/**
 * SimulationTick.js — fixed-step controller loop for OpenShift Games.
 *
 * Extends the original Kubernetes simulation with OpenShift 4.22 controllers:
 *   - Project lifecycle (Active → Terminating → purged)
 *   - Route admission (Service endpoints → status.ingress Admitted condition)
 *   - BuildConfig → Build → ImageStream (+ ImageChange rollout triggers)
 *   - OLM Subscriptions (Installing → Succeeded) and operator effects
 *   - MetalLB IPAddressPool/L2Advertisement → Service EXTERNAL-IP
 *   - SCC admission before pod creation (ReplicaSet FailedCreate, no Pod)
 *   - kubelet image pulls (internal ImageStreamTag + registry pull failures →
 *     ErrImagePull/ImagePullBackOff), Deployment progress deadlines
 *   - OLM: PackageManifest catalog, Subscription → InstallPlan → CSV,
 *     CSV-owned operator Deployment, MetalLB operand CR lifecycle
 *   - NetworkPolicy traffic evaluation (ingress+egress, DNS on port 5353)
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
import { podSecurityRequest, runAsUserAllowed } from './RBACEngine.js';
import {
  validateCronSchedule,
  parseCronSchedule,
  nextCronOccurrence,
} from '../resources/WorkloadResources.js';
import { knownImageRuntimeFailure } from '../resources/ImageSecurityProfiles.js';
// The service-ca controller issues serving certificates with the same
// dependency-free PEM helpers that back the shell's simulated `openssl`
// commands (issue #32b/#33a), so `openssl x509` can read the resulting Secret.
import {
  createCertificateAuthority,
  createSelfSignedCertificate,
  createServiceSignedCertificate,
  parseCertificatePem,
} from '../ui/ShellTools.js';

/** Fixed controller timings in game seconds (1 tick = 0.05 s at 20 TPS). */
const BUILD_PHASE_NEW_SECONDS = 1;
const BUILD_PHASE_PENDING_SECONDS = 1;
const BUILD_PHASE_RUNNING_SECONDS = 6;
const SUBSCRIPTION_INSTALL_SECONDS = 8;
/** OLM install-plan/CSV step timings in game seconds (compressed vs. real OLM). */
const INSTALLPLAN_COMPLETE_SECONDS = 2;
const CSV_INSTALL_SECONDS = 5;
/** Socially-acceptable interval between duplicate FailedCreate events. */
const FAILED_CREATE_EVENT_SECONDS = 10;
/** How long a container keeps retrying before the state reports ImagePullBackOff. */
const IMAGE_PULL_RETRY_SECONDS = 2;

/**
 * Software catalog advertised by the simulated openshift-marketplace
 * (PackageManifest objects). Keep this list small: the objects are real cluster
 * resources and every seeded resource gets a 3D mesh.
 */
const OLM_CATALOG = [
  {
    // redhat-operators package name on OCP 4.x is `metallb-operator` (the CSV
    // inside it is still metallb-operator.v0.14.9) — issue #18.
    name: 'metallb-operator',
    displayName: 'MetalLB Operator',
    currentCSV: 'metallb-operator.v0.14.9',
    channel: 'stable',
    provider: 'Red Hat',
    description:
      'MetalLB is a load-balancer implementation for bare-metal clusters using standard routing protocols.',
    crds: [{ kind: 'MetalLB', name: 'metallbs.metallb.io', version: 'v1beta1' }],
  },
  {
    name: 'ansible-automation-platform-operator',
    displayName: 'Ansible Automation Platform',
    currentCSV: 'aap-operator.v2.6.0',
    channel: 'stable-2.6',
    provider: 'Red Hat',
    description: 'Deploys and manages Ansible Automation Platform instances.',
    crds: [],
  },
  {
    name: 'openshift-pipelines-operator-rh',
    displayName: 'Red Hat OpenShift Pipelines',
    currentCSV: 'openshift-pipelines-operator-rh.v1.18.0',
    channel: 'latest',
    provider: 'Red Hat',
    description: 'Tekton-based CI/CD pipelines for OpenShift.',
    crds: [],
  },
  {
    name: 'cert-manager-operator',
    displayName: 'cert-manager Operator for Red Hat OpenShift',
    currentCSV: 'cert-manager-operator.v1.17.0',
    channel: 'stable',
    provider: 'Red Hat',
    description: 'Automates certificate management with cert-manager on OpenShift.',
    crds: [],
  },
];

const OAUTH_ROLLOUT_SECONDS = 5;
const PROJECT_TERMINATION_SECONDS = 2;
/** Real nodes reserve kube/system resources, so allocatable < capacity. */
const RESERVED_CPU_MILLICORES = 250;
const RESERVED_MEMORY_MIB = 1024;

/**
 * Image references the simulated registries cannot resolve. A tag such as
 * `quay.io/openshift/origin-hello-openshift:does-not-exist` is exactly the L10
 * rolling-update scenario; `:not-found` is used by the DeploymentStuckRollout
 * incident. The token may appear ANYWHERE in the tag (`:v9-nope` is also
 * unpullable, issue #26); public images are otherwise assumed pullable.
 */
const IMAGE_PULL_FAILURE_TAG_RE =
  /(does-not-exist|doesnotexist|doesnt-exist|nonexistent|no-such|not-found|notfound|missing|invalid|bogus|nope|broken)/i;
const IMAGE_PULL_FAILURE_REPO_RE =
  /(^|[\/])(does-not-exist|doesnotexist|nonexistent|no-such-repo|missing-repo)([\/:.]|$)/i;

/** service-ca / router constants (issues #32c, #33a, #33b). */
const SERVING_CERT_ANNOTATION = 'service.beta.openshift.io/serving-cert-secret-name';
const INJECT_CABUNDLE_ANNOTATION = 'service.beta.openshift.io/inject-cabundle';
const INJECT_CABUNDLE_KEY = 'service-ca.crt';
const ROUTER_NAMESPACE = 'openshift-ingress';
const ROUTER_NAMESPACE_LABEL = 'policy-group.network.openshift.io/ingress';
const ROUTER_DEFAULT_IP = '172.30.0.20';
const ROUTER_404_BODY =
  '<html><body><h1>404 Not Found</h1>\nThe requested URL was not found on this server.</body></html>';
const ROUTER_503_BODY =
  '<html><body><h1>503 Service Unavailable</h1>\nNo server is available to handle this request.</body></html>';

/** Base64-encode UTF-8 text (Secret `data` values / CABundle keys). */
function base64EncodeText(text) {
  const value = String(text ?? '');
  try {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(value)));
  } catch {
    /* fall through */
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64');
  return value;
}

/** Decode a base64 Secret `data` value back to UTF-8 text. */
function base64DecodeText(value) {
  const raw = String(value ?? '');
  try {
    if (typeof atob === 'function') {
      const binary = atob(raw.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      return new TextDecoder().decode(bytes);
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    /* fall through */
  }
  return '';
}

/** Parse an absolute/relative HTTP URL (the workstation curl front end). */
function parseHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    return {
      scheme: parsed.protocol.replace(/:$/, '').toLowerCase(),
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : null,
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
    };
  } catch {
    return null;
  }
}

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
    /**
     * Virtual wall-clock anchor. CronJob schedules (and `status.lastScheduleTime`)
     * are computed against `_simEpoch + gameSeconds*1000`, so a schedule fires
     * after its scheduled amount of *simulated* time and time scaling applies.
     */
    this._simEpoch = Date.now();
    /** OLM state kept outside the resource objects (reconcile bookkeeping). */
    this._olmOperatorDeployments = new Map();
    this._olmCatalogEnsuredAt = -Infinity;
    /** MetalLB operand resources created by the operator (uid → kind/ns). */
    this._metallbOperands = new Map();
    /** Known CSVs (uid → {name, namespace, packageName}) for uninstall cleanup. */
    this._knownCSVs = new Map();
    this._lastCronTickAt = -Infinity;

    if (eventBus) {
      eventBus.on('cluster:deleted:Pod', (data) => {
        const pod = data.resource;
        if (pod && pod.metadata.ownerReferences.length > 0) {
          const ownerKey =
            pod.metadata.ownerReferences[0]?.uid || pod.metadata.ownerReferences[0]?.name;
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
      // OCP 4.x SCC grants are (Cluster)RoleBindings to
      // system:openshift:scc:<name>; re-evaluate when those change.
      for (const eventName of [
        'cluster:added:RoleBinding',
        'cluster:modified:RoleBinding',
        'cluster:deleted:RoleBinding',
        'cluster:added:ClusterRoleBinding',
        'cluster:modified:ClusterRoleBinding',
        'cluster:deleted:ClusterRoleBinding',
        'scc:granted',
        'scc:revoked',
      ]) {
        eventBus.on(eventName, () => {
          this._sccDirty = true;
        });
      }

      // OLM uninstall: deleting the CSV removes the operator Deployment that
      // the CSV's install strategy created (the Subscription does NOT).
      eventBus.on('cluster:deleted:ClusterServiceVersion', (data) => {
        this._onCSVDeleted(data?.resource || data);
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
    this._tickImagePulls(dt);
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
    this._tickServiceCA();
    this._tickSCC(dt);
    this._ensureOLMDefaults();
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
      const terminating =
        project.status.phase === 'Terminating' || project.metadata.deletionTimestamp !== null;
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
        cpuPercent:
          alloc.cpu.capacity > 0 ? Math.round((alloc.cpu.used / alloc.cpu.capacity) * 100) : 0,
        memoryPercent:
          alloc.memory.capacity > 0
            ? Math.round((alloc.memory.used / alloc.memory.capacity) * 100)
            : 0,
      };

      const isReady = node.status.phase !== 'NotReady' && node.status.phase !== 'Unknown';
      node.setCondition(
        'Ready',
        isReady ? 'True' : 'False',
        isReady ? 'KubeletReady' : 'KubeletNotReady'
      );
      const freeMemory = alloc.memory.capacity - alloc.memory.used;
      const memoryEvictionThreshold = Math.min(
        RESERVED_MEMORY_MIB,
        Math.max(100, alloc.memory.capacity * 0.1)
      );
      node.setCondition(
        'MemoryPressure',
        freeMemory < memoryEvictionThreshold ? 'True' : 'False',
        freeMemory < memoryEvictionThreshold
          ? 'KubeletHasInsufficientMemory'
          : 'KubeletHasSufficientMemory'
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
      (pod) =>
        pod.status.phase === 'Pending' &&
        !pod.spec.nodeName &&
        !pod.isDeleting &&
        !this._isPodBlocked(pod)
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
      if (
        pod.status.phase !== 'Pending' ||
        !pod.spec.nodeName ||
        pod.isDeleting ||
        this._isPodBlocked(pod)
      )
        continue;
      if (pod._nodeBound) continue; // already bound; kubelet owns it now
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

  /**
   * Bind a Pending pod to a node (shared by the scheduler and DaemonSet
   * controller). The kubelet still has to pull images and start containers:
   * the phase only becomes Running in {@link _tickImagePulls} once every image
   * pull succeeds (an unpullable image leaves the Pod Pending in
   * ErrImagePull/ImagePullBackOff, exactly like a real cluster).
   */
  _schedulePodOnNode(pod, node) {
    if (pod._nodeBound) return pod;
    pod._nodeBound = true;
    pod.spec.nodeName = node.metadata.name;
    pod.status.startTime = pod.status.startTime || new Date().toISOString();
    pod.status.hostIP = node.status.addresses?.[0]?.address || '10.0.0.1';
    pod.status.podIP = pod.status.podIP || this._generatePodIP();
    pod.setCondition(
      'PodScheduled',
      'True',
      'Scheduled',
      `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`
    );
    pod.setCondition('Initialized', 'True', 'PodInitialized');
    pod.setCondition(
      'Ready',
      'False',
      'ContainersNotReady',
      'containers with unready status: [' +
        (pod.spec.containers || []).map((container) => container.name).join(' ') +
        ']'
    );
    this._trackRescheduledPod(pod);
    pod.recordEvent(
      'Normal',
      'Scheduled',
      `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`
    );
    this._initContainerStatuses(pod);
    pod.status.phase = 'Pending';
    this.cluster.update(pod.uid, pod);
    return pod;
  }

  /**
   * Kubelet image-pull controller. Bound pods stay Pending until every
   * container image can be pulled; failures surface as ErrImagePull then
   * ImagePullBackOff container states + kubelet events, never as Running pods.
   */
  _tickImagePulls(dt) {
    const pendingPods = this.cluster
      .getByKind('Pod')
      .filter(
        (pod) =>
          pod.status.phase === 'Pending' &&
          pod._nodeBound &&
          !pod.isDeleting &&
          !this._isPodBlocked(pod) &&
          !this._isIncidentControlled(pod)
      );
    for (const pod of pendingPods) {
      if (pod._imagePullDone) continue;
      // Kubelet retries failed pulls on backoff; once the image/tag appears the
      // Pod recovers instead of being stuck in ImagePullBackOff forever. While
      // waiting for the next retry the state escalates ErrImagePull ->
      // ImagePullBackOff like a real kubelet (describe/get STATUS).
      const retryDue =
        !pod._imagePullFailed ||
        typeof pod._nextImagePullRetryAt !== 'number' ||
        this.gameSeconds >= pod._nextImagePullRetryAt;
      if (!retryDue) {
        let changed = false;
        for (const status of pod.status.containerStatuses || []) {
          const waitingReason = status.state?.waiting?.reason;
          if (waitingReason === 'ErrImagePull') {
            status.state = {
              waiting: { reason: 'ImagePullBackOff', message: status.state.waiting.message },
            };
            changed = true;
          }
        }
        if (changed) this.cluster.update(pod.uid, pod);
        continue;
      }
      const containers = pod.spec.containers || [];
      if (containers.length === 0) continue;
      if (
        !pod.status.containerStatuses ||
        pod.status.containerStatuses.length !== containers.length
      ) {
        this._initContainerStatuses(pod);
      }
      const results = containers.map((container) => this._resolveContainerImagePull(container));
      const failure = results.find((result) => !result.ok);
      if (!failure) {
        pod._imagePullDone = true;
        pod._imagePullFailed = false;
        pod._nextImagePullRetryAt = undefined;
        // Containers restart from ContainerCreating before the kubelet starts
        // them (the previous waiting reason may have been ImagePullBackOff).
        this._initContainerStatuses(pod);
        pod.status.phase = 'Running';
        pod.setCondition(
          'Ready',
          'False',
          'ContainersNotReady',
          'containers with unready status: [' +
            containers.map((container) => container.name).join(' ') +
            ']'
        );
        pod.recordEvent(
          'Normal',
          'Pulled',
          `Successfully pulled image "${containers[0]?.image || ''}"`
        );
        this.cluster.update(pod.uid, pod);
        continue;
      }

      const message = failure.message || 'manifest unknown';
      pod._imagePullFailed = true;
      pod._nextImagePullRetryAt = this.gameSeconds + 10;
      if (typeof pod._imagePullFailedAt !== 'number') pod._imagePullFailedAt = this.gameSeconds;
      const backoff = this.gameSeconds - pod._imagePullFailedAt >= IMAGE_PULL_RETRY_SECONDS;
      const reason = backoff ? 'ImagePullBackOff' : 'ErrImagePull';
      for (let index = 0; index < pod.status.containerStatuses.length; index++) {
        const status = pod.status.containerStatuses[index];
        const containerFailure = results[index] && !results[index].ok ? results[index] : null;
        if (!containerFailure) continue;
        status.ready = false;
        status.started = false;
        status.state = { waiting: { reason, message: containerFailure.message } };
      }
      pod.setCondition(
        'Ready',
        'False',
        'ContainersNotReady',
        `containers with unready status: [${containers.map((container) => container.name).join(' ')}]`
      );
      // kubectl/oc describe show ErrImagePull first, then the exponential
      // ImagePullBackOff retries — throttle duplicate events like a real kubelet.
      const nextLog = pod._imagePullNextEventAt;
      if (typeof nextLog !== 'number' || this.gameSeconds >= nextLog) {
        if (!backoff) {
          pod.recordEvent(
            'Warning',
            'Failed',
            `Failed to pull image "${failure.image}": ${message}`
          );
        } else {
          pod.recordEvent('Normal', 'BackOff', `Back-off pulling image "${failure.image}"`);
          if (!pod._imagePullBackOffLogged) {
            pod._imagePullBackOffLogged = true;
            pod.recordEvent('Warning', 'Failed', `Error: ImagePullBackOff`);
          }
        }
        pod._imagePullNextEventAt = this.gameSeconds + 10;
      }
      this.cluster.update(pod.uid, pod);
    }
  }

  /**
   * Would the container image pull succeed? Mirrors the interesting failure
   * modes of a real cluster:
   *   - internal registry: the ImageStreamTag must exist and have a digest;
   *   - external registries: a small set of obviously-missing references
   *     (does-not-exist / not-found tags, missing repositories) fails, while
   *     public images are assumed pullable (the simulator has no registry).
   * @param {object} container
   * @returns {{ok: boolean, image: string, message?: string}}
   */
  _resolveContainerImagePull(container) {
    const image = String(container?.image || '').trim();
    if (!image) return { ok: false, image, message: 'invalid reference format: image is required' };
    const internal = this._parseInternalImageReference(image);
    if (internal) {
      const resolved = this.cluster.resolveImageStreamTag(
        internal.namespace,
        internal.name,
        internal.tag
      );
      const available = Boolean(resolved.found && (resolved.tagEntry?.items || []).length > 0);
      if (!available) {
        return {
          ok: false,
          image,
          message: `reading manifest ${internal.tag} in repository ${internal.namespace}/${internal.name}: manifest unknown`,
        };
      }
      return { ok: true, image };
    }
    const lastSlash = image.lastIndexOf('/');
    const lastColon = image.lastIndexOf(':');
    const tag = lastColon > lastSlash ? image.slice(lastColon + 1) : '';
    const repository = tag ? image.slice(0, lastColon) : image;
    const badTag = IMAGE_PULL_FAILURE_TAG_RE.test(tag) ? tag : '';
    const badRepoMatch = repository.match(IMAGE_PULL_FAILURE_REPO_RE);
    if (badTag || badRepoMatch) {
      return {
        ok: false,
        image,
        message: `failed to resolve reference "${image}": manifest unknown`,
      };
    }
    return { ok: true, image };
  }

  /**
   * Parse an internal-registry pull spec
   * (`image-registry.openshift-image-registry.svc:5000/ns/stream:tag`).
   * @returns {{namespace: string, name: string, tag: string}|null}
   */
  _parseInternalImageReference(image) {
    const hosts = [
      IMAGE_REGISTRY_HOST,
      'image-registry.openshift-image-registry.svc',
      'docker-registry.default.svc:5000',
    ];
    for (const host of hosts) {
      if (!image.startsWith(`${host}/`)) continue;
      let remainder = image.slice(host.length + 1);
      let digest = '';
      const atIndex = remainder.indexOf('@');
      if (atIndex >= 0) {
        digest = remainder.slice(atIndex + 1);
        remainder = remainder.slice(0, atIndex);
      }
      const parts = remainder.split('/');
      if (parts.length < 2) return null;
      const name = parts[parts.length - 1];
      const namespace = parts[parts.length - 2];
      let tag = digest ? digest : 'latest';
      const colonIndex = name.lastIndexOf(':');
      let streamName = name;
      if (colonIndex > 0) {
        streamName = name.slice(0, colonIndex);
        tag = name.slice(colonIndex + 1);
      }
      return { namespace, name: streamName, tag };
    }
    return null;
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
    const requiredAffinity =
      pod.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
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
        if (!tolerations.some((toleration) => this._toleratesTaint(toleration, taint)))
          score -= 0.1;
      }

      if (pod.spec.affinity?.nodeAffinity?.preferredDuringScheduling) {
        for (const preference of pod.spec.affinity.nodeAffinity.preferredDuringScheduling) {
          const matchLabels =
            preference.matchLabels ||
            preference.preference?.matchExpressions?.reduce((acc, expression) => {
              if (expression.operator === 'In' && expression.values?.length)
                acc[expression.key] = expression.values[0];
              return acc;
            }, {}) ||
            {};
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
    if (!node.matchesSelector(pod.spec.nodeSelector || {}))
      return "node(s) didn't match Pod's node selector";
    const requiredAffinity =
      pod.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
    if (requiredAffinity && !this._nodeMatchesRequiredAffinity(node, requiredAffinity))
      return "node(s) didn't match Pod's node affinity";
    const taint = this._firstUntoleratedNoScheduleTaint(pod, node);
    if (taint) return `node(s) had untolerated taint {${taint.key}: ${taint.value ?? ''}}`;
    const available = this._nodeAvailableForScheduling(node);
    if (!available) return 'node(s) were unschedulable';
    const podLimit = parseInt(
      node.status.allocatable?.pods || node.status.capacity?.pods || '110',
      10
    );
    if (Number.isFinite(podLimit) && available.podCount >= podLimit) return 'Too many pods';
    if (this._hasHostPortConflict(node, pod))
      return "node(s) didn't have free ports for the requested pod ports";
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
    return detail
      ? `0/${total} nodes are available: ${detail}.`
      : `0/${total} nodes are available: no node matched the pod requirements.`;
  }

  /** Available resources on a node for scheduling (static allocatable - usage). */
  _nodeAvailableForScheduling(node) {
    const alloc = this.cluster.getNodeAllocatable(node.metadata.name);
    if (!alloc) return null;
    const capacityCpu = alloc.cpu.capacity - Math.min(RESERVED_CPU_MILLICORES, alloc.cpu.capacity);
    const capacityMemory =
      alloc.memory.capacity - Math.min(RESERVED_MEMORY_MIB, alloc.memory.capacity);
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
      return (
        expressions.every((expression) =>
          this._labelsMatchExpression(node.metadata.labels || {}, expression)
        ) && fields.every((expression) => this._nodeFieldMatchesExpression(node, expression))
      );
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

  /** True for Pods the IncidentEngine is actively managing (damaged state). */
  _isIncidentControlled(pod) {
    return Boolean(pod?.metadata?.annotations?.['openshiftgames.io/incident']);
  }

  /** Does an SCC's runAsUser strategy permit UID 0? (anyuid/privileged yes,
   * restricted-v2/nonroot no). Used by the known-root-image runtime model. */
  _sccAllowsUidZero(scc) {
    if (!scc) return false;
    return runAsUserAllowed(scc.spec?.runAsUser, 0);
  }

  /**
   * The SCC that admitted a Pod. `openshift.io/scc` is written by `_tickSCC` for
   * every admitted Pod; a Pod created between controller ticks (bare `oc run`)
   * is resolved exactly like admission would, without mutating anything.
   * @param {object} pod
   * @returns {object|null}
   */
  _podScc(pod) {
    const admittedName = pod?.metadata?.annotations?.['openshift.io/scc'];
    if (admittedName) {
      const admitted = this.cluster.getSCC(admittedName);
      if (admitted) return admitted;
    }
    const resolution = this.cluster.resolveSCCForPod(pod);
    return resolution.allowed ? resolution.scc : null;
  }

  /**
   * Known root-image personality at runtime (issue #25): an image that starts as
   * UID 0 (nginx) is happily ADMITTED by a non-root SCC — admission only checks
   * the explicit pod spec — but the container cannot run with the arbitrary UID
   * and exits immediately with "Permission denied". Returns the image runtime
   * failure persona when the Pod is in that state, otherwise null.
   *
   * @param {object} pod
   * @param {object} container
   * @returns {{exitCode: number, lastStateReason: string, logLines: string[]}|null}
   */
  _knownRootImageRuntimeFailure(pod, container) {
    const failure = knownImageRuntimeFailure(container?.image);
    if (!failure) return null;
    const scc = this._podScc(pod);
    if (!scc) return null;
    // anyuid/privileged admit the root UID the image expects: it runs normally.
    if (this._sccAllowsUidZero(scc)) return null;
    return failure;
  }

  /**
   * Model the kubelet-side crash of a known root image admitted under a non-root
   * SCC: the container terminates (exit 1, Permission denied), the Pod keeps its
   * Running phase with a CrashLoopBackOff container state, the restart count
   * grows on every kubelet retry and the crash output is available to
   * `oc logs` / `oc logs --previous` (issue #25).
   */
  _crashKnownRootImageContainer(pod, status, failure) {
    const now = new Date().toISOString();
    status.restartCount = (status.restartCount || 0) + 1;
    status.ready = false;
    status.started = false;
    status.lastState = {
      terminated: {
        exitCode: failure.exitCode ?? 1,
        reason: failure.lastStateReason || 'Error',
        startedAt: now,
        finishedAt: now,
      },
    };
    status.state = { waiting: { reason: 'CrashLoopBackOff' } };
    const lines = Array.isArray(failure.logLines) ? failure.logLines : [];
    if (lines.length > 0) {
      // The CLI renders these annotations for `oc logs`/`oc logs --previous`
      // (same mechanism as the IncidentEngine's scripted crash logs).
      pod.setAnnotation('openshiftgames.io/logs', JSON.stringify(lines));
      pod.setAnnotation('openshiftgames.io/logs-previous', JSON.stringify(lines));
      pod.setAnnotation('openshiftgames.io/logs-container', status.name);
    }
    // Real kubelet BackOff events are aggregated; throttle duplicates the same
    // way the FailedCreate recorder does.
    const previousEventAt = pod._knownImageCrashEventAt;
    if (typeof previousEventAt !== 'number' || this.gameSeconds - previousEventAt >= 10) {
      pod._knownImageCrashEventAt = this.gameSeconds;
      pod.recordEvent(
        'Warning',
        'BackOff',
        `Back-off restarting failed container ${status.name} in pod ${pod.metadata.name}_${pod.metadata.namespace || 'default'}`
      );
    }
    this.cluster.update(pod.uid, pod);
  }

  _tickPodLifecycle(dt) {
    const runningPods = this.cluster
      .getByKind('Pod')
      .filter((pod) => pod.status.phase === 'Running' && !this._isIncidentControlled(pod));
    for (const pod of runningPods) {
      if (!pod.status.containerStatuses) continue;
      const containers = pod.spec.containers || [];
      let allReady = true;
      let anyRunning = false;

      for (let index = 0; index < pod.status.containerStatuses.length; index++) {
        const status = pod.status.containerStatuses[index];
        const container = containers[index] || {};
        // Known root images admitted by a non-root SCC crash as soon as the
        // container starts (issue #25): nginx is admitted under restricted-v2
        // and immediately exits with Permission denied. The retry loop is the
        // normal CrashLoopBackOff one; only actual start attempts crash.
        const runtimeFailure = this._knownRootImageRuntimeFailure(pod, container);
        if (
          runtimeFailure &&
          (status.state.running || status.state.waiting?.reason === 'ContainerCreating')
        ) {
          this._crashKnownRootImageContainer(pod, status, runtimeFailure);
          allReady = false;
          continue;
        }
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
      pod.setCondition(
        'ContainersReady',
        'False',
        'ContainersNotReady',
        `container ${status.name} ${String(reason).toLowerCase()}`
      );
      pod.setCondition(
        'Ready',
        'False',
        'ContainersNotReady',
        `container ${status.name} ${String(reason).toLowerCase()}`
      );
      pod.recordEvent(
        'Warning',
        reason === 'OOMKilled' ? 'OOMKilled' : 'Failed',
        `Container ${status.name} failed (${reason}) with restartPolicy: Never`
      );
    } else {
      status.state = { waiting: { reason: 'CrashLoopBackOff' } };
      pod.recordEvent('Warning', 'BackOff', `Back-off restarting failed container ${status.name}`);
    }
    return status;
  }

  _tickContainerResources(dt) {
    const failureRate = this._effectiveFailureRatePerSecond();
    const runningPods = this.cluster
      .getByKind('Pod')
      .filter(
        (pod) =>
          pod.status.phase === 'Running' &&
          pod.status.containerStatuses &&
          !this._isIncidentControlled(pod)
      );
    for (const pod of runningPods) {
      for (const status of pod.status.containerStatuses) {
        if (!status.state.running) continue;
        const baseLoad = status.resources.cpuRequest * 0.6;
        const variance = status.resources.cpuRequest * 0.3;
        status.resources.cpu = Math.max(0, baseLoad + (Math.random() - 0.5) * variance);
        // Smoothed CPU sample (HPA/metrics read an averaged window, not a
        // single instantaneous sample; avoids noise-driven rescales).
        status._cpuSmooth =
          status._cpuSmooth === undefined
            ? status.resources.cpu
            : status._cpuSmooth * 0.9 + status.resources.cpu * 0.1;
        const memBase = status.resources.memoryRequest * 0.7;
        const memGrowth = status.resources.memoryRequest * 0.01 * Math.random();
        // Synthetic memory creeps up but must not exceed a configured limit on
        // its own: a healthy Guaranteed pod should not OOM just because time
        // passed (SIM-027). Chaos/incidents can still push it over the limit.
        const memoryCeiling =
          status.resources.memoryLimit > 0
            ? status.resources.memoryLimit * 0.95
            : status.resources.memoryRequest * 2;
        status.resources.memory = Math.min(
          memoryCeiling,
          memBase +
            memGrowth +
            (status.resources.memory > memBase ? (status.resources.memory - memBase) * 0.99 : 0)
        );

        if (failureRate > 0 && Math.random() < failureRate * dt) {
          this._handleContainerFailure(pod, status, 'Error', 1);
        }
      }
    }
  }

  _tickHealthChecks(dt) {
    const runningPods = this.cluster
      .getByKind('Pod')
      .filter(
        (pod) =>
          pod.status.phase === 'Running' &&
          pod.status.containerStatuses &&
          !this._isIncidentControlled(pod)
      );
    for (const pod of runningPods) {
      const containers = pod.spec.containers || [];
      for (let index = 0; index < containers.length; index++) {
        const container = containers[index];
        const status = pod.status.containerStatuses[index];
        if (!status || !status.state.running) continue;

        if (container.livenessProbe && !this._evaluateProbe(container.livenessProbe, status)) {
          this._handleContainerFailure(pod, status, 'LivenessProbeFailure', 137);
          pod.recordEvent(
            'Warning',
            'Unhealthy',
            `Liveness probe failed for container ${status.name}`
          );
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
            pod.recordEvent(
              'Warning',
              'Unhealthy',
              `Readiness probe failed for container ${status.name}`
            );
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
    const cpuOverloaded =
      containerStatus.resources.cpu > containerStatus.resources.cpuLimit * 0.95 &&
      containerStatus.resources.cpuLimit > 0;
    const memOverloaded =
      containerStatus.resources.memory > containerStatus.resources.memoryLimit * 0.95 &&
      containerStatus.resources.memoryLimit > 0;
    if (cpuOverloaded || memOverloaded) {
      containerStatus._probeFailCount = (containerStatus._probeFailCount || 0) + 1;
      return containerStatus._probeFailCount < failThreshold;
    }
    containerStatus._probeFailCount = 0;
    return true;
  }

  _tickOOMKiller(dt) {
    const runningPods = this.cluster
      .getByKind('Pod')
      .filter(
        (pod) =>
          pod.status.phase === 'Running' &&
          pod.status.containerStatuses &&
          !this._isIncidentControlled(pod)
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
      return Array.isArray(parsed)
        ? parsed.filter((entry) => entry && typeof entry === 'object')
        : [];
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
      const from =
        trigger.from || trigger.imageChangeParams?.from || trigger.imageChange?.from || {};
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
      for (const name of trigger.imageChangeParams?.containerNames ||
        trigger.containerNames ||
        []) {
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
        deployment.spec.template.metadata.annotations =
          deployment.spec.template.metadata.annotations || {};
        deployment.spec.template.metadata.annotations['openshiftgames/image-trigger'] =
          `${streamName}:${tag}@${token}`;
      }
      changed = true;
      changedTag = `${streamName}:${tag}`;
    }

    if (!changed) return;
    deployment.metadata.generation = (Number(deployment.metadata.generation) || 1) + 1;
    deployment.setCondition(
      'Progressing',
      'True',
      'ReplicaSetUpdated',
      changedTag ? `image change ${changedTag}` : 'image change'
    );
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
    const template = deepClone(
      deploy.spec.template || { spec: { containers: [{ name: 'main', image: 'app:latest' }] } }
    );
    const templateHash = this._templateHash(template);
    const selector = deepClone(deploy.spec.selector?.matchLabels || deploy.metadata.labels || {});
    const strategy = deploy.spec.strategy || {};
    const strategyType = strategy.type || 'RollingUpdate';
    const maxSurge = this._resolveStrategyNumber(
      strategy.rollingUpdate?.maxSurge,
      desiredReplicas,
      'surge'
    );
    const maxUnavailable = this._resolveStrategyNumber(
      strategy.rollingUpdate?.maxUnavailable,
      desiredReplicas,
      'unavailable'
    );
    const minReadySeconds = Math.max(0, Number(deploy.spec.minReadySeconds) || 0);
    const progressDeadlineSeconds = Math.max(1, Number(deploy.spec.progressDeadlineSeconds) || 600);
    const revisionHistoryLimit = Number.isFinite(Number(deploy.spec.revisionHistoryLimit))
      ? Number(deploy.spec.revisionHistoryLimit)
      : 10;
    const paused = deploy.spec.paused === true;

    // The controller derives everything from ReplicaSet/template state, never
    // from GameEngine's imperative `_rollout` hint.
    delete deploy._rollout;

    const ownedSets = this.cluster
      .getChildren(deploy.uid)
      .filter((child) => child.kind === 'ReplicaSet');
    let currentSet =
      ownedSets.find((rs) => rs.metadata.labels?.['pod-template-hash'] === templateHash) || null;
    const oldSets = ownedSets.filter((rs) => rs !== currentSet);
    const templateChanged = !currentSet;
    const status = {
      desiredReplicas,
      minReadySeconds,
      maxUnavailable,
      maxSurge,
      paused,
      strategyType,
      templateHash,
      currentSet,
      ownedSets,
    };

    if (templateChanged && paused) {
      // A paused Deployment must not start a new rollout.
      for (const rs of ownedSets) this._reconcileReplicaSet(rs, undefined, minReadySeconds);
      this._updateDeploymentStatus(deploy, status, { rolloutPending: true });
      return;
    }
    if (templateChanged) {
      currentSet = this._createDeploymentReplicaSet(
        deploy,
        template,
        templateHash,
        selector,
        ownedSets
      );
      if (currentSet && !ownedSets.includes(currentSet)) ownedSets.push(currentSet);
      status.currentSet = currentSet;
      status.ownedSets = ownedSets;
    }

    // Reconcile a pre-existing ReplicaSet (legacy/saved state) whose template
    // no longer matches its hash label.
    if (
      currentSet &&
      this._stableStringify(currentSet.spec.template || {}) !== this._stableStringify(template)
    ) {
      currentSet.spec.template = deepClone(template);
      this.cluster.update(currentSet.uid, currentSet);
    }

    const activeOld = oldSets.reduce((sum, rs) => sum + this._activePodsOf(rs).length, 0);
    const activeCurrent = currentSet ? this._activePodsOf(currentSet).length : 0;

    if (paused) {
      for (const rs of [currentSet, ...oldSets])
        if (rs) this._reconcileReplicaSet(rs, undefined, minReadySeconds);
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
        // Real Deployment controller math (reconcileOldReplicaSets):
        //   maxScaledDown = allPodsCount - minAvailable - newRSUnavailablePods
        // where newRSUnavailablePods are the new ReplicaSet's pods that are not
        // yet available. This is what keeps the old ReplicaSet serving when the
        // new image cannot be pulled (issue #7) and what removes the failed
        // ReplicaSet's leftovers after `oc rollout undo`.
        const minAvailable = Math.max(0, desiredReplicas - maxUnavailable);
        const newSetSpecReplicas = Math.max(0, Number(currentSet?.spec.replicas ?? 0) || 0);
        const newUnavailable = Math.max(
          0,
          newSetSpecReplicas -
            (currentSet ? this._readyPodsOf(currentSet, minReadySeconds).length : 0)
        );
        const allPodsCount = activeOld + Math.max(activeCurrent, newSetSpecReplicas);
        const maxScaledDown = allPodsCount - minAvailable - newUnavailable;
        if (maxScaledDown > 0) {
          let remaining = maxScaledDown;
          const victims = oldSets
            .filter((rs) => this._activePodsOf(rs).length > 0)
            .sort((a, b) => this._replicaSetRevision(a) - this._replicaSetRevision(b));
          for (const victim of victims) {
            if (remaining <= 0) break;
            const active = this._activePodsOf(victim).length;
            const remove = Math.min(remaining, active);
            this._reconcileReplicaSet(victim, active - remove, minReadySeconds);
            remaining -= remove;
          }
        }
      }
      for (const rs of oldSets) {
        if (rs.spec.replicas !== 0 && this._activePodsOf(rs).length === 0)
          this._reconcileReplicaSet(rs, 0, minReadySeconds);
      }
    }

    const rolloutPending =
      this._activePodsOf(currentSet).length < desiredReplicas ||
      oldSets.some((rs) => this._activePodsOf(rs).length > 0);
    this._updateDeploymentStatus(deploy, status, { rolloutPending });
    this._pruneDeploymentReplicaSets(deploy, status, revisionHistoryLimit);
  }

  /** Create (or refresh) the ReplicaSet for a Deployment template revision. */
  _createDeploymentReplicaSet(deploy, template, templateHash, selector, ownedSets) {
    const namespace = deploy.metadata.namespace;
    const name = `${deploy.metadata.name}-${templateHash}`;
    let revision =
      ownedSets.reduce((max, rs) => Math.max(max, this._replicaSetRevision(rs)), 0) + 1;
    let rs = this.cluster.getByName('ReplicaSet', name, namespace);
    if (!rs) {
      // Real Deployment controller copies the Deployment's annotations onto each
      // new ReplicaSet, which is where `oc rollout history` reads
      // kubernetes.io/change-cause from.
      const changeCause =
        deploy.metadata?.annotations?.['kubernetes.io/change-cause'] ||
        template?.metadata?.annotations?.['kubernetes.io/change-cause'] ||
        '';
      const rsAnnotations = { 'deployment.kubernetes.io/revision': String(revision) };
      if (changeCause) rsAnnotations['kubernetes.io/change-cause'] = changeCause;
      rs = this.cluster.addResource({
        kind: 'ReplicaSet',
        metadata: {
          name,
          namespace,
          labels: { ...selector, 'pod-template-hash': templateHash },
          annotations: rsAnnotations,
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
    const currentRevision =
      parseInt(deploy.metadata.annotations['deployment.kubernetes.io/revision'] || '0', 10) || 0;
    revision = Math.max(revision, currentRevision + 1);
    deploy.metadata.annotations['deployment.kubernetes.io/revision'] = String(revision);
    rs.metadata.annotations = rs.metadata.annotations || {};
    rs.metadata.annotations['deployment.kubernetes.io/revision'] = String(revision);
    this.cluster.updateMetadata(deploy.uid, {
      annotations: { 'deployment.kubernetes.io/revision': String(revision) },
    });
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
    // A ReplicaSet scaled to zero is no longer trying (and failing) to create
    // Pods: drop its stale ReplicaFailure condition so a fixed Deployment does
    // not keep reporting the old admission failure (#25 fix path).
    if (rs.spec.replicas === 0) this._clearReplicaFailure(rs);
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
      for (let index = 0; index < pods.length - target; index++)
        this.cluster.remove(sorted[index].uid);
    }
    this._refreshReplicaSetStatus(rs, this._activePodsOf(rs), minReadySeconds);
  }

  _refreshReplicaSetStatus(rs, pods, minReadySeconds = 0) {
    const ready = pods.filter((pod) => this._podIsReady(pod, minReadySeconds));
    rs.status.replicas = pods.length;
    rs.status.fullyLabeledReplicas = pods.filter(
      (pod) =>
        pod.metadata.labels?.['pod-template-hash'] === rs.metadata.labels?.['pod-template-hash']
    ).length;
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
    // Admission rejections no longer create Failed Pod objects (issue #13):
    // the ReplicaSet carries a ReplicaFailure/FailedCreate condition instead.
    // The legacy denied-Pod scan is kept for pre-existing/incident pods.
    const deniedPods = ownedSets
      .flatMap((rs) => this.cluster.getChildren(rs.uid))
      .filter((child) => child.kind === 'Pod' && this._isPodBlocked(child));
    const failingSets = ownedSets.filter((rs) => this._hasReplicaFailure(rs));
    const replicaFailure =
      failingSets.length > 0
        ? (failingSets[0].status.conditions || []).find(
            (condition) => condition.type === 'ReplicaFailure'
          )
        : null;
    const admissionBlocked = Boolean(replicaFailure) || deniedPods.length > 0;
    const admissionMessage =
      replicaFailure?.message ||
      deniedPods[0]?.metadata?.annotations?.['openshiftgames/denied-reason'] ||
      '';
    const oldSetPods = ownedSets
      .filter((rs) => rs !== currentSet)
      .reduce((sum, rs) => sum + this._activePodsOf(rs).length, 0);
    const rolloutPending =
      flags.rolloutPending === true ||
      oldSetPods > 0 ||
      currentPods.length < desiredReplicas ||
      (currentSet &&
        this._stableStringify(currentSet.spec.template || {}) !==
          this._stableStringify(deploy.spec.template || {}));

    const previousSignature = deploy._deploymentStatusSignature;
    const progressDeadlineSeconds = Math.max(1, Number(deploy.spec.progressDeadlineSeconds) || 600);
    const progressing = !paused && (admissionBlocked || rolloutPending);
    deploy.status.replicas = allPods.length;
    // Deployment.status.readyReplicas counts every ready Pod of the Deployment
    // (old + new ReplicaSets), like a real cluster.
    deploy.status.readyReplicas = readyAll.length;
    deploy.status.availableReplicas = available;
    deploy.status.updatedReplicas = currentPods.length;
    deploy.status.unavailableReplicas = Math.max(0, desiredReplicas - available);
    deploy.status.observedGeneration = deploy.metadata.generation;
    if (progressing && typeof deploy._progressingSince !== 'number')
      deploy._progressingSince = this.gameSeconds;
    if (!progressing) deploy._progressingSince = undefined;
    const timedOut =
      progressing &&
      typeof deploy._progressingSince === 'number' &&
      this.gameSeconds - deploy._progressingSince >= progressDeadlineSeconds;

    if (admissionBlocked) {
      deploy.setCondition(
        'Available',
        'False',
        'MinimumReplicasUnavailable',
        `${available}/${desiredReplicas} replicas available`
      );
      deploy.setCondition(
        'Progressing',
        timedOut ? 'False' : 'True',
        timedOut ? 'ProgressDeadlineExceeded' : 'ReplicaSetUpdated',
        timedOut
          ? `ReplicaSet "${currentSet?.metadata?.name || 'new'}" has timed out progressing.`
          : `waiting for pods to be admitted: ${admissionMessage}`
      );
      deploy.setCondition(
        'ReplicaFailure',
        'True',
        'FailedCreate',
        admissionMessage || 'unable to admit pod'
      );
    } else {
      deploy.setCondition('ReplicaFailure', 'False', 'NoReplicaFailure', '');
      if (paused) {
        deploy.setCondition(
          'Progressing',
          'True',
          'DeploymentPaused',
          'deployment is paused; rollout will not continue until resumed'
        );
        deploy.setCondition(
          'Available',
          available >= Math.min(desiredReplicas, minAvailable) ? 'True' : 'False',
          available >= Math.min(desiredReplicas, minAvailable)
            ? 'MinimumReplicasAvailable'
            : 'MinimumReplicasUnavailable',
          `${available}/${desiredReplicas} replicas available`
        );
      } else if (rolloutPending) {
        if (timedOut) {
          deploy.setCondition(
            'Progressing',
            'False',
            'ProgressDeadlineExceeded',
            `ReplicaSet "${currentSet?.metadata?.name || 'new'}" has timed out progressing.`
          );
        } else {
          deploy.setCondition(
            'Progressing',
            'True',
            'ReplicaSetUpdated',
            `${readyCurrent.length} out of ${desiredReplicas} new replicas have been updated`
          );
        }
        deploy.setCondition(
          'Available',
          available >= minAvailable ? 'True' : 'False',
          available >= minAvailable ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable',
          `${available}/${desiredReplicas} replicas available`
        );
      } else {
        // The rollout has no pending ReplicaSet scale-up, but the Deployment can
        // still be unhealthy (crash-looping / unschedulable / unready Pods).
        // Real clusters only report MinimumReplicasAvailable when enough
        // replicas are actually available (issue #23: `0 available | 3
        // unavailable` must read Available False MinimumReplicasUnavailable).
        const minimumAvailable = available >= minAvailable;
        deploy.setCondition(
          'Available',
          minimumAvailable ? 'True' : 'False',
          minimumAvailable ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable',
          `${available}/${desiredReplicas} replicas available`
        );
        // Progressing only becomes NewReplicaSetAvailable once every desired
        // replica is available; a new ReplicaSet whose Pods exist but never
        // become Ready is still being updated.
        if (desiredReplicas > 0 && available < desiredReplicas) {
          deploy.setCondition(
            'Progressing',
            'True',
            'ReplicaSetUpdated',
            `${available} out of ${desiredReplicas} new replicas are available`
          );
        } else {
          deploy.setCondition('Progressing', 'True', 'NewReplicaSetAvailable', '');
        }
      }
    }

    // Engine hooks consumed by `oc rollout status` / other UI surfaces.
    if (timedOut && !deploy._deadlineEventEmitted) {
      deploy._deadlineEventEmitted = true;
      const message = `error: deployment "${deploy.metadata.name}" exceeded its progress deadline`;
      this.eventBus?.emit('rollout:progress-deadline-exceeded', {
        kind: 'Deployment',
        name: deploy.metadata.name,
        namespace: deploy.metadata.namespace,
        revision: this._replicaSetRevision(currentSet) || null,
        deadlineSeconds: progressDeadlineSeconds,
        message,
        resource: deploy,
      });
    }
    if (!timedOut) deploy._deadlineEventEmitted = false;

    const wasPending = deploy._rolloutPendingLast === true;
    deploy._rolloutPendingLast = progressing;
    if (progressing) {
      deploy._rolloutCompleteEmitted = false;
    } else if (wasPending && !deploy._rolloutCompleteEmitted) {
      deploy._rolloutCompleteEmitted = true;
      this.eventBus?.emit('rollout:complete', {
        kind: 'Deployment',
        name: deploy.metadata.name,
        namespace: deploy.metadata.namespace,
        revision: this._replicaSetRevision(currentSet) || null,
        message: `deployment "${deploy.metadata.name}" successfully rolled out`,
        resource: deploy,
      });
    }

    const signature = JSON.stringify({
      replicas: deploy.status.replicas,
      ready: deploy.status.readyReplicas,
      available: deploy.status.availableReplicas,
      updated: deploy.status.updatedReplicas,
      unavailable: deploy.status.unavailableReplicas,
      observedGeneration: deploy.status.observedGeneration,
      conditions: (deploy.status.conditions || []).map(
        (condition) => `${condition.type}:${condition.status}:${condition.reason}`
      ),
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

  // ── Rollout engine hooks (consumed by the CLI and UI) ────────────────────

  /** Resolve a workload for rollout inspection (`oc rollout …`). */
  _rolloutResource(kind, name, options = {}) {
    const canonical = this.cluster._canonicalKind(kind || 'Deployment') || kind || 'Deployment';
    const namespace = options.namespace || 'default';
    const resource = this.cluster.getByName(canonical, name, namespace);
    return { canonical, resource, namespace };
  }

  /**
   * Rollout status for `oc rollout status <kind>/<name>`, mirroring the real
   * oc contract: the CLI polls this through a `pending` state and prints the
   * failure line when the Deployment exhausts its progressDeadlineSeconds.
   *
   * @param {string} kind `Deployment`/`StatefulSet`/`DaemonSet`
   * @param {string} name
   * @param {{namespace?: string}} [options]
   * @returns {{
   *   found: boolean, complete: boolean, pending: boolean, timedOut: boolean,
   *   error?: string, message: string, reason: string|null,
   *   deadlineSeconds: number|null, remainingSeconds: number|null,
   *   revision: number|null,
   *   status: {desired: number, updated: number, ready: number, available: number, replicas: number, unavailable: number}
   * }}
   */
  getRolloutStatus(kind, name, options = {}) {
    const { canonical, resource } = this._rolloutResource(kind, name, options);
    const singular = String(canonical || 'resource').toLowerCase();
    if (!resource) {
      return {
        found: false,
        complete: false,
        pending: false,
        timedOut: false,
        message: `Error from server (NotFound): ${singular}s "${name}" not found`,
        reason: null,
        generation: 0,
        observedGeneration: 0,
        specUpdatePending: false,
        deadlineSeconds: null,
        remainingSeconds: null,
        revision: null,
        status: { desired: 0, updated: 0, ready: 0, available: 0, replicas: 0, unavailable: 0 },
      };
    }
    if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(canonical)) {
      return {
        found: true,
        complete: false,
        pending: false,
        timedOut: false,
        error: `error: no rollout strategy for "${singular}"`,
        message: `error: no rollout strategy for "${singular}"`,
        reason: 'NoRolloutStrategy',
        generation: Number(resource.metadata?.generation) || 1,
        observedGeneration: Number(resource.status?.observedGeneration) || 0,
        specUpdatePending: false,
        deadlineSeconds: null,
        remainingSeconds: null,
        revision: null,
        status: { desired: 0, updated: 0, ready: 0, available: 0, replicas: 0, unavailable: 0 },
      };
    }

    // Honest generation mirroring (#17): `oc set image` bumps metadata.generation
    // synchronously while status.observedGeneration only advances when the
    // controller reconciles that generation. Until then any completion reported
    // from the old status would be a lie — real oc prints the spec-update
    // waiting line instead of "successfully rolled out".
    const generation = Number(resource.metadata?.generation) || 1;
    const observedGeneration = Number(resource.status?.observedGeneration) || 0;
    const specUpdatePending = observedGeneration < generation;

    if (canonical === 'Deployment') {
      const desired = Math.max(0, Number(resource.spec.replicas ?? 1) || 0);
      const status = {
        desired,
        updated: Number(resource.status.updatedReplicas || 0),
        ready: Number(resource.status.readyReplicas || 0),
        available: Number(resource.status.availableReplicas || 0),
        replicas: Number(resource.status.replicas || 0),
        unavailable: Number(resource.status.unavailableReplicas || 0),
      };
      const progressing = resource.getCondition('Progressing');
      const paused = resource.spec.paused === true;
      const timedOut =
        !paused &&
        progressing?.status === 'False' &&
        progressing.reason === 'ProgressDeadlineExceeded';
      const failedCreate = (resource.status.conditions || []).some(
        (condition) => condition.type === 'ReplicaFailure' && condition.status === 'True'
      );
      const complete =
        !paused &&
        !timedOut &&
        !failedCreate &&
        !specUpdatePending &&
        status.updated >= desired &&
        status.available >= desired &&
        status.replicas <= desired;
      const deadlineSeconds = Math.max(1, Number(resource.spec.progressDeadlineSeconds) || 600);
      const remainingSeconds =
        typeof resource._progressingSince === 'number'
          ? Math.max(0, deadlineSeconds - (this.gameSeconds - resource._progressingSince))
          : null;
      let message;
      if (timedOut) {
        message = `error: deployment "${name}" exceeded its progress deadline`;
      } else if (specUpdatePending) {
        message = `Waiting for deployment "${name}" spec update to be observed by the deployment controller...`;
      } else if (complete) {
        message = `deployment "${name}" successfully rolled out`;
      } else if (paused) {
        message = `Waiting for deployment "${name}" rollout to finish: deployment is paused`;
      } else if (status.updated < status.desired) {
        message = `Waiting for deployment "${name}" rollout to finish: ${status.updated} out of ${status.desired} new replicas have been updated...`;
      } else if (status.replicas > status.updated) {
        message = `Waiting for deployment "${name}" rollout to finish: ${Math.max(0, status.replicas - status.updated)} old replicas are pending termination...`;
      } else {
        message = `Waiting for deployment "${name}" rollout to finish: ${status.available} of ${status.updated} updated replicas are available...`;
      }
      return {
        found: true,
        complete,
        pending: !complete && !timedOut,
        timedOut,
        message,
        reason: timedOut
          ? 'ProgressDeadlineExceeded'
          : specUpdatePending
            ? 'SpecUpdatePending'
            : complete
              ? 'NewReplicaSetAvailable'
              : progressing?.reason || null,
        generation,
        observedGeneration,
        specUpdatePending,
        deadlineSeconds,
        remainingSeconds,
        revision:
          Number(resource.metadata?.annotations?.['deployment.kubernetes.io/revision']) || null,
        status,
      };
    }

    const isDaemonSet = canonical === 'DaemonSet';
    const desired = isDaemonSet
      ? Math.max(
          0,
          Number(
            resource.status.desiredNumberScheduled ?? resource.status.currentNumberScheduled ?? 0
          ) || 0
        )
      : Math.max(0, Number(resource.spec.replicas ?? 1) || 0);
    const status = isDaemonSet
      ? {
          desired,
          updated: Number(resource.status.updatedNumberScheduled || 0),
          ready: Number(resource.status.numberReady || 0),
          available: Number(resource.status.numberAvailable || 0),
          replicas: Number(resource.status.currentNumberScheduled || 0),
          unavailable: Number(resource.status.numberUnavailable || 0),
        }
      : {
          desired,
          updated: Number(resource.status.updatedReplicas || resource.status.currentReplicas || 0),
          ready: Number(resource.status.readyReplicas || 0),
          available: Number(resource.status.availableReplicas || 0),
          replicas: Number(resource.status.replicas || resource.status.currentReplicas || 0),
          unavailable: Number(resource.status.unavailableReplicas || 0),
        };
    const complete =
      !specUpdatePending &&
      status.updated >= desired &&
      status.available >= desired &&
      status.replicas >= desired;
    const controllerName = isDaemonSet ? 'daemon set' : 'statefulset';
    return {
      found: true,
      complete,
      pending: !complete,
      timedOut: false,
      message: specUpdatePending
        ? `Waiting for ${controllerName} "${name}" spec update to be observed by the ${controllerName} controller...`
        : complete
          ? `${singular} "${name}" successfully rolled out`
          : `Waiting for ${controllerName} "${name}" rollout to finish: ${status.available} of ${status.desired} updated pods are available...`,
      reason: specUpdatePending
        ? 'SpecUpdatePending'
        : complete
          ? 'NewReplicaSetAvailable'
          : 'ReplicaSetUpdated',
      generation,
      observedGeneration,
      specUpdatePending,
      deadlineSeconds: null,
      remainingSeconds: null,
      revision: null,
      status,
    };
  }

  /**
   * Real rollout history: derived from the Deployment's ReplicaSets
   * (`deployment.kubernetes.io/revision` + `kubernetes.io/change-cause`), so
   * revisions appear as they really happened instead of a synthesised rev 1.
   *
   * @returns {Array<{revision:number, changeCause:string, images:string[], name:string, active:boolean, template:object}>}
   */
  getRolloutHistory(kind, name, options = {}) {
    const { canonical, resource } = this._rolloutResource(kind, name, options);
    if (!resource || !['Deployment', 'StatefulSet', 'DaemonSet'].includes(canonical)) return [];
    const ownedSets = this.cluster
      .getChildren(resource.uid)
      .filter((child) => child.kind === 'ReplicaSet');
    const history = ownedSets
      .map((rs) => {
        const revision = this._replicaSetRevision(rs);
        const activePods = this._activePodsOf(rs).length;
        return {
          revision,
          changeCause: rs.metadata?.annotations?.['kubernetes.io/change-cause'] || '',
          images: (rs.spec?.template?.spec?.containers || []).map(
            (container) => `${container.name}=${container.image}`
          ),
          name: rs.metadata.name,
          active: activePods > 0,
          replicas: Number(rs.spec?.replicas || 0),
          template: deepClone(rs.spec?.template || {}),
        };
      })
      .filter((entry) => entry.revision > 0);
    history.sort((a, b) => a.revision - b.revision);
    if (history.length > 0) return history;
    // Legacy/saved cluster without ReplicaSets: reflect the current template as
    // revision 1 so `rollout history` still has a row (no fake change-cause).
    const currentRevision =
      Number(resource.metadata?.annotations?.['deployment.kubernetes.io/revision']) || 1;
    return [
      {
        revision: currentRevision,
        changeCause: resource.metadata?.annotations?.['kubernetes.io/change-cause'] || '',
        images: (resource.spec?.template?.spec?.containers || []).map(
          (container) => `${container.name}=${container.image}`
        ),
        name: `${resource.metadata.name}-current`,
        active: true,
        replicas: Number(resource.spec?.replicas || 0),
        template: deepClone(resource.spec?.template || {}),
      },
    ];
  }

  /**
   * `oc rollout undo`: restore the pod template of a previous revision. The
   * Deployment controller then re-activates the existing (kept) ReplicaSet, so
   * availability is restored without creating a bogus new revision.
   *
   * @param {string} kind
   * @param {string} name
   * @param {{namespace?: string, revision?: number}} [options]
   * @returns {{success: boolean, message: string, revision?: number}}
   */
  undoRollout(kind, name, options = {}) {
    const { canonical, resource } = this._rolloutResource(kind, name, options);
    const singular = String(canonical || 'resource').toLowerCase();
    if (!resource)
      return {
        success: false,
        message: `Error from server (NotFound): ${singular}s "${name}" not found`,
      };
    if (canonical !== 'Deployment') {
      return {
        success: false,
        message: `error: no rollout history found for ${singular} "${name}"`,
      };
    }
    const history = this.getRolloutHistory(canonical, name, options);
    if (history.length === 0)
      return {
        success: false,
        message: `error: no rollout history found for ${singular} "${name}"`,
      };
    const currentRevision =
      Number(resource.metadata?.annotations?.['deployment.kubernetes.io/revision']) ||
      history[history.length - 1].revision;
    let target;
    if (options.revision !== undefined && options.revision !== null) {
      target = history.find((entry) => entry.revision === Number(options.revision));
      if (!target) {
        return {
          success: false,
          message: `error: unable to find specified revision ${options.revision}`,
        };
      }
    } else {
      target = [...history].reverse().find((entry) => entry.revision < currentRevision);
      if (!target) {
        // `oc rollout undo` on a Deployment with a single revision rolls back to
        // that revision (no-op) instead of erroring.
        target = history[history.length - 1];
      }
    }
    resource.spec.template = deepClone(target.template || {});
    resource.metadata.generation = (Number(resource.metadata.generation) || 1) + 1;
    resource._progressingSince = undefined;
    resource._deadlineEventEmitted = false;
    this.cluster.update(resource.uid, resource);
    // Counters/events shared with the objective + scoring layers (the legacy
    // GameEngine.rollout('undo') path emitted these too).
    this.cluster._rollbackCount = (this.cluster._rollbackCount || 0) + 1;
    this.eventBus?.emit('resource:rollback', {
      uid: resource.uid,
      kind: canonical,
      name,
      revision: target.revision,
    });
    this.eventBus?.emit('rollout:triggered', {
      kind: canonical,
      name,
      namespace: resource.metadata.namespace,
      revision: target.revision,
      reason: 'undo',
      resource,
    });
    return {
      success: true,
      revision: target.revision,
      message: `${singular}.apps/${name} rolled back`,
    };
  }

  _activePodsOf(owner) {
    if (!owner) return [];
    return this.cluster
      .getChildren(owner.uid)
      .filter(
        (child) =>
          child.kind === 'Pod' &&
          child.status.phase !== 'Succeeded' &&
          child.status.phase !== 'Failed'
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
    if (Array.isArray(value))
      return `[${value.map((entry) => this._stableStringify(entry)).join(',')}]`;
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
          if (
            existing &&
            !existing.isDeleting &&
            existing.status.phase !== 'Succeeded' &&
            existing.status.phase !== 'Failed'
          ) {
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
        for (let index = 0; index < pods.length - desiredReplicas; index++)
          this.cluster.remove(sorted[index].uid);
        pods = this._activePodsOf(statefulSet);
      }

      const readyPods = pods.filter((pod) => this._podIsReady(pod));
      const updatedPods = pods.filter(
        (pod) => pod.metadata.labels?.['controller-revision-hash'] === revisionName
      );
      statefulSet.status.replicas = pods.length;
      statefulSet.status.readyReplicas = readyPods.length;
      statefulSet.status.availableReplicas = readyPods.length;
      statefulSet.status.currentReplicas = pods.length;
      statefulSet.status.updatedReplicas = updatedPods.length;
      statefulSet.status.updateRevision = revisionName;
      if (pods.length > 0 && updatedPods.length === pods.length)
        statefulSet.status.currentRevision = revisionName;
      else if (!statefulSet.status.currentRevision)
        statefulSet.status.currentRevision = revisionName;
      statefulSet.status.observedGeneration = statefulSet.metadata.generation;
      if (pods.length > 0 && statefulSet.status.phase !== 'Running')
        statefulSet.setPhase('Running');
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
        volumes.push({
          name: claimBaseName,
          persistentVolumeClaim: { claimName: `${claimBaseName}-${podName}` },
        });
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
    const admissionFailure = this._admissionFailureMessage(podSpec, namespace, podName);
    if (admissionFailure) {
      this._recordFailedCreate(statefulSet, podName, admissionFailure);
      return null;
    }
    const pod = this.cluster.addResource({
      kind: 'Pod',
      metadata: { name: podName, namespace, labels },
      spec: podSpec,
      status: { phase: 'Pending' },
    });
    if (pod) {
      this.cluster.addRelationship(statefulSet.uid, pod.uid);
      this._clearReplicaFailure(statefulSet);
    }
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
        if (
          !this.cluster.getByName(
            'PersistentVolumeClaim',
            claimName,
            statefulSet.metadata.namespace
          )
        ) {
          this.cluster.addResource({
            kind: 'PersistentVolumeClaim',
            metadata: {
              name: claimName,
              namespace: statefulSet.metadata.namespace,
              labels: { app: statefulSet.metadata.name, ...(template.metadata?.labels || {}) },
              annotations: deepClone(template.metadata?.annotations || {}),
            },
            spec: deepClone(
              template.spec || {
                accessModes: ['ReadWriteOnce'],
                resources: { requests: { storage: '1Gi' } },
              }
            ),
          });
        }
      }
    }
  }

  _tickDaemonSets(dt) {
    const allNodes = this.cluster
      .getByKind('Node')
      .filter((node) => node.status.phase !== 'Terminating');
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
          const scheduled = pods.some(
            (pod) => pod.spec.nodeName === node.metadata.name && !pod.isDeleting
          );
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
      if (typeof job._startedAtGameSeconds !== 'number')
        job._startedAtGameSeconds = this.gameSeconds;
      if (!job.status.startTime) job.status.startTime = new Date().toISOString();

      const completions = Math.max(1, Number(job.spec.completions ?? 1) || 1);
      const parallelism = Math.max(1, Number(job.spec.parallelism ?? 1) || 1);
      const backoffLimit = Number.isFinite(Number(job.spec.backoffLimit))
        ? Number(job.spec.backoffLimit)
        : 6;
      const activeDeadlineSeconds = Number(job.spec.activeDeadlineSeconds);
      const jobPods = () =>
        this.cluster.getChildren(job.uid).filter((child) => child.kind === 'Pod');
      const succeededPods = jobPods().filter((pod) => pod.status.phase === 'Succeeded');
      const failedPods = jobPods().filter((pod) => pod.status.phase === 'Failed');
      const activePods = jobPods().filter(
        (pod) => pod.status.phase === 'Running' || pod.status.phase === 'Pending'
      );
      job.status.succeeded = succeededPods.length;
      job.status.failed = failedPods.length;
      job.status.active = activePods.length;

      const finishJob = (phase, reason, message) => {
        job.setPhase(phase);
        job.status.completionTime = new Date().toISOString();
        job.status.reason = reason;
        job.status.message = message || '';
        job.setCondition(
          phase === 'Complete' ? 'Complete' : 'Failed',
          'True',
          reason,
          message || ''
        );
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
            pod.setCondition(
              'Ready',
              'False',
              'ContainersNotReady',
              'job active deadline exceeded'
            );
            pod.recordEvent(
              'Warning',
              'DeadlineExceeded',
              'Pod terminated because the Job activeDeadlineSeconds was exceeded'
            );
          }
          job.status.active = 0;
          finishJob(
            'Failed',
            'DeadlineExceeded',
            `Job was active longer than specified deadline (${activeDeadlineSeconds}s)`
          );
          continue;
        }
      }
      if (failedPods.length > backoffLimit) {
        finishJob(
          'Failed',
          'BackoffLimitExceeded',
          `Job has reached the specified backoff limit (${backoffLimit})`
        );
        continue;
      }
      if (jobPods().some((pod) => this._isPodBlocked(pod))) continue;

      // Exponential retry backoff (simulation time).
      if (failedPods.length > 0) {
        if (typeof job._nextPodCreateAtGameSeconds !== 'number') {
          job._nextPodCreateAtGameSeconds =
            this.gameSeconds + Math.min(300, Math.pow(2, failedPods.length) * 10);
        }
      } else {
        job._nextPodCreateAtGameSeconds = undefined;
      }
      const backoffPending =
        failedPods.length > 0 &&
        typeof job._nextPodCreateAtGameSeconds === 'number' &&
        this.gameSeconds < job._nextPodCreateAtGameSeconds;
      const needed = Math.min(parallelism, completions - succeededPods.length) - activePods.length;
      for (let index = 0; index < needed; index++) {
        if (backoffPending) break;
        const pod = this._createPodForWorkload(job, job);
        if (!pod) break;
        pod.spec.restartPolicy = 'Never';
        const duration =
          Math.max(1, Number(job.spec.estimatedDurationSeconds) || 30) *
          (0.8 + Math.random() * 0.4);
        pod._completionAtGameSeconds = this.gameSeconds + duration;
        pod._jobUid = job.uid;
      }

      // Simulated-time completion (was wall-clock Date.now() based).
      for (const pod of activePods) {
        if (pod.status.phase !== 'Running') continue;
        if (
          typeof pod._completionAtGameSeconds === 'number' &&
          this.gameSeconds >= pod._completionAtGameSeconds
        ) {
          pod.setPhase('Succeeded');
          for (const status of pod.status.containerStatuses || []) {
            status.state = {
              terminated: {
                exitCode: 0,
                reason: 'Completed',
                finishedAt: new Date().toISOString(),
              },
            };
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
      job.status.active = jobPods().filter(
        (pod) => pod.status.phase === 'Running' || pod.status.phase === 'Pending'
      ).length;
      if (succeededNow >= completions)
        finishJob('Complete', 'JobComplete', 'Job completed successfully');
    }
  }

  _tickCronJobs(dt) {
    for (const cronJob of this.cluster.getByKind('CronJob')) {
      const namespace = cronJob.metadata.namespace;
      const jobs = this.cluster.getChildren(cronJob.uid).filter((child) => child.kind === 'Job');
      const running = jobs.filter(
        (job) =>
          job.status.phase !== 'Complete' &&
          job.status.phase !== 'Failed' &&
          !job.metadata.deletionTimestamp
      );
      const completed = jobs
        .filter((job) => job.status.phase === 'Complete')
        .sort(
          (a, b) => new Date(a.metadata.creationTimestamp) - new Date(b.metadata.creationTimestamp)
        );
      const failed = jobs
        .filter((job) => job.status.phase === 'Failed')
        .sort(
          (a, b) => new Date(a.metadata.creationTimestamp) - new Date(b.metadata.creationTimestamp)
        );

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
      if (lastCompleted)
        cronJob.status.lastSuccessfulTime =
          lastCompleted.status.completionTime || cronJob.status.lastSuccessfulTime;

      const successLimit = Number.isFinite(Number(cronJob.spec.successfulJobsHistoryLimit))
        ? Number(cronJob.spec.successfulJobsHistoryLimit)
        : 3;
      const failedLimit = Number.isFinite(Number(cronJob.spec.failedJobsHistoryLimit))
        ? Number(cronJob.spec.failedJobsHistoryLimit)
        : 1;
      while (completed.length > successLimit) this.cluster.remove(completed.shift().uid);
      while (failed.length > failedLimit) this.cluster.remove(failed.shift().uid);

      if (cronJob.spec.suspend) continue;

      // Real cron validation + next-run scheduling: a CronJob never creates a
      // Job at creation time, only at the next occurrence of its schedule
      // (issue #14). The simulated clock advances with game time.
      const parsed = parseCronSchedule(cronJob.spec.schedule || '*/5 * * * *');
      if (!parsed.valid) {
        if (!cronJob._invalidScheduleLogged) {
          cronJob._invalidScheduleLogged = true;
          cronJob.setCondition(
            'ScheduleInvalid',
            'True',
            'InvalidSchedule',
            `invalid CronJob schedule: ${parsed.message || cronJob.spec.schedule}`
          );
          cronJob.recordEvent(
            'Warning',
            'InvalidSchedule',
            `invalid CronJob schedule: ${parsed.message || cronJob.spec.schedule}`
          );
          this.cluster.update(cronJob.uid, cronJob);
        }
        continue;
      }
      cronJob._invalidScheduleLogged = false;
      const nowMs = this._virtualNowMs();
      if (
        typeof cronJob._nextScheduleAtMs !== 'number' ||
        !Number.isFinite(cronJob._nextScheduleAtMs)
      ) {
        const next = nextCronOccurrence(parsed, new Date(nowMs));
        cronJob._nextScheduleAtMs = next ? next.getTime() : Number.POSITIVE_INFINITY;
        this.cluster.update(cronJob.uid, cronJob);
        continue;
      }
      if (nowMs < cronJob._nextScheduleAtMs) continue;
      const scheduledAtMs = cronJob._nextScheduleAtMs;
      const scheduledAt = new Date(scheduledAtMs);

      const policy = cronJob.spec.concurrencyPolicy || 'Allow';
      if (running.length > 0) {
        if (policy === 'Forbid') {
          cronJob.recordEvent(
            'Normal',
            'JobAlreadyActive',
            'Skipped scheduled job: concurrency policy Forbid'
          );
          cronJob.status.lastScheduleTime = scheduledAt.toISOString();
          const nextSkip = nextCronOccurrence(parsed, scheduledAt);
          cronJob._nextScheduleAtMs = nextSkip ? nextSkip.getTime() : Number.POSITIVE_INFINITY;
          this.cluster.update(cronJob.uid, cronJob);
          continue;
        }
        if (policy === 'Replace') {
          for (const job of running) this.cluster.remove(job.uid);
          cronJob.recordEvent(
            'Normal',
            'JobReplaced',
            'Replaced a running job due to concurrency policy Replace'
          );
        }
      }

      // Real job names are `<cronjob>-<scheduled epoch minutes>`.
      let jobName = `${cronJob.metadata.name}-${Math.floor(scheduledAtMs / 60000)}`;
      let suffix = 0;
      while (this.cluster.getByName('Job', jobName, namespace)) {
        suffix += 1;
        jobName = `${cronJob.metadata.name}-${Math.floor(scheduledAtMs / 60000)}-${suffix}`;
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
      cronJob.status.lastScheduleTime = scheduledAt.toISOString();
      cronJob.status.active = [
        ...(cronJob.status.active || []),
        { apiVersion: 'batch/v1', kind: 'Job', name: jobName, namespace, uid: newJob.metadata.uid },
      ];
      cronJob.recordEvent('Normal', 'SuccessfulCreate', `Created job ${jobName}`);
      const nextAfterJob = nextCronOccurrence(parsed, new Date(scheduledAtMs + 1000));
      cronJob._nextScheduleAtMs = nextAfterJob ? nextAfterJob.getTime() : Number.POSITIVE_INFINITY;
      this.cluster.update(cronJob.uid, cronJob);
    }
  }

  /**
   * Recent Event objects across the cluster (issue #21).
   *
   * Every resource keeps its own Event history (`resource.getEvents()`); the CLI
   * merges these with its synthetic event stream so controller events such as
   * the ReplicaSet `Warning FailedCreate` emitted by SCC admission are visible
   * to `oc get events --field-selector reason=FailedCreate`.
   *
   * @param {{namespace?: string, allNamespaces?: boolean, reason?: string, type?: string, limit?: number}} [options]
   * @returns {Array<{type: string, reason: string, message: string, involvedObject: object, namespace: string, object: string, source: string, count: number, firstTimestamp: string, lastTimestamp: string}>}
   */
  getEvents(options = {}) {
    const namespace = options.namespace || null;
    const allNamespaces = options.allNamespaces === true || !namespace;
    const reasonFilter = options.reason ? String(options.reason) : null;
    const typeFilter = options.type ? String(options.type) : null;
    const limit = Math.max(1, Math.min(1000, Number(options.limit) || 200));
    const events = [];
    const resources =
      typeof this.cluster.getAllResources === 'function'
        ? this.cluster.getAllResources()
        : this.cluster.getByKind('Pod') || [];
    for (const resource of resources) {
      if (!resource) continue;
      const eventList =
        typeof resource.getEvents === 'function' ? resource.getEvents() : resource.events || [];
      for (const event of eventList || []) {
        if (!event || !event.reason) continue;
        const involvedObject = event.involvedObject || {};
        const eventNamespace = involvedObject.namespace || resource.metadata?.namespace || '';
        if (!allNamespaces && eventNamespace !== namespace) continue;
        if (reasonFilter && String(event.reason) !== reasonFilter) continue;
        if (typeFilter && String(event.type) !== typeFilter) continue;
        const kind = involvedObject.kind || resource.kind || 'Resource';
        const name = involvedObject.name || resource.metadata?.name || '';
        events.push({
          type: String(event.type || 'Normal'),
          reason: String(event.reason),
          message: String(event.message || ''),
          involvedObject: {
            kind,
            name,
            namespace: eventNamespace,
            uid: involvedObject.uid || resource.metadata?.uid || '',
          },
          namespace: eventNamespace,
          object: `${String(kind).toLowerCase()}/${name}`,
          source: event.source || kind,
          count: Number(event.count) || 1,
          firstTimestamp: event.firstTimestamp || event.timestamp || new Date().toISOString(),
          lastTimestamp: event.lastTimestamp || event.timestamp || new Date().toISOString(),
        });
      }
    }
    events.sort((a, b) => String(b.lastTimestamp).localeCompare(String(a.lastTimestamp)));
    return events.slice(0, limit);
  }

  /** Virtual wall-clock for CronJob scheduling (simulated time). */
  _virtualNowMs() {
    return this._simEpoch + this.gameSeconds * 1000;
  }

  _tickHPA(dt) {
    const TOLERANCE = 0.1; // --horizontal-pod-autoscaler-tolerance default
    for (const hpa of this.cluster.getByKind('HorizontalPodAutoscaler')) {
      const targetRef = hpa.spec.scaleTargetRef;
      if (!targetRef) continue;
      hpa.status.observedGeneration = hpa.metadata.generation;
      const target = this.cluster.getByName(targetRef.kind, targetRef.name, hpa.namespace);
      if (!target) {
        hpa.setCondition(
          'ScalingActive',
          'False',
          'FailedGetScale',
          `the HPA controller was unable to get the target's current scale: ${String(targetRef.kind).toLowerCase()}s.apps "${targetRef.name}" not found`
        );
        this.cluster.update(hpa.uid, hpa);
        continue;
      }

      const currentReplicas = Math.max(0, Number(target.spec.replicas ?? 1) || 0);
      const minReplicas = Number.isFinite(Number(hpa.spec.minReplicas))
        ? Number(hpa.spec.minReplicas)
        : 1;
      const maxReplicas = Number.isFinite(Number(hpa.spec.maxReplicas))
        ? Number(hpa.spec.maxReplicas)
        : 10;
      const metrics = hpa.spec.metrics || [
        {
          type: 'Resource',
          resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 50 } },
        },
      ];
      let desiredReplicas = currentReplicas;
      let metricsAvailable = true;
      const statusMetrics = [];

      for (const metric of metrics) {
        if (metric.type !== 'Resource' || !metric.resource) continue;
        const resourceName = metric.resource.name || 'cpu';
        const targetUtilization =
          Number(
            metric.resource.targetAverageUtilization ??
              metric.resource.target?.averageUtilization ??
              50
          ) || 50;
        const measured = this._getWorkloadCpuUtilization(target);
        if (!measured.available) {
          metricsAvailable = false;
          statusMetrics.push({
            type: 'Resource',
            resource: { name: resourceName, current: { averageUtilization: 0 } },
          });
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
        if (ratio > 1 + TOLERANCE)
          desiredReplicas = Math.max(desiredReplicas, Math.ceil(currentReplicas * ratio));
        else if (ratio < 1 - TOLERANCE)
          desiredReplicas = Math.min(desiredReplicas, Math.ceil(currentReplicas * ratio));
      }

      if (!metricsAvailable) {
        // Real HPA: no metrics sample -> TARGETS `<unknown>/50%`; currentMetrics
        // stays empty (a 0% sample would be a lie) and REPLICAS stays at its
        // last successful value (0 until the first successful sync).
        hpa.status.currentMetrics = [];
        hpa.status.desiredReplicas = Number(hpa.status.currentReplicas || 0) || 0;
        hpa.setCondition(
          'ScalingActive',
          'False',
          'FailedGetResourceMetric',
          'the HPA was unable to compute the replica count: no metrics returned'
        );
        hpa.setCondition('ScalingLimited', 'False', 'DesiredWithinRange', '');
        this.cluster.update(hpa.uid, hpa);
        continue;
      }
      hpa.status.currentMetrics = statusMetrics;
      hpa.status.currentReplicas = currentReplicas;

      const rawDesiredReplicas = Math.max(minReplicas, Math.min(maxReplicas, desiredReplicas));
      desiredReplicas = rawDesiredReplicas;
      hpa.setCondition(
        'ScalingActive',
        'True',
        'ValidMetricFound',
        'the HPA was able to successfully calculate a replica count from cpu resource utilization'
      );
      if (desiredReplicas >= maxReplicas && currentReplicas < desiredReplicas) {
        hpa.setCondition(
          'ScalingLimited',
          'True',
          'TooManyReplicas',
          'the desired replica count is more than the maximum replica count'
        );
      } else if (desiredReplicas <= minReplicas && currentReplicas > desiredReplicas) {
        hpa.setCondition(
          'ScalingLimited',
          'True',
          'TooFewReplicas',
          'the desired replica count is less than the minimum replica count'
        );
      } else {
        hpa.setCondition('ScalingLimited', 'False', 'DesiredWithinRange', '');
      }

      // Rate limits: ~+4 pods (or x2) per scale-up, at most halve on scale-down.
      const scaleUpLimit = Math.max(4, currentReplicas * 2);
      const scaleDownLimit = Math.max(1, Math.floor(currentReplicas * 0.5));
      let nextReplicas = desiredReplicas;
      if (nextReplicas > currentReplicas)
        nextReplicas = Math.min(nextReplicas, currentReplicas + scaleUpLimit);
      else if (nextReplicas < currentReplicas)
        nextReplicas = Math.max(nextReplicas, scaleDownLimit);

      if (nextReplicas !== currentReplicas) {
        const lastScaleTime = hpa.status.lastScaleTime
          ? new Date(hpa.status.lastScaleTime).getTime()
          : 0;
        const cooldown = nextReplicas > currentReplicas ? 30000 : 300000;
        if (Date.now() - lastScaleTime >= cooldown) {
          const direction = nextReplicas > currentReplicas ? 'up' : 'down';
          target.spec.replicas = nextReplicas;
          target.metadata.generation++;
          this.cluster.update(target.uid, target);
          hpa.status.currentReplicas = nextReplicas;
          hpa.status.desiredReplicas = nextReplicas;
          hpa.status.lastScaleTime = new Date().toISOString();
          hpa.recordEvent(
            'Normal',
            'SuccessfulRescale',
            `New size: ${nextReplicas}; reason: cpu resource utilization (percentage of request) above target`
          );
          this.eventBus?.emit('hpa:scaled', {
            hpa: hpa.metadata.name,
            target: target.metadata.name,
            from: currentReplicas,
            to: nextReplicas,
            direction,
          });
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
    const pods = this.cluster
      .selectByLabels('Pod', selector)
      .filter(
        (pod) =>
          pod.metadata.namespace === workload.metadata.namespace && pod.status.phase === 'Running'
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
        if ((volume.spec.storageClassName || '') !== (claim.spec.storageClassName || ''))
          return false;
        if (parseMemoryMi(volume.spec.capacity?.storage || '0') < requestMi) return false;
        return (
          accessModes.every((mode) => (volume.spec.accessModes || []).includes(mode)) &&
          volume.matchesSelector(claim.spec.selector?.matchLabels || {})
        );
      });

      let volume = existing;
      if (!volume) {
        const storageClass = this._findStorageClass(claim.spec.storageClassName);
        if (
          storageClass &&
          storageClass.spec?.provisioner &&
          storageClass.spec.provisioner !== 'kubernetes.io/no-provisioner'
        ) {
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
              claimRef: {
                kind: 'PersistentVolumeClaim',
                name: claim.metadata.name,
                namespace: claim.metadata.namespace,
                uid: claim.metadata.uid,
              },
            },
            status: { phase: 'Bound' },
          });
        }
      }

      if (!volume) {
        claim.setCondition(
          'Pending',
          'True',
          'ProvisioningFailed',
          `no persistent volumes available for this claim and no storage class is set`
        );
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
      claim.recordEvent(
        'Normal',
        'Bound',
        `PVC ${claim.metadata.name} bound to PV ${volume.metadata.name}`
      );
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
    if (storageClassName)
      return storageClasses.find((entry) => entry.metadata.name === storageClassName) || null;
    return (
      storageClasses.find(
        (entry) =>
          entry.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
      ) ||
      storageClasses.find(
        (entry) => (entry.spec?.provisioner || '') !== 'kubernetes.io/no-provisioner'
      ) ||
      null
    );
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
      route.status.ingress = [
        {
          host,
          routerName: 'default',
          routerCanonicalHostname: `router-default.${APPS_DOMAIN}`,
          wildcardPolicy: route.spec.wildcardPolicy || 'None',
          conditions: [
            {
              type: 'Admitted',
              status: admitted ? 'True' : 'False',
              reason,
              message,
              lastTransitionTime: new Date().toISOString(),
            },
          ],
        },
      ];
      route.status.observedGeneration = route.metadata.generation;

      if (admitted && previous !== true) {
        this.cluster.update(route.uid, route);
        this.eventBus?.emit('route:admitted', {
          route: route.metadata.name,
          host,
          namespace,
          resource: route,
        });
      } else if (!admitted && previous !== false) {
        this.cluster.update(route.uid, route);
        this.eventBus?.emit('route:not-admitted', {
          route: route.metadata.name,
          host,
          namespace,
          reason,
          message,
          resource: route,
        });
      }
    }
  }

  /**
   * MetalLB controller: when the MetalLB operator is installed and an
   * IPAddressPool is advertised by an L2Advertisement, assign EXTERNAL-IPs to
   * Services of type LoadBalancer (CONVERSION-SPEC §5).
   */
  _tickOperatorEffects(dt) {
    this._tickMetalLBOperands(dt);
    this._tickMetalLB(dt);
  }

  /**
   * Public synchronous seed hook for the app bootstrap (`launchGame`).
   *
   * The OLM catalog + global OperatorGroup are part of the seeded platform but
   * are owned by the simulation layer. They must exist BEFORE the app runs its
   * initial cluster auto-align (`_layoutClusterAfterModeStart`) so every mesh
   * gets a unique layout target; the per-tick {@link _ensureOLMDefaults} stays
   * as an idempotent safety net (level changes, manual deletion, saved games).
   *
   * @returns {void}
   */
  ensureOLMDefaultsSync() {
    this._ensureOLMDefaults();
  }

  /**
   * Ensure the simulated openshift-marketplace software catalog exists:
   * PackageManifest objects (cluster-scoped) + the global-operators
   * OperatorGroup that a real cluster ships in openshift-operators.
   * Runs every tick but only creates missing objects (a level change/reset
   * re-seeds them; players cannot permanently remove the catalog).
   */
  _ensureOLMDefaults() {
    if (this.cluster.getByKind('PackageManifest').length === 0) {
      for (const entry of OLM_CATALOG) {
        this.cluster.addResource({
          kind: 'PackageManifest',
          metadata: { name: entry.name, labels: { 'olm.catalogSource': 'redhat-operators' } },
          spec: {
            packageName: entry.name,
            defaultChannel: entry.channel,
            channels: [{ name: entry.channel, currentCSV: entry.currentCSV }],
          },
          status: {
            catalogSource: 'redhat-operators',
            catalogSourceNamespace: 'openshift-marketplace',
            packageName: entry.name,
            defaultChannel: entry.channel,
            provider: { name: entry.provider },
            channels: [
              {
                name: entry.channel,
                currentCSV: entry.currentCSV,
                currentCSVDesc: {
                  displayName: entry.displayName,
                  version: (entry.currentCSV.match(/\.v?(\d+\.\d+\.\d+)/) || [])[1] || '1.0.0',
                  description: entry.description,
                  provider: { name: entry.provider },
                },
              },
            ],
          },
        });
      }
    }
    if (
      this.cluster.getByName('Project', 'openshift-operators', '') &&
      !this.cluster.getByName('OperatorGroup', 'global-operators', 'openshift-operators')
    ) {
      this.cluster.addResource({
        kind: 'OperatorGroup',
        metadata: { name: 'global-operators', namespace: 'openshift-operators' },
        spec: { targetNamespaces: [] },
        status: { namespaces: [] },
      });
    }
  }

  /** Target CSV name for a package (PackageManifest currentCSV), otherwise a
   * package-derived name (never the Subscription name — issue #9). */
  _csvNameForPackage(packageName) {
    const manifest = this.cluster.getByName('PackageManifest', packageName, '');
    if (manifest && typeof manifest.currentCSV === 'string' && manifest.currentCSV)
      return manifest.currentCSV;
    const channels = manifest?.spec?.channels || manifest?.status?.channels || [];
    const channel = channels.find((entry) => entry.currentCSV) || null;
    if (channel?.currentCSV) return channel.currentCSV;
    return `${packageName}.v1.0.0`;
  }

  /** `oc rollout`-independent helper: package name a Subscription tracks. */
  _packageNameForSubscription(subscription) {
    return (
      subscription?.spec?.packageName ||
      subscription?.spec?.name ||
      subscription?.metadata?.name ||
      'operator'
    );
  }

  _csvVersionForPackage(packageName) {
    const csvName = this._csvNameForPackage(packageName);
    const match = String(csvName).match(/\.v?(\d+\.\d+\.\d+)/);
    return match ? match[1] : '1.0.0';
  }

  /** InstallPlan owned by a Subscription (created by this controller). */
  _installPlanForSubscription(subscription, namespace) {
    const child = this.cluster
      .getChildren(subscription.uid)
      .find((entry) => entry.kind === 'InstallPlan');
    if (child) return child;
    return (
      this.cluster
        .getByKindAndNamespace('InstallPlan', namespace)
        .find(
          (plan) =>
            plan.metadata?.labels?.['operators.coreos.com/subscription'] ===
            subscription.metadata.name
        ) || null
    );
  }

  /** CSV installed by a Subscription (status.installedCSV / currentCSV). */
  _csvForSubscription(subscription, namespace) {
    const csvName = subscription.status?.installedCSV || subscription.status?.currentCSV || '';
    if (csvName) {
      const named = this.cluster.getByName('ClusterServiceVersion', csvName, namespace);
      if (named) return named;
    }
    return (
      this.cluster
        .getByKindAndNamespace('ClusterServiceVersion', namespace)
        .find(
          (csv) =>
            csv.metadata?.labels?.['operators.coreos.com/subscription'] ===
            subscription.metadata.name
        ) || null
    );
  }

  /**
   * Create the operator Deployment described by a CSV install strategy, the way
   * OLM does after the CSV reaches Succeeded. The Deployment is labelled with
   * olm.owner so deleting the CSV can remove it (real uninstall).
   */
  _ensureOperatorDeploymentForCSV(csv, packageName) {
    if (!csv) return null;
    const namespace = csv.metadata.namespace;
    const strategyDeployment = csv.spec?.install?.spec?.deployments?.[0];
    const deploymentName =
      strategyDeployment?.name ||
      `${String(csv.metadata.name).replace(/\.v\d.*$/, '')}-controller-manager`;
    const existing = this.cluster.getByName('Deployment', deploymentName, namespace);
    if (existing) {
      this._olmOperatorDeployments.set(csv.uid, existing.uid);
      return existing;
    }
    const spec = deepClone(
      strategyDeployment?.spec || {
        replicas: 1,
        selector: { matchLabels: { name: `${packageName}-operator` } },
        template: {
          metadata: { labels: { name: `${packageName}-operator` } },
          spec: {
            serviceAccountName: 'default',
            containers: [
              {
                name: 'manager',
                image: `${packageName.replace(/-operator$/, '')}-operator:latest`,
                resources: {
                  requests: { cpu: '10m', memory: '64Mi' },
                  limits: { cpu: '200m', memory: '256Mi' },
                },
              },
            ],
          },
        },
      }
    );
    if (!spec.selector) spec.selector = { matchLabels: { name: `${packageName}-operator` } };
    const deployment = this.cluster.addResource({
      kind: 'Deployment',
      metadata: {
        name: deploymentName,
        namespace,
        labels: {
          'olm.owner': csv.metadata.name,
          'olm.owner.namespace': namespace,
          'olm.package': packageName,
          'app.kubernetes.io/managed-by': 'olm',
        },
        annotations: {
          'olm.operatorGroup': csv.metadata.annotations?.['olm.operatorGroup'] || '',
        },
      },
      spec,
    });
    if (deployment) this._olmOperatorDeployments.set(csv.uid, deployment.uid);
    return deployment;
  }

  /** `cluster:deleted:ClusterServiceVersion` → real uninstall of its operator. */
  _onCSVDeleted(csv) {
    if (!csv) return;
    const namespace = csv.metadata?.namespace || '';
    const csvName = csv.metadata?.name || '';
    const removed = [];
    for (const deployment of this.cluster.getByKindAndNamespace('Deployment', namespace)) {
      const owner = deployment.metadata?.labels?.['olm.owner'];
      if (owner === csvName || (owner && owner === csv.metadata?.name)) {
        this.cluster.remove(deployment.uid);
        removed.push(deployment.metadata.name);
      }
    }
    this._olmOperatorDeployments.delete(csv.uid);
    this._knownCSVs.delete(csv.uid);
    this.eventBus?.emit('operator:csv-deleted', {
      name: csvName,
      namespace,
      packageName: csv.metadata?.labels?.['olm.package'] || '',
      removedDeployments: removed,
    });
  }

  /**
   * MetalLB operator effects: once the operator CSV is Succeeded AND a MetalLB
   * custom resource exists (the operand CR the docs require after installing
   * the operator), the operator deploys the controller Deployment and the
   * speaker DaemonSet in the CR's namespace. Deleting the CR (or the CSV)
   * tears the operands down again.
   */
  _tickMetalLBOperands(dt) {
    const csvReady = this.cluster
      .getByKind('ClusterServiceVersion')
      .some(
        (csv) =>
          csv.status.phase === 'Succeeded' &&
          (/metallb/i.test(csv.metadata?.name || '') ||
            /^metallb/.test(String(csv.metadata?.labels?.['olm.package'] || '')))
      );
    const crs = this.cluster.getByKind('MetalLB');
    const desired = new Map();
    if (csvReady) {
      for (const cr of crs) {
        const namespace = cr.metadata.namespace;
        desired.set(`Deployment/${namespace}/controller`, {
          kind: 'Deployment',
          name: 'controller',
          namespace,
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: 'metallb', component: 'controller' } },
            template: {
              metadata: { labels: { app: 'metallb', component: 'controller' } },
              spec: {
                serviceAccountName: 'default',
                containers: [
                  {
                    name: 'controller',
                    image: 'quay.io/metallb/controller:v0.14.9',
                    args: ['--port=7472', '--log-level=info'],
                    ports: [{ name: 'monitoring', containerPort: 7472 }],
                    resources: {
                      requests: { cpu: '10m', memory: '32Mi' },
                      limits: { cpu: '100m', memory: '128Mi' },
                    },
                  },
                ],
              },
            },
          },
        });
        desired.set(`DaemonSet/${namespace}/speaker`, {
          kind: 'DaemonSet',
          name: 'speaker',
          namespace,
          spec: {
            selector: { matchLabels: { app: 'metallb', component: 'speaker' } },
            template: {
              metadata: { labels: { app: 'metallb', component: 'speaker' } },
              spec: {
                serviceAccountName: 'default',
                containers: [
                  {
                    name: 'speaker',
                    image: 'quay.io/metallb/speaker:v0.14.9',
                    args: ['--port=7472', '--log-level=info'],
                    ports: [{ name: 'monitoring', containerPort: 7472 }],
                    resources: {
                      requests: { cpu: '10m', memory: '32Mi' },
                      limits: { cpu: '100m', memory: '128Mi' },
                    },
                  },
                ],
              },
            },
          },
        });
      }
    }

    // Create/reconcile the operands that should exist.
    for (const wanted of desired.values()) {
      const existing = this.cluster.getByName(wanted.kind, wanted.name, wanted.namespace);
      if (existing) {
        this._metallbOperands.set(existing.uid, {
          kind: wanted.kind,
          name: wanted.name,
          namespace: wanted.namespace,
        });
        continue;
      }
      const created = this.cluster.addResource({
        kind: wanted.kind,
        metadata: {
          name: wanted.name,
          namespace: wanted.namespace,
          labels: {
            app: 'metallb',
            component: wanted.kind === 'Deployment' ? 'controller' : 'speaker',
            'app.kubernetes.io/managed-by': 'metallb-operator',
          },
        },
        spec: deepClone(wanted.spec),
      });
      if (created)
        this._metallbOperands.set(created.uid, {
          kind: wanted.kind,
          name: wanted.name,
          namespace: wanted.namespace,
        });
    }

    // Remove operands that are no longer desired (CR or operator removed).
    for (const [uid, entry] of this._metallbOperands) {
      const resource = this.cluster.get(uid);
      if (!resource) {
        this._metallbOperands.delete(uid);
        continue;
      }
      const key = `${entry.kind}/${entry.namespace}/${entry.name}`;
      if (desired.has(key)) continue;
      this.cluster.remove(uid);
      this._metallbOperands.delete(uid);
    }
  }

  _tickMetalLB(dt) {
    // MetalLB only programs LoadBalancer Services when the operator is
    // installed AND the MetalLB operand CR exists (real MetalLB flow).
    const metallbCRs = this.cluster.getByKind('MetalLB');
    const csvReady = this.cluster
      .getByKind('ClusterServiceVersion')
      .some((csv) => csv.status.phase === 'Succeeded' && /metallb/i.test(csv.metadata?.name || ''));
    const metallbInstalled = metallbCRs.length > 0 && csvReady;
    const pools = this.cluster
      .getByKind('IPAddressPool')
      .filter((pool) => (pool.spec?.addresses || []).length > 0);
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

    const services = this.cluster
      .getByKind('Service')
      .filter((service) => service.spec.type === 'LoadBalancer');
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
        ingress: [
          {
            ip: address,
            ipMode: 'VIP',
            hostname: '',
          },
        ],
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
    const requestedPool =
      service?.metadata?.annotations?.['metallb.universe.tf/address-pool'] ||
      service?.metadata?.annotations?.['metallb.io/address-pool'] ||
      '';
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
      for (let offset = 1; offset < maxAddresses; offset++)
        results.push(this._intToIp((network + offset) >>> 0));
      return results;
    }
    return [value];
  }

  _ipToInt(parts) {
    return (
      (((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + parts[3]) >>>
      0
    );
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
        const hasConfigChange = (buildConfig.spec.triggers || []).some(
          (trigger) => trigger.type === 'ConfigChange'
        );
        const hasBuilds = this.cluster.getBuildsForConfig(buildConfig).length > 0;
        if (hasConfigChange && !hasBuilds) {
          buildConfig._autoBuildElapsed = 0;
        }
      }
      const triggers = buildConfig.spec.triggers || [];
      const hasConfigChange = triggers.some((trigger) => trigger.type === 'ConfigChange');
      const generation = Number(buildConfig.metadata.generation) || 1;
      if (buildConfig._lastConfigChangeGeneration === undefined)
        buildConfig._lastConfigChangeGeneration = generation;
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
        (entry) =>
          (entry.from?.name || entry.fromName) === fromName &&
          (entry.from?.namespace || streamNamespace) === streamNamespace
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
        (entry) =>
          (entry.from?.name || entry.fromName) === fromName &&
          (entry.from?.namespace || streamNamespace) === streamNamespace
      );
      if (!freshRecord) {
        freshRecord = {
          from: { kind: 'ImageStreamTag', name: fromName, namespace: streamNamespace },
        };
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
    const owner = build.metadata.ownerReferences.find(
      (reference) => reference.kind === 'BuildConfig'
    );
    if (owner)
      return (
        this.cluster.get(owner.uid) || this.cluster.getBuildConfig(build.namespace, owner.name)
      );
    return this.cluster.getBuildConfig(
      build.namespace,
      build.metadata.labels?.buildconfig || build.metadata.labels?.['buildconfig.openshift.io/name']
    );
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
      return (
        (this._hashString(`${build.metadata.name}:failure`) % 1000) / 1000 <
        Number(buildConfig.spec.failureRate)
      );
    }
    if (!(this.buildFailureRate > 0)) return false;
    return (
      (this._hashString(`${build.metadata.name}:failure`) % 1000) / 1000 < this.buildFailureRate
    );
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
      this._triggerImageChangeRollout(
        namespace,
        imageStreamName,
        tag,
        result.tagEntry?.items?.[0]?.dockerImageReference
      );
    }

    if (buildConfig) {
      buildConfig.status.lastVersion = Math.max(
        buildConfig.status?.lastVersion || 0,
        Number(build.status?.version) || buildConfig.status?.lastVersion || 0
      );
      this.cluster.update(buildConfig.uid, buildConfig);
    }
    build.recordEvent(
      'Normal',
      'BuildCompleted',
      `Build ${build.metadata.name} completed successfully`
    );
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
      imageStream.status.dockerImageRepository =
        imageStream.status.dockerImageRepository ||
        `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStream.metadata.name}`;
      imageStream.status.publicDockerImageRepository = `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStream.metadata.name}`;
      imageStream.status.tags = imageStream.status.tags || [];

      for (const specTag of imageStream.spec.tags || []) {
        const tagName = specTag.name || 'latest';
        let statusTag = imageStream.status.tags.find((entry) => entry.tag === tagName);
        if (!statusTag) {
          statusTag = { tag: tagName, items: [] };
          imageStream.status.tags.push(statusTag);
        }
        if (
          statusTag.items.length === 0 &&
          specTag.from?.kind === 'DockerImage' &&
          specTag.from.name
        ) {
          statusTag.items = [
            {
              dockerImageReference: specTag.from.name,
              image: `sha256:${this.cluster._fakeDigest(specTag.from.name)}`,
              generation: 1,
              created: new Date().toISOString(),
            },
          ];
        }
      }
    }
  }

  // ── OpenShift: OLM subscriptions ───────────────────────────────────────

  /** Latch ResolutionFailed on a Subscription (idempotent, event + bus hook). */
  _failSubscriptionResolution(subscription, packageName, resolutionMessage) {
    if (subscription.status.reason === 'ConstraintsNotSatisfiable') return;
    subscription.status.phase = 'UpgradePending';
    subscription.status.reason = 'ConstraintsNotSatisfiable';
    subscription.status.message = resolutionMessage;
    subscription.setCondition(
      'ResolutionFailed',
      'True',
      'ConstraintsNotSatisfiable',
      resolutionMessage
    );
    subscription.setCondition('InstallPlanPending', 'False', 'NoInstallPlan', '');
    this.cluster.update(subscription.uid, subscription);
    subscription.recordEvent('Warning', 'ResolutionFailed', resolutionMessage);
    this.cluster.update(subscription.uid, subscription);
    this.eventBus?.emit('operator:resolution-failed', {
      name: subscription.metadata.name,
      namespace: subscription.metadata.namespace,
      packageName,
      message: resolutionMessage,
    });
  }

  /**
   * OLM resolves Subscription dependencies per namespace / OperatorGroup, not
   * per Subscription: if any package in a namespace is absent from the catalog,
   * the namespace's resolution fails as a unit, so EVERY Subscription sharing
   * that OperatorGroup reports ResolutionFailed (issue #26).
   *
   * @returns {Map<string, {packageName: string, subscriptionName: string}>}
   *   namespace → the first unresolved package it tracks
   */
  _resolutionFailuresByNamespace() {
    const failures = new Map();
    for (const subscription of this.cluster.getByKind('Subscription')) {
      if (subscription.metadata.deletionTimestamp) continue;
      const namespace = subscription.metadata.namespace;
      if (failures.has(namespace)) continue;
      const packageName = this._packageNameForSubscription(subscription);
      if (this.cluster.getByName('PackageManifest', packageName, '')) continue;
      failures.set(namespace, { packageName, subscriptionName: subscription.metadata.name });
    }
    return failures;
  }

  _tickSubscriptions(dt) {
    const resolutionFailures = this._resolutionFailuresByNamespace();
    for (const subscription of this.cluster.getByKind('Subscription')) {
      if (subscription.metadata.deletionTimestamp) continue;
      const namespace = subscription.metadata.namespace;
      const packageName = this._packageNameForSubscription(subscription);
      // The Subscription CRD defaults spec.installPlanApproval to Automatic.
      // Manifest apply stores the spec verbatim, so restore the API default
      // here instead of reporting `undefined` before/until the controller runs.
      if (!subscription.spec.installPlanApproval) {
        subscription.spec.installPlanApproval = 'Automatic';
        this.cluster.update(subscription.uid, subscription);
      }
      const csvName = this._csvNameForPackage(packageName);
      const version = this._csvVersionForPackage(packageName);
      const setStatus = (reason, message, phase = subscription.status.phase || 'Installing') => {
        if (subscription.status.phase === phase && subscription.status.reason === reason) return;
        subscription.status.phase = phase;
        subscription.status.reason = reason;
        subscription.status.message = message || '';
        this.cluster.update(subscription.uid, subscription);
      };

      // Simulated install failure flag (used by the OperatorInstallFailed incident).
      if (subscription.spec?.failure === true || subscription.spec?.installFailed === true) {
        if (subscription.status.phase !== 'Failed') {
          subscription.status.phase = 'Failed';
          subscription.status.reason = 'InstallFailed';
          subscription.status.message =
            subscription.spec.failureMessage || `operator ${packageName} failed to install`;
          subscription.setCondition(
            'InstallPlanComplete',
            'False',
            'InstallFailed',
            subscription.status.message
          );
          this.cluster.update(subscription.uid, subscription);
          this.eventBus?.emit('operator:failed', {
            name: subscription.metadata.name,
            namespace,
            packageName,
          });
        }
        continue;
      }
      if (subscription.status.phase === 'Failed') {
        // Failure flag cleared → retry the install.
        subscription.status.phase = 'Installing';
        subscription.status.reason = 'Installing';
        subscription._installElapsed = 0;
        this.cluster.update(subscription.uid, subscription);
        continue;
      }

      // A namespaced API object requires its project to exist.
      if (!this.cluster.getByName('Project', namespace, '')) {
        setStatus('NamespaceNotFound', `namespaces "${namespace}" not found`);
        if (!subscription._noNamespaceLogged) {
          subscription._noNamespaceLogged = true;
          subscription.setCondition(
            'InstallPlanPending',
            'False',
            'NamespaceNotFound',
            `namespaces "${namespace}" not found`
          );
          subscription.recordEvent(
            'Warning',
            'FailedCreate',
            `namespaces "${namespace}" not found`
          );
          this.cluster.update(subscription.uid, subscription);
        }
        continue;
      }
      subscription._noNamespaceLogged = false;

      // Catalog resolution (issues #18/#26): OLM resolves the namespace's
      // dependency set as a whole, so when any Subscription in this namespace
      // tracks a package that is missing from the catalog, every Subscription
      // sharing the OperatorGroup reports ConstraintsNotSatisfiable /
      // ResolutionFailed and nothing is installed in that namespace — no
      // phantom CSV, and a healthy sibling is not silently ignored.
      const resolutionFailure = resolutionFailures.get(namespace);
      if (resolutionFailure) {
        const ownPackageMissing = resolutionFailure.subscriptionName === subscription.metadata.name;
        const resolutionMessage = ownPackageMissing
          ? `constraints not satisfiable: no operators found in package "${resolutionFailure.packageName}" in the catalog referenced by the subscription`
          : `constraints not satisfiable: no operators found in package "${resolutionFailure.packageName}" in the catalog referenced by the namespace; OLM resolves namespace "${namespace}" as a unit`;
        this._failSubscriptionResolution(subscription, packageName, resolutionMessage);
        continue;
      }
      // Safety net if the namespace-level snapshot missed a package (e.g. the
      // catalog changed between the map build and this iteration).
      const catalogEntry = this.cluster.getByName('PackageManifest', packageName, '');
      if (!catalogEntry) {
        this._failSubscriptionResolution(
          subscription,
          packageName,
          `constraints not satisfiable: no operators found in package "${packageName}" in the catalog referenced by the subscription`
        );
        continue;
      }
      if (subscription.status.reason === 'ConstraintsNotSatisfiable') {
        // Package appeared later (e.g. catalog refreshed) → retry resolution.
        subscription.status.phase = 'Installing';
        subscription.status.reason = 'Installing';
        subscription._installElapsed = 0;
        this.cluster.update(subscription.uid, subscription);
      }

      // OperatorGroup: openshift-operators has the cluster-global group, other
      // namespaces require one (SingleNamespace installs) before OLM can deploy
      // the CSV (real 4.22 semantics — issue #9).
      const globalNamespace = namespace === 'openshift-operators';
      const operatorGroup =
        this.cluster.getByKindAndNamespace('OperatorGroup', namespace)[0] || null;
      if (!globalNamespace && !operatorGroup) {
        setStatus('NoOperatorGroup', `no operator group found in namespace "${namespace}"`);
        if (!subscription._noOperatorGroupLogged) {
          subscription._noOperatorGroupLogged = true;
          subscription.setCondition(
            'InstallPlanPending',
            'False',
            'NoOperatorGroup',
            `no operator group found in namespace "${namespace}"`
          );
          subscription.recordEvent(
            'Warning',
            'NoOperatorGroup',
            'OperatorGroup required to install this operator in the namespace'
          );
          this.cluster.update(subscription.uid, subscription);
          this.eventBus?.emit('operator:no-operatorgroup', {
            name: subscription.metadata.name,
            namespace,
            packageName,
            message: `no operator group found in namespace "${namespace}"`,
          });
        }
        continue;
      }
      subscription._noOperatorGroupLogged = false;

      // A Subscription whose CSV was deleted re-installs it (OLM keeps the
      // operator installed while the Subscription exists). Only deleting the
      // Subscription too makes the CSV deletion the real uninstall.
      let csv = this._csvForSubscription(subscription, namespace);
      if (
        (subscription.status.phase === 'Succeeded' ||
          subscription.status.installPlanComplete === true) &&
        !csv
      ) {
        subscription.status.phase = 'Installing';
        subscription.status.reason = 'Installing';
        subscription.status.installedCSV = '';
        subscription.status.currentCSV = '';
        subscription._installElapsed = 0;
        this.cluster.update(subscription.uid, subscription);
        continue;
      }

      if (typeof subscription._installElapsed !== 'number') {
        subscription._installElapsed = 0;
        subscription.status.phase = 'Installing';
        subscription.status.reason = 'Installing';
        subscription.status.message = `installing operator ${packageName}`;
        this.cluster.update(subscription.uid, subscription);
        this.eventBus?.emit('operator:installing', {
          name: subscription.metadata.name,
          namespace,
          packageName,
          csv: csvName,
        });
      }
      subscription._installElapsed += dt;
      const elapsed = subscription._installElapsed;

      // 1) InstallPlan (RequiresApproval until approved for Manual installs).
      let plan = this._installPlanForSubscription(subscription, namespace);
      if (!plan && elapsed >= 0.5) {
        const suffix = this._randomSuffix();
        plan = this.cluster.addResource({
          kind: 'InstallPlan',
          metadata: {
            name: `install-${suffix}`,
            namespace,
            labels: {
              'operators.coreos.com/subscription': subscription.metadata.name,
              'operators.coreos.com/package': packageName,
            },
          },
          spec: {
            approval: subscription.spec?.installPlanApproval || 'Automatic',
            approved: false,
            clusterServiceVersionNames: [csvName],
            source: subscription.spec?.source || '',
            sourceNamespace: subscription.spec?.sourceNamespace || '',
          },
          status: { phase: 'RequiresApproval' },
        });
        if (plan) {
          plan.setPlan(csvName, version);
          this.cluster.update(plan.uid, plan);
          this.eventBus?.emit('installplan:created', {
            name: plan.metadata.name,
            namespace,
            subscription: subscription.metadata.name,
            csv: csvName,
          });
        }
      }
      if (!plan) continue;

      // Automatic plans are approved by OLM; Manual plans wait for the player
      // (`oc patch installplan install-xxxxx --type=merge -p '{"spec":{"approved":true}}'`).
      if (plan.spec.approval !== 'Manual' && plan.spec.approved !== true) {
        plan.spec.approved = true;
        this.cluster.update(plan.uid, plan);
      }
      if (plan.spec.approved !== true) {
        subscription.setCondition(
          'InstallPlanPending',
          'False',
          'RequiresApproval',
          `install plan ${plan.metadata.name} requires approval`
        );
        setStatus('RequiresApproval', `install plan ${plan.metadata.name} requires approval`);
        continue;
      }
      if (typeof plan._approvedAtGameSeconds !== 'number')
        plan._approvedAtGameSeconds = this.gameSeconds;
      if (plan.status.phase !== 'Complete') {
        if (
          elapsed >= 1 ||
          this.gameSeconds - plan._approvedAtGameSeconds >= INSTALLPLAN_COMPLETE_SECONDS
        ) {
          plan.markComplete();
          this.cluster.update(plan.uid, plan);
          subscription.status.installPlanRef = { name: plan.metadata.name, namespace };
          this.cluster.update(subscription.uid, subscription);
          this.eventBus?.emit('installplan:complete', {
            name: plan.metadata.name,
            namespace,
            subscription: subscription.metadata.name,
          });
        } else {
          setStatus('Installing', `waiting for InstallPlan ${plan.metadata.name} to complete`);
          continue;
        }
      }

      // 2) ClusterServiceVersion, named after the package (never the Subscription).
      csv = this._csvForSubscription(subscription, namespace);
      if (!csv) {
        csv = this.cluster.addResource({
          kind: 'ClusterServiceVersion',
          metadata: {
            name: csvName,
            namespace,
            labels: {
              'operators.coreos.com/subscription': subscription.metadata.name,
              'olm.package': packageName,
            },
            annotations: {
              'olm.operatorNamespace': namespace,
              'olm.operatorGroup': operatorGroup
                ? `${operatorGroup.metadata.namespace}/${operatorGroup.metadata.name}`
                : '',
              'olm.targetNamespaces':
                operatorGroup &&
                Array.isArray(operatorGroup.spec.targetNamespaces) &&
                operatorGroup.spec.targetNamespaces.length > 0
                  ? operatorGroup.spec.targetNamespaces.join(',')
                  : globalNamespace
                    ? ''
                    : namespace,
            },
          },
          spec: {
            displayName: this._catalogDisplayName(packageName),
            version,
            customresourcedefinitions: { owned: deepClone(this._catalogCrds(packageName)) },
          },
          status: { phase: 'Installing' },
        });
        if (csv) {
          csv._installStartedAt = this.gameSeconds;
          csv.markInstalling(`installing ${csvName}`);
          this.cluster.update(csv.uid, csv);
          this._knownCSVs.set(csv.uid, { name: csvName, namespace, packageName });
          subscription.status.currentCSV = csvName;
          this.cluster.update(subscription.uid, subscription);
          this.eventBus?.emit('operator:csv-created', {
            name: csvName,
            namespace,
            packageName,
            subscription: subscription.metadata.name,
          });
        }
      }
      if (!csv) continue;

      // 3) CSV install strategy → Succeeded + operator Deployment.
      if (csv.status.phase !== 'Succeeded') {
        if (typeof csv._installStartedAt !== 'number') csv._installStartedAt = this.gameSeconds;
        if (this.gameSeconds - csv._installStartedAt < CSV_INSTALL_SECONDS) {
          setStatus('Installing', `waiting for ClusterServiceVersion ${csvName} to succeed`);
          continue;
        }
        csv.markSucceeded();
        this.cluster.update(csv.uid, csv);
        this._knownCSVs.set(csv.uid, { name: csvName, namespace, packageName });
        this.eventBus?.emit('operator:csv-succeeded', { name: csvName, namespace, packageName });
      }
      const operatorDeployment = this._ensureOperatorDeploymentForCSV(csv, packageName);
      if (operatorDeployment && operatorDeployment.status?.phase !== 'Running') {
        // Deployment controller creates the operator Pod; nothing else to do here.
      }

      if (subscription.status.phase !== 'Succeeded') {
        subscription.status.phase = 'Succeeded';
        subscription.status.installedCSV = csvName;
        subscription.status.currentCSV = csvName;
        subscription.status.reason = 'InstallSucceeded';
        subscription.status.message = `operator ${packageName} installed successfully`;
        subscription.status.installPlanRef = { name: plan.metadata.name, namespace };
        subscription.status.installPlanComplete = true;
        subscription.setCondition('InstallPlanComplete', 'True', 'InstallSucceeded');
        subscription.setCondition('InstallPlanPending', 'False', 'InstallPlanComplete');
        this.cluster.update(subscription.uid, subscription);
        if (!subscription._installedEmitted) {
          subscription._installedEmitted = true;
          this.eventBus?.emit('operator:installed', {
            name: subscription.metadata.name,
            namespace,
            packageName,
            csv: csvName,
            channel: subscription.spec?.channel,
            source: subscription.spec?.source,
            resource: subscription,
          });
        }
      }
    }

    // Keep track of CSVs created by earlier ticks so deleting them (including
    // during level teardown) performs the uninstall cleanup exactly once.
    for (const csv of this.cluster.getByKind('ClusterServiceVersion')) {
      if (!this._knownCSVs.has(csv.uid)) {
        const packageName =
          csv.metadata?.labels?.['olm.package'] ||
          String(csv.metadata?.name || '').replace(/\.v\d.*$/, '');
        this._knownCSVs.set(csv.uid, {
          name: csv.metadata.name,
          namespace: csv.metadata.namespace,
          packageName,
        });
      }
    }
    for (const [uid, entry] of this._knownCSVs) {
      if (!this.cluster.get(uid)) {
        this._onCSVDeleted({
          ...entry,
          metadata: {
            name: entry.name,
            namespace: entry.namespace,
            labels: { 'olm.package': entry.packageName },
          },
        });
        this._knownCSVs.delete(uid);
      }
    }
  }

  /** Display name advertised by the catalog for a package. */
  _catalogDisplayName(packageName) {
    const entry = OLM_CATALOG.find((candidate) => candidate.name === packageName);
    if (entry) return entry.displayName;
    return String(packageName)
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  /** CRDs advertised by the catalog for a package (CSV customresourcedefinitions). */
  _catalogCrds(packageName) {
    const entry = OLM_CATALOG.find((candidate) => candidate.name === packageName);
    return entry?.crds || [];
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
          pod.recordEvent(
            'Normal',
            'SCCAdmitted',
            `Security context constraint ${resolution.scc?.metadata.name || 'restricted-v2'} admitted the pod`
          );
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
      pod.setAnnotation(
        'openshiftgames/denied-reason',
        `pods "${pod.metadata.name}" is forbidden: ${message}`
      );
      pod.status.phase = 'Failed';
      pod.setCondition('Ready', 'False', 'SCCDenied', message);
      pod.recordEvent(
        'Warning',
        'FailedCreate',
        `Error creating: pods "${pod.metadata.name}" is forbidden: ${message}`
      );
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
    return this._resolveAdmissionForSpec(pod.spec || {}, pod.metadata?.namespace || 'default', pod);
  }

  /**
   * SCC admission for a (candidate) Pod spec. Works before the Pod object
   * exists, so controllers can reject a workload without ever creating a Pod
   * (issue #13: real clusters show `FailedCreate … unable to validate against
   * any security context constraint` on the ReplicaSet and no Pod).
   *
   * @param {object} podSpec
   * @param {string} namespace
   * @returns {{allowed: boolean, scc: object|null, candidates: object[], message?: string}}
   */
  _resolveAdmissionForSpec(podSpec, namespace) {
    // SCC admission only sees the explicit pod spec (RBACEngine.podSecurityRequest):
    // a bare `nginx:latest` with no securityContext is ADMITTED by restricted-v2
    // and only fails later at runtime (issue #25). Known-image personalities are
    // therefore NOT folded into the admission spec.
    const candidate = {
      metadata: { name: 'admission-candidate', namespace, labels: {} },
      spec: podSpec || {},
    };
    const resolution = this.cluster.resolveSCCForPod(candidate);
    if (resolution.allowed) return resolution;
    if (resolution.candidates && resolution.candidates.length > 0) {
      return {
        ...resolution,
        message: 'unable to validate against any security context constraint',
      };
    }

    // No SCC bound to the service account at all (e.g. a custom namespace the
    // player just created): restricted pods are still admitted, elevated ones
    // are not (matches the real default `system:authenticated` binding).
    const request = podSecurityRequest(podSpec || {});
    const elevated =
      request.privileged ||
      request.hostNetwork ||
      request.hostPID ||
      request.hostIPC ||
      request.hostPath ||
      request.hostPorts.length > 0 ||
      request.runAsUsers.includes(0);
    if (elevated) {
      return {
        ...resolution,
        allowed: false,
        message: 'unable to validate against any security context constraint',
      };
    }
    const restricted = this.cluster.getSCC('restricted-v2') || this.cluster.getSCCs()[0] || null;
    if (restricted && this.cluster.sccAllowsPod(restricted, podSpec || {})) {
      return { allowed: true, scc: restricted, candidates: [restricted] };
    }
    return { ...resolution, message: 'unable to validate against any security context constraint' };
  }

  /**
   * Record a controller-side FailedCreate (no Pod object is created) the way
   * the ReplicaSet/Job/DaemonSet controllers do, with duplicate-event
   * throttling like a real events recorder.
   * @param {object} parent controller resource
   * @param {string} podName candidate pod name (for the message)
   * @param {string} message admission/validation reason
   * @returns {null}
   */
  _recordFailedCreate(parent, podName, message) {
    const reason = String(message || 'unable to admit pod');
    // Real events are aggregated, not one-per-pod-attempt: throttle on the
    // failure reason so a controller retrying every tick does not flood Events.
    const signature = reason;
    const last = parent._lastFailedCreate;
    if (
      last &&
      last.signature === signature &&
      this.gameSeconds - last.at < FAILED_CREATE_EVENT_SECONDS
    ) {
      return null;
    }
    parent._lastFailedCreate = { signature, at: this.gameSeconds };
    const fullMessage = `Error creating: pods "${podName}" ${reason}`;
    parent.recordEvent('Warning', 'FailedCreate', fullMessage);
    if (
      parent.kind === 'ReplicaSet' ||
      parent.kind === 'StatefulSet' ||
      parent.kind === 'DaemonSet'
    ) {
      parent.setCondition('ReplicaFailure', 'True', 'FailedCreate', `pods "${podName}" ${reason}`);
      parent.status.replicas = parent.status.replicas || 0;
      parent.status.readyReplicas = 0;
      parent.status.availableReplicas = 0;
      parent.status.observedGeneration = parent.metadata.generation;
    }
    this.cluster.update(parent.uid, parent);
    this.eventBus?.emit('pod:failedcreate', {
      kind: parent.kind,
      name: parent.metadata.name,
      namespace: parent.metadata.namespace,
      pod: podName,
      message: `pods "${podName}" ${reason}`,
      reason: 'FailedCreate',
    });
    return null;
  }

  /** True when a controller resource currently has an active FailedCreate. */
  _hasReplicaFailure(parent) {
    return (parent?.status?.conditions || []).some(
      (condition) => condition.type === 'ReplicaFailure' && condition.status === 'True'
    );
  }

  /** Clear the FailedCreate condition after the controller succeeds again. */
  _clearReplicaFailure(parent) {
    if (!this._hasReplicaFailure(parent)) return;
    parent.setCondition('ReplicaFailure', 'False', 'NoReplicaFailure', '');
    parent._lastFailedCreate = null;
    this.cluster.update(parent.uid, parent);
  }

  /**
   * Validate a candidate Pod spec before it is created (API-server admission +
   * basic pod validation), returning a failure message or null when admitted.
   * @param {object} podSpec
   * @param {string} namespace
   * @param {string} podName
   * @returns {string|null}
   */
  _admissionFailureMessage(podSpec, namespace, podName) {
    const containers = podSpec?.containers || [];
    for (let index = 0; index < containers.length; index++) {
      const container = containers[index];
      if (!container || !String(container.image || '').trim()) {
        return `is invalid: spec.containers[${index}].image: Required value`;
      }
      if (!String(container.name || '').trim()) {
        return `is invalid: spec.containers[${index}].name: Required value`;
      }
    }
    const resolution = this._resolveAdmissionForSpec(podSpec, namespace);
    if (resolution.allowed) return null;
    return `is forbidden: ${resolution.message || 'unable to validate against any security context constraint'}`;
  }

  /** Whether a Pod is blocked by SCC/LimitRange/quota admission. */
  _isPodBlocked(pod) {
    const annotations = pod.metadata.annotations || {};
    return (
      annotations['openshiftgames/scc-denied'] === 'true' ||
      annotations['openshiftgames/limitrange-denied'] === 'true' ||
      annotations['openshiftgames/quota-denied'] === 'true'
    );
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
        const violations = this.cluster.checkLimitRange(
          pod.metadata.namespace,
          pod.spec || {}
        ).violations;
        if (violations.length === 0) {
          this._revivePod(pod, 'openshiftgames/limitrange-denied');
          pod.recordEvent(
            'Normal',
            'LimitRangeAdmitted',
            'Pod now satisfies the project LimitRange'
          );
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
        pod.setAnnotation(
          'openshiftgames/denied-reason',
          `pods "${pod.metadata.name}" is forbidden: ${check.violations[0]}`
        );
        pod.status.phase = 'Failed';
        pod.setCondition('Ready', 'False', 'LimitRangeViolation', check.violations[0]);
        pod.recordEvent(
          'Warning',
          'FailedCreate',
          `Error creating: pods "${pod.metadata.name}" is forbidden: ${check.violations[0]}`
        );
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
        if (
          this.cluster.checkQuota(pod.metadata.namespace, requests.cpu, requests.memory).allowed
        ) {
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
      pod.setAnnotation(
        'openshiftgames/denied-reason',
        `pods "${pod.metadata.name}" is forbidden: ${result.violations[0] || 'exceeded quota'}`
      );
      pod.status.phase = 'Failed';
      pod.setCondition('Ready', 'False', 'QuotaExceeded', result.violations[0] || 'exceeded quota');
      pod.recordEvent(
        'Warning',
        'FailedCreate',
        `Error creating: pods "${pod.metadata.name}" is forbidden: ${result.violations[0] || 'exceeded quota'}`
      );
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
          this.eventBus?.emit('quota:exceeded', {
            namespace,
            violations: result.violations,
            usage: result.usage,
          });
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
      oauth.status.conditions = [
        {
          type: provider ? 'Available' : 'Progressing',
          status: 'True',
          reason: provider ? 'IdentityProviderReady' : 'NoIdentityProviders',
          message: provider
            ? `identity provider ${provider.name} is ready`
            : 'no identity providers configured',
          lastTransitionTime: new Date().toISOString(),
        },
      ];
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
      operator.status.versions =
        operator.status.versions && operator.status.versions.length > 0
          ? operator.status.versions.map((entry) => ({ ...entry, version }))
          : [{ name: 'operator', version }];
      if (operator._forceDegraded) {
        operator.setCondition(
          'Degraded',
          'True',
          'Degraded',
          operator._degradedMessage || 'component is degraded'
        );
      }
      if (operator._forceUnavailable) {
        operator.setCondition(
          'Available',
          'False',
          'Unavailable',
          operator._unavailableMessage || 'component is unavailable'
        );
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
      for (const pod of this.cluster
        .getByKind('Pod')
        .filter((entry) => entry.status.phase === 'Running')) {
        if (Math.random() < this.chaosConfig.podKillRate * dt) {
          pod.setPhase('Failed');
          pod.recordEvent('Warning', 'ChaosKilled', 'Pod killed by chaos engineering');
          this.eventBus?.emit('chaos:podkill', { pod: pod.name, namespace: pod.namespace });
        }
      }
    }
    if (this.chaosConfig.nodeFailRate > 0) {
      for (const node of this.cluster
        .getByKind('Node')
        .filter((entry) => entry.isConditionTrue('Ready'))) {
        if (Math.random() < this.chaosConfig.nodeFailRate * dt) {
          node.setPhase('NotReady');
          node.setCondition('Ready', 'False', 'ChaosNodeFailure');
          node.recordEvent('Warning', 'ChaosNodeDown', 'Node failed due to chaos injection');
          const pods = this.cluster
            .getByKind('Pod')
            .filter((pod) => pod.spec.nodeName === node.name && pod.status.phase === 'Running');
          for (const pod of pods) {
            pod.setPhase('Failed');
            pod.recordEvent('Warning', 'NodeLost', `Node ${node.name} became unreachable`);
          }
          this.eventBus?.emit('chaos:nodefailure', { node: node.name, podsEvicted: pods.length });
        }
      }
    }
    if (this.chaosConfig.cpuStress > 0 || this.chaosConfig.memoryStress > 0) {
      for (const pod of this.cluster
        .getByKind('Pod')
        .filter((entry) => entry.status.phase === 'Running' && entry.status.containerStatuses)) {
        for (const status of pod.status.containerStatuses) {
          if (!status.state.running) continue;
          if (this.chaosConfig.cpuStress > 0)
            status.resources.cpu += status.resources.cpuRequest * this.chaosConfig.cpuStress;
          if (this.chaosConfig.memoryStress > 0)
            status.resources.memory +=
              status.resources.memoryRequest * this.chaosConfig.memoryStress;
        }
      }
    }
  }

  _createPodForWorkload(parent, templateSource, nameOverride) {
    if (!parent) return null;
    // Do not spin up replacement pods while an admission-denied pod exists.
    if (
      this.cluster
        .getChildren(parent.uid)
        .some((child) => child.kind === 'Pod' && this._isPodBlocked(child))
    ) {
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
    podSpec.containers = podSpec.containers || [
      {
        name: 'main',
        image: 'app:latest',
        resources: {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        },
      },
    ];
    const selectorLabels = templateSource.spec?.selector?.matchLabels || {};
    const templateLabels = template.metadata?.labels || templateSource.metadata.labels || {};
    // The pod-template-hash must be identical on the ReplicaSet and all pods it
    // creates (it is the RS name suffix, not a per-pod random value).
    const templateHash =
      templateLabels['pod-template-hash'] || templateSource.metadata.labels?.['pod-template-hash'];
    const labels = { ...selectorLabels, ...templateLabels };
    if (templateHash) labels['pod-template-hash'] = templateHash;

    // API-server admission + validation happen BEFORE the Pod object exists:
    // a rejected workload create leaves no Pod behind (issue #13), just a
    // FailedCreate event/condition on the owning controller.
    const admissionFailure = this._admissionFailureMessage(podSpec, namespace, podName);
    if (admissionFailure) {
      this._recordFailedCreate(parent, podName, admissionFailure);
      return null;
    }

    const pod = this.cluster.addResource({
      kind: 'Pod',
      metadata: { name: podName, namespace, labels },
      spec: podSpec,
      status: { phase: 'Pending' },
    });
    if (!pod) return null;
    this.cluster.addRelationship(parent.uid, pod.uid);
    this._clearReplicaFailure(parent);
    if (parent.kind === 'ReplicaSet') {
      parent.status.replicas = (parent.status.replicas || 0) + 1;
      parent.recordEvent('Normal', 'SuccessfulCreate', `Created pod: ${podName}`);
    }
    return pod;
  }

  // ── NetworkPolicy traffic evaluation ───────────────────────────────────
  //
  // Real Kubernetes NetworkPolicy semantics: a Pod is isolated for a direction
  // as soon as any policy with that policyType selects it; traffic is then
  // allowed only by an explicit rule of one of those policies. Both egress (in
  // the source namespace) and ingress (in the destination namespace) must
  // allow the flow. OpenShift's dns-default pods listen on port 5353, so DNS
  // egress policies must open 5353 (not 53) to restore name resolution
  // (issue #14).

  /** Labels used to match a namespace selector (Project labels + name label). */
  _namespaceLabels(namespace) {
    const project = this.cluster.getByName('Project', namespace, '');
    const labels = {
      'kubernetes.io/metadata.name': namespace,
      ...(project?.metadata?.labels || {}),
    };
    // The ingress operator labels the router namespace so a NetworkPolicy can
    // allow router traffic after a default-deny (#33b):
    //   namespaceSelector: matchLabels: policy-group.network.openshift.io/ingress: ""
    if (namespace === ROUTER_NAMESPACE || namespace === 'openshift-ingress-operator') {
      if (labels[ROUTER_NAMESPACE_LABEL] === undefined) labels[ROUTER_NAMESPACE_LABEL] = '';
      if (labels['network.openshift.io/policy-group'] === undefined) {
        labels['network.openshift.io/policy-group'] = 'ingress';
      }
    }
    return labels;
  }

  /** Match a LabelSelector ({matchLabels,matchExpressions}) against labels. */
  _labelSelectorMatches(selector, labels) {
    if (!selector || typeof selector !== 'object') return true;
    const matchLabels =
      selector.matchLabels && typeof selector.matchLabels === 'object'
        ? selector.matchLabels
        : selector.matchExpressions
          ? {}
          : selector;
    for (const [key, value] of Object.entries(matchLabels)) {
      if ((labels || {})[key] !== value) return false;
    }
    for (const expression of selector.matchExpressions || []) {
      if (!expression || !expression.key) continue;
      const values = Array.isArray(expression.values) ? expression.values : [];
      const actual = (labels || {})[expression.key];
      switch (expression.operator) {
        case 'In':
          if (actual === undefined || !values.includes(actual)) return false;
          break;
        case 'NotIn':
          if (actual !== undefined && values.includes(actual)) return false;
          break;
        case 'Exists':
          if (actual === undefined) return false;
          break;
        case 'DoesNotExist':
          if (actual !== undefined) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }

  _networkPoliciesIn(namespace) {
    return this.cluster.getByKindAndNamespace('NetworkPolicy', namespace);
  }

  _policyTypes(policy) {
    if (Array.isArray(policy?.spec?.policyTypes) && policy.spec.policyTypes.length > 0) {
      return policy.spec.policyTypes.map((entry) => String(entry));
    }
    const types = ['Ingress'];
    if (Array.isArray(policy?.spec?.egress) && policy.spec.egress.length > 0) types.push('Egress');
    return types;
  }

  _policySelectsPod(policy, pod) {
    return this._labelSelectorMatches(policy?.spec?.podSelector || {}, pod?.metadata?.labels || {});
  }

  /** Policies that isolate `pod` for the given direction ('Ingress'|'Egress'). */
  _policiesForPod(pod, direction) {
    return this._networkPoliciesIn(pod?.metadata?.namespace || 'default').filter(
      (policy) =>
        this._policyTypes(policy).includes(direction) && this._policySelectsPod(policy, pod)
    );
  }

  _networkPolicyPortMatches(rulePorts, port, protocol, destinationPod) {
    if (!Array.isArray(rulePorts) || rulePorts.length === 0) return true;
    for (const rulePort of rulePorts) {
      if (!rulePort || typeof rulePort !== 'object') continue;
      const ruleProtocol = String(rulePort.protocol || 'TCP').toUpperCase();
      const wantedProtocol = String(protocol || 'TCP').toUpperCase();
      if (ruleProtocol !== wantedProtocol) continue;
      if (rulePort.port === undefined || rulePort.port === null || rulePort.port === '')
        return true;
      const numeric = Number(rulePort.port);
      if (Number.isFinite(numeric)) {
        if (Number(port) === numeric) return true;
        if (
          Number.isFinite(Number(rulePort.endPort)) &&
          Number(port) >= numeric &&
          Number(port) <= Number(rulePort.endPort)
        )
          return true;
        continue;
      }
      // Named port: resolve against the destination container ports.
      const matched = (destinationPod?.spec?.containers || []).some((container) =>
        (container.ports || []).some(
          (containerPort) =>
            containerPort.name === rulePort.port &&
            Number(containerPort.containerPort) === Number(port)
        )
      );
      if (matched) return true;
    }
    return false;
  }

  _ipInCidr(ip, cidr) {
    if (!ip || !cidr || !String(cidr).includes('/')) return false;
    const [network, prefixRaw] = String(cidr).split('/');
    const prefix = Number(prefixRaw);
    const toInt = (value) => {
      const parts = String(value).split('.').map(Number);
      if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
      return (
        (((parts[0] << 24) >>> 0) +
          ((parts[1] << 16) >>> 0) +
          ((parts[2] << 8) >>> 0) +
          parts[3]) >>>
        0
      );
    };
    const ipValue = toInt(ip);
    const networkValue = toInt(network);
    if (ipValue === null || networkValue === null || !Number.isFinite(prefix)) return false;
    if (prefix <= 0) return true;
    const mask = prefix >= 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipValue & mask) === (networkValue & mask);
  }

  /**
   * Does a NetworkPolicy peer (from/to entry) select `targetPod`?
   * @param {object} peer
   * @param {string} peerNamespace namespace the policy lives in (podSelector is scoped to it)
   * @param {object} targetPod
   */
  _peerMatchesPod(peer, peerNamespace, targetPod) {
    if (!peer || typeof peer !== 'object') return false;
    const targetNamespace = targetPod?.metadata?.namespace || 'default';
    if (peer.ipBlock) {
      const podIp = targetPod?.status?.podIP || null;
      if (!podIp) return false;
      if (!this._ipInCidr(podIp, peer.ipBlock.cidr)) return false;
      return !(peer.ipBlock.except || []).some((cidr) => this._ipInCidr(podIp, cidr));
    }
    const hasPodSelector = Boolean(peer.podSelector);
    const hasNamespaceSelector = Boolean(peer.namespaceSelector);
    if (!hasPodSelector && !hasNamespaceSelector) return true; // empty peer: everything
    if (hasNamespaceSelector) {
      if (
        !this._labelSelectorMatches(peer.namespaceSelector, this._namespaceLabels(targetNamespace))
      )
        return false;
    } else if (targetNamespace !== peerNamespace) {
      // A bare podSelector only matches Pods in the policy's own namespace.
      return false;
    }
    if (hasPodSelector)
      return this._labelSelectorMatches(peer.podSelector, targetPod?.metadata?.labels || {});
    return true;
  }

  _rulesAllowTraffic(rules, peerKey, peerNamespace, peerPod, port, protocol, destinationPod) {
    if (!Array.isArray(rules) || rules.length === 0) return false;
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      const peers = rule[peerKey];
      const peersMatch =
        !Array.isArray(peers) ||
        peers.length === 0 ||
        peers.some((peer) => this._peerMatchesPod(peer, peerNamespace, peerPod));
      if (!peersMatch) continue;
      if (!this._networkPolicyPortMatches(rule.ports, port, protocol, destinationPod)) continue;
      return true;
    }
    return false;
  }

  /**
   * Can pod-to-pod traffic flow from `source` to `target`?
   * @param {object|string} sourcePod
   * @param {object|string} target Pod, Service or `{kind,name,namespace}`
   * @param {{port?: number, protocol?: string, namespace?: string}} [options]
   * @returns {{allowed: boolean, reason: string, policy?: string, pods?: object[]}}
   */
  canReach(sourcePod, target, options = {}) {
    const namespace = options.namespace || 'default';
    const source = this._resolvePodLike(sourcePod, namespace);
    if (!source) return { allowed: false, reason: 'source-not-found' };
    const destination = this._resolveTrafficDestination(target, options);
    if (!destination) return { allowed: false, reason: 'target-not-found' };
    if (destination.pods.length === 0) return { allowed: false, reason: 'no-endpoints', pods: [] };
    const requestedPort = Number(options.port ?? destination.port ?? 80);
    const port = Number.isFinite(requestedPort) ? requestedPort : 80;
    const protocol = String(options.protocol || 'TCP').toUpperCase();

    for (const destinationPod of destination.pods) {
      const egressPolicies = this._policiesForPod(source, 'Egress');
      let egressAllowed = egressPolicies.length === 0;
      let blockedBy = null;
      if (!egressAllowed) {
        for (const policy of egressPolicies) {
          if (
            this._rulesAllowTraffic(
              policy.spec?.egress,
              'to',
              policy.metadata.namespace,
              destinationPod,
              port,
              protocol,
              destinationPod
            )
          ) {
            egressAllowed = true;
            break;
          }
          blockedBy = blockedBy || policy.metadata.name;
        }
      }
      if (!egressAllowed)
        return { allowed: false, reason: 'egress', policy: blockedBy, pods: destination.pods };

      const ingressPolicies = this._policiesForPod(destinationPod, 'Ingress');
      let ingressAllowed = ingressPolicies.length === 0;
      blockedBy = null;
      if (!ingressAllowed) {
        for (const policy of ingressPolicies) {
          if (
            this._rulesAllowTraffic(
              policy.spec?.ingress,
              'from',
              policy.metadata.namespace,
              source,
              port,
              protocol,
              destinationPod
            )
          ) {
            ingressAllowed = true;
            break;
          }
          blockedBy = blockedBy || policy.metadata.name;
        }
      }
      if (!ingressAllowed)
        return { allowed: false, reason: 'ingress', policy: blockedBy, pods: destination.pods };
      return { allowed: true, reason: 'allowed', pods: destination.pods };
    }
    return { allowed: false, reason: 'no-endpoints', pods: [] };
  }

  /**
   * DNS resolution requires egress to the dns-default pods in openshift-dns on
   * port 5353 (OpenShift's DNS pods do not listen on 53 — issue #14). When the
   * source Pod is selected by any egress policy, a rule must explicitly allow
   * that traffic or name resolution fails.
   * @param {object|string} sourcePod
   * @returns {{allowed: boolean, reason: string, policy?: string}}
   */
  canResolveDNS(sourcePod) {
    const source = this._resolvePodLike(sourcePod);
    if (!source) return { allowed: false, reason: 'source-not-found' };
    const dnsPod = {
      metadata: {
        name: 'dns-default',
        namespace: 'openshift-dns',
        labels: { 'dns.operator.openshift.io/daemonset-dns': 'default', app: 'dns-default' },
      },
      status: { podIP: '172.30.0.10', phase: 'Running' },
    };
    const egressPolicies = this._policiesForPod(source, 'Egress');
    if (egressPolicies.length === 0) return { allowed: true, reason: 'no-egress-policy' };
    for (const policy of egressPolicies) {
      for (const protocol of ['UDP', 'TCP']) {
        if (
          this._rulesAllowTraffic(
            policy.spec?.egress,
            'to',
            policy.metadata.namespace,
            dnsPod,
            5353,
            protocol,
            dnsPod
          )
        ) {
          return { allowed: true, reason: 'dns-egress-allowed', policy: policy.metadata.name };
        }
      }
    }
    return { allowed: false, reason: 'dns-egress', policy: egressPolicies[0]?.metadata.name };
  }

  /** Resolve a pod resource / name / uid used by the evaluators. */
  _resolvePodLike(value, namespace = 'default') {
    if (!value) return null;
    if (typeof value === 'string') {
      return this.cluster.getByName('Pod', value, namespace) || this.cluster.get(value) || null;
    }
    if (value.metadata && value.spec) return value;
    if (value.uid) return this.cluster.get(value.uid);
    return null;
  }

  /** Resolve a `canReach` target into concrete Pods + a port. */
  _resolveTrafficDestination(target, options = {}) {
    const namespace = options.namespace || 'default';
    if (!target) return null;
    if (typeof target === 'object') {
      if (target.kind === 'Service' || target.spec?.selector) {
        const pods = this.cluster.getServiceEndpoints(target);
        const resolvedPort = this._routeBackendPort(
          { spec: { port: { targetPort: options.targetPort } } },
          target,
          pods
        );
        const port = Number(options.port ?? resolvedPort);
        return {
          kind: 'Service',
          name: target.metadata?.name,
          pods,
          port: Number.isFinite(port) ? port : resolvedPort,
        };
      }
      if (target.kind === 'Pod' || (target.metadata && target.spec)) {
        const pod = this._resolvePodLike(target, namespace);
        const port = Number(
          options.port ?? pod?.spec?.containers?.[0]?.ports?.[0]?.containerPort ?? 80
        );
        return pod ? { kind: 'Pod', name: pod.metadata.name, pods: [pod], port } : null;
      }
      if (target.kind && target.name) {
        const resource = this.cluster.getByName(
          target.kind,
          target.name,
          target.namespace || namespace
        );
        return resource ? this._resolveTrafficDestination(resource, options) : null;
      }
      return null;
    }

    let host = String(target).trim();
    if (!host) return null;
    host = host.replace(/^https?:\/\//, '').split('/')[0];
    let port = options.port !== undefined ? Number(options.port) : undefined;
    const portMatch = host.match(/^(.*):(\d+)$/);
    if (portMatch) {
      host = portMatch[1];
      if (port === undefined) port = Number(portMatch[2]);
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      const pod = this.cluster.getByKind('Pod').find((entry) => entry.status?.podIP === host);
      return pod
        ? {
            kind: 'Pod',
            name: pod.metadata.name,
            pods: [pod],
            port: port ?? 80,
            host,
            requiresDNS: false,
          }
        : { kind: 'IP', name: host, pods: [], port: port ?? 80, host, requiresDNS: false };
    }
    const svcMatch = host.match(
      /^([a-z0-9-]+)(?:\.([a-z0-9-]+))?(?:\.svc(?:\.cluster\.local)?)?$/i
    );
    const serviceName = svcMatch ? svcMatch[1] : host;
    const serviceNamespace = svcMatch && svcMatch[2] ? svcMatch[2] : namespace;
    const service = this.cluster.getByName('Service', serviceName, serviceNamespace);
    if (service) {
      const pods = this.cluster.getServiceEndpoints(service);
      const resolvedPort = this._routeBackendPort(
        { spec: { port: { targetPort: options.targetPort } } },
        service,
        pods
      );
      const numericPort = Number(port ?? resolvedPort);
      return {
        kind: 'Service',
        name: serviceName,
        namespace: serviceNamespace,
        pods,
        port: Number.isFinite(numericPort) ? numericPort : 80,
        host,
        requiresDNS: true,
      };
    }
    // Unresolvable/external host: name resolution is required and egress
    // policies around ipBlock decide reachability.
    return { kind: 'External', name: host, pods: [], port: port ?? 80, host, requiresDNS: true };
  }

  /**
   * Evaluate `oc exec <pod> -- curl <target>` against the cluster's
   * NetworkPolicies and return display-ready output lines.
   *
   * @param {object|string} sourcePod
   * @param {{target: string, namespace?: string, port?: number, protocol?: string}} options
   * @returns {{allowed: boolean, reason: string, policy: string|null, lines: string[]}}
   */
  trafficForExec(sourcePod, options = {}) {
    const namespace = options.namespace || 'default';
    const source = this._resolvePodLike(sourcePod, namespace);
    if (!source) {
      return {
        allowed: false,
        reason: 'source-not-found',
        policy: null,
        lines: ['error: unable to resolve the source Pod'],
      };
    }
    const destination = this._resolveTrafficDestination(options.target, { ...options, namespace });
    if (!destination) {
      return {
        allowed: false,
        reason: 'target-not-found',
        policy: null,
        lines: [`curl: (6) Could not resolve host: ${String(options.target || '')}`],
      };
    }
    const host = destination.host || destination.name || String(options.target || '');
    const port = Number(options.port ?? destination.port ?? 80);

    if (destination.requiresDNS) {
      const dns = this.canResolveDNS(source);
      if (!dns.allowed) {
        return {
          allowed: false,
          reason: 'dns-egress',
          policy: dns.policy || null,
          lines: [`curl: (6) Could not resolve host: ${host}`],
        };
      }
    }
    if (destination.kind === 'External') {
      // External traffic is only blocked by an egress policy that has no
      // matching ipBlock rule; the simulator has no external IPs, so treat an
      // egress-isolated Pod as blocked.
      const egressPolicies = this._policiesForPod(source, 'Egress');
      if (egressPolicies.length > 0) {
        return {
          allowed: false,
          reason: 'egress',
          policy: egressPolicies[0]?.metadata?.name || null,
          lines: [
            `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Connection timed out`,
          ],
        };
      }
      return {
        allowed: true,
        reason: 'external',
        policy: null,
        lines: ['<html><body>Hello from the Internet (container main)</body></html>'],
      };
    }
    if (destination.pods.length === 0) {
      return {
        allowed: false,
        reason: 'no-endpoints',
        policy: null,
        lines: [
          `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`,
        ],
      };
    }
    // The destination is already resolved to concrete Pods; evaluate against
    // the first endpoint (all endpoints of a Service share the selector rules).
    const reach = this.canReach(source, destination.pods[0], {
      port,
      protocol: options.protocol || 'TCP',
      namespace: destination.namespace || namespace,
    });
    if (!reach.allowed) {
      return {
        allowed: false,
        reason: reach.reason,
        policy: reach.policy || null,
        lines: [
          `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`,
        ],
      };
    }
    const destinationPod = reach.pods?.[0] || destination.pods[0];
    const app = destinationPod?.metadata?.labels?.app || destinationPod?.metadata?.name || host;
    const container = destinationPod?.spec?.containers?.[0]?.name || 'main';
    return {
      allowed: true,
      reason: 'allowed',
      policy: null,
      lines: [`<html><body>Hello from ${app} (container ${container})</body></html>`],
    };
  }

  // ── Router traffic + workstation curl (issues #32c, #33a, #33b) ────────
  //
  // A workstation `curl` resolves `<route>-<project>.apps.<domain>` through
  // the router. Admission only asks "does the Service have endpoints?", so a
  // Route can be Admitted=True while the router is blocked by the project's
  // NetworkPolicies — exactly the default-deny lesson (#33b). Router traffic is
  // evaluated as a synthetic `openshift-ingress` Pod, which is how the
  // `policy-group.network.openshift.io/ingress: ""` namespace selector works.

  /** Synthetic router Pod in `openshift-ingress` (source of Route traffic). */
  _routerPod() {
    return {
      metadata: {
        name: 'router-default-6b8f7c9d4-abcde',
        namespace: ROUTER_NAMESPACE,
        labels: { app: 'router', 'ingress.operator.openshift.io/default-router': 'true' },
      },
      spec: {
        containers: [
          {
            name: 'router',
            image: 'quay.io/openshift/origin-haproxy-router:4.22',
            ports: [
              { containerPort: 80, protocol: 'TCP' },
              { containerPort: 443, protocol: 'TCP' },
            ],
          },
        ],
      },
      status: { podIP: ROUTER_DEFAULT_IP, phase: 'Running' },
    };
  }

  /** Resolve a Route object / name / `{kind:'Route', name, namespace}` ref. */
  _resolveRouteLike(routeOrTarget, options = {}) {
    if (!routeOrTarget) return null;
    if (typeof routeOrTarget === 'string') {
      const namespace = options.namespace;
      if (namespace) return this.cluster.getByName('Route', routeOrTarget, namespace);
      return (
        this.cluster.getByKind('Route').find((route) => route.metadata?.name === routeOrTarget) ||
        null
      );
    }
    if (routeOrTarget.kind && routeOrTarget.kind !== 'Route') return null;
    if (routeOrTarget.metadata?.name && (routeOrTarget.spec || routeOrTarget.kind === 'Route')) {
      return routeOrTarget;
    }
    const name = routeOrTarget.name || routeOrTarget.metadata?.name;
    if (!name) return null;
    const namespace =
      routeOrTarget.namespace || routeOrTarget.metadata?.namespace || options.namespace;
    if (namespace) return this.cluster.getByName('Route', name, namespace);
    return this.cluster.getByKind('Route').find((route) => route.metadata?.name === name) || null;
  }

  /** Numeric container port behind a Route's Service (resolves named ports). */
  _routeBackendPort(route, service, pods) {
    const requested = route?.spec?.port?.targetPort;
    const servicePorts = service?.spec?.ports || [];
    let servicePort = null;
    if (requested !== undefined && requested !== null && requested !== '') {
      servicePort =
        servicePorts.find(
          (port) =>
            port.name === requested ||
            String(port.port) === String(requested) ||
            String(port.targetPort) === String(requested)
        ) || null;
    }
    servicePort = servicePort || servicePorts[0] || null;
    let target = servicePort?.targetPort ?? requested ?? servicePort?.port ?? 80;
    if (typeof target === 'string' && !/^\d+$/.test(target)) {
      const namedServicePort = servicePorts.find((port) => port.name === target);
      if (namedServicePort) target = namedServicePort.port;
    }
    if (typeof target === 'string' && !/^\d+$/.test(target)) {
      for (const pod of pods || []) {
        for (const container of pod?.spec?.containers || []) {
          const match = (container.ports || []).find((port) => port.name === target);
          if (match) return Number(match.containerPort);
        }
      }
    }
    const numeric = Number(target);
    return Number.isFinite(numeric) ? numeric : 80;
  }

  /**
   * Can the router reach a Route's backend? (issue #33b)
   *
   * Route admission only checks that the Service has ready endpoints. Traffic
   * additionally has to pass the project's NetworkPolicies, evaluated with the
   * router as the source Pod: after a default-deny, a Route stays Admitted but
   * connection attempts fail until an ingress policy allows the router
   * namespace (`namespaceSelector: matchLabels: policy-group.network.openshift.io/ingress: ""`).
   *
   * @param {object|string} routeOrTarget Route object, Route name, or `{kind:'Route',name,namespace}`
   * @param {{namespace?: string}} [options]
   * @returns {{allowed: boolean, reason: string, policy: string|null, route: object|null,
   *   service: object|null, pods: object[], port: number, termination: string|null}}
   */
  canRouterReach(routeOrTarget, options = {}) {
    const route = this._resolveRouteLike(routeOrTarget, options);
    if (!route) {
      return {
        allowed: false,
        reason: 'route-not-found',
        policy: null,
        route: null,
        service: null,
        pods: [],
        port: 0,
        termination: null,
      };
    }
    const termination = route.spec?.tls?.termination || null;
    const service = this.cluster.getRouteService(route);
    const base = {
      allowed: false,
      reason: '',
      policy: null,
      route,
      service,
      pods: [],
      port: 0,
      termination,
    };
    if (!this.cluster.isRouteAdmitted(route)) return { ...base, reason: 'route-not-admitted' };
    if (!service) return { ...base, reason: 'service-not-found' };
    const pods = this.cluster.getServiceEndpoints(service);
    const port = this._routeBackendPort(route, service, pods);
    if (!pods.length) return { ...base, pods, port, reason: 'no-endpoints' };
    const reach = this.canReach(this._routerPod(), pods[0], {
      port,
      protocol: 'TCP',
      namespace: route.metadata.namespace,
    });
    return {
      allowed: reach.allowed,
      reason: reach.allowed ? 'allowed' : reach.reason,
      policy: reach.policy || null,
      route,
      service,
      pods: reach.pods?.length ? reach.pods : pods,
      port,
      termination,
    };
  }

  /** Default router wildcard certificate (`*.apps.<cluster domain>`). */
  _routerDefaultCertificateInfo() {
    if (!this._routerDefaultCertificateInfoCache) {
      const material = createSelfSignedCertificate({
        commonName: `*.apps.${APPS_DOMAIN}`,
        organization: 'OpenShift',
        days: 365,
      });
      this._routerDefaultCertificateInfoCache = material.info;
    }
    return this._routerDefaultCertificateInfoCache;
  }

  /** Serialisable view of the TLS certificate presented to a curl client. */
  _certificateView(info, options = {}) {
    if (!info) return null;
    const subjectJson = JSON.stringify(info.subject || {});
    const issuerJson = JSON.stringify(info.issuer || {});
    return {
      commonName: info.commonName || '',
      sans: [...(info.sans || [])],
      subject: info.subject || {},
      issuer: info.issuer || {},
      selfSigned: subjectJson === issuerJson,
      trusted:
        options.trusted === undefined
          ? String(info.issuerCommonName || '') === 'service-ca'
          : options.trusted,
      notAfter: info.notAfter || null,
    };
  }

  /** Serving certificate of a Service (the service-ca secret), if present. */
  _servingCertificateInfo(service) {
    const secretName = service?.metadata?.annotations?.[SERVING_CERT_ANNOTATION];
    if (!secretName) return null;
    const secret = this.cluster.getByName('Secret', secretName, service.metadata.namespace);
    if (!secret) return null;
    const data = secret.spec?.data || secret.data || {};
    const pem = base64DecodeText(data['tls.crt'] || '');
    if (!pem) return null;
    return parseCertificatePem(pem);
  }

  _routerResponseHeaders(body) {
    return {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(String(body ?? '').length),
      date: new Date().toUTCString(),
      server: 'haproxy',
    };
  }

  /**
   * Find the Route serving `host` + `requestPath` (longest matching path wins,
   * like the HAProxy router).
   */
  _routeForHost(host, requestPath = '/') {
    const targetHost = String(host || '').toLowerCase();
    const candidates = this.cluster
      .getByKind('Route')
      .filter(
        (route) => String(this.cluster.getRouteHost(route) || '').toLowerCase() === targetHost
      );
    if (!candidates.length) return null;
    const matched = candidates.filter((route) => {
      const prefix = String(route.spec?.path || '');
      if (!prefix || prefix === '/') return true;
      const cleanPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
      return requestPath === prefix || requestPath.startsWith(cleanPrefix);
    });
    const pool = matched.length ? matched : candidates;
    return pool.sort(
      (left, right) => String(right.spec?.path || '').length - String(left.spec?.path || '').length
    )[0];
  }

  /** Response body for a successful Route request (the backend workload). */
  _workloadHttpBody(service, pod) {
    const container = pod?.spec?.containers?.[0] || {};
    const image = String(container.image || '');
    const app = pod?.metadata?.labels?.app || service?.metadata?.name || 'app';
    if (/hello-openshift/.test(image)) {
      return '<html><body>Hello OpenShift!</body></html>';
    }
    if (/nginx/.test(image)) {
      return (
        '<html><body><h1>Welcome to nginx!</h1>\n' +
        '<p>If you see this page, the nginx web server is successfully installed and working.</p>' +
        '</body></html>'
      );
    }
    return `<html><body>Hello from ${app} (container ${container.name || 'main'})</body></html>`;
  }

  /**
   * Workstation `curl` against a Route (issue #32c): resolve the host to a
   * Route, apply edge/passthrough/re-encrypt TLS + the http→https redirect
   * policy, then evaluate router→backend NetworkPolicy reachability (#33b).
   *
   * @param {string} rawUrl
   * @param {{method?: string, insecure?: boolean}} [options]
   * @returns {{error?: {code: number, message: string}, scheme?: string, host?: string,
   *   port?: number, path?: string, status?: number, statusText?: string,
   *   headers?: object, body?: string, location?: string,
   *   serverCert?: object|null, route?: string, routeNamespace?: string,
   *   termination?: string|null, reason?: string, policy?: string|null,
   *   targetPort?: number, serverIp?: string}}
   */
  trafficForWorkstationCurl(rawUrl, options = {}) {
    const parsed = parseHttpUrl(rawUrl);
    if (!parsed) {
      return { error: { code: 3, message: 'URL rejected: Malformed input to a URL function' } };
    }
    if (!['http', 'https'].includes(parsed.scheme)) {
      return { error: { code: 1, message: `Protocol "${parsed.scheme}" not supported` } };
    }
    const scheme = parsed.scheme;
    const host = String(parsed.hostname || '').toLowerCase();
    const method = String(options.method || 'GET').toUpperCase();
    const expectedPort = scheme === 'https' ? 443 : 80;
    const port = parsed.port ? Number(parsed.port) : expectedPort;
    const requestPath = parsed.path || '/';
    const base = { scheme, host, port, path: requestPath, method };
    if (port !== expectedPort) {
      return {
        error: {
          code: 7,
          message: `Failed to connect to ${host} port ${port} after 0 ms: Connection refused`,
        },
      };
    }

    const route = this._routeForHost(host, requestPath);
    if (!route) {
      const routerDomain = String(APPS_DOMAIN).toLowerCase();
      const isRouterHost = host === routerDomain || host.endsWith(`.${routerDomain}`);
      if (!isRouterHost) {
        return { error: { code: 6, message: `Could not resolve host: ${host}` } };
      }
      const result = {
        ...base,
        status: 404,
        statusText: 'Not Found',
        headers: this._routerResponseHeaders(ROUTER_404_BODY),
        body: method === 'HEAD' ? '' : ROUTER_404_BODY,
        reason: 'no-route',
      };
      if (scheme === 'https') {
        result.serverCert = this._certificateView(this._routerDefaultCertificateInfo(), {
          trusted: true,
        });
      }
      return result;
    }

    const tls = route.spec?.tls || null;
    const termination = tls?.termination || null;
    const insecurePolicy = String(tls?.insecureEdgeTerminationPolicy || 'None').toLowerCase();
    const routeBase = {
      ...base,
      host: this.cluster.getRouteHost(route),
      route: route.metadata.name,
      routeNamespace: route.metadata.namespace,
      termination,
    };
    const respond404 = (reason) => ({
      ...routeBase,
      status: 404,
      statusText: 'Not Found',
      headers: this._routerResponseHeaders(ROUTER_404_BODY),
      body: method === 'HEAD' ? '' : ROUTER_404_BODY,
      reason,
    });
    const respond503 = (reason, policy = null) => ({
      ...routeBase,
      status: 503,
      statusText: 'Service Unavailable',
      headers: this._routerResponseHeaders(ROUTER_503_BODY),
      body: method === 'HEAD' ? '' : ROUTER_503_BODY,
      reason,
      policy,
    });

    let serverCert = null;
    if (scheme === 'http') {
      if (termination === 'edge' || termination === 'reencrypt') {
        if (insecurePolicy === 'redirect') {
          const location = `https://${host}${requestPath}`;
          const body = `<html><body>Redirecting to ${location}</body></html>`;
          return {
            ...routeBase,
            status: 302,
            statusText: 'Found',
            headers: { location, 'content-length': String(body.length) },
            location,
            body: method === 'HEAD' ? '' : body,
            reason: 'redirect-to-https',
          };
        }
        if (insecurePolicy !== 'allow') return respond404('insecure-policy-none');
      } else if (termination === 'passthrough') {
        // The router cannot route plain HTTP for a passthrough Route (no
        // insecure listener, and it cannot read the payload to route it).
        return respond404('passthrough-http');
      }
    } else if (termination === 'passthrough') {
      // The client talks TLS end-to-end with the backend: it sees the backend
      // serving certificate (service-ca signed for the Service DNS names).
      const backendCert = this._servingCertificateInfo(this.cluster.getRouteService(route));
      serverCert = backendCert
        ? this._certificateView(backendCert)
        : this._certificateView(
            createSelfSignedCertificate({
              commonName: `${route.spec?.to?.name}.${route.metadata.namespace}.svc`,
              organization: 'OpenShift Games',
              issuer: { commonName: 'service-ca', organization: 'OpenShift' },
            }).info
          );
    } else if (termination === 'edge' || termination === 'reencrypt') {
      const configured = tls?.certificate ? parseCertificatePem(tls.certificate) : null;
      serverCert = configured
        ? this._certificateView(configured)
        : this._certificateView(this._routerDefaultCertificateInfo(), { trusted: true });
    } else {
      // HTTPS against a plain HTTP Route: the router falls back to its default
      // certificate and has no TLS route mapping for the host.
      const result = respond404('no-tls-route');
      result.serverCert = this._certificateView(this._routerDefaultCertificateInfo(), {
        trusted: true,
      });
      return result;
    }

    if (!this.cluster.isRouteAdmitted(route)) return respond503('no-endpoints');
    const service = this.cluster.getRouteService(route);
    if (!service) return respond503('service-not-found');
    const pods = this.cluster.getServiceEndpoints(service);
    if (!pods.length) return respond503('no-endpoints');
    if (termination === 'reencrypt') {
      // Re-encrypt needs to verify the backend TLS certificate: either the
      // Route's destinationCACertificate or (when omitted) the cluster service
      // CA, which means the backend must present a service-ca serving cert.
      if (tls?.destinationCACertificate) {
        const caInfo = parseCertificatePem(tls.destinationCACertificate);
        if (!caInfo || !caInfo.isCA) return respond503('bad-destination-ca');
      }
      if (!this._servingCertificateInfo(service)) return respond503('backend-tls-verify');
    }
    const reach = this.canRouterReach(route);
    if (!reach.allowed) return respond503(reach.reason, reach.policy);
    const destinationPod = reach.pods[0] || pods[0];
    const body = this._workloadHttpBody(service, destinationPod);
    return {
      ...routeBase,
      status: 200,
      statusText: 'OK',
      headers: this._routerResponseHeaders(body),
      body: method === 'HEAD' ? '' : body,
      serverCert,
      reason: 'allowed',
      targetPort: reach.port,
      serverIp: ROUTER_DEFAULT_IP,
    };
  }

  // ── service-ca controller (issue #33a) ─────────────────────────────────
  //
  // Two annotations are modelled:
  //   Service:   service.beta.openshift.io/serving-cert-secret-name=<secret>
  //              → service-ca creates a kubernetes.io/tls Secret (tls.crt/tls.key)
  //                whose DNS names cover the Service; reencrypt Routes consume it,
  //   ConfigMap: service.beta.openshift.io/inject-cabundle=true
  //              → service-ca injects the `service-ca.crt` trust bundle key.

  /** Lazily-created simulated cluster service CA (one per engine instance). */
  _ensureServiceCA() {
    if (!this._serviceCA) {
      this._serviceCA = createCertificateAuthority({
        commonName: 'service-ca',
        organization: 'OpenShift',
        days: 3650,
      });
    }
    return this._serviceCA;
  }

  /** PEM bundle the controller injects into annotated ConfigMaps. */
  getServiceCABundle() {
    return this._ensureServiceCA().certPem;
  }

  _serviceServingCertName(service) {
    return service?.metadata?.annotations?.[SERVING_CERT_ANNOTATION] || null;
  }

  /** DNS names a service-serving certificate must cover. */
  _servingCertDnsNames(service) {
    const name = service.metadata.name;
    const namespace = service.metadata.namespace;
    return [
      `${name}.${namespace}.svc`,
      `${name}.${namespace}.svc.cluster.local`,
      `${name}.${namespace}.svc.cluster.local.`,
      `${name}.${namespace}`,
    ];
  }

  /** Create/repair the serving-cert Secret for an annotated Service. */
  _ensureServingCertSecret(service) {
    const secretName = this._serviceServingCertName(service);
    if (!secretName) return null;
    const namespace = service.metadata.namespace;
    const existing = this.cluster.getByName('Secret', secretName, namespace);
    if (existing) {
      const data = existing.spec?.data || existing.data || {};
      if (data['tls.crt'] && data['tls.key']) return existing;
    }
    const ca = this._ensureServiceCA();
    const commonName = `${service.metadata.name}.${namespace}.svc`;
    const material = createServiceSignedCertificate({
      commonName,
      dnsNames: this._servingCertDnsNames(service),
      days: 365,
      issuer: { commonName: ca.subject.commonName, organization: ca.subject.organization },
    });
    const spec = {
      type: 'kubernetes.io/tls',
      data: {
        'tls.crt': base64EncodeText(material.certPem),
        'tls.key': base64EncodeText(material.keyPem),
      },
    };
    const metadata = {
      labels: { 'service.beta.openshift.io/serving-cert': '' },
      annotations: {
        'service.beta.openshift.io/serving-cert-generation': '1',
        'service.beta.openshift.io/serving-cert-overflow': 'false',
      },
    };
    let secret = null;
    if (existing) {
      secret = this.cluster.update(existing.uid, { spec, metadata });
    } else {
      secret = this.cluster.addResource({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: secretName, namespace, ...metadata },
        spec,
        status: { phase: 'Active' },
      });
    }
    if (secret) {
      this.eventBus?.emit('service-ca:serving-cert', {
        namespace,
        service: service.metadata.name,
        secret: secretName,
      });
    }
    return secret;
  }

  /** Inject/replace the `service-ca.crt` key on an annotated ConfigMap. */
  _injectServiceCABundle(configMap) {
    const annotation = String(configMap?.metadata?.annotations?.[INJECT_CABUNDLE_ANNOTATION] ?? '');
    if (!/^true$/i.test(annotation)) return null;
    const bundle = this.getServiceCABundle();
    const data = configMap.spec?.data || configMap.data || {};
    if (data[INJECT_CABUNDLE_KEY] === bundle) return configMap;
    const updated = this.cluster.update(configMap.uid, {
      spec: { data: { ...data, [INJECT_CABUNDLE_KEY]: bundle } },
    });
    if (updated) {
      this.eventBus?.emit('service-ca:cabundle-injected', {
        namespace: configMap.metadata.namespace,
        configMap: configMap.metadata.name,
      });
    }
    return updated;
  }

  /**
   * Run the service-ca controller once (also called synchronously by the
   * CommandBar right after a successful `oc annotate`, so the resulting Secret
   * or CABundle is visible immediately even while the simulation is paused).
   * @returns {{secrets: string[], configMaps: string[]}} created/injected refs
   */
  reconcileServiceCA() {
    const createdSecrets = [];
    const injectedConfigMaps = [];
    for (const service of this.cluster.getByKind('Service')) {
      const secretName = this._serviceServingCertName(service);
      if (!secretName) continue;
      const existed = Boolean(
        this.cluster.getByName('Secret', secretName, service.metadata.namespace)
      );
      const secret = this._ensureServingCertSecret(service);
      if (secret && !existed) {
        createdSecrets.push(`${secret.metadata.namespace}/${secret.metadata.name}`);
      }
    }
    for (const configMap of this.cluster.getByKind('ConfigMap')) {
      const annotation = String(
        configMap?.metadata?.annotations?.[INJECT_CABUNDLE_ANNOTATION] ?? ''
      );
      if (!/^true$/i.test(annotation)) continue;
      const hadBundle = Boolean(configMap.spec?.data?.[INJECT_CABUNDLE_KEY]);
      const updated = this._injectServiceCABundle(configMap);
      if (updated && !hadBundle) {
        injectedConfigMaps.push(`${updated.metadata.namespace}/${updated.metadata.name}`);
      }
    }
    return { secrets: createdSecrets, configMaps: injectedConfigMaps };
  }

  /** Controller tick: service-ca convergence (called every tick). */
  _tickServiceCA() {
    try {
      this.reconcileServiceCA();
    } catch {
      /* never let a side controller break the simulation loop */
    }
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
    this.chaosConfig = {
      podKillRate: 0,
      nodeFailRate: 0,
      networkPartition: false,
      cpuStress: 0,
      memoryStress: 0,
    };
    this._oauthPending = null;
    this._sccDirty = false;
    this._quotaViolationNamespaces = new Set();
    // OLM / operator bookkeeping refers to resources of the previous run; a new
    // level/cluster starts with none of them (the catalog is re-seeded by
    // ensureOLMDefaultsSync() before the app's initial auto-align).
    this._olmOperatorDeployments.clear();
    this._metallbOperands.clear();
    this._knownCSVs.clear();
    this._simEpoch = Date.now();
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
