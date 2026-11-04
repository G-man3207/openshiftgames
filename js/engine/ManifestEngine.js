/**
 * ManifestEngine — virtual filesystem + declarative OpenShift operations.
 *
 * Implements the declarative workflows taught by EX280V422:
 *
 *   oc apply -f <file>            -> applyFile(path)
 *   oc create -f <file>           -> applyFile(path)  (upsert; simulator)
 *   oc apply -k <dir>             -> applyKustomize(dir)
 *   oc process -f <tpl> -p K=V    -> processTemplate(path, params) (render only)
 *   oc process ... | oc apply -f - -> applyObjects(objects, '<stdin>')
 *   oc delete -f <file>           -> deleteFileObjects(path)
 *   helm install/upgrade/list/uninstall -> installHelm/upgradeHelm/listHelm/uninstallHelm
 *   htpasswd -c/-b/-D <file> user -> htpasswdAdd/htpasswdUpdate/htpasswdDelete
 *
 * Resources are upserted through `window.game.gameEngine.applyManifestObject(obj)`
 * when that engine API exists (engine-dev owns it); otherwise the engine falls
 * back to `kindRegistry.createResource()` + `ClusterState.add()` / in-place
 * update. Both paths produce the same result shapes.
 *
 * Result shape used by every apply operation:
 *   { ok: boolean,
 *     created: [{kind, name, namespace}],
 *     updated: [{kind, name, namespace}],
 *     errors: string[],            // human-readable, "file:line: message"
 *     errorDetails: [{file?, line?, message?}],
 *     warnings: string[] }
 *
 * Every mutating operation emits a game event (manifest:applied,
 * kustomize:applied, template:processed, helm:installed, helm:uninstalled)
 * through the GameEngine event bus and as a DOM CustomEvent
 * (`openshiftgames:manifest-applied`, ...) for UI listeners.
 *
 * No dependencies beyond js/data/kindRegistry.js, js/data/ManifestFiles.js and
 * js/engine/YamlParser.js. No DOM access at module load: safe in Node tests.
 */

import { parseYaml, stringifyYaml, toYamlError, YamlParseError } from './YamlParser.js';
// htpasswd hashing/verification helpers (shared with the engine's login flow).
// GameEngine does not import ManifestEngine, so this is cycle-free.
import { hashHtpasswdEntry, verifyHtpasswdPasswordHash } from './GameEngine.js';
import { MANIFEST_FILES } from '../data/ManifestFiles.js';
import {
  createResource,
  normalizeKind,
  apiVersionForKind,
  isClusterScopedKind,
  RESOURCE_KINDS,
} from '../data/kindRegistry.js';

export { parseYaml, stringifyYaml, YamlParseError };

const KUSTOMIZATION_FILENAMES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];
const WORKLOAD_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
  'Pod',
]);
const RENDERED_NUMBER_KEYS = new Set([
  'replicas',
  'port',
  'targetPort',
  'containerPort',
  'nodePort',
  'hostPort',
  'minReplicas',
  'maxReplicas',
  'terminationGracePeriodSeconds',
  'revisionHistoryLimit',
  'progressDeadlineSeconds',
  'weight',
]);

// ─── small helpers ──────────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizePath(input) {
  const raw = String(input ?? '')
    .trim()
    .replace(/\\/g, '/');
  if (!raw) return '';
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function resolvePath(baseDir, relative) {
  const rel = String(relative ?? '')
    .trim()
    .replace(/\\/g, '/');
  if (!rel) return normalizePath(baseDir);
  const parts = (normalizePath(baseDir) ? normalizePath(baseDir).split('/') : []).concat(
    rel.split('/')
  );
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function basename(path) {
  const norm = normalizePath(path);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/** Deep-merge maps; every list is replaced (Kustomize / strategic-merge-lite). */
export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return clone(patch);
  const out = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(patch)) return clone(patch);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) out[key] = clone(value);
    else if (isPlainObject(value))
      out[key] = deepMerge(isPlainObject(out[key]) ? out[key] : {}, value);
    else out[key] = clone(value);
  }
  return out;
}

/** Kubernetes strategic-merge keys for the list fields used by OpenShift manifests. */
const STRATEGIC_MERGE_KEYS = {
  containers: ['name'],
  initContainers: ['name'],
  ephemeralContainers: ['name'],
  env: ['name'],
  volumes: ['name'],
  volumeMounts: ['mountPath'],
  volumeDevices: ['devicePath'],
  imagePullSecrets: ['name'],
  ports: ['containerPort', 'port'],
  hostAliases: ['ip'],
  topologySpreadConstraints: ['topologyKey'],
};

/**
 * Strategic merge patch used by `patchesStrategicMerge` / `patches` (Kustomize):
 * maps merge recursively, lists with a known Kubernetes merge key merge by that
 * key, other lists are replaced (patch strategy `replace`).
 */
export function strategicMerge(base, patch) {
  return _strategicMerge(base, patch, null);
}

function _strategicMerge(base, patch, hint) {
  if (patch === undefined) return clone(base);
  if (Array.isArray(patch)) {
    const keys = hint ? STRATEGIC_MERGE_KEYS[hint] : null;
    if (!Array.isArray(base) || !keys) return clone(patch);
    const out = base.map((item) => clone(item));
    for (const patchItem of patch) {
      if (!isPlainObject(patchItem)) {
        out.push(clone(patchItem));
        continue;
      }
      const index = out.findIndex(
        (item) =>
          isPlainObject(item) &&
          keys.some((key) => item[key] !== undefined && item[key] === patchItem[key])
      );
      if (index === -1) out.push(clone(patchItem));
      else out[index] = _strategicMerge(out[index], patchItem, null);
    }
    return out;
  }
  if (isPlainObject(patch)) {
    const out = isPlainObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      out[key] = _strategicMerge(out[key], value, key);
    }
    return out;
  }
  return clone(patch);
}

function base64(str) {
  if (typeof btoa === 'function') return btoa(str);
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
  return str;
}

/** Deterministic, non-reversible stand-in for a bcrypt/SHA htpasswd hash. */
function fakeHtpasswdHash(user, pass) {
  const input = `${user}\u0000${pass}`;
  let h1 = 0xdeadbeef ^ user.length;
  let h2 = 0x41c6ce57 ^ pass.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const digest =
    (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  return `{SHA}${base64(digest).replace(/=+$/, '')}`;
}

function formatError(err, fallbackFile) {
  if (err && err.name === 'YamlParseError') {
    const file = err.file || fallbackFile || '<input>';
    return `${file}:${err.line}: ${err.message}`;
  }
  return err?.message || String(err);
}

function errorDetail(err, fallbackFile) {
  const detail = toYamlError(err);
  if (!detail.file && fallbackFile) detail.file = fallbackFile;
  return detail;
}

function coerceNumberStrings(value) {
  if (Array.isArray(value)) return value.map(coerceNumberStrings);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && RENDERED_NUMBER_KEYS.has(key) && /^-?\d+$/.test(val.trim())) {
      out[key] = parseInt(val.trim(), 10);
    } else {
      out[key] = coerceNumberStrings(val);
    }
  }
  return out;
}

// ─── engine ─────────────────────────────────────────────────────────────────

export class ManifestEngine {
  /**
   * @param {object|null} gameOrEngine `window.game` ({gameEngine, cluster}) or a
   *   GameEngine instance; may be omitted and resolved lazily from window.game.
   * @param {{autoCreateProjects?: boolean}} [options]
   */
  constructor(gameOrEngine = null, options = {}) {
    this.game = gameOrEngine;
    this.options = { autoCreateProjects: true, ...options };
    this.files = new Map();
    this.appliedFiles = [];
    this.appliedKustomize = [];
    this.templates = [];
    this.pendingTemplates = [];
    this.helmReleases = new Map();
    this.lastApplied = null;
    this.lastErrors = [];
    this._resetHistory();
    this._seedFiles();
  }

  // ── injection points ─────────────────────────────────────────────────────

  _game() {
    const ref = this.game;
    if (ref && typeof ref === 'object') {
      if (
        ref.gameEngine ||
        ref.cluster ||
        typeof ref.applyManifestObject === 'function' ||
        typeof ref.emit === 'function'
      ) {
        return ref;
      }
    }
    if (typeof window !== 'undefined' && window.game) return window.game;
    return ref || null;
  }

  _gameEngine() {
    const game = this._game();
    if (!game) return null;
    if (game.gameEngine) return game.gameEngine;
    if (typeof game.applyManifestObject === 'function') return game;
    if (typeof game.emit === 'function' && game.cluster) return game;
    return null;
  }

  _cluster() {
    const game = this._game();
    if (!game) return null;
    if (game.cluster) return game.cluster;
    if (game.gameEngine?.cluster) return game.gameEngine.cluster;
    return null;
  }

  _currentProject() {
    const game = this._game();
    const engine = this._gameEngine();
    return engine?.currentProject || game?.currentProject || 'default';
  }

  _emit(event, data) {
    const engine = this._gameEngine();
    try {
      if (engine && typeof engine.emit === 'function') engine.emit(event, data);
      else if (engine?.eventBus && typeof engine.eventBus.emit === 'function')
        engine.eventBus.emit(event, data);
    } catch (err) {
      // Never let an event-bus hiccup break a declarative operation.
      if (typeof console !== 'undefined')
        console.warn(`manifest: failed to emit ${event}`, err?.message || err);
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function' &&
      typeof CustomEvent === 'function'
    ) {
      try {
        window.dispatchEvent(
          new CustomEvent(`openshiftgames:${event.replace(':', '-')}`, { detail: data })
        );
      } catch {
        /* non-browser or event constructor missing */
      }
    }
  }

  // ── virtual filesystem ───────────────────────────────────────────────────

  _seedFiles() {
    this.files.clear();
    for (const [path, content] of Object.entries(MANIFEST_FILES)) {
      this.files.set(normalizePath(path), String(content ?? ''));
    }
  }

  _resetHistory() {
    this.appliedFiles = [];
    this.appliedKustomize = [];
    this.templates = [];
    this.pendingTemplates = [];
    this.helmReleases = new Map();
    this.lastApplied = null;
    this.lastErrors = [];
  }

  listFiles() {
    return [...this.files.keys()].sort();
  }

  /**
   * Flat file-tree representation: directories first, then files.
   * @returns {Array<{path: string, kind: 'directory'|'file', name: string, depth: number, extension?: string}>}
   */
  getFileTree() {
    const dirs = new Set();
    for (const path of this.files.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const entries = [];
    for (const path of dirs) {
      entries.push({
        path,
        kind: 'directory',
        name: basename(path),
        depth: path.split('/').length - 1,
      });
    }
    for (const path of this.files.keys()) {
      entries.push({
        path,
        kind: 'file',
        name: basename(path),
        depth: path.split('/').length - 1,
        extension: path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : '',
      });
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return entries;
  }

  exists(path) {
    return this.files.has(normalizePath(path));
  }

  /** @returns {string|null} null when the path does not exist. */
  readFile(path) {
    const norm = normalizePath(path);
    return this.files.has(norm) ? this.files.get(norm) : null;
  }

  writeFile(path, text) {
    const norm = normalizePath(path);
    if (!norm) throw new Error('writeFile: path must not be empty');
    this.files.set(norm, String(text ?? ''));
    return norm;
  }

  deleteFile(path) {
    return this.files.delete(normalizePath(path));
  }

  /** Restore the default files and forget apply/template/Helm records. */
  resetFiles() {
    this._seedFiles();
    this._resetHistory();
    this._emit('manifest:reset', { files: this.listFiles() });
    return this.listFiles();
  }

  // ── cluster helpers ──────────────────────────────────────────────────────

  _canonicalKind(kind) {
    const raw = String(kind || '').trim();
    if (!raw) return null;
    const normalized = normalizeKind(raw);
    if (normalized) return normalized;
    if (RESOURCE_KINDS.includes(raw)) return raw;
    return null;
  }

  _findResource(kind, name, namespace) {
    const cluster = this._cluster();
    if (!cluster || !kind || !name) return null;
    const canonical = this._canonicalKind(kind) || kind;
    const clusterScoped = isClusterScopedKind(canonical);
    const ns = clusterScoped ? '' : namespace || 'default';
    try {
      if (typeof cluster.getByName === 'function') {
        const found = cluster.getByName(canonical, name, ns);
        if (found) return found;
      }
      const listFn = cluster.getByKind || cluster.getResourcesByKind;
      if (typeof listFn === 'function') {
        const list = listFn.call(cluster, canonical) || [];
        return (
          list.find((resource) => {
            if (resource?.metadata?.name !== name) return false;
            if (clusterScoped) return true;
            return (resource.metadata?.namespace || 'default') === ns;
          }) || null
        );
      }
    } catch {
      return null;
    }
    return null;
  }

  _namespaceExists(namespace) {
    if (!namespace || namespace === 'default') return true;
    const cluster = this._cluster();
    if (!cluster) return false;
    try {
      if (typeof cluster.getByName === 'function') {
        if (cluster.getByName('Project', namespace, '')) return true;
      }
      if (
        typeof cluster.getByNamespace === 'function' &&
        cluster.getByNamespace(namespace).length > 0
      ) {
        return true;
      }
      if (typeof cluster.getByKind === 'function') {
        return (cluster.getByKind('Project') || []).some((r) => r?.metadata?.name === namespace);
      }
    } catch {
      return false;
    }
    return false;
  }

  // ── document normalisation ───────────────────────────────────────────────

  /**
   * Expand `kind: List` wrappers and validate a raw manifest object.
   * @param {object} raw
   * @param {string} source
   * @param {{namespace?: string}} [options] explicit namespace override
   *   (`oc apply -f … -n <project>`); applies to every namespaced object.
   * @returns {{ok: true, doc: object} | {ok: false, error: string, detail: object}}
   */
  _normalizeDoc(raw, source, options = {}) {
    if (!isPlainObject(raw)) {
      return {
        ok: false,
        error: `${source}: document is not a mapping`,
        detail: { file: source, message: 'document is not a mapping' },
      };
    }
    if (!raw.kind) {
      return {
        ok: false,
        error: `${source}: error: resource kind is required (missing "kind")`,
        detail: { file: source, message: 'resource kind is required' },
      };
    }
    const kind = String(raw.kind);
    if (kind === 'List') {
      const items = Array.isArray(raw.items) ? raw.items : [];
      return {
        ok: true,
        list: items.map((item, index) =>
          this._normalizeDoc(item, `${source}[items ${index}]`, options)
        ),
      };
    }
    const declaredApiVersion =
      raw.apiVersion === undefined || raw.apiVersion === null ? '' : String(raw.apiVersion);
    // `project.config.openshift.io/cluster` is a virtual singleton (kind Project
    // in the config.openshift.io group) that the kind registry cannot represent
    // (its Project kind is project.openshift.io/v1). Route exactly that object to
    // the GameEngine bridge instead of failing discovery; every other
    // config.openshift.io Project name is rejected like a real cluster would.
    if (kind === 'Project' && declaredApiVersion === 'config.openshift.io/v1') {
      const rawMetadata = isPlainObject(raw.metadata) ? raw.metadata : {};
      const configName =
        rawMetadata.name === undefined || rawMetadata.name === null ? '' : String(rawMetadata.name);
      if (configName === 'cluster') {
        const metadata = clone(rawMetadata);
        metadata.name = 'cluster';
        delete metadata.namespace; // cluster-scoped singleton
        const spec = isPlainObject(raw.spec) ? clone(raw.spec) : {};
        const extra = {};
        for (const [key, value] of Object.entries(raw)) {
          if (['apiVersion', 'kind', 'metadata', 'spec', 'status'].includes(key)) continue;
          extra[key] = clone(value);
          if (!(key in spec)) spec[key] = clone(value);
        }
        const labels = isPlainObject(metadata.labels) ? metadata.labels : {};
        const annotations = isPlainObject(metadata.annotations) ? metadata.annotations : {};
        return {
          ok: true,
          doc: { apiVersion: 'config.openshift.io/v1', kind: 'Project', metadata, spec },
          normalized: {
            kind: 'Project',
            apiVersion: 'config.openshift.io/v1',
            name: 'cluster',
            namespace: '',
            namespaced: false,
            labels,
            annotations,
            spec,
            extra,
            routed: 'project-config',
          },
        };
      }
      const message = `project.config.openshift.io "${configName}" is invalid: metadata.name: Unsupported value: "${configName}": supported values: "cluster"`;
      return { ok: false, error: `error: ${message}`, detail: { file: source, message } };
    }
    const canonical = this._canonicalKind(kind);
    // Real oc resolves (apiVersion, kind) through API discovery: kind names are
    // the exact API kind (CLI aliases such as `dc`/`svc` are not valid manifest
    // kinds) and apiVersion is required and must match the kind's group/version.
    const expectedApiVersion = canonical ? apiVersionForKind(canonical) : '';
    if (
      !canonical ||
      kind !== canonical ||
      !declaredApiVersion ||
      declaredApiVersion !== expectedApiVersion
    ) {
      const version = declaredApiVersion;
      const message = `no matches for kind "${kind}" in version "${version}"`;
      return {
        ok: false,
        error: `error: unable to recognize "${source}": ${message}`,
        detail: { file: source, message },
      };
    }

    const metadata = isPlainObject(raw.metadata) ? clone(raw.metadata) : {};
    let name = metadata.name ? String(metadata.name) : '';
    if (!name && metadata.generateName) {
      name = `${metadata.generateName}${Math.random().toString(36).slice(2, 7)}`;
    }
    if (!name) {
      return {
        ok: false,
        error: `${source}: error: resource name may not be empty (metadata.name is required)`,
        detail: { file: source, message: 'resource name may not be empty' },
      };
    }
    metadata.name = name;
    const namespaced = !isClusterScopedKind(canonical);
    if (namespaced) {
      // An explicit `-n/--namespace` overrides manifest metadata like oc's
      // EnforceNamespace; otherwise the manifest value (or current project) wins.
      const override = options && options.namespace ? String(options.namespace) : '';
      metadata.namespace =
        override || (metadata.namespace ? String(metadata.namespace) : this._currentProject());
    } else {
      metadata.namespace = '';
    }

    const spec = isPlainObject(raw.spec) ? clone(raw.spec) : {};
    // Kubernetes objects such as ConfigMap/Secret/Template/OAuth carry their
    // payload at the top level. The game model keeps it under `spec`, so fold
    // any non-standard top-level fields into spec for the simulator (and keep
    // the originals on `extra` for the engine bridge).
    const extra = {};
    for (const [key, value] of Object.entries(raw)) {
      if (['apiVersion', 'kind', 'metadata', 'spec', 'status'].includes(key)) continue;
      extra[key] = clone(value);
      if (!(key in spec)) spec[key] = clone(value);
    }

    const doc = {
      apiVersion: raw.apiVersion || apiVersionForKind(canonical),
      kind: canonical,
      metadata,
      spec,
    };
    const labels = isPlainObject(metadata.labels) ? metadata.labels : {};
    const annotations = isPlainObject(metadata.annotations) ? metadata.annotations : {};
    return {
      ok: true,
      doc,
      normalized: {
        kind: canonical,
        apiVersion: doc.apiVersion,
        name,
        namespace: metadata.namespace,
        namespaced,
        labels,
        annotations,
        spec,
        extra,
      },
    };
  }

  /** Flatten List wrappers into individual validated docs. */
  _normalizeAll(rawDocs, source, options = {}) {
    const out = [];
    const errors = [];
    const details = [];
    for (const raw of rawDocs) {
      const normalized = this._normalizeDoc(raw, source, options);
      if (!normalized.ok) {
        errors.push(normalized.error);
        details.push(normalized.detail);
        continue;
      }
      if (normalized.list) {
        for (const item of normalized.list) {
          if (!item.ok) {
            errors.push(item.error);
            details.push(item.detail);
          } else {
            out.push(item.normalized);
          }
        }
      } else {
        out.push(normalized.normalized);
      }
    }
    return { docs: out, errors, details };
  }

  // ── core apply ───────────────────────────────────────────────────────────

  _emptyResult(extra = {}) {
    const result = {
      ok: false,
      created: [],
      updated: [],
      errors: [],
      errorDetails: [],
      warnings: [],
      ...extra,
    };
    if (!result.ok && !result.error && result.errors.length > 0) result.error = result.errors[0];
    return result;
  }

  _applyFallback(normalized) {
    const cluster = this._cluster();
    if (!cluster)
      throw new Error('no cluster state available (window.game.cluster not initialised)');
    let resource = this._findResource(normalized.kind, normalized.name, normalized.namespace);
    const created = !resource;

    if (!resource) {
      resource = createResource(normalized.kind, {
        name: normalized.name,
        namespace: normalized.namespace,
        labels: normalized.labels,
        annotations: normalized.annotations,
        spec: {},
      });
      resource.apiVersion = normalized.apiVersion;
      resource.metadata.labels = { ...normalized.labels };
      resource.metadata.annotations = { ...normalized.annotations };
      resource.spec = clone(normalized.spec) || {};
      if (typeof cluster.add === 'function') cluster.add(resource);
      else throw new Error('cluster does not support add()');
    } else {
      resource.apiVersion = normalized.apiVersion;
      resource.metadata.labels = { ...(resource.metadata.labels || {}), ...normalized.labels };
      resource.metadata.annotations = {
        ...(resource.metadata.annotations || {}),
        ...normalized.annotations,
      };
      resource.spec = clone(normalized.spec) || {};
      if (typeof resource._bumpResourceVersion === 'function') resource._bumpResourceVersion();
      else if (typeof resource._bumpGeneration === 'function') resource._bumpGeneration();
      if (typeof cluster.add === 'function') {
        // Re-index labels/name (ClusterState.add on an existing UID delegates to update).
        try {
          cluster.add(resource);
        } catch {
          /* older ClusterState: mutation already visible */
        }
      }
    }
    return { resource, created };
  }

  /**
   * Apply the virtual `project.config.openshift.io/cluster` singleton.
   *
   * This object is not a Kubernetes resource in the simulator's registry: it is
   * forwarded to the GameEngine bridge (which stores the project configuration)
   * without creating a Project resource, touching cluster indexes or emitting a
   * resource:applied event.
   */
  _applyProjectConfig(normalized) {
    const engine = this._gameEngine();
    if (!engine || typeof engine.applyManifestObject !== 'function') {
      throw new Error(
        'Error from server (ServiceUnavailable): project.config.openshift.io "cluster" cannot be applied: initialise the cluster engine first'
      );
    }
    const rawObj = {
      apiVersion: normalized.apiVersion,
      kind: 'Project',
      metadata: {
        name: 'cluster',
        labels: clone(normalized.labels),
        annotations: clone(normalized.annotations),
      },
      spec: clone(normalized.spec),
    };
    for (const [key, value] of Object.entries(normalized.extra || {})) {
      if (!(key in rawObj)) rawObj[key] = clone(value);
    }
    const returned = engine.applyManifestObject(rawObj);
    if (!returned) {
      const reason =
        typeof engine.lastApplyError === 'string' && engine.lastApplyError
          ? engine.lastApplyError
          : '';
      throw new Error(
        reason ||
          'Error from server (BadRequest): unable to apply project.config.openshift.io "cluster"'
      );
    }
    if (typeof returned === 'object' && (returned.success === false || returned.ok === false)) {
      throw new Error(
        returned.message ||
          returned.error ||
          'Error from server (BadRequest): unable to apply project.config.openshift.io "cluster"'
      );
    }
    return {
      created: false,
      projectConfig: true,
      ref: {
        kind: 'Project',
        name: 'cluster',
        namespace: '',
        apiVersion: 'config.openshift.io/v1',
      },
      resource: returned,
    };
  }

  _applyOne(normalized) {
    if (normalized.routed === 'project-config') return this._applyProjectConfig(normalized);
    const engine = this._gameEngine();
    const existed = Boolean(
      this._findResource(normalized.kind, normalized.name, normalized.namespace)
    );
    let resource = null;
    let created = !existed;

    if (engine && typeof engine.applyManifestObject === 'function') {
      const rawObj = {
        apiVersion: normalized.apiVersion,
        kind: normalized.kind,
        metadata: {
          name: normalized.name,
          namespace: normalized.namespace || undefined,
          labels: clone(normalized.labels),
          annotations: clone(normalized.annotations),
        },
        spec: clone(normalized.spec),
      };
      for (const [key, value] of Object.entries(normalized.extra || {})) {
        if (!(key in rawObj)) rawObj[key] = clone(value);
      }
      const returned = engine.applyManifestObject(rawObj);
      if (returned === null) {
        // The engine rejected the object; never report a false success.
        const reason =
          typeof engine.lastApplyError === 'string' && engine.lastApplyError
            ? engine.lastApplyError
            : '';
        throw new Error(reason || `error: unable to apply ${normalized.kind} "${normalized.name}"`);
      }
      if (returned && returned.resource) {
        resource = returned.resource;
        if (typeof returned.created === 'boolean') created = returned.created;
      } else if (returned) {
        resource = returned;
      }
      if (!resource)
        resource = this._findResource(normalized.kind, normalized.name, normalized.namespace);
      if (!resource && returned === undefined) {
        throw new Error(`error: unable to apply ${normalized.kind} "${normalized.name}"`);
      }
    } else {
      const result = this._applyFallback(normalized);
      resource = result.resource;
      created = result.created;
    }

    return {
      created,
      ref: {
        kind: resource?.kind || normalized.kind,
        name: resource?.metadata?.name || normalized.name,
        namespace: resource?.metadata?.namespace ?? normalized.namespace ?? '',
      },
      resource,
    };
  }

  /**
   * Apply already-parsed YAML documents.
   * @param {object[]} rawDocs
   * @param {{source?: string, event?: string|null, path?: string, namespace?: string}} [opts]
   */
  _applyDocuments(rawDocs, opts = {}) {
    const source = opts.source || '<input>';
    const normalizeOptions = opts.namespace ? { namespace: String(opts.namespace) } : {};
    const { docs, errors, details } = this._normalizeAll(rawDocs, source, normalizeOptions);

    // Real `oc apply -f` applies every valid document and reports per-document
    // errors; a bad document does not roll back its siblings. Parse failures are
    // still handled transactionally by applyFile() before this point.
    const result = this._emptyResult({ ok: true, source });
    result.errors.push(...errors);
    result.errorDetails.push(...details);
    const warnings = [];
    const created = [];
    const updated = [];
    const autoCreatedProjects = [];
    const autoCreateProjects =
      opts.autoCreateProjects !== undefined
        ? opts.autoCreateProjects === true
        : this.options.autoCreateProjects !== false;

    const missing = new Set();
    const skippedNamespaces = new Set();
    const applicable = [];
    for (const normalized of docs) {
      if (!normalized.namespaced) {
        applicable.push(normalized);
        continue;
      }
      const ns = normalized.namespace;
      if (!ns || this._namespaceExists(ns)) {
        applicable.push(normalized);
        continue;
      }
      if (autoCreateProjects) {
        missing.add(ns);
        applicable.push(normalized);
      } else {
        skippedNamespaces.add(ns);
      }
    }

    // Simulator convenience (enabled by default): ensure target projects exist.
    // Real OCP would reject a namespaced apply with "namespaces "x" not found";
    // callers can pass {autoCreateProjects: false} to get that behaviour.
    if (autoCreateProjects && missing.size) {
      for (const ns of missing) {
        try {
          const project = this._normalizeDoc(
            {
              apiVersion: 'project.openshift.io/v1',
              kind: 'Project',
              metadata: { name: ns, labels: { 'openshift.io/requester': this._currentUser() } },
              spec: { displayName: ns, description: `Project ${ns} (created by ManifestEngine)` },
            },
            source
          );
          if (project.ok) {
            const applied = this._applyOne(project.normalized);
            autoCreatedProjects.push(applied.ref);
            warnings.push(
              `project "${ns}" did not exist and was created automatically (simulator convenience; real OpenShift: oc new-project ${ns})`
            );
          }
        } catch (err) {
          warnings.push(`could not create project "${ns}": ${err?.message || err}`);
        }
      }
    } else if (skippedNamespaces.size > 0) {
      for (const ns of skippedNamespaces) {
        const message = `Error from server (NotFound): namespaces "${ns}" not found`;
        result.errors.push(message);
        result.errorDetails.push({ file: source, message });
      }
    }

    let projectConfigApplied = false;
    for (const normalized of applicable) {
      if (normalized.namespaced && skippedNamespaces.has(normalized.namespace)) continue;
      try {
        const applied = this._applyOne(normalized);
        if (applied.projectConfig) {
          projectConfigApplied = true;
          continue;
        }
        if (applied.created) created.push(applied.ref);
        else updated.push(applied.ref);
      } catch (err) {
        result.errors.push(formatError(err, source));
        result.errorDetails.push(errorDetail(err, source));
      }
    }

    result.created = created;
    result.updated = updated;
    result.autoCreatedProjects = autoCreatedProjects;
    result.warnings.push(...warnings);
    result.ok = result.errors.length === 0;
    if (projectConfigApplied) {
      result.projectConfig = {
        apiVersion: 'config.openshift.io/v1',
        kind: 'Project',
        name: 'cluster',
      };
      if (result.ok && !result.message) {
        result.message = 'project.config.openshift.io/cluster configured';
      }
    }
    if (result.ok) delete result.error;
    else result.error = result.errors[0];

    if (result.ok && opts.event) {
      const resources = [...created, ...updated].map((ref) => ({ ...ref }));
      this.lastApplied = {
        source,
        path: opts.path || source,
        at: Date.now(),
        resources,
        created,
        updated,
      };
      this.lastErrors = [];
      this._emit(opts.event, {
        file: opts.event === 'manifest:applied' ? opts.path || source : undefined,
        path: opts.path || source,
        source,
        resources,
        created: created.map((ref) => ({ ...ref })),
        updated: updated.map((ref) => ({ ...ref })),
        warnings: [...warnings],
      });
    } else if (!result.ok) {
      this.lastErrors = [...result.errors];
    }
    return result;
  }

  _currentUser() {
    const engine = this._gameEngine();
    return engine?.currentUser || this._game()?.currentUser || 'kubeadmin';
  }

  // ── oc apply -f / oc create -f ───────────────────────────────────────────

  /**
   * `oc apply -f` / `oc create -f` for a virtual file.
   * @param {string} path
   * @param {{namespace?: string}} [options] explicit `-n/--namespace` override:
   *   additive and optional, so the Files panel's applyFile(path) is unchanged.
   * @returns {ReturnType<ManifestEngine['_emptyResult']> & {created: object[], updated: object[]}}
   */
  applyFile(path, options = {}) {
    const norm = normalizePath(path);
    if (!this.files.has(norm)) {
      // `oc apply -f <directory>` applies every YAML/JSON file below it.
      const prefix = norm ? `${norm}/` : '';
      const directoryFiles = this.listFiles().filter(
        (candidate) =>
          candidate !== norm &&
          candidate.startsWith(prefix) &&
          !candidate.startsWith('.oc/') &&
          /\.(ya?ml|json)$/i.test(candidate)
      );
      if (directoryFiles.length > 0) {
        return this._applyDirectory(norm, directoryFiles, options);
      }
      return this._emptyResult({
        errors: [`error: the path "${norm}" does not exist`],
        errorDetails: [{ file: norm, message: 'path does not exist' }],
      });
    }
    let docs;
    try {
      docs = parseYaml(this.files.get(norm), { file: norm });
    } catch (err) {
      const errors = [formatError(err, norm)];
      return this._emptyResult({ errors, errorDetails: [errorDetail(err, norm)] });
    }
    if (docs.length === 0) {
      return this._emptyResult({
        errors: [`error: no objects passed to apply (file "${norm}" is empty)`],
        errorDetails: [{ file: norm, message: 'no objects passed to apply' }],
      });
    }
    const result = this._applyDocuments(docs, {
      source: norm,
      path: norm,
      event: 'manifest:applied',
      namespace: options.namespace,
      autoCreateProjects: options.autoCreateProjects,
    });
    if (result.ok) {
      const templateMatch = this._matchPendingTemplate(docs);
      if (templateMatch) {
        templateMatch.applied = true;
        templateMatch.appliedAt = Date.now();
        templateMatch.resources = [...result.created, ...result.updated].map((ref) => ({ ...ref }));
        result.template = { path: templateMatch.path, name: templateMatch.name };
        this._emit('template:processed', {
          path: templateMatch.path,
          name: templateMatch.name,
          templateName: templateMatch.name,
          params: { ...templateMatch.params },
          resources: templateMatch.resources,
        });
      }
      this.appliedFiles.push({
        path: norm,
        source: norm,
        at: Date.now(),
        resources: [...result.created, ...result.updated].map((ref) => ({ ...ref })),
      });
      if (this.appliedFiles.length > 100) this.appliedFiles.shift();
    }
    return result;
  }

  /** Apply every manifest file in a directory (real `oc apply -f <dir>`). */
  _applyDirectory(dir, files, options = {}) {
    const aggregate = this._emptyResult({ ok: true, source: dir || '.' });
    aggregate.created = [];
    aggregate.updated = [];
    aggregate.errorDetails = [];
    aggregate.warnings = [];
    aggregate.autoCreatedProjects = [];
    for (const file of files) {
      const result = this.applyFile(file, options);
      aggregate.created.push(...(result.created || []));
      aggregate.updated.push(...(result.updated || []));
      aggregate.errors.push(...(result.errors || []));
      aggregate.errorDetails.push(...(result.errorDetails || []));
      aggregate.warnings.push(...(result.warnings || []));
      aggregate.autoCreatedProjects.push(...(result.autoCreatedProjects || []));
    }
    aggregate.ok = aggregate.errors.length === 0;
    if (aggregate.ok) delete aggregate.error;
    else aggregate.error = aggregate.errors[0];
    return aggregate;
  }

  /**
   * Parse + apply an array of objects (used by `oc process ... | oc apply -f -`).
   * @param {object[]} objects
   * @param {string} [source]
   * @param {{namespace?: string}} [options] explicit `-n/--namespace` override
   */
  applyObjects(objects, source = '<stdin>', options = {}) {
    if (!Array.isArray(objects)) {
      return this._emptyResult({
        errors: [`error: no objects supplied to apply (expected an array, got ${typeof objects})`],
      });
    }
    const docs = objects.filter((obj) => isPlainObject(obj));
    if (docs.length === 0) {
      return this._emptyResult({
        errors: ['error: no objects passed to apply'],
        errorDetails: [{ message: 'no objects passed to apply' }],
      });
    }
    const result = this._applyDocuments(docs, {
      source,
      path: source,
      event: 'manifest:applied',
      namespace: options.namespace,
      autoCreateProjects: options.autoCreateProjects,
    });

    // If the objects are the output of processTemplate(), record/emit the
    // template application (oc process ... | oc apply -f -).
    if (result.ok) {
      const match = this._matchPendingTemplate(docs);
      if (match) {
        match.applied = true;
        match.appliedAt = Date.now();
        match.resources = [...result.created, ...result.updated].map((ref) => ({ ...ref }));
        this._emit('template:processed', {
          path: match.path,
          name: match.name,
          templateName: match.name,
          params: { ...match.params },
          resources: match.resources,
        });
        result.template = { path: match.path, name: match.name };
      }
    }
    return result;
  }

  /** Apply + record a processed template in one call (no CLI pipe needed). */
  applyTemplate(path, params = {}, options = {}) {
    const processed = this.processTemplate(path, params, options);
    if (!processed.ok) {
      return {
        ok: false,
        created: [],
        updated: [],
        error: processed.error || processed.errors?.[0],
        errors: processed.errors || [],
        errorDetails: processed.errorDetails || [],
        warnings: processed.warnings || [],
      };
    }
    const applied = this.applyObjects(processed.objects, normalizePath(path));
    return {
      ...applied,
      objects: processed.objects,
      message: processed.message,
      template: { path: normalizePath(path) },
    };
  }

  _matchPendingTemplate(objects) {
    // `oc process ... | oc apply -f -` pipes a `kind: List` document; flatten it
    // so the piped objects can still be matched against a pending template.
    let candidates = objects;
    if (
      Array.isArray(objects) &&
      objects.length === 1 &&
      objects[0]?.kind === 'List' &&
      Array.isArray(objects[0].items)
    ) {
      candidates = objects[0].items;
    }
    if (!Array.isArray(candidates)) return null;
    const serialized = JSON.stringify(candidates);
    for (const entry of this.pendingTemplates) {
      if (entry.applied) continue;
      if (JSON.stringify(entry.objects) === serialized) return entry;
    }
    return null;
  }

  // ── oc apply -k ──────────────────────────────────────────────────────────

  _findKustomization(dir) {
    for (const name of KUSTOMIZATION_FILENAMES) {
      const path = dir ? `${dir}/${name}` : name;
      if (this.files.has(path)) return path;
    }
    return null;
  }

  _loadKustomization(dir, stack = new Set()) {
    const normDir = normalizePath(dir);
    if (stack.has(normDir))
      throw new Error(`kustomize: cycle detected while loading "${normDir || '.'}"`);
    stack.add(normDir);
    const kustomizationPath = this._findKustomization(normDir);
    if (!kustomizationPath) {
      throw new Error(
        `error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${
          normDir || '.'
        }'`
      );
    }
    let kustomization;
    try {
      const docs = parseYaml(this.files.get(kustomizationPath), { file: kustomizationPath });
      kustomization = docs[0] || {};
    } catch (err) {
      throw err;
    }
    if (!isPlainObject(kustomization))
      throw new Error(`${kustomizationPath}: kustomization must be a mapping`);

    const warnings = [];
    const objects = [];
    // Silent ignores hide real work from the learner: refuse unsupported
    // kustomize features loudly instead of producing a partial build. Unknown
    // fields are warned about (they may be typos for supported fields).
    const UNSUPPORTED_KUSTOMIZATION_KEYS = [
      'patchesJson6902',
      'configMapGenerator',
      'secretGenerator',
      'components',
      'replacements',
      'transformers',
      'vars',
      'helmCharts',
      'crds',
      'configurations',
      'openapi',
    ];
    const SUPPORTED_KUSTOMIZATION_KEYS = new Set([
      'apiVersion',
      'kind',
      'metadata',
      'resources',
      'bases',
      'namespace',
      'namePrefix',
      'nameSuffix',
      'commonLabels',
      'commonAnnotations',
      'labels',
      'images',
      'replicas',
      'patchesStrategicMerge',
      'patches',
      'generatorOptions',
    ]);
    const unsupportedKeys = UNSUPPORTED_KUSTOMIZATION_KEYS.filter(
      (key) => kustomization[key] !== undefined
    );
    if (unsupportedKeys.length > 0) {
      throw new Error(
        `${kustomizationPath}: ${unsupportedKeys.join(', ')} is not supported by this simulator and would otherwise be silently ignored (real kustomize v5 applies it); remove the key or use a supported kustomization field`
      );
    }
    for (const key of Object.keys(kustomization)) {
      if (!SUPPORTED_KUSTOMIZATION_KEYS.has(key)) {
        warnings.push(`${kustomizationPath}: unsupported kustomization field "${key}" ignored`);
      }
    }
    const resources = [
      ...(Array.isArray(kustomization.resources) ? kustomization.resources : []),
      ...(Array.isArray(kustomization.bases) ? kustomization.bases : []),
    ];
    for (const resource of resources) {
      if (typeof resource !== 'string') {
        warnings.push(`${kustomizationPath}: resource entries must be strings`);
        continue;
      }
      if (/^[a-z]+:\/\//i.test(resource)) {
        throw new Error(
          `${kustomizationPath}: remote kustomize resources are not supported ("${resource}")`
        );
      }
      const resolved = resolvePath(normDir, resource);
      if (/\.ya?ml$/i.test(resolved)) {
        if (!this.files.has(resolved))
          throw new Error(`${kustomizationPath}: resource file "${resource}" not found`);
        const docs = parseYaml(this.files.get(resolved), { file: resolved });
        for (const doc of docs) {
          if (isPlainObject(doc)) objects.push(clone(doc));
        }
      } else {
        const nested = this._loadKustomization(resolved, stack);
        objects.push(...nested.objects);
        warnings.push(...nested.warnings);
      }
    }

    // patchesStrategicMerge: file paths (relative to kustomization) or inline YAML.
    const patches = Array.isArray(kustomization.patchesStrategicMerge)
      ? kustomization.patchesStrategicMerge
      : [];
    for (const patchEntry of patches) {
      let patchDocs = [];
      let patchSource = kustomizationPath;
      if (typeof patchEntry === 'string') {
        if (
          patchEntry.includes('\n') ||
          patchEntry.trim().startsWith('apiVersion:') ||
          patchEntry.trim().startsWith('{')
        ) {
          patchDocs = parseYaml(patchEntry, { file: `${kustomizationPath} (inline patch)` });
          patchSource = `${kustomizationPath} (inline patch)`;
        } else {
          const patchPath = resolvePath(normDir, patchEntry);
          if (!this.files.has(patchPath))
            throw new Error(`${kustomizationPath}: patch "${patchEntry}" not found`);
          patchDocs = parseYaml(this.files.get(patchPath), { file: patchPath });
          patchSource = patchPath;
        }
      } else if (isPlainObject(patchEntry)) {
        patchDocs = [patchEntry];
      } else {
        warnings.push(`${kustomizationPath}: unsupported patchesStrategicMerge entry`);
        continue;
      }
      for (const patch of patchDocs) {
        if (!isPlainObject(patch) || !patch.kind || !patch.metadata?.name) {
          throw new Error(`${patchSource}: strategic merge patch needs kind and metadata.name`);
        }
        const patchKind = this._canonicalKind(patch.kind) || String(patch.kind);
        const target = objects.find(
          (obj) =>
            (this._canonicalKind(obj.kind) || obj.kind) === patchKind &&
            obj.metadata?.name === patch.metadata.name
        );
        if (!target) {
          throw new Error(
            `${patchSource}: no resource matched the strategic merge patch for ${patchKind}/${patch.metadata.name}`
          );
        }
        objects[objects.indexOf(target)] = this._mergeStrategicPatch(target, patch);
      }
    }

    // patches: [{path | patch, target?}] — newer kustomize field. JSON6902 is
    // not implemented; strategic-merge patches (with or without a target) are.
    const newerPatches = Array.isArray(kustomization.patches) ? kustomization.patches : [];
    for (const entry of newerPatches) {
      if (!isPlainObject(entry)) {
        throw new Error(
          `${kustomizationPath}: "patches" entries must be mappings with a "path"/"patch" (and optional "target")`
        );
      }
      const targetSpec = isPlainObject(entry.target) ? entry.target : null;
      let patchDocs = [];
      let patchSource = `${kustomizationPath} (inline patch)`;
      if (typeof entry.path === 'string' && entry.path) {
        const patchPath = resolvePath(normDir, entry.path);
        if (!this.files.has(patchPath))
          throw new Error(`${kustomizationPath}: patch "${entry.path}" not found`);
        patchDocs = parseYaml(this.files.get(patchPath), { file: patchPath });
        patchSource = patchPath;
      } else if (typeof entry.patch === 'string') {
        patchDocs = parseYaml(entry.patch, { file: `${kustomizationPath} (inline patch)` });
      } else {
        throw new Error(
          `${kustomizationPath}: "patches" entries need a "path" or an inline "patch"`
        );
      }
      if (patchDocs.some((doc) => Array.isArray(doc))) {
        throw new Error(
          `${patchSource}: JSON6902 patch lists are not supported by this simulator; use a strategic-merge patch (kind/metadata.name)`
        );
      }
      for (const patch of patchDocs) {
        if (!isPlainObject(patch))
          throw new Error(`${patchSource}: patch document must be a mapping`);
        const patchKind = (targetSpec && targetSpec.kind) || patch.kind;
        const patchName = (targetSpec && targetSpec.name) || patch.metadata?.name;
        if (!patchKind || !patchName) {
          throw new Error(
            `${patchSource}: strategic-merge patch needs kind and metadata.name (or target {kind, name})`
          );
        }
        if (targetSpec && (targetSpec.labelSelector || targetSpec.annotationSelector)) {
          throw new Error(
            `${patchSource}: "patches" target selectors are not supported; use target {kind, name}`
          );
        }
        const canonicalPatchKind = this._canonicalKind(patchKind) || String(patchKind);
        const targetNamespace =
          targetSpec && targetSpec.namespace ? String(targetSpec.namespace) : '';
        const target = objects.find(
          (obj) =>
            (this._canonicalKind(obj.kind) || obj.kind) === canonicalPatchKind &&
            obj.metadata?.name === patchName &&
            (!targetNamespace || obj.metadata?.namespace === targetNamespace)
        );
        if (!target)
          throw new Error(
            `${patchSource}: no resource matched patch for ${patchKind}/${patchName}`
          );
        objects[objects.indexOf(target)] = this._mergeStrategicPatch(target, patch);
      }
    }

    // Transformers: namespace, namePrefix/nameSuffix, labels, images, replicas.
    const namespace = kustomization.namespace ? String(kustomization.namespace) : '';
    const namePrefix = kustomization.namePrefix ? String(kustomization.namePrefix) : '';
    const nameSuffix = kustomization.nameSuffix ? String(kustomization.nameSuffix) : '';
    const commonLabels = {
      ...(isPlainObject(kustomization.commonLabels) ? kustomization.commonLabels : {}),
    };
    const labelPairs = {};
    let includeSelectors = false;
    if (Array.isArray(kustomization.labels)) {
      for (const entry of kustomization.labels) {
        if (!isPlainObject(entry)) continue;
        Object.assign(commonLabels, isPlainObject(entry.pairs) ? entry.pairs : {});
        if (entry.includeSelectors === true) includeSelectors = true;
      }
    }
    if (includeSelectors) Object.assign(labelPairs, commonLabels);
    const commonAnnotations = isPlainObject(kustomization.commonAnnotations)
      ? kustomization.commonAnnotations
      : {};

    const nameMap = new Map();
    for (const obj of objects) {
      if (!isPlainObject(obj.metadata)) obj.metadata = {};
      const oldName = obj.metadata.name;
      if (oldName && (namePrefix || nameSuffix)) {
        obj.metadata.name = `${namePrefix}${oldName}${nameSuffix}`;
        nameMap.set(oldName, obj.metadata.name);
      }
    }
    if (namespace) {
      for (const obj of objects) {
        const kind = this._canonicalKind(obj.kind) || obj.kind;
        if (!isClusterScopedKind(kind)) obj.metadata.namespace = namespace;
      }
    }
    for (const obj of objects) {
      if (!isPlainObject(obj.metadata.labels)) obj.metadata.labels = {};
      Object.assign(obj.metadata.labels, commonLabels);
      if (Object.keys(commonAnnotations).length) {
        if (!isPlainObject(obj.metadata.annotations)) obj.metadata.annotations = {};
        Object.assign(obj.metadata.annotations, commonAnnotations);
      }
      this._addCommonLabelsToSelectors(obj, labelPairs);
    }

    this._applyNameReferences(objects, nameMap);

    if (Array.isArray(kustomization.images)) {
      for (const image of kustomization.images)
        this._transformImages(objects, image, kustomizationPath);
    }
    if (Array.isArray(kustomization.replicas)) {
      for (const replica of kustomization.replicas) {
        if (!isPlainObject(replica) || !replica.name) continue;
        const targets = objects.filter((obj) => {
          const kind = this._canonicalKind(obj.kind) || obj.kind;
          if (kind !== 'Deployment' && kind !== 'StatefulSet' && kind !== 'ReplicaSet')
            return false;
          const current = obj.metadata?.name;
          return (
            current === replica.name || current === `${namePrefix}${replica.name}${nameSuffix}`
          );
        });
        if (targets.length === 0) {
          warnings.push(
            `${kustomizationPath}: replicas entry "${replica.name}" did not match any workload`
          );
        }
        for (const target of targets) {
          if (!isPlainObject(target.spec)) target.spec = {};
          target.spec.replicas = Number(replica.count);
        }
      }
    }

    stack.delete(normDir);
    return { objects, warnings, kustomizationPath };
  }

  /** Merge a strategic-merge patch into a target object, preserving identity fields. */
  _mergeStrategicPatch(target, patch) {
    const merged = strategicMerge(target, patch);
    merged.kind = target.kind;
    merged.apiVersion = target.apiVersion;
    const metadata = isPlainObject(merged.metadata)
      ? merged.metadata
      : { ...(target.metadata || {}) };
    metadata.name = target.metadata?.name || metadata.name;
    if (target.metadata?.namespace) metadata.namespace = target.metadata.namespace;
    merged.metadata = metadata;
    return merged;
  }

  _addCommonLabelsToSelectors(obj, labels) {
    if (!labels || Object.keys(labels).length === 0) return;
    const kind = this._canonicalKind(obj.kind) || obj.kind;
    if (kind === 'Service' && isPlainObject(obj.spec?.selector)) {
      Object.assign(obj.spec.selector, labels);
      return;
    }
    if (!WORKLOAD_KINDS.has(kind)) return;
    if (isPlainObject(obj.spec?.selector?.matchLabels)) {
      Object.assign(obj.spec.selector.matchLabels, labels);
    } else if (kind === 'Pod' && isPlainObject(obj.metadata.labels)) {
      Object.assign(obj.metadata.labels, labels);
    }
    if (isPlainObject(obj.spec?.template?.metadata?.labels)) {
      Object.assign(obj.spec.template.metadata.labels, labels);
    } else if (isPlainObject(obj.spec?.template?.metadata)) {
      obj.spec.template.metadata.labels = { ...labels };
    } else if (obj.spec?.template) {
      if (!isPlainObject(obj.spec.template.metadata)) obj.spec.template.metadata = {};
      obj.spec.template.metadata.labels = { ...labels };
    }
  }

  _applyNameReferences(objects, nameMap) {
    if (nameMap.size === 0) return;
    const remap = (value) =>
      typeof value === 'string' && nameMap.has(value) ? nameMap.get(value) : value;
    const remapPodSpec = (podSpec) => {
      if (!isPlainObject(podSpec)) return;
      if (podSpec.serviceAccountName)
        podSpec.serviceAccountName = remap(podSpec.serviceAccountName);
      for (const secret of podSpec.imagePullSecrets || []) {
        if (secret?.name) secret.name = remap(secret.name);
      }
      for (const key of ['containers', 'initContainers']) {
        for (const container of podSpec[key] || []) {
          if (!isPlainObject(container)) continue;
          for (const envFrom of container.envFrom || []) {
            if (envFrom?.configMapRef?.name)
              envFrom.configMapRef.name = remap(envFrom.configMapRef.name);
            if (envFrom?.secretRef?.name) envFrom.secretRef.name = remap(envFrom.secretRef.name);
          }
          for (const env of container.env || []) {
            if (env?.valueFrom?.configMapKeyRef?.name)
              env.valueFrom.configMapKeyRef.name = remap(env.valueFrom.configMapKeyRef.name);
            if (env?.valueFrom?.secretKeyRef?.name)
              env.valueFrom.secretKeyRef.name = remap(env.valueFrom.secretKeyRef.name);
          }
        }
      }
      for (const volume of podSpec.volumes || []) {
        if (volume?.configMap?.name) volume.configMap.name = remap(volume.configMap.name);
        if (volume?.secret?.secretName) volume.secret.secretName = remap(volume.secret.secretName);
        for (const source of volume?.projected?.sources || []) {
          if (source?.configMap?.name) source.configMap.name = remap(source.configMap.name);
          if (source?.secret?.name) source.secret.name = remap(source.secret.name);
        }
      }
    };
    for (const obj of objects) {
      const kind = this._canonicalKind(obj.kind) || obj.kind;
      if (kind === 'Route') {
        if (obj.spec?.to?.name) obj.spec.to.name = remap(obj.spec.to.name);
        for (const backend of obj.spec?.alternateBackends || []) {
          if (backend?.name) backend.name = remap(backend.name);
        }
      } else if (kind === 'StatefulSet' && obj.spec?.serviceName) {
        obj.spec.serviceName = remap(obj.spec.serviceName);
      } else if (kind === 'HorizontalPodAutoscaler' && obj.spec?.scaleTargetRef?.name) {
        obj.spec.scaleTargetRef.name = remap(obj.spec.scaleTargetRef.name);
      } else if (kind === 'RoleBinding' || kind === 'ClusterRoleBinding') {
        if (obj.roleRef?.name) obj.roleRef.name = remap(obj.roleRef.name);
      } else if (kind === 'Ingress') {
        for (const rule of obj.spec?.rules || []) {
          for (const path of rule?.http?.paths || []) {
            if (path?.backend?.service?.name)
              path.backend.service.name = remap(path.backend.service.name);
          }
        }
      }
      if (WORKLOAD_KINDS.has(kind)) remapPodSpec(obj.spec?.template?.spec);
      if (kind === 'CronJob') remapPodSpec(obj.spec?.jobTemplate?.spec?.template?.spec);
      if (kind === 'Pod') remapPodSpec(obj.spec);
    }
  }

  _transformImages(objects, imageSpec, source) {
    if (!isPlainObject(imageSpec) || !imageSpec.name) return;
    const targetName = String(imageSpec.name);
    const visit = (node) => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!isPlainObject(node)) return;
      if (Array.isArray(node.containers)) visit(node.containers);
      if (Array.isArray(node.initContainers)) visit(node.initContainers);
      for (const key of ['containers', 'initContainers']) {
        if (!Array.isArray(node[key])) continue;
        for (const container of node[key]) {
          if (!isPlainObject(container) || typeof container.image !== 'string') continue;
          const image = container.image;
          let digest = '';
          let withoutDigest = image;
          const at = image.indexOf('@');
          if (at !== -1) {
            digest = image.slice(at + 1);
            withoutDigest = image.slice(0, at);
          }
          let tag = '';
          let repository = withoutDigest;
          const slash = withoutDigest.lastIndexOf('/');
          const colon = withoutDigest.lastIndexOf(':');
          if (colon > slash) {
            tag = withoutDigest.slice(colon + 1);
            repository = withoutDigest.slice(0, colon);
          }
          if (repository !== targetName) continue;
          const nextRepository = imageSpec.newName ? String(imageSpec.newName) : repository;
          const nextTag = imageSpec.newTag !== undefined ? String(imageSpec.newTag) : tag;
          const nextDigest = imageSpec.digest !== undefined ? String(imageSpec.digest) : digest;
          container.image = `${nextRepository}${nextDigest ? `@${nextDigest}` : nextTag ? `:${nextTag}` : ''}`;
        }
      }
      for (const value of Object.values(node)) {
        if (isPlainObject(value) || Array.isArray(value)) visit(value);
      }
    };
    visit(objects);
  }

  /**
   * `oc kustomize <dir>`: render the kustomization to YAML objects without
   * touching the cluster (used by the CLI's render-only command).
   * @returns {{ok: boolean, objects: object[], yaml: string, warnings: string[], error?: string}}
   */
  renderKustomize(dirPath = '') {
    const dir = normalizePath(dirPath);
    const kustomizationPath = this._findKustomization(dir);
    if (!kustomizationPath) {
      const message = `error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${
        dir || '.'
      }'`;
      return { ok: false, objects: [], yaml: '', warnings: [], errors: [message], error: message };
    }
    try {
      const loaded = this._loadKustomization(dir);
      const yaml = loaded.objects.map((obj) => `---\n${stringifyYaml(obj)}`).join('');
      return { ok: true, objects: loaded.objects, yaml, warnings: loaded.warnings, errors: [] };
    } catch (err) {
      const message = formatError(err, kustomizationPath);
      return { ok: false, objects: [], yaml: '', warnings: [], errors: [message], error: message };
    }
  }

  applyKustomize(dirPath = '', options = {}) {
    const dir = normalizePath(dirPath);
    const kustomizationPath = this._findKustomization(dir);
    if (!kustomizationPath) {
      const message = `error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${
        dir || '.'
      }'`;
      return this._emptyResult({
        errors: [message],
        errorDetails: [{ file: dir || '.', message }],
      });
    }
    let loaded;
    try {
      loaded = this._loadKustomization(dir);
    } catch (err) {
      return this._emptyResult({
        errors: [formatError(err, kustomizationPath)],
        errorDetails: [errorDetail(err, kustomizationPath)],
      });
    }
    const result = this._applyDocuments(loaded.objects, {
      source: dir || '.',
      path: dir || '.',
      event: 'kustomize:applied',
      namespace: options.namespace,
      autoCreateProjects: options.autoCreateProjects,
    });
    result.warnings = [...loaded.warnings, ...(result.warnings || [])];
    if (result.ok) {
      this.appliedKustomize.push({
        path: dir || '.',
        kustomization: kustomizationPath,
        at: Date.now(),
        resources: [...result.created, ...result.updated].map((ref) => ({ ...ref })),
      });
      if (this.appliedKustomize.length > 100) this.appliedKustomize.shift();
    }
    return result;
  }

  // ── OpenShift templates ──────────────────────────────────────────────────

  _templateParameterDefs(templateDoc) {
    const spec = isPlainObject(templateDoc?.spec) ? templateDoc.spec : {};
    if (Array.isArray(templateDoc?.parameters)) return templateDoc.parameters;
    if (Array.isArray(spec.parameters)) return spec.parameters;
    return [];
  }

  _templateObjects(templateDoc) {
    const spec = isPlainObject(templateDoc?.spec) ? templateDoc.spec : {};
    if (Array.isArray(templateDoc?.objects)) return templateDoc.objects;
    if (Array.isArray(spec.objects)) return spec.objects;
    return [];
  }

  /** @returns {Record<string, string>} */
  _normalizeParams(params) {
    if (!params) return {};
    if (Array.isArray(params)) {
      const out = {};
      for (const entry of params) {
        if (typeof entry === 'string') {
          const eq = entry.indexOf('=');
          if (eq > 0) out[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
        } else if (isPlainObject(entry)) {
          for (const [key, value] of Object.entries(entry)) out[key] = String(value);
        }
      }
      return out;
    }
    if (isPlainObject(params)) {
      const out = {};
      for (const [key, value] of Object.entries(params)) out[key] = String(value);
      return out;
    }
    return {};
  }

  _generateParameterValue(expression) {
    const expr = String(expression || '').trim();
    const match = /^\[(.*)\]\{(\d+)\}$/.exec(expr);
    if (!match) return Math.random().toString(36).slice(2, 12);
    let pool = '';
    const chars = match[1];
    for (let i = 0; i < chars.length; i++) {
      if (chars[i + 1] === '-' && chars[i + 2] && i + 2 < chars.length) {
        const start = chars.charCodeAt(i);
        const end = chars.charCodeAt(i + 2);
        for (let code = start; code <= end; code++) pool += String.fromCharCode(code);
        i += 2;
      } else {
        pool += chars[i];
      }
    }
    if (!pool) pool = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const length = parseInt(match[2], 10);
    let out = '';
    for (let i = 0; i < length; i++) out += pool[Math.floor(Math.random() * pool.length)];
    return out;
  }

  _substituteString(input, values, warnings, pathLabel) {
    const wholeBrace = /^\$\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(input.trim());
    const wholeSimple = /^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}$/.exec(input.trim());
    const whole = wholeBrace || wholeSimple;
    if (whole) {
      const name = whole[1];
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        const raw = String(values[name]);
        if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        return raw;
      }
      warnings.add(`template parameter "${name}" is not declared`);
      return input;
    }
    let out = input;
    const replace = (name, original) => {
      if (Object.prototype.hasOwnProperty.call(values, name)) return String(values[name]);
      warnings.add(`template parameter "${name}" is not declared (${pathLabel})`);
      return original;
    };
    out = out.replace(/\$\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name) =>
      replace(name, match)
    );
    out = out.replace(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g, (match, name) =>
      replace(name, match)
    );
    return out;
  }

  _substituteDeep(value, values, warnings, pathLabel) {
    if (typeof value === 'string')
      return this._substituteString(value, values, warnings, pathLabel);
    if (Array.isArray(value))
      return value.map((item, index) =>
        this._substituteDeep(item, values, warnings, `${pathLabel}[${index}]`)
      );
    if (isPlainObject(value)) {
      const out = {};
      for (const [key, val] of Object.entries(value)) {
        out[key] = this._substituteDeep(val, values, warnings, `${pathLabel}.${key}`);
      }
      return out;
    }
    return value;
  }

  /**
   * Render an OpenShift Template. Does NOT apply anything: pipe the returned
   * objects/YAML to applyObjects() (CLI) or call applyTemplate().
   */
  processTemplate(path, params = {}, options = {}) {
    const norm = normalizePath(path);
    if (!this.files.has(norm)) {
      return {
        ok: false,
        objects: [],
        yaml: '',
        error: `error: the path "${norm}" does not exist`,
        errors: [`error: the path "${norm}" does not exist`],
        errorDetails: [{ file: norm, message: 'path does not exist' }],
        warnings: [],
      };
    }
    let docs;
    try {
      docs = parseYaml(this.files.get(norm), { file: norm });
    } catch (err) {
      return {
        ok: false,
        objects: [],
        yaml: '',
        error: formatError(err, norm),
        errors: [formatError(err, norm)],
        errorDetails: [errorDetail(err, norm)],
        warnings: [],
      };
    }
    const templateDoc = docs.find(
      (doc) => isPlainObject(doc) && this._canonicalKind(doc.kind) === 'Template'
    );
    if (!templateDoc) {
      return {
        ok: false,
        objects: [],
        yaml: '',
        error: `error: no Template object found in "${norm}"`,
        errors: [`error: no Template object found in "${norm}"`],
        errorDetails: [{ file: norm, message: 'no Template object found' }],
        warnings: [],
      };
    }

    const overrides = this._normalizeParams(params);
    const defs = this._templateParameterDefs(templateDoc);
    const declared = new Set(defs.map((def) => def?.name).filter(Boolean));
    const errors = [];
    const warnings = new Set();
    const values = {};

    const ignoreUnknownParameters = options && options.ignoreUnknownParameters === true;
    for (const name of Object.keys(overrides)) {
      if (declared.has(name)) continue;
      // Real `oc process` fails on undeclared -p parameters unless
      // --ignore-unknown-parameters is passed.
      if (ignoreUnknownParameters) warnings.add(`unknown template parameter "${name}"`);
      else errors.push(`unknown parameter: ${name}`);
    }

    for (const def of defs) {
      if (!isPlainObject(def) || !def.name) continue;
      const name = String(def.name);
      let value;
      if (Object.prototype.hasOwnProperty.call(overrides, name)) value = overrides[name];
      else if (def.value !== undefined && def.value !== null) value = String(def.value);
      else if (def.generate) value = this._generateParameterValue(def.from);
      if (value === undefined || value === null) value = '';
      if (def.required === true && value === '') {
        errors.push(`template parameter ${name} is required`);
        continue;
      }
      values[name] = String(value);
    }

    if (errors.length > 0) {
      return {
        ok: false,
        objects: [],
        yaml: '',
        error: errors[0],
        errors,
        errorDetails: errors.map((message) => ({ file: norm, message })),
        warnings: [...warnings.values()],
        parameters: values,
      };
    }

    const rawObjects = this._templateObjects(templateDoc);
    if (rawObjects.length === 0) {
      return {
        ok: false,
        objects: [],
        yaml: '',
        error: `error: Template "${templateDoc.metadata?.name || norm}" has no objects`,
        errors: [`error: Template "${templateDoc.metadata?.name || norm}" has no objects`],
        errorDetails: [{ file: norm, message: 'template has no objects' }],
        warnings: [...warnings.values()],
        parameters: values,
      };
    }

    const objects = clone(rawObjects).map((obj, index) =>
      this._substituteDeep(obj, values, warnings, `${norm}.objects[${index}]`)
    );
    const templateSpec = isPlainObject(templateDoc.spec) ? templateDoc.spec : {};
    const rawMessage =
      typeof templateDoc.message === 'string' ? templateDoc.message : templateSpec.message;
    const message =
      typeof rawMessage === 'string'
        ? this._substituteString(rawMessage, values, warnings, `${norm}.message`)
        : '';

    const record = {
      path: norm,
      name: templateDoc.metadata?.name || norm,
      params: { ...values },
      objects: clone(objects),
      applied: false,
      at: Date.now(),
    };
    this.templates.push(record);
    if (this.templates.length > 50) this.templates.shift();
    this.pendingTemplates.unshift(record);
    if (this.pendingTemplates.length > 10) this.pendingTemplates.pop();

    const yaml = objects.map((obj) => `---\n${stringifyYaml(obj)}`).join('');
    return {
      ok: true,
      objects,
      yaml,
      message,
      templateName: record.name,
      path: norm,
      parameters: { ...values },
      errors: [],
      errorDetails: [],
      warnings: [...warnings.values()],
    };
  }

  /** List declared parameters of a template (`oc process --parameters -f`). */
  templateParameters(path) {
    const docs = (() => {
      try {
        return parseYaml(this.files.get(normalizePath(path)) || '', { file: normalizePath(path) });
      } catch {
        return [];
      }
    })();
    const templateDoc = docs.find(
      (doc) => isPlainObject(doc) && this._canonicalKind(doc.kind) === 'Template'
    );
    if (!templateDoc) return [];
    return this._templateParameterDefs(templateDoc).map((def) => ({
      name: def.name,
      displayName: def.displayName || '',
      description: def.description || '',
      value: def.value ?? '',
      required: def.required === true,
      generate: def.generate || '',
      from: def.from || '',
    }));
  }

  // ── oc delete -f ─────────────────────────────────────────────────────────

  deleteFileObjects(path, options = {}) {
    const norm = normalizePath(path);
    if (!this.files.has(norm)) {
      const error = `error: the path "${norm}" does not exist`;
      return { ok: false, deleted: [], errors: [error], error, errorDetails: [] };
    }
    let docs;
    try {
      docs = parseYaml(this.files.get(norm), { file: norm });
    } catch (err) {
      return {
        ok: false,
        deleted: [],
        error: formatError(err, norm),
        errors: [formatError(err, norm)],
        errorDetails: [errorDetail(err, norm)],
      };
    }
    const normalizeOptions =
      options && options.namespace ? { namespace: String(options.namespace) } : {};
    const {
      docs: normalizedDocs,
      errors,
      details,
    } = this._normalizeAll(docs, norm, normalizeOptions);
    if (errors.length > 0)
      return { ok: false, deleted: [], errors, error: errors[0], errorDetails: details };

    const deleted = [];
    const notFound = [];
    const deleteErrors = [...errors];
    const errorDetails = [...details];
    const cluster = this._cluster();
    for (const normalized of normalizedDocs) {
      if (normalized && normalized.routed === 'project-config') {
        // Never delete a real Project that happens to be named "cluster": the
        // project configuration singleton is not a deletable resource here.
        const message =
          'Error from server (BadRequest): project.config.openshift.io "cluster" cannot be deleted in this simulator';
        deleteErrors.push(message);
        errorDetails.push({ file: norm, message });
        continue;
      }
      const { kind, name, namespace } = normalized;
      const resource = this._findResource(kind, name, namespace);
      if (!resource) {
        notFound.push({ kind, name, namespace });
        const apiGroup = apiVersionForKind(kind).includes('/')
          ? `.${apiVersionForKind(kind).split('/')[0]}`
          : '';
        deleteErrors.push(
          `Error from server (NotFound): ${kind.toLowerCase()}s${apiGroup} "${name}" not found`
        );
        continue;
      }
      try {
        if (cluster && typeof cluster.remove === 'function')
          cluster.remove(resource.uid || resource.metadata?.uid);
        else throw new Error('cluster does not support remove()');
        deleted.push({
          kind: resource.kind || kind,
          name: resource.metadata?.name || name,
          namespace,
        });
      } catch (err) {
        deleteErrors.push(formatError(err, norm));
        errorDetails.push(errorDetail(err, norm));
      }
    }
    return {
      ok: deleteErrors.length === 0,
      deleted,
      notFound,
      ...(deleteErrors.length > 0 ? { error: deleteErrors[0] } : {}),
      errors: deleteErrors,
      errorDetails,
    };
  }

  // ── Helm ─────────────────────────────────────────────────────────────────

  _readChart(chartDir, valuesPath, release, namespace, opts = {}) {
    const dir = normalizePath(chartDir);
    const chartPath = `${dir}/Chart.yaml`;
    if (!this.files.has(chartPath)) {
      return {
        ok: false,
        errors: [`Error: chart "${dir || '.'}" not found: Chart.yaml is missing`],
        errorDetails: [],
      };
    }
    let chart;
    let defaults = {};
    try {
      const chartDocs = parseYaml(this.files.get(chartPath), { file: chartPath });
      chart = isPlainObject(chartDocs[0]) ? chartDocs[0] : {};
      const valuesPathResolved = `${dir}/values.yaml`;
      if (this.files.has(valuesPathResolved)) {
        const valueDocs = parseYaml(this.files.get(valuesPathResolved), {
          file: valuesPathResolved,
        });
        defaults = isPlainObject(valueDocs[0]) ? valueDocs[0] : {};
      }
    } catch (err) {
      return {
        ok: false,
        errors: [formatError(err, `${dir}/Chart.yaml`)],
        errorDetails: [errorDetail(err, `${dir}/Chart.yaml`)],
      };
    }

    let overrides = {};
    if (valuesPath) {
      const resolvedValues = normalizePath(valuesPath);
      if (!this.files.has(resolvedValues)) {
        return {
          ok: false,
          errors: [`Error: values file "${resolvedValues}" not found`],
          errorDetails: [{ file: resolvedValues, message: 'values file not found' }],
        };
      }
      try {
        const docs = parseYaml(this.files.get(resolvedValues), { file: resolvedValues });
        overrides = isPlainObject(docs[0]) ? docs[0] : {};
      } catch (err) {
        return {
          ok: false,
          errors: [formatError(err, resolvedValues)],
          errorDetails: [errorDetail(err, resolvedValues)],
        };
      }
    }

    let values = deepMerge(defaults, overrides);
    const setValues = isPlainObject(opts.setValues)
      ? opts.setValues
      : isPlainObject(opts.values)
        ? opts.values
        : null;
    if (setValues) values = deepMerge(values, setValues);
    // Repo charts (`bitnami/nginx --version 15.0.0`) are rendered from the
    // bundled chart templates, but Helm exposes the CATALOG chart identity to
    // templates (`.Chart.Name/Version/AppVersion`) and to history/list output.
    // Callers pass those through opts so `helm rollback` can re-deploy the
    // exact chart revision (#24).
    const chartName = opts.chartName
      ? String(opts.chartName)
      : chart.name
        ? String(chart.name)
        : basename(dir);
    const chartVersion = opts.chartVersion
      ? String(opts.chartVersion)
      : chart.version
        ? String(chart.version)
        : '0.0.0';
    const chartAppVersion =
      opts.appVersion !== undefined && opts.appVersion !== null && opts.appVersion !== ''
        ? String(opts.appVersion)
        : chart.appVersion
          ? String(chart.appVersion)
          : '';
    const templatePaths = this.listFiles().filter((path) => {
      if (!path.startsWith(`${dir}/templates/`)) return false;
      return /\.(ya?ml)$/i.test(path);
    });
    if (templatePaths.length === 0) {
      return {
        ok: false,
        errors: [`Error: chart "${chartName}" has no templates/*.yaml files`],
        errorDetails: [],
      };
    }

    const context = {
      Release: { Name: release, Namespace: namespace, Service: 'Helm' },
      Chart: { Name: chartName, Version: chartVersion, AppVersion: chartAppVersion },
      Values: values,
    };

    const objects = [];
    for (const templatePath of templatePaths) {
      let rendered;
      try {
        rendered = this._renderGoTemplate(this.files.get(templatePath), context, templatePath);
      } catch (err) {
        return {
          ok: false,
          errors: [formatError(err, templatePath)],
          errorDetails: [errorDetail(err, templatePath)],
        };
      }
      let docs;
      try {
        docs = parseYaml(rendered, { file: templatePath });
      } catch (err) {
        return {
          ok: false,
          errors: [formatError(err, templatePath)],
          errorDetails: [errorDetail(err, templatePath)],
        };
      }
      for (const doc of docs) {
        if (!isPlainObject(doc)) continue;
        const coerced = coerceNumberStrings(doc);
        if (!isPlainObject(coerced.metadata)) coerced.metadata = {};
        const kind = this._canonicalKind(coerced.kind) || coerced.kind;
        if (!isClusterScopedKind(kind) && !coerced.metadata.namespace)
          coerced.metadata.namespace = namespace;
        objects.push(coerced);
      }
    }
    return {
      ok: true,
      objects,
      values,
      chart: { name: chartName, version: chartVersion, appVersion: chartAppVersion, chart },
      errors: [],
      errorDetails: [],
    };
  }

  _renderGoTemplate(text, context, filePath) {
    return String(text).replace(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g, (match, expression) => {
      const expr = expression.trim();
      if (!expr) return '';
      try {
        return this._evalTemplateExpression(expr, context);
      } catch (err) {
        throw new Error(`${filePath}: ${err.message}`);
      }
    });
  }

  _evalTemplateExpression(expression, context) {
    const parts = expression.split('|').map((part) => part.trim());
    // A missing value is allowed to flow through pipelines: `| default` exists
    // precisely to replace nil values (Helm/Sprig semantics).
    let value = this._evalTemplateValue(parts[0], context);
    for (const part of parts.slice(1)) {
      if (part === 'quote') {
        value = JSON.stringify(value === undefined || value === null ? '' : String(value));
      } else if (part.startsWith('default ')) {
        const literal = part
          .slice('default '.length)
          .trim()
          .replace(/^["']|["']$/g, '');
        if (value === undefined || value === null || value === '') value = literal;
      } else if (part === 'toString') {
        value = String(value ?? '');
      } else {
        throw new Error(`unsupported Helm template pipeline "| ${part}"`);
      }
    }
    if (value === undefined || value === null) {
      throw new Error(`no value for expression "{{ ${expression} }}"`);
    }
    return String(value);
  }

  _evalTemplateValue(term, context) {
    const token = term.trim();
    if (token.startsWith('"') || token.startsWith("'")) {
      return token.slice(1, -1);
    }
    if (token.startsWith('.')) {
      const path = token.split('.').filter(Boolean);
      let current = context;
      for (const segment of path) {
        if (current === undefined || current === null || typeof current !== 'object') {
          current = undefined;
          break;
        }
        current = current[segment];
      }
      return current;
    }
    if (/^-?\d+$/.test(token)) return parseInt(token, 10);
    if (token === 'true') return true;
    if (token === 'false') return false;
    throw new Error(`unsupported Helm template expression "${term}"`);
  }

  _helmReleaseError(message) {
    return {
      ok: false,
      error: message,
      released: null,
      resources: [],
      errors: [message],
      errorDetails: [],
      deleted: [],
    };
  }

  _validateReleaseName(release) {
    if (!release || typeof release !== 'string') return 'release name is required';
    if (release.length > 53) return `release name "${release}" is longer than 53 characters`;
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(release)) {
      return `release name "${release}" is invalid: must be lowercase alphanumeric with dashes`;
    }
    return null;
  }

  /** Render a chart without applying it. */
  renderHelm(release, chartDir, valuesPath = null, opts = {}) {
    const invalid = this._validateReleaseName(release);
    if (invalid) return this._helmReleaseError(`Error: ${invalid}`);
    const namespace = opts.namespace || this._currentProject() || 'default';
    const chart = this._readChart(chartDir, valuesPath, release, namespace, opts);
    if (!chart.ok) return { ...chart, released: null, resources: [], error: chart.errors?.[0] };
    return { ...chart, released: release, namespace };
  }

  _helmKey(namespace, name) {
    return `${namespace || 'default'}/${name}`;
  }

  /** Release records are namespace-scoped in Helm 3. */
  _helmMatches(name, opts = {}) {
    if (opts.namespace) {
      const record = this.helmReleases.get(this._helmKey(String(opts.namespace), name));
      return record ? [record] : [];
    }
    return [...this.helmReleases.values()].filter((record) => record.name === name);
  }

  _pruneHelmResources(previousResources, nextResources) {
    const refKey = (ref) => `${ref.kind}|${ref.namespace || ''}|${ref.name}`;
    const nextKeys = new Set((nextResources || []).map(refKey));
    const cluster = this._cluster();
    const deleted = [];
    for (const ref of previousResources || []) {
      if (nextKeys.has(refKey(ref))) continue;
      const resource = this._findResource(ref.kind, ref.name, ref.namespace);
      if (!resource) continue;
      try {
        if (cluster && typeof cluster.remove === 'function')
          cluster.remove(resource.uid || resource.metadata?.uid);
        else throw new Error('cluster does not support remove()');
        deleted.push({
          kind: resource.kind || ref.kind,
          name: resource.metadata?.name || ref.name,
          namespace: ref.namespace,
        });
      } catch (err) {
        // Best effort: an upgrade still succeeds if a stale object cannot be pruned.
        if (typeof console !== 'undefined')
          console.warn(`helm: could not prune ${ref.kind}/${ref.name}:`, err?.message || err);
      }
    }
    return deleted;
  }

  installHelm(release, chartDir, valuesPath = null, opts = {}) {
    const invalid = this._validateReleaseName(release);
    if (invalid) return this._helmReleaseError(`Error: ${invalid}`);
    const namespace = opts.namespace || this._currentProject() || 'default';
    const key = this._helmKey(namespace, release);
    if (this.helmReleases.has(key)) {
      return this._helmReleaseError(
        `Error: release "${release}" already exists in namespace "${namespace}" (use "helm upgrade ${release} ...")`
      );
    }
    const rendered = this.renderHelm(release, chartDir, valuesPath, { ...opts, namespace });
    if (!rendered.ok) return rendered;
    if (opts.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        released: release,
        name: release,
        chart: rendered.chart.name,
        chartVersion: rendered.chart.version,
        appVersion: rendered.chart.appVersion || '',
        namespace,
        revision: 1,
        resources: [],
        objects: rendered.objects,
        values: clone(rendered.values),
        errors: [],
        errorDetails: [],
        warnings: [],
      };
    }
    const result = this._applyDocuments(rendered.objects, {
      source: `helm:${release}`,
      path: `${normalizePath(chartDir)}`,
      event: null,
      namespace,
    });
    if (!result.ok) {
      return {
        ok: false,
        released: null,
        resources: [],
        error: result.errors?.[0],
        errors: result.errors,
        errorDetails: result.errorDetails,
        warnings: result.warnings,
      };
    }
    const resources = [...result.created, ...result.updated].map((ref) => ({ ...ref }));
    const record = {
      key,
      name: release,
      chart: rendered.chart.name,
      chartVersion: rendered.chart.version,
      appVersion: rendered.chart.appVersion || '',
      chartDir: normalizePath(chartDir),
      valuesPath: valuesPath ? normalizePath(valuesPath) : null,
      namespace: rendered.namespace,
      status: 'deployed',
      revision: 1,
      resources,
      values: clone(rendered.values),
      at: Date.now(),
    };
    this.helmReleases.set(key, record);
    this._emit('helm:installed', {
      release,
      name: release,
      chart: record.chart,
      namespace: record.namespace,
      resources: resources.map((ref) => ({ ...ref })),
    });
    return {
      ok: true,
      released: release,
      name: release,
      chart: record.chart,
      chartVersion: record.chartVersion,
      appVersion: record.appVersion,
      chartDir: record.chartDir,
      valuesPath: record.valuesPath,
      namespace: record.namespace,
      revision: record.revision,
      resources,
      errors: [],
      errorDetails: [],
      warnings: [...(result.warnings || [])],
      values: clone(rendered.values),
    };
  }

  upgradeHelm(release, chartDir, valuesPath = null, opts = {}) {
    const matches = this._helmMatches(release, opts);
    if (matches.length === 0)
      return this._helmReleaseError(`Error: release "${release}" not found`);
    if (matches.length > 1) {
      return this._helmReleaseError(
        `Error: release "${release}" is installed in multiple namespaces; specify -n/--namespace`
      );
    }
    const existing = matches[0];
    const rendered = this.renderHelm(release, chartDir, valuesPath, {
      ...opts,
      namespace: existing.namespace,
    });
    if (!rendered.ok) return rendered;
    if (opts.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        released: release,
        name: release,
        chart: rendered.chart.name,
        chartVersion: rendered.chart.version,
        appVersion: rendered.chart.appVersion || '',
        namespace: existing.namespace,
        revision: existing.revision,
        resources: [],
        objects: rendered.objects,
        values: clone(rendered.values),
        errors: [],
        errorDetails: [],
        warnings: [],
      };
    }
    const result = this._applyDocuments(rendered.objects, {
      source: `helm:${release}`,
      path: normalizePath(chartDir),
      event: null,
      namespace: existing.namespace,
    });
    if (!result.ok) {
      return {
        ok: false,
        released: null,
        resources: [],
        error: result.errors?.[0],
        errors: result.errors,
        errorDetails: result.errorDetails,
        warnings: result.warnings,
      };
    }
    const resources = [...result.created, ...result.updated].map((ref) => ({ ...ref }));
    // Helm upgrades delete resources that were removed from the chart manifest.
    const deleted = this._pruneHelmResources(existing.resources || [], resources);
    Object.assign(existing, {
      chart: rendered.chart.name,
      chartVersion: rendered.chart.version,
      appVersion: rendered.chart.appVersion || existing.appVersion || '',
      chartDir: normalizePath(chartDir),
      valuesPath: valuesPath ? normalizePath(valuesPath) : null,
      status: 'deployed',
      revision: (existing.revision || 1) + 1,
      resources,
      values: clone(rendered.values),
      updatedAt: Date.now(),
    });
    this._emit('helm:upgraded', {
      release,
      name: release,
      chart: existing.chart,
      namespace: existing.namespace,
      resources: resources.map((ref) => ({ ...ref })),
    });
    return {
      ok: true,
      released: release,
      name: release,
      chart: existing.chart,
      chartVersion: existing.chartVersion,
      appVersion: existing.appVersion,
      chartDir: existing.chartDir,
      valuesPath: existing.valuesPath,
      namespace: existing.namespace,
      revision: existing.revision,
      resources,
      deleted,
      errors: [],
      errorDetails: [],
      warnings: [...(result.warnings || [])],
      values: clone(rendered.values),
    };
  }

  /** @param {{namespace?: string}} [opts] filter by release namespace (Helm 3 is namespace-scoped) */
  listHelm(opts = {}) {
    const records = opts.namespace
      ? [...this.helmReleases.values()].filter(
          (record) => record.namespace === String(opts.namespace)
        )
      : [...this.helmReleases.values()];
    return records.map((record) => ({
      name: record.name,
      chart: record.chart,
      chartVersion: record.chartVersion,
      appVersion: record.appVersion || '',
      status: record.status,
      namespace: record.namespace,
      revision: record.revision,
      chartDir: record.chartDir,
      valuesPath: record.valuesPath || null,
      resources: (record.resources || []).map((ref) => ({ ...ref })),
      updatedAt: record.updatedAt || record.at,
    }));
  }

  getHelmRelease(name, opts = {}) {
    const matches = this._helmMatches(name, opts);
    if (matches.length !== 1) return null;
    const record = matches[0];
    return { ...record, resources: (record.resources || []).map((ref) => ({ ...ref })) };
  }

  uninstallHelm(name, opts = {}) {
    const matches = this._helmMatches(name, opts);
    if (matches.length === 0) {
      return {
        ok: false,
        deleted: [],
        notFound: [],
        error: `Error: release "${name}" not found`,
        errors: [`Error: release "${name}" not found`],
        errorDetails: [],
      };
    }
    if (matches.length > 1) {
      const message = `Error: release "${name}" is installed in multiple namespaces; specify -n/--namespace`;
      return {
        ok: false,
        deleted: [],
        notFound: [],
        error: message,
        errors: [message],
        errorDetails: [],
      };
    }
    const record = matches[0];
    const cluster = this._cluster();
    const deleted = [];
    const notFound = [];
    const errors = [];
    for (const ref of record.resources || []) {
      const resource = this._findResource(ref.kind, ref.name, ref.namespace);
      if (!resource) {
        notFound.push({ ...ref });
        continue;
      }
      try {
        if (cluster && typeof cluster.remove === 'function')
          cluster.remove(resource.uid || resource.metadata?.uid);
        else throw new Error('cluster does not support remove()');
        deleted.push({
          kind: resource.kind || ref.kind,
          name: resource.metadata?.name || ref.name,
          namespace: ref.namespace,
        });
      } catch (err) {
        errors.push(formatError(err));
      }
    }
    this.helmReleases.delete(record.key || this._helmKey(record.namespace, name));
    this._emit('helm:uninstalled', {
      release: name,
      name,
      namespace: record.namespace,
      deleted: deleted.map((ref) => ({ ...ref })),
    });
    return {
      ok: errors.length === 0,
      deleted,
      notFound,
      errors,
      errorDetails: [],
      namespace: record.namespace,
    };
  }

  // ── HTPasswd ─────────────────────────────────────────────────────────────

  _htpasswdLines(file = 'htpasswd') {
    const norm = normalizePath(file) || 'htpasswd';
    const content = this.files.get(norm) || '';
    return content.split('\n').filter((line) => line.trim() !== '');
  }

  _writeHtpasswdLines(lines, file = 'htpasswd') {
    const norm = normalizePath(file) || 'htpasswd';
    this.files.set(norm, lines.length ? `${lines.join('\n')}\n` : '');
  }

  _parseHtpasswdUser(line) {
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    return { user: line.slice(0, colon), hash: line.slice(colon + 1) };
  }

  /** @param {string} [file] virtual htpasswd file path (default: root `htpasswd`) @returns {string[]} */
  htpasswdList(file = 'htpasswd') {
    const users = [];
    for (const line of this._htpasswdLines(file)) {
      if (line.trim().startsWith('#')) continue;
      const parsed = this._parseHtpasswdUser(line);
      if (parsed) users.push(parsed.user);
    }
    return users;
  }

  _validateHtpasswdInput(user, pass, { requirePassword = true } = {}) {
    if (!user || typeof user !== 'string') return 'user name is required';
    if (/\s|:/.test(user)) return `invalid user name "${user}": must not contain spaces or ":"`;
    if (requirePassword && (pass === undefined || pass === null || String(pass) === ''))
      return 'password is required';
    return null;
  }

  /** Real htpasswd file paths are honoured; they default to the OAuth root file. */
  htpasswdAdd(user, pass, file = 'htpasswd', options = {}) {
    const normFile = normalizePath(file) || 'htpasswd';
    const invalid = this._validateHtpasswdInput(user, pass);
    if (invalid) return { ok: false, user, file: normFile, error: invalid, errors: [invalid] };
    const lines = this._htpasswdLines(normFile);
    for (const line of lines) {
      const parsed = this._parseHtpasswdUser(line);
      if (parsed && parsed.user === user) {
        const error = `user "${user}" already exists in ${normFile}`;
        return { ok: false, user, file: normFile, error, errors: [error] };
      }
    }
    lines.push(
      `${user}:${hashHtpasswdEntry(user, String(pass), { bcrypt: Boolean(options.bcrypt) })}`
    );
    this._writeHtpasswdLines(lines, normFile);
    return { ok: true, user, file: normFile, bcrypt: Boolean(options.bcrypt), errors: [] };
  }

  htpasswdUpdate(user, pass, file = 'htpasswd', options = {}) {
    const normFile = normalizePath(file) || 'htpasswd';
    const invalid = this._validateHtpasswdInput(user, pass);
    if (invalid) return { ok: false, user, file: normFile, error: invalid, errors: [invalid] };
    const lines = this._htpasswdLines(normFile);
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
      const parsed = this._parseHtpasswdUser(lines[i]);
      if (parsed && parsed.user === user) {
        lines[i] =
          `${user}:${hashHtpasswdEntry(user, String(pass), { bcrypt: Boolean(options.bcrypt) })}`;
        updated = true;
        break;
      }
    }
    if (!updated)
      lines.push(
        `${user}:${hashHtpasswdEntry(user, String(pass), { bcrypt: Boolean(options.bcrypt) })}`
      );
    this._writeHtpasswdLines(lines, normFile);
    return { ok: true, user, updated, file: normFile, bcrypt: Boolean(options.bcrypt), errors: [] };
  }

  htpasswdDelete(user, file = 'htpasswd') {
    const normFile = normalizePath(file) || 'htpasswd';
    if (!user)
      return {
        ok: false,
        user,
        file: normFile,
        error: 'user name is required',
        errors: ['user name is required'],
      };
    const lines = this._htpasswdLines(normFile);
    const next = lines.filter((line) => {
      const parsed = this._parseHtpasswdUser(line);
      return !(parsed && parsed.user === user);
    });
    if (next.length === lines.length) {
      const error = `user "${user}" not found in ${normFile}`;
      return { ok: false, user, file: normFile, error, errors: [error] };
    }
    this._writeHtpasswdLines(next, normFile);
    return { ok: true, user, file: normFile, errors: [] };
  }

  /**
   * Verify an HTPasswd login without exposing stored hashes. The OAuth provider
   * reads the root `htpasswd` file; optional `file` probes another file.
   * @returns {boolean}
   */
  htpasswdAuthenticate(user, pass, file = 'htpasswd') {
    if (!user) return false;
    for (const line of this._htpasswdLines(file)) {
      const parsed = this._parseHtpasswdUser(line);
      if (parsed && parsed.user === user)
        return verifyHtpasswdPasswordHash(user, parsed.hash, String(pass));
    }
    return false;
  }

  /** Alias used by the login command. */
  verifyHtpasswd(user, pass) {
    return this.htpasswdAuthenticate(user, pass);
  }

  // ── objective / exam-prep state ──────────────────────────────────────────

  hasAppliedFile(path) {
    const norm = normalizePath(path);
    return this.appliedFiles.some((entry) => entry.path === norm);
  }

  hasAppliedKustomize(path) {
    const norm = normalizePath(path || '.');
    return this.appliedKustomize.some((entry) => entry.path === norm);
  }

  getAppliedTemplates() {
    return this.templates.map((entry) => ({
      path: entry.path,
      name: entry.name,
      params: { ...entry.params },
      applied: entry.applied,
      at: entry.at,
      resources: (entry.resources || []).map((ref) => ({ ...ref })),
    }));
  }

  getState() {
    return {
      files: Object.fromEntries(this.files),
      fileList: this.listFiles(),
      appliedFiles: this.appliedFiles.map((entry) => ({
        ...entry,
        resources: entry.resources.map((ref) => ({ ...ref })),
      })),
      appliedKustomize: this.appliedKustomize.map((entry) => ({
        ...entry,
        resources: entry.resources.map((ref) => ({ ...ref })),
      })),
      templates: this.getAppliedTemplates(),
      helmReleases: this.listHelm(),
      helm: this.listHelm(),
      htpasswd: {
        file: 'htpasswd',
        users: this.htpasswdList(),
        content: this.files.get('htpasswd') || '',
      },
      lastApplied: this.lastApplied ? clone(this.lastApplied) : null,
      lastErrors: [...this.lastErrors],
    };
  }
}

export default ManifestEngine;
