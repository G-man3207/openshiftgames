import { ResourceBase } from './ResourceBase.js';
import { deepClone, mergeDefaults } from './ManifestSerializer.js';

const timestamp = () => new Date().toISOString();

/** Default container used by the workload kinds when the caller gives none. */
const DEFAULT_CONTAINER = {
  name: 'main',
  image: 'quay.io/openshift/origin-hello-openshift:latest',
  ports: [{ containerPort: 8080, protocol: 'TCP' }],
  resources: {
    requests: { cpu: '100m', memory: '128Mi' },
    limits: { cpu: '500m', memory: '256Mi' },
  },
};

export function defaultContainer(overrides = {}) {
  return mergeDefaults(DEFAULT_CONTAINER, overrides);
}

function normalizeContainers(containers) {
  const list =
    Array.isArray(containers) && containers.length > 0 ? containers : [defaultContainer()];
  return deepClone(list);
}

/**
 * Simulation-time runtime hint for a Job created without an explicit
 * `estimatedDurationSeconds`. A real batch Pod that just prints/echoes/prints a
 * date finishes in about a second, while the controller previously assumed 30 s
 * for every Job (#49: `perl -e "print 42"` "took" half a minute). Returns null
 * when the command cannot be classified, so the caller keeps the generic
 * default.
 * @param {object[]} containers
 * @returns {number|null}
 */
export function estimateJobRuntimeSeconds(containers) {
  const container = Array.isArray(containers) ? containers[0] : null;
  if (!container) return null;
  const argv = [...(container.command || []), ...(container.args || [])].map(String);
  const joined = argv.join(' ').trim();
  if (!joined) return null;
  // `sleep <n>` (optionally followed by more commands) dominates the runtime.
  const sleep = joined.match(/\bsleep\s+(\d+(?:\.\d+)?)\b/);
  if (sleep) return Math.max(1, Math.ceil(Number(sleep[1])));
  // One-shot commands that produce output and exit immediately on a real node.
  const quickOneShot =
    /\bprint\b|\bprintf\b|\becho\b|\bdate\b|\btrue\b|\bhostname\b|\buname\b|\bid\b|\bpwd\b|\bcat\b/;
  return quickOneShot.test(joined) ? 2 : null;
}

function parseCpuToMillis(cpu) {
  if (typeof cpu === 'number') return cpu;
  const str = String(cpu || '');
  if (str.endsWith('m')) return parseInt(str, 10);
  const parsed = parseFloat(str);
  return Number.isFinite(parsed) ? parsed * 1000 : 0;
}

function parseMemoryToMi(mem) {
  if (typeof mem === 'number') return mem;
  const str = String(mem || '');
  const units = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024 };
  for (const [suffix, factor] of Object.entries(units)) {
    if (str.endsWith(suffix)) return Math.round(parseFloat(str) * factor);
  }
  const parsed = parseFloat(str);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ─── `oc describe` helpers (issues #23 / #26) ───────────────────────────────
//
// The simulator stores book-keeping in `openshiftgames*` annotations (incident
// logs, quota/SCC admission flags) and finalizers. Real `oc describe` / `-o
// yaml` must never expose those, while genuine user annotations (e.g.
// `openshift.io/scc`) stay visible.

/** Simulator-internal metadata key prefix (`openshiftgames/...`, `openshiftgames.io/...`). */
export const INTERNAL_METADATA_PREFIX_RE = /^openshiftgames(?:\.io)?\//;

/** True for annotation/finalizer keys the simulator owns (hidden from CLI output). */
export function isInternalMetadataKey(key) {
  return INTERNAL_METADATA_PREFIX_RE.test(String(key ?? ''));
}

/** Copy of a resource's annotations with simulator-internal keys removed. */
export function visibleAnnotations(annotations) {
  const result = {};
  for (const [key, value] of Object.entries(annotations || {})) {
    if (isInternalMetadataKey(key)) continue;
    result[key] = value;
  }
  return result;
}

/** Finalizers with simulator-internal bookkeeping removed. */
export function visibleFinalizers(finalizers) {
  return (Array.isArray(finalizers) ? finalizers : []).filter(
    (name) => !isInternalMetadataKey(name)
  );
}

/** `oc` timestamp format: `Thu, 06 Nov 2025 16:42:23 +0000`. */
export function formatDescribeTime(value) {
  if (!value) return '<none>';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '<none>';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (number) => String(number).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** Compact age (`5s`, `3m`, `2h`, `4d`) used in describe event tables. */
export function formatDescribeAge(value, now = Date.now()) {
  const then = typeof value === 'number' ? value : new Date(value ?? 0).getTime();
  if (!Number.isFinite(then)) return '<unknown>';
  return formatDescribeDuration(Math.max(0, now - then));
}

/** Compact duration (`5s`, `3m`, `2h`, `4d`) used for event aggregation windows. */
export function formatDescribeDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

function describeTimestampMs(event) {
  const value = event?.lastTimestamp ?? event?.timestamp ?? event?.firstTimestamp;
  if (value === undefined || value === null) return Date.now();
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function describeEventFrom(event) {
  const source = String(event?.source || event?.reportingComponent || event?.from || '');
  if (source) {
    // Resource-level event records use the Kind as source; real describe shows
    // the component that reported the event.
    const component = {
      Pod: 'kubelet',
      Node: 'kubelet',
      Deployment: 'deployment-controller',
      ReplicaSet: 'replicaset-controller',
      StatefulSet: 'statefulset-controller',
      DaemonSet: 'daemonset-controller',
      Job: 'job-controller',
      CronJob: 'cronjob-controller',
      Route: 'router',
      Build: 'build-controller',
      BuildConfig: 'build-controller',
    }[source];
    return component || source;
  }
  return 'kubelet';
}

/**
 * Render the `Events:` block of a describe output the way real `oc` does:
 * identical events are aggregated with a `2m (x10 over 1m)` age suffix and the
 * table always has the Type/Reason/Age/From/Message header.
 * @param {object[]} eventList resource events (`{type, reason, message, timestamp, count, source}`)
 * @returns {string[]}
 */
export function describeEventLines(eventList) {
  const events = (Array.isArray(eventList) ? eventList : []).filter(Boolean);
  if (!events.length) return ['Events:          <none>'];
  const groups = new Map();
  for (const event of events) {
    const type = String(event.type || 'Normal');
    const reason = String(event.reason || '');
    const message = String(event.message || '');
    const source = describeEventFrom(event);
    const key = `${type}|${reason}|${source}|${message}`;
    const last = describeTimestampMs(event);
    const firstValue = event.firstTimestamp ?? event.timestamp ?? last;
    const first = typeof firstValue === 'number' ? firstValue : new Date(firstValue).getTime();
    const count = Math.max(1, Number(event.count) || 1);
    const existing = groups.get(key);
    if (existing) {
      existing.count += count;
      existing.last = Math.max(existing.last, last);
      existing.first = Math.min(existing.first, Number.isFinite(first) ? first : last);
    } else {
      groups.set(key, {
        type,
        reason,
        message,
        source,
        count,
        last,
        first: Number.isFinite(first) ? first : last,
      });
    }
  }
  const rows = [...groups.values()].sort((left, right) => left.last - right.last);
  const headers = ['Type', 'Reason', 'Age', 'From', 'Message'];
  const body = rows.map((row) => {
    let age = formatDescribeAge(row.last);
    if (row.count > 1)
      age = `${age} (x${row.count} over ${formatDescribeDuration(row.last - row.first)})`;
    return [row.type, row.reason, age, row.source, row.message];
  });
  const widths = headers
    .slice(0, -1)
    .map((header, index) =>
      Math.max(header.length, 4, ...body.map((row) => String(row[index] ?? '').length))
    );
  const render = (cells) =>
    `  ${cells
      .slice(0, -1)
      .map((cell, index) => String(cell ?? '').padEnd(widths[index] + 3))
      .join('')}${cells[cells.length - 1] ?? ''}`;
  const rule = `  ${widths.map((width) => '-'.repeat(width).padEnd(width + 3)).join('')}-------`;
  return ['Events:', render(headers), rule, ...body.map((row) => render(row))];
}

/** The Node line value for a pod (`node/ip`) plus whether it had to be derived. */
export function resolvePodNode(pod, cluster = null) {
  if (!pod) return { name: null, ip: null, derived: false };
  const nodeIp = (node) =>
    node?.status?.addresses?.find((entry) => entry?.type === 'InternalIP')?.address ||
    node?.status?.addresses?.[0]?.address ||
    null;
  if (pod.spec?.nodeName) {
    const node = cluster?.getByName?.('Node', pod.spec.nodeName, '') || null;
    return { name: pod.spec.nodeName, ip: pod.status?.hostIP || nodeIp(node), derived: false };
  }
  const statuses = pod.status?.containerStatuses || [];
  const phase = String(pod.status?.phase || '');
  // A Pod the kubelet has acted on must have been scheduled. Incidents that
  // damage a preload Pod before the scheduler binds it would otherwise make
  // describe print `<none>/<none>` for a container that is actually restarting.
  const kubeletSawPod =
    statuses.length > 0 ||
    ['Running', 'CrashLoopBackOff', 'Failed', 'Succeeded', 'Error'].includes(phase);
  if (!kubeletSawPod) return { name: null, ip: null, derived: false };
  const nodes = (cluster?.getByKind?.('Node') || []).filter(
    (node) => !node.metadata?.deletionTimestamp
  );
  if (!nodes.length) return { name: null, ip: null, derived: false };
  let hash = 0;
  for (const char of String(pod.metadata?.name || pod.metadata?.uid || 'pod'))
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const node = nodes[hash % nodes.length];
  return { name: node.metadata.name, ip: nodeIp(node), derived: true };
}

/** Pod phase as printed by real `oc describe pod` (CrashLoopBackOff is Running). */
export function describePodStatus(pod) {
  const phase = String(pod?.status?.phase || 'Pending');
  if (phase === 'CrashLoopBackOff') return 'Running';
  if (phase === 'ImagePullBackOff' || phase === 'ErrImagePull' || phase === 'ContainerCreating')
    return 'Pending';
  return phase;
}

// ─── Pod ────────────────────────────────────────────────────────────────────

export class Pod extends ResourceBase {
  constructor(metadata = {}) {
    super('Pod', { ...metadata, apiVersion: metadata.apiVersion || 'v1' });
    const containers = normalizeContainers(metadata.containers);
    const defaults = {
      containers,
      restartPolicy: metadata.restartPolicy || 'Always',
      terminationGracePeriodSeconds: 30,
      dnsPolicy: 'ClusterFirst',
      serviceAccountName: metadata.serviceAccountName || 'default',
      nodeName: metadata.nodeName || null,
      schedulerName: 'default-scheduler',
    };
    if (metadata.volumes) defaults.volumes = deepClone(metadata.volumes);
    if (metadata.imagePullSecrets) defaults.imagePullSecrets = deepClone(metadata.imagePullSecrets);
    this._initSpec(defaults, metadata.spec);

    const podSpec = this.spec;
    this._setInitialStatus({
      phase: 'Pending',
      qosClass: this._calculateQoS(),
      podIP: null,
      hostIP: null,
      startTime: timestamp(),
      conditions: [],
      containerStatuses: (podSpec.containers || []).map((container) => {
        const limits = container.resources?.limits || {};
        const requests = container.resources?.requests || {};
        return {
          name: container.name,
          image: container.image,
          imageID: '',
          ready: false,
          started: false,
          restartCount: 0,
          state: { waiting: { reason: 'ContainerCreating' } },
          lastState: {},
          // Resource accounting consumed by SimulationTick's metrics/OOM/chaos
          // controllers (millicores and MiB, same units as ClusterState helpers).
          resources: {
            cpu: 0,
            memory: 0,
            cpuLimit: parseCpuToMillis(limits.cpu || '0'),
            memoryLimit: parseMemoryToMi(limits.memory || '0'),
            cpuRequest: parseCpuToMillis(requests.cpu || '100m'),
            memoryRequest: parseMemoryToMi(requests.memory || '128Mi'),
          },
        };
      }),
    });
  }

  _calculateQoS() {
    const containers = this.spec.containers || [];
    if (containers.length === 0) return 'BestEffort';
    const guaranteed = containers.every((c) => {
      const r = c.resources || {};
      return (
        r.requests?.cpu &&
        r.requests?.memory &&
        r.limits?.cpu &&
        r.limits?.memory &&
        r.requests.cpu === r.limits.cpu &&
        r.requests.memory === r.limits.memory
      );
    });
    if (guaranteed) return 'Guaranteed';
    const anyRequest = containers.some(
      (c) => c.resources?.requests?.cpu || c.resources?.requests?.memory
    );
    return anyRequest ? 'Burstable' : 'BestEffort';
  }

  /** Legacy alias for `status.phase` (older simulation code read/wrote pod.phase). */
  get phase() {
    return this.status.phase;
  }

  set phase(value) {
    this.status.phase = value;
  }

  isReady() {
    if (this.status.phase === 'Succeeded' || this.status.phase === 'Failed') return false;
    const statuses = this.status.containerStatuses || [];
    if (statuses.length === 0) return this.status.phase === 'Running';
    return statuses.every((cs) => cs.ready);
  }

  getRestartCount() {
    return (this.status.containerStatuses || []).reduce(
      (sum, cs) => sum + (cs.restartCount || 0),
      0
    );
  }

  getPrimaryContainer() {
    return (this.spec.containers || [])[0] || null;
  }

  /** Simulate a container crash; the pod lifecycle controller re-creates it. */
  triggerCrash(reason = 'Error', exitCode = 1) {
    const finishedAt = timestamp();
    for (const cs of this.status.containerStatuses || []) {
      cs.restartCount = (cs.restartCount || 0) + 1;
      cs.ready = false;
      cs.started = false;
      cs.lastState = { terminated: { exitCode, reason, finishedAt } };
      cs.state = { waiting: { reason: 'CrashLoopBackOff' } };
    }
    this.setPhase('CrashLoopBackOff');
    this.addEvent(
      'Warning',
      'BackOff',
      `Back-off restarting failed container ${this.getPrimaryContainer()?.name || 'main'}`
    );
    this.setCondition('Ready', 'False', 'ContainersNotReady', 'containers with unready status');
    return this;
  }

  terminate(reason = 'Completed') {
    const completed = reason === 'Completed';
    const finishedAt = timestamp();
    for (const cs of this.status.containerStatuses || []) {
      cs.ready = false;
      cs.started = false;
      cs.state = { terminated: { exitCode: completed ? 0 : 1, reason, finishedAt } };
    }
    this.setPhase(completed ? 'Succeeded' : 'Failed');
    this.setCondition('Ready', 'False', 'ContainersNotReady', `pod ${reason}`);
    return this;
  }

  getPrimaryImage() {
    return this.spec.containers?.[0]?.image || '';
  }

  /**
   * Real `oc describe pod` shape (issues #23/#26):
   *  - `Image:` is the LIVE pod spec image (container status image can be stale
   *    for preloaded/incident pods),
   *  - `Node:` is never `<none>/<none>` for a pod the kubelet has run,
   *  - simulator-internal `openshiftgames*` annotations are hidden.
   * @param {{cluster?: any}} [opts] cluster state used to resolve the Node
   * @returns {string}
   */
  toDescribe(opts = {}) {
    const cluster = opts?.cluster || null;
    const statuses = this.status.containerStatuses || [];
    const conditions = this.status.conditions || [];
    const specContainers = this.spec.containers || [];
    const containers = specContainers.length
      ? specContainers.map((container) => ({
          container,
          status: statuses.find((status) => status.name === container.name) || null,
        }))
      : statuses.map((status) => ({
          container: { name: status.name, image: status.image },
          status,
        }));
    const node = resolvePodNode(this, cluster);
    const nodeLine = node.name ? `${node.name}/${node.ip || '<none>'}` : '<none>/<none>';
    const annotations = visibleAnnotations(this.metadata.annotations);
    const annotationText =
      Object.entries(annotations)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ') || '<none>';
    const labelsText =
      Object.entries(this.metadata.labels || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(', ') || '<none>';
    const owner =
      (this.metadata.ownerReferences || []).find((ref) => ref.controller) ||
      (this.metadata.ownerReferences || [])[0] ||
      null;
    const podIp = this.status.podIP || null;

    const lines = [
      `Name:             ${this.metadata.name}`,
      `Namespace:        ${this.metadata.namespace}`,
      `Priority:         0`,
      `Service Account:  ${this.spec.serviceAccountName || 'default'}`,
      `Node:             ${nodeLine}`,
      `Start Time:       ${formatDescribeTime(this.status.startTime)}`,
      `Labels:           ${labelsText}`,
      `Annotations:      ${annotationText}`,
      `Status:           ${describePodStatus(this)}`,
      `IP:               ${podIp || '<none>'}`,
    ];
    if (podIp) lines.push('IPs:', `  IP:  ${podIp}`);
    if (owner) lines.push(`Controlled By:    ${owner.kind}/${owner.name}`);
    lines.push('Containers:');
    if (!containers.length) {
      lines.push('  <none>');
    }
    for (const { container, status } of containers) {
      const specResources = container.resources || {};
      lines.push(`  ${container.name}:`);
      lines.push(`    Container ID:   ${status?.containerID || '<none>'}`);
      // The live pod spec image is authoritative (matches `-o jsonpath={.spec...image}`).
      lines.push(`    Image:          ${container.image || status?.image || '<none>'}`);
      lines.push(`    Image ID:       ${status?.imageID || '<none>'}`);
      const ports = Array.isArray(container.ports) ? container.ports : [];
      lines.push(
        `    Port:           ${ports.length ? ports.map((port) => `${port.containerPort}/${port.protocol || 'TCP'}`).join(', ') : '<none>'}`
      );
      lines.push(
        `    Host Port:      ${ports.length ? ports.map((port) => `${port.hostPort || 0}/${port.protocol || 'TCP'}`).join(', ') : '<none>'}`
      );
      if (status) {
        const state = status.state || {};
        const stateKind = Object.keys(state)[0];
        if (stateKind) {
          const stateDetail = state[stateKind] || {};
          lines.push(
            `    State:          ${stateKind.charAt(0).toUpperCase()}${stateKind.slice(1)}`
          );
          if (stateDetail.reason) lines.push(`      Reason:       ${stateDetail.reason}`);
          if (stateDetail.message && stateDetail.message !== stateDetail.reason)
            lines.push(`      Message:      ${stateDetail.message}`);
          if (stateDetail.exitCode !== undefined)
            lines.push(`      Exit Code:    ${stateDetail.exitCode}`);
          if (stateDetail.startedAt)
            lines.push(`      Started:      ${formatDescribeTime(stateDetail.startedAt)}`);
          if (stateDetail.finishedAt)
            lines.push(`      Finished:     ${formatDescribeTime(stateDetail.finishedAt)}`);
        }
        const lastState = status.lastState || {};
        const lastKind = Object.keys(lastState)[0];
        if (lastKind) {
          const lastDetail = lastState[lastKind] || {};
          lines.push(`    Last State:     ${lastKind.charAt(0).toUpperCase()}${lastKind.slice(1)}`);
          if (lastDetail.reason) lines.push(`      Reason:       ${lastDetail.reason}`);
          if (lastDetail.exitCode !== undefined)
            lines.push(`      Exit Code:    ${lastDetail.exitCode}`);
          if (lastDetail.finishedAt)
            lines.push(`      Finished:     ${formatDescribeTime(lastDetail.finishedAt)}`);
        }
        lines.push(`    Ready:          ${status.ready ? 'True' : 'False'}`);
        lines.push(`    Restart Count:  ${status.restartCount || 0}`);
      } else {
        lines.push(
          '    State:          Waiting',
          '      Reason:       ContainerCreating',
          '    Ready:          False',
          '    Restart Count:  0'
        );
      }
      const limitEntries = Object.entries(specResources.limits || {});
      if (limitEntries.length) {
        lines.push('    Limits:');
        for (const [resource, value] of limitEntries)
          lines.push(`      ${`${resource}:`.padEnd(9)} ${value}`);
      }
      const requestEntries = Object.entries(specResources.requests || {});
      if (requestEntries.length) {
        lines.push('    Requests:');
        for (const [resource, value] of requestEntries)
          lines.push(`      ${`${resource}:`.padEnd(9)} ${value}`);
      }
      const envEntries = Array.isArray(container.env) ? container.env : [];
      if (envEntries.length) {
        lines.push('    Environment:');
        for (const entry of envEntries) {
          const value = entry.valueFrom ? JSON.stringify(entry.valueFrom) : entry.value;
          lines.push(`      ${entry.name}:  ${value ?? ''}`);
        }
      } else {
        lines.push('    Environment:    <none>');
      }
      const mounts = Array.isArray(container.volumeMounts) ? container.volumeMounts : [];
      lines.push(mounts.length ? '    Mounts:' : '    Mounts:         <none>');
      for (const mount of mounts)
        lines.push(`      ${mount.mountPath} from ${mount.name} (${mount.readOnly ? 'ro' : 'rw'})`);
    }
    lines.push('Conditions:');
    if (conditions.length) {
      lines.push('  Type              Status');
      for (const condition of conditions)
        lines.push(`  ${String(condition.type).padEnd(18)}${condition.status}`);
    } else {
      lines.push('  <none>');
    }
    const volumes = this.spec.volumes || [];
    lines.push(`Volumes:${volumes.length ? '' : '            <none>'}`);
    for (const volume of volumes) {
      lines.push(
        `  ${volume.name}:`,
        `    Type:  ${Object.keys(volume).find((key) => key !== 'name') || 'Unknown'}`
      );
    }
    lines.push(`QoS Class:          ${this.status.qosClass || 'BestEffort'}`);
    const nodeSelector = Object.entries(this.spec.nodeSelector || {})
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    lines.push(`Node-Selectors:     ${nodeSelector || '<none>'}`);
    const tolerations = this.spec.tolerations || [];
    if (tolerations.length) {
      lines.push(
        'Tolerations:        ' +
          tolerations
            .map(
              (toleration) =>
                `${toleration.key || '*'}:${toleration.operator || 'Exists'}${toleration.effect ? `:${toleration.effect}` : ''}`
            )
            .join('\n                    ')
      );
    } else {
      lines.push('Tolerations:        node.kubernetes.io/not-ready:NoExecute op=Exists for 300s');
      lines.push('                    node.kubernetes.io/unreachable:NoExecute op=Exists for 300s');
    }
    lines.push(...describeEventLines(this.events));
    return lines.join('\n');
  }
}

// ─── Deployment ─────────────────────────────────────────────────────────────

export class Deployment extends ResourceBase {
  constructor(metadata = {}) {
    super('Deployment', { ...metadata, apiVersion: metadata.apiVersion || 'apps/v1' });
    const name = metadata.name || 'unnamed';
    const matchLabels = metadata.matchLabels || { app: name };
    const containers = normalizeContainers(metadata.containers);
    const defaults = {
      replicas: metadata.replicas ?? 3,
      selector: { matchLabels: deepClone(matchLabels) },
      strategy: {
        type: metadata.strategyType || 'RollingUpdate',
        rollingUpdate: {
          maxSurge: metadata.maxSurge || '25%',
          maxUnavailable: metadata.maxUnavailable || '25%',
        },
      },
      template: {
        metadata: { labels: deepClone(matchLabels) },
        spec: { containers },
      },
      revisionHistoryLimit: 10,
      progressDeadlineSeconds: 600,
    };
    this._initSpec(defaults, metadata.spec);
    this.replicaSets = [];
    this.revision = 1;
    this.revisionHistory = [];
    this.isRollingOut = false;
    this._setInitialStatus({
      observedGeneration: 1,
      replicas: 0,
      updatedReplicas: 0,
      readyReplicas: 0,
      availableReplicas: 0,
      unavailableReplicas: 0,
      conditions: [
        {
          type: 'Available',
          status: 'False',
          reason: 'MinimumReplicasUnavailable',
          message: 'Deployment does not have minimum availability.',
          lastTransitionTime: timestamp(),
        },
        {
          type: 'Progressing',
          status: 'True',
          reason: 'NewReplicaSetAvailable',
          message: `ReplicaSet "${name}-1" is progressing.`,
          lastTransitionTime: timestamp(),
        },
      ],
    });
  }

  getContainer(name) {
    const containers = this.spec.template?.spec?.containers || [];
    return containers.find((c) => c.name === name) || containers[0] || null;
  }

  setImage(containerName, image) {
    const container = containerName ? this.getContainer(containerName) : this.getContainer();
    if (!container) return false;
    if (container.image === image) return true;
    container.image = image;
    this.metadata.generation++;
    this.setPhase('Progressing');
    this.addEvent('Normal', 'Updated', `Image changed for container ${container.name} to ${image}`);
    return true;
  }

  /** Start a simulated rolling update to `newImage` (used by oc set image / triggers). */
  triggerRollingUpdate(newImage) {
    const container = this.getContainer();
    if (container && newImage) container.image = newImage;
    this.isRollingOut = true;
    this.revision++;
    this.revisionHistory.push({
      revision: this.revision,
      image: container?.image || newImage || '',
      timestamp: timestamp(),
    });
    if (this.revisionHistory.length > (this.spec.revisionHistoryLimit || 10)) {
      this.revisionHistory.shift();
    }
    this.addEvent(
      'Normal',
      'ScalingReplicaSet',
      `Scaled up replica set ${this.metadata.name}-${this.revision} to ${this.spec.strategy?.rollingUpdate?.maxSurge || '25%'}`
    );
    this.setCondition(
      'Progressing',
      'True',
      'ReplicaSetUpdated',
      `ReplicaSet "${this.metadata.name}-${this.revision}" is progressing.`
    );
    this.setPhase('Progressing');
    return `rev-${this.revision}`;
  }

  rollback(toRevision) {
    const target = this.revisionHistory.find((r) => r.revision === toRevision);
    if (!target) return false;
    this.addEvent(
      'Normal',
      'DeploymentRollback',
      `Rolled back deployment "${this.metadata.name}" to revision ${toRevision}`
    );
    return this.triggerRollingUpdate(target.image);
  }

  scale(replicas) {
    const old = this.spec.replicas;
    if (replicas === old) return this;
    this.spec.replicas = replicas;
    this.metadata.generation++;
    this.addEvent('Normal', 'ScalingReplicaSet', `Scaled replica set from ${old} to ${replicas}`);
    return this;
  }

  getCurrentReplicaSet() {
    return this.replicaSets.find(
      (rs) => rs.metadata?.labels?.['pod-template-hash'] === `rev-${this.revision}`
    );
  }

  /**
   * Real `oc describe deployment` shape (issues #23/#26): `Pod Template:`
   * section (containers/image/env/limits), a real `NewReplicaSet:` line and
   * simulator-internal annotations hidden. The owning ReplicaSets are resolved
   * through the cluster (they are owner-linked, not stored on the object).
   * @param {{cluster?: any}} [opts]
   * @returns {string}
   */
  toDescribe(opts = {}) {
    const cluster = opts?.cluster || null;
    const selector = this.spec.selector?.matchLabels || {};
    const strategy = this.spec.strategy || {};
    const rolling = strategy.rollingUpdate || {};
    const template = this.spec.template || {};
    const templateSpec = template.spec || {};
    const labelsText =
      Object.entries(this.metadata.labels || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(', ') || '<none>';
    const annotations = visibleAnnotations(this.metadata.annotations);
    const annotationText =
      Object.entries(annotations)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ') || '<none>';

    const replicaSets = (cluster?.getChildren?.(this.uid) || []).filter(
      (child) => child?.kind === 'ReplicaSet'
    );
    const revisionOf = (rs) =>
      Number.parseInt(
        rs?.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '0',
        10
      ) || 0;
    const sortedSets = replicaSets
      .slice()
      .sort((left, right) => revisionOf(left) - revisionOf(right));
    const currentSet = sortedSets.length ? sortedSets[sortedSets.length - 1] : null;
    const oldSets = sortedSets.slice(0, Math.max(0, sortedSets.length - 1));
    const replicaSetLine = (rs) =>
      `${rs.metadata?.name || '<none>'} (${rs.status?.replicas ?? 0}/${rs.spec?.replicas ?? 0} replicas created)`;
    const oldReplicaSetText = oldSets.length ? oldSets.map(replicaSetLine).join(', ') : '<none>';
    const newReplicaSetText = currentSet ? replicaSetLine(currentSet) : '<none>';

    const lines = [
      `Name:                   ${this.metadata.name}`,
      `Namespace:              ${this.metadata.namespace}`,
      `CreationTimestamp:      ${formatDescribeTime(this.metadata.creationTimestamp)}`,
      `Labels:                 ${labelsText}`,
      `Annotations:            ${annotationText}`,
      `Selector:               ${Object.entries(selector)
        .map(([key, value]) => `${key}=${value}`)
        .join(',')}`,
      `Replicas:               ${this.spec.replicas ?? 0} desired | ${this.status?.updatedReplicas ?? 0} updated | ${this.status?.replicas ?? 0} total | ${this.status?.availableReplicas ?? 0} available | ${this.status?.unavailableReplicas ?? 0} unavailable`,
      `StrategyType:           ${strategy.type || 'RollingUpdate'}`,
      `MinReadySeconds:        ${this.spec.minReadySeconds ?? 0}`,
      `RollingUpdateStrategy:  ${rolling.maxUnavailable ?? 0} max unavailable, ${rolling.maxSurge ?? 0} max surge`,
      'Pod Template:',
      `  Labels:  ${
        Object.entries(template.metadata?.labels || {})
          .map(([key, value]) => `${key}=${value}`)
          .join(', ') || '<none>'
      }`,
      '  Containers:',
    ];
    const templateContainers = templateSpec.containers || [];
    if (!templateContainers.length) lines.push('   <none>');
    for (const container of templateContainers) {
      const resources = container.resources || {};
      const ports = Array.isArray(container.ports) ? container.ports : [];
      lines.push(`   ${container.name}:`);
      lines.push(`    Image:        ${container.image || '<none>'}`);
      lines.push(
        `    Port:         ${ports.length ? ports.map((port) => `${port.containerPort}/${port.protocol || 'TCP'}`).join(', ') : '<none>'}`
      );
      lines.push(
        `    Host Port:    ${ports.length ? ports.map((port) => `${port.hostPort || 0}/${port.protocol || 'TCP'}`).join(', ') : '<none>'}`
      );
      const limitEntries = Object.entries(resources.limits || {});
      if (limitEntries.length) {
        lines.push('    Limits:');
        for (const [resource, value] of limitEntries)
          lines.push(`      ${`${resource}:`.padEnd(9)} ${value}`);
      }
      const requestEntries = Object.entries(resources.requests || {});
      if (requestEntries.length) {
        lines.push('    Requests:');
        for (const [resource, value] of requestEntries)
          lines.push(`      ${`${resource}:`.padEnd(9)} ${value}`);
      }
      const envEntries = Array.isArray(container.env) ? container.env : [];
      if (envEntries.length) {
        lines.push('    Environment:');
        for (const entry of envEntries) {
          const value = entry.valueFrom ? JSON.stringify(entry.valueFrom) : entry.value;
          lines.push(`      ${entry.name}:  ${value ?? ''}`);
        }
      } else {
        lines.push('    Environment:  <none>');
      }
      const mounts = Array.isArray(container.volumeMounts) ? container.volumeMounts : [];
      if (mounts.length) {
        lines.push('    Mounts:');
        for (const mount of mounts)
          lines.push(
            `      ${mount.mountPath} from ${mount.name} (${mount.readOnly ? 'ro' : 'rw'})`
          );
      } else {
        lines.push('    Mounts:       <none>');
      }
    }
    const volumes = templateSpec.volumes || [];
    if (volumes.length) {
      lines.push('  Volumes:');
      for (const volume of volumes) {
        lines.push(
          `   ${volume.name}:`,
          `    Type:  ${Object.keys(volume).find((key) => key !== 'name') || 'Unknown'}`
        );
      }
    } else {
      lines.push('  Volumes:        <none>');
    }
    lines.push('Conditions:');
    const conditions = this.status?.conditions || [];
    if (conditions.length) {
      lines.push('  Type           Status  Reason');
      lines.push('  ----           ------  ------');
      for (const condition of conditions) {
        lines.push(
          `  ${String(condition.type).padEnd(15)}${String(condition.status).padEnd(8)}${condition.reason || ''}`
        );
      }
    } else {
      lines.push('  <none>');
    }
    lines.push(`OldReplicaSets:         ${oldReplicaSetText}`);
    lines.push(`NewReplicaSet:          ${newReplicaSetText}`);
    lines.push(...describeEventLines(this.events));
    return lines.join('\n');
  }
}

// ─── ReplicaSet ─────────────────────────────────────────────────────────────

export class ReplicaSet extends ResourceBase {
  constructor(metadata = {}) {
    super('ReplicaSet', { ...metadata, apiVersion: metadata.apiVersion || 'apps/v1' });
    const name = metadata.name || 'unnamed';
    const matchLabels = metadata.matchLabels || { app: name };
    const defaults = {
      replicas: metadata.replicas ?? 3,
      selector: { matchLabels: deepClone(matchLabels) },
      template: {
        metadata: { labels: deepClone(matchLabels) },
        spec: { containers: normalizeContainers(metadata.containers) },
      },
    };
    this._initSpec(defaults, metadata.spec);
    this.pods = [];
    this._setInitialStatus({
      replicas: 0,
      fullyLabeledReplicas: 0,
      readyReplicas: 0,
      availableReplicas: 0,
      observedGeneration: 1,
      conditions: [],
    });
  }

  matchesSelector(labels = {}) {
    return Object.entries(this.spec.selector?.matchLabels || {}).every(([k, v]) => labels[k] === v);
  }

  addPod(pod) {
    if (!this.pods.includes(pod)) this.pods.push(pod);
    pod.addOwnerReference(this);
    return this;
  }

  removePod(pod) {
    this.pods = this.pods.filter((p) => p !== pod);
    return this;
  }

  getDesiredPodCount() {
    return this.spec.replicas || 0;
  }

  toDescribe() {
    const selector = this.spec.selector?.matchLabels || {};
    return `Name:           ${this.metadata.name}
Namespace:      ${this.metadata.namespace}
Selector:       ${Object.entries(selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')}
Replicas:       ${this.spec.replicas || 0} desired | ${this.status.replicas || 0} current | ${this.status.readyReplicas || 0} ready
Pod Template:
  Containers:
${(this.spec.template?.spec?.containers || [])
  .map((c) => `   ${c.name}:\n    Image:  ${c.image}`)
  .join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── StatefulSet ────────────────────────────────────────────────────────────

export class StatefulSet extends ResourceBase {
  constructor(metadata = {}) {
    super('StatefulSet', { ...metadata, apiVersion: metadata.apiVersion || 'apps/v1' });
    const name = metadata.name || 'unnamed';
    const matchLabels = metadata.matchLabels || { app: name };
    const defaults = {
      replicas: metadata.replicas ?? 3,
      selector: { matchLabels: deepClone(matchLabels) },
      serviceName: metadata.serviceName || name,
      podManagementPolicy: metadata.podManagementPolicy || 'OrderedReady',
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 0 } },
      template: {
        metadata: { labels: deepClone(matchLabels) },
        spec: { containers: normalizeContainers(metadata.containers) },
      },
      volumeClaimTemplates: metadata.volumeClaimTemplates || [
        {
          metadata: { name: 'data' },
          spec: {
            accessModes: ['ReadWriteOnce'],
            resources: { requests: { storage: '10Gi' } },
          },
        },
      ],
    };
    this._initSpec(defaults, metadata.spec);
    this.pods = [];
    this._setInitialStatus({
      replicas: 0,
      readyReplicas: 0,
      currentReplicas: 0,
      updatedReplicas: 0,
      currentRevision: `${name}-rev1`,
      updateRevision: `${name}-rev1`,
      observedGeneration: 1,
      conditions: [],
    });
  }

  getStableNetworkId(ordinal) {
    return `${this.metadata.name}-${ordinal}.${this.spec.serviceName}.${this.metadata.namespace}.svc.cluster.local`;
  }

  addPod(pod, ordinal = this.pods.length) {
    pod.metadata.name = `${this.metadata.name}-${ordinal}`;
    pod.setLabel('statefulset.kubernetes.io/pod-name', pod.metadata.name);
    pod.setLabel('controller-revision-hash', this.status.currentRevision);
    pod.hostname = pod.metadata.name;
    pod.subdomain = this.spec.serviceName;
    pod.addOwnerReference(this);
    this.pods.push(pod);
    return pod;
  }

  removePod(pod) {
    this.pods = this.pods.filter((p) => p !== pod);
    return this;
  }

  scale(replicas) {
    const old = this.spec.replicas;
    if (replicas === old) return this;
    this.spec.replicas = replicas;
    this.metadata.generation++;
    this.addEvent('Normal', 'SuccessfulScale', `Scaled statefulset from ${old} to ${replicas}`);
    return this;
  }

  toDescribe() {
    const selector = this.spec.selector?.matchLabels || {};
    return `Name:               ${this.metadata.name}
Namespace:          ${this.metadata.namespace}
Selector:           ${Object.entries(selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')}
Replicas:           ${this.spec.replicas || 0} desired | ${this.status.currentReplicas || 0} total
Update Strategy:    ${this.spec.updateStrategy?.type || 'RollingUpdate'}
Pod Template:
  Containers:
${(this.spec.template?.spec?.containers || [])
  .map((c) => `   ${c.name}:\n    Image:  ${c.image}`)
  .join('\n')}
Volume Claims:
${(this.spec.volumeClaimTemplates || [])
  .map(
    (v) => `  Name:  ${v.metadata?.name}
  Mode:  ${(v.spec?.accessModes || []).join(', ')}
  Size:  ${v.spec?.resources?.requests?.storage}`
  )
  .join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── DaemonSet ──────────────────────────────────────────────────────────────

export class DaemonSet extends ResourceBase {
  constructor(metadata = {}) {
    super('DaemonSet', { ...metadata, apiVersion: metadata.apiVersion || 'apps/v1' });
    const name = metadata.name || 'unnamed';
    const matchLabels = metadata.matchLabels || { app: name };
    const defaults = {
      selector: { matchLabels: deepClone(matchLabels) },
      template: {
        metadata: { labels: deepClone(matchLabels) },
        spec: {
          containers: normalizeContainers(metadata.containers),
          nodeSelector: metadata.nodeSelector || {},
          tolerations: metadata.tolerations || [],
        },
      },
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } },
    };
    this._initSpec(defaults, metadata.spec);
    this.pods = [];
    this.nodesPodMap = new Map();
    this._setInitialStatus({
      desiredNumberScheduled: 0,
      currentNumberScheduled: 0,
      numberReady: 0,
      numberAvailable: 0,
      numberMisscheduled: 0,
      updatedNumberScheduled: 0,
      observedGeneration: 1,
      conditions: [],
    });
  }

  shouldRunOnNode(node) {
    const selector = this.spec.template?.spec?.nodeSelector || {};
    if (Object.keys(selector).length === 0) return true;
    return Object.entries(selector).every(([k, v]) => node.metadata.labels[k] === v);
  }

  addPod(pod, nodeName) {
    pod.spec.nodeName = nodeName;
    pod.addOwnerReference(this);
    this.pods.push(pod);
    this.nodesPodMap.set(nodeName, pod);
    return pod;
  }

  removePodForNode(nodeName) {
    const pod = this.nodesPodMap.get(nodeName);
    if (pod) {
      this.pods = this.pods.filter((p) => p !== pod);
      this.nodesPodMap.delete(nodeName);
    }
    return pod;
  }

  toDescribe() {
    const selector = this.spec.selector?.matchLabels || {};
    return `Name:           ${this.metadata.name}
Namespace:      ${this.metadata.namespace}
Selector:       ${Object.entries(selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')}
Node-Selector:  ${
      Object.entries(this.spec.template?.spec?.nodeSelector || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(',') || '<none>'
    }
Desired Number of Nodes Scheduled: ${this.status.desiredNumberScheduled || 0}
Current Number of Nodes Scheduled: ${this.status.currentNumberScheduled || 0}
Number Ready:   ${this.status.numberReady || 0}
Pod Template:
  Containers:
${(this.spec.template?.spec?.containers || [])
  .map((c) => `   ${c.name}:\n    Image:  ${c.image}`)
  .join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── Job ────────────────────────────────────────────────────────────────────

export class Job extends ResourceBase {
  constructor(metadata = {}) {
    super('Job', { ...metadata, apiVersion: metadata.apiVersion || 'batch/v1' });
    const defaults = {
      completions: metadata.completions ?? 1,
      parallelism: metadata.parallelism ?? 1,
      backoffLimit: metadata.backoffLimit ?? 6,
      activeDeadlineSeconds: metadata.activeDeadlineSeconds || null,
      template: {
        spec: {
          containers: normalizeContainers(
            metadata.containers || [
              { name: 'worker', image: 'busybox:latest', command: ['sh', '-c', 'echo done'] },
            ]
          ),
          restartPolicy: 'Never',
        },
      },
    };
    this._initSpec(defaults, metadata.spec);
    // #49: derive a realistic runtime hint for trivial one-shot commands so the
    // build controller does not report every Job as taking ~30 s. Explicit
    // `estimatedDurationSeconds` from data-authored Jobs always wins.
    if (this.spec.estimatedDurationSeconds === undefined) {
      const estimate = estimateJobRuntimeSeconds(this.spec.template?.spec?.containers);
      if (Number.isFinite(estimate)) this.spec.estimatedDurationSeconds = estimate;
    }
    this.pods = [];
    this._setInitialStatus({
      phase: 'Pending',
      succeeded: 0,
      failed: 0,
      active: 0,
      startTime: timestamp(),
      completionTime: null,
      conditions: [],
    });
  }

  addPod(pod) {
    pod.spec.restartPolicy = 'Never';
    pod.addOwnerReference(this);
    this.pods.push(pod);
    return this;
  }

  getDuration() {
    if (!this.status.startTime) return 0;
    const end = this.status.completionTime ? new Date(this.status.completionTime) : new Date();
    return Math.max(
      0,
      Math.floor((end.getTime() - new Date(this.status.startTime).getTime()) / 1000)
    );
  }

  isComplete() {
    return this.status.phase === 'Complete';
  }

  isFailed() {
    return this.status.phase === 'Failed';
  }

  toDescribe() {
    return `Name:           ${this.metadata.name}
Namespace:      ${this.metadata.namespace}
Selector:       controller-uid=${this.metadata.uid}
Completions:    ${this.status.succeeded || 0}/${this.spec.completions || 1}
Parallelism:    ${this.spec.parallelism || 1}
Backoff Limit:  ${this.spec.backoffLimit || 0}
Start Time:     ${this.status.startTime || '<none>'}
Completed At:   ${this.status.completionTime || '<pending>'}
Duration:       ${this.getDuration()}s
Pods Statuses:  ${this.status.active || 0} Active / ${this.status.succeeded || 0} Succeeded / ${this.status.failed || 0} Failed
Pod Template:
  Containers:
${(this.spec.template?.spec?.containers || [])
  .map((c) => `   ${c.name}:\n    Image:  ${c.image}`)
  .join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── Cron schedule parsing (batch/v1 CronJob) ───────────────────────────────
//
// Kubernetes CronJob.spec.schedule accepts the standard 5-field cron format
// (minute hour day-of-month month day-of-week) plus the @hourly/@daily/@weekly/
// @monthly/@yearly/@midnight descriptors. Six-field (with seconds), free text
// ("every 5 min") or otherwise malformed values are rejected by the API server
// with a `spec.schedule: Invalid value: ...` validation error.
//
// The helpers below are shared by the CLI (create/apply validation) and the
// SimulationTick CronJob controller (real next-run computation, so a Job is no
// longer created immediately when the CronJob is created).

const CRON_DESCRIPTORS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const CRON_MONTH_NAMES = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const CRON_DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseCronField(field, min, max, { names = null, allowSevenAsZero = false } = {}) {
  const text = String(field || '').trim();
  if (!text) return { valid: false, detail: 'empty field' };
  const values = new Set();
  let wildcard = false;
  const parseNumber = (token) => {
    const lowered = token.toLowerCase();
    if (names && names[lowered] !== undefined) return names[lowered];
    if (!/^\d+$/.test(token)) return null;
    const value = Number(token);
    if (allowSevenAsZero && value === 7) return 0;
    return value;
  };
  const addRange = (startToken, endToken, step) => {
    const start = parseNumber(startToken);
    const end = parseNumber(endToken);
    if (start === null || end === null) return `invalid range "${startToken}-${endToken}"`;
    if (start < min || end > max || start > end)
      return `range "${startToken}-${endToken}" out of bounds ${min}-${max}`;
    for (let value = start; value <= end; value += step) values.add(value);
    return null;
  };
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (!piece) return { valid: false, detail: `empty list element in "${text}"` };
    const stepMatch = piece.match(/^(\*|[\w-]+)\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      if (!Number.isFinite(step) || step < 1)
        return { valid: false, detail: `invalid step in "${piece}"` };
      if (stepMatch[1] === '*') {
        wildcard = true;
        for (let value = min; value <= max; value += step) values.add(value);
      } else if (stepMatch[1].includes('-')) {
        const [startToken, endToken] = stepMatch[1].split('-');
        const error = addRange(startToken, endToken, step);
        if (error) return { valid: false, detail: error };
      } else {
        const start = parseNumber(stepMatch[1]);
        if (start === null || start < min || start > max)
          return { valid: false, detail: `invalid value in "${piece}"` };
        for (let value = start; value <= max; value += step) values.add(value);
      }
      continue;
    }
    if (piece === '*') {
      wildcard = true;
      for (let value = min; value <= max; value += 1) values.add(value);
      continue;
    }
    const rangeMatch = piece.match(/^([\w]+)-([\w]+)$/);
    if (rangeMatch) {
      const error = addRange(rangeMatch[1], rangeMatch[2], 1);
      if (error) return { valid: false, detail: error };
      continue;
    }
    const value = parseNumber(piece);
    if (value === null) return { valid: false, detail: `invalid value "${piece}"` };
    if (value < min || value > max)
      return { valid: false, detail: `value "${piece}" out of bounds ${min}-${max}` };
    values.add(value);
  }
  return { valid: true, values, wildcard };
}

/**
 * Parse a Kubernetes CronJob schedule.
 * @param {string} schedule
 * @returns {{valid: boolean, descriptor?: string, minutes?: number[], hours?: number[], daysOfMonth?: number[], months?: number[], daysOfWeek?: number[], domWildcard?: boolean, dowWildcard?: boolean, message?: string}}
 */
export function parseCronSchedule(schedule) {
  const raw = String(schedule ?? '').trim();
  if (!raw) {
    return { valid: false, message: 'spec.schedule: Required value: schedule is required' };
  }
  let expression = raw;
  let descriptor = '';
  if (raw.startsWith('@')) {
    descriptor = raw.toLowerCase();
    if (!CRON_DESCRIPTORS[descriptor]) {
      return {
        valid: false,
        message: `spec.schedule: Invalid value: "${raw}": unsupported descriptor`,
      };
    }
    expression = CRON_DESCRIPTORS[descriptor];
  }
  const fields = expression.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return {
      valid: false,
      message: `spec.schedule: Invalid value: "${raw}": expected exactly 5 fields, found ${fields.length}: [${fields.join(' ')}]`,
    };
  }
  const minute = parseCronField(fields[0], 0, 59);
  if (!minute.valid)
    return {
      valid: false,
      message: `spec.schedule: Invalid value: "${raw}": minute field: ${minute.detail}`,
    };
  const hour = parseCronField(fields[1], 0, 23);
  if (!hour.valid)
    return {
      valid: false,
      message: `spec.schedule: Invalid value: "${raw}": hour field: ${hour.detail}`,
    };
  const dayOfMonth = parseCronField(fields[2], 1, 31);
  if (!dayOfMonth.valid)
    return {
      valid: false,
      message: `spec.schedule: Invalid value: "${raw}": day-of-month field: ${dayOfMonth.detail}`,
    };
  const month = parseCronField(fields[3], 1, 12, { names: CRON_MONTH_NAMES });
  if (!month.valid)
    return {
      valid: false,
      message: `spec.schedule: Invalid value: "${raw}": month field: ${month.detail}`,
    };
  const dayOfWeek = parseCronField(fields[4], 0, 6, {
    names: CRON_DAY_NAMES,
    allowSevenAsZero: true,
  });
  if (!dayOfWeek.valid)
    return {
      valid: false,
      message: `spec.schedule: Invalid value: "${raw}": day-of-week field: ${dayOfWeek.detail}`,
    };
  return {
    valid: true,
    descriptor,
    expression,
    minutes: [...minute.values].sort((a, b) => a - b),
    hours: [...hour.values].sort((a, b) => a - b),
    daysOfMonth: [...dayOfMonth.values],
    months: [...month.values],
    daysOfWeek: [...dayOfWeek.values],
    domWildcard: dayOfMonth.wildcard,
    dowWildcard: dayOfWeek.wildcard,
  };
}

/**
 * Validate a CronJob schedule for the CLI / manifest apply paths.
 * @param {string} schedule
 * @returns {{valid: boolean, message?: string}}
 */
export function validateCronSchedule(schedule) {
  const parsed = parseCronSchedule(schedule);
  return parsed.valid ? { valid: true } : { valid: false, message: parsed.message };
}

/**
 * Next occurrence of a cron schedule strictly after `from`.
 * @param {string|object} scheduleOrParsed cron string or parseCronSchedule() result
 * @param {Date} [from]
 * @returns {Date|null}
 */
export function nextCronOccurrence(scheduleOrParsed, from = new Date()) {
  const parsed =
    typeof scheduleOrParsed === 'string' ? parseCronSchedule(scheduleOrParsed) : scheduleOrParsed;
  if (!parsed || !parsed.valid) return null;
  const start = new Date(from.getTime() + 60 * 1000);
  start.setSeconds(0, 0);
  const minutes = parsed.minutes;
  const hours = parsed.hours;
  for (let dayOffset = 0; dayOffset <= 400; dayOffset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
    if (!parsed.months.includes(day.getMonth() + 1)) continue;
    const domMatches = parsed.daysOfMonth.includes(day.getDate());
    const dowMatches = parsed.daysOfWeek.includes(day.getDay() % 7);
    let dayMatches;
    if (parsed.domWildcard && parsed.dowWildcard) dayMatches = true;
    else if (parsed.domWildcard) dayMatches = dowMatches;
    else if (parsed.dowWildcard) dayMatches = domMatches;
    else dayMatches = domMatches || dowMatches; // cron OR semantics when both are restricted
    if (!dayMatches) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          hour,
          minute,
          0,
          0
        );
        if (candidate.getTime() >= start.getTime()) return candidate;
      }
    }
  }
  return null;
}

// ─── CronJob ────────────────────────────────────────────────────────────────

export class CronJob extends ResourceBase {
  constructor(metadata = {}) {
    super('CronJob', { ...metadata, apiVersion: metadata.apiVersion || 'batch/v1' });
    const defaults = {
      schedule: metadata.schedule || '*/5 * * * *',
      concurrencyPolicy: metadata.concurrencyPolicy || 'Allow',
      suspend: metadata.suspend ?? false,
      successfulJobsHistoryLimit: metadata.successfulJobsHistoryLimit ?? 3,
      failedJobsHistoryLimit: metadata.failedJobsHistoryLimit ?? 1,
      startingDeadlineSeconds: metadata.startingDeadlineSeconds || null,
      jobTemplate: {
        spec: {
          completions: metadata.completions ?? 1,
          parallelism: metadata.parallelism ?? 1,
          backoffLimit: metadata.backoffLimit ?? 6,
          template: {
            spec: {
              containers: normalizeContainers(
                metadata.containers || [
                  { name: 'cron-worker', image: 'busybox:latest', command: ['sh', '-c', 'date'] },
                ]
              ),
              restartPolicy: 'OnFailure',
            },
          },
        },
      },
    };
    this._initSpec(defaults, metadata.spec);
    this.activeJobs = [];
    this.successfulJobs = [];
    this.failedJobs = [];
    this.elapsedSinceLastSchedule = 0;
    this.scheduleIntervalSeconds = this._parseSchedule(this.spec.schedule);
    this._setInitialStatus({
      phase: 'Active',
      suspend: this.spec.suspend,
      active: [],
      lastScheduleTime: null,
      lastSuccessfulTime: null,
      conditions: [],
    });
  }

  _parseSchedule(cron) {
    const parts = String(cron || '')
      .trim()
      .split(/\s+/);
    const minute = parts[0] || '*';
    const hour = parts[1] || '*';
    if (minute.startsWith('*/')) {
      const interval = parseInt(minute.substring(2), 10) || 5;
      return hour === '*' ? interval * 60 : interval * 3600;
    }
    if (minute === '0' && hour === '*') return 3600;
    if (minute === '0' && hour === '0') return 86400;
    return 300;
  }

  _triggerJob() {
    if (this.spec.suspend) return null;
    if (this.spec.concurrencyPolicy === 'Forbid' && this.activeJobs.length > 0) {
      this.addEvent(
        'Normal',
        'JobAlreadyActive',
        'Skipped scheduled job: concurrency policy Forbid'
      );
      return null;
    }
    if (this.spec.concurrencyPolicy === 'Replace' && this.activeJobs.length > 0) {
      for (const job of this.activeJobs) job.setPhase('Failed');
      this.activeJobs = [];
    }
    const suffix = Date.now().toString(36);
    const jobName = `${this.metadata.name}-${suffix}`;
    this.status.lastScheduleTime = timestamp();
    this.addEvent('Normal', 'SuccessfulCreate', `Created job ${jobName}`);
    return { name: jobName, spec: deepClone(this.spec.jobTemplate?.spec || {}) };
  }

  addActiveJob(job) {
    this.activeJobs.push(job);
    this.status.active = this.activeJobs.map((j) => j.metadata.name);
    job.addOwnerReference(this);
    return this;
  }

  suspend() {
    this.spec.suspend = true;
    this.status.suspend = true;
    this.setPhase('Suspended');
    this.addEvent('Normal', 'Suspended', 'CronJob suspended');
    return this;
  }

  resume() {
    this.spec.suspend = false;
    this.status.suspend = false;
    this.setPhase('Active');
    this.addEvent('Normal', 'Resumed', 'CronJob resumed');
    return this;
  }

  getScheduleIntervalSeconds() {
    return this._parseSchedule(this.spec.schedule);
  }

  toDescribe() {
    return `Name:                          ${this.metadata.name}
Namespace:                     ${this.metadata.namespace}
Schedule:                      ${this.spec.schedule}
Concurrency Policy:            ${this.spec.concurrencyPolicy}
Suspend:                       ${this.spec.suspend}
Successful Job History Limit:  ${this.spec.successfulJobsHistoryLimit}
Failed Job History Limit:      ${this.spec.failedJobsHistoryLimit}
Active Jobs:                   ${this.activeJobs.map((j) => j.metadata.name).join(', ') || '<none>'}
Last Schedule Time:            ${this.status.lastScheduleTime || '<none>'}
Last Successful Time:          ${this.status.lastSuccessfulTime || '<none>'}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export { parseCpuToMillis, parseMemoryToMi, normalizeContainers };
