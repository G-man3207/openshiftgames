import {
  deepClone,
  mergeDefaults,
  toManifestObject as serializeManifestObject,
  toManifestYAML as serializeManifestYAML,
  describeResource,
} from './ManifestSerializer.js';

let uidCounter = 0;

function generateUID() {
  uidCounter++;
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${random}-${uidCounter.toString(36).padStart(4, '0')}`;
}

/**
 * ResourceBase — common base class for every simulated OpenShift resource.
 *
 * Construction forms (kept for backwards compatibility):
 *   new ResourceBase('Pod', 'v1', 'web-1', 'demo')
 *   new ResourceBase('Route', { name: 'web', namespace: 'demo', apiVersion: 'route.openshift.io/v1' })
 *
 * Subclasses call `super('<Kind>', { ...metadata, apiVersion: '<correct apiVersion>' })`
 * and then build their default spec with `this._initSpec(defaults, metadata.spec)`
 * and their status skeleton with `this._setInitialStatus({...})`.  Defaults are
 * always deep-cloned, so two instances never share nested objects.
 *
 * Serialization is delegated to the shared ManifestSerializer:
 *   - `toManifestObject(opts)` → apply-clean plain object
 *   - `toYAML(opts)` → apply-clean YAML string (pass {includeStatus:true} for status;
 *     a numeric first argument is treated as the legacy indent + include status)
 *   - `describe()` → this.toDescribe() when the subclass provides one
 */
export class ResourceBase {
  constructor(kind, apiVersionOrMeta, name, namespace = 'default') {
    this.kind = kind;

    let meta;
    if (apiVersionOrMeta && typeof apiVersionOrMeta === 'object') {
      meta = apiVersionOrMeta;
    } else {
      meta = { apiVersion: apiVersionOrMeta, name, namespace };
    }
    const md = meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : meta;

    this.apiVersion = meta.apiVersion || md.apiVersion || 'v1';
    this.metadata = {
      name: md.name || meta.name || 'unnamed',
      namespace: md.namespace ?? meta.namespace ?? 'default',
      uid: md.uid || meta.uid || generateUID(),
      labels: deepClone(md.labels || meta.labels || {}),
      annotations: deepClone(md.annotations || meta.annotations || {}),
      creationTimestamp: md.creationTimestamp || new Date().toISOString(),
      deletionTimestamp: md.deletionTimestamp || null,
      generation: md.generation || 1,
      resourceVersion: md.resourceVersion || '1',
      ownerReferences: deepClone(md.ownerReferences || meta.ownerReferences || []),
      finalizers: deepClone(md.finalizers || meta.finalizers || []),
    };

    this.spec = {};
    this.status = {
      phase: 'Pending',
      conditions: [],
      observedGeneration: 0,
    };

    this._events = [];
    this._maxEvents = 50;
    this._deleted = false;
    this._listeners = new Map();
  }

  // ─── Convenience getters ────────────────────────────────────────────────

  get name() {
    return this.metadata.name;
  }

  get namespace() {
    return this.metadata.namespace;
  }

  get uid() {
    return this.metadata.uid;
  }

  get labels() {
    return this.metadata.labels;
  }

  get annotations() {
    return this.metadata.annotations;
  }

  get age() {
    const created = new Date(this.metadata.creationTimestamp).getTime();
    return Date.now() - created;
  }

  get ageFormatted() {
    const ms = this.age;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  get isDeleting() {
    return this.metadata.deletionTimestamp !== null;
  }

  get fullyQualifiedName() {
    return `${this.metadata.namespace}/${this.kind}/${this.metadata.name}`;
  }

  get events() {
    return this._events;
  }

  get isClusterScoped() {
    return !this.metadata.namespace;
  }

  // ─── Construction helpers for subclasses ────────────────────────────────

  /**
   * Build the instance spec from deep-cloned defaults + caller overrides.
   * @param {object} defaults @param {object} [overrides] @returns {object}
   */
  _initSpec(defaults, overrides) {
    this.spec = mergeDefaults(defaults, overrides);
    return this.spec;
  }

  /**
   * Build the initial status skeleton (no phase-change event is recorded for
   * the initial state; constructors must never assume `tick()` will run).
   * @param {object} status @returns {object}
   */
  _setInitialStatus(status = {}) {
    this.status = mergeDefaults(
      { phase: 'Pending', conditions: [], observedGeneration: 1 },
      status
    );
    return this.status;
  }

  // ─── Metadata mutation ──────────────────────────────────────────────────

  setLabel(key, value) {
    this.metadata.labels[key] = value;
    this._bumpResourceVersion();
    return this;
  }

  removeLabel(key) {
    delete this.metadata.labels[key];
    this._bumpResourceVersion();
    return this;
  }

  setAnnotation(key, value) {
    this.metadata.annotations[key] = value;
    this._bumpResourceVersion();
    return this;
  }

  removeAnnotation(key) {
    delete this.metadata.annotations[key];
    this._bumpResourceVersion();
    return this;
  }

  matchesSelector(selector) {
    if (!selector || Object.keys(selector).length === 0) return true;
    for (const [key, value] of Object.entries(selector)) {
      if (this.metadata.labels[key] !== value) return false;
    }
    return true;
  }

  matchesFieldSelector(field, value) {
    const parts = field.split('.');
    let current = this;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return false;
      current = current[part];
    }
    return String(current) === String(value);
  }

  // ─── Owner references / finalizers ─────────────────────────────────────

  addOwnerReference(owner) {
    const ref = {
      apiVersion: owner.apiVersion,
      kind: owner.kind,
      name: owner.metadata.name,
      uid: owner.metadata.uid,
      controller: true,
      blockOwnerDeletion: true,
    };
    const existing = this.metadata.ownerReferences.findIndex((r) => r.uid === ref.uid);
    if (existing >= 0) {
      this.metadata.ownerReferences[existing] = ref;
    } else {
      this.metadata.ownerReferences.push(ref);
    }
    this._bumpResourceVersion();
    return this;
  }

  removeOwnerReference(ownerUid) {
    this.metadata.ownerReferences = this.metadata.ownerReferences.filter((r) => r.uid !== ownerUid);
    this._bumpResourceVersion();
    return this;
  }

  getControllerOwner() {
    return this.metadata.ownerReferences.find((r) => r.controller) || null;
  }

  addFinalizer(name) {
    if (!this.metadata.finalizers.includes(name)) {
      this.metadata.finalizers.push(name);
      this._bumpResourceVersion();
    }
    return this;
  }

  removeFinalizer(name) {
    this.metadata.finalizers = this.metadata.finalizers.filter((f) => f !== name);
    this._bumpResourceVersion();
    return this;
  }

  markForDeletion() {
    if (!this.metadata.deletionTimestamp) {
      this.metadata.deletionTimestamp = new Date().toISOString();
      this._bumpResourceVersion();
      this.recordEvent('Normal', 'Killing', 'Resource marked for deletion');
    }
    return this;
  }

  canBeRemoved() {
    return this.metadata.deletionTimestamp !== null && this.metadata.finalizers.length === 0;
  }

  // ─── Conditions / phase ────────────────────────────────────────────────

  setCondition(type, status, reason = '', message = '') {
    const now = new Date().toISOString();
    const existing = this.status.conditions.findIndex((c) => c.type === type);
    const condition = {
      type,
      status: String(status),
      reason,
      message,
      lastTransitionTime: now,
      lastHeartbeatTime: now,
    };
    if (existing >= 0) {
      const prev = this.status.conditions[existing];
      if (prev.status === condition.status) {
        condition.lastTransitionTime = prev.lastTransitionTime;
      }
      this.status.conditions[existing] = condition;
    } else {
      this.status.conditions.push(condition);
    }
    this._bumpResourceVersion();
    return this;
  }

  getCondition(type) {
    return this.status.conditions.find((c) => c.type === type) || null;
  }

  isConditionTrue(type) {
    const condition = this.getCondition(type);
    return condition ? condition.status === 'True' : false;
  }

  setPhase(phase) {
    if (this.status.phase !== phase) {
      const oldPhase = this.status.phase;
      this.status.phase = phase;
      this._bumpResourceVersion();
      this.recordEvent('Normal', 'PhaseChange', `Phase changed from ${oldPhase} to ${phase}`);
    }
    return this;
  }

  setStatus(status) {
    return this.setPhase(status);
  }

  updateSpec(partialSpec) {
    Object.assign(this.spec, partialSpec);
    this.metadata.generation++;
    this._bumpResourceVersion();
    return this;
  }

  // ─── Events ────────────────────────────────────────────────────────────

  /** Simulation is controller-driven; resource-level tick is a deliberate no-op. */
  tick(deltaTime) {} // eslint-disable-line no-unused-vars

  addEvent(type, reason, message) {
    return this.recordEvent(type, reason, message);
  }

  recordEvent(type, reason, message) {
    const event = {
      type,
      reason,
      message,
      timestamp: new Date().toISOString(),
      count: 1,
      source: this.kind,
      involvedObject: {
        kind: this.kind,
        name: this.metadata.name,
        namespace: this.metadata.namespace,
        uid: this.metadata.uid,
      },
    };
    if (this._events.length > 0) {
      const last = this._events[this._events.length - 1];
      if (last.reason === reason && last.message === message) {
        last.count++;
        last.timestamp = event.timestamp;
        return this;
      }
    }
    this._events.push(event);
    if (this._events.length > this._maxEvents) {
      this._events.shift();
    }
    return this;
  }

  getEvents(limit) {
    if (limit) {
      return this._events.slice(-limit);
    }
    return [...this._events];
  }

  getWarningEvents() {
    return this._events.filter((e) => e.type === 'Warning');
  }

  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(callback);
    return this;
  }

  off(event, callback) {
    const list = this._listeners.get(event);
    if (list) {
      this._listeners.set(
        event,
        list.filter((cb) => cb !== callback)
      );
    }
    return this;
  }

  emit(event, data) {
    const list = this._listeners.get(event);
    if (list) {
      for (const cb of list) {
        cb(data);
      }
    }
  }

  _bumpResourceVersion() {
    this.metadata.resourceVersion = String(parseInt(this.metadata.resourceVersion, 10) + 1);
  }

  // ─── Serialization / validation ────────────────────────────────────────

  /**
   * Validate the resource against the basic API object rules plus any
   * kind-specific checks the subclass adds. Safe to call at any time.
   * @returns {{valid: boolean, errors: string[]}}
   */
  validate() {
    const errors = [];
    const name = this.metadata?.name;
    if (!this.kind) errors.push('kind is required');
    if (!this.apiVersion) errors.push('apiVersion is required');
    if (!name || typeof name !== 'string') {
      errors.push('metadata.name is required');
    } else if (name.length > 253) {
      errors.push('metadata.name must be 253 characters or fewer');
    } else if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name)) {
      errors.push('metadata.name must be a lowercase RFC 1123 subdomain');
    }
    if (
      this.metadata?.namespace &&
      !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(this.metadata.namespace)
    ) {
      errors.push('metadata.namespace must be a lowercase RFC 1123 label');
    }
    return { valid: errors.length === 0, errors };
  }

  /** @see ManifestSerializer.toManifestObject */
  toManifestObject(opts = {}) {
    return serializeManifestObject(this, opts);
  }

  /**
   * Apply-clean YAML for this resource. Drop `status` by default; pass
   * `{ includeStatus: true }` to include it (the YAML tab / oc get -o yaml).
   * A number argument is treated as the legacy `indent` parameter and keeps
   * status, preserving the pre-conversion `toYAML(indent)` behaviour.
   * @param {{includeStatus?: boolean}|number} [opts]
   * @returns {string}
   */
  toYAML(opts = {}) {
    if (typeof opts === 'number') return serializeManifestYAML(this, { includeStatus: true });
    return serializeManifestYAML(this, opts);
  }

  /** `oc describe`-style text; subclasses override toDescribe(). */
  describe() {
    if (typeof this.toDescribe === 'function') return this.toDescribe();
    return describeResource(this);
  }

  /** Internal simulator representation (contains uid/timestamps/status). */
  toJSON() {
    return {
      apiVersion: this.apiVersion,
      kind: this.kind,
      metadata: {
        ...this.metadata,
        ownerReferences: deepClone(this.metadata.ownerReferences),
        finalizers: deepClone(this.metadata.finalizers),
        labels: deepClone(this.metadata.labels),
        annotations: deepClone(this.metadata.annotations),
      },
      spec: deepClone(this.spec),
      status: deepClone(this.status),
    };
  }

  /**
   * Clone the resource, preserving its concrete subclass (previously this
   * downgraded every resource to a plain ResourceBase). The clone gets a new
   * UID and a clean event/log listener set.
   * @returns {this}
   */
  clone() {
    const cloned = Object.create(Object.getPrototypeOf(this));
    for (const [key, value] of Object.entries(this)) {
      cloned[key] = deepClone(value);
    }
    cloned.metadata.uid = generateUID();
    cloned.metadata.creationTimestamp = new Date().toISOString();
    cloned.metadata.resourceVersion = '1';
    cloned._events = [];
    cloned._listeners = new Map();
    cloned._deleted = false;
    return cloned;
  }

  equals(other) {
    if (!other || !(other instanceof ResourceBase)) return false;
    return this.metadata.uid === other.metadata.uid;
  }

  toString() {
    return `${this.kind}/${this.metadata.namespace}/${this.metadata.name}`;
  }
}

export default ResourceBase;
