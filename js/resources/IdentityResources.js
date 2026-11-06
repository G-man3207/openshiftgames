/**
 * OpenShift identity resources (user.openshift.io/v1).
 *
 * The game stores the API's top-level fields (`fullName`, `identities`,
 * `groups`, `users`) under `.spec` internally; ManifestSerializer flattens
 * them back to the real OpenShift layout for YAML output/apply.
 *
 * These objects are normally created implicitly on login (HTPasswd / OAuth),
 * or by a cluster admin with `oc create user` / `oc create group` /
 * `oc adm groups add-users`.
 */

import { ResourceBase } from './ResourceBase.js';
import { deepClone, deterministicUserUid } from './ManifestSerializer.js';

export class User extends ResourceBase {
  constructor(metadata = {}) {
    super('User', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'user.openshift.io/v1',
    });
    this._initSpec(
      {
        fullName: metadata.fullName || '',
        groups: deepClone(metadata.groups || []),
        identities: deepClone(metadata.identities || []),
      },
      metadata.spec
    );
    this._setInitialStatus({ phase: 'Active' });
  }

  get fullName() {
    return this.spec.fullName || '';
  }

  get groups() {
    return this.spec.groups || [];
  }

  get identities() {
    return this.spec.identities || [];
  }

  addGroup(groupName) {
    this.spec.groups = this.spec.groups || [];
    if (!this.spec.groups.includes(groupName)) {
      this.spec.groups.push(groupName);
      this.metadata.generation++;
      this._bumpResourceVersion();
    }
    return this;
  }

  removeGroup(groupName) {
    this.spec.groups = (this.spec.groups || []).filter((group) => group !== groupName);
    this.metadata.generation++;
    this._bumpResourceVersion();
    return this;
  }

  addIdentity(providerName, providerUserName) {
    this.spec.identities = this.spec.identities || [];
    const name = `${providerName}:${providerUserName}`;
    const exists = this.spec.identities.some(
      (identity) =>
        (typeof identity === 'string' ? identity : identity.name) === name ||
        (identity.providerName === providerName && identity.providerUserName === providerUserName)
    );
    if (!exists) {
      this.spec.identities.push({ providerName, providerUserName });
      this.metadata.generation++;
      this._bumpResourceVersion();
    }
    return this;
  }

  getIdentityNames() {
    return this.identities.map((identity) =>
      typeof identity === 'string'
        ? identity
        : `${identity.providerName}:${identity.providerUserName}`
    );
  }

  validate() {
    const result = super.validate();
    if (!Array.isArray(this.spec.groups || []))
      result.errors.push('spec.groups must be an array of group names');
    if (!Array.isArray(this.spec.identities || []))
      result.errors.push('spec.identities must be an array');
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
UID:          ${this.metadata.uid}
Full Name:    ${this.fullName || '<none>'}
Identities:   ${this.getIdentityNames().join(', ') || '<none>'}
Groups:       ${this.groups.join(', ') || '<none>'}
Labels:       ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations:  ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class Group extends ResourceBase {
  constructor(metadata = {}) {
    super('Group', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'user.openshift.io/v1',
    });
    this._initSpec({ users: deepClone(metadata.users || []) }, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  get users() {
    return this.spec.users || [];
  }

  addUser(userName) {
    this.spec.users = this.spec.users || [];
    if (!this.spec.users.includes(userName)) {
      this.spec.users.push(userName);
      this.metadata.generation++;
      this._bumpResourceVersion();
      this.addEvent('Normal', 'UserAdded', `User ${userName} added to group`);
    }
    return this;
  }

  removeUser(userName) {
    this.spec.users = (this.spec.users || []).filter((user) => user !== userName);
    this.metadata.generation++;
    this._bumpResourceVersion();
    this.addEvent('Normal', 'UserRemoved', `User ${userName} removed from group`);
    return this;
  }

  hasUser(userName) {
    return this.users.includes(userName);
  }

  validate() {
    const result = super.validate();
    if (!Array.isArray(this.spec.users || []))
      result.errors.push('spec.users must be an array of user names');
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Created:      ${this.metadata.creationTimestamp}
Labels:       ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations:  ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Users:
${this.users.map((user) => `  ${user}`).join('\n') || '  <none>'}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// Identities are linked to a User whose UID the API records as `spec.user.uid`;
// `deterministicUserUid()` (ManifestSerializer) fills the stable fallback while
// login links the real User UID (#76).
export { deterministicUserUid };

export class Identity extends ResourceBase {
  constructor(metadata = {}) {
    super('Identity', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'user.openshift.io/v1',
    });
    // Identity metadata.name is normally `<provider>:<providerUserName>` on a
    // real cluster (e.g. `htpasswd:alice`); parse it when no explicit values are
    // supplied so palette-created identities are self-consistent.
    const nameParts = String(metadata.name || '').split(':');
    const providerName =
      metadata.providerName || (nameParts.length > 1 ? nameParts[0] : 'htpasswd');
    const providerUserName =
      metadata.providerUserName ||
      (nameParts.length > 1 ? nameParts.slice(1).join(':') : metadata.name || '');
    const userName = metadata.userName || metadata.user?.name || providerUserName || '';
    this._initSpec(
      {
        providerName,
        providerUserName,
        user: {
          name: userName,
          uid: metadata.user?.uid || '',
        },
      },
      metadata.spec
    );
    this.applyAdmissionDefaults();
    this._setInitialStatus({ phase: 'Active' });
  }

  get providerName() {
    return this.spec.providerName || 'htpasswd';
  }

  get providerUserName() {
    return this.spec.providerUserName || '';
  }

  get userName() {
    return this.spec.user?.name || '';
  }

  /** OpenShift Identity resource name: `<provider>:<providerUserName>`. */
  get identityName() {
    return `${this.providerName}:${this.providerUserName}`;
  }

  /**
   * API-server admission for an Identity (#76): it is linked to a User, so
   * `spec.user.uid` is always populated. Login supplies the real User UID
   * (ClusterState.createIdentity); an object that only names its user gets the
   * deterministic fallback. Hidden from `oc get identities` no longer: the CLI
   * prints this value in the USER UID column.
   * GameEngine.applyManifestObject() calls this after installing an applied
   * spec (that path replaces `.spec` wholesale).
   * @returns {this}
   */
  applyAdmissionDefaults() {
    return this._ensureUserUid();
  }

  /**
   * Fill in the linked User UID when the object only referenced the user by
   * name (keeps an explicit/real UID untouched, #76).
   * @returns {this}
   */
  _ensureUserUid() {
    const user = this.spec.user || {};
    this.spec.user = user;
    if (!user.uid && user.name) user.uid = deterministicUserUid(user.name);
    return this;
  }

  linkUser(userName, userUid = '') {
    this.spec.user = {
      name: userName,
      uid: userUid || deterministicUserUid(userName),
    };
    this.metadata.generation++;
    this._bumpResourceVersion();
    return this;
  }

  validate() {
    const result = super.validate();
    if (!this.spec.providerName) result.errors.push('providerName is required');
    if (!this.spec.providerUserName) result.errors.push('providerUserName is required');
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:             ${this.metadata.name}
Provider Name:    ${this.providerName}
Provider Username:${this.providerUserName}
User Name:        ${this.userName || '<none>'}
User UID:         ${this.spec.user?.uid || '<none>'}
Labels:           ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export default { User, Group, Identity };
