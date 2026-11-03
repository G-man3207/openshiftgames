/**
 * RBACEngine.js — OpenShift RBAC + SCC evaluation model for OpenShift Games.
 *
 * Pure, DOM-free helper functions used by `ClusterState` and `GameEngine` to
 * answer `oc auth can-i`, `oc adm policy ...` and SecurityContextConstraint
 * admission questions. Keeping the evaluator separate makes it unit-testable
 * with plain `node --input-type=module` harnesses (no Three.js / DOM needed).
 *
 * Evaluation order for `canI` (matches CONVERSION-SPEC.md §6):
 *   1. kubeadmin / system:admin are always allowed (cluster-admin).
 *   2. ClusterRoleBindings bound to the user, the user's groups or a service
 *      account identity.
 *   3. RoleBindings in the target project (can reference a Role or a
 *      ClusterRole).
 *   4. Built-in cluster roles (`admin`, `edit`, `view`, `self-provisioner`,
 *      `cluster-admin`) are available as fallbacks even when the corresponding
 *      ClusterRole object was not seeded into the simulated cluster.
 *   5. Any authenticated user may create projects (the OpenShift
 *      self-provisioner default binding).
 *
 * Wildcards are supported in verbs (`*`), resources (`*`) and apiGroups (`*`).
 */

import {
  KIND_ALIASES,
  apiVersionForKind,
  isClusterScopedKind,
  normalizeKind,
} from '../data/kindRegistry.js';

/** Users that bypass RBAC checks in the simulator. */
const SYSTEM_ADMIN_USERS = new Set(['kubeadmin', 'system:admin', 'system:cluster-admin']);

const READ_VERBS = ['get', 'list', 'watch'];
const EDIT_VERBS = [...READ_VERBS, 'create', 'update', 'patch', 'delete', 'deletecollection'];

/**
 * Simplified rules for OpenShift's built-in cluster roles. Used when the
 * ClusterRole resource is absent from the simulated cluster (the seed only
 * creates `cluster-admin` explicitly). Resource groups included so that
 * `apiGroups` matching stays realistic.
 * @type {Record<string, Array<{apiGroups?: string[], resources?: string[], verbs?: string[]}>>}
 */
export const BUILTIN_CLUSTER_ROLE_RULES = {
  'cluster-admin': [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }],
  admin: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }],
  edit: [
    {
      apiGroups: [''],
      resources: ['pods', 'pods/attach', 'pods/exec', 'pods/log', 'pods/portforward', 'pods/proxy', 'services', 'services/proxy', 'configmaps', 'secrets', 'persistentvolumeclaims', 'serviceaccounts', 'endpoints', 'events', 'limitranges'],
      verbs: EDIT_VERBS,
    },
    {
      apiGroups: ['apps'],
      resources: ['deployments', 'deployments/scale', 'replicasets', 'replicasets/scale', 'statefulsets', 'statefulsets/scale', 'daemonsets'],
      verbs: EDIT_VERBS,
    },
    { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: EDIT_VERBS },
    { apiGroups: ['route.openshift.io'], resources: ['routes', 'routes/custom-host', 'routes/status'], verbs: EDIT_VERBS },
    { apiGroups: ['build.openshift.io'], resources: ['builds', 'buildconfigs', 'buildlogs'], verbs: EDIT_VERBS },
    { apiGroups: ['image.openshift.io'], resources: ['imagestreams', 'imagestreamtags', 'imagestreamimages'], verbs: EDIT_VERBS },
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies'], verbs: EDIT_VERBS },
    { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: EDIT_VERBS },
    { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: EDIT_VERBS },
    { apiGroups: ['metallb.io'], resources: ['ipaddresspools', 'l2advertisements'], verbs: EDIT_VERBS },
    { apiGroups: ['security.openshift.io'], resources: ['securitycontextconstraints'], verbs: ['get', 'list'] },
  ],
  view: [
    {
      apiGroups: [''],
      resources: ['pods', 'pods/log', 'services', 'configmaps', 'secrets', 'persistentvolumeclaims', 'serviceaccounts', 'endpoints', 'events', 'limitranges'],
      verbs: READ_VERBS,
    },
    { apiGroups: ['apps'], resources: ['deployments', 'replicasets', 'statefulsets', 'daemonsets'], verbs: READ_VERBS },
    { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: READ_VERBS },
    { apiGroups: ['route.openshift.io'], resources: ['routes'], verbs: READ_VERBS },
    { apiGroups: ['build.openshift.io'], resources: ['builds', 'buildconfigs'], verbs: READ_VERBS },
    { apiGroups: ['image.openshift.io'], resources: ['imagestreams', 'imagestreamtags'], verbs: READ_VERBS },
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies'], verbs: READ_VERBS },
    { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: READ_VERBS },
    { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: READ_VERBS },
    { apiGroups: ['metallb.io'], resources: ['ipaddresspools', 'l2advertisements'], verbs: READ_VERBS },
  ],
  'self-provisioner': [
    { apiGroups: ['project.openshift.io'], resources: ['projectrequests', 'projects'], verbs: ['create', 'get', 'list'] },
    { apiGroups: [''], resources: ['namespaces'], verbs: ['create', 'get', 'list'] },
  ],
  'system:image-puller': [
    { apiGroups: ['image.openshift.io'], resources: ['imagestreams/layers'], verbs: READ_VERBS },
    { apiGroups: [''], resources: ['pods/log'], verbs: READ_VERBS },
  ],
};

/** Roles that are always accepted as a `roleRef` even without a resource object. */
export const BUILTIN_ROLE_NAMES = new Set(Object.keys(BUILTIN_CLUSTER_ROLE_RULES));

/** Project-creation resources that self-provisioner covers. */
const PROJECT_CREATION_RESOURCES = new Set(['project', 'projects', 'projectrequest', 'projectrequests', 'namespace', 'namespaces']);

/**
 * Return the API group for a canonical kind ('' for the core group).
 * @param {string} kind
 * @returns {string}
 */
export function apiGroupForKind(kind) {
  const apiVersion = apiVersionForKind(kind);
  if (!apiVersion || !apiVersion.includes('/')) return '';
  return apiVersion.split('/')[0];
}

/**
 * Parse a CLI resource token like `pods`, `deploy`, `securitycontextconstraints`
 * or `scc/privileged` into `{kind, name, subresource, tokens}`.
 * @param {string} resource
 * @returns {{kind: string|null, name: string|null, subresource: string|null, tokens: Set<string>}}
 */
export function parseResourceToken(resource) {
  const raw = String(resource || '').trim();
  const [basePart, second] = raw.split('/');
  const canonical = normalizeKind(basePart) || null;
  const kind = canonical || (basePart ? basePart.charAt(0).toUpperCase() + basePart.slice(1) : null);
  const tokens = new Set();
  if (basePart) {
    tokens.add(basePart.toLowerCase());
    tokens.add(String(kind).toLowerCase());
    tokens.add(`${String(kind).toLowerCase()}s`);
  }
  if (kind) {
    for (const [alias, target] of Object.entries(KIND_ALIASES)) {
      if (target === kind) tokens.add(alias);
    }
  }
  // The second segment of `scc/privileged` may be a name or a subresource.
  const isSubresource = ['exec', 'log', 'logs', 'proxy', 'portforward', 'attach', 'scale', 'status', 'layers'].includes(second);
  return {
    kind,
    name: second && !isSubresource ? second : null,
    subresource: isSubresource ? second : null,
    tokens,
  };
}

/**
 * Does a single RBAC rule allow `verb` on `resource`?
 * Honours `verbs: ['*']`, `resources: ['*']`, `apiGroups: ['*']`, resource
 * subresources and optional `resourceNames`.
 * @param {object} rule
 * @param {string} verb
 * @param {object} parsed - result of {@link parseResourceToken}
 * @returns {boolean}
 */
export function ruleMatches(rule, verb, parsed) {
  if (!rule || typeof rule !== 'object') return false;
  const verbs = rule.verbs || [];
  if (verbs.length > 0 && !verbs.includes('*') && !verbs.includes(verb)) return false;
  if (verbs.length === 0) return false;

  const resources = rule.resources || [];
  let resourceOk = false;
  if (resources.includes('*')) {
    resourceOk = true;
  } else {
    for (const entry of resources) {
      const res = String(entry).toLowerCase();
      if (res.includes('/')) {
        const [base, sub] = res.split('/');
        if (parsed.subresource) {
          const fullToken = `${String(parsed.kind).toLowerCase()}/${sub}`;
          if (res === fullToken || parsed.tokens.has(fullToken)) {
            resourceOk = true;
            break;
          }
        }
      } else if (!parsed.subresource && parsed.tokens.has(res)) {
        resourceOk = true;
        break;
      }
    }
  }
  if (!resourceOk) return false;

  const apiGroups = rule.apiGroups;
  if (Array.isArray(apiGroups) && apiGroups.length > 0) {
    const group = parsed.kind ? apiGroupForKind(parsed.kind) : '';
    if (!apiGroups.includes('*')) {
      const matchesGroup = apiGroups.some((g) => {
        const wanted = String(g || '');
        if (wanted === group) return true;
        // Be forgiving for legacy rules that use the full apiVersion.
        return wanted.includes('/') && wanted.split('/')[0] === group;
      });
      if (!matchesGroup) return false;
    }
  }

  if (Array.isArray(rule.resourceNames) && rule.resourceNames.length > 0) {
    if (!parsed.name || !rule.resourceNames.includes(parsed.name)) return false;
  }
  return true;
}

/**
 * Evaluate an ordered list of RBAC rules.
 * @param {Array<object>} rules
 * @param {string} verb
 * @param {object} parsed
 * @returns {object|null} the matching rule, or null
 */
export function evaluateRules(rules, verb, parsed) {
  for (const rule of rules || []) {
    if (ruleMatches(rule, verb, parsed)) return rule;
  }
  return null;
}

/**
 * Identity information for a user or service account name.
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string} userName
 * @returns {{userName: string, user: object|null, names: Set<string>, groups: Set<string>}}
 */
export function getUserIdentity(cluster, userName) {
  const names = new Set();
  const groups = new Set();
  if (!userName) return { userName: '', user: null, names, groups };

  names.add(userName);
  const user = cluster?.getUser ? cluster.getUser(userName) : cluster?.getByName?.('User', userName, '');
  const spec = user?.spec || {};
  for (const group of spec.groups || []) groups.add(group);

  const groupResources = cluster?.getByKind ? cluster.getByKind('Group') : [];
  for (const group of groupResources) {
    if ((group.spec?.users || []).includes(userName)) groups.add(group.metadata.name);
  }

  if (userName.startsWith('system:serviceaccount:')) {
    const parts = userName.split(':');
    const namespace = parts[2] || '';
    groups.add('system:authenticated');
    groups.add('system:serviceaccounts');
    if (namespace) groups.add(`system:serviceaccounts:${namespace}`);
  } else if (userName !== 'system:anonymous') {
    groups.add('system:authenticated');
  }
  return { userName, user, names, groups };
}

/**
 * Does an RBAC binding subject match the given identity?
 * @param {{kind?: string, name?: string, namespace?: string}} subject
 * @param {ReturnType<typeof getUserIdentity>} identity
 * @param {string} [bindingNamespace] namespace of the enclosing RoleBinding
 * @returns {boolean}
 */
export function subjectMatches(subject, identity, bindingNamespace = '') {
  if (!subject || !subject.kind || !subject.name) return false;
  if (subject.kind === 'User') return identity.names.has(subject.name);
  if (subject.kind === 'Group') return identity.groups.has(subject.name);
  if (subject.kind === 'ServiceAccount') {
    const candidates = [];
    if (subject.namespace) candidates.push(`system:serviceaccount:${subject.namespace}:${subject.name}`);
    if (bindingNamespace) candidates.push(`system:serviceaccount:${bindingNamespace}:${subject.name}`);
    return candidates.some((identityName) => identity.names.has(identityName));
  }
  return false;
}

/**
 * Resolve the rules for a roleRef. Falls back to built-in role rules when the
 * ClusterRole/Role object does not exist in the simulated cluster.
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {{kind?: string, name?: string}} roleRef
 * @param {string} [namespace]
 * @returns {Array<object>}
 */
export function getRoleRules(cluster, roleRef, namespace = '') {
  const roleName = roleRef?.name;
  if (!roleName) return [];
  if (roleRef.kind === 'Role') {
    const role = cluster?.getByName ? cluster.getByName('Role', roleName, namespace) : null;
    if (role) return role.spec?.rules || [];
    return BUILTIN_CLUSTER_ROLE_RULES[roleName] || [];
  }
  const clusterRole = cluster?.getByName ? cluster.getByName('ClusterRole', roleName, '') : null;
  if (clusterRole) return clusterRole.spec?.rules || [];
  return BUILTIN_CLUSTER_ROLE_RULES[roleName] || [];
}

function makeAllowed(reason, extra = {}) {
  return { allowed: true, reason, ...extra };
}

function makeDenied(reason, extra = {}) {
  return { allowed: false, reason, ...extra };
}

/**
 * Core `oc auth can-i` evaluator.
 *
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string} userName
 * @param {string} verb - e.g. get/create/delete/use
 * @param {string} resource - kind, alias, plural or `kind/name`
 * @param {string} [namespace] project/namespace (ignored for cluster-scoped resources)
 * @returns {{allowed: boolean, reason: string, role?: string, binding?: string, namespace?: string}}
 */
export function canI(cluster, userName, verb, resource, namespace) {
  if (!verb || !resource) return makeDenied('invalid authorization request');
  if (!userName) return makeDenied('You must be logged in to the server (Unauthorized)');
  if (SYSTEM_ADMIN_USERS.has(userName)) {
    return makeAllowed('kubeadmin is cluster-admin (system:masters)', { role: 'cluster-admin', binding: 'system:masters' });
  }

  const parsed = parseResourceToken(resource);
  const namespaced = parsed.kind ? !isClusterScopedKind(parsed.kind) : !!namespace;
  const effectiveNamespace = namespaced ? (namespace || 'default') : '';
  const identity = getUserIdentity(cluster, userName);

  /** @param {{kind?: string, name?: string}} roleRef */
  const tryRoleRef = (roleRef, binding) => {
    const rules = getRoleRules(cluster, roleRef, effectiveNamespace);
    const rule = evaluateRules(rules, verb, parsed);
    if (!rule) return null;
    const bindingKind = binding?.kind || (binding?.apiVersion === 'rbac.authorization.k8s.io/v1' ? 'RoleBinding' : 'Binding');
    return makeAllowed(
      `${bindingKind} "${binding?.metadata?.name || binding?.name}" grants ${roleRef.kind || 'ClusterRole'} "${roleRef.name}"`,
      { role: roleRef.name, binding: binding?.metadata?.name || binding?.name }
    );
  };

  // ClusterRoleBindings are cluster-wide.
  const crbs = cluster?.getByKind ? cluster.getByKind('ClusterRoleBinding') : [];
  for (const crb of crbs) {
    const subjects = crb.spec?.subjects || [];
    if (subjects.some((s) => subjectMatches(s, identity, ''))) {
      const result = tryRoleRef(crb.spec?.roleRef || {}, crb);
      if (result) return result;
    }
  }

  // RoleBindings only apply inside their project.
  if (effectiveNamespace) {
    const rbs = cluster?.getByKindAndNamespace ? cluster.getByKindAndNamespace('RoleBinding', effectiveNamespace) : [];
    for (const rb of rbs) {
      const subjects = rb.spec?.subjects || [];
      if (subjects.some((s) => subjectMatches(s, identity, effectiveNamespace))) {
        const result = tryRoleRef(rb.spec?.roleRef || {}, rb);
        if (result) return result;
      }
    }
  }

  // Default OpenShift self-provisioner binding for authenticated users.
  if (identity.groups.has('system:authenticated') && verb === 'create' && PROJECT_CREATION_RESOURCES.has(String(resource).toLowerCase())) {
    return makeAllowed('self-provisioner (clustered default binding to system:authenticated)', {
      role: 'self-provisioner',
      binding: 'self-provisioners',
    });
  }

  const scope = effectiveNamespace ? ` in project "${effectiveNamespace}"` : '';
  return makeDenied(`User "${userName}" cannot ${verb} ${resource}${scope}`, { namespace: effectiveNamespace });
}

/**
 * Flattened permission list used by `oc auth can-i --list`.
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string} userName
 * @param {string} [namespace]
 * @returns {Array<{binding: string, role: string, kind: string, rules: Array<object>}>}
 */
export function listPermissions(cluster, userName, namespace = 'default') {
  const identity = getUserIdentity(cluster, userName);
  /** @type {Map<string, {binding: string, role: string, kind: string, rules: Array<object>}>} */
  const results = new Map();

  const push = (kind, bindingName, roleRef) => {
    const key = `${kind}:${bindingName}:${roleRef.name}`;
    if (results.has(key)) return;
    results.set(key, {
      binding: bindingName,
      role: roleRef.name,
      kind,
      rules: getRoleRules(cluster, roleRef, namespace),
    });
  };

  for (const crb of cluster?.getByKind ? cluster.getByKind('ClusterRoleBinding') : []) {
    const subjects = crb.spec?.subjects || [];
    if (subjects.some((s) => subjectMatches(s, identity, ''))) push('ClusterRoleBinding', crb.metadata.name, crb.spec?.roleRef || {});
  }
  if (namespace) {
    for (const rb of cluster?.getByKindAndNamespace ? cluster.getByKindAndNamespace('RoleBinding', namespace) : []) {
      const subjects = rb.spec?.subjects || [];
      if (subjects.some((s) => subjectMatches(s, identity, namespace))) push('RoleBinding', rb.metadata.name, rb.spec?.roleRef || {});
    }
  }
  return Array.from(results.values());
}

/**
 * Who currently holds `verb` on `resource` in a project? Used by
 * `oc adm policy who-can <verb> <resource>`.
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string} verb
 * @param {string} resource
 * @param {string} [namespace]
 * @returns {Array<{kind: string, name: string}>}
 */
export function whoCan(cluster, verb, resource, namespace = 'default') {
  const parsed = parseResourceToken(resource);
  const namespaced = parsed.kind ? !isClusterScopedKind(parsed.kind) : true;
  const effectiveNamespace = namespaced ? namespace || 'default' : '';
  const found = new Map();

  const collect = (binding, bindingNamespace) => {
    const roleRef = binding.spec?.roleRef || {};
    const rules = getRoleRules(cluster, roleRef, bindingNamespace);
    if (!evaluateRules(rules, verb, parsed)) return;
    for (const subject of binding.spec?.subjects || []) {
      let identityName = '';
      if (subject.kind === 'ServiceAccount') {
        identityName = `system:serviceaccount:${subject.namespace || bindingNamespace}:${subject.name}`;
      } else {
        identityName = subject.name;
      }
      found.set(`${subject.kind}:${identityName}`, { kind: subject.kind, name: identityName });
    }
  };

  for (const crb of cluster?.getByKind ? cluster.getByKind('ClusterRoleBinding') : []) collect(crb, '');
  if (effectiveNamespace) {
    for (const rb of cluster?.getByKindAndNamespace ? cluster.getByKindAndNamespace('RoleBinding', effectiveNamespace) : []) {
      collect(rb, effectiveNamespace);
    }
  }
  return Array.from(found.values());
}

// ─── SecurityContextConstraints ────────────────────────────────────────────

/**
 * All SCCs sorted by admission precedence (priority desc, then name).
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @returns {Array<object>}
 */
const SCC_RESTRICTIVENESS_RANK = {
  'restricted-v3': 0,
  'restricted-v2': 0,
  restricted: 0,
  'nonroot-v2': 1,
  nonroot: 1,
  'hostmount-anyuid': 2,
  anyuid: 2,
  privileged: 3,
};

export function getSCCs(cluster) {
  const sccs = cluster?.getByKind ? cluster.getByKind('SecurityContextConstraints') : [];
  return [...sccs].sort((a, b) => {
    const pa = Number(a.spec?.priority ?? 0);
    const pb = Number(b.spec?.priority ?? 0);
    if (pb !== pa) return pb - pa;
    // Admission tries the most restrictive usable SCC first.
    const rankA = SCC_RESTRICTIVENESS_RANK[a.metadata.name] ?? 2;
    const rankB = SCC_RESTRICTIVENESS_RANK[b.metadata.name] ?? 2;
    if (rankA !== rankB) return rankA - rankB;
    return String(a.metadata.name).localeCompare(String(b.metadata.name));
  });
}

/**
 * All SCCs usable by a service account, sorted by precedence.
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string} namespace
 * @param {string} serviceAccount
 * @returns {Array<object>}
 */
export function getSCCsForServiceAccount(cluster, namespace, serviceAccount) {
  const identity = getUserIdentity(cluster, `system:serviceaccount:${namespace}:${serviceAccount || 'default'}`);
  return getSCCs(cluster).filter((scc) => {
    const users = scc.spec?.users || [];
    const groups = scc.spec?.groups || [];
    if (users.includes(identity.userName)) return true;
    return groups.some((group) => identity.groups.has(group));
  });
}

/**
 * Highest-precedence SCC bound to a service account (or null).
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string} namespace
 * @param {string} serviceAccount
 * @returns {object|null}
 */
export function sccForServiceAccount(cluster, namespace, serviceAccount) {
  return getSCCsForServiceAccount(cluster, namespace, serviceAccount)[0] || null;
}

/**
 * Summarise the security-sensitive parts of a Pod spec.
 * @param {object} podSpec
 * @returns {{privileged: boolean, runAsUsers: number[], hostNetwork: boolean, hostPID: boolean, hostIPC: boolean, hostPorts: number[], hostPath: boolean}}
 */
export function podSecurityRequest(podSpec) {
  const spec = podSpec || {};
  const containers = spec.containers || [];
  const result = {
    privileged: spec.privileged === true,
    runAsUsers: [],
    hostNetwork: spec.hostNetwork === true,
    hostPID: spec.hostPID === true,
    hostIPC: spec.hostIPC === true,
    hostPorts: [],
    hostPath: false,
  };

  const podSc = spec.securityContext || {};
  if (typeof podSc.runAsUser === 'number') result.runAsUsers.push(podSc.runAsUser);

  for (const container of containers) {
    const sc = container?.securityContext || {};
    if (sc.privileged === true) result.privileged = true;
    if (typeof sc.runAsUser === 'number') result.runAsUsers.push(sc.runAsUser);
    for (const port of container?.ports || []) {
      if (port?.hostPort) result.hostPorts.push(port.hostPort);
    }
  }
  for (const volume of spec.volumes || []) {
    if (volume?.hostPath) {
      result.hostPath = true;
      break;
    }
  }
  return result;
}

/**
 * Would `runAsUser: uid` be accepted under an SCC runAsUser strategy?
 * @param {object} runAsUserStrategy
 * @param {number} uid
 * @returns {boolean}
 */
export function runAsUserAllowed(runAsUserStrategy, uid) {
  const strategy = runAsUserStrategy || { type: 'RunAsAny' };
  const type = strategy.type || 'RunAsAny';
  if (type === 'RunAsAny') return true;
  if (type === 'MustRunAsNonRoot') return uid > 0;
  if (type === 'MustRunAsRange') {
    const min = typeof strategy.uidRangeMin === 'number' ? strategy.uidRangeMin : null;
    const max = typeof strategy.uidRangeMax === 'number' ? strategy.uidRangeMax : null;
    if (min === null && max === null) return uid > 0;
    if (min !== null && uid < min) return false;
    if (max !== null && uid > max) return false;
    return true;
  }
  // MustRunAs / unknown: allow non-root UIDs in the simulator.
  return uid !== 0;
}

/**
 * Does an SCC permit the security context requested by a pod spec?
 * @param {object} scc
 * @param {object} podSpec
 * @returns {boolean}
 */
export function sccAllowsPod(scc, podSpec) {
  if (!scc) return false;
  const spec = scc.spec || {};
  const request = podSecurityRequest(podSpec);

  if (request.privileged && !spec.allowPrivilegedContainer) return false;
  if (request.hostNetwork && !spec.allowHostNetwork) return false;
  if (request.hostPID && !spec.allowHostPID) return false;
  if (request.hostIPC && !spec.allowHostIPC) return false;
  if (request.hostPorts.length > 0 && !spec.allowHostPorts) return false;
  if (request.hostPath && !spec.allowHostDirVolumePlugin) return false;

  for (const uid of request.runAsUsers) {
    if (!runAsUserAllowed(spec.runAsUser, uid)) return false;
  }
  return true;
}

/**
 * Resolve the SCC that would admit a Pod (or null when none does).
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {object} pod - Pod resource
 * @returns {{allowed: boolean, scc: object|null, candidates: Array<object>, reason?: string}}
 */
export function resolveSCCForPod(cluster, pod) {
  const namespace = pod?.metadata?.namespace || pod?.namespace || 'default';
  const podSpec = pod?.spec || {};
  const serviceAccount = podSpec.serviceAccountName || podSpec.serviceAccount || 'default';
  const candidates = getSCCsForServiceAccount(cluster, namespace, serviceAccount);
  for (const scc of candidates) {
    if (sccAllowsPod(scc, podSpec)) return { allowed: true, scc, candidates };
  }
  return {
    allowed: false,
    scc: candidates[0] || null,
    candidates,
    reason: 'unable to validate against any security context constraint',
  };
}

/**
 * Normalise an SCC subject (from `oc adm policy add-scc-to-user/-group/-serviceaccount`)
 * into `{kind, name, namespace, entry, subject}`.
 *
 * Accepted inputs: `alice`, `user:alice`, `group:devs`,
 * `system:serviceaccount:demo:builder`, `{kind:'ServiceAccount', name:'builder', namespace:'demo'}`.
 *
 * @param {string|object} subject
 * @param {{kind?: string, namespace?: string}} [options]
 * @returns {{kind: string, name: string, namespace: string, entry: 'users'|'groups', subject: string}}
 */
export function normalizeSCCSubject(subject, options = {}) {
  if (subject && typeof subject === 'object') {
    const kind = subject.kind || options.kind || 'User';
    const name = subject.name || '';
    const namespace = subject.namespace || options.namespace || '';
    if (kind === 'ServiceAccount') {
      return {
        kind,
        name,
        namespace,
        entry: 'users',
        subject: `system:serviceaccount:${namespace || 'default'}:${name}`,
      };
    }
    if (kind === 'Group') return { kind, name, namespace: '', entry: 'groups', subject: `group:${name}` };
    return { kind, name, namespace: '', entry: 'users', subject: name };
  }

  const raw = String(subject || '').trim();
  if (raw.startsWith('system:serviceaccount:')) {
    const parts = raw.split(':');
    return { kind: 'ServiceAccount', name: parts[3] || '', namespace: parts[2] || 'default', entry: 'users', subject: raw };
  }
  if (raw.startsWith('group:')) {
    return { kind: 'Group', name: raw.slice(6), namespace: '', entry: 'groups', subject: `group:${raw.slice(6)}` };
  }
  if (raw.startsWith('user:')) {
    return { kind: 'User', name: raw.slice(5), namespace: '', entry: 'users', subject: raw.slice(5) };
  }
  const kind = options.kind || 'User';
  if (kind === 'ServiceAccount') {
    const namespace = options.namespace || 'default';
    return { kind, name: raw, namespace, entry: 'users', subject: `system:serviceaccount:${namespace}:${raw}` };
  }
  if (kind === 'Group') return { kind, name: raw, namespace: '', entry: 'groups', subject: `group:${raw}` };
  return { kind, name: raw, namespace: '', entry: 'users', subject: raw };
}

export default {
  BUILTIN_CLUSTER_ROLE_RULES,
  BUILTIN_ROLE_NAMES,
  apiGroupForKind,
  parseResourceToken,
  ruleMatches,
  evaluateRules,
  getUserIdentity,
  subjectMatches,
  getRoleRules,
  canI,
  listPermissions,
  whoCan,
  getSCCs,
  getSCCsForServiceAccount,
  sccForServiceAccount,
  podSecurityRequest,
  runAsUserAllowed,
  sccAllowsPod,
  resolveSCCForPod,
  normalizeSCCSubject,
};
