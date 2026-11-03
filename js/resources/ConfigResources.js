import { ResourceBase } from './ResourceBase.js';
import { deepClone } from './ManifestSerializer.js';

/**
 * Base64 helpers that work in browsers and in Node (self-tests import these
 * modules without a DOM). The game never displays raw secret passwords in the
 * UI; `getData(key)` decodes on demand only.
 */
function b64encode(text) {
  try {
    return btoa(text);
  } catch {
    const bytes = new TextEncoder().encode(String(text));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
}

function b64decode(text) {
  try {
    return atob(text);
  } catch {
    return String(text);
  }
}

export const SECRET_TYPES = [
  'Opaque',
  'kubernetes.io/tls',
  'kubernetes.io/dockerconfigjson',
  'kubernetes.io/dockercfg',
  'kubernetes.io/basic-auth',
  'kubernetes.io/ssh-auth',
  'kubernetes.io/service-account-token',
  'bootstrap.kubernetes.io/token',
];

export class ConfigMap extends ResourceBase {
  constructor(metadata = {}) {
    super('ConfigMap', { ...metadata, apiVersion: metadata.apiVersion || 'v1' });
    const defaults = {
      data: deepClone(metadata.configData || metadata.data || {}),
      binaryData: deepClone(metadata.binaryData || {}),
    };
    if (metadata.immutable === true) defaults.immutable = true;
    this._initSpec(defaults, metadata.spec);
    this.mountedBy = [];
    this.envInjectedBy = [];
    this._setInitialStatus({ phase: 'Active' });
  }

  get data() {
    return this.spec.data || {};
  }

  get binaryData() {
    return this.spec.binaryData || {};
  }

  get immutable() {
    return this.spec.immutable === true;
  }

  setData(key, value) {
    if (this.immutable) {
      this.addEvent('Warning', 'ImmutableViolation', 'Cannot modify immutable ConfigMap');
      return false;
    }
    this.spec.data = this.spec.data || {};
    this.spec.data[key] = value;
    this.metadata.generation++;
    this._bumpResourceVersion();
    this.addEvent('Normal', 'Updated', `Key "${key}" updated`);
    return true;
  }

  deleteData(key) {
    if (this.immutable) {
      this.addEvent('Warning', 'ImmutableViolation', 'Cannot modify immutable ConfigMap');
      return false;
    }
    delete this.spec.data?.[key];
    this.metadata.generation++;
    this._bumpResourceVersion();
    return true;
  }

  getData(key) {
    return this.spec.data?.[key];
  }

  getKeys() {
    return Object.keys(this.spec.data || {});
  }

  getSize() {
    return Object.entries(this.spec.data || {}).reduce(
      (sum, [key, value]) => sum + key.length + String(value).length,
      0
    );
  }

  addMountReference(podName) {
    if (!this.mountedBy.includes(podName)) this.mountedBy.push(podName);
  }

  removeMountReference(podName) {
    this.mountedBy = this.mountedBy.filter((name) => name !== podName);
  }

  addEnvReference(podName) {
    if (!this.envInjectedBy.includes(podName)) this.envInjectedBy.push(podName);
  }

  removeEnvReference(podName) {
    this.envInjectedBy = this.envInjectedBy.filter((name) => name !== podName);
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Namespace:    ${this.metadata.namespace}
Labels:       ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:  ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}

Data
====
${Object.entries(this.data).map(([k, v]) => `${k}:\n----\n${v}`).join('\n') || '<none>'}

BinaryData
====
${Object.keys(this.binaryData).length > 0 ? Object.keys(this.binaryData).join('\n') : '<none>'}

Immutable:     ${this.immutable}
Mounted By:    ${this.mountedBy.join(', ') || '<none>'}
Env Injected:  ${this.envInjectedBy.join(', ') || '<none>'}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

export class Secret extends ResourceBase {
  constructor(metadata = {}) {
    super('Secret', { ...metadata, apiVersion: metadata.apiVersion || 'v1' });
    const type = metadata.secretType || metadata.type || 'Opaque';
    const data = {};
    if (metadata.data) {
      for (const [key, value] of Object.entries(metadata.data)) data[key] = value;
    }
    const stringData = deepClone(metadata.stringData || {});
    for (const [key, value] of Object.entries(stringData)) data[key] = b64encode(value);

    if (type === 'kubernetes.io/tls') {
      if (!data['tls.crt']) data['tls.crt'] = b64encode(SAMPLE_CERT);
      if (!data['tls.key']) data['tls.key'] = b64encode(SAMPLE_KEY);
    }
    if (type === 'kubernetes.io/dockerconfigjson' && !data['.dockerconfigjson']) {
      data['.dockerconfigjson'] = b64encode(
        JSON.stringify({
          auths: {
            'registry.example.com': {
              username: 'user',
              password: '***',
              auth: b64encode('user:***'),
            },
          },
        })
      );
    }
    if (type === 'kubernetes.io/basic-auth') {
      if (!data.username) data.username = b64encode('admin');
      if (!data.password) data.password = b64encode('***');
    }

    const defaults = { type, data };
    if (Object.keys(stringData).length > 0) defaults.stringData = stringData;
    if (metadata.immutable === true) defaults.immutable = true;
    this._initSpec(defaults, metadata.spec);
    this.mountedBy = [];
    this.envInjectedBy = [];
    this._setInitialStatus({ phase: 'Active' });
  }

  get type() {
    return this.spec.type || 'Opaque';
  }

  get data() {
    return this.spec.data || {};
  }

  get stringData() {
    return this.spec.stringData || {};
  }

  get immutable() {
    return this.spec.immutable === true;
  }

  get keys() {
    return Object.keys(this.spec.data || {});
  }

  setData(key, value, encode = true) {
    if (this.immutable) {
      this.addEvent('Warning', 'ImmutableViolation', 'Cannot modify immutable Secret');
      return false;
    }
    this.spec.data = this.spec.data || {};
    this.spec.data[key] = encode ? b64encode(String(value)) : value;
    this.metadata.generation++;
    this._bumpResourceVersion();
    this.addEvent('Normal', 'Updated', `Key "${key}" updated`);
    return true;
  }

  getData(key, decode = true) {
    const value = this.spec.data?.[key];
    if (value === undefined) return undefined;
    return decode ? b64decode(value) : value;
  }

  deleteData(key) {
    if (this.immutable) return false;
    delete this.spec.data?.[key];
    this.metadata.generation++;
    this._bumpResourceVersion();
    return true;
  }

  getSize() {
    return Object.values(this.spec.data || {}).reduce((sum, v) => sum + String(v).length, 0);
  }

  addMountReference(podName) {
    if (!this.mountedBy.includes(podName)) this.mountedBy.push(podName);
  }

  removeMountReference(podName) {
    this.mountedBy = this.mountedBy.filter((name) => name !== podName);
  }

  addEnvReference(podName) {
    if (!this.envInjectedBy.includes(podName)) this.envInjectedBy.push(podName);
  }

  removeEnvReference(podName) {
    this.envInjectedBy = this.envInjectedBy.filter((name) => name !== podName);
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Namespace:    ${this.metadata.namespace}
Labels:       ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:  ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}

Type:  ${this.type}

Data
====
${Object.entries(this.data).map(([k, v]) => `${k}:  ${b64decode(v).length} bytes`).join('\n') || '<none>'}

Immutable:     ${this.immutable}
Mounted By:    ${this.mountedBy.join(', ') || '<none>'}
Env Injected:  ${this.envInjectedBy.join(', ') || '<none>'}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

const SAMPLE_CERT =
  '-----BEGIN CERTIFICATE-----\nMIIBxTCCAW...\n-----END CERTIFICATE-----';
const SAMPLE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvgIBAD...\n-----END PRIVATE KEY-----';

export { b64encode, b64decode };
export default { ConfigMap, Secret };
