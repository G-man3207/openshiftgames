/**
 * CampaignMode — campaign runner: the optional Linux & RHEL Foundations prelude
 * (chapter 0) plus the EX280 track (chapters 1–5).
 *
 * Responsibilities:
 *  - load CONVERSION-SPEC §9 level data (js/data/CampaignLevels.js); campaign
 *    ORDER, unlocking and display labels come from its helpers — level ids are
 *    stable save keys, never positions,
 *  - seed the level's Projects/Nodes/workloads through the registry factory,
 *  - seed the Files/Manifests panel for declarative levels (manifestFiles/focusFiles),
 *  - seed the simulated RHEL workstation for Linux levels (`levelDef.linuxHost`),
 *  - load scripted incidents,
 *  - evaluate objectives every second via js/engine/ObjectiveEvaluator.js,
 *  - keep the public API consumed by index.html unchanged
 *    (startLevel/getLevels/getChapters/getStatus/useHint/nextLevel/retryLevel/
 *     pause/resume/exitToMenu/destroy + currentLevelDef/objectiveProgress).
 *
 * No engine edits: every optional engine API is feature-detected so this mode
 * also works against partially-integrated builds and in the Node test harness.
 */

import {
  CAMPAIGN_LEVELS,
  CHAPTERS,
  EX280_ORDER,
  continueLevelId,
  getCampaignLevel,
  isLevelUnlocked,
  isPreludeLevel,
  levelLabel,
} from '../data/CampaignLevels.js';
import {
  createObjectiveProgress,
  evaluateObjectives,
  getObjectiveSummary,
} from '../engine/ObjectiveEvaluator.js';

const CAMPAIGN_STATE = {
  MENU: 'menu',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const DEFAULT_PROJECT = 'default';
const DEFAULT_USER = 'kubeadmin';

/** Seeded kinds that get the conventional `app=<name>` label (application objects). */
const APP_LABELED_KINDS = new Set([
  'Pod',
  'Deployment',
  'ReplicaSet',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'Service',
  'Route',
  'Ingress',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
  'HorizontalPodAutoscaler',
  'PodDisruptionBudget',
  'BuildConfig',
  'Build',
  'ImageStream',
]);

class CampaignMode {
  constructor(gameEngine, incidentEngine, scoringEngine) {
    this.gameEngine = gameEngine;
    this.incidentEngine = incidentEngine;
    this.scoringEngine = scoringEngine;
    this.state = CAMPAIGN_STATE.MENU;
    this.currentLevel = null;
    this.currentLevelDef = null;
    this.objectiveProgress = [];
    this.startTime = 0;
    this.elapsedTime = 0;
    this.pausedTime = 0;
    this.pauseStart = 0;
    this.ticker = null;
    this.hadFailures = false;
    this.usedHints = false;
    this.campaignFinished = false;
    this.tutorialStep = 0;
    this.tutorialActive = false;
    this.levelRetryCount = 0;

    if (this.gameEngine) this.gameEngine.campaignLevels = CAMPAIGN_LEVELS;
  }

  // ─── menu data ────────────────────────────────────────────────────────────

  getLevels() {
    const progress = this.scoringEngine?.getProgress?.() || { campaignProgress: {} };
    const campaignProgress = progress.campaignProgress || {};
    return CAMPAIGN_LEVELS.map((level) => {
      const levelProgress = campaignProgress[level.id];
      return {
        id: level.id,
        label: levelLabel(level.id),
        prelude: isPreludeLevel(level.id),
        title: level.title,
        chapter: level.chapter,
        chapterName: level.chapterName,
        description: level.description,
        examObjectives: level.examObjectives,
        docsLinks: level.docsLinks,
        objectives: level.objectives,
        manifestFiles: level.manifestFiles || [],
        focusFiles: level.focusFiles || [],
        locked: !isLevelUnlocked(level.id, campaignProgress),
        completed: Boolean(levelProgress?.completed),
        stars: levelProgress?.stars || 0,
        bestTime: levelProgress?.bestTime || null,
      };
    });
  }

  getChapters() {
    const progress = this.scoringEngine?.getProgress?.() || { campaignProgress: {} };
    const campaignProgress = progress.campaignProgress || {};
    return CHAPTERS.map((chapter) => {
      const levels = chapter.levels.map((levelId) => {
        const levelProgress = campaignProgress[levelId];
        return {
          id: levelId,
          completed: Boolean(levelProgress?.completed),
          stars: levelProgress?.stars || 0,
        };
      });
      const totalStars = levels.reduce((sum, level) => sum + level.stars, 0);
      return {
        id: chapter.id,
        name: chapter.name,
        description: chapter.description,
        prelude: Boolean(chapter.prelude),
        levels,
        totalStars,
        maxStars: levels.length * 3,
        completed: levels.every((level) => level.completed),
      };
    });
  }

  // ─── level lifecycle ─────────────────────────────────────────────────────

  startLevel(levelId) {
    const levelDef = getCampaignLevel(levelId);
    if (!levelDef) return false;

    if (!this.isLevelUnlocked(levelDef.id)) return false;

    this.currentLevel = levelDef.id;
    this.currentLevelDef = levelDef;
    this.state = CAMPAIGN_STATE.LOADING;
    this.hadFailures = false;
    this.usedHints = false;
    this.campaignFinished = false;
    this.tutorialStep = 0;
    this.tutorialActive = false;
    this.pausedTime = 0;
    this.pauseStart = 0;
    this.elapsedTime = 0;

    this.objectiveProgress = createObjectiveProgress(levelDef.objectives);

    try {
      this.setupCluster(levelDef);
    } catch (error) {
      console.warn('CampaignMode: setupCluster failed', error);
    }

    try {
      this.setupIncidents(levelDef);
    } catch (error) {
      console.warn('CampaignMode: setupIncidents failed', error);
    }

    this.seedManifestPanel(levelDef);
    // After the Files panel reset: home-directory files of the workstation live
    // in the same virtual filesystem, so the host seed must be applied last.
    this.seedLinuxHost(levelDef);

    if (levelDef.tutorial) {
      this.tutorialActive = true;
      this.tutorialStep = 0;
    }

    this.state = CAMPAIGN_STATE.PLAYING;
    this.startTime = Date.now();
    // Readiness evidence is scoped to this drill run (#20): only commands typed
    // while the level is active count for its bullets.
    try {
      this.scoringEngine?.beginDrillEvidence?.('campaign', levelDef.id);
    } catch (error) {
      console.warn('CampaignMode: beginDrillEvidence failed', error);
    }
    try {
      this.incidentEngine?.start?.('campaign');
    } catch (error) {
      console.warn('CampaignMode: incident engine start failed', error);
    }

    this.startTicking();

    this.emit('campaign:level-started', {
      levelId: levelDef.id,
      levelLabel: levelLabel(levelDef.id),
      prelude: isPreludeLevel(levelDef.id),
      title: levelDef.title,
      chapter: levelDef.chapter,
      chapterName: levelDef.chapterName,
      description: levelDef.description,
      examObjectives: levelDef.examObjectives,
      docsLinks: levelDef.docsLinks,
      objectives: this.objectiveProgress,
      availableResources: levelDef.availableResources,
      manifestFiles: levelDef.manifestFiles || [],
      focusFiles: levelDef.focusFiles || [],
      tutorial: levelDef.tutorial || null,
    });

    return true;
  }

  /**
   * Unlocked when the previous level of the same track is completed (prelude
   * and EX280 track are separate; the prelude never gates Level 1), when it is
   * a track's first level, or when it was completed before.
   */
  isLevelUnlocked(levelId) {
    const progress = this.scoringEngine?.getProgress?.() || { campaignProgress: {} };
    return isLevelUnlocked(levelId, progress.campaignProgress || {});
  }

  /** The level the "Continue" action opens for the current saved progress. */
  getContinueLevelId() {
    const progress = this.scoringEngine?.getProgress?.() || { campaignProgress: {} };
    return continueLevelId(progress.campaignProgress || {});
  }

  /**
   * Seed the simulated cluster for the level.
   * - ClusterState.clear() re-seeds the default OpenShift 4.22 baseline,
   *   so level data must be NAME-based and must not collide with defaults.
   * - Projects are created first so namespaced resources resolve.
   * - `startingUser: null` forces the player to log in; otherwise the level
   *   starts as kubeadmin (or the configured startingUser).
   */
  setupCluster(levelDef) {
    const clusterState = this.gameEngine?.cluster;
    if (!clusterState) return;

    if (typeof clusterState.clear === 'function') clusterState.clear();

    // Reset campaign-scoped simulation counters so per-level objectives start fresh.
    clusterState._rollbackCount = 0;
    clusterState._rescheduledCount = 0;
    clusterState._rescheduledPods = 0;
    try {
      if (typeof this.gameEngine.clearCommandHistory === 'function')
        this.gameEngine.clearCommandHistory();
      else if (Array.isArray(this.gameEngine._commandHistory))
        this.gameEngine._commandHistory.length = 0;
    } catch {
      /* non-fatal */
    }

    this.applyStartingUser(levelDef);

    const resources = Array.isArray(levelDef.startingResources) ? levelDef.startingResources : [];
    const ordered = [
      ...resources.filter((resource) => resource.kind === 'Project'),
      ...resources.filter((resource) => resource.kind !== 'Project'),
    ];
    // Levels with a single seeded Project put their workloads in that project.
    const levelProjects = ordered.filter((resource) => resource.kind === 'Project');
    const defaultProject = levelProjects.length === 1 ? levelProjects[0].name : DEFAULT_PROJECT;

    for (const resource of ordered) {
      try {
        this.addStartingResource(clusterState, resource, defaultProject);
      } catch (error) {
        console.warn(`CampaignMode: could not seed ${resource?.kind}/${resource?.name}`, error);
      }
    }
  }

  /** Log in/out according to the level definition. */
  applyStartingUser(levelDef) {
    const engine = this.gameEngine;
    if (!engine) return;
    const hasStartingUser = Object.prototype.hasOwnProperty.call(levelDef, 'startingUser');
    const targetUser = hasStartingUser ? levelDef.startingUser : DEFAULT_USER;

    if (targetUser === null) {
      try {
        if (typeof engine.logout === 'function' && engine.currentUser) engine.logout();
        else engine.currentUser = null;
      } catch {
        /* non-fatal */
      }
      return;
    }

    try {
      if (engine.currentUser !== targetUser && typeof engine.login === 'function') {
        engine.login(targetUser);
      }
    } catch (error) {
      console.warn(`CampaignMode: login as ${targetUser} failed`, error);
    }
    // kubeadmin-style simulated users can be restored directly if login() is absent.
    if (!engine.currentUser) engine.currentUser = targetUser;
    if (!engine.currentProject) engine.currentProject = DEFAULT_PROJECT;
  }

  /** Add one starting resource through the registry-backed ClusterState path. */
  addStartingResource(clusterState, descriptor, defaultProject = DEFAULT_PROJECT) {
    if (!descriptor || !descriptor.kind) return null;
    const name = descriptor.name;
    const namespace =
      descriptor.namespace ||
      descriptor.metadata?.namespace ||
      (descriptor.kind === 'Project' ? '' : defaultProject);
    // Only application objects get the conventional `app=<name>` label; a real
    // Node, Project, Subscription or RBAC object carries no such label (1.16.0:
    // `oc describe node` showed `app=worker-0`).
    const labels = APP_LABELED_KINDS.has(descriptor.kind)
      ? { app: name, ...(descriptor.labels || {}) }
      : { ...(descriptor.labels || {}) };
    const added = clusterState.addResource({
      kind: descriptor.kind,
      name,
      namespace,
      labels,
      annotations: descriptor.annotations || {},
      spec: descriptor.spec || {},
      status: descriptor.status || {},
    });
    if (!added) return null;

    if (descriptor.kind === 'Node' && typeof added.setCondition === 'function') {
      try {
        added.setCondition('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status');
      } catch {
        /* ignore */
      }
    }

    if (descriptor.kind === 'Deployment') {
      // Ensure selector/template labels agree so ReplicaSet creation succeeds.
      const spec = added.spec || {};
      spec.replicas = spec.replicas ?? 1;
      spec.selector = spec.selector || { matchLabels: { app: name } };
      spec.template = spec.template || {};
      spec.template.metadata = spec.template.metadata || {};
      spec.template.metadata.labels = { app: name, ...(spec.template.metadata.labels || {}) };
      spec.template.spec = spec.template.spec || {};
    }

    if (descriptor.kind === 'Service') {
      const spec = added.spec || {};
      if (!spec.selector || Object.keys(spec.selector).length === 0) {
        spec.selector = { app: descriptor.app || name };
      }
      if (spec.type === undefined) spec.type = 'ClusterIP';
    }

    return added;
  }

  setupIncidents(levelDef) {
    const incidentEngine = this.incidentEngine;
    if (!incidentEngine) return;
    if (typeof incidentEngine.reset === 'function') incidentEngine.reset();
    const incidents = Array.isArray(levelDef.incidents) ? levelDef.incidents : [];
    if (incidents.length > 0 && typeof incidentEngine.loadScriptedIncidents === 'function') {
      incidentEngine.loadScriptedIncidents(incidents);
    }
  }

  // ─── declarative files seeding (CONVERSION-SPEC §7) ──────────────────────

  getManifestEngine() {
    if (this.gameEngine?.manifestEngine) return this.gameEngine.manifestEngine;
    if (typeof window !== 'undefined' && window.game?.manifestEngine) {
      return window.game.manifestEngine;
    }
    return null;
  }

  seedManifestPanel(levelDef) {
    const files = Array.isArray(levelDef.manifestFiles) ? levelDef.manifestFiles : [];
    const focusFiles = Array.isArray(levelDef.focusFiles) ? levelDef.focusFiles : files;
    const manifestEngine = this.getManifestEngine();

    if (manifestEngine && typeof manifestEngine.resetFiles === 'function') {
      try {
        manifestEngine.resetFiles();
      } catch (error) {
        console.warn('CampaignMode: manifestEngine.resetFiles failed', error);
      }
    }

    // index.html calls panel.setContext(...) itself after launch; also notify here
    // for mode switches that do not go through index (tests, programmatic starts).
    if (typeof window !== 'undefined' && window.game?.manifestPanel?.setContext) {
      try {
        window.game.manifestPanel.setContext({ files, focusFiles, manifestFiles: files });
      } catch (error) {
        console.warn('CampaignMode: manifestPanel.setContext failed', error);
      }
    }
    return { files, focusFiles };
  }

  /**
   * Reset the simulated RHEL workstation (js/engine/LinuxHost.js) and apply the
   * level's `linuxHost` seed (Linux & RHEL Foundations levels). Levels without a
   * seed get the default workstation, so a previous Linux level never leaks its
   * files, services or containers into the next level.
   */
  seedLinuxHost(levelDef) {
    const host =
      this.gameEngine?.linuxHost ||
      (typeof window !== 'undefined' ? window.game?.linuxHost || null : null);
    if (!host || typeof host.reset !== 'function') return false;
    try {
      host.reset(levelDef?.linuxHost ?? null);
      return true;
    } catch (error) {
      console.warn('CampaignMode: linuxHost.reset failed', error);
      return false;
    }
  }

  // ─── per-second tick ─────────────────────────────────────────────────────

  startTicking() {
    this.stopTicking();
    this.ticker = setInterval(() => this.update(), 1000);
  }

  stopTicking() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  update() {
    if (this.state !== CAMPAIGN_STATE.PLAYING) return;
    this.elapsedTime = (Date.now() - this.startTime - this.pausedTime) / 1000;

    this.updateObjectives();
    this.checkCompletion();
    this.checkFailure();

    this.emit('campaign:update', {
      levelId: this.currentLevel,
      elapsedTime: Math.round(this.elapsedTime),
      objectives: this.objectiveProgress,
      summary: getObjectiveSummary(this.objectiveProgress),
      clusterHealth: this.getClusterHealth(),
    });
  }

  /** Evaluation context passed to ObjectiveEvaluator (CONVERSION-SPEC §13). */
  buildEvaluationContext() {
    return {
      clusterState: this.gameEngine?.cluster || null,
      gameEngine: this.gameEngine || null,
      incidentEngine: this.incidentEngine || null,
      scoringEngine: this.scoringEngine || null,
      manifestEngine: this.getManifestEngine(),
      // Used by composite objective types (examScore) in level 20.
      objectiveProgress: this.objectiveProgress,
      levelDef: this.currentLevelDef,
    };
  }

  updateObjectives() {
    if (!this.currentLevelDef || !Array.isArray(this.currentLevelDef.objectives)) return;
    evaluateObjectives(this.currentLevelDef.objectives, this.buildEvaluationContext(), {
      progress: this.objectiveProgress,
      // Objectives are end-state, not latched: removing a group member or
      // deleting a resource must un-tick the objective while the level is live
      // (`oc adm groups remove-users developers bob` → "Group … alice and bob"
      // is false again).
      recheckCompleted: true,
    });
  }

  // ─── completion / failure / stars ────────────────────────────────────────

  checkCompletion() {
    if (this.objectiveProgress.length === 0) return;
    if (!this.objectiveProgress.every((objective) => objective.completed)) return;
    // examScore is a composite of the other objectives; it can only complete
    // after the rest are done, which is exactly the capstone intent.
    this.completeLevel();
  }

  checkFailure() {
    const health = this.getClusterHealth();
    if (health <= 0) this.hadFailures = true;
    const activeIncidents = this.getActiveIncidents();
    if (activeIncidents.some((incident) => (incident?.severity || 0) >= 5)) {
      this.hadFailures = true;
    }
  }

  completeLevel() {
    if (this.state === CAMPAIGN_STATE.COMPLETED) return null;
    this.state = CAMPAIGN_STATE.COMPLETED;
    this.stopTicking();
    try {
      this.incidentEngine?.stop?.();
    } catch {
      /* ignore */
    }

    const completionTime = this.elapsedTime;
    const totalObjectives = this.objectiveProgress.length;
    const completedObjectives = this.objectiveProgress.filter(
      (objective) => objective.completed
    ).length;
    const efficiency = totalObjectives === 0 ? 1 : completedObjectives / totalObjectives;

    let result = { stars: 1, xpEarned: 100 };
    try {
      if (typeof this.scoringEngine?.completeCampaignLevel === 'function') {
        // Hand the live objective types to ScoringEngine so the EX280 readiness
        // verdict can record per-objective evidence for this level.
        this.scoringEngine._lastObjectiveTypes = this.objectiveProgress
          .map((objective) => String(objective?.type || '').toLowerCase())
          .filter(Boolean);
        result = this.scoringEngine.completeCampaignLevel(
          this.currentLevel,
          completionTime,
          efficiency,
          this.hadFailures,
          this.usedHints
        );
      }
    } catch (error) {
      console.warn('CampaignMode: completeCampaignLevel failed', error);
    }

    const completionData = {
      levelId: this.currentLevel,
      levelLabel: levelLabel(this.currentLevel),
      prelude: isPreludeLevel(this.currentLevel),
      title: this.currentLevelDef?.title || `Level ${levelLabel(this.currentLevel)}`,
      chapter: this.currentLevelDef?.chapter,
      chapterName: this.currentLevelDef?.chapterName,
      stars: result?.stars || 1,
      xpEarned: result?.xpEarned || 0,
      completionTime: Math.round(completionTime),
      efficiency: Math.round(efficiency * 100),
      hadFailures: this.hadFailures,
      nextLevel: this.currentLevelDef?.nextLevel ?? null,
      // UI contract (HANDOFF GAME-014): relabel "Next Level" for the final
      // level and return to the menu after `campaign:campaign-complete`.
      isLastLevel: this.isLastLevel(),
      totalLevels: CAMPAIGN_LEVELS.length,
      state: this.state,
    };

    this.emit('campaign:level-completed', completionData);
    this.emit('mode:level-complete', {
      ...completionData,
      message: `Completed in ${Math.round(completionTime)}s with ${Math.round(efficiency * 100)}% efficiency. +${result?.xpEarned || 0} XP`,
    });
    return result;
  }

  failLevel(reason) {
    this.state = CAMPAIGN_STATE.FAILED;
    this.stopTicking();
    try {
      this.incidentEngine?.stop?.();
    } catch {
      /* ignore */
    }
    this.levelRetryCount += 1;
    if (this.scoringEngine?.progress?.stats) {
      this.scoringEngine.progress.stats.levelRetries =
        (this.scoringEngine.progress.stats.levelRetries || 0) + 1;
      if (typeof this.scoringEngine.saveProgress === 'function') this.scoringEngine.saveProgress();
    }
    this.emit('campaign:level-failed', {
      levelId: this.currentLevel,
      levelLabel: levelLabel(this.currentLevel),
      title: this.currentLevelDef?.title || `Level ${levelLabel(this.currentLevel)}`,
      reason,
      elapsedTime: Math.round(this.elapsedTime),
    });
  }

  // ─── navigation ──────────────────────────────────────────────────────────

  retryLevel() {
    if (!this.currentLevel) return false;
    return this.startLevel(this.currentLevel);
  }

  /** Alias used by index.html's game-over modal. */
  restart() {
    return this.retryLevel();
  }

  /** Alias used by programmatic launchers. */
  start() {
    if (this.state === CAMPAIGN_STATE.PLAYING) return true;
    if (this.currentLevel && this.currentLevelDef) return this.retryLevel();
    return this.startLevel(this.getContinueLevelId());
  }

  nextLevel() {
    const nextId = this.currentLevelDef?.nextLevel;
    if (!nextId) {
      // HANDOFF GAME-014 (frontend): the last level cannot advance. Keep the
      // completed level visible (do NOT }clear currentLevelDef and leave the
      // shell in an empty campaign view) and announce campaign completion so
      // the shell can navigate to the menu / ending screen.
      this.campaignFinished = true;
      const payload = {
        levelId: this.currentLevel,
        levelLabel: levelLabel(this.currentLevel),
        title: this.currentLevelDef?.title || `Level ${levelLabel(this.currentLevel)}`,
        totalLevels: CAMPAIGN_LEVELS.length,
        state: this.state,
        message: `Campaign complete — all ${EX280_ORDER.length} EX280 levels finished.`,
      };
      this.emit('campaign:campaign-complete', payload);
      this.emit('mode:campaign-complete', payload);
      return false;
    }
    const started = this.startLevel(nextId);
    if (started === false) {
      this.emit('campaign:next-level-unavailable', {
        levelId: this.currentLevel,
        nextLevel: nextId,
      });
    }
    return started;
  }

  /** True when the current level is the last one in the campaign. */
  isLastLevel() {
    return !this.currentLevelDef?.nextLevel;
  }

  hasNextLevel() {
    return Boolean(this.currentLevelDef?.nextLevel);
  }

  /** True while the level-completed state is showing (level is finished). */
  isCompleted() {
    return this.state === CAMPAIGN_STATE.COMPLETED;
  }

  /** True when the whole campaign has been finished and the menu is next. */
  isCampaignComplete() {
    return Boolean(this.campaignFinished) && this.isLastLevel();
  }

  exitToMenu() {
    this.stopTicking();
    try {
      this.incidentEngine?.stop?.();
    } catch {
      /* ignore */
    }
    this.state = CAMPAIGN_STATE.MENU;
    this.currentLevel = null;
    this.currentLevelDef = null;
    this.objectiveProgress = [];
    this.emit('campaign:exit-to-menu', {});
  }

  /** Index.html lifecycle compatibility. */
  exit() {
    this.exitToMenu();
  }

  cleanup() {
    this.exitToMenu();
  }

  // ─── pause / hints / tutorial ────────────────────────────────────────────

  pause() {
    if (this.state !== CAMPAIGN_STATE.PLAYING) return;
    this.state = CAMPAIGN_STATE.PAUSED;
    this.pauseStart = Date.now();
    try {
      this.incidentEngine?.pause?.();
    } catch {
      /* ignore */
    }
    this.emit('campaign:paused', { levelId: this.currentLevel });
  }

  resume() {
    if (this.state !== CAMPAIGN_STATE.PAUSED) return;
    this.state = CAMPAIGN_STATE.PLAYING;
    this.pausedTime += Date.now() - this.pauseStart;
    try {
      this.incidentEngine?.resume?.();
    } catch {
      /* ignore */
    }
    this.emit('campaign:resumed', { levelId: this.currentLevel });
  }

  useHint(index) {
    if (!this.currentLevelDef) return null;
    const hint = this.currentLevelDef.hints?.[index];
    if (hint === undefined) return null;
    this.usedHints = true;
    this.emit('campaign:hint-used', {
      levelId: this.currentLevel,
      hintIndex: index,
      hint,
    });
    return hint;
  }

  /**
   * Reveal the authored how-to (`objective.how`) of one objective. It is the
   * same help as a hint, so it counts as one (it never fails a level).
   * @param {number} index objective index in the current level
   * @returns {{explain?: string, run?: string[], check?: string}|null}
   */
  revealHow(index) {
    const how = this.currentLevelDef?.objectives?.[index]?.how;
    if (!how || typeof how !== 'object') return null;
    this.usedHints = true;
    this.emit('campaign:hint-used', {
      levelId: this.currentLevel,
      hintIndex: null,
      objectiveIndex: index,
      how,
    });
    return how;
  }

  /**
   * The lab project the player is expected to work in, or null. Levels that
   * seed exactly one Project are worked in that Project (the grader is
   * project-scoped, so the same commands in `default` do not tick). A level
   * opts out — or names another project — with an explicit `workProject`
   * (string, or null when the project is not the work context).
   * @param {object|null} [levelDef]
   * @returns {string|null}
   */
  getWorkProject(levelDef = this.currentLevelDef) {
    if (!levelDef) return null;
    if (Object.prototype.hasOwnProperty.call(levelDef, 'workProject')) {
      return levelDef.workProject || null;
    }
    const projects = (
      Array.isArray(levelDef.startingResources) ? levelDef.startingResources : []
    ).filter((resource) => resource && resource.kind === 'Project' && resource.name);
    return projects.length === 1 ? projects[0].name : null;
  }

  advanceTutorial() {
    if (!this.tutorialActive || !this.currentLevelDef?.tutorial) return null;
    const steps = this.currentLevelDef.tutorial.steps || [];
    if (this.tutorialStep >= steps.length) {
      this.tutorialActive = false;
      this.emit('campaign:tutorial-completed', { levelId: this.currentLevel });
      return null;
    }
    const step = steps[this.tutorialStep];
    this.tutorialStep += 1;
    this.emit('campaign:tutorial-step', {
      levelId: this.currentLevel,
      step: this.tutorialStep,
      totalSteps: steps.length,
      target: step.target,
      text: step.text,
    });
    return step;
  }

  skipTutorial() {
    this.tutorialActive = false;
    this.emit('campaign:tutorial-skipped', { levelId: this.currentLevel });
  }

  // ─── status helpers consumed by index.html/HUD ───────────────────────────

  getClusterHealth() {
    try {
      if (typeof this.incidentEngine?.getClusterHealth === 'function') {
        return this.incidentEngine.getClusterHealth();
      }
    } catch {
      /* ignore */
    }
    return 100;
  }

  getActiveIncidents() {
    try {
      if (typeof this.incidentEngine?.getActiveIncidents === 'function') {
        return this.incidentEngine.getActiveIncidents() || [];
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  getCompletionPercentage() {
    return getObjectiveSummary(this.objectiveProgress).percentage;
  }

  getStatus() {
    return {
      state: this.state,
      currentLevel: this.currentLevel,
      // Display number ("0.3", "12", "22"); `currentLevel` stays the stable id.
      levelLabel: this.currentLevel ? levelLabel(this.currentLevel) : null,
      prelude: this.currentLevel ? isPreludeLevel(this.currentLevel) : false,
      levelTitle: this.currentLevelDef?.title || null,
      chapter: this.currentLevelDef?.chapter || null,
      chapterName: this.currentLevelDef?.chapterName || null,
      elapsedTime: Math.round(this.elapsedTime),
      objectives: this.objectiveProgress,
      completionPercentage: this.getCompletionPercentage(),
      clusterHealth: this.getClusterHealth(),
      activeIncidents: this.getActiveIncidents().length,
      tutorialActive: this.tutorialActive,
      tutorialStep: this.tutorialStep,
      isLastLevel: this.isLastLevel(),
      hasNextLevel: this.hasNextLevel(),
      campaignFinished: Boolean(this.campaignFinished),
      hints: this.currentLevelDef?.hints || [],
      workProject: this.getWorkProject(),
      availableResources: this.currentLevelDef?.availableResources || [],
      examObjectives: this.currentLevelDef?.examObjectives || [],
      docsLinks: this.currentLevelDef?.docsLinks || [],
      manifestFiles: this.currentLevelDef?.manifestFiles || [],
      focusFiles: this.currentLevelDef?.focusFiles || [],
    };
  }

  emit(event, payload) {
    try {
      this.gameEngine?.emit?.(event, payload);
    } catch (error) {
      console.warn(`CampaignMode: failed to emit ${event}`, error);
    }
  }

  destroy() {
    this.stopTicking();
    this.gameEngine = null;
    this.incidentEngine = null;
    this.scoringEngine = null;
    this.currentLevelDef = null;
    this.objectiveProgress = [];
  }
}

export { CampaignMode, CAMPAIGN_STATE };
