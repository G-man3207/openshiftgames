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

import {
  parseYaml,
  stringifyYaml,
  toYamlError,
  YamlParseError,
} from './YamlParser.js';
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
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob', 'Pod']);
const RENDERED_NUMBER_KEYS = new Set([
  'replicas', 'port', 'targetPort', 'containerPort', 'nodePort', 'hostPort',
  'minReplicas', 'maxReplicas', 'terminationGracePeriodSeconds',
  'revisionHistoryLimit', 'progressDeadlineSeconds', 'weight',
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
  return String(input ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function resolvePath(baseDir, relative) {
  const rel = String(relative ?? '').trim().replace(/\\/g, '/');
  if (!rel) return normalizePath(baseDir);
  const parts = (normalizePath(baseDir) ? normalizePath(baseDir).split('/') : []).concat(rel.split('/'));
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
    else if (isPlainObject(value)) out[key] = deepMerge(isPlainObject(out[key]) ? out[key] : {}, value);
    else out[key] = clone(value);
  }
  return out;
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
  const digest = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
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
      if (ref.gameEngine || ref.cluster || typeof ref.applyManifestObject === 'function' || typeof ref.emit === 'function') {
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
      else if (engine?.eventBus && typeof engine.eventBus.emit === 'function') engine.eventBus.emit(event, data);
    } catch (err) {
      // Never let an event-bus hiccup break a declarative operation.
      if (typeof console !== 'undefined') console.warn(`manifest: failed to emit ${event}`, err?.message || err);
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      try {
        window.dispatchEvent(new CustomEvent(`openshiftgames:${event.replace(':', '-')}`, { detail: data }));
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
      entries.push({ path, kind: 'directory', name: basename(path), depth: path.split('/').length - 1 });
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
      if (typeof cluster.getByNamespace === 'function' && cluster.getByNamespace(namespace).length > 0) {
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
      return { ok: false, error: `${source}: document is not a mapping`, detail: { file: source, message: 'document is not a mapping' } };
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
      return { ok: true, list: items.map((item, index) => this._normalizeDoc(item, `${source}[items ${index}]`, options)) };
    }
    const canonical = this._canonicalKind(kind);
    if (!canonical) {
      const apiVersion = raw.apiVersion || 'v1';
      return {
        ok: false,
        error: `error: unable to recognize "${source}": no matches for kind "${kind}" in version "${apiVersion}"`,
        detail: { file: source, message: `no matches for kind "${kind}" in version "${apiVersion}"` },
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
      metadata.namespace = override || (metadata.namespace ? String(metadata.namespace) : this._currentProject());
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
    const result = { ok: false, created: [], updated: [], errors: [], errorDetails: [], warnings: [], ...extra };
    if (!result.ok && !result.error && result.errors.length > 0) result.error = result.errors[0];
    return result;
  }

  _applyFallback(normalized) {
    const cluster = this._cluster();
    if (!cluster) throw new Error('no cluster state available (window.game.cluster not initialised)');
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
      resource.metadata.annotations = { ...(resource.metadata.annotations || {}), ...normalized.annotations };
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

  _applyOne(normalized) {
    const engine = this._gameEngine();
    const existed = Boolean(this._findResource(normalized.kind, normalized.name, normalized.namespace));
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
      if (returned && returned.resource) {
        resource = returned.resource;
        if (typeof returned.created === 'boolean') created = returned.created;
      } else if (returned) {
        resource = returned;
      }
      if (!resource) resource = this._findResource(normalized.kind, normalized.name, normalized.namespace);
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
    if (errors.length > 0) {
      return this._emptyResult({ errors, errorDetails: details, source });
    }

    const result = this._emptyResult({ ok: true, source });
    const warnings = [];
    const created = [];
    const updated = [];
    const autoCreatedProjects = [];

    // Simulator convenience: ensure target projects exist. Real OCP would
    // reject a namespaced apply with "namespaces \"x\" not found".
    if (this.options.autoCreateProjects !== false && typeof this._cluster === 'function') {
      const missing = new Set();
      for (const normalized of docs) {
        if (!normalized.namespaced) continue;
        const ns = normalized.namespace;
        if (ns && !this._namespaceExists(ns)) missing.add(ns);
      }
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
    }

    for (const normalized of docs) {
      try {
        const applied = this._applyOne(normalized);
        if (applied.created) created.push(applied.ref);
        else updated.push(applied.ref);
      } catch (err) {
        result.ok = false;
        result.errors.push(formatError(err, source));
        result.errorDetails.push(errorDetail(err, source));
      }
    }

    result.created = created;
    result.updated = updated;
    result.autoCreatedProjects = autoCreatedProjects;
    result.warnings.push(...warnings);

    if (result.ok && opts.event) {
      const resources = [...created, ...updated].map((ref) => ({ ...ref }));
      this.lastApplied = { source, path: opts.path || source, at: Date.now(), resources, created, updated };
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
    const result = this._applyDocuments(docs, { source: norm, path: norm, event: 'manifest:applied', namespace: options.namespace });
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
    const result = this._applyDocuments(docs, { source, path: source, event: 'manifest:applied', namespace: options.namespace });

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
  applyTemplate(path, params = {}) {
    const processed = this.processTemplate(path, params);
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
    return { ...applied, objects: processed.objects, message: processed.message, template: { path: normalizePath(path) } };
  }

  _matchPendingTemplate(objects) {
    const serialized = JSON.stringify(objects);
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
    if (stack.has(normDir)) throw new Error(`kustomize: cycle detected while loading "${normDir || '.'}"`);
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
    if (!isPlainObject(kustomization)) throw new Error(`${kustomizationPath}: kustomization must be a mapping`);

    const warnings = [];
    const objects = [];
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
        throw new Error(`${kustomizationPath}: remote kustomize resources are not supported ("${resource}")`);
      }
      const resolved = resolvePath(normDir, resource);
      if (/\.ya?ml$/i.test(resolved)) {
        if (!this.files.has(resolved)) throw new Error(`${kustomizationPath}: resource file "${resource}" not found`);
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
    const patches = Array.isArray(kustomization.patchesStrategicMerge) ? kustomization.patchesStrategicMerge : [];
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
          if (!this.files.has(patchPath)) throw new Error(`${kustomizationPath}: patch "${patchEntry}" not found`);
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
        const merged = deepMerge(target, patch);
        merged.kind = target.kind;
        merged.apiVersion = target.apiVersion;
        merged.metadata = { ...target.metadata, ...patch.metadata };
        const index = objects.indexOf(target);
        objects[index] = merged;
      }
    }

    // patches: [{path, target:{kind,name}}] — subset of the newer field.
    const newerPatches = Array.isArray(kustomization.patches) ? kustomization.patches : [];
    for (const entry of newerPatches) {
      if (!isPlainObject(entry) || !entry.path) {
        warnings.push(`${kustomizationPath}: only file-based "patches" entries are supported`);
        continue;
      }
      const patchPath = resolvePath(normDir, entry.path);
      if (!this.files.has(patchPath)) throw new Error(`${kustomizationPath}: patch "${entry.path}" not found`);
      const patchDocs = parseYaml(this.files.get(patchPath), { file: patchPath });
      for (const patch of patchDocs) {
        if (!isPlainObject(patch) || !patch.kind || !patch.metadata?.name) continue;
        const target = objects.find(
          (obj) =>
            (this._canonicalKind(obj.kind) || obj.kind) === (this._canonicalKind(patch.kind) || patch.kind) &&
            obj.metadata?.name === patch.metadata.name
        );
        if (!target) throw new Error(`${patchPath}: no resource matched patch for ${patch.kind}/${patch.metadata.name}`);
        objects[objects.indexOf(target)] = deepMerge(target, patch);
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
    const commonAnnotations = isPlainObject(kustomization.commonAnnotations) ? kustomization.commonAnnotations : {};

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
      for (const image of kustomization.images) this._transformImages(objects, image, kustomizationPath);
    }
    if (Array.isArray(kustomization.replicas)) {
      for (const replica of kustomization.replicas) {
        if (!isPlainObject(replica) || !replica.name) continue;
        const targets = objects.filter((obj) => {
          const kind = this._canonicalKind(obj.kind) || obj.kind;
          if (kind !== 'Deployment' && kind !== 'StatefulSet' && kind !== 'ReplicaSet') return false;
          const current = obj.metadata?.name;
          return current === replica.name || current === `${namePrefix}${replica.name}${nameSuffix}`;
        });
        if (targets.length === 0) {
          warnings.push(`${kustomizationPath}: replicas entry "${replica.name}" did not match any workload`);
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
    const remap = (value) => (typeof value === 'string' && nameMap.has(value) ? nameMap.get(value) : value);
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
            if (path?.backend?.service?.name) path.backend.service.name = remap(path.backend.service.name);
          }
        }
      }
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

  applyKustomize(dirPath = '') {
    const dir = normalizePath(dirPath);
    const kustomizationPath = this._findKustomization(dir);
    if (!kustomizationPath) {
      const message = `error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${
        dir || '.'
      }'`;
      return this._emptyResult({ errors: [message], errorDetails: [{ file: dir || '.', message }] });
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
    out = out.replace(/\$\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name) => replace(name, match));
    out = out.replace(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g, (match, name) => replace(name, match));
    return out;
  }

  _substituteDeep(value, values, warnings, pathLabel) {
    if (typeof value === 'string') return this._substituteString(value, values, warnings, pathLabel);
    if (Array.isArray(value)) return value.map((item, index) => this._substituteDeep(item, values, warnings, `${pathLabel}[${index}]`));
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
  processTemplate(path, params = {}) {
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
    const templateDoc = docs.find((doc) => isPlainObject(doc) && this._canonicalKind(doc.kind) === 'Template');
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

    for (const name of Object.keys(overrides)) {
      if (!declared.has(name)) warnings.add(`unknown template parameter "${name}"`);
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
    const rawMessage = typeof templateDoc.message === 'string' ? templateDoc.message : templateSpec.message;
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
    const templateDoc = docs.find((doc) => isPlainObject(doc) && this._canonicalKind(doc.kind) === 'Template');
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

  deleteFileObjects(path) {
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
    const { docs: normalizedDocs, errors, details } = this._normalizeAll(docs, norm);
    if (errors.length > 0) return { ok: false, deleted: [], errors, error: errors[0], errorDetails: details };

    const deleted = [];
    const notFound = [];
    const deleteErrors = [...errors];
    const errorDetails = [...details];
    const cluster = this._cluster();
    for (const normalized of normalizedDocs) {
      const { kind, name, namespace } = normalized;
      const resource = this._findResource(kind, name, namespace);
      if (!resource) {
        notFound.push({ kind, name, namespace });
        const apiGroup = apiVersionForKind(kind).includes('/') ? `.${apiVersionForKind(kind).split('/')[0]}` : '';
        deleteErrors.push(`Error from server (NotFound): ${kind.toLowerCase()}s${apiGroup} "${name}" not found`);
        continue;
      }
      try {
        if (cluster && typeof cluster.remove === 'function') cluster.remove(resource.uid || resource.metadata?.uid);
        else throw new Error('cluster does not support remove()');
        deleted.push({ kind: resource.kind || kind, name: resource.metadata?.name || name, namespace });
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

  _readChart(chartDir, valuesPath, release, namespace) {
    const dir = normalizePath(chartDir);
    const chartPath = `${dir}/Chart.yaml`;
    if (!this.files.has(chartPath)) {
      return { ok: false, errors: [`Error: chart "${dir || '.'}" not found: Chart.yaml is missing`], errorDetails: [] };
    }
    let chart;
    let defaults = {};
    try {
      const chartDocs = parseYaml(this.files.get(chartPath), { file: chartPath });
      chart = isPlainObject(chartDocs[0]) ? chartDocs[0] : {};
      const valuesPathResolved = `${dir}/values.yaml`;
      if (this.files.has(valuesPathResolved)) {
        const valueDocs = parseYaml(this.files.get(valuesPathResolved), { file: valuesPathResolved });
        defaults = isPlainObject(valueDocs[0]) ? valueDocs[0] : {};
      }
    } catch (err) {
      return { ok: false, errors: [formatError(err, `${dir}/Chart.yaml`)], errorDetails: [errorDetail(err, `${dir}/Chart.yaml`)] };
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
        return { ok: false, errors: [formatError(err, resolvedValues)], errorDetails: [errorDetail(err, resolvedValues)] };
      }
    }

    const values = deepMerge(defaults, overrides);
    const chartName = chart.name ? String(chart.name) : basename(dir);
    const chartVersion = chart.version ? String(chart.version) : '0.0.0';
    const templatePaths = this.listFiles().filter((path) => {
      if (!path.startsWith(`${dir}/templates/`)) return false;
      return /\.(ya?ml)$/i.test(path);
    });
    if (templatePaths.length === 0) {
      return { ok: false, errors: [`Error: chart "${chartName}" has no templates/*.yaml files`], errorDetails: [] };
    }

    const context = {
      Release: { Name: release, Namespace: namespace, Service: 'Helm' },
      Chart: { Name: chartName, Version: chartVersion, AppVersion: chart.appVersion ? String(chart.appVersion) : '' },
      Values: values,
    };

    const objects = [];
    for (const templatePath of templatePaths) {
      let rendered;
      try {
        rendered = this._renderGoTemplate(this.files.get(templatePath), context, templatePath);
      } catch (err) {
        return { ok: false, errors: [formatError(err, templatePath)], errorDetails: [errorDetail(err, templatePath)] };
      }
      let docs;
      try {
        docs = parseYaml(rendered, { file: templatePath });
      } catch (err) {
        return { ok: false, errors: [formatError(err, templatePath)], errorDetails: [errorDetail(err, templatePath)] };
      }
      for (const doc of docs) {
        if (!isPlainObject(doc)) continue;
        const coerced = coerceNumberStrings(doc);
        if (!isPlainObject(coerced.metadata)) coerced.metadata = {};
        const kind = this._canonicalKind(coerced.kind) || coerced.kind;
        if (!isClusterScopedKind(kind) && !coerced.metadata.namespace) coerced.metadata.namespace = namespace;
        objects.push(coerced);
      }
    }
    return { ok: true, objects, values, chart: { name: chartName, version: chartVersion, chart }, errors: [], errorDetails: [] };
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
    let value = this._evalTemplateValue(parts[0], context);
    for (const part of parts.slice(1)) {
      if (part === 'quote') {
        value = JSON.stringify(value === undefined || value === null ? '' : String(value));
      } else if (part.startsWith('default ')) {
        const literal = part.slice('default '.length).trim().replace(/^["']|["']$/g, '');
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
      if (current === undefined) throw new Error(`no value for "${token}"`);
      return current;
    }
    if (/^-?\d+$/.test(token)) return parseInt(token, 10);
    if (token === 'true') return true;
    if (token === 'false') return false;
    throw new Error(`unsupported Helm template expression "${term}"`);
  }

  _helmReleaseError(message) {
    return { ok: false, error: message, released: null, resources: [], errors: [message], errorDetails: [], deleted: [] };
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
    const chart = this._readChart(chartDir, valuesPath, release, namespace);
    if (!chart.ok) return { ...chart, released: null, resources: [], error: chart.errors?.[0] };
    return { ...chart, released: release, namespace };
  }

  installHelm(release, chartDir, valuesPath = null, opts = {}) {
    const invalid = this._validateReleaseName(release);
    if (invalid) return this._helmReleaseError(`Error: ${invalid}`);
    if (this.helmReleases.has(release)) {
      return this._helmReleaseError(`Error: release "${release}" already exists (use "helm upgrade ${release} ...")`);
    }
    const rendered = this.renderHelm(release, chartDir, valuesPath, opts);
    if (!rendered.ok) return rendered;
    const result = this._applyDocuments(rendered.objects, {
      source: `helm:${release}`,
      path: `${normalizePath(chartDir)}`,
      event: null,
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
      name: release,
      chart: rendered.chart.name,
      chartVersion: rendered.chart.version,
      chartDir: normalizePath(chartDir),
      valuesPath: valuesPath ? normalizePath(valuesPath) : null,
      namespace: rendered.namespace,
      status: 'deployed',
      revision: 1,
      resources,
      values: clone(rendered.values),
      at: Date.now(),
    };
    this.helmReleases.set(release, record);
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
      namespace: record.namespace,
      resources,
      errors: [],
      errorDetails: [],
      warnings: [...(result.warnings || [])],
      values: clone(rendered.values),
    };
  }

  upgradeHelm(release, chartDir, valuesPath = null, opts = {}) {
    const existing = this.helmReleases.get(release);
    if (!existing) return this._helmReleaseError(`Error: release "${release}" not found`);
    const rendered = this.renderHelm(release, chartDir, valuesPath, {
      namespace: opts.namespace || existing.namespace,
    });
    if (!rendered.ok) return rendered;
    const result = this._applyDocuments(rendered.objects, {
      source: `helm:${release}`,
      path: normalizePath(chartDir),
      event: null,
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
    Object.assign(existing, {
      chart: rendered.chart.name,
      chartVersion: rendered.chart.version,
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
      namespace: existing.namespace,
      resources,
      errors: [],
      errorDetails: [],
      warnings: [...(result.warnings || [])],
      values: clone(rendered.values),
    };
  }

  /** @returns {Array<{name: string, chart: string, status: string, resources: object[]}>} */
  listHelm() {
    return [...this.helmReleases.values()].map((record) => ({
      name: record.name,
      chart: record.chart,
      chartVersion: record.chartVersion,
      status: record.status,
      namespace: record.namespace,
      revision: record.revision,
      chartDir: record.chartDir,
      resources: (record.resources || []).map((ref) => ({ ...ref })),
      updatedAt: record.updatedAt || record.at,
    }));
  }

  getHelmRelease(name) {
    const record = this.helmReleases.get(name);
    return record ? { ...record, resources: (record.resources || []).map((ref) => ({ ...ref })) } : null;
  }

  uninstallHelm(name) {
    const record = this.helmReleases.get(name);
    if (!record) {
      return {
        ok: false,
        deleted: [],
        notFound: [],
        error: `Error: release "${name}" not found`,
        errors: [`Error: release "${name}" not found`],
        errorDetails: [],
      };
    }
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
        if (cluster && typeof cluster.remove === 'function') cluster.remove(resource.uid || resource.metadata?.uid);
        else throw new Error('cluster does not support remove()');
        deleted.push({ kind: resource.kind || ref.kind, name: resource.metadata?.name || ref.name, namespace: ref.namespace });
      } catch (err) {
        errors.push(formatError(err));
      }
    }
    this.helmReleases.delete(name);
    this._emit('helm:uninstalled', { release: name, name, deleted: deleted.map((ref) => ({ ...ref })) });
    return { ok: errors.length === 0, deleted, notFound, errors, errorDetails: [] };
  }

  // ── HTPasswd ─────────────────────────────────────────────────────────────

  _htpasswdLines() {
    const content = this.files.get('htpasswd') || '';
    return content.split('\n').filter((line) => line.trim() !== '');
  }

  _writeHtpasswdLines(lines) {
    this.files.set('htpasswd', lines.length ? `${lines.join('\n')}\n` : '');
  }

  _parseHtpasswdUser(line) {
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    return { user: line.slice(0, colon), hash: line.slice(colon + 1) };
  }

  /** @returns {string[]} usernames in file order */
  htpasswdList() {
    const users = [];
    for (const line of this._htpasswdLines()) {
      if (line.trim().startsWith('#')) continue;
      const parsed = this._parseHtpasswdUser(line);
      if (parsed) users.push(parsed.user);
    }
    return users;
  }

  _validateHtpasswdInput(user, pass, { requirePassword = true } = {}) {
    if (!user || typeof user !== 'string') return 'user name is required';
    if (/\s|:/.test(user)) return `invalid user name "${user}": must not contain spaces or ":"`;
    if (requirePassword && (pass === undefined || pass === null || String(pass) === '')) return 'password is required';
    return null;
  }

  htpasswdAdd(user, pass) {
    const invalid = this._validateHtpasswdInput(user, pass);
    if (invalid) return { ok: false, user, error: invalid, errors: [invalid] };
    const lines = this._htpasswdLines();
    for (const line of lines) {
      const parsed = this._parseHtpasswdUser(line);
      if (parsed && parsed.user === user) {
        const error = `user "${user}" already exists in htpasswd`;
        return { ok: false, user, error, errors: [error] };
      }
    }
    lines.push(`${user}:${fakeHtpasswdHash(user, String(pass))}`);
    this._writeHtpasswdLines(lines);
    return { ok: true, user, file: 'htpasswd', errors: [] };
  }

  htpasswdUpdate(user, pass) {
    const invalid = this._validateHtpasswdInput(user, pass);
    if (invalid) return { ok: false, user, error: invalid, errors: [invalid] };
    const lines = this._htpasswdLines();
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
      const parsed = this._parseHtpasswdUser(lines[i]);
      if (parsed && parsed.user === user) {
        lines[i] = `${user}:${fakeHtpasswdHash(user, String(pass))}`;
        updated = true;
        break;
      }
    }
    if (!updated) lines.push(`${user}:${fakeHtpasswdHash(user, String(pass))}`);
    this._writeHtpasswdLines(lines);
    return { ok: true, user, updated, file: 'htpasswd', errors: [] };
  }

  htpasswdDelete(user) {
    if (!user) return { ok: false, error: 'user name is required', errors: ['user name is required'] };
    const lines = this._htpasswdLines();
    const next = lines.filter((line) => {
      const parsed = this._parseHtpasswdUser(line);
      return !(parsed && parsed.user === user);
    });
    if (next.length === lines.length) {
      const error = `user "${user}" not found in htpasswd`;
      return { ok: false, user, error, errors: [error] };
    }
    this._writeHtpasswdLines(next);
    return { ok: true, user, file: 'htpasswd', errors: [] };
  }

  /**
   * Verify an HTPasswd login without exposing stored hashes.
   * @returns {boolean}
   */
  htpasswdAuthenticate(user, pass) {
    if (!user) return false;
    for (const line of this._htpasswdLines()) {
      const parsed = this._parseHtpasswdUser(line);
      if (parsed && parsed.user === user) return parsed.hash === fakeHtpasswdHash(user, String(pass));
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
      appliedFiles: this.appliedFiles.map((entry) => ({ ...entry, resources: entry.resources.map((ref) => ({ ...ref })) })),
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
