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
/** Real nodes reserve kube/system resources, so allocatable < capacity. */
const RESERVED_CPU_MILLICORES = 250;
const RESERVED_MEMORY_MIB = 1024;

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
    /** Accumulated simulated time in seconds (controller clock). */
    this.gameSeconds = 0;
    this.tickRate = 1;
    this.schedulerQueue = [];
    this.pendingScaleDecisions = new Map();
    this.hpaEvalInterval = 15;
    this.probeInterval = 5;
    this.cronCheckInterval = 10;
    this.metricsHistory = new Map();
    this.maxMetricsHistory = 60;
    /**
     * Difficulty dial written by GameEngine (`0.002 * multiplier`). Kept for
     * backwards compatibility, but the controllers now interpret it as a
     * per-second failure probability derived from the "normal" reference so
     * that healthy pods do not crash every few seconds (SIM-027).
     */
    this.randomFailureRate = 0.002;
    this.randomFailureRateReference = 0.002;
    this.randomFailureRatePerSecond = 0.0003;
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
    this.gameSeconds = (this.gameSeconds || 0) + dt;

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
      // Player-visible node status must agree with the node spec: capacity from
      // spec.cpu/spec.memory (modes seed 16 / 32Gi nodes).
      if (typeof node.syncCapacityFromSpec === 'function') node.syncCapacityFromSpec();
      const alloc = this.cluster.getNodeAllocatable(node.name);
      if (!alloc) continue;

      // Real Node.status.allocatable is a static property (capacity minus
      // kube/system reservation) and must not shrink as pods are scheduled.
      // Live consumption belongs in status.usage (SIM-023).
      node.status.allocatable = {
        ...(node.status.allocatable || {}),
        cpu: `${Math.max(0, Math.round(alloc.cpu.capacity - RESERVED_CPU_MILLICORES))}m`,
        memory: `${Math.max(0, Math.round(alloc.memory.capacity - RESERVED_MEMORY_MIB))}Mi`,
        pods: String(node.status.allocatable?.pods || node.status.capacity?.pods || '110'),
      };
      node.status.usage = {
        cpu: alloc.cpu.used,
        memory: alloc.memory.used,
        cpuPercent: alloc.cpu.capacity > 0 ? Math.round((alloc.cpu.used / alloc.cpu.capacity) * 100) : 0,
        memoryPercent: alloc.memory.capacity > 0 ? Math.round((alloc.memory.used / alloc.memory.capacity) * 100) : 0,
      };

      const isReady = node.status.phase !== 'NotReady' && node.status.phase !== 'Unknown';
      node.setCondition('Ready', isReady ? 'True' : 'False', isReady ? 'KubeletReady' : 'KubeletNotReady');
      const freeMemory = alloc.memory.capacity - alloc.memory.used;
      const memoryEvictionThreshold = Math.min(RESERVED_MEMORY_MIB, Math.max(100, alloc.memory.capacity * 0.1));
      node.setCondition(
        'MemoryPressure',
        freeMemory < memoryEvictionThreshold ? 'True' : 'False',
        freeMemory < memoryEvictionThreshold ? 'KubeletHasInsufficientMemory' : 'KubeletHasSufficientMemory'
      );
      // PID exhaustion is not modelled; never derive it from CPU pressure.
      node.setCondition('PIDPressure', 'False', 'KubeletHasSufficientPIDs');
      if (isReady) node.setCondition('DiskPressure', 'False', 'KubeletHasNoDiskPressure');
    }
  }

  _tickPodScheduling(dt) {
    const pods = this.cluster.getByKind('Pod');
    const nodes = this.cluster.getByKind('Node');

    // 1) Unbound Pending pods: normal scheduler path.
    const pendingPods = pods.filter(
      (pod) => pod.status.phase === 'Pending' && !pod.spec.nodeName && !pod.isDeleting && !this._isPodBlocked(pod)
    );
    for (const pod of pendingPods) {
      const node = this._findBestNode(pod, nodes);
      if (node) {
        this._schedulePodOnNode(pod, node);
      } else {
        const message = this._schedulingFailureMessage(pod, nodes);
        pod.setCondition('PodScheduled', 'False', 'Unschedulable', message);
        pod.recordEvent('Warning', 'FailedScheduling', message);
      }
    }

    // 2) Already-bound Pending pods (DaemonSet pods, manifests with
    // spec.nodeName): they skip the scheduler but must still start. Cordoned
    // nodes keep running already-bound pods; only new placement is blocked.
    for (const pod of pods) {
      if (pod.status.phase !== 'Pending' || !pod.spec.nodeName || pod.isDeleting || this._isPodBlocked(pod)) continue;
      const node = nodes.find((entry) => entry.metadata.name === pod.spec.nodeName);
      if (!node) {
        const message = `node "${pod.spec.nodeName}" not found`;
        pod.setCondition('PodScheduled', 'False', 'Unschedulable', message);
        pod.recordEvent('Warning', 'FailedScheduling', message);
        continue;
      }
      if (!node.isConditionTrue('Ready') || node.status.phase === 'Terminating') {
        const message = `node "${node.metadata.name}" is not ready`;
        pod.setCondition('PodScheduled', 'False', 'Unschedulable', message);
        pod.recordEvent('Warning', 'FailedScheduling', message);
        continue;
      }
      this._schedulePodOnNode(pod, node);
    }
  }

  /** Bind a Pending pod to a node and start it (shared by scheduler and DS). */
  _schedulePodOnNode(pod, node) {
    pod.spec.nodeName = node.metadata.name;
    pod.status.phase = 'Running';
    pod.status.startTime = pod.status.startTime || new Date().toISOString();
    pod.status.hostIP = node.status.addresses?.[0]?.address || '10.0.0.1';
    pod.status.podIP = pod.status.podIP || this._generatePodIP();
    pod.setCondition('PodScheduled', 'True', 'Scheduled', `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`);
    pod.setCondition('Initialized', 'True', 'PodInitialized');
    pod.setCondition('Ready', 'False', 'ContainersNotReady');
    this._trackRescheduledPod(pod);
    pod.recordEvent('Normal', 'Scheduled', `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`);
    this._initContainerStatuses(pod);
    this.cluster.update(pod.uid, pod);
    return pod;
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

  /**
   * Pick the best node for a pod, enforcing cordon, taints/tolerations,
   * nodeSelector, required node affinity, hostPort conflicts and the pod limit.
   * @param {object} pod
   * @param {object[]} [nodes]
   * @returns {object|null}
   */
  _findBestNode(pod, nodes = this.cluster.getByKind('Node')) {
    const requested = this._getPodResourceRequests(pod);
    const nodeSelector = pod.spec.nodeSelector || {};
    const requiredAffinity = pod.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
    let bestNode = null;
    let bestScore = -Infinity;

    for (const node of nodes) {
      if (this._nodeUnschedulableReason(node, pod, requested)) continue;
      const available = this._nodeAvailableForScheduling(node);
      if (!available) continue;

      const cpuScore = available.cpu / available.capacityCpu;
      const memScore = available.memory / available.capacityMemory;
      const podCountPenalty = available.podCount * 0.05;
      let score = (cpuScore + memScore) / 2 - podCountPenalty;

      // Untolerated PreferNoSchedule taints bias the scheduler away softly.
      const tolerations = pod.spec.tolerations || [];
      for (const taint of node.spec.taints || []) {
        if (taint.effect !== 'PreferNoSchedule') continue;
        if (!tolerations.some((toleration) => this._toleratesTaint(toleration, taint))) score -= 0.1;
      }

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

  /** @returns {string|null} why the node cannot host the pod (null = fits). */
  _nodeUnschedulableReason(node, pod, requested = this._getPodResourceRequests(pod)) {
    if (node.status.phase === 'Terminating') return 'node(s) were terminating';
    if (!node.isConditionTrue('Ready')) return 'node(s) were not ready';
    if (node.spec.unschedulable === true || node.isCordon) return 'node(s) were unschedulable';
    if (!node.matchesSelector(pod.spec.nodeSelector || {})) return "node(s) didn't match Pod's node selector";
    const requiredAffinity = pod.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
    if (requiredAffinity && !this._nodeMatchesRequiredAffinity(node, requiredAffinity)) return "node(s) didn't match Pod's node affinity";
    const taint = this._firstUntoleratedNoScheduleTaint(pod, node);
    if (taint) return `node(s) had untolerated taint {${taint.key}: ${taint.value ?? ''}}`;
    const available = this._nodeAvailableForScheduling(node);
    if (!available) return 'node(s) were unschedulable';
    const podLimit = parseInt(node.status.allocatable?.pods || node.status.capacity?.pods || '110', 10);
    if (Number.isFinite(podLimit) && available.podCount >= podLimit) return 'Too many pods';
    if (this._hasHostPortConflict(node, pod)) return "node(s) didn't have free ports for the requested pod ports";
    if (available.cpu < requested.cpu) return 'Insufficient cpu';
    if (available.memory < requested.memory) return 'Insufficient memory';
    return null;
  }

  /**
   * Scheduler-style FailedScheduling message summarising why every node was
   * rejected for a pod.
   * @returns {string}
   */
  _schedulingFailureMessage(pod, nodes = this.cluster.getByKind('Node')) {
    const total = nodes.length;
    if (total === 0) return 'no nodes available to schedule pod';
    const requested = this._getPodResourceRequests(pod);
    const reasons = new Map();
    for (const node of nodes) {
      const reason = this._nodeUnschedulableReason(node, pod, requested);
      if (!reason) continue;
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
    const detail = Array.from(reasons.entries())
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ');
    return detail ? `0/${total} nodes are available: ${detail}.` : `0/${total} nodes are available: no node matched the pod requirements.`;
  }

  /** Available resources on a node for scheduling (static allocatable - usage). */
  _nodeAvailableForScheduling(node) {
    const alloc = this.cluster.getNodeAllocatable(node.metadata.name);
    if (!alloc) return null;
    const capacityCpu = alloc.cpu.capacity - Math.min(RESERVED_CPU_MILLICORES, alloc.cpu.capacity);
    const capacityMemory = alloc.memory.capacity - Math.min(RESERVED_MEMORY_MIB, alloc.memory.capacity);
    return {
      cpu: capacityCpu - alloc.cpu.used,
      memory: capacityMemory - alloc.memory.used,
      podCount: alloc.podCount,
      capacityCpu: Math.max(1, capacityCpu),
      capacityMemory: Math.max(1, capacityMemory),
    };
  }

  /** First untolerated NoSchedule/NoExecute taint on the node, if any. */
  _firstUntoleratedNoScheduleTaint(pod, node) {
    const tolerations = pod.spec.tolerations || [];
    for (const taint of node.spec.taints || []) {
      if (taint.effect !== 'NoSchedule' && taint.effect !== 'NoExecute') continue;
      if (!tolerations.some((toleration) => this._toleratesTaint(toleration, taint))) return taint;
    }
    return null;
  }

  /** Does a single toleration tolerate a taint? */
  _toleratesTaint(toleration, taint) {
    if (!toleration || !taint) return false;
    const operator = toleration.operator || 'Equal';
    const effect = toleration.effect || '';
    if (effect && effect !== taint.effect) return false;
    const key = toleration.key || '';
    if (operator === 'Exists') return !key || key === taint.key;
    if (key !== taint.key) return false;
    return String(toleration.value ?? '') === String(taint.value ?? '');
  }

  /** Required node affinity: any nodeSelectorTerm may match. */
  _nodeMatchesRequiredAffinity(node, required) {
    const terms = required?.nodeSelectorTerms || [];
    if (terms.length === 0) return true;
    return terms.some((term) => {
      if (!term || typeof term !== 'object') return false;
      const expressions = term.matchExpressions || [];
      const fields = term.matchFields || [];
      return expressions.every((expression) => this._labelsMatchExpression(node.metadata.labels || {}, expression))
        && fields.every((expression) => this._nodeFieldMatchesExpression(node, expression));
    });
  }

  _labelsMatchExpression(labels, expression) {
    const actual = labels?.[expression.key];
    const values = expression.values || [];
    switch (expression.operator) {
      case 'In':
        return actual !== undefined && values.includes(actual);
      case 'NotIn':
        return actual === undefined || !values.includes(actual);
      case 'Exists':
        return actual !== undefined;
      case 'DoesNotExist':
        return actual === undefined;
      case 'Gt':
        return actual !== undefined && Number(actual) > Number(values[0]);
      case 'Lt':
        return actual !== undefined && Number(actual) < Number(values[0]);
      default:
        return false;
    }
  }

  _nodeFieldMatchesExpression(node, expression) {
    if (expression.key !== 'metadata.name') return false;
    const values = expression.values || [];
    switch (expression.operator) {
      case 'In':
        return values.includes(node.metadata.name);
      case 'NotIn':
        return !values.includes(node.metadata.name);
      default:
        return false;
    }
  }

  /** True when a requested hostPort is already taken on the node. */
  _hasHostPortConflict(node, pod) {
    const used = new Set();
    for (const other of this.cluster.getByKind('Pod')) {
      if (other === pod || other.spec.nodeName !== node.metadata.name) continue;
      if (other.status.phase !== 'Running' && other.status.phase !== 'Pending') continue;
      for (const container of other.spec.containers || []) {
        for (const port of container.ports || []) {
          if (port.hostPort) used.add(`${port.protocol || 'TCP'}:${port.hostPort}`);
        }
      }
    }
    for (const container of pod.spec.containers || []) {
      for (const port of container.ports || []) {
        if (port.hostPort && used.has(`${port.protocol || 'TCP'}:${port.hostPort}`)) return true;
      }
    }
    return false;
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
      const containers = pod.spec.containers || [];
      let allReady = true;
      let anyRunning = false;

      for (let index = 0; index < pod.status.containerStatuses.length; index++) {
        const status = pod.status.containerStatuses[index];
        const container = containers[index] || {};
        if (status.state.waiting) {
          if (status.state.waiting.reason === 'ContainerCreating') {
            status.state = { running: { startedAt: new Date().toISOString() } };
            status.started = true;
            status.ready = false;
            pod.recordEvent('Normal', 'Started', `Started container ${status.name}`);
          } else if (status.state.waiting.reason === 'CrashLoopBackOff') {
            const backoffTime = Math.max(1, Math.min(300, Math.pow(2, status.restartCount) * 10));
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
          // Containers with a readinessProbe are owned by _tickHealthChecks:
          // never auto-ready them here (SIM-019).
          const startupPending = Boolean(container.startupProbe) && !status._startupComplete;
          if (!status.ready && status.started && !container.readinessProbe && !startupPending) {
            status.ready = true;
            pod.recordEvent('Normal', 'Ready', `Container ${status.name} is ready`);
          }
        }
        if (!status.ready) allReady = false;
      }

      const wasReady = pod.isConditionTrue('Ready');
      if (allReady && anyRunning) {
        pod.setCondition('ContainersReady', 'True', 'ContainersReady');
        pod.setCondition('Ready', 'True', 'PodReady');
        if (!wasReady) pod._readyAt = this.gameSeconds;
      } else {
        pod.setCondition('ContainersReady', 'False', 'ContainersNotReady');
        pod.setCondition('Ready', 'False', 'ContainersNotReady');
        if (wasReady) pod._readyAt = undefined;
      }

      if (pod.isDeleting) {
        // terminationGracePeriodSeconds: 0 is valid and means "kill now"
        // (the old `|| 30` treated 0 as unset).
        const rawGrace = pod.spec.terminationGracePeriodSeconds;
        const gracePeriod = typeof rawGrace === 'number' ? rawGrace : 30;
        const deletionTime = new Date(pod.metadata.deletionTimestamp).getTime();
        if (Date.now() - deletionTime > gracePeriod * 1000 * (1 / this.tickRate)) {
          pod.status.phase = 'Succeeded';
          pod.removeFinalizer('kubernetes');
        }
      }
    }
  }

  /** Effective per-second per-container random failure probability (SIM-027). */
  _effectiveFailureRatePerSecond() {
    const rate = Number(this.randomFailureRate);
    if (!(rate > 0)) return 0;
    const reference = Number(this.randomFailureRateReference) || 0.002;
    const base = Number(this.randomFailureRatePerSecond);
    if (!(base > 0)) return 0;
    return base * (rate / reference);
  }

  /**
   * Apply a container failure honouring the pod restart policy. With
   * `restartPolicy: Never` the container stays terminated and the pod becomes
   * `Failed` (a Job pod must fail instead of restarting forever, SIM-011).
   */
  _handleContainerFailure(pod, status, reason, exitCode) {
    const now = new Date().toISOString();
    status.restartCount = (status.restartCount || 0) + 1;
    status.ready = false;
    status.started = false;
    status.lastState = { terminated: { exitCode, reason, finishedAt: now } };
    const restartPolicy = pod.spec.restartPolicy || 'Always';
    if (restartPolicy === 'Never') {
      status.state = { terminated: { exitCode, reason, finishedAt: now } };
      pod.status.phase = 'Failed';
      pod.setCondition('ContainersReady', 'False', 'ContainersNotReady', `container ${status.name} ${String(reason).toLowerCase()}`);
      pod.setCondition('Ready', 'False', 'ContainersNotReady', `container ${status.name} ${String(reason).toLowerCase()}`);
      pod.recordEvent('Warning', reason === 'OOMKilled' ? 'OOMKilled' : 'Failed', `Container ${status.name} failed (${reason}) with restartPolicy: Never`);
    } else {
      status.state = { waiting: { reason: 'CrashLoopBackOff' } };
      pod.recordEvent('Warning', 'BackOff', `Back-off restarting failed container ${status.name}`);
    }
    return status;
  }

  _tickContainerResources(dt) {
    const failureRate = this._effectiveFailureRatePerSecond();
    const runningPods = this.cluster.getByKind('Pod').filter(
      (pod) => pod.status.phase === 'Running' && pod.status.containerStatuses
    );
    for (const pod of runningPods) {
      for (const status of pod.status.containerStatuses) {
        if (!status.state.running) continue;
        const baseLoad = status.resources.cpuRequest * 0.6;
        const variance = status.resources.cpuRequest * 0.3;
        status.resources.cpu = Math.max(0, baseLoad + (Math.random() - 0.5) * variance);
        // Smoothed CPU sample (HPA/metrics read an averaged window, not a
        // single instantaneous sample; avoids noise-driven rescales).
        status._cpuSmooth = status._cpuSmooth === undefined
          ? status.resources.cpu
          : status._cpuSmooth * 0.9 + status.resources.cpu * 0.1;
        const memBase = status.resources.memoryRequest * 0.7;
        const memGrowth = status.resources.memoryRequest * 0.01 * Math.random();
        // Synthetic memory creeps up but must not exceed a configured limit on
        // its own: a healthy Guaranteed pod should not OOM just because time
        // passed (SIM-027). Chaos/incidents can still push it over the limit.
        const memoryCeiling = status.resources.memoryLimit > 0 ? status.resources.memoryLimit * 0.95 : status.resources.memoryRequest * 2;
        status.resources.memory = Math.min(
          memoryCeiling,
          memBase + memGrowth + (status.resources.memory > memBase ? (status.resources.memory - memBase) * 0.99 : 0)
        );

        if (failureRate > 0 && Math.random() < failureRate * dt) {
          this._handleContainerFailure(pod, status, 'Error', 1);
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

        if (container.livenessProbe && !this._evaluateProbe(container.livenessProbe, status)) {
          this._handleContainerFailure(pod, status, 'LivenessProbeFailure', 137);
          pod.recordEvent('Warning', 'Unhealthy', `Liveness probe failed for container ${status.name}`);
          continue;
        }
        if (container.startupProbe && !status._startupComplete) {
          if (this._evaluateProbe(container.startupProbe, status)) status._startupComplete = true;
          else status.ready = false;
        }
        if (container.readinessProbe) {
          const startupPending = Boolean(container.startupProbe) && !status._startupComplete;
          const ready = !startupPending && this._evaluateProbe(container.readinessProbe, status);
          if (!ready && status.ready) {
            status.ready = false;
            pod.recordEvent('Warning', 'Unhealthy', `Readiness probe failed for container ${status.name}`);
          } else if (ready && !status.ready) {
            status.ready = true;
            pod.recordEvent('Normal', 'Ready', `Container ${status.name} is ready`);
          }
        }
      }

      // Readiness-probe results must reach the Pod Ready condition (and thus
      // Service endpoints) in the same tick (SIM-019).
      const statuses = pod.status.containerStatuses || [];
      const anyRunning = statuses.some((status) => status.state?.running);
      const allReady = statuses.length > 0 && statuses.every((status) => status.ready);
      const wasReady = pod.isConditionTrue('Ready');
      if (anyRunning && allReady) {
        pod.setCondition('ContainersReady', 'True', 'ContainersReady');
        pod.setCondition('Ready', 'True', 'PodReady');
        if (!wasReady) pod._readyAt = this.gameSeconds;
      } else {
        pod.setCondition('ContainersReady', 'False', 'ContainersNotReady');
        pod.setCondition('Ready', 'False', 'ContainersNotReady');
        if (wasReady) pod._readyAt = undefined;
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
          const memoryUsed = status.resources.memory;
          this._handleContainerFailure(pod, status, 'OOMKilled', 137);
          status.lastState = {
            terminated: {
              exitCode: 137,
              reason: 'OOMKilled',
              finishedAt: new Date().toISOString(),
              message: `Container ${status.name} exceeded memory limit (${Math.round(memoryUsed)}Mi > ${status.resources.memoryLimit}Mi)`,
            },
          };
          status.resources.memory = 0;
          status.resources.cpu = 0;
          pod.recordEvent('Warning', 'OOMKilled', `Container ${status.name} was OOM killed`);
          this.eventBus?.emit('incident:oomkill', {
            pod: pod.name,
            namespace: pod.namespace,
            container: status.name,
            memoryUsed,
            memoryLimit: status.resources.memoryLimit,
          });
        }
      }
    }
  }

  // ── Workload controllers ───────────────────────────────────────────────

  _tickDeployments(dt) {
    for (const deploy of this.cluster.getByKind('Deployment')) {
      // OCP 4.22 image-change triggers live in the
      // `image.openshift.io/triggers` annotation (apps/v1 Deployments have no
      // spec.triggers field); apply them before reconciling the rollout.
      this._processDeploymentImageTriggers(deploy);
      this._reconcileDeployment(deploy);
    }
  }

  /**
   * Parse `metadata.annotations['image.openshift.io/triggers']` (a JSON array
   * of {from:{kind,name,namespace}, fieldPath, paused}). Returns [] when the
   * annotation is absent (no image trigger) or malformed.
   */
  _deploymentImageTriggers(deployment) {
    const raw = deployment?.metadata?.annotations?.['image.openshift.io/triggers'];
    if (!raw) return [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Roll a Deployment when an ImageStreamTag referenced by its image-change
   * trigger annotation becomes available/changes. The controller keeps the last
   * observed tag reference on the in-memory resource (`_imageTriggerRefs`); the
   * template mutation then causes a normal ReplicaSet rollout.
   */
  _processDeploymentImageTriggers(deployment) {
    const triggers = this._deploymentImageTriggers(deployment);
    if (triggers.length === 0) return;
    if (!deployment.spec || !deployment.spec.template) return;
    const namespace = deployment.metadata.namespace;
    const containers = deployment.spec?.template?.spec?.containers || [];
    deployment._imageTriggerRefs = deployment._imageTriggerRefs || {};
    let changed = false;
    let changedTag = '';

    for (const trigger of triggers) {
      if (trigger.paused === true) continue;
      const from = trigger.from || trigger.imageChangeParams?.from || trigger.imageChange?.from || {};
      if (from.kind && from.kind !== 'ImageStreamTag') continue;
      const fromName = String(from.name || '');
      if (!fromName) continue;
      const [streamName, tag = 'latest'] = fromName.split(':');
      if (!streamName) continue;
      const streamNamespace = from.namespace || namespace;
      const resolved = this.cluster.resolveImageStreamTag(streamNamespace, streamName, tag);
      const tagItem = resolved.tagEntry?.items?.[0];
      const available = Boolean(resolved.found && tagItem);
      // Real image-change triggers substitute the ImageStreamTag's resolved
      // image (digest-qualified) pull spec, which is what makes an identical
      // `:latest` tag still change the pod template and roll out.
      const desiredImage = available
        ? `${IMAGE_REGISTRY_HOST}/${streamNamespace}/${streamName}@${tagItem.image || tagItem.dockerImageReference || tag}`
        : '';
      const key = `${trigger.fieldPath || fromName}`;
      const previousToken = deployment._imageTriggerRefs[key];
      const token = available
        ? `${tagItem.image || ''}|${resolved.dockerImageReference || ''}|${resolved.tagEntry?.updated || ''}`
        : '';
      deployment._imageTriggerRefs[key] = token;
      if (!available) continue;

      const fieldMatch = String(trigger.fieldPath || '').match(/containers\[(\d+)\].image/);
      const targets = [];
      if (fieldMatch) {
        const container = containers[Number(fieldMatch[1])];
        if (container) targets.push(container);
      }
      for (const name of trigger.imageChangeParams?.containerNames || trigger.containerNames || []) {
        const container = containers.find((entry) => entry.name === name);
        if (container && !targets.includes(container)) targets.push(container);
      }
      const effectiveTargets = targets.length > 0 ? targets : containers;
      const firstObservation = previousToken === undefined;
      const tokenChanged = !firstObservation && previousToken !== token;
      const imageDiffers = effectiveTargets.some((container) => container.image !== desiredImage);
      // Apply on the first observation only if the template still points
      // somewhere else; afterwards only on tag changes.
      if (!tokenChanged && !(firstObservation && imageDiffers)) continue;
      let appliedImage = false;
      for (const container of effectiveTargets) {
        if (container.image === desiredImage) continue;
        container.image = desiredImage;
        appliedImage = true;
      }
      if (tokenChanged && !appliedImage) {
        // The resolved pull spec is unchanged (same tag) but the tag now points
        // at a different image: record the new image identity on the pod
        // template, exactly what makes the real trigger controller roll out.
        deployment.spec.template.metadata = deployment.spec.template.metadata || {};
        deployment.spec.template.metadata.annotations = deployment.spec.template.metadata.annotations || {};
        deployment.spec.template.metadata.annotations['openshiftgames/image-trigger'] = `${streamName}:${tag}@${token}`;
      }
      changed = true;
      changedTag = `${streamName}:${tag}`;
    }

    if (!changed) return;
    deployment.metadata.generation = (Number(deployment.metadata.generation) || 1) + 1;
    deployment.setCondition('Progressing', 'True', 'ReplicaSetUpdated', changedTag ? `image change ${changedTag}` : 'image change');
    this.cluster.update(deployment.uid, deployment);
    this.eventBus?.emit('rollout:triggered', {
      kind: 'Deployment',
      name: deployment.metadata.name,
      namespace,
      imageStreamTag: changedTag,
      resource: deployment,
    });
  }

  /**
   * Deployment controller: template changes create a new ReplicaSet named
   * `<deploy>-<pod-template-hash>`; old ReplicaSets are scaled to zero and kept
   * for rollback up to revisionHistoryLimit (SIM-004/SIM-007/SIM-008).
   */
  _reconcileDeployment(deploy) {
    const namespace = deploy.metadata.namespace;
    const desiredReplicas = Math.max(0, Number(deploy.spec.replicas ?? 1) || 0);
    const template = deepClone(deploy.spec.template || { spec: { containers: [{ name: 'main', image: 'app:latest' }] } });
    const templateHash = this._templateHash(template);
    const selector = deepClone(deploy.spec.selector?.matchLabels || deploy.metadata.labels || {});
    const strategy = deploy.spec.strategy || {};
    const strategyType = strategy.type || 'RollingUpdate';
    const maxSurge = this._resolveStrategyNumber(strategy.rollingUpdate?.maxSurge, desiredReplicas, 'surge');
    const maxUnavailable = this._resolveStrategyNumber(strategy.rollingUpdate?.maxUnavailable, desiredReplicas, 'unavailable');
    const minReadySeconds = Math.max(0, Number(deploy.spec.minReadySeconds) || 0);
    const progressDeadlineSeconds = Math.max(1, Number(deploy.spec.progressDeadlineSeconds) || 600);
    const revisionHistoryLimit = Number.isFinite(Number(deploy.spec.revisionHistoryLimit)) ? Number(deploy.spec.revisionHistoryLimit) : 10;
    const paused = deploy.spec.paused === true;

    // The controller derives everything from ReplicaSet/template state, never
    // from GameEngine's imperative `_rollout` hint.
    delete deploy._rollout;

    const ownedSets = this.cluster.getChildren(deploy.uid).filter((child) => child.kind === 'ReplicaSet');
    let currentSet = ownedSets.find((rs) => rs.metadata.labels?.['pod-template-hash'] === templateHash) || null;
    const oldSets = ownedSets.filter((rs) => rs !== currentSet);
    const templateChanged = !currentSet;
    const status = { desiredReplicas, minReadySeconds, maxUnavailable, maxSurge, paused, strategyType, templateHash, currentSet, ownedSets };

    if (templateChanged && paused) {
      // A paused Deployment must not start a new rollout.
      for (const rs of ownedSets) this._reconcileReplicaSet(rs, undefined, minReadySeconds);
      this._updateDeploymentStatus(deploy, status, { rolloutPending: true });
      return;
    }
    if (templateChanged) {
      currentSet = this._createDeploymentReplicaSet(deploy, template, templateHash, selector, ownedSets);
      if (currentSet && !ownedSets.includes(currentSet)) ownedSets.push(currentSet);
      status.currentSet = currentSet;
      status.ownedSets = ownedSets;
    }

    // Reconcile a pre-existing ReplicaSet (legacy/saved state) whose template
    // no longer matches its hash label.
    if (currentSet && this._stableStringify(currentSet.spec.template || {}) !== this._stableStringify(template)) {
      currentSet.spec.template = deepClone(template);
      this.cluster.update(currentSet.uid, currentSet);
    }

    const activeOld = oldSets.reduce((sum, rs) => sum + this._activePodsOf(rs).length, 0);
    const activeCurrent = currentSet ? this._activePodsOf(currentSet).length : 0;

    if (paused) {
      for (const rs of [currentSet, ...oldSets]) if (rs) this._reconcileReplicaSet(rs, undefined, minReadySeconds);
    } else if (strategyType === 'Recreate') {
      if (activeOld > 0) {
        for (const rs of oldSets) this._reconcileReplicaSet(rs, 0, minReadySeconds);
        this._reconcileReplicaSet(currentSet, 0, minReadySeconds);
      } else {
        this._reconcileReplicaSet(currentSet, desiredReplicas, minReadySeconds);
      }
    } else {
      // RollingUpdate: create up to maxSurge new pods first, then remove old
      // pods one at a time once the new ReplicaSet satisfies minAvailable.
      let currentTarget;
      if (activeOld === 0) {
        currentTarget = desiredReplicas;
      } else {
        const surgeRoom = Math.max(0, desiredReplicas + maxSurge - activeOld - activeCurrent);
        currentTarget = Math.min(desiredReplicas, activeCurrent + surgeRoom);
      }
      if (currentSet) this._reconcileReplicaSet(currentSet, currentTarget, minReadySeconds);
      if (activeOld > 0) {
        const minAvailable = Math.max(0, desiredReplicas - maxUnavailable);
        const totalReady = (currentSet ? this._readyPodsOf(currentSet, minReadySeconds).length : 0)
          + oldSets.reduce((sum, rs) => sum + this._readyPodsOf(rs, minReadySeconds).length, 0);
        // One old pod may go only while one more than minAvailable stays ready.
        if (totalReady > minAvailable) {
          const victimSet = oldSets
            .filter((rs) => this._activePodsOf(rs).length > 0)
            .sort((a, b) => this._replicaSetRevision(a) - this._replicaSetRevision(b))[0];
          if (victimSet) this._reconcileReplicaSet(victimSet, this._activePodsOf(victimSet).length - 1, minReadySeconds);
        }
      }
      for (const rs of oldSets) {
        if (rs.spec.replicas !== 0 && this._activePodsOf(rs).length === 0) this._reconcileReplicaSet(rs, 0, minReadySeconds);
      }
    }

    const rolloutPending = this._activePodsOf(currentSet).length < desiredReplicas
      || oldSets.some((rs) => this._activePodsOf(rs).length > 0);
    this._updateDeploymentStatus(deploy, status, { rolloutPending });
    this._pruneDeploymentReplicaSets(deploy, status, revisionHistoryLimit);
  }

  /** Create (or refresh) the ReplicaSet for a Deployment template revision. */
  _createDeploymentReplicaSet(deploy, template, templateHash, selector, ownedSets) {
    const namespace = deploy.metadata.namespace;
    const name = `${deploy.metadata.name}-${templateHash}`;
    let revision = ownedSets.reduce((max, rs) => Math.max(max, this._replicaSetRevision(rs)), 0) + 1;
    let rs = this.cluster.getByName('ReplicaSet', name, namespace);
    if (!rs) {
      rs = this.cluster.addResource({
        kind: 'ReplicaSet',
        metadata: {
          name,
          namespace,
          labels: { ...selector, 'pod-template-hash': templateHash },
          annotations: { 'deployment.kubernetes.io/revision': String(revision) },
        },
        spec: {
          replicas: 0,
          selector: { matchLabels: deepClone(selector) },
          template: deepClone(template),
        },
      });
    }
    if (!rs) return null;
    this.cluster.addRelationship(deploy.uid, rs.uid);
    deploy.metadata.annotations = deploy.metadata.annotations || {};
    const currentRevision = parseInt(deploy.metadata.annotations['deployment.kubernetes.io/revision'] || '0', 10) || 0;
    revision = Math.max(revision, currentRevision + 1);
    deploy.metadata.annotations['deployment.kubernetes.io/revision'] = String(revision);
    rs.metadata.annotations = rs.metadata.annotations || {};
    rs.metadata.annotations['deployment.kubernetes.io/revision'] = String(revision);
    this.cluster.updateMetadata(deploy.uid, { annotations: { 'deployment.kubernetes.io/revision': String(revision) } });
    this.eventBus?.emit('rollout:triggered', {
      kind: 'Deployment',
      name: deploy.metadata.name,
      namespace,
      revision,
      templateHash,
      resource: deploy,
    });
    return rs;
  }

  /**
   * Reconcile one ReplicaSet to a target replica count. When `targetReplicas`
   * is undefined the existing `rs.spec.replicas` is honoured.
   */
  _reconcileReplicaSet(rs, targetReplicas, minReadySeconds = 0) {
    if (!rs) return;
    if (typeof targetReplicas === 'number' && Number.isFinite(targetReplicas)) {
      const next = Math.max(0, Math.floor(targetReplicas));
      if (rs.spec.replicas !== next) {
        rs.spec.replicas = next;
        this.cluster.update(rs.uid, rs);
      }
    }
    const target = Math.max(0, Number(rs.spec.replicas ?? 0) || 0);
    const pods = this._activePodsOf(rs);
    const blockedPod = pods.find((pod) => this._isPodBlocked(pod));
    if (blockedPod) {
      // Do not create replacements while admission is rejecting pods.
      this._refreshReplicaSetStatus(rs, pods, minReadySeconds);
      return;
    }
    if (pods.length < target) {
      for (let index = 0; index < target - pods.length; index++) this._createPodForWorkload(rs, rs);
    } else if (pods.length > target) {
      const sorted = [...pods].sort((a, b) => {
        if (a.status.phase === 'Pending' && b.status.phase !== 'Pending') return -1;
        if (b.status.phase === 'Pending' && a.status.phase !== 'Pending') return 1;
        return new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp);
      });
      for (let index = 0; index < pods.length - target; index++) this.cluster.remove(sorted[index].uid);
    }
    this._refreshReplicaSetStatus(rs, this._activePodsOf(rs), minReadySeconds);
  }

  _refreshReplicaSetStatus(rs, pods, minReadySeconds = 0) {
    const ready = pods.filter((pod) => this._podIsReady(pod, minReadySeconds));
    rs.status.replicas = pods.length;
    rs.status.fullyLabeledReplicas = pods.filter((pod) => pod.metadata.labels?.['pod-template-hash'] === rs.metadata.labels?.['pod-template-hash']).length;
    rs.status.readyReplicas = ready.length;
    rs.status.availableReplicas = ready.length;
    rs.status.observedGeneration = rs.metadata.generation;
    rs.status.phase = 'Running';
  }

  /** Derive Deployment status/conditions from the real ReplicaSet pods. */
  _updateDeploymentStatus(deploy, ctx, flags = {}) {
    const { desiredReplicas, minReadySeconds, maxUnavailable, paused, currentSet, ownedSets } = ctx;
    const allPods = ownedSets.flatMap((rs) => this._activePodsOf(rs));
    const currentPods = currentSet ? this._activePodsOf(currentSet) : [];
    const readyAll = allPods.filter((pod) => this._podIsReady(pod, minReadySeconds));
    const readyCurrent = currentPods.filter((pod) => this._podIsReady(pod, minReadySeconds));
    const available = readyAll.length;
    const minAvailable = Math.max(0, desiredReplicas - maxUnavailable);
    // Admission-denied pods are Failed objects, so they are not "active"; scan
    // all owned pods (not just active ones) to surface ReplicaFailure.
    const deniedPods = ownedSets
      .flatMap((rs) => this.cluster.getChildren(rs.uid))
      .filter((child) => child.kind === 'Pod' && this._isPodBlocked(child));
    const oldSetPods = ownedSets.filter((rs) => rs !== currentSet).reduce((sum, rs) => sum + this._activePodsOf(rs).length, 0);
    const rolloutPending = flags.rolloutPending === true
      || oldSetPods > 0
      || currentPods.length < desiredReplicas
      || (currentSet && this._stableStringify(currentSet.spec.template || {}) !== this._stableStringify(deploy.spec.template || {}));

    const previousSignature = deploy._deploymentStatusSignature;
    deploy.status.replicas = allPods.length;
    deploy.status.readyReplicas = (!paused && rolloutPending && currentSet) ? readyCurrent.length : readyAll.length;
    deploy.status.availableReplicas = available;
    deploy.status.updatedReplicas = currentPods.length;
    deploy.status.unavailableReplicas = Math.max(0, desiredReplicas - available);
    deploy.status.observedGeneration = deploy.metadata.generation;

    if (deniedPods.length > 0) {
      const deadline = Math.max(1, Number(deploy.spec.progressDeadlineSeconds) || 600);
      if (typeof deploy._progressingSince !== 'number') deploy._progressingSince = this.gameSeconds;
      const timedOut = this.gameSeconds - deploy._progressingSince >= deadline;
      deploy.setCondition('Available', 'False', 'MinimumReplicasUnavailable', `${available}/${desiredReplicas} replicas available`);
      deploy.setCondition(
        'Progressing',
        timedOut ? 'False' : 'True',
        timedOut ? 'ProgressDeadlineExceeded' : 'ReplicaSetUpdated',
        timedOut ? 'ReplicaSet has timed out progressing because pods are rejected by admission' : 'waiting for pods to be admitted'
      );
      deploy.setCondition('ReplicaFailure', 'True', 'FailedCreate', deniedPods[0].metadata.annotations['openshiftgames/denied-reason'] || 'unable to admit pod');
    } else {
      deploy.setCondition('ReplicaFailure', 'False', 'NoReplicaFailure', '');
      if (paused) {
        deploy._progressingSince = undefined;
        deploy.setCondition('Progressing', 'True', 'DeploymentPaused', 'deployment is paused; rollout will not continue until resumed');
        deploy.setCondition('Available', available >= Math.min(desiredReplicas, minAvailable) ? 'True' : 'False', available >= Math.min(desiredReplicas, minAvailable) ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', `${available}/${desiredReplicas} replicas available`);
      } else if (rolloutPending) {
        const deadline = Math.max(1, Number(deploy.spec.progressDeadlineSeconds) || 600);
        if (typeof deploy._progressingSince !== 'number') deploy._progressingSince = this.gameSeconds;
        const timedOut = this.gameSeconds - deploy._progressingSince >= deadline;
        if (timedOut) {
          deploy.setCondition('Progressing', 'False', 'ProgressDeadlineExceeded', `ReplicaSet "${currentSet?.metadata?.name || 'new'}" has timed out progressing.`);
        } else {
          deploy.setCondition('Progressing', 'True', 'ReplicaSetUpdated', `${readyCurrent.length} out of ${desiredReplicas} new replicas have been updated`);
        }
        deploy.setCondition('Available', available >= minAvailable ? 'True' : 'False', available >= minAvailable ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', `${available}/${desiredReplicas} replicas available`);
      } else {
        deploy._progressingSince = undefined;
        deploy.setCondition('Available', 'True', 'MinimumReplicasAvailable', '');
        deploy.setCondition('Progressing', 'True', 'NewReplicaSetAvailable', '');
      }
    }

    const signature = JSON.stringify({
      replicas: deploy.status.replicas,
      ready: deploy.status.readyReplicas,
      available: deploy.status.availableReplicas,
      updated: deploy.status.updatedReplicas,
      unavailable: deploy.status.unavailableReplicas,
      observedGeneration: deploy.status.observedGeneration,
      conditions: (deploy.status.conditions || []).map((condition) => `${condition.type}:${condition.status}:${condition.reason}`),
    });
    if (signature !== previousSignature) {
      deploy._deploymentStatusSignature = signature;
      this.cluster.update(deploy.uid, deploy);
    }
  }

  /** Keep only the newest `revisionHistoryLimit` ReplicaSets (scaled to 0). */
  _pruneDeploymentReplicaSets(deploy, ctx, revisionHistoryLimit) {
    const sets = (ctx.ownedSets || []).filter((rs) => rs !== ctx.currentSet);
    const removable = sets
      .filter((rs) => rs.spec.replicas === 0 && this._activePodsOf(rs).length === 0)
      .sort((a, b) => this._replicaSetRevision(b) - this._replicaSetRevision(a));
    const keepOld = Math.max(0, revisionHistoryLimit - 1);
    for (const rs of removable.slice(keepOld)) {
      this.cluster.remove(rs.uid);
    }
  }

  _replicaSetRevision(rs) {
    const value = Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision']);
    if (Number.isFinite(value)) return value;
    return 0;
  }

  _activePodsOf(owner) {
    if (!owner) return [];
    return this.cluster.getChildren(owner.uid).filter(
      (child) => child.kind === 'Pod' && child.status.phase !== 'Succeeded' && child.status.phase !== 'Failed'
    );
  }

  _readyPodsOf(owner, minReadySeconds = 0) {
    return this._activePodsOf(owner).filter((pod) => this._podIsReady(pod, minReadySeconds));
  }

  _podIsReady(pod, minReadySeconds = 0) {
    if (!pod || pod.status.phase !== 'Running' || !pod.isConditionTrue('Ready')) return false;
    if (minReadySeconds > 0) {
      if (typeof pod._readyAt !== 'number') return false;
      if (this.gameSeconds - pod._readyAt < minReadySeconds) return false;
    }
    return true;
  }

  /** Resolve an int-or-percent strategy field; K8s rounds surge up / unavail down. */
  _resolveStrategyNumber(value, desiredReplicas, kind) {
    const fallbackPercent = 25;
    let raw = value;
    if (raw === undefined || raw === null || raw === '') raw = `${fallbackPercent}%`;
    if (typeof raw === 'string' && raw.trim().endsWith('%')) {
      const percent = parseFloat(raw);
      if (!Number.isFinite(percent)) return 0;
      const scaled = (percent / 100) * desiredReplicas;
      return kind === 'surge' ? Math.ceil(scaled) : Math.floor(scaled);
    }
    const number = Number(raw);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
  }

  /** Deterministic 9-char `pod-template-hash` from a pod template. */
  _templateHash(template) {
    const digest = this._hashString(this._stableStringify(template || {}));
    return digest.toString(36).padStart(9, '0').slice(-9);
  }

  /** JSON with recursively sorted keys (stable across apply round-trips). */
  _stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((entry) => this._stableStringify(entry)).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${this._stableStringify(value[key])}`).join(',')}}`;
  }

  _tickStatefulSets(dt) {
    for (const statefulSet of this.cluster.getByKind('StatefulSet')) {
      const desiredReplicas = Math.max(0, Number(statefulSet.spec.replicas ?? 1) || 0);
      const namespace = statefulSet.metadata.namespace;
      const templateHash = this._templateHash(statefulSet.spec.template || {});
      const revisionName = `${statefulSet.metadata.name}-${templateHash}`;
      const activePods = this._activePodsOf(statefulSet);
      this._ensureStatefulSetClaims(statefulSet, activePods);

      const blocked = activePods.some((pod) => this._isPodBlocked(pod));
      if (!blocked) {
        // Recreate the lowest missing ordinal (stable pod name, SIM-006).
        for (let ordinal = 0; ordinal < desiredReplicas; ordinal++) {
          const podName = `${statefulSet.metadata.name}-${ordinal}`;
          const existing = this.cluster.getByName('Pod', podName, namespace);
          if (existing && !existing.isDeleting && existing.status.phase !== 'Succeeded' && existing.status.phase !== 'Failed') {
            continue;
          }
          const created = this._createStatefulSetPod(statefulSet, ordinal, revisionName);
          if (created) break; // approximate OrderedReady: one pod per tick
        }
      }

      // Rolling update: one outdated pod at a time, highest ordinal first,
      // until every pod carries the current controller-revision-hash.
      const outdated = this._activePodsOf(statefulSet)
        .filter((pod) => pod.metadata.labels?.['controller-revision-hash'] !== revisionName)
        .sort((a, b) => this._podOrdinal(b) - this._podOrdinal(a));
      if (!blocked && outdated.length > 0) this.cluster.remove(outdated[0].uid);

      // Scale down the highest ordinals.
      let pods = this._activePodsOf(statefulSet);
      if (pods.length > desiredReplicas) {
        const sorted = [...pods].sort((a, b) => this._podOrdinal(b) - this._podOrdinal(a));
        for (let index = 0; index < pods.length - desiredReplicas; index++) this.cluster.remove(sorted[index].uid);
        pods = this._activePodsOf(statefulSet);
      }

      const readyPods = pods.filter((pod) => this._podIsReady(pod));
      const updatedPods = pods.filter((pod) => pod.metadata.labels?.['controller-revision-hash'] === revisionName);
      statefulSet.status.replicas = pods.length;
      statefulSet.status.readyReplicas = readyPods.length;
      statefulSet.status.availableReplicas = readyPods.length;
      statefulSet.status.currentReplicas = pods.length;
      statefulSet.status.updatedReplicas = updatedPods.length;
      statefulSet.status.updateRevision = revisionName;
      if (pods.length > 0 && updatedPods.length === pods.length) statefulSet.status.currentRevision = revisionName;
      else if (!statefulSet.status.currentRevision) statefulSet.status.currentRevision = revisionName;
      statefulSet.status.observedGeneration = statefulSet.metadata.generation;
      if (pods.length > 0 && statefulSet.status.phase !== 'Running') statefulSet.setPhase('Running');
    }
  }

  /** Create one StatefulSet pod with stable ordinal name, labels and claims. */
  _createStatefulSetPod(statefulSet, ordinal, revisionName) {
    const namespace = statefulSet.metadata.namespace;
    const podName = `${statefulSet.metadata.name}-${ordinal}`;
    const existing = this.cluster.getByName('Pod', podName, namespace);
    if (existing && !existing.isDeleting) return null;
    const template = statefulSet.spec.template || {};
    const podSpec = deepClone(template.spec || {});
    podSpec.containers = podSpec.containers || [{ name: 'main', image: 'app:latest' }];
    podSpec.hostname = podName;
    podSpec.subdomain = statefulSet.spec.serviceName || statefulSet.metadata.name;
    const claimTemplates = statefulSet.spec.volumeClaimTemplates || [];
    if (claimTemplates.length > 0) {
      const volumes = podSpec.volumes || [];
      for (const claimTemplate of claimTemplates) {
        const claimBaseName = claimTemplate.metadata?.name || claimTemplate.name || 'data';
        volumes.push({ name: claimBaseName, persistentVolumeClaim: { claimName: `${claimBaseName}-${podName}` } });
      }
      podSpec.volumes = volumes;
    }
    const selectorLabels = statefulSet.spec.selector?.matchLabels || {};
    const templateLabels = template.metadata?.labels || {};
    const labels = {
      ...selectorLabels,
      ...templateLabels,
      'statefulset.kubernetes.io/pod-name': podName,
      'apps.kubernetes.io/pod-index': String(ordinal),
      'controller-revision-hash': revisionName,
    };
    const pod = this.cluster.addResource({
      kind: 'Pod',
      metadata: { name: podName, namespace, labels },
      spec: podSpec,
      status: { phase: 'Pending' },
    });
    if (pod) this.cluster.addRelationship(statefulSet.uid, pod.uid);
    return pod;
  }

  _podOrdinal(pod) {
    const match = String(pod?.metadata?.name || '').match(/-(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /** Create per-replica PVCs from StatefulSet volumeClaimTemplates. */
  _ensureStatefulSetClaims(statefulSet, pods) {
    const templates = statefulSet.spec.volumeClaimTemplates || [];
    if (templates.length === 0) return;
    const desiredReplicas = Math.max(0, Number(statefulSet.spec.replicas ?? 1) || 0);
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
              labels: { app: statefulSet.metadata.name, ...(template.metadata?.labels || {}) },
              annotations: deepClone(template.metadata?.annotations || {}),
            },
            spec: deepClone(template.spec || { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } }),
          });
        }
      }
    }
  }

  _tickDaemonSets(dt) {
    const allNodes = this.cluster.getByKind('Node').filter((node) => node.status.phase !== 'Terminating');
    for (const daemonSet of this.cluster.getByKind('DaemonSet')) {
      const selectorLabels = daemonSet.spec.selector?.matchLabels || {};
      const nodeSelector = daemonSet.spec.nodeSelector || {};
      const tolerations = daemonSet.spec.template?.spec?.tolerations || [];
      // DaemonSet targets every Ready, matching node. Cordoned nodes still run
      // already-bound DS pods (real DS tolerates unschedulable); custom
      // NoSchedule taints require a template toleration.
      const targetNodes = allNodes.filter((node) => {
        if (!node.isConditionTrue('Ready')) return false;
        if (!node.matchesSelector(nodeSelector)) return false;
        if (this._firstUntoleratedNoScheduleTaint({ spec: { tolerations } }, node)) return false;
        return true;
      });

      let pods = this._activePodsOf(daemonSet);
      const blocked = pods.some((pod) => this._isPodBlocked(pod));
      if (!blocked) {
        for (const node of targetNodes) {
          const scheduled = pods.some((pod) => pod.spec.nodeName === node.metadata.name && !pod.isDeleting);
          if (scheduled) continue;
          const pod = this._createPodForWorkload(daemonSet, daemonSet);
          if (!pod) continue;
          this._schedulePodOnNode(pod, node);
          pods = this._activePodsOf(daemonSet);
          break; // one pod per tick to keep the controller smooth
        }
      }

      // Remove pods from nodes that no longer match the DS node selector.
      for (const pod of pods) {
        if (!pod.spec.nodeName) continue;
        const node = allNodes.find((entry) => entry.metadata.name === pod.spec.nodeName);
        if (node && !targetNodes.includes(node)) this.cluster.remove(pod.uid);
      }

      pods = this._activePodsOf(daemonSet);
      const ready = pods.filter((pod) => this._podIsReady(pod));
      daemonSet.status.desiredNumberScheduled = targetNodes.length;
      daemonSet.status.currentNumberScheduled = pods.filter((pod) => pod.spec.nodeName).length;
      daemonSet.status.numberReady = ready.length;
      daemonSet.status.numberAvailable = ready.length;
      daemonSet.status.numberUnavailable = Math.max(0, targetNodes.length - ready.length);
      daemonSet.status.numberMisscheduled = 0;
      daemonSet.status.updatedNumberScheduled = pods.length;
      daemonSet.status.observedGeneration = daemonSet.metadata.generation;
      if (pods.length > 0 && daemonSet.status.phase !== 'Running') daemonSet.setPhase('Running');
    }
  }

  _tickJobs(dt) {
    for (const job of this.cluster.getByKind('Job')) {
      if (job.status.phase === 'Complete' || job.status.phase === 'Failed') continue;
      // Real Job.status.phase is only set to Complete/Failed; it is unset while
      // the Job is active (batch/v1 JobPhase has no Pending value).
      if (job.status.phase === 'Pending') delete job.status.phase;
      if (typeof job._startedAtGameSeconds !== 'number') job._startedAtGameSeconds = this.gameSeconds;
      if (!job.status.startTime) job.status.startTime = new Date().toISOString();

      const completions = Math.max(1, Number(job.spec.completions ?? 1) || 1);
      const parallelism = Math.max(1, Number(job.spec.parallelism ?? 1) || 1);
      const backoffLimit = Number.isFinite(Number(job.spec.backoffLimit)) ? Number(job.spec.backoffLimit) : 6;
      const activeDeadlineSeconds = Number(job.spec.activeDeadlineSeconds);
      const jobPods = () => this.cluster.getChildren(job.uid).filter((child) => child.kind === 'Pod');
      const succeededPods = jobPods().filter((pod) => pod.status.phase === 'Succeeded');
      const failedPods = jobPods().filter((pod) => pod.status.phase === 'Failed');
      const activePods = jobPods().filter((pod) => pod.status.phase === 'Running' || pod.status.phase === 'Pending');
      job.status.succeeded = succeededPods.length;
      job.status.failed = failedPods.length;
      job.status.active = activePods.length;

      const finishJob = (phase, reason, message) => {
        job.setPhase(phase);
        job.status.completionTime = new Date().toISOString();
        job.status.reason = reason;
        job.status.message = message || '';
        job.setCondition(phase === 'Complete' ? 'Complete' : 'Failed', 'True', reason, message || '');
        this.cluster.update(job.uid, job);
        return true;
      };

      if (succeededPods.length >= completions) {
        finishJob('Complete', 'JobComplete', 'Job completed successfully');
        continue;
      }
      if (Number.isFinite(activeDeadlineSeconds) && activeDeadlineSeconds > 0) {
        const elapsed = this.gameSeconds - job._startedAtGameSeconds;
        if (elapsed >= activeDeadlineSeconds) {
          // Terminate still-running pods and fail the Job (SIM-011).
          for (const pod of activePods) {
            pod.setPhase('Failed');
            pod.setCondition('Ready', 'False', 'ContainersNotReady', 'job active deadline exceeded');
            pod.recordEvent('Warning', 'DeadlineExceeded', 'Pod terminated because the Job activeDeadlineSeconds was exceeded');
          }
          job.status.active = 0;
          finishJob('Failed', 'DeadlineExceeded', `Job was active longer than specified deadline (${activeDeadlineSeconds}s)`);
          continue;
        }
      }
      if (failedPods.length > backoffLimit) {
        finishJob('Failed', 'BackoffLimitExceeded', `Job has reached the specified backoff limit (${backoffLimit})`);
        continue;
      }
      if (jobPods().some((pod) => this._isPodBlocked(pod))) continue;

      // Exponential retry backoff (simulation time).
      if (failedPods.length > 0) {
        if (typeof job._nextPodCreateAtGameSeconds !== 'number') {
          job._nextPodCreateAtGameSeconds = this.gameSeconds + Math.min(300, Math.pow(2, failedPods.length) * 10);
        }
      } else {
        job._nextPodCreateAtGameSeconds = undefined;
      }
      const backoffPending = failedPods.length > 0
        && typeof job._nextPodCreateAtGameSeconds === 'number'
        && this.gameSeconds < job._nextPodCreateAtGameSeconds;
      const needed = Math.min(parallelism, completions - succeededPods.length) - activePods.length;
      for (let index = 0; index < needed; index++) {
        if (backoffPending) break;
        const pod = this._createPodForWorkload(job, job);
        if (!pod) break;
        pod.spec.restartPolicy = 'Never';
        const duration = Math.max(1, Number(job.spec.estimatedDurationSeconds) || 30) * (0.8 + Math.random() * 0.4);
        pod._completionAtGameSeconds = this.gameSeconds + duration;
        pod._jobUid = job.uid;
      }

      // Simulated-time completion (was wall-clock Date.now() based).
      for (const pod of activePods) {
        if (pod.status.phase !== 'Running') continue;
        if (typeof pod._completionAtGameSeconds === 'number' && this.gameSeconds >= pod._completionAtGameSeconds) {
          pod.setPhase('Succeeded');
          for (const status of pod.status.containerStatuses || []) {
            status.state = { terminated: { exitCode: 0, reason: 'Completed', finishedAt: new Date().toISOString() } };
            status.ready = false;
            status.started = false;
          }
          pod.setCondition('Ready', 'False', 'ContainersNotReady', 'pod completed');
          pod.setCondition('ContainersReady', 'False', 'ContainersNotReady');
          pod.recordEvent('Normal', 'Completed', 'Pod completed successfully');
        }
      }

      const succeededNow = jobPods().filter((pod) => pod.status.phase === 'Succeeded').length;
      job.status.succeeded = succeededNow;
      job.status.failed = jobPods().filter((pod) => pod.status.phase === 'Failed').length;
      job.status.active = jobPods().filter((pod) => pod.status.phase === 'Running' || pod.status.phase === 'Pending').length;
      if (succeededNow >= completions) finishJob('Complete', 'JobComplete', 'Job completed successfully');
    }
  }

  _tickCronJobs(dt) {
    for (const cronJob of this.cluster.getByKind('CronJob')) {
      const namespace = cronJob.metadata.namespace;
      const jobs = this.cluster.getChildren(cronJob.uid).filter((child) => child.kind === 'Job');
      const running = jobs.filter((job) => job.status.phase !== 'Complete' && job.status.phase !== 'Failed' && !job.metadata.deletionTimestamp);
      const completed = jobs.filter((job) => job.status.phase === 'Complete')
        .sort((a, b) => new Date(a.metadata.creationTimestamp) - new Date(b.metadata.creationTimestamp));
      const failed = jobs.filter((job) => job.status.phase === 'Failed')
        .sort((a, b) => new Date(a.metadata.creationTimestamp) - new Date(b.metadata.creationTimestamp));

      // CronJob.status.active is an array of Job object references (batch/v1).
      cronJob.status.active = running.map((job) => ({
        apiVersion: 'batch/v1',
        kind: 'Job',
        name: job.metadata.name,
        namespace,
        uid: job.metadata.uid,
      }));
      cronJob.status.suspend = cronJob.spec.suspend === true;
      const lastCompleted = completed[completed.length - 1];
      if (lastCompleted) cronJob.status.lastSuccessfulTime = lastCompleted.status.completionTime || cronJob.status.lastSuccessfulTime;

      const successLimit = Number.isFinite(Number(cronJob.spec.successfulJobsHistoryLimit)) ? Number(cronJob.spec.successfulJobsHistoryLimit) : 3;
      const failedLimit = Number.isFinite(Number(cronJob.spec.failedJobsHistoryLimit)) ? Number(cronJob.spec.failedJobsHistoryLimit) : 1;
      while (completed.length > successLimit) this.cluster.remove(completed.shift().uid);
      while (failed.length > failedLimit) this.cluster.remove(failed.shift().uid);

      if (cronJob.spec.suspend) continue;
      const interval = this._parseCronInterval(cronJob.spec.schedule || '*/5 * * * *');
      const now = Date.now();
      const lastSchedule = cronJob.status.lastScheduleTime ? new Date(cronJob.status.lastScheduleTime).getTime() : 0;
      if (lastSchedule && now - lastSchedule < interval) continue;

      const policy = cronJob.spec.concurrencyPolicy || 'Allow';
      if (running.length > 0) {
        if (policy === 'Forbid') {
          cronJob.recordEvent('Normal', 'JobAlreadyActive', 'Skipped scheduled job: concurrency policy Forbid');
          // Avoid re-logging the same skip every cron check.
          cronJob.status.lastScheduleTime = new Date(now).toISOString();
          continue;
        }
        if (policy === 'Replace') {
          for (const job of running) this.cluster.remove(job.uid);
          cronJob.recordEvent('Normal', 'JobReplaced', 'Replaced a running job due to concurrency policy Replace');
        }
      }

      let jobName = `${cronJob.metadata.name}-${Math.floor(now / 60000)}`;
      let suffix = 0;
      while (this.cluster.getByName('Job', jobName, namespace)) {
        suffix += 1;
        jobName = `${cronJob.metadata.name}-${Math.floor(now / 60000)}-${suffix}`;
      }
      const jobSpec = deepClone(cronJob.spec.jobTemplate?.spec || {});
      const newJob = this.cluster.addResource({
        kind: 'Job',
        metadata: {
          name: jobName,
          namespace,
          labels: {
            ...(cronJob.spec.jobTemplate?.metadata?.labels || {}),
            'cronjob.kubernetes.io/name': cronJob.metadata.name,
          },
          annotations: deepClone(cronJob.spec.jobTemplate?.metadata?.annotations || {}),
        },
        spec: jobSpec,
      });
      if (!newJob) continue;
      this.cluster.addRelationship(cronJob.uid, newJob.uid);
      cronJob.status.lastScheduleTime = new Date(now).toISOString();
      cronJob.status.active = [...(cronJob.status.active || []), { apiVersion: 'batch/v1', kind: 'Job', name: jobName, namespace, uid: newJob.metadata.uid }];
      cronJob.recordEvent('Normal', 'SuccessfulCreate', `Created job ${jobName}`);
    }
  }

  /**
   * Average schedule interval in milliseconds for common 5-field cron forms
   * (used as a compressed-time scheduler; supports daily/hourly/every-N).
   */
  _parseCronInterval(schedule) {
    const parts = String(schedule || '').trim().split(/\s+/);
    if (parts.length < 5) return 300000;
    const [minuteField, hourField] = parts;
    const parseField = (field) => {
      if (!field || field === '*') return { any: true };
      if (field.startsWith('*/')) return { step: Math.max(1, parseInt(field.slice(2), 10) || 1) };
      if (/^\d+$/.test(field)) return { value: parseInt(field, 10) };
      return { any: true };
    };
    const minute = parseField(minuteField);
    const hour = parseField(hourField);
    if (hour.any && minute.any) return 60 * 1000; // every minute
    if (hour.any && minute.step) return minute.step * 60 * 1000;
    if (hour.step && minute.any) return hour.step * 60 * 60 * 1000;
    if (hour.step && minute.value !== undefined) return hour.step * 60 * 60 * 1000;
    if (hour.value !== undefined && minute.any) return 60 * 60 * 1000;
    if (hour.value !== undefined && minute.step) return Math.max(60 * 1000, minute.step * 60 * 1000);
    if (hour.value !== undefined && minute.value !== undefined) return 24 * 60 * 60 * 1000;
    return 60 * 60 * 1000;
  }

  _tickHPA(dt) {
    const TOLERANCE = 0.1; // --horizontal-pod-autoscaler-tolerance default
    for (const hpa of this.cluster.getByKind('HorizontalPodAutoscaler')) {
      const targetRef = hpa.spec.scaleTargetRef;
      if (!targetRef) continue;
      hpa.status.observedGeneration = hpa.metadata.generation;
      const target = this.cluster.getByName(targetRef.kind, targetRef.name, hpa.namespace);
      if (!target) {
        hpa.setCondition('ScalingActive', 'False', 'FailedGetScale', `the HPA controller was unable to get the target's current scale: ${String(targetRef.kind).toLowerCase()}s.apps "${targetRef.name}" not found`);
        this.cluster.update(hpa.uid, hpa);
        continue;
      }

      const currentReplicas = Math.max(0, Number(target.spec.replicas ?? 1) || 0);
      const minReplicas = Number.isFinite(Number(hpa.spec.minReplicas)) ? Number(hpa.spec.minReplicas) : 1;
      const maxReplicas = Number.isFinite(Number(hpa.spec.maxReplicas)) ? Number(hpa.spec.maxReplicas) : 10;
      const metrics = hpa.spec.metrics || [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 50 } } }];
      let desiredReplicas = currentReplicas;
      let metricsAvailable = true;
      const statusMetrics = [];

      for (const metric of metrics) {
        if (metric.type !== 'Resource' || !metric.resource) continue;
        const resourceName = metric.resource.name || 'cpu';
        const targetUtilization = Number(
          metric.resource.targetAverageUtilization ?? metric.resource.target?.averageUtilization ?? 50
        ) || 50;
        const measured = this._getWorkloadCpuUtilization(target);
        if (!measured.available) {
          metricsAvailable = false;
          statusMetrics.push({ type: 'Resource', resource: { name: resourceName, current: { averageUtilization: 0 } } });
          continue;
        }
        statusMetrics.push({
          type: 'Resource',
          resource: {
            name: resourceName,
            current: {
              averageUtilization: measured.utilization,
              averageValue: `${Math.round(measured.averageUsageMillis)}m`,
            },
          },
        });
        const ratio = measured.utilization / targetUtilization;
        if (ratio > 1 + TOLERANCE) desiredReplicas = Math.max(desiredReplicas, Math.ceil(currentReplicas * ratio));
        else if (ratio < 1 - TOLERANCE) desiredReplicas = Math.min(desiredReplicas, Math.ceil(currentReplicas * ratio));
      }

      hpa.status.currentMetrics = statusMetrics;
      hpa.status.currentReplicas = currentReplicas;
      if (!metricsAvailable) {
        hpa.status.desiredReplicas = currentReplicas;
        hpa.setCondition('ScalingActive', 'False', 'FailedGetResourceMetric', 'the HPA was unable to compute the replica count: no metrics returned');
        hpa.setCondition('ScalingLimited', 'False', 'DesiredWithinRange', '');
        this.cluster.update(hpa.uid, hpa);
        continue;
      }

      const rawDesiredReplicas = Math.max(minReplicas, Math.min(maxReplicas, desiredReplicas));
      desiredReplicas = rawDesiredReplicas;
      hpa.setCondition('ScalingActive', 'True', 'ValidMetricFound', 'the HPA was able to successfully calculate a replica count from cpu resource utilization');
      if (desiredReplicas >= maxReplicas && currentReplicas < desiredReplicas) {
        hpa.setCondition('ScalingLimited', 'True', 'TooManyReplicas', 'the desired replica count is more than the maximum replica count');
      } else if (desiredReplicas <= minReplicas && currentReplicas > desiredReplicas) {
        hpa.setCondition('ScalingLimited', 'True', 'TooFewReplicas', 'the desired replica count is less than the minimum replica count');
      } else {
        hpa.setCondition('ScalingLimited', 'False', 'DesiredWithinRange', '');
      }

      // Rate limits: ~+4 pods (or x2) per scale-up, at most halve on scale-down.
      const scaleUpLimit = Math.max(4, currentReplicas * 2);
      const scaleDownLimit = Math.max(1, Math.floor(currentReplicas * 0.5));
      let nextReplicas = desiredReplicas;
      if (nextReplicas > currentReplicas) nextReplicas = Math.min(nextReplicas, currentReplicas + scaleUpLimit);
      else if (nextReplicas < currentReplicas) nextReplicas = Math.max(nextReplicas, scaleDownLimit);

      if (nextReplicas !== currentReplicas) {
        const lastScaleTime = hpa.status.lastScaleTime ? new Date(hpa.status.lastScaleTime).getTime() : 0;
        const cooldown = nextReplicas > currentReplicas ? 30000 : 300000;
        if (Date.now() - lastScaleTime >= cooldown) {
          const direction = nextReplicas > currentReplicas ? 'up' : 'down';
          target.spec.replicas = nextReplicas;
          target.metadata.generation++;
          this.cluster.update(target.uid, target);
          hpa.status.currentReplicas = nextReplicas;
          hpa.status.desiredReplicas = nextReplicas;
          hpa.status.lastScaleTime = new Date().toISOString();
          hpa.recordEvent('Normal', 'SuccessfulRescale', `New size: ${nextReplicas}; reason: cpu resource utilization (percentage of request) above target`);
          this.eventBus?.emit('hpa:scaled', { hpa: hpa.metadata.name, target: target.metadata.name, from: currentReplicas, to: nextReplicas, direction });
        }
      } else {
        hpa.status.desiredReplicas = desiredReplicas;
      }
      this.cluster.update(hpa.uid, hpa);
    }
  }

  /**
   * Workload CPU utilization (sum usage / sum requests) over Running pods.
   * @returns {{available: boolean, utilization: number, averageUsageMillis: number}}
   */
  _getWorkloadCpuUtilization(workload) {
    const selector = workload.spec.selector?.matchLabels || workload.metadata.labels || {};
    const pods = this.cluster.selectByLabels('Pod', selector).filter(
      (pod) => pod.metadata.namespace === workload.metadata.namespace && pod.status.phase === 'Running'
    );
    let totalUsage = 0;
    let totalRequest = 0;
    for (const pod of pods) {
      for (const status of pod.status.containerStatuses || []) {
        totalUsage += Number(status._cpuSmooth ?? status.resources?.cpu) || 0;
        totalRequest += Number(status.resources?.cpuRequest) || 0;
      }
    }
    if (pods.length === 0 || totalRequest <= 0) {
      return { available: false, utilization: 0, averageUsageMillis: 0 };
    }
    return {
      available: true,
      utilization: Math.round((totalUsage / totalRequest) * 100),
      averageUsageMillis: totalUsage / pods.length,
    };
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
      const readyPods = pods.filter(
        (pod) => pod.status.phase === 'Running' && !pod.isDeleting && pod.isConditionTrue('Ready')
      );
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

      const address = this._allocateMetalLBAddress(usablePools, usedIps, service);
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
  _allocateMetalLBAddress(pools, usedIps, service = null) {
    const requestedPool = service?.metadata?.annotations?.['metallb.universe.tf/address-pool']
      || service?.metadata?.annotations?.['metallb.io/address-pool']
      || '';
    for (const pool of pools) {
      // autoAssign: false pools are only used by services that explicitly
      // request them via the address-pool annotation (MetalLB semantics).
      if (pool.spec?.autoAssign === false && requestedPool !== pool.metadata.name) continue;
      if (requestedPool && requestedPool !== pool.metadata.name) continue;
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
      if (parts.length !== 4 || !Number.isFinite(prefix)) return [base];
      const hostBits = 32 - prefix;
      if (hostBits <= 0) return [base]; // /32 single-address pool
      const network = this._ipToInt(parts) & ((0xffffffff << hostBits) >>> 0);
      const results = [];
      const maxAddresses = Math.min(2 ** hostBits, 1024);
      for (let offset = 1; offset < maxAddresses; offset++) results.push(this._intToIp((network + offset) >>> 0));
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
      const triggers = buildConfig.spec.triggers || [];
      const hasConfigChange = triggers.some((trigger) => trigger.type === 'ConfigChange');
      const generation = Number(buildConfig.metadata.generation) || 1;
      if (buildConfig._lastConfigChangeGeneration === undefined) buildConfig._lastConfigChangeGeneration = generation;
      if (buildConfig._autoBuildElapsed !== undefined && buildConfig._autoBuildElapsed !== null) {
        buildConfig._autoBuildElapsed += dt;
        if (buildConfig._autoBuildElapsed >= 1) {
          buildConfig._autoBuildElapsed = null;
          if (!this.cluster.getActiveBuildFor(buildConfig)) {
            const result = this.cluster.startBuildFor(buildConfig, { reason: 'ConfigChange' });
            if (result.success) buildConfig._lastConfigChangeGeneration = generation;
          }
        }
      } else if (hasConfigChange && generation !== buildConfig._lastConfigChangeGeneration) {
        // ConfigChange trigger: a BuildConfig spec change starts a new build
        // once the previous (Serial) build has finished (SIM-026).
        if (!this.cluster.getActiveBuildFor(buildConfig)) {
          const result = this.cluster.startBuildFor(buildConfig, { reason: 'ConfigChange' });
          if (result.success) buildConfig._lastConfigChangeGeneration = generation;
        }
      }
      // ImageChange trigger: a new build starts when the referenced builder
      // ImageStreamTag becomes available or changes (SIM-026).
      this._maybeStartImageChangeBuild(buildConfig);
    }
  }

  /** Start a build when a BuildConfig ImageChange trigger's tag changed. */
  _maybeStartImageChangeBuild(buildConfig) {
    const triggers = (buildConfig.spec.triggers || []).filter(
      (trigger) => trigger.type === 'ImageChange' && trigger.paused !== true
    );
    if (triggers.length === 0) return;
    buildConfig.status = buildConfig.status || {};
    buildConfig.status.imageChangeTriggers = buildConfig.status.imageChangeTriggers || [];
    let statusChanged = false;
    for (const trigger of triggers) {
      const params = trigger.imageChange || trigger.imageChangeParams || {};
      const from = params.from || trigger.from || {};
      if (from.kind && from.kind !== 'ImageStreamTag') continue;
      const fromName = String(from.name || '');
      if (!fromName.includes(':')) continue;
      const [streamName, tag] = fromName.split(':');
      const streamNamespace = from.namespace || buildConfig.metadata.namespace;
      const resolved = this.cluster.resolveImageStreamTag(streamNamespace, streamName, tag);
      const tagItem = resolved.tagEntry?.items?.[0];
      const available = Boolean(resolved.found && tagItem);
      if (!available) continue;
      const reference = `${tagItem.image || ''}|${resolved.dockerImageReference || ''}|${resolved.tagEntry?.updated || ''}`;
      let record = buildConfig.status.imageChangeTriggers.find(
        (entry) => (entry.from?.name || entry.fromName) === fromName
          && (entry.from?.namespace || streamNamespace) === streamNamespace
      );
      const previous = record?.lastTriggeredImageID;
      if (previous === reference) continue;
      if (this.cluster.getActiveBuildFor(buildConfig)) continue; // retry after the serial build finishes
      const result = this.cluster.startBuildFor(buildConfig, { reason: 'ImageChange' });
      if (!result.success) continue;
      // startBuildFor() replaces buildConfig.status when it updates the
      // BuildConfig, so re-resolve the record from the fresh status array.
      buildConfig.status.imageChangeTriggers = buildConfig.status.imageChangeTriggers || [];
      let freshRecord = buildConfig.status.imageChangeTriggers.find(
        (entry) => (entry.from?.name || entry.fromName) === fromName
          && (entry.from?.namespace || streamNamespace) === streamNamespace
      );
      if (!freshRecord) {
        freshRecord = { from: { kind: 'ImageStreamTag', name: fromName, namespace: streamNamespace } };
        buildConfig.status.imageChangeTriggers.push(freshRecord);
      }
      freshRecord.lastTriggeredImageID = reference;
      statusChanged = true;
    }
    if (statusChanged) this.cluster.update(buildConfig.uid, buildConfig);
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
  /**
   * Called after an ImageStreamTag update (build output, `oc tag`,
   * `oc import-image`). Only Deployments carrying the
   * `image.openshift.io/triggers` annotation roll out; without the annotation
   * an image change does not automatically update workloads (OCP 4.22 model).
   */
  _triggerImageChangeRollout(namespace, imageStreamName, tag, dockerImageReference) {
    for (const deployment of this.cluster.getByKindAndNamespace('Deployment', namespace)) {
      this._processDeploymentImageTriggers(deployment);
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
    if (!parent) return null;
    // Do not spin up replacement pods while an admission-denied pod exists.
    if (this.cluster.getChildren(parent.uid).some((child) => child.kind === 'Pod' && this._isPodBlocked(child))) {
      return null;
    }

    const podName = nameOverride || `${parent.name}-${this._randomSuffix()}`;
    const namespace = parent.metadata.namespace;
    // Create-only path: ClusterState.addResource() re-applies the supplied
    // status to an existing object, which used to reset a running pod to
    // Pending when a controller upserted the same name again (SIM-006).
    const existing = this.cluster.getByName('Pod', podName, namespace);
    if (existing) return existing;

    const template = templateSource.spec.template || {};
    const podSpec = deepClone(template.spec || {});
    podSpec.containers = podSpec.containers || [{
      name: 'main',
      image: 'app:latest',
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
    }];
    const selectorLabels = templateSource.spec?.selector?.matchLabels || {};
    const templateLabels = template.metadata?.labels || templateSource.metadata.labels || {};
    // The pod-template-hash must be identical on the ReplicaSet and all pods it
    // creates (it is the RS name suffix, not a per-pod random value).
    const templateHash = templateLabels['pod-template-hash'] || templateSource.metadata.labels?.['pod-template-hash'];
    const labels = { ...selectorLabels, ...templateLabels };
    if (templateHash) labels['pod-template-hash'] = templateHash;

    const pod = this.cluster.addResource({
      kind: 'Pod',
      metadata: { name: podName, namespace, labels },
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
    this.gameSeconds = 0;
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
