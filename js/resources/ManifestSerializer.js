/**
 * ManifestSerializer — the single shared manifest / YAML serializer for shifting.pro.
 *
 * Every resource class (`js/resources/*.js`), the central kind registry
 * (`js/data/kindRegistry.js`) and the CLI/YAML export/Inspector must use this module
 * instead of hand-rolling YAML or manifest objects.
 *
 * Contract:
 *   - `toManifestObject(resource, opts)` builds an **apply-clean** manifest object.
 *     It drops simulator-only metadata (uid, creationTimestamp, resourceVersion,
 *     generation, deletionTimestamp, ownerReferences, finalizers) and drops
 *     `status` unless `opts.includeStatus === true`. Field order is deterministic.
 *   - `stringifyYAML(value)` renders a plain JS value as block-style YAML with
 *     2-space indentation, quoting strings that would otherwise change type
 *     (`"true"`, `"20"`, strings containing `: `, ` #`, quotes, newlines, ...).
 *   - `toManifestYAML(resource, opts)` is `stringifyYAML(toManifestObject(...)) + '\n'`
 *     (what `ResourceBase#toYAML` and the game's YAML exporters return).
 *   - `normalizeManifestObject(manifest)` is the reverse path used when applying
 *     YAML: it lifts spec-less OpenShift kinds (SCC, Template, User, Group,
 *     Identity, ConfigMap, Secret, ServiceAccount, StorageClass, Role,
 *     ClusterRole, RoleBinding, ClusterRoleBinding) whose real API stores
 *     fields at the top level into the game's uniform `.spec` model.
 *   - `FLAT_KINDS` documents that mapping; `deepClone` / `deepMerge` /
 *     `mergeDefaults` are shared helpers (defaults are always deep-cloned, so
 *     instances never share mutable defaults).
 *
 * This module has no imports and never imports a resource class, so it can be
 * used from any layer without creating circular imports.
 */

// ─── Kind models without a `spec` wrapper in the real OpenShift API ─────────
// The game keeps every kind's payload under `.spec` for uniform engine/UI code;
// on the way out these kinds are flattened to their real top-level field names.
// Order in each array is the canonical YAML order.
export const FLAT_KINDS = Object.freeze({
  ConfigMap: ['data', 'binaryData', 'immutable'],
  Secret: ['type', 'data', 'stringData', 'immutable'],
  StorageClass: [
    'provisioner',
    'parameters',
    'reclaimPolicy',
    'volumeBindingMode',
    'allowVolumeExpansion',
    'mountOptions',
  ],
  ServiceAccount: ['secrets', 'imagePullSecrets', 'automountServiceAccountToken'],
  Role: ['rules'],
  ClusterRole: ['rules', 'aggregationRule'],
  RoleBinding: ['roleRef', 'subjects'],
  ClusterRoleBinding: ['roleRef', 'subjects'],
  SecurityContextConstraints: [
    'priority',
    'allowPrivilegedContainer',
    'allowHostDirVolumePlugin',
    'allowHostNetwork',
    'allowHostPorts',
    'allowHostPID',
    'allowHostIPC',
    'readOnlyRootFilesystem',
    'runAsUser',
    'seLinuxContext',
    'fsGroup',
    'supplementalGroups',
    'users',
    'groups',
  ],
  Template: ['parameters', 'objects', 'message'],
  User: ['fullName', 'identities', 'groups'],
  Group: ['users'],
  Identity: ['providerName', 'providerUserName', 'user'],
});

/** Kinds whose resource class stores data under `.spec` but are flat on the wire. */
export function isFlatKind(kind) {
  return Object.prototype.hasOwnProperty.call(FLAT_KINDS, kind);
}

// ─── API view metadata (for `oc get -o yaml/json`, not for apply-clean export) ──

/**
 * Kinds that have no `status` subresource in the real API. `oc get -o yaml`
 * output must not invent a status block for them; the simulator's status
 * skeleton (`phase/conditions/observedGeneration`) is internal bookkeeping.
 * (Ingress is listed per the audit: the simulated Ingress status is simulator
 * state, not the OCP ingress-controller status.)
 */
export const NO_STATUS_KINDS = Object.freeze(
  new Set([
    'ConfigMap',
    'Secret',
    'ServiceAccount',
    'Role',
    'ClusterRole',
    'RoleBinding',
    'ClusterRoleBinding',
    'NetworkPolicy',
    'LimitRange',
    'Template',
    'Ingress',
    'Endpoints',
    'StorageClass',
    'User',
    'Group',
    'Identity',
    'SecurityContextConstraints',
    'IPAddressPool',
    'L2Advertisement',
  ])
);

/** True when the real API serves a `status` subresource for this kind. */
export function kindHasStatus(kind) {
  return !NO_STATUS_KINDS.has(kind);
}

/**
 * Kinds where real objects carry `metadata.generation` (controllers/spec
 * resources). Other kinds (ConfigMap, Secret, Pod, RBAC, ...) do not.
 */
export const GENERATION_KINDS = Object.freeze(
  new Set([
    'Deployment',
    'ReplicaSet',
    'StatefulSet',
    'DaemonSet',
    'Job',
    'CronJob',
    'HorizontalPodAutoscaler',
    'PodDisruptionBudget',
    'BuildConfig',
    'Build',
    'ImageStream',
    'Route',
    'ClusterResourceQuota',
    'ResourceQuota',
    'ClusterVersion',
    'ClusterOperator',
  ])
);

// ─── Basic helpers ──────────────────────────────────────────────────────────

/** @param {*} value @returns {*} */
export function isPlainObject(value) {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Deep-clone plain JS data (objects/arrays). Primitives are returned as-is.
 * Never shares object/array references with the source.
 * @template T @param {T} value @returns {T}
 */
export function deepClone(value) {
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = deepClone(item);
    }
    return out;
  }
  return value;
}

/**
 * Recursively merge `override` into a clone of `base` and return the result.
 * Arrays are replaced (not concatenated); `undefined` values in the override
 * are ignored. Neither argument is mutated.
 * @param {object} base @param {object} override @returns {object}
 */
export function deepMerge(base, override) {
  const left = isPlainObject(base) ? base : {};
  if (!isPlainObject(override)) return deepClone(override === undefined ? left : override);
  const out = deepClone(left);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = deepClone(value);
    }
  }
  return out;
}

/**
 * Build a fresh, deep-cloned spec from defaults overridden by `overrides`.
 * Used by every resource class so instances never share mutable defaults.
 * @param {object} defaults @param {object} [overrides] @returns {object}
 */
export function mergeDefaults(defaults, overrides) {
  return deepMerge(defaults || {}, overrides || {});
}

function sortObjectKeys(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

function hasKeys(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

// ─── Manifest construction ──────────────────────────────────────────────────

/**
 * Stable, RFC-4122-v4-shaped UID for the User an OpenShift Identity references
 * (#76). Real Identities always carry `spec.user.uid` (the linked User's
 * metadata.uid) and the CLI prints it in the `oc get identities` USER UID
 * column. Login links the real UID; an Identity that only names its user (a
 * seeded/applied manifest) gets a deterministic UID derived from the name, so
 * the column is never empty and repeated reads agree.
 * @param {string} userName
 * @returns {string}
 */
export function deterministicUserUid(userName) {
  const source = String(userName ?? '');
  let state = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    state ^= source.charCodeAt(index);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  let hex = '';
  while (hex.length < 32) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    state = (state + 0x9e3779b9) >>> 0;
    hex += state.toString(16).padStart(8, '0');
  }
  const chars = hex.slice(0, 32).split('');
  chars[12] = '4'; // version 4
  chars[16] = '89ab'[Number.parseInt(chars[16], 16) % 4]; // RFC 4122 variant
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Normalise a Kubernetes/OpenShift manifest object (as parsed from YAML) into
 * the game resource model.
 *
 * @param {object} manifest
 * @returns {{kind: string, apiVersion: string, name: string, namespace: string,
 *   uid?: string, labels: object, annotations: object, spec: object,
 *   status: (object|null), ownerReferences: Array, finalizers: Array}}
 */
export function normalizeManifestObject(manifest = {}) {
  const kind = manifest.kind || '';
  const meta = isPlainObject(manifest.metadata) ? manifest.metadata : {};
  const flatFields = FLAT_KINDS[kind];
  let spec;
  if (flatFields) {
    spec = isPlainObject(manifest.spec) ? deepClone(manifest.spec) : {};
    for (const field of flatFields) {
      if (manifest[field] !== undefined) spec[field] = deepClone(manifest[field]);
    }
  } else {
    spec = deepClone(manifest.spec || {});
  }
  // Identity admission records the linked User's UID; a manifest that only names
  // its user gets the deterministic fallback before the spec is stored (#76).
  if (kind === 'Identity') {
    spec.user = isPlainObject(spec.user) ? spec.user : {};
    if (!spec.user.uid && spec.user.name) spec.user.uid = deterministicUserUid(spec.user.name);
  }
  return {
    kind,
    apiVersion: manifest.apiVersion || '',
    name: meta.name || manifest.name || 'unnamed',
    namespace: meta.namespace ?? manifest.namespace ?? '',
    uid: meta.uid || manifest.uid || undefined,
    labels: deepClone(meta.labels || {}),
    annotations: deepClone(meta.annotations || {}),
    ownerReferences: deepClone(meta.ownerReferences || []),
    finalizers: deepClone(meta.finalizers || []),
    spec,
    status: isPlainObject(manifest.status) ? deepClone(manifest.status) : null,
  };
}

/**
 * Build a manifest object from a resource instance (or a plain
 * `{kind, apiVersion, metadata, spec, status}` object).
 *
 * Default behaviour is **apply-clean** (used by the Files/YAML exporters):
 * deterministic output apiVersion → kind → metadata → (kind payload) → status;
 * label/annotation keys and any extra fields are sorted; simulator-only
 * metadata (uid, creationTimestamp, resourceVersion, generation,
 * ownerReferences, finalizers) is never exposed and `status` only appears when
 * `opts.includeStatus` is set.
 *
 * `opts.apiView` produces a **real-API-shaped view** for `oc get -o yaml/json`:
 * the stored objectMeta (uid, creationTimestamp, resourceVersion, generation,
 * deletionTimestamp, ownerReferences, finalizers) is kept and `status` is
 * emitted only for kinds that actually have a status subresource
 * (see NO_STATUS_KINDS). Callers that need apply-clean output must not pass it.
 *
 * @param {object} resource
 * @param {{includeStatus?: boolean, apiView?: boolean, includeObjectMeta?: boolean}} [opts]
 * @returns {object}
 */
export function toManifestObject(resource, opts = {}) {
  if (!resource || typeof resource !== 'object') return {};
  const kind = resource.kind || '';
  const apiVersion = resource.apiVersion || 'v1';
  const md = isPlainObject(resource.metadata) ? resource.metadata : {};
  const spec = isPlainObject(resource.spec) ? resource.spec : {};
  const apiView = opts.apiView === true || opts.includeObjectMeta === true;

  const metadata = { name: md.name || 'unnamed' };
  const namespace = md.namespace || '';
  if (namespace) metadata.namespace = namespace;
  if (hasKeys(md.labels)) metadata.labels = sortObjectKeys(deepClone(md.labels));
  if (hasKeys(md.annotations)) metadata.annotations = sortObjectKeys(deepClone(md.annotations));
  if (apiView) {
    if (md.uid) metadata.uid = String(md.uid);
    if (md.creationTimestamp) metadata.creationTimestamp = md.creationTimestamp;
    if (md.resourceVersion) metadata.resourceVersion = String(md.resourceVersion);
    if (md.deletionTimestamp) metadata.deletionTimestamp = md.deletionTimestamp;
    if (md.generation && GENERATION_KINDS.has(kind)) metadata.generation = md.generation;
    if (Array.isArray(md.ownerReferences) && md.ownerReferences.length > 0) {
      metadata.ownerReferences = deepClone(md.ownerReferences);
    }
    if (Array.isArray(md.finalizers) && md.finalizers.length > 0) {
      metadata.finalizers = deepClone(md.finalizers);
    }
  }

  /** @type {Record<string, any>} */
  const obj = { apiVersion, kind, metadata };

  const flatFields = FLAT_KINDS[kind];
  if (flatFields) {
    const emitted = new Set();
    for (const field of flatFields) {
      const value = spec[field];
      if (value === undefined) continue;
      obj[field] = deepClone(value);
      emitted.add(field);
    }
    for (const field of Object.keys(spec).sort()) {
      if (emitted.has(field) || spec[field] === undefined) continue;
      obj[field] = deepClone(spec[field]);
    }
  } else {
    obj.spec = deepClone(spec);
  }

  // In apiView mode status is part of the real object only for kinds that have
  // a status subresource; otherwise it is simulator bookkeeping and is hidden.
  const wantStatus = opts.apiView === true ? kindHasStatus(kind) : Boolean(opts.includeStatus);
  if (wantStatus && isPlainObject(resource.status)) {
    obj.status = deepClone(resource.status);
  }
  return obj;
}

// ─── YAML string emission ───────────────────────────────────────────────────

const RESERVED_WORDS = /^(true|false|null|~|yes|no|on|off)$/i;
const NUMBER_LIKE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/;
const UNSAFE_FIRST_CHAR = /^[\-?:,[\]{}#&*!|>'"%@`\s]/;

function needsQuotes(str) {
  if (str === '') return true;
  if (RESERVED_WORDS.test(str)) return true;
  if (NUMBER_LIKE.test(str)) return true;
  if (DATE_LIKE.test(str)) return true;
  if (UNSAFE_FIRST_CHAR.test(str)) return true;
  if (str !== str.trim()) return true;
  // characters that change YAML meaning inside a plain scalar
  if (/[\n\r\t]/.test(str)) return true;
  if (/:\s/.test(str) || /:$/.test(str)) return true;
  if (/\s#/.test(str)) return true;
  if (/["'\\]/.test(str)) return true;
  if (str === '---' || str === '...') return true;
  return false;
}

function quoteString(str) {
  return `"${str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

function formatScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return String(value);
  }
  if (typeof value === 'bigint') return String(value);
  const str = String(value);
  return needsQuotes(str) ? quoteString(str) : str;
}

function formatKey(key) {
  const str = String(key);
  return needsQuotes(str) ? quoteString(str) : str;
}

/** Strings that can use YAML block scalars (`|` / `|-`). */
function isBlockScalarCandidate(str) {
  if (!str.includes('\n')) return false;
  if (/[\t\r]/.test(str)) return false;
  if (str.includes('\u0000')) return false;
  // A line that starts with whitespace makes the block indentation ambiguous
  // (the first non-empty line sets the indent); fall back to a quoted scalar.
  for (const line of str.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) return false;
  }
  return true;
}

const INDENT = '  ';

/**
 * Render a value as YAML lines.
 * @param {*} value
 * @param {number} level indentation level (0 = root)
 * @param {string[]} lines output accumulator
 * @param {boolean} [topLevel]
 */
function emitValue(value, level, lines) {
  const pad = INDENT.repeat(level);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (Array.isArray(item)) {
        if (item.length === 0) lines.push(`${pad}- []`);
        else {
          const sub = [];
          emitValue(item, level + 1, sub);
          sub[0] = `${pad}- ${sub[0].slice(INDENT.repeat(level + 1).length)}`;
          lines.push(...sub);
        }
      } else if (isPlainObject(item)) {
        if (Object.keys(item).length === 0) {
          lines.push(`${pad}- {}`);
        } else {
          const sub = [];
          emitObject(item, level + 1, sub);
          sub[0] = `${pad}- ${sub[0].slice(INDENT.repeat(level + 1).length)}`;
          lines.push(...sub);
        }
      } else if (typeof item === 'string' && isBlockScalarCandidate(item)) {
        const endsWithNewline = item.endsWith('\n');
        lines.push(`${pad}- ${endsWithNewline ? '|' : '|-'}`);
        const body = endsWithNewline ? item.slice(0, -1) : item;
        for (const line of body.split('\n')) {
          lines.push(line === '' ? '' : `${INDENT.repeat(level + 1)}${line}`);
        }
      } else {
        lines.push(`${pad}- ${formatScalar(item)}`);
      }
    }
    return;
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) {
      lines.push(`${pad}{}`);
      return;
    }
    emitObject(value, level, lines);
    return;
  }
  lines.push(`${pad}${formatScalar(value)}`);
}

function emitObject(obj, level, lines) {
  const pad = INDENT.repeat(level);
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const label = formatKey(key);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${label}: []`);
      } else {
        lines.push(`${pad}${label}:`);
        emitValue(value, level + 1, lines);
      }
    } else if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        lines.push(`${pad}${label}: {}`);
      } else {
        lines.push(`${pad}${label}:`);
        emitObject(value, level + 1, lines);
      }
    } else if (typeof value === 'string' && isBlockScalarCandidate(value)) {
      const endsWithNewline = value.endsWith('\n');
      lines.push(`${pad}${label}: ${endsWithNewline ? '|' : '|-'}`);
      const body = endsWithNewline ? value.slice(0, -1) : value;
      for (const line of body.split('\n')) {
        lines.push(line === '' ? '' : `${INDENT.repeat(level + 1)}${line}`);
      }
    } else {
      lines.push(`${pad}${label}: ${formatScalar(value)}`);
    }
  }
}

/**
 * Serialise any plain JS value to block-style YAML (2-space indentation).
 * Empty mappings/sequences render as `{}`/`[]`; multi-line strings use `|`/`|-`.
 * @param {*} value @returns {string}
 */
export function stringifyYAML(value) {
  if (value === undefined) return '';
  const lines = [];
  emitValue(value, 0, lines);
  // Always terminate with a single newline: YAML files conventionally end with
  // one, and a trailing `|` block scalar needs the final line break to keep its
  // trailing newline.
  return `${lines.join('\n')}\n`;
}

/**
 * Serialise a resource (or plain manifest object) to a YAML string.
 * @param {object} resource
 * @param {{includeStatus?: boolean, apiView?: boolean, includeObjectMeta?: boolean, trailingNewline?: boolean}} [opts]
 * @returns {string}
 */
export function toManifestYAML(resource, opts = {}) {
  const text = stringifyYAML(toManifestObject(resource, opts));
  if (opts.trailingNewline === false) return text.endsWith('\n') ? text.slice(0, -1) : text;
  return text;
}

/** Alias kept for callers that prefer the resource-centric name. */
export const resourceToYAML = toManifestYAML;

// ─── Generic describe fallback ──────────────────────────────────────────────

/**
 * Generic `oc describe`-style text for a resource whose class has no custom
 * `toDescribe()`. Prefer a class-specific describe for real kinds.
 * @param {object} resource
 * @returns {string}
 */
export function describeResource(resource) {
  const md = resource.metadata || {};
  const lines = [];
  lines.push(`Name:         ${md.name || 'unnamed'}`);
  if (md.namespace) lines.push(`Namespace:    ${md.namespace}`);
  lines.push(`Kind:         ${resource.kind || ''}`);
  lines.push(`API Version:  ${resource.apiVersion || ''}`);
  const labels = Object.entries(md.labels || {}).map(([k, v]) => `${k}=${v}`);
  if (labels.length) lines.push(`Labels:       ${labels.join(', ')}`);
  const annotations = Object.entries(md.annotations || {}).map(([k, v]) => `${k}=${v}`);
  if (annotations.length) lines.push(`Annotations:  ${annotations.join(', ')}`);
  if (md.creationTimestamp) lines.push(`Created:      ${md.creationTimestamp}`);
  lines.push('');
  lines.push('Spec:');
  const specText = stringifyYAML(isPlainObject(resource.spec) ? resource.spec : {});
  for (const line of specText.split('\n')) lines.push(`  ${line}`);
  if (isPlainObject(resource.status) && Object.keys(resource.status).length > 0) {
    lines.push('');
    lines.push('Status:');
    const statusText = stringifyYAML(resource.status);
    for (const line of statusText.split('\n')) lines.push(`  ${line}`);
  }
  const events = Array.isArray(resource._events) ? resource._events.slice(-10) : [];
  if (events.length > 0) {
    lines.push('');
    lines.push('Events:');
    for (const event of events) {
      lines.push(`  ${event.type}\t${event.reason}\t${event.message}`);
    }
  }
  return lines.join('\n');
}

export default {
  FLAT_KINDS,
  NO_STATUS_KINDS,
  GENERATION_KINDS,
  isFlatKind,
  kindHasStatus,
  isPlainObject,
  deepClone,
  deepMerge,
  mergeDefaults,
  normalizeManifestObject,
  toManifestObject,
  stringifyYAML,
  toManifestYAML,
  resourceToYAML,
  describeResource,
};
