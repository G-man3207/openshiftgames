/**
 * ChaosMode — OpenShift 4.22 "production firefighting" survival mode.
 *
 * Preserves the original chaos mechanics (survival timer, difficulty, health
 * decay, waves, combo XP, scoring) while the simulated cluster and copy are
 * OpenShift-specific:
 *   - Projects, Deployments, Services, Route, BuildConfig
 *   - incident categories/names from js/data/IncidentDefs.js (CrashLoopBackOff,
 *     RouteNotAdmitted, SCCForbidden, ResourceQuotaExceeded, BuildFailed, ...)
 *   - registry-valid resource specs (no bogus top-level Deployment.image)
 *
 * ClusterState.clear() re-seeds the OpenShift 4.22 baseline (10 Projects,
 * default ServiceAccounts, SCCs, users, ClusterOperators, ClusterVersion,
 * OAuth, ImageStreams, project-request Template); ChaosMode keeps it and adds
 * its own OpenShift namespaces/workloads on top.
 */

import { INCIDENT_CATEGORIES } from '../data/IncidentDefs.js';
import { OPENSHIFT_VERSION } from '../engine/ClusterState.js';

const CHAOS_STATE = {
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAME_OVER: 'gameOver',
};

const INITIAL_CLUSTER = {
  projects: [
    {
      kind: 'Project',
      name: 'storefront',
      spec: { displayName: 'Storefront', description: 'Customer-facing web tier' },
    },
    {
      kind: 'Project',
      name: 'platform',
      spec: { displayName: 'Platform services', description: 'Workers, jobs and batch processing' },
    },
  ],
  nodes: [
    { kind: 'Node', name: 'chaos-node-1', spec: { cpu: '8', memory: '16Gi' } },
    { kind: 'Node', name: 'chaos-node-2', spec: { cpu: '8', memory: '16Gi' } },
    { kind: 'Node', name: 'chaos-node-3', spec: { cpu: '8', memory: '16Gi' } },
  ],
  workloads: [
    {
      kind: 'Deployment',
      name: 'web-frontend',
      namespace: 'storefront',
      spec: {
        replicas: 2,
        template: {
          metadata: { labels: { app: 'web-frontend' } },
          spec: {
            containers: [
              {
                name: 'main',
                image: 'quay.io/openshift/origin-hello-openshift:latest',
                ports: [{ name: 'http', containerPort: 8080 }],
              },
            ],
          },
        },
      },
    },
    {
      kind: 'Deployment',
      name: 'api-backend',
      namespace: 'storefront',
      spec: {
        replicas: 2,
        template: {
          metadata: { labels: { app: 'api-backend' } },
          spec: {
            containers: [
              {
                name: 'main',
                image: 'quay.io/openshift/origin-hello-openshift:latest',
                ports: [{ name: 'http', containerPort: 8080 }],
              },
            ],
          },
        },
      },
    },
    {
      kind: 'Deployment',
      name: 'catalog-worker',
      namespace: 'platform',
      spec: {
        replicas: 1,
        template: {
          metadata: { labels: { app: 'catalog-worker' } },
          spec: {
            containers: [
              { name: 'main', image: 'quay.io/openshift/origin-hello-openshift:latest' },
            ],
          },
        },
      },
    },
    {
      kind: 'Service',
      name: 'web-frontend',
      namespace: 'storefront',
      spec: {
        type: 'ClusterIP',
        selector: { app: 'web-frontend' },
        ports: [{ name: 'http', port: 8080, targetPort: 8080 }],
      },
    },
    {
      kind: 'Service',
      name: 'api-backend',
      namespace: 'storefront',
      spec: {
        type: 'ClusterIP',
        selector: { app: 'api-backend' },
        ports: [{ name: 'http', port: 8080, targetPort: 8080 }],
      },
    },
    {
      kind: 'Route',
      name: 'web-frontend',
      namespace: 'storefront',
      spec: {
        to: { kind: 'Service', name: 'web-frontend', weight: 100 },
        port: { targetPort: 'http' },
        tls: { termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' },
        wildcardPolicy: 'None',
      },
    },
    {
      kind: 'BuildConfig',
      name: 'web-frontend',
      namespace: 'storefront',
      spec: {
        source: {
          type: 'Git',
          git: { uri: 'https://github.com/openshift/nodejs-ex', ref: 'main' },
        },
        strategy: {
          type: 'Source',
          sourceStrategy: {
            from: { kind: 'ImageStreamTag', name: 'nodejs:20-ubi9', namespace: 'openshift' },
          },
        },
        output: { to: { kind: 'ImageStreamTag', name: 'web-frontend:latest' } },
        triggers: [{ type: 'ConfigChange' }, { type: 'ImageChange' }],
        runPolicy: 'Serial',
      },
    },
  ],
};

class ChaosMode {
  constructor(gameEngine, incidentEngine, scoringEngine) {
    this.gameEngine = gameEngine;
    this.incidentEngine = incidentEngine;
    this.scoringEngine = scoringEngine;
    this.ticker = null;
    this.pauseStart = 0;
    this.gameOverThreshold = 0;
    this._boundOnIncidentResolved = (data) => {
      if (this.state !== CHAOS_STATE.PLAYING) return;
      this.onIncidentResolved(data);
    };
    this._boundOnIncidentCreated = (data) => {
      if (this.state !== CHAOS_STATE.PLAYING) return;
      this.noteIncident(data);
    };
    this.resetState();
  }

  resetState() {
    this.state = CHAOS_STATE.IDLE;
    this.survivalTime = 0;
    this.startTime = 0;
    this.pausedTime = 0;
    this.chaosBudget = 1;
    this.difficultyLevel = 1;
    this.totalXP = 0;
    this.incidentsResolved = 0;
    this.highestCombo = 0;
    this.clusterHealth = 100;
    this.healthDecayRate = 0;
    this.waveNumber = 0;
    this.waveIncidentCount = 0;
    this.waveCooldown = false;
    this.waveCooldownTimer = 0;
    this.incidentCategories = {};
    this.lastIncident = null;
    this.lastResolution = null;
  }

  start() {
    this.resetState();
    this.state = CHAOS_STATE.PLAYING;
    this.startTime = Date.now();
    try {
      this.scoringEngine?.endDrillEvidence?.();
    } catch {
      /* non-fatal */
    }

    this.setupCluster();
    this.incidentEngine?.reset?.();
    this.incidentEngine?.start?.('chaos');

    this.stopTicking();
    this.ticker = setInterval(() => this.update(), 1000);

    if (this.gameEngine && typeof this.gameEngine.off === 'function') {
      this.gameEngine.off('incident:resolved', this._boundOnIncidentResolved);
      this.gameEngine.off('incident:created', this._boundOnIncidentCreated);
    }
    this.gameEngine?.on?.('incident:resolved', this._boundOnIncidentResolved);
    this.gameEngine?.on?.('incident:created', this._boundOnIncidentCreated);

    this.gameEngine?.emit?.('chaos:started', {
      initialCluster: INITIAL_CLUSTER,
      difficultyLevel: this.difficultyLevel,
      openshiftVersion: OPENSHIFT_VERSION,
      incidentCategories: Object.keys(INCIDENT_CATEGORIES || {}),
      description:
        'Keep the OpenShift platform healthy while incidents cascade across Projects, Routes, Builds and Operators.',
    });
  }

  setupCluster() {
    const clusterState = this.gameEngine?.cluster;
    if (!clusterState) return;

    clusterState.clear();

    const allResources = [
      ...INITIAL_CLUSTER.projects,
      ...INITIAL_CLUSTER.nodes,
      ...INITIAL_CLUSTER.workloads,
    ];

    for (const descriptor of allResources) {
      try {
        this.addStartingResource(clusterState, descriptor);
      } catch (error) {
        console.warn(`ChaosMode: could not seed ${descriptor.kind}/${descriptor.name}`, error);
      }
    }
  }

  addStartingResource(clusterState, descriptor) {
    if (!descriptor || !descriptor.kind) return null;
    const name = descriptor.name;
    const namespace =
      descriptor.namespace ||
      descriptor.metadata?.namespace ||
      (descriptor.kind === 'Project' ? '' : 'default');
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

    if (descriptor.kind === 'Project' && typeof clusterState.ensureProjectDefaults === 'function') {
      clusterState.ensureProjectDefaults(added);
    }

    if (descriptor.kind === 'Node' && typeof added.setCondition === 'function') {
      added.setPhase?.('Running');
      added.setCondition('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status');
      clusterState.update(added.uid, added);
    }

    if (descriptor.kind === 'Deployment') {
      const spec = added.spec || {};
      spec.replicas = spec.replicas ?? 1;
      spec.selector = spec.selector || { matchLabels: { app: name } };
      spec.template = spec.template || {};
      spec.template.metadata = spec.template.metadata || {};
      spec.template.metadata.labels = { app: name, ...(spec.template.metadata.labels || {}) };
      spec.template.spec = spec.template.spec || {};
      spec.template.spec.containers = spec.template.spec.containers || [
        { name: 'main', image: 'quay.io/openshift/origin-hello-openshift:latest' },
      ];
    }

    if (descriptor.kind === 'Service') {
      const spec = added.spec || {};
      if (!spec.selector || Object.keys(spec.selector).length === 0) spec.selector = { app: name };
      if (spec.type === undefined) spec.type = 'ClusterIP';
    }

    if (descriptor.kind === 'Route') {
      const spec = added.spec || {};
      spec.to = spec.to || { kind: 'Service', name: descriptor.service || name, weight: 100 };
      spec.wildcardPolicy = spec.wildcardPolicy || 'None';
    }

    return added;
  }

  update() {
    if (this.state !== CHAOS_STATE.PLAYING) return;

    this.survivalTime = (Date.now() - this.startTime - this.pausedTime) / 1000;
    this.updateDifficulty();
    this.updateHealth();
    this.updateWaves();
    this.checkGameOver();

    this.gameEngine?.emit?.('chaos:update', {
      survivalTime: Math.round(this.survivalTime),
      difficultyLevel: this.difficultyLevel,
      chaosBudget: Math.round(this.chaosBudget * 10) / 10,
      clusterHealth: Math.round(this.clusterHealth),
      activeIncidents: this.incidentEngine?.getActiveIncidents?.().length || 0,
      incidentsResolved: this.incidentsResolved,
      currentCombo: this.incidentEngine?.comboCount || 0,
      highestCombo: this.highestCombo,
      totalXP: this.totalXP,
      waveNumber: this.waveNumber,
      incidentCategories: { ...this.incidentCategories },
      lastIncident: this.lastIncident,
      lastResolution: this.lastResolution,
    });
  }

  updateDifficulty() {
    const minutesElapsed = this.survivalTime / 60;
    this.difficultyLevel = Math.min(10, 1 + Math.floor(minutesElapsed / 2));
    this.chaosBudget = 1 + minutesElapsed * 0.5;
    this.healthDecayRate = this.difficultyLevel * 0.1;
  }

  updateHealth() {
    const activeIncidents = this.incidentEngine?.getActiveIncidents?.() || [];
    let penalty = 0;

    for (const incident of activeIncidents) {
      const severityPenalty = incident.severity * 2;
      const timeFactor = 1 + ((Date.now() - incident.createdAt) / 60000) * 0.5;
      penalty += severityPenalty * timeFactor;
    }

    penalty += this.healthDecayRate;

    const regenRate = this.incidentsResolved > 0 ? 0.5 : 0;
    this.clusterHealth = Math.max(
      0,
      Math.min(100, this.clusterHealth - penalty / 60 + regenRate / 60)
    );
  }

  updateWaves() {
    if (this.waveCooldown) {
      this.waveCooldownTimer -= 1;
      if (this.waveCooldownTimer <= 0) {
        this.waveCooldown = false;
        this.startNewWave();
      }
      return;
    }

    const minutesElapsed = this.survivalTime / 60;
    const waveInterval = Math.max(1, 3 - this.difficultyLevel * 0.2);
    const expectedWave = Math.floor(minutesElapsed / waveInterval) + 1;

    if (expectedWave > this.waveNumber) {
      this.startNewWave();
    }
  }

  startNewWave() {
    this.waveNumber++;
    this.waveIncidentCount = Math.min(5, 1 + Math.floor(this.waveNumber / 3));

    this.gameEngine?.emit?.('chaos:wave', {
      waveNumber: this.waveNumber,
      incidentCount: this.waveIncidentCount,
      difficultyLevel: this.difficultyLevel,
      message: `Incident wave ${this.waveNumber} is hitting the OpenShift platform (${this.waveIncidentCount} potential incidents).`,
    });

    this.waveCooldown = true;
    this.waveCooldownTimer = Math.max(5, 15 - this.difficultyLevel);
  }

  onIncidentResolved(data = {}) {
    this.incidentsResolved++;
    this.totalXP += data.xpEarned || 0;
    this.highestCombo = Math.max(this.highestCombo, data.combo || 0);

    if (data.category) {
      this.incidentCategories[data.category] = (this.incidentCategories[data.category] || 0) + 1;
    }
    this.lastResolution = {
      name: data.name || null,
      category: data.category || null,
      severity: data.severity || null,
      action: data.action || null,
      at: Date.now(),
    };

    const healthBonus = Math.min(10, (data.severity || 1) * 2);
    this.clusterHealth = Math.min(100, this.clusterHealth + healthBonus);

    this.gameEngine?.emit?.('chaos:incident-resolved', {
      xpEarned: data.xpEarned,
      combo: data.combo,
      healthRecovered: healthBonus,
      clusterHealth: Math.round(this.clusterHealth),
      incident: data.name || null,
      category: data.category || null,
      message: data.name
        ? `${data.name} (${data.category || 'OpenShift'}) resolved; platform health recovering.`
        : 'OpenShift incident resolved; platform health recovering.',
    });
  }

  /** Record a newly spawned incident for HUD/messages (called when engine emits). */
  noteIncident(incident = {}) {
    this.lastIncident = {
      name: incident.name || null,
      category: incident.category || null,
      severity: incident.severity || null,
      target: incident.target || null,
      at: Date.now(),
    };
  }

  checkGameOver() {
    if (this.clusterHealth <= this.gameOverThreshold) {
      this.gameOver();
    }
  }

  gameOver() {
    this.state = CHAOS_STATE.GAME_OVER;
    this.stopTicking();
    this.incidentEngine?.stop?.();
    this.gameEngine?.off?.('incident:created', this._boundOnIncidentCreated);

    this.scoringEngine?.recordChaosSurvival?.(this.survivalTime);

    const finalStats = {
      survivalTime: Math.round(this.survivalTime),
      difficultyReached: this.difficultyLevel,
      incidentsResolved: this.incidentsResolved,
      highestCombo: this.highestCombo,
      totalXP: this.totalXP,
      wavesReached: this.waveNumber,
      incidentCategories: { ...this.incidentCategories },
      incidentBreakdown: this.incidentEngine?.getStats?.() || {},
      openshiftVersion: OPENSHIFT_VERSION,
    };

    this.gameEngine?.emit?.('chaos:game-over', finalStats);
    this.gameEngine?.emit?.('mode:game-over', {
      message: `OpenShift platform survived ${Math.round(this.survivalTime)}s | Wave ${this.waveNumber} | ${this.incidentsResolved} incidents resolved | Combo x${this.highestCombo}`,
    });

    return finalStats;
  }

  pause() {
    if (this.state !== CHAOS_STATE.PLAYING) return;
    this.state = CHAOS_STATE.PAUSED;
    this.pauseStart = Date.now();
    this.incidentEngine?.pause?.();
    this.gameEngine?.emit?.('chaos:paused', { survivalTime: Math.round(this.survivalTime) });
  }

  resume() {
    if (this.state !== CHAOS_STATE.PAUSED) return;
    this.state = CHAOS_STATE.PLAYING;
    this.pausedTime += Date.now() - this.pauseStart;
    this.incidentEngine?.resume?.();
    this.gameEngine?.emit?.('chaos:resumed', {});
  }

  getStatus() {
    return {
      state: this.state,
      survivalTime: Math.round(this.survivalTime),
      difficultyLevel: this.difficultyLevel,
      chaosBudget: Math.round(this.chaosBudget * 10) / 10,
      clusterHealth: Math.round(this.clusterHealth),
      activeIncidents: this.incidentEngine?.getActiveIncidents?.() || [],
      incidentsResolved: this.incidentsResolved,
      currentCombo: this.incidentEngine?.comboCount || 0,
      highestCombo: this.highestCombo,
      totalXP: this.totalXP,
      waveNumber: this.waveNumber,
      incidentCategories: { ...this.incidentCategories },
      lastIncident: this.lastIncident,
      lastResolution: this.lastResolution,
    };
  }

  stopTicking() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  restart() {
    this.stopTicking();
    this.incidentEngine?.reset?.();
    this.start();
  }

  exit() {
    this.stopTicking();
    this.incidentEngine?.stop?.();
    this.gameEngine?.off?.('incident:resolved', this._boundOnIncidentResolved);
    this.gameEngine?.off?.('incident:created', this._boundOnIncidentCreated);
    this.state = CHAOS_STATE.IDLE;
    this.gameEngine?.emit?.('chaos:exited', {});
  }

  destroy() {
    this.stopTicking();
    this.gameEngine?.off?.('incident:resolved', this._boundOnIncidentResolved);
    this.gameEngine?.off?.('incident:created', this._boundOnIncidentCreated);
    this.gameEngine = null;
    this.incidentEngine = null;
    this.scoringEngine = null;
  }
}

export { ChaosMode, CHAOS_STATE, INITIAL_CLUSTER };
