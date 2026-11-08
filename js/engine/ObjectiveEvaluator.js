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
 *   explainObjective(obj, ctx) -> null | { code, text, ... }   (why an objective is unticked)
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
import { templateHash } from './TemplateHash.js';
// linux-engine (1.16.0): `file` objectives can require a manifest to parse as YAML.
import { parseYaml } from './YamlParser.js';

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
  // 1.16.0: one Node's maintenance state (Ready, cordoned, drained) — campaign
  // "Nodes & Cluster Troubleshooting".
  'node',
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
  // 1.16.0: `project.config.openshift.io/cluster` points new projects at a
  // project-request Template (graded on the config, not on `oc edit` typed).
  'projectRequestTemplate',
  // 1.16.0 (linux-engine): the simulated RHEL 9 workstation (js/engine/LinuxHost.js),
  // graded from host STATE — files, units, processes, packages, firewalld, podman,
  // SELinux, accounts, the shell session — plus `ran` (cwd-aware executed-command log).
  'file',
  'service',
  'process',
  'package',
  'firewall',
  'container',
  'selinux',
  'linuxUser',
  'cwd',
  'env',
  'ran',
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
  'node',
  'examScore',
  'architectureScore',
  'networkPolicy',
  'oauthProvider',
  'password',
  'identity',
  'installPlan',
  'subscription',
  'routeAccess',
  'projectRequestTemplate',
  'label',
  // linux-engine: workstation state checks are done/not-done flags.
  'file',
  'service',
  'process',
  'package',
  'firewall',
  'container',
  'selinux',
  'linuxUser',
  'linuxuser',
  'cwd',
  'env',
  'ran',
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

/** Compile an objective regex (string or RegExp) without stateful `g`/`y` flags. */
function compilePattern(pattern) {
  if (pattern === undefined || pattern === null || pattern === '') return null;
  const rawPattern = pattern instanceof RegExp ? pattern.source : String(pattern);
  const flags = (pattern instanceof RegExp ? pattern.flags : 'i').replace(/[gy]/g, '');
  try {
    return new RegExp(rawPattern, flags);
  } catch {
    return null;
  }
}

/** Global `oc` flags that may precede the subcommand and take a separate value. */
const OC_GLOBAL_VALUE_FLAGS = new Set([
  '-n',
  '--namespace',
  '--context',
  '--cluster',
  '--user',
  '--as',
  '--as-group',
  '-s',
  '--server',
  '--token',
  '--kubeconfig',
  '--request-timeout',
  '-v',
  '--loglevel',
]);

/**
 * `oc -n lab get is` → `oc get is -n lab`. Objective patterns are authored as
 * `oc <verb> <resource>`; a global flag typed before the subcommand must not
 * hide the verb from them (1.16.0: L9 "oc -n build-lab get is" never ticked).
 * @param {string} raw recorded command line
 * @returns {string}
 */
export function canonicalCommandText(raw) {
  const text = String(raw || '').trim();
  const match = /^(oc|kubectl)\s+(-.*)$/i.exec(text);
  if (!match) return text;
  const tokens = match[2].split(/\s+/);
  const leading = [];
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const token = tokens[index];
    leading.push(token);
    index += 1;
    if (!token.includes('=') && OC_GLOBAL_VALUE_FLAGS.has(token) && index < tokens.length) {
      leading.push(tokens[index]);
      index += 1;
    }
  }
  if (index >= tokens.length) return text;
  return [match[1], ...tokens.slice(index), ...leading].join(' ');
}

function matchCommands(c, pattern, options = {}) {
  const regex = compilePattern(pattern);
  if (!regex) return [];
  const successOnly = options.successOnly !== false;
  return commandHistory(c).filter((entry) => {
    if (!entry || typeof entry.raw !== 'string') return false;
    if (successOnly && entry.success === false) return false;
    return regex.test(entry.raw) || regex.test(canonicalCommandText(entry.raw));
  });
}

// ─── command objectives: what a read showed, not only what was typed ──────
//
// A `command` objective with `inspect: true` is a READ (get/describe/logs)
// whose evidence is what it showed (1.16.0): it must have succeeded, run
// against the objective's project and printed something. `oc get is` at the
// start of L9 printed "No resources found in build-lab namespace." and still
// ticked "Examine the ImageStream"; `oc get pods` in `default` ticked L3's
// "Inspect Pods". Fields:
//   namespace     project the read must target ('*' = any); default: the
//                 level's `workProject` when declared, else its single seeded
//                 Project (no project → no restriction). `-A` always counts.
//   outputPattern regex the output must match (what the read must show).

/**
 * Split a recorded line into its shell segments (`;`, `&&`, `||`, `|`),
 * respecting quotes and `$(…)` substitutions.
 * @param {string} raw
 * @returns {string[]}
 */
function commandSegments(raw) {
  const text = String(raw || '');
  const segments = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' && text[index - 1] === '$') {
      depth += 1;
    } else if (char === ')' && depth > 0) {
      depth -= 1;
    } else if (
      depth === 0 &&
      (char === ';' || char === '|' || (char === '&' && text[index + 1] === '&'))
    ) {
      segments.push(current.trim());
      current = '';
      if (char !== ';' && text[index + 1] === char) index += 1;
      continue;
    }
    current += char;
  }
  segments.push(current.trim());
  return segments.filter(Boolean);
}

/** `-n X` / `--namespace=X` / `-A` of one oc segment. */
function segmentNamespaceScope(segment) {
  const tokens = String(segment || '')
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ''));
  let namespace = null;
  let all = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-A' || token === '--all-namespaces' || token === '--all-namespaces=true') {
      all = true;
    } else if ((token === '-n' || token === '--namespace') && index + 1 < tokens.length) {
      namespace = tokens[index + 1];
      index += 1;
    } else if (token.startsWith('--namespace=')) {
      namespace = token.slice('--namespace='.length);
    } else if (/^-n[a-z0-9]/.test(token)) {
      namespace = token.slice(2);
    }
  }
  return { all, namespace };
}

/**
 * Lines that say a read found nothing, only switched project, or are a server
 * warning (`Warning: apps.openshift.io/v1 DeploymentConfig is deprecated …`
 * precedes `oc get all` output, even before "No resources found").
 */
const EMPTY_READ_LINE =
  /^(No resources found\b.*|Now using project .*|Already on project .*|Warning: .*)$/i;

/**
 * Did a read print something real? Empty output, "No resources found …" and an
 * empty `-o yaml|json` List do not count. Output that was never captured
 * (history written without it) is unknown and does not block.
 * @param {string|undefined} output
 * @returns {boolean}
 */
export function outputShowsSomething(output) {
  if (typeof output !== 'string') return true;
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !EMPTY_READ_LINE.test(line));
  if (lines.length === 0) return false;
  const text = lines.join('\n');
  if (/^kind:\s*List$/m.test(text) && /^items:\s*\[\]$/m.test(text)) return false;
  if (/"kind"\s*:\s*"List"/.test(text) && /"items"\s*:\s*\[\s*\]/.test(text)) return false;
  return true;
}

/** Project a `command` objective's reads must target (null = any). */
function commandObjectiveNamespace(obj, c) {
  if (typeof obj.namespace === 'string' && obj.namespace) {
    return obj.namespace === '*' ? null : obj.namespace;
  }
  const level = c.levelDef;
  if (level && hasOwn(level, 'workProject')) return level.workProject || null;
  return levelProjectNamespace(c);
}

/** `… > file` / `… >> file`: the stdout redirect target of one segment ('' if none). */
function segmentRedirectTarget(segment) {
  const unquoted = String(segment || '').replace(/'[^']*'|"[^"]*"/g, '');
  const match = /(?:^|[^\d&>])>>?\s*([^\s|;&<>]+)/.exec(unquoted);
  return match ? match[1] : '';
}

/** Content of a workstation file (Files panel / shell), or undefined when unreadable. */
function readWorkstationFile(c, path) {
  const engine = c.manifestEngine;
  if (!engine || typeof engine.readFile !== 'function') return undefined;
  for (const candidate of [path, String(path).replace(/^\.\//, '')]) {
    try {
      const text = engine.readFile(candidate);
      if (typeof text === 'string') return text;
    } catch {
      /* try the next spelling */
    }
  }
  return undefined;
}

/** Does one recorded read satisfy an `inspect` objective's project/output rules? */
function inspectionCounts(entry, regex, namespace, outputRegex, c) {
  const segments = commandSegments(entry.raw);
  const segment =
    segments.find((part) => regex.test(part) || regex.test(canonicalCommandText(part))) ||
    segments[0] ||
    '';
  if (namespace) {
    const scope = segmentNamespaceScope(segment);
    const actual = scope.namespace || entry.project || null;
    if (!scope.all && actual && actual !== namespace) return false;
  }
  // `oc get deployment webapp -o yaml > /tmp/webapp.yaml` prints nothing: the
  // export is the file it wrote (unreadable → unknown, does not block).
  const redirect = segmentRedirectTarget(segment);
  const shown = redirect ? readWorkstationFile(c, redirect) : entry.output;
  if (!outputShowsSomething(shown)) return false;
  if (outputRegex && typeof shown === 'string' && !outputRegex.test(shown)) return false;
  return true;
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

/**
 * Read-only view of the cluster limited to one project (plus the Nodes it runs
 * on), shaped like the ClusterState readers the Architecture Advisor uses.
 */
function projectClusterView(cluster, namespace) {
  const inProject = (resource) => {
    const resourceNs = resourceNamespace(resource);
    if (resourceNs) return resourceNs === namespace;
    if (resource?.kind === 'Node') return true;
    if (resource?.kind === 'Project' || resource?.kind === 'Namespace') {
      return resourceName(resource) === namespace;
    }
    return false;
  };
  const byKind = (kind) => listKind(cluster, kind).filter(inProject);
  return {
    getResourcesByKind: byKind,
    getByKind: byKind,
    getAllResources: () => getAllResources(cluster).filter(inProject),
  };
}

/**
 * Advisor score of the player's own project (1.16.0). Scoring the whole
 * cluster rated the platform's seeded workloads: L20's "Advisor ≥ 25" was
 * already ticked at level start (≈ 54) before prod-platform even existed.
 */
function projectArchitectureTotal(c, namespace) {
  if (!namespace) return architectureTotal(c);
  const engine = c.scoringEngine;
  if (!engine || !c.clusterState) return 0;
  if (!findResource(c.clusterState, 'Project', namespace)) return 0;
  try {
    if (typeof engine.calculateArchitectureScore === 'function') {
      const view = projectClusterView(c.clusterState, namespace);
      return asNumber(engine.calculateArchitectureScore(view)?.total, 0);
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

function secretTypeOf(secret) {
  return String(secret?.type || resourceSpec(secret).type || 'Opaque');
}

function wantedList(obj, plural, singular) {
  const list = asArray(obj?.[plural]).filter(Boolean).map(String);
  if (list.length > 0) return list;
  return obj?.[singular] ? [String(obj[singular])] : [];
}

/**
 * Optional state filters of a `deploy` objective (1.16.0):
 *  - `secretType`: the Secret must be of that type (L11 "Create the TLS Secret"
 *    used to accept an Opaque `web-tls`);
 *  - `subjects`/`subject` + `roles`/`role` on a RoleBinding: it must grant one of
 *    the roles to one of the subjects (L14/L16 used to accept ANY learner
 *    binding, e.g. the ServiceAccount binding that repairs the incident).
 *    Subjects use the `group:x` / `user:x` / `system:serviceaccount:ns:sa` forms.
 */
function deployStateMatches(resource, obj) {
  if (obj.secretType && secretTypeOf(resource) !== String(obj.secretType)) return false;
  const subjects = wantedList(obj, 'subjects', 'subject');
  if (subjects.length > 0) {
    const granted = asArray(resourceSpec(resource).subjects || resource?.subjects);
    if (!subjects.some((wanted) => bindingSubjectMatches(granted, wanted))) return false;
  }
  const roles = wantedList(obj, 'roles', 'role');
  if (roles.length > 0) {
    const roleRef = resourceSpec(resource).roleRef || resource?.roleRef || {};
    if (!roles.includes(String(roleRef.name || ''))) return false;
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
    if (!deployStateMatches(resource, obj)) return bool(false);
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
  resources = resources.filter((resource) => deployStateMatches(resource, obj));
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
          // Snapshot the hash that authenticated this login (#71): the password
          // rotation objective proves the hash CHANGED after an earlier
          // successful login without ever learning the player's literal
          // password. A login event is emitted synchronously by GameEngine.login
          // after the IdP Secret was verified, so this reads the hash that just
          // authenticated the user.
          let passwordHash = null;
          try {
            const name =
              typeof engine._providerSecretName === 'function' ? engine._providerSecretName() : '';
            const entries =
              name && typeof engine._getHtpasswdEntries === 'function'
                ? engine._getHtpasswdEntries(name)
                : null;
            const entry = asArray(entries).find(
              (candidate) => String(candidate?.user || '') === String(user)
            );
            if (entry && entry.hash !== undefined && entry.hash !== null) {
              passwordHash = String(entry.hash);
            }
          } catch {
            /* the rotation objective falls back to Secret-write evidence */
          }
          cache.entries.push({
            user: String(user),
            provider: data?.provider || null,
            time: Date.now(),
            ...(passwordHash ? { passwordHash } : {}),
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
        // A new level/challenge/retry is a new engine session: the engine's
        // loginHistory is cleared on cluster:reset, so the evidence latch must
        // be cleared with it (#71). Otherwise snapshots from a previous run of
        // the same objective can satisfy or poison the rotation predicate.
        bus.on('cluster:reset', () => {
          cache.entries.length = 0;
          cache.secretTouches.clear();
        });
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
/**
 * Is a User backed by an identity-provider Identity? A first login creates the
 * User AND the Identity `<provider>:<name>` mapped to it; `oc create user`
 * creates a bare User with no identities.
 */
function userHasIdentity(c, user) {
  const name = resourceName(user);
  const own = [...asArray(user?.identities), ...asArray(resourceSpec(user).identities)];
  if (own.length > 0) return true;
  return listKind(c.clusterState, 'Identity').some((identity) => {
    const spec = resourceSpec(identity);
    return String(spec.user?.name || spec.userName || '') === name;
  });
}

function evaluateUser(obj, c) {
  const users = listKind(c.clusterState, 'User');
  if (obj.name) {
    const user = users.find((candidate) => resourceName(candidate) === obj.name) || null;
    // `exists: false` grades a real deletion (issue #34 auth-users bullet).
    if (obj.exists === false) return bool(!user);
    // `viaLogin: true` (1.16.0): "User alice exists after first login" — a User
    // made with `oc create user alice` has no Identity and must not tick (L13).
    if (user && obj.viaLogin === true) return bool(userHasIdentity(c, user));
    return bool(Boolean(user));
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

/** Does an openshift-config Secret hold a non-empty `htpasswd` data key? */
function htpasswdSecretResolves(cluster, secretName) {
  if (!secretName) return false;
  const secret = findResource(cluster, 'Secret', secretName, 'openshift-config');
  if (!secret) return false;
  const data = secret?.spec?.data || secret?.data || {};
  const encoded = data.htpasswd;
  return typeof encoded === 'string' && encoded.length > 0;
}

/**
 * OAuth identity-provider state (issue #30): grade
 * `oauth.config.openshift.io/cluster` and the live authentication rollout
 * instead of a command regex. Heredoc applies, `oc apply -f` and
 * `oc patch oauth cluster` all count once the provider is really active.
 *
 * `secretReferenced: true` (#71) grades "the htpasswd Secret exists and the
 * identity provider actually references it" instead of a hidden Secret name: a
 * Secret called `my-htp` that `oauth/cluster` points at is exactly as valid as
 * the shipped `htpass-secret` example, as long as the auth rollout applied it.
 */
function evaluateOAuthProvider(obj, c) {
  const wantedType = String(obj.providerType || 'HTPasswd').toLowerCase();
  const wantedSecret = obj.secretName ? String(obj.secretName) : null;
  const requireResolvedSecret = obj.secretReferenced === true;
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
    if (requireResolvedSecret && !htpasswdSecretResolves(cluster, htpasswdSecretOf(candidate))) {
      return false;
    }
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

/** The `{user, hash}` entry for `user` in the IdP-referenced Secret. */
function htpasswdEntryFor(c, user) {
  const entries = htpasswdEntriesFor(c);
  if (!Array.isArray(entries)) return null;
  return entries.find((candidate) => candidate && String(candidate.user) === String(user)) || null;
}

/**
 * State-graded password rotation (#71): no literal password is required, the
 * player's own new password counts. Completion is proven from cluster + login
 * evidence:
 *  - the IdP is active and the user's htpasswd hash CHANGED after a successful
 *    login that authenticated the old hash, and
 *  - a later successful login authenticated the CURRENT hash (the new password
 *    works; the login path only records successes, so no plaintext is stored).
 * Login-time hash snapshots are primary evidence; the Secret write timestamp
 * and a per-run hash baseline cover builds without the event latch.
 */
function evaluatePasswordRotation(obj, c) {
  const user = obj.user ? String(obj.user) : '';
  if (!user) return bool(false);
  if (!identityProviderActive(c)) return bool(false);
  const entry = htpasswdEntryFor(c, user);
  if (!entry) return bool(false);
  const currentHash = String(entry.hash || '');
  if (!currentHash) return bool(false);
  const history = asArray(loginHistory(c));
  const logins = history.filter((item) => loginEntryUser(item) === user);
  // Capture the per-run baseline as soon as the IdP and the user's htpasswd
  // entry exist — BEFORE any successful login — so the fallback below can prove
  // the rotation even when the EventBus latch missed the first login event (the
  // evidence cache attaches its listeners lazily on the first evaluation; a
  // suite/level that logs in before any objective tick must still complete).
  const baseline = ensureBaseline(obj, () => ({ hash: currentHash, historyLength: logins.length }));
  if (logins.length === 0) return bool(false);
  // The engine login history is reset on level/challenge seeding; the event
  // latch is session-scoped, so only snapshots at/after this run's first login
  // belong to it (a replayed level must not reuse a previous run's hash).
  const runStart = Math.min(
    ...history
      .map((item) => (item && typeof item === 'object' ? Number(item.time) : NaN))
      .filter((time) => Number.isFinite(time))
  );
  // 1) Login-time snapshots: the latest login authenticated the current hash,
  //    and an earlier login authenticated a different (the old) hash.
  const snapshots = asArray(latchLoginEvents(c.gameEngine)).filter(
    (item) =>
      item &&
      String(item.user) === user &&
      typeof item.passwordHash === 'string' &&
      item.passwordHash.length > 0 &&
      (!Number.isFinite(runStart) || Number(item.time) >= runStart)
  );
  const lastSnapshot = snapshots[snapshots.length - 1];
  if (lastSnapshot) {
    if (lastSnapshot.passwordHash !== currentHash) return bool(false);
    if (snapshots.some((item) => item.passwordHash !== currentHash)) return bool(true);
  }
  // 2) The authentication operator watches the IdP Secret: a login before the
  //    most recent write and another one after it prove the rotated password.
  const cache = evidenceCache(c.gameEngine);
  const secretName = passwordProviderSecretName(c);
  const rotatedAt = cache?.secretTouches?.get(secretName);
  if (typeof rotatedAt === 'number') {
    const times = logins
      .map((item) => (item && typeof item === 'object' ? Number(item.time) : NaN))
      .filter((time) => Number.isFinite(time));
    if (times.some((time) => time < rotatedAt) && times.some((time) => time >= rotatedAt)) {
      return bool(true);
    }
  }
  // 3) Baseline for environments without the event latch: the hash captured the
  //    first time the objective saw the IdP Secret must differ, and a login by
  //    the user must have happened since.
  if (baseline.hash && baseline.hash !== currentHash) {
    return bool(logins.length > asNumber(baseline.historyLength, 0));
  }
  return bool(false);
}

function evaluatePassword(obj, c) {
  if (obj.rotate === true || obj.rotation === true) return evaluatePasswordRotation(obj, c);
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
  const namespace = obj.namespace || levelProjectNamespace(c) || '';
  const services = listKind(cluster, 'Service');
  const workloads = listKinds(cluster, [
    'Deployment',
    'StatefulSet',
    'DaemonSet',
    'Pod',
    'ReplicaSet',
  ]);
  // Only the Service the objective names may satisfy it (issue #75): falling
  // back to "any Service in the cluster" let the platform's dns-default /
  // router-internal-default Services tick "Service web selects the workload"
  // before the learner had created Service web at all.
  const candidateServices = services.filter((service) => {
    if (namespace && resourceNamespace(service) !== namespace) return false;
    const name = resourceName(service);
    return name === to || name === `${to}-svc` || resourceSpec(service).to?.name === to;
  });
  if (candidateServices.length === 0) return bool(false);
  const connected = candidateServices.some((service) => {
    const selector = resourceSpec(service).selector;
    if (!selector || Object.keys(selector).length === 0) return false;
    const serviceNamespace = resourceNamespace(service);
    return workloads.some((workload) => {
      if (serviceNamespace && resourceNamespace(workload) !== serviceNamespace) return false;
      return labelsMatchSelector(podTemplateLabelsOf(workload), selector);
    });
  });
  return bool(connected);
}

/**
 * The Service port a Route targets: `spec.port.targetPort`, or — when the Route
 * names no port — the Service's first port (by name when it is named), which is
 * what `oc create route`/`oc expose` fill in and what the router uses.
 */
function routeTargetPort(route, c) {
  const spec = resourceSpec(route);
  const explicit = spec.port?.targetPort;
  if (explicit !== undefined && explicit !== null && explicit !== '') return String(explicit);
  const serviceName = spec.to?.name || route?.serviceName || '';
  const service = serviceName
    ? findResource(c?.clusterState, 'Service', serviceName, resourceNamespace(route) || undefined)
    : null;
  const first = asArray(resourceSpec(service).ports)[0];
  if (!first) return '';
  return String(first.name || first.targetPort || first.port || '');
}

function routeMatches(route, obj, c = null) {
  const spec = resourceSpec(route);
  if (obj.name && resourceName(route) !== obj.name) return false;
  // `targetPort` (1.16.0): "targeting the Service port name https" — a Route
  // created with `--port=8443` used to tick it (L12).
  if (
    obj.targetPort !== undefined &&
    obj.targetPort !== null &&
    routeTargetPort(route, c) !== String(obj.targetPort)
  ) {
    return false;
  }
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
  routes = routes.filter((route) => routeMatches(route, obj, c));
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
    // `certificate: true` (1.16.0): the Route serves its own certificate — a PEM
    // in spec.tls.certificate or an externalCertificate Secret reference — not
    // the router's default wildcard certificate.
    if (obj.certificate === true) {
      const pem = /-----BEGIN CERTIFICATE-----/.test(String(tls.certificate || ''));
      if (!pem && !tls.externalCertificate?.name) return false;
    }
    return true;
  });
  return bool(matching.length > 0);
}

/**
 * Does a Build belong to BuildConfig `name`? The build controller stamps the
 * `buildconfig` / `openshift.io/build-config.name` labels and annotation, the
 * owner reference and `status.config`; a build is also named `<config>-<n>`.
 */
function buildBelongsToConfig(build, name) {
  if (!name) return true;
  const labels = resourceLabels(build);
  if (
    labels.buildconfig === name ||
    labels['openshift.io/build-config.name'] === name ||
    labels['buildconfig.openshift.io/name'] === name
  ) {
    return true;
  }
  if (build?.metadata?.annotations?.['openshift.io/build-config.name'] === name) return true;
  if (resourceStatus(build).config?.name === name) return true;
  if (
    asArray(build?.metadata?.ownerReferences).some(
      (owner) => owner?.kind === 'BuildConfig' && owner?.name === name
    )
  ) {
    return true;
  }
  return new RegExp(`^${escapeRegex(name)}-\\d+$`).test(resourceName(build));
}

/**
 * "A Build … reaches phase Complete" (1.16.0): only a Build object whose
 * `status.phase` is Complete counts. The old fallback — a BuildConfig with
 * `status.lastVersion > 0` — ticked the moment `oc new-app` or `oc start-build`
 * CREATED the build, while `oc get builds` still said New/Running (L9, L20).
 */
function evaluateBuild(obj, c) {
  let builds = listKind(c.clusterState, 'Build');
  const buildNamespace = objectiveResourceNamespace(c, obj, 'Build');
  if (buildNamespace)
    builds = builds.filter((build) => resourceNamespace(build) === buildNamespace);
  if (obj.name) {
    builds = builds.filter(
      (build) => resourceName(build) === obj.name || buildBelongsToConfig(build, obj.name)
    );
  }
  const complete = builds.filter((build) => resourceStatus(build).phase === 'Complete');
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
  const succeeded = matching.filter((subscription) => {
    const status = resourceStatus(subscription);
    // Fast path: the Subscription itself reports Succeeded.
    if (status.phase === 'Succeeded') return true;
    // Real OLM (#53D): once a channel upgrade is resolved the Subscription
    // reports state/phase UpgradePending even though the PREVIOUSLY installed
    // CSV keeps running — the operator IS installed. Count it when
    // status.installedCSV names a Succeeded CSV in the same namespace, so the
    // "install the operator" objective stays observable for a pinned Manual
    // install (L18) whose upgrade plan is still waiting for approval.
    const installedCSV = String(status.installedCSV || '');
    if (!installedCSV) return false;
    return listKind(c.clusterState, 'ClusterServiceVersion').some(
      (csv) =>
        resourceName(csv) === installedCSV &&
        resourceNamespace(csv) === resourceNamespace(subscription) &&
        resourceStatus(csv).phase === 'Succeeded'
    );
  }).length;
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
  // An uninstall is "delete the Subscription AND its CSV" (1.16.0): deleting the
  // Subscription alone leaves the operator installed and running (L18, lab 10).
  // Remember every CSV the matched Subscriptions installed while they existed,
  // so the CSV is still recognised once its Subscription is gone (lab 10's
  // `aap-operator.v2.6.0` does not even contain the package name).
  const remembered = obj._installedCsvs instanceof Map ? obj._installedCsvs : new Map();
  obj._installedCsvs = remembered;
  for (const subscription of matching) {
    const status = resourceStatus(subscription);
    const namespace = resourceNamespace(subscription);
    for (const csvName of [status.installedCSV, status.currentCSV]) {
      if (csvName) remembered.set(`${namespace}/${csvName}`, { namespace, name: String(csvName) });
    }
  }
  const installNamespaces = new Set([...remembered.values()].map((entry) => entry.namespace));
  if (namespaceFilter) installNamespaces.add(namespaceFilter);
  const leftoverCsvs = listKind(c.clusterState, 'ClusterServiceVersion').filter((csv) => {
    if (resourceLabels(csv)['olm.copiedFrom']) return false; // OLM's copies follow the source
    const namespace = resourceNamespace(csv);
    if (remembered.has(`${namespace}/${resourceName(csv)}`)) return true;
    if (installNamespaces.size > 0 && !installNamespaces.has(namespace)) return false;
    if (!wanted) return false;
    const packageLabel = String(resourceLabels(csv)['olm.package'] || '').toLowerCase();
    return resourceName(csv).toLowerCase().includes(wanted) || packageLabel.includes(wanted);
  });
  const target = Math.max(1, asNumber(obj.count, 1));
  const levelContext = Boolean(c.levelDef);
  const done =
    matching.length === 0 &&
    leftoverCsvs.length === 0 &&
    (!levelContext || obj._sawInstalled === true);
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

/**
 * Can `subject` USE the SCC under the simulator's full 4.x RBAC model? Unlike
 * `sccGrantedTo` (which looks for a binding whose roleRef is the synthetic
 * `system:openshift:scc:<name>` ClusterRole), this follows exactly what
 * `oc auth can-i use scc/<name>` evaluates: any Role/Binding rule set that
 * grants `use` on that SCC counts — including a hand-written Role with
 * `apiGroups: [security.openshift.io]`/`resources: [securitycontextconstraints]`
 * (issue #71). Grading the grant's effect, not the object shape, is the same
 * state contract IncidentEngine uses to heal SCCForbidden.
 */
function sccUsableBySubject(c, sccName, subject, namespace = '') {
  const cluster = c.clusterState;
  try {
    if (cluster && typeof cluster.getSCCsForSubject === 'function') {
      const grants = asArray(cluster.getSCCsForSubject(subject, namespace || ''));
      if (
        grants.some((entry) =>
          typeof entry === 'string'
            ? entry === String(sccName)
            : resourceName(entry) === String(sccName)
        )
      ) {
        return true;
      }
    }
  } catch {
    /* fall through to can-i */
  }
  const engine = c.gameEngine;
  try {
    if (engine && typeof engine.canI === 'function') {
      const check = engine.canI('use', `scc/${sccName}`, namespace || undefined, subject);
      if (check?.allowed === true) return true;
    } else if (cluster && typeof cluster.canI === 'function') {
      const check = cluster.canI(subject, 'use', `scc/${sccName}`, namespace || '');
      if (check?.allowed === true) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function evaluateScc(obj, c) {
  const name = obj.scc || obj.name || obj.sccName;
  if (!name) return bool(false);
  const scc = findResource(c.clusterState, 'SecurityContextConstraints', name);
  if (!scc) return bool(false);
  let subject = obj.subject;
  const namespace = obj.namespace || levelProjectNamespace(c) || '';
  // A `*` project wildcard in the level data means "this lab's project", not
  // "any project in the cluster": `system:serviceaccount:*:default` must match
  // the level's seeded Project (e.g. privileged-lab), not the default project.
  if (subject && String(subject).includes('*')) {
    if (namespace) subject = String(subject).split('*').join(namespace);
  }
  const expected = obj.expected !== false;
  const state = sccGrantState(c, name);
  const present = subject
    ? sccGrantedTo(c, name, subject) || sccUsableBySubject(c, name, subject, namespace)
    : state.kind === 'binding'
      ? asArray(state.subjects).length > 0
      : asArray(state.legacy?.users).length > 0 || asArray(state.legacy?.groups).length > 0;
  // "Grant the SCC to the DEDICATED ServiceAccount" (1.16.0): a grant that also
  // reaches the project's other ServiceAccounts — `add-scc-to-group privileged
  // system:serviceaccounts:<ns>`, `-z default`, a cluster-wide group — is
  // over-broad and must not tick (L17, lab 8). Meant for SCCs no lab
  // ServiceAccount holds by default (privileged, anyuid, …); no first-look
  // baseline, since the first evaluation can come after the player's grant.
  if (present && expected && obj.exclusive === true) {
    if (sccOverBroadSubjects(c, name, subject, namespace).length > 0) return bool(false);
  }
  return bool(present === expected);
}

/**
 * ServiceAccounts OTHER than `subject` in the objective's project that can use
 * the SCC: the project's `default` ServiceAccount and a synthetic one (which
 * only a namespace-wide or cluster-wide grant can reach).
 * @returns {string[]} the over-broad probe subjects that can use the SCC
 */
function sccOverBroadSubjects(c, sccName, subject, namespace) {
  if (!namespace) return [];
  const probes = [
    `system:serviceaccount:${namespace}:default`,
    `system:serviceaccount:${namespace}:osg-scc-probe`,
  ].filter((probe) => probe !== String(subject || ''));
  return probes.filter(
    (probe) => sccGrantedTo(c, sccName, probe) || sccUsableBySubject(c, sccName, probe, namespace)
  );
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
  const wantedServiceAccount = obj.serviceAccount ? String(obj.serviceAccount) : '';
  const pods = listKind(c.clusterState, 'Pod').filter((pod) => {
    if (privilegedNamespace && resourceNamespace(pod) !== privilegedNamespace) return false;
    // "Run the privileged workload AS priv-sa" (#71): a privileged Pod admitted
    // for another (e.g. the project default) ServiceAccount is a different
    // security posture and must not satisfy the level.
    if (wantedServiceAccount) {
      const podServiceAccount = String(resourceSpec(pod).serviceAccountName || 'default');
      if (podServiceAccount !== wantedServiceAccount) return false;
    }
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
    // The API server/kubelet injects a projected `kube-api-access-*` volume
    // into every Pod (ServiceAccount token + kube-root-ca.crt + service CA).
    // It is platform infrastructure, not a learner-mounted ConfigMap, and it
    // used to tick "Mount a ConfigMap into a workload volume" at level start
    // (issue #75).
    if (/^kube-api-access-/.test(String(volume.name || ''))) return false;
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
  // Grade the level's own project only: cluster-wide platform workloads (e.g.
  // the router's projected volumes) must not satisfy a workload objective.
  const namespace = obj.namespace || levelProjectNamespace(c) || '';
  let workloads = listKinds(c.clusterState, targetKinds);
  if (namespace)
    workloads = workloads.filter((workload) => resourceNamespace(workload) === namespace);
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
  const namespace = obj.namespace || levelProjectNamespace(c) || '';
  let workloads = listKinds(c.clusterState, targetKinds);
  if (namespace)
    workloads = workloads.filter((workload) => resourceNamespace(workload) === namespace);
  const name = obj.name || obj.resourceName;
  const using = workloads.filter((workload) => envReferences(workload, kind, name)).length;
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(using >= target, Math.min(using, target), target);
}

/**
 * ConfigMaps that carry at least one key matching the sensitive-key pattern
 * (password, token, key, …), with the offending keys. Shared by the
 * `noConfigMap` grader and by its failure note so both always agree.
 *
 * @param {object} c resolved evaluation context
 * @param {RegExp} [pattern] stateless (no `g`/`y` flag) key matcher
 * @returns {Array<{configMap: object, keys: string[]}>}
 */
function sensitiveConfigMapLeaks(c, pattern = SENSITIVE_CONFIGMAP_KEY) {
  const leaks = [];
  for (const configMap of listKind(c.clusterState, 'ConfigMap')) {
    const data = resourceSpec(configMap).data;
    if (!data || typeof data !== 'object') continue;
    const keys = Object.keys(data).filter((key) => pattern.test(key));
    if (keys.length > 0) leaks.push({ configMap, keys });
  }
  return leaks;
}

function evaluateNoConfigMap(obj, c) {
  const sensitivePattern = obj.sensitive === false ? null : SENSITIVE_CONFIGMAP_KEY;
  if (!sensitivePattern) return bool(true);
  const leaks = sensitiveConfigMapLeaks(c, sensitivePattern);
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

/**
 * ReplicaSets a Deployment owns, OLDEST FIRST: ClusterState keeps owner
 * relationships in creation order (a rollback re-activates an old ReplicaSet
 * without re-creating it); the owner-reference scan sorts by creation time.
 */
function ownedReplicaSets(c, deployment) {
  const uid = deployment?.uid || deployment?.metadata?.uid;
  try {
    if (uid && typeof c.clusterState?.getChildren === 'function') {
      const children = asArray(c.clusterState.getChildren(uid)).filter(
        (child) => child?.kind === 'ReplicaSet'
      );
      if (children.length > 0) return children;
    }
  } catch {
    /* fall back to a scan */
  }
  const name = resourceName(deployment);
  const namespace = resourceNamespace(deployment);
  return listKind(c.clusterState, 'ReplicaSet')
    .filter((rs) => {
      if (resourceNamespace(rs) !== namespace) return false;
      if (
        asArray(rs?.metadata?.ownerReferences).some(
          (owner) => owner?.kind === 'Deployment' && owner?.name === name
        )
      ) {
        return true;
      }
      const hash = replicaSetHash(rs);
      return Boolean(hash) && resourceName(rs) === `${name}-${hash}`;
    })
    .sort((left, right) =>
      String(left?.metadata?.creationTimestamp || '').localeCompare(
        String(right?.metadata?.creationTimestamp || '')
      )
    );
}

function replicaSetHash(rs) {
  return String(resourceLabels(rs)['pod-template-hash'] || '');
}

/** The `pod-template-hash` the Deployment controller derives from the current template. */
function deploymentTemplateHash(deployment) {
  try {
    return templateHash(resourceSpec(deployment).template || {});
  } catch {
    return '';
  }
}

/** Workloads an update/rollback/availability objective is about. */
function rolloutWorkloads(obj, c, fallbackKinds) {
  const kinds = resolveTargetKinds(obj, fallbackKinds);
  let workloads = listKinds(c.clusterState, kinds);
  if (obj.name) workloads = workloads.filter((workload) => resourceName(workload) === obj.name);
  const namespace = objectiveResourceNamespace(c, obj, kinds[0]);
  if (namespace)
    workloads = workloads.filter((workload) => resourceNamespace(workload) === namespace);
  return workloads;
}

/**
 * A rolling update is a change of the POD TEMPLATE (1.16.0). A generation bump
 * alone is not one: scaling bumps it, and so did a no-op `oc rollout undo` on a
 * single revision, which used to tick L10's "update" AND "rollback" with one
 * command. A Deployment's evidence is its own history, not a first-look
 * baseline (the first evaluation can come late — the level intro pauses the
 * mode — after the player's first command): the seeded Deployment owns ONE
 * ReplicaSet, and an update rolls out a template with another hash (which a
 * later rollback does not erase). Other workload kinds compare the template
 * hash with the one first seen.
 */
function evaluateUpdate(obj, c) {
  const workloads = rolloutWorkloads(obj, c, ['Deployment', 'StatefulSet', 'DaemonSet']);
  const target = Math.max(1, asNumber(obj.count, 1));
  if (workloads.length === 0) return result(false, 0, target);
  const baseline = ensureBaseline(obj, () => ({ entries: {} }));
  const latched = new Set(asArray(obj._updatedLatch));
  for (const workload of workloads) {
    const id = workload?.uid || resourceName(workload);
    const currentHash = deploymentTemplateHash(workload);
    let changed = false;
    if (workload.kind === 'Deployment') {
      const sets = ownedReplicaSets(c, workload);
      const hashes = new Set(sets.map(replicaSetHash).filter(Boolean));
      const firstHash = sets.length > 0 ? replicaSetHash(sets[0]) : '';
      changed = hashes.size >= 2 || (Boolean(firstHash) && currentHash !== firstHash);
    } else {
      if (!hasOwn(baseline.entries, id)) baseline.entries[id] = { hash: currentHash };
      changed = currentHash !== baseline.entries[id].hash;
    }
    if (changed) latched.add(id);
  }
  obj._updatedLatch = [...latched];
  const updated = workloads.filter((workload) =>
    latched.has(workload?.uid || resourceName(workload))
  ).length;
  return result(updated >= target, Math.min(updated, target), target);
}

/**
 * "Roll the Deployment back with oc rollout undo" (1.16.0): `oc rollout undo`
 * was used AND the Deployment really runs an earlier revision again — the
 * ReplicaSet matching its current template is OLDER than a ReplicaSet it rolled
 * out later (the controller re-activates the old ReplicaSet). A no-op undo on a
 * single revision, or an undo that brought the bad template back, does not count.
 */
function evaluateRollback(obj, c) {
  const count = asNumber(c.clusterState?._rollbackCount, 0);
  const target = Math.max(1, asNumber(obj.count, 1));
  const deployments = rolloutWorkloads({ ...obj, kind: 'Deployment' }, c, ['Deployment']);
  const rolledBack = deployments.some((deployment) => {
    const sets = ownedReplicaSets(c, deployment);
    const currentHash = deploymentTemplateHash(deployment);
    const activeIndex = sets.findIndex((rs) => replicaSetHash(rs) === currentHash);
    if (activeIndex < 0) return false;
    return sets.some((rs, index) => index > activeIndex && replicaSetHash(rs) !== currentHash);
  });
  const done = rolledBack && count >= target;
  return result(done, done ? target : Math.min(count, target - 1), target);
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

/**
 * Availability of the named workload(s), in percent of the replicas they
 * served when first seen (1.16.0). Scaling to 0 or deleting the Deployment is
 * 0 %; a rolling update that keeps the old Pods serving stays at 100 %.
 */
function workloadAvailabilityPercent(obj, c) {
  const workloads = rolloutWorkloads(obj, c, ['Deployment']);
  const baseline = ensureBaseline(obj, () => ({ desired: {} }));
  // The replicas the level seeded win over a first look: the first evaluation
  // can come after the player already scaled the workload down.
  const seeded = (workload) =>
    asNumber(
      asArray(c.levelDef?.startingResources).find(
        (resource) => resource?.kind === workload.kind && resource?.name === resourceName(workload)
      )?.spec?.replicas,
      0
    );
  for (const workload of workloads) {
    const name = `${resourceNamespace(workload)}/${resourceName(workload)}`;
    if (!hasOwn(baseline.desired, name)) {
      baseline.desired[name] = Math.max(
        1,
        seeded(workload),
        asNumber(resourceSpec(workload).replicas, 1)
      );
    }
  }
  const names = Object.keys(baseline.desired);
  if (names.length === 0) return 0;
  let desired = 0;
  let available = 0;
  for (const name of names) {
    const wanted = asNumber(baseline.desired[name], 1);
    const workload = workloads.find(
      (candidate) => `${resourceNamespace(candidate)}/${resourceName(candidate)}` === name
    );
    const status = resourceStatus(workload);
    desired += wanted;
    available += Math.min(wanted, asNumber(status.availableReplicas ?? status.numberAvailable, 0));
  }
  return desired > 0 ? Math.round((available / desired) * 100) : 0;
}

function evaluateUptime(obj, c) {
  const percentage = asNumber(obj.percentage, 90);
  // `kind`/`name` (1.16.0): "keep availability during the rollout" is the
  // workload's own availability. L10 has no incident, so the incident-health
  // reading below stayed at 100 % even with the Deployment scaled to 0.
  if (obj.name || obj.kind) {
    const availability = workloadAvailabilityPercent(obj, c);
    return result(availability >= percentage, availability, percentage);
  }
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

// ─── node maintenance state (1.16.0) ───────────────────────────────────────
//
// Campaign "Nodes & Cluster Troubleshooting" grades what `oc adm cordon|drain|
// uncordon` leave behind, not the typed lines:
//   { type: 'node', name, ready?, schedulable?, drained?, workloadsAvailable? }
//   ready: true|false        the kubelet-posted Ready condition is (not) True
//   schedulable: true|false  the node is not cordoned (`spec.unschedulable`) / is
//   drained: true            during this run the node was seen cordoned with no
//                            Pod left on it that a drain evicts (DaemonSet and
//                            mirror Pods stay; finished or terminating Pods do
//                            not count). This one fact is a LATCH, so the end
//                            of a maintenance window (uncordon) keeps it. It
//                            lives on the per-run objective (progress) object and
//                            is tied to the Node's uid, so a level start resets it.
//   workloadsAvailable: true every Deployment of the objective's `namespace` (or
//                            the level's lab project) serves all its replicas.

/** Does `pod` still sit on its node in a way `oc adm drain` would evict? */
function podBlocksDrain(pod) {
  if (!pod) return false;
  const metadata = pod.metadata || {};
  if (asArray(metadata.ownerReferences).some((reference) => reference?.kind === 'DaemonSet'))
    return false;
  // Static (mirror) Pods belong to the kubelet; drain never evicts them.
  if (hasOwn(metadata.annotations, 'kubernetes.io/config.mirror')) return false;
  if (metadata.deletionTimestamp || pod.isDeleting === true) return false;
  const phase = resourceStatus(pod).phase;
  return phase !== 'Succeeded' && phase !== 'Failed';
}

function nodeIsReady(node) {
  if (!node || resourceStatus(node).phase === 'NotReady') return false;
  try {
    if (typeof node.isConditionTrue === 'function') return Boolean(node.isConditionTrue('Ready'));
  } catch {
    /* fall through to the raw conditions */
  }
  const ready = asArray(resourceStatus(node).conditions).find(
    (condition) => condition?.type === 'Ready'
  );
  return String(ready?.status) === 'True';
}

/** Deployments of `namespace` that do not serve all their replicas. */
function unavailableDeployments(c, namespace) {
  if (!namespace) return [];
  return listKind(c.clusterState, 'Deployment').filter((deployment) => {
    if (resourceNamespace(deployment) !== namespace) return false;
    const desired = asNumber(resourceSpec(deployment).replicas, 1);
    return asNumber(resourceStatus(deployment).availableReplicas, 0) < desired;
  });
}

/** Pods on `nodeName` that a drain would still evict. */
function podsBlockingDrain(c, nodeName) {
  return listKind(c.clusterState, 'Pod').filter(
    (pod) => resourceSpec(pod).nodeName === nodeName && podBlocksDrain(pod)
  );
}

/** Node state for `node` objectives; updates the run's `drained` latch. */
function nodeObjectiveState(obj, c) {
  const name = String(obj.name || obj.node || '');
  const node = name ? findResource(c.clusterState, 'Node', name) : null;
  if (!node) return null;
  const cordoned = resourceSpec(node).unschedulable === true;
  const nodeId = node.uid || node.metadata?.uid || name;
  const baseline = ensureBaseline(obj, () => ({ nodeId, drainedSeen: false }));
  if (baseline.nodeId !== nodeId) {
    baseline.nodeId = nodeId;
    baseline.drainedSeen = false;
  }
  const blocking = podsBlockingDrain(c, name);
  if (cordoned && blocking.length === 0) baseline.drainedSeen = true;
  const namespace = obj.namespace || levelProjectNamespace(c);
  return {
    name,
    cordoned,
    ready: nodeIsReady(node),
    blocking,
    drainedSeen: baseline.drainedSeen === true,
    namespace,
    unavailable: obj.workloadsAvailable === true ? unavailableDeployments(c, namespace) : [],
  };
}

function evaluateNode(obj, c) {
  const state = nodeObjectiveState(obj, c);
  if (!state) return bool(false);
  const checks = [];
  if (obj.drained === true) checks.push(state.drainedSeen);
  if (typeof obj.ready === 'boolean') checks.push(state.ready === obj.ready);
  if (typeof obj.schedulable === 'boolean') checks.push(!state.cordoned === obj.schedulable);
  if (obj.workloadsAvailable === true) checks.push(state.unavailable.length === 0);
  return bool(checks.every(Boolean));
}

function evaluateCommand(obj, c) {
  const pattern = obj.pattern;
  if (!pattern) return bool(false);
  let matches = matchCommands(c, pattern, { successOnly: obj.mustSucceed !== false });
  if (obj.inspect === true) {
    const regex = compilePattern(pattern);
    const namespace = commandObjectiveNamespace(obj, c);
    const outputRegex = compilePattern(obj.outputPattern);
    matches = matches.filter((entry) => inspectionCounts(entry, regex, namespace, outputRegex, c));
  }
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(matches.length >= target, Math.min(matches.length, target), target);
}

/**
 * Composite drill score: 60 % objectives, 20 % cluster health, 20 % Advisor.
 * It is the capstone's FINAL gate (1.16.0): with free health and Advisor points
 * it used to tick after ~14 of 18 objectives, i.e. while four were still open
 * and before the scheduled incidents had even fired. It now completes only
 * once every other objective is done and the composite reaches `minScore`;
 * the composite itself is still reported as progress.
 */
function evaluateExamScore(obj, c) {
  const minScore = asNumber(obj.minScore, 75);
  const objectivePercent = objectivesCompletionPercent(c, new Set(['examscore'])) ?? 0;
  const health = clusterHealthPercent(c);
  const architecture = obj.namespace
    ? projectArchitectureTotal(c, obj.namespace)
    : architectureTotal(c);
  const composite = Math.round(objectivePercent * 0.6 + health * 0.2 + architecture * 0.2);
  const othersDone = objectivePercent >= 100;
  return result(othersDone && composite >= minScore, composite, minScore);
}

function evaluateArchitectureScore(obj, c) {
  const minScore = asNumber(obj.minScore, 75);
  // `namespace` (1.16.0): rate the player's own project, not the platform.
  const total = Math.round(
    obj.namespace ? projectArchitectureTotal(c, obj.namespace) : architectureTotal(c)
  );
  return result(total >= minScore, total, minScore);
}

/**
 * `project.config.openshift.io/cluster` points new projects at a
 * project-request Template that exists in openshift-config (1.16.0). L15 used
 * to grade `oc (edit|patch) project.config` typed text: it ticked on an `oc edit`
 * that saved nothing and never on `oc apply -f` reaching the same state.
 */
function evaluateProjectRequestTemplate(obj, c) {
  const cluster = c.clusterState;
  let config = null;
  try {
    config = typeof cluster?.getProjectConfig === 'function' ? cluster.getProjectConfig() : null;
  } catch {
    config = null;
  }
  const name = String(config?.spec?.projectRequestTemplate?.name || '');
  if (!name) return bool(false);
  if (obj.name && name !== String(obj.name)) return bool(false);
  const templateNamespace = obj.namespace || 'openshift-config';
  return bool(Boolean(findResource(cluster, 'Template', name, templateNamespace)));
}

// ─── Linux workstation objectives (linux-engine, 1.16.0) ────────────────────
//
// Pure reads of the LinuxHost model (js/engine/LinuxHost.js): grading follows the state
// of the simulated RHEL 9 workstation, never typed text — `ran` reads the host's own
// executed-command log (resolved paths + cwd), not the raw history.

function linuxHostOf(c) {
  return c?.raw?.linuxHost || c?.gameEngine?.linuxHost || currentWindow()?.game?.linuxHost || null;
}

/** `u+x` / `go+w` / `a+r` → permission mask. */
function linuxPermBits(spec) {
  const match = String(spec || '').match(/^([ugoa]*)[+=]?([rwxst]+)$/);
  if (!match) return 0;
  const who = match[1] || 'a';
  let bits = 0;
  for (const target of who.includes('a') ? 'ugo' : who) {
    const shift = { u: 6, g: 3, o: 0 }[target];
    for (const perm of match[2]) {
      if (perm === 's') bits |= target === 'u' ? 0o4000 : target === 'g' ? 0o2000 : 0;
      else if (perm === 't') bits |= 0o1000;
      else bits |= { r: 4, w: 2, x: 1 }[perm] << shift;
    }
  }
  return bits;
}

function linuxRegexList(value) {
  return (Array.isArray(value) ? value : [value])
    .filter((entry) => entry !== undefined && entry !== null)
    .map((entry) => {
      try {
        return new RegExp(String(entry), 'm');
      } catch {
        return new RegExp(String(entry).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm');
      }
    });
}

function linuxYamlValue(document, path) {
  return String(path)
    .split('.')
    .reduce(
      (value, key) => (value === undefined || value === null ? undefined : value[key]),
      document
    );
}

/** One `file` check: existence, type, mode bits, owner, context and content. */
function linuxFileHolds(host, spec) {
  if (!spec || !spec.path) return false;
  const info = host.fileInfo(spec.path);
  if (spec.absent === true || spec.exists === false) return !info.exists;
  if (!info.exists) return false;
  const kind = spec.fileType || (spec.isDirectory ? 'dir' : spec.isFile ? 'file' : null);
  if (kind && info.type !== (kind === 'directory' ? 'dir' : kind)) return false;
  if (spec.isSymlink === true && !info.isSymlink) return false;
  if (spec.mode !== undefined) {
    const wanted =
      typeof spec.mode === 'number' ? spec.mode : Number.parseInt(String(spec.mode), 8);
    if ((info.mode & 0o7777) !== wanted) return false;
  }
  const setBits = linuxPermBits(spec.perm ?? spec.modeSet);
  if (setBits && (info.mode & setBits) !== setBits) return false;
  const clearBits = linuxPermBits(spec.notPerm ?? spec.modeClear);
  if (clearBits && info.mode & clearBits) return false;
  if (spec.owner && info.owner !== spec.owner) return false;
  if (spec.group && info.group !== spec.group) return false;
  if (spec.context) {
    const wanted = String(spec.context);
    const actual = String(info.context || '');
    if (wanted.includes(':') ? actual !== wanted : actual.split(':')[2] !== wanted) return false;
  }
  const needsContent = [
    'contains',
    'matches',
    'notContains',
    'notMatches',
    'equals',
    'lines',
    'lineSet',
    'sameContentAs',
    'yaml',
  ].some((key) => spec[key] !== undefined);
  if (!needsContent) return true;
  if (info.type !== 'file' || typeof info.content !== 'string') return false;
  const content = info.content;
  for (const regex of linuxRegexList(spec.contains ?? spec.matches))
    if (!regex.test(content)) return false;
  for (const regex of linuxRegexList(spec.notContains ?? spec.notMatches))
    if (regex.test(content)) return false;
  if (spec.equals !== undefined) {
    const wanted = String(spec.equals);
    if (content !== wanted && content !== `${wanted}\n` && `${content}\n` !== wanted) return false;
  }
  const bodyLines = content.replace(/\n$/, '').split('\n');
  if (Array.isArray(spec.lines)) {
    if (bodyLines.length !== spec.lines.length) return false;
    if (spec.lines.some((line, index) => String(line) !== bodyLines[index])) return false;
  }
  if (Array.isArray(spec.lineSet)) {
    const seen = bodyLines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\d+\s+/, ''))
      .sort();
    const wanted = spec.lineSet.map((line) => String(line).trim()).sort();
    if (seen.length !== wanted.length || seen.some((line, index) => line !== wanted[index]))
      return false;
  }
  if (spec.sameContentAs) {
    const other = host.fileInfo(spec.sameContentAs);
    if (!other.exists || other.content !== content) return false;
  }
  if (spec.yaml && typeof spec.yaml === 'object') {
    let documents;
    try {
      documents = parseYaml(content);
    } catch {
      return false;
    }
    const document = Array.isArray(documents) ? documents[0] : documents;
    if (!document || typeof document !== 'object') return false;
    for (const [path, value] of Object.entries(spec.yaml)) {
      const actual = linuxYamlValue(document, path);
      if (actual === undefined || String(actual) !== String(value)) return false;
    }
  }
  return true;
}

function evaluateLinuxFile(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const checks = Array.isArray(obj.all) && obj.all.length ? obj.all : [obj];
  return bool(checks.every((spec) => linuxFileHolds(host, spec)));
}

function evaluateLinuxService(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const state = host.serviceState(obj.name || obj.unit || '');
  const checks = [];
  if (typeof obj.active === 'boolean') checks.push(state.active === obj.active);
  if (typeof obj.enabled === 'boolean') checks.push(state.enabled === obj.enabled);
  if (typeof obj.failed === 'boolean') checks.push(state.failed === obj.failed);
  if (!checks.length) checks.push(state.active);
  return bool(checks.every(Boolean));
}

function evaluateLinuxProcess(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const full = obj.match !== undefined || obj.command !== undefined;
  const running =
    obj.pid !== undefined
      ? host.processRunning(null, { pid: obj.pid })
      : host.processRunning(String(obj.match ?? obj.command ?? obj.name ?? ''), {
          full,
          user: obj.user,
        });
  return bool(obj.running === false ? !running : running);
}

function evaluateLinuxPackage(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const installed = host.packageInstalled(obj.name);
  return bool(obj.installed === false ? !installed : installed);
}

function evaluateLinuxFirewall(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const state = host.firewallHas({ service: obj.service, port: obj.port, zone: obj.zone });
  const present = obj.present !== false;
  const scopes = [];
  if (obj.runtime !== undefined) scopes.push(['runtime', obj.runtime]);
  if (obj.permanent !== undefined) scopes.push(['permanent', obj.permanent]);
  if (!scopes.length) scopes.push(['runtime', true]);
  return bool(scopes.every(([scope, wanted]) => (wanted ? state[scope] === present : true)));
}

function evaluateLinuxContainer(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const info = host.containerInfo(obj.name, { user: obj.user || 'student' });
  if (obj.exists === false) return bool(!info.exists);
  if (!info.exists) return bool(false);
  if (typeof obj.running === 'boolean' && info.running !== obj.running) return bool(false);
  if (obj.state && info.state !== obj.state) return bool(false);
  if (obj.image) {
    const regex = linuxRegexList(obj.image)[0];
    if (!regex.test(info.image) && !info.image.includes(String(obj.image))) return bool(false);
  }
  const publish = obj.publish ?? obj.port;
  if (publish) {
    const parts = String(publish).split(':');
    const wanted =
      parts.length >= 2
        ? `${parts[parts.length - 2]}:${parts[parts.length - 1]}`
        : `${parts[0]}:${parts[0]}`;
    if (!info.ports.includes(wanted.replace(/\/tcp$/, ''))) return bool(false);
  }
  if (obj.env && typeof obj.env === 'object') {
    for (const [key, value] of Object.entries(obj.env))
      if (info.env[key] !== String(value)) return bool(false);
  }
  return bool(true);
}

function evaluateLinuxSelinux(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const checks = [];
  if (obj.mode) checks.push(host.selinux.mode === String(obj.mode).toLowerCase());
  if (obj.configMode)
    checks.push(host.selinuxConfigMode() === String(obj.configMode).toLowerCase());
  if (obj.port) {
    const [number, proto = 'tcp'] = String(obj.port).split('/');
    checks.push(host.portType(proto, Number(number)) === (obj.type || 'http_port_t'));
  }
  return bool(checks.length > 0 && checks.every(Boolean));
}

function evaluateLinuxUser(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const user = host.users.get(String(obj.name || ''));
  if (obj.exists === false) return bool(!user);
  if (!user) return bool(false);
  if (obj.uid !== undefined && user.uid !== Number(obj.uid)) return bool(false);
  if (obj.shell && user.shell !== obj.shell) return bool(false);
  if (obj.home && user.home !== obj.home) return bool(false);
  const groups = host.groupsOf(user.name);
  for (const group of asArray(obj.groups)) if (!groups.includes(group)) return bool(false);
  if (obj.locked !== undefined) {
    const locked = String(host.shadow.get(user.name)?.hash || '').startsWith('!');
    if (locked !== Boolean(obj.locked)) return bool(false);
  }
  return bool(true);
}

function evaluateLinuxCwd(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  return bool(host.session.cwd === host.resolvePath(String(obj.path || '~')));
}

function evaluateLinuxEnv(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const entry = host.envVar(String(obj.name || ''));
  if (!entry) return bool(false);
  if (obj.value !== undefined && entry.value !== String(obj.value)) return bool(false);
  if (obj.exported === true && !entry.exported) return bool(false);
  if (obj.exported === false && entry.exported) return bool(false);
  return bool(true);
}

/**
 * `ran`: a command was executed on the workstation — argv0 `command`, every short-option
 * letter of `flags` present, `args` regex, and (with `path`) a resolved path operand equal
 * to it or, with no operands, the working directory it ran in.
 */
function evaluateLinuxRan(obj, c) {
  const host = linuxHostOf(c);
  if (!host) return bool(false);
  const wantedPath = obj.path ? host.resolvePath(String(obj.path), { cwd: '/home/student' }) : null;
  const argsRegex = obj.args ? linuxRegexList(obj.args)[0] : null;
  const matches = asArray(host.execLog).filter((entry) => {
    if (obj.command && entry.command !== obj.command) return false;
    if (obj.success !== 'any' && entry.success !== (obj.success !== false)) return false;
    if (typeof obj.sudo === 'boolean' && entry.sudo !== obj.sudo) return false;
    const argv = asArray(entry.argv).slice(1);
    if (obj.flags) {
      const letters = new Set(
        argv.filter((arg) => /^-[A-Za-z]/.test(arg)).flatMap((arg) => arg.slice(1).split(''))
      );
      if ([...String(obj.flags)].some((letter) => !letters.has(letter))) return false;
    }
    if (argsRegex && !argsRegex.test(argv.join(' '))) return false;
    if (wantedPath) {
      const operands = argv.filter((arg) => !arg.startsWith('-'));
      const hit =
        asArray(entry.paths).includes(wantedPath) ||
        (operands.length === 0 && entry.cwd === wantedPath);
      if (!hit) return false;
    }
    return true;
  });
  const target = Math.max(1, asNumber(obj.count, 1));
  return result(matches.length >= target, Math.min(matches.length, target), target);
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
    case 'projectrequesttemplate':
      return evaluateProjectRequestTemplate(obj, c);
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
    case 'node':
      return evaluateNode(obj, c);
    case 'command':
      return evaluateCommand(obj, c);
    // linux-engine (1.16.0): the RHEL workstation.
    case 'file':
      return evaluateLinuxFile(obj, c);
    case 'service':
      return evaluateLinuxService(obj, c);
    case 'process':
      return evaluateLinuxProcess(obj, c);
    case 'package':
      return evaluateLinuxPackage(obj, c);
    case 'firewall':
      return evaluateLinuxFirewall(obj, c);
    case 'container':
      return evaluateLinuxContainer(obj, c);
    case 'selinux':
      return evaluateLinuxSelinux(obj, c);
    case 'linuxuser':
      return evaluateLinuxUser(obj, c);
    case 'cwd':
      return evaluateLinuxCwd(obj, c);
    case 'env':
      return evaluateLinuxEnv(obj, c);
    case 'ran':
      return evaluateLinuxRan(obj, c);
    case 'examscore':
      return evaluateExamScore(obj, c);
    case 'architecturescore':
      return evaluateArchitectureScore(obj, c);
    default:
      return null;
  }
}

// ─── self-explaining objectives ────────────────────────────────────────────
//
// Grading is deliberately project-scoped (issue #30), which means a player who
// follows the objective labels but forgets `oc project <lab>` sees a resource
// in `oc get` and an objective that silently refuses to tick. An unticked
// objective therefore carries a `note` that says why, computed from the same
// helpers the graders use. Notes never change what ticks; they only explain.

/**
 * Objective types whose `name` is one namespaced resource that the evaluator
 * only accepts inside `objectiveResourceNamespace()`. The value is the kind
 * used when the objective carries no `kind` of its own (`null`: `kind` is
 * required). Types that are NOT project-scoped by this helper (`update`,
 * `resources`, `mount`, `quota`, …) are deliberately absent: a "this level
 * checks project X" note for them could be false.
 */
const NAMED_RESOURCE_DEFAULT_KIND = new Map([
  ['deploy', null],
  ['label', null],
  ['scale', 'Deployment'],
  ['image', 'Deployment'],
  ['complete', 'Job'],
]);

/** Types without a `kind` field whose `name` is always one resource of a fixed kind. */
const NAMED_RESOURCE_FIXED_KIND = new Map([
  ['route', 'Route'],
  ['routeaccess', 'Route'],
  ['imagestream', 'ImageStream'],
  ['cronjob', 'CronJob'],
  ['build', 'BuildConfig'],
]);

/** Kind/name of the single namespaced resource an objective is about, or null. */
function namedResourceOf(objective, type) {
  const name = typeof objective.name === 'string' ? objective.name : '';
  if (!name) return null;
  if (NAMED_RESOURCE_FIXED_KIND.has(type)) {
    return { kind: NAMED_RESOURCE_FIXED_KIND.get(type), name };
  }
  if (!NAMED_RESOURCE_DEFAULT_KIND.has(type)) return null;
  const kind =
    typeof objective.kind === 'string' && objective.kind
      ? canonicalKind(objective.kind)
      : NAMED_RESOURCE_DEFAULT_KIND.get(type);
  return kind ? { kind, name } : null;
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`; more than `max` items end in `N more`. */
function quotedList(items, max) {
  const shown = items.slice(0, max).map((item) => `"${item}"`);
  const rest = items.length - shown.length;
  if (rest > 0) shown.push(`${rest} more`);
  if (shown.length < 2) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * `wrong-project` note: the objective's resource is missing from the project
 * this level grades, but a resource of that kind and name exists in another
 * project. Only emitted when the graded project exists, so `fix` is runnable.
 */
function explainWrongProject(objective, type, c) {
  const target = namedResourceOf(objective, type);
  if (!target || CLUSTER_SCOPED_KINDS.has(target.kind)) return null;
  const expected = objectiveResourceNamespace(c, objective, target.kind);
  if (!expected) return null;
  if (findResource(c.clusterState, target.kind, target.name, expected)) return null;
  const found = [
    ...new Set(
      listKind(c.clusterState, target.kind)
        .filter((resource) => resourceName(resource) === target.name)
        .map((resource) => resourceNamespace(resource))
        .filter((namespace) => namespace && namespace !== expected)
    ),
  ].sort();
  if (found.length === 0) return null;
  if (!findResource(c.clusterState, 'Project', expected)) return null;
  let text =
    `${target.kind} "${target.name}" exists in project${found.length > 1 ? 's' : ''} ` +
    `${quotedList(found, 3)}, but this objective is graded in project "${expected}".`;
  // Already in the graded project: switching is a no-op, the thing must be re-created here.
  if (getCurrentProject(c) === expected) {
    text += ` You are in "${expected}" now: create it again here.`;
  }
  return { code: 'wrong-project', text, fix: `oc project ${expected}`, found, expected };
}

/** `sensitive-configmap-key` note: names (up to two) ConfigMaps that fail `noConfigMap`. */
function explainSensitiveConfigMap(objective, c) {
  if (objective.sensitive === false) return null;
  const current = getCurrentProject(c);
  const leaks = sensitiveConfigMapLeaks(c)
    .map((leak) => ({ ...leak, namespace: resourceNamespace(leak.configMap) }))
    // The ConfigMaps in the player's own project are the ones they can act on first.
    .sort((a, b) => Number(b.namespace === current) - Number(a.namespace === current));
  if (leaks.length === 0) return null;
  const sentences = leaks.slice(0, 2).map(({ configMap, keys, namespace }) => {
    const where = namespace && namespace !== current ? ` in project "${namespace}"` : '';
    const noun = keys.length > 1 ? 'keys' : 'key';
    return `ConfigMap "${resourceName(configMap)}"${where} has the ${noun} ${quotedList(keys, 2)}.`;
  });
  const more = leaks.length - sentences.length;
  if (more > 0) {
    sentences.push(
      `${more} more ConfigMap${more === 1 ? '' : 's'} also ${more === 1 ? 'has' : 'have'} a sensitive key.`
    );
  }
  sentences.push('Passwords, tokens and keys belong in a Secret, not a ConfigMap.');
  return { code: 'sensitive-configmap-key', text: sentences.join(' ') };
}

/**
 * Ready-to-run `oc process <source> -p K=V … | oc apply -f -` for a `template`
 * objective (the parameters come from the objective itself).
 */
function templatePipeline(objective, source) {
  const params =
    objective.parameters && typeof objective.parameters === 'object' ? objective.parameters : {};
  const flags = Object.entries(params).map(([key, value]) => `-p ${key}=${value}`);
  return `oc process ${[source, ...flags].join(' ')} | oc apply -f -`;
}

/**
 * Notes for an unticked `template` objective. The Files panel's primary
 * "Apply -f" button on a Template file only STORES the Template, and
 * `oc process` alone only PRINTS the objects; neither ticks the objective, and
 * both look like success. Precedence: rendered-but-not-applied, then applied
 * with other parameters, then stored-but-not-processed.
 */
function explainTemplate(objective, c) {
  const wanted = String(objective.name || objective.template || '');
  if (!wanted) return null;
  const needle = wanted.toLowerCase();
  const records = appliedTemplates(manifestState(c))
    .filter((entry) => `${entry?.name || ''} ${entry?.path || ''}`.toLowerCase().includes(needle))
    .sort((a, b) => asNumber(b?.at, 0) - asNumber(a?.at, 0));
  const params =
    objective.parameters && typeof objective.parameters === 'object' ? objective.parameters : null;
  const namespace = objectiveResourceNamespace(c, objective, 'Template');
  const stored = namespace ? findResource(c.clusterState, 'Template', wanted, namespace) : null;
  const applied = records.filter((entry) => entry?.applied !== false);
  const rendered = records.find((entry) => entry?.applied === false);

  if (applied.length === 0 && rendered) {
    return {
      code: 'template-not-applied',
      text: `You rendered "${wanted}" with oc process, but nothing was created yet. Pipe the output into oc apply -f -.`,
      fix: templatePipeline(objective, stored ? wanted : `-f ${rendered.path}`),
    };
  }
  if (applied.length > 0 && params) {
    const latest = applied[0];
    const wrong = Object.entries(params).filter(
      ([key, value]) => !quantityMatches(latest?.params?.[key], value)
    );
    if (wrong.length > 0) {
      const used = wrong
        .map(([key]) => `${key}=${latest?.params?.[key] ?? '(not set)'}`)
        .join(', ');
      const needed = wrong.map(([key, value]) => `${key}=${value}`).join(', ');
      return {
        code: 'template-wrong-parameters',
        text: `"${wanted}" was applied with ${used}, but this objective needs ${needed}.`,
        fix: templatePipeline(objective, stored ? wanted : `-f ${latest.path}`),
      };
    }
  }
  if (applied.length === 0 && stored) {
    return {
      code: 'template-not-processed',
      text: `Template "${wanted}" is stored in project "${namespace}", but it has not been processed yet. Applying a template file only saves the template.`,
      fix: templatePipeline(objective, wanted),
    };
  }
  return null;
}

/**
 * Notes for an unticked `node` objective (1.16.0): which part of the
 * maintenance is missing — the drain, Pods still on the node, the workload still
 * starting elsewhere, the final uncordon, or a node that is not Ready.
 */
function explainNode(objective, c) {
  const state = nodeObjectiveState(objective, c);
  if (!state) return null;
  const drain = `oc adm drain ${state.name} --ignore-daemonsets --delete-emptydir-data`;
  if (objective.drained === true && !state.drainedSeen) {
    const count = state.blocking.length;
    return {
      code: 'node-not-drained',
      text: state.cordoned
        ? `${state.name} is cordoned but still runs ${count} Pod${count === 1 ? '' : 's'} that a drain evicts.`
        : `${state.name} has not been drained yet: cordon it and evict its Pods first.`,
      fix: drain,
    };
  }
  if (objective.ready === true && !state.ready) {
    return {
      code: 'node-not-ready',
      text: `${state.name} is not Ready: its kubelet is not reporting.`,
    };
  }
  if (objective.schedulable === true && state.cordoned) {
    return {
      code: 'node-cordoned',
      text: `${state.name} is still cordoned (STATUS Ready,SchedulingDisabled), so the scheduler skips it.`,
      fix: `oc adm uncordon ${state.name}`,
    };
  }
  if (objective.workloadsAvailable === true && state.unavailable.length > 0) {
    const names = state.unavailable.map((deployment) => resourceName(deployment));
    return {
      code: 'node-workload-unavailable',
      text: `Deployment ${quotedList(names, 2)} in project "${state.namespace}" does not serve all its replicas yet: its Pods are still starting on the other nodes.`,
    };
  }
  return null;
}

/**
 * Explain why an objective is not ticked, or return null when there is nothing
 * useful to say. Pure and cheap (it runs every second for every unticked
 * objective) and never throws. Call it for unticked objectives only: it
 * describes the failing state, so on a satisfied objective it returns null.
 *
 * Note shapes:
 *  - `{ code: 'wrong-project', text, fix, found, expected }` — the resource the
 *    objective names exists only in other project(s) `found`, but this level
 *    grades project `expected`; `fix` is `oc project <expected>`.
 *  - `{ code: 'sensitive-configmap-key', text }` — a `noConfigMap` objective is
 *    failing because of the ConfigMap key(s) named in `text`.
 *  - `{ code: 'template-not-processed' | 'template-not-applied' |
 *    'template-wrong-parameters', text, fix }` — a `template` objective: the
 *    Template is only stored, only rendered, or was applied with other
 *    parameters; `fix` is the `oc process … | oc apply -f -` pipeline to run.
 *  - `{ code: 'node-not-drained' | 'node-not-ready' | 'node-cordoned' |
 *    'node-workload-unavailable', text, fix? }` — a `node` objective: the
 *    missing maintenance step (`fix` is the drain / uncordon command).
 *
 * @param {object} objective campaign / challenge objective (or its progress object)
 * @param {object} [ctx] same evaluation context as {@link evaluateObjective}
 * @returns {{code: string, text: string, fix?: string, found?: string[], expected?: string}|null}
 */
export function explainObjective(objective, ctx = {}) {
  if (!objective || typeof objective !== 'object') return null;
  try {
    const type = String(objective.type || '').toLowerCase();
    const c = resolveContext(ctx);
    if (type === 'noconfigmap') return explainSensitiveConfigMap(objective, c);
    if (type === 'template') return explainTemplate(objective, c);
    if (type === 'node') return explainNode(objective, c);
    return explainWrongProject(objective, type, c) || explainGradingRule(objective, type, c);
  } catch {
    return null;
  }
}

/** Short inline form of a recorded command for a note. */
function noteCommand(raw) {
  const text = String(raw || '').trim();
  return `\`${text.length > 70 ? `${text.slice(0, 67)}...` : text}\``;
}

/**
 * Notes for the 1.16.0 state rules, so a stricter objective says why it is not
 * ticking (computed from the same helpers the graders use).
 */
function explainGradingRule(objective, type, c) {
  switch (type) {
    case 'command':
      return explainInspection(objective, c);
    case 'build':
      return explainBuildRunning(objective, c);
    case 'deploy':
      return explainDeployState(objective, c);
    case 'scc':
      return explainSccOverBroad(objective, c);
    case 'operator':
      return explainOperatorLeftovers(objective, c);
    case 'user':
      return explainUserWithoutLogin(objective, c);
    case 'examscore':
      return explainExamScoreGate(objective, c);
    default:
      return null;
  }
}

/** `read-wrong-project` / `read-showed-nothing` for an `inspect` command objective. */
function explainInspection(objective, c) {
  if (objective.inspect !== true) return null;
  const regex = compilePattern(objective.pattern);
  if (!regex) return null;
  const tried = matchCommands(c, objective.pattern, {
    successOnly: objective.mustSucceed !== false,
  });
  const last = tried[tried.length - 1];
  if (!last) return null;
  const namespace = commandObjectiveNamespace(objective, c);
  const segments = commandSegments(last.raw);
  const segment =
    segments.find((part) => regex.test(part) || regex.test(canonicalCommandText(part))) ||
    segments[0] ||
    '';
  const scope = segmentNamespaceScope(segment);
  const actual = scope.namespace || last.project || null;
  if (namespace && !scope.all && actual && actual !== namespace) {
    return {
      code: 'read-wrong-project',
      text: `${noteCommand(last.raw)} ran in project "${actual}", but this objective counts what it shows in project "${namespace}".`,
      fix: `oc project ${namespace}`,
      found: [actual],
      expected: namespace,
    };
  }
  return {
    code: 'read-showed-nothing',
    text: `${noteCommand(last.raw)} did not show ${objective.outputPattern ? 'what this objective looks for' : 'anything'} yet ("No resources found" or empty). Run it again once there is something to see.`,
  };
}

/** `build-not-complete`: the Build exists but has not reached Complete. */
function explainBuildRunning(objective, c) {
  let builds = listKind(c.clusterState, 'Build');
  const namespace = objectiveResourceNamespace(c, objective, 'Build');
  if (namespace) builds = builds.filter((build) => resourceNamespace(build) === namespace);
  if (objective.name) {
    builds = builds.filter(
      (build) =>
        resourceName(build) === objective.name || buildBelongsToConfig(build, objective.name)
    );
  }
  const latest = builds[builds.length - 1];
  if (!latest) return null;
  const phase = String(resourceStatus(latest).phase || 'New');
  if (phase === 'Complete') return null;
  return {
    code: 'build-not-complete',
    text: `Build "${resourceName(latest)}" is ${phase}; this ticks when \`oc get builds\` shows it Complete.`,
  };
}

/** `secret-wrong-type` / `rolebinding-wrong-grant` for `deploy` state filters. */
function explainDeployState(objective, c) {
  const kind = canonicalKind(objective.kind);
  const namespace = objectiveResourceNamespace(c, objective, kind);
  if (objective.secretType && kind === 'Secret' && objective.name) {
    const secret = findResource(c.clusterState, 'Secret', objective.name, namespace);
    if (!secret || secretTypeOf(secret) === String(objective.secretType)) return null;
    return {
      code: 'secret-wrong-type',
      text: `Secret "${objective.name}" exists but its type is ${secretTypeOf(secret)}; this objective needs a ${objective.secretType} Secret (\`oc create secret tls\`). Delete it and create it again.`,
      fix: `oc delete secret ${objective.name}${namespace ? ` -n ${namespace}` : ''}`,
    };
  }
  const subjects = wantedList(objective, 'subjects', 'subject');
  const roles = wantedList(objective, 'roles', 'role');
  if (kind !== 'RoleBinding' || (subjects.length === 0 && roles.length === 0)) return null;
  const project = namespace || levelProjectNamespace(c);
  const learnerBindings = listKind(c.clusterState, 'RoleBinding').filter(
    (binding) =>
      (!project || resourceNamespace(binding) === project) &&
      !isBootstrapProjectRoleBinding(binding)
  );
  if (learnerBindings.length === 0) return null;
  const who = subjects
    .map((subject) => subject.replace(/^system:serviceaccount:[^:]+:/, 'ServiceAccount '))
    .join(' or ');
  return {
    code: 'rolebinding-wrong-grant',
    text: `No RoleBinding${project ? ` in "${project}"` : ''} gives ${roles.length ? roles.join(' or ') : 'a role'}${who ? ` to ${who}` : ''} yet; the bindings there grant other roles or subjects.`,
  };
}

/** `scc-over-broad`: the SCC also reaches other ServiceAccounts of the project. */
function explainSccOverBroad(objective, c) {
  if (objective.exclusive !== true) return null;
  const name = objective.scc || objective.name || objective.sccName;
  const namespace = objective.namespace || levelProjectNamespace(c) || '';
  let subject = objective.subject;
  if (subject && String(subject).includes('*') && namespace) {
    subject = String(subject).split('*').join(namespace);
  }
  const broad = sccOverBroadSubjects(c, name, subject, namespace);
  if (!name || broad.length === 0) return null;
  // Name the grant that does it: a group binding, or a direct `default` grant.
  const roleName = `system:openshift:scc:${name}`;
  let fix = '';
  for (const binding of listKinds(c.clusterState, ['RoleBinding', 'ClusterRoleBinding'])) {
    const spec = resourceSpec(binding);
    if ((spec.roleRef?.name || '') !== roleName) continue;
    const group = asArray(spec.subjects).find(
      (entry) =>
        entry?.kind === 'Group' &&
        /^system:(serviceaccounts|authenticated)/.test(String(entry.name))
    );
    if (group) {
      fix = `oc adm policy remove-scc-from-group ${name} ${group.name}`;
      break;
    }
    const defaultSa = asArray(spec.subjects).find(
      (entry) => entry?.kind === 'ServiceAccount' && entry.name === 'default'
    );
    if (defaultSa) {
      fix = `oc adm policy remove-scc-from-user ${name} -z default -n ${defaultSa.namespace || namespace}`;
      break;
    }
  }
  return {
    code: 'scc-over-broad',
    text: `The ${name} SCC also reaches the ServiceAccount "default" in "${namespace}", not only the dedicated one: a project-wide grant is too broad. Remove it and grant the SCC with \`-z\` to the dedicated ServiceAccount only.`,
    ...(fix ? { fix } : {}),
  };
}

/** `operator-csv-left`: the Subscription is gone but its CSV is still installed. */
function explainOperatorLeftovers(objective, c) {
  if (objective.installed !== false || !(objective._installedCsvs instanceof Map)) return null;
  for (const entry of objective._installedCsvs.values()) {
    if (!findResource(c.clusterState, 'ClusterServiceVersion', entry.name, entry.namespace))
      continue;
    const wanted = String(objective.name || objective.operator || '').toLowerCase();
    const subscriptionLeft = listKind(c.clusterState, 'Subscription').some((subscription) =>
      `${resourceName(subscription)} ${resourceSpec(subscription).name || ''}`
        .toLowerCase()
        .includes(wanted)
    );
    if (subscriptionLeft) return null;
    return {
      code: 'operator-csv-left',
      text: `The Subscription is deleted, but the CSV "${entry.name}" is still installed in "${entry.namespace}": the operator keeps running until it is deleted too.`,
      fix: `oc delete csv ${entry.name} -n ${entry.namespace}`,
    };
  }
  return null;
}

/** `user-not-logged-in`: the User exists but no identity provider login created it. */
function explainUserWithoutLogin(objective, c) {
  if (objective.viaLogin !== true || !objective.name) return null;
  const user = findResource(c.clusterState, 'User', objective.name);
  if (!user || userHasIdentity(c, user)) return null;
  return {
    code: 'user-not-logged-in',
    text: `User "${objective.name}" exists but has no identity (it was created by hand, e.g. \`oc create user\`); this counts the User a first login through the identity provider creates.`,
  };
}

/** `exam-score-gated`: the composite is high enough but other objectives are open. */
function explainExamScoreGate(objective, c) {
  const progress = asArray(c.objectiveProgress).filter(
    (entry) => String(entry?.type || '').toLowerCase() !== 'examscore'
  );
  const open = progress.filter((entry) => !entry?.completed).length;
  if (open === 0) return null;
  return {
    code: 'exam-score-gated',
    text: `This final score only counts once every other objective is done (${open} still open).`,
  };
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
    // Per-run evaluator state (`_baseline`, latches) lives on the progress copy
    // and never carries over from a shared level definition that something
    // evaluated directly (tests, Exam Prep previews).
    const authored = Object.fromEntries(
      Object.entries(objective || {}).filter(([key]) => !key.startsWith('_'))
    );
    return {
      ...authored,
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
 * `options.recheckCompleted` is true. Every objective that is (re)evaluated also
 * gets `note`: null when ticked, otherwise `explainObjective()` (or null).
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
  // Attach the login/Secret evidence latch (issues #30/#71) at the FIRST
  // objective evaluation of a run: the cache installs its EventBus listeners
  // lazily, and a run that logs a user in before any other objective needs
  // evidence must still capture that login's htpasswd-hash snapshot.
  try {
    evidenceCache(ctx?.gameEngine);
  } catch {
    /* feature-detected: an engine without an event bus simply has no latch */
  }
  const recheckCompleted = options.recheckCompleted === true;
  for (let index = 0; index < progress.length; index += 1) {
    const objective = progress[index];
    if (!objective) continue;
    if (objective.completed && !recheckCompleted) continue;
    const evaluated = evaluateObjective(objective, ctx);
    objective.current = evaluated.current;
    objective.target = evaluated.target;
    objective.completed = evaluated.completed;
    // An unticked objective explains itself (`explainObjective`); a ticked one never carries a note.
    let note = null;
    if (!evaluated.completed) {
      try {
        note = explainObjective(objective, ctx) || null;
      } catch {
        note = null;
      }
    }
    objective.note = note;
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
  explainObjective,
  createObjectiveProgress,
  getObjectiveSummary,
  hasCommand,
  resolveContext,
  listKind,
  findResource,
  containersOf,
};
