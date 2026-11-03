/**
 * SimulationTick.js — fixed-step controller loop for OpenShift Games.
 *
 * Extends the original Kubernetes simulation with OpenShift 4.22 controllers:
 *   - Project lifecycle (Active → Terminating → purged)
 *   - Route admission (Service endpoints → status.ingress Admitted condition)
 *   - BuildConfig → Build → ImageStream (+ ImageChange rollout triggers)
 *   - OLM Subscriptions (Installing → Succeeded) and operator effects
 *   - MetalLB IPAddressPool/L2Advertisement → Service EXTERNAL-IP
 *   - SCC admission (privileged / runAsUser:0 → Failed + `scc:denied`)
 *   - LimitRange defaults/min/max enforcement
 *   - ResourceQuota / ClusterResourceQuota enforcement
 *   - OAuth identity-provider rollout (~5s) and ClusterOperator health
 *
 * All mutations happen inside `cluster.startBatch()` / `flushBatch()` so the
 * renderer and UI update once per tick (see docs/architecture-map.md §4).
 *
 * @module engine/SimulationTick
 */

import {
  APPS_DOMAIN,
  IMAGE_REGISTRY_HOST,
  OPENSHIFT_CHANNEL,
  OPENSHIFT_VERSION,
  deepClone,
  parseCpuMillis,
  parseMemoryMi,
} from './ClusterState.js';
import { podSecurityRequest } from './RBACEngine.js';

/** Fixed controller timings in game seconds (1 tick = 0.05 s at 20 TPS). */
const BUILD_PHASE_NEW_SECONDS = 1;
const BUILD_PHASE_PENDING_SECONDS = 1;
const BUILD_PHASE_RUNNING_SECONDS = 6;
const SUBSCRIPTION_INSTALL_SECONDS = 8;
const OAUTH_ROLLOUT_SECONDS = 5;
const PROJECT_TERMINATION_SECONDS = 2;
const ROLLOUT_POD_INTERVAL_SECONDS = 0.2;

export class SimulationTick {
  /**
   * @param {import('./ClusterState.js').ClusterState} clusterState
   * @param {import('./GameEngine.js').EventBus} [eventBus]
   */
  constructor(clusterState, eventBus) {
    this.cluster = clusterState;
    this.eventBus = eventBus || null;
    this.cluster._evictedOwnerCounts = new Map();
    this.cluster._rescheduledCount = 0;

    if (eventBus) {
      eventBus.on('cluster:deleted:Pod', (data) => {
        const pod = data.resource;
        if (pod && pod.metadata.ownerReferences.length > 0) {
          const ownerKey = pod.metadata.ownerReferences[0]?.uid || pod.metadata.ownerReferences[0]?.name;
          if (ownerKey) {
            const map = this.cluster._evictedOwnerCounts;
            map.set(ownerKey, (map.get(ownerKey) || 0) + 1);
          }
        }
      });

      // OLM: deleting a Subscription uninstalls the operator.
      eventBus.on('cluster:deleted:Subscription', (data) => {
        const subscription = data.resource;
        eventBus.emit('operator:uninstalled', {
          name: data.name,
          namespace: data.namespace,
          packageName: subscription?.spec?.packageName || data.name,
        });
      });

      // OAuth: provider changes need a simulated 5s oauth rollout.
      eventBus.on('cluster:added:OAuth', () => this._scheduleOAuthRollout());
      eventBus.on('cluster:modified:OAuth', () => this._scheduleOAuthRollout());

      // SCC grant/revocation re-evaluates pods denied earlier.
      eventBus.on('cluster:modified:SecurityContextConstraints', () => {
        this._sccDirty = true;
      });
      eventBus.on('cluster:added:SecurityContextConstraints', () => {
        this._sccDirty = true;
      });
    }

    this.tickCount = 0;
    this.tickRate = 1;
    this.schedulerQueue = [];
    this.pendingScaleDecisions = new Map();
    this.hpaEvalInterval = 15;
    this.probeInterval = 5;
    this.cronCheckInterval = 10;
    this.metricsHistory = new Map();
    this.maxMetricsHistory = 60;
    this.randomFailureRate = 0.002;
    this.networkLatencyBase = 5;
    this.enableChaos = false;
    this.chaosConfig = {
      podKillRate: 0,
      nodeFailRate: 0,
      networkPartition: false,
      cpuStress: 0,
      memoryStress: 0,
    };

    /** Build failure probability per build (spec §5: random 15%). */
    this.buildFailureRate = 0.15;
    /** Track OAuth rollout state: {remaining, provider}. */
    this._oauthPending = null;
    this._sccDirty = false;
    this._quotaViolationNamespaces = new Set();
  }

  // ── Tick pipeline ───────────────────────────────────────────────────────

  /**
   * Advance all controllers by `deltaTime` seconds (already scaled by tickRate
   * via {@link setTickRate}).
   * @param {number} deltaTime
   */
  tick(deltaTime) {
    this.tickCount++;
    const dt = deltaTime * this.tickRate;

    this.cluster.startBatch();

    // Core OpenShift controllers.
    this._tickProjects(dt);
    this._tickNodes(dt);
    this._tickLimitRanges(dt);
    this._tickQuotaEnforcement(dt);
    this._tickPodScheduling(dt);
    this._tickPodLifecycle(dt);
    this._tickContainerResources(dt);
    this._tickHealthChecks(dt);
    this._tickOOMKiller(dt);

    // Workload controllers.
    this._tickDeployments(dt);
    this._tickStatefulSets(dt);
    this._tickDaemonSets(dt);
    this._tickJobs(dt);
    if (this.tickCount % this.cronCheckInterval === 0) this._tickCronJobs(dt);
    if (this.tickCount % this.hpaEvalInterval === 0) this._tickHPA(dt);
    this._tickPersistentVolumeClaims(dt);

    // OpenShift builds / images / networking / operators.
    this._tickBuildConfigs(dt);
    this._tickBuilds(dt);
    this._tickImageStreams(dt);
    if (this.tickCount % this.probeInterval === 0) this._tickProbes(dt);
    this._tickRoutes(dt);
    this._tickSCC(dt);
    this._tickSubscriptions(dt);
    this._tickOperatorEffects(dt);
    if (this.tickCount % 5 === 0) this.cluster.recalculateQuotaStatus(true);
    if (this.tickCount % 20 === 0) this._tickClusterHealth(dt);
    this._tickOAuth(dt);

    this._recordMetrics();

    if (this.enableChaos) this._tickChaos(dt);

    this.cluster.flushBatch();

    if (this.eventBus) {
      this.eventBus.emit('simulation:tick', {
        tickCount: this.tickCount,
        deltaTime: dt,
        stats: this.cluster.getClusterStats(),
      });
    }
  }

  // ── Projects / OpenShift cluster lifecycle ─────────────────────────────

  _tickProjects(dt) {
    for (const project of this.cluster.getByKind('Project')) {
      const name = project.metadata.name;
      const terminating = project.status.phase === 'Terminating' || project.metadata.deletionTimestamp !== null;
      if (!terminating) {
        if (project.status.phase !== 'Active') project.setPhase('Active');
        continue;
      }
      if (project.status.phase !== 'Terminating') project.setPhase('Terminating');
      project._terminatingElapsed = (project._terminatingElapsed || 0) + dt;
      if (project._terminatingElapsed >= PROJECT_TERMINATION_SECONDS) {
        this.cluster.purgeProject(name);
      }
    }
  }

  // ── Nodes / scheduling / pod lifecycle (preserved) ─────────────────────

  _tickNodes(dt) {
    for (const node of this.cluster.getByKind('Node')) {
      if (node.status.phase === 'Terminating') continue;
      const alloc = this.cluster.getNodeAllocatable(node.name);
      if (!alloc) continue;

      node.status.allocatable = { cpu: alloc.cpu.available, memory: alloc.memory.available };
      node.status.usage = {
        cpu: alloc.cpu.used,
        memory: alloc.memory.used,
        cpuPercent: alloc.cpu.capacity > 0 ? Math.round((alloc.cpu.used / alloc.cpu.capacity) * 100) : 0,
        memoryPercent: alloc.memory.capacity > 0 ? Math.round((alloc.memory.used / alloc.memory.capacity) * 100) : 0,
      };

      const isReady = node.status.phase !== 'NotReady' && node.status.phase !== 'Unknown';
      node.setCondition('Ready', isReady ? 'True' : 'False', isReady ? 'KubeletReady' : 'KubeletNotReady');
      node.setCondition(
        'MemoryPressure',
        alloc.memory.available < 100 ? 'True' : 'False',
        alloc.memory.available < 100 ? 'KubeletHasInsufficientMemory' : 'KubeletHasSufficientMemory'
      );
      node.setCondition(
        'PIDPressure',
        alloc.cpu.available < 50 ? 'True' : 'False',
        alloc.cpu.available < 50 ? 'KubeletHasInsufficientPIDs' : 'KubeletHasSufficientPIDs'
      );
    }
  }

  _tickPodScheduling(dt) {
    const pendingPods = this.cluster.getByKind('Pod').filter(
      (pod) => pod.status.phase === 'Pending' && !pod.spec.nodeName && !pod.metadata.annotations['openshiftgames/scc-denied']
    );

    for (const pod of pendingPods) {
      const node = this._findBestNode(pod);
      if (node) {
        pod.spec.nodeName = node.name;
        pod.status.phase = 'Running';
        pod.status.startTime = new Date().toISOString();
        pod.status.hostIP = node.status.addresses?.[0]?.address || '10.0.0.1';
        pod.status.podIP = this._generatePodIP();
        pod.setCondition('PodScheduled', 'True', 'Scheduled', `Successfully assigned to ${node.name}`);
        pod.setCondition('Initialized', 'True', 'PodInitialized');
        pod.setCondition('Ready', 'False', 'ContainersNotReady');
        this._trackRescheduledPod(pod);
        pod.recordEvent('Normal', 'Scheduled', `Successfully assigned ${pod.namespace}/${pod.name} to ${node.name}`);
        this._initContainerStatuses(pod);
      } else {
        pod.setCondition('PodScheduled', 'False', 'Unschedulable', 'No nodes available with sufficient resources');
        pod.recordEvent('Warning', 'FailedScheduling', 'No nodes available to schedule pod');
      }
    }
  }

  _trackRescheduledPod(pod) {
    if (pod.metadata.ownerReferences.length === 0) return;
    const ownerKey = pod.metadata.ownerReferences[0]?.uid || pod.metadata.ownerReferences[0]?.name;
    const evictedMap = this.cluster._evictedOwnerCounts;
    if (!evictedMap || !ownerKey || !(evictedMap.get(ownerKey) > 0)) return;
    this.cluster._rescheduledCount = (this.cluster._rescheduledCount || 0) + 1;
    evictedMap.set(ownerKey, evictedMap.get(ownerKey) - 1);
    if (evictedMap.get(ownerKey) <= 0) evictedMap.delete(ownerKey);
  }

  _findBestNode(pod) {
    const nodes = this.cluster.getByKind('Node').filter(
      (node) => node.isConditionTrue('Ready') && node.status.phase !== 'Terminating'
    );
    if (nodes.length === 0) return null;

    const requested = this._getPodResourceRequests(pod);
    const nodeSelector = pod.spec.nodeSelector || {};
    let bestNode = null;
    let bestScore = -Infinity;

    for (const node of nodes) {
      if (!node.matchesSelector(nodeSelector)) continue;
      if (pod.spec.tolerations) {
        const taints = node.spec.taints || [];
        const untolerated = taints.filter(
          (taint) => !pod.spec.tolerations.some((toleration) => toleration.key === taint.key && (toleration.operator === 'Exists' || toleration.value === taint.value))
        );
        if (untolerated.some((taint) => taint.effect === 'NoSchedule')) continue;
      }
      const alloc = this.cluster.getNodeAllocatable(node.name);
      if (!alloc) continue;
      if (alloc.cpu.available < requested.cpu) continue;
      if (alloc.memory.available < requested.memory) continue;

      const cpuScore = alloc.cpu.available / (alloc.cpu.capacity || 1);
      const memScore = alloc.memory.available / (alloc.memory.capacity || 1);
      const podCountPenalty = alloc.podCount * 0.05;
      let score = (cpuScore + memScore) / 2 - podCountPenalty;

      if (pod.spec.affinity?.nodeAffinity?.preferredDuringScheduling) {
        for (const preference of pod.spec.affinity.nodeAffinity.preferredDuringScheduling) {
          const matchLabels = preference.matchLabels || preference.preference?.matchExpressions?.reduce((acc, expression) => {
            if (expression.operator === 'In' && expression.values?.length) acc[expression.key] = expression.values[0];
            return acc;
          }, {}) || {};
          if (node.matchesSelector(matchLabels)) score += (preference.weight || 0) / 100;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }
    return bestNode;
  }

  _getPodResourceRequests(pod) {
    let cpu = 0;
    let memory = 0;
    for (const container of pod.spec.containers || []) {
      cpu += parseCpuMillis(container.resources?.requests?.cpu || '100m');
      memory += parseMemoryMi(container.resources?.requests?.memory || '128Mi');
    }
    return { cpu, memory };
  }

  _getPodResourceLimits(pod) {
    let cpu = 0;
    let memory = 0;
    for (const container of pod.spec.containers || []) {
      cpu += parseCpuMillis(container.resources?.limits?.cpu || '0');
      memory += parseMemoryMi(container.resources?.limits?.memory || '0');
    }
    return { cpu, memory };
  }

  _initContainerStatuses(pod) {
    pod.status.containerStatuses = (pod.spec.containers || []).map((container) => ({
      name: container.name,
      image: container.image || 'unknown:latest',
      ready: false,
      started: false,
      restartCount: 0,
      state: { waiting: { reason: 'ContainerCreating' } },
      lastState: {},
      resources: {
        cpu: 0,
        memory: 0,
        cpuLimit: parseCpuMillis(container.resources?.limits?.cpu || '0'),
        memoryLimit: parseMemoryMi(container.resources?.limits?.memory || '0'),
        cpuRequest: parseCpuMillis(container.resources?.requests?.cpu || '100m'),
        memoryRequest: parseMemoryMi(container.resources?.requests?.memory || '128Mi'),
      },
    }));
  }

  _tickPodLifecycle(dt) {
    const runningPods = this.cluster.getByKind('Pod').filter((pod) => pod.status.phase === 'Running');
    for (const pod of runningPods) {
      if (!pod.status.containerStatuses) continue;
      let allReady = true;
      let anyRunning = false;

      for (const status of pod.status.containerStatuses) {
        if (status.state.waiting) {
          if (status.state.waiting.reason === 'ContainerCreating') {
            status.state = { running: { startedAt: new Date().toISOString() } };
            status.started = true;
            status.ready = false;
            pod.recordEvent('Normal', 'Started', `Started container ${status.name}`);
          } else if (status.state.waiting.reason === 'CrashLoopBackOff') {
            const backoffTime = Math.min(300, Math.pow(2, status.restartCount) * 10);
            if (Math.random() < dt / backoffTime) {
              status.state = { running: { startedAt: new Date().toISOString() } };
              status.started = true;
              status.ready = false;
            }
            allReady = false;
            continue;
          }
        }
        if (status.state.running) {
          anyRunning = true;
          if (!status.ready && status.started) {
            status.ready = true;
            pod.recordEvent('Normal', 'Ready', `Container ${status.name} is ready`);
          }
        }
        if (!status.ready) allReady = false;
      }

      if (allReady && anyRunning) {
        pod.setCondition('ContainersReady', 'True', 'ContainersReady');
        pod.setCondition('Ready', 'True', 'PodReady');
      } else {
        pod.setCondition('Ready', 'False', 'ContainersNotReady');
      }

      if (pod.isDeleting) {
        const gracePeriod = pod.spec.terminationGracePeriodSeconds || 30;
        const deletionTime = new Date(pod.metadata.deletionTimestamp).getTime();
        if (Date.now() - deletionTime > gracePeriod * 1000 * (1 / this.tickRate)) {
          pod.status.phase = 'Succeeded';
          pod.removeFinalizer('kubernetes');
        }
      }
    }
  }

  _tickContainerResources(dt) {
    const runningPods = this.cluster.getByKind('Pod').filter(
      (pod) => pod.status.phase === 'Running' && pod.status.containerStatuses
    );
    for (const pod of runningPods) {
      for (const status of pod.status.containerStatuses) {
        if (!status.state.running) continue;
        const baseLoad = status.resources.cpuRequest * 0.6;
        const variance = status.resources.cpuRequest * 0.3;
        status.resources.cpu = Math.max(0, baseLoad + (Math.random() - 0.5) * variance);
        const memBase = status.resources.memoryRequest * 0.7;
        const memGrowth = status.resources.memoryRequest * 0.01 * Math.random();
        status.resources.memory = Math.min(
          status.resources.memoryLimit > 0 ? status.resources.memoryLimit * 1.1 : status.resources.memoryRequest * 2,
          memBase + memGrowth + (status.resources.memory > memBase ? (status.resources.memory - memBase) * 0.99 : 0)
        );

        if (this.randomFailureRate > 0 && Math.random() < this.randomFailureRate) {
          status.state = { waiting: { reason: 'CrashLoopBackOff' } };
          status.ready = false;
          status.started = false;
          status.restartCount++;
          status.lastState = { terminated: { exitCode: 1, reason: 'Error', finishedAt: new Date().toISOString() } };
          pod.recordEvent('Warning', 'BackOff', `Back-off restarting failed container ${status.name}`);
        }
      }
    }
  }

  _tickHealthChecks(dt) {
    const runningPods = this.cluster.getByKind('Pod').filter(
      (pod) => pod.status.phase === 'Running' && pod.status.containerStatuses
    );
    for (const pod of runningPods) {
      const containers = pod.spec.containers || [];
      for (let index = 0; index < containers.length; index++) {
        const container = containers[index];
        const status = pod.status.containerStatuses[index];
        if (!status || !status.state.running) continue;

        if (container.livenessProbe) {
          if (!this._evaluateProbe(container.livenessProbe, status)) {
            status.state = { waiting: { reason: 'CrashLoopBackOff' } };
            status.ready = false;
            status.started = false;
            status.restartCount++;
            status.lastState = { terminated: { exitCode: 137, reason: 'LivenessProbeFailure', finishedAt: new Date().toISOString() } };
            pod.recordEvent('Warning', 'Unhealthy', `Liveness probe failed for container ${status.name}`);
          }
        }
        if (container.readinessProbe) {
          const ready = this._evaluateProbe(container.readinessProbe, status);
          if (!ready && status.ready) {
            status.ready = false;
            pod.recordEvent('Warning', 'Unhealthy', `Readiness probe failed for container ${status.name}`);
          } else if (ready && !status.ready) {
            status.ready = true;
          }
        }
        if (container.startupProbe && !status._startupComplete) {
          if (this._evaluateProbe(container.startupProbe, status)) status._startupComplete = true;
          else status.ready = false;
        }
      }
    }
  }

  _evaluateProbe(probe, containerStatus) {
    if (!containerStatus.state.running) return false;
    const failThreshold = probe.failureThreshold || 3;
    const cpuOverloaded = containerStatus.resources.cpu > containerStatus.resources.cpuLimit * 0.95 && containerStatus.resources.cpuLimit > 0;
    const memOverloaded = containerStatus.resources.memory > containerStatus.resources.memoryLimit * 0.95 && containerStatus.resources.memoryLimit > 0;
    if (cpuOverloaded || memOverloaded) {
      containerStatus._probeFailCount = (containerStatus._probeFailCount || 0) + 1;
      return containerStatus._probeFailCount < failThreshold;
    }
    containerStatus._probeFailCount = 0;
    return true;
  }

  _tickOOMKiller(dt) {
    const runningPods = this.cluster.getByKind('Pod').filter(
      (pod) => pod.status.phase === 'Running' && pod.status.containerStatuses
    );
    for (const pod of runningPods) {
      for (const status of pod.status.containerStatuses) {
        if (!status.state.running) continue;
        if (status.resources.memoryLimit <= 0) continue;
        if (status.resources.memory > status.resources.memoryLimit) {
          status.state = { waiting: { reason: 'CrashLoopBackOff' } };
          status.ready = false;
          status.started = false;
          status.restartCount++;
          status.lastState = {
            terminated: {
              exitCode: 137,
              reason: 'OOMKilled',
              finishedAt: new Date().toISOString(),
              message: `Container ${status.name} exceeded memory limit (${Math.round(status.resources.memory)}Mi > ${status.resources.memoryLimit}Mi)`,
            },
          };
          status.resources.memory = 0;
          status.resources.cpu = 0;
          pod.recordEvent('Warning', 'OOMKilled', `Container ${status.name} was OOM killed`);
          this.eventBus?.emit('incident:oomkill', {
            pod: pod.name,
            namespace: pod.namespace,
            container: status.name,
            memoryUsed: status.resources.memory,
            memoryLimit: status.resources.memoryLimit,
          });
        }
      }
    }
  }

  // ── Workload controllers ───────────────────────────────────────────────

  _tickDeployments(dt) {
    for (const deploy of this.cluster.getByKind('Deployment')) {
      const desiredReplicas = deploy.spec.replicas ?? 1;
      const selector = deploy.spec.selector?.matchLabels || deploy.metadata.labels;

      const replicaSets = this.cluster.selectByLabels('ReplicaSet', selector)
        .filter((replicaSet) => replicaSet.metadata.namespace === deploy.namespace);

      let currentRS = replicaSets[0];
      if (!currentRS) {
        const rs = this.cluster.addResource({
          kind: 'ReplicaSet',
          metadata: {
            name: `${deploy.name}-${this._randomSuffix()}`,
            namespace: deploy.namespace,
            labels: { ...selector, 'pod-template-hash': this._randomSuffix() },
          },
          spec: {
            replicas: desiredReplicas,
            selector: { matchLabels: selector },
            template: deepClone(deploy.spec.template || { spec: { containers: [{ name: 'main', image: 'app:latest' }] } }),
          },
        });
        this.cluster.addRelationship(deploy.uid, rs.uid);
        currentRS = rs;
      }

      // Keep the simulated ReplicaSet template in sync with the Deployment
      // (image change / set image / rollout restart semantics).
      const desiredTemplateJson = JSON.stringify(deploy.spec.template || {});
      if (JSON.stringify(currentRS.spec.template || {}) !== desiredTemplateJson) {
        currentRS.spec.template = deepClone(deploy.spec.template || {});
        this.cluster.update(currentRS.uid, currentRS);
      }
      currentRS.spec.replicas = desiredReplicas;

      const pods = this.cluster.getChildren(currentRS.uid).filter((pod) => pod.kind === 'Pod');
      const runningPods = pods.filter((pod) => pod.status.phase === 'Running' && pod.isConditionTrue('Ready'));
      const totalPods = pods.filter((pod) => pod.status.phase !== 'Succeeded' && pod.status.phase !== 'Failed');
      const deniedPods = pods.filter((pod) => this._isPodBlocked(pod));

      // Simulated rolling update: delete old pods a few per second while the
      // controller recreates them from the (possibly new) template.
      if (deploy._rollout) {
        const rollout = deploy._rollout;
        rollout.elapsed = (rollout.elapsed || 0) + dt;
        if (rollout.remaining === undefined || rollout.remaining === null) rollout.remaining = Math.max(1, pods.length);
        if (rollout.elapsed >= ROLLOUT_POD_INTERVAL_SECONDS) {
          rollout.elapsed = 0;
          const victim = pods.find((pod) => pod.status.phase === 'Running') || pods[0];
          if (victim) this.cluster.remove(victim.uid);
          rollout.remaining -= 1;
          if (rollout.remaining <= 0) delete deploy._rollout;
        }
        deploy.setCondition('Progressing', 'True', 'ReplicaSetUpdated', `rolling out ${deploy._rollout?.reason || 'new template'}`);
      }

      currentRS.status.phase = 'Running';
      currentRS.status.replicas = totalPods.length;
      currentRS.status.readyReplicas = runningPods.length;
      currentRS.status.availableReplicas = runningPods.length;

      deploy.status.replicas = totalPods.length;
      deploy.status.readyReplicas = runningPods.length;
      deploy.status.availableReplicas = runningPods.length;
      deploy.status.updatedReplicas = totalPods.length;
      deploy.status.observedGeneration = deploy.metadata.generation;

      if (deniedPods.length > 0) {
        deploy.setCondition('Available', 'False', 'MinimumReplicasUnavailable', `0/${desiredReplicas} replicas available`);
        deploy.setCondition('Progressing', 'True', 'ReplicaSetUpdated', 'waiting for pods to be admitted');
        deploy.setCondition('ReplicaFailure', 'True', 'FailedCreate', deniedPods[0].metadata.annotations['openshiftgames/denied-reason'] || 'unable to admit pod');
        continue;
      }
      deploy.setCondition('ReplicaFailure', 'False', 'NoReplicaFailure', '');

      if (runningPods.length >= desiredReplicas) {
        deploy.setCondition('Available', 'True', 'MinimumReplicasAvailable');
        deploy.setCondition('Progressing', 'True', 'NewReplicaSetAvailable');
      } else {
        deploy.setCondition('Available', 'False', 'MinimumReplicasUnavailable', `${runningPods.length}/${desiredReplicas} replicas available`);
        deploy.setCondition('Progressing', 'True', 'ReplicaSetUpdated', `${totalPods.length}/${desiredReplicas} replicas created`);
      }

      if (totalPods.length < desiredReplicas) {
        for (let i = 0; i < desiredReplicas - totalPods.length; i++) this._createPodForWorkload(currentRS, deploy);
      } else if (totalPods.length > desiredReplicas) {
        const sortedPods = [...totalPods].sort((a, b) => {
          if (a.status.phase === 'Pending' && b.status.phase !== 'Pending') return -1;
          if (b.status.phase === 'Pending' && a.status.phase !== 'Pending') return 1;
          return new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp);
        });
        for (let i = 0; i < totalPods.length - desiredReplicas; i++) this.cluster.remove(sortedPods[i].uid);
      }
    }
  }

  _tickStatefulSets(dt) {
    for (const statefulSet of this.cluster.getByKind('StatefulSet')) {
      const desiredReplicas = statefulSet.spec.replicas ?? 1;
      const pods = this.cluster.getChildren(statefulSet.uid).filter((pod) => pod.kind === 'Pod');
      const activePods = pods.filter((pod) => pod.status.phase !== 'Succeeded' && pod.status.phase !== 'Failed');
      const readyPods = activePods.filter((pod) => pod.isConditionTrue('Ready'));
      const denied = pods.some((pod) => this._isPodBlocked(pod));

      statefulSet.status.replicas = activePods.length;
      statefulSet.status.readyReplicas = readyPods.length;
      statefulSet.status.currentReplicas = activePods.length;

      if (denied) continue;
      this._ensureStatefulSetClaims(statefulSet, activePods);
      if (activePods.length < desiredReplicas) {
        this._createPodForWorkload(statefulSet, statefulSet, `${statefulSet.name}-${activePods.length}`);
      } else if (activePods.length > desiredReplicas) {
        const sorted = [...activePods].sort((a, b) => {
          const aOrdinal = parseInt(a.name.split('-').pop(), 10) || 0;
          const bOrdinal = parseInt(b.name.split('-').pop(), 10) || 0;
          return bOrdinal - aOrdinal;
        });
        this.cluster.remove(sorted[0].uid);
      }
    }
  }

  /** Create per-replica PVCs from StatefulSet volumeClaimTemplates. */
  _ensureStatefulSetClaims(statefulSet, pods) {
    const templates = statefulSet.spec.volumeClaimTemplates || [];
    if (templates.length === 0) return;
    const desiredReplicas = statefulSet.spec.replicas ?? 1;
    for (let ordinal = 0; ordinal < Math.max(desiredReplicas, pods.length); ordinal++) {
      const podName = `${statefulSet.metadata.name}-${ordinal}`;
      for (const template of templates) {
        const claimName = `${template.metadata?.name || template.name || 'data'}-${podName}`;
        if (!this.cluster.getByName('PersistentVolumeClaim', claimName, statefulSet.metadata.namespace)) {
          this.cluster.addResource({
            kind: 'PersistentVolumeClaim',
            metadata: {
              name: claimName,
              namespace: statefulSet.metadata.namespace,
              labels: { app: statefulSet.metadata.name },
            },
            spec: deepClone(template.spec || { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } }),
          });
        }
      }
    }
  }

  _tickDaemonSets(dt) {
    const nodes = this.cluster.getByKind('Node').filter((node) => node.isConditionTrue('Ready'));
    for (const daemonSet of this.cluster.getByKind('DaemonSet')) {
      const pods = this.cluster.getChildren(daemonSet.uid).filter((pod) => pod.kind === 'Pod');
      const nodeSelector = daemonSet.spec.nodeSelector || {};
      const targetNodes = nodes.filter((node) => node.matchesSelector(nodeSelector));
      const podNodeNames = new Set(pods.map((pod) => pod.spec.nodeName).filter(Boolean));
      if (!pods.some((pod) => this._isPodBlocked(pod))) {
        for (const node of targetNodes) {
          if (podNodeNames.has(node.name)) continue;
          const pod = this._createPodForWorkload(daemonSet, daemonSet);
          if (pod) pod.spec.nodeName = node.name;
        }
      }
      const activePods = pods.filter((pod) => pod.status.phase !== 'Succeeded' && pod.status.phase !== 'Failed');
      daemonSet.status.desiredNumberScheduled = targetNodes.length;
      daemonSet.status.currentNumberScheduled = activePods.length;
      daemonSet.status.numberReady = activePods.filter((pod) => pod.isConditionTrue('Ready')).length;
    }
  }

  _tickJobs(dt) {
    for (const job of this.cluster.getByKind('Job')) {
      if (job.status.phase === 'Complete' || job.status.phase === 'Failed') continue;
      const completions = job.spec.completions ?? 1;
      const parallelism = job.spec.parallelism ?? 1;
      const pods = this.cluster.getChildren(job.uid).filter((pod) => pod.kind === 'Pod');
      const succeededPods = pods.filter((pod) => pod.status.phase === 'Succeeded');
      const activePods = pods.filter((pod) => pod.status.phase === 'Running' || pod.status.phase === 'Pending');
      const failedPods = pods.filter((pod) => pod.status.phase === 'Failed');

      job.status.succeeded = succeededPods.length;
      job.status.active = activePods.length;
      job.status.failed = failedPods.length;

      if (succeededPods.length >= completions) {
        job.setPhase('Complete');
        job.status.completionTime = new Date().toISOString();
        job.setCondition('Complete', 'True', 'JobComplete');
        continue;
      }
      if (failedPods.length > (job.spec.backoffLimit ?? 6)) {
        job.setPhase('Failed');
        job.setCondition('Failed', 'True', 'BackoffLimitExceeded');
        continue;
      }
      if (pods.some((pod) => this._isPodBlocked(pod))) continue;

      const needed = Math.min(parallelism, completions - succeededPods.length) - activePods.length;
      for (let i = 0; i < needed; i++) {
        const pod = this._createPodForWorkload(job, job);
        if (!pod) continue;
        pod.spec.restartPolicy = 'Never';
        pod._completionTime = Date.now() + (job.spec.estimatedDurationSeconds || 30) * 1000 * (0.8 + Math.random() * 0.4);
      }
      for (const pod of activePods) {
        if (pod._completionTime && Date.now() >= pod._completionTime) {
          pod.setPhase('Succeeded');
          for (const status of pod.status.containerStatuses || []) {
            status.state = { terminated: { exitCode: 0, reason: 'Completed', finishedAt: new Date().toISOString() } };
            status.ready = false;
          }
        }
      }
    }
  }

  _tickCronJobs(dt) {
    for (const cronJob of this.cluster.getByKind('CronJob')) {
      if (cronJob.spec.suspend) continue;
      const now = Date.now();
      const lastSchedule = cronJob.status.lastScheduleTime ? new Date(cronJob.status.lastScheduleTime).getTime() : 0;
      const interval = this._parseCronInterval(cronJob.spec.schedule || '*/5 * * * *');
      if (now - lastSchedule < interval) continue;

      const jobName = `${cronJob.name}-${Math.floor(now / 1000)}`;
      const newJob = this.cluster.addResource({
        kind: 'Job',
        metadata: { name: jobName, namespace: cronJob.namespace, labels: { ...(cronJob.spec.jobTemplate?.metadata?.labels || {}) } },
        spec: deepClone(cronJob.spec.jobTemplate?.spec || {}),
      });
      this.cluster.addRelationship(cronJob.uid, newJob.uid);
      cronJob.status.lastScheduleTime = new Date().toISOString();
      cronJob.status.active = (cronJob.status.active || 0) + 1;
      cronJob.recordEvent('Normal', 'SuccessfulCreate', `Created job ${jobName}`);

      const historyLimit = cronJob.spec.successfulJobsHistoryLimit ?? 3;
      const completedJobs = this.cluster.getChildren(cronJob.uid)
        .filter((job) => job.kind === 'Job' && job.status.phase === 'Complete')
        .sort((a, b) => new Date(a.metadata.creationTimestamp) - new Date(b.metadata.creationTimestamp));
      while (completedJobs.length > historyLimit) this.cluster.remove(completedJobs.shift().uid);
    }
  }

  _parseCronInterval(schedule) {
    const parts = String(schedule).split(' ');
    if (parts.length < 5) return 300000;
    if (parts[0].startsWith('*/')) return parseInt(parts[0].slice(2), 10) * 60 * 1000;
    return 60 * 60 * 1000;
  }

  _tickHPA(dt) {
    for (const hpa of this.cluster.getByKind('HorizontalPodAutoscaler')) {
      const targetRef = hpa.spec.scaleTargetRef;
      if (!targetRef) continue;
      const target = this.cluster.getByName(targetRef.kind, targetRef.name, hpa.namespace);
      if (!target) continue;

      const currentReplicas = target.spec.replicas ?? 1;
      const minReplicas = hpa.spec.minReplicas ?? 1;
      const maxReplicas = hpa.spec.maxReplicas ?? 10;
      const metrics = hpa.spec.metrics || [{ type: 'Resource', resource: { name: 'cpu', targetAverageUtilization: 50 } }];
      let desiredReplicas = currentReplicas;

      for (const metric of metrics) {
        if (metric.type !== 'Resource' || !metric.resource) continue;
        const targetUtilization = metric.resource.targetAverageUtilization || metric.resource.target?.averageUtilization || 50;
        const currentUtilization = this._getWorkloadCpuUtilization(target);
        if (currentUtilization > 0) {
          desiredReplicas = Math.max(desiredReplicas, Math.ceil(currentReplicas * (currentUtilization / targetUtilization)));
        }
        hpa.status.currentMetrics = hpa.status.currentMetrics || [];
        const metricStatus = { type: 'Resource', resource: { name: metric.resource.name, currentAverageUtilization: currentUtilization } };
        const existingIndex = hpa.status.currentMetrics.findIndex((entry) => entry.resource?.name === metric.resource.name);
        if (existingIndex >= 0) hpa.status.currentMetrics[existingIndex] = metricStatus;
        else hpa.status.currentMetrics.push(metricStatus);
      }

      desiredReplicas = Math.max(minReplicas, Math.min(maxReplicas, desiredReplicas));
      const scaleUpLimit = Math.max(4, currentReplicas * 2);
      const scaleDownLimit = Math.max(1, Math.floor(currentReplicas * 0.5));
      if (desiredReplicas > currentReplicas) desiredReplicas = Math.min(desiredReplicas, currentReplicas + scaleUpLimit);
      else if (desiredReplicas < currentReplicas) desiredReplicas = Math.max(desiredReplicas, scaleDownLimit);

      if (desiredReplicas !== currentReplicas) {
        const lastScaleTime = hpa.status.lastScaleTime ? new Date(hpa.status.lastScaleTime).getTime() : 0;
        const cooldown = desiredReplicas > currentReplicas ? 30000 : 300000;
        if (Date.now() - lastScaleTime >= cooldown) {
          target.spec.replicas = desiredReplicas;
          hpa.status.currentReplicas = desiredReplicas;
          hpa.status.desiredReplicas = desiredReplicas;
          hpa.status.lastScaleTime = new Date().toISOString();
          const direction = desiredReplicas > currentReplicas ? 'up' : 'down';
          hpa.recordEvent('Normal', 'SuccessfulRescale', `Scaled ${direction} to ${desiredReplicas} replicas`);
          this.eventBus?.emit('hpa:scaled', { hpa: hpa.name, target: target.name, from: currentReplicas, to: desiredReplicas, direction });
        }
      }
    }
  }

  _getWorkloadCpuUtilization(workload) {
    const selector = workload.spec.selector?.matchLabels || workload.metadata.labels;
    const pods = this.cluster.selectByLabels('Pod', selector)
      .filter((pod) => pod.metadata.namespace === workload.namespace && pod.status.phase === 'Running');
    if (pods.length === 0) return 0;
    let totalUtilization = 0;
    let count = 0;
    for (const pod of pods) {
      for (const status of pod.status.containerStatuses || []) {
        if (status.resources.cpuRequest > 0) {
          totalUtilization += (status.resources.cpu / status.resources.cpuRequest) * 100;
          count++;
        }
      }
    }
    return count > 0 ? Math.round(totalUtilization / count) : 0;
  }

  // ── Storage: PersistentVolumeClaim binding ─────────────────────────────

  /** PVC → PV binding controller (static matching + dynamic provisioning). */
  _tickPersistentVolumeClaims(dt) {
    const claims = this.cluster.getByKind('PersistentVolumeClaim');
    if (claims.length === 0) return;

    for (const claim of claims) {
      const phase = claim.status.phase;
      if (phase === 'Bound') {
        if (claim.metadata.deletionTimestamp && claim.spec.volumeName) {
          const volume = this.cluster.getByName('PersistentVolume', claim.spec.volumeName, '');
          if (volume) {
            volume.status.phase = 'Released';
            this.cluster.update(volume.uid, volume);
          }
        }
        continue;
      }

      const request = claim.spec.resources?.requests?.storage || '1Gi';
      const requestMi = parseMemoryMi(request);
      const accessModes = claim.spec.accessModes || ['ReadWriteOnce'];

      const existing = this.cluster.getByKind('PersistentVolume').find((volume) => {
        if (volume.status.phase !== 'Available') return false;
        if ((volume.spec.storageClassName || '') !== (claim.spec.storageClassName || '')) return false;
        if (parseMemoryMi(volume.spec.capacity?.storage || '0') < requestMi) return false;
        return accessModes.every((mode) => (volume.spec.accessModes || []).includes(mode))
          && volume.matchesSelector(claim.spec.selector?.matchLabels || {});
      });

      let volume = existing;
      if (!volume) {
        const storageClass = this._findStorageClass(claim.spec.storageClassName);
        if (storageClass && storageClass.spec?.provisioner && storageClass.spec.provisioner !== 'kubernetes.io/no-provisioner') {
          volume = this.cluster.addResource({
            kind: 'PersistentVolume',
            metadata: {
              name: `pvc-${claim.metadata.uid}`.toLowerCase().slice(0, 63),
              labels: { ...claim.metadata.labels },
              annotations: { 'pv.kubernetes.io/provisioned-by': storageClass.spec.provisioner },
            },
            spec: {
              capacity: { storage: request },
              accessModes: [...accessModes],
              persistentVolumeReclaimPolicy: storageClass.spec.reclaimPolicy || 'Delete',
              storageClassName: storageClass.metadata.name,
              claimRef: { kind: 'PersistentVolumeClaim', name: claim.metadata.name, namespace: claim.metadata.namespace, uid: claim.metadata.uid },
            },
            status: { phase: 'Bound' },
          });
        }
      }

      if (!volume) {
        claim.setCondition('Pending', 'True', 'ProvisioningFailed', `no persistent volumes available for this claim and no storage class is set`);
        continue;
      }

      claim.status.phase = 'Bound';
      claim.status.capacity = { storage: volume.spec.capacity?.storage || request };
      claim.status.accessModes = [...accessModes];
      claim.spec.volumeName = volume.metadata.name;
      volume.status.phase = 'Bound';
      volume.spec.claimRef = {
        kind: 'PersistentVolumeClaim',
        name: claim.metadata.name,
        namespace: claim.metadata.namespace,
        uid: claim.metadata.uid,
      };
      claim.recordEvent('Normal', 'Bound', `PVC ${claim.metadata.name} bound to PV ${volume.metadata.name}`);
      this.cluster.update(claim.uid, claim);
      this.cluster.update(volume.uid, volume);
      this.eventBus?.emit('pvc:bound', {
        claim: claim.metadata.name,
        namespace: claim.metadata.namespace,
        volume: volume.metadata.name,
        resource: claim,
      });
    }
  }

  /** Find a StorageClass by name (or the default storage class). */
  _findStorageClass(storageClassName) {
    const storageClasses = this.cluster.getByKind('StorageClass');
    if (storageClassName) return storageClasses.find((entry) => entry.metadata.name === storageClassName) || null;
    return storageClasses.find((entry) => entry.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true')
      || storageClasses.find((entry) => (entry.spec?.provisioner || '') !== 'kubernetes.io/no-provisioner')
      || null;
  }

  // ── OpenShift: routes / services / MetalLB ─────────────────────────────

  /** Service endpoint accounting (kept from the original simulation). */
  _tickProbes(dt) {
    for (const service of this.cluster.getByKind('Service')) {
      const pods = this.cluster.findPodsForService(service.name, service.namespace);
      const readyPods = pods.filter((pod) => pod.isConditionTrue('Ready'));
      service.status.readyEndpoints = readyPods.length;
      service.status.totalEndpoints = pods.length;
      service.status.endpoints = readyPods.map((pod) => ({
        ip: pod.status.podIP,
        nodeName: pod.spec.nodeName,
        targetRef: { kind: 'Pod', name: pod.name, namespace: pod.namespace },
      }));
    }
  }

  /** Route admission controller (CONVERSION-SPEC §5). */
  _tickRoutes(dt) {
    for (const route of this.cluster.getByKind('Route')) {
      const service = this.cluster.getRouteService(route);
      const namespace = route.metadata.namespace;
      const host = this.cluster.getRouteHost(route);
      if (!route.spec.host) route.spec.host = host;

      let admitted = false;
      let reason = 'ServiceUnavailable';
      let message = 'no endpoints available';

      if (route.spec.rejected === true || route._forceReject === true) {
        reason = 'Rejected';
        message = route._rejectMessage || 'the route has been rejected by the router configuration';
      } else if (!route.spec.to || route.spec.to.kind !== 'Service') {
        reason = 'InvalidTargetKind';
        message = 'route target must be a Service';
      } else if (!service) {
        reason = 'ServiceNotFound';
        message = `service "${route.spec.to.name}" not found`;
      } else {
        const endpoints = this.cluster.getServiceEndpoints(service);
        if (endpoints.length > 0) {
          admitted = true;
          reason = 'Accepted';
          message = 'The route has been admitted by the router';
        }
      }

      const previous = route._admittedState;
      route._admittedState = admitted;
      route.status = route.status || {};
      route.status.ingress = [{
        host,
        routerName: 'default',
        routerCanonicalHostname: `router-default.${APPS_DOMAIN}`,
        wildcardPolicy: route.spec.wildcardPolicy || 'None',
        conditions: [{
          type: 'Admitted',
          status: admitted ? 'True' : 'False',
          reason,
          message,
          lastTransitionTime: new Date().toISOString(),
        }],
      }];
      route.status.observedGeneration = route.metadata.generation;

      if (admitted && previous !== true) {
        this.cluster.update(route.uid, route);
        this.eventBus?.emit('route:admitted', { route: route.metadata.name, host, namespace, resource: route });
      } else if (!admitted && previous !== false) {
        this.cluster.update(route.uid, route);
        this.eventBus?.emit('route:not-admitted', { route: route.metadata.name, host, namespace, reason, message, resource: route });
      }
    }
  }

  /**
   * MetalLB controller: when the MetalLB operator is installed and an
   * IPAddressPool is advertised by an L2Advertisement, assign EXTERNAL-IPs to
   * Services of type LoadBalancer (CONVERSION-SPEC §5).
   */
  _tickOperatorEffects(dt) {
    this._tickMetalLB(dt);
  }

  _tickMetalLB(dt) {
    const subscriptions = this.cluster.getByKind('Subscription');
    const metallbInstalled = subscriptions.some(
      (subscription) => subscription.status.phase === 'Succeeded'
        && /metallb/i.test(subscription.spec?.packageName || subscription.metadata.name)
    );
    const pools = this.cluster.getByKind('IPAddressPool').filter((pool) => (pool.spec?.addresses || []).length > 0);
    const advertisements = this.cluster.getByKind('L2Advertisement');
    const advertisedPools = new Set();
    for (const advertisement of advertisements) {
      const names = advertisement.spec?.ipAddressPools || [];
      if (names.length === 0) {
        // An L2Advertisement without an explicit pool list advertises all pools.
        for (const pool of pools) advertisedPools.add(pool.metadata.name);
      } else {
        for (const name of names) advertisedPools.add(name);
      }
    }
    const usablePools = pools.filter((pool) => advertisedPools.has(pool.metadata.name));

    const services = this.cluster.getByKind('Service').filter((service) => service.spec.type === 'LoadBalancer');
    if (services.length === 0) return;

    const usedIps = new Set();
    for (const service of this.cluster.getByKind('Service')) {
      for (const ingress of service.status?.loadBalancer?.ingress || []) {
        if (ingress.ip) usedIps.add(ingress.ip);
      }
    }

    for (const service of services) {
      const current = service.status?.loadBalancer?.ingress || [];
      if (!metallbInstalled || usablePools.length === 0) {
        if (current.length > 0) {
          service.status.loadBalancer = { ingress: [] };
          this.cluster.update(service.uid, service);
        }
        service.status.loadBalancer = service.status.loadBalancer || { ingress: [] };
        continue;
      }
      if (current.length > 0) continue;

      const address = this._allocateMetalLBAddress(usablePools, usedIps);
      if (!address) continue;
      usedIps.add(address);
      service.status.loadBalancer = {
        ingress: [{
          ip: address,
          ipMode: 'VIP',
          hostname: '',
        }],
      };
      this.cluster.update(service.uid, service);
      service.recordEvent('Normal', 'EnsuredLoadBalancer', `Assigned external IP ${address}`);
      this.eventBus?.emit('service:external-ip', {
        service: service.metadata.name,
        namespace: service.metadata.namespace,
        ip: address,
        resource: service,
      });
    }
  }

  /** Pick the first free IP from the advertised MetalLB pools. */
  _allocateMetalLBAddress(pools, usedIps) {
    for (const pool of pools) {
      for (const rawAddress of pool.spec.addresses || []) {
        for (const candidate of this._expandAddressRange(rawAddress)) {
          if (!usedIps.has(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  /**
   * Expand a MetalLB address entry ("192.168.1.200-192.168.1.210" or
   * "192.168.1.0/24") into a bounded list of candidate IPs.
   * @param {string} entry
   * @returns {string[]}
   */
  _expandAddressRange(entry) {
    const value = String(entry || '').trim();
    if (!value) return [];
    if (value.includes('-')) {
      const [start, end] = value.split('-').map((part) => part.trim());
      const startParts = start.split('.').map(Number);
      const endParts = end.split('.').map(Number);
      if (startParts.length !== 4 || endParts.length !== 4) return [start];
      let current = this._ipToInt(startParts);
      const last = this._ipToInt(endParts);
      const results = [];
      while (current <= last && results.length < 256) {
        results.push(this._intToIp(current));
        current++;
      }
      return results;
    }
    if (value.includes('/')) {
      const [base, prefixRaw] = value.split('/');
      const prefix = parseInt(prefixRaw, 10);
      const parts = base.split('.').map(Number);
      if (parts.length !== 4 || Number.isNaN(prefix)) return [base];
      const hostBits = 32 - prefix;
      const network = this._ipToInt(parts) & (hostBits === 0 ? 0xffffffff : (0xffffffff << hostBits) >>> 0);
      const results = [];
      for (let offset = 1; offset < Math.min(1 << hostBits, 64); offset++) results.push(this._intToIp((network + offset) >>> 0));
      return results;
    }
    return [value];
  }

  _ipToInt(parts) {
    return (((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + parts[3]) >>> 0;
  }

  _intToIp(value) {
    return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
  }

  // ── OpenShift: builds & image streams ──────────────────────────────────

  /** BuildConfig controller: kick off the initial ConfigChange build. */
  _tickBuildConfigs(dt) {
    for (const buildConfig of this.cluster.getByKind('BuildConfig')) {
      if (!buildConfig._initialTriggerChecked) {
        buildConfig._initialTriggerChecked = true;
        const hasConfigChange = (buildConfig.spec.triggers || []).some((trigger) => trigger.type === 'ConfigChange');
        const hasBuilds = this.cluster.getBuildsForConfig(buildConfig).length > 0;
        if (hasConfigChange && !hasBuilds) {
          buildConfig._autoBuildElapsed = 0;
        }
      }
      if (buildConfig._autoBuildElapsed !== undefined && buildConfig._autoBuildElapsed !== null) {
        buildConfig._autoBuildElapsed += dt;
        if (buildConfig.status?.phase !== 'Building') {
          // fall through to timing check
        }
        if (buildConfig._autoBuildElapsed >= 1) {
          buildConfig._autoBuildElapsed = null;
          if (!this.cluster.getActiveBuildFor(buildConfig)) {
            this.cluster.startBuildFor(buildConfig, { reason: 'ConfigChange' });
          }
        }
      }
    }
  }

  /** Build controller: New → Pending → Running → Complete/Failed. */
  _tickBuilds(dt) {
    for (const build of this.cluster.getByKind('Build')) {
      if (!['New', 'Pending', 'Running'].includes(build.status.phase)) continue;

      if (build._phaseElapsed === undefined) {
        build._phaseElapsed = 0;
        build._phase = build.status.phase || 'New';
        build._willFail = this._shouldBuildFail(build);
        build._failMessage = build._willFail ? this._buildFailureMessage(build) : '';
      }
      build._phaseElapsed += dt;
      const buildConfig = this._findBuildConfigForBuild(build);

      if (build.status.phase === 'New') {
        if (build._phaseElapsed >= BUILD_PHASE_NEW_SECONDS) {
          build.status.phase = 'Pending';
          build.status.reason = 'BuildPending';
          build._phaseElapsed = 0;
          build.recordEvent('Normal', 'BuildStarted', `Build ${build.metadata.name} started`);
          this.cluster.update(build.uid, build);
        }
        continue;
      }
      if (build.status.phase === 'Pending') {
        if (build._phaseElapsed >= BUILD_PHASE_PENDING_SECONDS) {
          build.status.phase = 'Running';
          build.status.reason = 'BuildRunning';
          build._phaseElapsed = 0;
          this.cluster.update(build.uid, build);
        }
        continue;
      }

      // Running
      if (build._willFail) {
        if (build._phaseElapsed >= 1) this._completeBuildWithFailure(build, buildConfig);
        continue;
      }
      if (build._phaseElapsed >= this._buildRunningDuration(build)) {
        this._completeBuildSuccess(build, buildConfig);
      }
    }
  }

  /** Deterministic 6–10s running duration based on the build name. */
  _buildRunningDuration(build) {
    const variance = this._hashString(`${build.metadata.name}:running`) % 41; // 0..40 tenths
    return BUILD_PHASE_RUNNING_SECONDS + variance / 10;
  }

  _findBuildConfigForBuild(build) {
    const owner = build.metadata.ownerReferences.find((reference) => reference.kind === 'BuildConfig');
    if (owner) return this.cluster.get(owner.uid) || this.cluster.getBuildConfig(build.namespace, owner.name);
    return this.cluster.getBuildConfig(build.namespace, build.metadata.labels?.buildconfig || build.metadata.labels?.['buildconfig.openshift.io/name']);
  }

  /**
   * Decide whether a build fails. Deterministic per build name (different build
   * versions get different outcomes) plus explicit `spec.forFailure` overrides.
   */
  _shouldBuildFail(build) {
    const buildConfig = this._findBuildConfigForBuild(build);
    if (build.spec?.forFailure === true || buildConfig?.spec?.forFailure === true) return true;
    // The first build of a BuildConfig always succeeds (deterministic levels /
    // verifier flows); later versions can fail randomly like a real cluster.
    const version = parseInt(String(build.metadata.name).split('-').pop(), 10);
    if (Number.isFinite(version) && version <= 1) return false;
    if (buildConfig?.spec?.failureRate !== undefined) {
      return (this._hashString(`${build.metadata.name}:failure`) % 1000) / 1000 < Number(buildConfig.spec.failureRate);
    }
    if (!(this.buildFailureRate > 0)) return false;
    return (this._hashString(`${build.metadata.name}:failure`) % 1000) / 1000 < this.buildFailureRate;
  }

  /** Human-readable build failure message (mirrors `oc logs build/...`). */
  _buildFailureMessage(build) {
    if (build.spec?.forFailureMessage) return build.spec.forFailureMessage;
    return 'build failed: error: unable to build the image: source compilation failed (simulated failure)';
  }

  _completeBuildSuccess(build, buildConfig) {
    build.status.phase = 'Complete';
    build.status.completionTime = new Date().toISOString();
    build.status.reason = 'BuildComplete';
    build.status.message = 'Build completed successfully';
    build.setCondition('Complete', 'True', 'BuildComplete');
    this.cluster.update(build.uid, build);

    const output = build.spec?.output?.to || buildConfig?.spec?.output?.to || {};
    if (output.kind === 'ImageStreamTag' && output.name) {
      const [imageStreamName, tag = 'latest'] = String(output.name).split(':');
      const namespace = output.namespace || build.metadata.namespace;
      const result = this.cluster.updateImageStreamTag(namespace, imageStreamName, tag, {});
      build.status.output = {
        to: { kind: 'ImageStreamTag', name: `${imageStreamName}:${tag}` },
        imageDigest: result.tagEntry?.items?.[0]?.image || '',
      };
      this.cluster.update(build.uid, build);
      this._triggerImageChangeRollout(namespace, imageStreamName, tag, result.tagEntry?.items?.[0]?.dockerImageReference);
    }

    if (buildConfig) {
      buildConfig.status.lastVersion = Math.max(buildConfig.status?.lastVersion || 0, Number(build.status?.version) || buildConfig.status?.lastVersion || 0);
      this.cluster.update(buildConfig.uid, buildConfig);
    }
    build.recordEvent('Normal', 'BuildCompleted', `Build ${build.metadata.name} completed successfully`);
    this.eventBus?.emit('build:complete', {
      build: build.metadata.name,
      buildConfig: buildConfig?.metadata.name || '',
      namespace: build.metadata.namespace,
      imageStream: output.name || '',
      resource: build,
    });
  }

  _completeBuildWithFailure(build, buildConfig) {
    build.status.phase = 'Failed';
    build.status.completionTime = new Date().toISOString();
    build.status.reason = 'BuildFailed';
    build.status.message = this._buildFailureMessage(build);
    build.setCondition('Complete', 'False', 'BuildFailed', build.status.message);
    this.cluster.update(build.uid, build);
    build.recordEvent('Warning', 'BuildFailed', build.status.message);
    this.eventBus?.emit('build:failed', {
      build: build.metadata.name,
      buildConfig: buildConfig?.metadata.name || '',
      namespace: build.metadata.namespace,
      message: build.status.message,
      resource: build,
    });
  }

  /**
   * ImageChange trigger: roll out Deployments that consume the updated
   * ImageStreamTag (either through `spec.triggers` or a container image that
   * references the internal registry).
   */
  _triggerImageChangeRollout(namespace, imageStreamName, tag, dockerImageReference) {
    const reference = dockerImageReference || `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStreamName}:${tag}`;
    for (const deployment of this.cluster.getByKindAndNamespace('Deployment', namespace)) {
      const containers = deployment.spec?.template?.spec?.containers || [];
      const triggers = deployment.spec?.triggers || [];
      const triggerReferencesTag = triggers.some((trigger) => {
        if (trigger.type !== 'ImageChange') return false;
        const params = trigger.imageChangeParams || trigger.imageChange || {};
        return params.from?.name === `${imageStreamName}:${tag}`;
      });
      const anyContainerReferencesTag = containers.some((container) => {
        const image = String(container.image || '');
        return image.includes(`${namespace}/${imageStreamName}:`) || image.endsWith(`/${imageStreamName}:${tag}`) || image === `${imageStreamName}:${tag}`;
      });
      if (!triggerReferencesTag && !anyContainerReferencesTag) continue;

      // Update containers that point at the image stream tag.
      const desiredImage = anyContainerReferencesTag ? reference : null;
      if (desiredImage) {
        for (const container of containers) {
          if (String(container.image || '').includes(`${namespace}/${imageStreamName}:`) || String(container.image || '').endsWith(`/${imageStreamName}:${tag}`)) {
            container.image = desiredImage;
          }
        }
      }
      deployment.metadata.generation++;
      deployment._rollout = { reason: `image change ${imageStreamName}:${tag}`, startedAt: Date.now(), remaining: null };
      deployment.setCondition('Progressing', 'True', 'ReplicaSetUpdated', `image change ${imageStreamName}:${tag}`);
      this.cluster.update(deployment.uid, deployment);
      this.eventBus?.emit('rollout:triggered', {
        kind: 'Deployment',
        name: deployment.metadata.name,
        namespace,
        imageStreamTag: `${imageStreamName}:${tag}`,
        resource: deployment,
      });
    }
  }

  /** ImageStream controller: keep `.status.dockerImageRepository`/tags coherent. */
  _tickImageStreams(dt) {
    for (const imageStream of this.cluster.getByKind('ImageStream')) {
      const namespace = imageStream.metadata.namespace;
      imageStream.status = imageStream.status || {};
      imageStream.status.dockerImageRepository = imageStream.status.dockerImageRepository
        || `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStream.metadata.name}`;
      imageStream.status.publicDockerImageRepository = `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStream.metadata.name}`;
      imageStream.status.tags = imageStream.status.tags || [];

      for (const specTag of imageStream.spec.tags || []) {
        const tagName = specTag.name || 'latest';
        let statusTag = imageStream.status.tags.find((entry) => entry.tag === tagName);
        if (!statusTag) {
          statusTag = { tag: tagName, items: [] };
          imageStream.status.tags.push(statusTag);
        }
        if (statusTag.items.length === 0 && specTag.from?.kind === 'DockerImage' && specTag.from.name) {
          statusTag.items = [{
            dockerImageReference: specTag.from.name,
            image: `sha256:${this.cluster._fakeDigest(specTag.from.name)}`,
            generation: 1,
            created: new Date().toISOString(),
          }];
        }
      }
    }
  }

  // ── OpenShift: OLM subscriptions ───────────────────────────────────────

  _tickSubscriptions(dt) {
    for (const subscription of this.cluster.getByKind('Subscription')) {
      if (subscription.metadata.deletionTimestamp) continue;
      const packageName = subscription.spec?.packageName || subscription.metadata.name;

      if (subscription.spec?.failure === true || subscription.spec?.installFailed === true) {
        if (subscription.status.phase !== 'Failed') {
          subscription.status.phase = 'Failed';
          subscription.status.reason = 'InstallFailed';
          subscription.status.message = subscription.spec.failureMessage || `operator ${packageName} failed to install`;
          subscription.setCondition('InstallPlanComplete', 'False', 'InstallFailed', subscription.status.message);
          this.cluster.update(subscription.uid, subscription);
          this.eventBus?.emit('operator:failed', { name: subscription.metadata.name, namespace: subscription.metadata.namespace, packageName });
        }
        continue;
      }

      const phase = subscription.status.phase;
      if (phase === 'Failed') {
        // Failure flag cleared → retry the install.
        subscription.status.phase = 'Installing';
        subscription._installElapsed = 0;
        this.cluster.update(subscription.uid, subscription);
        continue;
      }
      if (phase === 'Succeeded') continue;

      if (phase !== 'Installing') {
        subscription.status.phase = 'Installing';
        subscription._installElapsed = 0;
        subscription.status.reason = 'Installing';
        subscription.status.message = `installing operator ${packageName}`;
        this.cluster.update(subscription.uid, subscription);
        this.eventBus?.emit('operator:installing', { name: subscription.metadata.name, namespace: subscription.metadata.namespace, packageName });
        continue;
      }

      subscription._installElapsed = (subscription._installElapsed || 0) + dt;
      if (subscription._installElapsed < SUBSCRIPTION_INSTALL_SECONDS) continue;

      const installedCSV = `${packageName}.v1.0.0`;
      subscription.status.phase = 'Succeeded';
      subscription.status.installedCSV = installedCSV;
      subscription.status.currentCSV = installedCSV;
      subscription.status.reason = 'InstallSucceeded';
      subscription.status.message = `operator ${packageName} installed successfully`;
      subscription.status.installPlanRef = { name: `install-${packageName}`, namespace: subscription.metadata.namespace };
      subscription.status.installPlanComplete = true;
      subscription.setCondition('InstallPlanComplete', 'True', 'InstallSucceeded');
      this.cluster.update(subscription.uid, subscription);
      this.eventBus?.emit('operator:installed', {
        name: subscription.metadata.name,
        namespace: subscription.metadata.namespace,
        packageName,
        csv: installedCSV,
        channel: subscription.spec?.channel,
        source: subscription.spec?.source,
        resource: subscription,
      });
    }
  }

  /** @param {object} subscription @returns {string} */
  _operatorVersionForSubscription(subscription) {
    return `${subscription.spec?.packageName || subscription.metadata.name}.v1.0.0`;
  }

  // ── OpenShift: SCC admission ───────────────────────────────────────────

  _tickSCC(dt) {
    const dirty = this._sccDirty;
    this._sccDirty = false;

    for (const pod of this.cluster.getByKind('Pod')) {
      if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Terminating') continue;
      const denied = pod.metadata.annotations['openshiftgames/scc-denied'] === 'true';

      if (denied) {
        if (!dirty) continue;
        const resolution = this._resolvePodSCC(pod);
        if (resolution.allowed) {
          this._revivePod(pod, 'openshiftgames/scc-denied');
          pod.setAnnotation('openshift.io/scc', resolution.scc?.metadata.name || 'restricted-v2');
          pod.recordEvent('Normal', 'SCCAdmitted', `Security context constraint ${resolution.scc?.metadata.name || 'restricted-v2'} admitted the pod`);
          this.cluster.update(pod.uid, pod);
        }
        continue;
      }

      if (pod._sccEvaluated) continue;
      pod._sccEvaluated = true;
      const resolution = this._resolvePodSCC(pod);
      if (resolution.allowed) {
        pod.setAnnotation('openshift.io/scc', resolution.scc?.metadata.name || 'restricted-v2');
        continue;
      }

      const podSpec = pod.spec || {};
      const container = podSpec.containers?.[0] || {};
      const message = 'unable to validate against any security context constraint';
      pod.setAnnotation('openshiftgames/scc-denied', 'true');
      pod.setAnnotation('openshiftgames/denied-reason', `pods "${pod.metadata.name}" is forbidden: ${message}`);
      pod.status.phase = 'Failed';
      pod.setCondition('Ready', 'False', 'SCCDenied', message);
      pod.recordEvent('Warning', 'FailedCreate', `Error creating: pods "${pod.metadata.name}" is forbidden: ${message}`);
      this.cluster.update(pod.uid, pod);
      this.eventBus?.emit('scc:denied', {
        pod: pod.metadata.name,
        namespace: pod.metadata.namespace,
        container: container.name || 'main',
        serviceAccount: podSpec.serviceAccountName || 'default',
        securityContext: container.securityContext || podSpec.securityContext || null,
        message,
        resource: pod,
      });
    }
  }

  /**
   * Resolve the SCC for a pod. Falls back to treating pods without any bound
   * SCC as restricted (helps levels that create resources before a project is
   * fully seeded) unless they request elevated capabilities.
   */
  _resolvePodSCC(pod) {
    const resolution = this.cluster.resolveSCCForPod(pod);
    if (resolution.candidates && resolution.candidates.length > 0) return resolution;

    // No SCC bound to the service account at all (e.g. custom namespace).
    const request = podSecurityRequest(pod.spec || {});
    const elevated = request.privileged || request.hostNetwork || request.hostPID || request.hostIPC || request.hostPath
      || request.hostPorts.length > 0 || request.runAsUsers.includes(0);
    if (elevated) {
      return { ...resolution, allowed: false };
    }
    const restricted = this.cluster.getSCC('restricted-v2') || this.cluster.getSCCs()[0] || null;
    if (restricted && this.cluster.sccAllowsPod(restricted, pod.spec || {})) {
      return { allowed: true, scc: restricted, candidates: [restricted] };
    }
    return resolution;
  }

  /** Whether a Pod is blocked by SCC/LimitRange/quota admission. */
  _isPodBlocked(pod) {
    const annotations = pod.metadata.annotations || {};
    return annotations['openshiftgames/scc-denied'] === 'true'
      || annotations['openshiftgames/limitrange-denied'] === 'true'
      || annotations['openshiftgames/quota-denied'] === 'true';
  }

  /** Put a previously denied pod back into Pending so controllers retry it. */
  _revivePod(pod, annotationKey) {
    delete pod.metadata.annotations[annotationKey];
    delete pod.metadata.annotations['openshiftgames/denied-reason'];
    pod._sccEvaluated = false;
    pod._limitsEvaluated = false;
    pod._quotaEvaluated = false;
    delete pod.spec.nodeName;
    delete pod.status.podIP;
    delete pod.status.hostIP;
    pod.status.containerStatuses = [];
    pod.status.phase = 'Pending';
    this.cluster.update(pod.uid, pod);
    return pod;
  }

  // ── OpenShift: LimitRange enforcement ──────────────────────────────────

  _tickLimitRanges(dt) {
    for (const pod of this.cluster.getByKind('Pod')) {
      if (pod.status.phase === 'Succeeded') continue;
      const denied = pod.metadata.annotations['openshiftgames/limitrange-denied'] === 'true';
      if (denied) {
        const violations = this.cluster.checkLimitRange(pod.metadata.namespace, pod.spec || {}).violations;
        if (violations.length === 0) {
          this._revivePod(pod, 'openshiftgames/limitrange-denied');
          pod.recordEvent('Normal', 'LimitRangeAdmitted', 'Pod now satisfies the project LimitRange');
          this.cluster.update(pod.uid, pod);
        }
        continue;
      }
      if (pod._limitsEvaluated) continue;
      pod._limitsEvaluated = true;

      const namespace = pod.metadata.namespace;
      const limitRanges = this.cluster.getLimitRanges(namespace);
      if (limitRanges.length === 0) continue;

      const defaults = this.cluster.applyLimitRangeDefaults(namespace, pod.spec);
      let changed = defaults.applied;
      const check = this.cluster.checkLimitRange(namespace, pod.spec);
      if (!check.allowed) {
        pod.setAnnotation('openshiftgames/limitrange-denied', 'true');
        pod.setAnnotation('openshiftgames/denied-reason', `pods "${pod.metadata.name}" is forbidden: ${check.violations[0]}`);
        pod.status.phase = 'Failed';
        pod.setCondition('Ready', 'False', 'LimitRangeViolation', check.violations[0]);
        pod.recordEvent('Warning', 'FailedCreate', `Error creating: pods "${pod.metadata.name}" is forbidden: ${check.violations[0]}`);
        this.cluster.update(pod.uid, pod);
        this.eventBus?.emit('limitrange:violation', {
          pod: pod.metadata.name,
          namespace,
          violations: check.violations,
          limitRange: limitRanges[0]?.metadata?.name,
          resource: pod,
        });
        continue;
      }
      if (changed) {
        pod.metadata.generation++;
        this.cluster.update(pod.uid, pod);
      }
    }
  }

  // ── OpenShift: quotas (ResourceQuota + ClusterResourceQuota) ───────────

  _tickQuotaEnforcement(dt) {
    // Admit/reject pods against ResourceQuota + ClusterResourceQuota.
    for (const pod of this.cluster.getByKind('Pod')) {
      if (pod.status.phase === 'Succeeded') continue;
      const annotations = pod.metadata.annotations;
      if (annotations['openshiftgames/quota-denied'] === 'true') {
        const requests = this._getPodResourceRequests(pod);
        if (this.cluster.checkQuota(pod.metadata.namespace, requests.cpu, requests.memory).allowed) {
          this._revivePod(pod, 'openshiftgames/quota-denied');
          pod.recordEvent('Normal', 'QuotaAdmitted', 'Pod now fits within the project quota');
          this.cluster.update(pod.uid, pod);
        }
        continue;
      }
      if (pod._quotaEvaluated) continue;
      pod._quotaEvaluated = true;
      const requests = this._getPodResourceRequests(pod);
      const result = this.cluster.checkQuota(pod.metadata.namespace, requests.cpu, requests.memory);
      if (result.allowed) {
        pod.setAnnotation('openshiftgames/quota-admitted', 'true');
        this.cluster.update(pod.uid, pod);
        continue;
      }

      pod.setAnnotation('openshiftgames/quota-denied', 'true');
      pod.setAnnotation('openshiftgames/denied-reason', `pods "${pod.metadata.name}" is forbidden: ${result.violations[0] || 'exceeded quota'}`);
      pod.status.phase = 'Failed';
      pod.setCondition('Ready', 'False', 'QuotaExceeded', result.violations[0] || 'exceeded quota');
      pod.recordEvent('Warning', 'FailedCreate', `Error creating: pods "${pod.metadata.name}" is forbidden: ${result.violations[0] || 'exceeded quota'}`);
      this.cluster.update(pod.uid, pod);
      this.eventBus?.emit('quota:exceeded', {
        namespace: pod.metadata.namespace,
        pod: pod.metadata.name,
        violations: result.violations,
        usage: result.usage,
        quotaName: result.quotaName,
      });
    }

    // Legacy quota map + current violations (kept for backwards compatibility).
    const violating = new Set();
    for (const [namespace] of this.cluster.resourceQuotas) {
      const result = this.cluster.checkQuota(namespace, 0, 0);
      if (!result.allowed) {
        violating.add(namespace);
        if (!this._quotaViolationNamespaces.has(namespace)) {
          this.eventBus?.emit('quota:exceeded', { namespace, violations: result.violations, usage: result.usage });
        }
      }
    }
    this._quotaViolationNamespaces = violating;
  }

  // ── OpenShift: OAuth rollout + cluster operators ───────────────────────

  _scheduleOAuthRollout() {
    const provider = this.cluster.getAuthProviderConfig();
    this._oauthPending = { remaining: OAUTH_ROLLOUT_SECONDS, provider };
  }

  _tickOAuth(dt) {
    if (!this._oauthPending) return;
    this._oauthPending.remaining -= dt;
    if (this._oauthPending.remaining > 0) return;

    const provider = this._oauthPending.provider;
    this._oauthPending = null;
    const oauth = this.cluster.getOAuth();
    if (oauth) {
      oauth.status = oauth.status || {};
      oauth.status.ready = !!provider;
      oauth.status.lastRollout = new Date().toISOString();
      oauth.status.observedGeneration = oauth.metadata.generation;
      oauth.status.rollingOut = false;
      oauth.status.conditions = [{
        type: provider ? 'Available' : 'Progressing',
        status: 'True',
        reason: provider ? 'IdentityProviderReady' : 'NoIdentityProviders',
        message: provider ? `identity provider ${provider.name} is ready` : 'no identity providers configured',
        lastTransitionTime: new Date().toISOString(),
      }];
      oauth._bumpResourceVersion();
    }
    this.eventBus?.emit('auth:provider-ready', {
      provider,
      namespace: 'openshift-config',
      resource: oauth,
    });
  }

  _tickClusterHealth(dt) {
    const version = OPENSHIFT_VERSION;
    for (const operator of this.cluster.getClusterOperators()) {
      if (!operator.status.conditions || operator.status.conditions.length === 0) {
        operator.setCondition('Available', 'True', 'AsExpected', 'All is well');
        operator.setCondition('Progressing', 'False', 'AsExpected', 'All is well');
        operator.setCondition('Degraded', 'False', 'AsExpected', 'All is well');
      }
      operator.status.versions = operator.status.versions && operator.status.versions.length > 0
        ? operator.status.versions.map((entry) => ({ ...entry, version }))
        : [{ name: 'operator', version }];
      if (operator._forceDegraded) {
        operator.setCondition('Degraded', 'True', 'Degraded', operator._degradedMessage || 'component is degraded');
      }
      if (operator._forceUnavailable) {
        operator.setCondition('Available', 'False', 'Unavailable', operator._unavailableMessage || 'component is unavailable');
      }
      operator.status.observedGeneration = operator.metadata.generation;
    }

    const clusterVersion = this.cluster.getClusterVersion();
    if (clusterVersion) {
      clusterVersion.status = clusterVersion.status || {};
      clusterVersion.status.desired = {
        version: clusterVersion.spec?.desiredUpdate?.version || version,
        channel: clusterVersion.spec?.channel || OPENSHIFT_CHANNEL,
      };
      clusterVersion.status.version = clusterVersion.status.desired.version;
      clusterVersion.status.observedGeneration = clusterVersion.metadata.generation;
    }
  }

  // ── Chaos / pod factory / metrics ──────────────────────────────────────

  _tickChaos(dt) {
    if (this.chaosConfig.podKillRate > 0) {
      for (const pod of this.cluster.getByKind('Pod').filter((entry) => entry.status.phase === 'Running')) {
        if (Math.random() < this.chaosConfig.podKillRate * dt) {
          pod.setPhase('Failed');
          pod.recordEvent('Warning', 'ChaosKilled', 'Pod killed by chaos engineering');
          this.eventBus?.emit('chaos:podkill', { pod: pod.name, namespace: pod.namespace });
        }
      }
    }
    if (this.chaosConfig.nodeFailRate > 0) {
      for (const node of this.cluster.getByKind('Node').filter((entry) => entry.isConditionTrue('Ready'))) {
        if (Math.random() < this.chaosConfig.nodeFailRate * dt) {
          node.setPhase('NotReady');
          node.setCondition('Ready', 'False', 'ChaosNodeFailure');
          node.recordEvent('Warning', 'ChaosNodeDown', 'Node failed due to chaos injection');
          const pods = this.cluster.getByKind('Pod').filter(
            (pod) => pod.spec.nodeName === node.name && pod.status.phase === 'Running'
          );
          for (const pod of pods) {
            pod.setPhase('Failed');
            pod.recordEvent('Warning', 'NodeLost', `Node ${node.name} became unreachable`);
          }
          this.eventBus?.emit('chaos:nodefailure', { node: node.name, podsEvicted: pods.length });
        }
      }
    }
    if (this.chaosConfig.cpuStress > 0 || this.chaosConfig.memoryStress > 0) {
      for (const pod of this.cluster.getByKind('Pod').filter((entry) => entry.status.phase === 'Running' && entry.status.containerStatuses)) {
        for (const status of pod.status.containerStatuses) {
          if (!status.state.running) continue;
          if (this.chaosConfig.cpuStress > 0) status.resources.cpu += status.resources.cpuRequest * this.chaosConfig.cpuStress;
          if (this.chaosConfig.memoryStress > 0) status.resources.memory += status.resources.memoryRequest * this.chaosConfig.memoryStress;
        }
      }
    }
  }

  _createPodForWorkload(parent, templateSource, nameOverride) {
    // Do not spin up replacement pods while an admission-denied pod exists.
    if (this.cluster.getChildren(parent.uid).some((child) => child.kind === 'Pod' && this._isPodBlocked(child))) {
      return null;
    }

    const podName = nameOverride || `${parent.name}-${this._randomSuffix()}`;
    const template = templateSource.spec.template || {};
    const podSpec = deepClone(template.spec || {});
    podSpec.containers = podSpec.containers || [{
      name: 'main',
      image: 'app:latest',
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
    }];
    const templateLabels = template.metadata?.labels || templateSource.metadata.labels || {};

    const pod = this.cluster.addResource({
      kind: 'Pod',
      metadata: {
        name: podName,
        namespace: parent.metadata.namespace,
        labels: { ...templateLabels, 'pod-template-hash': this._randomSuffix() },
      },
      spec: podSpec,
      status: { phase: 'Pending' },
    });
    if (!pod) return null;
    this.cluster.addRelationship(parent.uid, pod.uid);
    return pod;
  }

  _recordMetrics() {
    const stats = this.cluster.getClusterStats();
    this.metricsHistory.set(this.tickCount, {
      tick: this.tickCount,
      timestamp: Date.now(),
      cpu: stats.cpu,
      memory: stats.memory,
      pods: stats.pods,
      nodes: stats.nodes,
    });
    if (this.metricsHistory.size > this.maxMetricsHistory) {
      this.metricsHistory.delete(this.metricsHistory.keys().next().value);
    }
  }

  getMetricsHistory(count) {
    const entries = Array.from(this.metricsHistory.values());
    return count ? entries.slice(-count) : entries;
  }

  getMetricsSummary() {
    const entries = Array.from(this.metricsHistory.values());
    if (entries.length === 0) return null;
    const cpuValues = entries.map((entry) => entry.cpu.percent);
    const memValues = entries.map((entry) => entry.memory.percent);
    return {
      cpu: {
        current: cpuValues[cpuValues.length - 1],
        avg: Math.round(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length),
        max: Math.max(...cpuValues),
        min: Math.min(...cpuValues),
      },
      memory: {
        current: memValues[memValues.length - 1],
        avg: Math.round(memValues.reduce((a, b) => a + b, 0) / memValues.length),
        max: Math.max(...memValues),
        min: Math.min(...memValues),
      },
      tickCount: this.tickCount,
      historyLength: entries.length,
    };
  }

  setChaosConfig(config) {
    Object.assign(this.chaosConfig, config);
    this.enableChaos = Object.values(this.chaosConfig).some((value) => value > 0 || value === true);
  }

  setTickRate(rate) {
    this.tickRate = Math.max(0.1, Math.min(10, rate));
  }

  /**
   * Adjust the simulated build failure probability (`spec.forFailure` still
   * forces a failure; set to 0 for deterministic test runs).
   * @param {number} rate 0..1
   */
  setBuildFailureRate(rate) {
    this.buildFailureRate = Math.max(0, Math.min(1, Number(rate) || 0));
  }

  reset() {
    this.tickCount = 0;
    this.schedulerQueue = [];
    this.pendingScaleDecisions.clear();
    this.metricsHistory.clear();
    this.enableChaos = false;
    this.chaosConfig = { podKillRate: 0, nodeFailRate: 0, networkPartition: false, cpuStress: 0, memoryStress: 0 };
    this._oauthPending = null;
    this._sccDirty = false;
    this._quotaViolationNamespaces = new Set();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _generatePodIP() {
    return `10.244.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
  }

  _generateExternalIP() {
    return `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
  }

  _randomSuffix() {
    return Math.random().toString(36).substring(2, 7);
  }

  /** FNV-1a hash used for deterministic pseudo-random behaviour. */
  _hashString(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }
}

export default SimulationTick;
