/**
 * MergePatch.js — Kubernetes patch strategies for the OpenShift Games engine.
 *
 * Implements the three patch formats the real API server accepts from
 * `oc patch` (`--type=strategic|merge|json`), plus the validation the API
 * server applies to workload pod templates afterwards. DOM-free so it can be
 * unit-tested with plain Node harnesses (see RBACEngine.js for the style).
 *
 * Strategic merge (the `oc patch` default for built-in/aggregated kinds):
 *  - map fields merge recursively, `null` deletes a field,
 *  - lists are replaced UNLESS the field has a patch-merge key, in which case
 *    entries merge by that key (e.g. `containers` by `name`, so patching a
 *    container's `securityContext` keeps its `image`),
 *  - entries may carry `$patch: delete` (remove the matching entry) or
 *    `$patch: replace` (replace the whole object).
 *
 * JSON merge (`--type=merge`): RFC 7386 — lists are always replaced.
 * JSON patch (`--type=json`): RFC 6902 operations array.
 *
 * @module engine/MergePatch
 */

/** CRD-backed / merge-only kinds (their API server has no strategic merge strategy). */
const MERGE_ONLY_KINDS = new Set([
  'Subscription',
  'ClusterServiceVersion',
  'InstallPlan',
  'OperatorGroup',
  'PackageManifest',
  'CatalogSource',
  'IPAddressPool',
  'L2Advertisement',
]);

/**
 * List fields with a strategic-merge key (the same patch strategies the
 * Kubernetes API server declares for its built-in types).
 * @type {Record<string, string>}
 */
const LIST_MERGE_KEYS = {
  containers: 'name',
  initContainers: 'name',
  ephemeralContainers: 'name',
  env: 'name',
  envFrom: null,
  volumes: 'name',
  volumeMounts: 'mountPath',
  volumeDevices: 'devicePath',
  imagePullSecrets: 'name',
  hostAliases: 'ip',
  ownerReferences: 'uid',
  finalizers: null,
  ports: null, // resolved dynamically: name > containerPort > port
};

/** Pod-spec locations that carry `containers` for each workload kind. */
const POD_SPEC_PATHS = {
  Pod: ['spec'],
  Deployment: ['spec', 'template', 'spec'],
  ReplicaSet: ['spec', 'template', 'spec'],
  StatefulSet: ['spec', 'template', 'spec'],
  DaemonSet: ['spec', 'template', 'spec'],
  Job: ['spec', 'template', 'spec'],
  CronJob: ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
  ReplicationController: ['spec', 'template', 'spec'],
};

/** API group suffix used in validation messages (`Deployment.apps`). */
const KIND_API_GROUPS = {
  Pod: '',
  ReplicationController: '',
  Deployment: 'apps',
  ReplicaSet: 'apps',
  StatefulSet: 'apps',
  DaemonSet: 'apps',
  Job: 'batch',
  CronJob: 'batch',
};

/** @param {*} value @returns {boolean} */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep clone JSON-compatible data.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function clone(value) {
  if (Array.isArray(value)) return value.map((item) => clone(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item);
    return out;
  }
  return value;
}

/**
 * Is the server-side patch strategy for `kind` strategic merge (the `oc patch`
 * default) or JSON merge (CRDs/aggregated APIs without a patch strategy)?
 * @param {string} kind canonical or CLI kind token
 * @param {(kind: string) => string|null} [normalize]
 * @returns {'strategic'|'merge'}
 */
export function defaultPatchType(kind, normalize) {
  const canonical = normalize ? normalize(kind) : kind;
  const name = canonical || kind;
  if (!name) return 'strategic';
  if (MERGE_ONLY_KINDS.has(String(name))) return 'merge';
  return 'strategic';
}

/**
 * Resolve the patch type for `oc patch <kind>` (options.type wins).
 * @param {object} options `{type?: string, patchType?: string}`
 * @param {string} kind
 * @param {(kind: string) => string|null} [normalize]
 * @returns {{type: 'strategic'|'merge'|'json', error?: string}}
 */
export function resolvePatchType(options = {}, kind, normalize) {
  const requested = options.type || options.patchType || '';
  const raw = String(requested || '')
    .trim()
    .toLowerCase();
  if (raw) {
    if (raw === 'strategic') return { type: 'strategic' };
    if (raw === 'merge' || raw === 'json-merge') return { type: 'merge' };
    if (raw === 'json' || raw === 'json-patch') return { type: 'json' };
    return {
      type: 'strategic',
      error: `error: --type must be one of: strategic, merge, json (got "${requested}")`,
    };
  }
  return { type: defaultPatchType(kind, normalize) };
}

/**
 * Choose the strategic-merge key for a list field, following the API server's
 * patch strategies (containers by name, Service ports by port, container ports
 * by containerPort, ...). Returns null when the list should be replaced.
 * @param {string} fieldName
 * @param {Array<*>} patchList
 * @param {Array<*>} targetList
 * @returns {string|null}
 */
export function listMergeKeyFor(fieldName, patchList = [], targetList = []) {
  if (Object.prototype.hasOwnProperty.call(LIST_MERGE_KEYS, fieldName)) {
    const mapped = LIST_MERGE_KEYS[fieldName];
    if (mapped) return mapped;
    if (mapped === null && fieldName !== 'ports') return null;
  }
  if (fieldName === 'ports') {
    const sample = [...patchList, ...targetList].find(isPlainObject) || {};
    for (const key of ['name', 'containerPort', 'port']) {
      if (sample[key] !== undefined) return key;
    }
    return null;
  }
  return null;
}

/**
 * Merge one object with a strategic-merge patch.
 * @param {*} target
 * @param {*} patch
 * @returns {*}
 */
function mergeObject(target, patch) {
  if (patch === null || patch === undefined) return null;
  if (!isPlainObject(patch)) return clone(patch);
  if (patch.$patch === 'replace') {
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key.startsWith('$')) continue;
      out[key] = clone(value);
    }
    return out;
  }
  const result = isPlainObject(target) ? clone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('$')) continue;
    if (value === null) {
      delete result[key];
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = mergeList(result[key], value, key);
    } else if (isPlainObject(value)) {
      result[key] = mergeObject(isPlainObject(result[key]) ? result[key] : {}, value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

/**
 * Strategic-merge a list field.
 * @param {*} targetList
 * @param {Array<*>} patchList
 * @param {string} fieldName
 * @returns {*}
 */
function mergeList(targetList, patchList, fieldName) {
  const list = Array.isArray(targetList) ? clone(targetList) : [];
  const key = listMergeKeyFor(fieldName, patchList, list);
  if (!key) {
    // The API server replaces lists without a patch-merge strategy.
    return patchList
      .filter((item) => !(isPlainObject(item) && item.$patch === 'delete'))
      .map((item) => {
        if (isPlainObject(item) && item.$patch) {
          const out = {};
          for (const [name, value] of Object.entries(item)) {
            if (!name.startsWith('$')) out[name] = clone(value);
          }
          return out;
        }
        return clone(item);
      });
  }
  const out = Array.isArray(list) ? list : [];
  for (const patchItem of patchList) {
    if (!isPlainObject(patchItem)) {
      out.push(clone(patchItem));
      continue;
    }
    const keyValue = patchItem[key];
    const index =
      keyValue === undefined
        ? -1
        : out.findIndex((item) => isPlainObject(item) && item[key] === keyValue);
    if (patchItem.$patch === 'delete') {
      if (index >= 0) out.splice(index, 1);
      continue;
    }
    if (index >= 0) {
      out[index] = mergeObject(out[index], patchItem);
    } else {
      const entry = {};
      for (const [name, value] of Object.entries(patchItem)) {
        if (name.startsWith('$')) continue;
        entry[name] = clone(value);
      }
      out.push(entry);
    }
  }
  return out;
}

/**
 * Apply a strategic merge patch.
 * @param {object} target
 * @param {object} patch
 * @returns {object}
 */
export function strategicMergePatch(target, patch) {
  const result = mergeObject(target, patch);
  return isPlainObject(result) ? result : {};
}

/**
 * Apply an RFC 7386 JSON merge patch (lists are replaced, nulls delete keys).
 * @param {*} target
 * @param {*} patch
 * @returns {*}
 */
export function jsonMergePatch(target, patch) {
  if (patch === null) return null;
  if (!isPlainObject(patch)) return clone(patch);
  const result = isPlainObject(target) ? clone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    if (isPlainObject(value)) {
      result[key] = jsonMergePatch(isPlainObject(result[key]) ? result[key] : {}, value);
    } else if (Array.isArray(value)) {
      result[key] = clone(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parse an RFC 6902 JSON pointer into path segments.
 * @param {string} pointer
 * @returns {string[]}
 */
function parsePointer(pointer) {
  return String(pointer || '')
    .replace(/^\//, '')
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** @param {object} document @param {string[]} path @returns {*} */
function getByPointer(document, path) {
  let target = document;
  for (const part of path) {
    if (target === null || target === undefined) return undefined;
    target = target[part];
  }
  return target;
}

/**
 * Apply an RFC 6902 JSON patch. Returns the patched document or an error.
 * @param {object} document
 * @param {Array<{op: string, path: string, value?: *, from?: string}>} operations
 * @returns {{ok: boolean, result?: object, error?: string}}
 */
export function applyJsonPatch(document, operations) {
  if (!Array.isArray(operations)) {
    return { ok: false, error: 'json patch must be an array of operations' };
  }
  let result = clone(document);
  for (const operation of operations) {
    if (!isPlainObject(operation) || !operation.op || typeof operation.path !== 'string') {
      return { ok: false, error: 'json patch operation requires "op" and "path"' };
    }
    const path = parsePointer(operation.path);
    if (path.length === 0) {
      if (operation.op === 'replace' || operation.op === 'add') {
        result = clone(operation.value);
        continue;
      }
      return {
        ok: false,
        error: `invalid json patch operation "${operation.op}" on the document root`,
      };
    }
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1];
    const parent = getByPointer(result, parentPath);
    if (parent === undefined || parent === null || typeof parent !== 'object') {
      return { ok: false, error: `json patch path "${operation.path}" does not exist` };
    }
    switch (operation.op) {
      case 'add': {
        if (Array.isArray(parent)) {
          const index = last === '-' ? parent.length : Number(last);
          if (!Number.isInteger(index) || index < 0 || index > parent.length) {
            return { ok: false, error: `json patch path "${operation.path}" is invalid` };
          }
          parent.splice(index, 0, clone(operation.value));
        } else {
          parent[last] = clone(operation.value);
        }
        break;
      }
      case 'replace': {
        if (Array.isArray(parent)) {
          const index = Number(last);
          if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
            return { ok: false, error: `json patch path "${operation.path}" does not exist` };
          }
          parent[index] = clone(operation.value);
        } else {
          if (!Object.prototype.hasOwnProperty.call(parent, last)) {
            return { ok: false, error: `json patch path "${operation.path}" does not exist` };
          }
          parent[last] = clone(operation.value);
        }
        break;
      }
      case 'remove': {
        if (Array.isArray(parent)) {
          const index = Number(last);
          if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
            return { ok: false, error: `json patch path "${operation.path}" does not exist` };
          }
          parent.splice(index, 1);
        } else {
          if (!Object.prototype.hasOwnProperty.call(parent, last)) {
            return { ok: false, error: `json patch path "${operation.path}" does not exist` };
          }
          delete parent[last];
        }
        break;
      }
      case 'test': {
        const current = getByPointer(result, path);
        if (JSON.stringify(current) !== JSON.stringify(operation.value)) {
          return { ok: false, error: `json patch test failed at "${operation.path}"` };
        }
        break;
      }
      case 'copy':
      case 'move': {
        const fromPath = parsePointer(operation.from);
        const fromParentPath = fromPath.slice(0, -1);
        const fromLast = fromPath[fromPath.length - 1];
        const fromParent = getByPointer(result, fromParentPath);
        if (fromParent === undefined || fromParent === null) {
          return { ok: false, error: `json patch "from" path "${operation.from}" does not exist` };
        }
        const value = clone(fromParent[fromLast]);
        if (operation.op === 'move') {
          if (Array.isArray(fromParent)) fromParent.splice(Number(fromLast), 1);
          else delete fromParent[fromLast];
        }
        if (Array.isArray(parent)) {
          const index = last === '-' ? parent.length : Number(last);
          parent.splice(Number.isInteger(index) ? index : parent.length, 0, value);
        } else {
          parent[last] = value;
        }
        break;
      }
      default:
        return { ok: false, error: `unsupported json patch operation "${operation.op}"` };
    }
  }
  return { ok: true, result };
}

/**
 * Resolve the pod spec inside a workload resource (or the Pod's own spec).
 * @param {object} resource
 * @returns {{path: string[], spec: object}|null}
 */
export function getPodSpec(resource) {
  const kind = resource?.kind || '';
  const path = POD_SPEC_PATHS[kind];
  if (!path) return null;
  const spec = getByPointer(resource, path);
  return isPlainObject(spec) ? { path, spec } : null;
}

/**
 * Validate a workload the way the API server validates a pod template: every
 * container needs a name and an image. Returns the first error, or null.
 * @param {object} resource
 * @returns {{path: string, message: string}|null}
 */
export function validatePodTemplate(resource) {
  const resolved = getPodSpec(resource);
  if (!resolved) return null;
  const containers = resolved.spec.containers;
  if (!Array.isArray(containers) || containers.length === 0) {
    return { path: `${resolved.path.join('.')}.containers`, message: 'Required value' };
  }
  for (const [index, container] of containers.entries()) {
    const base = `${resolved.path.join('.')}.containers[${index}]`;
    if (!isPlainObject(container)) {
      return { path: base, message: 'Invalid value: not an object' };
    }
    if (!container.name) return { path: `${base}.name`, message: 'Required value' };
    if (!container.image || typeof container.image !== 'string' || container.image.trim() === '') {
      return { path: `${base}.image`, message: 'Required value' };
    }
  }
  return null;
}

/**
 * Build the real API-server style validation message for a workload:
 * `Deployment.apps "priv-app" is invalid: spec.template.spec.containers[0].image: Required value`.
 * @param {object} resource
 * @returns {string|null} the `Error from server (Invalid): ...` line, or null
 */
export function invalidWorkloadMessage(resource) {
  const error = validatePodTemplate(resource);
  if (!error) return null;
  const kind = resource.kind || 'Pod';
  const group = KIND_API_GROUPS[kind];
  const label = group === undefined ? kind : group ? `${kind}.${group}` : kind;
  const name = resource.metadata?.name || resource.name || '';
  return `Error from server (Invalid): ${label} "${name}" is invalid: ${error.path}: ${error.message}`;
}

export default {
  clone,
  defaultPatchType,
  resolvePatchType,
  listMergeKeyFor,
  strategicMergePatch,
  jsonMergePatch,
  applyJsonPatch,
  getPodSpec,
  validatePodTemplate,
  invalidWorkloadMessage,
};
