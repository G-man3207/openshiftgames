/**
 * ScoringEngine — XP, stars, achievements, EX280 progress and the
 * OpenShift Architecture Advisor (CONVERSION-SPEC §11/§12).
 *
 * Storage:
 *   - canonical key `openshiftgames_progress`
 *   - one-time best-effort migration from the original `k8sgames_progress`
 *   - stat fallbacks: `namespacesCreated` → `projectsCreated`,
 *     `roleBindingsCreated` → `rolebindingsCreated`
 *   - EX280 Prep state lives in `progress.examPrep`:
 *       { [bulletId]: { state: 'practiced'|'mastered', updatedAt } }
 *
 * Event subscriptions are defensive: every engine/UI API is feature-detected
 * so the engine also works in Node harnesses and against partially integrated
 * builds. Both `resource:created` (command bar / sandbox) and the
 * `cluster:added:<Kind>` stream (palette / manifests / controllers) are
 * supported, de-duplicated by UID and by kind/namespace/name.
 */

import { ACHIEVEMENTS } from '../data/Achievements.js';
import { RESOURCE_KINDS } from '../data/kindRegistry.js';

const XP_LEVELS = [
  { level: 1, title: 'Novice', xpRequired: 0 },
  { level: 2, title: 'Novice II', xpRequired: 100 },
  { level: 3, title: 'Novice III', xpRequired: 250 },
  { level: 4, title: 'Apprentice', xpRequired: 450 },
  { level: 5, title: 'Apprentice II', xpRequired: 700 },
  { level: 6, title: 'Apprentice III', xpRequired: 1000 },
  { level: 7, title: 'Operator', xpRequired: 1400 },
  { level: 8, title: 'Operator II', xpRequired: 1900 },
  { level: 9, title: 'Operator III', xpRequired: 2500 },
  { level: 10, title: 'Administrator', xpRequired: 3200 },
  { level: 11, title: 'Administrator II', xpRequired: 4000 },
  { level: 12, title: 'Administrator III', xpRequired: 5000 },
  { level: 13, title: 'Engineer', xpRequired: 6200 },
  { level: 14, title: 'Engineer II', xpRequired: 7600 },
  { level: 15, title: 'Engineer III', xpRequired: 9200 },
  { level: 16, title: 'Architect', xpRequired: 11000 },
  { level: 17, title: 'Architect II', xpRequired: 13000 },
  { level: 18, title: 'Architect III', xpRequired: 15500 },
  { level: 19, title: 'SRE', xpRequired: 18500 },
  { level: 20, title: 'SRE II', xpRequired: 22000 },
  { level: 21, title: 'SRE III', xpRequired: 26000 },
  { level: 22, title: 'Principal', xpRequired: 30500 },
  { level: 23, title: 'Principal II', xpRequired: 35500 },
  { level: 24, title: 'Principal III', xpRequired: 41000 },
  { level: 25, title: 'Staff', xpRequired: 47500 },
  { level: 26, title: 'Staff II', xpRequired: 55000 },
  { level: 27, title: 'Staff III', xpRequired: 63500 },
  { level: 28, title: 'EX280 Candidate', xpRequired: 73000 },
  { level: 29, title: 'EX280 Certified', xpRequired: 84000 },
  { level: 30, title: 'OpenShift Master', xpRequired: 100000 },
];

const STORAGE_KEY = 'openshiftgames_progress';
const LEGACY_STORAGE_KEY = 'k8sgames_progress';

/** Campaign chapters (20 levels × 4) used for the `chaptersCompleted` stat. */
const CAMPAIGN_CHAPTERS = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];

/**
 * Required/known stat keys (CONVERSION-SPEC §12). Missing keys initialise to
 * zero; `fastestIncidentResolve` is deliberately left undefined because 0
 * would mean "instant" to achievement conditions.
 */
const STAT_DEFAULTS = {
  totalPodsDeployed: 0,
  deploymentsCreated: 0,
  servicesCreated: 0,
  projectsCreated: 0,
  routesCreated: 0,
  buildsCompleted: 0,
  buildsStarted: 0,
  buildConfigsCreated: 0,
  imageStreamsCreated: 0,
  templatesProcessed: 0,
  helmReleases: 0,
  manifestsApplied: 0,
  kustomizeOverlaysApplied: 0,
  usersCreated: 0,
  groupsCreated: 0,
  rolebindingsCreated: 0,
  sccGrants: 0,
  operatorsInstalled: 0,
  examPrepMastered: 0,
  networkPoliciesCreated: 0,
  pvcsCreated: 0,
  pvsCreated: 0,
  storageClassesCreated: 0,
  hpasCreated: 0,
  statefulSetsCreated: 0,
  daemonSetsCreated: 0,
  jobsCreated: 0,
  cronJobsCreated: 0,
  ingressesCreated: 0,
  configMapsCreated: 0,
  secretsCreated: 0,
  rolesCreated: 0,
  serviceAccountsCreated: 0,
  pdbsCreated: 0,
  incidentsResolved: 0,
  commandsExecuted: 0,
  yamlViewed: 0,
  maxConcurrentPods: 0,
  maxNodes: 0,
  uniqueResourceTypesDeployed: 0,
  sandboxResourcesDeployed: 0,
  levelsCompleted: 0,
  chaptersCompleted: 0,
  threeStarLevels: 0,
  totalStars: 0,
  challengesCompleted: 0,
  threeStarChallenges: 0,
  longestChaosSurvival: 0,
  resourceQuotasCreated: 0,
  limitRangesCreated: 0,
  clusterResourceQuotasCreated: 0,
  ipAddressPoolsCreated: 0,
  l2AdvertisementsCreated: 0,
  canIAllowed: 0,
  logins: 0,
  logouts: 0,
  bestArchitectureScore: 0,
  highestArchitectureScore: 0,
  lastArchitectureScore: 0,
};

/** Resource kind → creation counter. */
const KIND_STAT_MAP = {
  Pod: 'totalPodsDeployed',
  Deployment: 'deploymentsCreated',
  Service: 'servicesCreated',
  Project: 'projectsCreated',
  Namespace: 'projectsCreated',
  NetworkPolicy: 'networkPoliciesCreated',
  PersistentVolumeClaim: 'pvcsCreated',
  PersistentVolume: 'pvsCreated',
  StorageClass: 'storageClassesCreated',
  HorizontalPodAutoscaler: 'hpasCreated',
  StatefulSet: 'statefulSetsCreated',
  DaemonSet: 'daemonSetsCreated',
  Job: 'jobsCreated',
  CronJob: 'cronJobsCreated',
  Ingress: 'ingressesCreated',
  ConfigMap: 'configMapsCreated',
  Secret: 'secretsCreated',
  Role: 'rolesCreated',
  RoleBinding: 'rolebindingsCreated',
  ClusterRoleBinding: 'rolebindingsCreated',
  ServiceAccount: 'serviceAccountsCreated',
  PodDisruptionBudget: 'pdbsCreated',
  Route: 'routesCreated',
  BuildConfig: 'buildConfigsCreated',
  Build: 'buildsStarted',
  ImageStream: 'imageStreamsCreated',
  User: 'usersCreated',
  Group: 'groupsCreated',
  ResourceQuota: 'resourceQuotasCreated',
  LimitRange: 'limitRangesCreated',
  ClusterResourceQuota: 'clusterResourceQuotasCreated',
  IPAddressPool: 'ipAddressPoolsCreated',
  L2Advertisement: 'l2AdvertisementsCreated',
};

/** Kinds whose `cluster:added:<Kind>` events we listen for. */
const TRACKED_KINDS = Array.from(new Set([
  ...RESOURCE_KINDS,
  'Namespace', // legacy alias: ClusterState canonicalises it to Project
]));

const SENSITIVE_CONFIGMAP_KEY = /password|passwd|secret|token|key|credential/i;

// ─── small helpers ─────────────────────────────────────────────────────────

/** Resource-name aliases used when normalising learner command evidence. */
const KIND_ALIASES = {
  pod: 'pod', pods: 'pod',
  deploy: 'deployment', deployment: 'deployment', deployments: 'deployment',
  rs: 'replicaset', replicaset: 'replicaset', replicasets: 'replicaset',
  sts: 'statefulset', statefulset: 'statefulset', statefulsets: 'statefulset',
  ds: 'daemonset', daemonset: 'daemonset', daemonsets: 'daemonset',
  svc: 'service', service: 'service', services: 'service',
  is: 'imagestream', imagestream: 'imagestream', imagestreams: 'imagestream',
  istag: 'istag', imagestreamtag: 'istag', imagestreamtags: 'istag',
  bc: 'buildconfig', buildconfig: 'buildconfig', buildconfigs: 'buildconfig',
  build: 'build', builds: 'build',
  route: 'route', routes: 'route',
  cm: 'configmap', configmap: 'configmap', configmaps: 'configmap',
  secret: 'secret', secrets: 'secret',
  sa: 'serviceaccount', serviceaccount: 'serviceaccount', serviceaccounts: 'serviceaccount',
  user: 'user', users: 'user',
  group: 'group', groups: 'group',
  role: 'role', roles: 'role',
  rolebinding: 'rolebinding', rolebindings: 'rolebinding',
  clusterrole: 'clusterrole', clusterroles: 'clusterrole',
  clusterrolebinding: 'clusterrolebinding', clusterrolebindings: 'clusterrolebinding',
  netpol: 'networkpolicy', networkpolicy: 'networkpolicy', networkpolicies: 'networkpolicy',
  quota: 'resourcequota', resourcequota: 'resourcequota', resourcequotas: 'resourcequota',
  limitrange: 'limitrange', limitranges: 'limitrange',
  clusterquota: 'clusterresourcequota', clusterresourcequota: 'clusterresourcequota',
  scc: 'scc', securitycontextconstraint: 'scc', securitycontextconstraints: 'scc',
  job: 'job', jobs: 'job',
  cronjob: 'cronjob', cronjobs: 'cronjob',
  node: 'node', nodes: 'node',
  project: 'project', projects: 'project',
  namespace: 'project', namespaces: 'project',
  template: 'template', templates: 'template',
  oauth: 'oauth', clusteroperator: 'clusteroperator', clusteroperators: 'clusteroperator',
  subscription: 'subscription', sub: 'subscription', subscriptions: 'subscription',
  csv: 'csv', clusterserviceversion: 'csv', clusterserviceversions: 'csv',
  installplan: 'installplan', installplans: 'installplan',
  packagemanifest: 'packagemanifest', packagemanifests: 'packagemanifest',
  pvc: 'pvc', persistentvolumeclaim: 'pvc', persistentvolumeclaims: 'pvc',
  pv: 'pv', persistentvolume: 'pv', persistentvolumes: 'pv',
  hpa: 'hpa', horizontalpodautoscaler: 'hpa',
  pdb: 'pdb', poddisruptionbudget: 'pdb',
  ingress: 'ingress', ingresses: 'ingress',
  operatorgroup: 'operatorgroup', operatorgroups: 'operatorgroup',
  configmapkey: 'configmap',
};

/** Second-token verbs that are followed by a subcommand (oc set image ...). */
const SUBCOMMAND_VERBS = new Set(['set', 'rollout', 'expose', 'adm', 'auth', 'policy', 'image']);

/** First-level oc verbs that take a resource kind as the next argument. */
const RESOURCE_VERBS = new Set([
  'get', 'describe', 'delete', 'create', 'apply', 'replace', 'edit', 'patch',
  'label', 'annotate', 'run', 'logs', 'exec', 'rsh', 'cp', 'debug', 'wait',
  'scale', 'expose', 'tag', 'import-image', 'image', 'observe', 'idle', 'rsync',
]);

function normalizeKindWord(word) {
  const key = String(word || '').toLowerCase().replace(/[^a-z-]/g, '');
  return KIND_ALIASES[key] || '';
}

/**
 * Normalise a learner command into a short, resource-kind-normalised evidence
 * signature, e.g.:
 *   `oc get pods -o wide`                    → 'oc get pod'
 *   `oc label deployment/web tier=frontend`  → 'oc label deployment'
 *   `oc adm policy add-role-to-group edit g` → 'oc adm policy add-role-to-group'
 *   `helm install shop helm/webapp`          → 'helm install'
 * Used by the EX280 readiness verdict as per-bullet evidence (a completed level
 * alone must not claim mastery).
 */
export function commandSignature(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const tokens = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (tokens.length === 0) return '';
  const first = tokens[0].toLowerCase();
  const words = [first];
  const pushToken = (token) => {
    const cleaned = String(token || '').replace(/^['"]|['"]$/g, '');
    const kindPart = cleaned.includes('/') ? cleaned.split('/')[0] : cleaned;
    const kind = normalizeKindWord(kindPart);
    if (kind) return kind;
    if (/^[a-z][a-z-]*$/.test(cleaned)) return cleaned.toLowerCase();
    return '';
  };
  for (let i = 1; i < tokens.length && words.length < 4; i += 1) {
    const token = tokens[i].replace(/^['"]|['"]$/g, '');
    if (!token || token.startsWith('-')) continue;
    if (words.length === 1) {
      if (first !== 'oc') {
        // Non-oc tool: helm keeps its verb (`helm install`), other tools are the
        // signature themselves (`htpasswd`, `skopeo`, `vim` …).
        if (first !== 'helm') return first;
        const word = pushToken(token);
        if (word) words.push(word);
        return words.join(' ');
      }
      const word = pushToken(token);
      if (!word) return words.join(' ');
      words.push(word);
      if (!SUBCOMMAND_VERBS.has(word) && !RESOURCE_VERBS.has(word) && word !== 'get') return words.join(' ');
      continue;
    }
    if (words[1] === 'adm' || words[1] === 'auth') {
      const word = pushToken(token);
      if (!word) return words.join(' ');
      words.push(word);
      if (words[2] === 'policy' || words[2] === 'groups') continue; // include the action
      return words.join(' ');
    }
    if (SUBCOMMAND_VERBS.has(words[1])) {
      const word = pushToken(token);
      if (!word) return words.join(' ');
      // `oc set image`, `oc rollout status`, `oc expose service` … then stop or add kind.
      if (words.length >= 3) {
        if (RESOURCE_VERBS.has(words[1]) || ['set', 'rollout'].includes(words[1])) return words.join(' ');
      }
      words.push(word);
      if (words[1] === 'adm' || words[1] === 'auth') return words.join(' ');
      continue;
    }
    if (RESOURCE_VERBS.has(words[1])) {
      const kind = normalizeKindWord(token.includes('/') ? token.split('/')[0] : token);
      if (kind) words.push(kind);
      return words.join(' ');
    }
    return words.join(' ');
  }
  return words.join(' ');
}

export { KIND_ALIASES, normalizeKindWord };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resourceSpec(resource) {
  return resource && typeof resource.spec === 'object' && resource.spec ? resource.spec : {};
}

function resourceStatus(resource) {
  return resource && typeof resource.status === 'object' && resource.status ? resource.status : {};
}

function resourceLabels(resource) {
  const labels = resource?.metadata?.labels || resource?.labels;
  return labels && typeof labels === 'object' ? labels : {};
}

function resourceName(resource) {
  return resource?.metadata?.name || resource?.name || '';
}

function resourceNamespace(resource) {
  return resource?.metadata?.namespace || resource?.namespace || '';
}

function ratio(part, whole) {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(1, part / whole));
}

function integer(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

class ScoringEngine {
  constructor(gameEngine) {
    this.gameEngine = gameEngine;
    this.progress = this.loadProgress();
    this.sessionStats = this.createEmptySessionStats();
    this.unlockedAchievements = new Set(this.progress.achievements || []);

    /** De-dupe keys for creation/build/operator events. */
    this._countedResources = new Set();
    this._countedBuilds = new Set();
    this._countedOperators = new Set();
    this._countedSccGrants = new Set();
    this._countedFiles = new Set();
    this._unsubscribers = [];

    /** Mode seeding must not count as player-created resources. */
    this._statsSuspended = false;
    this._seedResumeTimer = null;

    this.bindEvents();

    if (this._needsMigrationSave) {
      this.progress.achievements = Array.from(this.unlockedAchievements);
      this.saveProgress();
      this._removeLegacyProgress();
    }
  }

  // ─── defaults / shape / migration ───────────────────────────────────────

  createEmptySessionStats() {
    return {
      totalPodsDeployed: 0,
      deploymentsCreated: 0,
      servicesCreated: 0,
      projectsCreated: 0,
      routesCreated: 0,
      buildsCompleted: 0,
      buildsStarted: 0,
      buildConfigsCreated: 0,
      imageStreamsCreated: 0,
      templatesProcessed: 0,
      helmReleases: 0,
      manifestsApplied: 0,
      kustomizeOverlaysApplied: 0,
      usersCreated: 0,
      groupsCreated: 0,
      rolebindingsCreated: 0,
      sccGrants: 0,
      operatorsInstalled: 0,
      examPrepMastered: 0,
      networkPoliciesCreated: 0,
      pvcsCreated: 0,
      pvsCreated: 0,
      storageClassesCreated: 0,
      hpasCreated: 0,
      statefulSetsCreated: 0,
      daemonSetsCreated: 0,
      jobsCreated: 0,
      cronJobsCreated: 0,
      ingressesCreated: 0,
      configMapsCreated: 0,
      secretsCreated: 0,
      rolesCreated: 0,
      roleBindingsCreated: 0,
      serviceAccountsCreated: 0,
      pdbsCreated: 0,
      incidentsResolved: 0,
      commandsExecuted: 0,
      yamlViewed: 0,
      maxConcurrentPods: 0,
      maxNodes: 0,
      uniqueResourceTypesDeployed: 0,
      sandboxResourcesDeployed: 0,
      resourceQuotasCreated: 0,
      limitRangesCreated: 0,
      clusterResourceQuotasCreated: 0,
      ipAddressPoolsCreated: 0,
      l2AdvertisementsCreated: 0,
      canIAllowed: 0,
      fastestIncidentResolve: Infinity,
      resourceTypesUsed: new Set(),
    };
  }

  /** Normalise legacy/partial stored data into the current progress shape. */
  _normalizeProgress(data = {}) {
    const source = data && typeof data === 'object' ? data : {};
    const stats = { ...(source.stats && typeof source.stats === 'object' ? source.stats : {}) };

    // Migration fallbacks required by CONVERSION-SPEC §12.
    if (stats.projectsCreated === undefined && stats.namespacesCreated !== undefined) {
      stats.projectsCreated = asNumber(stats.namespacesCreated, 0);
    }
    if (stats.rolebindingsCreated === undefined && stats.roleBindingsCreated !== undefined) {
      stats.rolebindingsCreated = asNumber(stats.roleBindingsCreated, 0);
    }
    if (stats.roleBindingsCreated === undefined && stats.rolebindingsCreated !== undefined) {
      stats.roleBindingsCreated = asNumber(stats.rolebindingsCreated, 0);
    }
    if (stats.bestArchitectureScore === undefined && stats.highestArchitectureScore !== undefined) {
      stats.bestArchitectureScore = asNumber(stats.highestArchitectureScore, 0);
    }
    if (stats.highestArchitectureScore === undefined && stats.bestArchitectureScore !== undefined) {
      stats.highestArchitectureScore = asNumber(stats.bestArchitectureScore, 0);
    }
    if (stats.architectureScore === undefined && stats.bestArchitectureScore !== undefined) {
      stats.architectureScore = asNumber(stats.bestArchitectureScore, 0);
    }

    const campaignProgress = { ...(source.campaignProgress || {}) };
    const challengeProgress = { ...(source.challengeProgress || {}) };
    const examPrep = this._normalizeExamPrepStore(source.examPrep);
    // Per-bullet readiness evidence is scoped to the linked drill RUN (#20):
    // only commands executed while that campaign level / challenge was active
    // count, so sandbox exploration cannot inflate the EX280 verdict.
    // Shape: { 'campaign:12': ['oc get sub,csv -n metallb-system', ...], ... }
    const drillCommandEvidence = {};
    if (source.drillCommandEvidence && typeof source.drillCommandEvidence === 'object') {
      for (const [key, entries] of Object.entries(source.drillCommandEvidence)) {
        if (!/^(campaign|challenge):\d+$/.test(key)) continue;
        if (!Array.isArray(entries)) continue;
        drillCommandEvidence[key] = entries
          .filter((entry) => typeof entry === 'string' && entry)
          .slice(-200);
      }
    }
    // Levels/challenges completed through live objective evaluation (not a
    // console shortcut): their examObjectives bullets may count as evidence.
    const objectiveEvidence = source.objectiveEvidence && typeof source.objectiveEvidence === 'object'
      ? { ...source.objectiveEvidence }
      : {};

    const progress = {
      xp: asNumber(source.xp, 0),
      level: asNumber(source.level, 1),
      stats: { ...STAT_DEFAULTS, ...stats },
      achievements: Array.isArray(source.achievements) ? source.achievements : [],
      campaignProgress,
      challengeProgress,
      examPrep,
      drillCommandEvidence,
      objectiveEvidence,
    };

    // Derived counters from saved progress objects.
    progress.stats.levelsCompleted = Object.values(campaignProgress).filter((entry) => entry?.completed).length;
    progress.stats.threeStarLevels = Object.values(campaignProgress).filter((entry) => entry?.stars === 3).length;
    progress.stats.totalStars = Object.values(campaignProgress).reduce(
      (sum, entry) => sum + asNumber(entry?.stars, 0),
      0
    );
    progress.stats.chaptersCompleted = CAMPAIGN_CHAPTERS.filter((chapter) =>
      chapter.every((levelId) => campaignProgress[levelId]?.completed)
    ).length;
    progress.stats.challengesCompleted = Object.values(challengeProgress).filter((entry) => entry?.completed).length;
    progress.stats.threeStarChallenges = Object.values(challengeProgress).filter((entry) => entry?.stars === 3).length;
    progress.stats.examPrepMastered = this._countMastered(examPrep);

    return progress;
  }

  /** Accept both the current object form and lightweight legacy forms. */
  _normalizeExamPrepStore(raw) {
    if (!raw) return {};
    const out = {};
    const add = (id, value) => {
      if (!id) return;
      const state = value === 'mastered' || value?.state === 'mastered'
        ? 'mastered'
        : value === 'practiced' || value?.state === 'practiced'
          ? 'practiced'
          : null;
      if (!state) return;
      const updatedAt = asNumber(value?.updatedAt, 0) || Date.now();
      const previous = out[id];
      if (previous?.state === 'mastered') return;
      out[id] = { state, updatedAt };
    };
    if (Array.isArray(raw)) {
      for (const id of raw) add(id, 'mastered');
      return out;
    }
    if (typeof raw !== 'object') return out;
    if (Array.isArray(raw.mastered)) for (const id of raw.mastered) add(id, 'mastered');
    if (Array.isArray(raw.practiced)) for (const id of raw.practiced) add(id, 'practiced');
    const reserved = new Set(['objectives', 'bullets', 'states', 'mastered', 'practiced', 'updatedAt']);
    for (const [id, value] of Object.entries(raw)) {
      if (reserved.has(id)) continue;
      add(id, value);
    }
    return out;
  }

  _countMastered(examPrep = this.progress?.examPrep || {}) {
    return Object.values(examPrep || {}).filter((entry) => entry?.state === 'mastered').length;
  }

  _removeLegacyProgress() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* best effort */
    }
  }

  // ─── event wiring ───────────────────────────────────────────────────────

  _on(event, handler) {
    if (!this.gameEngine || typeof this.gameEngine.on !== 'function') return;
    try {
      const off = this.gameEngine.on(event, handler);
      if (typeof off === 'function') this._unsubscribers.push(off);
    } catch (error) {
      console.warn(`ScoringEngine: could not subscribe to ${event}`, error?.message || error);
    }
  }

  bindEvents() {
    if (!this.gameEngine) return;

    // ── Legacy events kept for backwards compatibility ─────────────────────
    this._on('resource:created', (data) => this.trackResourceCreated(data));
    this._on('incident:resolved', (data) => this.trackIncidentResolved(data));
    this._on('command:executed', (data = {}) => {
      this._bumpStat('commandsExecuted');
      this._recordCommandEvidence(data);
      // Count explicit authorization checks once per command. (Objective
      // evaluation calls engine.canI() every tick, so auth:checked must not
      // be used for this counter or it would inflate by 1/second.)
      if (/\bauth\s+can-i\b/i.test(String(data.raw || data.command || ''))) {
        this._bumpStat('canIAllowed');
      }
      this._afterStatChange();
    });
    this._on('yaml:viewed', () => {
      this._bumpStat('yamlViewed');
      this._afterStatChange();
    });
    this._on('incident:cascading-resolved', () => {
      this.progress.stats.cascadingFailuresResolved =
        (this.progress.stats.cascadingFailuresResolved || 0) + 1;
      this._afterStatChange();
    });
    this._on('secret:exposed-fixed', () => {
      this.progress.stats.foundExposedSecret = true;
      this._afterStatChange();
    });
    this._on('rollout:zero-downtime', () => {
      this.progress.stats.zeroDowntimeUpdates = (this.progress.stats.zeroDowntimeUpdates || 0) + 1;
      this._afterStatChange();
    });
    this._on('easter-egg:triggered', (data) => {
      if (!this.progress.stats.easterEggs) this.progress.stats.easterEggs = {};
      if (data?.id && !this.progress.stats.easterEggs[data.id]) {
        this.progress.stats.easterEggs[data.id] = true;
        this._afterStatChange();
      }
    });

    // ── Mode lifecycle: do not count seeded starting resources ─────────────
    this._on('cluster:reset', () => {
      // A fresh simulated cluster: names may be reused in the next lab/level,
      // so the per-session de-dupe keys must not leak across resets.
      this._countedResources.clear();
      this._countedBuilds.clear();
      this._countedOperators.clear();
      this._countedSccGrants.clear();
      this._suspendStats();
    });
    for (const event of ['campaign:level-started', 'challenge:started', 'sandbox:started', 'chaos:started']) {
      this._on(event, () => this._resumeStats());
    }

    // ── Resource creation stream (palette / commands / manifests / engines) ─
    for (const kind of TRACKED_KINDS) {
      this._on(`cluster:added:${kind}`, (data) => this._onClusterAdded(kind, data));
    }

    // ── OpenShift controller outcomes ───────────────────────────────────────
    this._on('build:complete', (data) => this._onBuildComplete(data));
    this._on('cluster:modified:Build', (data) => {
      if (data?.resource?.status?.phase === 'Complete') this._onBuildComplete(data);
    });
    this._on('operator:installed', (data) => this._onOperatorInstalled(data));
    this._on('cluster:modified:Subscription', (data) => {
      if (data?.resource?.status?.phase === 'Succeeded') this._onOperatorInstalled(data);
    });
    this._on('scc:granted', (data) => this._onSccGranted(data));
    this._on('manifest:applied', () => {
      if (this._statsSuspended) return;
      this._bumpStat('manifestsApplied');
      this._afterStatChange();
    });
    this._on('kustomize:applied', () => {
      if (this._statsSuspended) return;
      this._bumpStat('kustomizeOverlaysApplied');
      this._afterStatChange();
    });
    this._on('helm:installed', (data) => {
      if (this._statsSuspended) return;
      this._bumpStat('helmReleases');
      this.progress.stats.lastHelmRelease = data?.release || data?.name || null;
      this._afterStatChange();
    });
    this._on('template:processed', (data) => {
      if (this._statsSuspended) return;
      this._bumpStat('templatesProcessed');
      this.progress.stats.lastTemplateProcessed = data?.name || data?.path || data?.templateName || null;
      this._afterStatChange();
    });

    // ── Session / identity ──────────────────────────────────────────────────
    this._on('login', (data) => {
      if (this._statsSuspended) return;
      this._bumpStat('logins');
      this.progress.stats.lastLoginUser = data?.user || this.gameEngine?.currentUser || null;
      this._afterStatChange();
    });
    this._on('logout', () => {
      if (this._statsSuspended) return;
      this._bumpStat('logouts');
      this._afterStatChange();
    });
    this._on('project:created', (data) => {
      if (this._statsSuspended) return;
      this._countProject(data?.name || data?.resource?.metadata?.name, data?.resource);
    });
    this._on('resource:applied', (data) => {
      if (this._statsSuspended) return;
      this.progress.stats.lastResourceApplied = {
        kind: data?.kind || null,
        name: data?.name || null,
        namespace: data?.namespace || null,
        action: data?.action || null,
        at: Date.now(),
      };
    });
    this._on('cluster:modified', (data) => {
      // Observation only; kind-specific modified handlers below own counters.
      this.progress.stats.lastClusterModified = {
        kind: data?.kind || null,
        name: data?.name || null,
        namespace: data?.namespace || null,
        at: Date.now(),
      };
    });
    this._on('auth:checked', (data) => {
      // Observational only: objective evaluation produces one of these every
      // second, so never increment counters or save progress from this event.
      this.progress.stats.lastAuthCheck = {
        user: data?.user || null,
        verb: data?.verb || null,
        resource: data?.resource || null,
        allowed: data?.allowed === true,
        at: Date.now(),
      };
    });

    // ── Night owl (kept from the original game) ────────────────────────────
    const checkNightOwl = () => {
      const hour = new Date().getHours();
      if (hour >= 0 && hour < 4) {
        this.progress.stats.playedLateNight = true;
        this._afterStatChange();
        if (this._nightOwlInterval) {
          clearInterval(this._nightOwlInterval);
          this._nightOwlInterval = null;
        }
      }
    };
    checkNightOwl();
    if (!this._nightOwlInterval && !this.progress.stats.playedLateNight) {
      this._nightOwlInterval = setInterval(checkNightOwl, 60000);
      this._nightOwlInterval.unref?.();
    }
  }

  _suspendStats() {
    this._statsSuspended = true;
    if (this._seedResumeTimer) clearTimeout(this._seedResumeTimer);
    this._seedResumeTimer = setTimeout(() => this._resumeStats(), 5000);
    this._seedResumeTimer.unref?.();
  }

  _resumeStats() {
    this._statsSuspended = false;
    if (this._seedResumeTimer) {
      clearTimeout(this._seedResumeTimer);
      this._seedResumeTimer = null;
    }
    this._refreshClusterSizeStats();
  }

  /** Capture node/Pod highs from the freshly seeded mode cluster. */
  _refreshClusterSizeStats() {
    const pods = this._getKindList('Pod').length;
    if (pods > 0) {
      this.progress.stats.maxConcurrentPods = Math.max(
        asNumber(this.progress.stats.maxConcurrentPods, 0),
        pods
      );
    }
    const nodes = this._getKindList('Node').length;
    if (nodes > 0) {
      this.progress.stats.maxNodes = Math.max(asNumber(this.progress.stats.maxNodes, 0), nodes);
    }
  }

  // ─── counting primitives ────────────────────────────────────────────────

  /** Mark key(s) and report whether this resource was already counted. */
  _countResourceOnce(kind, name, namespace, uid) {
    const keys = [];
    if (uid) keys.push(`uid:${uid}`);
    if (name) keys.push(`name:${kind}:${namespace || ''}:${name}`);
    if (keys.length === 0) return false;
    let seen = false;
    for (const key of keys) if (this._countedResources.has(key)) seen = true;
    for (const key of keys) this._countedResources.add(key);
    if (this._countedResources.size > 8000) {
      this._countedResources = new Set([...this._countedResources].slice(-4000));
    }
    return seen;
  }

  _countUnique(set, key) {
    if (!key) return false;
    if (set.has(key)) return true;
    set.add(key);
    if (set.size > 4000) {
      const trimmed = [...set].slice(-2000);
      set.clear();
      for (const entry of trimmed) set.add(entry);
    }
    return false;
  }

  _bumpStat(key, amount = 1) {
    if (!key) return;
    if (this.sessionStats && typeof this.sessionStats[key] === 'number') {
      this.sessionStats[key] += amount;
    }
    this.progress.stats[key] = asNumber(this.progress.stats[key], 0) + amount;
    // Keep the legacy camel-case alias for pre-conversion achievements/UI.
    if (key === 'rolebindingsCreated') {
      this.progress.stats.roleBindingsCreated = this.progress.stats.rolebindingsCreated;
    }
    if (key === 'projectsCreated' && this.progress.stats.namespacesCreated === undefined) {
      this.progress.stats.namespacesCreated = this.progress.stats.projectsCreated;
    }
  }

  /**
   * Begin recording drill-scoped readiness evidence for a campaign level or
   * challenge. Commands run in sandbox/chaos have no active drill and therefore
   * never count towards the EX280 readiness verdict (#20).
   */
  beginDrillEvidence(scope, id) {
    if (!scope || id === undefined || id === null) return;
    const key = `${scope}:${id}`;
    if (!this.progress.drillCommandEvidence) this.progress.drillCommandEvidence = {};
    if (!Array.isArray(this.progress.drillCommandEvidence[key])) this.progress.drillCommandEvidence[key] = [];
    this._activeDrillKey = key;
  }

  /** Stop recording drill evidence (entering sandbox/chaos/menu). */
  endDrillEvidence() {
    this._activeDrillKey = null;
  }

  /**
   * Record a successful learner command as EX280 readiness evidence, scoped to
   * the currently active drill run. Stores the normalised command (deduped,
   * capped) so `ExamPrepMode` can match it against the bullet's own commands.
   */
  _recordCommandEvidence(data = {}) {
    if (!this._activeDrillKey) return;
    const raw = String(data.raw || data.command || '').trim().replace(/\s+/g, ' ');
    if (!raw || raw.length > 220) return;
    if (!this.progress.drillCommandEvidence) this.progress.drillCommandEvidence = {};
    const list = this.progress.drillCommandEvidence[this._activeDrillKey] || [];
    const entry = raw.toLowerCase();
    if (list.includes(entry)) return;
    list.push(entry);
    this.progress.drillCommandEvidence[this._activeDrillKey] = list.slice(-200);
  }

  /**
   * Record that a campaign level / challenge was completed through live
   * objective evaluation (called from the modes on real completion). A console
   * shortcut that writes progress directly never reaches this method, so the
   * readiness verdict cannot be inflated by it.
   */
  recordObjectiveEvidence(scope, id, objectiveTypes = []) {
    if (!scope || id === undefined || id === null) return;
    if (!this.progress.objectiveEvidence) this.progress.objectiveEvidence = {};
    const key = `${scope}:${id}`;
    const seen = new Set(this.progress.objectiveEvidence[key] || []);
    for (const type of objectiveTypes) {
      if (typeof type === 'string' && type) seen.add(type.toLowerCase());
    }
    this.progress.objectiveEvidence[key] = [...seen].slice(-40);
  }

  /** Drill-scoped evidence map: { 'campaign:12': [...], 'challenge:2': [...] }. */
  getDrillCommandEvidence() {
    const source = this.progress.drillCommandEvidence;
    const out = {};
    if (source && typeof source === 'object') {
      for (const [key, entries] of Object.entries(source)) {
        if (Array.isArray(entries)) out[key] = entries.slice();
      }
    }
    return out;
  }

  /** Single drill bucket (empty array when none recorded). */
  getDrillEvidenceFor(scope, id) {
    const key = `${scope}:${id}`;
    return this.getDrillCommandEvidence()[key] || [];
  }

  /** @deprecated flattened drill evidence (kept for older callers). */
  getCommandEvidence() {
    return Object.values(this.getDrillCommandEvidence()).flat();
  }

  getObjectiveEvidence() {
    return this.progress.objectiveEvidence && typeof this.progress.objectiveEvidence === 'object'
      ? { ...this.progress.objectiveEvidence }
      : {};
  }

  _afterStatChange() {
    try {
      this.checkAchievements();
    } catch (error) {
      console.warn('ScoringEngine: achievement check failed', error?.message || error);
    }
    this.saveProgress();
  }

  _onClusterAdded(kind, data) {
    if (!data || (data.kind && data.kind !== kind)) return;
    if (this._statsSuspended) return;
    const resource = data.resource || null;
    const name = data.name || resourceName(resource);
    const namespace = data.namespace ?? resourceNamespace(resource);
    const uid = data.uid || resource?.metadata?.uid || null;

    // ClusterState.clear() re-seeds the default OpenShift baseline. Seeded
    // resources use deterministic `seed-*` UIDs and are not player creations.
    if (uid && String(uid).startsWith('seed-')) {
      this._countResourceOnce(kind, name, namespace, uid);
      return;
    }

    if (kind === 'Pod') {
      // Controller-created pods carry pod-template-hash. Only count pods the
      // player created directly (palette, oc run, oc create -f Pod, ...).
      if (resourceLabels(resource)['pod-template-hash']) {
        // Remember the key so a follow-up `resource:created` for the same Pod
        // (from a test/stub emitter) cannot count it either.
        this._countResourceOnce(kind, name, namespace, uid);
        this._refreshClusterSizeStats();
        return;
      }
    }

    if (this._countResourceOnce(kind, name, namespace, uid)) return;

    const statKey = KIND_STAT_MAP[kind];
    if (statKey) this._bumpStat(statKey);

    this._trackUniqueKind(kind);
    this._trackConcurrency(kind, resource);

    if (kind === 'Project') this._countProject(name, resource);

    this._afterStatChange();
  }

  _countProject(name, resource) {
    if (!name) return;
    if (this._countResourceOnce('Project', name, '', resource?.metadata?.uid || null)) return;
    this._bumpStat('projectsCreated');
    this._afterStatChange();
  }

  _trackUniqueKind(kind) {
    if (!kind) return;
    const used = this.sessionStats.resourceTypesUsed;
    if (used && typeof used.add === 'function') used.add(kind);
    this.progress.stats.uniqueResourceTypesDeployed = Math.max(
      asNumber(this.progress.stats.uniqueResourceTypesDeployed, 0),
      used && typeof used.size === 'number' ? used.size : 0
    );
  }

  _trackConcurrency(kind, resource) {
    if (!kind) return;
    if (kind === 'Pod') {
      const count = this._getKindList('Pod').length;
      this.progress.stats.maxConcurrentPods = Math.max(
        asNumber(this.progress.stats.maxConcurrentPods, 0),
        count
      );
    }
    if (kind === 'Node') {
      const count = this._getKindList('Node').length;
      this.progress.stats.maxNodes = Math.max(asNumber(this.progress.stats.maxNodes, 0), count);
    }
  }

  _getKindList(kind) {
    const cluster = this.gameEngine?.cluster;
    if (!cluster) return [];
    try {
      if (typeof cluster.getResourcesByKind === 'function') return cluster.getResourcesByKind(kind) || [];
      if (typeof cluster.getByKind === 'function') return cluster.getByKind(kind) || [];
    } catch {
      /* ignore */
    }
    return [];
  }

  // ─── legacy public trackers ──────────────────────────────────────────────

  trackResourceCreated(data = {}) {
    if (this._statsSuspended) return;
    const kind = data.kind;
    if (!kind) return;

    // `resource:created` is emitted by CommandBar/SandboxMode after the cluster
    // add; the cluster:added stream usually counted it first. De-dupe by name.
    if (kind === 'Pod' && data.concurrentPods) {
      this.progress.stats.maxConcurrentPods = Math.max(
        asNumber(this.progress.stats.maxConcurrentPods, 0),
        asNumber(data.concurrentPods, 0)
      );
    }
    if (kind === 'Node' && data.nodeCount) {
      this.progress.stats.maxNodes = Math.max(asNumber(this.progress.stats.maxNodes, 0), asNumber(data.nodeCount, 0));
    }

    if (!this._countResourceOnce(kind, data.name, data.namespace, data.uid)) {
      const statKey = KIND_STAT_MAP[kind];
      if (statKey) this._bumpStat(statKey);
      this._trackUniqueKind(kind);
      if (kind === 'Pod' && !data.concurrentPods) this._trackConcurrency(kind);
      if (kind === 'Node' && !data.nodeCount) this._trackConcurrency(kind);
    }

    if (data.mode === 'sandbox') {
      this._bumpStat('sandboxResourcesDeployed');
    }

    this._afterStatChange();
  }

  trackIncidentResolved(data = {}) {
    this._bumpStat('incidentsResolved');

    if (data.resolutionTime && data.resolutionTime < this.sessionStats.fastestIncidentResolve) {
      this.sessionStats.fastestIncidentResolve = data.resolutionTime;
    }
    if (data.resolutionTime) {
      this.progress.stats.fastestIncidentResolve = Math.min(
        asNumber(this.progress.stats.fastestIncidentResolve, Infinity),
        data.resolutionTime
      );
    }

    if (data.combo) {
      this.progress.stats.highestCombo = Math.max(asNumber(this.progress.stats.highestCombo, 0), data.combo);
    }

    if (data.xpEarned) {
      this.addXP(data.xpEarned);
    }

    this._afterStatChange();
  }

  _onBuildComplete(data = {}) {
    if (this._statsSuspended) return;
    const resource = data.resource || null;
    const uid = resource?.metadata?.uid || data.uid || null;
    const name = data.build || data.name || resourceName(resource);
    const namespace = data.namespace || resourceNamespace(resource);
    const keys = [];
    if (uid) keys.push(`uid:${uid}`);
    if (name) keys.push(`build-name:${name}`);
    if (name && namespace) keys.push(`build:${name}:${namespace}`);
    const seen = keys.some((key) => this._countedBuilds.has(key));
    for (const key of keys) this._countedBuilds.add(key);
    if (seen) return;
    this._bumpStat('buildsCompleted');
    this.progress.stats.lastBuildCompleted = name || null;
    this._afterStatChange();
  }

  _onOperatorInstalled(data = {}) {
    if (this._statsSuspended) return;
    const resource = data.resource || null;
    const uid = resource?.metadata?.uid || data.uid || null;
    const name = data.name || data.subscription || data.packageName || resourceName(resource);
    const namespace = data.namespace || resourceNamespace(resource);
    const keys = [];
    if (uid) keys.push(`uid:${uid}`);
    if (name) keys.push(`operator-name:${name}`);
    if (name && namespace) keys.push(`operator:${name}:${namespace}`);
    const seen = keys.some((key) => this._countedOperators.has(key));
    for (const key of keys) this._countedOperators.add(key);
    if (seen) return;
    this._bumpStat('operatorsInstalled');
    this.progress.stats.lastOperatorInstalled = data.packageName || name || null;
    this._afterStatChange();
  }

  _onSccGranted(data = {}) {
    if (this._statsSuspended) return;
    const key = `scc:${data.scc || ''}:${data.subject || data.name || ''}`;
    if (this._countUnique(this._countedSccGrants, key)) return;
    this._bumpStat('sccGrants');
    this._afterStatChange();
  }

  // ─── XP / levels ─────────────────────────────────────────────────────────

  addXP(amount) {
    const delta = asNumber(amount, 0);
    if (!delta) return;
    this.progress.xp = asNumber(this.progress.xp, 0) + delta;
    const oldLevel = asNumber(this.progress.level, 1);
    this.progress.level = this.calculateLevel(this.progress.xp);

    if (this.progress.level > oldLevel) {
      const levelInfo = XP_LEVELS.find((entry) => entry.level === this.progress.level);
      this.gameEngine?.emit?.('player:level-up', {
        level: this.progress.level,
        title: levelInfo ? levelInfo.title : 'Unknown',
        totalXP: this.progress.xp,
      });
    }

    this.gameEngine?.emit?.('xp:gained', {
      amount: delta,
      totalXP: this.progress.xp,
      level: this.progress.level,
    });
    this.saveProgress();
  }

  calculateLevel(xp) {
    let level = 1;
    for (const entry of XP_LEVELS) {
      if (xp >= entry.xpRequired) level = entry.level;
      else break;
    }
    return level;
  }

  getLevelInfo() {
    const currentXP = this.progress.xp || 0;
    const currentLevel = this.calculateLevel(currentXP);
    const currentEntry = XP_LEVELS.find((entry) => entry.level === currentLevel);
    const nextEntry = XP_LEVELS.find((entry) => entry.level === currentLevel + 1);

    return {
      level: currentLevel,
      title: currentEntry ? currentEntry.title : 'Novice',
      currentXP,
      xpForCurrentLevel: currentEntry ? currentEntry.xpRequired : 0,
      xpForNextLevel: nextEntry ? nextEntry.xpRequired : null,
      xpProgress: nextEntry
        ? (currentXP - currentEntry.xpRequired) / (nextEntry.xpRequired - currentEntry.xpRequired)
        : 1,
    };
  }

  // ─── campaign / challenge stars ─────────────────────────────────────────

  calculateStarRating(levelId, completionTime, efficiency, hadFailures) {
    const levels = this.gameEngine?.campaignLevels || [];
    const level = levels.find((entry) => entry.id === levelId);
    if (!level?.starCriteria) {
      // No level definition (e.g. a challenge id): completion = 1 star.
      return 1;
    }

    let stars = 1;
    const criteria = level.starCriteria;
    const timeMet = completionTime <= criteria.time;
    const efficiencyMet = efficiency >= criteria.efficiency;
    const noFailuresMet = !criteria.noFailures || !hadFailures;

    if (timeMet && efficiencyMet) stars = 2;
    if (timeMet && efficiencyMet && noFailuresMet) stars = 3;
    return stars;
  }

  completeCampaignLevel(levelId, completionTime, efficiency, hadFailures, usedHints) {
    const stars = this.calculateStarRating(levelId, completionTime, efficiency, hadFailures);

    if (!this.progress.campaignProgress) this.progress.campaignProgress = {};
    const existing = this.progress.campaignProgress[levelId];
    if (!existing || stars > existing.stars) {
      this.progress.campaignProgress[levelId] = {
        completed: true,
        stars,
        bestTime: existing ? Math.min(asNumber(existing.bestTime, completionTime), completionTime) : completionTime,
        completedAt: Date.now(),
      };
    } else if (existing) {
      existing.completed = true;
      existing.bestTime = Math.min(asNumber(existing.bestTime, completionTime), completionTime);
    }

    const completedLevels = Object.keys(this.progress.campaignProgress).filter(
      (id) => this.progress.campaignProgress[id].completed
    );
    this.progress.stats.levelsCompleted = completedLevels.length;
    this.progress.stats.threeStarLevels = Object.values(this.progress.campaignProgress).filter(
      (entry) => entry.stars === 3
    ).length;
    this.progress.stats.totalStars = Object.values(this.progress.campaignProgress).reduce(
      (sum, entry) => sum + asNumber(entry.stars, 0),
      0
    );

    if (!this.progress.stats.levelTimes) this.progress.stats.levelTimes = {};
    this.progress.stats.levelTimes[levelId] = Math.min(
      asNumber(this.progress.stats.levelTimes[levelId], Infinity),
      completionTime
    );

    if (!usedHints) {
      this.progress.stats.completedWithoutHints = (this.progress.stats.completedWithoutHints || 0) + 1;
    }

    this.progress.stats.chaptersCompleted = CAMPAIGN_CHAPTERS.filter((chapter) =>
      chapter.every((level) => this.progress.campaignProgress[level]?.completed)
    ).length;

    // Evidence that the level was completed through live objective evaluation.
    this.recordObjectiveEvidence('level', levelId, this._lastObjectiveTypes || []);

    const baseXP = 100 + Number(levelId) * 25;
    const starBonus = stars * 50;
    this.addXP(baseXP + starBonus);

    this.checkAchievements();
    this.saveProgress();

    return { stars, xpEarned: baseXP + starBonus };
  }

  /**
   * Record a timed challenge result.
   *
   * @param {number|string} challengeId
   * @param {number} completionTime seconds
   * @param {number} completionPercentage 0..100
   * @param {{timeLimit?: number, usedHints?: boolean}} [options]
   *   `timeLimit` enables time-relative star thresholds; without it the legacy
   *   fixed thresholds (≤180 s / ≤120 s) are kept for compatibility.
   */
  completeChallenge(challengeId, completionTime, completionPercentage, options = {}) {
    if (!this.progress.challengeProgress) this.progress.challengeProgress = {};

    const timeLimit = asNumber(options.timeLimit, 0);
    const completed = completionPercentage >= 100;
    let stars = 0;
    if (completed) {
      stars = 1;
      const twoStarTime = timeLimit > 0 ? timeLimit * 0.75 : 180;
      const threeStarTime = timeLimit > 0 ? timeLimit * 0.5 : 120;
      if (completionTime <= twoStarTime) stars = 2;
      if (completionTime <= threeStarTime) stars = 3;
    }

    const existing = this.progress.challengeProgress[challengeId];
    if (!existing || stars > existing.stars) {
      this.progress.challengeProgress[challengeId] = {
        completed: completed || Boolean(existing?.completed),
        stars,
        bestTime: existing ? Math.min(asNumber(existing.bestTime, completionTime), completionTime) : completionTime,
        completionPercentage,
      };
    } else if (existing) {
      existing.completed = existing.completed || completed;
      existing.bestTime = Math.min(asNumber(existing.bestTime, completionTime), completionTime);
      existing.completionPercentage = Math.max(
        asNumber(existing.completionPercentage, 0),
        completionPercentage
      );
    }

    this.progress.stats.challengesCompleted = Object.values(this.progress.challengeProgress).filter(
      (entry) => entry.completed
    ).length;
    this.progress.stats.threeStarChallenges = Object.values(this.progress.challengeProgress).filter(
      (entry) => entry.stars === 3
    ).length;

    this.recordObjectiveEvidence('challenge', challengeId, this._lastObjectiveTypes || []);

    const xp = Math.floor(completionPercentage * 2) + stars * 75;
    this.addXP(xp);
    this.checkAchievements();
    this.saveProgress();

    return { stars, xpEarned: xp };
  }

  recordChaosSurvival(survivalTimeSeconds) {
    this.progress.stats.longestChaosSurvival = Math.max(
      asNumber(this.progress.stats.longestChaosSurvival, 0),
      asNumber(survivalTimeSeconds, 0)
    );
    this.progress.stats.chaosRuns = asNumber(this.progress.stats.chaosRuns, 0) + 1;
    this.checkAchievements();
    this.saveProgress();
  }

  // ─── EX280 Prep progress API (CONVERSION-SPEC §11) ──────────────────────

  /** @returns {Record<string, {state: 'practiced'|'mastered', updatedAt: number}>} */
  getExamPrepProgress() {
    const out = {};
    for (const [id, entry] of Object.entries(this.progress.examPrep || {})) {
      if (!entry || !entry.state) continue;
      out[id] = { state: entry.state, updatedAt: asNumber(entry.updatedAt, 0) };
    }
    return out;
  }

  /**
   * Record EX280 bullet practice/mastery. `mastered` is sticky: practising an
   * already-mastered bullet never downgrades it.
   * @param {string} bulletId
   * @param {'practiced'|'mastered'} state
   * @returns {{state: string, updatedAt: number}|null}
   */
  markExamPrep(bulletId, state) {
    if (!bulletId) return null;
    const normalized = state === 'mastered' ? 'mastered' : state === 'practiced' ? 'practiced' : null;
    if (!normalized) return null;

    if (!this.progress.examPrep || typeof this.progress.examPrep !== 'object') {
      this.progress.examPrep = {};
    }
    const existing = this.progress.examPrep[bulletId];
    const previousState = existing?.state || (typeof existing === 'string' ? existing : null);
    const nextState = previousState === 'mastered' ? 'mastered' : normalized;
    const entry = { state: nextState, updatedAt: Date.now() };
    this.progress.examPrep[bulletId] = entry;
    this.progress.stats.examPrepMastered = this._countMastered(this.progress.examPrep);

    this.gameEngine?.emit?.('examPrep:updated', {
      bulletId,
      state: nextState,
      mastered: this.progress.stats.examPrepMastered,
    });
    this.checkAchievements();
    this.saveProgress();
    return { ...entry };
  }

  // ─── OpenShift Architecture Advisor (CONVERSION-SPEC §12) ───────────────

  /**
   * Score a cluster on the 10 OpenShift Architecture Advisor categories.
   * @param {object} clusterState ClusterState (or a compatible stub)
   * @returns {{total: number, categories: Record<string, {score: number, recommendations: string[]}>}}
   */
  calculateArchitectureScore(clusterState) {
    const scores = {
      highAvailability: this.scoreHighAvailability(clusterState),
      security: this.scoreSecurity(clusterState),
      networking: this.scoreNetworking(clusterState),
      scalability: this.scoreScalability(clusterState),
      costEfficiency: this.scoreCostEfficiency(clusterState),
      reliability: this.scoreReliability(clusterState),
      configuration: this.scoreConfiguration(clusterState),
      storage: this.scoreStorage(clusterState),
      observability: this.scoreObservability(clusterState),
      organization: this.scoreOrganization(clusterState),
    };

    const values = Object.values(scores);
    const total = values.length === 0 ? 0 : Math.round(
      values.reduce((sum, category) => sum + asNumber(category.score, 0), 0) / values.length
    );

    const stats = this.progress.stats;
    const previous = asNumber(stats.lastArchitectureScore, -1);
    stats.lastArchitectureScore = total;
    stats.bestArchitectureScore = Math.max(asNumber(stats.bestArchitectureScore, 0), total);
    stats.highestArchitectureScore = stats.bestArchitectureScore;
    stats.architectureScore = stats.bestArchitectureScore;
    stats.architectureScoreUpdatedAt = Date.now();
    if (total !== previous) {
      this.checkAchievements();
      this.saveProgress();
    }

    return { total, categories: scores };
  }

  _resources(state, kind) {
    if (!state) return [];
    try {
      if (typeof state.getResourcesByKind === 'function') return asArray(state.getResourcesByKind(kind));
      if (typeof state.getByKind === 'function') return asArray(state.getByKind(kind));
      if (typeof state.getAllResources === 'function') {
        return asArray(state.getAllResources()).filter((resource) => resource?.kind === kind);
      }
      if (state.resources && typeof state.resources.values === 'function') {
        return [...state.resources.values()].filter((resource) => resource?.kind === kind);
      }
    } catch {
      /* defensive */
    }
    return [];
  }

  _allResources(state) {
    if (!state) return [];
    try {
      if (typeof state.getAllResources === 'function') return asArray(state.getAllResources());
      if (state.resources && typeof state.resources.values === 'function') {
        return [...state.resources.values()];
      }
    } catch {
      /* defensive */
    }
    return [];
  }

  _containers(resource) {
    const spec = resourceSpec(resource);
    if (resource?.kind === 'Pod') return asArray(spec.containers);
    if (resource?.kind === 'CronJob') {
      return asArray(spec.jobTemplate?.spec?.template?.spec?.containers);
    }
    if (Array.isArray(spec.template?.spec?.containers)) return spec.template.spec.containers;
    return asArray(spec.containers);
  }

  _workloadKinds(state) {
    return [
      ...this._resources(state, 'Deployment'),
      ...this._resources(state, 'StatefulSet'),
      ...this._resources(state, 'DaemonSet'),
      ...this._resources(state, 'ReplicaSet'),
    ];
  }

  _routesAdmitted(routes) {
    return routes.filter((route) => {
      const ingress = asArray(resourceStatus(route).ingress);
      return ingress.some((entry) =>
        asArray(entry?.conditions).some(
          (condition) => condition?.type === 'Admitted' && String(condition.status) === 'True'
        )
      );
    });
  }

  _hasSensitiveConfigMap(configMaps) {
    return configMaps.some((configMap) => {
      const data = resourceSpec(configMap).data;
      if (!data || typeof data !== 'object') return false;
      return Object.keys(data).some((key) => SENSITIVE_CONFIGMAP_KEY.test(key));
    });
  }

  _manifestState() {
    const manifestEngine = this.gameEngine?.manifestEngine
      || (typeof window !== 'undefined' ? window.game?.manifestEngine : null);
    if (!manifestEngine) return null;
    try {
      if (typeof manifestEngine.getState === 'function') return manifestEngine.getState();
    } catch {
      /* defensive */
    }
    return null;
  }

  // ── category: high availability ─────────────────────────────────────────
  scoreHighAvailability(state) {
    const recommendations = [];
    const deployments = this._resources(state, 'Deployment');
    if (deployments.length === 0) {
      return {
        score: 0,
        recommendations: ['Deploy workloads as Deployments with at least two replicas'],
      };
    }

    let score = 0;
    const multiReplica = deployments.filter((deployment) => asNumber(resourceSpec(deployment).replicas, 1) > 1);
    score += ratio(multiReplica.length, deployments.length) * 40;
    if (multiReplica.length < deployments.length) {
      recommendations.push('Set spec.replicas > 1 for every Deployment (oc scale deployment/<name> --replicas=2)');
    }

    const nodes = this._resources(state, 'Node');
    score += Math.min(30, nodes.length * 10);
    if (nodes.length < 3) {
      recommendations.push('Run at least three worker Nodes so a single failure cannot take the platform down');
    }

    const pdbs = this._resources(state, 'PodDisruptionBudget');
    score += Math.min(30, pdbs.length * 15);
    if (pdbs.length === 0) {
      recommendations.push('Add PodDisruptionBudgets so drains/maintenance keep a minimum number of Pods available');
    }

    return { score: integer(score), recommendations };
  }

  // ── category: security (SCC / RBAC / NetworkPolicy / secrets) ───────────
  scoreSecurity(state) {
    const recommendations = [];
    let score = 0;

    const netpols = this._resources(state, 'NetworkPolicy');
    score += Math.min(25, netpols.length * 10);
    if (netpols.length === 0) {
      recommendations.push('Create NetworkPolicies (default-deny + explicit allows) to segment project traffic');
    }

    const roles = [...this._resources(state, 'Role'), ...this._resources(state, 'ClusterRole')];
    const bindings = [
      ...this._resources(state, 'RoleBinding'),
      ...this._resources(state, 'ClusterRoleBinding'),
    ];
    score += Math.min(25, (roles.length + bindings.length) * 5);
    if (roles.length === 0 && bindings.length === 0) {
      recommendations.push('Use RBAC Roles/RoleBindings instead of shared administrator credentials');
    }

    const wildcardRoles = roles.filter((role) => {
      const name = resourceName(role);
      // Built-in cluster-admin/system roles legitimately use wildcards.
      if (name === 'cluster-admin' || name.startsWith('system:')) return false;
      return asArray(resourceSpec(role).rules).some(
        (rule) => asArray(rule?.verbs).includes('*') || asArray(rule?.resources).includes('*')
      );
    });
    if (wildcardRoles.length > 0) {
      score -= 10;
      recommendations.push('Replace wildcard Role rules with the specific verbs/resources the workload needs');
    }

    const secrets = this._resources(state, 'Secret');
    const configMaps = this._resources(state, 'ConfigMap');
    score += Math.min(25, secrets.length * 10);
    if (this._hasSensitiveConfigMap(configMaps)) {
      score -= 15;
      recommendations.push('Move passwords/tokens/keys out of ConfigMaps into Secrets (or a Vault-backed provider)');
    } else if (secrets.length === 0) {
      recommendations.push('Store credentials and TLS material in Secrets, not in ConfigMaps or images');
    }

    const sccs = this._resources(state, 'SecurityContextConstraints');
    const grantedSccs = sccs.filter((scc) => {
      const spec = resourceSpec(scc);
      return asArray(spec.users).length > 0 || asArray(spec.groups).length > 0;
    });
    if (grantedSccs.length > 0) score += 15;
    else {
      recommendations.push('Grant SCCs to a ServiceAccount (oc adm policy add-scc-to-user anyuid -z <sa>), not to broad groups');
    }

    const privilegedWorkloads = this._workloadKinds(state).filter((workload) => {
      const containers = this._containers(workload);
      return containers.some((container) => container?.securityContext?.privileged === true)
        || resourceSpec(workload)?.template?.spec?.securityContext?.privileged === true;
    });
    if (privilegedWorkloads.length === 0) score += 10;
    else {
      recommendations.push('Avoid privileged containers; use anyuid/nonroot SCCs and drop Linux capabilities instead');
    }

    return { score: integer(score), recommendations };
  }

  // ── category: networking (Routes / LoadBalancer / TLS) ──────────────────
  scoreNetworking(state) {
    const recommendations = [];
    let score = 0;

    const deployments = this._resources(state, 'Deployment');
    const services = this._resources(state, 'Service');
    score += ratio(services.length, Math.max(1, deployments.length)) * 25;
    if (services.length < deployments.length) {
      recommendations.push('Create a Service for every Deployment (oc expose deployment/<name> or a Service manifest)');
    }

    const routes = this._resources(state, 'Route');
    const admittedRoutes = this._routesAdmitted(routes);
    score += Math.min(25, routes.length * 10);
    if (routes.length === 0 && services.length > 0) {
      recommendations.push('Expose a Service with a Route (oc expose svc/<name>) for external HTTP(S) access');
    } else if (routes.length > 0 && admittedRoutes.length < routes.length) {
      recommendations.push('Check Route admission: the router needs ready Service endpoints (oc get route, oc get endpoints)');
    }

    const tlsRoutes = routes.filter((route) => Boolean(resourceSpec(route).tls?.termination));
    score += ratio(tlsRoutes.length, Math.max(1, routes.length)) * 20;
    if (routes.length > 0 && tlsRoutes.length === 0) {
      recommendations.push('Use TLS termination on Routes (oc create route edge/reencrypt/passthrough)');
    }

    const loadBalancers = services.filter((service) => resourceSpec(service).type === 'LoadBalancer');
    if (loadBalancers.length > 0) score += 15;
    else {
      recommendations.push('For non-HTTP services on bare metal, install MetalLB and use a LoadBalancer Service');
    }

    const netpols = this._resources(state, 'NetworkPolicy');
    score += Math.min(15, netpols.length * 5);
    if (netpols.length === 0 && services.length > 0) {
      recommendations.push('Add NetworkPolicies so Routes/Services are not reachable from every Pod in every project');
    }

    return { score: integer(score), recommendations };
  }

  // ── category: scalability ───────────────────────────────────────────────
  scoreScalability(state) {
    const recommendations = [];
    let score = 0;

    const deployments = this._resources(state, 'Deployment');
    const hpas = this._resources(state, 'HorizontalPodAutoscaler');
    score += Math.min(40, hpas.length * 20);
    if (hpas.length === 0 && deployments.length > 0) {
      recommendations.push('Add a HorizontalPodAutoscaler (oc autoscale deployment/<name> --min=2 --max=10 --cpu-percent=70)');
    }

    const multiReplica = deployments.filter((deployment) => asNumber(resourceSpec(deployment).replicas, 1) > 1);
    score += ratio(multiReplica.length, Math.max(1, deployments.length)) * 25;
    if (deployments.length > 0 && multiReplica.length < deployments.length) {
      recommendations.push('Run more than one replica for each stateless Deployment');
    }

    const withRequests = deployments.filter((deployment) =>
      this._containers(deployment).length > 0
      && this._containers(deployment).every((container) => container?.resources?.requests)
    );
    score += ratio(withRequests.length, Math.max(1, deployments.length)) * 20;
    if (deployments.length > 0 && withRequests.length < deployments.length) {
      recommendations.push('Set CPU/memory requests on every container so the scheduler and HPA have real data');
    }

    const nodes = this._resources(state, 'Node');
    score += Math.min(15, nodes.length * 5);
    if (nodes.length < 2) recommendations.push('Add worker Nodes or enable cluster autoscaling for burst capacity');

    return { score: integer(score), recommendations };
  }

  // ── category: cost efficiency ───────────────────────────────────────────
  scoreCostEfficiency(state) {
    const recommendations = [];
    const deployments = this._resources(state, 'Deployment');
    if (deployments.length === 0) {
      return { score: 0, recommendations: ['Deploy workloads before evaluating cost efficiency'] };
    }

    let score = 60;
    const overProvisioned = deployments.filter((deployment) => asNumber(resourceSpec(deployment).replicas, 1) > 5);
    if (overProvisioned.length > 0) {
      score -= overProvisioned.length * 10;
      recommendations.push('Review Deployments with more than five replicas; use an HPA instead of fixed overprovisioning');
    }

    const hpas = this._resources(state, 'HorizontalPodAutoscaler');
    score += Math.min(20, hpas.length * 10);
    if (hpas.length === 0) recommendations.push('Use an HPA to scale down during idle periods');

    const withLimits = deployments.filter((deployment) =>
      this._containers(deployment).length > 0
      && this._containers(deployment).every((container) => container?.resources?.limits)
    );
    score += ratio(withLimits.length, deployments.length) * 20;
    if (withLimits.length < deployments.length) {
      recommendations.push('Set resource limits so one noisy workload cannot starve the project');
    }

    return { score: integer(score), recommendations };
  }

  // ── category: reliability (probes / replicas / PDB) ─────────────────────
  scoreReliability(state) {
    const recommendations = [];
    let score = 0;

    const deployments = this._resources(state, 'Deployment');
    const withBothProbes = deployments.filter((deployment) => {
      const containers = this._containers(deployment);
      return containers.length > 0
        && containers.every((container) => container?.livenessProbe && container?.readinessProbe);
    });
    score += ratio(withBothProbes.length, Math.max(1, deployments.length)) * 40;
    if (deployments.length > 0 && withBothProbes.length < deployments.length) {
      recommendations.push('Add liveness and readiness probes to every container (oc set probe deployment/<name>)');
    }

    const multiReplica = deployments.filter((deployment) => asNumber(resourceSpec(deployment).replicas, 1) > 1);
    score += ratio(multiReplica.length, Math.max(1, deployments.length)) * 25;

    const pdbs = this._resources(state, 'PodDisruptionBudget');
    score += Math.min(20, pdbs.length * 10);
    if (pdbs.length === 0 && multiReplica.length > 0) {
      recommendations.push('Protect multi-replica workloads with PodDisruptionBudgets');
    }

    const rolling = deployments.filter((deployment) => {
      const type = resourceSpec(deployment).strategy?.type;
      return !type || type === 'RollingUpdate';
    });
    score += ratio(rolling.length, Math.max(1, deployments.length)) * 15;
    if (rolling.length < deployments.length) {
      recommendations.push('Prefer the RollingUpdate strategy for zero-downtime deployments');
    }

    return { score: integer(score), recommendations };
  }

  // ── category: configuration (ConfigMaps / Secrets / manifests) ──────────
  scoreConfiguration(state) {
    const recommendations = [];
    let score = 0;

    const configMaps = this._resources(state, 'ConfigMap');
    const secrets = this._resources(state, 'Secret');
    score += Math.min(35, (configMaps.length + secrets.length) * 10);
    if (configMaps.length === 0 && secrets.length === 0) {
      recommendations.push('Externalise configuration with ConfigMaps and Secrets (do not bake it into images)');
    }
    if (this._hasSensitiveConfigMap(configMaps)) {
      score -= 15;
      recommendations.push('Move sensitive ConfigMap keys (password/token/key) into a Secret');
    }

    const workloads = [...this._resources(state, 'Deployment'), ...this._resources(state, 'StatefulSet')];
    const withConfigRefs = workloads.filter((workload) => {
      if (asArray(resourceSpec(workload).template?.spec?.volumes).length > 0) return true;
      return this._containers(workload).some(
        (container) => asArray(container?.envFrom).length > 0
          || asArray(container?.env).some((entry) => entry?.valueFrom)
      );
    });
    score += ratio(withConfigRefs.length, Math.max(1, workloads.length)) * 30;
    if (workloads.length > 0 && withConfigRefs.length < workloads.length) {
      recommendations.push('Consume ConfigMaps/Secrets via envFrom or volumes instead of hardcoded values');
    }

    const manifestState = this._manifestState();
    const appliedFiles = asArray(manifestState?.appliedFiles).length;
    const appliedKustomize = asArray(manifestState?.appliedKustomize).length;
    if (appliedFiles + appliedKustomize > 0) score += 20;
    else {
      recommendations.push('Manage configuration declaratively (oc apply -f / oc apply -k) so changes are reviewable');
    }

    return { score: integer(score), recommendations };
  }

  // ── category: storage ───────────────────────────────────────────────────
  scoreStorage(state) {
    const recommendations = [];
    const statefulSets = this._resources(state, 'StatefulSet');
    const pvcs = this._resources(state, 'PersistentVolumeClaim');
    const pvs = this._resources(state, 'PersistentVolume');
    const storageClasses = this._resources(state, 'StorageClass');

    if (statefulSets.length === 0 && pvcs.length === 0 && pvs.length === 0) {
      return {
        score: 50,
        recommendations: ['If you run databases/queues, use StatefulSets with PVCs and a default StorageClass'],
      };
    }

    let score = 20;
    if (statefulSets.length > 0) {
      const boundPvcs = pvcs.filter((claim) => resourceStatus(claim).phase === 'Bound');
      score += ratio(boundPvcs.length, Math.max(statefulSets.length, pvcs.length)) * 30;
      if (boundPvcs.length < pvcs.length || boundPvcs.length < statefulSets.length) {
        recommendations.push('Check PVC binding: inspect StorageClasses, PV capacity and access modes (oc get pvc, oc describe pvc)');
      }
    } else if (pvcs.length > 0) {
      const boundPvcs = pvcs.filter((claim) => resourceStatus(claim).phase === 'Bound');
      score += ratio(boundPvcs.length, pvcs.length) * 30;
    }

    score += Math.min(25, pvs.length * 10);
    if (storageClasses.length > 0) score += 15;
    else recommendations.push('Provide a default StorageClass so PVCs can be dynamically provisioned');

    return { score: integer(score), recommendations };
  }

  // ── category: observability (probes / events / ClusterOperators) ────────
  scoreObservability(state) {
    const recommendations = [];
    let score = 0;

    const deployments = this._resources(state, 'Deployment');
    const withProbes = deployments.filter((deployment) =>
      this._containers(deployment).some((container) => container?.livenessProbe || container?.readinessProbe)
    );
    score += ratio(withProbes.length, Math.max(1, deployments.length)) * 30;
    if (deployments.length > 0 && withProbes.length < deployments.length) {
      recommendations.push('Add probes so failures are visible to OpenShift and unhealthy Pods are replaced');
    }

    const operators = this._resources(state, 'ClusterOperator');
    if (operators.length > 0) {
      const healthy = operators.filter((operator) => {
        const conditions = asArray(resourceStatus(operator).conditions);
        const available = conditions.find((condition) => condition?.type === 'Available');
        const degraded = conditions.find((condition) => condition?.type === 'Degraded');
        return available?.status === 'True' && degraded?.status !== 'True';
      });
      score += ratio(healthy.length, operators.length) * 40;
      if (healthy.length < operators.length) {
        recommendations.push('Investigate degraded ClusterOperators (oc get co, oc describe co/<name>) before they page you at 03:00');
      }
    } else {
      recommendations.push('Watch ClusterOperators and ClusterVersion for platform-level health');
    }

    const daemonSets = this._resources(state, 'DaemonSet');
    const monitoring = daemonSets.some((daemonSet) =>
      /monitor|metric|log|fluent|prometheus|node-exporter/i.test(resourceName(daemonSet))
    );
    const monitoringOperator = operators.some((operator) => resourceName(operator) === 'monitoring');
    if (monitoring || monitoringOperator) score += 15;
    else recommendations.push('Use the OpenShift monitoring stack (or a metrics/logging DaemonSet) for cluster-wide visibility');

    const hpas = this._resources(state, 'HorizontalPodAutoscaler');
    score += Math.min(15, hpas.length * 5);

    return { score: integer(score), recommendations };
  }

  // ── category: organization (projects / quotas / labels) ─────────────────
  scoreOrganization(state) {
    const recommendations = [];
    let score = 0;

    const projects = this._resources(state, 'Project');
    score += Math.min(30, projects.length * 5);
    if (projects.length <= 1) {
      recommendations.push('Organise workloads into Projects (one per team/environment) instead of one shared namespace');
    }

    const quotas = this._resources(state, 'ResourceQuota');
    const limitRanges = this._resources(state, 'LimitRange');
    const clusterQuotas = this._resources(state, 'ClusterResourceQuota');
    score += Math.min(20, quotas.length * 10);
    score += Math.min(10, limitRanges.length * 5);
    score += Math.min(10, clusterQuotas.length * 10);
    if (quotas.length === 0 && clusterQuotas.length === 0) {
      recommendations.push('Add ResourceQuotas/ClusterResourceQuotas to cap project consumption');
    }
    if (limitRanges.length === 0) {
      recommendations.push('Add a LimitRange so Pods get sane default requests/limits');
    }

    const allResources = this._allResources(state);
    const labeled = allResources.filter((resource) => Object.keys(resourceLabels(resource)).length > 0);
    score += ratio(labeled.length, Math.max(1, allResources.length)) * 30;
    if (labeled.length < allResources.length * 0.5) {
      recommendations.push('Label resources consistently (app, app.kubernetes.io/part-of, environment) for selectors and policy');
    }

    return { score: integer(score), recommendations };
  }

  // ─── achievements ───────────────────────────────────────────────────────

  checkAchievements() {
    const stats = { ...this.progress.stats };
    const newUnlocks = [];

    for (const achievement of ACHIEVEMENTS) {
      if (this.unlockedAchievements.has(achievement.id)) continue;
      try {
        if (achievement.condition(stats)) {
          this.unlockedAchievements.add(achievement.id);
          newUnlocks.push(achievement);
          this.addXP(achievement.xpReward);
          this.gameEngine?.emit?.('achievement:unlocked', {
            id: achievement.id,
            name: achievement.name,
            description: achievement.description,
            icon: achievement.icon,
            category: achievement.category,
            xpReward: achievement.xpReward,
          });
        }
      } catch (error) {
        console.warn('Achievement check error:', error);
      }
    }

    this.progress.achievements = Array.from(this.unlockedAchievements);
    if (newUnlocks.length > 0) this.saveProgress();
    return newUnlocks;
  }

  getAchievements() {
    return ACHIEVEMENTS.map((achievement) => ({
      ...achievement,
      condition: undefined,
      unlocked: this.unlockedAchievements.has(achievement.id),
    }));
  }

  // ─── progress persistence / public API ───────────────────────────────────

  getProgress() {
    return {
      xp: this.progress.xp || 0,
      level: this.progress.level || 1,
      levelInfo: this.getLevelInfo(),
      stats: { ...this.progress.stats },
      campaignProgress: { ...this.progress.campaignProgress },
      challengeProgress: { ...this.progress.challengeProgress },
      examPrep: this.getExamPrepProgress(),
      drillCommandEvidence: this.getDrillCommandEvidence(),
      objectiveEvidence: this.getObjectiveEvidence(),
      achievementsUnlocked: this.unlockedAchievements.size,
      achievementsTotal: ACHIEVEMENTS.length,
    };
  }

  loadProgress() {
    let data = null;
    let sourceKey = null;
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          data = JSON.parse(stored);
          sourceKey = STORAGE_KEY;
        }
      }
    } catch {
      data = null;
    }

    if (!data) {
      try {
        if (typeof localStorage !== 'undefined') {
          const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
          if (legacy) {
            data = JSON.parse(legacy);
            sourceKey = LEGACY_STORAGE_KEY;
          }
        }
      } catch {
        data = null;
      }
    }

    this._needsMigrationSave = sourceKey === LEGACY_STORAGE_KEY;
    return this._normalizeProgress(data || {});
  }

  saveProgress() {
    if (!this.progress) return;
    try {
      if (typeof localStorage === 'undefined') return;
      const achievements = Array.from(this.unlockedAchievements || this.progress.achievements || []);
      this.progress.achievements = achievements;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        xp: this.progress.xp,
        level: this.progress.level,
        stats: this.progress.stats,
        achievements,
        campaignProgress: this.progress.campaignProgress,
        challengeProgress: this.progress.challengeProgress,
        examPrep: this.progress.examPrep,
        drillCommandEvidence: this.progress.drillCommandEvidence || {},
        objectiveEvidence: this.progress.objectiveEvidence || {},
      }));
    } catch {
      /* storage unavailable/full — progress still lives in memory */
    }
  }

  resetProgress() {
    this.progress = this._normalizeProgress({});
    this.unlockedAchievements.clear();
    this.sessionStats = this.createEmptySessionStats();
    this._countedResources.clear();
    this._countedBuilds.clear();
    this._countedOperators.clear();
    this._countedSccGrants.clear();
    this._countedFiles.clear();
    this._needsMigrationSave = false;
    this.saveProgress();
    this._removeLegacyProgress();
  }

  destroy() {
    this.saveProgress();
    if (this._nightOwlInterval) clearInterval(this._nightOwlInterval);
    if (this._seedResumeTimer) clearTimeout(this._seedResumeTimer);
    for (const off of this._unsubscribers) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this._unsubscribers = [];
    this.gameEngine = null;
  }
}

export { ScoringEngine, XP_LEVELS, STORAGE_KEY, LEGACY_STORAGE_KEY };
