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
  const list = Array.isArray(containers) && containers.length > 0 ? containers : [defaultContainer()];
  return deepClone(list);
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
    return (this.status.containerStatuses || []).reduce((sum, cs) => sum + (cs.restartCount || 0), 0);
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
    this.addEvent('Warning', 'BackOff', `Back-off restarting failed container ${this.getPrimaryContainer()?.name || 'main'}`);
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

  toDescribe() {
    const containers = this.status.containerStatuses || [];
    const conditions = this.status.conditions || [];
    return `Name:         ${this.metadata.name}
Namespace:    ${this.metadata.namespace}
Priority:     0
Node:         ${this.spec.nodeName || '<none>'}/${this.status.hostIP || '<none>'}
Start Time:   ${this.status.startTime || '<none>'}
Labels:       ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:  ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Status:       ${this.status.phase}
IP:           ${this.status.podIP || '<none>'}
QoS Class:    ${this.status.qosClass || 'BestEffort'}
Service Account: ${this.spec.serviceAccountName || 'default'}
Containers:
${containers
  .map(
    (cs) => `  ${cs.name}:
    Image:          ${cs.image}
    State:          ${Object.keys(cs.state || {})[0] || 'Unknown'}
    Ready:          ${cs.ready}
    Restart Count:  ${cs.restartCount || 0}`
  )
  .join('\n') || '  <none>'}
Conditions:
${conditions.map((c) => `  ${c.type.padEnd(16)} ${c.status}`).join('\n') || '  <none>'}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
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
    this.setCondition('Progressing', 'True', 'ReplicaSetUpdated', `ReplicaSet "${this.metadata.name}-${this.revision}" is progressing.`);
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

  toDescribe() {
    const selector = this.spec.selector?.matchLabels || {};
    const strategy = this.spec.strategy || {};
    const rolling = strategy.rollingUpdate || {};
    return `Name:                   ${this.metadata.name}
Namespace:              ${this.metadata.namespace}
CreationTimestamp:      ${this.metadata.creationTimestamp}
Labels:                 ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:            ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Selector:               ${Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')}
Replicas:               ${this.status.replicas || 0} desired | ${this.status.updatedReplicas || 0} updated | ${this.status.replicas || 0} total | ${this.status.availableReplicas || 0} available | ${this.status.unavailableReplicas || 0} unavailable
StrategyType:           ${strategy.type || 'RollingUpdate'}
MinReadySeconds:        0
RollingUpdateStrategy:  ${rolling.maxUnavailable || 0} max unavailable, ${rolling.maxSurge || 0} max surge
Conditions:
${(this.status.conditions || []).map((c) => `  ${c.type.padEnd(16)} ${c.status.padEnd(6)} ${c.reason || ''}`).join('\n') || '  <none>'}
OldReplicaSets:         <none>
NewReplicaSet:          <none>
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
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
Selector:       ${Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')}
Replicas:       ${this.spec.replicas || 0} desired | ${this.status.replicas || 0} current | ${this.status.readyReplicas || 0} ready
Pod Template:
  Containers:
${(this.spec.template?.spec?.containers || [])
  .map((c) => `   ${c.name}:\n    Image:  ${c.image}`)
  .join('\n')}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
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
      volumeClaimTemplates:
        metadata.volumeClaimTemplates || [
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
Selector:           ${Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')}
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
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
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
Selector:       ${Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')}
Node-Selector:  ${Object.entries(this.spec.template?.spec?.nodeSelector || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>'}
Desired Number of Nodes Scheduled: ${this.status.desiredNumberScheduled || 0}
Current Number of Nodes Scheduled: ${this.status.currentNumberScheduled || 0}
Number Ready:   ${this.status.numberReady || 0}
Pod Template:
  Containers:
${(this.spec.template?.spec?.containers || [])
  .map((c) => `   ${c.name}:\n    Image:  ${c.image}`)
  .join('\n')}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
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
            metadata.containers || [{ name: 'worker', image: 'busybox:latest', command: ['sh', '-c', 'echo done'] }]
          ),
          restartPolicy: 'Never',
        },
      },
    };
    this._initSpec(defaults, metadata.spec);
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
    return Math.max(0, Math.floor((end.getTime() - new Date(this.status.startTime).getTime()) / 1000));
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
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
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
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
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
    if (start < min || end > max || start > end) return `range "${startToken}-${endToken}" out of bounds ${min}-${max}`;
    for (let value = start; value <= end; value += step) values.add(value);
    return null;
  };
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (!piece) return { valid: false, detail: `empty list element in "${text}"` };
    const stepMatch = piece.match(/^(\*|[\w-]+)\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      if (!Number.isFinite(step) || step < 1) return { valid: false, detail: `invalid step in "${piece}"` };
      if (stepMatch[1] === '*') {
        wildcard = true;
        for (let value = min; value <= max; value += step) values.add(value);
      } else if (stepMatch[1].includes('-')) {
        const [startToken, endToken] = stepMatch[1].split('-');
        const error = addRange(startToken, endToken, step);
        if (error) return { valid: false, detail: error };
      } else {
        const start = parseNumber(stepMatch[1]);
        if (start === null || start < min || start > max) return { valid: false, detail: `invalid value in "${piece}"` };
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
    if (value < min || value > max) return { valid: false, detail: `value "${piece}" out of bounds ${min}-${max}` };
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
      return { valid: false, message: `spec.schedule: Invalid value: "${raw}": unsupported descriptor` };
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
  if (!minute.valid) return { valid: false, message: `spec.schedule: Invalid value: "${raw}": minute field: ${minute.detail}` };
  const hour = parseCronField(fields[1], 0, 23);
  if (!hour.valid) return { valid: false, message: `spec.schedule: Invalid value: "${raw}": hour field: ${hour.detail}` };
  const dayOfMonth = parseCronField(fields[2], 1, 31);
  if (!dayOfMonth.valid) return { valid: false, message: `spec.schedule: Invalid value: "${raw}": day-of-month field: ${dayOfMonth.detail}` };
  const month = parseCronField(fields[3], 1, 12, { names: CRON_MONTH_NAMES });
  if (!month.valid) return { valid: false, message: `spec.schedule: Invalid value: "${raw}": month field: ${month.detail}` };
  const dayOfWeek = parseCronField(fields[4], 0, 6, { names: CRON_DAY_NAMES, allowSevenAsZero: true });
  if (!dayOfWeek.valid) return { valid: false, message: `spec.schedule: Invalid value: "${raw}": day-of-week field: ${dayOfWeek.detail}` };
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
  const parsed = typeof scheduleOrParsed === 'string' ? parseCronSchedule(scheduleOrParsed) : scheduleOrParsed;
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
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
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
                metadata.containers || [{ name: 'cron-worker', image: 'busybox:latest', command: ['sh', '-c', 'date'] }]
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
    const parts = String(cron || '').trim().split(/\s+/);
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
      this.addEvent('Normal', 'JobAlreadyActive', 'Skipped scheduled job: concurrency policy Forbid');
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
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

export { parseCpuToMillis, parseMemoryToMi, normalizeContainers };
