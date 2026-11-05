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
  'incident',
  'investigate',
  'uptime',
  'clusterHealth',
  'reschedule',
  'nodeSelector',
  'taint',
  'command',
  'examScore',
  'architectureScore',
  // Behaviour-based grading (issue #30): a `networkPolicy` objective probes the
  // simulator's own traffic evaluator instead of matching hidden NetworkPolicy
  // object names, and `oauthProvider` grades the resulting OAuth/identity
  // provider state instead of a command regex.
  'networkPolicy',
  'oauthProvider',
  // Phase-2B objective kinds (issue #34): password rotation, identity cleanup,
  // OLM install variants and Route reachability from the workstation.
  'password',
  'identity',
  'installPlan',
  'subscription',
  'routeAccess',
  // Extension: `label` appears in the level-2 curriculum prose in §9 even
  // though it is missing from the type list. Implemented as a state check so
  // "work with labels and selectors" is actually exercised.
  'label',
];

/** Types whose natural display is a simple done/not-done flag. */
const BOOLEAN_TYPES = new Set([
  'project',
  'login',
  'user',
  'group',
  'canI',
  'connect',
  'route',
  'tls',
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
  'cronJob',
  'mount',
  'envFrom',
  'noConfigMap',
  'resources',
  'probes',
  'stable',
  'leastPrivilege',
  'update',
  'rollback',
  'resolve',
  'incident',
  'investigate',
  'uptime',
  'clusterHealth',
  'reschedule',
  'nodeSelector',
  'taint',
  'examScore',
  'architectureScore',
  'networkPolicy',
  'oauthProvider',
  'password',
  'identity',
  'installPlan',
  'subscription',
  'routeAccess',
  'label',
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
  return listKind(cluster, kind).find((resource) => resourceName(resource).includes(value)) || null;
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
  const projects = resources.filter(
    (resource) => resource && resource.kind === 'Project' && resource.name
  );
  return projects.length === 1 ? projects[0].name : null;
}

/**
 * Kinds that almost always live in the level's lab project. Used only as a
 * fallback when the objective data does not carry a namespace. Config object
 * kinds (Secret/ConfigMap) are deliberately excluded because they may belong to
 * a shared namespace such as openshift-config.
 */
const LEVEL_SCOPED_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Pod',
  'ReplicaSet',
  'Service',
  'Route',
  'Job',
  'CronJob',
  'Build',
  'BuildConfig',
  'ImageStream',
  'ServiceAccount',
  'ResourceQuota',
  'LimitRange',
  'NetworkPolicy',
  'Template',
]);

function objectiveResourceNamespace(c, obj, kind = null) {
  if (obj?.namespace) return obj.namespace;
  const canonical = kind || canonicalKind(obj?.kind || '');
  if (!LEVEL_SCOPED_KINDS.has(canonical)) return null;
  return levelProjectNamespace(c);
}

/**
 * Kinds that live at cluster scope. Everything else is namespaced and therefore
 * cannot be graded correctly without a namespace (issue #30: a write command
 * executed in the wrong project must not tick a namespaced objective).
 */
const CLUSTER_SCOPED_KINDS = new Set([
  'Node',
  'Project',
  'ClusterRole',
  'ClusterRoleBinding',
  'ClusterOperator',
  'ClusterVersion',
  'ClusterResourceQuota',
  'SecurityContextConstraints',
  'OAuth',
  'StorageClass',
  'PersistentVolume',
  'CustomResourceDefinition',
  'Namespace',
]);

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
  // Level-start epoch captured by IncidentEngine.start()/reset(). A lazily
  // captured "first evaluation" baseline is wrong: one-shot preloads with
  // `triggerTime: 0` activate on the first tick after start(), i.e. BEFORE the
  // 1 s objective loop first runs, which soft-locked timed lab 02 at 3/4 (#22).
  const levelStart = (() => {
    try {
      if (typeof engine.getActivationEpoch === 'function') {
        return asNumber(engine.getActivationEpoch(), 0);
      }
    } catch {
      /* fall through */
    }
    return asNumber(engine.levelStartActivationCount, 0);
  })();
  // Does this level still have incidents that can fire? If not and none ever
  // activated, an "incident must happen" gate can never be satisfied (campaign
  // L10's rollout fault is modelled by SimulationTick, not a scripted incident):
  // fall back to the plain health check instead of soft-locking the level.
  const hasPlan = (() => {
    try {
      if (typeof engine.hasIncidentPlan === 'function') return Boolean(engine.hasIncidentPlan());
    } catch {
      /* fall through */
    }
    return asArray(engine.scriptedQueue).length > 0;
  })();
  return { activations, active, levelStart, hasPlan, gated: hasPlan || activations > levelStart };
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
  return (
    String(path || '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '') || '.'
  );
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
  if (!state)
    return (
      matchCommands(c, `apply\\s+(-f|--filename(=|\\s+))\\s*\\S*${escapeRegex(String(file || ''))}`)
        .length > 0
    );
  return appliedFiles(state).some((entry) => pathEquals(entry?.path || entry?.source, file));
}

function hasAppliedKustomize(c, path) {
  const state = manifestState(c);
  const target = path || '.';
  if (!state) {
    return (
      matchCommands(c, `apply\\s+(-k|--kustomize(=|\\s+))\\s*\\S*${escapeRegex(target)}`).length > 0
    );
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
    if (typeof engine.getActiveIncidents === 'function')
      return asArray(engine.getActiveIncidents());
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
  const relevant = progress.filter(
    (objective) => !excludeTypes.has(String(objective?.type || '').toLowerCase())
  );
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

/**
 * RoleBindings every OpenShift project provisions on creation (issue #35):
 * the requester's `admin` binding plus the service-account image/deploy
 * bindings. They are infrastructure, not learner work, so a count-only
 * "create/bind a RoleBinding" objective (L14/L16/lab 11) must ignore them —
 * otherwise the objective pre-ticks at level start. Learner bindings have
 * different generated names (`edit`, `alice-edit`, …).
 */
const BOOTSTRAP_PROJECT_ROLE_BINDING_NAMES = new Set([
  'admin',
  'system:image-pullers',
  'system:image-builders',
  'system:deployers',
]);
const BOOTSTRAP_PROJECT_ROLE_REF_NAMES = new Set([
  'system:image-puller',
  'system:image-builder',
  'system:deployer',
]);

function isBootstrapProjectRoleBinding(binding) {
  if (!binding) return false;
  if (isAutoProvisionedProjectAdminBinding(binding)) return true;
  const name = resourceName(binding);
  if (BOOTSTRAP_PROJECT_ROLE_BINDING_NAMES.has(name)) return true;
  const roleRef = resourceSpec(binding).roleRef || {};
  return BOOTSTRAP_PROJECT_ROLE_REF_NAMES.has(String(roleRef.name || ''));
}

/**
 * Does a resource exist AND count as up? Used by `deploy` objectives that set
 * `running: true` (L1: a Pod rejected by restricted-v2 is created in `Failed`
 * state, so mere existence must not tick "run a Pod").
 */
function resourceIsUp(resource) {
  if (!resource) return false;
  const kind = String(resource.kind || '');
  if (kind === 'Pod') {
    const phase = resourceStatus(resource).phase;
    if (phase === 'Running') {
      return typeof resource.isConditionTrue === 'function'
        ? resource.isConditionTrue('Ready')
        : true;
    }
    return false;
  }
  if (
    kind === 'Deployment' ||
    kind === 'ReplicaSet' ||
    kind === 'StatefulSet' ||
    kind === 'DaemonSet'
  ) {
    const status = resourceStatus(resource);
    return asNumber(status.availableReplicas ?? status.readyReplicas, 0) > 0;
  }
  if (kind === 'Job') {
    const phase = resourceStatus(resource).phase;
    return phase === 'Complete' || phase === 'Succeeded';
  }
  return true;
}

function evaluateDeploy(obj, c) {
  const kind = canonicalKind(obj.kind);
  const name = obj.name;
  const namespace = objectiveResourceNamespace(c, obj, kind);
  const requireRunning = obj.running === true || obj.phase === 'Running';
  if (name) {
    const resource = findResource(c.clusterState, kind, name, namespace);
    if (!resource) return bool(false);
    return bool(!requireRunning || resourceIsUp(resource));
  }
  let resources = listKind(c.clusterState, kind);
  if (namespace)
    resources = resources.filter((resource) => resourceNamespace(resource) === namespace);
  // Count-only RBAC objectives ("bind a role in <project>") must be scoped to
  // the level's project; otherwise any RoleBinding anywhere in the cluster counts.
  if (!namespace && kind === 'RoleBinding') {
    const expected = levelProjectNamespace(c);
    if (expected)
      resources = resources.filter((resource) => resourceNamespace(resource) === expected);
  }
  // Every project provisions its four bootstrap RoleBindings (admin +
  // system:image-pullers/builders/deployers, issue #35); they are not
  // learner-created, so count-only RBAC objectives (L14/L16/lab 11) must ignore
  // them or they pre-tick at level start.
  if (kind === 'RoleBinding') {
    resources = resources.filter((resource) => !isBootstrapProjectRoleBinding(resource));
  }
  if (requireRunning) resources = resources.filter((resource) => resourceIsUp(resource));
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
  // Namespace-correct grading (#30 / #29): a label objective may only be
  // satisfied by the object that lives in the objective's project. An
  // unlabelled namespaced target cannot be verified, so it stays incomplete
  // rather than crediting a same-named object in another project.
  if (namespace === null && !CLUSTER_SCOPED_KINDS.has(kind)) return bool(false);
  let resources = listKind(c.clusterState, kind);
  if (name) resources = resources.filter((resource) => resourceName(resource) === name);
  if (namespace)
    resources = resources.filter((resource) => resourceNamespace(resource) === namespace);
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

// ─── behaviour probes: network policy (issue #30) ──────────────────────────
//
// Challenge 9 grades "zero-trust project networking", not the names of the
// learner's NetworkPolicy objects. These probes call the same traffic
// evaluator that `oc exec … curl` uses, so a hand-written policy set with the
// right behaviour earns full credit. Purpose-built objective fields:
//   probe: 'default-deny' → unlabelled Pods in the project are isolated for
//          Ingress *and* Egress (no Pod-to-Pod and no internet egress),
//   probe: 'dns-egress'   → a frontend Pod can resolve DNS (5353 to
//          openshift-dns) while the project is otherwise isolated,
//   probe: 'reach'        → source can reach `to`:port (allowed path),
//   probe: 'deny'         → source cannot reach `to`:port,
//   (the destination descriptor field is `to`, not `target`, because the
//   progress wrapper owns `target` as the objective's completion count.)
//   probe: 'deny-external'→ source resolves names but cannot reach the
//          internet, and the denial comes from the egress policy (not from a
//          broken DNS egress rule).
// Probe Pods are synthesised from the workloads' own pod templates, so
// grading never races the Deployment controller creating concrete Pods.

function simulationOf(c) {
  const engine = c.gameEngine;
  const simulation = engine?.simulation || engine?.engine?.simulation || null;
  if (!simulation || typeof simulation.canReach !== 'function') return null;
  return simulation;
}

function networkProbeNamespace(obj, c) {
  return obj.namespace || levelProjectNamespace(c) || '';
}

function cloneTemplateSpec(spec) {
  try {
    return JSON.parse(JSON.stringify(spec || {}));
  } catch {
    return { containers: [] };
  }
}

/** Build a Pod-shaped probe from a workload descriptor's pod template. */
function workloadProbePod(c, descriptor, fallbackNamespace) {
  if (!descriptor) return null;
  const ref =
    typeof descriptor === 'string' ? { kind: 'Deployment', name: descriptor } : descriptor;
  const kind = canonicalKind(ref.kind || 'Deployment');
  const name = ref.name;
  if (!name) return null;
  const namespace = ref.namespace || fallbackNamespace || '';
  const resource = findResource(c.clusterState, kind, name, namespace || undefined);
  if (!resource) return null;
  if (kind === 'Pod') return resource;
  const template = resourceSpec(resource).template || {};
  const labels = { ...resourceLabels(resource), ...(template.metadata?.labels || {}) };
  const spec = cloneTemplateSpec(template.spec);
  if (!Array.isArray(spec.containers) || spec.containers.length === 0) {
    spec.containers = [{ name: 'probe', image: 'busybox' }];
  }
  return {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      name: `${name}-network-probe`,
      namespace: resourceNamespace(resource) || namespace,
      labels,
    },
    spec,
  };
}

/** Build a Pod-shaped endpoint probe for a Service target. */
function serviceProbePod(c, descriptor, fallbackNamespace) {
  const ref = typeof descriptor === 'string' ? { name: descriptor } : descriptor;
  if (!ref?.name) return null;
  const namespace = ref.namespace || fallbackNamespace || '';
  const service = findResource(c.clusterState, 'Service', ref.name, namespace || undefined);
  if (!service) return null;
  const spec = resourceSpec(service);
  const selector = spec.selector || {};
  const firstPort = asArray(spec.ports)[0] || {};
  const targetPort = asNumber(firstPort.targetPort ?? firstPort.port, 80);
  return {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      name: `${ref.name}-network-probe`,
      namespace: resourceNamespace(service) || namespace,
      labels: { ...selector },
    },
    spec: {
      containers: [{ name: 'probe', image: 'busybox', ports: [{ containerPort: targetPort }] }],
    },
  };
}

function networkTargetPod(c, descriptor, fallbackNamespace) {
  if (!descriptor) return null;
  const kind = canonicalKind(typeof descriptor === 'string' ? 'Service' : descriptor.kind || 'Pod');
  if (kind === 'Service') return serviceProbePod(c, descriptor, fallbackNamespace);
  return workloadProbePod(c, descriptor, fallbackNamespace);
}

/** An unlabelled probe Pod: only a namespace-wide policy can select it. */
function neutralProbePod(namespace, suffix) {
  return {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: { name: `netpol-probe-${suffix}`, namespace, labels: {} },
    spec: { containers: [{ name: 'probe', image: 'busybox' }] },
  };
}

function probeTrafficForExec(sim, sourcePod, target, namespace, options = {}) {
  if (!sourcePod || typeof sim.trafficForExec !== 'function') return null;
  return sim.trafficForExec(sourcePod, { target, namespace, ...options });
}

/** Is the project isolated in both directions for a Pod with no allow rules? */
function namespaceIsolationActive(c, namespace) {
  const sim = simulationOf(c);
  if (!sim || !namespace) return false;
  const peerA = neutralProbePod(namespace, 'a');
  const peerB = neutralProbePod(namespace, 'b');
  if (sim.canReach(peerA, peerB, { namespace, port: 8080, protocol: 'TCP' }).allowed !== false)
    return false;
  const external = probeTrafficForExec(sim, peerA, 'http://example.com', namespace, { port: 80 });
  return external !== null && external.allowed === false;
}

// ─── policy-shape grading for the capstone (#37) ───────────────────────────
//
// L20 must grade "add a default-deny NetworkPolicy" on the policy's behaviour
// in the project, not on a hidden `metadata.name` — a hand-written policy that
// isolates all Pods for Ingress is exactly as valid as the shipped example.
// These helpers mirror the simulator's own policy parsing (policyTypes defaults
// to Ingress; an empty podSelector selects every Pod).

function networkPolicyTypesOf(policy) {
  const spec = resourceSpec(policy);
  if (Array.isArray(spec.policyTypes) && spec.policyTypes.length > 0) {
    return spec.policyTypes.map((entry) => String(entry));
  }
  const types = ['Ingress'];
  if (asArray(spec.egress).length > 0) types.push('Egress');
  return types;
}

/** Does this podSelector match every Pod in the namespace (`{}`-equivalent)? */
function podSelectorMatchesAll(selector) {
  if (selector === undefined || selector === null) return true;
  if (typeof selector !== 'object') return false;
  const matchLabels = selector.matchLabels;
  const matchExpressions = selector.matchExpressions;
  const labelsEmpty = !matchLabels || Object.keys(matchLabels).length === 0;
  const expressionsEmpty = !matchExpressions || asArray(matchExpressions).length === 0;
  return labelsEmpty && expressionsEmpty;
}

/** A default-deny: selects all Pods, isolates Ingress and allows no ingress. */
function isIngressIsolationPolicy(policy) {
  const spec = resourceSpec(policy);
  if (!networkPolicyTypesOf(policy).includes('Ingress')) return false;
  if (!podSelectorMatchesAll(spec.podSelector)) return false;
  return asArray(spec.ingress).length === 0;
}

/** Any NetworkPolicy in the project isolates all Pods for Ingress (#37). */
function namespaceHasIngressIsolation(c, namespace) {
  if (!namespace) return false;
  return listKind(c.clusterState, 'NetworkPolicy')
    .filter((policy) => resourceNamespace(policy) === namespace)
    .some(isIngressIsolationPolicy);
}

function probeDnsEgress(c, obj, namespace) {
  const sim = simulationOf(c);
  if (!sim || typeof sim.canResolveDNS !== 'function') return false;
  // "Allow DNS while everything else is denied": the project must already be
  // egress-isolated, otherwise an unrestricted cluster would pass trivially.
  if (!namespaceIsolationActive(c, namespace)) return false;
  const source = workloadProbePod(
    c,
    obj.source || { kind: 'Deployment', name: 'frontend' },
    namespace
  );
  if (!source) return false;
  return sim.canResolveDNS(source).allowed === true;
}

function probeReach(c, obj, namespace, expected) {
  const sim = simulationOf(c);
  if (!sim) return false;
  // The allowed path only counts once the project is actually isolated: with
  // no NetworkPolicy at all, frontend → backend is reachable by default.
  if (expected && !namespaceIsolationActive(c, namespace)) return false;
  const source = workloadProbePod(c, obj.source, namespace);
  const target = networkTargetPod(c, obj.to, namespace);
  if (!source || !target) return false;
  const port = asNumber(obj.port, 80);
  const protocol = String(obj.protocol || 'TCP').toUpperCase();
  const outcome = sim.canReach(source, target, { namespace, port, protocol });
  return outcome.allowed === expected;
}

function probeExternalDenied(c, obj, namespace) {
  const sim = simulationOf(c);
  const source = workloadProbePod(c, obj.source, namespace);
  if (!source) return false;
  const external = probeTrafficForExec(sim, source, 'http://example.com', namespace, { port: 80 });
  if (!external || external.allowed !== false) return false;
  // A failed DNS lookup must not satisfy "external traffic is blocked": the
  // denial has to come from the egress policy after name resolution works.
  return external.reason !== 'dns-egress';
}

function evaluateNetworkPolicy(obj, c) {
  const probe = String(obj.probe || obj.check || '').toLowerCase();
  const namespace = networkProbeNamespace(obj, c);
  if (!namespace || !simulationOf(c)) return bool(false);
  switch (probe) {
    case 'default-deny':
      return bool(namespaceIsolationActive(c, namespace));
    // Capstone variant (#37): only the Ingress direction is isolated. L20's
    // shipped default-deny also blocks Egress, but a player-written
    // `policyTypes: [Ingress]` deny-all satisfies the objective just as well.
    case 'ingress-isolation':
      return bool(namespaceHasIngressIsolation(c, namespace));
    case 'dns-egress':
      return bool(probeDnsEgress(c, obj, namespace));
    case 'reach':
      return bool(probeReach(c, obj, namespace, true));
    case 'deny':
      return bool(probeReach(c, obj, namespace, false));
    case 'deny-external':
      return bool(probeExternalDenied(c, obj, namespace));
    default:
      return bool(false);
  }
}

function evaluateScale(obj, c) {
  const kind = canonicalKind(obj.kind || 'Deployment');
  const replicas = Math.max(1, asNumber(obj.replicas, 1));
  let resources = listKind(c.clusterState, kind);
  if (obj.name) resources = resources.filter((resource) => resourceName(resource) === obj.name);
  const scaleNamespace = objectiveResourceNamespace(c, obj, kind);
  if (scaleNamespace)
    resources = resources.filter((resource) => resourceNamespace(resource) === scaleNamespace);
  if (resources.length === 0) return result(false, 0, replicas);
  const maxReplicas = Math.max(
    ...resources.map((resource) => asNumber(resourceSpec(resource).replicas, 0))
  );
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

// ─── login / secret evidence and OAuth identity-provider state (issue #30) ─
//
// `oc login -u alice …; oc whoami; oc login -u kubeadmin` must still tick
// "Log in to the CLI as alice": the objective latches on a successful login
// event instead of only looking at the current session. The engine's own
// login history is authoritative (openshift-details owns the login path and
// clears it on every level seeding, so a retry cannot be pre-ticked); the
// EventBus latch below covers builds without that history and also timestamps
// OAuth Secret writes for the password-rotation objective.
//
// The evidence cache is keyed by game engine and lives for the page session.
// Entries are appended by EventBus events; nothing here mutates the cluster.

const gradingEvidenceCache = new WeakMap();

function evidenceCache(engine) {
  if (!engine || typeof engine !== 'object') return null;
  let cache = gradingEvidenceCache.get(engine);
  if (!cache) {
    cache = { entries: [], secretTouches: new Map() };
    gradingEvidenceCache.set(engine, cache);
    try {
      const bus = engine.eventBus;
      if (bus && typeof bus.on === 'function') {
        bus.on('login', (data) => {
          const user =
            typeof data === 'string' ? data : (data?.user ?? data?.username ?? data?.name);
          if (!user) return;
          cache.entries.push({
            user: String(user),
            provider: data?.provider || null,
            time: Date.now(),
          });
          if (cache.entries.length > 200) cache.entries.splice(0, cache.entries.length - 200);
        });
        const noteSecret = (data) => {
          const resource = data?.resource;
          if (!resource || String(resource.kind || data?.kind || '') !== 'Secret') return;
          const namespace = resource.metadata?.namespace || data?.namespace || '';
          if (namespace !== 'openshift-config') return;
          const name = resource.metadata?.name || data?.name || '';
          if (name) cache.secretTouches.set(name, Date.now());
        };
        bus.on('cluster:modified', noteSecret);
        bus.on('cluster:added', noteSecret);
      }
    } catch {
      /* feature-detected: an engine without an event bus simply has no latch */
    }
  }
  return cache;
}

function latchLoginEvents(engine) {
  return evidenceCache(engine)?.entries || null;
}

function loginEntryUser(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return String(entry.user ?? entry.username ?? entry.name ?? '');
}

function callLoginHistory(owner, method) {
  if (!owner || typeof owner[method] !== 'function') return null;
  try {
    const list = owner[method]();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

function arrayLoginHistory(owner, property) {
  if (!owner) return null;
  const value = owner[property];
  return Array.isArray(value) ? value : null;
}

/**
 * Owner-provided login history (authoritative). Returned as soon as a provider
 * is capable of answering (even when the list is still empty), so an empty
 * owner history is not confused with "no owner history exists".
 * @returns {Array<{user: string, provider?: string, time?: number}>|null}
 */
function providerLoginHistory(c) {
  const engine = c.gameEngine;
  const cluster = c.clusterState;
  const candidates = [
    callLoginHistory(engine, 'getLoginHistory'),
    arrayLoginHistory(engine, 'loginHistory'),
    arrayLoginHistory(engine, 'recentLogins'),
    callLoginHistory(cluster, 'getLoginHistory'),
    arrayLoginHistory(cluster, 'loginHistory'),
    arrayLoginHistory(cluster, 'recentLogins'),
  ];
  for (const list of candidates) {
    if (Array.isArray(list)) return list;
  }
  return null;
}

function loginHistory(c) {
  const owned = providerLoginHistory(c);
  if (owned) return owned;
  return latchLoginEvents(c.gameEngine) || [];
}

function evaluateLogin(obj, c) {
  const wanted = obj.user ? String(obj.user) : null;
  const matches = (user) => (wanted ? user === wanted : Boolean(user));
  const currentUser = c.gameEngine?.currentUser || null;
  const owned = providerLoginHistory(c);
  if (owned) {
    // The engine history is reset on level seeding, so any matching login is
    // evidence for THIS run. Latch: later logins/logouts must not un-tick.
    if (owned.some((entry) => matches(loginEntryUser(entry)))) return bool(true);
  } else {
    const latched = latchLoginEvents(c.gameEngine) || [];
    if (latched.length > 0) {
      const baseline = ensureBaseline(obj, () => ({ historyLength: latched.length }));
      const start = Math.min(Math.max(0, asNumber(baseline.historyLength, 0)), latched.length);
      if (latched.slice(start).some((entry) => matches(loginEntryUser(entry)))) return bool(true);
    }
  }
  return bool(matches(currentUser));
}

/**
 * Real cluster state only: OpenShift creates the User object on first login
 * (`oc adm groups new`/`add-users` only record group membership). A bare name
 * in a Group must therefore not tick "User alice exists" (issue #30).
 */
function evaluateUser(obj, c) {
  const users = listKind(c.clusterState, 'User');
  if (obj.name) {
    const present = users.some((user) => resourceName(user) === obj.name);
    // `exists: false` grades a real deletion (issue #34 auth-users bullet).
    return bool(obj.exists === false ? !present : present);
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(users.length >= target, Math.min(users.length, target), target);
}

/**
 * Identity objects (issue #34): `oc delete user bob` deliberately leaves the
 * Identity (`htpasswd:bob`) behind on a real cluster, so cleanup is graded on
 * the separate Identity resource. Match by exact metadata.name, or by the
 * spec user/providerUserName when only `user` is supplied.
 */
function evaluateIdentity(obj, c) {
  const identities = listKind(c.clusterState, 'Identity');
  const wantedName = obj.name ? String(obj.name) : '';
  const wantedUser = obj.user ? String(obj.user) : '';
  if (!wantedName && !wantedUser) return bool(false);
  const present = identities.some((identity) => {
    if (wantedName) return resourceName(identity) === wantedName;
    const spec = resourceSpec(identity);
    const userName = String(spec.user?.name || spec.userName || '');
    const providerUserName = String(spec.providerUserName || '');
    return userName === wantedUser || providerUserName === wantedUser;
  });
  return bool(obj.exists === false ? !present : present);
}

function htpasswdSecretOf(provider) {
  return provider?.htpasswd?.fileData?.name || provider?.htpasswd?.secret?.name || '';
}

/**
 * OAuth identity-provider state (issue #30): grade
 * `oauth.config.openshift.io/cluster` and the live authentication rollout
 * instead of a command regex. Heredoc applies, `oc apply -f` and
 * `oc patch oauth cluster` all count once the provider is really active.
 */
function evaluateOAuthProvider(obj, c) {
  const wantedType = String(obj.providerType || 'HTPasswd').toLowerCase();
  const wantedSecret = obj.secretName ? String(obj.secretName) : null;
  const cluster = c.clusterState;
  let oauth = null;
  try {
    if (cluster && typeof cluster.getOAuth === 'function') oauth = cluster.getOAuth();
  } catch {
    /* ignore */
  }
  if (!oauth) oauth = findResource(cluster, 'OAuth', obj.oauthName || 'cluster', '');
  const provider = asArray(oauth?.spec?.identityProviders).find((candidate) => {
    if (!candidate || String(candidate.type || '').toLowerCase() !== wantedType) return false;
    if (obj.providerName && candidate.name !== obj.providerName) return false;
    if (wantedSecret && htpasswdSecretOf(candidate) !== wantedSecret) return false;
    return true;
  });
  if (!provider) return bool(false);
  // "The provider actually active": the authentication operator completed the
  // OAuth rollout for this configuration. GameEngine only flips authProvider to
  // ready after that rollout, so a configured-but-not-rolled-out provider does
  // not tick yet.
  const engine = c.gameEngine;
  try {
    if (engine && typeof engine.getAuthProvider === 'function') {
      const active = engine.getAuthProvider();
      if (!active || active.ready !== true) return bool(false);
      if (wantedSecret && String(active.secretName || '') !== wantedSecret) return bool(false);
      return bool(true);
    }
  } catch {
    /* fall through to the cluster view */
  }
  const config =
    cluster && typeof cluster.getAuthProviderConfig === 'function'
      ? cluster.getAuthProviderConfig()
      : null;
  return bool(Boolean(config));
}

// ─── HTPasswd password rotation (issue #34 auth-passwords) ────────────────
//
// Grades the real rotation flow: the IdP-referenced Secret's htpasswd entry for
// the user must verify the requested password, the authentication provider must
// be active, and (optional `requireLogin`) the user must have logged in AFTER
// the most recent write to that Secret — so a login with the previous password
// cannot satisfy the objective.

function passwordProviderSecretName(c) {
  const engine = c.gameEngine;
  try {
    if (engine && typeof engine._providerSecretName === 'function') {
      const name = engine._providerSecretName();
      if (name) return String(name);
    }
  } catch {
    /* feature-detect */
  }
  const provider = engine?.authProvider;
  if (provider) {
    const name = provider.secretName || provider.htpasswd?.fileData?.name;
    if (name) return String(name);
  }
  try {
    const config = c.clusterState?.getAuthProviderConfig?.();
    if (config?.secretName) return String(config.secretName);
  } catch {
    /* ignore */
  }
  return '';
}

/** Is the configured HTPasswd provider live (OAuth rollout finished)? */
function identityProviderActive(c) {
  const engine = c.gameEngine;
  try {
    if (engine && typeof engine.getAuthProvider === 'function') {
      const provider = engine.getAuthProvider();
      if (!provider || provider.ready !== true) return false;
      if (engine.simulation && engine.simulation._oauthPending) return false;
      return true;
    }
  } catch {
    /* fall through to the cluster view */
  }
  try {
    return Boolean(c.clusterState?.getAuthProviderConfig?.());
  } catch {
    return false;
  }
}

function decodeBase64Text(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    if (typeof atob === 'function') return atob(value);
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    /* ignore */
  }
  return null;
}

/** `[{user, hash}]` from the Secret the identity provider references. */
function htpasswdEntriesFor(c) {
  const engine = c.gameEngine;
  try {
    if (engine && typeof engine._getHtpasswdEntries === 'function') {
      const entries = engine._getHtpasswdEntries();
      if (Array.isArray(entries)) return entries;
    }
  } catch {
    /* feature-detect */
  }
  const secretName = passwordProviderSecretName(c);
  if (!secretName) return null;
  const secret = findResource(c.clusterState, 'Secret', secretName, 'openshift-config');
  const encoded = secret?.spec?.data?.htpasswd ?? secret?.data?.htpasswd;
  const text = decodeBase64Text(encoded);
  if (!text) return null;
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf(':');
      return separator > 0
        ? { user: line.slice(0, separator), hash: line.slice(separator + 1) }
        : null;
    })
    .filter(Boolean);
}

function passwordVerifies(c, user, password) {
  const engine = c.gameEngine;
  const entries = htpasswdEntriesFor(c);
  if (!entries) return false;
  const entry = entries.find((candidate) => candidate && String(candidate.user) === String(user));
  if (!entry) return false;
  try {
    if (engine && typeof engine.verifyHtpasswdPasswordHash === 'function')
      return engine.verifyHtpasswdPasswordHash(user, entry.hash, password) === true;
  } catch {
    /* fall through to the plaintext comparison */
  }
  return String(entry.hash) === String(password);
}

function evaluatePassword(obj, c) {
  const user = obj.user ? String(obj.user) : '';
  if (!user || obj.password === undefined || obj.password === null) return bool(false);
  if (!identityProviderActive(c)) return bool(false);
  if (!passwordVerifies(c, user, obj.password)) return bool(false);
  if (!obj.requireLogin) return bool(true);
  const secretName = passwordProviderSecretName(c);
  if (!secretName) return bool(false);
  const history = loginHistory(c);
  const cache = evidenceCache(c.gameEngine);
  const rotatedAt = cache?.secretTouches?.get(secretName);
  let tail = history;
  if (typeof rotatedAt === 'number') {
    // The EventBus timestamp orders the Secret write against the logins, so a
    // login with the OLD password that happened before the rotation is ignored.
    tail = history.filter((entry) => {
      const time = entry && typeof entry === 'object' ? Number(entry.time) : NaN;
      return !Number.isFinite(time) || time >= rotatedAt;
    });
  } else {
    // No observed Secret write (e.g. rotated before this session's first
    // evaluation): fall back to a rolling history baseline.
    const baseline = ensureBaseline(obj, () => ({ historyLength: history.length }));
    const start = Math.min(Math.max(0, asNumber(baseline.historyLength, 0)), history.length);
    tail = history.slice(start);
  }
  return bool(tail.some((entry) => loginEntryUser(entry) === user));
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
      const check = c.clusterState.canI(
        user || engine?.currentUser || 'kubeadmin',
        verb,
        resource,
        namespace
      );
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
  const workloads = listKinds(cluster, [
    'Deployment',
    'StatefulSet',
    'DaemonSet',
    'Pod',
    'ReplicaSet',
  ]);
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
    const condition = asArray(entry?.conditions).find(
      (candidate) => candidate?.type === 'Admitted'
    );
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

/**
 * Can the workstation reach a Route through the router/NetworkPolicy model
 * (issue #33): uses the simulator's `canRouterReach(route, {namespace})`
 * helper, so grading follows the same path an HTTP request from the
 * workstation would take (Router → Service → Pods → policy evaluation).
 */
function evaluateRouteAccess(obj, c) {
  const namespace = obj.namespace || levelProjectNamespace(c);
  const route = obj.name
    ? findResource(c.clusterState, 'Route', obj.name, namespace || undefined)
    : null;
  if (!route) return result(false, 0, 1);
  // Capstone hardening (#37): before any NetworkPolicy exists the router can
  // trivially reach the Route, so "reachable through the router" must not tick.
  // With `requireIsolation` the project has to be ingress-isolated first (any
  // default-deny policy) and a router-allowing ingress policy still has to let
  // the end-to-end request through before this objective counts.
  if (
    obj.requireIsolation === true &&
    !namespaceHasIngressIsolation(c, resourceNamespace(route) || namespace)
  ) {
    return result(false, 0, 1);
  }
  const sim = c.gameEngine?.simulation || c.gameEngine?.engine?.simulation || null;
  if (!sim || typeof sim.canRouterReach !== 'function') return result(false, 0, 1);
  let reach = null;
  try {
    reach = sim.canRouterReach(route, { namespace: resourceNamespace(route) || namespace });
  } catch {
    reach = null;
  }
  if (!reach) return result(false, 0, 1);
  return result(Boolean(reach.allowed), reach.allowed ? 1 : 0, 1);
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
  if (buildNamespace)
    builds = builds.filter((build) => resourceNamespace(build) === buildNamespace);
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
    const bc = findResource(
      c.clusterState,
      'BuildConfig',
      obj.name,
      objectiveResourceNamespace(c, obj, 'BuildConfig')
    );
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
    if (countNamespace)
      streams = streams.filter((stream) => resourceNamespace(stream) === countNamespace);
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
  if (imageNamespace)
    workloads = workloads.filter((resource) => resourceNamespace(resource) === imageNamespace);
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
    const paramsOk =
      !params ||
      processed.some((entry) =>
        Object.entries(params).every(([key, value]) =>
          new RegExp(`${escapeRegex(key)}\\s*=\\s*${escapeRegex(String(value))}`, 'i').test(
            entry.raw
          )
        )
      );
    const appliedAfterProcessing = applied.some((applyEntry) =>
      processed.some(
        (processEntry) => asNumber(applyEntry.timestamp, 0) >= asNumber(processEntry.timestamp, 0)
      )
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
  // Phase-2B OLM variants (issue #34): scope to an install namespace, and model
  // the AllNamespaces (global OperatorGroup) install in openshift-operators.
  const namespaceFilter =
    obj.namespace || (obj.allNamespaces === true ? 'openshift-operators' : '');
  const matching = subscriptions.filter((subscription) => {
    if (namespaceFilter && resourceNamespace(subscription) !== namespaceFilter) return false;
    if (!wanted) return true;
    const spec = resourceSpec(subscription);
    const haystack =
      `${resourceName(subscription)} ${spec.name || ''} ${spec.packageName || ''}`.toLowerCase();
    return haystack.includes(wanted);
  });
  const succeeded = matching.filter(
    (subscription) => resourceStatus(subscription).phase === 'Succeeded'
  ).length;
  const csvSucceeded = listKind(c.clusterState, 'ClusterServiceVersion').filter((csv) => {
    if (namespaceFilter && resourceNamespace(csv) !== namespaceFilter) return false;
    const name = resourceName(csv).toLowerCase();
    if (wanted && !name.includes(wanted)) return false;
    return resourceStatus(csv).phase === 'Succeeded';
  }).length;
  const installed = obj.installed !== false;
  if (installed) {
    const target = Math.max(1, asNumber(obj.count, 1));
    const observed = Math.max(succeeded, csvSucceeded);
    if (observed >= target) obj._installedLatch = true;
    // Latch: in L18 the same level then uninstalls the operator, so the
    // "install" objective must stay complete once the CSV was observed
    // Succeeded (#14 end-state vs objective ordering; runtime repro).
    const done = observed >= target || (Boolean(c.levelDef) && obj._installedLatch === true);
    return result(done, done ? target : Math.min(observed, target), target);
  }
  // "Uninstall" only makes sense once the operator was present during this
  // level; otherwise the objective would be complete at level start (L18).
  if (matching.length > 0) obj._sawInstalled = true;
  const target = Math.max(1, asNumber(obj.count, 1));
  const levelContext = Boolean(c.levelDef);
  const done = matching.length === 0 && (!levelContext || obj._sawInstalled === true);
  return result(done, done ? target : 0, target);
}

function installPlanMatches(plan, packageName, namespace) {
  if (namespace && resourceNamespace(plan) !== namespace) return false;
  if (!packageName) return true;
  const wanted = String(packageName).toLowerCase();
  const labels = resourceLabels(plan);
  const packageLabel = String(labels['operators.coreos.com/package'] || '').toLowerCase();
  if (packageLabel && (packageLabel === wanted || packageLabel.includes(wanted))) return true;
  const csvNames = asArray(resourceSpec(plan).clusterServiceVersionNames).map((name) =>
    String(name).toLowerCase()
  );
  return csvNames.some((name) => name.includes(wanted));
}

/**
 * OLM InstallPlan approval (issue #34): the Manual-approval flow waits at
 * RequiresApproval until the learner approves the plan, then OLM completes it
 * and the CSV reaches Succeeded. Latched once observed because L18 uninstalls
 * operators later in the same level.
 */
function evaluateInstallPlan(obj, c) {
  const namespace = obj.namespace || levelProjectNamespace(c) || '';
  const packageName = String(obj.package || obj.name || '');
  const approval = obj.approval ? String(obj.approval) : null;
  const plans = listKind(c.clusterState, 'InstallPlan').filter((plan) => {
    if (!installPlanMatches(plan, packageName, namespace)) return false;
    if (approval && String(resourceSpec(plan).approval || '') !== approval) return false;
    return true;
  });
  const approved = plans.some((plan) => resourceSpec(plan).approved === true);
  const complete = plans.some((plan) => resourceStatus(plan).phase === 'Complete');
  const csvNames = new Set(
    plans.flatMap((plan) =>
      asArray(resourceSpec(plan).clusterServiceVersionNames).map((name) => String(name))
    )
  );
  const csvSucceeded = listKind(c.clusterState, 'ClusterServiceVersion').some((csv) => {
    if (namespace && resourceNamespace(csv) !== namespace) return false;
    if (csvNames.size > 0 && !csvNames.has(resourceName(csv))) return false;
    if (packageName && !resourceName(csv).toLowerCase().includes(packageName.toLowerCase()))
      return false;
    return resourceStatus(csv).phase === 'Succeeded';
  });
  const observed = approved && (complete || csvSucceeded);
  if (observed) obj._installPlanLatch = true;
  const done = observed || (Boolean(c.levelDef) && obj._installPlanLatch === true);
  return bool(done);
}

/**
 * Head CSV of the catalog channel a Subscription tracks, read from the
 * cluster's PackageManifest (`status.channels[*].currentCSV`). Used to grade the
 * L18 "pin the install" objective on state: a valid pin installs a CSV that is
 * an older channel entry, never the channel head itself (issue #48.1).
 *
 * @param {object} cluster
 * @param {object} spec Subscription spec
 * @returns {string} channel-head CSV name ('' when the catalog is unavailable)
 */
function packageChannelHead(cluster, spec) {
  const packageName = String(spec?.name || spec?.packageName || '');
  if (!packageName) return '';
  const manifest = listKind(cluster, 'PackageManifest').find(
    (candidate) =>
      resourceName(candidate) === packageName ||
      String(resourceSpec(candidate).packageName || '') === packageName
  );
  if (!manifest) return '';
  const status = resourceStatus(manifest);
  const channels = asArray(status.channels).length
    ? asArray(status.channels)
    : asArray(resourceSpec(manifest).channels);
  const channelName = String(spec?.channel || status.defaultChannel || '');
  const channel =
    channels.find((candidate) => String(candidate.name || '') === channelName) ||
    channels[0] ||
    null;
  const entries = asArray(channel?.entries);
  return String(channel?.currentCSV || entries[0]?.name || '');
}

/**
 * OLM Subscription declaration (issue #34): all supplied spec fields
 * (channel/startingCSV/installPlanApproval, …) must match a real Subscription.
 * Latched once observed because the L18 flow can uninstall it afterwards.
 *
 * State-based pin grading (issue #48.1): `pinnedInstall: true` grades the
 * out*come* instead of hard-coded values — the Subscription must have installed
 * exactly the CSV named by its own `spec.startingCSV`, and that pin must be an
 * older (non-head) entry of the channel it tracks. Any valid channel entry the
 * player pins therefore satisfies the objective (e.g. v1.16.0 with Manual
 * approval), while installing the channel head or leaving the pin unresolved
 * does not.
 */
function evaluateSubscription(obj, c) {
  const namespace = obj.namespace || levelProjectNamespace(c) || '';
  const wantedName = obj.name ? String(obj.name) : '';
  const packageName = String(obj.package || obj.name || '');
  const requiresPinnedInstall = obj.pinnedInstall === true;
  const fields = ['channel', 'startingCSV', 'installPlanApproval', 'source', 'sourceNamespace'];
  const matching = listKind(c.clusterState, 'Subscription').filter((subscription) => {
    if (namespace && resourceNamespace(subscription) !== namespace) return false;
    const spec = resourceSpec(subscription);
    const status = resourceStatus(subscription);
    const haystack =
      `${resourceName(subscription)} ${spec.name || ''} ${spec.packageName || ''}`.toLowerCase();
    if (packageName && !haystack.includes(packageName.toLowerCase())) return false;
    if (
      wantedName &&
      resourceName(subscription) !== wantedName &&
      !haystack.includes(wantedName.toLowerCase())
    ) {
      // A Subscription renamed by the learner still counts when it installs the
      // same package; the package match above is the authoritative selector.
    }
    for (const field of fields) {
      if (obj[field] === undefined || obj[field] === null) continue;
      if (String(spec[field] ?? '') !== String(obj[field])) return false;
    }
    if (requiresPinnedInstall) {
      // The installed CSV must BE the pinned CSV, and the pin must not be the
      // channel head (pinning the head is just a normal install, not a pin).
      const pinned = String(spec.startingCSV || '');
      const installed = String(status.installedCSV || '');
      if (!pinned || !installed || installed !== pinned) return false;
      const channelHead = packageChannelHead(c.clusterState, spec);
      if (channelHead && pinned === channelHead) return false;
    }
    if (
      obj.statusPhase &&
      String(resourceStatus(subscription).phase || '') !== String(obj.statusPhase)
    )
      return false;
    if (
      obj.installedCSV &&
      String(resourceStatus(subscription).installedCSV || '') !== String(obj.installedCSV)
    )
      return false;
    if (
      obj.currentCSV &&
      String(resourceStatus(subscription).currentCSV || '') !== String(obj.currentCSV)
    )
      return false;
    return true;
  });
  const observed = matching.length > 0;
  if (observed) obj._subscriptionLatch = true;
  const done = observed || (Boolean(c.levelDef) && obj._subscriptionLatch === true);
  return bool(done);
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

/**
 * Does a binding subject list grant `subject`? Subject strings accepted here are
 * the game/CLI spellings: `system:serviceaccount:<ns>:<sa>`, `user:<name>`,
 * `group:<name>`, or a bare user/group name. RBAC subjects are matched by
 * kind + name (+ namespace for ServiceAccounts).
 */
function bindingSubjectMatches(subjects, wanted) {
  if (!wanted) return true;
  const list = asArray(subjects);
  const target = String(wanted);
  let kind = 'User';
  let name = target;
  let namespace = '';
  if (target.startsWith('system:serviceaccount:')) {
    kind = 'ServiceAccount';
    const rest = target.slice('system:serviceaccount:'.length);
    const split = rest.lastIndexOf(':');
    if (split > 0) {
      namespace = rest.slice(0, split);
      name = rest.slice(split + 1);
    } else {
      name = rest;
    }
  } else if (target.startsWith('serviceaccount:')) {
    kind = 'ServiceAccount';
    const rest = target.slice('serviceaccount:'.length);
    const split = rest.lastIndexOf(':');
    namespace = split > 0 ? rest.slice(0, split) : '';
    name = split > 0 ? rest.slice(split + 1) : rest;
  } else if (target.startsWith('user:')) {
    kind = 'User';
    name = target.slice(5);
  } else if (target.startsWith('group:')) {
    kind = 'Group';
    name = target.slice(6);
  }
  const matchesSubject = (subject) => {
    if (!subject) return false;
    const subjectKind = subject.kind || 'User';
    if (kind === 'ServiceAccount') {
      return (
        subjectKind === 'ServiceAccount' &&
        String(subject.name) === name &&
        (!namespace || !subject.namespace || String(subject.namespace) === namespace)
      );
    }
    if (kind === 'Group') return subjectKind === 'Group' && String(subject.name) === name;
    return subjectKind === 'User' && String(subject.name) === name;
  };
  return list.some(matchesSubject);
}

/**
 * Subjects granted an SCC under the OCP 4.x model. The authoritative source is
 * an RBAC binding whose roleRef is ClusterRole `system:openshift:scc:<name>`:
 *   - users/groups → ClusterRoleBinding
 *   - ServiceAccounts → RoleBinding in the project
 * `oc describe scc` users/groups lists are NOT used by real 4.x grants (they
 * stay at their seeded defaults), so they are only a last-resort legacy fallback
 * for partially-implemented builds.
 * @returns {{kind: 'binding'|'legacy', subjects: object[]|string[]}}
 */
function sccGrantState(c, sccName) {
  const roleName = `system:openshift:scc:${sccName}`;
  const subjects = [];
  let foundBinding = false;
  for (const kind of ['RoleBinding', 'ClusterRoleBinding']) {
    for (const binding of listKind(c.clusterState, kind)) {
      const spec = resourceSpec(binding);
      const roleRef = spec.roleRef || {};
      const refName = roleRef.name || spec.roleRefName || '';
      if (refName !== roleName) continue;
      foundBinding = true;
      subjects.push(...asArray(spec.subjects || binding.subjects));
    }
  }
  const scc = findResource(c.clusterState, 'SecurityContextConstraints', sccName);
  const legacy = {};
  if (scc) {
    const spec = resourceSpec(scc);
    legacy.users = asArray(spec.users).map(String);
    legacy.groups = asArray(spec.groups).map(String);
  }
  return {
    kind: foundBinding ? 'binding' : 'legacy',
    subjects,
    legacy,
    bindingCount: foundBinding ? 1 : 0,
  };
}

/** Is `subject` granted the SCC under the 4.x binding model (or legacy seed)? */
function sccGrantedTo(c, sccName, subject) {
  const state = sccGrantState(c, sccName);
  const cluster = c.clusterState;
  if (state.kind === 'binding') {
    if (bindingSubjectMatches(state.subjects, subject)) return true;
    // Prefer an engine helper when present (binding-aware, includes legacy seeds).
    if (typeof cluster?.getSCCGrantsForSubject === 'function') {
      try {
        const grants = asArray(cluster.getSCCGrantsForSubject(subject));
        if (grants.map(String).includes(String(sccName))) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }
  // Legacy fallback: seeded SCC users/groups lists (pre-4.x-model builds).
  if (subject.startsWith('system:serviceaccount:') || subject.startsWith('serviceaccount:')) {
    const rest = subject.startsWith('serviceaccount:')
      ? subject.slice('serviceaccount:'.length)
      : subject.slice('system:serviceaccount:'.length);
    const split = rest.lastIndexOf(':');
    const namespace = split > 0 ? rest.slice(0, split) : '';
    const saName = split > 0 ? rest.slice(split + 1) : rest;
    if (namespace && typeof cluster?.getSCCsForServiceAccount === 'function') {
      try {
        const names = asArray(cluster.getSCCsForServiceAccount(namespace, saName)).map((entry) =>
          typeof entry === 'string' ? entry : entry?.name || entry?.metadata?.name || ''
        );
        if (names.includes(String(sccName))) return true;
      } catch {
        /* ignore */
      }
    }
    if (
      saName === 'default' &&
      state.legacy.groups?.includes(`system:serviceaccounts:${namespace}`)
    )
      return true;
  }
  if (subject.startsWith('group:')) return subjectMatches(state.legacy?.groups, subject.slice(6));
  const plain = subject.replace(/^user:/, '');
  return subjectMatches(state.legacy?.users, plain) || subjectMatches(state.legacy?.groups, plain);
}

function evaluateScc(obj, c) {
  const name = obj.scc || obj.name || obj.sccName;
  if (!name) return bool(false);
  const scc = findResource(c.clusterState, 'SecurityContextConstraints', name);
  if (!scc) return bool(false);
  let subject = obj.subject;
  // A `*` project wildcard in the level data means "this lab's project", not
  // "any project in the cluster": `system:serviceaccount:*:default` must match
  // the level's seeded Project (e.g. privileged-lab), not the default project.
  if (subject && String(subject).includes('*')) {
    const namespace = obj.namespace || levelProjectNamespace(c);
    if (namespace) subject = String(subject).split('*').join(namespace);
  }
  const expected = obj.expected !== false;
  const state = sccGrantState(c, name);
  const present = subject
    ? sccGrantedTo(c, name, subject)
    : state.kind === 'binding'
      ? asArray(state.subjects).length > 0
      : asArray(state.legacy?.users).length > 0 || asArray(state.legacy?.groups).length > 0;
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
  return containersOf(workload).some(
    (container) => container?.securityContext?.privileged === true
  );
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
  if (completeNamespace)
    resources = resources.filter((resource) => resourceNamespace(resource) === completeNamespace);
  const complete = resources.filter((resource) => resourceStatus(resource).phase === 'Complete');
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(complete.length >= target, Math.min(complete.length, target), target);
}

function evaluateCronJob(obj, c) {
  let cronJobs = listKind(c.clusterState, 'CronJob');
  if (obj.name) cronJobs = cronJobs.filter((cronJob) => resourceName(cronJob) === obj.name);
  const cronNamespace = objectiveResourceNamespace(c, obj, 'CronJob');
  if (cronNamespace)
    cronJobs = cronJobs.filter((cronJob) => resourceNamespace(cronJob) === cronNamespace);
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
      if (kind === 'ConfigMap' && entry?.configMapRef)
        return !name || entry.configMapRef.name === name;
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
  const sensitivePattern = obj.sensitive === false ? null : SENSITIVE_CONFIGMAP_KEY;
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
  return {
    workloads,
    containers: workloads.flatMap((workload) =>
      containersOf(workload).map((container) => ({ workload, container }))
    ),
  };
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
      roles: listKinds(c.clusterState, ['Role', 'ClusterRole']).map(
        (role) => role?.uid || resourceName(role)
      ),
      bindings: listKinds(c.clusterState, ['RoleBinding', 'ClusterRoleBinding']).map(
        (binding) => binding?.uid || resourceName(binding)
      ),
    }));
    const knownRoles = new Set(baseline.roles);
    const knownBindings = new Set(baseline.bindings);
    createdDuringLevel =
      listKinds(c.clusterState, ['Role', 'ClusterRole']).some(
        (role) => !knownRoles.has(role?.uid || resourceName(role))
      ) ||
      listKinds(c.clusterState, ['RoleBinding', 'ClusterRoleBinding']).some(
        (binding) => !knownBindings.has(binding?.uid || resourceName(binding))
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
    asArray(pod?.metadata?.ownerReferences).some((reference) => reference?.kind === 'DaemonSet')
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
  if (obj.namespace)
    workloads = workloads.filter((workload) => resourceNamespace(workload) === obj.namespace);
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
  const matching = wanted
    ? resolved.filter((incident) => matchesIncident(incident, wanted))
    : resolved;
  let count = matching.length;
  if (!wanted) {
    const stats = c.incidentEngine?.getStats?.();
    count = Math.max(count, asNumber(stats?.totalResolved, 0));
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(count >= target, Math.min(count, target), target);
}

/**
 * "This incident actually happened during the run" gate. Used by the L20
 * capstone so a level with scheduled incidents cannot complete before the
 * incidents fire (no more 46-second capstone).
 */
function evaluateIncident(obj, c) {
  const wanted = obj.incidentType || obj.name || null;
  const min = Math.max(1, asNumber(obj.min ?? obj.count, 1));
  const engine = c.incidentEngine;
  let history = null;
  try {
    if (engine && typeof engine.getIncidentHistory === 'function')
      history = engine.getIncidentHistory();
  } catch {
    history = null;
  }
  let pool;
  if (Array.isArray(history)) {
    pool = history;
  } else {
    // Fallback: incidents that are still active or were resolved.
    pool = [...activeIncidents(c), ...resolvedIncidents(c)];
  }
  const count = wanted
    ? pool.filter((incident) => matchesIncident(incident, wanted)).length
    : pool.length;
  return result(count >= min, Math.min(count, min), min);
}

function evaluateInvestigate(obj, c) {
  const wanted = obj.incidentType || obj.name;
  const threshold = asNumber(obj.progress, 0.5);
  const pool = [...activeIncidents(c), ...resolvedIncidents(c)];
  const matching = wanted ? pool.filter((incident) => matchesIncident(incident, wanted)) : pool;
  // Resolving the incident implies it was investigated: the learner cannot fix
  // a fault they never diagnosed, and the incident panel/state must not be the
  // only path (GAME-004). Otherwise take the reported investigation progress.
  const progressFor = (incident) => {
    const state = String(incident?.state || '').toLowerCase();
    if (state === 'resolved') return 1;
    return asNumber(incident?.investigationProgress, 0);
  };
  const progress = Math.max(0, ...matching.map(progressFor));
  return result(progress >= threshold, progress >= threshold ? 1 : 0, 1);
}

function evaluateUptime(obj, c) {
  const percentage = asNumber(obj.percentage, 90);
  const health = clusterHealthPercent(c);
  // "Restore/keep health ≥ N%" cannot be satisfied before the level's incident
  // has actually happened. The baseline is the activation epoch captured at
  // level start — NOT the activation count at the first evaluation, because
  // `triggerTime: 0` preloads activate between start() and the first tick and
  // would otherwise be baked into the baseline forever (#22). Incidents that
  // fire later still gate completion until they activate and clear again.
  const activity = incidentActivity(c);
  if (activity && activity.gated) {
    if (activity.activations <= activity.levelStart) {
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
  // Same level-start activation epoch gate as evaluateUptime (#22) so campaign
  // and timed-lab paths stay symmetric.
  const activity = incidentActivity(c);
  if (activity && activity.gated) {
    if (activity.activations <= activity.levelStart || activity.active > 0) {
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
            available?.status === 'True' && (degraded === undefined || degraded.status !== 'True')
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
    }) ||
    pods.some((pod) => {
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
    case 'networkpolicy':
      return evaluateNetworkPolicy(obj, c);
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
    case 'identity':
      return evaluateIdentity(obj, c);
    case 'oauthprovider':
      return evaluateOAuthProvider(obj, c);
    case 'password':
      return evaluatePassword(obj, c);
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
    case 'routeaccess':
      return evaluateRouteAccess(obj, c);
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
    case 'installplan':
      return evaluateInstallPlan(obj, c);
    case 'subscription':
      return evaluateSubscription(obj, c);
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
    case 'incident':
      return evaluateIncident(obj, c);
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
      const fallbackTarget =
        typeIsBoolean(type) && !Number.isFinite(Number(objective.count))
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
