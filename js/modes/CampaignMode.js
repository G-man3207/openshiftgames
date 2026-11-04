/**
 * CampaignMode — EX280 campaign runner (20 levels, 5 chapters).
 *
 * Responsibilities:
 *  - load CONVERSION-SPEC §9 level data (js/data/CampaignLevels.js),
 *  - seed the level's Projects/Nodes/workloads through the registry factory,
 *  - seed the Files/Manifests panel for declarative levels (manifestFiles/focusFiles),
 *  - load scripted incidents,
 *  - evaluate objectives every second via js/engine/ObjectiveEvaluator.js,
 *  - keep the public API consumed by index.html unchanged
 *    (startLevel/getLevels/getChapters/getStatus/useHint/nextLevel/retryLevel/
 *     pause/resume/exitToMenu/destroy + currentLevelDef/objectiveProgress).
 *
 * No engine edits: every optional engine API is feature-detected so this mode
 * also works against partially-integrated builds and in the Node test harness.
 */

import { CAMPAIGN_LEVELS, CHAPTERS } from '../data/CampaignLevels.js';
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
      const previousCompleted =
        level.id === 1 || Boolean(campaignProgress[level.id - 1]?.completed);
      return {
        id: level.id,
        title: level.title,
        chapter: level.chapter,
        chapterName: level.chapterName,
        description: level.description,
        examObjectives: level.examObjectives,
        docsLinks: level.docsLinks,
        objectives: level.objectives,
        manifestFiles: level.manifestFiles || [],
        focusFiles: level.focusFiles || [],
        locked: !previousCompleted,
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
        levels,
        totalStars,
        maxStars: levels.length * 3,
        completed: levels.every((level) => level.completed),
      };
    });
  }

  // ─── level lifecycle ─────────────────────────────────────────────────────

  startLevel(levelId) {
    const levelDef = CAMPAIGN_LEVELS.find((level) => level.id === Number(levelId));
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

  isLevelUnlocked(levelId) {
    if (levelId <= 1) return true;
    const progress = this.scoringEngine?.getProgress?.() || { campaignProgress: {} };
    return Boolean(progress.campaignProgress?.[levelId - 1]?.completed);
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
    const labels = { app: name, ...(descriptor.labels || {}) };
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
      title: this.currentLevelDef?.title || `Level ${this.currentLevel}`,
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
      title: this.currentLevelDef?.title || `Level ${this.currentLevel}`,
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
    return this.startLevel(1);
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
        title: this.currentLevelDef?.title || `Level ${this.currentLevel}`,
        totalLevels: CAMPAIGN_LEVELS.length,
        state: this.state,
        message: 'Campaign complete — all 20 EX280 levels finished.',
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
