import { ResourceBase } from './ResourceBase.js';
import {
  CRIO_RUNTIME,
  KUBELET_VERSION,
  NODE_KERNEL_VERSION,
  RHCOS_OS_IMAGE,
} from '../data/platformVersions.js';
import { deepClone } from './ManifestSerializer.js';

const timestamp = () => new Date().toISOString();

function parseCpuToMillis(cpu) {
  if (typeof cpu === 'number') return cpu;
  const str = String(cpu || '');
  if (str.endsWith('m')) return parseInt(str, 10);
  const parsed = parseFloat(str);
  return Number.isFinite(parsed) ? parsed * 1000 : 0;
}

function parseMemoryToBytes(mem) {
  if (typeof mem === 'number') return mem;
  const str = String(mem || '');
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  for (const [suffix, multiplier] of Object.entries(units)) {
    if (str.endsWith(suffix)) return parseFloat(str) * multiplier;
  }
  const parsed = parseFloat(str);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Canonical kubelet reason/message pairs for Node conditions on OCP 4.22
 * (issue #43). The node controller re-evaluates conditions every tick and
 * often only passes the reason; a real node still reports the full kubelet
 * message, so fill in the canonical text instead of blanking the field.
 */
const NODE_CONDITION_DEFAULTS = {
  Ready: {
    True: ['KubeletReady', 'kubelet is posting ready status'],
    False: ['KubeletNotReady', 'kubelet stopped posting node status.'],
    Unknown: ['NodeStatusUnknown', 'Kubelet stopped posting node status.'],
  },
  MemoryPressure: {
    True: ['KubeletHasInsufficientMemory', 'kubelet has insufficient memory available'],
    False: ['KubeletHasSufficientMemory', 'kubelet has sufficient memory available'],
  },
  DiskPressure: {
    True: ['KubeletHasDiskPressure', 'kubelet has disk pressure'],
    False: ['KubeletHasNoDiskPressure', 'kubelet has no disk pressure'],
  },
  PIDPressure: {
    True: ['KubeletHasInsufficientPID', 'kubelet has insufficient PID available'],
    False: ['KubeletHasSufficientPID', 'kubelet has sufficient PID available'],
  },
  // Real OCP kubelets report NetworkUnavailable=False with the
  // NoNetworkPlugin reason because the OpenShift network plugin does not use
  // the kubelet network-plugin interface; the message is the kubelet's
  // canonical text for that condition.
  NetworkUnavailable: {
    True: ['NoNetworkPlugin', 'network plugin is not ready'],
    False: ['NoNetworkPlugin', 'network plugin is not ready'],
  },
};

const NODE_TIMESTAMP_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NODE_TIMESTAMP_MONTHS = [
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

/**
 * Format a Node condition timestamp the way `oc describe node` does
 * (RFC1123Z, e.g. `Wed, 04 Nov 2026 22:01:58 +0000`).
 * @param {string|number|Date} [value]
 * @returns {string}
 */
function describeNodeTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '<unknown>';
  const pad = (number) => String(number).padStart(2, '0');
  return (
    `${NODE_TIMESTAMP_DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ` +
    `${NODE_TIMESTAMP_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** Columns of the real `oc describe node` Conditions table (issue #43). */
const NODE_CONDITION_COLUMNS = [
  'Type',
  'Status',
  'LastHeartbeatTime',
  'LastTransitionTime',
  'Reason',
  'Message',
];

/** Render the real TYPE/STATUS/LASTHEARTBEATTIME/…/MESSAGE conditions table. */
function describeNodeConditions(conditions = []) {
  const rows = (conditions || []).map((condition) => [
    condition.type || '',
    String(condition.status ?? ''),
    describeNodeTime(condition.lastHeartbeatTime),
    describeNodeTime(condition.lastTransitionTime),
    condition.reason || '',
    condition.message || '',
  ]);
  const widths = NODE_CONDITION_COLUMNS.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length))
  );
  const renderRow = (row) =>
    `  ${row
      .map((cell, index) =>
        index === row.length - 1 ? String(cell) : String(cell).padEnd(widths[index] + 2)
      )
      .join('')}`;
  return [
    renderRow(NODE_CONDITION_COLUMNS),
    renderRow(NODE_CONDITION_COLUMNS.map((header) => '-'.repeat(header.length))),
    ...rows.map(renderRow),
  ].join('\n');
}

/** Render `status.addresses` with the real describe-node alignment. */
function describeNodeAddresses(addresses = []) {
  if (!addresses.length) return '  <none>';
  const labels = addresses.map((address) => `${address.type}:`);
  const width = Math.max(...labels.map((label) => label.length)) + 2;
  return addresses
    .map((address, index) => `  ${labels[index].padEnd(width)}${address.address}`)
    .join('\n');
}

/** Render `spec.taints` like a real node: `key=value:effect` or `key:effect`. */
function describeNodeTaints(taints = []) {
  if (!taints.length) return '<none>';
  return taints
    .map((taint) =>
      taint.value ? `${taint.key}=${taint.value}:${taint.effect}` : `${taint.key}:${taint.effect}`
    )
    .join(',');
}

export class Node extends ResourceBase {
  constructor(metadata = {}) {
    super('Node', { ...metadata, namespace: '', apiVersion: metadata.apiVersion || 'v1' });
    const cpuCapacity = metadata.cpuCapacity || '4';
    const memoryCapacity = metadata.memoryCapacity || '8Gi';
    const defaults = {
      // OCP 4.22 default clusterNetwork is 10.128.0.0/14 (OVN-Kubernetes /23 per node).
      podCIDR: metadata.podCIDR || `10.128.${Math.floor(Math.random() * 64) * 2}.0/23`,
      providerID: metadata.providerID || `baremetal://cluster/${metadata.name || 'node'}`,
      taints: deepClone(metadata.taints || []),
      unschedulable: metadata.unschedulable ?? false,
      // Game extension used by ClusterState.getNodeAllocatable()/MetricsDashboard:
      cpu: String(cpuCapacity),
      memory: String(memoryCapacity),
    };
    this._initSpec(defaults, metadata.spec);
    const capacity = {
      cpu: String(metadata.cpuCapacity || this.spec.cpu || '4'),
      memory: String(metadata.memoryCapacity || this.spec.memory || '8Gi'),
      pods: '110',
      ephemeralStorage: '50Gi',
    };
    const allocatable = {
      cpu:
        metadata.cpuAllocatable || String(Math.max(0, parseCpuToMillis(capacity.cpu) - 200)) + 'm',
      memory:
        metadata.memoryAllocatable ||
        `${Math.max(0, Math.floor(parseMemoryToBytes(capacity.memory) / 1024 ** 3) - 1)}Gi`,
      pods: '110',
      ephemeralStorage: '45Gi',
    };
    const now = timestamp();
    const condition = (type, status, reason, message) => ({
      type,
      status,
      reason,
      message,
      lastHeartbeatTime: now,
      lastTransitionTime: now,
    });
    this._setInitialStatus({
      phase: metadata.phase || 'Running',
      capacity,
      allocatable,
      conditions: [
        condition('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status'),
        condition(
          'MemoryPressure',
          'False',
          'KubeletHasSufficientMemory',
          'kubelet has sufficient memory available'
        ),
        condition(
          'DiskPressure',
          'False',
          'KubeletHasNoDiskPressure',
          'kubelet has no disk pressure'
        ),
        condition(
          'PIDPressure',
          'False',
          'KubeletHasSufficientPID',
          'kubelet has sufficient PID available'
        ),
        condition('NetworkUnavailable', 'False', 'NoNetworkPlugin', 'network plugin is not ready'),
      ],
      nodeInfo: {
        kubeletVersion: metadata.kubeletVersion || KUBELET_VERSION,
        containerRuntimeVersion: metadata.containerRuntimeVersion || CRIO_RUNTIME,
        osImage: metadata.osImage || RHCOS_OS_IMAGE,
        architecture: 'amd64',
        operatingSystem: 'linux',
        kernelVersion: metadata.kernelVersion || NODE_KERNEL_VERSION,
        machineID: this.metadata.uid,
        systemUUID: this.metadata.uid,
      },
      usage: { cpu: 0, memory: 0, cpuPercent: 0, memoryPercent: 0 },
      addresses: [
        {
          type: 'InternalIP',
          address: `192.168.${1 + Math.floor(Math.random() * 250)}.${10 + Math.floor(Math.random() * 240)}`,
        },
        { type: 'Hostname', address: metadata.name || 'node' },
      ],
    });
    this.pods = [];
    this.isCordon = this.spec.unschedulable === true;
  }

  /**
   * Set a node condition, filling in the canonical kubelet reason/message when
   * the controller (IncidentEngine / SimulationTick node tick) omits them.
   * `lastHeartbeatTime` is refreshed on every call; `lastTransitionTime` only
   * moves when the condition status actually changes — real node behaviour.
   * @param {string} type
   * @param {string} status
   * @param {string} [reason]
   * @param {string} [message]
   * @returns {this}
   */
  setCondition(type, status, reason = '', message = '') {
    const defaults = NODE_CONDITION_DEFAULTS[type]?.[String(status)] || null;
    return super.setCondition(
      type,
      String(status),
      reason || (defaults ? defaults[0] : ''),
      message || (defaults ? defaults[1] : '')
    );
  }

  get isReady() {
    return this.isConditionTrue('Ready');
  }

  addPod(pod) {
    if (!this.pods.includes(pod)) this.pods.push(pod);
    pod.spec.nodeName = this.metadata.name;
    return this;
  }

  removePod(pod) {
    this.pods = this.pods.filter((p) => p !== pod);
    return this;
  }

  canSchedulePod(pod) {
    if (this.spec.unschedulable || this.isCordon) return false;
    const podLimit = parseInt(this.status.allocatable?.pods || '110', 10);
    if (this.pods.length >= podLimit) return false;
    for (const taint of this.spec.taints || []) {
      if (taint.effect !== 'NoSchedule' && taint.effect !== 'NoExecute') continue;
      const tolerates = (pod.spec?.tolerations || []).some(
        (t) => t.key === taint.key && (t.operator === 'Exists' || t.value === taint.value)
      );
      if (!tolerates) return false;
    }
    return true;
  }

  cordon() {
    this.isCordon = true;
    this.spec.unschedulable = true;
    this.addEvent('Normal', 'NodeCordon', `Node ${this.metadata.name} cordoned`);
    return this;
  }

  uncordon() {
    this.isCordon = false;
    this.spec.unschedulable = false;
    this.addEvent('Normal', 'NodeUncordon', `Node ${this.metadata.name} uncordoned`);
    return this;
  }

  drain() {
    this.cordon();
    const drained = [...this.pods];
    this.addEvent('Normal', 'NodeDrain', `Draining node, evicting ${drained.length} pods`);
    return drained;
  }

  addTaint(key, value, effect) {
    this.spec.taints = this.spec.taints || [];
    this.spec.taints.push({ key, value, effect });
    this.metadata.generation++;
    this.addEvent('Normal', 'TaintAdded', `Taint ${key}=${value}:${effect} added`);
    return this;
  }

  removeTaint(key) {
    this.spec.taints = (this.spec.taints || []).filter((t) => t.key !== key);
    this.metadata.generation++;
    this.addEvent('Normal', 'TaintRemoved', `Taint ${key} removed`);
    return this;
  }

  getCpuUsagePercent() {
    const used = this.status.usage?.cpu || 0;
    const capacity = parseCpuToMillis(
      this.status.allocatable?.cpu || this.status.capacity?.cpu || this.spec.cpu || '4'
    );
    return capacity > 0 ? (used / capacity) * 100 : 0;
  }

  getMemoryUsagePercent() {
    // usage.memory is in MiB (ClusterState.getNodeAllocatable), allocatable in bytes
    const usedBytes = (this.status.usage?.memory || 0) * 1024 ** 2;
    const capacity = parseMemoryToBytes(
      this.status.allocatable?.memory || this.status.capacity?.memory || this.spec.memory || '8Gi'
    );
    return capacity > 0 ? (usedBytes / capacity) * 100 : 0;
  }

  /**
   * Re-derive status.capacity/allocatable from the spec.
   *
   * Modes seed Nodes by merging a manifest-style spec ({cpu:'16', memory:'32Gi'})
   * into an already-constructed Node, so the constructor-time capacity (4 / 8Gi)
   * could disagree with the spec — `oc describe node` then showed capacity 4 with
   * allocatable 16000m. Call this whenever spec.cpu/spec.memory change.
   */
  syncCapacityFromSpec() {
    const cpu = String(this.spec?.cpu || this.status.capacity?.cpu || '4');
    const memory = String(this.spec?.memory || this.status.capacity?.memory || '8Gi');
    const pods = String(this.spec?.pods || this.status.capacity?.pods || '110');
    this.status.capacity = { ...(this.status.capacity || {}), cpu, memory, pods };
    const allocCpu = Math.max(0, parseCpuToMillis(cpu) - 200);
    const allocMemoryBytes = Math.max(0, parseMemoryToBytes(memory) - 1024 ** 3);
    this.status.allocatable = {
      ...(this.status.allocatable || {}),
      cpu: `${allocCpu}m`,
      memory: `${Math.round(allocMemoryBytes / 1024 ** 2)}Mi`,
      pods,
    };
  }

  /**
   * ROLES value for `oc get nodes` / `oc describe node` (#28 P4): derived from
   * the `node-role.kubernetes.io/*` labels, with a name-based fallback so a
   * machine is never rendered as `<none>`.
   */
  get roles() {
    const labels = this.metadata?.labels || {};
    const roles = Object.keys(labels)
      .filter((key) => key.startsWith('node-role.kubernetes.io/'))
      .map((key) => key.slice('node-role.kubernetes.io/'.length))
      .filter(Boolean);
    if (roles.length > 0) return roles.sort().join(',');
    const name = String(this.metadata?.name || '');
    if (/^(master|control-plane)/.test(name)) return 'control-plane,master';
    return 'worker';
  }

  toDescribe() {
    return `Name:               ${this.metadata.name}
Roles:              ${this.roles}
Labels:             ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n                    ') || '<none>'
    }
Annotations:        ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
CreationTimestamp:  ${describeNodeTime(this.metadata.creationTimestamp)}
Taints:             ${describeNodeTaints(this.spec.taints || [])}
Unschedulable:      ${this.spec.unschedulable === true}
Conditions:
${describeNodeConditions(this.status.conditions || [])}
Addresses:
${describeNodeAddresses(this.status.addresses || [])}
Capacity:
  cpu:                ${this.status.capacity?.cpu}
  memory:             ${this.status.capacity?.memory}
  pods:               ${this.status.capacity?.pods}
Allocatable:
  cpu:                ${this.status.allocatable?.cpu}
  memory:             ${this.status.allocatable?.memory}
  pods:               ${this.status.allocatable?.pods}
System Info:
  Kubelet Version:    ${this.status.nodeInfo?.kubeletVersion}
  Container Runtime:  ${this.status.nodeInfo?.containerRuntimeVersion}
  OS Image:           ${this.status.nodeInfo?.osImage}
  Kernel Version:     ${this.status.nodeInfo?.kernelVersion}
  Architecture:       ${this.status.nodeInfo?.architecture}
Non-terminated Pods: (${this.pods.length} in total)
  CPU Usage:          ${Math.round(this.status.usage?.cpu || 0)}m / ${this.status.allocatable?.cpu || this.status.capacity?.cpu} (${this.getCpuUsagePercent().toFixed(1)}%)
  Memory Usage:       ${Math.round(this.status.usage?.memory || 0)}Mi / ${this.status.allocatable?.memory || this.status.capacity?.memory} (${this.getMemoryUsagePercent().toFixed(1)}%)
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class HorizontalPodAutoscaler extends ResourceBase {
  constructor(metadata = {}) {
    super('HorizontalPodAutoscaler', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'autoscaling/v2',
    });
    const defaults = {
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: metadata.targetKind || 'Deployment',
        name: metadata.targetName || metadata.name || 'app',
      },
      minReplicas: metadata.minReplicas ?? 1,
      maxReplicas: metadata.maxReplicas ?? 10,
      metrics: deepClone(
        metadata.metrics || [
          {
            type: 'Resource',
            resource: {
              name: 'cpu',
              target: { type: 'Utilization', averageUtilization: 50 },
            },
          },
        ]
      ),
      behavior: {
        scaleUp: {
          stabilizationWindowSeconds: metadata.scaleUpStabilization ?? 0,
          policies: [
            { type: 'Percent', value: 100, periodSeconds: 15 },
            { type: 'Pods', value: 4, periodSeconds: 15 },
          ],
          selectPolicy: 'Max',
        },
        scaleDown: {
          stabilizationWindowSeconds: metadata.scaleDownStabilization ?? 300,
          policies: [{ type: 'Percent', value: 100, periodSeconds: 15 }],
          selectPolicy: 'Max',
        },
      },
    };
    this._initSpec(defaults, metadata.spec);
    this.currentReplicas = metadata.currentReplicas || this.spec.minReplicas;
    this.targetDeployment = null;
    this.lastScaleTime = null;
    // Fresh HPA: no metrics have been sampled yet, so exactly like a real
    // cluster `oc get hpa` reports TARGETS `<unknown>/50%` (not 50%/50%) and
    // REPLICAS 0 until the HPA controller completes a successful sync.
    this._setInitialStatus({
      phase: 'Active',
      currentReplicas: Number(metadata.currentReplicas) || 0,
      desiredReplicas: Number(metadata.currentReplicas) || 0,
      currentMetrics: [],
      lastScaleTime: null,
      conditions: [
        {
          type: 'AbleToScale',
          status: 'True',
          reason: 'ReadyForNewScale',
          lastTransitionTime: timestamp(),
        },
        {
          type: 'ScalingActive',
          status: 'False',
          reason: 'FailedGetResourceMetric',
          message: 'the HPA was unable to compute the replica count: no metrics returned',
          lastTransitionTime: timestamp(),
        },
        {
          type: 'ScalingLimited',
          status: 'False',
          reason: 'DesiredWithinRange',
          lastTransitionTime: timestamp(),
        },
      ],
    });
  }

  setTargetDeployment(deployment) {
    this.targetDeployment = deployment;
    return this;
  }

  getTargetUtilization() {
    return this.spec.metrics?.[0]?.resource?.target?.averageUtilization || 50;
  }

  toDescribe() {
    const target = this.spec.scaleTargetRef;
    return `Name:                                  ${this.metadata.name}
Namespace:                             ${this.metadata.namespace}
Reference:                             ${target.kind}/${target.name}
Metrics:                               ( current / target )
  resource cpu on pods (as a percentage of request):  ${this.status.currentMetrics?.[0]?.resource?.current?.averageUtilization !== undefined ? `${Math.round(this.status.currentMetrics[0].resource.current.averageUtilization)}%` : '<unknown>'} / ${this.getTargetUtilization()}%
Min replicas:                          ${this.spec.minReplicas}
Max replicas:                          ${this.spec.maxReplicas}
${target.kind}/${target.name} replicas: ${this.status.currentReplicas || 0}
Conditions:
${(this.status.conditions || []).map((c) => `  Type: ${c.type}  Status: ${c.status}  Reason: ${c.reason}`).join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class ResourceQuota extends ResourceBase {
  constructor(metadata = {}) {
    super('ResourceQuota', { ...metadata, apiVersion: metadata.apiVersion || 'v1' });
    const defaults = {
      hard: deepClone(
        metadata.hard || {
          pods: '20',
          'requests.cpu': '4',
          'requests.memory': '8Gi',
          'limits.cpu': '8',
          'limits.memory': '16Gi',
        }
      ),
    };
    this._initSpec(defaults, metadata.spec);
    const used = {};
    for (const key of Object.keys(this.spec.hard || {})) used[key] = '0';
    this._setInitialStatus({ phase: 'Active', hard: deepClone(this.spec.hard), used });
  }

  get used() {
    return this.status.used || {};
  }

  setTargetNamespace(namespace) {
    this.targetNamespace = namespace;
    if (namespace && typeof namespace === 'object') namespace.resourceQuota = this;
    return this;
  }

  updateUsage(resources) {
    const namespace = this.metadata.namespace;
    const inNamespace = resources.filter((r) => r.metadata?.namespace === namespace);
    const used = {};
    for (const key of Object.keys(this.spec.hard || {})) used[key] = '0';
    used.pods = String(inNamespace.filter((r) => r.kind === 'Pod').length);
    if ('services' in used)
      used.services = String(inNamespace.filter((r) => r.kind === 'Service').length);
    if ('configmaps' in used)
      used.configmaps = String(inNamespace.filter((r) => r.kind === 'ConfigMap').length);
    if ('secrets' in used)
      used.secrets = String(inNamespace.filter((r) => r.kind === 'Secret').length);

    let requestsCpu = 0;
    let requestsMemory = 0;
    let limitsCpu = 0;
    let limitsMemory = 0;
    for (const pod of inNamespace.filter((r) => r.kind === 'Pod')) {
      for (const container of pod.spec?.containers || []) {
        requestsCpu += parseCpuToMillis(container.resources?.requests?.cpu);
        requestsMemory += parseMemoryToBytes(container.resources?.requests?.memory);
        limitsCpu += parseCpuToMillis(container.resources?.limits?.cpu);
        limitsMemory += parseMemoryToBytes(container.resources?.limits?.memory);
      }
    }
    if ('requests.cpu' in used) used['requests.cpu'] = `${Math.round(requestsCpu)}m`;
    if ('requests.memory' in used)
      used['requests.memory'] = `${Math.round(requestsMemory / 1024 ** 2)}Mi`;
    if ('limits.cpu' in used) used['limits.cpu'] = `${Math.round(limitsCpu)}m`;
    if ('limits.memory' in used)
      used['limits.memory'] = `${Math.round(limitsMemory / 1024 ** 2)}Mi`;
    this.status.used = used;
    return used;
  }

  isExceeded(resourceType) {
    const used = parseFloat(this.status.used?.[resourceType]) || 0;
    const hard = parseFloat(this.spec.hard?.[resourceType]) || 0;
    return hard > 0 && used >= hard;
  }

  getUsagePercent(resourceType) {
    const used = parseFloat(this.status.used?.[resourceType]) || 0;
    const hard = parseFloat(this.spec.hard?.[resourceType]) || 0;
    return hard > 0 ? (used / hard) * 100 : 0;
  }

  toDescribe() {
    const hard = this.spec.hard || {};
    const used = this.status.used || {};
    // Real `oc describe quota` uses a tabwriter: every column is padded to the
    // widest cell so Resource/Used/Hard line up exactly (#36).
    const keys = Object.keys(hard).sort();
    const keyWidth = Math.max(14, ...keys.map((key) => key.length + 2));
    const usedWidth = Math.max(6, ...keys.map((key) => String(used[key] ?? '0').length + 2));
    const row = (resource, usedValue, hardValue) =>
      `${String(resource).padEnd(keyWidth)}${String(usedValue).padEnd(usedWidth)}${hardValue}`;
    return `Name:         ${this.metadata.name}
Namespace:    ${this.metadata.namespace}
${row('Resource', 'Used', 'Hard')}
${row('--------', '----', '----')}
${keys.map((key) => row(key, used[key] ?? '0', hard[key])).join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class PodDisruptionBudget extends ResourceBase {
  constructor(metadata = {}) {
    super('PodDisruptionBudget', { ...metadata, apiVersion: metadata.apiVersion || 'policy/v1' });
    const hasMin = metadata.minAvailable !== undefined;
    const defaults = {
      selector: { matchLabels: deepClone(metadata.matchLabels || {}) },
      minAvailable: hasMin ? metadata.minAvailable : null,
      maxUnavailable:
        metadata.maxUnavailable !== undefined ? metadata.maxUnavailable : hasMin ? null : 1,
      // API default when omitted is IfHealthyBudget; valid values are only
      // IfHealthyBudget | AlwaysAllow. Omit unless the caller sets one.
      ...(metadata.unhealthyPodEvictionPolicy
        ? { unhealthyPodEvictionPolicy: metadata.unhealthyPodEvictionPolicy }
        : {}),
    };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({
      phase: 'Active',
      currentHealthy: 0,
      desiredHealthy: 0,
      disruptionsAllowed: 0,
      expectedPods: 0,
      observedGeneration: 1,
      conditions: [],
    });
  }

  updateStatus(matchingPods = []) {
    const running = matchingPods.filter(
      (p) => p.status?.phase === 'Running' || p.phase === 'Running'
    );
    this.status.expectedPods = matchingPods.length;
    this.status.currentHealthy = running.length;
    const expected = matchingPods.length;
    if (this.spec.minAvailable !== null && this.spec.minAvailable !== undefined) {
      const minAvailable =
        typeof this.spec.minAvailable === 'string' && this.spec.minAvailable.endsWith('%')
          ? Math.ceil((expected * parseInt(this.spec.minAvailable, 10)) / 100)
          : parseInt(this.spec.minAvailable, 10);
      this.status.desiredHealthy = minAvailable;
      this.status.disruptionsAllowed = Math.max(0, running.length - minAvailable);
    } else {
      const maxUnavailable =
        typeof this.spec.maxUnavailable === 'string' && this.spec.maxUnavailable.endsWith('%')
          ? Math.ceil((expected * parseInt(this.spec.maxUnavailable, 10)) / 100)
          : parseInt(this.spec.maxUnavailable, 10) || 0;
      this.status.desiredHealthy = Math.max(0, expected - maxUnavailable);
      this.status.disruptionsAllowed = Math.max(0, maxUnavailable - (expected - running.length));
    }
    return this.status;
  }

  canDisrupt() {
    return (this.status.disruptionsAllowed || 0) > 0;
  }

  toDescribe() {
    const specLine =
      this.spec.minAvailable !== null && this.spec.minAvailable !== undefined
        ? `Min Available:         ${this.spec.minAvailable}`
        : `Max Unavailable:       ${this.spec.maxUnavailable}`;
    return `Name:                  ${this.metadata.name}
Namespace:             ${this.metadata.namespace}
${specLine}
Selector:              ${Object.entries(this.spec.selector?.matchLabels || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}
Status:
  Allowed Disruptions: ${this.status.disruptionsAllowed}
  Current Healthy:     ${this.status.currentHealthy}
  Desired Healthy:     ${this.status.desiredHealthy}
  Total:               ${this.status.expectedPods}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export { parseCpuToMillis, parseMemoryToBytes };
export default { Node, HorizontalPodAutoscaler, ResourceQuota, PodDisruptionBudget };
