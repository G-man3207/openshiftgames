/**
 * Monitoring resource classes — OpenShift 4.22 / EX280.
 *
 * The OpenShift monitoring stack is CRD-driven and cluster-admin territory: it
 * runs in the `openshift-monitoring` project, and normal users inspect it rather
 * than re-create it. Two `monitoring.coreos.com/v1` kinds are modelled here:
 *
 *   - PrometheusRule declares the alerting/recording rule groups cluster
 *     Prometheus evaluates (`oc get prometheusrules -A`, `oc describe
 *     prometheusrule <name>`).
 *   - Alertmanager configures the notifier that routes the resulting alerts
 *     (`oc get alertmanager -n openshift-monitoring`, `oc describe alertmanager
 *     main`). Its description lists the alerts that are currently firing.
 *
 * Alerts are evaluated from live cluster state, not hard-coded: a project with
 * a CrashLoopBackOff pod (or an ImagePullBackOff Pending pod) makes the matching
 * rule fire, exactly like the real `kubernetes-monitoring-rules` rule set. The
 * `Watchdog` alert is always firing (dead man's switch - on a real cluster it
 * certifies that the alerting pipeline itself works), so every cluster has one
 * honest firing alert to inspect.
 *
 * `seedMonitoringResources(cluster)` installs the default-cluster baseline:
 * the three rules the simulated cluster ships, alertmanager-main (CR + Service
 * + Route + two running Pods) and its Watchdog event.
 */

import { ResourceBase } from './ResourceBase.js';

/** Project the monitoring stack lives in. */
export const MONITORING_NAMESPACE = 'openshift-monitoring';

const timestamp = () => new Date().toISOString();

/** Cluster reference per Alertmanager instance (never serialized/cloned). */
const alertSources = new WeakMap();

/**
 * Attach the cluster an Alertmanager CR belongs to, so its alerts can be
 * evaluated from live state. Kept out of the resource fields on purpose: the
 * cluster graph must never be deep-cloned with the resource.
 * @param {ResourceBase} alertmanager
 * @param {object} cluster ClusterState instance
 */
export function attachAlertSource(alertmanager, cluster) {
  if (alertmanager && cluster) alertSources.set(alertmanager, cluster);
  return alertmanager;
}

/**
 * `oc describe`-style `Labels`/`Annotations` block (first pair on the header
 * line). The generic CR describer aligns every level-0 value to the widest
 * field plus tabwriter padding: `Annotations:`/`API Version:` are 12 chars, so
 * values start at column 14 (`Labels:` + 7 spaces) and continuation label lines
 * are indented 14 spaces (#49).
 */
function describeMap(heading, values) {
  const entries = Object.entries(values || {}).filter(([, value]) => value !== '');
  const column = 14;
  const header = `${heading}${' '.repeat(Math.max(0, column - heading.length))}`;
  if (!entries.length) return [`${header}<none>`];
  const pad = ' '.repeat(column);
  const [first, ...rest] = entries.map(([key, value]) => `${key}=${value}`);
  return [`${header}${first}`, ...rest.map((line) => `${pad}${line}`)];
}

function countRules(groups) {
  let rules = 0;
  for (const group of groups || []) rules += (group.rules || []).length;
  return { groups: (groups || []).length, rules };
}

// ─── PrometheusRule ────────────────────────────────────────────────────────

/**
 * PrometheusRule (monitoring.coreos.com/v1, namespaced): alerting and recording
 * rule groups evaluated by the cluster Prometheus instance.
 */
export class PrometheusRule extends ResourceBase {
  constructor(metadata = {}) {
    super('PrometheusRule', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'monitoring.coreos.com/v1',
    });
    this._initSpec({ groups: [] }, metadata.spec);
    const counts = countRules(this.spec.groups);
    this._setInitialStatus({
      observedGeneration: 1,
      groups: counts.groups,
      rules: counts.rules,
      lastEvaluation: timestamp(),
      conditions: [],
    });
  }

  /** Every alerting rule declared by this object, flattened. */
  get alertRules() {
    const rules = [];
    for (const group of this.spec.groups || []) {
      for (const rule of group.rules || []) {
        if (rule.alert) rules.push({ ...rule, group: group.name });
      }
    }
    return rules;
  }

  toDescribe() {
    const lines = [
      `Name:         ${this.metadata.name}`,
      `Namespace:    ${this.metadata.namespace}`,
      ...describeMap('Labels:', this.metadata.labels),
      ...describeMap('Annotations:', this.metadata.annotations),
      `API Version:  monitoring.coreos.com/v1`,
      `Kind:         PrometheusRule`,
      'Metadata:',
      `  Creation Timestamp:  ${this.metadata.creationTimestamp}`,
      'Spec:',
    ];
    const groups = this.spec.groups || [];
    if (!groups.length) {
      lines.push('  Groups:  <none>');
    } else {
      lines.push('  Groups:');
      for (const group of groups) {
        lines.push(`    Name:  ${group.name || 'unnamed'}`);
        const rules = group.rules || [];
        if (!rules.length) lines.push('    Rules:  <none>');
        else {
          lines.push('    Rules:');
          for (const rule of rules) {
            if (rule.alert) lines.push(`      Alert:  ${rule.alert}`);
            if (rule.record) lines.push(`      Record:  ${rule.record}`);
            const ruleLabels = Object.entries(rule.labels || {});
            if (ruleLabels.length) {
              lines.push('      Labels:');
              for (const [key, value] of ruleLabels) lines.push(`        ${key}:  ${value}`);
            }
            if (rule.for) lines.push(`      For:    ${rule.for}`);
            if (rule.expr) lines.push(`      Expr:  ${rule.expr}`);
            const annotations = Object.entries(rule.annotations || {});
            if (annotations.length) {
              lines.push('      Annotations:');
              for (const [key, value] of annotations) {
                const label = key.charAt(0).toUpperCase() + key.slice(1);
                lines.push(`        ${label}:  ${value}`);
              }
            }
          }
        }
      }
    }
    lines.push('Events:');
    lines.push(this._eventsDescription());
    return lines.join('\n');
  }

  _eventsDescription() {
    const events = this.getEvents(10);
    if (!events.length) return '  <none>';
    return events.map((event) => `  ${event.type}\t${event.reason}\t${event.message}`).join('\n');
  }
}

// ─── Alertmanager ──────────────────────────────────────────────────────────

/**
 * The subset of alerting rules the simulated cluster ships. Names/expression
 * shapes follow the real `kubernetes-monitoring-rules`, `node-exporter-rules`
 * and `openshift-monitoring-rules` PrometheusRules in openshift-monitoring.
 */
const DEFAULT_PROMETHEUS_RULES = [
  {
    name: 'kubernetes-monitoring-rules',
    labels: { prometheus: 'k8s', role: 'alert-rules' },
    groups: [
      {
        name: 'kubernetes-apps',
        rules: [
          {
            alert: 'KubePodCrashLooping',
            expr: 'max_over_time(kube_pod_container_status_waiting_reason{job="kube-state-metrics",reason="CrashLoopBackOff"}[5m]) >= 1',
            for: '15m',
            labels: { severity: 'warning' },
            annotations: {
              description:
                'Pod {{ $labels.namespace }}/{{ $labels.pod }} ({{ $labels.container }}) is in waiting state (reason: "CrashLoopBackOff").',
              summary: 'Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping.',
            },
          },
          {
            alert: 'KubePodNotReady',
            expr: 'sum by (namespace, pod) (max by (namespace, pod) (kube_pod_status_phase{job="kube-state-metrics",phase=~"Pending|Unknown"}) * on(namespace, pod) group_left(owner_kind) topk by (namespace, pod) (1, max by (namespace, pod, owner_kind) (kube_pod_owner{owner_kind!="Job"}))) > 0',
            for: '15m',
            labels: { severity: 'warning' },
            annotations: {
              summary: 'Pod {{ $labels.namespace }}/{{ $labels.pod }} is not ready.',
              description:
                'Pod {{ $labels.namespace }}/{{ $labels.pod }} has been in a non-ready state for longer than 15 minutes.',
            },
          },
          {
            alert: 'KubeDeploymentReplicasMismatch',
            expr: 'kube_deployment_spec_replicas{job="kube-state-metrics"} != kube_deployment_status_replicas_available{job="kube-state-metrics"}',
            for: '15m',
            labels: { severity: 'warning' },
            annotations: {
              summary:
                'Deployment {{ $labels.namespace }}/{{ $labels.deployment }} has not matched the expected number of replicas for longer than 15 minutes.',
            },
          },
        ],
      },
    ],
  },
  {
    name: 'node-exporter-rules',
    labels: { prometheus: 'k8s', role: 'alert-rules' },
    groups: [
      {
        name: 'node-exporter',
        rules: [
          {
            alert: 'NodeFilesystemSpaceFillingUp',
            expr: '(node_filesystem_avail_bytes{job="node-exporter",fstype!=""} / node_filesystem_size_bytes{job="node-exporter",fstype!=""} * 100 < 15 and predict_linear(node_filesystem_avail_bytes{job="node-exporter",fstype!=""}[6h], 4 * 60 * 60) < 0)',
            for: '6h',
            labels: { severity: 'warning' },
            annotations: {
              summary:
                'Filesystem on {{ $labels.device }} at {{ $labels.instance }} is filling up.',
            },
          },
          {
            alert: 'NodeFilesystemAlmostOutOfSpace',
            expr: 'node_filesystem_avail_bytes{job="node-exporter",fstype!=""} / node_filesystem_size_bytes{job="node-exporter",fstype!=""} * 100 < 5',
            for: '30m',
            labels: { severity: 'warning' },
            annotations: {
              summary:
                'Filesystem on {{ $labels.device }} at {{ $labels.instance }} is almost out of space.',
            },
          },
          {
            alert: 'NodeNetworkReceiveErrs',
            expr: 'increase(node_network_receive_errs_total[2m]) / rate(node_network_receive_packets_total[2m]) > 0.01',
            for: '1h',
            labels: { severity: 'warning' },
            annotations: {
              summary:
                '{{ $labels.instance }} interface {{ $labels.device }} shows errors while receiving packets.',
            },
          },
        ],
      },
    ],
  },
  {
    name: 'openshift-monitoring-rules',
    labels: { prometheus: 'k8s', role: 'alert-rules' },
    groups: [
      {
        name: 'openshift-monitoring',
        rules: [
          {
            alert: 'TargetDown',
            expr: '100 * (1 - sum(up{job=~".*"}) by (job) / count(up{job=~".*"}) by (job)) > 10',
            for: '10m',
            labels: { severity: 'warning' },
            annotations: {
              summary:
                '{{ printf "%.4g" $value }}% of the {{ $labels.job }} targets in {{ $labels.namespace }} namespace are down.',
            },
          },
          {
            alert: 'Watchdog',
            expr: 'vector(1)',
            labels: { severity: 'none' },
            annotations: {
              description:
                'This is an alert meant to ensure that the entire alerting pipeline is functional. This alert is always firing, therefore it should always be firing in Alertmanager and always fire against a receiver.',
              summary:
                'An alert that should always be firing to certify that Alertmanager is working properly.',
            },
          },
        ],
      },
    ],
  },
];

/** The always-firing dead man's switch alert. */
function watchdogAlert() {
  return {
    name: 'Watchdog',
    severity: 'none',
    state: 'firing',
    activeAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    namespace: MONITORING_NAMESPACE,
    target: 'alertmanager-main',
    summary:
      'An alert that should always be firing to certify that Alertmanager is working properly.',
  };
}

function podAlertRecords(pod) {
  const namespace = pod.metadata?.namespace || '';
  const name = pod.metadata?.name || 'unknown';
  const statuses = pod.status?.containerStatuses || [];
  const waitingReasons = statuses
    .map((status) => status.state?.waiting?.reason || '')
    .filter(Boolean);
  const records = [];
  if (
    waitingReasons.includes('CrashLoopBackOff') ||
    pod.status?.phase === 'Failed' ||
    statuses.some((status) => (status.restartCount || 0) > 0 && status.state?.waiting)
  ) {
    records.push({
      name: 'KubePodCrashLooping',
      severity: 'warning',
      state: 'firing',
      activeAt: pod.metadata?.creationTimestamp || timestamp(),
      namespace,
      target: `pod/${name}`,
      summary: `Pod ${namespace}/${name} is crash looping.`,
    });
  }
  if (
    pod.status?.phase === 'Pending' &&
    waitingReasons.some((reason) =>
      [
        'ImagePullBackOff',
        'ErrImagePull',
        'CreateContainerConfigError',
        'InvalidImageName',
      ].includes(reason)
    )
  ) {
    records.push({
      name: 'KubePodNotReady',
      severity: 'warning',
      state: 'firing',
      activeAt: pod.metadata?.creationTimestamp || timestamp(),
      namespace,
      target: `pod/${name}`,
      summary: `Pod ${namespace}/${name} is not ready.`,
    });
  }
  return records;
}

function nodeAlertRecords(node) {
  const conditions = node.status?.conditions || node.conditions || [];
  const disk = conditions.find(
    (condition) => condition.type === 'DiskPressure' && condition.status === 'True'
  );
  if (!disk) return [];
  return [
    {
      name: 'NodeFilesystemSpaceFillingUp',
      severity: 'warning',
      state: 'firing',
      activeAt: disk.lastTransitionTime || timestamp(),
      namespace: '',
      target: `node/${node.metadata?.name || 'unknown'}`,
      summary: `Filesystem on node ${node.metadata?.name || 'unknown'} is filling up.`,
    },
  ];
}

/**
 * Evaluate the shipped alert rules against live cluster state.
 * @param {object} cluster ClusterState instance
 * @returns {Array<{name: string, severity: string, state: string, activeAt: string, namespace: string, target: string, summary: string}>}
 */
export function computeFiringAlerts(cluster) {
  const alerts = [];
  const pods = typeof cluster?.getByKind === 'function' ? cluster.getByKind('Pod') || [] : [];
  for (const pod of pods) {
    alerts.push(...podAlertRecords(pod));
    if (alerts.length >= 20) break;
  }
  const nodes = typeof cluster?.getByKind === 'function' ? cluster.getByKind('Node') || [] : [];
  for (const node of nodes) {
    alerts.push(...nodeAlertRecords(node));
    if (alerts.length >= 20) break;
  }
  alerts.push(watchdogAlert());
  return alerts.slice(0, 20);
}

/**
 * Alertmanager CR (monitoring.coreos.com/v1, namespaced): the notifier instance
 * the OpenShift monitoring operator deploys into openshift-monitoring.
 */
export class Alertmanager extends ResourceBase {
  constructor(metadata = {}) {
    super('Alertmanager', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'monitoring.coreos.com/v1',
    });
    const replicas = Number(metadata.replicas ?? metadata.spec?.replicas ?? 2) || 2;
    this._initSpec(
      {
        replicas,
        version: metadata.version || metadata.spec?.version || '0.27.0',
        logLevel: metadata.spec?.logLevel || 'info',
        retention: metadata.spec?.retention || '120h',
        nodeSelector: { 'kubernetes.io/os': 'linux' },
        securityContext: { runAsNonRoot: true },
      },
      metadata.spec
    );
    this._setInitialStatus({
      replicas: this.spec.replicas,
      availableReplicas: this.spec.replicas,
      conditions: [
        {
          type: 'Available',
          status: 'True',
          reason: 'Available',
          message: '',
          lastTransitionTime: timestamp(),
        },
      ],
      alerts: [],
    });
  }

  /** Alerts currently firing (evaluated from live cluster state when attached). */
  getFiringAlerts() {
    const cluster = alertSources.get(this);
    if (cluster) return computeFiringAlerts(cluster);
    return Array.isArray(this.status.alerts) ? this.status.alerts : [];
  }

  toDescribe() {
    const lines = [
      `Name:         ${this.metadata.name}`,
      `Namespace:    ${this.metadata.namespace}`,
      ...describeMap('Labels:', this.metadata.labels),
      ...describeMap('Annotations:', this.metadata.annotations),
      'API Version:  monitoring.coreos.com/v1',
      'Kind:         Alertmanager',
      'Metadata:',
      `  Creation Timestamp:  ${this.metadata.creationTimestamp}`,
      'Spec:',
      `  Replicas:   ${this.spec.replicas ?? 2}`,
      `  Version:    ${this.spec.version || '<none>'}`,
      `  Log Level:  ${this.spec.logLevel || 'info'}`,
      `  Retention:  ${this.spec.retention || '120h'}`,
      'Status:',
      `  Available Replicas:  ${this.status.availableReplicas ?? this.spec.replicas ?? 0}`,
      `  Replicas:            ${this.status.replicas ?? this.spec.replicas ?? 0}`,
    ];
    const conditions = this.status.conditions || [];
    if (conditions.length) {
      lines.push('  Conditions:');
      for (const condition of conditions) {
        lines.push(`    Type:    ${condition.type}`);
        lines.push(`    Status:  ${condition.status}`);
        if (condition.reason) lines.push(`    Reason:  ${condition.reason}`);
      }
    }
    const alerts = this.getFiringAlerts();
    lines.push('  Firing Alerts:');
    if (!alerts.length) lines.push('    <none>');
    for (const alert of alerts) {
      lines.push(
        `    ${alert.name}  (severity: ${alert.severity || 'none'}, state: ${alert.state || 'firing'})`
      );
      if (alert.target) lines.push(`      Target:   ${alert.target}`);
      if (alert.summary) lines.push(`      Summary:  ${alert.summary}`);
    }
    lines.push('Events:');
    const events = this.getEvents(10);
    lines.push(
      events.length
        ? events.map((event) => `  ${event.type}\t${event.reason}\t${event.message}`).join('\n')
        : '  <none>'
    );
    return lines.join('\n');
  }
}

// ─── Default-cluster seeding ───────────────────────────────────────────────

/** Parse a Kubernetes CPU quantity to millicores (the simulation's unit). */
function parseCpuMillis(value) {
  const text = String(value ?? '0').trim();
  if (text.endsWith('m')) return Math.round(parseFloat(text) || 0);
  return Math.round((parseFloat(text) || 0) * 1000);
}

/** Parse a Kubernetes memory quantity to MiB (the simulation's unit). */
function parseMemoryMiB(value) {
  const text = String(value ?? '0').trim();
  const match = text.match(/^([0-9.]+)\s*([KMGT]i)?$/i);
  if (!match) return 0;
  const amount = parseFloat(match[1]) || 0;
  const unit = (match[2] || 'Mi').toUpperCase();
  const factors = { KI: 1 / 1024, MI: 1, GI: 1024, TI: 1024 * 1024 };
  return Math.round(amount * (factors[unit] || 1));
}

/** Image digests for the seeded monitoring containers (realistic sha256 shape). */
const IMAGE_DIGESTS = {
  alertmanager: 'sha256:8f3c0b1ee6f0c6f5b9d2a8ca11b6d6ba3aa8e1c4bf0d1c8c1e6a4c6a2f0b9d1',
  'config-reloader': 'sha256:1c7e4a0f0b2c6e5d8a9f3b7c1d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8',
};

/**
 * Build a `status.containerStatuses` entry for a seeded Running container.
 * The simulator's resource accounting (`SimulationTick._tickContainerResources`)
 * requires the numeric `resources` block, so seeded pods must provide it.
 */
function runningContainerStatus(container, startedAt) {
  const requests = container.resources?.requests || {};
  const limits = container.resources?.limits || {};
  const cpuRequest = parseCpuMillis(requests.cpu || '100m');
  const memoryRequest = parseMemoryMiB(requests.memory || '128Mi');
  return {
    name: container.name,
    image: container.image,
    imageID: IMAGE_DIGESTS[container.name] || `sha256:${'0'.repeat(64)}`,
    ready: true,
    started: true,
    restartCount: 0,
    state: { running: { startedAt } },
    lastState: {},
    resources: {
      cpu: cpuRequest * 0.6,
      memory: memoryRequest * 0.7,
      cpuLimit: parseCpuMillis(limits.cpu || '0'),
      memoryLimit: parseMemoryMiB(limits.memory || '0'),
      cpuRequest,
      memoryRequest,
    },
  };
}

function addResource(cluster, kind, name, options = {}) {
  if (typeof cluster._seed === 'function') return cluster._seed(kind, name, options);
  // Fallback for cluster stores without the private _seed convention.
  const created = {
    kind,
    metadata: { name, namespace: options.namespace || '' },
    spec: options.spec || {},
    status: options.status || {},
  };
  if (typeof cluster.addResource === 'function') return cluster.addResource(created);
  return null;
}

function seedPrometheusRules(cluster) {
  for (const rule of DEFAULT_PROMETHEUS_RULES) {
    addResource(cluster, 'PrometheusRule', rule.name, {
      namespace: MONITORING_NAMESPACE,
      labels: rule.labels,
      spec: { groups: rule.groups },
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({
          apiVersion: 'monitoring.coreos.com/v1',
          kind: 'PrometheusRule',
          metadata: { name: rule.name, namespace: MONITORING_NAMESPACE, labels: rule.labels },
          spec: { groups: rule.groups },
        }),
      },
    });
  }
}

function seedAlertmanager(cluster) {
  const replicas = 2;
  const alertmanager = addResource(cluster, 'Alertmanager', 'main', {
    namespace: MONITORING_NAMESPACE,
    labels: { app: 'alertmanager', alertmanager: 'main' },
    spec: { replicas, version: '0.27.0', logLevel: 'info', retention: '120h' },
    status: {
      replicas,
      availableReplicas: replicas,
      conditions: [
        {
          type: 'Available',
          status: 'True',
          reason: 'Available',
          message: '',
          lastTransitionTime: timestamp(),
        },
      ],
      alerts: [watchdogAlert()],
    },
  });
  if (alertmanager) {
    attachAlertSource(alertmanager, cluster);
    alertmanager.recordEvent(
      'Normal',
      'Watchdog',
      "Watchdog alert is firing (dead man's switch) — the alerting pipeline is healthy"
    );
  }

  addResource(cluster, 'Service', 'alertmanager-main', {
    namespace: MONITORING_NAMESPACE,
    labels: { app: 'alertmanager', alertmanager: 'main' },
    spec: {
      type: 'ClusterIP',
      selector: { app: 'alertmanager', alertmanager: 'main' },
      ports: [
        { name: 'web', port: 9094, targetPort: 9094, protocol: 'TCP' },
        { name: 'grpc', port: 9095, targetPort: 9095, protocol: 'TCP' },
        { name: 'reloader', port: 9093, targetPort: 9093, protocol: 'TCP' },
      ],
    },
    // A real 4.22 Service status carries only `loadBalancer` — the API server
    // never stores a `phase`/`conditions` skeleton on a Service (issue #59).
    status: { loadBalancer: {} },
  });

  addResource(cluster, 'Route', 'alertmanager-main', {
    namespace: MONITORING_NAMESPACE,
    labels: { app: 'alertmanager' },
    spec: {
      host: '',
      to: { kind: 'Service', name: 'alertmanager-main', weight: 100 },
      port: { targetPort: 'web' },
      wildcardPolicy: 'None',
      tls: { termination: 'reencrypt', insecureEdgeTerminationPolicy: 'Redirect' },
    },
    status: {
      phase: 'Admitted',
      ingress: [
        {
          host: `alertmanager-main-${MONITORING_NAMESPACE}.apps.cluster.example.com`,
          routerName: 'default',
          routerCanonicalHostname: 'router-default.apps.cluster.example.com',
          wildcardPolicy: 'None',
          conditions: [
            {
              type: 'Admitted',
              status: 'True',
              reason: 'Accepted',
              message: 'Route admitted by the ingress router',
              lastTransitionTime: timestamp(),
            },
          ],
        },
      ],
    },
  });

  const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const containers = [
    {
      name: 'alertmanager',
      image: 'quay.io/openshift/origin-alertmanager:latest',
      ports: [{ name: 'web', containerPort: 9094, protocol: 'TCP' }],
      resources: {
        requests: { cpu: '4m', memory: '40Mi' },
        limits: { cpu: '10m', memory: '80Mi' },
      },
    },
    {
      name: 'config-reloader',
      image: 'quay.io/openshift/origin-configmap-reloader:latest',
      resources: { requests: { cpu: '1m', memory: '10Mi' } },
    },
  ];
  for (let replica = 0; replica < replicas; replica += 1) {
    const podName = `alertmanager-main-${replica}`;
    addResource(cluster, 'Pod', podName, {
      namespace: MONITORING_NAMESPACE,
      labels: {
        app: 'alertmanager',
        alertmanager: 'main',
        'controller-revision-hash': 'alertmanager-main-7c9b8f6d5',
        'statefulset.kubernetes.io/pod-name': podName,
      },
      spec: {
        containers,
        nodeName: `worker-${replica}`,
        restartPolicy: 'Always',
        serviceAccountName: 'alertmanager-main',
      },
      status: {
        phase: 'Running',
        podIP: `10.128.0.${40 + replica}`,
        hostIP: `10.0.${128 + replica}.10`,
        startTime: startedAt,
        conditions: [
          { type: 'Ready', status: 'True', lastTransitionTime: startedAt },
          { type: 'ContainersReady', status: 'True', lastTransitionTime: startedAt },
        ],
        containerStatuses: containers.map((container) =>
          runningContainerStatus(container, startedAt)
        ),
      },
    });
  }
}

/**
 * Seed the default monitoring stack into a ClusterState instance.
 * Called once from `ClusterState._initDefaults()` (after the project config).
 * @param {object} cluster ClusterState instance (must expose the `_seed` helper)
 * @returns {boolean} true when the monitoring baseline was installed
 */
export function seedMonitoringResources(cluster) {
  if (!cluster || typeof cluster.getByKind !== 'function') return false;
  if ((cluster.getByKind('Alertmanager') || []).some((entry) => entry.metadata?.name === 'main')) {
    return false;
  }
  try {
    seedPrometheusRules(cluster);
    seedAlertmanager(cluster);
    return true;
  } catch (error) {
    console.warn('MonitoringResources: failed to seed the monitoring stack', error);
    return false;
  }
}
