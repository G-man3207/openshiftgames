/**
 * IncidentEngine.js — OpenShift incident lifecycle + cluster-state effects.
 *
 * CONVERSION-SPEC.md §8 (incidents) / §5 (controllers) / §13 (contracts).
 *
 * What changed vs the Kubernetes game:
 *  1. Command lists use `ocCommands` only (legacy naming removed).
 *  2. Incidents are NO LONGER COSMETIC (architecture-map G9). On spawn each
 *     incident injects a plausible damaged state into the target resource(s)
 *     (`applyIncidentEffects`), and resolving it applies the `resolution`
 *     descriptor from IncidentDefs (`applyResolutionEffects`) by mutating the
 *     live ClusterState. Fixing the resource outside the panel (a Pod becoming
 *     Ready, a Route being admitted, a build completing …) also auto-resolves
 *     the incident via the `cluster:modified` watcher.
 *  3. One clock: GameEngine.onUpdate passes SECONDS and the old internal
 *     `setInterval` also ticked milliseconds (architecture-map G12). `tick()`
 *     normalises both and only starts the fallback timer if no external ticks
 *     arrive (e.g. a mode that forgets to pump the engine).
 *  4. OpenShift cascade rules + OpenShift incident names (exact spec §8 names).
 *
 * Engine APIs used (all documented in CONVERSION-SPEC §13 / ClusterState):
 *   gameEngine.cluster.getByName / getByKind / getChildren / selectByLabels /
 *   getByKindAndNamespace / add / update / remove / getResourceQuota /
 *   setResourceQuota ; ResourceBase.setPhase / setCondition / recordEvent /
 *   setAnnotation / removeFinalizer ; EventBus emit/on.
 * Everything is feature-detected and wrapped in try/catch — an incident can
 * never crash the render loop.
 */

import {
  INCIDENT_DEFS,
  INCIDENT_DEFS_BY_NAME,
  SEVERITY_LEVELS,
  LEGACY_INCIDENT_ALIASES,
} from '../data/IncidentDefs.js';
import { ResourceBase } from '../resources/ResourceBase.js';

const INCIDENT_STATE = {
  CREATED: 'Created',
  ACTIVE: 'Active',
  INVESTIGATING: 'Investigating',
  RESOLVED: 'Resolved',
};

/** Phase values that mean "this Pod/Job/Build is not healthy". */
const UNHEALTHY_PHASES = new Set([
  'Pending',
  'Failed',
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'Terminating',
  'Unknown',
  'Error',
]);

const INCIDENT_ANNOTATION = 'openshiftgames.io/incident';
const HEAL_ANNOTATION = 'openshiftgames.io/healed';

/**
 * Incidents whose broken state is stable enough for `cluster:modified` to
 * detect that the player repaired the underlying resource. Pod crash-loop/probe
 * style incidents are healed through the panel resolution action instead
 * (the pod lifecycle controller would otherwise mask/recreate their state).
 */
const STATE_RESOLVABLE = new Set([
  'RouteNotAdmitted',
  'RouteTLSCertificateError',
  'RouteHostConflict',
  'ServiceNoEndpoints',
  'NetworkPolicyBlocking',
  'DNSResolutionFailure',
  'IngressDegraded',
  'LoadBalancerPending',
  'NodeNotReady',
  'NodeDiskPressure',
  'NodeMemoryPressure',
  'PendingScheduling',
  'SCCForbidden',
  'ResourceQuotaExceeded',
  'ClusterResourceQuotaExceeded',
  'LimitRangeViolation',
  'UnauthorizedAccess',
  'HTPasswdAuthFailure',
  'CronJobMissedSchedule',
  'PVCPending',
  'BuildFailed',
  'ImageStreamTagMissing',
  'JobDeadlineExceeded',
  'HPAUnableToScale',
  'OperatorInstallFailed',
  'SecretExposed',
  'DeploymentStuckRollout',
]);

/**
 * Minimum simulation time between two per-tick state-healing passes (#27).
 * The state check mutates nothing, but it walks cluster collections, so a
 * 1.5 s game-time throttle keeps the tick path predictable while still
 * clearing an incident within about a second of the learner's fix. Pause
 * freezes the clock (no ticks), so this throttle is pause-aware by design.
 */
const STATE_HEAL_INTERVAL_SECONDS = 1.5;

/**
 * Legacy level data names campaign nodes `node-1…3`; the cluster presents the
 * realistic OCP names (`worker-0`, `worker-1`, `master-0`). Scripted incidents
 * authored before that change must still damage the intended machine instead
 * of silently picking the first Node (#28).
 */
const NODE_NAME_ALIASES = {
  'node-1': 'worker-0',
  'node-2': 'worker-1',
  'node-3': 'master-0',
};

const nowIso = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Incident instance
// ─────────────────────────────────────────────────────────────────────────────
class Incident {
  constructor(def, target, id) {
    this.id = id;
    this.defId = def.id;
    this.name = def.name;
    this.category = def.category;
    this.severity = def.severity;
    this.description = def.description;
    this.visualEffect = def.visualEffect;
    this.affectedResourceTypes = [...(def.affectedResourceTypes || [])];
    this.investigationSteps = (def.investigationSteps || []).map((s) => ({
      ...s,
      completed: false,
    }));
    this.resolutionActions = (def.resolutionActions || []).map((a) => ({ ...a }));
    this.ocCommands = [...(def.ocCommands || [])];
    this.autoResolveTime = def.autoResolveTime ?? null;
    this.docsUrl = def.docsUrl || null;
    this.resolution = def.resolution ? { ...def.resolution } : null;
    this.target = target;
    this.namespace = null; // resolved at spawn time
    this.uid = null; // resolved at spawn time (for HUD/Minimap highlight)
    this.state = INCIDENT_STATE.CREATED;
    this.createdAt = Date.now();
    this.activatedAt = null;
    this.resolvedAt = null;
    // Simulation-time (IncidentEngine.elapsedTime, seconds) timestamps so
    // pause/overlay freezes also freeze auto-resolve timers (GAME-015).
    this.activatedGameSeconds = null;
    this.resolvedGameSeconds = null;
    this.investigationProgress = 0;
    // Actual damaged Pod (for investigation command substitution, GAME-016).
    this.targetPod = null;
    this.targetPodUid = null;
    // The ServiceAccount/identity damaged by an RBAC incident (the incident
    // target is usually the workload, so the denied identity is tracked here).
    this.rbacSubject = null;
    // Damage parameters re-applied to replacement Pods so "restart until green"
    // cannot fake a fix for CrashLoopBackOff-style incidents.
    this.damageSpec = null;
    this.baseline = null;
    this.cascadeChildren = [];
    this.cascadeParent = null;
    this.comboEligible = true;
    this.restoreState = null; // values saved by onset damage so resolution can undo it
    this.effectApplied = null; // last resolution effect result
  }

  activate(gameSeconds = null) {
    this.state = INCIDENT_STATE.ACTIVE;
    this.activatedAt = Date.now();
    this.activatedGameSeconds = Number.isFinite(Number(gameSeconds)) ? Number(gameSeconds) : null;
  }

  startInvestigation() {
    if (this.state === INCIDENT_STATE.ACTIVE) this.state = INCIDENT_STATE.INVESTIGATING;
  }

  completeInvestigationStep(index) {
    if (index >= 0 && index < this.investigationSteps.length) {
      this.investigationSteps[index].completed = true;
      const done = this.investigationSteps.filter((s) => s.completed).length;
      this.investigationProgress = done / this.investigationSteps.length;
    }
  }

  resolve(gameSeconds = null) {
    this.state = INCIDENT_STATE.RESOLVED;
    this.resolvedAt = Date.now();
    this.resolvedGameSeconds = Number.isFinite(Number(gameSeconds)) ? Number(gameSeconds) : null;
  }

  getResolutionTime() {
    if (this.activatedGameSeconds !== null && this.resolvedGameSeconds !== null) {
      return Math.max(0, this.resolvedGameSeconds - this.activatedGameSeconds);
    }
    if (!this.activatedAt || !this.resolvedAt) return null;
    return (this.resolvedAt - this.activatedAt) / 1000;
  }

  /**
   * @param {number} currentTime wall-clock ms (legacy callers)
   * @param {number} [currentGameSeconds] simulation seconds (pause-aware)
   */
  isExpired(currentTime, currentGameSeconds = null) {
    if (!this.autoResolveTime || !this.activatedAt) return false;
    if (this.activatedGameSeconds !== null && Number.isFinite(Number(currentGameSeconds))) {
      return Number(currentGameSeconds) - this.activatedGameSeconds >= this.autoResolveTime;
    }
    return (currentTime - this.activatedAt) / 1000 >= this.autoResolveTime;
  }

  getSummary() {
    return {
      id: this.id,
      defId: this.defId,
      name: this.name,
      category: this.category,
      severity: this.severity,
      description: this.description,
      state: this.state,
      target: this.target,
      namespace: this.namespace,
      uid: this.uid,
      targetPod: this.targetPod,
      targetPodUid: this.targetPodUid,
      visualEffect: this.visualEffect,
      investigationProgress: this.investigationProgress,
      createdAt: this.createdAt,
      activatedAt: this.activatedAt,
      docsUrl: this.docsUrl,
      ocCommands: this.ocCommands,
      hasCascade: this.cascadeChildren.length > 0,
      pendingTarget: Boolean(this.pendingTarget),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────
class IncidentEngine {
  constructor(gameEngine) {
    this.gameEngine = gameEngine;
    this.activeIncidents = new Map();
    this.resolvedIncidents = [];
    this.incidentCounter = 0;
    this.difficultyLevel = 1;
    this.paused = false;
    this.mode = 'sandbox';
    this.scriptedQueue = [];
    this.elapsedTime = 0;
    // Number of incidents that have activated since the mode/level started.
    // ObjectiveEvaluator uses this to gate "restore/keep health" objectives
    // (GAME-001): they cannot be complete before an incident has happened.
    this.activationCount = 0;
    // Activation epoch captured by start()/reset() at level start. Preloaded
    // incidents with `triggerTime: 0` activate after start(), so objective
    // baselines must compare against THIS value, never against the count seen
    // at the first evaluation (that was #22: lab 02 soft-locked at 3/4).
    this.levelStartActivationCount = 0;
    this.comboCount = 0;
    this.lastResolveTime = 0;
    this.lastResolveGameSeconds = null;
    this.comboWindow = 10000;
    this.maxCascadeDepth = 3;
    this.pendingCascadeTimers = [];
    // Activation log (simulation-time) used by the L20 capstone gate: an
    // incident that fired during the run is recorded here even after resolving.
    this.incidentHistory = [];
    // Deferred `incident:created` announcements (wait for the damaged Pod name
    // so panel investigation commands carry a real Pod name, not the owner).
    this._announceTimers = [];
    // Incident definitions by id (log profiles + damage metadata).
    this._defsById = new Map(INCIDENT_DEFS.map((def) => [def.id, def]));

    // Clock handling (G12): external fixed-step ticks vs internal fallback timer.
    this._clockInterval = null;
    this._fallbackTimer = null;
    this._externalTickSeen = false;

    // State-driven resolution bookkeeping.
    this._resolving = false;
    this._clusterUnsubscribers = [];
    // Per-tick state-healing throttle (#27a): simulation seconds of the last
    // pass. Reset on start()/reset() so a new run always checks immediately.
    this._lastStateHealGameSeconds = null;

    // OpenShift cascade rules (parent name → children spawn chances).
    this.cascadeRules = new Map([
      [
        'NodeNotReady',
        [
          { incident: 'PendingScheduling', probability: 0.6, delay: 5000, severity: 2 },
          { incident: 'ServiceNoEndpoints', probability: 0.5, delay: 8000, severity: 3 },
        ],
      ],
      [
        'OOMKilled',
        [
          { incident: 'ReadinessProbeFailure', probability: 0.6, delay: 3000, severity: 2 },
          { incident: 'LivenessProbeFailure', probability: 0.4, delay: 5000, severity: 2 },
        ],
      ],
      [
        'DNSResolutionFailure',
        [
          { incident: 'ServiceNoEndpoints', probability: 0.7, delay: 4000, severity: 3 },
          { incident: 'ReadinessProbeFailure', probability: 0.4, delay: 6000, severity: 2 },
        ],
      ],
      [
        'NodeDiskPressure',
        [{ incident: 'PendingScheduling', probability: 0.7, delay: 10000, severity: 2 }],
      ],
      [
        'NodeMemoryPressure',
        [
          { incident: 'OOMKilled', probability: 0.6, delay: 5000, severity: 3 },
          { incident: 'PendingScheduling', probability: 0.5, delay: 8000, severity: 2 },
        ],
      ],
      [
        'BuildFailed',
        [
          { incident: 'ImageStreamTagMissing', probability: 0.6, delay: 6000, severity: 3 },
          { incident: 'DeploymentStuckRollout', probability: 0.4, delay: 10000, severity: 3 },
        ],
      ],
      [
        'RouteTLSCertificateError',
        [{ incident: 'RouteNotAdmitted', probability: 0.6, delay: 5000, severity: 3 }],
      ],
    ]);

    this.difficultyWeights = this.buildDifficultyWeights();
  }

  // ── Context helpers ───────────────────────────────────────────────────────
  get cluster() {
    const ge = this.gameEngine;
    if (ge && ge.cluster) return ge.cluster;
    if (typeof window !== 'undefined' && window.game && window.game.cluster)
      return window.game.cluster;
    return null;
  }

  emit(event, data = {}) {
    try {
      if (this.gameEngine && typeof this.gameEngine.emit === 'function') {
        this.gameEngine.emit(event, data);
      } else if (typeof window !== 'undefined' && window.game && window.game.engine) {
        window.game.engine.emit(event, data);
      }
    } catch (err) {
      // never let an event listener break incident processing
    }
  }

  _safe(fn, fallback = null) {
    try {
      return fn();
    } catch (err) {
      return fallback;
    }
  }

  // ── Difficulty weighting (unchanged API) ─────────────────────────────────
  buildDifficultyWeights() {
    const weights = new Map();
    for (let level = 1; level <= 10; level++) {
      const maxSeverity = Math.min(5, Math.ceil(level / 2));
      const eligible = INCIDENT_DEFS.filter((d) => d.severity <= maxSeverity);
      const totalWeight = eligible.reduce((sum, d) => sum + this._incidentWeight(level, d), 0) || 1;
      weights.set(
        level,
        eligible.map((d) => ({
          def: d,
          weight: this._incidentWeight(level, d) / totalWeight,
        }))
      );
    }
    return weights;
  }

  _incidentWeight(level, def) {
    if (level >= def.severity * 2) return 3;
    if (level >= def.severity) return 2;
    return 1;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  loadScriptedIncidents(incidents = []) {
    this.scriptedQueue = (incidents || [])
      .map((inc) => {
        const requested = inc.type || inc.name;
        let def = INCIDENT_DEFS.find((d) => d.name === requested);
        let resolvedFrom = null;
        if (!def && LEGACY_INCIDENT_ALIASES[requested]) {
          resolvedFrom = requested;
          def = INCIDENT_DEFS_BY_NAME[LEGACY_INCIDENT_ALIASES[requested]];
          // eslint-disable-next-line no-console
          console.warn(
            `[incidents] scripted incident "${requested}" is legacy; using "${def ? def.name : '?'}". Update the level data to spec §8 names.`
          );
        }
        if (!def) {
          // eslint-disable-next-line no-console
          console.warn(`[incidents] unknown scripted incident type "${requested}" — skipped.`);
          return null;
        }
        return {
          ...inc,
          originalType: requested,
          resolvedFrom,
          def,
          triggered: false,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.triggerTime || 0) - (b.triggerTime || 0));
    return this.scriptedQueue.length;
  }

  start(mode) {
    this.stop();
    this.mode = mode || 'sandbox';
    this.elapsedTime = 0;
    this.paused = false;
    this.activeIncidents.clear();
    this.resolvedIncidents = [];
    this.activationCount = 0;
    // Level-start epoch (#22): one-shot incident preloads (triggerTime: 0) fire
    // on the first tick AFTER start(), so they are counted after this snapshot.
    this.levelStartActivationCount = 0;
    this.incidentHistory = [];
    this.comboCount = 0;
    this.lastResolveGameSeconds = null;
    this.incidentCounter = 0;
    this._resolving = false;
    this._externalTickSeen = false;
    this._lastStateHealGameSeconds = null;
    this._clearAnnounceTimers();

    // Fallback clock only when nothing else pumps tick() (kept for modes that
    // call start() without an external fixed-step caller, e.g. headless tests).
    this._fallbackTimer = setTimeout(() => {
      this._fallbackTimer = null;
      if (this.paused || this._externalTickSeen) return;
      this._clockInterval = setInterval(() => this.tick(1000), 1000);
      this._clockInterval.unref?.();
    }, 2500);
    this._fallbackTimer.unref?.();

    this._bindClusterEvents();
  }

  stop() {
    if (this._clockInterval) {
      clearInterval(this._clockInterval);
      this._clockInterval = null;
    }
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
    for (const timer of this.pendingCascadeTimers) clearTimeout(timer);
    this.pendingCascadeTimers = [];
    this._clearAnnounceTimers();
    this._unbindClusterEvents();
    this.paused = true;
  }

  _clearAnnounceTimers() {
    for (const timer of this._announceTimers) clearInterval(timer);
    this._announceTimers = [];
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  /**
   * Fixed-step tick.
   * GameEngine.onUpdate() supplies SECONDS (~0.016). Some legacy callers pass
   * milliseconds (1000). One clock only: normalise both to milliseconds.
   */
  tick(delta) {
    if (this.paused) return;
    let deltaMs = 0;
    if (typeof delta === 'number' && Number.isFinite(delta) && delta > 0) {
      if (delta < 5) {
        deltaMs = delta * 1000; // seconds
      } else {
        deltaMs = delta; // already milliseconds
      }
      this._externalTickSeen = true;
    }

    this.elapsedTime += deltaMs;
    const elapsedSeconds = this.elapsedTime / 1000;

    this.processScriptedIncidents(elapsedSeconds);
    this.processAutoResolve();
    this.updateActiveIncidents();

    if (this.mode === 'chaos') {
      this.processChaosTick(elapsedSeconds);
    }
  }

  processScriptedIncidents(elapsedSeconds) {
    for (const scripted of this.scriptedQueue) {
      if (scripted.triggered) continue;
      if (elapsedSeconds >= (scripted.triggerTime || 0)) {
        scripted.triggered = true;
        let target = scripted.target;
        if (!target || target === 'random' || target === 'multiple') {
          target = this.selectRandomTarget(scripted.def);
        }
        this.spawnIncident(scripted.def, target, scripted.severity || scripted.def.severity, {
          namespace: scripted.namespace,
          scriptedFrom: scripted.originalType || scripted.def.name,
          // Never invent a different target for a data-authored incident.
          exactTarget: true,
          // #31 A1: optional per-incident seed/fix contract authored in the
          // level data. `seed` makes the broken value part of the cluster
          // state (the fault has a real root cause); `fix` defines the only
          // state-driven remediation (e.g. APP_MODE in allowed[]).
          seed: scripted.seed || null,
          fix: scripted.fix || null,
        });
      }
    }
  }

  processAutoResolve() {
    const now = Date.now();
    const gameSeconds = this.elapsedTime / 1000;
    for (const [id, incident] of [...this.activeIncidents]) {
      // Simulation time, so pausing the level (IncidentEngine.pause + no ticks)
      // also pauses auto-resolve (GAME-015).
      if (incident.isExpired(now, gameSeconds)) this.resolveIncident(id, 'auto');
    }
    // #27(a): repairing the underlying resource is not a side effect of a
    // cluster write. `oc adm policy add-scc-to-user`, a quota patch, a kubelet
    // restart or a fix made BEFORE the incident fired emits no guaranteed
    // `cluster:modified` afterwards — the state check therefore also runs on
    // the simulation tick (throttled, pause-aware) instead of only from the
    // watcher. `_onClusterModified()` keeps its immediate reaction for feedback.
    this._reconcileStateHealing(gameSeconds);
  }

  /**
   * Periodic state-healing pass (#27a). Runs ~every 1.5 game seconds:
   *  1. retry onset damage for incidents whose target appeared late (same
   *     contract as the cluster:modified watcher), then
   *  2. resolve incidents whose damaged resource has been repaired in the
   *     cluster (quota raised, SCC granted, node Ready, route admitted, …).
   */
  _reconcileStateHealing(gameSeconds) {
    if (this.paused || this._resolving) return;
    if (this.activeIncidents.size === 0) return;
    const last = this._lastStateHealGameSeconds;
    if (Number.isFinite(last) && gameSeconds - last < STATE_HEAL_INTERVAL_SECONDS) return;
    this._lastStateHealGameSeconds = gameSeconds;
    for (const [id, incident] of [...this.activeIncidents]) {
      if (!this.activeIncidents.has(id)) continue;
      this._safe(() => this._checkIncidentHealth(id, incident, gameSeconds));
    }
  }

  /**
   * State check for one active incident. Shared by the tick pass and by
   * `_onClusterModified()` so the two paths cannot drift.
   * @returns {boolean} true when the incident was resolved by this check
   */
  _checkIncidentHealth(incidentId, incident, gameSeconds) {
    if (!incident || this._resolving) return false;
    if (incident.state === INCIDENT_STATE.CREATED) return false;
    if (!incident.damageApplied) {
      // The named target did not exist at onset. The cluster:modified watcher
      // retries the damage; the tick does too so an incident authored against
      // a not-yet-created object becomes real even when no later write happens.
      this._retryOnsetDamage(incident);
      return false;
    }
    if (!STATE_RESOLVABLE.has(incident.name)) return false;
    if (!this._incidentPastActivationGrace(incident, gameSeconds)) return false;
    const healed = this._safe(() => this._targetLooksHealthy(incident), false);
    if (!healed) return false;
    this.resolveIncident(incidentId, 'resource-fixed');
    return true;
  }

  /**
   * Grace period after activation, measured in SIMULATION seconds so a paused
   * game does not let a check race the onset damage. 1.5 s matches the
   * historical cluster:modified grace.
   */
  _incidentPastActivationGrace(incident, gameSeconds) {
    const activatedGame = Number(incident.activatedGameSeconds);
    if (Number.isFinite(activatedGame)) return gameSeconds - activatedGame >= 1.5;
    return !incident.activatedAt || Date.now() - incident.activatedAt >= 1500;
  }

  updateActiveIncidents() {
    for (const [, incident] of this.activeIncidents) {
      if (incident.state === INCIDENT_STATE.CREATED) {
        const gameSeconds = this.elapsedTime / 1000;
        incident.activate(gameSeconds);
        this.activationCount += 1;
        this._recordIncidentHistory(incident, gameSeconds);
        this.emit('incident:activated', incident.getSummary());
      }
    }
  }

  /** Record every incident activation for this run (capstone gating, stats). */
  _recordIncidentHistory(incident, gameSeconds) {
    this.incidentHistory.push({
      id: incident.id,
      defId: incident.defId,
      name: incident.name,
      category: incident.category,
      severity: incident.severity,
      target: incident.target,
      namespace: incident.namespace,
      activatedAt: Number.isFinite(Number(gameSeconds))
        ? Number(gameSeconds)
        : Math.round(this.elapsedTime / 1000),
    });
  }

  /** Incidents that activated during this run (survives resolution). */
  getIncidentHistory() {
    return this.incidentHistory.slice();
  }

  processChaosTick(elapsedSeconds) {
    const minutesElapsed = elapsedSeconds / 60;
    this.difficultyLevel = Math.min(10, 1 + Math.floor(minutesElapsed / 2));

    const baseInterval = 15;
    const interval = Math.max(3, baseInterval - this.difficultyLevel * 1.2);
    const shouldSpawn = Math.random() < 1 / interval;

    if (shouldSpawn && this.activeIncidents.size < 5 + this.difficultyLevel) {
      const def = this.selectRandomIncident();
      if (def) this.spawnIncident(def, this.selectRandomTarget(def));
    }
  }

  selectRandomIncident() {
    const level = Math.min(10, this.difficultyLevel);
    const pool = this.difficultyWeights.get(level);
    if (!pool || pool.length === 0) return null;

    const roll = Math.random();
    let cumulative = 0;
    for (const entry of pool) {
      cumulative += entry.weight;
      if (roll <= cumulative) return entry.def;
    }
    return pool[pool.length - 1].def;
  }

  /** Pick a random existing resource of one of the incident's affected kinds. */
  selectRandomTarget(def) {
    const state = this.cluster;
    if (!state) return 'unknown';

    const candidates = [];
    for (const kind of def.affectedResourceTypes || []) {
      const resources = state.getByKind(kind) || [];
      candidates.push(...resources);
    }
    // Prefer namespaced resources in the current project for relevance.
    const project = this.gameEngine && this.gameEngine.currentProject;
    const preferred = project ? candidates.filter((r) => r.namespace === project) : [];
    const pool = preferred.length > 0 ? preferred : candidates;
    if (pool.length === 0) return 'unknown';
    return pool[Math.floor(Math.random() * pool.length)].name || 'unknown';
  }

  // ── Spawning ──────────────────────────────────────────────────────────────
  spawnIncident(def, target, overrideSeverity, opts = {}) {
    if (!def) return null;
    this.incidentCounter++;
    const id = `inc-${this.incidentCounter}`;
    const incident = new Incident(def, target || 'unknown', id);
    if (overrideSeverity) incident.severity = overrideSeverity;
    // Per-incident seed/fix contract (#31 A1) authored in the level data.
    incident.seed = opts.seed || null;
    incident.fix = opts.fix || null;

    // Scripted incidents name a concrete target from level/challenge data; do
    // not silently retarget a same-kind resource or fabricate `<kind>-incident-N`
    // in another namespace (GAME-005). If the named object does not exist yet we
    // keep the incident pending and attach damage when the learner creates it.
    const exactTarget = opts.exactTarget === true;
    let resolvedTarget = this._resolveTargetResource(incident);
    if (!resolvedTarget && !exactTarget) resolvedTarget = this._findFallbackTarget(incident);
    if (!resolvedTarget && !exactTarget) resolvedTarget = this._ensureTargetResource(def, incident);
    if (resolvedTarget) {
      incident.target = resolvedTarget.name;
      incident.uid = resolvedTarget.uid || resolvedTarget.metadata?.uid || null;
      incident.namespace = resolvedTarget.namespace || resolvedTarget.metadata?.namespace || '';
    } else {
      incident.namespace =
        opts.namespace ||
        this._defaultNamespaceFor(def) ||
        (this.gameEngine && this.gameEngine.currentProject) ||
        'default';
      if (exactTarget && incident.target && incident.target !== 'unknown') {
        incident.pendingTarget = true;
      }
    }

    this.activeIncidents.set(id, incident);

    // Resolve the concrete damaged Pod before announcing the incident so the
    // payload carries `targetPod` for investigation-command substitution.
    const affected = incident.affectedResourceTypes || [];
    if (incident.resolution?.targetKind === 'Pod' || affected.includes('Pod')) {
      this._safe(() => this._pickPodForIncident(incident));
    }

    // Inject the damage BEFORE the announcement so onset damage can resolve the
    // concrete Pod name used in the panel's `oc logs/describe <pod>` commands.
    const damage = this._safe(() => this.applyIncidentEffects(incident));
    incident.damageApplied = damage ? damage.applied !== false : false;

    this._announceIncident(incident);
    this.checkCascade(incident, 0);
    return id;
  }

  /**
   * Emit `incident:created` for the panel/HUD. Pod-style incidents whose Pod
   * name is not resolvable yet are announced after a short poll (max ~2 s) so
   * the investigation commands never show an owner name where a Pod name is
   * required (`oc logs payment-service` is NotFound on a real cluster).
   */
  _announceIncident(incident) {
    const needsPod =
      incident.resolution?.targetKind === 'Pod' ||
      (incident.affectedResourceTypes || []).includes('Pod');
    if (needsPod && !incident.targetPod && !incident.pendingTarget) {
      let attempts = 0;
      const timer = setInterval(() => {
        attempts += 1;
        if (!this.activeIncidents.has(incident.id)) {
          clearInterval(timer);
          this._announceTimers = this._announceTimers.filter((entry) => entry !== timer);
          return;
        }
        // Pods may be created a tick or two after the scripted trigger time:
        // retry the onset damage too, so the incident is real and the panel
        // commands carry a concrete Pod name.
        if (!incident.damageApplied) {
          const damage = this._safe(() => this.applyIncidentEffects(incident));
          if (damage && damage.applied !== false) {
            incident.damageApplied = true;
            incident.pendingTarget = false;
          }
        }
        if (!incident.targetPod) this._safe(() => this._pickPodForIncident(incident));
        if (incident.targetPod || attempts >= 12) {
          clearInterval(timer);
          this._announceTimers = this._announceTimers.filter((entry) => entry !== timer);
          this._emitIncidentCreated(incident);
        }
      }, 150);
      timer.unref?.();
      this._announceTimers.push(timer);
      return;
    }
    this._emitIncidentCreated(incident);
  }

  _emitIncidentCreated(incident) {
    this.emit('incident:created', {
      ...incident.getSummary(),
      state: incident.state,
      investigationSteps: incident.investigationSteps.map((s) => ({
        command: s.command,
        hint: s.hint,
      })),
      resolutionActions: incident.resolutionActions,
      ocCommands: incident.ocCommands,
      damagedSubject: incident.rbacSubject || incident.damagedSubject || null,
    });
  }

  _defaultNamespaceFor(def) {
    const state = this.cluster;
    if (!state) return 'default';
    for (const kind of def.affectedResourceTypes || []) {
      const resources = state.getByKind(kind) || [];
      if (resources.length > 0) return resources[0].namespace || '';
    }
    return '';
  }

  checkCascade(parentIncident, depth) {
    if (depth >= this.maxCascadeDepth) return;

    const rules = this.cascadeRules.get(parentIncident.name);
    if (!rules) return;

    for (const rule of rules) {
      if (Math.random() > rule.probability) continue;

      const timer = setTimeout(() => {
        this.pendingCascadeTimers = this.pendingCascadeTimers.filter((t) => t !== timer);
        if (this.paused) return;
        if (parentIncident.state === INCIDENT_STATE.RESOLVED) return;

        const childDef = INCIDENT_DEFS.find((d) => d.name === rule.incident);
        if (!childDef) return;

        const childId = this.spawnIncident(childDef, parentIncident.target, rule.severity, {
          namespace: parentIncident.namespace,
        });
        const child = childId ? this.activeIncidents.get(childId) : null;
        if (child) {
          child.cascadeParent = parentIncident.id;
          parentIncident.cascadeChildren.push(childId);
          this.emit('incident:cascade', {
            parentId: parentIncident.id,
            childId,
            parentName: parentIncident.name,
            childName: child.name,
            uid: child.uid,
          });
          this.checkCascade(child, depth + 1);
        }
      }, rule.delay);
      this.pendingCascadeTimers.push(timer);
    }
  }

  // ── Investigation API (kept for modes/panel) ─────────────────────────────
  investigateIncident(incidentId) {
    const incident = this.activeIncidents.get(incidentId);
    if (!incident) return null;

    incident.startInvestigation();
    this.emit('incident:investigating', {
      id: incident.id,
      name: incident.name,
      steps: incident.investigationSteps,
      commands: incident.ocCommands,
      ocCommands: incident.ocCommands,
    });

    return {
      steps: incident.investigationSteps,
      commands: incident.ocCommands,
      ocCommands: incident.ocCommands,
      progress: incident.investigationProgress,
    };
  }

  completeStep(incidentId, stepIndex) {
    const incident = this.activeIncidents.get(incidentId);
    if (!incident) return null;
    incident.completeInvestigationStep(stepIndex);
    this.emit('incident:step-completed', {
      id: incident.id,
      name: incident.name,
      stepIndex,
      progress: incident.investigationProgress,
    });
    return incident.investigationProgress;
  }

  /**
   * Mark every investigation step complete. Resolving an incident implies the
   * learner diagnosed it, so the "investigate" objective must not stay blocked
   * once the incident is gone (GAME-004 soft-lock).
   */
  _completeInvestigation(incident) {
    if (!incident) return;
    for (const step of incident.investigationSteps || []) step.completed = true;
    incident.investigationProgress =
      incident.investigationSteps.length > 0 ? 1 : incident.investigationProgress;
  }

  // ── Resolution ────────────────────────────────────────────────────────────
  resolveIncident(incidentId, actionId = 'manual') {
    const incident = this.activeIncidents.get(incidentId);
    if (!incident) return null;
    if (this._resolving) return null;

    this._resolving = true;
    try {
      const gameSeconds = this.elapsedTime / 1000;
      this._completeInvestigation(incident);
      incident.resolve(gameSeconds);
      this.activeIncidents.delete(incidentId);
      this.resolvedIncidents.push(incident);

      const resolutionTime = incident.getResolutionTime();
      const severityInfo =
        SEVERITY_LEVELS.find((s) => s.level === incident.severity) || SEVERITY_LEVELS[0];
      let xpEarned = severityInfo.xpReward;

      const now = Date.now();
      // Combo window measured in simulation seconds so pausing does not grant
      // free combo multipliers (GAME-015).
      const comboElapsed =
        this.lastResolveGameSeconds === null ? Infinity : gameSeconds - this.lastResolveGameSeconds;
      if (comboElapsed * 1000 < this.comboWindow) {
        this.comboCount++;
        xpEarned = Math.floor(xpEarned * (1 + this.comboCount * 0.25));
      } else {
        this.comboCount = 1;
      }
      this.lastResolveGameSeconds = gameSeconds;
      this.lastResolveTime = now;

      if (resolutionTime !== null && resolutionTime < 30) {
        xpEarned = Math.floor(xpEarned * 1.5);
      }

      // Apply the cluster mutations BEFORE announcing the resolution so
      // listeners (scoring, objectives, renderer) observe the healed state.
      const effect = this._safe(() => this.applyResolutionEffects(incident, actionId), {
        applied: false,
        reason: 'exception',
      });
      incident.effectApplied = effect;

      const cascadeChildren = incident.cascadeChildren.filter((cid) =>
        this.activeIncidents.has(cid)
      );

      this.emit('incident:resolved', {
        id: incident.id,
        name: incident.name,
        category: incident.category,
        severity: incident.severity,
        target: incident.target,
        namespace: incident.namespace,
        uid: incident.uid,
        targetPod: incident.targetPod || null,
        investigationProgress: incident.investigationProgress,
        resolutionTime,
        action: actionId,
        xpEarned,
        combo: this.comboCount,
        cascadeChildrenRemaining: cascadeChildren.length,
        effect,
        resolvedBy:
          actionId === 'auto'
            ? 'auto'
            : actionId === 'resource-fixed'
              ? 'cluster-change'
              : 'player',
      });

      if (incident.cascadeChildren && incident.cascadeChildren.length >= 2) {
        this.emit('incident:cascading-resolved', {
          id: incident.id,
          cascadeCount: incident.cascadeChildren.length,
        });
      }

      // Keep the legacy secret-exposed signal used by ScoringEngine.
      if (incident.name === 'SecretExposed') {
        this.emit('secret:exposed-fixed', { id: incident.id, uid: incident.uid });
      }

      return { xpEarned, combo: this.comboCount, resolutionTime, effect };
    } finally {
      this._resolving = false;
    }
  }

  // ── Target resolution helpers ────────────────────────────────────────────
  _findResource(kind, name, namespace) {
    const state = this.cluster;
    if (!state || !kind || !name) return null;
    // Scripted data authored before the realistic node naming maps `node-N`
    // onto the cluster's `worker-0`/`worker-1`/`master-0` machine (#28).
    const legacyNodeAlias = kind === 'Node' ? NODE_NAME_ALIASES[String(name).toLowerCase()] : null;
    const candidates = legacyNodeAlias ? [name, legacyNodeAlias] : [name];
    for (const candidate of candidates) {
      if (namespace) {
        const exact = this._safe(() => state.getByName(kind, candidate, namespace));
        if (exact) return exact;
      }
      const loose = this._safe(() => state.getByName(kind, candidate));
      if (loose) return loose;
      const list = this._safe(() => state.getByKind(kind)) || [];
      const found =
        list.find((r) => r.name === candidate) || list.find((r) => r.metadata?.name === candidate);
      if (found) return found;
    }
    return null;
  }

  _resolveTargetResource(incident) {
    const resolution = incident.resolution || {};
    const kinds = [];
    if (resolution.targetKind) kinds.push(resolution.targetKind);
    for (const k of incident.affectedResourceTypes || []) if (!kinds.includes(k)) kinds.push(k);

    const namespace = incident.namespace || this.gameEngine?.currentProject || '';

    for (const kind of kinds) {
      if (!incident.target || incident.target === 'unknown') {
        const list = this._safe(() => this.cluster?.getByKind(kind)) || [];
        if (list.length > 0) return list[0];
        continue;
      }
      const found = this._findResource(kind, incident.target, namespace);
      if (found) return found;
    }

    // Last resort: look the target up by name across affected kinds without ns.
    for (const kind of kinds) {
      const list = this._safe(() => this.cluster?.getByKind(kind)) || [];
      const found = list.find((r) => r.name === incident.target);
      if (found) return found;
    }
    return null;
  }

  _findFallbackTarget(incident) {
    const kinds = incident.affectedResourceTypes || [];
    for (const kind of kinds) {
      if (kind === 'Pod') continue;
      const list = this._safe(() => this.cluster?.getByKind(kind)) || [];
      const project = this.gameEngine?.currentProject;
      const preferred = project ? list.filter((r) => r.namespace === project) : [];
      if (preferred.length > 0) return preferred[0];
      if (list.length > 0) return list[0];
    }
    const pods = this._safe(() => this.cluster?.getByKind('Pod')) || [];
    return pods.length > 0 ? pods[0] : null;
  }

  /**
   * Last-resort target creation: if no resource of the affected kinds exists
   * (fresh sandbox/chaos or a level that references a missing object), create
   * one through the kind registry so the incident is still inspectable and
   * repairable. Failures are non-fatal.
   */
  _ensureTargetResource(def, incident) {
    const state = this.cluster;
    if (!state || typeof state.addResource !== 'function') return null;
    const kinds = (def.affectedResourceTypes || []).filter((kind) => kind !== 'Pod');
    const kind = kinds[0] || (def.affectedResourceTypes || [])[0];
    if (!kind) return null;
    const project =
      this.gameEngine?.currentProject ||
      this._safe(() => state.getProjects?.()[0]?.name) ||
      'default';
    const namespace =
      this._safe(() => state.getByKind(kind)?.[0]?.namespace) ||
      ([
        'ClusterOperator',
        'ClusterVersion',
        'SecurityContextConstraints',
        'ClusterResourceQuota',
        'Project',
      ].includes(kind)
        ? ''
        : project);
    const name = `${String(kind).toLowerCase()}-incident-${this.incidentCounter}`;
    const obj = {
      metadata: {
        name,
        namespace,
        annotations: { 'openshiftgames.io/incident-target': 'true' },
      },
      spec: {},
      status: { phase: 'Pending' },
    };
    const resource = this._safe(() => state.addResource({ kind, ...obj }));
    if (resource) {
      incident.namespace = resource.namespace || resource.metadata?.namespace || namespace;
      incident.uid = resource.uid || resource.metadata?.uid || null;
    }
    return resource || null;
  }

  /** All pods "owned" by a workload-ish resource (Deployment/RS/STS/DS/Job/CronJob). */
  _workloadPods(resource) {
    const state = this.cluster;
    if (!state || !resource) return [];
    if (resource.kind === 'Pod') return [resource];
    const out = [];
    const visit = (res) => {
      if (!res) return;
      for (const child of this._safe(() => state.getChildren(res.uid)) || []) {
        if (child.kind === 'Pod') out.push(child);
        else visit(child);
      }
    };
    visit(resource);
    return out;
  }

  _pickPodForIncident(incident) {
    const target = this._resolveTargetResource(incident);
    if (!target) return null;
    let pod = null;
    if (target.kind === 'Pod') pod = target;
    else {
      const pods = this._workloadPods(target);
      if (pods.length > 0) pod = pods[0];
    }
    if (!pod) {
      const namespace = incident.namespace || target.namespace || this.gameEngine?.currentProject;
      const all = this._safe(() => this.cluster?.getByKindAndNamespace('Pod', namespace)) || [];
      pod = all.length > 0 ? all[0] : null;
    }
    if (pod) {
      // Expose the concrete Pod name so the Incident panel can render
      // `oc logs <pod>` / `oc describe pod <pod>` with the real name (GAME-016).
      incident.targetPod = pod.metadata?.name || pod.name || null;
      incident.targetPodUid = pod.uid || pod.metadata?.uid || null;
    }
    return pod;
  }

  /** Is this Pod admitted by an SCC that allows its security context? */
  _isPodAdmissible(pod) {
    if (!pod || !this.cluster) return true;
    try {
      if (typeof this.cluster.resolveSCCForPod === 'function') {
        const resolution = this.cluster.resolveSCCForPod(pod);
        // `allowed === undefined` means "no opinion": do not block the heal.
        return resolution?.allowed !== false;
      }
    } catch {
      /* fall through */
    }
    return true;
  }

  // ── Low-level mutation primitives ────────────────────────────────────────
  _annotate(resource, key, value) {
    if (!resource) return;
    if (typeof resource.setAnnotation === 'function') {
      this._safe(() => resource.setAnnotation(key, String(value)));
    } else {
      resource.metadata = resource.metadata || {};
      resource.metadata.annotations = resource.metadata.annotations || {};
      resource.metadata.annotations[key] = String(value);
    }
  }

  _clearAnnotation(resource, key) {
    if (!resource) return;
    if (typeof resource.removeAnnotation === 'function') {
      this._safe(() => resource.removeAnnotation(key));
    } else if (resource.metadata?.annotations) {
      delete resource.metadata.annotations[key];
    }
  }

  _recordEvent(resource, type, reason, message) {
    if (!resource) return;
    if (typeof resource.recordEvent === 'function') {
      this._safe(() => resource.recordEvent(type, reason, message));
    } else if (typeof resource.addEvent === 'function') {
      this._safe(() => resource.addEvent(type, reason, message));
    }
  }

  _setPhase(resource, phase) {
    if (!resource) return;
    if (typeof resource.setPhase === 'function') {
      this._safe(() => resource.setPhase(phase));
    } else {
      resource.status = resource.status || {};
      resource.status.phase = phase;
    }
  }

  _setCondition(resource, type, status, reason = '', message = '') {
    if (!resource) return;
    resource.status = resource.status || {};
    if (!Array.isArray(resource.status.conditions)) resource.status.conditions = [];
    if (typeof resource.setCondition === 'function') {
      this._safe(() => resource.setCondition(type, status, reason, message));
      return;
    }
    const next = { type, status: String(status), reason, message, lastTransitionTime: nowIso() };
    const idx = resource.status.conditions.findIndex((c) => c.type === type);
    if (idx >= 0) resource.status.conditions[idx] = next;
    else resource.status.conditions.push(next);
  }

  _isConditionTrue(resource, type) {
    if (!resource) return false;
    const conditions = resource.status?.conditions;
    if (!Array.isArray(conditions)) return false;
    if (typeof resource.isConditionTrue === 'function') {
      return this._safe(() => resource.isConditionTrue(type), false);
    }
    const cond = conditions.find((c) => c.type === type);
    return cond?.status === 'True';
  }

  _commit(resource) {
    const state = this.cluster;
    if (!state || !resource) return;
    const uid = resource.uid || resource.metadata?.uid;
    if (!uid) return;
    this._safe(() =>
      state.update(uid, {
        status: resource.status,
        spec: resource.spec,
        metadata: resource.metadata,
      })
    );
  }

  _ensureTag(imagestream, tagName, imageRef) {
    if (!imagestream) return;
    imagestream.status = imagestream.status || {};
    imagestream.status.tags = imagestream.status.tags || [];
    const ref =
      imageRef ||
      `image-registry.openshift-image-registry.svc:5000/${imagestream.namespace || 'default'}/${imagestream.name}:${tagName}`;
    const existing = imagestream.status.tags.find((t) => t.tag === tagName || t.name === tagName);
    const entry = {
      tag: tagName,
      name: tagName,
      items: [{ dockerImageReference: ref, image: ref, created: nowIso() }],
    };
    if (existing) Object.assign(existing, entry);
    else imagestream.status.tags.push(entry);
    this._commit(imagestream);
  }

  // ── ONSET: inject real damage into the cluster ───────────────────────────
  applyIncidentEffects(incident) {
    if (!incident || !this.cluster) return { applied: false };
    const target = this._resolveTargetResource(incident);
    // Some incidents damage an owner/identity instead of the named target (e.g.
    // UnauthorizedAccess targets the workload but damages its ServiceAccount's
    // bindings). Never skip damage just because the named target could not be
    // resolved: each damage function does its own lookups.
    if (!target && !incident.target) return { applied: false, reason: 'no-target' };

    const byName = {
      CrashLoopBackOff: () => this._damageCrashLoop(incident),
      ImagePullBackOff: () =>
        this._damagePod(incident, {
          phase: 'ImagePullBackOff',
          waitingReason: 'ImagePullBackOff',
          lastReason: '',
          eventReason: 'Failed',
          message: 'Failed to pull image: manifest unknown (image tag not found)',
        }),
      OOMKilled: () =>
        this._damagePod(incident, {
          phase: 'Running',
          ready: false,
          waitingReason: '',
          lastReason: 'OOMKilled',
          exitCode: 137,
          restarts: 1,
          eventReason: 'OOMKilling',
          message: 'Container exceeded its memory limit and was OOM killed',
          markPhase: 'CrashLoopBackOff',
        }),
      SCCForbidden: () => this._damageScc(incident),
      PendingScheduling: () => this._damagePendingScheduling(incident),
      CreateContainerConfigError: () =>
        this._damageConfigDependency(incident, 'CreateContainerConfigError'),
      ConfigMapMissing: () => this._damageConfigDependency(incident, 'CreateContainerConfigError'),
      SecretMissing: () => this._damageConfigDependency(incident, 'CreateContainerConfigError'),
      ReadinessProbeFailure: () => this._damageProbe(incident, 'readiness'),
      LivenessProbeFailure: () => this._damageProbe(incident, 'liveness'),
      PodStuckTerminating: () => this._damageStuckTerminating(incident),
      DeploymentStuckRollout: () => this._damageRollout(incident),
      ImageStreamTagMissing: () => this._damageImageStreamTag(incident),
      BuildFailed: () => this._damageBuild(incident),
      HPAUnableToScale: () => this._damageHpa(incident),
      JobDeadlineExceeded: () => this._damageJob(incident),
      CronJobMissedSchedule: () => this._damageCronJob(incident),
      PVCPending: () => this._damagePvc(incident),
      SecretExposed: () => this._damageSecretExposed(incident),
      ServiceNoEndpoints: () => this._damageService(incident),
      RouteNotAdmitted: () => this._damageRoute(incident, 'not-admitted'),
      RouteTLSCertificateError: () => this._damageRoute(incident, 'tls'),
      RouteHostConflict: () => this._damageRoute(incident, 'host-conflict'),
      NetworkPolicyBlocking: () => this._damageNetworkPolicy(incident),
      DNSResolutionFailure: () => this._damageDns(incident),
      IngressDegraded: () => this._damageIngress(incident),
      LoadBalancerPending: () => this._damageLoadBalancer(incident),
      UnauthorizedAccess: () => this._damageRbac(incident),
      HTPasswdAuthFailure: () => this._damageOAuth(incident),
      ResourceQuotaExceeded: () => this._damageQuota(incident),
      LimitRangeViolation: () => this._damageLimitRange(incident),
      ClusterResourceQuotaExceeded: () => this._damageClusterQuota(incident),
      NodeNotReady: () => this._damageNodeReady(incident),
      NodeDiskPressure: () => this._damageNodePressure(incident, 'DiskPressure'),
      NodeMemoryPressure: () => this._damageNodePressure(incident, 'MemoryPressure'),
      OperatorInstallFailed: () => this._damageOperator(incident),
    };

    const fn = byName[incident.name];
    const result = fn
      ? this._safe(fn, { applied: false, reason: 'damage-exception' })
      : { applied: false };
    if (target && !incident.uid) {
      incident.uid = target.uid || target.metadata?.uid || null;
      incident.namespace = target.namespace || target.metadata?.namespace || incident.namespace;
      incident.target = target.name;
    }
    return result || { applied: true };
  }

  _saveRestore(incident, value) {
    incident.restoreState = value;
  }

  _markIncident(podOrResource, incident) {
    this._annotate(podOrResource, INCIDENT_ANNOTATION, incident.name);
    this._clearAnnotation(podOrResource, HEAL_ANNOTATION);
  }

  /**
   * CrashLoopBackOff onset (#31 A1): when the level authors a `seed` env
   * contract, inject that faulty value into the workload template FIRST so the
   * broken value is part of the live cluster state (and therefore of the
   * baseline a later "did the learner fix it?" comparison uses), then damage
   * the Pods exactly as before.
   */
  _damageCrashLoop(incident) {
    this._seedIncidentEnv(incident);
    return this._damagePod(incident, {
      phase: 'CrashLoopBackOff',
      waitingReason: 'CrashLoopBackOff',
      lastReason: 'Error',
      exitCode: 1,
      restarts: 1,
      eventReason: 'BackOff',
      message: 'Back-off restarting failed container',
    });
  }

  /**
   * Write `incident.seed` into the target workload's first container: a faulty
   * env value and/or a broken image tag (#31). This makes the fault part of the
   * live cluster state BEFORE damage is applied, so the baseline a later "did
   * the learner fix it?" comparison uses includes it.
   */
  _seedIncidentEnv(incident) {
    const seed = incident?.seed;
    if ((!seed?.env?.name && !seed?.image) || incident._seedApplied) return false;
    const target = this._resolveTargetResource(incident);
    if (!target || target.kind === 'Pod') return false;
    const containers = target.spec?.template?.spec?.containers || [];
    if (containers.length === 0) return false;
    const container = containers[0];
    const changes = [];
    if (seed.image) {
      container.image = String(seed.image);
      changes.push(`image=${seed.image}`);
    }
    if (seed.env?.name) {
      container.env = Array.isArray(container.env) ? container.env : [];
      const existing = container.env.find((entry) => entry.name === seed.env.name);
      if (existing) {
        existing.value = String(seed.env.value ?? '');
        delete existing.valueFrom;
      } else {
        container.env.push({ name: seed.env.name, value: String(seed.env.value ?? '') });
      }
      changes.push(`${seed.env.name}=${seed.env.value}`);
    }
    incident._seedApplied = true;
    this._recordEvent(
      target,
      'Warning',
      'ConfigInjected',
      `Deployment is configured with ${changes.join(', ')}; the container cannot start with this configuration`
    );
    this._commit(target);
    return true;
  }

  /** Current first-container env value for the fix contract's env name. */
  _incidentEnvValue(incident, target) {
    const fix = incident?.fix;
    if (!fix?.env?.name) return null;
    const containers = target?.spec?.template?.spec?.containers || [];
    const container = containers[0];
    if (!container) return null;
    const entry = (container.env || []).find((item) => item.name === fix.env.name);
    return entry ? String(entry.value ?? '') : null;
  }

  /** Is the authored fix contract satisfied on the owning workload? */
  _incidentFixSatisfied(incident, target) {
    const fix = incident?.fix;
    if (!fix?.env?.name) return false;
    const value = this._incidentEnvValue(incident, target);
    if (value === null) return false;
    const allowed = Array.isArray(fix.env.allowed) ? fix.env.allowed.map(String) : [];
    return allowed.includes(value);
  }

  _damagePod(incident, opts) {
    const target = this._resolveTargetResource(incident);
    const pods = [];
    if (target && target.kind !== 'Pod') {
      pods.push(...this._workloadPods(target));
    } else {
      const pod = this._pickPodForIncident(incident);
      if (pod) pods.push(pod);
    }
    if (pods.length === 0) {
      // No pod available: mark the workload so the incident is still visible/repairable.
      if (target) {
        this._markIncident(target, incident);
        this._recordEvent(target, 'Warning', 'IncidentInjected', incident.description);
        this._commit(target);
      }
      return { applied: false, reason: 'no-pod' };
    }

    // A broken image/command/config crash-loops EVERY replica of the workload,
    // not just one Pod (and `oc logs` on the workload must show the same crash).
    incident.damageSpec = { ...opts };
    for (const pod of pods) this._damagePodObject(incident, pod, opts);

    // Also flag the owning Deployment when relevant so the card targets a visible object.
    if (target && target.kind !== 'Pod') {
      this._markIncident(target, incident);
      if (
        typeof target.kind === 'string' &&
        (target.kind === 'Deployment' || target.kind === 'ReplicaSet')
      ) {
        this._setCondition(
          target,
          'Available',
          'False',
          'MinimumReplicasUnavailable',
          'The workload has unavailable replicas'
        );
      }
      this._commit(target);
      // Snapshot the template/generation AFTER the onset commit (update()
      // bumps generation); a later real fix (oc set image, oc edit, rollout
      // undo) changes it and is treated as the remediation even though the
      // damaged pod object itself cannot recover (GAME-006). `containers` is a
      // semantic fingerprint: a `oc rollout restart` annotation change must NOT
      // count as a fix — only image/command/env/securityContext changes do.
      // Never overwrite an existing onset baseline: damage-retry or a later
      // re-damage must not make the (already fixed) template look "broken".
      if (!incident.baseline?.workload) {
        incident.baseline = incident.baseline || {};
        incident.baseline.workload = {
          uid: target.uid || target.metadata?.uid || null,
          generation: Number(target.metadata?.generation ?? 1),
          template: this._safe(() => JSON.stringify(target.spec?.template || {}), '') || '',
          containers: this._safe(() => this._containerSemanticSignature(target), '') || '',
        };
      }
    } else {
      for (const pod of pods) this._markIncident(pod, incident);
    }
    for (const pod of pods) this._commit(pod);
    return {
      applied: true,
      kind: 'pod',
      target: incident.targetPod || pods[0].name,
      pods: pods.length,
    };
  }

  /**
   * Bind an unbound Pod to a schedulable Node before the incident damages it.
   *
   * A CrashLoopBackOff/ImagePullBackOff Pod must have been scheduled by the
   * kubelet: it has `spec.nodeName`, `status.hostIP`/`podIP`, `startTime` and a
   * `Scheduled` event. Controller-created Pods are bound by
   * SimulationTick._tickPodScheduling, but a `triggerTime: 0` preload can run
   * its damage pass BEFORE that scheduler tick (#23: crash-looping
   * payment-service Pods showed `Node: <none>` in get/describe). Bind them here
   * using the simulator's own picker so the placement matches normal scheduling;
   * fall back to the first Ready, uncordoned Node (name-sorted, deterministic).
   *
   * Mutates the Pod only — the caller commits it with the damage, so this never
   * re-enters the cluster:modified watcher mid-onset.
   */
  _bindDamagedPodToNode(pod) {
    if (!pod || pod.spec?.nodeName) return null;
    const cluster = this.cluster;
    if (!cluster || typeof cluster.getByKind !== 'function') return null;
    const nodes = this._safe(() => cluster.getByKind('Node'), []) || [];
    if (nodes.length === 0) return null;

    const simulation = this.gameEngine?.simulation || null;
    let node = null;
    if (simulation && typeof simulation._findBestNode === 'function') {
      node = this._safe(() => simulation._findBestNode(pod, nodes), null);
    }
    if (!node) {
      node =
        nodes
          .filter(
            (candidate) =>
              candidate &&
              candidate.status?.phase !== 'Terminating' &&
              candidate.spec?.unschedulable !== true &&
              !candidate.isCordon &&
              (typeof candidate.isConditionTrue === 'function'
                ? candidate.isConditionTrue('Ready')
                : true)
          )
          .sort((left, right) =>
            String(left.metadata?.name || left.name || '').localeCompare(
              String(right.metadata?.name || right.name || '')
            )
          )[0] || null;
    }
    if (!node) return null;
    const nodeName = node.metadata?.name || node.name;
    if (!nodeName) return null;

    const podName = pod.metadata?.name || pod.name || 'pod';
    const namespace = pod.metadata?.namespace || pod.namespace || 'default';
    pod.spec = pod.spec || {};
    pod._nodeBound = true;
    pod.spec.nodeName = nodeName;
    pod.status = pod.status || {};
    pod.status.startTime = pod.status.startTime || nowIso();
    pod.status.hostIP = pod.status.hostIP || node.status?.addresses?.[0]?.address || '10.0.0.1';
    if (!pod.status.podIP) {
      const generated =
        simulation && typeof simulation._generatePodIP === 'function'
          ? this._safe(() => simulation._generatePodIP(), null)
          : null;
      pod.status.podIP = generated || '10.244.0.10';
    }
    const message = `Successfully assigned ${namespace}/${podName} to ${nodeName}`;
    if (typeof pod.setCondition === 'function') {
      pod.setCondition('PodScheduled', 'True', 'Scheduled', message);
      pod.setCondition('Initialized', 'True', 'PodInitialized');
    }
    if (typeof pod.recordEvent === 'function') {
      pod.recordEvent('Normal', 'Scheduled', message);
    }
    return nodeName;
  }

  /** Mutate one Pod's container status + per-Pod crash log annotations. */
  _damagePodObject(incident, pod, opts) {
    if (!pod) return;
    // #23: a crash-looping/pulling Pod must have been scheduled. Only skip
    // binding for the unschedulable-Pending flavour (PendingScheduling's
    // fallback damage), which is *supposed* to have no node.
    const unschedulablePending = opts?.phase === 'Pending' && !opts?.waitingReason;
    if (!unschedulablePending) this._safe(() => this._bindDamagedPodToNode(pod));
    const containers = pod.status?.containerStatuses || [];
    const first = containers[0] || {
      name: 'main',
      ready: true,
      started: true,
      state: {},
      lastState: {},
      restartCount: 0,
    };
    const newState = { ...first };
    newState.ready = opts.ready ?? false;
    newState.started = false;
    newState.restartCount = (first.restartCount || opts.restarts || 0) + (opts.restarts ? 1 : 0);

    if (opts.waitingReason) {
      newState.state = { waiting: { reason: opts.waitingReason, message: opts.message || '' } };
    } else if (opts.ready === false) {
      newState.state = { running: { startedAt: newState.runningStart || nowIso() } };
    }
    if (opts.lastReason) {
      newState.lastState = {
        terminated: {
          exitCode: opts.exitCode ?? 1,
          reason: opts.lastReason,
          message: opts.message || '',
          finishedAt: nowIso(),
        },
      };
    }
    pod.status = pod.status || {};
    pod.status.containerStatuses =
      containers.length > 0 ? [newState, ...containers.slice(1)] : [newState];
    this._setPhase(pod, opts.markPhase || opts.phase || pod.status.phase || 'Running');
    this._setCondition(
      pod,
      'Ready',
      'False',
      'ContainersNotReady',
      opts.message || 'Container is not ready'
    );
    this._setCondition(pod, 'ContainersReady', 'False', 'ContainersNotReady', opts.message || '');
    this._recordEvent(
      pod,
      'Warning',
      opts.eventReason || 'BackOff',
      opts.message || incident.description
    );
    // Real `oc logs` output for THIS Pod (cli reads these annotations).
    this._applyPodLogAnnotations(incident, pod);
    // Expose the concrete Pod name for the panel's investigation commands.
    if (!incident.targetPod) {
      incident.targetPod = pod.metadata?.name || pod.name || null;
      incident.targetPodUid = pod.uid || pod.metadata?.uid || null;
    }
    this._markIncident(pod, incident);
  }

  /** Resolve the owning workload name (Deployment/StatefulSet/...) for a Pod. */
  _workloadNameForPod(pod) {
    if (!pod) return '';
    let current = pod;
    for (let depth = 0; depth < 4; depth += 1) {
      const ref = (current?.metadata?.ownerReferences || [])[0];
      if (!ref?.kind || !ref?.name) break;
      if (ref.kind !== 'ReplicaSet' && ref.kind !== 'ReplicationController') return ref.name;
      const owner =
        this._safe(() => this.cluster?.get?.(ref.uid)) ||
        this._findResource(ref.kind, ref.name, current?.namespace || current?.metadata?.namespace);
      if (!owner) return ref.name;
      current = owner;
      if (ref.kind === 'ReplicaSet') {
        const next = (owner?.metadata?.ownerReferences || [])[0];
        if (next?.name) return next.name;
      }
    }
    return current?.metadata?.name || '';
  }

  /**
   * Write `oc logs` content for the damaged Pod from the incident definition's
   * `logs` profile (tokens <pod> <deployment> <image> <namespace> substituted
   * from the live object). cli's CommandBar renders these for `oc logs` /
   * `oc logs --previous` instead of a generic synthetic crash log.
   */
  _applyPodLogAnnotations(incident, pod) {
    if (!pod) return;
    const def = this._defsById.get(incident.defId) || null;
    const profile = def?.logs;
    if (!profile) return;
    const containers = pod.spec?.containers || [];
    // Prefer the Pod's ACTUAL container name: deployments created from literal
    // manifests (e.g. L20 webapp uses `name: webapp`) are not `main`, and the cli
    // only applies these logs when the requested container matches.
    let container = profile.container;
    if (
      container &&
      containers.length > 0 &&
      !containers.some((entry) => entry.name === container)
    ) {
      container = '';
    }
    container =
      container ||
      containers[0]?.name ||
      (pod.status?.containerStatuses || [])[0]?.name ||
      profile.container ||
      'main';
    const podName = pod.metadata?.name || pod.name || incident.target || 'pod';
    const containerSpec =
      containers.find((entry) => entry.name === container) || containers[0] || {};
    const image = containerSpec.image || (pod.status?.containerStatuses || [])[0]?.image || '';
    const workloadName = this._workloadNameForPod(pod) || incident.target || podName;
    const namespace = pod.namespace || pod.metadata?.namespace || incident.namespace || '';
    const substitute = (line) =>
      String(line)
        .replace(/<pod>/g, podName)
        .replace(/<deployment>/g, workloadName)
        .replace(/<image>/g, image)
        .replace(/<namespace>/g, namespace);
    const current = Array.isArray(profile.current) ? profile.current.map(substitute) : null;
    const previous = Array.isArray(profile.previous) ? profile.previous.map(substitute) : null;
    if (current) this._annotate(pod, 'openshiftgames.io/logs', JSON.stringify(current));
    if (previous) this._annotate(pod, 'openshiftgames.io/logs-previous', JSON.stringify(previous));
    this._annotate(pod, 'openshiftgames.io/logs-container', container);
  }

  _clearPodLogAnnotations(pod) {
    for (const key of [
      'openshiftgames.io/logs',
      'openshiftgames.io/logs-previous',
      'openshiftgames.io/logs-container',
    ]) {
      this._clearAnnotation(pod, key);
    }
  }

  /**
   * Semantic container fingerprint of a workload template. Deliberately ignores
   * Pod-template metadata (e.g. `kubectl.kubernetes.io/restartedAt` added by
   * `oc rollout restart`) and replica counts, so "restart until green" does not
   * count as fixing a CrashLoopBackOff.
   */
  _containerSemanticSignature(resource) {
    const containers = resource?.spec?.template?.spec?.containers || [];
    return JSON.stringify(
      containers.map((container) => ({
        name: container.name,
        image: container.image,
        command: container.command,
        args: container.args,
        env: container.env,
        envFrom: container.envFrom,
        resources: container.resources,
        securityContext: container.securityContext,
      }))
    );
  }

  _damageConfigDependency(incident, waitingReason) {
    const target = this._resolveTargetResource(incident);
    // If the target itself is a ConfigMap/Secret: remove the data so the reference breaks.
    if (target && (target.kind === 'ConfigMap' || target.kind === 'Secret')) {
      this._saveRestore(incident, {
        kind: target.kind,
        uid: target.uid,
        data: JSON.parse(JSON.stringify(target.data || target.spec?.data || {})),
      });
      if (target.spec && target.spec.data) target.spec.data = {};
      this._markIncident(target, incident);
      this._recordEvent(
        target,
        'Warning',
        'ReferenceBroken',
        `Workload references ${target.kind}/${target.name} but the required key is missing`
      );
      this._commit(target);
    }
    return this._damagePod(incident, {
      phase: 'Pending',
      ready: false,
      waitingReason,
      eventReason: 'Failed',
      message:
        waitingReason === 'CreateContainerConfigError'
          ? `configmap "${incident.target}" not found`
          : incident.description,
      markPhase: 'Pending',
    });
  }

  /**
   * SCC admission failure. With the real OCP 4.x model the rejected Pod is
   * never created: the owning Deployment/ReplicaSet reports
   * ReplicaFailure/FailedCreate and `oc get pods` stays empty. Mark the workload
   * (and the ServiceAccount identity) — do NOT fail/deny or auto-heal Pods, and
   * never auto-grant the SCC (that is the learner's `oc adm policy` step).
   */
  _damageScc(incident) {
    const target = this._resolveTargetResource(incident);
    // Resolve the workload's ServiceAccount (dedicated SA preferred over default).
    let saName = null;
    let saNamespace = incident.namespace || '';
    const podSpec = target?.spec?.template?.spec || (target?.kind === 'Pod' ? target.spec : null);
    if (podSpec) {
      saName = podSpec.serviceAccountName || podSpec.serviceAccount || 'default';
    }
    if (!saName) {
      const pods = target ? this._workloadPods(target) : [];
      if (pods.length > 0) saName = pods[0]?.spec?.serviceAccountName || 'default';
    }
    saName = saName || 'default';
    const sa = this._findResource('ServiceAccount', saName, saNamespace);
    if (sa) {
      saNamespace = sa.namespace || sa.metadata?.namespace || saNamespace;
      this._markIncident(sa, incident);
      this._commit(sa);
    }
    incident.rbacSubject = {
      kind: 'ServiceAccount',
      name: saName,
      namespace: saNamespace,
    };

    if (target && target.kind !== 'Pod' && target.kind !== 'ServiceAccount') {
      this._setCondition(
        target,
        'Available',
        'False',
        'MinimumReplicasUnavailable',
        'Pods rejected by security context constraints'
      );
      this._setCondition(
        target,
        'ReplicaFailure',
        'True',
        'FailedCreate',
        'pods is forbidden: unable to validate against any security context constraint'
      );
      this._recordEvent(
        target,
        'Warning',
        'FailedCreate',
        `Error creating: pods "${incident.target}-${incident.id}" is forbidden: unable to validate against any security context constraint: [provider restricted-v2: .securityContext.privileged: Forbidden]`
      );
      this._markIncident(target, incident);
      this._commit(target);
    }
    return {
      applied: !!target || !!sa,
      kind: 'pod',
      scc: incident.resolution?.grantScc || 'privileged',
      serviceAccount: incident.rbacSubject,
    };
  }

  _damagePendingScheduling(incident) {
    const pod = this._pickPodForIncident(incident);
    if (!pod)
      return this._damagePod(incident, {
        phase: 'Pending',
        markPhase: 'Pending',
        eventReason: 'FailedScheduling',
        message: 'No nodes available',
      });
    this._saveRestore(incident, {
      uid: pod.uid,
      nodeName: pod.spec?.nodeName || null,
      nodeSelector: pod.spec?.nodeSelector
        ? JSON.parse(JSON.stringify(pod.spec.nodeSelector))
        : null,
    });
    if (pod.spec) {
      pod.spec.nodeName = null;
      pod.spec.nodeSelector = { 'openshiftgames.io/incident': 'no-such-label' };
    }
    this._setPhase(pod, 'Pending');
    this._setCondition(
      pod,
      'PodScheduled',
      'False',
      'Unschedulable',
      "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/anti-affinity."
    );
    this._recordEvent(
      pod,
      'Warning',
      'FailedScheduling',
      "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/anti-affinity."
    );
    this._markIncident(pod, incident);
    this._commit(pod);
    return { applied: true, kind: 'pod', target: pod.name };
  }

  _damageProbe(incident, probeType) {
    const pod = this._pickPodForIncident(incident);
    if (!pod)
      return this._damagePod(incident, {
        phase: 'Running',
        ready: false,
        eventReason: 'Unhealthy',
        message: `${probeType} probe failed`,
      });
    const containers = pod.status?.containerStatuses || [];
    const first = { ...(containers[0] || {}) };
    first.ready = false;
    first.started = true;
    if (probeType === 'liveness') {
      first.state = { waiting: { reason: 'CrashLoopBackOff', message: 'Liveness probe failed' } };
      first.lastState = {
        terminated: { exitCode: 137, reason: 'LivenessProbeFailure', finishedAt: nowIso() },
      };
      first.restartCount = (first.restartCount || 0) + 1;
    } else {
      first.state = { running: { startedAt: nowIso() } };
    }
    pod.status = pod.status || {};
    pod.status.containerStatuses = [first, ...containers.slice(1)];
    this._setPhase(pod, probeType === 'liveness' ? 'CrashLoopBackOff' : 'Running');
    this._setCondition(pod, 'Ready', 'False', 'ContainersNotReady', `${probeType} probe failed`);
    this._recordEvent(
      pod,
      'Warning',
      'Unhealthy',
      `${probeType} probe failed for container ${first.name || 'main'}`
    );
    this._markIncident(pod, incident);

    const target = this._resolveTargetResource(incident);
    if (target && target.kind !== 'Pod') {
      this._markIncident(target, incident);
      this._commit(target);
    }
    this._commit(pod);
    return { applied: true, kind: 'pod', target: pod.name };
  }

  _damageStuckTerminating(incident) {
    const pod = this._pickPodForIncident(incident);
    if (!pod) return { applied: false };
    pod.metadata = pod.metadata || {};
    pod.metadata.deletionTimestamp = nowIso();
    if (!pod.metadata.finalizers) pod.metadata.finalizers = [];
    if (!pod.metadata.finalizers.includes('openshiftgames.io/incident-hold')) {
      pod.metadata.finalizers.push('openshiftgames.io/incident-hold');
    }
    this._setPhase(pod, 'Terminating');
    this._recordEvent(
      pod,
      'Warning',
      'FailedKillPod',
      'Pod is stuck terminating because a finalizer is not being removed'
    );
    this._markIncident(pod, incident);
    this._commit(pod);
    return { applied: true, kind: 'pod', target: pod.name };
  }

  _damageRollout(incident) {
    const deploy =
      this._resolveTargetResource(incident) ||
      this._findResource('Deployment', incident.target, incident.namespace);
    if (!deploy) return { applied: false };
    this._saveRestore(incident, {
      uid: deploy.uid,
      template: JSON.parse(JSON.stringify(deploy.spec?.template || {})),
    });
    // Break the newest pod template so the rollout cannot converge.
    if (deploy.spec?.template?.spec?.containers?.[0]) {
      deploy.spec.template.spec.containers[0].image =
        'image-registry.openshift-image-registry.svc:5000/openshift/broken-builder:not-found';
    }
    this._setCondition(
      deploy,
      'Progressing',
      'False',
      'ProgressDeadlineExceeded',
      'ReplicaSet has timed out progressing.'
    );
    this._setCondition(
      deploy,
      'Available',
      'False',
      'MinimumReplicasUnavailable',
      'Deployment does not have minimum availability.'
    );
    this._recordEvent(
      deploy,
      'Warning',
      'FailedCreate',
      'Error creating: pods ...: ImagePullBackOff'
    );
    this._markIncident(deploy, incident);
    this._commit(deploy);
    return { applied: true, kind: 'deployment', target: deploy.name };
  }

  _damageImageStreamTag(incident) {
    const target = this._resolveTargetResource(incident);
    const stream =
      target && target.kind === 'ImageStream'
        ? target
        : this._findResource('ImageStream', incident.target, incident.namespace) ||
          (this._safe(() => this.cluster?.getByKind('ImageStream')) || [])[0];
    if (!stream) return { applied: false };
    this._saveRestore(incident, {
      uid: stream.uid,
      tags: JSON.parse(JSON.stringify(stream.status?.tags || [])),
    });
    stream.status = stream.status || {};
    stream.status.tags = [];
    this._markIncident(stream, incident);
    this._recordEvent(
      stream,
      'Warning',
      'ImageStreamTagNotFound',
      `imagestreamtag "${incident.target}" not found`
    );
    this._commit(stream);
    return { applied: true, kind: 'imagestream', target: stream.name };
  }

  _damageBuild(incident) {
    const target = this._resolveTargetResource(incident);
    let build = target && target.kind === 'Build' ? target : null;
    if (!build) {
      const builds = this._safe(() => this.cluster?.getByKind('Build')) || [];
      build = builds.find((b) => b.name === incident.target) || builds[0] || null;
    }
    if (!build) {
      // BuildConfig target: mark the last build/status as failed.
      const bc = this._findResource('BuildConfig', incident.target, incident.namespace);
      if (bc) {
        this._markIncident(bc, incident);
        this._setCondition(bc, 'BuildFailed', 'True', 'BuildFailed', 'The last build failed');
        this._commit(bc);
        return { applied: true, kind: 'buildconfig', target: bc.name };
      }
      return { applied: false };
    }
    build.status = build.status || {};
    build.status.phase = 'Failed';
    build.status.reason = 'GenericBuildFailed';
    build.status.message = 'build failed: source clone failed / builder image unavailable';
    build.status.completionTimestamp = nowIso();
    this._markIncident(build, incident);
    this._recordEvent(build, 'Warning', 'BuildFailed', build.status.message);
    this._commit(build);
    return { applied: true, kind: 'build', target: build.name };
  }

  _damageHpa(incident) {
    const hpa =
      this._resolveTargetResource(incident) ||
      this._findResource('HorizontalPodAutoscaler', incident.target, incident.namespace);
    if (!hpa) return { applied: false };
    this._setCondition(
      hpa,
      'AbleToScale',
      'False',
      'FailedGetResourceMetric',
      'failed to get cpu utilization: unable to get metrics for resource cpu'
    );
    this._setCondition(
      hpa,
      'ScalingActive',
      'False',
      'FailedGetResourceMetric',
      'the HPA was unable to compute the replica count'
    );
    this._recordEvent(hpa, 'Warning', 'FailedGetResourceMetric', 'failed to get cpu utilization');
    this._markIncident(hpa, incident);
    this._commit(hpa);
    return { applied: true, kind: 'hpa', target: hpa.name };
  }

  _damageJob(incident) {
    const job =
      this._resolveTargetResource(incident) ||
      this._findResource('Job', incident.target, incident.namespace);
    if (!job) return { applied: false };
    this._saveRestore(incident, {
      uid: job.uid,
      name: job.name,
      namespace: job.namespace || incident.namespace,
      spec: JSON.parse(JSON.stringify(job.spec || {})),
      activeDeadlineSeconds: job.spec?.activeDeadlineSeconds ?? null,
      containers: this._safe(() => this._containerSemanticSignature(job), '') || '',
    });
    job.status = job.status || {};
    job.status.phase = 'Failed';
    job.status.conditions = [
      {
        type: 'Failed',
        status: 'True',
        reason: 'DeadlineExceeded',
        message: 'Job was active longer than specified deadline',
        lastTransitionTime: nowIso(),
      },
    ];
    this._setCondition(
      job,
      'Failed',
      'True',
      'DeadlineExceeded',
      'Job was active longer than specified deadline'
    );
    this._markIncident(job, incident);
    this._recordEvent(
      job,
      'Warning',
      'DeadlineExceeded',
      'Job was active longer than specified deadline'
    );
    this._commit(job);
    return { applied: true, kind: 'job', target: job.name };
  }

  _damageCronJob(incident) {
    const cron =
      this._resolveTargetResource(incident) ||
      this._findResource('CronJob', incident.target, incident.namespace);
    if (!cron) return { applied: false };
    this._saveRestore(incident, { uid: cron.uid, suspend: cron.spec?.suspend ?? false });
    if (cron.spec) cron.spec.suspend = true;
    cron.status = cron.status || {};
    cron.status.active = [];
    this._recordEvent(
      cron,
      'Warning',
      'Suspended',
      'CronJob has been suspended; no Jobs will be created'
    );
    this._markIncident(cron, incident);
    this._commit(cron);
    return { applied: true, kind: 'cronjob', target: cron.name };
  }

  _damagePvc(incident) {
    const pvc =
      this._resolveTargetResource(incident) ||
      this._findResource('PersistentVolumeClaim', incident.target, incident.namespace);
    if (!pvc) return { applied: false };
    this._saveRestore(incident, { uid: pvc.uid, volumeName: pvc.spec?.volumeName || null });
    if (pvc.spec) pvc.spec.volumeName = null;
    this._setPhase(pvc, 'Pending');
    this._recordEvent(
      pvc,
      'Warning',
      'ProvisioningFailed',
      'no persistent volumes available for this claim and no storage class is set'
    );
    this._markIncident(pvc, incident);
    this._commit(pvc);
    return { applied: true, kind: 'pvc', target: pvc.name };
  }

  _damageSecretExposed(incident) {
    const secret = this._resolveTargetResource(incident);
    const resource =
      secret ||
      this._findResource('Secret', incident.target, incident.namespace) ||
      this._findResource('ConfigMap', incident.target, incident.namespace);
    if (!resource) return { applied: false };
    this._annotate(resource, 'openshiftgames.io/exposed', 'true');
    this._markIncident(resource, incident);
    this._recordEvent(
      resource,
      'Warning',
      'CredentialExposed',
      'Sensitive value found in a readable object; rotate the credential'
    );
    this._commit(resource);
    return { applied: true, kind: 'secret', target: resource.name };
  }

  _damageService(incident) {
    const svc =
      this._resolveTargetResource(incident) ||
      this._findResource('Service', incident.target, incident.namespace);
    if (!svc) return { applied: false };
    this._saveRestore(incident, {
      uid: svc.uid,
      selector: JSON.parse(JSON.stringify(svc.spec?.selector || {})),
    });
    if (svc.spec) svc.spec.selector = { 'openshiftgames.io/incident': 'no-matching-pods' };
    this._recordEvent(
      svc,
      'Warning',
      'EndpointsNotFound',
      'Endpoints not found for the service selector'
    );
    this._markIncident(svc, incident);
    this._commit(svc);
    return { applied: true, kind: 'service', target: svc.name };
  }

  _damageRoute(incident, mode) {
    const route =
      this._resolveTargetResource(incident) ||
      this._findResource('Route', incident.target, incident.namespace);
    if (!route) return { applied: false };
    route.status = route.status || {};
    const host =
      route.spec?.host ||
      `${route.name}-${route.namespace || incident.namespace || 'default'}.apps.cluster.example.com`;
    const save = {
      uid: route.uid,
      host: route.spec?.host || '',
      tls: JSON.parse(JSON.stringify(route.spec?.tls || {})),
    };
    this._saveRestore(incident, save);

    if (mode === 'host-conflict') {
      if (route.spec) route.spec.host = 'conflict.apps.cluster.example.com';
      this._recordEvent(
        route,
        'Warning',
        'HostAlreadyClaimed',
        `route "${route.name}" host "conflict.apps.cluster.example.com" is already claimed by another namespace`
      );
    } else if (mode === 'tls') {
      this._annotate(
        route,
        'openshiftgames.io/tls-error',
        'certificate SAN does not match route host'
      );
      this._recordEvent(
        route,
        'Warning',
        'CertificateError',
        'certificate is not valid for the requested host'
      );
    } else {
      this._recordEvent(route, 'Warning', 'ServiceUnavailable', 'no endpoints available');
    }

    route.status.ingress = [
      {
        host,
        routerName: 'default',
        wildcardPolicy: 'None',
        conditions: [
          {
            type: 'Admitted',
            status: 'False',
            reason:
              mode === 'host-conflict'
                ? 'HostAlreadyClaimed'
                : mode === 'tls'
                  ? 'CertificateError'
                  : 'ServiceUnavailable',
            message:
              mode === 'host-conflict'
                ? 'host already claimed'
                : mode === 'tls'
                  ? 'bad certificate'
                  : 'no endpoints available',
            lastTransitionTime: nowIso(),
          },
        ],
      },
    ];
    this._markIncident(route, incident);
    this._commit(route);
    return { applied: true, kind: 'route', target: route.name };
  }

  _damageNetworkPolicy(incident) {
    const policy =
      this._resolveTargetResource(incident) ||
      this._findResource('NetworkPolicy', incident.target, incident.namespace);
    if (!policy) return { applied: false };
    this._saveRestore(incident, {
      uid: policy.uid,
      podSelector: JSON.parse(JSON.stringify(policy.spec?.podSelector || {})),
      policyTypes: JSON.parse(JSON.stringify(policy.spec?.policyTypes || ['Ingress'])),
      ingress: JSON.parse(JSON.stringify(policy.spec?.ingress || [])),
      egress: JSON.parse(JSON.stringify(policy.spec?.egress || [])),
    });
    if (policy.spec) {
      policy.spec.podSelector = { matchLabels: {} };
      policy.spec.policyTypes = ['Ingress', 'Egress'];
      policy.spec.ingress = [];
      policy.spec.egress = [];
    }
    this._recordEvent(
      policy,
      'Warning',
      'TrafficDenied',
      'default-deny policy blocks all ingress/egress traffic for selected pods'
    );
    this._markIncident(policy, incident);
    this._commit(policy);
    if (typeof policy.updateAffectedPods === 'function') {
      this._safe(() =>
        policy.updateAffectedPods(
          this.cluster.getByKindAndNamespace('Pod', incident.namespace) || []
        )
      );
    }
    return { applied: true, kind: 'networkpolicy', target: policy.name };
  }

  _damageDns(incident) {
    const dnsPods =
      this._safe(() => this.cluster?.getByKindAndNamespace('Pod', 'openshift-dns')) || [];
    for (const pod of dnsPods) {
      this._setPhase(pod, 'CrashLoopBackOff');
      this._setCondition(
        pod,
        'Ready',
        'False',
        'ContainersNotReady',
        'DNS resolver is unavailable'
      );
      this._recordEvent(pod, 'Warning', 'Unhealthy', 'CoreDNS container is not ready');
      this._markIncident(pod, incident);
      this._commit(pod);
    }
    const target = this._resolveTargetResource(incident);
    if (target) {
      this._markIncident(target, incident);
      this._commit(target);
    }
    const co = this._safe(() => this.cluster.getClusterOperator?.('dns'));
    if (co) {
      this._setCondition(
        co,
        'Degraded',
        'True',
        'DNSUnavailable',
        'In-cluster DNS resolution is failing'
      );
      this._commit(co);
    }
    // The incident is "real" even when no dns-default Pods are seeded: the
    // target Service and the DNS ClusterOperator carry the degraded state.
    return { applied: dnsPods.length > 0 || !!target || !!co, kind: 'dns', pods: dnsPods.length };
  }

  _damageIngress(incident) {
    const co =
      this._safe(() => this.cluster.getClusterOperator?.('ingress')) ||
      this._findResource('ClusterOperator', 'ingress', '') ||
      this._findResource('ClusterOperator', incident.target, '');
    if (co) {
      this._setCondition(
        co,
        'Degraded',
        'True',
        'IngressDegraded',
        'The ingress operator is reporting a degraded router deployment'
      );
      this._setCondition(co, 'Available', 'True', 'IngressAvailable', '');
      this._markIncident(co, incident);
      this._commit(co);
    }
    const target = this._resolveTargetResource(incident);
    if (target && target !== co) {
      this._markIncident(target, incident);
      this._commit(target);
    }
    return { applied: !!co };
  }

  _damageLoadBalancer(incident) {
    const svc =
      this._resolveTargetResource(incident) ||
      this._findResource('Service', incident.target, incident.namespace);
    if (!svc) return { applied: false };
    svc.status = svc.status || {};
    svc.status.loadBalancer = { ingress: [] };
    this._annotate(svc, 'openshiftgames.io/lb-pending', 'true');
    this._recordEvent(
      svc,
      'Warning',
      'PendingLoadBalancer',
      'load balancer has not been provisioned yet'
    );
    this._markIncident(svc, incident);
    this._commit(svc);
    return { applied: true, kind: 'service', target: svc.name };
  }

  _damageRbac(incident) {
    const sa =
      this._findResource('ServiceAccount', incident.target, incident.namespace) ||
      this._findResource('ServiceAccount', 'default', incident.namespace) ||
      (this._safe(() =>
        this.cluster?.getByKindAndNamespace('ServiceAccount', incident.namespace)
      ) || [])[0];
    const removed = [];
    if (sa) {
      incident.namespace = sa.namespace || sa.metadata?.namespace || incident.namespace;
      incident.rbacSubject = {
        kind: 'ServiceAccount',
        name: sa.name,
        namespace: incident.namespace,
      };
      const bindings =
        this._safe(() => this.cluster?.getByKindAndNamespace('RoleBinding', incident.namespace)) ||
        this._safe(() => this.cluster?.getByKind('RoleBinding')) ||
        [];
      const saUser = `system:serviceaccount:${sa.namespace}:${sa.name}`;
      for (const rb of bindings) {
        const subjects = rb.spec?.subjects || rb.subjects || [];
        if (
          !subjects.some((s) =>
            s.kind === 'ServiceAccount'
              ? `system:serviceaccount:${s.namespace || sa.namespace}:${s.name}` === saUser
              : s.name === saUser
          )
        )
          continue;
        removed.push(
          JSON.parse(
            JSON.stringify({
              uid: rb.uid,
              kind: rb.kind,
              name: rb.name,
              namespace: rb.namespace,
              spec: rb.spec,
              metadata: { name: rb.name, namespace: rb.namespace },
            })
          )
        );
        this._safe(() => this.cluster.remove(rb.uid));
      }
      this._markIncident(sa, incident);
      this._recordEvent(
        sa,
        'Warning',
        'Forbidden',
        `User "system:serviceaccount:${incident.namespace}:${sa.name}" cannot get resource "pods": RBAC binding removed`
      );
      this._commit(sa);
    }
    this._saveRestore(incident, { removedBindings: removed });
    const target = this._resolveTargetResource(incident);
    if (target && target.kind === 'Pod') {
      this._setPhase(target, 'Running');
      this._recordEvent(
        target,
        'Warning',
        'Forbidden',
        'the server responded with 403 Forbidden: User cannot get resource "pods"'
      );
      this._commit(target);
    }
    return { applied: removed.length > 0 || !!sa, removedBindings: removed.length };
  }

  _damageOAuth(incident) {
    const provider = this._safe(() => this.cluster.getAuthProviderConfig?.()) || null;
    const providerConfig = provider ||
      this.gameEngine?.authProvider || {
        type: 'HTPasswd',
        name: 'htpasswd',
        secretName: 'htpasswd-secret',
        namespace: 'openshift-config',
      };
    if (this.gameEngine) {
      this.gameEngine.authProvider = { ...providerConfig, ready: false };
    }
    // Make the fault durable: the described symptom is a broken htpasswd
    // Secret, so actually remove its `htpasswd` key (restored on heal) instead
    // of relying on a provider flag that the OAuth rollout would reset (GAME-003).
    const secretName = providerConfig?.secretName || 'htpasswd-secret';
    const secret = this._findResource('Secret', secretName, 'openshift-config');
    if (secret) {
      const data = JSON.parse(JSON.stringify(secret.spec?.data || secret.data || {}));
      this._saveRestore(incident, {
        ...(incident.restoreState || {}),
        oauthSecret: { uid: secret.uid, name: secretName, data },
      });
      if (secret.spec) secret.spec.data = {};
      else secret.data = {};
      this._markIncident(secret, incident);
      this._recordEvent(
        secret,
        'Warning',
        'InvalidHTPasswdSecret',
        `Secret "${secretName}" is missing the required "htpasswd" key`
      );
      this._commit(secret);
    }
    const oauth =
      this._safe(() => this.cluster.getOAuth?.()) || this._findResource('OAuth', 'cluster', '');
    if (oauth) {
      this._setCondition(
        oauth,
        'Available',
        'False',
        'OAuthServerNotReady',
        'The authentication operator is not ready; oc login is rejected'
      );
      this._recordEvent(oauth, 'Warning', 'LoginFailed', 'HTPasswd identity provider is not ready');
      this._markIncident(oauth, incident);
      this._commit(oauth);
    }
    const co = this._safe(() => this.cluster.getClusterOperator?.('authentication'));
    if (co) {
      this._setCondition(
        co,
        'Degraded',
        'True',
        'OAuthServerNotReady',
        'The authentication operator is not ready'
      );
      this._commit(co);
    }
    return { applied: !!oauth || !!co || !!secret };
  }

  /**
   * Quota-exceeded onset damage (#27b + #31 A2).
   *
   * The truthful model: the project's quota is exactly full, so the owning
   * controller cannot create the replacement Pod. We do NOT rewrite a Pod to
   * Pending/FailedCreate (that object would not exist on a real cluster): one
   * deterministic Running Pod owned by a Deployment/ReplicaSet is removed and
   * the quota's `pods` hard limit is set to the post-removal usage, i.e.
   * Used == Hard. The quota-level Exceeded condition/event is what the learner
   * sees; raising the hard limits (or deleting workloads) makes room and the
   * controller schedules the replacement again.
   */
  _damageQuota(incident) {
    const ns = incident.namespace || this.gameEngine?.currentProject || 'default';
    const resolved = this._resolveTargetResource(incident);
    const quotas = this._safe(() => this.cluster?.getResourceQuotaObjects?.(ns)) || [];
    const quota =
      (resolved && resolved.kind === 'ResourceQuota' ? resolved : null) ||
      this._findResource('ResourceQuota', incident.target, ns) ||
      quotas[0] ||
      null;
    if (!quota) return { applied: false };

    // #27(b): bind the incident to the quota that is ACTUALLY damaged. L15
    // authors the namespace ("quota-lab") as the target, and lab 6 names
    // "team-quota" while the shipped examples/quota.yaml creates
    // "compute-quota". Without rebinding, `_resolveTargetResource()` returns
    // null and the state check can never run, so `autoResolveTime: null`
    // leaves the drawer button as the only exit.
    const quotaName = quota.name || quota.metadata?.name;
    if (quotaName && incident.target !== quotaName) {
      incident.target = quotaName;
      incident.pendingTarget = false;
    }
    if (quotaName) incident.damagedQuotaName = quotaName;
    incident.uid = quota.uid || quota.metadata?.uid || incident.uid;
    incident.namespace = quota.namespace || quota.metadata?.namespace || ns;

    const usageBefore = this._safe(() => this.cluster.getQuotaUsage(ns)) || {};
    // Remove ONE deterministic Running Pod owned by a workload so the quota is
    // full at the post-removal usage (no phantom Pod objects, Used <= Hard).
    const removedPod = this._removePodForQuotaDamage(ns);
    if (removedPod) incident.removedPodName = removedPod.metadata?.name || removedPod.name || null;
    const usageAfter = this._safe(() => this.cluster.getQuotaUsage(ns)) || {};
    const usedPods = Number.isFinite(Number(usageAfter.pods))
      ? Number(usageAfter.pods)
      : Math.max(0, Number(usageBefore.pods || 0) - (removedPod ? 1 : 0));

    const savedHard = JSON.parse(JSON.stringify(quota.spec?.hard || {}));
    if (!incident.restoreState) this._saveRestore(incident, { uid: quota.uid, hard: savedHard });
    const tight = { ...savedHard };
    // Used == Hard on the pods dimension: the next Pod creation is rejected
    // with `exceeded quota: <name>` by the admission path.
    tight.pods = String(usedPods);
    // CPU/memory limits are left untouched so Used can never exceed Hard there.
    quota.spec = { ...(quota.spec || {}), hard: tight };
    this._setCondition(quota, 'Exceeded', 'True', 'QuotaExceeded', 'exceeded quota: pods');
    this._recordEvent(
      quota,
      'Warning',
      'QuotaExceeded',
      `exceeded quota: ${quota.name} is exhausted (used ${usedPods} of ${usedPods} pods)`
    );
    this._markIncident(quota, incident);
    this._commit(quota);
    this.emit('quota:exceeded', {
      namespace: ns,
      quota: quota.name,
      removedPod: incident.removedPodName,
    });
    this._safe(() => this.cluster.recalculateQuotaStatus?.());
    return { applied: true, quota: quotaName, removedPod: incident.removedPodName, usedPods };
  }

  /**
   * Pick the deterministic (name-sorted) first Running Pod owned by a
   * Deployment/ReplicaSet in `namespace` and remove it. Returns the Pod object.
   */
  _removePodForQuotaDamage(namespace) {
    const pods = this._safe(() => this.cluster?.getByKindAndNamespace('Pod', namespace)) || [];
    const owned = pods.filter((pod) => {
      if (!pod || pod.status?.phase !== 'Running') return false;
      const owners = pod.metadata?.ownerReferences || pod.ownerReferences || [];
      return owners.some(
        (ref) =>
          ref?.kind === 'ReplicaSet' ||
          ref?.kind === 'Deployment' ||
          ref?.kind === 'ReplicationController'
      );
    });
    owned.sort((left, right) =>
      String(left.metadata?.name || left.name || '').localeCompare(
        String(right.metadata?.name || right.name || '')
      )
    );
    const victim = owned[0];
    if (!victim) return null;
    const uid = victim.uid || victim.metadata?.uid;
    if (!uid) return null;
    this._recordEvent(
      victim,
      'Normal',
      'Killing',
      'Quota exhausted: the ReplicaSet cannot create a replacement Pod'
    );
    this._safe(() => this.cluster.remove(uid));
    return victim;
  }

  _damageLimitRange(incident) {
    const lr =
      this._resolveTargetResource(incident) ||
      this._findResource('LimitRange', incident.target, incident.namespace) ||
      (this._safe(() => this.cluster?.getByKindAndNamespace('LimitRange', incident.namespace)) ||
        [])[0];
    if (!lr) return { applied: false };
    this._saveRestore(incident, {
      uid: lr.uid,
      limits: JSON.parse(JSON.stringify(lr.spec?.limits || [])),
    });
    if (lr.spec) {
      lr.spec.limits = [
        {
          type: 'Container',
          max: { cpu: '10m', memory: '16Mi' },
          min: { cpu: '1', memory: '1Gi' },
        },
      ];
    }
    this._recordEvent(
      lr,
      'Warning',
      'LimitRangeViolation',
      'pod resources are outside the allowed LimitRange min/max'
    );
    this._markIncident(lr, incident);
    this._commit(lr);
    return { applied: true };
  }

  _damageClusterQuota(incident) {
    const crq =
      this._resolveTargetResource(incident) ||
      this._findResource('ClusterResourceQuota', incident.target, '') ||
      (this._safe(() => this.cluster?.getByKind('ClusterResourceQuota')) || [])[0];
    if (!crq) return { applied: false };
    this._saveRestore(incident, {
      uid: crq.uid,
      status: JSON.parse(JSON.stringify(crq.status || {})),
    });
    crq.status = crq.status || {};
    crq.status.total = crq.status.total || { hard: crq.spec?.quota?.hard || {}, used: {} };
    crq.status.total.used = { ...(crq.status.total.used || {}), pods: 9999 };
    this._recordEvent(
      crq,
      'Warning',
      'QuotaExceeded',
      'cluster resource quota exceeded across selected projects'
    );
    this._markIncident(crq, incident);
    this._commit(crq);
    return { applied: true };
  }

  /**
   * Bind a node incident to the Node object it actually damages (#27b/#28).
   * Level data may still name the machine `node-2` while the cluster presents
   * `worker-1`; the state-healing path resolves targets by name, so the
   * incident must point at the real damaged object or it can never heal.
   */
  _bindIncidentToNode(incident, node) {
    if (!incident || !node) return;
    const nodeName = node.name || node.metadata?.name;
    if (nodeName && incident.target !== nodeName) {
      incident.target = nodeName;
      incident.pendingTarget = false;
    }
    incident.namespace = '';
    if (!incident.uid) incident.uid = node.uid || node.metadata?.uid || null;
  }

  _damageNodeReady(incident) {
    const node =
      this._resolveTargetResource(incident) ||
      this._findResource('Node', incident.target, '') ||
      (this._safe(() => this.cluster?.getByKind('Node')) || [])[0];
    if (!node) return { applied: false };
    this._bindIncidentToNode(incident, node);
    if (!incident.restoreState) {
      this._saveRestore(incident, {
        uid: node.uid,
        phase: node.status?.phase || 'Running',
        unschedulable: node.spec?.unschedulable ?? false,
      });
    }
    this._setPhase(node, 'NotReady');
    // #49: a stopped kubelet stops posting a heartbeat. The node lifecycle
    // controller then marks EVERY kubelet-posted condition (Ready plus the three
    // pressure conditions) Unknown with reason NodeStatusUnknown and the real
    // "Kubelet stopped posting node status." message — it does not report
    // `Ready False KubeletNotReady` while the node is unreachable.
    for (const conditionType of ['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure']) {
      this._setCondition(
        node,
        conditionType,
        'Unknown',
        'NodeStatusUnknown',
        'Kubelet stopped posting node status.'
      );
    }
    // Issue #43: a real NotReady node is NOT cordoned. The node lifecycle
    // controller adds node.kubernetes.io/unreachable / not-ready taints
    // (NoSchedule + NoExecute) and `oc get nodes` STATUS stays plain NotReady.
    const simulation = this.gameEngine?.simulation;
    if (simulation?.applyNodeNotReadyTaints) {
      simulation.applyNodeNotReadyTaints(node);
    } else if (node.spec) {
      node.spec.taints = [
        ...(node.spec.taints || []).filter(
          (taint) => !String(taint?.key || '').startsWith('node.kubernetes.io/')
        ),
        { key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule' },
        { key: 'node.kubernetes.io/unreachable', effect: 'NoExecute' },
        { key: 'node.kubernetes.io/not-ready', effect: 'NoSchedule' },
        { key: 'node.kubernetes.io/not-ready', effect: 'NoExecute' },
      ];
    }
    if (node.spec) node.spec.unschedulable = false;
    this._recordEvent(
      node,
      'Warning',
      'NodeNotReady',
      `Node ${node.name} status is now: NodeNotReady`
    );
    this._markIncident(node, incident);
    this._commit(node);
    return { applied: true, kind: 'node', target: node.name };
  }

  _damageNodePressure(incident, pressure) {
    const node =
      this._resolveTargetResource(incident) ||
      this._findResource('Node', incident.target, '') ||
      (this._safe(() => this.cluster?.getByKind('Node')) || [])[0];
    if (!node) return { applied: false };
    this._bindIncidentToNode(incident, node);
    if (!incident.restoreState) {
      this._saveRestore(incident, {
        uid: node.uid,
        conditions: JSON.parse(JSON.stringify(node.status?.conditions || [])),
        memory: node.spec?.memory,
        allocatable: node.status?.allocatable,
      });
    }
    if (pressure === 'MemoryPressure' && node.spec) {
      // Shrink the node so _tickNodes keeps reporting the pressure condition.
      node.spec.memory = '1Gi';
    }
    this._setCondition(
      node,
      pressure,
      'True',
      'KubeletHasInsufficientResources',
      pressure === 'DiskPressure' ? 'node is running out of disk' : 'node is under memory pressure'
    );
    this._recordEvent(
      node,
      'Warning',
      pressure,
      `Node reports ${pressure}=True; kubelet is evicting pods`
    );
    this._markIncident(node, incident);
    this._commit(node);
    return { applied: true, kind: 'node', target: node.name };
  }

  _damageOperator(incident) {
    const sub =
      this._resolveTargetResource(incident) ||
      this._findResource('Subscription', incident.target, incident.namespace) ||
      (this._safe(() => this.cluster?.getByKind('Subscription')) || [])[0];
    if (!sub) return { applied: false };
    this._saveRestore(incident, {
      uid: sub.uid,
      status: JSON.parse(JSON.stringify(sub.status || {})),
    });
    sub.status = sub.status || {};
    sub.status.state = 'AtLatestKnown';
    // Also flip the phase to Failed (unless the simulator owns it) so a
    // Succeeded Subscription cannot satisfy the recovery check by accident.
    if (sub.status.phase !== 'Failed') {
      incident.baseline = incident.baseline || {};
      incident.baseline.subscriptionPhase = sub.status.phase || null;
      sub.status.phase = 'Failed';
    }
    sub.status.conditions = [
      {
        type: 'CatalogSourcesUnhealthy',
        status: 'True',
        reason: 'CatalogSourceUnhealthy',
        message: 'catalog source is unhealthy; operator installation failed',
        lastTransitionTime: nowIso(),
      },
    ];
    this._markIncident(sub, incident);
    this._recordEvent(
      sub,
      'Warning',
      'InstallFailed',
      'operator installation failed: catalog source is unhealthy'
    );
    this._commit(sub);

    // If a CSV-style resource exists in the model, mark it Failed as well.
    const csvKind = (this._safe(() => this.cluster?.getByKind('ClusterServiceVersion')) || []).find(
      (c) => c.name === sub.status?.installedCSV || c.name === sub.spec?.name
    );
    if (csvKind) {
      this._setPhase(csvKind, 'Failed');
      this._recordEvent(csvKind, 'Warning', 'InstallFailed', 'CSV install failed');
      this._commit(csvKind);
    }
    return { applied: true, kind: 'operator', target: sub.name };
  }

  // ── RESOLUTION: apply the `resolution` descriptor from the defs ──────────
  applyResolutionEffects(incident, actionId = 'manual') {
    const state = this.cluster;
    if (!incident || !state) return { applied: false, reason: 'no-cluster' };

    const resolution = incident.resolution || {};
    const target = this._resolveTargetResource(incident);
    const result = this._applyEffect(incident, target, resolution, actionId);

    // Always clear the incident annotation if we touched a resource.
    if (target) this._clearAnnotation(target, INCIDENT_ANNOTATION);
    if (target) {
      this._annotate(target, HEAL_ANNOTATION, nowIso());
      this._recordEvent(
        target,
        'Normal',
        'IncidentResolved',
        `${incident.name} resolved by ${actionId}`
      );
      this._commit(target);
    }

    const payload = {
      incidentId: incident.id,
      name: incident.name,
      target: incident.target,
      uid: incident.uid || target?.uid || null,
      namespace: incident.namespace,
      action: actionId,
      effect: resolution.effect || 'heal',
      kind: resolution.kind || 'cluster',
      applied: result?.applied !== false,
      details: result || {},
    };

    // Legacy + OpenShift-specific events other modules already listen for.
    this.emit('resource:healed', payload);
    if (resolution.effect === 'reschedule') this.emit('resource:rescheduled', payload);
    if (resolution.effect === 'dns') this.emit('cluster:dns-restored', payload);
    if (resolution.effect === 'rotate') this.emit('security:credential-rotated', payload);
    if (resolution.effect === 'install') this.emit('operator:installed', payload);
    if (resolution.effect === 'admit') this.emit('route:admitted', payload);
    if (resolution.effect === 'complete' && resolution.kind === 'build')
      this.emit('build:complete', payload);
    if (resolution.effect === 'clear' && resolution.kind === 'quota')
      this.emit('quota:cleared', payload);
    if (resolution.kind === 'oauth') this.emit('auth:provider-ready', payload);
    if (resolution.kind === 'rbac') this.emit('scc:granted', payload);

    return {
      applied: result?.applied !== false,
      kind: resolution.kind || 'cluster',
      effect: resolution.effect || 'heal',
      ...result,
    };
  }

  _applyEffect(incident, target, resolution, actionId) {
    const kind = resolution.kind || 'cluster';
    const effect = resolution.effect || 'heal';

    switch (kind) {
      case 'pod':
        return this._healPods(incident, target, actionId);
      case 'deployment':
        return this._healDeployment(incident, target);
      case 'service':
        return this._healService(incident, target, effect);
      case 'route':
        return this._healRoute(incident, target, effect);
      case 'build':
        return this._healBuild(incident, target, resolution);
      case 'imagestreamtag':
      case 'imagestream':
        return this._healImageStream(incident, target, resolution);
      case 'node':
        return this._healNode(incident, target, effect);
      case 'networkpolicy':
        return this._healNetworkPolicy(incident, target, resolution);
      case 'configmap':
      case 'secret':
        return this._healConfigObject(incident, target, kind);
      case 'quota':
        return this._healQuota(incident, target, actionId);
      case 'limitrange':
        return this._healLimitRange(incident, target);
      case 'clusterquota':
        return this._healClusterQuota(incident, target);
      case 'cronjob':
        return this._healCronJob(incident, target);
      case 'job':
        return this._healJob(incident, target);
      case 'hpa':
        return this._healHpa(incident, target);
      case 'pvc':
        return this._healPvc(incident, target);
      case 'operator':
        return this._healOperator(incident, target, resolution);
      case 'clusteroperator':
        return this._healClusterOperator(incident, target);
      case 'ingress':
        return this._healIngress(incident, target);
      case 'oauth':
        return this._healOAuth(incident, target);
      case 'rbac':
        return this._healRbac(incident, target, resolution);
      case 'cluster':
        return this._healClusterWide(incident, target, effect);
      default:
        return this._healGeneric(incident, target);
    }
  }

  _healPodContainer(pod) {
    if (!pod) return;
    const containers = pod.status?.containerStatuses || [];
    const healthy = containers.map((cs) => ({
      ...cs,
      ready: true,
      started: true,
      // A healed container is a FRESH running instance: drop the injected
      // previous-termination state so `oc logs <healthy-pod> --previous` reports
      // a real "previous terminated container not found" BadRequest instead of
      // replaying the old synthetic crash log (GAME-004).
      restartCount: 0,
      state: { running: { startedAt: cs.state?.running?.startedAt || nowIso() } },
      lastState: {},
    }));
    pod.status = pod.status || {};
    pod.status.containerStatuses =
      healthy.length > 0
        ? healthy
        : [
            {
              name: 'main',
              ready: true,
              started: true,
              restartCount: 0,
              state: { running: { startedAt: nowIso() } },
              lastState: {},
            },
          ];
    this._setPhase(pod, 'Running');
    this._setCondition(pod, 'PodScheduled', 'True', 'Scheduled', 'Assigned to a node');
    this._setCondition(pod, 'Initialized', 'True', 'PodInitialized', '');
    this._setCondition(pod, 'Ready', 'True', 'PodReady', '');
    this._setCondition(pod, 'ContainersReady', 'True', 'ContainersReady', '');
    this._clearAnnotation(pod, INCIDENT_ANNOTATION);
    this._clearPodLogAnnotations(pod);
    this._recordEvent(pod, 'Normal', 'Healed', 'Pod is running and ready again');
    this._commit(pod);
  }

  _healPods(incident, target, actionId = 'manual') {
    const pods = [];
    if (target) {
      if (target.kind === 'Pod') pods.push(target);
      else pods.push(...this._workloadPods(target));
    }
    if (pods.length === 0) {
      const fallback = this._pickPodForIncident(incident);
      if (fallback) pods.push(fallback);
    }
    // State-driven resolution (the learner already repaired the cluster) must
    // never bounce a workload that is ALREADY healthy (#27c).
    const stateDriven = actionId === 'resource-fixed' || actionId === 'auto';

    // SCC incident: granting the SCC is a PLAYER action. Only the explicit
    // "Grant a permissive SCC to the ServiceAccount" resolution action may
    // create the binding — auto-resolve / state-driven heal must never grant an
    // SCC by itself (that used to tick L17's objective without the player).
    if (incident.name === 'SCCForbidden') {
      const explicitGrant = actionId === 'grant-scc';
      if (explicitGrant) {
        this._grantSccTo(
          incident,
          this._requiredSccForIncident(incident),
          incident.rbacSubject?.name
        );
      } else if (!this._incidentSccGranted(incident)) {
        // No grant: do not fake a heal. Report the still-denied state.
        if (target) {
          this._recordEvent(
            target,
            'Warning',
            'SCCDenied',
            'Grant the privileged SCC to the ServiceAccount before the Pod can be admitted'
          );
          this._commit(target);
        }
        return { applied: false, kind: 'pod', reason: 'scc-not-granted' };
      }
    } else if (incident.resolution?.grantScc && actionId !== 'auto') {
      // Non-SCC incidents never auto-grant either.
      if (actionId !== 'resource-fixed') this._grantSccTo(incident, incident.resolution.grantScc);
    }

    let healed = 0;
    for (const pod of pods) {
      // Stuck terminating: clear finalizers and delete the pod object.
      if (
        incident.name === 'PodStuckTerminating' ||
        pod.status?.phase === 'Terminating' ||
        pod.metadata?.deletionTimestamp
      ) {
        this._clearAnnotation(pod, INCIDENT_ANNOTATION);
        pod.metadata = pod.metadata || {};
        pod.metadata.finalizers = [];
        this._recordEvent(
          pod,
          'Normal',
          'Killing',
          'Pod finalizers released; pod will be recreated by its controller'
        );
        this._commit(pod);
        this._safe(() => this.cluster.remove(pod.uid));
        healed++;
        continue;
      }
      // SCC incident: only revive pods the granted SCC actually admits.
      if (incident.name === 'SCCForbidden') {
        if (!this._isPodAdmissible(pod)) {
          this._clearAnnotation(pod, INCIDENT_ANNOTATION);
          this._recordEvent(
            pod,
            'Warning',
            'SCCDenied',
            'Pod is still forbidden by security context constraints; grant an SCC that allows its securityContext'
          );
          this._commit(pod);
          continue;
        }
        // #27(c): state-driven heal of a workload that is ALREADY Running with
        // the SCC annotation must not re-pend it (that produced a
        // Pending/ContainerCreating Pod on `Node: <none>` and unticked the
        // "privileged workload Running" objective). Only reviving denied pods
        // needs the re-admission round-trip below.
        const alreadyHealthyAdmitted =
          pod.status?.phase === 'Running' &&
          Boolean(pod.metadata?.annotations?.['openshift.io/scc']) &&
          (typeof pod.isConditionTrue !== 'function' || pod.isConditionTrue('Ready'));
        if (stateDriven && alreadyHealthyAdmitted) {
          this._clearAnnotation(pod, INCIDENT_ANNOTATION);
          this._recordEvent(
            pod,
            'Normal',
            'SCCAdmitted',
            'Pod is already admitted and running under the granted SCC'
          );
          this._commit(pod);
          healed++;
          continue;
        }
        // Re-run admission for real instead of pretending the Pod runs: clear
        // the denial marker and put the Pod back through scheduling/admission so
        // `openshift.io/scc` is set by the simulator (GAME-002/GAME-017).
        this._clearAnnotation(pod, 'openshiftgames/scc-denied');
        this._clearAnnotation(pod, 'openshiftgames/denied-reason');
        this._clearAnnotation(pod, INCIDENT_ANNOTATION);
        pod._sccEvaluated = false;
        if (pod.spec) delete pod.spec.nodeName;
        pod.status = pod.status || {};
        delete pod.status.podIP;
        delete pod.status.hostIP;
        pod.status.containerStatuses = [];
        this._setPhase(pod, 'Pending');
        this._recordEvent(
          pod,
          'Normal',
          'SCCGranted',
          'Security context constraint granted; Pod will be re-admitted'
        );
        this._commit(pod);
        healed++;
        continue;
      }
      // Pending scheduling: restore the original node selector/affinity.
      if (incident.restoreState && incident.restoreState.uid === pod.uid) {
        if (pod.spec) {
          pod.spec.nodeSelector = incident.restoreState.nodeSelector || undefined;
          if (!incident.restoreState.nodeName) pod.spec.nodeName = null;
        }
      }
      this._healPodContainer(pod);
      healed++;
    }

    // Also restore a broken Deployment template (rollout/config incidents).
    // SCC incidents are re-admitted by the simulator; do not fake availability.
    if (
      incident.name !== 'SCCForbidden' &&
      target &&
      (target.kind === 'Deployment' ||
        target.kind === 'ReplicaSet' ||
        target.kind === 'StatefulSet')
    ) {
      this._healDeployment(incident, target);
    }

    return { applied: healed > 0, kind: 'pod', healed };
  }

  /** SCC name required by the incident's damaged workload pods. */
  _requiredSccForIncident(incident) {
    const target = this._resolveTargetResource(incident);
    let pods = [];
    if (target?.kind === 'Pod') pods = [target];
    else if (target) pods = this._workloadPods(target);
    if (pods.length === 0 && incident.targetPodUid) {
      const pod = this._safe(() => this.cluster.get?.(incident.targetPodUid));
      if (pod) pods = [pod];
    }
    const needsPrivileged = pods.some((pod) => {
      const spec = pod.spec || {};
      return (
        spec.securityContext?.privileged === true ||
        (spec.containers || []).some((container) => container?.securityContext?.privileged === true)
      );
    });
    if (needsPrivileged) return 'privileged';
    return incident.resolution?.grantScc || 'anyuid';
  }

  /**
   * Is the SCC required by this incident actually granted to the workload's
   * ServiceAccount under the OCP 4.x RBAC-binding model? Used by state-driven
   * resolution so the incident clears when the learner runs
   * `oc adm policy add-scc-to-user <scc> -z <sa>`, not from an auto-grant.
   */
  _incidentSccGranted(incident) {
    const sccName =
      incident.resolution?.grantScc || this._requiredSccForIncident(incident) || 'privileged';
    const subject = incident.rbacSubject || {};
    const namespace = subject.namespace || incident.namespace || '';
    const saName = subject.kind === 'ServiceAccount' ? subject.name : null;
    const subjectStr = saName
      ? `system:serviceaccount:${namespace}:${saName}`
      : subject.name || incident.target;
    const cluster = this.cluster;
    if (!cluster) return false;
    const toNames = (grants) =>
      (Array.isArray(grants) ? grants : [])
        .map((entry) =>
          typeof entry === 'string' ? entry : entry?.name || entry?.metadata?.name || ''
        )
        .filter(Boolean);
    try {
      if (typeof cluster.getSCCGrantsForSubject === 'function') {
        return toNames(cluster.getSCCGrantsForSubject(subjectStr)).includes(String(sccName));
      }
      if (saName && typeof cluster.getSCCsForServiceAccount === 'function') {
        if (toNames(cluster.getSCCsForServiceAccount(namespace, saName)).includes(String(sccName)))
          return true;
      }
    } catch {
      /* fall through to the binding scan */
    }
    // Binding scan (works on partially-integrated builds / before helpers land).
    const roleName = `system:openshift:scc:${sccName}`;
    for (const kind of ['RoleBinding', 'ClusterRoleBinding']) {
      for (const binding of this._safe(() => cluster.getByKind(kind)) || []) {
        const spec = binding.spec || {};
        if ((spec.roleRef?.name || '') !== roleName) continue;
        const subjects = spec.subjects || binding.subjects || [];
        if (
          subjects.some((entry) => {
            if (entry?.kind === 'ServiceAccount') {
              return saName
                ? entry.name === saName && (!entry.namespace || entry.namespace === namespace)
                : `${entry.namespace || namespace}:${entry.name}` === incident.target;
            }
            return entry?.kind === 'User' && entry.name === subjectStr;
          })
        ) {
          return true;
        }
      }
    }
    return false;
  }

  _healDeployment(incident, target) {
    const deploy =
      target &&
      (target.kind === 'Deployment' ||
        target.kind === 'ReplicaSet' ||
        target.kind === 'StatefulSet')
        ? target
        : this._findResource('Deployment', incident.target, incident.namespace) ||
          this._safe(() => (this.cluster?.getByKind('Deployment') || [])[0]);
    if (!deploy) return { applied: false };

    // Restore the original pod template (broken image / env refs).
    if (incident.restoreState?.template && deploy.spec) {
      deploy.spec.template = incident.restoreState.template;
    }
    const pods = this._workloadPods(deploy);
    for (const pod of pods) {
      if (incident.name === 'SCCForbidden' && !this._isPodAdmissible(pod)) continue;
      this._healPodContainer(pod);
    }

    const desired = deploy.spec?.replicas ?? 1;
    const healthyPods = pods.filter(
      (pod) =>
        pod.status?.phase === 'Running' &&
        (pod.isConditionTrue ? pod.isConditionTrue('Ready') : true)
    ).length;
    deploy.status = deploy.status || {};
    if (incident.name === 'SCCForbidden' && healthyPods < desired) {
      // Keep reporting the real, still-forbidden state instead of claiming
      // minimum availability after a heal that admission rejected.
      deploy.status.replicas = Math.max(deploy.status.replicas || 0, pods.length);
      deploy.status.readyReplicas = healthyPods;
      deploy.status.availableReplicas = healthyPods;
      deploy.status.updatedReplicas = pods.length;
      deploy.status.observedGeneration =
        deploy.metadata?.generation || deploy.status.observedGeneration;
      this._setCondition(
        deploy,
        'Available',
        'False',
        'MinimumReplicasUnavailable',
        `${healthyPods}/${desired} replicas available (SCC denied)`
      );
      this._setCondition(
        deploy,
        'Progressing',
        'True',
        'ReplicaSetUpdated',
        'waiting for pods to be admitted'
      );
      this._recordEvent(
        deploy,
        'Warning',
        'SCCDenied',
        'Pods are still rejected by security context constraints'
      );
      this._commit(deploy);
      return {
        applied: false,
        kind: 'deployment',
        target: deploy.name,
        pods: pods.length,
        reason: 'scc-denied',
      };
    }
    deploy.status.replicas = Math.max(deploy.status.replicas || 0, desired);
    deploy.status.readyReplicas = desired;
    deploy.status.availableReplicas = desired;
    deploy.status.updatedReplicas = desired;
    deploy.status.observedGeneration =
      deploy.metadata?.generation || deploy.status.observedGeneration;
    this._setCondition(
      deploy,
      'Available',
      'True',
      'MinimumReplicasAvailable',
      'Deployment has minimum availability.'
    );
    this._setCondition(
      deploy,
      'Progressing',
      'True',
      'NewReplicaSetAvailable',
      'ReplicaSet has successfully progressed.'
    );
    this._clearAnnotation(deploy, INCIDENT_ANNOTATION);
    this._recordEvent(deploy, 'Normal', 'Healed', 'Rollout completed; all replicas are available');
    this._commit(deploy);
    return { applied: true, kind: 'deployment', target: deploy.name, pods: pods.length };
  }

  _healService(incident, target, effect) {
    const svc =
      target && target.kind === 'Service'
        ? target
        : this._findResource('Service', incident.target, incident.namespace);
    if (!svc) return { applied: false };

    // Restore the selector / heal the backing pods so endpoints reappear.
    if (incident.restoreState?.selector && svc.spec) {
      svc.spec.selector = incident.restoreState.selector;
    }
    const selector = svc.spec?.selector || {};
    const pods = (
      this._safe(() => this.cluster?.getByKindAndNamespace('Pod', svc.namespace)) || []
    ).filter((p) =>
      Object.entries(selector).every(([k, v]) => (p.metadata?.labels || {})[k] === v)
    );
    for (const pod of pods) this._healPodContainer(pod);

    if (effect === 'assign-ip') {
      svc.status = svc.status || {};
      svc.status.loadBalancer = { ingress: [{ ip: '203.0.113.10', hostname: '' }] };
      this._clearAnnotation(svc, 'openshiftgames.io/lb-pending');
      this._recordEvent(
        svc,
        'Normal',
        'EnsuredLoadBalancer',
        'Load balancer IP assigned from the MetalLB address pool'
      );
    }
    this._clearAnnotation(svc, INCIDENT_ANNOTATION);
    this._recordEvent(svc, 'Normal', 'Healed', 'Service has ready endpoints');
    this._commit(svc);
    return { applied: true, kind: 'service', target: svc.name, pods: pods.length };
  }

  _healRoute(incident, target, effect) {
    const route =
      target && target.kind === 'Route'
        ? target
        : this._findResource('Route', incident.target, incident.namespace);
    if (!route) return { applied: false };

    const defaultHost = this._safe(
      () => this.cluster.defaultRouteHost?.(route.name, route.namespace),
      `${route.name}-${route.namespace || 'default'}.apps.cluster.example.com`
    );
    if (effect === 'restore-host') {
      if (route.spec) route.spec.host = incident.restoreState?.host || defaultHost;
    }
    if (effect === 'restore-tls') {
      route.spec = route.spec || {};
      route.spec.tls = { ...(incident.restoreState?.tls || {}), termination: 'edge' };
      if (!route.spec.tls.certificate)
        route.spec.tls.certificate =
          '-----BEGIN CERTIFICATE-----\n[renewed]\n-----END CERTIFICATE-----';
      if (!route.spec.tls.key)
        route.spec.tls.key = '-----BEGIN PRIVATE KEY-----\n[renewed]\n-----END PRIVATE KEY-----';
      this._clearAnnotation(route, 'openshiftgames.io/tls-error');
    }

    // Heal the backing Service/Pods so admission stays valid for the controller.
    const svc =
      this._safe(() => this.cluster.getRouteService?.(route)) ||
      this._findResource('Service', route.spec?.to?.name, route.namespace);
    if (svc) {
      if (typeof this.cluster?.getServiceEndpoints === 'function') {
        const endpoints = this._safe(() => this.cluster.getServiceEndpoints(svc)) || [];
        if (endpoints.length === 0) {
          const selector = svc.spec?.selector || {};
          const pods = (
            this._safe(() => this.cluster?.getByKindAndNamespace('Pod', svc.namespace)) || []
          ).filter((p) =>
            Object.entries(selector).every(([k, v]) => (p.metadata?.labels || {})[k] === v)
          );
          for (const pod of pods) this._healPodContainer(pod);
        }
      }
    }

    const host = route.spec?.host || defaultHost;
    route.status = route.status || {};
    route.status.ingress = [
      {
        host,
        routerName: 'default',
        wildcardPolicy: 'None',
        conditions: [
          {
            type: 'Admitted',
            status: 'True',
            reason: 'Accepted',
            message: 'The route is admitted and serving traffic',
            lastTransitionTime: nowIso(),
          },
        ],
      },
    ];
    this._clearAnnotation(route, INCIDENT_ANNOTATION);
    this._recordEvent(
      route,
      'Normal',
      'Admitted',
      `Route ${host} admitted by the default Ingress Controller`
    );
    this._commit(route);
    return { applied: true, kind: 'route', target: route.name, host };
  }

  _healBuild(incident, target, resolution) {
    const build =
      target && target.kind === 'Build'
        ? target
        : (this._safe(() => this.cluster?.getByKind('Build')) || []).find(
            (b) => b.name === incident.target
          ) || (this._safe(() => this.cluster?.getByKind('Build')) || [])[0];
    if (!build) {
      const bc = this._findResource('BuildConfig', incident.target, incident.namespace);
      if (bc) {
        this._setCondition(
          bc,
          'BuildFailed',
          'False',
          'BuildSucceeded',
          'The latest build completed successfully'
        );
        this._clearAnnotation(bc, INCIDENT_ANNOTATION);
        this._recordEvent(bc, 'Normal', 'BuildSucceeded', 'Latest build completed successfully');
        this._commit(bc);
        return { applied: true, kind: 'buildconfig', target: bc.name };
      }
      return { applied: false };
    }

    // Do not fabricate a Complete phase for a failed Build: a real retry starts
    // a NEW Build from the BuildConfig and lets it run (GAME-003).
    if (build.status?.phase === 'Failed' || build.status?.phase === 'Error') {
      const bcName =
        build.spec?.buildConfig?.name ||
        (this._safe(() => this.cluster?.getByKind('BuildConfig')) || []).find(
          (candidate) =>
            candidate.namespace === build.namespace &&
            build.metadata?.name?.startsWith(candidate.metadata?.name)
        )?.metadata?.name;
      const buildConfig = bcName
        ? this._findResource('BuildConfig', bcName, build.namespace)
        : null;
      let retried = null;
      if (buildConfig && typeof this.cluster?.startBuildFor === 'function') {
        const result = this._safe(() =>
          this.cluster.startBuildFor(buildConfig, { actor: 'kubeadmin', reason: 'Retry' })
        );
        retried = result?.build || null;
      }
      this._clearAnnotation(build, INCIDENT_ANNOTATION);
      if (retried) {
        this._recordEvent(
          build,
          'Normal',
          'Retried',
          `New build ${retried.metadata?.name || retried.name} started from ${bcName}`
        );
        this._recordEvent(retried, 'Normal', 'BuildStarted', 'Build retried after failure');
        this._commit(build);
        this._commit(retried);
        return {
          applied: true,
          kind: 'build',
          target: build.name,
          retryBuild: retried.metadata?.name || retried.name,
        };
      }
      // Fallback (no simulator build controller available): mark the failed
      // build as cancelled rather than pretending it succeeded.
      build.status.phase = 'Cancelled';
      build.status.reason = 'Cancelled';
      build.status.message = 'failed build cleared; start a new build to produce the image';
      build.status.completionTimestamp = nowIso();
      this._commit(build);
      return { applied: true, kind: 'build', target: build.name, retryBuild: null };
    }

    build.status = build.status || {};
    build.status.phase = 'Complete';
    build.status.reason = '';
    build.status.message = 'build completed successfully';
    build.status.completionTimestamp = nowIso();
    build.status.startTimestamp = build.status.startTimestamp || nowIso();
    this._clearAnnotation(build, INCIDENT_ANNOTATION);
    this._recordEvent(build, 'Normal', 'BuildCompleted', 'Build completed and pushed the image');
    this._commit(build);

    // Push the output tag into the ImageStream (prefers the new ClusterState helper).
    const out = build.spec?.output?.to;
    const refParts = (out?.name || incident.target || 'app:latest').split(':');
    const streamName = refParts[0];
    const tagName = refParts[1] || 'latest';
    if (typeof this.cluster?.updateImageStreamTag === 'function') {
      this._safe(() => this.cluster.updateImageStreamTag(build.namespace, streamName, tagName));
    } else {
      const stream = this._findResource('ImageStream', streamName, build.namespace);
      if (stream) this._ensureTag(stream, tagName);
    }

    const bc = this._findResource(
      'BuildConfig',
      build.spec?.buildConfig?.name || streamName,
      build.namespace
    );
    if (bc) {
      bc.status = bc.status || {};
      bc.status.lastVersion = Math.max(bc.status.lastVersion || 0, 1);
      this._commit(bc);
    }

    // Unstick deployments that referenced the tag.
    for (const deploy of this._safe(() =>
      this.cluster?.getByKindAndNamespace('Deployment', build.namespace)
    ) || []) {
      if (
        this._safe(() => JSON.stringify(deploy.spec?.template || {}).includes(streamName), false)
      ) {
        this._healDeployment(incident, deploy);
      }
    }
    return { applied: true, kind: 'build', target: build.name };
  }

  _healImageStream(incident, target, resolution) {
    let stream = target && target.kind === 'ImageStream' ? target : null;
    if (!stream) {
      const streamName = String(incident.target || '').split(':')[0];
      stream =
        this._findResource('ImageStream', streamName, incident.namespace) ||
        this._safe(() =>
          this.cluster?.getImageStream?.(
            incident.namespace || this.gameEngine?.currentProject,
            streamName
          )
        ) ||
        (this._safe(() => this.cluster?.getByKind('ImageStream')) || [])[0];
    }
    if (!stream) return { applied: false };

    const savedTags = incident.restoreState?.tags;
    if (Array.isArray(savedTags) && savedTags.length > 0) {
      stream.status = stream.status || {};
      stream.status.tags = savedTags;
      this._commit(stream);
    } else if (typeof this.cluster?.updateImageStreamTag === 'function') {
      this._safe(() =>
        this.cluster.updateImageStreamTag(
          stream.namespace || incident.namespace,
          stream.name,
          resolution.tag || 'latest'
        )
      );
    } else {
      this._ensureTag(stream, resolution.tag || 'latest');
    }
    this._clearAnnotation(stream, INCIDENT_ANNOTATION);
    this._recordEvent(
      stream,
      'Normal',
      'TagRestored',
      'ImageStreamTag restored from the internal registry'
    );
    this._commit(stream);

    for (const deploy of this._safe(() => this.cluster?.getByKind('Deployment')) || []) {
      if ((deploy.namespace || '') === (stream.namespace || '')) {
        if (
          this._safe(() => JSON.stringify(deploy.spec?.template || {}).includes(stream.name), false)
        ) {
          this._healDeployment(incident, deploy);
        }
      }
    }
    return { applied: true, kind: 'imagestream', target: stream.name };
  }

  _healNode(incident, target, effect) {
    const node =
      target && target.kind === 'Node'
        ? target
        : this._findResource('Node', incident.target, '') ||
          (this._safe(() => this.cluster?.getByKind('Node')) || [])[0];
    if (!node) return { applied: false };

    if (incident.restoreState?.memory && node.spec) node.spec.memory = incident.restoreState.memory;
    this._setPhase(node, 'Running');
    // A healed node is Ready and schedulable again: clear the lifecycle taints
    // the NotReady damage added (issue #43). Do not touch spec.unschedulable —
    // the incident never cordoned the node, so a player's cordon is preserved.
    const simulation = this.gameEngine?.simulation;
    if (simulation?.clearNodeNotReadyTaints) {
      simulation.clearNodeNotReadyTaints(node);
    } else if (node.spec) {
      node.spec.taints = (node.spec.taints || []).filter(
        (taint) => !String(taint?.key || '').startsWith('node.kubernetes.io/not-ready')
      );
      node.spec.taints = (node.spec.taints || []).filter(
        (taint) => !String(taint?.key || '').startsWith('node.kubernetes.io/unreachable')
      );
    }
    this._setCondition(node, 'Ready', 'True', 'KubeletReady', 'kubelet is posting ready status');
    this._setCondition(
      node,
      'MemoryPressure',
      'False',
      'KubeletHasSufficientMemory',
      'kubelet has sufficient memory available'
    );
    this._setCondition(
      node,
      'DiskPressure',
      'False',
      'KubeletHasNoDiskPressure',
      'kubelet has no disk pressure'
    );
    this._setCondition(
      node,
      'PIDPressure',
      'False',
      'KubeletHasSufficientPID',
      'kubelet has sufficient PID available'
    );
    // Real OCP 4.22 nodes (OVN-Kubernetes) report NetworkUnavailable=False with
    // reason RouteCreated and the "ovn-kube cleared kubelet-set NoRouteCreated"
    // message once the node network is programmed (#49).
    this._setCondition(
      node,
      'NetworkUnavailable',
      'False',
      'RouteCreated',
      'ovn-kube cleared kubelet-set NoRouteCreated'
    );
    this._clearAnnotation(node, INCIDENT_ANNOTATION);
    this._recordEvent(node, 'Normal', 'NodeReady', `Node ${node.name} status is now: NodeReady`);
    this._commit(node);

    // Pods that were failed with the node come back through the scheduler.
    const pods = this._safe(() => this.cluster?.getByKind('Pod')) || [];
    for (const pod of pods) {
      if (pod.spec?.nodeName === node.name && UNHEALTHY_PHASES.has(pod.status?.phase)) {
        this._setPhase(pod, 'Pending');
        if (pod.spec) pod.spec.nodeName = null;
        this._commit(pod);
      }
    }
    return { applied: true, kind: 'node', target: node.name };
  }

  _healNetworkPolicy(incident, target, resolution) {
    const policy =
      target && target.kind === 'NetworkPolicy'
        ? target
        : this._findResource('NetworkPolicy', incident.target, incident.namespace) ||
          (this._safe(() =>
            this.cluster?.getByKindAndNamespace('NetworkPolicy', incident.namespace)
          ) || [])[0];
    if (!policy) return { applied: false };

    if (incident.restoreState?.ingress) {
      policy.spec = policy.spec || {};
      policy.spec.podSelector = incident.restoreState.podSelector || { matchLabels: {} };
      policy.spec.policyTypes = incident.restoreState.policyTypes || ['Ingress'];
      policy.spec.ingress = incident.restoreState.ingress;
      policy.spec.egress = incident.restoreState.egress || [];
    } else {
      policy.spec = policy.spec || {};
      policy.spec.policyTypes = ['Ingress', 'Egress'];
      policy.spec.ingress = [{ from: [{ podSelector: {} }] }];
      policy.spec.egress = [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'openshift-dns' },
              },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 5353 },
            { protocol: 'TCP', port: 5353 },
          ],
        },
        { to: [{ podSelector: {} }] },
      ];
    }
    this._clearAnnotation(policy, INCIDENT_ANNOTATION);
    this._recordEvent(
      policy,
      'Normal',
      'TrafficAllowed',
      'NetworkPolicy allow rules restored/added'
    );
    this._commit(policy);
    if (typeof policy.updateAffectedPods === 'function') {
      this._safe(() =>
        policy.updateAffectedPods(this.cluster.getByKindAndNamespace('Pod', policy.namespace) || [])
      );
    }
    return { applied: true, kind: 'networkpolicy', target: policy.name };
  }

  _healConfigObject(incident, target, kind) {
    const resourceKind = kind === 'secret' ? 'Secret' : 'ConfigMap';
    let resource =
      target && target.kind === resourceKind
        ? target
        : this._findResource(resourceKind, incident.target, incident.namespace);
    if (!resource && incident.restoreState?.uid) {
      resource = this._safe(() => this.cluster?.getResource?.(incident.restoreState.uid));
    }
    if (resource) {
      // Restore removed data (ConfigMapMissing/SecretMissing onset clears it).
      // `data` is a read-only getter on the rich ConfigMap/Secret classes: write spec.data.
      resource.spec = resource.spec || {};
      const currentData =
        resource.spec.data && typeof resource.spec.data === 'object' ? resource.spec.data : {};
      const restoredData =
        incident.restoreState?.data && Object.keys(incident.restoreState.data).length > 0
          ? JSON.parse(JSON.stringify(incident.restoreState.data))
          : Object.keys(currentData).length === 0
            ? { username: 'app', password: 'rotated-secret-value' }
            : { ...currentData };
      if (resourceKind === 'Secret' && incident.name === 'SecretExposed') {
        restoredData.password = `rotated-${Math.random().toString(36).slice(2, 10)}`;
        this._clearAnnotation(resource, 'openshiftgames.io/exposed');
      }
      resource.spec.data = restoredData;
      this._clearAnnotation(resource, INCIDENT_ANNOTATION);
      this._recordEvent(
        resource,
        'Normal',
        'Healed',
        `${resourceKind} restored with the required keys`
      );
      this._commit(resource);
    }

    // Heal pods waiting on the restored object.
    const pods =
      this._safe(() => this.cluster?.getByKindAndNamespace('Pod', incident.namespace)) || [];
    let healedPods = 0;
    for (const pod of pods) {
      const waiting = pod.status?.containerStatuses?.some(
        (cs) => cs.state?.waiting?.reason === 'CreateContainerConfigError'
      );
      if (waiting || pod.metadata?.annotations?.[INCIDENT_ANNOTATION] === incident.name) {
        this._healPodContainer(pod);
        healedPods++;
      }
    }
    return { applied: !!resource || healedPods > 0, kind, healedPods };
  }

  _healQuota(incident, target, actionId = 'manual') {
    const ns = incident.namespace || this.gameEngine?.currentProject || 'default';
    const quota =
      (target && target.kind === 'ResourceQuota' ? target : null) ||
      this._findResource('ResourceQuota', incident.target, ns) ||
      (this._safe(() => this.cluster?.getByKindAndNamespace('ResourceQuota', ns)) || [])[0] ||
      null;
    const stateDriven = actionId === 'resource-fixed' || actionId === 'auto';

    if (quota) {
      // State-driven heal: the learner already raised the quota from the CLI.
      // Do NOT overwrite their new limits with the pre-onset snapshot (#27b) —
      // just clear the incident bookkeeping and report the quota as within
      // bounds. Manual/panel resolutions may restore/bump the limits.
      if (stateDriven) {
        this._setCondition(
          quota,
          'Exceeded',
          'False',
          'WithinQuota',
          'Project usage is within the quota'
        );
        this._clearAnnotation(quota, INCIDENT_ANNOTATION);
        this._recordEvent(
          quota,
          'Normal',
          'QuotaUpdated',
          'Project quota limits are within bounds again'
        );
        this._commit(quota);
        this._safe(() => this.cluster.recalculateQuotaStatus?.());
        return { applied: true, retried: 0, stateDriven: true };
      }
      const usage = this._safe(() => this.cluster.getQuotaUsage(ns)) || {};
      const restored = incident.restoreState?.hard
        ? JSON.parse(JSON.stringify(incident.restoreState.hard))
        : { ...(quota.spec?.hard || {}) };
      // Guarantee the restored/bumped limits are strictly above current usage.
      restored.pods = String(Math.max(Number(restored.pods ?? 0), (usage.pods || 0) + 5));
      if (restored['requests.cpu'] !== undefined) {
        restored['requests.cpu'] =
          `${Math.max(this._parseCpuMillis(restored['requests.cpu']), Math.ceil(usage['requests.cpu'] || 0) + 1000)}m`;
      }
      if (restored['requests.memory'] !== undefined) {
        const current = this._parseMemoryMi(restored['requests.memory']);
        restored['requests.memory'] =
          `${Math.max(current, Math.ceil(usage['requests.memory'] || 0) + 512)}Mi`;
      }
      quota.spec = { ...(quota.spec || {}), hard: restored };
      this._setCondition(
        quota,
        'Exceeded',
        'False',
        'WithinQuota',
        'Project usage is within the quota'
      );
      this._clearAnnotation(quota, INCIDENT_ANNOTATION);
      this._recordEvent(quota, 'Normal', 'QuotaUpdated', 'Project quota limits restored');
      this._commit(quota);
      this._safe(() => this.cluster.recalculateQuotaStatus?.());
    }

    let retried = 0;
    for (const pod of this._safe(() => this.cluster?.getByKindAndNamespace('Pod', ns)) || []) {
      if (
        pod.status?.phase === 'Pending' ||
        pod.metadata?.annotations?.[INCIDENT_ANNOTATION] === incident.name
      ) {
        this._setPhase(pod, 'Pending');
        this._clearAnnotation(pod, INCIDENT_ANNOTATION);
        this._commit(pod);
        retried++;
      }
    }
    return { applied: !!quota, retried };
  }

  _parseCpuMillis(value) {
    if (typeof value === 'number') return value;
    const str = String(value ?? '0');
    if (str.endsWith('m')) return parseInt(str, 10) || 0;
    return Math.round((parseFloat(str) || 0) * 1000);
  }

  _parseMemoryMi(value) {
    if (typeof value === 'number') return value;
    const str = String(value ?? '0');
    if (str.endsWith('Gi')) return Math.round((parseFloat(str) || 0) * 1024);
    if (str.endsWith('Mi')) return Math.round(parseFloat(str) || 0);
    if (str.endsWith('Ki')) return Math.round((parseFloat(str) || 0) / 1024);
    return Math.round(parseFloat(str) || 0);
  }

  _healLimitRange(incident, target) {
    const lr =
      target && target.kind === 'LimitRange'
        ? target
        : this._findResource('LimitRange', incident.target, incident.namespace) ||
          (this._safe(() =>
            this.cluster?.getByKindAndNamespace('LimitRange', incident.namespace)
          ) || [])[0];
    if (!lr) return { applied: false };

    if (incident.restoreState?.limits) {
      lr.spec = lr.spec || {};
      lr.spec.limits = incident.restoreState.limits;
    } else {
      lr.spec = lr.spec || {};
      lr.spec.limits = [
        {
          type: 'Container',
          max: { cpu: '2', memory: '2Gi' },
          min: { cpu: '10m', memory: '4Mi' },
          default: { cpu: '300m', memory: '256Mi' },
          defaultRequest: { cpu: '100m', memory: '128Mi' },
        },
      ];
    }
    this._clearAnnotation(lr, INCIDENT_ANNOTATION);
    this._recordEvent(
      lr,
      'Normal',
      'LimitRangeUpdated',
      'LimitRange bounds restored to a workable range'
    );
    this._commit(lr);
    return { applied: true, kind: 'limitrange', target: lr.name };
  }

  _healClusterQuota(incident, target) {
    const crq =
      target && target.kind === 'ClusterResourceQuota'
        ? target
        : this._findResource('ClusterResourceQuota', incident.target, '') ||
          (this._safe(() => this.cluster?.getByKind('ClusterResourceQuota')) || [])[0];
    if (!crq) return { applied: false };
    crq.status = crq.status || {};
    const restored = incident.restoreState?.status
      ? JSON.parse(JSON.stringify(incident.restoreState.status))
      : null;
    crq.status = { ...crq.status, ...(restored || {}) };
    crq.status.total = crq.status.total || {
      hard: crq.spec?.quota?.hard || { pods: '50' },
      used: { pods: 0 },
    };
    const hardPods = Number(crq.status.total.hard?.pods ?? crq.spec?.quota?.hard?.pods ?? 50);
    const usedPods = Number(crq.status.total.used?.pods ?? 0);
    crq.status.total.used = {
      ...(crq.status.total.used || {}),
      pods: Math.max(0, Math.min(usedPods, hardPods - 1)),
    };
    this._clearAnnotation(crq, INCIDENT_ANNOTATION);
    this._recordEvent(
      crq,
      'Normal',
      'QuotaUpdated',
      'ClusterResourceQuota usage is back within limits'
    );
    this._commit(crq);
    return { applied: true, kind: 'clusterquota', target: crq.name };
  }

  _healCronJob(incident, target) {
    const cron =
      target && target.kind === 'CronJob'
        ? target
        : this._findResource('CronJob', incident.target, incident.namespace) ||
          (this._safe(() => this.cluster?.getByKind('CronJob')) || [])[0];
    if (!cron) return { applied: false };
    cron.spec = cron.spec || {};
    cron.spec.suspend = false;
    cron.status = cron.status || {};
    cron.status.lastScheduleTime = nowIso();
    cron.status.active = [];
    this._clearAnnotation(cron, INCIDENT_ANNOTATION);
    this._recordEvent(cron, 'Normal', 'Resumed', 'CronJob resumed and scheduling Jobs again');
    this._commit(cron);
    return { applied: true, kind: 'cronjob', target: cron.name };
  }

  _healJob(incident, target) {
    const job =
      target && target.kind === 'Job'
        ? target
        : this._findResource('Job', incident.target, incident.namespace) ||
          (this._safe(() => this.cluster?.getByKind('Job')) || [])[0];
    if (!job) return { applied: false };
    // #31: never FABRICATE completion for a Job the learner already repaired by
    // delete+recreate (or otherwise moved out of Failed). Overwriting the fresh
    // Job to Complete used to skip the real controller, so no Pod was ever
    // created and `oc logs job/<name>` said "no pods found". Only a Job that is
    // still Failed (or absent) is force-completed by the resolution effect.
    if (job.status?.phase && job.status.phase !== 'Failed') {
      this._clearAnnotation(job, INCIDENT_ANNOTATION);
      this._commit(job);
      return { applied: true, kind: 'job', target: job.name, fabricated: false };
    }
    job.status = job.status || {};
    job.status.phase = 'Complete';
    job.status.succeeded = Math.max(job.status.succeeded || 0, 1);
    job.status.conditions = [
      {
        type: 'Complete',
        status: 'True',
        reason: 'JobCompleted',
        message: 'Job completed successfully',
        lastTransitionTime: nowIso(),
      },
    ];
    this._setCondition(job, 'Complete', 'True', 'JobCompleted', 'Job completed successfully');
    this._setCondition(job, 'Failed', 'False', 'JobCompleted', '');
    this._clearAnnotation(job, INCIDENT_ANNOTATION);
    this._recordEvent(job, 'Normal', 'JobCompleted', 'Job completed successfully');
    this._commit(job);
    return { applied: true, kind: 'job', target: job.name };
  }

  _healHpa(incident, target) {
    const hpa =
      target && target.kind === 'HorizontalPodAutoscaler'
        ? target
        : this._findResource('HorizontalPodAutoscaler', incident.target, incident.namespace) ||
          (this._safe(() => this.cluster?.getByKind('HorizontalPodAutoscaler')) || [])[0];
    if (!hpa) return { applied: false };
    this._setCondition(hpa, 'AbleToScale', 'True', 'ReadyForNewScale', 'the HPA is able to scale');
    this._setCondition(
      hpa,
      'ScalingActive',
      'True',
      'ValidMetricFound',
      'the HPA was able to successfully calculate a replica count'
    );
    hpa.status = hpa.status || {};
    hpa.status.currentReplicas = hpa.status.currentReplicas ?? hpa.status.desiredReplicas ?? 1;
    hpa.status.desiredReplicas = hpa.status.currentReplicas;
    this._clearAnnotation(hpa, INCIDENT_ANNOTATION);
    this._recordEvent(hpa, 'Normal', 'Healed', 'HPA can fetch metrics and scale again');
    this._commit(hpa);
    return { applied: true, kind: 'hpa', target: hpa.name };
  }

  _healPvc(incident, target) {
    const pvc =
      (target && target.kind === 'PersistentVolumeClaim' ? target : null) ||
      this._findResource('PersistentVolumeClaim', incident.target, incident.namespace) ||
      (this._safe(() => this.cluster?.getByKind('PersistentVolumeClaim')) || [])[0];
    if (!pvc) return { applied: false };

    const pvList = this._safe(() => this.cluster?.getByKind('PersistentVolume')) || [];
    let pv = pvList.find(
      (candidate) =>
        candidate.name === incident.restoreState?.volumeName ||
        candidate.status?.phase === 'Available' ||
        (candidate.status?.phase === 'Bound' && candidate.spec?.claimRef?.name === pvc.name)
    );
    if (!pv) {
      const name = `pv-${pvc.name}`;
      const obj = {
        kind: 'PersistentVolume',
        metadata: { name },
        spec: {
          capacity: { storage: pvc.spec?.resources?.requests?.storage || '1Gi' },
          accessModes: pvc.spec?.accessModes || ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: pvc.spec?.storageClassName || 'standard',
        },
        status: { phase: 'Available' },
      };
      pv =
        typeof this.cluster?.addResource === 'function'
          ? this._safe(() => this.cluster.addResource(obj))
          : null;
      if (!pv) {
        const r = new ResourceBase('PersistentVolume', 'v1', name, '');
        r.spec = obj.spec;
        r.status = obj.status;
        pv = this._safe(() => this.cluster.add(r));
      }
    }
    if (!pv) return { applied: false };

    pvc.spec = pvc.spec || {};
    pvc.spec.volumeName = pv.name;
    this._setPhase(pvc, 'Bound');
    pv.spec = pv.spec || {};
    pv.spec.claimRef = {
      kind: 'PersistentVolumeClaim',
      name: pvc.name,
      namespace: pvc.namespace,
      uid: pvc.uid,
    };
    pv.status = { ...(pv.status || {}), phase: 'Bound' };
    this._commit(pv);
    this._clearAnnotation(pvc, INCIDENT_ANNOTATION);
    this._recordEvent(pvc, 'Normal', 'Binding', `Bound to persistent volume ${pv.name}`);
    this._commit(pvc);
    return { applied: true, kind: 'pvc', target: pvc.name, pv: pv.name };
  }

  _healOperator(incident, target, resolution) {
    const sub =
      (target && target.kind === 'Subscription' ? target : null) ||
      this._findResource('Subscription', incident.target, incident.namespace) ||
      (this._safe(() => this.cluster?.getByKind('Subscription')) || [])[0];
    if (!sub) return { applied: false };

    const csvName =
      resolution.csvName ||
      `${String(sub.spec?.name || sub.name || 'operator').split('.')[0]}.v1.0.0`;
    sub.status = sub.status || {};
    sub.status.phase = 'Succeeded';
    sub.status.installedCSV = csvName;
    sub.status.currentCSV = sub.status.currentCSV || csvName;
    sub.status.state = 'AtLatestKnown';
    sub.status.conditions = [
      {
        type: 'CatalogSourcesUnhealthy',
        status: 'False',
        reason: 'AllCatalogSourcesHealthy',
        message: 'all available catalogsources are healthy',
        lastTransitionTime: nowIso(),
      },
    ];
    this._clearAnnotation(sub, INCIDENT_ANNOTATION);
    this._recordEvent(sub, 'Normal', 'InstallSucceeded', `operator installed: ${csvName}`);
    this._commit(sub);

    const csv = (this._safe(() => this.cluster?.getByKind('ClusterServiceVersion')) || []).find(
      (c) => c.name === csvName || c.name === sub.status?.installedCSV
    );
    if (csv) {
      this._setPhase(csv, 'Succeeded');
      this._recordEvent(csv, 'Normal', 'InstallSucceeded', 'CSV phase Succeeded');
      this._commit(csv);
    }

    // Heal a matching ClusterOperator (e.g. the metallb operator).
    const operatorName = String(incident.target || '').toLowerCase();
    const co = (this._safe(() => this.cluster.getClusterOperators?.()) || []).find(
      (op) =>
        operatorName.includes(op.name) || (sub.spec?.name || '').toLowerCase().includes(op.name)
    );
    if (co) {
      this._setCondition(co, 'Available', 'True', 'Healthy', '');
      this._setCondition(co, 'Degraded', 'False', 'Healthy', '');
      this._setCondition(co, 'Progressing', 'False', 'AsExpected', '');
      this._commit(co);
    }
    return { applied: true, kind: 'operator', csv: csvName };
  }

  _healClusterOperator(incident, target) {
    const co =
      (target && target.kind === 'ClusterOperator' ? target : null) ||
      this._findResource('ClusterOperator', incident.target, '') ||
      this._safe(() => this.cluster.getClusterOperator?.('ingress')) ||
      (this._safe(() => this.cluster?.getByKind('ClusterOperator')) || []).find(
        (c) => c.name === 'ingress'
      );
    if (!co) return { applied: false };

    if (typeof this.cluster?.setClusterOperatorState === 'function') {
      this._safe(() =>
        this.cluster.setClusterOperatorState(co.name, {
          available: true,
          progressing: false,
          degraded: false,
          message: 'Operator reconciled successfully',
        })
      );
    }
    this._setCondition(co, 'Available', 'True', 'AsExpected', '');
    this._setCondition(co, 'Progressing', 'False', 'AsExpected', '');
    this._setCondition(co, 'Degraded', 'False', 'AsExpected', '');
    this._clearAnnotation(co, INCIDENT_ANNOTATION);
    this._recordEvent(co, 'Normal', 'Healed', `ClusterOperator ${co.name} is healthy again`);
    this._commit(co);
    return { applied: true, kind: 'clusteroperator', target: co.name };
  }

  _healIngress(incident, target) {
    if (target && target.kind === 'Ingress') {
      target.status = target.status || {};
      target.status.loadBalancer = { ingress: [{ ip: '203.0.113.10' }] };
      this._clearAnnotation(target, INCIDENT_ANNOTATION);
      this._recordEvent(target, 'Normal', 'Healed', 'Ingress is admitted and has an address');
      this._commit(target);
    }
    this._healClusterOperator(incident, this._findResource('ClusterOperator', 'ingress', ''));
    return { applied: true, kind: 'ingress' };
  }

  _healOAuth(incident, target) {
    const oauth =
      (target && target.kind === 'OAuth' ? target : null) ||
      this._safe(() => this.cluster.getOAuth?.()) ||
      this._findResource('OAuth', 'cluster', '') ||
      (this._safe(() => this.cluster?.getByKind('OAuth')) || [])[0];

    if (oauth) {
      // Make sure an HTPasswd identity provider is configured.
      oauth.spec = oauth.spec || {};
      const providers = Array.isArray(oauth.spec.identityProviders)
        ? oauth.spec.identityProviders
        : [];
      if (!providers.some((provider) => provider.type === 'HTPasswd')) {
        oauth.spec.identityProviders = [
          ...providers,
          {
            name: 'htpasswd',
            mappingMethod: 'claim',
            type: 'HTPasswd',
            htpasswd: { fileData: { name: 'htpasswd-secret' } },
          },
        ];
      }
      this._setCondition(
        oauth,
        'Available',
        'True',
        'OAuthServerReady',
        'The OAuth server is ready'
      );
      this._clearAnnotation(oauth, INCIDENT_ANNOTATION);
      this._recordEvent(oauth, 'Normal', 'Healed', 'OAuth provider is ready; users can log in');
      this._commit(oauth);
    }

    // Restore the htpasswd Secret content removed by onset damage.
    const savedSecret = incident.restoreState?.oauthSecret;
    if (savedSecret) {
      const secret =
        (savedSecret.uid && this._safe(() => this.cluster.getResource?.(savedSecret.uid))) ||
        this._findResource('Secret', savedSecret.name || 'htpasswd-secret', 'openshift-config');
      if (secret) {
        secret.spec = secret.spec || {};
        secret.spec.data = JSON.parse(JSON.stringify(savedSecret.data || {}));
        if (!secret.spec.data.htpasswd) {
          secret.spec.data.htpasswd =
            typeof Buffer !== 'undefined'
              ? Buffer.from('placeholder-user:{SHA}placeholder\n').toString('base64')
              : 'cGxhY2Vob2xkZXI=';
        }
        this._clearAnnotation(secret, INCIDENT_ANNOTATION);
        this._recordEvent(
          secret,
          'Normal',
          'HTPasswdRestored',
          'htpasswd key restored from the identity-provider requirement'
        );
        this._commit(secret);
      }
    }

    // Re-sync the session-level provider and mark it ready.
    if (this.gameEngine) {
      if (typeof this.gameEngine._syncAuthProviderFromOAuth === 'function') {
        this._safe(() => this.gameEngine._syncAuthProviderFromOAuth({ silent: true }));
      }
      const provider =
        this.gameEngine.authProvider || this._safe(() => this.cluster.getAuthProviderConfig?.());
      if (provider) {
        this.gameEngine.authProvider = { ...provider, ready: true };
      } else {
        this.gameEngine.authProvider = {
          type: 'HTPasswd',
          name: 'htpasswd',
          secretName: 'htpasswd-secret',
          namespace: 'openshift-config',
          ready: true,
        };
      }
    }

    const co = this._safe(() => this.cluster.getClusterOperator?.('authentication'));
    if (co) {
      this._setCondition(co, 'Degraded', 'False', 'AsExpected', '');
      this._setCondition(co, 'Available', 'True', 'AsExpected', '');
      this._commit(co);
    }
    return { applied: true, kind: 'oauth' };
  }

  _healRbac(incident, target, resolution) {
    const ns = incident.namespace || this.gameEngine?.currentProject || 'default';
    let sa = target && target.kind === 'ServiceAccount' ? target : null;
    if (!sa) sa = this._findResource('ServiceAccount', incident.target, ns);
    if (!sa)
      sa =
        (this._safe(() => this.cluster?.getByKindAndNamespace('ServiceAccount', ns)) || [])[0] ||
        null;

    const addObject = (obj) => {
      if (typeof this.cluster?.addResource === 'function')
        return this._safe(() => this.cluster.addResource(obj));
      const rb = new ResourceBase(
        obj.kind || 'RoleBinding',
        'rbac.authorization.k8s.io/v1',
        obj.metadata.name,
        obj.metadata.namespace
      );
      rb.spec = obj.spec;
      rb.status = obj.status || { phase: 'Active' };
      return this._safe(() => this.cluster.add(rb));
    };

    // Restore role bindings removed by onset damage.
    const removed = incident.restoreState?.removedBindings || [];
    for (const saved of removed) {
      addObject({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: saved.name, namespace: saved.namespace || ns },
        spec: saved.spec || {
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' },
          subjects: [],
        },
        status: { phase: 'Active' },
      });
    }

    // Ensure a view binding exists for the ServiceAccount.
    if (sa) {
      const bindings =
        this._safe(() => this.cluster?.getByKindAndNamespace('RoleBinding', ns)) || [];
      const already = bindings.some((rb) =>
        (rb.spec?.subjects || []).some(
          (sub) => sub.kind === 'ServiceAccount' && sub.name === sa.name
        )
      );
      if (!already) {
        addObject({
          apiVersion: 'rbac.authorization.k8s.io/v1',
          kind: 'RoleBinding',
          metadata: { name: `${sa.name}-view`, namespace: ns },
          spec: {
            roleRef: {
              apiGroup: 'rbac.authorization.k8s.io',
              kind: 'ClusterRole',
              name: resolution?.role || 'view',
            },
            subjects: [{ kind: 'ServiceAccount', name: sa.name, namespace: ns }],
          },
          status: { phase: 'Active' },
        });
      }
      this._clearAnnotation(sa, INCIDENT_ANNOTATION);
      this._recordEvent(
        sa,
        'Normal',
        'AccessGranted',
        `view role bound to service account ${sa.name}`
      );
      this._commit(sa);
    }
    return { applied: !!sa || removed.length > 0, kind: 'rbac', restoredBindings: removed.length };
  }

  _healClusterWide(incident, target, effect) {
    if (effect === 'dns') {
      const dnsPods =
        this._safe(() => this.cluster?.getByKindAndNamespace('Pod', 'openshift-dns')) || [];
      for (const pod of dnsPods) this._healPodContainer(pod);
      if (target && target.kind === 'Pod') this._healPodContainer(target);
      const co = this._safe(() => this.cluster.getClusterOperator?.('dns'));
      if (co) {
        this._setCondition(co, 'Degraded', 'False', 'AsExpected', '');
        this._commit(co);
      }
      if (target) {
        this._clearAnnotation(target, INCIDENT_ANNOTATION);
        this._commit(target);
      }
      this.emit('cluster:dns-restored', { incidentId: incident.id, pods: dnsPods.length });
      return { applied: true, kind: 'dns', pods: dnsPods.length };
    }
    return this._healGeneric(incident, target);
  }

  _healGeneric(incident, target) {
    if (!target) return { applied: false };
    if (UNHEALTHY_PHASES.has(target.status?.phase)) this._setPhase(target, 'Running');
    if (Array.isArray(target.status?.conditions)) {
      for (const cond of target.status.conditions) {
        if (cond.status !== 'True') continue;
        if (['Degraded', 'Available', 'Ready', 'Admitted'].includes(cond.type)) {
          this._setCondition(
            target,
            cond.type,
            cond.type === 'Degraded' ? 'False' : 'True',
            'Healed',
            ''
          );
        }
      }
    }
    this._clearAnnotation(target, INCIDENT_ANNOTATION);
    this._recordEvent(target, 'Normal', 'Healed', 'Resource restored to a healthy state');
    this._commit(target);
    return { applied: true, kind: 'generic' };
  }

  _grantSccTo(incident, sccName, saName) {
    const state = this.cluster;
    if (!state || !sccName) return false;
    const namespace = incident.namespace || this.gameEngine?.currentProject || 'default';
    const saCandidates = saName
      ? [this._findResource('ServiceAccount', saName, namespace)]
      : this._safe(() => state.getByKindAndNamespace('ServiceAccount', namespace)) || [];
    const sa = saCandidates.find(Boolean) || null;
    const subject = sa
      ? { kind: 'ServiceAccount', name: sa.name, namespace: sa.namespace || namespace }
      : { kind: 'User', name: incident.target };

    if (typeof state.grantSCC === 'function') {
      const result = this._safe(() =>
        state.grantSCC(sccName, subject, { kind: subject.kind, namespace: subject.namespace })
      );
      if (result && result.success) {
        this.emit('scc:granted', {
          scc: sccName,
          subject: result.subject?.subject || `${subject.kind}/${subject.name}`,
          kind: result.subject?.kind || subject.kind,
          name: result.subject?.name || subject.name,
          namespace: result.subject?.namespace || subject.namespace,
          incidentId: incident.id,
        });
        return true;
      }
      return false;
    }

    // Fallback for older ClusterState: mutate the SCC users list directly.
    const scc =
      this._safe(() => state.getSCC?.(sccName)) ||
      this._findResource('SecurityContextConstraints', sccName, '');
    if (!scc) return false;
    const list = scc.spec?.users || scc.users || [];
    const entry = sa ? `system:serviceaccount:${subject.namespace}:${sa.name}` : subject.name;
    if (!list.includes(entry)) {
      list.push(entry);
      if (scc.spec) scc.spec.users = list;
      else scc.users = list;
      this._commit(scc);
    }
    this.emit('scc:granted', { scc: sccName, subject: entry, namespace, incidentId: incident.id });
    return true;
  }

  _bindClusterEvents() {
    const engine = this.gameEngine;
    if (!engine || typeof engine.on !== 'function') return;
    const handler = (payload) => this._onClusterModified(payload);
    const off = this._safe(() => engine.on('cluster:modified', handler));
    if (typeof off === 'function') this._clusterUnsubscribers.push(off);
    const offAdded = this._safe(() => engine.on('cluster:added', handler));
    if (typeof offAdded === 'function') this._clusterUnsubscribers.push(offAdded);
    // Investigation progress is driven by what the learner actually types:
    // `oc logs`/`oc describe` on any Pod owned by the incident target advances
    // the incident's investigation steps without the panel (GAME-004).
    const offCommand = this._safe(() =>
      engine.on('command:executed', (payload) => this._onCommandExecuted(payload))
    );
    if (typeof offCommand === 'function') this._clusterUnsubscribers.push(offCommand);
  }

  _unbindClusterEvents() {
    for (const off of this._clusterUnsubscribers) this._safe(off);
    this._clusterUnsubscribers = [];
  }

  // ── CLI-driven investigation (no panel required) ─────────────────────────
  /**
   * @param {{raw?:string, command?:string, success?:boolean}} payload
   */
  _onCommandExecuted(payload = {}) {
    if (this.paused || this._resolving) return;
    if (payload.success === false) return;
    const raw = String(payload.raw || payload.command || '').trim();
    if (!/^oc\s+/i.test(raw)) return;
    for (const [, incident] of this.activeIncidents) {
      if (incident.state === INCIDENT_STATE.RESOLVED) continue;
      if (incident.state === INCIDENT_STATE.CREATED) continue;
      // #35/#27: count the incident's OWN diagnostic commands as investigation
      // evidence from the CLI (no panel required) — e.g. SCCForbidden steps
      // `oc get sa -n <ns> -o name` and `oc adm policy who-can use scc
      // privileged`, quota `describe quota`, node `get nodes`, etc.
      const stepIndex = this._matchInvestigationStep(incident, raw);
      if (stepIndex >= 0) {
        this._completeInvestigationStep(incident, stepIndex, raw);
        continue;
      }
      // Legacy path: `oc logs`/`oc describe` on the damaged Pod or its owner
      // advances the first kind-matching step (the Pod name is not known when
      // the step text is authored).
      const match = raw.match(/^oc\s+(logs|describe)\s+(.*)$/i);
      if (!match) continue;
      const action = match[1].toLowerCase();
      const ref = this._parseInvestigationRef(match[2]);
      if (!ref || !this._commandTargetsIncident(incident, ref, action)) continue;
      this._advanceInvestigation(incident, action, raw);
    }
  }

  /** Alias map for investigation resource words (`sa` vs `serviceaccount`). */
  _investigationWord(word) {
    const text = String(word || '')
      .toLowerCase()
      .replace(/^['"]|['"]$/g, '');
    const aliases = {
      sa: 'serviceaccount',
      sas: 'serviceaccount',
      serviceaccounts: 'serviceaccount',
      deploy: 'deployment',
      deployments: 'deployment',
      bc: 'buildconfig',
      buildconfigs: 'buildconfig',
      is: 'imagestream',
      imagestreams: 'imagestream',
      istag: 'imagestreamtag',
      istags: 'imagestreamtag',
      sccs: 'scc',
      ns: 'namespace',
      namespaces: 'namespace',
      pv: 'persistentvolume',
      pvs: 'persistentvolume',
      pvc: 'persistentvolumeclaim',
      pvcs: 'persistentvolumeclaim',
      quota: 'resourcequota',
      quotas: 'resourcequota',
      clusterquota: 'clusterresourcequota',
      clusterquotas: 'clusterresourcequota',
      pods: 'pod',
      nodes: 'node',
      roles: 'role',
      rolebindings: 'rolebinding',
      clusterrolebindings: 'clusterrolebinding',
      configmaps: 'configmap',
      services: 'service',
      routes: 'route',
      secrets: 'secret',
    };
    if (aliases[text]) return aliases[text];
    if (text.startsWith('<') && text.endsWith('>')) return '<placeholder>';
    // Generic plural folding for words not covered above.
    if (text.length > 3 && text.endsWith('s') && !text.endsWith('ss')) return text.slice(0, -1);
    return text;
  }

  /**
   * Parse an `oc …` line into the words that matter for step matching plus the
   * namespace it runs against. Flags (and their values) are dropped so
   * `-o name` / `--output=yaml` / `--types=Warning` are optional for the learner.
   * @returns {{words:string[], namespace:string|null}}
   */
  _investigationEvidence(raw) {
    const tokens = String(raw || '')
      .trim()
      .replace(/^(?:oc|kubectl)\s+/i, '')
      .split(/\s+/)
      .map((token) => token.replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const flagsWithValues = new Set([
      '-n',
      '--namespace',
      '-o',
      '--output',
      '-f',
      '--filename',
      '-l',
      '--selector',
      '--field-selector',
      '--types',
      '-c',
      '--container',
      '-p',
      '--patch',
      '--type',
      '-z',
      '--serviceaccount',
      '--as',
      '--as-group',
      '-u',
      '--username',
      '--tail',
      '--since',
      '-A',
      '--all-namespaces',
    ]);
    const words = [];
    let namespace = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === '--') break;
      if (token.startsWith('-')) {
        let name = token;
        let value = null;
        const eq = token.indexOf('=');
        if (eq > 0) {
          name = token.slice(0, eq);
          value = token.slice(eq + 1);
        }
        if (!value && flagsWithValues.has(name) && i + 1 < tokens.length) {
          const next = tokens[i + 1];
          if (!next.startsWith('-') || name === '-n' || name === '--namespace') {
            value = next;
            i += 1;
          }
        }
        if (name === '-n' || name === '--namespace') namespace = value;
        continue;
      }
      // `pod/x` / `deploy/app` references are equivalent to `pod x`.
      if (token.includes('/')) {
        const [kind, ...rest] = token.split('/');
        words.push(kind, rest.join('/'));
      } else {
        words.push(token);
      }
    }
    return { words, namespace };
  }

  /**
   * Index of the first uncompleted investigation step that the executed
   * command satisfies, or -1.
   */
  _matchInvestigationStep(incident, raw) {
    const steps = incident?.investigationSteps || [];
    if (steps.length === 0) return -1;
    const evidence = this._investigationEvidence(raw);
    if (evidence.words.length === 0) return -1;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step?.command || step.completed) continue;
      if (this._commandSatisfiesStep(step.command, evidence, incident)) return index;
    }
    return -1;
  }

  /** Does an executed command satisfy one investigation step's command? */
  _commandSatisfiesStep(stepCommand, evidence, incident) {
    const expected = this._investigationEvidence(stepCommand);
    const expectedWords = expected.words.map((word) => this._investigationWord(word));
    const actualWords = evidence.words.map((word) => this._investigationWord(word));
    if (expectedWords.length === 0 || actualWords.length === 0) return false;
    if (expectedWords[0] !== actualWords[0]) return false;
    let actualIndex = 0;
    for (const word of expectedWords) {
      const actual = actualWords[actualIndex];
      if (actual === undefined) return false;
      if (word !== '<placeholder>' && word !== actual) return false;
      actualIndex += 1;
    }
    // A step that names the namespace only counts when the learner ran the
    // command against the incident's namespace (or their current project).
    if (expected.namespace) {
      const expectedNamespace = incident.namespace || this.gameEngine?.currentProject || '';
      const actualNamespace = evidence.namespace || this.gameEngine?.currentProject || '';
      if (expectedNamespace && actualNamespace && expectedNamespace !== actualNamespace)
        return false;
    }
    return true;
  }

  /** Mark one investigation step complete and announce it (panel + HUD). */
  _completeInvestigationStep(incident, index, raw) {
    if (!incident || index < 0) return;
    incident.startInvestigation();
    this.completeStep(incident.id, index);
    this.emit('incident:command-investigated', {
      id: incident.id,
      name: incident.name,
      command: raw,
      stepIndex: index,
      progress: incident.investigationProgress,
    });
  }

  /** Parse `pod/x`, `deploy/x`, `x`, `pod x`, `x -n ns`, `x --previous`. */
  _parseInvestigationRef(args = '') {
    const tokens = String(args)
      .split(/\s+/)
      .map((token) => token.replace(/^['"]|['"]$/g, ''))
      .filter((token) => token && !token.startsWith('-'));
    if (tokens.length === 0) return null;
    const first = tokens[0];
    if (first.includes('/')) {
      const [kind, ...rest] = first.split('/');
      return { kind: kind.toLowerCase(), name: rest.join('/') || tokens[1] || '' };
    }
    const kindPrefixes = [
      'pod',
      'pods',
      'deploy',
      'deployments',
      'deployment',
      'rs',
      'replicaset',
      'ds',
      'daemonset',
      'sts',
      'statefulset',
      'job',
      'jobs',
      'bc',
      'buildconfig',
      'build',
    ];
    if (kindPrefixes.includes(first.toLowerCase()) && tokens[1]) {
      return { kind: first.toLowerCase(), name: tokens[1] };
    }
    return { kind: 'pod', name: first };
  }

  /** Does this `oc logs/describe` reference a Pod/owner of the incident target? */
  _commandTargetsIncident(incident, ref, action) {
    const target = this._resolveTargetResource(incident);
    const workloadNames = new Set(
      [incident.target, target?.name, target?.metadata?.name].filter(Boolean).map(String)
    );
    const podNames = new Set(
      this._workloadPods(target)
        .map((pod) => pod.metadata?.name || pod.name)
        .filter(Boolean)
    );
    if (incident.targetPod) podNames.add(incident.targetPod);
    const workloadKinds = new Set([
      'deploy',
      'deployments',
      'deployment',
      'rs',
      'replicaset',
      'ds',
      'daemonset',
      'sts',
      'statefulset',
    ]);
    if (workloadKinds.has(ref.kind)) {
      return workloadNames.has(ref.name);
    }
    if (ref.kind === 'job' || ref.kind === 'jobs') {
      return incident.target === ref.name || target?.name === ref.name;
    }
    // Pod reference (explicit `pod/x` or a bare name that resolves to a Pod):
    if (podNames.has(ref.name)) return true;
    if (action === 'logs' && incident.resolution?.targetKind === 'Pod') {
      // `oc logs <deployment>` is also accepted for workload incidents.
      return workloadNames.has(ref.name) || podNames.has(ref.name);
    }
    return false;
  }

  /** Advance the first not-yet-completed step matching the command kind. */
  _advanceInvestigation(incident, action, raw) {
    const steps = incident.investigationSteps || [];
    if (steps.length === 0) return;
    const wantsLogs = action === 'logs';
    const candidate = steps.findIndex((step, index) => {
      if (step.completed || incident._investigatedSteps?.has?.(index)) return false;
      const command = String(step.command || '').toLowerCase();
      if (wantsLogs) return command.includes('logs');
      return command.includes('describe') || command.includes('get pod');
    });
    const index = candidate >= 0 ? candidate : steps.findIndex((step) => !step.completed);
    if (index < 0) return;
    this._completeInvestigationStep(incident, index, raw);
  }

  /** Retry onset damage for an incident whose target appeared late. */
  _retryOnsetDamage(incident) {
    if (!incident || incident.damageApplied || incident._retryingDamage) return false;
    incident._retryingDamage = true;
    let damage = null;
    try {
      damage = this.applyIncidentEffects(incident);
    } finally {
      incident._retryingDamage = false;
    }
    if (damage && damage.applied !== false) {
      incident.damageApplied = true;
      incident.pendingTarget = false;
      return true;
    }
    return false;
  }

  _onClusterModified() {
    if (this.paused || this._resolving) return;
    if (this.activeIncidents.size === 0) return;
    const gameSeconds = this.elapsedTime / 1000;
    for (const [id, incident] of [...this.activeIncidents]) {
      if (incident.state === INCIDENT_STATE.CREATED) continue;

      // Onset damage can miss its target (e.g. a Deployment with no Pods yet).
      // Retry once resources appear so the incident becomes "real".
      if (!incident.damageApplied) {
        if (!incident._retryingDamage) this._retryOnsetDamage(incident);
        continue;
      }

      // A real fix to the owning workload (oc set image / edit / rollout undo)
      // replaces the faulty Pod in a real cluster. The damaged Pod object cannot
      // recover on its own here, so treat a SEMANTIC container change since
      // onset as the canonical remediation (GAME-006).
      if (!STATE_RESOLVABLE.has(incident.name) && incident.baseline?.workload) {
        const healedByFix = this._safe(
          () => this._healPodIncidentFromWorkloadChange(incident, id),
          false
        );
        if (healedByFix) continue;
        // Not fixed yet: the controller may have recreated Pods (e.g. after
        // `oc delete pod`). Re-inject the same damage on healthy replacements so
        // "restart until green" does not work — the broken image/command comes
        // back on a real cluster too.
        this._safe(() => this._redamageReplacementPods(incident), false);
        continue;
      }
      if (!STATE_RESOLVABLE.has(incident.name)) continue;
      if (!this._incidentPastActivationGrace(incident, gameSeconds)) continue;
      // Shared with the per-tick pass (#27a) so both paths stay identical.
      this._checkIncidentHealth(id, incident, gameSeconds);
    }
  }

  /**
   * Pod/workload incidents: if the owning workload's template/generation changed
   * after onset, replace the damaged Pod state (the learner fixed the workload).
   * @returns {boolean} true when the incident was resolved.
   */
  _healPodIncidentFromWorkloadChange(incident, incidentId) {
    if (this._resolving || incident._handlingWorkloadFix) return false;
    incident._handlingWorkloadFix = true;
    try {
      return this._healPodIncidentFromWorkloadChangeInner(incident, incidentId);
    } finally {
      incident._handlingWorkloadFix = false;
    }
  }

  /**
   * The workload template is still broken but the controller created fresh Pods
   * (e.g. after `oc delete pod` or a rollout restart). Re-apply the onset damage
   * to those Pods so deleting/restarting does not fake a fix.
   */
  _redamageReplacementPods(incident) {
    if (this._resolving || incident._redamaging) return false;
    if (!incident.damageSpec) return false;
    const target = this._resolveTargetResource(incident);
    if (!target || target.kind === 'Pod') return false;
    // Only re-damage while the workload template is STILL the broken one: once
    // the learner fixes the image/command/env, replacement Pods must come up
    // healthy (otherwise this safety net would undo the fix).
    // #31 A1: with a seed/fix contract, "fixed" is defined by the fix (e.g.
    // APP_MODE in allowed[]), not by any semantic signature change — so
    // `oc set env FOO=bar` keeps re-damaging the fresh Pods.
    const base = incident.baseline?.workload;
    if (incident.fix) {
      if (this._incidentFixSatisfied(incident, target)) return false;
    } else if (base) {
      const currentContainers =
        this._safe(() => this._containerSemanticSignature(target), '') || '';
      const currentTemplate =
        this._safe(() => JSON.stringify(target.spec?.template || {}), '') || '';
      const fixed = base.containers
        ? base.containers !== currentContainers
        : base.template !== currentTemplate;
      if (fixed) return false;
    }
    const pods = this._workloadPods(target);
    if (pods.length === 0) return false;
    const podHealthy = (pod) =>
      !!pod &&
      pod.status?.phase === 'Running' &&
      (pod.isConditionTrue ? pod.isConditionTrue('Ready') : true);
    const fresh = pods.filter(
      (pod) => podHealthy(pod) && !pod.metadata?.annotations?.[INCIDENT_ANNOTATION]
    );
    if (fresh.length === 0) return false;
    incident._redamaging = true;
    try {
      for (const pod of fresh) this._damagePodObject(incident, pod, incident.damageSpec);
      for (const pod of fresh) this._commit(pod);
      this.emit('incident:redamaged', {
        id: incident.id,
        name: incident.name,
        pods: fresh.map((pod) => pod.metadata?.name || pod.name),
      });
      return true;
    } finally {
      incident._redamaging = false;
    }
  }

  _healPodIncidentFromWorkloadChangeInner(incident, incidentId) {
    const target = this._resolveTargetResource(incident);
    if (!target || target.kind === 'Pod') return false;
    const base = incident.baseline?.workload;
    if (!base) return false;
    const currentTemplate = this._safe(() => JSON.stringify(target.spec?.template || {}), '') || '';
    const currentContainers = this._safe(() => this._containerSemanticSignature(target), '') || '';
    const currentGeneration = Number(target.metadata?.generation ?? 1);
    // A fix means the CONTAINER SPEC changed — image, command/args, env,
    // securityContext. `oc rollout restart` (template metadata annotation) or a
    // replica-only change is NOT a fix: on a real cluster the same broken
    // configuration comes back. CrashLoopBackOff/OOMKilled style incidents
    // therefore only heal on a semantic container change; other pod incidents
    // (missing ConfigMap/Secret, PendingScheduling, probes) may also heal from a
    // template change that restores the reference.
    const semanticOnly = new Set([
      'CrashLoopBackOff',
      'ImagePullBackOff',
      'OOMKilled',
      'CreateContainerConfigError',
      'ReadinessProbeFailure',
      'LivenessProbeFailure',
    ]);
    const semanticChanged = Boolean(base.containers)
      ? base.containers !== currentContainers
      : currentTemplate !== base.template;
    const templateChanged =
      currentTemplate !== base.template || currentGeneration > base.generation;
    let changed = semanticOnly.has(incident.name) ? semanticChanged : templateChanged;
    // #31 A1: when the level authors a seed/fix contract, ONLY satisfying the
    // fix counts. Any other template change (e.g. `oc set env FOO=bar`) would
    // change the semantic signature but must not heal the incident.
    if (incident.fix) {
      if (!this._incidentFixSatisfied(incident, target)) return false;
      changed = true;
    }
    if (!changed) return false;

    // Heal every damaged Pod so the workload can report healthy replicas.
    const pods = this._workloadPods(target);
    for (const pod of pods) {
      if (!pod) continue;
      this._healPodContainer(pod);
      this._clearAnnotation(pod, 'openshiftgames/scc-denied');
      this._annotate(pod, HEAL_ANNOTATION, nowIso());
    }
    const healthy = this._workloadPods(target).every(
      (pod) =>
        pod.status?.phase === 'Running' &&
        (pod.isConditionTrue ? pod.isConditionTrue('Ready') : true)
    );
    if (healthy) {
      this._recordEvent(
        target,
        'Normal',
        'RolloutRecovered',
        semanticOnly.has(incident.name)
          ? 'Container spec changed; workload is healthy again'
          : 'Pod template updated; workload is healthy again'
      );
      this._commit(target);
      this.resolveIncident(incidentId, 'resource-fixed');
      return true;
    }
    return false;
  }

  /** Does the incident target look healthy enough to auto-clear the incident? */
  _targetLooksHealthy(incident) {
    const target = this._resolveTargetResource(incident);
    // #27(b): this function deliberately continues when the target cannot be
    // resolved. Several checks are state-based on OTHER objects (SCC bindings,
    // htpasswd provider, the namespace quota, DNS policies) and used to be
    // unreachable because a null target short-circuited the whole switch. Each
    // per-type case below guards the target it actually needs.
    // NOTE: the injected `openshiftgames.io/incident` annotation is cleared by
    // applyResolutionEffects; it must NOT block state-driven healing, otherwise
    // a player fixing the resource via the CLI would never auto-clear the card.

    const podHealthy = (pod) =>
      !!pod &&
      pod.status?.phase === 'Running' &&
      (pod.isConditionTrue ? pod.isConditionTrue('Ready') : true);

    switch (incident.name) {
      case 'CrashLoopBackOff':
      case 'ImagePullBackOff':
      case 'OOMKilled':
      case 'CreateContainerConfigError':
      case 'ConfigMapMissing':
      case 'SecretMissing':
      case 'PendingScheduling':
      case 'ReadinessProbeFailure':
      case 'LivenessProbeFailure':
      case 'PodStuckTerminating': {
        const pods =
          incident.name === 'PodStuckTerminating' ? [target] : this._workloadPods(target);
        if (pods.length === 0) return podHealthy(target);
        return pods.every(podHealthy);
      }
      case 'SCCForbidden': {
        // Real 4.x: the rejected Pod is never created. The incident clears when
        // the learner's RBAC binding actually grants the SCC to the workload SA
        // (no auto-grant, no fabricated Failed Pod).
        return this._incidentSccGranted(incident);
      }
      case 'DeploymentStuckRollout': {
        if (!target || target.kind !== 'Deployment') return false;
        const desired = target.spec?.replicas ?? 1;
        return (
          (target.status?.availableReplicas || 0) >= desired &&
          this._isConditionTrue(target, 'Available')
        );
      }
      case 'NodeNotReady':
        return !!target && target.kind === 'Node' && this._isConditionTrue(target, 'Ready');
      case 'NodeDiskPressure':
        return !!target && target.kind === 'Node' && !this._isConditionTrue(target, 'DiskPressure');
      case 'NodeMemoryPressure':
        return (
          !!target && target.kind === 'Node' && !this._isConditionTrue(target, 'MemoryPressure')
        );
      case 'RouteNotAdmitted':
      case 'RouteTLSCertificateError':
      case 'RouteHostConflict':
        return (
          !!target &&
          target.kind === 'Route' &&
          (typeof this.cluster?.isRouteAdmitted === 'function'
            ? !!this._safe(() => this.cluster.isRouteAdmitted(target))
            : (target.status?.ingress || []).some((i) =>
                (i.conditions || []).some((c) => c.type === 'Admitted' && c.status === 'True')
              ))
        );
      case 'ServiceNoEndpoints': {
        if (!target || target.kind !== 'Service') return false;
        if (typeof this.cluster?.getServiceEndpoints === 'function') {
          return (this._safe(() => this.cluster.getServiceEndpoints(target)) || []).length > 0;
        }
        const selector = target.spec?.selector || {};
        const pods = (
          this._safe(() => this.cluster?.getByKindAndNamespace('Pod', target.namespace)) || []
        ).filter((p) =>
          Object.entries(selector).every(([k, v]) => (p.metadata?.labels || {})[k] === v)
        );
        return pods.some(podHealthy);
      }
      case 'NetworkPolicyBlocking': {
        if (!target || target.kind !== 'NetworkPolicy') return false;
        return Array.isArray(target.spec?.ingress) && target.spec.ingress.length > 0;
      }
      case 'DNSResolutionFailure': {
        // The learner fix on OpenShift is an egress policy allowing the
        // dns-default Pod port (5353) to the openshift-dns namespace — accept
        // that as remediation even before the DNS Pods are re-admitted.
        const policies =
          this._safe(() =>
            this.cluster?.getByKindAndNamespace('NetworkPolicy', incident.namespace)
          ) || [];
        const allowsDns = policies.some((policy) => {
          const rules = Array.isArray(policy.spec?.egress) ? policy.spec.egress : [];
          return rules.some((rule) =>
            (rule.ports || []).some((port) => Number(port?.port) === 5353)
          );
        });
        if (allowsDns) return true;
        const dnsPods =
          this._safe(() => this.cluster?.getByKindAndNamespace('Pod', 'openshift-dns')) || [];
        if (dnsPods.length === 0) {
          const co = this._safe(() => this.cluster.getClusterOperator?.('dns'));
          return !!co && !this._isConditionTrue(co, 'Degraded');
        }
        return dnsPods.every(podHealthy);
      }
      case 'IngressDegraded':
        return (
          !!target &&
          target.kind === 'ClusterOperator' &&
          !this._isConditionTrue(target, 'Degraded')
        );
      case 'LoadBalancerPending':
        return (
          !!target &&
          target.kind === 'Service' &&
          (target.status?.loadBalancer?.ingress || []).length > 0
        );
      case 'UnauthorizedAccess': {
        // The damaged identity is stored at onset (the incident target is the
        // workload, not the ServiceAccount). Any real RoleBinding/ClusterRoleBinding
        // for that SA (e.g. `oc adm policy add-role-to-user view -z default`)
        // repairs the denial — the panel is not the only exit.
        let subject =
          incident.rbacSubject ||
          (target?.kind === 'ServiceAccount'
            ? { kind: 'ServiceAccount', name: target.name, namespace: target.namespace }
            : null);
        if (!subject?.name) {
          if (!target) return false;
          // Derive from the workload's pod template / running Pods (default SA
          // when nothing is explicit) so older incidents still detect repairs.
          const podSpec = target.kind === 'Pod' ? target.spec : target.spec?.template?.spec;
          let saName = podSpec?.serviceAccountName || podSpec?.serviceAccount || '';
          let saNamespace =
            incident.namespace || target.namespace || target.metadata?.namespace || '';
          if (!saName) {
            const pods = target.kind === 'Pod' ? [target] : this._workloadPods(target);
            saName = pods[0]?.spec?.serviceAccountName || 'default';
          }
          subject = { kind: 'ServiceAccount', name: saName || 'default', namespace: saNamespace };
        }
        const namespace = subject.namespace || incident.namespace;
        const bindings = [
          ...(this._safe(() => this.cluster?.getByKindAndNamespace('RoleBinding', namespace)) ||
            []),
          ...(this._safe(() => this.cluster?.getByKind('ClusterRoleBinding')) || []),
        ];
        return bindings.some((binding) => {
          const subjects = binding.spec?.subjects || binding.subjects || [];
          return subjects.some(
            (entry) =>
              entry?.kind === 'ServiceAccount' &&
              entry.name === subject.name &&
              (!entry.namespace || entry.namespace === namespace)
          );
        });
      }
      case 'HTPasswdAuthFailure': {
        // Provider must be ready AND the referenced htpasswd Secret must
        // actually contain the `htpasswd` key; an OAuth rollout alone is not a fix.
        const provider =
          this.gameEngine?.authProvider || this._safe(() => this.cluster.getAuthProviderConfig?.());
        if (!provider?.ready) return false;
        const secretName =
          provider.secretName || provider.htpasswd?.fileData?.name || 'htpasswd-secret';
        const secret = this._findResource('Secret', secretName, 'openshift-config');
        if (!secret) return false;
        const data = secret.spec?.data || secret.data || {};
        if (!data.htpasswd) return false;
        const oauth = this._safe(() => this.cluster.getOAuth?.());
        if (oauth && this._isConditionTrue(oauth, 'Available') === false) {
          const conditions = oauth.status?.conditions || [];
          const unavailable = conditions.some(
            (c) => c.type === 'Available' && c.status === 'False'
          );
          if (unavailable) return false;
        }
        return true;
      }
      case 'ResourceQuotaExceeded': {
        // #27(b): the incident target is sometimes the namespace (L15) and
        // sometimes a quota name the learner never created (lab 6 authors
        // "team-quota" while examples/quota.yaml creates "compute-quota").
        // Onset damage binds `damagedQuotaName`/`target` to the real object;
        // the check accepts a target-less evaluation and falls back to the
        // namespace-wide quota state so it can never soft-lock.
        const ns = incident.namespace || target?.namespace || this.gameEngine?.currentProject || '';
        const check = this._safe(() => this.cluster.checkQuota?.(ns, 0, 0));
        if (check && check.allowed === false) return false;
        const quotas = this._safe(() => this.cluster.getResourceQuotaObjects?.(ns)) || [];
        if (quotas.length === 0) return false;
        const damagedName = incident.damagedQuotaName;
        let damaged = target?.kind === 'ResourceQuota' ? target : null;
        if (damagedName) {
          damaged =
            quotas.find((quota) => (quota.name || quota.metadata?.name) === damagedName) || null;
          // The damaged quota must still exist (raising a different quota is
          // not a fix for this incident).
          if (!damaged) return false;
        }
        // #31 A2: the damaged state is Used == Hard (no room for the blocked
        // replacement Pod). The learner fixed it when the pods dimension has
        // room again — by raising the hard limit or by freeing usage.
        const hardPods = Number(damaged?.spec?.hard?.pods);
        if (!Number.isFinite(hardPods)) return true;
        const usage = this._safe(() => this.cluster.getQuotaUsage?.(ns)) || {};
        const usedPods = Number(usage.pods);
        if (!Number.isFinite(usedPods)) return true;
        return usedPods < hardPods;
      }
      case 'LimitRangeViolation':
        return !!target && !this._isConditionTrue(target, 'Exceeded');
      case 'ClusterResourceQuotaExceeded': {
        if (!target) return false;
        const total = target.status?.total;
        if (!total) return false;
        return Number(total.used?.pods ?? 0) < Number(total.hard?.pods ?? Infinity);
      }
      case 'JobDeadlineExceeded': {
        // A Failed Job cannot be resumed: the CLI repair is delete + recreate,
        // or a patch that replaces the Job. Resolve when a Job with the target
        // name completes after the damaged object was replaced/changed, keeping
        // the panel from being the only exit.
        const job =
          target?.kind === 'Job'
            ? target
            : this._findResource('Job', incident.target, incident.namespace);
        if (!job) return false;
        const phase = job.status?.phase;
        if (phase === 'Complete' || phase === 'Succeeded') return true;
        const restore = incident.restoreState || {};
        const recreated = restore.uid && job.uid && job.uid !== restore.uid;
        if (recreated) return phase !== 'Failed';
        const specChanged =
          restore.activeDeadlineSeconds !== (job.spec?.activeDeadlineSeconds ?? null) ||
          (restore.containers &&
            restore.containers !== this._safe(() => this._containerSemanticSignature(job), ''));
        return specChanged && phase !== 'Failed';
      }
      case 'CronJobMissedSchedule':
        return !!target && target.kind === 'CronJob' && target.spec?.suspend !== true;
      case 'PVCPending':
        return (
          !!target && target.kind === 'PersistentVolumeClaim' && target.status?.phase === 'Bound'
        );
      case 'ImageStreamTagMissing': {
        if (!target || target.kind !== 'ImageStream') return false;
        const tag = incident.resolution?.tag || 'latest';
        const tags = (target.status?.tags || []).map((entry) => entry.tag || entry.name);
        const specTags = (target.spec?.tags || []).map((entry) => entry.name);
        // Only THIS stream/tag counts; unrelated seeded ImageStreams (openshift
        // namespace) must not auto-resolve the incident.
        return tags.includes(tag) || specTags.includes(tag);
      }
      case 'BuildFailed': {
        if (!target) return false;
        const targetName = target.kind === 'Build' ? resourceName(target) : incident.target;
        const bcName =
          target.kind === 'Build' ? target.spec?.buildConfig?.name || null : targetName || null;
        if (target.kind === 'Build' && target.status?.phase === 'Complete') return true;
        const builds = this._safe(() => this.cluster?.getByKind('Build')) || [];
        const onset = Number(incident.createdAt) || 0;
        const succeededSinceOnset = builds.some((build) => {
          if (build.status?.phase !== 'Complete') return false;
          const sameConfig =
            bcName &&
            (build.spec?.buildConfig?.name === bcName ||
              resourceName(build).startsWith(`${bcName}-`));
          if (bcName ? !sameConfig : true) return false;
          const created = Date.parse(build.metadata?.creationTimestamp || '') || 0;
          return created >= onset;
        });
        if (succeededSinceOnset) return true;
        // BuildConfig target: a new completed build produced from it also counts.
        if (target.kind === 'BuildConfig') {
          return builds.some(
            (build) =>
              build.status?.phase === 'Complete' &&
              (build.spec?.buildConfig?.name === resourceName(target) ||
                resourceName(build).startsWith(`${resourceName(target)}-`)) &&
              (Date.parse(build.metadata?.creationTimestamp || '') || 0) >= onset
          );
        }
        return false;
      }
      case 'HPAUnableToScale':
        return !!target && this._isConditionTrue(target, 'AbleToScale');
      case 'OperatorInstallFailed': {
        if (!target || target.kind !== 'Subscription') return false;
        if (target.status?.phase !== 'Succeeded') return false;
        if (!target.status?.installedCSV) return false;
        const conditions = Array.isArray(target.status?.conditions) ? target.status.conditions : [];
        const stillUnhealthy = conditions.some(
          (condition) =>
            condition?.type === 'CatalogSourcesUnhealthy' && String(condition.status) === 'True'
        );
        // The damaged condition must be cleared/replaced (panel heal, delete +
        // recreate Subscription, or a successful OLM reconcile) — a Succeeded
        // phase that was already there is not a fix.
        return !stillUnhealthy;
      }
      case 'SecretExposed':
        return (
          Boolean(target) && target.metadata?.annotations?.['openshiftgames.io/exposed'] !== 'true'
        );
      default:
        return false;
    }
  }

  _parseCpuMillis(value) {
    if (typeof value === 'number') return value;
    const str = String(value ?? '0');
    if (str.endsWith('m')) return parseInt(str, 10) || 0;
    return Math.round((parseFloat(str) || 0) * 1000);
  }

  _parseMemoryMi(value) {
    if (typeof value === 'number') return value;
    const str = String(value ?? '0');
    if (str.endsWith('Gi')) return Math.round((parseFloat(str) || 0) * 1024);
    if (str.endsWith('Mi')) return Math.round(parseFloat(str) || 0);
    if (str.endsWith('Ki')) return Math.round((parseFloat(str) || 0) / 1024);
    return Math.round(parseFloat(str) || 0);
  }

  getActiveIncidents() {
    return Array.from(this.activeIncidents.values()).map((inc) => inc.getSummary());
  }

  getIncidentDetails(incidentId) {
    const incident = this.activeIncidents.get(incidentId);
    if (!incident) return null;
    return {
      id: incident.id,
      defId: incident.defId,
      name: incident.name,
      category: incident.category,
      severity: incident.severity,
      description: incident.description,
      state: incident.state,
      target: incident.target,
      namespace: incident.namespace,
      uid: incident.uid,
      targetPod: incident.targetPod,
      targetPodUid: incident.targetPodUid,
      damagedSubject: incident.rbacSubject || null,
      visualEffect: incident.visualEffect,
      investigationSteps: incident.investigationSteps,
      resolutionActions: incident.resolutionActions,
      ocCommands: incident.ocCommands,
      docsUrl: incident.docsUrl,
      resolution: incident.resolution,
      investigationProgress: incident.investigationProgress,
      cascadeParent: incident.cascadeParent,
      cascadeChildren: incident.cascadeChildren,
      createdAt: incident.createdAt,
      activatedAt: incident.activatedAt,
      autoResolveTime: incident.autoResolveTime,
      pendingTarget: Boolean(incident.pendingTarget),
    };
  }

  /**
   * Activation epoch of the current level/challenge. Captured when the level
   * started (start()/reset()) BEFORE one-shot `triggerTime: 0` preloads fire,
   * so ObjectiveEvaluator can tell "an incident happened during this level"
   * apart from "an incident was already counted when the first evaluation ran"
   * (#22: timed lab 02 soft-lock).
   */
  getActivationEpoch() {
    return Number.isFinite(this.levelStartActivationCount) ? this.levelStartActivationCount : 0;
  }

  /**
   * Whether the current level still has scripted incidents that can activate.
   * When the queue is empty (and none ever activated) an activation gate can
   * never be satisfied — e.g. campaign L10's bad-image rollout is modelled by
   * SimulationTick, not by a scripted IncidentEngine incident — so the
   * ObjectiveEvaluator must fall back to the health check instead of waiting
   * forever for an incident that cannot happen.
   */
  hasIncidentPlan() {
    return this.scriptedQueue.length > 0;
  }

  getStats() {
    const total = this.resolvedIncidents.length;
    const avgResolveTime =
      total > 0
        ? this.resolvedIncidents.reduce((sum, inc) => sum + (inc.getResolutionTime() || 0), 0) /
          total
        : 0;

    const bySeverity = {};
    for (const inc of this.resolvedIncidents) {
      bySeverity[inc.severity] = (bySeverity[inc.severity] || 0) + 1;
    }

    const byCategory = {};
    for (const inc of this.resolvedIncidents) {
      byCategory[inc.category] = (byCategory[inc.category] || 0) + 1;
    }

    const cascadeCount = this.resolvedIncidents.filter(
      (inc) => inc.cascadeChildren.length > 0
    ).length;

    return {
      totalResolved: total,
      activeCount: this.activeIncidents.size,
      averageResolveTime: Math.round(avgResolveTime * 10) / 10,
      bySeverity,
      byCategory,
      cascadeCount,
      currentCombo: this.comboCount,
      activationCount: this.activationCount,
      difficultyLevel: this.difficultyLevel,
      effectsApplied: this.resolvedIncidents.filter((i) => i.effectApplied?.applied).length,
    };
  }

  getClusterHealth() {
    let healthPenalty = 0;
    for (const [, incident] of this.activeIncidents) {
      const severityInfo = SEVERITY_LEVELS.find((s) => s.level === incident.severity);
      const multiplier = severityInfo ? incident.severity / 5 : 0.2;
      healthPenalty += multiplier * 15;
    }
    return Math.max(0, Math.min(100, 100 - healthPenalty));
  }

  reset() {
    this.stop();
    this._unbindClusterEvents();
    this._clearAnnounceTimers();
    this.activeIncidents.clear();
    this.resolvedIncidents = [];
    this.incidentHistory = [];
    this.incidentCounter = 0;
    this.difficultyLevel = 1;
    this.activationCount = 0;
    this.levelStartActivationCount = 0;
    this.comboCount = 0;
    this.lastResolveTime = 0;
    this.lastResolveGameSeconds = null;
    this.scriptedQueue = [];
    this.elapsedTime = 0;
    this._resolving = false;
    this._externalTickSeen = false;
    this._lastStateHealGameSeconds = null;
  }

  destroy() {
    this.reset();
    this.gameEngine = null;
  }
}

export { IncidentEngine, Incident, INCIDENT_STATE };
