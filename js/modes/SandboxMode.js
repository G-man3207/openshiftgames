/**
 * SandboxMode — free-play OpenShift 4.22 cluster (CONVERSION-SPEC §12).
 *
 * The palette and all resource creation paths derive from
 * `js/data/kindRegistry.js` (single source of truth). YAML export uses the
 * shared ManifestSerializer through the registry — no local apiVersion map or
 * hand-rolled YAML emitter.
 *
 * `ClusterState.clear()` re-seeds the default OpenShift baseline (Projects,
 * default ServiceAccounts, SCCs, kubeadmin/admin, ClusterOperators,
 * ClusterVersion, OAuth, ImageStreams, project-request Template). SandboxMode
 * deliberately KEEPS that baseline and only adds platform Nodes on top
 * (worker-0/worker-1/master-0 from the shared catalog, #53F), instead of
 * fighting the reseed with a custom namespace.
 */

import {
  PLACEABLE_KINDS,
  apiVersionForKind,
  createResource,
  isClusterScopedKind,
  toManifestObject,
  toManifestYAML,
} from '../data/kindRegistry.js';
import { MANIFEST_FILES } from '../data/ManifestFiles.js';
import { catalogNode } from '../engine/ClusterState.js';
import {
  createObjectiveProgress,
  evaluateObjectives,
  getObjectiveSummary,
} from '../engine/ObjectiveEvaluator.js';

const SANDBOX_STATE = {
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
};

/** Every kind the palette can place, derived from the registry. */
const ALL_RESOURCE_TYPES = [...PLACEABLE_KINDS];

class SandboxMode {
  constructor(gameEngine, scoringEngine) {
    this.gameEngine = gameEngine;
    this.scoringEngine = scoringEngine;
    this.state = SANDBOX_STATE.IDLE;
    this.startTime = 0;
    this.elapsedTime = 0;
    this.ticker = null;
    this.resourceCount = 0;
    this.architectureScore = null;
    this.autoScoreInterval = null;
    this.nodeCount = 0;
    /** Active EX280 quick lab (seeded via setupQuickLab from EX280 Prep). */
    this.quickLab = null;
  }

  start(initialNodes) {
    this.state = SANDBOX_STATE.PLAYING;
    this.startTime = Date.now();
    // Free-play commands must not count towards the EX280 readiness verdict (#20).
    try {
      this.scoringEngine?.endDrillEvidence?.();
    } catch {
      /* non-fatal */
    }
    this.elapsedTime = 0;
    this.resourceCount = 0;
    this.architectureScore = null;
    this.quickLab = null;
    this.nodeCount = Math.max(1, Number(initialNodes) || 3);

    this.setupCluster(this.nodeCount);

    this.stopTicking();
    this.ticker = setInterval(() => this.update(), 1000);
    this.autoScoreInterval = setInterval(() => this.refreshArchitectureScore(), 10000);

    this.gameEngine?.emit?.('sandbox:started', {
      availableResources: ALL_RESOURCE_TYPES,
      nodeCount: this.nodeCount,
      openshiftVersion: '4.22',
      defaultProjects: this.getProjectNames(),
    });
  }

  /**
   * Reset to the standard OpenShift 4.22 baseline and add sandbox worker Nodes.
   * ClusterState.clear() itself re-seeds the baseline — do not delete it.
   */
  setupCluster(nodeCount = 3) {
    const clusterState = this.gameEngine?.cluster;
    if (!clusterState) return;

    if (typeof clusterState.clear === 'function') clusterState.clear();

    // The engine reset normally resets the session; for direct/programmatic
    // starts make sure the current project still exists after the reseed.
    try {
      const project = this.gameEngine?.currentProject || 'default';
      if (typeof clusterState.getProject === 'function' && !clusterState.getProject(project)) {
        this.gameEngine.currentProject = 'default';
      }
    } catch {
      /* defensive */
    }

    const count = Math.max(1, Number(nodeCount) || 3);
    this.nodeCount = count;
    // Same machine names as every other mode (#53F): worker-0, worker-1,
    // master-0 (2-node clusters stop after worker-1). A 3-node cluster has a
    // control-plane node, exactly like the campaign.
    for (let index = 0; index < count; index += 1) {
      const machine = catalogNode(index);
      const node = clusterState.addResource({
        kind: 'Node',
        name: machine.name,
        metadata: {
          name: machine.name,
          labels: {
            ...machine.labels,
            'topology.kubernetes.io/zone': `zone-${(index % 3) + 1}`,
          },
        },
        spec: { cpu: '16', memory: '32Gi', pods: 250 },
        status: { phase: 'Running' },
      });
      if (node && typeof node.setCondition === 'function') {
        try {
          node.setCondition('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status');
          clusterState.update(node.uid, node);
        } catch {
          /* defensive */
        }
      }
    }
  }

  getProjectNames() {
    const clusterState = this.gameEngine?.cluster;
    try {
      if (typeof clusterState?.getProjects === 'function') {
        return clusterState
          .getProjects()
          .map((project) => project.metadata?.name || project.name)
          .filter(Boolean);
      }
      if (typeof clusterState?.getByKind === 'function') {
        return (clusterState.getByKind('Project') || [])
          .map((project) => project.metadata?.name)
          .filter(Boolean);
      }
    } catch {
      /* defensive */
    }
    return [];
  }

  update() {
    if (this.state !== SANDBOX_STATE.PLAYING) return;

    this.elapsedTime = (Date.now() - this.startTime) / 1000;

    const state = this.gameEngine?.cluster;
    if (state) {
      const allResources =
        typeof state.getAllResources === 'function' ? state.getAllResources() : [];
      this.resourceCount = allResources.length;
    }

    this._updateQuickLab();

    this.gameEngine?.emit?.('sandbox:update', {
      elapsedTime: Math.round(this.elapsedTime),
      resourceCount: this.resourceCount,
      nodeCount: this.nodeCount,
      architectureScore: this.architectureScore ? this.architectureScore.total : null,
      quickLab: this.quickLab
        ? {
            id: this.quickLab.id,
            title: this.quickLab.title,
            completed: this.quickLab.completed,
            summary: getObjectiveSummary(this.quickLab.progress),
          }
        : null,
    });
  }

  /**
   * Create a resource through the registry factory + ClusterState upsert path.
   * @param {string} kind
   * @param {string} name
   * @param {object} [spec]
   * @returns {boolean}
   */
  addResource(kind, name, spec = {}) {
    const state = this.gameEngine?.cluster;
    if (!state || !kind || !name) return false;

    // Only registry-known placeable kinds may be created from the palette.
    if (ALL_RESOURCE_TYPES.includes(kind)) {
      // OK
    } else if (typeof state.getAllKinds === 'function' && state.getAllKinds().includes(kind)) {
      // Known but non-placeable (e.g. ClusterOperator): still allow programmatic use.
    } else {
      return false;
    }

    const namespace = isClusterScopedKind(kind)
      ? ''
      : spec?.namespace || this.gameEngine?.currentProject || 'default';
    const cleanSpec = this.cleanSpec(spec);
    const labels = cleanSpec.labels && typeof cleanSpec.labels === 'object' ? cleanSpec.labels : {};
    const annotations =
      cleanSpec.annotations && typeof cleanSpec.annotations === 'object'
        ? cleanSpec.annotations
        : {};
    delete cleanSpec.labels;
    delete cleanSpec.annotations;
    delete cleanSpec.namespace;
    let resource;
    try {
      resource = createResource(kind, {
        name,
        namespace,
        labels,
        annotations,
        spec: cleanSpec,
      });
    } catch (error) {
      console.warn(`SandboxMode: createResource(${kind}) failed`, error);
      return false;
    }

    if (kind === 'Node' && typeof resource.setCondition === 'function') {
      resource.setPhase?.('Running');
      resource.setCondition('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status');
    }

    const added = state.addResource(resource);
    if (!added) return false;

    this.resourceCount =
      typeof state.getAllResources === 'function'
        ? state.getAllResources().length
        : this.resourceCount + 1;

    this.gameEngine?.emit?.('resource:created', {
      kind,
      name,
      namespace,
      mode: 'sandbox',
      concurrentPods: kind === 'Pod' ? (state.getResourcesByKind?.('Pod') || []).length : undefined,
      nodeCount: kind === 'Node' ? (state.getResourcesByKind?.('Node') || []).length : undefined,
    });

    return true;
  }

  removeResource(kind, name) {
    const state = this.gameEngine?.cluster;
    if (!state) return false;

    let removed =
      typeof state.removeResource === 'function' ? state.removeResource(kind, name) : null;
    if (!removed && typeof state.getByKind === 'function') {
      const match = (state.getByKind(kind) || []).find(
        (resource) => (resource.metadata?.name || resource.name) === name
      );
      if (match && typeof state.remove === 'function') removed = state.remove(match.uid);
    }
    if (removed) {
      this.resourceCount = Math.max(0, this.resourceCount - 1);
      this.gameEngine?.emit?.('resource:removed', { kind, name, mode: 'sandbox' });
      return true;
    }
    return false;
  }

  /**
   * Seed an EX280 Prep "quick lab" into the live sandbox and track its check
   * objectives. Called by ExamPrepMode after it launches the sandbox:
   *   app.modeInstance.setupQuickLab(lab)
   * The lab's `check` array is evaluated every second; when every check passes
   * the linked EX280 objective is marked mastered (`scoring.markExamPrep`).
   *
   * @param {{id: string, title: string, objectiveId: string, setup?: {startingResources?: object[], manifestFiles?: string[]}, check?: object[]}} lab
   * @returns {boolean}
   */
  setupQuickLab(lab) {
    if (!lab || !lab.id) return false;
    const clusterState = this.gameEngine?.cluster;
    this.quickLab = {
      id: lab.id,
      title: lab.title || lab.id,
      objectiveId: lab.objectiveId || null,
      check: Array.isArray(lab.check) ? lab.check : [],
      progress: createObjectiveProgress(Array.isArray(lab.check) ? lab.check : []),
      completed: false,
      startedAt: Date.now(),
    };

    // Seed starting resources (Projects first so namespaced objects resolve).
    const resources = Array.isArray(lab.setup?.startingResources)
      ? lab.setup.startingResources
      : [];
    const ordered = [
      ...resources.filter((resource) => resource && resource.kind === 'Project'),
      ...resources.filter((resource) => resource && resource.kind !== 'Project'),
    ];
    const defaultProject =
      ordered.find((resource) => resource.kind === 'Project')?.name ||
      this.gameEngine?.currentProject ||
      'default';
    for (const descriptor of ordered) {
      try {
        const namespace =
          descriptor.namespace ||
          descriptor.metadata?.namespace ||
          (descriptor.kind === 'Project' ? '' : defaultProject);
        const added = clusterState?.addResource({
          kind: descriptor.kind,
          name: descriptor.name,
          namespace,
          labels: { app: descriptor.name, ...(descriptor.labels || {}) },
          annotations: descriptor.annotations || {},
          spec: descriptor.spec || {},
          status:
            descriptor.kind === 'Project'
              ? { phase: 'Active', ...(descriptor.status || {}) }
              : descriptor.status || {},
        });
        if (
          added &&
          descriptor.kind === 'Project' &&
          typeof clusterState.ensureProjectDefaults === 'function'
        ) {
          clusterState.ensureProjectDefaults(added);
        }
      } catch (error) {
        console.warn(
          `SandboxMode: quick lab could not seed ${descriptor?.kind}/${descriptor?.name}`,
          error
        );
      }
    }

    // Make sure the lab's referenced manifest files exist in the virtual FS.
    const manifestEngine =
      this.gameEngine?.manifestEngine ||
      (typeof window !== 'undefined' ? window.game?.manifestEngine : null);
    for (const path of Array.isArray(lab.setup?.manifestFiles) ? lab.setup.manifestFiles : []) {
      try {
        if (!manifestEngine || typeof manifestEngine.writeFile !== 'function') break;
        if (
          typeof manifestEngine.readFile === 'function' &&
          typeof manifestEngine.readFile(path) === 'string'
        )
          continue;
        const content = MANIFEST_FILES?.[path];
        if (typeof content === 'string') manifestEngine.writeFile(path, content);
      } catch {
        /* virtual FS is optional */
      }
    }

    this.gameEngine?.emit?.('quicklab:started', {
      labId: this.quickLab.id,
      title: this.quickLab.title,
      objectiveId: this.quickLab.objectiveId,
      check: this.quickLab.check,
      startingResources: (lab.setup?.startingResources || []).map((resource) => ({
        kind: resource.kind,
        name: resource.name,
        namespace: resource.namespace,
      })),
      manifestFiles: lab.setup?.manifestFiles || [],
      steps: lab.steps || [],
    });
    return true;
  }

  /** @returns {{id:string,title:string,objectiveId:string|null,completed:boolean,checks:object[]}|null} */
  getQuickLabStatus() {
    if (!this.quickLab) return null;
    return {
      id: this.quickLab.id,
      title: this.quickLab.title,
      objectiveId: this.quickLab.objectiveId,
      completed: this.quickLab.completed,
      checks: this.quickLab.progress.map((objective) => ({
        type: objective.type,
        label: objective.label || objective.type,
        completed: Boolean(objective.completed),
        current: objective.current || 0,
        target: objective.target || 1,
      })),
      summary: getObjectiveSummary(this.quickLab.progress),
    };
  }

  /** Evaluate quick-lab check objectives; mark the linked EX280 bullet mastered. */
  _updateQuickLab() {
    const lab = this.quickLab;
    if (!lab || lab.completed || lab.progress.length === 0) return;
    const context = {
      clusterState: this.gameEngine?.cluster || null,
      gameEngine: this.gameEngine || null,
      scoringEngine: this.scoringEngine || null,
      manifestEngine: this.gameEngine?.manifestEngine || null,
      incidentEngine: (typeof window !== 'undefined' ? window.game?.incidentEngine : null) || null,
      objectiveProgress: lab.progress,
      levelDef: null,
    };
    try {
      evaluateObjectives(lab.check, context, { progress: lab.progress });
    } catch (error) {
      console.warn('SandboxMode: quick lab check evaluation failed', error);
      return;
    }
    const summary = getObjectiveSummary(lab.progress);
    if (!summary.allCompleted) return;
    lab.completed = true;
    lab.completedAt = Date.now();
    let marked = null;
    try {
      if (lab.objectiveId && typeof this.scoringEngine?.markExamPrep === 'function') {
        marked = this.scoringEngine.markExamPrep(lab.objectiveId, 'mastered');
      }
    } catch (error) {
      console.warn('SandboxMode: could not mark quick lab objective', error);
    }
    this.gameEngine?.emit?.('quicklab:completed', {
      labId: lab.id,
      title: lab.title,
      objectiveId: lab.objectiveId,
      checks: this.getQuickLabStatus()?.checks || [],
      marked,
      message: `Quick lab complete: ${lab.title}. Objective ${lab.objectiveId || ''} marked mastered.`,
    });
  }

  getArchitectureScore() {
    const state = this.gameEngine?.cluster;
    if (!state || typeof this.scoringEngine?.calculateArchitectureScore !== 'function') return null;

    this.architectureScore = this.scoringEngine.calculateArchitectureScore(state);

    this.gameEngine?.emit?.('sandbox:architecture-score', {
      total: this.architectureScore.total,
      categories: Object.entries(this.architectureScore.categories).map(([key, value]) => ({
        name: key,
        score: value.score,
        recommendations: value.recommendations,
      })),
    });

    return this.architectureScore;
  }

  refreshArchitectureScore() {
    if (this.state !== SANDBOX_STATE.PLAYING) return;
    this.getArchitectureScore();
  }

  /**
   * Export every resource as apply-clean OpenShift YAML using the shared
   * ManifestSerializer (via kindRegistry). No local serializer.
   * @returns {string}
   */
  exportClusterYAML() {
    const state = this.gameEngine?.cluster;
    if (!state) return '';

    const allResources = typeof state.getAllResources === 'function' ? state.getAllResources() : [];
    const sorted = [...allResources].sort((left, right) => {
      const leftKey = `${left.kind}/${left.metadata?.namespace || ''}/${left.metadata?.name || ''}`;
      const rightKey = `${right.kind}/${right.metadata?.namespace || ''}/${right.metadata?.name || ''}`;
      return leftKey.localeCompare(rightKey);
    });

    const documents = [];
    for (const resource of sorted) {
      if (!resource || !resource.kind) continue;
      try {
        const yaml =
          typeof resource.toYAML === 'function'
            ? resource.toYAML()
            : toManifestYAML(toManifestObject(resource));
        if (yaml && String(yaml).trim()) documents.push(String(yaml).trimEnd());
      } catch (error) {
        console.warn(
          `SandboxMode: could not serialise ${resource.kind}/${resource.metadata?.name || resource.name}`,
          error
        );
      }
    }

    const yaml = documents.join('\n---\n');
    this.gameEngine?.emit?.('sandbox:yaml-exported', { resourceCount: documents.length });
    this.gameEngine?.emit?.('yaml:viewed', {});
    return yaml;
  }

  /** apiVersion for a kind — single source of truth is the registry. */
  getApiVersion(kind) {
    return apiVersionForKind(kind);
  }

  cleanSpec(spec) {
    if (!spec || typeof spec !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(spec)) {
      if (key === 'status' || value === undefined) continue;
      out[key] = value;
    }
    return out;
  }

  pause() {
    if (this.state !== SANDBOX_STATE.PLAYING) return;
    this.state = SANDBOX_STATE.PAUSED;
    this.gameEngine?.emit?.('sandbox:paused', {});
  }

  resume() {
    if (this.state !== SANDBOX_STATE.PAUSED) return;
    this.state = SANDBOX_STATE.PLAYING;
    this.gameEngine?.emit?.('sandbox:resumed', {});
  }

  getStatus() {
    return {
      state: this.state,
      elapsedTime: Math.round(this.elapsedTime),
      resourceCount: this.resourceCount,
      nodeCount: this.nodeCount,
      availableResources: ALL_RESOURCE_TYPES,
      architectureScore: this.architectureScore,
      currentProject: this.gameEngine?.currentProject || 'default',
      currentUser: this.gameEngine?.currentUser || null,
    };
  }

  stopTicking() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.autoScoreInterval) {
      clearInterval(this.autoScoreInterval);
      this.autoScoreInterval = null;
    }
  }

  exit() {
    this.stopTicking();
    this.state = SANDBOX_STATE.IDLE;
    this.quickLab = null;
    this.gameEngine?.emit?.('sandbox:exited', {});
  }

  destroy() {
    this.stopTicking();
    this.gameEngine = null;
    this.scoringEngine = null;
  }
}

export { SandboxMode, SANDBOX_STATE, ALL_RESOURCE_TYPES };
