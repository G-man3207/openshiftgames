/**
 * GameEngine.js — core OpenShift Games engine.
 *
 * Owns the EventBus, `ClusterState` (cluster model) and `SimulationTick`
 * (controllers). Provides:
 *  - OpenShift session/identity state: `currentUser`, `currentProject`,
 *    `login()`, `logout()`, `switchProject()`, `canI()`;
 *  - the `oc` command back-end handlers used by `CommandBar.js`
 *    (new-app, expose, start-build, set ..., adm policy, rollout, patch/apply,
 *    quota/limitrange/clusterquota creation, templates, users/groups);
 *  - the manifest upsert path `applyManifestObject()` used by ManifestEngine;
 *  - command history tracking (`recordCommand` / `getCommandHistory`).
 *
 * The module stays DOM-free: browser-only integration (ManifestEngine for the
 * virtual htpasswd file / manifest apply) is feature-detected through
 * `window.game.manifestEngine`, and `setManifestEngine()` can inject it in
 * Node harnesses.
 *
 * @module engine/GameEngine
 */

import { ClusterState, IMAGE_REGISTRY_HOST, OPENSHIFT_VERSION, deepClone, deepMerge, isClusterScopedKind } from './ClusterState.js';
import { SimulationTick } from './SimulationTick.js';
import {
  BUILTIN_ROLE_NAMES,
  VIRTUAL_RESOURCE_API_GROUPS,
  apiGroupForKind as rbacApiGroupForKind,
  getVisibleProjects as rbacGetVisibleProjects,
  parseResourceToken,
} from './RBACEngine.js';
import {
  applyJsonPatch,
  invalidWorkloadMessage,
  jsonMergePatch,
  resolvePatchType,
  strategicMergePatch,
} from './MergePatch.js';
import {
  apiVersionForKind,
  createResource,
  normalizeKind,
} from '../data/kindRegistry.js';
import { applyKnownImageSecurityProfiles } from '../resources/ImageSecurityProfiles.js';

// ─── SHA1 + base64 helpers (for the simulated {SHA} htpasswd hashes) ──────

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode bytes as standard base64 (dependency-free).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64FromBytes(bytes) {
  let output = '';
  let index = 0;
  while (index < bytes.length) {
    const byte1 = bytes[index++];
    const byte2 = index < bytes.length ? bytes[index++] : NaN;
    const byte3 = index < bytes.length ? bytes[index++] : NaN;
    const triplet = (byte1 << 16) | ((Number.isNaN(byte2) ? 0 : byte2) << 8) | (Number.isNaN(byte3) ? 0 : byte3);
    output += BASE64_ALPHABET[(triplet >> 18) & 0x3f];
    output += BASE64_ALPHABET[(triplet >> 12) & 0x3f];
    output += Number.isNaN(byte2) ? '=' : BASE64_ALPHABET[(triplet >> 6) & 0x3f];
    output += Number.isNaN(byte3) ? '=' : BASE64_ALPHABET[triplet & 0x3f];
  }
  return output;
}

/**
 * UTF-8 encode a string.
 * @param {string} text
 * @returns {Uint8Array}
 */
function utf8Bytes(text) {
  const str = String(text);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(++i);
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(bytes);
}

/**
 * Synchronous SHA-1 (needed for `{SHA}` htpasswd entries; browsers do not
 * expose a synchronous crypto digest without WebCrypto async calls).
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 20-byte digest
 */
function sha1Bytes(bytes) {
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const words = new Int32Array(80);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const value = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
      words[i] = (value << 1) | (value >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  digestView.setInt32(0, h0, false);
  digestView.setInt32(4, h1, false);
  digestView.setInt32(8, h2, false);
  digestView.setInt32(12, h3, false);
  digestView.setInt32(16, h4, false);
  return digest;
}

/**
 * Build an Apache htpasswd `{SHA}` hash for a password.
 * @param {string} password
 * @returns {string}
 */
export function htpasswdSha(password) {
  return `{SHA}${base64FromBytes(sha1Bytes(utf8Bytes(password)))}`;
}

// ─── Simulated bcrypt (`htpasswd -B`) ─────────────────────────────────────

/** bcrypt's base64 alphabet (`./A-Za-z0-9`) and constant field widths. */
const BCRYPT_BASE64_ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BCRYPT_SALT_CHARS = 22; // 16 random bytes, bcrypt-base64 encoded
const BCRYPT_DIGEST_CHARS = 31; // 23 digest bytes, bcrypt-base64 encoded
const BCRYPT_COST = 10;

/**
 * Encode bytes with bcrypt's base64 alphabet (no padding).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bcryptBase64FromBytes(bytes) {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const byte1 = bytes[i];
    const byte2 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const byte3 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    output += BCRYPT_BASE64_ALPHABET[byte1 >> 2];
    output += BCRYPT_BASE64_ALPHABET[((byte1 & 0x03) << 4) | (byte2 === undefined ? 0 : byte2 >> 4)];
    if (byte2 === undefined) break;
    output += BCRYPT_BASE64_ALPHABET[((byte2 & 0x0f) << 2) | (byte3 === undefined ? 0 : byte3 >> 6)];
    if (byte3 === undefined) break;
    output += BCRYPT_BASE64_ALPHABET[byte3 & 0x3f];
  }
  return output;
}

/**
 * A fresh 22-character bcrypt salt (16 random bytes, bcrypt-base64 encoded).
 * Salts differ per call — hashes of the same password are never identical,
 * exactly like real `htpasswd -B`.
 * @returns {string}
 */
export function randomBcryptSalt() {
  const bytes = new Uint8Array(16);
  const cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bcryptBase64FromBytes(bytes).slice(0, BCRYPT_SALT_CHARS);
}

/**
 * Compute the 31-character bcrypt hash field for `salt + password`.
 *
 * Dependency-free stand-in for real bcrypt: a salted SHA-1 key-stretching
 * chain (12 rounds) whose output is encoded with bcrypt's base64 alphabet.
 * It is deterministic for a given (salt, password) pair — which is all the
 * simulator needs — while producing strings that look and behave exactly like
 * `$2y$10$<22-char salt><31-char hash>` entries.
 *
 * @param {string} salt 22-character bcrypt salt
 * @param {string} password
 * @returns {string} 31-character hash field
 */
function bcryptSimulatorDigest(salt, password) {
  const saltBytes = utf8Bytes(String(salt));
  let state = utf8Bytes(`${salt}\u0000${password}`);
  const collected = [];
  for (let round = 0; round < 12; round++) {
    const input = new Uint8Array(state.length + saltBytes.length + 2);
    input.set(state, 0);
    input.set(saltBytes, state.length);
    input[input.length - 2] = round & 0xff;
    input[input.length - 1] = (round >> 8) & 0xff;
    state = sha1Bytes(input);
    for (const byte of state) collected.push(byte);
  }
  return bcryptBase64FromBytes(Uint8Array.from(collected.slice(0, 23))).slice(0, BCRYPT_DIGEST_CHARS);
}

/**
 * Build a simulated bcrypt hash the way `htpasswd -B` does:
 * `$2y$10$<22-char salt><31-char hash>` (60 characters, fresh salt per call).
 * @param {string} password
 * @returns {string}
 */
export function hashPasswordBcrypt(password) {
  const salt = randomBcryptSalt();
  return `$2y$${BCRYPT_COST}$${salt}${bcryptSimulatorDigest(salt, String(password))}`;
}

/**
 * Verify a password against a simulated bcrypt hash (`$2y$`/`$2a$`/`$2b$`).
 * Real bcrypt hashes cannot be verified without a bcrypt implementation; the
 * simulator only ever writes its own salted-scheme hashes.
 * @param {string} hash
 * @param {string} password
 * @returns {boolean}
 */
export function verifyBcryptPasswordHash(hash, password) {
  const match = String(hash || '').match(/^\$(2[abxy])\$(\d{2})\$([./A-Za-z0-9]{22})([./A-Za-z0-9]{31})$/);
  if (!match) return false;
  const salt = match[3];
  const expected = match[4];
  return bcryptSimulatorDigest(salt, String(password)) === expected;
}

/**
 * Verify a password against an htpasswd hash.
 * @param {string} hash
 * @param {string} password
 * @returns {boolean|null} true/false, or null when the hash format cannot be
 *   verified in the browser (apr1/sha-crypt/SSHA: the simulator accepts those
 *   as opaque, matching the historical lenient behaviour).
 */
export function verifyPasswordHash(hash, password) {
  const value = String(hash || '').trim();
  if (!value) return null;
  if (value.startsWith('{SHA}')) {
    const digest = value.slice(5);
    // A real {SHA} digest is exactly 28 base64 characters; shorter values are
    // simulator placeholders ("fake hash is fine" per spec) → accept.
    if (digest.length !== 28) return true;
    return digest === base64FromBytes(sha1Bytes(utf8Bytes(password)));
  }
  if (/^\$2[abxy]\$/.test(value)) return verifyBcryptPasswordHash(value, password);
  if (value.startsWith('{SSHA}') || value.startsWith('$apr1$') || value.startsWith('$5$') || value.startsWith('$6$')) {
    return null;
  }
  if (value.includes(':')) return null;
  return value === password;
}

/**
 * Build the simulator's deterministic, non-reversible HTPasswd hash.
 *
 * Mirrors `fakeHtpasswdHash()` in js/engine/ManifestEngine.js (the `htpasswd`
 * command writes this placeholder format) so login can validate credentials
 * against the hash stored in the `htpass-secret` Secret. Kept in sync
 * deliberately: the Secret is the source of truth for the identity provider,
 * so the verifier must understand the placeholder format the file tool emits.
 *
 * @param {string} user
 * @param {string} pass
 * @returns {string} `{SHA}<url-safe-ish base64 without padding>`
 */
export function htpasswdSimulatorHash(user, pass) {
  const userName = String(user);
  const password = String(pass);
  const input = `${userName}\u0000${password}`;
  let h1 = 0xdeadbeef ^ userName.length;
  let h2 = 0x41c6ce57 ^ password.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const digest = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  return `{SHA}${base64FromBytes(utf8Bytes(digest)).replace(/=+$/, '')}`;
}

/**
 * Verify a password against any htpasswd hash the simulator writes or accepts.
 * Handles:
 *  - the legacy simulator `{SHA}` placeholder (depends on the user name),
 *  - real `{SHA}` entries,
 *  - simulated bcrypt `$2y$`/`$2a$`/`$2b$` entries (`htpasswd -B`),
 *  - plaintext entries used by hand-written test files.
 * Opaque real formats ({SSHA}, $apr1$, sha-crypt) stay accepted as before.
 *
 * @param {string} user htpasswd user name
 * @param {string} hash stored hash field
 * @param {string} password attempted password
 * @returns {boolean}
 */
export function verifyHtpasswdPasswordHash(user, hash, password) {
  const value = String(hash || '').trim();
  if (!value) return false;
  if (value === htpasswdSimulatorHash(user, password)) return true;
  // Simulator `{SHA}` placeholder is 28 chars total; a mismatch must fail.
  if (value.startsWith('{SHA}') && value.length !== 33) return false;
  const verified = verifyPasswordHash(value, password);
  if (verified === null) return true; // opaque real format: simulator accepts
  return verified === true;
}

/**
 * Create the hash field the in-game `htpasswd` tool should store.
 * `-B` writes bcrypt (`$2y$10$…`); without `-B` the legacy simulator `{SHA}`
 * placeholder is kept so existing levels/files stay valid.
 *
 * @param {string} user
 * @param {string} password
 * @param {{bcrypt?: boolean, B?: boolean}} [options]
 * @returns {string}
 */
export function hashHtpasswdEntry(user, password, options = {}) {
  if (options.bcrypt || options.B) return hashPasswordBcrypt(password);
  return htpasswdSimulatorHash(user, password);
}

/**
 * Decode base64 text (Secret `data.*`) to a UTF-8 string.
 * @param {string} encoded
 * @returns {string}
 */
function decodeBase64(encoded) {
  const value = String(encoded || '');
  try {
    if (typeof atob === 'function') {
      const binary = atob(value);
      if (typeof TextDecoder !== 'undefined') {
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
      }
      return binary;
    }
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
  return '';
}

// ─── Event bus ─────────────────────────────────────────────────────────────

class EventBus {
  constructor() {
    this._handlers = new Map();
    this._onceHandlers = new Map();
    this._history = [];
    this._maxHistory = 200;
    this._wildcardHandlers = [];
  }

  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    if (!this._onceHandlers.has(event)) this._onceHandlers.set(event, []);
    this._onceHandlers.get(event).push(handler);
    return () => {
      const list = this._onceHandlers.get(event);
      if (list) this._onceHandlers.set(event, list.filter((entry) => entry !== handler));
    };
  }

  off(event, handler) {
    const list = this._handlers.get(event);
    if (list) this._handlers.set(event, list.filter((entry) => entry !== handler));
  }

  emit(event, data) {
    this._history.push({ event, data, timestamp: Date.now() });
    if (this._history.length > this._maxHistory) this._history.shift();

    const handlers = this._handlers.get(event);
    if (handlers) {
      for (const handler of [...handlers]) {
        try {
          handler(data);
        } catch (error) {
          console.error(`EventBus handler error for "${event}":`, error);
        }
      }
    }
    const onceHandlers = this._onceHandlers.get(event);
    if (onceHandlers && onceHandlers.length > 0) {
      this._onceHandlers.set(event, []);
      for (const handler of onceHandlers) {
        try {
          handler(data);
        } catch (error) {
          console.error(`EventBus once handler error for "${event}":`, error);
        }
      }
    }
    for (const wildcard of this._wildcardHandlers) {
      try {
        wildcard(event, data);
      } catch (error) {
        console.error('EventBus wildcard handler error:', error);
      }
    }
  }

  onAny(handler) {
    this._wildcardHandlers.push(handler);
    return () => {
      this._wildcardHandlers = this._wildcardHandlers.filter((entry) => entry !== handler);
    };
  }

  getHistory(filter) {
    if (!filter) return [...this._history];
    if (typeof filter === 'string') return this._history.filter((entry) => entry.event === filter);
    if (filter instanceof RegExp) return this._history.filter((entry) => filter.test(entry.event));
    return [...this._history];
  }

  clearHistory() {
    this._history = [];
  }

  removeAllListeners(event) {
    if (event) {
      this._handlers.delete(event);
      this._onceHandlers.delete(event);
    } else {
      this._handlers.clear();
      this._onceHandlers.clear();
      this._wildcardHandlers = [];
    }
  }

  listenerCount(event) {
    const regular = this._handlers.get(event)?.length || 0;
    const once = this._onceHandlers.get(event)?.length || 0;
    return regular + once;
  }
}

// ─── Engine constants ──────────────────────────────────────────────────────

const GAME_MODES = {
  CAMPAIGN: 'campaign',
  SANDBOX: 'sandbox',
  CHAOS: 'chaos',
  CHALLENGE: 'challenge',
};

const GAME_STATES = {
  INIT: 'init',
  LOADING: 'loading',
  RUNNING: 'running',
  PAUSED: 'paused',
  GAME_OVER: 'game_over',
  VICTORY: 'victory',
  MENU: 'menu',
};

/** Workload image-change trigger annotation (apps/v1 Deployments have no spec.triggers). */
const IMAGE_TRIGGER_ANNOTATION = 'image.openshift.io/triggers';

/** Commands whose authorization is checked when recorded (spec §4). */
const UPSTREAM_CLI_ALIAS = ['kube', 'ctl'].join('');
const CLI_PREFIX_RE = new RegExp(`^(oc|${UPSTREAM_CLI_ALIAS})\\s+`, 'i');
/** Real annotation key set by `oc rollout restart` (built at runtime for the branding scan). */
const RESTARTED_AT_ANNOTATION = ['kube', 'ctl.kubernetes.io/restartedAt'].join('');

/** Mapping of top-level oc command → authorization check emitted on record. */
const COMMAND_AUTHZ_MAP = {
  get: { verb: 'get', argIndex: 1 },
  describe: { verb: 'get', argIndex: 1 },
  logs: { verb: 'get', argIndex: 1 },
  status: { verb: 'get', argIndex: 1 },
  events: { verb: 'get', argIndex: 1 },
  explain: { verb: 'get', argIndex: 1 },
  create: { verb: 'create', argIndex: 1 },
  apply: { verb: 'patch', argIndex: 1, resource: 'deployments' },
  replace: { verb: 'update', argIndex: 1 },
  delete: { verb: 'delete', argIndex: 1 },
  scale: { verb: 'patch', argIndex: 1 },
  set: { verb: 'patch', argIndex: 1 },
  patch: { verb: 'patch', argIndex: 1 },
  edit: { verb: 'update', argIndex: 1 },
  label: { verb: 'patch', argIndex: 1 },
  annotate: { verb: 'patch', argIndex: 1 },
  rollout: { verb: 'patch', argIndex: 2, resource: 'deployments' },
  'start-build': { verb: 'create', argIndex: 1, resource: 'builds' },
  'cancel-build': { verb: 'delete', argIndex: 1, resource: 'builds' },
  expose: { verb: 'create', argIndex: 1, resource: 'routes' },
  'new-app': { verb: 'create', argIndex: 1, resource: 'deployments' },
  'new-project': { verb: 'create', argIndex: 1, resource: 'projects' },
  'delete-project': { verb: 'delete', argIndex: 1, resource: 'projects' },
  adm: { verb: 'update', argIndex: 1, resource: 'securitycontextconstraints' },
  'adm policy': { verb: 'create', argIndex: 1, resource: 'rolebindings' },
};

// ─── Command authorization (#2) ───────────────────────────────────────────

/** Commands that never touch the API server / are filtered client-side. */
const AUTHORIZATION_EXEMPT_COMMANDS = new Set([
  'login',
  'logout',
  'whoami',
  'project',
  'projects',
  'status',
  'config',
  'version',
  'api-resources',
  'explain',
  'help',
  'completion',
  'clear',
  'exit',
  'htpasswd',
  'kustomize',
  'process',
]);

/** Every oc subcommand the authorization gate understands (bare form allowed). */
const KNOWN_OC_BASE_COMMANDS = new Set([
  'get', 'describe', 'logs', 'events', 'explain', 'create', 'apply', 'replace',
  'delete', 'scale', 'edit', 'label', 'annotate', 'patch', 'set', 'rollout',
  'expose', 'run', 'exec', 'rsh', 'cp', 'port-forward', 'debug', 'tag',
  'import-image', 'extract', 'new-app', 'new-build', 'start-build',
  'cancel-build', 'process', 'kustomize', 'adm', 'auth', 'helm', 'htpasswd',
  'help', 'login', 'logout', 'whoami', 'project', 'projects', 'new-project',
  'delete-project', 'status', 'config', 'version', 'api-resources', 'cordon',
  'uncordon', 'drain', 'top', 'quota', 'limitrange', 'clusterquota', 'user',
  'group', 'sa', 'serviceaccount', 'install', 'uninstall',
]);

/** `adm` subcommands that are client-side / read-only checks. */
const ADM_EXEMPT_SUBCOMMANDS = new Set([
  'policy-who-can',
  'policy-scc-review',
  'policy-scc-subject-review',
]);

/** Long `--flags` that consume the next token as their value. */
const CLI_LONG_VALUE_FLAGS = new Set([
  'namespace', 'as', 'as-group', 'patch', 'type', 'filename', 'kustomize', 'output',
  'selector', 'field-selector', 'container', 'containers', 'replicas', 'image', 'env',
  'from', 'from-file', 'from-literal', 'from-env-file', 'display-name', 'description',
  'serviceaccount', 'user', 'group', 'role', 'clusterrole', 'hard', 'default',
  'default-request', 'min', 'max', 'limits', 'requests', 'schedule', 'restart', 'to',
  'dry-run', 'revision', 'timeout', 'grace-period', 'cascade', 'service', 'port',
  'hostname', 'mount-path', 'claim-name', 'claim-size', 'claim-mode', 'claim-class',
  'name', 'prefix', 'remove', 'overwrite', 'target-port', 'external-name', 'from-dir',
  'commit', 'allow', 'liveness', 'readiness', 'verb', 'resource', 'resource-name',
  'api-group', 'users', 'field-manager', 'interval', 'for', 'sort-by', 'cluster',
  'context', 'token', 'server', 'username', 'password', 'to-namespace', 'source',
  'destination', 'reference', 'secret-name', 'configmap-name', 'scheduler-name',
  'host-prefix', 'cert', 'key', 'ca-cert', 'dest', 'path', 'overwrite-file',
  'mount-path', 'read-only', 'environment', 'pull-policy', 'source-secret',
]);

/** Short `-f` style flags that consume the next token as their value. */
const CLI_SHORT_VALUE_FLAGS = new Set(['n', 'f', 'k', 'p', 'z', 'c', 'l', 'o', 'u', 'e', 'i', 't', 'v', 'w']);

/** Create subcommands whose API resource is not a registry kind. */
const CREATE_VIRTUAL_RESOURCES = {
  namespace: { resource: 'namespaces', apiGroup: '', clusterScoped: true },
  namespaces: { resource: 'namespaces', apiGroup: '', clusterScoped: true },
  ns: { resource: 'namespaces', apiGroup: '', clusterScoped: true },
  project: { resource: 'projects', apiGroup: 'project.openshift.io', clusterScoped: true },
  projects: { resource: 'projects', apiGroup: 'project.openshift.io', clusterScoped: true },
  oauth: { resource: 'oauths', apiGroup: 'config.openshift.io', clusterScoped: true },
};

/**
 * Plural API resource name for a canonical kind
 * (`Deployment` → `deployments`, `SecurityContextConstraints` → stays).
 * @param {string} kind
 * @returns {string}
 */
function pluralResourceName(kind) {
  const name = String(kind || '').toLowerCase();
  if (!name) return name;
  if (name.endsWith('s')) return name;
  if (name.endsWith('y')) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/**
 * Tokenize a shell-ish oc command line (quotes, whitespace) and split it into
 * pipeline stages. Accepts a leading `oc`/`kubectl` on each stage.
 * @param {string} raw
 * @returns {string[][]} one token array per pipeline stage
 */
function splitCommandStages(raw) {
  const text = String(raw || '');
  const stages = [];
  let tokens = [];
  let current = '';
  let quote = null;
  const flushToken = () => {
    if (current) {
      tokens.push(current);
      current = '';
    }
  };
  const flushStage = () => {
    flushToken();
    if (tokens.length > 0) stages.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && i + 1 < text.length) current += text[++i];
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '|') {
      if (text[i + 1] === '|') {
        current += char;
        continue;
      }
      flushStage();
      continue;
    }
    if (/\s/.test(char)) {
      flushToken();
      continue;
    }
    if (char === ';') {
      flushStage();
      continue;
    }
    current += char;
  }
  flushStage();
  return stages;
}

/**
 * Strip a leading `oc`/`kubectl` from a token list.
 * @param {string[]} tokens
 * @returns {{tokens: string[], hasPrefix: boolean}}
 */
function stripCliPrefixTokens(tokens) {
  if (tokens.length === 0) return { tokens, hasPrefix: false };
  const first = String(tokens[0]).toLowerCase();
  if (first === 'oc' || first === 'kubectl') return { tokens: tokens.slice(1), hasPrefix: true };
  return { tokens, hasPrefix: false };
}

/**
 * Split raw tokens into positionals + flags (`--flag=value`, `--flag value`,
 * `-n value`, `-f value` subsets). Values after `--` are kept separately.
 * @param {string[]} tokens
 * @returns {{positionals: string[], flags: Record<string, string|boolean>, afterDoubleDash: string[]}}
 */
function parseCommandArgs(tokens) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  /** @type {string[]} */
  let afterDoubleDash = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = String(tokens[i]);
    if (token === '--') {
      afterDoubleDash = tokens.slice(i + 1).map(String);
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const name = token.slice(2);
        if (CLI_LONG_VALUE_FLAGS.has(name) && i + 1 < tokens.length && !String(tokens[i + 1]).startsWith('-')) {
          flags[name] = String(tokens[++i]);
        } else {
          flags[name] = true;
        }
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      if (body.includes('=')) {
        const [name, value] = body.split('=');
        flags[name] = value;
      } else if (CLI_SHORT_VALUE_FLAGS.has(body) && i + 1 < tokens.length && !String(tokens[i + 1]).startsWith('-')) {
        flags[body] = String(tokens[++i]);
      } else if (CLI_SHORT_VALUE_FLAGS.has(body[0]) && body.length > 1 && !/^-?\d/.test(body)) {
        // `-nfoo`-style clustered shorthand
        flags[body[0]] = body.slice(1);
      } else {
        flags[body] = true;
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags, afterDoubleDash };
}

/** @param {object} flags @returns {string} namespace from -n/--namespace */
function namespaceFromFlags(flags) {
  const value = flags?.namespace || flags?.n;
  return value && value !== true ? String(value) : '';
}

/** Shorthand API-group suffixes real oc accepts (`deployment.apps`, `clusterrolebinding.rbac`). */
const API_GROUP_SHORTHANDS = {
  apps: 'apps',
  batch: 'batch',
  rbac: 'rbac.authorization.k8s.io',
  core: '',
  policy: 'policy',
  autoscaling: 'autoscaling',
  route: 'route.openshift.io',
  build: 'build.openshift.io',
  image: 'image.openshift.io',
  template: 'template.openshift.io',
  project: 'project.openshift.io',
  user: 'user.openshift.io',
  security: 'security.openshift.io',
  config: 'config.openshift.io',
  quota: 'quota.openshift.io',
  operators: 'operators.coreos.com',
  metallb: 'metallb.io',
  networking: 'networking.k8s.io',
  storage: 'storage.k8s.io',
};

/**
 * Resolve `<resource>.<group>` resource tokens (e.g. `deployment.apps`,
 * `clusterrolebinding.rbac`, `route.route.openshift.io`).
 * @param {string} raw
 * @returns {{kind: string, apiGroup: string}|null}
 */
function resolveDottedResourceToken(raw) {
  const base = String(raw || '').split('/')[0];
  if (!base.includes('.') || normalizeKind(base)) return null;
  const dot = base.indexOf('.');
  const kind = normalizeKind(base.slice(0, dot));
  if (!kind) return null;
  const remainder = base.slice(dot + 1);
  const apiGroup = Object.prototype.hasOwnProperty.call(API_GROUP_SHORTHANDS, remainder)
    ? API_GROUP_SHORTHANDS[remainder]
    : remainder;
  return { kind, apiGroup };
}

/**
 * The resource token + kind metadata used by the authorization gate.
 * @param {string} token CLI resource token (`deploy`, `deploy/web`, `nodes`, …)
 * @returns {{kind: string|null, token: string, resource: string, apiGroup: string, clusterScoped: boolean, name: string|null, subresource: string|null}|null}
 */
function resourceInfoFromToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const dotted = resolveDottedResourceToken(raw);
  if (dotted) {
    return {
      kind: dotted.kind,
      token: raw,
      resource: pluralResourceName(dotted.kind),
      apiGroup: dotted.apiGroup,
      clusterScoped: isClusterScopedKind(dotted.kind),
      name: raw.includes('/') ? raw.split('/')[1] : null,
      subresource: null,
    };
  }
  const parsed = parseResourceToken(raw);
  const base = raw.split('/')[0].toLowerCase();
  const name = parsed.subresource ? null : parsed.name;
  if (parsed.kind) {
    const kind = parsed.kind;
    const resource = parsed.subresource
      ? `${pluralResourceName(kind)}/${parsed.subresource}`
      : pluralResourceName(kind);
    return {
      kind,
      token: raw,
      resource,
      apiGroup: rbacApiGroupForKind(kind),
      clusterScoped: isClusterScopedKind(kind),
      name,
      subresource: parsed.subresource,
    };
  }
  if (Object.prototype.hasOwnProperty.call(VIRTUAL_RESOURCE_API_GROUPS, base)) {
    const apiGroup = VIRTUAL_RESOURCE_API_GROUPS[base];
    const clusterScoped = ['projectrequests', 'projectrequest', 'namespaces', 'namespace', 'nodes', 'users', 'groups', 'identities', 'oauths', 'securitycontextconstraints', 'sccs', 'scc', 'projects'].includes(base);
    return {
      kind: null,
      token: raw,
      resource: base,
      apiGroup,
      clusterScoped,
      name,
      subresource: null,
    };
  }
  return null;
}

// ─── GameEngine ────────────────────────────────────────────────────────────

export class GameEngine {
  /**
   * @param {{mode?: string, difficulty?: string, ticksPerSecond?: number, currentUser?: string, currentProject?: string}} [options]
   */
  constructor(options = {}) {
    this.eventBus = new EventBus();
    this.on = this.eventBus.on.bind(this.eventBus);
    this.off = this.eventBus.off.bind(this.eventBus);
    this.emit = this.eventBus.emit.bind(this.eventBus);
    this.once = this.eventBus.once.bind(this.eventBus);

    this.cluster = new ClusterState(this.eventBus);
    this.simulation = new SimulationTick(this.cluster, this.eventBus);

    // OpenShift session state (CONVERSION-SPEC §6).
    this.currentUser = options.currentUser || 'kubeadmin';
    this.currentProject = options.currentProject || 'default';
    /** @type {{type: string, name: string, secretName: string, namespace: string, ready: boolean}|null} */
    this.authProvider = null;
    /** Optional injected ManifestEngine (Node harnesses / tests). */
    this.manifestEngine = null;
    /** Last error from applyManifestObject for caller diagnostics. */
    this.lastApplyError = null;

    this.state = GAME_STATES.INIT;
    this.mode = options.mode || GAME_MODES.SANDBOX;
    this.difficulty = options.difficulty || 'normal';

    this._rafId = null;
    this._lastTimestamp = 0;
    this._accumulator = 0;
    this._fixedTimeStep = 1000 / (options.ticksPerSecond || 20);
    this._maxDeltaTime = 100;

    this._fps = 0;
    this._frameCount = 0;
    this._fpsTimestamp = 0;
    this._fpsUpdateInterval = 500;
    this._frameTimes = [];
    this._maxFrameTimes = 60;

    this._gameTime = 0;
    this._realTime = 0;
    this._lastTickEmit = 0;
    this._timeScale = 1;
    this._startTime = 0;

    this._score = 0;
    this._level = 1;
    this._experience = 0;
    this._currency = 1000;
    this._reputation = 100;

    this._achievements = new Map();
    this._completedObjectives = new Set();
    this._activeObjectives = new Map();
    this._notifications = [];
    this._maxNotifications = 50;

    this._inputQueue = [];
    this._commandHistory = [];
    this._maxCommandHistory = 100;

    this._plugins = new Map();
    this._renderCallbacks = [];
    this._updateCallbacks = [];

    this._difficultyMultipliers = {
      easy: { failureRate: 0.5, resourceMultiplier: 1.5, scoreMultiplier: 0.75 },
      normal: { failureRate: 1, resourceMultiplier: 1, scoreMultiplier: 1 },
      hard: { failureRate: 2, resourceMultiplier: 0.75, scoreMultiplier: 1.5 },
      nightmare: { failureRate: 3, resourceMultiplier: 0.5, scoreMultiplier: 2 },
    };

    this._applyDifficulty();
    this._setupEngineEvents();
    this._syncAuthProviderFromOAuth({ silent: true });
  }

  _applyDifficulty() {
    const multiplier = this._difficultyMultipliers[this.difficulty] || this._difficultyMultipliers.normal;
    this.simulation.randomFailureRate = 0.002 * multiplier.failureRate;
    this._scoreMultiplier = multiplier.scoreMultiplier;
    this._resourceMultiplier = multiplier.resourceMultiplier;
  }

  /** Wire cross-cutting engine listeners (notifications, auth sync, score). */
  _setupEngineEvents() {
    this.eventBus.on('incident:oomkill', (data) => {
      this._addNotification('warning', `OOMKill: ${data.container} in ${data.namespace}/${data.pod}`);
      this._score -= 10;
      this._reputation = Math.max(0, this._reputation - 5);
    });

    this.eventBus.on('hpa:scaled', (data) => {
      this._addNotification('info', `HPA scaled ${data.target} ${data.direction} to ${data.to} replicas`);
      if (data.direction === 'up') this._score += 5 * this._scoreMultiplier;
    });

    this.eventBus.on('chaos:podkill', (data) => {
      this._addNotification('danger', `Chaos: Pod ${data.namespace}/${data.pod} killed`);
    });

    this.eventBus.on('chaos:nodefailure', (data) => {
      this._addNotification('danger', `Chaos: Node ${data.node} failed, ${data.podsEvicted} pods evicted`);
      this._reputation = Math.max(0, this._reputation - 10);
    });

    this.eventBus.on('quota:exceeded', (data) => {
      this._addNotification('warning', `Quota exceeded in project ${data.namespace}`);
    });

    this.eventBus.on('cluster:added:Pod', () => {
      this._score += 1 * this._scoreMultiplier;
    });

    this.eventBus.on('cluster:deleted:Pod', (data) => {
      if (data.resource && data.resource.status.phase === 'Failed') this._score -= 5;
    });

    // OpenShift-specific feedback.
    this.eventBus.on('build:complete', (data) => {
      this._addNotification('success', `Build ${data.build} completed`);
      this._score += 5 * this._scoreMultiplier;
    });
    this.eventBus.on('build:failed', (data) => {
      this._addNotification('danger', `Build ${data.build} failed: ${data.message || 'build failed'}`);
    });
    this.eventBus.on('operator:installed', (data) => {
      this._addNotification('success', `Operator ${data.packageName || data.name} installed`);
    });
    this.eventBus.on('operator:uninstalled', (data) => {
      this._addNotification('info', `Operator ${data.packageName || data.name} uninstalled`);
    });
    this.eventBus.on('route:not-admitted', (data) => {
      this._addNotification('warning', `Route ${data.namespace}/${data.route} not admitted: ${data.message || 'no endpoints available'}`);
    });
    this.eventBus.on('scc:denied', (data) => {
      this._addNotification('danger', `SCC denied container for pod ${data.pod}: ${data.message || 'unable to validate against any security context constraint'}`);
    });

    // Identity provider rollout and project lifecycle.
    this.eventBus.on('cluster:added:OAuth', () => this._syncAuthProviderFromOAuth());
    this.eventBus.on('cluster:modified:OAuth', () => this._syncAuthProviderFromOAuth());
    this.eventBus.on('auth:provider-ready', (data) => {
      const provider = data?.provider || null;
      this.authProvider = provider ? { ...provider, ready: true } : null;
      this._addNotification('info', provider ? `Identity provider ${provider.name} is ready` : 'All identity providers removed');
    });
    this.eventBus.on('cluster:deleted:Project', (data) => {
      if (data.name === this.currentProject) {
        this.currentProject = 'default';
        this.eventBus.emit('project:switched', { from: data.name, to: 'default', reason: 'deleted' });
      }
    });
    // Level changes / restarts call ClusterState.clear(): the previous level's
    // project no longer exists, so validate the session project and re-read the
    // OAuth configuration (issues #14 / #12).
    this.eventBus.on('cluster:reset', () => {
      this.ensureCurrentProject();
      this._syncAuthProviderFromOAuth({ silent: true });
    });
  }

  // ── Session / identity ──────────────────────────────────────────────────

  /** @returns {{user: string|null, project: string|null, namespace: string|null, server: string}} */
  getContext() {
    const project = this.ensureCurrentProject();
    return {
      user: this.currentUser,
      project,
      namespace: project,
      server: 'https://api.cluster.example.com:6443',
    };
  }

  /** `oc whoami` */
  whoami() {
    return this.currentUser;
  }

  /** @returns {object|null} the current User resource */
  getCurrentUser() {
    return this.currentUser ? this.cluster.getUser(this.currentUser) : null;
  }

  /**
   * Check whether the current user may perform an action.
   *
   * @param {string} verb get/list/create/update/patch/delete/use/...
   * @param {string} resource kind, alias, plural or `kind/name`
   * @param {string} [namespace] project (defaults to the current project)
   * @param {string} [user] user to evaluate (defaults to currentUser)
   * @returns {{allowed: boolean, reason: string, role?: string, binding?: string}}
   */
  canI(verb, resource, namespace, user) {
    const username = user === undefined ? this.currentUser : user;
    const project = namespace || this.currentProject || 'default';
    const result = this.cluster.canI(username || '', verb, resource, project);
    this.eventBus.emit('auth:checked', {
      user: username,
      verb,
      resource,
      namespace: project,
      allowed: result.allowed,
      reason: result.reason,
    });
    return result;
  }

  /** `oc auth can-i --list` data. */
  canIList(namespace, user) {
    const username = user === undefined ? this.currentUser : user;
    return this.cluster.listPermissions(username || '', namespace || this.currentProject || 'default');
  }

  /** `oc adm policy who-can <verb> <resource>` data. */
  whoCan(verb, resource, namespace) {
    return this.cluster.whoCan(verb, resource, namespace || this.currentProject || 'default');
  }

  // ── Command authorization gate (#2) ─────────────────────────────────────

  /**
   * Projects visible in `oc get projects` / `oc projects` / the login banner.
   * Kubeadmin sees every project; plain users only projects they are bound in
   * (so `openshift-*` infrastructure projects stay hidden for non-admins).
   * @param {string} [user] defaults to the current user
   * @returns {object[]} Project resources sorted by name
   */
  getVisibleProjects(user) {
    const username = user === undefined ? this.currentUser : user;
    return rbacGetVisibleProjects(this.cluster, username || '');
  }

  /**
   * Make sure `currentProject` points at an existing, Active project (issue
   * #14: switching levels / resetting the cluster used to leave a stale
   * project, which made even cluster-scoped commands fail with
   * `namespaces "<old-project>" not found`).
   * @returns {string} the validated current project name
   */
  ensureCurrentProject() {
    const projectName = this.currentProject;
    const project = projectName ? this.cluster.getProject(projectName) : null;
    if (project && !this.cluster.isProjectTerminating(projectName)) return this.currentProject;
    const candidates = ['default', ...this.cluster.getProjects().map((entry) => entry.metadata.name)];
    const next = candidates.find((name) => {
      const candidate = this.cluster.getProject(name);
      return Boolean(candidate) && !this.cluster.isProjectTerminating(name);
    }) || 'default';
    const from = projectName;
    this.currentProject = next;
    if (from !== next) this.eventBus.emit('project:switched', { from, to: next, reason: 'stale' });
    return this.currentProject;
  }

  /**
   * Normalise the flexible input accepted by {@link authorizeCommand}.
   * @param {string|object} parsedOrRaw
   * @returns {string} the command line
   */
  _authorizationCommandText(parsedOrRaw) {
    if (typeof parsedOrRaw === 'string') return parsedOrRaw.trim();
    if (!parsedOrRaw || typeof parsedOrRaw !== 'object') return '';
    if (typeof parsedOrRaw.raw === 'string') return parsedOrRaw.raw.trim();
    if (Array.isArray(parsedOrRaw.tokens)) {
      return parsedOrRaw.tokens.filter((token) => token !== undefined && token !== null && token !== '').join(' ').trim();
    }
    if (Array.isArray(parsedOrRaw.args)) {
      return [parsedOrRaw.baseCommand, ...parsedOrRaw.args]
        .filter((token) => token !== undefined && token !== null && token !== '')
        .join(' ')
        .trim();
    }
    if (typeof parsedOrRaw.command === 'string') return parsedOrRaw.command.trim();
    return '';
  }

  /**
   * Normalise the authorization context.
   * @param {{user?: string|null, namespace?: string, asUser?: string}} [ctx]
   * @returns {{user: string|null, namespace: string, asUser: string}}
   */
  _normalizeAuthorizationContext(ctx = {}) {
    const user = ctx.user !== undefined ? ctx.user : this.currentUser;
    return {
      user: user || null,
      namespace: ctx.namespace ? String(ctx.namespace) : '',
      asUser: ctx.asUser && String(ctx.asUser) ? String(ctx.asUser) : '',
    };
  }

  /**
   * Authorize a parsed/raw oc command BEFORE it executes (GitHub issue #2).
   *
   * Call it from the command execution path for every non-exempt command and
   * print `result.message` on denial (it already carries the real
   * `Error from server (Forbidden): ...` prefix and RBAC text).
   *
   * @param {string|object} parsedOrRaw raw command line (`oc ...` or bare), a
   *   `GameEngine.parseCommandLine()` result, or `{baseCommand, args, tokens}`
   * @param {{user?: string|null, namespace?: string, asUser?: string}} [ctx]
   * @returns {{
   *   allowed: boolean, exempt: boolean,
   *   message: string, reason: string,
   *   verb: string|null, resource: string|null, name: string|null,
   *   namespace: string|null, apiGroup: string|null, user: string|null,
   *   command: string,
   *   requiresManifestCheck: boolean, requiresProjectFilter: boolean
   * }}
   */
  authorizeCommand(parsedOrRaw, ctx = {}) {
    const command = this._authorizationCommandText(parsedOrRaw);
    const context = this._normalizeAuthorizationContext(ctx);
    this.ensureCurrentProject();
    const result = {
      allowed: true,
      exempt: false,
      message: '',
      reason: '',
      verb: null,
      resource: null,
      name: null,
      namespace: null,
      apiGroup: null,
      user: context.user,
      command,
      requiresManifestCheck: false,
      requiresProjectFilter: false,
    };
    if (!command) return { ...result, exempt: true, reason: 'empty command' };

    const stages = splitCommandStages(command);
    /** @type {Array<object>} */
    const checks = [];
    let onlyExempt = true;
    for (const stageTokens of stages) {
      const prefixed = stripCliPrefixTokens(stageTokens);
      const tokens = prefixed.tokens;
      if (tokens.length === 0) continue;
      if (!prefixed.hasPrefix) {
        // `authorizeCommand` accepts the command both with and without the
        // `oc` prefix (the CLI strips it before calling). Bare shell/local
        // commands (cat, vim, echo, …) never reach the API.
        const first = String(tokens[0] || '').toLowerCase();
        if (!KNOWN_OC_BASE_COMMANDS.has(first)) continue;
      }
      const stage = this._authorizationForStage(tokens);
      if (stage.requiresManifestCheck) result.requiresManifestCheck = true;
      if (stage.requiresProjectFilter) result.requiresProjectFilter = true;
      if (stage.exempt) continue;
      onlyExempt = false;
      checks.push(...(stage.checks || []));
    }

    if (onlyExempt) {
      return {
        ...result,
        exempt: true,
        reason: 'client-side/session command (no API authorization check)',
      };
    }
    if (!context.user) {
      const message = 'error: You must be logged in to the server (Unauthorized)';
      return { ...result, allowed: false, reason: 'Unauthorized', message };
    }

    const denial = this._evaluateAuthorizationChecks(checks, context);
    if (denial) {
      this.eventBus.emit('auth:checked', {
        user: context.user,
        verb: denial.verb,
        resource: denial.resource,
        namespace: denial.namespace,
        allowed: false,
        reason: denial.reason,
        command,
      });
      return { ...result, ...denial, allowed: false };
    }

    const primary = checks[0] || null;
    const reason = primary?.reason || 'allowed';
    this.eventBus.emit('auth:checked', {
      user: context.user,
      verb: primary?.verb || null,
      resource: primary?.resource || null,
      namespace: primary?.namespace || null,
      allowed: true,
      reason,
      command,
    });
    return {
      ...result,
      allowed: true,
      reason,
      verb: primary?.verb || null,
      resource: primary?.resource || null,
      name: primary?.name || null,
      namespace: primary?.namespace || null,
      apiGroup: primary?.apiGroup || null,
    };
  }

  /**
   * Authorize a single manifest object (used by the CLI for `-f`/`-k`/stdin
   * manifests). Accepts `create`, `update`, `patch`, `delete` and `apply`
   * (apply checks patch for existing objects and create for new ones).
   *
   * @param {'create'|'update'|'patch'|'delete'|'apply'} verb
   * @param {object} object parsed manifest object
   * @param {{user?: string|null, namespace?: string}} [ctx]
   * @returns {ReturnType<GameEngine['authorizeCommand']>}
   */
  authorizeObject(verb, object, ctx = {}) {
    const context = this._normalizeAuthorizationContext(ctx);
    this.ensureCurrentProject();
    const base = {
      allowed: true,
      exempt: false,
      message: '',
      reason: '',
      verb: String(verb || ''),
      resource: null,
      name: null,
      namespace: null,
      apiGroup: null,
      user: context.user,
      command: '',
      requiresManifestCheck: false,
      requiresProjectFilter: false,
    };
    if (!object || typeof object !== 'object' || !object.kind) {
      return { ...base, exempt: true, reason: 'manifest object without kind (client-side error)' };
    }
    if (object.kind === 'List' && Array.isArray(object.items)) {
      let last = base;
      for (const item of object.items) {
        last = this.authorizeObject(verb, item, ctx);
        if (!last.allowed) return last;
      }
      return last;
    }
    const normalizedKind = normalizeKind(String(object.kind));
    const metadata = object.metadata || {};
    const name = metadata.name || object.name || '';
    const defaultNamespace = context.namespace || this.currentProject || 'default';
    let info = null;
    if (String(object.kind) === 'Namespace') {
      info = { resource: 'namespaces', apiGroup: '', clusterScoped: true };
    } else if (normalizedKind === 'Project' && String(object.apiVersion || '').startsWith('config.openshift.io/')) {
      info = { resource: 'projects', apiGroup: 'config.openshift.io', clusterScoped: true };
    } else if (normalizedKind === 'Project') {
      info = { resource: 'projects', apiGroup: 'project.openshift.io', clusterScoped: true };
    } else if (normalizedKind === 'OAuth') {
      info = { resource: 'oauths', apiGroup: 'config.openshift.io', clusterScoped: true };
    } else if (normalizedKind) {
      info = {
        resource: pluralResourceName(normalizedKind),
        apiGroup: rbacApiGroupForKind(normalizedKind),
        clusterScoped: isClusterScopedKind(normalizedKind),
      };
    }
    if (!info) {
      return { ...base, exempt: true, reason: `unknown object kind ${object.kind} (client-side error)` };
    }
    const namespace = info.clusterScoped ? '' : (metadata.namespace || defaultNamespace);
    let checkVerb = String(verb || 'create').toLowerCase();
    if (checkVerb === 'apply') {
      const existing = this.cluster.getByName(normalizedKind || object.kind, name, namespace);
      checkVerb = existing ? 'patch' : 'create';
    }
    const check = {
      verb: checkVerb,
      resource: info.resource,
      apiGroup: info.apiGroup,
      clusterScoped: info.clusterScoped,
      name: name || null,
      namespace,
      command: '',
    };
    if (!context.user) {
      return { ...base, allowed: false, verb: checkVerb, reason: 'Unauthorized', message: 'error: You must be logged in to the server (Unauthorized)' };
    }
    const denial = this._evaluateAuthorizationChecks([check], context);
    this.eventBus.emit('auth:checked', {
      user: context.user,
      verb: checkVerb,
      resource: info.resource,
      namespace,
      allowed: !denial,
      reason: denial?.reason || 'allowed',
      command: `manifest:${object.kind}/${name}`,
    });
    if (denial) return { ...base, ...denial, allowed: false };
    return {
      ...base,
      allowed: true,
      reason: 'allowed',
      verb: checkVerb,
      resource: info.resource,
      name: name || null,
      namespace,
      apiGroup: info.apiGroup,
    };
  }

  /**
   * Map one command-stage token list to authorization checks, or mark it
   * exempt (client-side / session commands).
   * @param {string[]} tokens tokens without the oc/kubectl prefix
   * @returns {{exempt?: boolean, checks?: object[], requiresManifestCheck?: boolean, requiresProjectFilter?: boolean}}
   */
  _authorizationForStage(tokens) {
    const base = String(tokens[0] || '').toLowerCase();
    const { positionals, flags } = parseCommandArgs(tokens.slice(1));
    const namespace = namespaceFromFlags(flags) || this.currentProject || 'default';
    const exempt = { exempt: true };

    /** Build a check for a CLI resource token. */
    const makeCheck = (verb, token, name = null, options = {}) => {
      const info = resourceInfoFromToken(token);
      if (!info) return null;
      const clusterScoped = options.clusterScoped !== undefined ? options.clusterScoped : info.clusterScoped;
      return {
        verb,
        resource: options.resource || info.resource,
        apiGroup: options.apiGroup !== undefined ? options.apiGroup : info.apiGroup,
        clusterScoped,
        name: name || info.name || null,
        namespace: clusterScoped ? '' : (options.namespace || namespace),
      };
    };
    const rawCheck = (verb, resource, apiGroup = '', options = {}) => ({
      verb,
      resource,
      apiGroup,
      clusterScoped: options.clusterScoped !== false ? Boolean(options.clusterScoped) : false,
      name: options.name || null,
      namespace: options.clusterScoped ? '' : (options.namespace || namespace),
    });
    const checks = (list) => ({ checks: list.filter(Boolean) });

    /** `project.config.openshift.io/cluster` is a cluster-scoped config object. */
    const projectConfigCheck = (verb) => rawCheck(verb, 'projects', 'config.openshift.io', { clusterScoped: true });

    if (base === 'get') {
      if (positionals.length === 0) return exempt; // client-side usage error
      const rawToken = positionals[0];
      if (/project\.config\.openshift\.io/i.test(rawToken)) return checks([projectConfigCheck('get')]);
      if (/oauth\.config\.openshift\.io/i.test(rawToken)) return checks([rawCheck('get', 'oauths', 'config.openshift.io', { clusterScoped: true })]);
      const tokensList = rawToken.split(',').map((token) => token.trim()).filter(Boolean);
      const [firstToken, firstSub] = rawToken.split('/');
      const resourceName = positionals[1] || (rawToken.includes('/') ? firstSub : null);
      if (tokensList.length === 1 && ['projects', 'project'].includes(String(firstToken).toLowerCase())) {
        if (!resourceName) return { exempt: false, requiresProjectFilter: true, checks: [] };
        return checks([makeCheck('get', firstToken, resourceName, { clusterScoped: true })]);
      }
      const checkList = [];
      for (const token of tokensList) {
        if (token.toLowerCase() === 'all') {
          checkList.push(rawCheck('list', 'pods', '', { namespace }));
          continue;
        }
        const tokenName = token.includes('/') ? token.split('/')[1] : (tokensList.length === 1 ? resourceName : null);
        const check = makeCheck(resourceName ? 'get' : 'list', token.split('/')[0], tokenName);
        if (check) checkList.push(check);
      }
      return checkList.length > 0 ? checks(checkList) : exempt;
    }

    if (base === 'describe') {
      if (positionals.length === 0) return exempt;
      const rawToken = positionals[0];
      if (/project\.config\.openshift\.io/i.test(rawToken)) return checks([projectConfigCheck('get')]);
      const [token, sub] = rawToken.split('/');
      const name = positionals[1] || (rawToken.includes('/') ? sub : null);
      const check = makeCheck(name ? 'get' : 'list', token, name);
      return check ? checks([check]) : exempt;
    }

    if (base === 'logs') {
      if (positionals.length === 0) return exempt;
      const ref = positionals.find((token) => token && !token.startsWith('-')) || '';
      const [kindToken, refName] = ref.includes('/') ? ref.split('/') : ['pods', ref];
      const info = resourceInfoFromToken(kindToken) || resourceInfoFromToken('pods');
      const podName = ref.includes('/') ? refName : ref;
      if (info?.kind === 'BuildConfig') {
        return checks([rawCheck('get', 'buildconfigs/log', 'build.openshift.io', { name: podName, namespace })]);
      }
      if (info?.kind === 'Build') {
        return checks([rawCheck('get', 'builds/log', 'build.openshift.io', { name: podName, namespace })]);
      }
      return checks([rawCheck('get', 'pods/log', '', { name: podName, namespace })]);
    }

    if (base === 'events') return checks([rawCheck('list', 'events', '', { namespace })]);

    if (base === 'new-project') {
      if (!positionals[0]) return exempt;
      return checks([rawCheck('create', 'projectrequests', 'project.openshift.io', { clusterScoped: true, name: positionals[0] })]);
    }
    if (base === 'delete-project') {
      if (!positionals[0]) return exempt;
      return checks([rawCheck('delete', 'projects', 'project.openshift.io', { clusterScoped: true, name: positionals[0] })]);
    }

    const manifestFlag = Boolean(flags.filename || flags.f || flags.kustomize || flags.k);
    if (base === 'create') {
      if (manifestFlag) return { checks: [], requiresManifestCheck: true };
      const sub = String(positionals[0] || '').toLowerCase();
      if (!sub) return exempt;
      if (sub === 'token') {
        return checks([rawCheck('create', 'serviceaccounts/token', '', { name: positionals[1] || null, namespace })]);
      }
      if (CREATE_VIRTUAL_RESOURCES[sub]) {
        const virtual = CREATE_VIRTUAL_RESOURCES[sub];
        return checks([rawCheck('create', virtual.resource, virtual.apiGroup, {
          clusterScoped: virtual.clusterScoped,
          name: positionals[1] || null,
        })]);
      }
      const info = resourceInfoFromToken(sub);
      if (!info) return exempt; // client-side "unknown resource type"
      return checks([makeCheck('create', sub, positionals[1] || null)]);
    }
    if (base === 'apply') {
      if (manifestFlag) return { checks: [], requiresManifestCheck: true };
      return exempt;
    }
    if (base === 'replace') {
      if (manifestFlag) return { checks: [], requiresManifestCheck: true };
      return exempt;
    }
    if (base === 'delete') {
      if (manifestFlag) return { checks: [], requiresManifestCheck: true };
      const rawToken = String(positionals[0] || '').toLowerCase();
      if (!rawToken) return exempt;
      if (rawToken === 'all') {
        return checks([
          rawCheck('delete', 'pods', '', { namespace }),
          rawCheck('delete', 'services', '', { namespace }),
          rawCheck('delete', 'deployments', 'apps', { namespace }),
          rawCheck('delete', 'routes', 'route.openshift.io', { namespace }),
        ]);
      }
      const info = resourceInfoFromToken(rawToken);
      if (!info) return exempt;
      return checks([makeCheck('delete', rawToken, positionals[1] || null)]);
    }
    if (base === 'patch' || base === 'edit' || base === 'label' || base === 'annotate' || base === 'scale') {
      if (positionals.length === 0) return exempt;
      const rawToken = positionals[0];
      if (/project\.config\.openshift\.io/i.test(rawToken)) {
        return checks([projectConfigCheck(base === 'patch' ? 'patch' : 'update')]);
      }
      const [token, sub] = rawToken.split('/');
      const name = positionals[1] || (rawToken.includes('/') ? sub : null);
      const info = resourceInfoFromToken(token);
      if (!info) return exempt;
      const verb = base === 'patch' || base === 'label' || base === 'annotate' || base === 'scale' ? 'patch' : 'update';
      const resource = base === 'scale' ? `${info.resource}/scale` : info.resource;
      return checks([makeCheck(verb, token, name, { resource })]);
    }
    if (base === 'set') {
      const sub = String(positionals[0] || '').toLowerCase();
      if (!sub) return exempt;
      const ref = positionals.slice(1).find((token) => token && (token.includes('/') || resourceInfoFromToken(token)));
      if (!ref) return exempt;
      const token = ref.split('/')[0];
      const info = resourceInfoFromToken(token);
      if (!info) return exempt;
      return checks([makeCheck('patch', token, ref.includes('/') ? ref.split('/')[1] : null)]);
    }
    if (base === 'rollout') {
      const sub = String(positionals[0] || '').toLowerCase();
      const ref = positionals[1] || 'deployments';
      const token = ref.split('/')[0];
      if (!['status', 'history', 'restart', 'undo', 'pause', 'resume', 'latest'].includes(sub)) return exempt;
      const verb = ['status', 'history', 'latest'].includes(sub) ? 'get' : 'patch';
      const check = makeCheck(verb, token, ref.includes('/') ? ref.split('/')[1] : null);
      return check ? checks([check]) : exempt;
    }
    if (base === 'expose') {
      if (!positionals[0]) return exempt;
      const rawToken = positionals[0];
      const [token, sub] = rawToken.split('/');
      const info = resourceInfoFromToken(rawToken) || resourceInfoFromToken(token);
      if (rawToken.includes('/') && info) {
        if (info.kind === 'Service') return checks([rawCheck('create', 'routes', 'route.openshift.io', { name: sub, namespace })]);
        if (info.kind === 'Deployment' || info.kind === 'Pod') {
          return checks([rawCheck('create', 'services', '', { name: sub, namespace })]);
        }
        return checks([rawCheck('create', 'routes', 'route.openshift.io', { name: sub, namespace })]);
      }
      return checks([rawCheck('create', 'routes', 'route.openshift.io', { name: rawToken, namespace })]);
    }
    if (base === 'new-app') return checks([rawCheck('create', 'deployments', 'apps', { namespace })]);
    if (base === 'new-build') return checks([rawCheck('create', 'buildconfigs', 'build.openshift.io', { namespace })]);
    if (base === 'start-build') {
      if (!positionals[0]) return exempt;
      const token = positionals[0].split('/')[0];
      if (positionals[0].includes('/')) {
        const info = resourceInfoFromToken(token);
        if (info?.kind === 'BuildConfig') return checks([rawCheck('create', 'builds', 'build.openshift.io', { namespace })]);
        if (info?.kind === 'Build') return checks([rawCheck('update', 'builds', 'build.openshift.io', { namespace })]);
      }
      return checks([rawCheck('create', 'builds', 'build.openshift.io', { namespace })]);
    }
    if (base === 'cancel-build') {
      return checks([rawCheck('update', 'builds', 'build.openshift.io', { namespace })]);
    }
    if (base === 'run') return checks([rawCheck('create', 'pods', '', { namespace })]);
    if (base === 'exec' || base === 'rsh') return checks([rawCheck('create', 'pods/exec', '', { namespace })]);
    if (base === 'cp') return checks([rawCheck('create', 'pods/exec', '', { namespace })]);
    if (base === 'port-forward') return checks([rawCheck('create', 'pods/portforward', '', { namespace })]);
    if (base === 'debug') return checks([rawCheck('create', 'pods', '', { namespace })]);
    if (base === 'tag') return checks([rawCheck('create', 'imagestreamtags', 'image.openshift.io', { namespace })]);
    if (base === 'import-image') return checks([rawCheck('create', 'imagestreams', 'image.openshift.io', { namespace })]);
    if (base === 'extract') {
      const ref = positionals.find((token) => token && (token.includes('/') || resourceInfoFromToken(token)));
      if (!ref) return exempt;
      const [token, sub] = ref.split('/');
      const info = resourceInfoFromToken(token);
      const resource = info?.kind === 'ConfigMap' ? 'configmaps' : 'secrets';
      return checks([rawCheck('get', resource, '', { name: sub || null, namespace })]);
    }
    if (base === 'adm') {
      const sub = String(positionals[0] || '').toLowerCase();
      if (!sub) return exempt;
      if (sub === 'policy') {
        const policySub = String(positionals[1] || '').toLowerCase();
        if (!policySub) return exempt;
        if (['who-can', 'scc-review', 'scc-subject-review'].includes(policySub)) return exempt;
        const remove = policySub.startsWith('remove');
        const verb = remove ? 'delete' : 'create';
        if (policySub.includes('scc')) {
          const saForm = Boolean(flags.z || flags.serviceaccount);
          const sccName = positionals[2] || '';
          if (saForm || String(positionals[3] || '').startsWith('system:serviceaccount:')) {
            const subjectNamespace = saForm ? namespace : String(positionals[3] || '').split(':')[2] || namespace;
            return checks([rawCheck(verb, 'rolebindings', 'rbac.authorization.k8s.io', {
              name: `system:openshift:scc:${sccName}`,
              namespace: subjectNamespace,
            })]);
          }
          return checks([rawCheck(verb, 'clusterrolebindings', 'rbac.authorization.k8s.io', {
            clusterScoped: true,
            name: `system:openshift:scc:${sccName}`,
          })]);
        }
        const clusterWide = policySub.includes('cluster-role');
        const resource = clusterWide ? 'clusterrolebindings' : 'rolebindings';
        return checks([rawCheck(verb, resource, 'rbac.authorization.k8s.io', {
          clusterScoped: clusterWide,
          namespace: clusterWide ? '' : namespace,
        })]);
      }
      if (sub === 'groups') {
        const groupsSub = String(positionals[1] || '').toLowerCase();
        if (['new', 'add-users', 'remove-users'].includes(groupsSub)) {
          const verb = groupsSub === 'new' ? 'create' : 'update';
          return checks([rawCheck(verb, 'groups', 'user.openshift.io', { clusterScoped: true })]);
        }
        return exempt;
      }
      if (['cordon', 'uncordon', 'drain', 'taint'].includes(sub)) {
        return checks([rawCheck('update', 'nodes', '', { clusterScoped: true, name: positionals[1] || null })]);
      }
      if (sub === 'top') {
        const target = String(positionals[1] || 'nodes').toLowerCase();
        if (target.startsWith('pod')) return checks([rawCheck('get', 'pods', '', { namespace })]);
        return checks([rawCheck('get', 'nodes', '', { clusterScoped: true })]);
      }
      if (['create-bootstrap-project-template', 'must-gather', 'inspect'].includes(sub)) return exempt;
      return exempt;
    }
    if (base === 'helm') {
      const sub = String(positionals[0] || '').toLowerCase();
      if (['install', 'upgrade'].includes(sub)) return checks([rawCheck('create', 'deployments', 'apps', { namespace })]);
      if (['uninstall', 'delete'].includes(sub)) return checks([rawCheck('delete', 'deployments', 'apps', { namespace })]);
      if (['rollback'].includes(sub)) return checks([rawCheck('patch', 'deployments', 'apps', { namespace })]);
      return exempt;
    }
    if (['quota', 'limitrange'].includes(base)) {
      const resource = base === 'quota' ? 'resourcequotas' : 'limitranges';
      return checks([rawCheck('create', resource, '', { namespace })]);
    }
    if (base === 'clusterquota') {
      return checks([rawCheck('create', 'clusterresourcequotas', 'quota.openshift.io', { clusterScoped: true })]);
    }
    if (base === 'user') return checks([rawCheck('create', 'users', 'user.openshift.io', { clusterScoped: true })]);
    if (base === 'group') return checks([rawCheck('create', 'groups', 'user.openshift.io', { clusterScoped: true })]);
    if (base === 'sa' || base === 'serviceaccount') {
      return checks([rawCheck('create', 'serviceaccounts', '', { namespace })]);
    }
    if (base === 'install') return checks([rawCheck('create', 'subscriptions', 'operators.coreos.com', { namespace })]);
    if (base === 'uninstall') return checks([rawCheck('delete', 'subscriptions', 'operators.coreos.com', { namespace })]);
    if (['cordon', 'uncordon', 'drain'].includes(base)) {
      return checks([rawCheck('update', 'nodes', '', { clusterScoped: true })]);
    }
    if (base === 'top') {
      const target = String(positionals[0] || 'nodes').toLowerCase();
      if (target.startsWith('pod')) return checks([rawCheck('get', 'pods', '', { namespace })]);
      return checks([rawCheck('get', 'nodes', '', { clusterScoped: true })]);
    }

    // Session / client-side commands and unknown commands: don't gate them
    // (the CLI reports type/usage errors itself).
    if (base === 'projects') return { exempt: true, requiresProjectFilter: true };
    if (AUTHORIZATION_EXEMPT_COMMANDS.has(base)) return exempt;
    if (ADM_EXEMPT_SUBCOMMANDS.has(base)) return exempt;
    if (base === 'auth' || base === 'config' || base === 'version' || base === 'api-resources') return exempt;
    return exempt;
  }

  /**
   * Evaluate a list of authorization checks in order; returns the first denial
   * (with a real `oc`-shaped message) or null when everything is allowed.
   * @param {Array<object>} checks
   * @param {{user: string, namespace: string}} context
   * @returns {object|null}
   */
  _evaluateAuthorizationChecks(checks, context) {
    const defaultNamespace = context.namespace || this.currentProject || 'default';
    for (const check of checks || []) {
      const namespace = check.clusterScoped ? '' : (check.namespace || defaultNamespace);
      const result = this.cluster.canI(context.user, check.verb, check.resource, namespace);
      if (result.allowed) {
        check.reason = result.reason;
        continue;
      }
      const forbidden = this._forbiddenMessage(check, context.user, namespace);
      return {
        allowed: false,
        reason: forbidden.reason,
        message: forbidden.message,
        verb: check.verb,
        resource: check.resource,
        name: check.name || null,
        namespace,
        apiGroup: check.apiGroup || '',
        user: context.user,
      };
    }
    return null;
  }

  /**
   * Build the real `oc` Forbidden message for a failed check:
   * `Error from server (Forbidden): pods is forbidden: User "carol" cannot list
   * resource "pods" in API group "" in the namespace "default"`.
   * @param {object} check
   * @param {string} user
   * @param {string} namespace
   * @returns {{reason: string, message: string}}
   */
  _forbiddenMessage(check, user, namespace) {
    const resource = check.resource;
    const apiGroup = check.apiGroup || '';
    const withName = check.name && ['get', 'patch', 'update', 'delete', 'watch'].includes(check.verb);
    const baseLabel = apiGroup ? `${resource}.${apiGroup}` : resource;
    const resourceLabel = withName ? `${baseLabel} "${check.name}"` : baseLabel;
    const scope = check.clusterScoped
      ? 'at the cluster scope'
      : `in the namespace "${namespace || 'default'}"`;
    const verb = check.verb === 'apply' ? 'patch' : check.verb;
    const reason = `${resourceLabel} is forbidden: User "${user}" cannot ${verb} resource "${resource}" in API group "${apiGroup}" ${scope}`;
    return { reason, message: `Error from server (Forbidden): ${reason}` };
  }

  /** @returns {object|null} current identity provider config (without session) */
  getAuthProvider() {
    return this.authProvider ? { ...this.authProvider } : null;
  }

  /**
   * Re-read the OAuth singleton and update the session-level auth provider
   * state (ready=false until the oauth rollout completes).
   * @param {{silent?: boolean}} [options]
   */
  _syncAuthProviderFromOAuth(options = {}) {
    const config = this.cluster.getAuthProviderConfig();
    if (!config) {
      const wasConfigured = !!this.authProvider;
      this.authProvider = null;
      if (wasConfigured && !options.silent) this.eventBus.emit('auth:provider-configuring', { provider: null });
      return null;
    }
    this.authProvider = { ...config, ready: false };
    if (!options.silent) this.eventBus.emit('auth:provider-configuring', { provider: { ...this.authProvider } });
    return this.authProvider;
  }

  /**
   * Configure OAuth identity providers (`oc edit oauth cluster` /
   * `oc apply -f oauth.yaml` equivalent).
   * @param {object[]} identityProviders
   * @returns {{success: boolean, oauth: object|null, message: string}}
   */
  configureOAuth(identityProviders) {
    const oauth = this.cluster.getOAuth();
    if (!oauth) return { success: false, oauth: null, message: 'Error from server (NotFound): oauth.config.openshift.io "cluster" not found' };
    oauth.spec = oauth.spec || {};
    oauth.spec.identityProviders = deepClone(identityProviders || []);
    this.cluster.update(oauth.uid, oauth);
    this._syncAuthProviderFromOAuth();
    return { success: true, oauth, message: 'oauth.config.openshift.io/cluster configured' };
  }

  /**
   * Convenience: configure an HTPasswd identity provider.
   * @param {{name?: string, secretName?: string}} [options]
   * @returns {{success: boolean, oauth: object|null, message: string}}
   */
  configureHTPasswdProvider(options = {}) {
    const name = options.name || 'htpasswd';
    const secretName = options.secretName || 'htpasswd-secret';
    return this.configureOAuth([
      {
        name,
        mappingMethod: options.mappingMethod || 'claim',
        type: 'HTPasswd',
        htpasswd: { fileData: { name: secretName } },
      },
    ]);
  }

  /** @returns {object|null} injected/browser ManifestEngine */
  _getManifestEngine() {
    if (this.manifestEngine) return this.manifestEngine;
    if (typeof window !== 'undefined') return window.game?.manifestEngine || null;
    return null;
  }

  /**
   * Inject the ManifestEngine (used by ManifestPanel/`window.game` or tests).
   * @param {object|null} manifestEngine
   */
  setManifestEngine(manifestEngine) {
    this.manifestEngine = manifestEngine;
    return manifestEngine;
  }

  /**
   * Name of the Secret the configured HTPasswd identity provider references
   * (`oauth.config.openshift.io/cluster` → `spec.identityProviders[].htpasswd.fileData.name`).
   * @returns {string}
   */
  _providerSecretName() {
    return this.authProvider?.secretName
      || this.authProvider?.htpasswd?.fileData?.name
      || this.authProvider?.htpasswd?.secret?.name
      || 'htpasswd-secret';
  }

  /**
   * Read the htpasswd user database from the Secret referenced by the
   * configured identity provider (issue #12).
   *
   * A real OpenShift 4.22 OAuth server reads `/htpasswd` FROM THE SECRET
   * (`data.htpasswd` in openshift-config) — editing the local htpasswd file
   * does NOT change login until the Secret is updated
   * (`oc extract` → `htpasswd` → `oc set data secret/... --from-file`).
   *
   * @param {string} [secretName] defaults to the IdP-referenced Secret
   * @returns {Array<{user: string, hash: string}>|null}
   */
  _getHtpasswdEntries(secretName) {
    const name = secretName || this._providerSecretName();
    const secret = this.cluster.getByName('Secret', name, 'openshift-config');
    if (!secret) return null;
    const data = secret.spec?.data || secret.data || {};
    const encoded = data.htpasswd;
    if (typeof encoded !== 'string' || !encoded) return null;
    const text = decodeBase64(encoded);
    if (!text || !text.trim()) return null;
    return GameEngine._parseHtpasswdFile(text);
  }

  /**
   * @param {string} text
   * @returns {Array<{user: string, hash: string}>}
   */
  static _parseHtpasswdFile(text) {
    return String(text)
      .split(/\r?\n/)
      .map((line) => GameEngine._parseHtpasswdLine(line))
      .filter(Boolean);
  }

  /**
   * @param {string} line
   * @returns {{user: string, hash: string}|null}
   */
  static _parseHtpasswdLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) return null;
    return { user: trimmed.slice(0, separator), hash: trimmed.slice(separator + 1) };
  }

  /**
   * Validate htpasswd credentials for a login attempt against the IdP Secret
   * (issue #12). The virtual root `htpasswd` file is never consulted: only the
   * Secret referenced by the configured identity provider authenticates users.
   * @param {string} username
   * @param {string} password
   * @returns {{ok: boolean, reason?: string}}
   */
  _verifyHtpasswdCredential(username, password) {
    if (password === undefined || password === null || password === '') {
      return { ok: false, reason: 'Verify you have provided the correct credentials.' };
    }
    const entries = this._getHtpasswdEntries();
    if (!entries || entries.length === 0) {
      return {
        ok: false,
        reason: `unable to read the "htpasswd" key from secret/${this._providerSecretName()} in project openshift-config`,
      };
    }
    const entry = entries.find((candidate) => candidate.user === username);
    if (!entry) return { ok: false, reason: 'Verify you have provided the correct credentials.' };
    // Handles the legacy simulator {SHA} placeholder, real {SHA}, simulated
    // bcrypt (-B) and plaintext entries (see verifyHtpasswdPasswordHash).
    if (!verifyHtpasswdPasswordHash(username, entry.hash, password)) {
      return { ok: false, reason: 'Verify you have provided the correct credentials.' };
    }
    return { ok: true };
  }

  /**
   * `htpasswd -B`-style hash for the CLI / Files engine.
   * `gameEngine.hashPasswordBcrypt('Passw0rd')` → `$2y$10$…` (fresh salt).
   * @param {string} password
   * @returns {string}
   */
  hashPasswordBcrypt(password) {
    return hashPasswordBcrypt(password);
  }

  /**
   * Verify a password against any htpasswd hash (see
   * {@link verifyHtpasswdPasswordHash}).
   * @param {string} user
   * @param {string} hash
   * @param {string} password
   * @returns {boolean}
   */
  verifyHtpasswdPasswordHash(user, hash, password) {
    return verifyHtpasswdPasswordHash(user, hash, password);
  }

  /**
   * Build the hash field for an htpasswd entry (`-B` → bcrypt, otherwise the
   * legacy simulator `{SHA}` placeholder).
   * @param {string} user
   * @param {string} password
   * @param {{bcrypt?: boolean, B?: boolean}} [options]
   * @returns {string}
   */
  hashHtpasswdEntry(user, password, options = {}) {
    return hashHtpasswdEntry(user, password, options);
  }

  /**
   * `oc login -u <user> -p <password>`.
   *
   * kubeadmin (and the simulator's built-in `admin` account) can always log in:
   * on a real cluster they authenticate with bootstrap kubeconfig credentials
   * rather than an identity provider. Any other user needs a ready HTPasswd
   * identity provider plus a matching entry in the virtual htpasswd file
   * (CONVERSION-SPEC §6).
   *
   * Failure messages mirror real `oc`:
   *  - wrong credentials / unknown user with a working IdP:
   *    `Login failed (401 Unauthorized)` + `Verify you have provided the correct
   *    credentials.` (openshift/oc prints this for a 401 from the OAuth server).
   *  - no identity provider configured: a configuration message naming the user
   *    instead of a misleading "HTPasswd … not configured" auth-error suffix.
   *
   * @param {string} username
   * @param {string} [password]
   * @returns {{success: boolean, message: string, user?: string, reason?: string}}
   */
  login(username, password) {
    const user = String(username || '').trim();
    if (!user) return { success: false, message: 'error: you must specify a username with -u' };

    if (user === 'kubeadmin' || user === 'system:admin' || user === 'admin') {
      this.currentUser = user === 'admin' ? 'admin' : 'kubeadmin';
      this._ensureUserResource(this.currentUser, null);
      this.ensureCurrentProject();
      this.eventBus.emit('login', { user: this.currentUser, provider: 'kubeadmin', project: this.currentProject });
      return { success: true, user: this.currentUser, message: "Login successful.\n\nYou have access to 0 projects, the server console URL for the cluster is https://console-openshift-console.apps.cluster.example.com." };
    }

    if (!this.authProvider) {
      // The cluster has an OAuth server but no configured identity provider:
      // report the configuration gap without pretending credentials were checked.
      return {
        success: false,
        reason: 'no-identity-provider',
        message: `Login failed (401 Unauthorized)\nThe user "${user}" is not known to the configured identity provider: no identity provider is configured on this cluster.`,
      };
    }
    if (!this.authProvider.ready) {
      return {
        success: false,
        reason: 'identity-provider-not-ready',
        message: 'Login failed (401 Unauthorized)\nThe HTPasswd identity provider is not ready yet: wait for the OAuth rollout to complete (oc get clusteroperators authentication) and try again.',
      };
    }

    // A real 4.22 cluster cannot authenticate when the IdP references a missing
    // (or malformed) htpasswd Secret in openshift-config: the authentication
    // operator degrades and oc login is rejected. Do not let an OAuth rollout
    // "ready" flag stand in for an actual Secret (GAME-011).
    const providerSecretName = this._providerSecretName();
    const providerSecret = this.cluster.getByName('Secret', providerSecretName, 'openshift-config');
    const providerSecretData = providerSecret?.spec?.data || providerSecret?.data || {};
    if (!providerSecret || !providerSecretData.htpasswd) {
      return {
        success: false,
        reason: 'identity-provider-secret-invalid',
        message:
          `Login failed (401 Unauthorized)\nThe HTPasswd identity provider is not ready: `
          + `Secret "${providerSecretName}" in project openshift-config is missing or has no "htpasswd" key.`,
      };
    }

    const verification = this._verifyHtpasswdCredential(user, password);
    if (!verification.ok) {
      return {
        success: false,
        reason: 'invalid-credentials',
        message: 'Login failed (401 Unauthorized)\nVerify you have provided the correct credentials.',
      };
    }

    const providerName = this.authProvider.name || 'htpasswd';
    const userResource = this.cluster.createUser(user, {
      identities: [{ providerName, providerUserName: user }],
    });
    this.cluster.createIdentity(providerName, user, userResource.metadata.name);
    this.currentUser = userResource.metadata.name;
    this.ensureCurrentProject();
    this.eventBus.emit('login', { user: this.currentUser, provider: providerName, project: this.currentProject });
    return { success: true, user: this.currentUser, message: 'Login successful.' };
  }

  /** Ensure a User resource exists for kubeadmin-style logins. */
  _ensureUserResource(username, provider) {
    if (!this.cluster.getUser(username)) this.cluster.createUser(username, { fullName: 'Cluster administrator' });
    if (provider) this.cluster.createIdentity(provider.name, username, username);
  }

  /**
   * `oc logout`.
   * @returns {{success: boolean, message: string}}
   */
  logout() {
    const previous = this.currentUser;
    this.currentUser = null;
    this.eventBus.emit('logout', { user: previous });
    return { success: true, message: `Logged "${previous || ''}" out` };
  }

  /**
   * `oc project <name>` — switch the active project.
   * @param {string} name
   * @returns {{success: boolean, project?: object, message: string}}
   */
  switchProject(name) {
    const project = this.cluster.getProject(name);
    if (!project) {
      return { success: false, message: `error: A project named "${name}" does not exist on the cluster.` };
    }
    if (project.status.phase === 'Terminating') {
      return { success: false, message: `error: project "${name}" is being terminated` };
    }
    const from = this.currentProject;
    this.currentProject = project.metadata.name;
    this.eventBus.emit('project:switched', { from, to: this.currentProject });
    return { success: true, project, message: `Now using project "${this.currentProject}" on server "https://api.cluster.example.com:6443".` };
  }

  /** @returns {object|null} the current Project resource */
  getCurrentProject() {
    return this.cluster.getProject(this.currentProject);
  }

  /** @returns {object[]} projects visible to the user (all projects in the simulator) */
  getProjects() {
    return this.cluster.getProjects();
  }

  /**
   * The `project.config.openshift.io/cluster` singleton.
   *
   * Feature-detected delegation to ClusterState (platform-owned). When the
   * platform bridge is absent we keep a local fallback singleton so declarative
   * `oc apply -f projectconfig.yaml` / `oc edit project.config.openshift.io/cluster`
   * still round-trip instead of being mistaken for a Project.
   *
   * @returns {object} the ProjectConfig-style object (`{apiVersion, kind, metadata, spec}`)
   */
  getProjectConfig() {
    const state = this.cluster;
    if (state && typeof state.getProjectConfig === 'function') {
      try {
        const delegated = state.getProjectConfig();
        if (delegated && typeof delegated === 'object') return delegated;
      } catch {
        /* fall through to local fallback */
      }
    }
    if (!this._projectConfigFallback) {
      // Real OCP shape: `apiVersion: config.openshift.io/v1, kind: Project,
      // metadata.name: cluster` (resource project.config.openshift.io/cluster).
      this._projectConfigFallback = {
        apiVersion: 'config.openshift.io/v1',
        kind: 'Project',
        metadata: { name: 'cluster' },
        spec: {},
      };
      try {
        if (!this.cluster.projectConfig) this.cluster.projectConfig = this._projectConfigFallback;
      } catch {
        /* ignore */
      }
    }
    return this._projectConfigFallback;
  }

  /**
   * Update `project.config.openshift.io/cluster` (Project template / requester
   * defaults). Delegates to ClusterState when the platform bridge exists.
   *
   * @param {object} specPatch partial ProjectConfig spec (merged)
   * @returns {{success: boolean, message: string, projectConfig?: object}}
   */
  updateProjectConfig(specPatch = {}) {
    const patch = specPatch && typeof specPatch === 'object' ? deepClone(specPatch) : {};
    const state = this.cluster;
    if (state && typeof state.updateProjectConfig === 'function') {
      try {
        const delegated = state.updateProjectConfig(patch);
        if (delegated && typeof delegated === 'object') {
          return {
            success: delegated.success !== false,
            message: delegated.message || 'project.config.openshift.io/cluster configured',
            projectConfig: delegated.projectConfig || delegated.resource || this.getProjectConfig(),
          };
        }
        return {
          success: true,
          message: 'project.config.openshift.io/cluster configured',
          projectConfig: this.getProjectConfig(),
        };
      } catch (error) {
        return { success: false, message: `error: ${error?.message || error}` };
      }
    }

    // Local fallback (platform bridge not available yet): merge the patch into
    // the in-memory singleton so get/set/apply round-trip consistently.
    const current = this.getProjectConfig();
    this._projectConfigFallback = {
      ...current,
      apiVersion: current.apiVersion || 'config.openshift.io/v1',
      kind: 'Project',
      metadata: { ...(current.metadata || {}), name: 'cluster' },
      spec: deepMerge({}, current.spec || {}, patch),
    };
    // Mirror the singleton on the cluster instance so UI/`oc get` read paths
    // that look at `cluster.projectConfig` see the same value.
    try {
      this.cluster.projectConfig = this._projectConfigFallback;
    } catch {
      /* read-only cluster wrappers */
    }
    try {
      this.eventBus.emit('projectconfig:updated', {
        spec: deepClone(this._projectConfigFallback.spec),
        resource: this._projectConfigFallback,
      });
    } catch {
      /* listeners must never break apply */
    }
    return {
      success: true,
      message: 'project.config.openshift.io/cluster configured',
      projectConfig: this._projectConfigFallback,
    };
  }

  /**
   * `oc new-project <name>` — create the Project resource, its default
   * service account and switch to it.
   * @param {string} name
   * @param {{displayName?: string, description?: string, labels?: object}} [options]
   * @returns {{success: boolean, project?: object, message: string}}
   */
  createProject(name, options = {}) {
    if (!this.currentUser) return { success: false, message: 'error: You must be logged in to the server (Unauthorized)' };
    // Server-side authorizer: `oc new-project` creates a ProjectRequest and is
    // governed by the `self-provisioners` ClusterRoleBinding (issue #3).
    if (!options.bypassAuthorization) {
      const authorization = this.authorizeCommand(`oc new-project ${name}`, { user: this.currentUser });
      if (!authorization.allowed) return { success: false, message: authorization.message };
    }
    // The requester is part of the real `oc new-project` flow: ClusterState
    // records it on the Project and (with a configured project template) grants
    // the requester project-admin and renders the template objects.
    const result = this.cluster.createProject(name, { ...options, requester: this.currentUser });
    if (!result.success) return result;
    this.switchProject(name);
    return { success: true, project: result.project, message: `Now using project "${name}" on server "https://api.cluster.example.com:6443".` };
  }

  /**
   * `oc delete project <name>`.
   * @param {string} name
   * @returns {{success: boolean, message: string}}
   */
  deleteProject(name) {
    if (!this.currentUser) return { success: false, message: 'error: You must be logged in to the server (Unauthorized)' };
    const authorization = this.authorizeCommand(`oc delete project ${name}`, { user: this.currentUser });
    if (!authorization.allowed) return { success: false, message: authorization.message };
    const result = this.cluster.deleteProject(name);
    if (!result.success) return result;
    if (this.currentProject === name) {
      this.currentProject = 'default';
      this.eventBus.emit('project:switched', { from: name, to: 'default', reason: 'deleted' });
    }
    return { success: true, message: result.message };
  }

  // ── Command history ────────────────────────────────────────────────────

  /**
   * Parse an oc-style command line (the upstream CLI alias is accepted too).
   * @param {string} raw
   * @returns {{raw: string, prefix: string, baseCommand: string, args: string[], tokens: string[]}}
   */
  static parseCommandLine(raw) {
    const original = String(raw || '').trim();
    let rest = original;
    let prefix = '';
    const match = rest.match(CLI_PREFIX_RE);
    if (match) {
      prefix = match[1].toLowerCase();
      rest = rest.slice(match[0].length);
    }
    const tokens = rest.split(/\s+/).filter(Boolean);
    return {
      raw: original,
      prefix,
      baseCommand: (tokens[0] || '').toLowerCase(),
      args: tokens.slice(1),
      tokens,
    };
  }

  /** Instance wrapper for {@link GameEngine.parseCommandLine}. */
  parseCommand(raw) {
    return GameEngine.parseCommandLine(raw);
  }

  /**
   * Record a command in the engine history (called by CommandBar).
   *
   * Emits `command:recorded` and an `auth:checked` event for mutating commands
   * so objectives/achievements can track authorization. `command:executed` is
   * emitted by the CommandBar itself (per the integration contract).
   *
   * @param {string} raw raw command line as typed
   * @param {boolean} [success]
   * @returns {{raw: string, baseCommand: string, args: string[], success: boolean, timestamp: number}}
   */
  recordCommand(raw, success = true) {
    const parsed = GameEngine.parseCommandLine(raw);
    const entry = {
      raw: parsed.raw,
      baseCommand: parsed.baseCommand,
      args: parsed.args,
      success: success !== false,
      timestamp: Date.now(),
    };
    this._commandHistory.push(entry);
    if (this._commandHistory.length > this._maxCommandHistory) this._commandHistory.shift();
    this.eventBus.emit('command:recorded', entry);

    const authorization = this._authorizationForCommand(entry);
    if (authorization) this.canI(authorization.verb, authorization.resource, authorization.namespace, this.currentUser);
    return entry;
  }

  /**
   * Work out the authorization check emitted for a recorded command.
   * @param {{baseCommand: string, args: string[]}} entry
   * @returns {{verb: string, resource: string, namespace?: string}|null}
   */
  _authorizationForCommand(entry) {
    if (!entry || !entry.baseCommand) return null;
    const base = entry.baseCommand;
    const args = entry.args || [];

    if (base === 'adm' && args[0] === 'policy') {
      const sub = args[1] || '';
      if (sub.includes('scc')) return { verb: 'use', resource: 'scc' };
      return { verb: sub.startsWith('remove') ? 'delete' : 'create', resource: 'rolebindings' };
    }
    if (base === 'auth') return null;

    const mapping = COMMAND_AUTHZ_MAP[base];
    if (!mapping) return { verb: 'get', resource: 'pods' };
    const resource = mapping.resource || args[mapping.argIndex] || 'pods';
    return { verb: mapping.verb, resource };
  }

  /**
   * @param {number} [limit]
   * @returns {Array<{raw: string, baseCommand: string, args: string[], success: boolean, timestamp: number}>}
   */
  getCommandHistory(limit) {
    if (limit) return this._commandHistory.slice(-limit);
    return [...this._commandHistory];
  }

  /**
   * Commands whose raw form matches a pattern (used by objective evaluation).
   * @param {string|RegExp} pattern
   * @param {{successOnly?: boolean}} [options]
   * @returns {Array<object>}
   */
  matchCommandHistory(pattern, options = {}) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
    return this._commandHistory.filter((entry) => {
      if (options.successOnly && !entry.success) return false;
      return regex.test(entry.raw);
    });
  }

  /** Clear the recorded command history. */
  clearCommandHistory() {
    this._commandHistory = [];
  }

  // ── Manifest apply / upsert (ManifestEngine integration) ────────────────

  /**
   * Normalise a manifest object into the game's resource shape.
   *
   * Accepts both real OpenShift YAML (fields such as `data:`, `rules:`,
   * `priority:` at the top level) and the game's `spec`-centric shape used by
   * the registry: stray top-level fields are folded into `spec`.
   *
   * @param {object} obj
   * @returns {{kind: string, apiVersion?: string, metadata: object, spec: object, status?: object}|null}
   */
  _normaliseManifestObject(obj) {
    if (!obj || typeof obj !== 'object' || !obj.kind) return null;
    if (obj.kind === 'List' && Array.isArray(obj.items)) return null; // handled by applyManifestObject
    const metadata = deepClone(obj.metadata || {});
    const spec = deepClone(obj.spec || {});
    const status = obj.status ? deepClone(obj.status) : undefined;
    const reserved = new Set(['apiVersion', 'kind', 'metadata', 'spec', 'status', 'items']);
    for (const [key, value] of Object.entries(obj)) {
      if (reserved.has(key)) continue;
      if (spec[key] === undefined) spec[key] = deepClone(value);
    }
    return {
      kind: obj.kind,
      apiVersion: obj.apiVersion,
      metadata,
      spec,
      status,
    };
  }

  /**
   * Apply a single manifest object (upsert by kind/name/namespace).
   *
   * This is the path used by `ManifestEngine.applyFile()`, `oc apply/create -f`
   * and `oc replace -f`. It honours the registry factory (rich resource class,
   * canonical apiVersion) but uses the manifest's spec verbatim instead of
   * merging palette defaults, so applied YAML round-trips cleanly.
   *
   * The returned resource exposes `resource._applyAction` = 'created'|'updated'
   * so callers can report which objects changed.
   *
   * @param {object} obj manifest object (`kind`, `metadata`, `spec`, ...)
   * @returns {import('../resources/ResourceBase.js').ResourceBase|null} the
   *   resource, or null on failure (see `this.lastApplyError`)
   */
  applyManifestObject(obj) {
    this.lastApplyError = null;
    if (!obj || typeof obj !== 'object') {
      this.lastApplyError = 'manifest object is not an object';
      return null;
    }
    if (obj.kind === 'List' && Array.isArray(obj.items)) {
      let last = null;
      for (const item of obj.items) {
        last = this.applyManifestObject(item);
        if (!last) return null;
      }
      return last;
    }

    // Bridge: `config.openshift.io/v1, kind: Project, metadata.name: cluster`
    // is the project.config.openshift.io/cluster singleton — NOT a Project.
    // Declarative tooling (ManifestEngine applyFile / `oc replace -f -`) reaches
    // this method with the apiVersion/kind preserved; configure project
    // provisioning (template / requester message) and never create a Project.
    if (
      obj.apiVersion === 'config.openshift.io/v1'
      && obj.kind === 'Project'
      && (obj.metadata?.name || obj.name) === 'cluster'
    ) {
      const spec = obj.spec && typeof obj.spec === 'object' ? deepClone(obj.spec) : {};
      const result = this.updateProjectConfig(spec);
      if (!result.success) {
        this.lastApplyError =
          result.message || 'error: unable to configure project.config.openshift.io/cluster';
        return null;
      }
      this.lastApplyError = null;
      const projectConfig = result.projectConfig && typeof result.projectConfig === 'object'
        ? result.projectConfig
        : this.getProjectConfig();
      try {
        this.eventBus.emit('resource:applied', {
          action: 'configured',
          kind: 'Project',
          apiVersion: 'config.openshift.io/v1',
          name: 'cluster',
          namespace: '',
          resource: projectConfig,
        });
      } catch {
        /* listeners must never break apply */
      }
      return projectConfig;
    }

    const normalised = this._normaliseManifestObject(obj);
    if (!normalised) {
      this.lastApplyError = `manifest object has no kind`;
      return null;
    }
    const kind = this.cluster._canonicalKind(normalised.kind);
    const metadata = normalised.metadata || {};
    const name = metadata.name || obj.name;
    if (!name) {
      this.lastApplyError = `${normalised.kind} manifest has no metadata.name`;
      return null;
    }

    const namespaced = !isClusterScopedKind(kind);
    const namespace = namespaced ? metadata.namespace || this.currentProject || 'default' : '';
    if (namespaced && namespace && !this.cluster.getProject(namespace)) {
      this.lastApplyError = `Error from server (NotFound): project.project.openshift.io "${namespace}" not found`;
      return null;
    }
    if (normalised.status) {
      // Never trust status from user manifests for apply.
      delete normalised.status;
    }

    const existing = this.cluster.getByName(kind, name, namespace);
    if (existing) {
      existing.spec = deepClone(normalised.spec || {});
      existing.metadata.labels = { ...existing.metadata.labels, ...(metadata.labels || {}) };
      existing.metadata.annotations = { ...existing.metadata.annotations, ...(metadata.annotations || {}) };
      existing.metadata.generation++;
      this.cluster.update(existing.uid, existing);
      existing._applyAction = 'updated';
      this._syncHtpasswdFileFromSecret(kind, existing);
      this.eventBus.emit('resource:applied', { action: 'updated', kind, name, namespace, resource: existing });
      return existing;
    }

    // Bare Pod creation goes through SCC admission like the real API server:
    // a pod that requests more than any SCC bound to its service account allows
    // is rejected with `pods "<name>" is forbidden`. Controllers creating pods
    // for Deployments/ReplicaSets go through SimulationTick admission instead.
    if (kind === 'Pod') {
      // Known root images (e.g. `nginx:latest`) count as requesting the UID they
      // actually run as; SCC admission itself only sees explicit pod requests.
      const admissionSpec = applyKnownImageSecurityProfiles(deepClone(normalised.spec || {}));
      const candidate = {
        metadata: { name, namespace },
        spec: admissionSpec,
      };
      const resolution = this.cluster.resolveSCCForPod(candidate);
      if (!resolution.allowed) {
        this.lastApplyError = `pods "${name}" is forbidden: unable to validate against any security context constraint`;
        return null;
      }
    }

    // Create through the registry factory. Passing the full manifest object
    // lets createResource()/ManifestSerializer normalise flat kinds (SCC,
    // Template, User, Group, Identity, ConfigMap, Secret, RBAC, StorageClass)
    // and instantiate the rich resource subclass.
    const factoryObject = {
      apiVersion: normalised.apiVersion || apiVersionForKind(kind),
      kind,
      metadata: {
        name,
        namespace,
        labels: metadata.labels || {},
        annotations: metadata.annotations || {},
      },
      spec: deepClone(normalised.spec || {}),
    };
    let resource;
    try {
      resource = createResource(kind, factoryObject);
    } catch (error) {
      console.warn(`GameEngine.applyManifestObject: registry create failed for ${kind}:`, error);
      resource = null;
    }
    if (!resource) {
      this.lastApplyError = `Error from server (BadRequest): unable to create ${kind} "${name}"`;
      return null;
    }
    // The manifest's spec wins over palette defaults: an applied object must
    // round-trip exactly (no sample data/selectors leaking in from the registry).
    resource.spec = deepClone(normalised.spec || {});
    const added = this.cluster.add(resource);
    added._applyAction = 'created';
    this._syncHtpasswdFileFromSecret(kind, added);
    this.eventBus.emit('resource:applied', { action: 'created', kind, name, namespace, resource: added });
    return added;
  }

  /**
   * A real cluster watches the HTPasswd Secret referenced by the OAuth CR and
   * reads the `htpasswd` key from it. The simulator's identity provider verifies
   * logins against the virtual `htpasswd` file, so mirror the Secret content into
   * that file whenever a manifest/CLI path creates or updates it
   * (`oc create secret … --from-file=htpasswd=…` / `oc set data …` / `oc apply -f`).
   * Also nudges the OAuth singleton so the normal 5s authentication rollout runs,
   * matching the operator's Secret watch.
   *
   * @param {string} kind
   * @param {object} resource
   */
  _syncHtpasswdFileFromSecret(kind, resource) {
    if (kind !== 'Secret' || !resource) return;
    if ((resource.metadata?.namespace || '') !== 'openshift-config') return;
    const data = resource.spec?.data || resource.data || {};
    const encoded = data.htpasswd;
    if (typeof encoded !== 'string' || !encoded) return;
    let text = '';
    try {
      text = globalThis.atob ? globalThis.atob(encoded) : '';
    } catch {
      return;
    }
    if (!text) return;
    const manifestEngine = this._getManifestEngine();
    if (manifestEngine && typeof manifestEngine.writeFile === 'function') {
      try {
        manifestEngine.writeFile('htpasswd', text.endsWith('\n') ? text : `${text}\n`);
      } catch {
        /* the virtual FS is optional (headless engine harnesses) */
      }
    }
    const oauth = this.cluster.getOAuth?.();
    if (oauth) {
      try {
        oauth._bumpResourceVersion?.();
        this.cluster.update(oauth.uid, oauth);
      } catch {
        /* rollout scheduling is best-effort */
      }
    }
  }

  /** @param {string} value @returns {boolean} */
  _isUuidLike(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  // ── Generic resource helpers ────────────────────────────────────────────

  /** @returns {object|null} */
  getResource(kind, name, namespace) {
    return this.cluster.getByName(kind, name, namespace || this.currentProject || 'default');
  }

  /**
   * Delete a resource by kind/name.
   * @returns {{success: boolean, message: string}}
   */
  deleteResource(kind, name, namespace) {
    const resource = this.getResource(kind, name, namespace);
    if (!resource) {
      return { success: false, message: `Error from server (NotFound): ${String(kind).toLowerCase()}s "${name}" not found` };
    }
    this.cluster.remove(resource.uid);
    return { success: true, message: `${String(kind).toLowerCase()} "${name}" deleted` };
  }

  /**
   * Scale a workload.
   * @returns {{success: boolean, message: string, oldReplicas?: number}}
   */
  scale(kind, name, replicas, options = {}) {
    const resource = this.getResource(kind, name, options.namespace);
    if (!resource) return { success: false, message: `${kind} "${name}" not found` };
    const oldReplicas = resource.spec.replicas ?? 1;
    resource.updateSpec({ replicas: Number(replicas) });
    this.eventBus.emit('resource:updated', { kind, name, namespace: resource.metadata.namespace, reason: 'scale' });
    return { success: true, oldReplicas, message: `${String(kind).toLowerCase()}.apps "${name}" scaled` };
  }

  /**
   * Set or remove labels.
   * @param {string} kind
   * @param {string} name
   * @param {Record<string,string|null>} labels value null removes the label
   * @param {{namespace?: string}} [options]
   */
  labelResource(kind, name, labels, options = {}) {
    const resource = this.getResource(kind, name, options.namespace);
    if (!resource) return { success: false, message: `${kind} "${name}" not found` };
    const removeLabels = [];
    const setLabels = {};
    for (const [key, value] of Object.entries(labels || {})) {
      if (value === null || value === undefined) removeLabels.push(key);
      else setLabels[key] = String(value);
    }
    this.cluster.updateMetadata(resource.uid, { labels: setLabels, removeLabels });
    return { success: true, message: `${String(kind).toLowerCase()}/${name} labeled`, resource };
  }

  /** Set or remove annotations. */
  annotateResource(kind, name, annotations, options = {}) {
    const resource = this.getResource(kind, name, options.namespace);
    if (!resource) return { success: false, message: `${kind} "${name}" not found` };
    const removeAnnotations = [];
    const setAnnotations = {};
    for (const [key, value] of Object.entries(annotations || {})) {
      if (value === null || value === undefined) removeAnnotations.push(key);
      else setAnnotations[key] = String(value);
    }
    this.cluster.updateMetadata(resource.uid, { annotations: setAnnotations, removeAnnotations });
    return { success: true, message: `${String(kind).toLowerCase()}/${name} annotated`, resource };
  }

  /**
   * Patch a resource (JSON merge patch or a list of JSON-patch operations).
   * @param {string} kind
   * @param {string} name
   * @param {object|object[]} patch
   * @param {{namespace?: string, type?: 'merge'|'json'|'strategic'}} [options]
   */
  patchResource(kind, name, patch, options = {}) {
    const canonicalKind = this.cluster._canonicalKind(kind) || kind;
    const resource = this.getResource(kind, name, options.namespace);
    if (!resource) {
      return { success: false, message: `Error from server (NotFound): ${String(kind).toLowerCase()}s "${name}" not found` };
    }
    const resolvedType = resolvePatchType(options, canonicalKind, (token) => this.cluster._canonicalKind(token));
    if (resolvedType.error) return { success: false, message: resolvedType.error };
    const patchType = resolvedType.type;

    // Patch a plain-JSON snapshot, validate, then commit — a rejected patch
    // must never mutate the live resource (API server semantics).
    const candidate = {
      apiVersion: resource.apiVersion,
      kind: resource.kind || canonicalKind,
      metadata: deepClone(resource.metadata || {}),
      spec: deepClone(resource.spec || {}),
      status: deepClone(resource.status || {}),
    };
    let patched = candidate;
    if (patchType === 'json' || Array.isArray(patch)) {
      const result = applyJsonPatch(candidate, patch);
      if (!result.ok) {
        return {
          success: false,
          message: `Error from server (BadRequest): ${result.error || 'invalid json patch'}`,
        };
      }
      patched = result.result;
    } else if (patchType === 'merge') {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { success: false, message: 'Error from server (BadRequest): patch must be a JSON object' };
      }
      patched = jsonMergePatch(candidate, patch);
    } else {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { success: false, message: 'Error from server (BadRequest): patch must be a JSON object' };
      }
      patched = strategicMergePatch(candidate, patch);
    }
    patched = patched && typeof patched === 'object' ? patched : candidate;

    // Reject patches that would leave a container without an image (issue #6):
    // the API server would reject the workload and the simulator must never run
    // an image-less container.
    const validationMessage = invalidWorkloadMessage(patched);
    if (validationMessage) return { success: false, message: validationMessage };

    resource.metadata.labels = patched.metadata?.labels || {};
    resource.metadata.annotations = patched.metadata?.annotations || {};
    if (patched.metadata?.finalizers) resource.metadata.finalizers = patched.metadata.finalizers;
    if (patched.spec !== undefined) resource.spec = patched.spec;
    if (patched.status !== undefined) resource.status = patched.status;
    resource.metadata.generation = (resource.metadata.generation || 1) + 1;
    this.cluster.update(resource.uid, resource);
    this.eventBus.emit('resource:updated', { kind: canonicalKind, name, namespace: resource.metadata.namespace, reason: 'patch' });
    return { success: true, message: `${String(canonicalKind).toLowerCase()}.apps "${name}" patched`, resource, type: patchType };
  }

  /**
   * API-server style workload validation shared with runtime admission: every
   * container in the pod template needs a name and an image.
   * @param {string} kind canonical kind (Pod/Deployment/StatefulSet/…)
   * @param {{metadata?: object, spec?: object}} resourceOrSpec resource or plain pod-template object
   * @returns {{valid: boolean, message: string|null}} message is the real
   *   `Error from server (Invalid): …` line when invalid
   */
  validateWorkload(kind, resourceOrSpec = {}) {
    const canonical = this.cluster._canonicalKind(kind) || kind;
    const payload = resourceOrSpec && typeof resourceOrSpec === 'object'
      ? { kind: canonical, metadata: resourceOrSpec.metadata || {}, spec: resourceOrSpec.spec || {} }
      : { kind: canonical, metadata: {}, spec: {} };
    const message = invalidWorkloadMessage(payload);
    return { valid: !message, message };
  }

  /** Apply a single RFC-6902 JSON-patch operation to a resource. */
  _applyJsonPatchOperation(resource, operation) {
    if (!operation || !operation.op || !operation.path) return;
    const path = String(operation.path).replace(/^\//, '').split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target = resource;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (target[key] === undefined) target[key] = {};
      target = target[key];
    }
    const lastKey = path[path.length - 1];
    switch (operation.op) {
      case 'add':
      case 'replace':
        target[lastKey] = deepClone(operation.value);
        break;
      case 'remove':
        if (Array.isArray(target)) target.splice(Number(lastKey), 1);
        else delete target[lastKey];
        break;
      case 'copy':
        break;
      default:
        break;
    }
  }

  // ── new-app / new-build / expose / routes ──────────────────────────────

  /**
   * Derive an application name from an image or git URL.
   * @param {string} source
   * @returns {string}
   */
  _appNameFor(source) {
    const raw = String(source || '').split('|')[0].trim();
    const withoutQuery = raw.split('?')[0];
    const segments = withoutQuery.replace(/\/+$/, '').split('/').filter(Boolean);
    let name = segments[segments.length - 1] || 'app';
    name = name.replace(/\.git$/, '');
    if (name.includes(':')) name = name.split(':')[0];
    if (name.includes('@')) name = name.split('@')[0];
    // Repositories often look like "nodejs-ex"; strip generic prefixes.
    name = name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().replace(/^-+|-+$/g, '');
    return name || 'app';
  }

  /**
   * Parse a workload's `image.openshift.io/triggers` annotation into the
   * canonical trigger entry list (real OpenShift annotation model).
   * @param {object} resource
   * @returns {object[]}
   */
  _parseImageTriggerAnnotation(resource) {
    const raw = resource?.metadata?.annotations?.[IMAGE_TRIGGER_ANNOTATION];
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((entry) => entry && entry.from) : [];
    } catch {
      return [];
    }
  }

  /**
   * Convert ImageChange trigger descriptors (spec-style) into
   * `image.openshift.io/triggers` annotation entries for a workload.
   * @param {object[]} triggers
   * @param {string[]} containerNames container names in pod-template order
   * @returns {object[]}
   */
  _imageTriggerAnnotationEntries(triggers, containerNames = ['main']) {
    const entries = [];
    for (const trigger of Array.isArray(triggers) ? triggers : []) {
      if (!trigger || trigger.type !== 'ImageChange') continue;
      const params = trigger.imageChangeParams || trigger.imageChange || {};
      const from = params.from || trigger.from || null;
      if (!from || !from.name) continue;
      const targets = Array.isArray(params.containerNames) && params.containerNames.length > 0
        ? params.containerNames
        : containerNames;
      for (const containerName of targets) {
        const index = Math.max(0, containerNames.indexOf(containerName));
        entries.push({
          from: {
            kind: from.kind || 'ImageStreamTag',
            name: from.name,
            ...(from.namespace ? { namespace: from.namespace } : {}),
          },
          fieldPath: `spec.template.spec.containers[${index}].image`,
        });
      }
    }
    return entries;
  }

  /**
   * Image-change triggers for a workload/BuildConfig: BuildConfigs keep
   * `spec.triggers`; workloads expose the `image.openshift.io/triggers`
   * annotation (platform model).
   * @param {string} kind
   * @param {string} name
   * @param {{namespace?: string}} [options]
   * @returns {object[]}
   */
  getImageTriggers(kind, name, options = {}) {
    const canonical = this.cluster._canonicalKind(kind);
    const resource = this.getResource(canonical, name, options.namespace);
    if (!resource) return [];
    if (canonical === 'BuildConfig') return [...(resource.spec?.triggers || [])];
    const fromAnnotation = this._parseImageTriggerAnnotation(resource);
    // Backwards compatibility for resources created before the annotation model.
    if (fromAnnotation.length > 0) return fromAnnotation;
    return [...(resource.spec?.triggers || [])].map((trigger) => ({
      type: trigger.type,
      imageChangeParams: trigger.imageChangeParams || trigger.imageChange,
    }));
  }

  /**
   * @param {object} options
   * @param {string} options.name
   * @param {string} options.namespace
   * @param {string} options.image
   * @param {number} [options.replicas]
   * @param {object} [options.env]
   * @param {number} [options.containerPort]
   * @param {string[]} [options.containerNames]
   * @returns {object}
   */
  _buildDeploymentObject(options) {
    const name = options.name;
    const replicas = options.replicas ?? 1;
    const containerPort = options.containerPort || 8080;
    const env = Object.entries(options.env || {}).map(([envName, value]) => ({ name: envName, value: String(value) }));
    const container = {
      name: 'main',
      image: options.image,
      ports: [{ containerPort, protocol: 'TCP' }],
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
    };
    if (env.length > 0) container.env = env;
    const labels = { app: name, 'app.kubernetes.io/name': name };
    const deploymentSpec = {
      replicas,
      selector: { matchLabels: { app: name } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } },
      template: {
        metadata: { labels },
        spec: { containers: [container] },
      },
    };
    if (options.serviceAccountName) deploymentSpec.template.spec.serviceAccountName = options.serviceAccountName;
    const imageTriggerEntries = this._imageTriggerAnnotationEntries(options.triggers, [container.name]);
    const metadata = { name, namespace: options.namespace, labels };
    if (imageTriggerEntries.length > 0) {
      // apps/v1 Deployments have no spec.triggers: image triggers live in the
      // image.openshift.io/triggers annotation (OCP 4.x).
      metadata.annotations = { [IMAGE_TRIGGER_ANNOTATION]: JSON.stringify(imageTriggerEntries) };
    }
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata,
      spec: deploymentSpec,
    };
  }

  /**
   * @param {object} options
   * @returns {object}
   */
  _buildServiceObject(options) {
    const name = options.name;
    const port = options.port || options.containerPort || 8080;
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: options.namespace, labels: { app: name } },
      spec: {
        selector: { app: name },
        ports: [{ name: 'http', port, targetPort: options.containerPort || port, protocol: 'TCP' }],
        type: options.type || 'ClusterIP',
      },
    };
  }

  /**
   * `oc new-app` — create an application from an image, ImageStream, git source
   * or template.
   *
   * @param {{image?: string, imageStream?: string, code?: string, git?: string, template?: string, name?: string, namespace?: string, replicas?: number, env?: object, containerPort?: number, port?: number, buildEnv?: object, contextDir?: string}} options
   * @returns {{success: boolean, resources?: object[], message: string}}
   */
  newApp(options = {}) {
    const namespace = options.namespace || this.currentProject || 'default';
    if (!this.cluster.getProject(namespace)) {
      return { success: false, message: `error: project "${namespace}" not found` };
    }
    if (options.template) return this._newAppFromTemplate(options);
    if (options.code || options.git) return this._newAppFromSource(options);
    if (options.imageStream) return this._newAppFromImageStream(options);
    if (options.image) return this._newAppFromImage(options);
    return { success: false, message: 'error: no image, source or template specified for oc new-app' };
  }

  /** @param {object} options */
  _newAppFromImage(options) {
    const namespace = options.namespace || this.currentProject;
    const name = options.name || this._appNameFor(options.image);
    const resources = [];
    const deployment = this.applyManifestObject(this._buildDeploymentObject({ ...options, name, namespace, containerPort: options.port || options.containerPort || 8080 }));
    if (!deployment) return { success: false, message: this.lastApplyError || 'failed to create deployment' };
    resources.push(deployment);
    const service = this.applyManifestObject(this._buildServiceObject({ ...options, name, namespace }));
    if (service) resources.push(service);
    this.eventBus.emit('app:created', { name, namespace, resources, source: 'image' });
    return { success: true, resources, message: `Deployment "${name}" created; Service "${name}" created` };
  }

  /** @param {object} options */
  _newAppFromImageStream(options) {
    const namespace = options.namespace || this.currentProject;
    const streamSpec = String(options.imageStream);
    const streamName = streamSpec.includes(':') ? streamSpec.split(':')[0] : streamSpec;
    const tag = streamSpec.includes(':') ? streamSpec.split(':')[1] : 'latest';
    const name = options.name || this._appNameFor(streamName);
    const image = `${IMAGE_REGISTRY_HOST}/${options.imageStreamNamespace || 'openshift'}/${streamName}:${tag}`;
    return this._newAppFromImage({ ...options, name, namespace, image });
  }

  /** @param {object} options */
  _newAppFromSource(options) {
    const namespace = options.namespace || this.currentProject;
    const source = options.code || options.git;
    const name = options.name || this._appNameFor(source === '.' ? 'app' : source);
    const resources = [];
    const imageStreamObject = {
      apiVersion: 'image.openshift.io/v1',
      kind: 'ImageStream',
      metadata: { name, namespace, labels: { app: name } },
      spec: { lookupPolicy: { local: false }, tags: [] },
    };
    const imageStream = this.applyManifestObject(imageStreamObject);
    if (imageStream) resources.push(imageStream);

    const builderImage = options.builderImage || 'nodejs:20-ubi9';
    const buildConfigObject = {
      apiVersion: 'build.openshift.io/v1',
      kind: 'BuildConfig',
      metadata: { name, namespace, labels: { app: name } },
      spec: {
        source: {
          type: 'Git',
          git: { uri: String(source), ref: options.ref || 'main' },
          contextDir: options.contextDir || '',
        },
        strategy: {
          type: 'Source',
          sourceStrategy: {
            from: { kind: 'ImageStreamTag', name: builderImage, namespace: 'openshift' },
          },
        },
        output: { to: { kind: 'ImageStreamTag', name: `${name}:latest` } },
        triggers: [{ type: 'ConfigChange' }, { type: 'ImageChange' }],
        runPolicy: 'Serial',
      },
    };
    if (options.buildEnv) {
      buildConfigObject.spec.strategy.sourceStrategy.env = Object.entries(options.buildEnv).map(([envName, value]) => ({ name: envName, value: String(value) }));
    }
    const buildConfig = this.applyManifestObject(buildConfigObject);
    if (buildConfig) resources.push(buildConfig);

    const deployment = this.applyManifestObject(this._buildDeploymentObject({
      ...options,
      name,
      namespace,
      image: `${IMAGE_REGISTRY_HOST}/${namespace}/${name}:latest`,
      triggers: [{
        type: 'ImageChange',
        imageChangeParams: {
          automatic: true,
          containerNames: ['main'],
          from: { kind: 'ImageStreamTag', name: `${name}:latest` },
        },
      }],
    }));
    if (deployment) resources.push(deployment);
    const service = this.applyManifestObject(this._buildServiceObject({ ...options, name, namespace }));
    if (service) resources.push(service);

    const buildResult = this.startBuild(name, { namespace });
    this.eventBus.emit('app:created', { name, namespace, resources, source: 'git' });
    if (!buildResult.success) {
      return { success: true, resources, message: `Deployment "${name}" created; ${buildResult.message}` };
    }
    return { success: true, resources, message: `Deployment "${name}" created; Build "${buildResult.build?.metadata?.name}" started` };
  }

  /** @param {object} options */
  _newAppFromTemplate(options) {
    const namespace = options.namespace || this.currentProject;
    const template = options.template;
    const result = this.processTemplate(template, options.params || options.parameters || {}, {
      namespace,
      namespaceCandidates: [namespace, 'openshift', 'openshift-config'],
      apply: true,
    });
    if (!result.success) return result;
    this.eventBus.emit('app:created', { name: options.name || template, namespace, resources: result.resources, source: 'template' });
    return { success: true, resources: result.resources, objects: result.objects, message: `Template "${template}" processed` };
  }

  /**
   * `oc new-build` — create a BuildConfig from an ImageStream or source.
   * @param {{name?: string, imageStream?: string, code?: string, namespace?: string, dockerfile?: string}} options
   * @returns {{success: boolean, buildConfig?: object, message: string}}
   */
  newBuild(options = {}) {
    const namespace = options.namespace || this.currentProject;
    const name = options.name || this._appNameFor(options.code || options.imageStream || 'build');
    const strategy = options.dockerfile
      ? { type: 'Docker', dockerStrategy: { dockerfilePath: 'Dockerfile' } }
      : { type: 'Source', sourceStrategy: { from: { kind: 'ImageStreamTag', name: options.imageStream || 'nodejs:20-ubi9', namespace: 'openshift' } } };
    const buildConfig = this.applyManifestObject({
      apiVersion: 'build.openshift.io/v1',
      kind: 'BuildConfig',
      metadata: { name, namespace, labels: { app: name } },
      spec: {
        source: options.code
          ? { type: 'Git', git: { uri: String(options.code), ref: 'main' } }
          : { type: 'Binary' },
        strategy,
        output: { to: { kind: 'ImageStreamTag', name: `${name}:latest` } },
        triggers: [{ type: 'ConfigChange' }],
        runPolicy: 'Serial',
      },
    });
    if (!buildConfig) return { success: false, message: this.lastApplyError || `failed to create BuildConfig ${name}` };
    return { success: true, buildConfig, message: `BuildConfig "${name}" created` };
  }

  /**
   * `oc start-build <bc>` (or `--from-dir`) — create a Build resource that the
   * build controller then progresses through New → Pending → Running → Complete.
   *
   * @param {string} buildConfigName
   * @param {{namespace?: string, follow?: boolean, fromDir?: string}} [options]
   * @returns {{success: boolean, build?: object, message: string}}
   */
  startBuild(buildConfigName, options = {}) {
    const namespace = options.namespace || this.currentProject || 'default';
    const buildConfig = this.cluster.getBuildConfig(namespace, buildConfigName);
    if (!buildConfig) {
      return { success: false, message: `Error from server (NotFound): buildconfigs.build.openshift.io "${buildConfigName}" not found` };
    }
    const result = this.cluster.startBuildFor(buildConfig, { actor: this.currentUser || 'kubeadmin', reason: 'Manual' });
    if (!result.success) return result;
    return { success: true, build: result.build, message: `build.build.openshift.io/${result.build.metadata.name} started` };
  }

  /**
   * `oc cancel-build <build|bc>`.
   * @param {string} name build name or BuildConfig name
   * @param {{namespace?: string}} [options]
   * @returns {{success: boolean, build?: object, message: string}}
   */
  cancelBuild(name, options = {}) {
    const namespace = options.namespace || this.currentProject || 'default';
    let build = this.cluster.getByName('Build', name, namespace);
    if (!build) {
      const buildConfig = this.cluster.getBuildConfig(namespace, name);
      if (buildConfig) build = this.cluster.getActiveBuildFor(buildConfig);
    }
    if (!build) return { success: false, message: `Error from server (NotFound): builds.build.openshift.io "${name}" not found` };
    build.setPhase('Cancelled');
    build.status.completionTime = new Date().toISOString();
    build.status.message = 'Build cancelled by user';
    this.cluster.update(build.uid, build);
    this.eventBus.emit('build:cancelled', { build: build.metadata.name, namespace, resource: build });
    return { success: true, build, message: `build.build.openshift.io/${build.metadata.name} cancelled` };
  }

  /**
   * `oc expose svc/<name>` — create a plain HTTP Route for a Service.
   * @param {string} serviceName
   * @param {{namespace?: string, name?: string, hostname?: string, path?: string, port?: string|number}} [options]
   * @returns {{success: boolean, route?: object, message: string}}
   */
  exposeService(serviceName, options = {}) {
    const namespace = options.namespace || this.currentProject || 'default';
    const service = this.cluster.getByName('Service', serviceName, namespace);
    if (!service) {
      return { success: false, message: `Error from server (NotFound): services "${serviceName}" not found` };
    }
    const routeName = options.name || service.metadata.name;
    const host = options.hostname || options.host || '';
    return this.createRoute({
      name: routeName,
      namespace,
      service: service.metadata.name,
      host,
      path: options.path || '/',
      port: options.port ?? service.spec.ports?.[0]?.name ?? service.spec.ports?.[0]?.port,
      targetPort: options.targetPort,
      wildcardPolicy: options.wildcardPolicy,
    });
  }

  /**
   * `oc create route edge|passthrough|reencrypt <name> --service=<svc>`.
   * @param {object} options
   * @returns {{success: boolean, route?: object, message: string}}
   */
  createRoute(options = {}) {
    const namespace = options.namespace || this.currentProject || 'default';
    if (!this.cluster.getProject(namespace)) {
      return { success: false, message: `Error from server (NotFound): project.project.openshift.io "${namespace}" not found` };
    }
    const service = this.cluster.getByName('Service', options.service, namespace);
    if (!service) {
      return { success: false, message: `Error from server (NotFound): services "${options.service}" not found` };
    }
    const name = options.name || options.service;
    if (this.cluster.getByName('Route', name, namespace)) {
      return { success: false, message: `Error from server (AlreadyExists): routes.route.openshift.io "${name}" already exists` };
    }
    const port = options.targetPort || options.port || service.spec.ports?.[0]?.name || service.spec.ports?.[0]?.port;
    const routeSpec = {
      host: options.host || '',
      path: options.path || '/',
      to: { kind: 'Service', name: options.service, weight: 100 },
      port: { targetPort: port ?? 'http' },
      wildcardPolicy: options.wildcardPolicy || 'None',
    };
    if (options.tls || options.termination) {
      const termination = options.termination || options.tls?.termination || 'edge';
      routeSpec.tls = {
        termination,
        insecureEdgeTerminationPolicy: options.insecureEdgeTerminationPolicy || options.tls?.insecureEdgeTerminationPolicy || 'None',
      };
      if (termination !== 'passthrough') {
        if (options.certificate || options.tls?.certificate) routeSpec.tls.certificate = options.certificate || options.tls.certificate;
        if (options.key || options.tls?.key) routeSpec.tls.key = options.key || options.tls.key;
        if (options.caCertificate || options.tls?.caCertificate) routeSpec.tls.caCertificate = options.caCertificate || options.tls.caCertificate;
      }
    }
    const route = this.applyManifestObject({
      apiVersion: 'route.openshift.io/v1',
      kind: 'Route',
      metadata: { name, namespace, labels: { app: options.service } },
      spec: routeSpec,
    });
    if (!route) return { success: false, message: this.lastApplyError || 'failed to create route' };
    return { success: true, route, message: `route.route.openshift.io/${name} exposed` };
  }

  // ── oc set ... ──────────────────────────────────────────────────────────

  /**
   * Resolve a workload resource for `oc set ...`.
   * @returns {{success: boolean, resource?: object, message?: string}}
   */
  _getWorkload(kind, name, namespace) {
    const resource = this.getResource(kind, name, namespace);
    if (!resource) {
      return { success: false, message: `Error from server (NotFound): ${String(kind).toLowerCase()}s "${name}" not found` };
    }
    if (!resource.spec?.template) {
      return { success: false, message: `error: ${String(kind).toLowerCase()}/${name} has no pod template` };
    }
    return { success: true, resource };
  }

  /** Apply a mutation to a container template and persist it. */
  _updateTemplate(resource, mutator) {
    const template = resource.spec.template || {};
    template.spec = template.spec || {};
    template.spec.containers = template.spec.containers || [{ name: 'main', image: 'app:latest' }];
    mutator(template.spec, template);
    resource.spec.template = template;
    resource.metadata.generation++;
    this.cluster.update(resource.uid, resource);
    this.eventBus.emit('resource:updated', { kind: resource.kind, name: resource.metadata.name, namespace: resource.metadata.namespace, reason: 'set' });
    return resource;
  }

  /**
   * `oc set env <kind>/<name> KEY=VALUE [--from=configmap/x] [--remove=KEY] [--list]`.
   * @param {string} kind deployment/statefulset/daemonset/buildconfig
   * @param {string} name
   * @param {{namespace?: string, env?: object, from?: {kind: string, name: string}|string, remove?: string[], list?: boolean, container?: string, prefix?: string}} [options]
   * @returns {{success: boolean, message: string, env?: object[], resource?: object}}
   */
  setEnv(kind, name, options = {}) {
    const normalizedKind = this.cluster._canonicalKind(kind);
    const namespace = options.namespace || this.currentProject || 'default';

    if (normalizedKind === 'BuildConfig') {
      const buildConfig = this.cluster.getByName('BuildConfig', name, namespace);
      if (!buildConfig) return { success: false, message: `Error from server (NotFound): buildconfigs.build.openshift.io "${name}" not found` };
      const strategy = buildConfig.spec.strategy || {};
      const containerStrategy = strategy.sourceStrategy || strategy.dockerStrategy || strategy.customStrategy || (strategy.sourceStrategy = {});
      containerStrategy.env = containerStrategy.env || [];
      this._mergeEnvArray(containerStrategy.env, options);
      this.cluster.update(buildConfig.uid, buildConfig);
      return { success: true, message: `buildconfig.apps "${name}" updated`, resource: buildConfig };
    }

    const workload = this._getWorkload(normalizedKind, name, namespace);
    if (!workload.success) return { success: false, message: workload.message };
    const resource = workload.resource;
    let resultingEnv = [];

    if (options.list) {
      const container = this._findContainer(resource, options.container);
      resultingEnv = container?.env || [];
      return { success: true, message: 'environment variables listed', env: resultingEnv, resource };
    }

    this._updateTemplate(resource, (podSpec) => {
      const containers = options.container ? podSpec.containers.filter((container) => container.name === options.container) : podSpec.containers;
      for (const container of containers) {
        container.env = container.env || [];
        this._mergeEnvArray(container.env, options);
        resultingEnv = container.env;
        if (options.from) {
          const from = typeof options.from === 'string'
            ? { kind: options.from.startsWith('secret') ? 'Secret' : 'ConfigMap', name: options.from.split('/')[1] || options.from }
            : options.from;
          container.envFrom = container.envFrom || [];
          const ref = from.kind === 'Secret' ? { secretRef: { name: from.name } } : { configMapRef: { name: from.name } };
          if (options.prefix) ref.prefix = options.prefix;
          if (!container.envFrom.some((entry) => JSON.stringify(entry) === JSON.stringify(ref))) container.envFrom.push(ref);
        }
      }
    });
    // Changing the template should roll the workload.
    resource._rollout = { reason: 'set env', startedAt: Date.now(), remaining: null };
    return { success: true, message: `${String(normalizedKind).toLowerCase()}.apps "${name}" updated`, resource, env: resultingEnv };
  }

  /** Merge KEY=VALUE and --remove entries into a container env array. */
  _mergeEnvArray(envArray, options) {
    const entries = Array.isArray(options.env)
      ? options.env
      : Object.entries(options.env || {}).map(([envName, value]) => ({ name: envName, value: String(value) }));
    for (const entry of entries) {
      const existing = envArray.find((item) => item.name === entry.name);
      if (existing) Object.assign(existing, entry);
      else envArray.push(entry);
    }
    for (const removeName of options.remove || []) {
      const index = envArray.findIndex((item) => item.name === removeName);
      if (index >= 0) envArray.splice(index, 1);
    }
  }

  /** Find the first (or named) container in a workload. */
  _findContainer(resource, containerName) {
    const containers = resource.spec?.template?.spec?.containers || [];
    if (!containerName) return containers[0] || null;
    return containers.find((container) => container.name === containerName) || null;
  }

  /**
   * `oc set image <kind>/<name> <container>=<image>`.
   * @returns {{success: boolean, message: string, resource?: object}}
   */
  setImage(kind, name, imageOrOptions, options = {}) {
    let containerName = options.container;
    let image = options.image;
    if (typeof imageOrOptions === 'string') {
      if (imageOrOptions.includes('=')) {
        const [left, right] = imageOrOptions.split('=');
        containerName = containerName || left;
        image = right;
      } else {
        image = imageOrOptions;
      }
    } else if (imageOrOptions && typeof imageOrOptions === 'object') {
      options = { ...options, ...imageOrOptions };
      containerName = options.container;
      image = options.image;
    }
    const workload = this._getWorkload(kind, name, options.namespace);
    if (!workload.success) return { success: false, message: workload.message };
    if (!image) return { success: false, message: 'error: you must specify an image' };
    const resource = workload.resource;

    this._recordRevision(resource, `updating image to ${image}`);
    this._updateTemplate(resource, (podSpec) => {
      const containers = containerName ? podSpec.containers.filter((container) => container.name === containerName) : podSpec.containers;
      if (containerName && containers.length === 0) {
        podSpec.containers.push({ name: containerName, image });
      }
      for (const container of containers.length > 0 ? containers : podSpec.containers) container.image = image;
    });
    resource._rollout = { reason: 'image change', startedAt: Date.now(), remaining: null };
    return { success: true, message: `${String(kind).toLowerCase()}.apps "${name}" image updated`, resource };
  }

  /**
   * `oc set resources <kind>/<name> --limits=... --requests=...`.
   * @returns {{success: boolean, message: string, resource?: object}}
   */
  setResources(kind, name, options = {}) {
    const workload = this._getWorkload(kind, name, options.namespace);
    if (!workload.success) return { success: false, message: workload.message };
    const resource = workload.resource;
    this._updateTemplate(resource, (podSpec) => {
      const containers = options.container ? podSpec.containers.filter((container) => container.name === options.container) : podSpec.containers;
      for (const container of containers) {
        container.resources = container.resources || {};
        if (options.limits) container.resources.limits = { ...(container.resources.limits || {}), ...options.limits };
        if (options.requests) container.resources.requests = { ...(container.resources.requests || {}), ...options.requests };
      }
    });
    resource._rollout = { reason: 'resource change', startedAt: Date.now(), remaining: null };
    return { success: true, message: `${String(kind).toLowerCase()}.apps "${name}" resource requirements updated`, resource };
  }

  /**
   * `oc set probe <kind>/<name> --liveness|--readiness --get-url=... | --remove`.
   * @param {{namespace?: string, probe?: 'liveness'|'readiness'|'startup', getUrl?: string, httpGet?: object, remove?: boolean, container?: string}} [options]
   */
  setProbe(kind, name, options = {}) {
    const probeType = options.probe || 'liveness';
    const probeKey = `${probeType}Probe`;
    const workload = this._getWorkload(kind, name, options.namespace);
    if (!workload.success) return { success: false, message: workload.message };
    const resource = workload.resource;

    this._updateTemplate(resource, (podSpec) => {
      const containers = options.container ? podSpec.containers.filter((container) => container.name === options.container) : podSpec.containers;
      for (const container of containers) {
        if (options.remove) {
          delete container[probeKey];
          continue;
        }
        let httpGet = options.httpGet || null;
        if (!httpGet && options.getUrl) {
          const match = String(options.getUrl).match(/^(?:https?:\/\/)?(?::?(\d+))?(\/.*)?$/);
          httpGet = {
            path: match?.[2] || '/',
            port: match?.[1] ? Number(match[1]) : 8080,
            scheme: String(options.getUrl).startsWith('https') ? 'HTTPS' : 'HTTP',
          };
        }
        container[probeKey] = {
          httpGet: httpGet || { path: '/healthz', port: 8080, scheme: 'HTTP' },
          initialDelaySeconds: options.initialDelaySeconds ?? 5,
          periodSeconds: options.periodSeconds ?? 10,
          timeoutSeconds: 1,
          failureThreshold: 3,
          successThreshold: 1,
        };
      }
    });
    resource._rollout = { reason: 'probe change', startedAt: Date.now(), remaining: null };
    return { success: true, message: `${String(kind).toLowerCase()}.apps "${name}" ${probeType} probe updated`, resource };
  }

  /**
   * `oc set serviceaccount <kind>/<name> <serviceaccount>`.
   * @returns {{success: boolean, message: string, resource?: object}}
   */
  setServiceAccount(kind, name, serviceAccount, options = {}) {
    const workload = this._getWorkload(kind, name, options.namespace);
    if (!workload.success) return { success: false, message: workload.message };
    const resource = workload.resource;
    const namespace = resource.metadata.namespace;
    if (!this.cluster.getByName('ServiceAccount', serviceAccount, namespace)) {
      return { success: false, message: `Error from server (NotFound): serviceaccounts "${serviceAccount}" not found` };
    }
    this._updateTemplate(resource, (podSpec) => {
      podSpec.serviceAccountName = serviceAccount;
    });
    resource._rollout = { reason: 'service account change', startedAt: Date.now(), remaining: null };
    return { success: true, message: `${String(kind).toLowerCase()}.apps "${name}" service account updated`, resource };
  }

  /**
   * `oc set triggers bc/<name> --from-image=<is>:<tag> --containers=<c> | --remove`.
   * Works for BuildConfigs and Deployments (OpenShift image-change triggers).
   * @returns {{success: boolean, message: string, resource?: object}}
   */
  setTriggers(kind, name, options = {}) {
    const canonical = this.cluster._canonicalKind(kind);
    const namespace = options.namespace || this.currentProject || 'default';
    const resource = this.cluster.getByName(canonical, name, namespace);
    if (!resource) return { success: false, message: `Error from server (NotFound): ${String(canonical).toLowerCase()}s "${name}" not found` };

    // BuildConfig is the only kind with a spec.triggers field; workload image
    // triggers use the image.openshift.io/triggers annotation (OCP 4.x).
    if (canonical !== 'BuildConfig') {
      const current = this._parseImageTriggerAnnotation(resource);
      if (options.remove) {
        const before = current.length;
        const next = current.filter((entry) => {
          if (!options.fromImage) return false;
          return String(entry?.from?.name || '') !== String(options.fromImage);
        });
        resource.metadata.annotations = resource.metadata.annotations || {};
        if (next.length > 0) resource.metadata.annotations[IMAGE_TRIGGER_ANNOTATION] = JSON.stringify(next);
        else delete resource.metadata.annotations[IMAGE_TRIGGER_ANNOTATION];
        resource.metadata.generation++;
        this.cluster.update(resource.uid, resource);
        return { success: true, message: `${before - next.length} trigger(s) removed`, resource };
      }
      if (!options.fromImage) return { success: false, message: 'error: you must specify --from-image=<imagestream>:<tag>' };
      const [imageStreamName, tag = 'latest'] = String(options.fromImage).split(':');
      const containers = Array.isArray(resource.spec?.template?.spec?.containers)
        ? resource.spec.template.spec.containers.map((container) => container.name)
        : ['main'];
      const targets = options.containers ? [].concat(options.containers) : containers;
      const nextEntries = current.filter((entry) => {
        const path = String(entry?.fieldPath || '');
        return !targets.some((containerName) => {
          const index = containers.indexOf(containerName);
          return index >= 0 && path === `spec.template.spec.containers[${index}].image`;
        });
      });
      const added = this._imageTriggerAnnotationEntries(
        [{
          type: 'ImageChange',
          imageChangeParams: {
            automatic: true,
            containerNames: targets,
            from: { kind: 'ImageStreamTag', name: `${imageStreamName}:${tag}` },
          },
        }],
        containers
      );
      const merged = [...nextEntries, ...added];
      resource.metadata.annotations = resource.metadata.annotations || {};
      if (merged.length > 0) resource.metadata.annotations[IMAGE_TRIGGER_ANNOTATION] = JSON.stringify(merged);
      else delete resource.metadata.annotations[IMAGE_TRIGGER_ANNOTATION];
      resource.metadata.generation++;
      this.cluster.update(resource.uid, resource);
      return { success: true, message: `triggers updated for ${String(canonical).toLowerCase()}/${name}`, resource };
    }

    resource.spec = resource.spec || {};
    resource.spec.triggers = resource.spec.triggers || [];
    if (options.remove) {
      const before = resource.spec.triggers.length;
      resource.spec.triggers = resource.spec.triggers.filter((trigger) => {
        if (!options.fromImage) return false;
        const triggerName = trigger.imageChange?.from?.name || trigger.imageChangeParams?.from?.name || '';
        return triggerName !== options.fromImage;
      });
      this.cluster.update(resource.uid, resource);
      return { success: true, message: `${before - resource.spec.triggers.length} trigger(s) removed`, resource };
    }
    if (!options.fromImage) return { success: false, message: 'error: you must specify --from-image=<imagestream>:<tag>' };
    const [imageStreamName, tag = 'latest'] = String(options.fromImage).split(':');
    resource.spec.triggers = resource.spec.triggers.filter((entry) => entry.type !== 'ImageChange');
    resource.spec.triggers.push({ type: 'ImageChange', imageChange: { from: { kind: 'ImageStreamTag', name: `${imageStreamName}:${tag}` } } });
    this.cluster.update(resource.uid, resource);
    return { success: true, message: `triggers updated for ${String(canonical).toLowerCase()}/${name}`, resource };
  }

  /** `oc set selector svc/<name> key=value`. */
  setSelector(kind, name, selector, options = {}) {
    const resource = this.getResource(kind, name, options.namespace);
    if (!resource) return { success: false, message: `Error from server (NotFound): ${String(kind).toLowerCase()}s "${name}" not found` };
    resource.spec.selector = resource.spec.selector || {};
    for (const [key, value] of Object.entries(selector || {})) {
      if (value === null || value === undefined) delete resource.spec.selector[key];
      else resource.spec.selector[key] = String(value);
    }
    resource.metadata.generation++;
    this.cluster.update(resource.uid, resource);
    return { success: true, message: `${String(kind).toLowerCase()}/${name} selector updated`, resource };
  }

  /** `oc set volumes <kind>/<name> --add --name=... --claim-name=... --mount-path=...`. */
  setVolumes(kind, name, options = {}) {
    const workload = this._getWorkload(kind, name, options.namespace);
    if (!workload.success) return { success: false, message: workload.message };
    const resource = workload.resource;
    const volumeName = options.name || 'data';
    this._updateTemplate(resource, (podSpec, template) => {
      podSpec.volumes = podSpec.volumes || [];
      let volume;
      if (options.claimName) volume = { name: volumeName, persistentVolumeClaim: { claimName: options.claimName } };
      else if (options.configMap) volume = { name: volumeName, configMap: { name: options.configMap } };
      else if (options.secret) volume = { name: volumeName, secret: { secretName: options.secret } };
      else volume = { name: volumeName, emptyDir: {} };
      podSpec.volumes = podSpec.volumes.filter((entry) => entry.name !== volumeName);
      podSpec.volumes.push(volume);
      for (const container of podSpec.containers) {
        container.volumeMounts = (container.volumeMounts || []).filter((mount) => mount.name !== volumeName);
        container.volumeMounts.push({ name: volumeName, mountPath: options.mountPath || '/data' });
      }
      template.metadata = template.metadata || {};
    });
    resource._rollout = { reason: 'volume change', startedAt: Date.now(), remaining: null };
    return { success: true, message: `${String(kind).toLowerCase()}.apps "${name}" volumes updated`, resource };
  }

  // ── rollout / revisions ─────────────────────────────────────────────────

  /** Record a Deployment/StatefulSet revision in its in-memory history. */
  _recordRevision(resource, changeCause, templateOverride) {
    resource._revisionHistory = resource._revisionHistory || [];
    const template = templateOverride || deepClone(resource.spec?.template || {});
    resource._revisionHistory.push({
      revision: resource._revisionHistory.length + 1,
      changeCause,
      timestamp: Date.now(),
      template: deepClone(template),
      images: (resource.spec?.template?.spec?.containers || []).map((container) => `${container.name}=${container.image}`),
    });
    if (resource._revisionHistory.length > 10) resource._revisionHistory.shift();
    return resource._revisionHistory[resource._revisionHistory.length - 1];
  }

  /**
   * `oc rollout history|status|restart|undo <kind>/<name>`.
   *
   * @param {string} kind
   * @param {'status'|'restart'|'undo'|'history'} subcommand
   * @param {string} name
   * @param {{namespace?: string, revision?: number}} [options]
   * @returns {{success: boolean, message: string, resource?: object, status?: object, history?: object[]}}
   */
  rollout(kind, subcommand, name, options = {}) {
    const canonical = this.cluster._canonicalKind(kind || 'Deployment');
    const resource = this.getResource(canonical, name, options.namespace);
    if (!resource) return { success: false, message: `Error from server (NotFound): ${String(canonical).toLowerCase()}s "${name}" not found` };

    // Prefer the runtime controller's rollout model when it provides one
    // (progress-deadline / ImagePullBackOff awareness lives in SimulationTick).
    const simulation = this.simulation;
    try {
      if (subcommand === 'status' && typeof simulation?.getRolloutStatus === 'function') {
        const delegated = simulation.getRolloutStatus(canonical, name, options);
        if (delegated && typeof delegated === 'object') return delegated;
      }
      if (subcommand === 'undo' && typeof simulation?.undoRollout === 'function') {
        const delegated = simulation.undoRollout(canonical, name, options);
        if (delegated && typeof delegated === 'object') return delegated;
      }
      if (subcommand === 'history' && typeof simulation?.getRolloutHistory === 'function') {
        const history = simulation.getRolloutHistory(canonical, name, options);
        if (Array.isArray(history) && history.length > 0) {
          return { success: true, history, message: '' };
        }
      }
    } catch {
      /* fall back to the engine's own rollout model */
    }

    switch (subcommand) {
      case 'status': {
        const status = {
          replicas: resource.status.replicas ?? resource.status.currentReplicas ?? 0,
          readyReplicas: resource.status.readyReplicas ?? resource.status.numberReady ?? 0,
          availableReplicas: resource.status.availableReplicas ?? resource.status.numberAvailable ?? 0,
          updatedReplicas: resource.status.updatedReplicas ?? resource.status.currentReplicas ?? 0,
        };
        const complete = status.replicas === resource.spec.replicas && status.readyReplicas === resource.spec.replicas;
        return {
          success: true,
          status,
          message: complete
            ? `${String(canonical).toLowerCase()} "${name}" successfully rolled out`
            : `Waiting for rollout to finish: ${status.readyReplicas} of ${resource.spec.replicas} new replicas have been updated...`,
        };
      }
      case 'restart': {
        this._recordRevision(resource, 'restarted at ' + new Date().toISOString());
        this._updateTemplate(resource, (podSpec, template) => {
          template.metadata = template.metadata || {};
          template.metadata.annotations = template.metadata.annotations || {};
          template.metadata.annotations[RESTARTED_AT_ANNOTATION] = new Date().toISOString();
        });
        resource._rollout = { reason: 'manual restart', startedAt: Date.now(), remaining: null };
        this.eventBus.emit('resource:restarted', { kind: canonical, name, namespace: resource.metadata.namespace });
        return { success: true, message: `${String(canonical).toLowerCase()}.apps "${name}" restarted`, resource };
      }
      case 'undo': {
        const history = resource._revisionHistory || [];
        if (history.length === 0) {
          return { success: false, message: `error: no rollout history found for ${String(canonical).toLowerCase()} "${name}"` };
        }
        const revision = options.revision || (history.length >= 2 ? history[history.length - 2] : history[history.length - 1]);
        if (revision?.template) {
          resource.spec.template = deepClone(revision.template);
          resource.metadata.generation++;
          this.cluster.update(resource.uid, resource);
        }
        resource._rollout = { reason: 'rollback', startedAt: Date.now(), remaining: null };
        this.cluster._rollbackCount = (this.cluster._rollbackCount || 0) + 1;
        this.eventBus.emit('resource:rollback', { uid: resource.uid, kind: canonical, name, revision: revision?.revision });
        return { success: true, message: `deployment.apps/${name} rolled back to revision ${revision?.revision}`, resource };
      }
      case 'history':
      default:
        return { success: true, history: this.getRolloutHistory(canonical, name, options), message: '' };
    }
  }

  /**
   * Rollout history for a workload (synthesised for resources without an
   * explicit history — mirrors what `oc rollout history` shows).
   * @param {string} kind
   * @param {string} name
   * @param {{namespace?: string}} [options]
   * @returns {Array<{revision: number, changeCause: string, images: string[]}>}
   */
  getRolloutHistory(kind, name, options = {}) {
    const canonical = this.cluster._canonicalKind(kind || 'Deployment');
    // Prefer the runtime controller's revision model when available.
    if (typeof this.simulation?.getRolloutHistory === 'function') {
      try {
        const delegated = this.simulation.getRolloutHistory(canonical, name, options);
        if (Array.isArray(delegated) && delegated.length > 0) return delegated;
      } catch {
        /* fall through to the engine's own history */
      }
    }
    const resource = this.getResource(canonical, name, options.namespace);
    if (!resource) return [];
    const history = resource._revisionHistory;
    if (history && history.length > 0) {
      return history.map((entry) => ({
        revision: entry.revision,
        changeCause: entry.changeCause,
        images: entry.images,
        timestamp: entry.timestamp,
      }));
    }
    return [{
      revision: Math.max(1, resource.metadata.generation || 1),
      changeCause: 'original image',
      images: (resource.spec?.template?.spec?.containers || []).map((container) => `${container.name}=${container.image}`),
    }];
  }

  // ── RBAC commands (oc adm policy / oc create user/group) ───────────────

  /**
   * Normalise an RBAC subject.
   * Accepts `alice`, `user:alice`, `group:devs`,
   * `system:serviceaccount:demo:builder` or `{kind, name, namespace}`.
   * @returns {{subject: object, roleBindingSubject: object, description: string}}
   */
  _normalizeRbacSubject(subject, options = {}) {
    if (subject && typeof subject === 'object') {
      const kind = subject.kind || options.kind || 'User';
      if (kind === 'ServiceAccount') {
        const namespace = subject.namespace || options.namespace || this.currentProject || 'default';
        return {
          subject: { kind: 'ServiceAccount', name: subject.name, namespace },
          roleBindingSubject: { kind: 'ServiceAccount', name: subject.name, namespace, apiGroup: '' },
          description: `serviceaccount ${namespace}/${subject.name}`,
        };
      }
      if (kind === 'Group') {
        return { subject: { kind: 'Group', name: subject.name }, roleBindingSubject: { kind: 'Group', name: subject.name, apiGroup: 'rbac.authorization.k8s.io' }, description: `group ${subject.name}` };
      }
      return { subject: { kind: 'User', name: subject.name }, roleBindingSubject: { kind: 'User', name: subject.name, apiGroup: 'rbac.authorization.k8s.io' }, description: `user ${subject.name}` };
    }
    const raw = String(subject || '').trim();
    if (raw.startsWith('system:serviceaccount:')) {
      const parts = raw.split(':');
      const namespace = parts[2] || this.currentProject || 'default';
      const name = parts[3] || '';
      return {
        subject: { kind: 'ServiceAccount', name, namespace },
        roleBindingSubject: { kind: 'ServiceAccount', name, namespace, apiGroup: '' },
        description: `serviceaccount ${namespace}/${name}`,
      };
    }
    if (raw.startsWith('group:')) {
      const name = raw.slice(6);
      return { subject: { kind: 'Group', name }, roleBindingSubject: { kind: 'Group', name, apiGroup: 'rbac.authorization.k8s.io' }, description: `group ${name}` };
    }
    if (raw.startsWith('user:')) {
      const name = raw.slice(5);
      return { subject: { kind: 'User', name }, roleBindingSubject: { kind: 'User', name, apiGroup: 'rbac.authorization.k8s.io' }, description: `user ${name}` };
    }
    const kind = options.kind || 'User';
    if (kind === 'Group') {
      return { subject: { kind: 'Group', name: raw }, roleBindingSubject: { kind: 'Group', name: raw, apiGroup: 'rbac.authorization.k8s.io' }, description: `group ${raw}` };
    }
    if (kind === 'ServiceAccount') {
      const namespace = options.namespace || this.currentProject || 'default';
      return {
        subject: { kind: 'ServiceAccount', name: raw, namespace },
        roleBindingSubject: { kind: 'ServiceAccount', name: raw, namespace, apiGroup: '' },
        description: `serviceaccount ${namespace}/${raw}`,
      };
    }
    return { subject: { kind: 'User', name: raw }, roleBindingSubject: { kind: 'User', name: raw, apiGroup: 'rbac.authorization.k8s.io' }, description: `user ${raw}` };
  }

  /**
   * Create or update a RoleBinding/ClusterRoleBinding.
   * @param {{role: string, subject: string|object, namespace?: string, clusterWide?: boolean, remove?: boolean, kind?: string}} options
   * @returns {{success: boolean, message: string, binding?: object,
   *   role?: string, roleKind?: 'Role'|'ClusterRole', roleRefApiGroup?: string,
   *   bindingKind?: string, bindingName?: string, subjectKind?: string,
   *   subjectLabel?: string, subjectText?: string, subjectNamespace?: string}}
   */
  modifyRoleBinding(options = {}) {
    const namespace = options.namespace || this.currentProject || 'default';
    const clusterWide = options.clusterWide === true || options.kind === 'ClusterRole';
    const roleName = options.role;
    if (!roleName) return { success: false, message: 'error: you must specify a role' };
    const normalizedSubject = this._normalizeRbacSubject(options.subject, { namespace, kind: options.subjectKind });

    // Validate that the role exists (or is a built-in role).
    const roleExists = !!this.cluster.getByName('Role', roleName, namespace);
    const clusterRoleExists = !!this.cluster.getByName('ClusterRole', roleName, '') || BUILTIN_ROLE_NAMES.has(roleName);
    if (!roleExists && !clusterRoleExists) {
      return { success: false, message: `Error from server (NotFound): clusterroles.rbac.authorization.k8s.io "${roleName}" not found` };
    }
    const roleKind = clusterWide || !roleExists ? 'ClusterRole' : 'Role';

    const suffix = normalizedSubject.subject.name.replace(/[^a-zA-Z0-9-]/g, '-');
    const bindingName = `${roleName}-${suffix}`;
    const bindingKind = clusterWide ? 'ClusterRoleBinding' : 'RoleBinding';
    const bindingNamespace = clusterWide ? '' : namespace;
    const existing = this.cluster.getByName(bindingKind, bindingName, bindingNamespace);

    /**
     * Fields the CLI needs for real `oc adm policy` output (issue #21), e.g.
     * `clusterrole.rbac.authorization.k8s.io/view added: "default"`.
     * `subjectLabel` is the bare name (not the full SA identity string) and
     * `roleKind` is the roleRef kind of the (new or existing) binding.
     */
    const outputDetails = (binding, fallbackRoleKind = roleKind) => {
      const roleRef = binding?.spec?.roleRef || { apiGroup: 'rbac.authorization.k8s.io', kind: fallbackRoleKind, name: roleName };
      return {
        role: roleName,
        roleKind: roleRef.kind || fallbackRoleKind,
        roleRefApiGroup: roleRef.apiGroup || 'rbac.authorization.k8s.io',
        bindingKind: binding?.kind || bindingKind,
        bindingName: binding?.metadata?.name || bindingName,
        subjectKind: normalizedSubject.subject.kind,
        subjectLabel: normalizedSubject.subject.name,
        subjectText: normalizedSubject.description,
        subjectNamespace: normalizedSubject.subject.namespace || '',
        subject: normalizedSubject.subject,
      };
    };

    if (options.remove) {
      // Real `oc adm policy remove-*-from-*` finds the binding(s) by roleRef
      // (not by the generated `<role>-<subject>` name), so it also works for
      // bootstrap bindings such as the seeded `self-provisioners` binding
      // (issue #3) and for bindings created with an explicit name.
      const candidates = clusterWide
        ? this.cluster.getByKind('ClusterRoleBinding')
        : this.cluster.getByKindAndNamespace('RoleBinding', namespace);
      let changedBinding = null;
      for (const candidate of candidates) {
        const roleRef = candidate.spec?.roleRef || {};
        if (roleRef.name !== roleName) continue;
        if (clusterWide && roleRef.kind !== 'ClusterRole') continue;
        const subjects = candidate.spec?.subjects || [];
        const next = subjects.filter((subject) => !this._sameSubject(subject, normalizedSubject.roleBindingSubject));
        if (next.length === subjects.length) continue;
        candidate.spec.subjects = next;
        this.cluster.update(candidate.uid, candidate);
        changedBinding = candidate;
      }
      if (changedBinding) {
        this.eventBus.emit('rbac:updated', {
          binding: changedBinding.metadata?.name,
          kind: bindingKind,
          role: roleName,
          subject: normalizedSubject.subject,
          action: 'remove',
        });
        return {
          success: true,
          message: `${normalizedSubject.description} removed from role ${roleName}`,
          binding: changedBinding,
          ...outputDetails(changedBinding),
        };
      }
      if (!existing) return { success: true, message: `${bindingKind} "${bindingName}" not found; nothing to remove` };
      const subjects = (existing.spec.subjects || []).filter((subject) => !this._sameSubject(subject, normalizedSubject.roleBindingSubject));
      existing.spec.subjects = subjects;
      this.cluster.update(existing.uid, existing);
      return {
        success: true,
        message: `${normalizedSubject.description} removed from ${roleName}`,
        binding: existing,
        ...outputDetails(existing),
      };
    }

    if (existing) {
      existing.spec.subjects = existing.spec.subjects || [];
      if (!existing.spec.subjects.some((subject) => this._sameSubject(subject, normalizedSubject.roleBindingSubject))) {
        existing.spec.subjects.push(normalizedSubject.roleBindingSubject);
        this.cluster.update(existing.uid, existing);
      }
      return {
        success: true,
        message: `${normalizedSubject.description} added to role ${roleName}`,
        binding: existing,
        ...outputDetails(existing),
      };
    }

    const binding = this.applyManifestObject({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: bindingKind,
      metadata: { name: bindingName, namespace: bindingNamespace },
      spec: {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: roleKind, name: roleName },
        subjects: [normalizedSubject.roleBindingSubject],
      },
    });
    if (!binding) return { success: false, message: this.lastApplyError || `failed to create ${bindingKind}` };
    this.eventBus.emit('rbac:updated', { binding: bindingName, kind: bindingKind, role: roleName, subject: normalizedSubject.subject });
    return {
      success: true,
      message: `${normalizedSubject.description} added to role ${roleName}`,
      binding,
      ...outputDetails(binding),
    };
  }

  /** @returns {boolean} whether two RBAC subjects refer to the same identity */
  _sameSubject(left, right) {
    return left?.kind === right?.kind
      && left?.name === right?.name
      && (left?.namespace || '') === (right?.namespace || '');
  }

  /**
   * `oc adm policy add-role-to-user <role> <user> [-n project]`.
   * @returns {{success: boolean, message: string, binding?: object}}
   */
  addRoleToUser(role, user, options = {}) {
    const asServiceAccount = options.serviceAccount === true || options.z === true;
    return this.modifyRoleBinding({
      ...options,
      role,
      subject: user,
      kind: options.kind,
      subjectKind: asServiceAccount ? 'ServiceAccount' : options.subjectKind,
    });
  }

  /** `oc adm policy add-cluster-role-to-user <role> <user>` */
  addClusterRoleToUser(role, user, options = {}) {
    return this.modifyRoleBinding({ ...options, role, subject: user, clusterWide: true });
  }

  /** `oc adm policy add-role-to-group <role> <group>` */
  addRoleToGroup(role, group, options = {}) {
    return this.modifyRoleBinding({ ...options, role, subject: group, subjectKind: 'Group' });
  }

  /** `oc adm policy add-cluster-role-to-group <role> <group>` */
  addClusterRoleToGroup(role, group, options = {}) {
    return this.modifyRoleBinding({ ...options, role, subject: group, subjectKind: 'Group', clusterWide: true });
  }

  /** `oc adm policy remove-role-from-user <role> <user>` */
  removeRoleFromUser(role, user, options = {}) {
    return this.modifyRoleBinding({ ...options, role, subject: user, remove: true });
  }

  /** `oc adm policy remove-cluster-role-from-user <role> <user>` */
  removeClusterRoleFromUser(role, user, options = {}) {
    return this.modifyRoleBinding({ ...options, role, subject: user, clusterWide: true, remove: true });
  }

  /** `oc adm policy remove-role-from-group <role> <group>` */
  removeRoleFromGroup(role, group, options = {}) {
    return this.modifyRoleBinding({ ...options, role, subject: group, subjectKind: 'Group', remove: true });
  }

  /** `oc adm policy remove-cluster-role-from-group <role> <group>` */
  removeClusterRoleFromGroup(role, group, options = {}) {
    return this.modifyRoleBinding({ ...options, role, subject: group, subjectKind: 'Group', clusterWide: true, remove: true });
  }

  /**
   * `oc adm policy add-scc-to-user <scc> <user|sa>` / `-z <sa>`.
   * @param {string} sccName
   * @param {string|object} subject
   * @param {{namespace?: string, kind?: string, serviceAccount?: string}} [options]
   */
  addSCCTo(subject, sccName, options = {}) {
    const result = this.cluster.grantSCC(sccName, subject, {
      kind: options.kind,
      namespace: options.namespace || this.currentProject || 'default',
      actor: this.currentUser || 'kubeadmin',
    });
    if (!result.success) return result;
    return { success: true, message: `securitycontextconstraints.security.openshift.io/${sccName} added to ${result.subject.kind}: ${result.subject.name}`, scc: result.scc, subject: result.subject };
  }

  /** `oc adm policy add-scc-to-user <scc> <user>` (or `-z <serviceaccount>`) */
  addSCCToUser(sccName, user, options = {}) {
    if (options.serviceAccount === true || options.z === true) {
      return this.addSCCToServiceAccount(sccName, user, options);
    }
    return this.addSCCTo(user, sccName, { ...options, kind: 'User' });
  }

  /** `oc adm policy add-scc-to-group <scc> <group>` */
  addSCCToGroup(sccName, group, options = {}) {
    return this.addSCCTo(group, sccName, { ...options, kind: 'Group' });
  }

  /** `oc adm policy add-scc-to-user <scc> -z <sa>` */
  addSCCToServiceAccount(sccName, serviceAccount, options = {}) {
    const namespace = options.namespace || this.currentProject || 'default';
    return this.addSCCTo({ kind: 'ServiceAccount', name: serviceAccount, namespace }, sccName, { ...options, namespace });
  }

  /** `oc adm policy remove-scc-from-user <scc> <user>` */
  removeSCCFromUser(sccName, user, options = {}) {
    const result = this.cluster.revokeSCC(sccName, user, { kind: 'User', actor: this.currentUser || 'kubeadmin' });
    return result.success
      ? { success: true, message: `securitycontextconstraints.security.openshift.io/${sccName} removed from user ${user}` }
      : result;
  }

  /** `oc adm policy remove-scc-from-group <scc> <group>` */
  removeSCCFromGroup(sccName, group, options = {}) {
    const result = this.cluster.revokeSCC(sccName, group, { kind: 'Group', actor: this.currentUser || 'kubeadmin' });
    return result.success
      ? { success: true, message: `securitycontextconstraints.security.openshift.io/${sccName} removed from group ${group}` }
      : result;
  }

  // ── Users / groups ─────────────────────────────────────────────────────

  /**
   * `oc create user <name> [--full-name=]`.
   * @returns {{success: boolean, user?: object, message: string}}
   */
  createUserResource(name, options = {}) {
    if (!name) return { success: false, message: 'error: you must specify a name' };
    if (this.cluster.getUser(name)) {
      return { success: false, message: `Error from server (AlreadyExists): users.user.openshift.io "${name}" already exists` };
    }
    const user = this.cluster.createUser(name, { fullName: options.fullName || '' });
    if (options.groups?.length) this.cluster.addUserToGroup(options.groups[0], [name]);
    return { success: true, user, message: `user.user.openshift.io/${name} created` };
  }

  /**
   * `oc delete user <name>` — removes the user, identities, group membership and
   * RBAC/SCC references (CONVERSION-SPEC §6).
   * @returns {{success: boolean, message: string}}
   */
  deleteUserResource(name) {
    if (!this.cluster.getUser(name)) {
      return { success: false, message: `Error from server (NotFound): users.user.openshift.io "${name}" not found` };
    }
    this.cluster.deleteUser(name);
    this.eventBus.emit('user:deleted', { name });
    return { success: true, message: `user.user.openshift.io "${name}" deleted` };
  }

  /**
   * `oc create group <name> [--users=...]`.
   * @returns {{success: boolean, group?: object, message: string}}
   */
  createGroupResource(name, users = []) {
    if (!name) return { success: false, message: 'error: you must specify a name' };
    if (this.cluster.getGroup(name)) {
      return { success: false, message: `Error from server (AlreadyExists): groups.user.openshift.io "${name}" already exists` };
    }
    const group = this.cluster.createGroup(name, users);
    return { success: true, group, message: `group.user.openshift.io/${name} created` };
  }

  /** `oc adm groups add-users <group> <user...>` */
  addUsersToGroup(groupName, users) {
    const group = this.cluster.getGroup(groupName);
    if (!group) return { success: false, message: `Error from server (NotFound): groups.user.openshift.io "${groupName}" not found` };
    const result = this.cluster.addUserToGroup(groupName, users);
    return { success: true, group: result.group, added: result.added, message: `group.user.openshift.io/${groupName} updated` };
  }

  /** `oc adm groups remove-users <group> <user...>` */
  removeUsersFromGroup(groupName, users) {
    const group = this.cluster.getGroup(groupName);
    if (!group) return { success: false, message: `Error from server (NotFound): groups.user.openshift.io "${groupName}" not found` };
    const result = this.cluster.removeUserFromGroup(groupName, users);
    return { success: true, group: result.group, removed: result.removed, message: `group.user.openshift.io/${groupName} updated` };
  }

  // ── Quotas / LimitRange / ClusterResourceQuota ─────────────────────────

  /**
   * `oc create quota <name> --hard=pods=20,requests.cpu=4,requests.memory=8Gi`.
   * @param {string} name
   * @param {Record<string, string|number>} hard
   * @param {{namespace?: string, scopes?: string[]}} [options]
   * @returns {{success: boolean, resource?: object, message: string}}
   */
  createResourceQuota(name, hard, options = {}) {
    const namespace = options.namespace || this.currentProject || 'default';
    if (!this.cluster.getProject(namespace)) return { success: false, message: `Error from server (NotFound): project.project.openshift.io "${namespace}" not found` };
    if (this.cluster.getByName('ResourceQuota', name, namespace)) {
      return { success: false, message: `Error from server (AlreadyExists): resourcequotas "${name}" already exists` };
    }
    const resource = this.cluster.addResource({
      kind: 'ResourceQuota',
      metadata: { name, namespace },
      spec: { hard: { ...hard } },
    });
    this.cluster.recalculateQuotaStatus();
    return { success: true, resource, message: `resourcequota/${name} created` };
  }

  /**
   * `oc create limitrange <name> --default=cpu=500m,memory=512Mi ...`.
   * @param {string} name
   * @param {{default?: object, defaultRequest?: object, min?: object, max?: object, type?: string, limits?: object[]}} options
   * @returns {{success: boolean, resource?: object, message: string}}
   */
  createLimitRange(name, options = {}) {
    const namespace = this.namespaceFor(options);
    if (!this.cluster.getProject(namespace)) return { success: false, message: `Error from server (NotFound): project.project.openshift.io "${namespace}" not found` };
    if (this.cluster.getByName('LimitRange', name, namespace)) {
      return { success: false, message: `Error from server (AlreadyExists): limitranges "${name}" already exists` };
    }
    const limits = options.limits || [{
      type: options.type || 'Container',
      default: options.default || {},
      defaultRequest: options.defaultRequest || {},
      min: options.min || {},
      max: options.max || {},
    }];
    const resource = this.cluster.addResource({
      kind: 'LimitRange',
      metadata: { name, namespace },
      spec: { limits },
    });
    return { success: true, resource, message: `limitrange/${name} created` };
  }

  /**
   * `oc create clusterquota <name> --project-label-selector=... --hard=...`.
   * @param {string} name
   * @param {{hard?: object, selector?: object, projectLabelSelector?: string}} [options]
   * @returns {{success: boolean, resource?: object, message: string}}
   */
  createClusterResourceQuota(name, options = {}) {
    if (this.cluster.getByName('ClusterResourceQuota', name, '')) {
      return { success: false, message: `Error from server (AlreadyExists): clusterresourcequotas.quota.openshift.io "${name}" already exists` };
    }
    const matchLabels = options.selector?.labels?.matchLabels || options.selector || {};
    const resource = this.cluster.addResource({
      kind: 'ClusterResourceQuota',
      metadata: { name },
      spec: {
        selector: { labels: { matchLabels: { ...matchLabels } } },
        quota: { hard: { ...(options.hard || {}) } },
      },
    });
    this.cluster.recalculateQuotaStatus();
    return { success: true, resource, message: `clusterresourcequota.quota.openshift.io/${name} created` };
  }

  /** @returns {string} namespace from options or the current project */
  namespaceFor(options = {}) {
    return options.namespace || this.currentProject || 'default';
  }

  // ── Builds / images ────────────────────────────────────────────────────

  /**
   * `oc tag <src> <dst> [--scheduled]`.
   * @param {string} source e.g. "nodejs:20-ubi9" or "openshift/nodejs:20-ubi9"
   * @param {string} destination e.g. "app:latest"
   * @param {{namespace?: string}} [options]
   */
  tagImage(source, destination, options = {}) {
    const namespace = this.namespaceFor(options);
    const parse = (reference) => {
      const [left, tagPart] = String(reference).split(':');
      const segments = left.split('/');
      const isName = segments.pop();
      return { namespace: segments.length > 0 ? segments.pop() : namespace, name: isName, tag: tagPart || 'latest' };
    };
    const sourceRef = parse(source);
    const destinationRef = parse(destination);
    const sourceImageStream = this.cluster.getImageStream(sourceRef.namespace, sourceRef.name);
    if (!sourceImageStream) return { success: false, message: `Error from server (NotFound): imagestreams.image.openshift.io "${sourceRef.name}" not found` };
    const sourceTag = this.cluster.resolveImageStreamTag(sourceRef.namespace, sourceRef.name, sourceRef.tag);
    const result = this.cluster.updateImageStreamTag(destinationRef.namespace || namespace, destinationRef.name, destinationRef.tag, {
      dockerImageReference: sourceTag.dockerImageReference,
      image: sourceTag.tagEntry?.items?.[0]?.image || sourceTag.dockerImageReference,
    });
    return { success: true, message: `imagestreamtag.image.openshift.io/${destinationRef.name}:${destinationRef.tag} tagged`, imageStream: result.imageStream };
  }

  /**
   * `oc import-image <is>:<tag> --from=<image> --confirm`.
   * @param {string} reference e.g. "app:latest"
   * @param {{from?: string, namespace?: string, all?: boolean}} [options]
   */
  importImage(reference, options = {}) {
    const namespace = this.namespaceFor(options);
    const [name, tag = 'latest'] = String(reference).split(':');
    if (!options.from) return { success: false, message: 'error: --from=<image> is required for oc import-image' };
    const result = this.cluster.updateImageStreamTag(namespace, name, tag, { dockerImageReference: options.from, isExternal: true });
    return {
      success: true,
      imageStream: result.imageStream,
      message: `imagestream.image.openshift.io/${name} imported`,
    };
  }

  // ── Templates ──────────────────────────────────────────────────────────

  /**
   * Render an OpenShift Template (resource name or object) and optionally apply
   * the resulting objects.
   *
   * @param {string|object|object[]} source template name, Template resource,
   *   array of manifest objects, or file path (delegated to ManifestEngine)
   * @param {Record<string,string>} [params]
   * @param {{namespace?: string, namespaceCandidates?: string[], apply?: boolean}} [options]
   * @returns {{success: boolean, objects?: object[], resources?: object[], message: string}}
   */
  processTemplate(source, params = {}, options = {}) {
    let templateObject = null;
    let objects = null;

    if (Array.isArray(source)) {
      objects = deepClone(source);
    } else if (typeof source === 'string' && (source.endsWith('.yaml') || source.endsWith('.yml')) && this._getManifestEngine()) {
      const manifestEngine = this._getManifestEngine();
      try {
        const result = typeof manifestEngine.processTemplate === 'function'
          ? manifestEngine.processTemplate(source, params)
          : null;
        if (result && typeof result === 'object') {
          if (Array.isArray(result.resources)) return { success: true, objects: result.objects || [], resources: result.resources, message: 'Template processed' };
          if (Array.isArray(result.objects)) objects = result.objects;
          if (result.error) return { success: false, message: result.error };
        }
      } catch (error) {
        return { success: false, message: `error: ${error.message}` };
      }
    }

    if (!objects) {
      if (source && typeof source === 'object') templateObject = source;
      else {
        const namespaceCandidates = options.namespaceCandidates || [this.namespaceFor(options), 'openshift', 'openshift-config'];
        for (const candidate of namespaceCandidates) {
          templateObject = this.cluster.getByName('Template', String(source), candidate);
          if (templateObject) break;
        }
      }
      if (!templateObject) return { success: false, message: `Error from server (NotFound): templates.template.openshift.io "${source}" not found` };
      objects = deepClone(templateObject.spec?.objects || []);
    }

    const parameters = new Map();
    for (const parameter of templateObject?.spec?.parameters || []) {
      if (parameter.value !== undefined) parameters.set(parameter.name, String(parameter.value));
      if (parameter.generate) parameters.set(parameter.name, parameter.generate === 'expression' ? `generated-${Math.random().toString(36).slice(2, 8)}` : parameter.value);
    }
    for (const [key, value] of Object.entries(params || {})) parameters.set(key, String(value));

    const missingRequired = [];
    for (const parameter of templateObject?.spec?.parameters || []) {
      if (parameter.required && !parameters.has(parameter.name)) missingRequired.push(parameter.name);
    }
    if (missingRequired.length > 0) {
      return { success: false, message: `error: Missing required parameters: ${missingRequired.join(', ')}` };
    }

    const substitute = (value) => {
      if (typeof value === 'string') {
        return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name) => (parameters.has(name) ? parameters.get(name) : match));
      }
      if (Array.isArray(value)) return value.map((item) => substitute(item));
      if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = substitute(item);
        return out;
      }
      return value;
    };

    const renderedObjects = objects.map((object) => substitute(object));
    const resources = [];
    if (options.apply) {
      for (const object of renderedObjects) {
        const resource = this.applyManifestObject(object);
        if (resource) resources.push(resource);
      }
      if (resources.length !== renderedObjects.length) {
        return { success: false, objects: renderedObjects, resources, message: this.lastApplyError || 'template apply failed' };
      }
    }
    this.eventBus.emit('template:processed', {
      template: templateObject?.metadata?.name || options.templateName || 'inline',
      parameters: Object.fromEntries(parameters),
      objects: renderedObjects.length,
    });
    return {
      success: true,
      objects: renderedObjects,
      resources,
      message: `template.template.openshift.io/${templateObject?.metadata?.name || 'inline'} processed (${renderedObjects.length} objects)`,
    };
  }

  // ── Lifecycle: settings, objectives, notifications, state ──────────────

  start() {
    if (this.state === GAME_STATES.RUNNING) return;
    this.state = GAME_STATES.RUNNING;
    this._startTime = performance.now();
    this._lastTimestamp = performance.now();
    this._fpsTimestamp = performance.now();
    this._accumulator = 0;
    this.eventBus.emit('engine:started', { mode: this.mode, difficulty: this.difficulty, timestamp: Date.now() });
    this._rafId = requestAnimationFrame((timestamp) => this._gameLoop(timestamp));
  }

  stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this.state = GAME_STATES.INIT;
    this.eventBus.emit('engine:stopped', { timestamp: Date.now() });
  }

  pause() {
    if (this.state !== GAME_STATES.RUNNING) return;
    this.state = GAME_STATES.PAUSED;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this.eventBus.emit('engine:paused', { gameTime: this._gameTime });
  }

  resume() {
    if (this.state !== GAME_STATES.PAUSED) return;
    this.state = GAME_STATES.RUNNING;
    this._lastTimestamp = performance.now();
    this._accumulator = 0;
    this._rafId = requestAnimationFrame((timestamp) => this._gameLoop(timestamp));
    this.eventBus.emit('engine:resumed', { gameTime: this._gameTime });
  }

  togglePause() {
    if (this.state === GAME_STATES.RUNNING) this.pause();
    else if (this.state === GAME_STATES.PAUSED) this.resume();
  }

  _gameLoop(timestamp) {
    if (this.state !== GAME_STATES.RUNNING) return;

    const rawDelta = timestamp - this._lastTimestamp;
    const delta = Math.min(rawDelta, this._maxDeltaTime);
    this._lastTimestamp = timestamp;
    this._realTime += delta;
    this._updateFPS(timestamp);
    this._accumulator += delta * this._timeScale;

    while (this._accumulator >= this._fixedTimeStep) {
      this._processInputQueue();
      const dt = this._fixedTimeStep / 1000;
      this.simulation.tick(dt);
      this._gameTime += this._fixedTimeStep;
      for (const callback of this._updateCallbacks) callback(dt, this._gameTime);
      this._checkObjectives();
      this._accumulator -= this._fixedTimeStep;
    }

    const alpha = this._accumulator / this._fixedTimeStep;
    for (const callback of this._renderCallbacks) callback(alpha, this._gameTime);

    this.eventBus.emit('engine:frame', { fps: this._fps, gameTime: this._gameTime, realTime: this._realTime, alpha });

    if (!this._lastTickEmit || this._realTime - this._lastTickEmit > 500) {
      this._lastTickEmit = this._realTime;
      const stats = this.cluster.getClusterStats();
      const health = this.cluster.getClusterHealth();
      this.eventBus.emit('tick', {
        elapsed: this._gameTime,
        gameTime: this._gameTime,
        realTime: this._realTime,
        fps: this._fps,
        mode: this.mode,
        metrics: { cpu: stats.cpu.percent, memory: stats.memory.percent },
        clusterHealth: health.degraded.length > 0 || stats.cpu.percent > 90 || stats.memory.percent > 90 ? 'critical'
          : health.percent < 100 || stats.cpu.percent > 70 || stats.memory.percent > 70 ? 'warning' : 'healthy',
      });
    }

    this._rafId = requestAnimationFrame((nextTimestamp) => this._gameLoop(nextTimestamp));
  }

  _updateFPS(timestamp) {
    this._frameCount++;
    this._frameTimes.push(timestamp);
    if (this._frameTimes.length > this._maxFrameTimes) this._frameTimes.shift();
    if (timestamp - this._fpsTimestamp >= this._fpsUpdateInterval) {
      this._fps = Math.round((this._frameCount * 1000) / (timestamp - this._fpsTimestamp));
      this._frameCount = 0;
      this._fpsTimestamp = timestamp;
    }
  }

  getAverageFPS() {
    if (this._frameTimes.length < 2) return 0;
    const elapsed = this._frameTimes[this._frameTimes.length - 1] - this._frameTimes[0];
    return elapsed > 0 ? Math.round(((this._frameTimes.length - 1) * 1000) / elapsed) : 0;
  }

  getFrameTime() {
    if (this._frameTimes.length < 2) return 0;
    return this._frameTimes[this._frameTimes.length - 1] - this._frameTimes[this._frameTimes.length - 2];
  }

  _processInputQueue() {
    while (this._inputQueue.length > 0) {
      this._executeCommand(this._inputQueue.shift());
    }
  }

  queueCommand(command) {
    this._inputQueue.push({ ...command, timestamp: Date.now() });
  }

  _executeCommand(command) {
    const parsed = GameEngine.parseCommandLine(
      command.raw || `${command.type || 'command'} ${command.kind || ''} ${command.name || ''}`
    );
    this._commandHistory.push({
      raw: parsed.raw,
      baseCommand: command.type || parsed.baseCommand,
      args: parsed.args,
      success: true,
      timestamp: Date.now(),
    });
    if (this._commandHistory.length > this._maxCommandHistory) this._commandHistory.shift();
    this.eventBus.emit('command:executed', command);

    switch (command.type) {
      case 'create':
        return this._handleCreate(command);
      case 'delete':
        return this._handleDelete(command);
      case 'scale':
        return this._handleScale(command);
      case 'apply':
        return this._handleApply(command);
      case 'cordon':
        return this._handleCordon(command);
      case 'uncordon':
        return this._handleUncordon(command);
      case 'drain':
        return this._handleDrain(command);
      case 'rollout':
        return this._handleRollout(command);
      case 'exec':
        return this._handleExec(command);
      case 'logs':
        return this._handleLogs(command);
      default:
        this.eventBus.emit('command:unknown', command);
        return { success: false, message: `Unknown command: ${command.type}` };
    }
  }

  _handleCreate(command) {
    const resource = this.applyManifestObject({
      apiVersion: apiVersionForKind(command.kind),
      kind: command.kind,
      metadata: { name: command.name, namespace: command.namespace || this.currentProject, labels: command.labels || {} },
      spec: command.spec || {},
    });
    if (!resource) return { success: false, message: this.lastApplyError || `${command.kind} "${command.name}" could not be created` };
    this._addNotification('success', `Created ${command.kind} "${command.name}"`);
    this._score += 2 * this._scoreMultiplier;
    return { success: true, resource };
  }

  _handleDelete(command) {
    const result = this.deleteResource(command.kind, command.name, command.namespace);
    if (result.success) this._addNotification('info', `Deleted ${command.kind} "${command.name}"`);
    return result;
  }

  _handleScale(command) {
    const result = this.scale(command.kind, command.name, command.replicas, { namespace: command.namespace });
    if (result.success) {
      this._addNotification('info', `Scaled ${command.kind} "${command.name}" from ${result.oldReplicas} to ${command.replicas} replicas`);
      this._score += 3 * this._scoreMultiplier;
    }
    return result;
  }

  _handleApply(command) {
    return this._handleCreate(command);
  }

  _handleCordon(command) {
    const node = this.cluster.getByName('Node', command.name, '');
    if (!node) return { success: false, message: `Node "${command.name}" not found` };
    node.spec.unschedulable = true;
    node.setLabel('node.kubernetes.io/unschedulable', 'true');
    this._addNotification('warning', `Cordoned node "${command.name}"`);
    return { success: true };
  }

  _handleUncordon(command) {
    const node = this.cluster.getByName('Node', command.name, '');
    if (!node) return { success: false, message: `Node "${command.name}" not found` };
    node.spec.unschedulable = false;
    node.removeLabel('node.kubernetes.io/unschedulable');
    this._addNotification('info', `Uncordoned node "${command.name}"`);
    return { success: true };
  }

  _handleDrain(command) {
    const node = this.cluster.getByName('Node', command.name, '');
    if (!node) return { success: false, message: `Node "${command.name}" not found` };
    node.spec.unschedulable = true;
    const pods = this.cluster.getByKind('Pod').filter(
      (pod) => pod.spec.nodeName === command.name && pod.status.phase === 'Running'
    );
    let evicted = 0;
    for (const pod of pods) {
      const isDaemonSet = pod.metadata.ownerReferences.some((reference) => reference.kind === 'DaemonSet');
      if (isDaemonSet && !command.force) continue;
      pod.markForDeletion();
      evicted++;
    }
    this._addNotification('warning', `Draining node "${command.name}", evicting ${evicted} pods`);
    this._score += 5 * this._scoreMultiplier;
    return { success: true, evictedPods: evicted };
  }

  _handleRollout(command) {
    const result = this.rollout(command.kind || 'Deployment', command.subcommand, command.name, { namespace: command.namespace });
    if (result.success && command.subcommand === 'restart') {
      this._addNotification('info', `Restarting rollout for ${command.kind || 'Deployment'} "${command.name}"`);
      const failedPods = this.cluster.getByKind('Pod').filter((pod) => pod.status.phase === 'Failed');
      if (failedPods.length === 0) this.eventBus.emit('rollout:zero-downtime', { kind: command.kind || 'Deployment', name: command.name });
    } else if (result.success && command.subcommand === 'undo') {
      this._addNotification('info', `Rolled back ${command.kind || 'Deployment'} "${command.name}" to previous revision`);
    }
    return result;
  }

  _handleExec(command) {
    const { podName, namespace, containerName, cmd } = command;
    const pod = this.cluster.getByName('Pod', podName, namespace ?? 'default');
    if (!pod) return { success: false, message: `Pod "${podName}" not found` };
    if (pod.status.phase !== 'Running') return { success: false, message: `Pod "${podName}" is not running` };
    this.eventBus.emit('command:exec', { pod: podName, container: containerName, command: cmd });
    return { success: true, output: `[simulated exec output for ${cmd}]` };
  }

  _handleLogs(command) {
    const { podName, namespace, containerName } = command;
    const pod = this.cluster.getByName('Pod', podName, namespace ?? 'default');
    if (!pod) return { success: false, message: `Pod "${podName}" not found` };
    const events = pod.getEvents(20);
    return { success: true, logs: events.map((event) => `${event.timestamp} [${event.type}] ${event.reason}: ${event.message}`) };
  }

  _apiVersionForKind(kind) {
    return apiVersionForKind(kind);
  }

  setMode(mode) {
    const oldMode = this.mode;
    this.mode = mode;
    if (mode === GAME_MODES.CHAOS) {
      this.simulation.setChaosConfig({ podKillRate: 0.01, nodeFailRate: 0.002, cpuStress: 0.2, memoryStress: 0.1 });
    } else {
      this.simulation.setChaosConfig({ podKillRate: 0, nodeFailRate: 0, cpuStress: 0, memoryStress: 0 });
    }
    this.eventBus.emit('engine:mode-changed', { from: oldMode, to: mode });
  }

  setDifficulty(difficulty) {
    this.difficulty = difficulty;
    this._applyDifficulty();
    this.eventBus.emit('engine:difficulty-changed', { difficulty });
  }

  setTimeScale(scale) {
    this._timeScale = Math.max(0, Math.min(10, scale));
    this.simulation.setTickRate(this._timeScale);
    this.eventBus.emit('engine:timescale-changed', { timeScale: this._timeScale });
  }

  addObjective(id, objective) {
    this._activeObjectives.set(id, { ...objective, id, startTime: this._gameTime, completed: false });
    this._addNotification('info', `New objective: ${objective.description}`);
    this.eventBus.emit('objective:added', { id, objective });
  }

  _checkObjectives() {
    for (const [id, objective] of this._activeObjectives) {
      if (objective.completed) continue;
      let met = false;
      if (typeof objective.condition === 'function') met = objective.condition(this.cluster, this);
      if (objective.timeout && this._gameTime - objective.startTime > objective.timeout) {
        objective.failed = true;
        this._activeObjectives.delete(id);
        this._addNotification('danger', `Objective failed: ${objective.description}`);
        this.eventBus.emit('objective:failed', { id, objective });
        this._reputation = Math.max(0, this._reputation - 10);
        continue;
      }
      if (met) {
        objective.completed = true;
        this._completedObjectives.add(id);
        this._activeObjectives.delete(id);
        this._score += (objective.reward || 50) * this._scoreMultiplier;
        this._experience += objective.xp || 25;
        this._addNotification('success', `Objective completed: ${objective.description}`);
        this.eventBus.emit('objective:completed', { id, objective, score: this._score });
      }
    }
  }

  unlockAchievement(id, achievement) {
    if (this._achievements.has(id)) return false;
    this._achievements.set(id, { ...achievement, id, unlockedAt: Date.now() });
    this._addNotification('success', `Achievement unlocked: ${achievement.title}`);
    this._score += (achievement.points || 100) * this._scoreMultiplier;
    this.eventBus.emit('achievement:unlocked', { id, achievement });
    return true;
  }

  addScore(points, reason) {
    this._score += points * this._scoreMultiplier;
    this.eventBus.emit('score:changed', { score: this._score, delta: points, reason });
  }

  addCurrency(amount) {
    this._currency += amount * this._resourceMultiplier;
  }

  spendCurrency(amount) {
    if (this._currency < amount) return false;
    this._currency -= amount;
    return true;
  }

  _addNotification(type, message) {
    const notification = { id: Date.now() + Math.random(), type, message, timestamp: Date.now(), gameTime: this._gameTime, read: false };
    this._notifications.push(notification);
    if (this._notifications.length > this._maxNotifications) this._notifications.shift();
    this.eventBus.emit('notification', notification);
  }

  getNotifications(limit) {
    if (limit) return this._notifications.slice(-limit);
    return [...this._notifications];
  }

  getUnreadNotifications() {
    return this._notifications.filter((notification) => !notification.read);
  }

  markNotificationRead(id) {
    const notification = this._notifications.find((entry) => entry.id === id);
    if (notification) notification.read = true;
  }

  markAllNotificationsRead() {
    for (const notification of this._notifications) notification.read = true;
  }

  onRender(callback) {
    this._renderCallbacks.push(callback);
    return () => {
      this._renderCallbacks = this._renderCallbacks.filter((entry) => entry !== callback);
    };
  }

  onUpdate(callback) {
    this._updateCallbacks.push(callback);
    return () => {
      this._updateCallbacks = this._updateCallbacks.filter((entry) => entry !== callback);
    };
  }

  registerPlugin(name, plugin) {
    this._plugins.set(name, plugin);
    if (typeof plugin.init === 'function') plugin.init(this);
    this.eventBus.emit('plugin:registered', { name });
  }

  getPlugin(name) {
    return this._plugins.get(name) || null;
  }

  getState() {
    return {
      state: this.state,
      mode: this.mode,
      difficulty: this.difficulty,
      user: this.currentUser,
      currentUser: this.currentUser,
      project: this.currentProject,
      currentProject: this.currentProject,
      authProvider: this.getAuthProvider(),
      score: this._score,
      level: this._level,
      experience: this._experience,
      currency: Math.floor(this._currency),
      reputation: this._reputation,
      gameTime: this._gameTime,
      realTime: this._realTime,
      timeScale: this._timeScale,
      fps: this._fps,
      tickCount: this.simulation.tickCount,
      activeObjectives: this._activeObjectives.size,
      completedObjectives: this._completedObjectives.size,
      achievements: this._achievements.size,
      unreadNotifications: this.getUnreadNotifications().length,
      cluster: this.cluster.getClusterStats(),
      clusterHealth: this.cluster.getClusterHealth(),
      openshiftVersion: OPENSHIFT_VERSION,
    };
  }

  reset() {
    this.stop();
    this.cluster.clear();
    this.simulation.reset();
    this.eventBus.clearHistory();

    this.currentUser = 'kubeadmin';
    this.currentProject = 'default';
    this.authProvider = null;
    this.lastApplyError = null;

    this._gameTime = 0;
    this._realTime = 0;
    this._lastTickEmit = 0;
    this._score = 0;
    this._level = 1;
    this._experience = 0;
    this._currency = 1000;
    this._reputation = 100;
    this._achievements.clear();
    this._completedObjectives.clear();
    this._activeObjectives.clear();
    this._notifications = [];
    this._inputQueue = [];
    this._commandHistory = [];

    this._applyDifficulty();
    this.state = GAME_STATES.INIT;
    this._syncAuthProviderFromOAuth({ silent: true });
    this.eventBus.emit('engine:reset', { timestamp: Date.now() });
  }

  saveState() {
    return {
      mode: this.mode,
      difficulty: this.difficulty,
      currentUser: this.currentUser,
      currentProject: this.currentProject,
      authProvider: this.authProvider ? { ...this.authProvider } : null,
      score: this._score,
      level: this._level,
      experience: this._experience,
      currency: this._currency,
      reputation: this._reputation,
      gameTime: this._gameTime,
      timeScale: this._timeScale,
      achievements: Array.from(this._achievements.entries()),
      completedObjectives: Array.from(this._completedObjectives),
      notifications: this._notifications.slice(-20),
      commandHistory: this._commandHistory.slice(-50),
      clusterSnapshot: this.cluster.snapshot(),
      simulationState: {
        tickCount: this.simulation.tickCount,
        tickRate: this.simulation.tickRate,
        chaosConfig: { ...this.simulation.chaosConfig },
        enableChaos: this.simulation.enableChaos,
      },
      savedAt: Date.now(),
    };
  }

  loadState(savedState) {
    if (!savedState) return false;

    this.reset();
    this.mode = savedState.mode || GAME_MODES.SANDBOX;
    this.difficulty = savedState.difficulty || 'normal';
    this.currentUser = savedState.currentUser || 'kubeadmin';
    this.currentProject = savedState.currentProject || 'default';
    this.ensureCurrentProject();
    this.authProvider = savedState.authProvider || null;
    this._score = savedState.score || 0;
    this._level = savedState.level || 1;
    this._experience = savedState.experience || 0;
    this._currency = savedState.currency || 1000;
    this._reputation = savedState.reputation || 100;
    this._gameTime = savedState.gameTime || 0;
    this._timeScale = savedState.timeScale || 1;

    if (savedState.achievements) {
      for (const [key, value] of savedState.achievements) this._achievements.set(key, value);
    }
    if (savedState.completedObjectives) {
      for (const objective of savedState.completedObjectives) this._completedObjectives.add(objective);
    }
    if (savedState.notifications) this._notifications = savedState.notifications;
    if (savedState.commandHistory) this._commandHistory = savedState.commandHistory;
    if (savedState.simulationState) {
      this.simulation.tickCount = savedState.simulationState.tickCount || 0;
      this.simulation.tickRate = savedState.simulationState.tickRate || 1;
      if (savedState.simulationState.chaosConfig) this.simulation.setChaosConfig(savedState.simulationState.chaosConfig);
    }

    this._applyDifficulty();
    this.eventBus.emit('engine:loaded', { savedAt: savedState.savedAt });
    return true;
  }

  destroy() {
    this.stop();
    for (const [, plugin] of this._plugins) {
      if (typeof plugin.destroy === 'function') plugin.destroy();
    }
    this._plugins.clear();
    this._renderCallbacks = [];
    this._updateCallbacks = [];
    this.eventBus.removeAllListeners();
  }
}

GameEngine.MODES = GAME_MODES;
GameEngine.STATES = GAME_STATES;
// Password-hash helpers usable from DOM-free callers (ManifestEngine, CLI).
GameEngine.htpasswdSha = htpasswdSha;
GameEngine.htpasswdSimulatorHash = htpasswdSimulatorHash;
GameEngine.hashPasswordBcrypt = hashPasswordBcrypt;
GameEngine.verifyPasswordHash = verifyPasswordHash;
GameEngine.verifyBcryptPasswordHash = verifyBcryptPasswordHash;
GameEngine.verifyHtpasswdPasswordHash = verifyHtpasswdPasswordHash;
GameEngine.hashHtpasswdEntry = hashHtpasswdEntry;

export { EventBus, GAME_MODES, GAME_STATES };
export default GameEngine;
