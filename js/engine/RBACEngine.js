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
 *   4. `use securitycontextconstraints/<name>` additionally honours namespaced
 *      RoleBindings (the OCP 4.x `add-scc-to-user -z <sa>` grant model).
 *   5. Built-in cluster roles (`admin`, `edit`, `view`, `self-provisioner`,
 *      `cluster-admin`, `system:openshift:scc:<name>`) are available as
 *      fallbacks even when the corresponding ClusterRole object was not seeded
 *      into the simulated cluster.
 *
 * Project creation is NOT special-cased: a real 4.x cluster seeds the
 * `self-provisioners` ClusterRoleBinding (ClusterRole `self-provisioner` →
 * Group `system:authenticated:oauth`), so removing that subject really does
 * disable `oc new-project` (GitHub issue #3).
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
 * API groups for virtual (non-registry) resource tokens used by the CLI /
 * authorization gate: `projectrequests` (oc new-project), `namespaces`
 * (`oc create namespace`), etc. Keys are lowercase CLI tokens.
 * @type {Record<string, string>}
 */
export const VIRTUAL_RESOURCE_API_GROUPS = {
  projectrequests: 'project.openshift.io',
  projectrequest: 'project.openshift.io',
  projects: 'project.openshift.io',
  namespaces: '',
  namespace: '',
  events: '',
  pods: '',
  services: '',
  serviceaccounts: '',
  secrets: '',
  configmaps: '',
  persistentvolumeclaims: '',
  resourcequotas: '',
  limitranges: '',
  endpoints: '',
  nodes: '',
  users: 'user.openshift.io',
  groups: 'user.openshift.io',
  identities: 'user.openshift.io',
  oauths: 'config.openshift.io',
  'securitycontextconstraints': 'security.openshift.io',
  sccs: 'security.openshift.io',
  scc: 'security.openshift.io',
};

/** Real 4.22 default SCC ClusterRoles: `system:openshift:scc:<name>`. */
const SCC_CLUSTER_ROLE_PREFIX = 'system:openshift:scc:';

/**
 * Synthesise the policy rules of a 4.x SCC ClusterRole
 * (`use securitycontextconstraints.security.openshift.io` with a resourceName).
 * @param {string} roleName
 * @returns {Array<object>|null}
 */
function sccClusterRoleRules(roleName) {
  if (!String(roleName || '').startsWith(SCC_CLUSTER_ROLE_PREFIX)) return null;
  const sccName = String(roleName).slice(SCC_CLUSTER_ROLE_PREFIX.length);
  if (!sccName) return null;
  return [{
    apiGroups: ['security.openshift.io'],
    resources: ['securitycontextconstraints'],
    resourceNames: [sccName],
    verbs: ['use'],
  }];
}

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
    // Real OCP 4.x ClusterRole: `oc new-project` is a ProjectRequest create.
    { apiGroups: ['project.openshift.io'], resources: ['projectrequests'], verbs: ['create'] },
  ],
  'system:image-puller': [
    { apiGroups: ['image.openshift.io'], resources: ['imagestreams/layers'], verbs: READ_VERBS },
    { apiGroups: [''], resources: ['pods/log'], verbs: READ_VERBS },
  ],
};

/** Roles that are always accepted as a `roleRef` even without a resource object. */
export const BUILTIN_ROLE_NAMES = new Set(Object.keys(BUILTIN_CLUSTER_ROLE_RULES));

/**
 * Return the API group for a canonical kind or CLI resource token
 * ('' for the core group). Handles virtual tokens (`projectrequests`,
 * `namespaces`, `oauths`, …) that are not registry kinds.
 * @param {string} kind
 * @returns {string}
 */
export function apiGroupForKind(kind) {
  const key = String(kind || '');
  const lower = key.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(VIRTUAL_RESOURCE_API_GROUPS, lower)) {
    return VIRTUAL_RESOURCE_API_GROUPS[lower];
  }
  const apiVersion = apiVersionForKind(key);
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
    // Users authenticated through the OAuth server (htpasswd/AD/OIDC/…, and
    // kubeadmin's token) also carry the `system:authenticated:oauth` group.
    // Real OCP 4.x seeds `self-provisioners` → Group system:authenticated:oauth.
    groups.add('system:authenticated:oauth');
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
    return BUILTIN_CLUSTER_ROLE_RULES[roleName] || sccClusterRoleRules(roleName) || [];
  }
  const clusterRole = cluster?.getByName ? cluster.getByName('ClusterRole', roleName, '') : null;
  if (clusterRole) return clusterRole.spec?.rules || [];
  return BUILTIN_CLUSTER_ROLE_RULES[roleName] || sccClusterRoleRules(roleName) || [];
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

  // SCC "use" checks are special: the grant may live in a RoleBinding inside the
  // workload's project (`oc adm policy add-scc-to-user <scc> -z <sa> -n <project>`)
  // even though the SCC resource itself is cluster-scoped.
  if (parsed.kind === 'SecurityContextConstraints' && parsed.name && verb === 'use') {
    const namespaceHint = namespace || '';
    if (identityCanUseSCC(cluster, identity, parsed.name, namespaceHint)) {
      return makeAllowed(`SCC "${parsed.name}" granted through an RBAC binding`, {
        role: `${SCC_CLUSTER_ROLE_PREFIX}${parsed.name}`,
        binding: `${SCC_CLUSTER_ROLE_PREFIX}${parsed.name}`,
      });
    }
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
 * Legacy SCC grants: does the SCC's own `spec.users`/`spec.groups` list cover
 * the identity? The seeded default SCCs ship the real 4.22 legacy lists
 * (`restricted-v2` → system:authenticated, `privileged` → system:admin, …);
 * `oc adm policy add-scc-*` never mutates these lists on 4.x.
 * @param {object} scc
 * @param {ReturnType<typeof getUserIdentity>} identity
 * @returns {boolean}
 */
export function legacySCCListAllows(scc, identity) {
  const users = scc?.spec?.users || [];
  const groups = scc?.spec?.groups || [];
  if (users.includes(identity.userName)) return true;
  return groups.some((group) => identity.groups.has(group));
}

/**
 * Does an RBAC binding set (ClusterRoleBindings + the given namespaced
 * RoleBindings) grant `use` on the SCC named `sccName`?
 * OCP 4.x models SCC grants as:
 *  - ClusterRoleBinding → ClusterRole `system:openshift:scc:<name>`
 *    (users/groups, and cluster-wide service-account grants), and/or
 *  - RoleBinding in the workload's project → ClusterRole
 *    `system:openshift:scc:<name>` (the `add-scc-to-user -z <sa>` form).
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {ReturnType<typeof getUserIdentity>} identity
 * @param {string} sccName
 * @param {string} [namespace]
 * @returns {boolean}
 */
export function identityCanUseSCC(cluster, identity, sccName, namespace = '') {
  if (!sccName) return false;
  const parsed = parseResourceToken(`scc/${sccName}`);
  const allows = (binding, bindingNamespace) => {
    const subjects = binding?.spec?.subjects || [];
    if (!subjects.some((subject) => subjectMatches(subject, identity, bindingNamespace))) return false;
    const rules = getRoleRules(cluster, binding.spec?.roleRef || {}, bindingNamespace);
    return Boolean(evaluateRules(rules, 'use', parsed));
  };

  for (const crb of cluster?.getByKind ? cluster.getByKind('ClusterRoleBinding') : []) {
    if (allows(crb, '')) return true;
  }
  const namespaces = namespace ? [namespace] : [namespace].filter(Boolean);
  for (const ns of namespaces) {
    const rbs = cluster?.getByKindAndNamespace ? cluster.getByKindAndNamespace('RoleBinding', ns) : [];
    for (const rb of rbs) {
      if (allows(rb, ns)) return true;
    }
  }
  return false;
}

/**
 * Which SCCs may `userName` (or a `system:serviceaccount:<ns>:<sa>` identity)
 * use? Union of the legacy SCC lists and the 4.x RBAC binding model.
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string} userName
 * @param {string} [namespace]
 * @returns {Array<object>} SCC objects sorted by admission precedence
 */
export function getSCCsForSubject(cluster, userName, namespace = '') {
  const identity = getUserIdentity(cluster, userName);
  const effectiveNamespace = namespace || extractServiceAccountNamespace(userName);
  return getSCCs(cluster).filter((scc) => {
    if (legacySCCListAllows(scc, identity)) return true;
    return identityCanUseSCC(cluster, identity, scc.metadata.name, effectiveNamespace);
  });
}

/** @param {string} userName @returns {string} */
function extractServiceAccountNamespace(userName) {
  const match = String(userName || '').match(/^system:serviceaccount:([^:]+):/);
  return match ? match[1] : '';
}

/**
 * All SCCs usable by a service account, sorted by precedence.
 * Binding-aware: legacy `spec.users/groups` lists + ClusterRoleBindings +
 * the namespaced RoleBinding created by `add-scc-to-user -z <sa>`.
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string} namespace
 * @param {string} serviceAccount
 * @returns {Array<object>}
 */
export function getSCCsForServiceAccount(cluster, namespace, serviceAccount) {
  const identity = getUserIdentity(cluster, `system:serviceaccount:${namespace}:${serviceAccount || 'default'}`);
  return getSCCs(cluster).filter((scc) => {
    if (legacySCCListAllows(scc, identity)) return true;
    return identityCanUseSCC(cluster, identity, scc.metadata.name, namespace);
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
 * Names of the SCCs granted to an arbitrary subject through the 4.x binding
 * model (or the legacy SCC lists). Used by objectives / incident repair
 * detection, so it accepts every spelling the game uses:
 * `system:serviceaccount:<ns>:<sa>`, `user:alice`, `group:devs`, a bare user
 * name or `{kind, name, namespace}`.
 *
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string|object} subject
 * @param {string} [namespace] optional project scope (limits RoleBindings)
 * @returns {string[]} SCC names, sorted
 */
export function getSCCGrantsForSubject(cluster, subject, namespace = '') {
  const parsed = normalizeSCCSubject(subject, { namespace });
  const identityName = parsed.kind === 'ServiceAccount'
    ? `system:serviceaccount:${parsed.namespace || namespace || 'default'}:${parsed.name}`
    : parsed.name;
  const identity = getUserIdentity(cluster, identityName);
  const names = new Set();

  const collectFromBinding = (binding, bindingNamespace) => {
    const roleName = String(binding?.spec?.roleRef?.name || '');
    if (!roleName.startsWith(SCC_CLUSTER_ROLE_PREFIX)) return;
    const sccName = roleName.slice(SCC_CLUSTER_ROLE_PREFIX.length);
    if (!sccName) return;
    const subjects = binding?.spec?.subjects || [];
    if (subjects.some((s) => subjectMatches(s, identity, bindingNamespace))) names.add(sccName);
  };

  for (const crb of cluster?.getByKind ? cluster.getByKind('ClusterRoleBinding') : []) collectFromBinding(crb, '');
  const roleBindings = namespace && cluster?.getByKindAndNamespace
    ? cluster.getByKindAndNamespace('RoleBinding', namespace)
    : (cluster?.getByKind ? cluster.getByKind('RoleBinding') : []);
  for (const rb of roleBindings) collectFromBinding(rb, rb.metadata?.namespace || '');

  // Legacy lists on the SCC objects (seeded 4.22 defaults, e.g. privileged
  // grants system:admin and system:cluster-admins).
  for (const scc of cluster?.getByKind ? cluster.getByKind('SecurityContextConstraints') : []) {
    if (legacySCCListAllows(scc, identity)) names.add(scc.metadata.name);
  }
  return [...names].sort();
}

/**
 * Projects a user may see in `oc get projects` / `oc projects`.
 *
 * The OpenShift project API filters the list to projects the user can access
 * (cluster admins see everything). Plain authenticated users therefore see no
 * projects — and never the `openshift-*` infrastructure projects.
 *
 * @param {import('./ClusterState.js').ClusterState} cluster
 * @param {string} userName
 * @returns {Array<object>} Project resources sorted by name
 */
export function getVisibleProjects(cluster, userName) {
  const projects = cluster?.getProjects ? cluster.getProjects() : [];
  if (!userName) return [];
  if (SYSTEM_ADMIN_USERS.has(userName)) return projects;
  const identity = getUserIdentity(cluster, userName);

  // Cluster-wide read grants: any CRB whose rules allow list/get on projects
  // (e.g. cluster-admin, cluster-reader) sees every project.
  const projectToken = parseResourceToken('projects');
  for (const crb of cluster?.getByKind ? cluster.getByKind('ClusterRoleBinding') : []) {
    const subjects = crb.spec?.subjects || [];
    if (!subjects.some((s) => subjectMatches(s, identity, ''))) continue;
    const rules = getRoleRules(cluster, crb.spec?.roleRef || {}, '');
    if (evaluateRules(rules, 'list', projectToken) || evaluateRules(rules, 'get', projectToken)) return projects;
  }

  // Otherwise a project is visible when the user has a RoleBinding in it (the
  // project-request flow grants the requester `admin` there).
  const visible = projects.filter((project) => {
    const namespace = project.metadata?.name || '';
    const rbs = cluster?.getByKindAndNamespace ? cluster.getByKindAndNamespace('RoleBinding', namespace) : [];
    return rbs.some((rb) => (rb.spec?.subjects || []).some((subject) => subjectMatches(subject, identity, namespace)));
  });
  return visible;
}

/**
 * Summarise the security-sensitive parts of a Pod spec — the explicit
 * requests that SCC admission evaluates.
 * @param {object} podSpec
 * @returns {{privileged: boolean, runAsUsers: number[], hostNetwork: boolean, hostPID: boolean, hostIPC: boolean, hostPorts: number[], hostPath: boolean, allowPrivilegeEscalation: boolean, addedCapabilities: string[]}}
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
    allowPrivilegeEscalation: false,
    addedCapabilities: [],
  };

  const podSc = spec.securityContext || {};
  if (typeof podSc.runAsUser === 'number') result.runAsUsers.push(podSc.runAsUser);
  if (podSc.allowPrivilegeEscalation === true) result.allowPrivilegeEscalation = true;

  // Only *explicit* requests matter: a bare `nginx:latest` (no securityContext)
  // must stay admissible under restricted-v2.
  const collectCapabilities = (sc) => {
    for (const capability of sc?.capabilities?.add || []) {
      if (capability && !result.addedCapabilities.includes(capability)) result.addedCapabilities.push(capability);
    }
  };
  collectCapabilities(podSc);

  for (const container of containers) {
    const sc = container?.securityContext || {};
    if (sc.privileged === true) result.privileged = true;
    if (typeof sc.runAsUser === 'number') result.runAsUsers.push(sc.runAsUser);
    if (sc.allowPrivilegeEscalation === true) result.allowPrivilegeEscalation = true;
    collectCapabilities(sc);
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
  if (request.allowPrivilegeEscalation && spec.allowPrivilegeEscalation !== true) return false;

  // Explicit `capabilities.add`: only the SCC's allowedCapabilities pass.
  if (request.addedCapabilities.length > 0) {
    const allowed = new Set([...(spec.allowedCapabilities || [])]);
    for (const capability of request.addedCapabilities) {
      if (allowed.has('*') || allowed.has(capability)) continue;
      return false;
    }
  }

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
  VIRTUAL_RESOURCE_API_GROUPS,
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
  getVisibleProjects,
  getSCCs,
  legacySCCListAllows,
  identityCanUseSCC,
  getSCCsForSubject,
  getSCCsForServiceAccount,
  getSCCGrantsForSubject,
  sccForServiceAccount,
  podSecurityRequest,
  runAsUserAllowed,
  sccAllowsPod,
  resolveSCCForPod,
  normalizeSCCSubject,
};
