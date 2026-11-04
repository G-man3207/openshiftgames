/**
 * ObjectiveEvaluator — single, reusable implementation of every campaign /
 * challenge objective type in CONVERSION-SPEC §9.
 *
 * Imported by `js/modes/CampaignMode.js` (campaign) and by
 * `js/modes/ChallengeMode.js` (challenges, modes-dev integration).
 *
 * Contract (CONVERSION-SPEC §13):
 *   evaluateObjective(obj, ctx) -> { completed, current, target }
 *   ctx = { clusterState, gameEngine, incidentEngine, scoringEngine, manifestEngine }
 *
 * Everything is defensive: the engine is being built in parallel with these
 * objectives, so every optional API is feature-detected and every evaluator
 * falls back to a no-op "not completed" state rather than throwing. A bad
 * objective must never brick a level or crash the per-second tick.
 *
 * Read-heavy by design: objectives observe simulated cluster state and (for
 * declarative actions) ManifestEngine records / command history. Nothing here
 * mutates the cluster.
 */

import { normalizeKind } from '../data/kindRegistry.js';

/** Objective types implemented by this module (CONVERSION-SPEC §9). */
export const OBJECTIVE_TYPES = [
  'deploy',
  'scale',
  'replicas',
  'project',
  'login',
  'user',
  'group',
  'canI',
  'serviceType',
  'connect',
  'route',
  'tls',
  'build',
  'imageStream',
  'image',
  'template',
  'helm',
  'kustomize',
  'manifest',
  'operator',
  'scc',
  'privileged',
  'quota',
  'limitRange',
  'clusterQuota',
  'complete',
  'cronJob',
  'mount',
  'envFrom',
  'noConfigMap',
  'resources',
  'probes',
  'hpa',
  'pdb',
  'bound',
  'headless',
  'stable',
  'leastPrivilege',
  'distribute',
  'coverage',
  'update',
  'rollback',
  'resolve',
  'investigate',
  'uptime',
  'clusterHealth',
  'reschedule',
  'nodeSelector',
  'taint',
  'command',
  'examScore',
  'architectureScore',
  // Extension: `label` appears in the level-2 curriculum prose in §9 even
  // though it is missing from the type list. Implemented as a state check so
  // "work with labels and selectors" is actually exercised.
  'label',
];

/** Types whose natural display is a simple done/not-done flag. */
const BOOLEAN_TYPES = new Set([
  'project', 'login', 'user', 'group', 'canI', 'connect', 'route', 'tls',
  'imageStream', 'image', 'template', 'helm', 'kustomize', 'manifest',
  'operator', 'scc', 'privileged', 'quota', 'limitRange', 'clusterQuota',
  'cronJob', 'mount', 'envFrom', 'noConfigMap', 'resources', 'probes',
  'stable', 'leastPrivilege', 'update', 'rollback', 'resolve', 'investigate',
  'uptime', 'clusterHealth', 'reschedule', 'nodeSelector', 'taint',
  'examScore', 'architectureScore', 'label',
]);

const ADMIN_USERS = new Set(['kubeadmin', 'system:admin', 'system:cluster-admin']);
const ADMIN_GROUPS = new Set(['system:masters', 'system:cluster-admins']);
const SENSITIVE_CONFIGMAP_KEY = /password|passwd|secret|token|key|credential/i;

// ─── small utilities ───────────────────────────────────────────────────────

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function currentWindow() {
  return typeof window !== 'undefined' ? window : null;
}

function canonicalKind(kind) {
  if (kind === undefined || kind === null || kind === '') return '';
  const str = String(kind);
  let normalized = null;
  try {
    normalized = normalizeKind(str);
  } catch {
    normalized = null;
  }
  if (normalized) return normalized;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function resourceName(resource) {
  return resource?.metadata?.name || resource?.name || '';
}

function resourceNamespace(resource) {
  return resource?.metadata?.namespace || resource?.namespace || '';
}

function resourceSpec(resource) {
  return resource?.spec && typeof resource.spec === 'object' ? resource.spec : {};
}

function resourceStatus(resource) {
  return resource?.status && typeof resource.status === 'object' ? resource.status : {};
}

function resourceLabels(resource) {
  const labels = resource?.metadata?.labels || resource?.labels;
  return labels && typeof labels === 'object' ? labels : {};
}

function getTotal(stats) {
  if (!stats || typeof stats !== 'object') return 0;
  const total = stats.totalObjectives ?? stats.total;
  return asNumber(total, 0);
}

// ─── context resolution ────────────────────────────────────────────────────

/**
 * Resolve the evaluation context. Callers should pass a full ctx (CampaignMode
 * and ChallengeMode do); browser consumers of `window.game` are supported as a
 * fallback, and Node harnesses can pass any subset.
 *
 * @param {object} [ctx]
 * @returns {{gameEngine: object|null, clusterState: object|null,
 *   incidentEngine: object|null, scoringEngine: object|null,
 *   manifestEngine: object|null, objectiveProgress: Array|null,
 *   levelDef: object|null, raw: object}}
 */
export function resolveContext(ctx = {}) {
  const win = currentWindow();
  const shared = win?.game && typeof win.game === 'object' ? win.game : {};
  const gameEngine = ctx.gameEngine || shared.gameEngine || null;
  const clusterState = ctx.clusterState || gameEngine?.cluster || shared.cluster || null;
  const incidentEngine = ctx.incidentEngine || shared.incidentEngine || null;
  const scoringEngine = ctx.scoringEngine || shared.scoringEngine || null;
  const manifestEngine =
    ctx.manifestEngine || gameEngine?.manifestEngine || shared.manifestEngine || null;
  return {
    gameEngine,
    clusterState,
    incidentEngine,
    scoringEngine,
    manifestEngine,
    objectiveProgress: Array.isArray(ctx.objectiveProgress) ? ctx.objectiveProgress : null,
    levelDef: ctx.levelDef || null,
    raw: ctx,
  };
}

// ─── resource readers (feature-detected) ──────────────────────────────────

function getAllResources(cluster) {
  if (!cluster) return [];
  try {
    if (typeof cluster.getAllResources === 'function') return asArray(cluster.getAllResources());
    if (typeof cluster.getResources === 'function') return asArray(cluster.getResources());
    if (cluster.resources && typeof cluster.resources.values === 'function') {
      return [...cluster.resources.values()];
    }
  } catch {
    /* ignore */
  }
  return [];
}

/** All resources of a canonical kind. */
export function listKind(cluster, kind) {
  const canonical = canonicalKind(kind);
  if (!canonical || !cluster) return [];
  try {
    if (typeof cluster.getResourcesByKind === 'function') {
      return asArray(cluster.getResourcesByKind(canonical));
    }
  } catch {
    /* fall through to full scan */
  }
  return getAllResources(cluster).filter((resource) => resource?.kind === canonical);
}

function listKinds(cluster, kinds) {
  const out = [];
  for (const kind of asArray(kinds)) out.push(...listKind(cluster, kind));
  return out;
}

/** Find a resource by kind/name (any namespace unless `namespace` given). */
export function findResource(cluster, kind, name, namespace) {
  if (!cluster || !name) return null;
  const canonical = canonicalKind(kind);
  try {
    if (typeof cluster.getByName === 'function') {
      const direct = cluster.getByName(canonical, name, namespace || undefined);
      if (direct) return direct;
    }
  } catch {
    /* ignore */
  }
  const needle = String(name);
  return (
    listKind(cluster, canonical).find((resource) => {
      if (resourceName(resource) !== needle) return false;
      if (namespace && resourceNamespace(resource) !== namespace) return false;
      return true;
    }) || null
  );
}

function findByPrefix(cluster, kind, needle) {
  const value = String(needle || '');
  if (!value) return null;
  return (
    listKind(cluster, kind).find((resource) => resourceName(resource).includes(value)) || null
  );
}

/** Containers for Pod-like objects, resolving the spec.template path correctly. */
export function containersOf(resource) {
  if (!resource) return [];
  const spec = resourceSpec(resource);
  if (resource.kind === 'Pod') return asArray(spec.containers);
  if (resource.kind === 'CronJob') {
    return asArray(spec.jobTemplate?.spec?.template?.spec?.containers);
  }
  const fromTemplate = spec.template?.spec?.containers;
  if (Array.isArray(fromTemplate)) return fromTemplate;
  return asArray(spec.containers);
}

function podTemplateSpecOf(resource) {
  if (!resource) return null;
  const spec = resourceSpec(resource);
  if (resource.kind === 'Pod') return spec;
  if (resource.kind === 'CronJob') return spec.jobTemplate?.spec?.template?.spec || null;
  return spec.template?.spec || null;
}

function podTemplateLabelsOf(resource) {
  if (!resource) return {};
  const spec = resourceSpec(resource);
  if (resource.kind === 'Pod') return resourceLabels(resource);
  if (resource.kind === 'CronJob') {
    return spec.jobTemplate?.spec?.template?.metadata?.labels || {};
  }
  return spec.template?.metadata?.labels || resourceLabels(resource);
}

function getCurrentProject(c) {
  return c.gameEngine?.currentProject || 'default';
}

/**
 * The single Project a level seeds (when unambiguous). Used to scope objectives
 * that were authored without a namespace: a level whose lab project is
 * `rbac-lab`/`manifests-lab`/… must be completed in that project, not in the
 * player's current project. Returns null for levels that seed 0 or 2+ Projects
 * (e.g. the capstone or challenges where the player creates the project).
 */
function levelProjectNamespace(c) {
  const resources = asArray(c?.levelDef?.startingResources);
  const projects = resources.filter((resource) => resource && resource.kind === 'Project' && resource.name);
  return projects.length === 1 ? projects[0].name : null;
}

/**
 * Kinds that almost always live in the level's lab project. Used only as a
 * fallback when the objective data does not carry a namespace. Config object
 * kinds (Secret/ConfigMap) are deliberately excluded because they may belong to
 * a shared namespace such as openshift-config.
 */
const LEVEL_SCOPED_KINDS = new Set([
  'Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'ReplicaSet', 'Service',
  'Route', 'Job', 'CronJob', 'Build', 'BuildConfig', 'ImageStream',
  'ServiceAccount', 'ResourceQuota', 'LimitRange', 'NetworkPolicy', 'Template',
]);

function objectiveResourceNamespace(c, obj, kind = null) {
  if (obj?.namespace) return obj.namespace;
  const canonical = kind || canonicalKind(obj?.kind || '');
  if (!LEVEL_SCOPED_KINDS.has(canonical)) return null;
  return levelProjectNamespace(c);
}

/** Store a lazy per-objective baseline the first time an objective is evaluated. */
function ensureBaseline(objective, factory) {
  if (!objective._baseline || typeof objective._baseline !== 'object') {
    try {
      objective._baseline = factory();
    } catch {
      objective._baseline = {};
    }
  }
  return objective._baseline;
}

/** Stable-ish fingerprint of a workload pod template (change detection). */
function templateFingerprint(resource) {
  try {
    return JSON.stringify(resourceSpec(resource).template || {});
  } catch {
    return '';
  }
}

/**
 * Incident activity for "restore/keep health" objectives.
 * `activationCount` is incremented by IncidentEngine when an incident first
 * activates; level start resets it, so objectives cannot be satisfied before
 * the level's incident has actually happened.
 */
function incidentActivity(c) {
  // Only level/challenge evaluation is gated; standalone objective checks that
  // pass a bare ctx keep the historical behaviour.
  if (!c.levelDef) return null;
  const engine = c.incidentEngine;
  if (!engine) return null;
  const stats = (() => {
    try {
      return typeof engine.getStats === 'function' ? engine.getStats() : {};
    } catch {
      return {};
    }
  })();
  const activations = asNumber(
    engine.activationCount ?? stats.totalActivated ?? stats.totalResolved,
    -1
  );
  if (activations < 0) return null;
  const active = activeIncidents(c).length;
  return { activations, active };
}

function quantityMatches(actual, expected) {
  if (actual === undefined || actual === null) return false;
  const left = String(actual).trim();
  const right = String(expected).trim();
  if (left === right) return true;
  const leftNum = Number(left);
  const rightNum = Number(right);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) return leftNum === rightNum;
  return left.toLowerCase() === right.toLowerCase();
}

function subsetMatches(actual, expected) {
  if (!expected || typeof expected !== 'object') return true;
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => quantityMatches(actual[key], value));
}

// ─── result helpers ────────────────────────────────────────────────────────

/** @typedef {{completed: boolean, current: number, target: number}} ObjectiveResult */

function result(completed, current, target) {
  const safeTarget = asNumber(target, 1);
  return {
    completed: Boolean(completed),
    current: asNumber(current, 0),
    target: safeTarget > 0 ? safeTarget : 1,
  };
}

/** Boolean objective: shows 0/1 or 1/1 progress. */
function bool(completed) {
  return result(completed, completed ? 1 : 0, 1);
}

function incomplete(count = 1) {
  return result(false, 0, asNumber(count, 1) || 1);
}

function typeIsBoolean(type) {
  return BOOLEAN_TYPES.has(type);
}

// ─── declarative (ManifestEngine) readers ─────────────────────────────────

function manifestState(c) {
  if (!c.manifestEngine) return null;
  try {
    if (typeof c.manifestEngine.getState === 'function') return c.manifestEngine.getState();
  } catch {
    /* ignore */
  }
  return null;
}

function normalizePath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '') || '.';
}

function pathEquals(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function appliedFiles(state) {
  return asArray(state?.appliedFiles);
}

function appliedKustomize(state) {
  return asArray(state?.appliedKustomize);
}

function appliedTemplates(state) {
  return asArray(state?.templates);
}

function helmReleases(state) {
  return asArray(state?.helmReleases || state?.helm);
}

function commandHistory(c) {
  const engine = c.gameEngine;
  if (!engine) return [];
  try {
    if (typeof engine.getCommandHistory === 'function') return asArray(engine.getCommandHistory());
  } catch {
    /* ignore */
  }
  if (Array.isArray(engine._commandHistory)) return engine._commandHistory;
  return [];
}

function matchCommands(c, pattern, options = {}) {
  const rawPattern = pattern instanceof RegExp ? pattern.source : String(pattern || '');
  const flags = pattern instanceof RegExp ? pattern.flags : 'i';
  let regex;
  try {
    regex = new RegExp(rawPattern, flags);
  } catch {
    return [];
  }
  const successOnly = options.successOnly !== false;
  return commandHistory(c).filter((entry) => {
    if (!entry || typeof entry.raw !== 'string') return false;
    if (successOnly && entry.success === false) return false;
    return regex.test(entry.raw);
  });
}

function hasAppliedFile(c, file) {
  const state = manifestState(c);
  if (!state) return matchCommands(c, `apply\\s+(-f|--filename(=|\\s+))\\s*\\S*${escapeRegex(String(file || ''))}`).length > 0;
  return appliedFiles(state).some((entry) => pathEquals(entry?.path || entry?.source, file));
}

function hasAppliedKustomize(c, path) {
  const state = manifestState(c);
  const target = path || '.';
  if (!state) {
    return matchCommands(c, `apply\\s+(-k|--kustomize(=|\\s+))\\s*\\S*${escapeRegex(target)}`).length > 0;
  }
  return appliedKustomize(state).some((entry) => pathEquals(entry?.path, target));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── incident readers ──────────────────────────────────────────────────────

function activeIncidents(c) {
  const engine = c.incidentEngine;
  if (!engine) return [];
  try {
    if (typeof engine.getActiveIncidents === 'function') return asArray(engine.getActiveIncidents());
  } catch {
    /* ignore */
  }
  if (engine.activeIncidents && typeof engine.activeIncidents.values === 'function') {
    return [...engine.activeIncidents.values()];
  }
  return [];
}

function resolvedIncidents(c) {
  const engine = c.incidentEngine;
  if (!engine) return [];
  if (Array.isArray(engine.resolvedIncidents)) return engine.resolvedIncidents;
  return [];
}

function incidentName(incident) {
  return incident?.name || incident?.def?.name || incident?.type || '';
}

function matchesIncident(incident, wanted) {
  if (!wanted) return true;
  const name = String(incidentName(incident));
  return name === wanted || name.toLowerCase() === String(wanted).toLowerCase();
}

function clusterHealthPercent(c) {
  try {
    const engine = c.incidentEngine;
    if (engine && typeof engine.getClusterHealth === 'function') {
      return asNumber(engine.getClusterHealth(), 100);
    }
  } catch {
    /* ignore */
  }
  return 100;
}

// ─── architectural score ───────────────────────────────────────────────────

function architectureTotal(c) {
  const engine = c.scoringEngine;
  if (!engine || !c.clusterState) return 0;
  try {
    if (typeof engine.calculateArchitectureScore === 'function') {
      const score = engine.calculateArchitectureScore(c.clusterState);
      return asNumber(score?.total, 0);
    }
  } catch {
    /* ignore */
  }
  return 0;
}

function objectivesCompletionPercent(c, excludeTypes = new Set()) {
  const progress = c.objectiveProgress;
  if (!Array.isArray(progress) || progress.length === 0) return null;
  const relevant = progress.filter((objective) => !excludeTypes.has(String(objective?.type || '').toLowerCase()));
  if (relevant.length === 0) return null;
  const done = relevant.filter((objective) => objective?.completed).length;
  return (done / relevant.length) * 100;
}

// ─── individual objective evaluators ──────────────────────────────────────


/**
 * The standard project-admin RoleBinding created automatically when a Project
 * is provisioned (project template / requester: `RoleBinding admin` granting
 * `ClusterRole admin` to the requester User). It is infrastructure, not the
 * learner's work, so it must not satisfy campaign "create a RoleBinding"
 * objectives (L14/L16).
 */
function isAutoProvisionedProjectAdminBinding(binding) {
  if (!binding) return false;
  const name = resourceName(binding);
  if (name !== 'admin') return false;
  const spec = resourceSpec(binding);
  const roleRef = spec.roleRef || {};
  if (roleRef.kind !== 'ClusterRole' || roleRef.name !== 'admin') return false;
  return asArray(spec.subjects).some((subject) => subject && subject.kind === 'User');
}

function evaluateDeploy(obj, c) {
  const kind = canonicalKind(obj.kind);
  const name = obj.name;
  const namespace = objectiveResourceNamespace(c, obj, kind);
  if (name) return bool(Boolean(findResource(c.clusterState, kind, name, namespace)));
  let resources = listKind(c.clusterState, kind);
  if (namespace) resources = resources.filter((resource) => resourceNamespace(resource) === namespace);
  // Count-only RBAC objectives ("bind a role in <project>") must be scoped to
  // the level's project; otherwise any RoleBinding anywhere in the cluster counts.
  if (!namespace && kind === 'RoleBinding') {
    const expected = levelProjectNamespace(c);
    if (expected) resources = resources.filter((resource) => resourceNamespace(resource) === expected);
  }
  // The auto-provisioned project `admin` binding is not learner-created: ignore
  // it for every RoleBinding-count objective (L14/L16) so the checklist still
  // requires a real `oc adm policy add-role-to-*`/RoleBinding manifest.
  if (kind === 'RoleBinding') {
    resources = resources.filter((resource) => !isAutoProvisionedProjectAdminBinding(resource));
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  const current = Math.min(resources.length, target);
  return result(resources.length >= target, current, target);
}

function evaluateLabel(obj, c) {
  const kind = canonicalKind(obj.kind);
  const name = obj.name;
  const key = obj.key || obj.label;
  const value = obj.value;
  if (!key) return bool(false);
  const namespace = objectiveResourceNamespace(c, obj, kind);
  let resources = listKind(c.clusterState, kind);
  if (name) resources = resources.filter((resource) => resourceName(resource) === name);
  if (namespace) resources = resources.filter((resource) => resourceNamespace(resource) === namespace);
  const matches = (resource) => {
    const labels = resourceLabels(resource);
    if (!hasOwn(labels, key)) return false;
    return value === undefined || String(labels[key]) === String(value);
  };
  const matching = resources.filter(matches);
  // Do not credit a label that was already present when the level started:
  // require either a label applied during this level (resourceVersion change)
  // or a matching resource created during this level.
  const baseline = ensureBaseline(obj, () => ({
    matchedAtStart: matching.length > 0,
    versions: Object.fromEntries(
      resources.map((resource) => [
        resource?.uid || resourceName(resource),
        String(resource?.metadata?.resourceVersion || ''),
      ])
    ),
  }));
  const changed = matching.some((resource) => {
    const keyId = resource?.uid || resourceName(resource);
    if (!Object.prototype.hasOwnProperty.call(baseline.versions, keyId)) return true;
    return String(resource?.metadata?.resourceVersion || '') !== baseline.versions[keyId];
  });
  return bool(matching.length > 0 && (!baseline.matchedAtStart || changed));
}

function evaluateScale(obj, c) {
  const kind = canonicalKind(obj.kind || 'Deployment');
  const replicas = Math.max(1, asNumber(obj.replicas, 1));
  let resources = listKind(c.clusterState, kind);
  if (obj.name) resources = resources.filter((resource) => resourceName(resource) === obj.name);
  const scaleNamespace = objectiveResourceNamespace(c, obj, kind);
  if (scaleNamespace) resources = resources.filter((resource) => resourceNamespace(resource) === scaleNamespace);
  if (resources.length === 0) return result(false, 0, replicas);
  const maxReplicas = Math.max(...resources.map((resource) => asNumber(resourceSpec(resource).replicas, 0)));
  return result(maxReplicas >= replicas, Math.min(maxReplicas, replicas), replicas);
}

function evaluateReplicas(obj, c) {
  const minPerDeployment = Math.max(1, asNumber(obj.minPerDeployment, 1));
  const deployments = listKind(c.clusterState, 'Deployment');
  if (deployments.length === 0) return result(false, 0, 1);
  const compliant = deployments.filter(
    (deployment) => asNumber(resourceSpec(deployment).replicas, 0) >= minPerDeployment
  ).length;
  return result(compliant === deployments.length, compliant, deployments.length);
}

function evaluateProject(obj, c) {
  const projects = listKind(c.clusterState, 'Project');
  const active = projects.filter((project) => {
    const phase = resourceStatus(project).phase;
    return !phase || phase === 'Active';
  });
  if (obj.name) {
    const match = active.find((project) => resourceName(project) === obj.name);
    return bool(Boolean(match));
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(active.length >= target, Math.min(active.length, target), target);
}

function evaluateLogin(obj, c) {
  const currentUser = c.gameEngine?.currentUser || null;
  if (obj.user) return bool(currentUser === obj.user);
  return bool(Boolean(currentUser));
}

function evaluateUser(obj, c) {
  const users = listKind(c.clusterState, 'User');
  if (obj.name) {
    return bool(users.some((user) => resourceName(user) === obj.name));
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(users.length >= target, Math.min(users.length, target), target);
}

function groupUsers(group) {
  if (!group) return [];
  const spec = resourceSpec(group);
  if (Array.isArray(spec.users)) return spec.users;
  if (typeof group.users === 'object') return asArray(group.users);
  const status = resourceStatus(group);
  return asArray(status.users);
}

function evaluateGroup(obj, c) {
  const groups = listKind(c.clusterState, 'Group');
  if (obj.name) {
    const group = groups.find((candidate) => resourceName(candidate) === obj.name);
    if (!group) return bool(false);
    const wantedUsers = asArray(obj.users).map(String);
    if (wantedUsers.length === 0) return bool(true);
    const actual = groupUsers(group).map(String);
    return bool(wantedUsers.every((user) => actual.includes(user)));
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(groups.length >= target, Math.min(groups.length, target), target);
}

function evaluateCanI(obj, c) {
  const verb = obj.verb || 'get';
  const resource = obj.resource || 'pods';
  // `oc auth can-i` is project-scoped. When the objective omits the project,
  // use the level's single seeded Project rather than whatever `oc project`
  // happens to be active when the next tick runs.
  const namespace = obj.namespace || levelProjectNamespace(c);
  const user = obj.user;
  const expected = obj.expected !== false;
  const engine = c.gameEngine;
  let allowed = false;
  try {
    if (engine && typeof engine.canI === 'function') {
      const check = engine.canI(verb, resource, namespace, user);
      allowed = check?.allowed === true;
    } else if (c.clusterState && typeof c.clusterState.canI === 'function') {
      const check = c.clusterState.canI(user || engine?.currentUser || 'kubeadmin', verb, resource, namespace);
      allowed = check?.allowed === true;
    }
  } catch {
    allowed = false;
  }
  return bool(allowed === expected);
}

function evaluateServiceType(obj, c) {
  const wantedType = obj.kind || 'ClusterIP';
  const target = Math.max(1, asNumber(obj.count, 1));
  let services = listKind(c.clusterState, 'Service');
  const namespace = objectiveResourceNamespace(c, obj, 'Service');
  if (namespace) services = services.filter((svc) => resourceNamespace(svc) === namespace);
  const matching = services.filter((service) => {
    const spec = resourceSpec(service);
    const type = spec.type || 'ClusterIP';
    if (type !== wantedType) return false;
    // A LoadBalancer Service is only "exposed" once MetalLB assigned an
    // EXTERNAL-IP; the level text promises that, not just the service type.
    if (wantedType === 'LoadBalancer') {
      const ingress = asArray(resourceStatus(service).loadBalancer?.ingress);
      if (ingress.length === 0) return false;
    }
    return true;
  }).length;
  return result(matching >= target, Math.min(matching, target), target);
}

function labelsMatchSelector(labels, selector) {
  if (!selector || Object.keys(selector).length === 0) return false;
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function evaluateConnect(obj, c) {
  const cluster = c.clusterState;
  const to = obj.to || obj.service || obj.name;
  if (!to) return bool(false);
  const services = listKind(cluster, 'Service');
  const workloads = listKinds(cluster, ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'ReplicaSet']);
  const candidateServices = services.filter((service) => {
    const name = resourceName(service);
    return name === to || name === `${to}-svc` || resourceSpec(service).to?.name === to;
  });
  const pool = candidateServices.length > 0 ? candidateServices : services;
  const connected = pool.some((service) => {
    const selector = resourceSpec(service).selector;
    if (!selector || Object.keys(selector).length === 0) return false;
    const namespace = resourceNamespace(service);
    return workloads.some((workload) => {
      if (namespace && resourceNamespace(workload) !== namespace) return false;
      return labelsMatchSelector(podTemplateLabelsOf(workload), selector);
    });
  });
  return bool(connected);
}

function routeMatches(route, obj) {
  const spec = resourceSpec(route);
  if (obj.name && resourceName(route) !== obj.name) return false;
  if (obj.host) {
    const host = spec.host || route.effectiveHost?.() || '';
    if (host !== obj.host) return false;
  }
  if (obj.path) {
    const routePath = spec.path || '/';
    if (routePath !== obj.path) return false;
  }
  if (obj.service) {
    const serviceName = spec.to?.name || route.serviceName || '';
    if (serviceName !== obj.service) return false;
  }
  if (obj.termination) {
    const termination = spec.tls?.termination || '';
    if (termination !== obj.termination) return false;
  }
  return true;
}

function routeAdmitted(route) {
  try {
    if (typeof route.isAdmitted === 'function') return route.isAdmitted();
  } catch {
    /* fall through */
  }
  const ingress = asArray(resourceStatus(route).ingress);
  for (const entry of ingress) {
    const condition = asArray(entry?.conditions).find((candidate) => candidate?.type === 'Admitted');
    if (condition && String(condition.status) === 'True') return true;
  }
  return false;
}

function evaluateRoute(obj, c) {
  let routes = listKind(c.clusterState, 'Route');
  const namespace = obj.namespace || levelProjectNamespace(c);
  if (namespace) routes = routes.filter((route) => resourceNamespace(route) === namespace);
  routes = routes.filter((route) => routeMatches(route, obj));
  const admitted = routes.filter(routeAdmitted).length;
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(admitted >= target, Math.min(admitted, target), target);
}

function evaluateTls(obj, c) {
  let routes = listKind(c.clusterState, 'Route');
  const namespace = obj.namespace || levelProjectNamespace(c);
  if (namespace) routes = routes.filter((route) => resourceNamespace(route) === namespace);
  if (obj.enabled === false) {
    const withTls = routes.filter((route) => Boolean(resourceSpec(route).tls?.termination));
    return bool(withTls.length === 0);
  }
  const matching = routes.filter((route) => {
    const tls = resourceSpec(route).tls;
    if (!tls || !tls.termination) return false;
    if (obj.termination && tls.termination !== obj.termination) return false;
    if (obj.name && resourceName(route) !== obj.name) return false;
    return true;
  });
  return bool(matching.length > 0);
}

function evaluateBuild(obj, c) {
  let builds = listKind(c.clusterState, 'Build');
  const buildNamespace = objectiveResourceNamespace(c, obj, 'Build');
  if (buildNamespace) builds = builds.filter((build) => resourceNamespace(build) === buildNamespace);
  const complete = builds.filter((build) => resourceStatus(build).phase === 'Complete');
  if (obj.name) {
    const buildDirect = complete.some((build) => resourceName(build) === obj.name);
    if (buildDirect) return bool(true);
    const matchingConfigs = complete.some((build) => {
      const config = resourceStatus(build).config || {};
      return config.name === obj.name || resourceLabels(build).buildconfig === obj.name;
    });
    if (matchingConfigs) return bool(true);
    // A completed build named `<buildconfig>-<n>` belongs to the named config.
    if (complete.some((build) => resourceName(build).startsWith(`${obj.name}-`))) return bool(true);
    // A named BuildConfig whose last build completed also satisfies `build`.
    const bc = findResource(c.clusterState, 'BuildConfig', obj.name, objectiveResourceNamespace(c, obj, 'BuildConfig'));
    if (!bc) return bool(false);
    return bool(asNumber(resourceStatus(bc).lastVersion, 0) > 0);
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(complete.length >= target, Math.min(complete.length, target), target);
}

function evaluateImageStream(obj, c) {
  const name = obj.name;
  if (!name) {
    const target = Math.max(1, asNumber(obj.count, 1));
    let streams = listKind(c.clusterState, 'ImageStream');
    const countNamespace = objectiveResourceNamespace(c, obj, 'ImageStream');
    if (countNamespace) streams = streams.filter((stream) => resourceNamespace(stream) === countNamespace);
    return result(streams.length >= target, Math.min(streams.length, target), target);
  }
  const streamNamespace = objectiveResourceNamespace(c, obj, 'ImageStream');
  let stream = findResource(c.clusterState, 'ImageStream', name, streamNamespace);
  if (!stream) {
    stream = findByPrefix(c.clusterState, 'ImageStream', name);
    if (stream && streamNamespace && resourceNamespace(stream) !== streamNamespace) stream = null;
  }
  if (!stream) return bool(false);
  if (!obj.tag) return bool(true);
  const statusTags = asArray(resourceStatus(stream).tags).map((tag) => tag?.tag);
  const specTags = asArray(resourceSpec(stream).tags).map((tag) => tag?.name);
  return bool(statusTags.includes(obj.tag) || specTags.includes(obj.tag));
}

function evaluateImage(obj, c) {
  const kind = canonicalKind(obj.kind || 'Deployment');
  let workloads = listKind(c.clusterState, kind);
  if (obj.name) workloads = workloads.filter((resource) => resourceName(resource) === obj.name);
  const imageNamespace = objectiveResourceNamespace(c, obj, kind);
  if (imageNamespace) workloads = workloads.filter((resource) => resourceNamespace(resource) === imageNamespace);
  const needle = String(obj.imageContains || obj.image || '');
  if (!needle) return bool(workloads.length > 0);
  const match = workloads.some((workload) =>
    containersOf(workload).some((container) => String(container?.image || '').includes(needle))
  );
  return bool(match);
}

function evaluateTemplate(obj, c) {
  const state = manifestState(c);
  const wantedName = obj.name || obj.template;
  const params = obj.parameters && typeof obj.parameters === 'object' ? obj.parameters : null;
  if (state) {
    const templates = appliedTemplates(state).filter((entry) => entry?.applied !== false);
    const matching = templates.filter((entry) => {
      if (!wantedName) return true;
      const haystack = `${entry?.name || ''} ${entry?.path || ''}`.toLowerCase();
      return haystack.includes(String(wantedName).toLowerCase());
    });
    const withParams = params
      ? matching.filter((entry) =>
          Object.entries(params).every(([key, value]) =>
            quantityMatches(entry?.params?.[key], value)
          )
        )
      : matching;
    if (withParams.length > 0) return bool(true);
  }
  // Fallback for CLI-only harnesses without ManifestEngine records: require a
  // real `oc process … | oc apply …` pipeline (process alone is only a render,
  // and merely creating a Template object is not processing it).
  if (wantedName) {
    const processed = matchCommands(c, `process\\s+(-f\\s+)?\\S*${escapeRegex(wantedName)}`);
    const applied = matchCommands(c, 'apply\\s+(-f|--filename)(=|\\s+)\\S+');
    const paramsOk = !params || processed.some((entry) =>
      Object.entries(params).every(([key, value]) =>
        new RegExp(`${escapeRegex(key)}\\s*=\\s*${escapeRegex(String(value))}`, 'i').test(entry.raw)
      )
    );
    const appliedAfterProcessing = applied.some((applyEntry) =>
      processed.some((processEntry) => asNumber(applyEntry.timestamp, 0) >= asNumber(processEntry.timestamp, 0))
    );
    if (processed.length > 0 && appliedAfterProcessing && paramsOk) return bool(true);
  }
  return bool(false);
}

function evaluateHelm(obj, c) {
  const state = manifestState(c);
  const releases = state ? helmReleases(state) : [];
  const wantedRelease = obj.release || obj.name;
  const wantedChart = obj.chart;
  const matching = releases.filter((release) => {
    if (wantedRelease && release?.name !== wantedRelease) return false;
    if (wantedChart) {
      const chart = `${release?.chart || ''} ${release?.chartDir || ''}`.toLowerCase();
      if (!chart.includes(String(wantedChart).toLowerCase())) return false;
    }
    return true;
  });
  if (matching.length > 0) return bool(true);
  // Fallback: `helm install <release> <chart>` recorded in command history.
  const pattern = wantedRelease
    ? `helm\\s+install\\s+\\S*${escapeRegex(wantedRelease)}`
    : 'helm\\s+install\\s+\\S+';
  return bool(matchCommands(c, pattern).length > 0);
}

function evaluateKustomize(obj, c) {
  const path = obj.path || obj.dir || '';
  if (hasAppliedKustomize(c, path)) return bool(true);
  if (obj.name && hasAppliedKustomize(c, obj.name)) return bool(true);
  return bool(false);
}

function evaluateManifest(obj, c) {
  const file = obj.file || obj.path || obj.name;
  if (!file) return bool(false);
  return bool(hasAppliedFile(c, file));
}

function evaluateOperator(obj, c) {
  const wanted = String(obj.name || obj.operator || '').toLowerCase();
  const subscriptions = listKind(c.clusterState, 'Subscription');
  const matching = subscriptions.filter((subscription) => {
    if (!wanted) return true;
    const spec = resourceSpec(subscription);
    const haystack = `${resourceName(subscription)} ${spec.name || ''} ${spec.packageName || ''}`.toLowerCase();
    return haystack.includes(wanted);
  });
  const succeeded = matching.filter((subscription) => resourceStatus(subscription).phase === 'Succeeded').length;
  const installed = obj.installed !== false;
  if (installed) {
    const target = Math.max(1, asNumber(obj.count, 1));
    return result(succeeded >= target, Math.min(succeeded, target), target);
  }
  // "Uninstall" only makes sense once the operator was present during this
  // level; otherwise the objective would be complete at level start (L18).
  if (matching.length > 0) obj._sawInstalled = true;
  const target = Math.max(1, asNumber(obj.count, 1));
  const levelContext = Boolean(c.levelDef);
  const done = matching.length === 0 && (!levelContext || obj._sawInstalled === true);
  return result(done, done ? target : 0, target);
}

function subjectMatches(subjectList, wanted) {
  if (!wanted) return true;
  const list = asArray(subjectList).map(String);
  const target = String(wanted);
  if (target.includes('*')) {
    const regex = new RegExp(`^${escapeRegex(target).replace(/\\\*/g, '.*')}$`);
    return list.some((entry) => regex.test(entry));
  }
  return list.includes(target);
}

function evaluateScc(obj, c) {
  const name = obj.scc || obj.name || obj.sccName;
  if (!name) return bool(false);
  const scc = findResource(c.clusterState, 'SecurityContextConstraints', name);
  if (!scc) return bool(false);
  const spec = resourceSpec(scc);
  let subject = obj.subject;
  // A `*` project wildcard in the level data means "this lab's project", not
  // "any project in the cluster": `system:serviceaccount:*:default` must match
  // the level's seeded Project (e.g. privileged-lab), not the default project.
  if (subject && String(subject).includes('*')) {
    const namespace = obj.namespace || levelProjectNamespace(c);
    if (namespace) subject = String(subject).split('*').join(namespace);
  }
  const expected = obj.expected !== false;
  const present = subject
    ? subjectMatches(spec.users, subject) || subjectMatches(spec.groups, subject)
    : asArray(spec.users).length > 0 || asArray(spec.groups).length > 0;
  return bool(present === expected);
}

/** Does an SCC allow privileged containers? */
function sccAllowsPrivileged(scc) {
  if (!scc) return false;
  if (resourceName(scc) === 'privileged') return true;
  return resourceSpec(scc).allowPrivilegedContainer === true;
}

function workloadIsPrivileged(workload) {
  const podSpec = podTemplateSpecOf(workload);
  if (!podSpec) return false;
  if (podSpec.securityContext?.privileged === true) return true;
  return containersOf(workload).some((container) => container?.securityContext?.privileged === true);
}

function podIsPrivileged(pod) {
  const spec = resourceSpec(pod);
  if (spec.securityContext?.privileged === true) return true;
  return asArray(spec.containers).some(
    (container) => container?.securityContext?.privileged === true
  );
}

function evaluatePrivileged(obj, c) {
  // Per the objective contract this means "a Pod is RUNNING with a privileged
  // container AND an SCC actually admitted it" — not merely that a workload
  // template requests it (a privileged pod is denied under restricted-v2 /
  // anyuid, so template-only credit would teach a false SCC model).
  const sccs = listKind(c.clusterState, 'SecurityContextConstraints');
  const sccByName = new Map(sccs.map((scc) => [resourceName(scc), scc]));
  const privilegedNamespace = obj.namespace || levelProjectNamespace(c);
  const pods = listKind(c.clusterState, 'Pod').filter((pod) => {
    if (privilegedNamespace && resourceNamespace(pod) !== privilegedNamespace) return false;
    if (!podIsPrivileged(pod)) return false;
    if (resourceStatus(pod).phase !== 'Running') return false;
    const ready = typeof pod.isConditionTrue === 'function' ? pod.isConditionTrue('Ready') : true;
    if (!ready) return false;
    const sccName = pod.metadata?.annotations?.['openshift.io/scc'] || pod.sccName || null;
    if (!sccName) return false;
    return sccAllowsPrivileged(sccByName.get(sccName));
  });
  const count = pods.length;
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(count >= target, Math.min(count, target), target);
}

function evaluateQuota(obj, c) {
  let quotas = listKind(c.clusterState, 'ResourceQuota');
  if (obj.namespace) quotas = quotas.filter((quota) => resourceNamespace(quota) === obj.namespace);
  if (obj.name) quotas = quotas.filter((quota) => resourceName(quota) === obj.name);
  if (quotas.length === 0) return bool(false);
  if (!obj.hard) return bool(true);
  return bool(quotas.some((quota) => subsetMatches(resourceSpec(quota).hard, obj.hard)));
}

function evaluateLimitRange(obj, c) {
  let ranges = listKind(c.clusterState, 'LimitRange');
  if (obj.namespace) ranges = ranges.filter((range) => resourceNamespace(range) === obj.namespace);
  if (obj.name) ranges = ranges.filter((range) => resourceName(range) === obj.name);
  return bool(ranges.length > 0);
}

function evaluateClusterQuota(obj, c) {
  let quotas = listKind(c.clusterState, 'ClusterResourceQuota');
  if (obj.name) quotas = quotas.filter((quota) => resourceName(quota) === obj.name);
  return bool(quotas.length > 0);
}

function evaluateComplete(obj, c) {
  const kind = canonicalKind(obj.kind || 'Job');
  let resources = listKind(c.clusterState, kind);
  if (obj.name) resources = resources.filter((resource) => resourceName(resource) === obj.name);
  const completeNamespace = objectiveResourceNamespace(c, obj, kind);
  if (completeNamespace) resources = resources.filter((resource) => resourceNamespace(resource) === completeNamespace);
  const complete = resources.filter((resource) => resourceStatus(resource).phase === 'Complete');
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(complete.length >= target, Math.min(complete.length, target), target);
}

function evaluateCronJob(obj, c) {
  let cronJobs = listKind(c.clusterState, 'CronJob');
  if (obj.name) cronJobs = cronJobs.filter((cronJob) => resourceName(cronJob) === obj.name);
  const cronNamespace = objectiveResourceNamespace(c, obj, 'CronJob');
  if (cronNamespace) cronJobs = cronJobs.filter((cronJob) => resourceNamespace(cronJob) === cronNamespace);
  if (obj.suspended === false) {
    cronJobs = cronJobs.filter((cronJob) => resourceSpec(cronJob).suspend !== true);
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(cronJobs.length >= target, Math.min(cronJobs.length, target), target);
}

function volumeReferences(workload, kind, name) {
  const podSpec = podTemplateSpecOf(workload);
  if (!podSpec) return false;
  const volumes = asArray(podSpec.volumes);
  return volumes.some((volume) => {
    if (!volume || typeof volume !== 'object') return false;
    if (kind === 'ConfigMap' && volume.configMap) {
      return !name || volume.configMap.name === name;
    }
    if (kind === 'Secret' && volume.secret) {
      return !name || volume.secret.secretName === name;
    }
    if (Array.isArray(volume.projected?.sources)) {
      return volume.projected.sources.some((source) =>
        kind === 'ConfigMap' ? Boolean(source?.configMap) : Boolean(source?.secret)
      );
    }
    return false;
  });
}

function evaluateMount(obj, c) {
  const kind = canonicalKind(obj.kind || 'ConfigMap');
  const targetKinds = obj.targetKind
    ? [canonicalKind(obj.targetKind)]
    : ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job'];
  const name = obj.name || obj.resourceName;
  const workloads = listKinds(c.clusterState, targetKinds);
  const mounted = workloads.filter((workload) => volumeReferences(workload, kind, name)).length;
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(mounted >= target, Math.min(mounted, target), target);
}

function envReferences(workload, kind, name) {
  const containers = containersOf(workload);
  return containers.some((container) => {
    const envFrom = asArray(container?.envFrom);
    const fromMatch = envFrom.some((entry) => {
      if (kind === 'ConfigMap' && entry?.configMapRef) return !name || entry.configMapRef.name === name;
      if (kind === 'Secret' && entry?.secretRef) return !name || entry.secretRef.name === name;
      return false;
    });
    if (fromMatch) return true;
    return asArray(container?.env).some((entry) => {
      const valueFrom = entry?.valueFrom;
      if (!valueFrom) return false;
      if (kind === 'ConfigMap' && valueFrom.configMapKeyRef) {
        return !name || valueFrom.configMapKeyRef.name === name;
      }
      if (kind === 'Secret' && valueFrom.secretKeyRef) {
        return !name || valueFrom.secretKeyRef.name === name;
      }
      return false;
    });
  });
}

function evaluateEnvFrom(obj, c) {
  const kind = canonicalKind(obj.kind || 'ConfigMap');
  const targetKinds = obj.targetKind
    ? [canonicalKind(obj.targetKind)]
    : ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod'];
  const workloads = listKinds(c.clusterState, targetKinds);
  const name = obj.name || obj.resourceName;
  const using = workloads.filter((workload) => envReferences(workload, kind, name)).length;
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(using >= target, Math.min(using, target), target);
}

function evaluateNoConfigMap(obj, c) {
  const sensitivePattern =
    obj.sensitive === false ? null : SENSITIVE_CONFIGMAP_KEY;
  if (!sensitivePattern) return bool(true);
  const leaks = listKind(c.clusterState, 'ConfigMap').filter((configMap) => {
    const data = resourceSpec(configMap).data;
    if (!data || typeof data !== 'object') return false;
    return Object.keys(data).some((key) => sensitivePattern.test(key));
  });
  return result(leaks.length === 0, leaks.length === 0 ? 1 : 0, 1);
}

function resolveTargetKinds(obj, fallback = ['Deployment', 'StatefulSet']) {
  return obj.kind ? [canonicalKind(obj.kind)] : fallback;
}

function collectContainersForWorkloads(cluster, kinds, name) {
  let workloads = listKinds(cluster, kinds);
  if (name) workloads = workloads.filter((workload) => resourceName(workload) === name);
  return { workloads, containers: workloads.flatMap((workload) => containersOf(workload).map((container) => ({ workload, container }))) };
}

function evaluateResources(obj, c) {
  const { workloads, containers } = collectContainersForWorkloads(
    c.clusterState,
    resolveTargetKinds(obj),
    obj.name
  );
  if (workloads.length === 0 || containers.length === 0) return result(false, 0, 1);
  const configured = containers.filter(({ container }) => {
    const resources = container?.resources;
    return Boolean(resources?.requests && resources?.limits);
  }).length;
  return result(configured === containers.length, configured, containers.length);
}

function evaluateProbes(obj, c) {
  const { workloads, containers } = collectContainersForWorkloads(
    c.clusterState,
    resolveTargetKinds(obj),
    obj.name
  );
  if (workloads.length === 0 || containers.length === 0) return result(false, 0, 1);
  const withProbes = containers.filter(({ container }) => {
    if (obj.liveness !== false && !container?.livenessProbe) return false;
    if (obj.readiness !== false && !container?.readinessProbe) return false;
    if (obj.startup === true && !container?.startupProbe) return false;
    return true;
  }).length;
  return result(withProbes === containers.length, withProbes, containers.length);
}

function evaluateCount(kind, obj, c) {
  const resources = listKind(c.clusterState, kind);
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(resources.length >= target, Math.min(resources.length, target), target);
}

function evaluateBound(obj, c) {
  const kind = canonicalKind(obj.kind || 'PersistentVolumeClaim');
  const claims = listKind(c.clusterState, kind).filter(
    (claim) => resourceStatus(claim).phase === 'Bound'
  );
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(claims.length >= target, Math.min(claims.length, target), target);
}

function evaluateHeadless(obj, c) {
  const kind = canonicalKind(obj.kind || 'Service');
  const headless = listKind(c.clusterState, kind).filter(
    (resource) => resourceSpec(resource).clusterIP === 'None'
  );
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(headless.length >= target, Math.min(headless.length, target), target);
}

function evaluateStable(obj, c) {
  const kind = canonicalKind(obj.kind || 'StatefulSet');
  const sets = listKind(c.clusterState, kind);
  if (sets.length === 0) return bool(false);
  const stable = sets.some((set) => {
    const spec = resourceSpec(set);
    const status = resourceStatus(set);
    const desired = asNumber(spec.replicas, 1);
    const ready = asNumber(status.readyReplicas, 0);
    return ready >= desired || status.readyReplicas === undefined;
  });
  return bool(stable);
}

function collectRoleViolations(c) {
  const violations = [];
  const roles = listKinds(c.clusterState, ['Role', 'ClusterRole']);
  for (const role of roles) {
    const name = resourceName(role);
    if (!name || name === 'cluster-admin' || name.startsWith('system:')) continue;
    const spec = resourceSpec(role);
    const hasWildcard = asArray(spec.rules).some((rule) => {
      const verbs = asArray(rule?.verbs).map(String);
      const resources = asArray(rule?.resources).map(String);
      return verbs.includes('*') || resources.includes('*');
    });
    if (hasWildcard) violations.push(`role ${name} grants wildcard permissions`);
  }
  const bindings = listKinds(c.clusterState, ['RoleBinding', 'ClusterRoleBinding']);
  for (const binding of bindings) {
    const roleRef = resourceSpec(binding).roleRef || {};
    const name = resourceName(binding);
    if (!name || name.startsWith('system:') || name === 'kubeadmin-cluster-admin') continue;
    if (roleRef.name !== 'cluster-admin') continue;
    const subjects = asArray(resourceSpec(binding).subjects);
    const nonAdmin = subjects.some((subject) => {
      if (!subject || !subject.kind) return false;
      if (subject.kind === 'User') return !ADMIN_USERS.has(String(subject.name));
      if (subject.kind === 'Group') return !ADMIN_GROUPS.has(String(subject.name));
      return true;
    });
    if (nonAdmin) violations.push(`binding ${name} grants cluster-admin to a non-admin subject`);
  }
  return violations;
}

function evaluateLeastPrivilege(obj, c) {
  // The auto-provisioned project `admin` bindings are infrastructure, and an
  // empty cluster trivially has no violations: require the learner to have
  // created at least one Role/ClusterRole/RoleBinding during this level before
  // the guard can complete (L14/C7 otherwise start "done").
  let createdDuringLevel = true;
  if (c.levelDef) {
    const baseline = ensureBaseline(obj, () => ({
      roles: listKinds(c.clusterState, ['Role', 'ClusterRole']).map((role) => role?.uid || resourceName(role)),
      bindings: listKinds(c.clusterState, ['RoleBinding', 'ClusterRoleBinding']).map((binding) => binding?.uid || resourceName(binding)),
    }));
    const knownRoles = new Set(baseline.roles);
    const knownBindings = new Set(baseline.bindings);
    createdDuringLevel =
      listKinds(c.clusterState, ['Role', 'ClusterRole']).some((role) => !knownRoles.has(role?.uid || resourceName(role)))
      || listKinds(c.clusterState, ['RoleBinding', 'ClusterRoleBinding']).some(
        (binding) => !knownBindings.has(binding?.uid || resourceName(binding)),
      );
  }
  const violations = collectRoleViolations(c);
  const done = violations.length === 0 && createdDuringLevel;
  return result(done, done ? 1 : 0, 1);
}

function evaluateDistribute(obj, c) {
  const minNodes = Math.max(1, asNumber(obj.minNodes, 2));
  const pods = listKind(c.clusterState, 'Pod');
  const nodes = new Set(
    pods
      .map((pod) => resourceSpec(pod).nodeName)
      .filter((nodeName) => typeof nodeName === 'string' && nodeName.length > 0)
  );
  return result(nodes.size >= minNodes, Math.min(nodes.size, minNodes), minNodes);
}

function evaluateCoverage(obj, c) {
  const kind = canonicalKind(obj.kind || 'DaemonSet');
  const nodes = listKind(c.clusterState, 'Node');
  const daemonSets = listKind(c.clusterState, kind);
  if (nodes.length === 0) return result(false, 0, 1);
  if (daemonSets.length === 0) return result(false, 0, nodes.length);
  const pods = listKind(c.clusterState, 'Pod').filter((pod) =>
    asArray(pod?.metadata?.ownerReferences).some(
      (reference) => reference?.kind === 'DaemonSet'
    )
  );
  const covered = new Set(
    pods.map((pod) => resourceSpec(pod).nodeName).filter((nodeName) => Boolean(nodeName))
  );
  return result(covered.size >= nodes.length, Math.min(covered.size, nodes.length), nodes.length);
}

function evaluateUpdate(obj, c) {
  const kinds = resolveTargetKinds(obj, ['Deployment', 'StatefulSet', 'DaemonSet']);
  let workloads = listKinds(c.clusterState, kinds);
  if (obj.name) workloads = workloads.filter((workload) => resourceName(workload) === obj.name);
  if (obj.namespace) workloads = workloads.filter((workload) => resourceNamespace(workload) === obj.namespace);
  const target = Math.max(1, asNumber(obj.count, 1));
  if (workloads.length === 0) return result(false, 0, target);
  // A controller writing status.updatedReplicas during the initial rollout is
  // NOT a learner update. Capture the workload generation/template on the first
  // evaluation after level start and credit only a real spec change.
  const baseline = ensureBaseline(obj, () => ({ entries: {} }));
  for (const workload of workloads) {
    const id = workload?.uid || resourceName(workload);
    if (!Object.prototype.hasOwnProperty.call(baseline.entries, id)) {
      baseline.entries[id] = {
        generation: asNumber(workload?.metadata?.generation, 1),
        template: templateFingerprint(workload),
      };
    }
  }
  const updated = workloads.filter((workload) => {
    const id = workload?.uid || resourceName(workload);
    const base = baseline.entries[id];
    if (!base) return true; // created during this level
    return (
      asNumber(workload?.metadata?.generation, 1) > base.generation ||
      templateFingerprint(workload) !== base.template
    );
  }).length;
  return result(updated >= target, Math.min(updated, target), target);
}

function evaluateRollback(obj, c) {
  const count = asNumber(c.clusterState?._rollbackCount, 0);
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(count >= target, Math.min(count, target), target);
}

function evaluateResolve(obj, c) {
  const resolved = resolvedIncidents(c);
  const wanted = obj.incidentType || obj.name || null;
  const matching = wanted ? resolved.filter((incident) => matchesIncident(incident, wanted)) : resolved;
  let count = matching.length;
  if (!wanted) {
    const stats = c.incidentEngine?.getStats?.();
    count = Math.max(count, asNumber(stats?.totalResolved, 0));
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(count >= target, Math.min(count, target), target);
}

function evaluateInvestigate(obj, c) {
  const wanted = obj.incidentType || obj.name;
  const threshold = asNumber(obj.progress, 0.5);
  const pool = [...activeIncidents(c), ...resolvedIncidents(c)];
  const matching = wanted ? pool.filter((incident) => matchesIncident(incident, wanted)) : pool;
  const progress = Math.max(0, ...matching.map((incident) => asNumber(incident?.investigationProgress, 0)));
  return result(progress >= threshold, progress >= threshold ? 1 : 0, 1);
}

function evaluateUptime(obj, c) {
  const percentage = asNumber(obj.percentage, 90);
  const health = clusterHealthPercent(c);
  // "Restore/keep health ≥ N%" cannot be satisfied before the level's incident
  // has actually happened. Require an incident activation after level start and
  // all incidents cleared again (they are the only thing that lowers health).
  const activity = incidentActivity(c);
  if (activity) {
    const baseline = ensureBaseline(obj, () => ({ activations: activity.activations }));
    if (activity.activations <= baseline.activations) {
      return result(false, Math.round(health), percentage);
    }
    if (activity.active > 0) {
      return result(false, Math.round(health), percentage);
    }
  }
  return result(health >= percentage, Math.round(health), percentage);
}

function evaluateClusterHealth(obj, c) {
  const minPercent = asNumber(obj.minPercent, 90);
  const health = clusterHealthPercent(c);
  const activity = incidentActivity(c);
  if (activity) {
    const baseline = ensureBaseline(obj, () => ({ activations: activity.activations }));
    if (activity.activations <= baseline.activations || activity.active > 0) {
      return result(false, Math.round(health), minPercent);
    }
  }
  let healthy = health >= minPercent;
  if (obj.allOperatorsAvailable) {
    const operators = listKind(c.clusterState, 'ClusterOperator');
    if (operators.length > 0) {
      healthy =
        healthy &&
        operators.every((operator) => {
          const conditions = asArray(resourceStatus(operator).conditions);
          const available = conditions.find((condition) => condition?.type === 'Available');
          const degraded = conditions.find((condition) => condition?.type === 'Degraded');
          return (
            available?.status === 'True' &&
            (degraded === undefined || degraded.status !== 'True')
          );
        });
    }
  }
  return result(healthy, Math.round(health), minPercent);
}

function evaluateReschedule(obj, c) {
  const count = asNumber(c.clusterState?._rescheduledCount, 0);
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(count >= target, Math.min(count, target), target);
}

function nodeLabelMatches(node, label) {
  const labels = resourceLabels(node);
  const wanted = String(label);
  if (!wanted) return true;
  if (wanted.includes('=')) {
    const [key, value] = wanted.split('=');
    return labels[key] === value;
  }
  return hasOwn(labels, wanted);
}

function evaluateNodeSelector(obj, c) {
  const nodes = listKind(c.clusterState, 'Node');
  const label = obj.nodeLabel || obj.label || obj.key;
  const matchingNodes = nodes.filter((node) => nodeLabelMatches(node, label));
  const kinds = obj.kind
    ? [canonicalKind(obj.kind)]
    : ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'ReplicaSet'];
  const pods = listKinds(c.clusterState, 'Pod');
  const workloads = listKinds(c.clusterState, kinds);
  const nodeNames = new Set(matchingNodes.map((node) => resourceName(node)));
  const scheduled = pods.some((pod) => nodeNames.has(resourceSpec(pod).nodeName));
  const hasSelector =
    workloads.some((workload) => {
      const spec = podTemplateSpecOf(workload) || {};
      const selector = spec.nodeSelector;
      return selector && Object.keys(selector).length > 0;
    }) || pods.some((pod) => {
      const selector = resourceSpec(pod).nodeSelector;
      return selector && Object.keys(selector).length > 0;
    });
  return bool(matchingNodes.length > 0 && (scheduled || hasSelector));
}

function evaluateTaint(obj, c) {
  const nodes = listKind(c.clusterState, 'Node');
  const filtered = nodes.filter((node) => {
    if (obj.node && resourceName(node) !== obj.node) return false;
    const taints = asArray(resourceSpec(node).taints);
    return taints.some((taint) => {
      if (obj.key && taint?.key !== obj.key) return false;
      if (obj.effect && taint?.effect !== obj.effect) return false;
      return true;
    });
  });
  return bool(filtered.length > 0);
}

function evaluateCommand(obj, c) {
  const pattern = obj.pattern;
  if (!pattern) return bool(false);
  const matches = matchCommands(c, pattern, { successOnly: obj.mustSucceed !== false });
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(matches.length >= target, Math.min(matches.length, target), target);
}

function evaluateExamScore(obj, c) {
  const minScore = asNumber(obj.minScore, 75);
  const objectivePercent = objectivesCompletionPercent(c, new Set(['examscore'])) ?? 0;
  const health = clusterHealthPercent(c);
  const architecture = architectureTotal(c);
  const composite = Math.round(objectivePercent * 0.6 + health * 0.2 + architecture * 0.2);
  return result(composite >= minScore, composite, minScore);
}

function evaluateArchitectureScore(obj, c) {
  const minScore = asNumber(obj.minScore, 75);
  const total = Math.round(architectureTotal(c));
  return result(total >= minScore, total, minScore);
}

function evaluateByType(type, obj, c) {
  switch (type) {
    case 'deploy':
      return evaluateDeploy(obj, c);
    case 'label':
      return evaluateLabel(obj, c);
    case 'scale':
      return evaluateScale(obj, c);
    case 'replicas':
      return evaluateReplicas(obj, c);
    case 'project':
      return evaluateProject(obj, c);
    case 'login':
      return evaluateLogin(obj, c);
    case 'user':
      return evaluateUser(obj, c);
    case 'group':
      return evaluateGroup(obj, c);
    case 'cani':
      return evaluateCanI(obj, c);
    case 'servicetype':
      return evaluateServiceType(obj, c);
    case 'connect':
      return evaluateConnect(obj, c);
    case 'route':
      return evaluateRoute(obj, c);
    case 'tls':
      return evaluateTls(obj, c);
    case 'build':
      return evaluateBuild(obj, c);
    case 'imagestream':
      return evaluateImageStream(obj, c);
    case 'image':
      return evaluateImage(obj, c);
    case 'template':
      return evaluateTemplate(obj, c);
    case 'helm':
      return evaluateHelm(obj, c);
    case 'kustomize':
      return evaluateKustomize(obj, c);
    case 'manifest':
      return evaluateManifest(obj, c);
    case 'operator':
      return evaluateOperator(obj, c);
    case 'scc':
      return evaluateScc(obj, c);
    case 'privileged':
      return evaluatePrivileged(obj, c);
    case 'quota':
      return evaluateQuota(obj, c);
    case 'limitrange':
      return evaluateLimitRange(obj, c);
    case 'clusterquota':
      return evaluateClusterQuota(obj, c);
    case 'complete':
      return evaluateComplete(obj, c);
    case 'cronjob':
      return evaluateCronJob(obj, c);
    case 'mount':
      return evaluateMount(obj, c);
    case 'envfrom':
      return evaluateEnvFrom(obj, c);
    case 'noconfigmap':
      return evaluateNoConfigMap(obj, c);
    case 'resources':
      return evaluateResources(obj, c);
    case 'probes':
      return evaluateProbes(obj, c);
    case 'hpa':
      return evaluateCount('HorizontalPodAutoscaler', obj, c);
    case 'pdb':
      return evaluateCount('PodDisruptionBudget', obj, c);
    case 'bound':
      return evaluateBound(obj, c);
    case 'headless':
      return evaluateHeadless(obj, c);
    case 'stable':
      return evaluateStable(obj, c);
    case 'leastprivilege':
      return evaluateLeastPrivilege(obj, c);
    case 'distribute':
      return evaluateDistribute(obj, c);
    case 'coverage':
      return evaluateCoverage(obj, c);
    case 'update':
      return evaluateUpdate(obj, c);
    case 'rollback':
      return evaluateRollback(obj, c);
    case 'resolve':
      return evaluateResolve(obj, c);
    case 'investigate':
      return evaluateInvestigate(obj, c);
    case 'uptime':
      return evaluateUptime(obj, c);
    case 'clusterhealth':
      return evaluateClusterHealth(obj, c);
    case 'reschedule':
      return evaluateReschedule(obj, c);
    case 'nodeselector':
      return evaluateNodeSelector(obj, c);
    case 'taint':
      return evaluateTaint(obj, c);
    case 'command':
      return evaluateCommand(obj, c);
    case 'examscore':
      return evaluateExamScore(obj, c);
    case 'architecturescore':
      return evaluateArchitectureScore(obj, c);
    default:
      return null;
  }
}

/**
 * Evaluate a single objective.
 *
 * @param {object} objective objective from CampaignLevels / ChallengeMode
 * @param {object} [ctx] { clusterState, gameEngine, incidentEngine, scoringEngine, manifestEngine }
 * @returns {ObjectiveResult} { completed, current, target }
 */
export function evaluateObjective(objective, ctx = {}) {
  if (!objective || typeof objective !== 'object') {
    return incomplete(1);
  }
  const type = String(objective.type || '').toLowerCase();
  if (!type) return incomplete(objective.count ?? 1);
  const c = resolveContext(ctx);
  try {
    const evaluated = evaluateByType(type, objective, c);
    if (evaluated) {
      const fallbackTarget = typeIsBoolean(type) && !Number.isFinite(Number(objective.count))
        ? 1
        : asNumber(objective.count, 1);
      return {
        completed: Boolean(evaluated.completed),
        current: asNumber(evaluated.current, 0),
        target: asNumber(evaluated.target, fallbackTarget) || 1,
      };
    }
  } catch (error) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`ObjectiveEvaluator: objective type "${type}" failed to evaluate`, error);
    }
  }
  return incomplete(asNumber(objective.count, 1));
}

/**
 * Build the initial progress objects for a level/challenge.
 * CampaignMode uses this at level start; the shape matches the historical
 * `{...objective, current, target, completed}` consumed by the objectives panel.
 *
 * @param {object[]} objectives
 * @returns {Array<object>}
 */
export function createObjectiveProgress(objectives) {
  return asArray(objectives).map((objective) => {
    const isBoolean = typeIsBoolean(String(objective?.type || '').toLowerCase());
    return {
      ...objective,
      current: 0,
      target: isBoolean ? 1 : Math.max(1, asNumber(objective?.count, 1)),
      completed: false,
    };
  });
}

/**
 * Evaluate all objectives and merge the results into progress objects.
 * Existing progress objects are reused (completed objectives are not
 * re-evaluated, matching the previous CampaignMode behaviour) unless
 * `options.recheckCompleted` is true.
 *
 * @param {object[]} objectives
 * @param {object} [ctx]
 * @param {{progress?: object[], recheckCompleted?: boolean}} [options]
 * @returns {Array<object>}
 */
export function evaluateObjectives(objectives, ctx = {}, options = {}) {
  const progress = Array.isArray(options.progress)
    ? options.progress
    : createObjectiveProgress(objectives);
  const recheckCompleted = options.recheckCompleted === true;
  for (let index = 0; index < progress.length; index += 1) {
    const objective = progress[index];
    if (!objective) continue;
    if (objective.completed && !recheckCompleted) continue;
    const evaluated = evaluateObjective(objective, ctx);
    objective.current = evaluated.current;
    objective.target = evaluated.target;
    objective.completed = evaluated.completed;
  }
  return progress;
}

/**
 * Summary used by HUD/objectives panel/tests.
 * @param {object[]} progress
 */
export function getObjectiveSummary(progress) {
  const items = asArray(progress);
  const completed = items.filter((objective) => objective?.completed).length;
  return {
    completed,
    total: items.length,
    percentage: items.length === 0 ? 0 : Math.round((completed / items.length) * 100),
    allCompleted: items.length > 0 && completed === items.length,
  };
}

/** Convenience: did a command matching `pattern` succeed? */
export function hasCommand(ctx, pattern, options = {}) {
  return matchCommands(resolveContext(ctx), pattern, options);
}

export default {
  OBJECTIVE_TYPES,
  evaluateObjective,
  evaluateObjectives,
  createObjectiveProgress,
  getObjectiveSummary,
  hasCommand,
  resolveContext,
  listKind,
  findResource,
  containersOf,
};
