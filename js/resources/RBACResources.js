import { ResourceBase } from './ResourceBase.js';
import { deepClone } from './ManifestSerializer.js';

const RBAC_API_GROUP = 'rbac.authorization.k8s.io';

export class ServiceAccount extends ResourceBase {
  constructor(metadata = {}) {
    super('ServiceAccount', { ...metadata, apiVersion: metadata.apiVersion || 'v1' });
    const defaults = {
      secrets: deepClone(metadata.secrets || []),
      imagePullSecrets: deepClone(metadata.imagePullSecrets || []),
      automountServiceAccountToken: metadata.automountServiceAccountToken !== false,
    };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  get secrets() {
    return this.spec.secrets || [];
  }

  get imagePullSecrets() {
    return this.spec.imagePullSecrets || [];
  }

  get automountServiceAccountToken() {
    return this.spec.automountServiceAccountToken !== false;
  }

  addSecret(secretName) {
    this.spec.secrets = this.spec.secrets || [];
    if (!this.spec.secrets.some((s) => (typeof s === 'string' ? s : s.name) === secretName)) {
      this.spec.secrets.push({ name: secretName });
      this.addEvent('Normal', 'SecretAdded', `Secret ${secretName} added`);
    }
    return this;
  }

  removeSecret(secretName) {
    this.spec.secrets = (this.spec.secrets || []).filter(
      (s) => (typeof s === 'string' ? s : s.name) !== secretName
    );
    return this;
  }

  toDescribe() {
    return `Name:                ${this.metadata.name}
Namespace:           ${this.metadata.namespace}
Labels:              ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:         ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Image pull secrets:  ${this.imagePullSecrets.map((s) => s.name || s).join(', ') || '<none>'}
Mountable secrets:   ${this.secrets.map((s) => s.name || s).join(', ') || '<none>'}
Tokens:              ${this.secrets
      .map((s) => s.name || s)
      .filter((name) => String(name).includes('token'))
      .join(', ') || '<none>'}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

class PolicyRulesResource extends ResourceBase {
  get rules() {
    return this.spec.rules || [];
  }

  set rules(value) {
    this.spec.rules = value;
  }

  addRule(apiGroups, resources, verbs, extra = {}) {
    this.spec.rules = this.spec.rules || [];
    this.spec.rules.push({
      apiGroups: Array.isArray(apiGroups) ? apiGroups : [apiGroups],
      resources: Array.isArray(resources) ? resources : [resources],
      verbs: Array.isArray(verbs) ? verbs : [verbs],
      ...extra,
    });
    this.metadata.generation++;
    this._bumpResourceVersion();
    this.addEvent('Normal', 'RuleAdded', `Rule added: ${verbs} on ${resources}`);
    return this;
  }

  removeRule(index) {
    if (index >= 0 && index < (this.spec.rules || []).length) {
      this.spec.rules.splice(index, 1);
      this.metadata.generation++;
      this._bumpResourceVersion();
    }
    return this;
  }

  hasWildcard() {
    return (this.spec.rules || []).some(
      (rule) =>
        rule.verbs?.includes('*') || rule.resources?.includes('*') || rule.apiGroups?.includes('*')
    );
  }

  _rulesDescribe() {
    return `PolicyRule:
  Resources           Verbs             API Groups
  ---------           -----             ----------
${(this.spec.rules || [])
  .map(
    (rule) =>
      `  ${(rule.resources || []).join(', ').padEnd(20)} ${(rule.verbs || []).join(', ').padEnd(18)} ${(rule.apiGroups || ['']).join(', ')}`
  )
  .join('\n')}`;
  }
}

export class Role extends PolicyRulesResource {
  constructor(metadata = {}) {
    super('Role', { ...metadata, apiVersion: metadata.apiVersion || `${RBAC_API_GROUP}/v1` });
    this._initSpec({ rules: deepClone(metadata.rules || []) }, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Namespace:    ${this.metadata.namespace}
Labels:       ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:  ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
${this._rulesDescribe()}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

export class ClusterRole extends PolicyRulesResource {
  constructor(metadata = {}) {
    super('ClusterRole', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || `${RBAC_API_GROUP}/v1`,
    });
    const defaults = { rules: deepClone(metadata.rules || []) };
    if (metadata.aggregationRule) defaults.aggregationRule = deepClone(metadata.aggregationRule);
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Labels:       ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:  ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
${this._rulesDescribe()}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

function makeSubject(kind, name, namespace) {
  const subject = { kind, name };
  if (kind === 'ServiceAccount') {
    subject.namespace = namespace || undefined;
  } else {
    subject.apiGroup = RBAC_API_GROUP;
  }
  return subject;
}

class BindingResource extends ResourceBase {
  get roleRef() {
    return this.spec.roleRef;
  }

  get subjects() {
    return this.spec.subjects || [];
  }

  set subjects(value) {
    this.spec.subjects = value;
  }

  addSubject(kind, name, namespace) {
    this.spec.subjects = this.spec.subjects || [];
    const subject = makeSubject(kind, name, namespace);
    const exists = this.spec.subjects.some(
      (s) => s.kind === subject.kind && s.name === subject.name && (s.namespace || '') === (subject.namespace || '')
    );
    if (!exists) {
      if (subject.namespace === undefined) delete subject.namespace;
      this.spec.subjects.push(subject);
      this.metadata.generation++;
      this._bumpResourceVersion();
      this.addEvent('Normal', 'SubjectAdded', `Subject ${kind}/${name} added`);
    }
    return this;
  }

  removeSubject(name, kind) {
    this.spec.subjects = (this.spec.subjects || []).filter(
      (s) => !(s.name === name && (!kind || s.kind === kind))
    );
    this.metadata.generation++;
    this._bumpResourceVersion();
    return this;
  }

  _bindingDescribe() {
    return `Role:
  Kind:       ${this.spec.roleRef?.kind}
  Name:       ${this.spec.roleRef?.name}
Subjects:
  Kind              Name              Namespace
  ----              ----              ---------
${(this.spec.subjects || [])
  .map(
    (s) => `  ${(s.kind || '').padEnd(18)} ${(s.name || '').padEnd(18)} ${s.namespace || ''}`
  )
  .join('\n')}`;
  }
}

export class RoleBinding extends BindingResource {
  constructor(metadata = {}) {
    super('RoleBinding', { ...metadata, apiVersion: metadata.apiVersion || `${RBAC_API_GROUP}/v1` });
    const defaults = {
      roleRef: {
        apiGroup: RBAC_API_GROUP,
        kind: metadata.roleRefKind || 'Role',
        name: metadata.roleRefName || metadata.roleName || '',
      },
      subjects: deepClone(metadata.subjects || []),
    };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Namespace:    ${this.metadata.namespace}
Labels:       ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:  ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
${this._bindingDescribe()}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

export class ClusterRoleBinding extends BindingResource {
  constructor(metadata = {}) {
    super('ClusterRoleBinding', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || `${RBAC_API_GROUP}/v1`,
    });
    const defaults = {
      roleRef: {
        apiGroup: RBAC_API_GROUP,
        kind: metadata.roleRefKind || 'ClusterRole',
        name: metadata.roleRefName || metadata.roleName || '',
      },
      subjects: deepClone(metadata.subjects || []),
    };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Labels:       ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:  ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
${this._bindingDescribe()}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

export { RBAC_API_GROUP, PolicyRulesResource, BindingResource };
export default { ServiceAccount, Role, ClusterRole, RoleBinding, ClusterRoleBinding };
