/**
 * IncidentDefs.js — OpenShift incident catalogue (EX280 conversion).
 *
 * Source of truth for the incident engine/panel and for campaign/challenge
 * content authors. The `name` values are EXACT and part of the integration
 * contract (CONVERSION-SPEC.md §8) — campaign/challenge definitions reference
 * them by name, and IncidentEngine cascade rules key on them. Do not rename
 * without coordinating the Lead + campaign-dev.
 *
 * Reference docs for this content (OCP 4.22, accessed 2026-11-03):
 *   - Troubleshooting / pod error states:
 *     https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/support/troubleshooting
 *   - Routes:  …/4.22/html/ingress_and_load_balancing/routes
 *   - Network policy / OVN: …/4.22/html-single/network_security/index
 *   - SCC, RBAC, identity, pods: …/4.22/html-single/authentication_and_authorization/index
 *   - Builds / ImageStreams: …/4.22/html/building_applications/index
 *   - Quotas / LimitRanges: …/4.22/html/building_applications/index + …/4.22/html/nodes/index
 *   - Operator install failures: …/4.22/html/operators/index
 *   - MetalLB: …/4.22/html/ingress_and_load_balancing/load-balancing-with-metallb
 *
 * Schema per incident:
 *   {
 *     id, name, category, severity (1..5), description, visualEffect,
 *     affectedResourceTypes: [registry kinds],
 *     investigationSteps: [{ command, hint }],     // 2-4 real `oc` commands
 *     resolutionActions: [{ action, label, difficulty }],  // 2-3 options
 *     ocCommands: [string],                        // display-only command list
 *     autoResolveTime: null | seconds,
 *     docsUrl: string,
 *     resolution: {                                // consumed by IncidentEngine
 *       kind: 'pod'|'deployment'|'node'|'route'|'service'|'build'|'buildconfig'|
 *             'imagestream'|'imagestreamtag'|'networkpolicy'|'configmap'|'secret'|
 *             'quota'|'limitrange'|'clusterquota'|'cronjob'|'job'|'hpa'|'pvc'|
 *             'operator'|'clusteroperator'|'ingress'|'oauth'|'serviceaccount'|
 *             'rbac'|'cluster'|'dns',
 *       effect: 'heal'|'restore'|'clear'|'admit'|'complete'|'ready'|'unsuspend'|
 *               'allow'|'rotate'|'bound'|'install'|'assign-ip'|'reschedule'|'unstick',
 *       targetKind,        // registry kind to find the target resource by
 *       ...options         // effect-specific hints used by the engine
 *     }
 *   }
 *
 * Placeholder tokens in investigationSteps: <pod> <deployment> <node> <service>
 * <route> <build> <buildconfig> <imagestream> <imagestreamtag> <configmap>
 * <secret> <networkpolicy> <ingress> <pvc> <pv> <job> <cronjob> <hpa> <quota>
 * <limitrange> <clusterquota> <subscription> <user> <group> <serviceaccount>
 * <scc> <namespace>. The panel substitutes <namespace> with the current
 * project, <pod> with the concrete damaged Pod, and every other token with the
 * incident target name.
 *
 * Optional `logs: { container, current: [line], previous: [line] }` supplies the
 * per-Pod container output that IncidentEngine writes onto damaged Pods so
 * `oc logs` / `oc logs --previous` show the real crash reason instead of a
 * generic synthetic log. Tokens substituted from the live Pod:
 * <pod> <deployment> <image> <namespace>.
 */

// ─── Documentation links (OCP 4.22, verified 2026-11-03) ───────────────────
const DOCS = {
  pod: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index',
  troubleshoot:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/support/troubleshooting',
  route:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes',
  ingress:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/configuring-ingress-cluster-traffic',
  network:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html-single/network_security/index',
  scc: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html-single/authentication_and_authorization/index',
  identity:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/configuring-identity-providers',
  build:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index',
  quota:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index',
  nodes:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index',
  storage:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/storage/index',
  operator:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/index',
  metallb:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/load-balancing-with-metallb',
};

// ─── Category taxonomy (spec §8: Pod / Network / Security / Build / Cluster / Storage / Identity) ──
const INCIDENT_CATEGORIES = {
  Pod: { label: 'Pod & Workload', color: '#ef4444', weight: 3, icon: '\u26a0' },
  Network: { label: 'Network', color: '#eab308', weight: 2, icon: '\u{1f310}' },
  Security: { label: 'Security', color: '#f97316', weight: 2, icon: '\u{1f6e1}' },
  Build: { label: 'Build & Images', color: '#8b5cf6', weight: 1, icon: '\u{1f527}' },
  Cluster: { label: 'Cluster & Quota', color: '#dc2626', weight: 1, icon: '\u{1f5a5}' },
  Storage: { label: 'Storage', color: '#8b5cf6', weight: 1, icon: '\u{1f4be}' },
  Identity: { label: 'Identity & Access', color: '#06b6d4', weight: 1, icon: '\u{1f464}' },
};

// ─── Severity levels (consumed by IncidentEngine XP + IncidentPanel styling) ──
const SEVERITY_LEVELS = [
  { level: 1, name: 'Low', color: '#22c55e', xpReward: 25, timeMultiplier: 1.5 },
  { level: 2, name: 'Medium', color: '#eab308', xpReward: 50, timeMultiplier: 1.2 },
  { level: 3, name: 'High', color: '#f97316', xpReward: 100, timeMultiplier: 1.0 },
  { level: 4, name: 'Critical', color: '#ef4444', xpReward: 200, timeMultiplier: 0.8 },
  { level: 5, name: 'Emergency', color: '#dc2626', xpReward: 350, timeMultiplier: 0.6 },
];

/** Compact step helper: `S('oc describe pod <pod>', 'look at Events')`. */
const S = (command, hint) => ({ command, hint });
/** Compact resolution-action helper. */
const A = (action, label, difficulty = 1) => ({ action, label, difficulty });

// ─── The catalogue ─────────────────────────────────────────────────────────
const INCIDENT_DEFS = [
  // ══════════════════════════════ POD / WORKLOAD ══════════════════════════════
  {
    id: 'crash-loop-backoff',
    name: 'CrashLoopBackOff',
    category: 'Pod',
    severity: 3,
    description:
      'A container keeps exiting and kubelet is backing off restart attempts. The Pod alternates between Running with restarts and CrashLoopBackOff.',
    visualEffect: 'pulse-red',
    affectedResourceTypes: ['Pod', 'Deployment'],
    investigationSteps: [
      S(
        'oc logs <pod> --previous',
        'Read the previous container instance — the actual crash reason is in the last run.'
      ),
      S(
        'oc describe pod <pod>',
        'Check Last State / Restart Count and the Events section (Back-off restarting failed container).'
      ),
      S(
        'oc get pods -l app=<deployment> -o wide',
        'List every replica of the owning workload; <pod> is one of these Pods.'
      ),
      S(
        'oc get events --field-selector involvedObject.name=<pod>',
        'Correlate the failure with recent cluster events.'
      ),
    ],
    resolutionActions: [
      A('fix-image', 'Correct the image tag / command', 1),
      A('fix-command', 'Fix the container entrypoint', 2),
      A('fix-resources', 'Adjust CPU/memory limits', 1),
    ],
    ocCommands: [
      'oc logs <pod> --previous',
      'oc describe pod <pod>',
      'oc get pods -l app=<deployment>',
      'oc edit deployment/<deployment>',
      'oc rollout status deployment/<deployment>',
    ],
    // Per-Pod crash output rendered by `oc logs` (current) / `oc logs --previous`.
    // Tokens: <pod> <deployment> <image> <namespace> — substituted from the live Pod.
    logs: {
      container: 'main',
      current: [
        'Starting application...',
        'FATAL: <deployment> failed to start: configuration for image <image> is invalid',
        'Error: required configuration key is missing or unreadable',
        'Process exited with status 1',
      ],
      previous: [
        'Starting application...',
        'FATAL: <deployment> cannot start with image <image>: invalid configuration (exit code 1)',
        'Error: configuration validation failed: APP_MODE has an unsupported value',
        'Process exited with status 1',
      ],
    },
    autoResolveTime: null,
    docsUrl: DOCS.troubleshoot,
    resolution: { kind: 'pod', effect: 'heal', targetKind: 'Pod', restart: true },
  },
  {
    id: 'image-pull-backoff',
    name: 'ImagePullBackOff',
    category: 'Pod',
    severity: 2,
    description:
      'The image cannot be pulled: wrong image reference, missing image pull secret, or the internal registry is unreachable.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Pod', 'Deployment'],
    investigationSteps: [
      S(
        'oc describe pod <pod>',
        'Events show ErrImagePull/ImagePullBackOff with the exact registry error.'
      ),
      S(
        'oc get pod <pod> -o jsonpath={.spec.containers[*].image}',
        'Verify the image reference and tag.'
      ),
      S(
        'oc get pods -l app=<deployment> -o wide',
        'Check whether every replica of the workload is failing to pull the same image.'
      ),
      S(
        'oc get sa <serviceaccount> -o yaml',
        'Check imagePullSecrets on the ServiceAccount (internal registry auth).'
      ),
    ],
    resolutionActions: [
      A('fix-image-ref', 'Correct image name/tag', 1),
      A('fix-pull-secret', 'Fix the image pull secret', 2),
    ],
    ocCommands: [
      'oc describe pod <pod>',
      'oc get pod <pod> -o yaml',
      'oc get secrets -n <namespace>',
      'oc secrets link default my-pull-secret --for=pull',
    ],
    logs: {
      container: 'main',
      current: ['Error from server: image <image> is not available'],
      previous: [
        'Error from server: image <image> is not available',
        'manifest unknown: manifest tagged by "latest" is not found',
      ],
    },
    autoResolveTime: null,
    docsUrl: DOCS.pod,
    resolution: { kind: 'pod', effect: 'heal', targetKind: 'Pod', pullSecret: true },
  },
  {
    id: 'oom-killed',
    name: 'OOMKilled',
    category: 'Pod',
    severity: 3,
    description:
      'A container exceeded its memory limit and was OOM-killed. Last State shows OOMKilled with exit code 137.',
    visualEffect: 'flash-red',
    affectedResourceTypes: ['Pod', 'Deployment'],
    investigationSteps: [
      S(
        'oc describe pod <pod>',
        'Look for "Last State: Terminated, Reason: OOMKilled" and the memory limit.'
      ),
      S('oc adm top pod <pod>', 'Compare live memory usage with the configured limit.'),
      S(
        'oc get pod <pod> -o jsonpath={.spec.containers[*].resources}',
        'Review requests/limits to right-size the container.'
      ),
    ],
    resolutionActions: [
      A('increase-memory', 'Increase the memory limit', 1),
      A('fix-memory-leak', 'Fix the application memory leak', 3),
      A('add-hpa', 'Add an HPA to scale horizontally', 2),
    ],
    ocCommands: [
      'oc describe pod <pod>',
      'oc adm top pod <pod>',
      'oc set resources deployment/<deployment> --limits=memory=512Mi',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.pod,
    resolution: { kind: 'pod', effect: 'heal', targetKind: 'Pod', memory: 'bump' },
  },
  {
    id: 'scc-forbidden',
    name: 'SCCForbidden',
    category: 'Security',
    severity: 4,
    description:
      'Pod admission failed: no security context constraint allows the requested securityContext. The API returns "unable to validate against any security context constraint".',
    visualEffect: 'pulse-red',
    affectedResourceTypes: ['Pod', 'Deployment', 'ServiceAccount'],
    investigationSteps: [
      S(
        'oc describe pod <pod>',
        'The Events section shows "unable to validate against any security context constraint" and which SCCs rejected the Pod.'
      ),
      S(
        'oc get sa -n <namespace> -o name',
        'List the project ServiceAccounts — a dedicated SA is a better identity than default for privileged workloads.'
      ),
      S(
        'oc adm policy who-can use scc privileged',
        'Check which subjects may use the SCC; on 4.x the grant is an RBAC binding, not an SCC users entry.'
      ),
      S(
        'oc get rolebinding -n <namespace>',
        'The 4.x grant is a RoleBinding in the project to ClusterRole system:openshift:scc:privileged.'
      ),
    ],
    resolutionActions: [
      A('grant-scc', 'Grant a permissive SCC to the ServiceAccount', 1),
      A('adjust-security-context', 'Remove the privileged/UID request', 2),
    ],
    ocCommands: [
      'oc describe pod <pod>',
      'oc get sa -n <namespace>',
      'oc adm policy add-scc-to-user privileged -z <serviceaccount> -n <namespace>',
      'oc get rolebinding -n <namespace>',
      'oc auth can-i use scc/privileged --as=system:serviceaccount:<namespace>:<serviceaccount>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.scc,
    resolution: { kind: 'pod', effect: 'heal', targetKind: 'Pod', grantScc: 'privileged' },
  },
  {
    id: 'pending-scheduling',
    name: 'PendingScheduling',
    category: 'Pod',
    severity: 3,
    description:
      'The Pod cannot be scheduled: no node matches its nodeSelector/affinity, nodes are tainted, or there is not enough allocatable CPU/memory.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Pod', 'Deployment'],
    investigationSteps: [
      S(
        'oc describe pod <pod>',
        'The Events/Scheduler section explains why no node fits (FailedScheduling).'
      ),
      S('oc get nodes', 'Check Ready state and labels of candidate nodes.'),
      S('oc describe node <node>', 'Inspect taints, conditions and allocatable resources.'),
      S('oc get resourcequota -n <namespace>', 'A quota can also prevent pod creation/admission.'),
    ],
    resolutionActions: [
      A('fix-node-selector', 'Fix nodeSelector/affinity', 1),
      A('add-capacity', 'Scale nodes or reduce requests', 2),
      A('remove-taint', 'Tolerate or remove the node taint', 2),
    ],
    ocCommands: [
      'oc describe pod <pod>',
      'oc get nodes',
      'oc adm top node <node>',
      'oc label node <node> region=east',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.nodes,
    resolution: { kind: 'pod', effect: 'reschedule', targetKind: 'Pod' },
  },
  {
    id: 'create-container-config-error',
    name: 'CreateContainerConfigError',
    category: 'Pod',
    severity: 3,
    description:
      'The container cannot start because a referenced ConfigMap or Secret (volume or envFrom) is missing or lacks the required key.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Pod', 'Deployment'],
    investigationSteps: [
      S('oc describe pod <pod>', 'Events name the missing ConfigMap/Secret or key.'),
      S(
        'oc get configmap <configmap> -n <namespace>',
        'Confirm the ConfigMap referenced by the workload exists.'
      ),
      S(
        'oc get secret <secret> -n <namespace>',
        'Confirm the Secret exists and has the expected keys.'
      ),
      S(
        'oc get deployment <deployment> -o yaml',
        'Check envFrom/volumes references in the pod template.'
      ),
    ],
    resolutionActions: [
      A('create-configmap', 'Create the missing ConfigMap', 1),
      A('create-secret', 'Create the missing Secret', 1),
      A('fix-reference', 'Correct the reference name/key', 1),
    ],
    ocCommands: [
      'oc describe pod <pod>',
      'oc get configmap <configmap>',
      'oc get secret <secret>',
      'oc set env deployment/<deployment> --from=configmap/<configmap>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.pod,
    resolution: { kind: 'pod', effect: 'restore', targetKind: 'Pod', restoreRefs: true },
  },
  {
    id: 'readiness-probe-failure',
    name: 'ReadinessProbeFailure',
    category: 'Pod',
    severity: 2,
    description:
      'The readiness probe is failing; the Pod is removed from Service endpoints and traffic stops reaching it.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Pod', 'Deployment'],
    investigationSteps: [
      S('oc describe pod <pod>', 'Events show "Readiness probe failed" plus the probe URL/port.'),
      S('oc logs <pod>', 'Application logs usually explain why /readyz is failing.'),
      S(
        'oc get endpoints <service> -n <namespace>',
        'A NotReady Pod no longer appears in the Service endpoints.'
      ),
    ],
    resolutionActions: [
      A('fix-probe-path', 'Correct the readiness probe path', 1),
      A('fix-probe-port', 'Fix the probe port', 1),
      A('increase-delay', 'Increase initialDelaySeconds', 1),
    ],
    ocCommands: [
      'oc describe pod <pod>',
      'oc get endpoints <service>',
      'oc set probe deployment/<deployment> --readiness --get-url=http://:8080/readyz',
    ],
    autoResolveTime: 90,
    docsUrl: DOCS.pod,
    resolution: { kind: 'pod', effect: 'heal', targetKind: 'Pod', probe: 'readiness' },
  },
  {
    id: 'liveness-probe-failure',
    name: 'LivenessProbeFailure',
    category: 'Pod',
    severity: 3,
    description:
      'The liveness probe fails and kubelet keeps restarting the container; restart count climbs and the app flaps.',
    visualEffect: 'pulse-red',
    affectedResourceTypes: ['Pod', 'Deployment'],
    investigationSteps: [
      S('oc describe pod <pod>', 'Events show "Liveness probe failed" and the restart count.'),
      S(
        'oc logs <pod> --previous',
        'Check the logs from the previous (restarted) container instance.'
      ),
      S(
        'oc get deployment <deployment> -o yaml',
        'Review livenessProbe initialDelaySeconds/timeoutSeconds/periodSeconds.'
      ),
    ],
    resolutionActions: [
      A('fix-probe-config', 'Fix the liveness probe configuration', 1),
      A('increase-timeout', 'Increase timeout/failureThreshold', 1),
      A('fix-app-health', 'Make the app health endpoint respond', 2),
    ],
    ocCommands: [
      'oc describe pod <pod>',
      'oc logs <pod> --previous',
      'oc set probe deployment/<deployment> --liveness --get-url=http://:8080/healthz',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.pod,
    resolution: { kind: 'pod', effect: 'heal', targetKind: 'Pod', probe: 'liveness' },
  },
  {
    id: 'pod-stuck-terminating',
    name: 'PodStuckTerminating',
    category: 'Pod',
    severity: 2,
    description:
      'The Pod is stuck in Terminating because a finalizer is not being removed, so it blocks rollout/deletion.',
    visualEffect: 'blink-gray',
    affectedResourceTypes: ['Pod'],
    investigationSteps: [
      S('oc get pod <pod>', 'STATUS stays Terminating for minutes.'),
      S('oc describe pod <pod>', 'Check the Finalizers and Deletion Grace Period fields.'),
      S('oc get pod <pod> -o jsonpath={.metadata.finalizers}', 'List the blocking finalizers.'),
    ],
    resolutionActions: [
      A('force-delete', 'Force delete the Pod', 1),
      A('remove-finalizer', 'Remove the blocking finalizer', 2),
    ],
    ocCommands: [
      'oc get pod <pod>',
      'oc describe pod <pod>',
      'oc delete pod <pod> --grace-period=0 --force',
    ],
    autoResolveTime: 120,
    docsUrl: DOCS.pod,
    resolution: { kind: 'pod', effect: 'clear', targetKind: 'Pod', deletePod: true },
  },
  {
    id: 'deployment-stuck-rollout',
    name: 'DeploymentStuckRollout',
    category: 'Pod',
    severity: 3,
    description:
      'A rolling update never completes: the new ReplicaSet cannot become ready and the Deployment reports ProgressDeadlineExceeded.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Deployment', 'ReplicaSet'],
    investigationSteps: [
      S(
        'oc rollout status deployment/<deployment>',
        'Confirms the rollout is stuck ("waiting for rollout to finish").'
      ),
      S(
        'oc describe deployment <deployment>',
        'Condition Progressing=False reason ProgressDeadlineExceeded.'
      ),
      S(
        'oc get rs -n <namespace>',
        'Old and new ReplicaSets both present — new one has no Ready pods.'
      ),
      S(
        'oc get pods -n <namespace>',
        'Inspect the new pods: image pull, crash loop, probes or quota.'
      ),
    ],
    resolutionActions: [
      A('fix-template', 'Fix the new pod template', 2),
      A('rollback', 'Roll back with oc rollout undo', 1),
      A('fix-resources', 'Fix resources/quota on the new pods', 1),
    ],
    ocCommands: [
      'oc rollout status deployment/<deployment>',
      'oc describe deployment <deployment>',
      'oc rollout undo deployment/<deployment>',
      'oc get rs',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.build,
    resolution: { kind: 'deployment', effect: 'unstick', targetKind: 'Deployment' },
  },
  {
    id: 'image-stream-tag-missing',
    name: 'ImageStreamTagMissing',
    category: 'Build',
    severity: 2,
    description:
      'A Deployment references an ImageStreamTag that does not exist in the project (never imported / build never pushed it).',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['ImageStream', 'Deployment'],
    investigationSteps: [
      S('oc get istag -n <namespace>', 'List ImageStreamTags in the project.'),
      S(
        'oc describe imagestream <imagestream> -n <namespace>',
        'Check which tags the ImageStream actually tracks.'
      ),
      S(
        'oc get events -n <namespace>',
        'Look for FailedCreate/ErrImagePull referencing the missing tag.'
      ),
    ],
    resolutionActions: [
      A('import-tag', 'Import the tag with oc import-image', 1),
      A('trigger-build', 'Run the build that produces the tag', 2),
      A('fix-deployment-image', 'Point the Deployment at an existing tag', 1),
    ],
    ocCommands: [
      'oc get imagestream <imagestream> -o yaml',
      'oc get imagestreamtag <imagestreamtag>',
      'oc import-image <imagestream> --from=... --confirm',
      'oc start-build <buildconfig>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.build,
    resolution: {
      kind: 'imagestreamtag',
      effect: 'restore',
      targetKind: 'ImageStream',
      tag: 'latest',
    },
  },
  {
    id: 'build-failed',
    name: 'BuildFailed',
    category: 'Build',
    severity: 3,
    description:
      'A Source-to-Image build failed and never pushed an image to the ImageStream, so the Deployment cannot roll out.',
    visualEffect: 'flash-red',
    affectedResourceTypes: ['Build', 'BuildConfig'],
    investigationSteps: [
      S('oc get builds -n <namespace>', 'Find the failed Build and its STATUS.'),
      S(
        'oc logs -f build/<build> -n <namespace>',
        'Read the build log: source clone, builder image or Dockerfile error.'
      ),
      S('oc describe build <build>', 'Status.Reason/Message and the output ImageStreamTag.'),
      S(
        'oc describe buildconfig <buildconfig>',
        'Check source, strategy and output configuration.'
      ),
    ],
    resolutionActions: [
      A('fix-source', 'Fix the source repo/context', 2),
      A('fix-builder', 'Fix the builder image/strategy', 2),
      A('retry-build', 'Start a new build', 1),
    ],
    ocCommands: [
      'oc get builds',
      'oc logs -f build/<build>',
      'oc describe build <build>',
      'oc start-build <buildconfig> --follow',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.build,
    resolution: {
      kind: 'build',
      effect: 'complete',
      targetKind: 'Build',
      imageStream: '<buildconfig>',
    },
  },
  {
    id: 'hpa-unable-to-scale',
    name: 'HPAUnableToScale',
    category: 'Pod',
    severity: 2,
    description:
      'The HorizontalPodAutoscaler cannot compute a scale decision (missing metrics server / bad metrics) and reports AbleToScale=False.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['HorizontalPodAutoscaler', 'Deployment'],
    investigationSteps: [
      S('oc describe hpa <hpa>', 'Conditions show AbleToScale=False / FailedGetResourceMetric.'),
      S('oc get hpa <hpa>', 'TARGETS may show <unknown>/70%.'),
      S('oc adm top pods -n <namespace>', 'Check whether pod metrics are available at all.'),
      S(
        'oc get deployment <deployment>',
        'Confirm the scaleTargetRef points at an existing Deployment.'
      ),
    ],
    resolutionActions: [
      A('fix-metrics', 'Restore metrics availability', 2),
      A('fix-target', 'Fix HPA scaleTargetRef', 1),
      A('set-resources', 'Set requests so utilization can be computed', 1),
    ],
    ocCommands: ['oc describe hpa <hpa>', 'oc adm top pods', 'oc get hpa <hpa> -o yaml'],
    autoResolveTime: 120,
    docsUrl: DOCS.pod,
    resolution: { kind: 'hpa', effect: 'heal', targetKind: 'HorizontalPodAutoscaler' },
  },
  {
    id: 'job-deadline-exceeded',
    name: 'JobDeadlineExceeded',
    category: 'Pod',
    severity: 2,
    description:
      'A Job exceeded its activeDeadlineSeconds and was marked Failed; its Pods were terminated before completing.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Job', 'Pod'],
    investigationSteps: [
      S('oc get job <job> -n <namespace>', 'STATUS shows Failed with reason DeadlineExceeded.'),
      S('oc describe job <job>', 'Read the Job conditions and the activeDeadlineSeconds value.'),
      S('oc logs job/<job> -n <namespace>', 'Why the job did not finish in time.'),
      S(
        'oc get pods -n <namespace> -l job-name=<job>',
        'The Pods were terminated; a Failed Job object cannot be resumed.'
      ),
    ],
    resolutionActions: [
      A('raise-deadline', 'Create a replacement Job with a longer activeDeadlineSeconds', 1),
      A('fix-command', 'Fix the job command', 2),
      A('recreate', 'Delete and recreate the Job', 1),
    ],
    ocCommands: [
      'oc get job <job>',
      'oc describe job <job>',
      'oc logs job/<job>',
      'oc delete job <job>',
      'oc create job <job> --image=perl -- perl -e "print 42"',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.pod,
    resolution: { kind: 'job', effect: 'complete', targetKind: 'Job' },
  },
  {
    id: 'cronjob-missed-schedule',
    name: 'CronJobMissedSchedule',
    category: 'Pod',
    severity: 1,
    description:
      'A CronJob missed its schedule (it is suspended, or its schedule/window means no run is due) and no new Jobs are being created.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['CronJob', 'Job'],
    investigationSteps: [
      S('oc get cronjob <cronjob> -n <namespace>', 'Check SUSPEND column and LAST SCHEDULE age.'),
      S('oc describe cronjob <cronjob>', 'Check schedule expression and recent events.'),
      S('oc get jobs -n <namespace>', 'Confirm whether recent Jobs were created.'),
    ],
    resolutionActions: [
      A('unsuspend', 'Set suspend: false', 1),
      A('fix-schedule', 'Fix the cron expression', 1),
    ],
    ocCommands: [
      'oc get cronjob <cronjob>',
      'oc describe cronjob <cronjob>',
      'oc patch cronjob <cronjob> -p \'{"spec":{"suspend":false}}\'',
    ],
    autoResolveTime: 120,
    docsUrl: DOCS.pod,
    resolution: { kind: 'cronjob', effect: 'unsuspend', targetKind: 'CronJob' },
  },
  {
    id: 'pvc-pending',
    name: 'PVCPending',
    category: 'Storage',
    severity: 3,
    description:
      'A PersistentVolumeClaim stays Pending because no PV matches (size/accessModes/storageClassName) or dynamic provisioning is unavailable.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['PersistentVolumeClaim', 'PersistentVolume'],
    investigationSteps: [
      S('oc get pvc <pvc> -n <namespace>', 'STATUS=Pending; check capacity/access mode/SC.'),
      S('oc describe pvc <pvc>', 'Events show "no persistent volumes available for this claim".'),
      S('oc get pv', 'Look for Available PVs with matching size/accessModes.'),
      S('oc get storageclass', 'Check the default StorageClass / dynamic provisioner.'),
    ],
    resolutionActions: [
      A('bind-volume', 'Create a matching PV', 2),
      A('fix-storageclass', 'Use a StorageClass that can provision', 1),
      A('resize-claim', 'Request a size a PV can satisfy', 1),
    ],
    ocCommands: ['oc get pvc', 'oc describe pvc <pvc>', 'oc get pv', 'oc get storageclass'],
    autoResolveTime: null,
    docsUrl: DOCS.storage,
    resolution: { kind: 'pvc', effect: 'bound', targetKind: 'PersistentVolumeClaim' },
  },
  {
    id: 'configmap-missing',
    name: 'ConfigMapMissing',
    category: 'Pod',
    severity: 3,
    description:
      'A workload references a ConfigMap that does not exist (or is missing a key), so containers cannot start and Pods report CreateContainerConfigError.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['ConfigMap', 'Pod', 'Deployment'],
    investigationSteps: [
      S('oc describe pod <pod>', 'Events say configmap "<name>" not found.'),
      S('oc get configmap <configmap> -n <namespace>', 'Confirm whether the object exists.'),
      S(
        'oc get deployment <deployment> -o yaml',
        'Find the envFrom/volume reference to the missing ConfigMap.'
      ),
    ],
    resolutionActions: [
      A('create-configmap', 'Create the missing ConfigMap', 1),
      A('fix-key', 'Add the missing key', 1),
      A('fix-reference', 'Fix the workload reference', 1),
    ],
    ocCommands: [
      'oc describe pod <pod>',
      'oc get configmap <configmap>',
      'oc create configmap <configmap> --from-literal=key=value',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.pod,
    resolution: { kind: 'configmap', effect: 'restore', targetKind: 'ConfigMap' },
  },
  {
    id: 'secret-missing',
    name: 'SecretMissing',
    category: 'Pod',
    severity: 3,
    description:
      'A workload references a Secret that does not exist (or lacks a key), blocking container creation and image pulls.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Secret', 'Pod', 'Deployment'],
    investigationSteps: [
      S('oc describe pod <pod>', 'Events name the missing Secret or key.'),
      S(
        'oc get secret <secret> -n <namespace>',
        'Confirm the Secret exists and has the expected keys.'
      ),
      S('oc get deployment <deployment> -o yaml', 'Check secretRef / volume references.'),
    ],
    resolutionActions: [
      A('create-secret', 'Create the missing Secret', 1),
      A('fix-key', 'Add the missing key', 1),
      A('fix-reference', 'Fix the workload reference', 1),
    ],
    ocCommands: [
      'oc describe pod <pod>',
      'oc get secret <secret>',
      'oc create secret generic <secret> --from-literal=password=change-me',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.scc,
    resolution: { kind: 'secret', effect: 'restore', targetKind: 'Secret' },
  },
  {
    id: 'secret-exposed',
    name: 'SecretExposed',
    category: 'Security',
    severity: 5,
    description:
      'Sensitive data leaked into a ConfigMap/Secret in a readable place (or a Secret was committed in plain text); credentials must be rotated.',
    visualEffect: 'flash-red',
    affectedResourceTypes: ['Secret', 'ConfigMap'],
    investigationSteps: [
      S(
        'oc get secret <secret> -n <namespace> -o yaml',
        'Inspect where the credential is stored and its type.'
      ),
      S(
        'oc get configmap <configmap> -n <namespace> -o yaml',
        'Sensitive values must not live in ConfigMaps.'
      ),
      S('oc get rolebindings -n <namespace>', 'Review who can read the Secret.'),
    ],
    resolutionActions: [
      A('rotate-secret', 'Rotate the credential', 2),
      A('move-to-secret', 'Move data from ConfigMap to Secret', 2),
      A('revoke-access', 'Remove excessive role bindings', 2),
    ],
    ocCommands: [
      'oc get secret <secret> -o yaml',
      'oc create secret generic <secret> --from-literal=password=$(openssl rand -hex 16) --dry-run=client -o yaml | oc replace -f -',
      'oc get rolebindings',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.scc,
    resolution: { kind: 'secret', effect: 'rotate', targetKind: 'Secret' },
  },

  // ══════════════════════════════ NETWORK ══════════════════════════════
  {
    id: 'service-no-endpoints',
    name: 'ServiceNoEndpoints',
    category: 'Network',
    severity: 3,
    description:
      'A Service has no ready endpoints: the selector matches no Pods, or the matching Pods are not Ready.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Service', 'Deployment'],
    investigationSteps: [
      S(
        'oc get endpoints <service> -n <namespace>',
        'ENDPOINTS is <none> when no Pod matches/is Ready.'
      ),
      S('oc describe service <service>', 'Compare spec.selector with the pods labels.'),
      S('oc get pods --show-labels -n <namespace>', 'Find Pods and their labels/readiness.'),
    ],
    resolutionActions: [
      A('fix-selector', 'Fix the Service selector', 1),
      A('fix-readiness', 'Make backing Pods Ready', 2),
    ],
    ocCommands: [
      'oc get endpoints <service>',
      'oc describe service <service>',
      'oc get pods --show-labels',
      'oc label pod <pod> app=<service>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.route,
    resolution: { kind: 'service', effect: 'restore', targetKind: 'Service' },
  },
  {
    id: 'route-not-admitted',
    name: 'RouteNotAdmitted',
    category: 'Network',
    severity: 3,
    description:
      'A Route was not admitted by the Ingress Controller (status.ingress[].conditions Admitted=False): a hostname claim conflict, shard/router mismatch or invalid TLS/config. Missing Service endpoints do not block admission — they only stop traffic from being served.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Route', 'Service'],
    investigationSteps: [
      S('oc get route <route> -n <namespace>', 'Check HOST/PORT, SERVICE and TERMINATION columns.'),
      S(
        'oc describe route <route>',
        'Status/conditions show whether an Ingress Controller admitted it.'
      ),
      S(
        'oc get route <route> -o jsonpath={.status.ingress[*].conditions}',
        'Inspect Admitted reason/message.'
      ),
      S(
        'oc get endpoints <service> -n <namespace>',
        'No endpoints means the admitted Route has no backend to serve traffic (a traffic failure, not an admission failure).'
      ),
    ],
    resolutionActions: [
      A('fix-endpoints', 'Restore Service endpoints', 2),
      A('fix-route-host', 'Fix the Route host/domain', 1),
      A('fix-router-shard', 'Fix the IngressController selector', 2),
    ],
    ocCommands: [
      'oc get route <route>',
      'oc describe route <route>',
      'oc get endpoints <service>',
      'oc get pods -n openshift-ingress',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.route,
    resolution: { kind: 'route', effect: 'admit', targetKind: 'Route' },
  },
  {
    id: 'route-tls-certificate-error',
    name: 'RouteTLSCertificateError',
    category: 'Network',
    severity: 4,
    description:
      'An edge/reencrypt Route serves a certificate that does not match its host (wrong CN/SAN, expired, or bad secret reference).',
    visualEffect: 'flash-red',
    affectedResourceTypes: ['Route', 'Secret'],
    investigationSteps: [
      S(
        'oc describe route <route>',
        'Check the TLS termination and certificate/key fields or secret reference.'
      ),
      S(
        'oc get route <route> -o jsonpath={.spec.tls}',
        'Inspect termination, certificate, key, caCertificate.'
      ),
      S(
        'oc get secret <secret> -n <namespace> -o yaml',
        'Verify the tls.crt/tls.key pair and its SANs.'
      ),
      S(
        'oc get secret <secret> -n <namespace> -o jsonpath={.data.tls\\.crt} | base64 -d | openssl x509 -noout -subject -ext subjectAltName',
        'Decode the TLS secret and inspect the certificate SANs the router serves.'
      ),
    ],
    resolutionActions: [
      A('renew-cert', 'Create a correct certificate and update the Route', 2),
      A('fix-secret-ref', 'Fix the TLS secret reference', 1),
    ],
    ocCommands: [
      'oc describe route <route>',
      'oc get route <route> -o jsonpath={.spec.tls}',
      'oc create secret tls <secret> --cert=tls.crt --key=tls.key',
      'oc create route edge <route> --service=<service> --cert=tls.crt --key=tls.key',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.route,
    resolution: { kind: 'route', effect: 'restore-tls', targetKind: 'Route' },
  },
  {
    id: 'route-host-conflict',
    name: 'RouteHostConflict',
    category: 'Network',
    severity: 3,
    description:
      'Two routes claim the same hostname. With the default Strict route admission only one namespace may own a host; the second Route is rejected.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Route'],
    investigationSteps: [
      S('oc get routes -A', 'Find another Route advertising the same HOST/PORT.'),
      S('oc describe route <route>', 'The status shows the conflicting host claim.'),
      S(
        'oc get ingresscontroller -n openshift-ingress-operator -o yaml',
        'Check spec.routeAdmission.namespaceOwnership (Strict vs InterNamespaceAllowed).'
      ),
    ],
    resolutionActions: [
      A('change-host', 'Give the Route a unique hostname', 1),
      A('allow-cross-namespace', 'Set InterNamespaceAllowed admission', 2),
    ],
    ocCommands: [
      'oc get routes -A',
      'oc describe route <route>',
      'oc patch route <route> -p \'{"spec":{"host":"<route>.apps.cluster.example.com"}}\'',
      'oc -n openshift-ingress-operator patch ingresscontroller/default --type=merge -p \'{"spec":{"routeAdmission":{"namespaceOwnership":"InterNamespaceAllowed"}}}\'',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.route,
    resolution: { kind: 'route', effect: 'restore-host', targetKind: 'Route' },
  },
  {
    id: 'network-policy-blocking',
    name: 'NetworkPolicyBlocking',
    category: 'Network',
    severity: 3,
    description:
      'A default-deny or overly narrow NetworkPolicy blocks required traffic, so Services time out even though Pods are healthy.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['NetworkPolicy', 'Service', 'Pod'],
    investigationSteps: [
      S(
        'oc get networkpolicy -n <namespace>',
        'List policies and the pod selector each one applies to.'
      ),
      S('oc describe networkpolicy <networkpolicy>', 'Check ingress/egress rules and ports.'),
      S('oc exec <pod> -- curl -sv <service>:8080', 'Reproduce the timeout from inside a Pod.'),
      S(
        'oc get events -n <namespace>',
        'Denied connections are usually not events — verify by policy inspection.'
      ),
    ],
    resolutionActions: [
      A('allow-traffic', 'Add an allow rule to the policy', 1),
      A('fix-selector', 'Fix the policy podSelector', 1),
      A('remove-policy', 'Delete the blocking policy', 2),
    ],
    ocCommands: [
      'oc get networkpolicy',
      'oc describe networkpolicy <networkpolicy>',
      'oc exec <pod> -- curl -sv <service>:8080',
      'oc edit networkpolicy <networkpolicy>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.network,
    resolution: { kind: 'networkpolicy', effect: 'allow', targetKind: 'NetworkPolicy' },
  },
  {
    id: 'dns-resolution-failure',
    name: 'DNSResolutionFailure',
    category: 'Network',
    severity: 4,
    description:
      'In-cluster DNS resolution is broken: a Pod cannot resolve Service names, usually because of DNS Pods being down or an egress policy that does not allow the DNS Pod port 5353.',
    visualEffect: 'flash-red',
    affectedResourceTypes: ['Service', 'Pod'],
    investigationSteps: [
      S(
        'oc exec <pod> -- nslookup <service>.<namespace>.svc.cluster.local',
        'Reproduce the resolution failure from a Pod using the full service DNS name.'
      ),
      S(
        'oc get pods -n openshift-dns',
        'Check that the DNS Pods (dns-default) are Running and Ready.'
      ),
      S(
        'oc get networkpolicy -n <namespace>',
        'On OpenShift the dns-default Pods listen on 5353; an egress rule that only allows port 53 still blocks them.'
      ),
      S('oc get endpoints <service> -n <namespace>', 'Confirm the Service itself has endpoints.'),
    ],
    resolutionActions: [
      A('allow-dns-egress', 'Allow DNS egress on port 5353 (the dns-default Pod port)', 1),
      A('restore-dns', 'Restore openshift-dns Pods', 2),
    ],
    ocCommands: [
      'oc exec <pod> -- nslookup <service>.<namespace>.svc.cluster.local',
      'oc get pods -n openshift-dns',
      'oc get networkpolicy',
      'oc get svc -n openshift-dns',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.network,
    resolution: {
      kind: 'cluster',
      effect: 'dns',
      targetKind: 'Service',
      namespace: 'openshift-dns',
    },
  },
  {
    id: 'ingress-degraded',
    name: 'IngressDegraded',
    category: 'Network',
    severity: 4,
    description:
      'The ingress ClusterOperator is Degraded or its router Pods are not ready, so multiple Routes stop working at once.',
    visualEffect: 'flash-red',
    affectedResourceTypes: ['Ingress', 'ClusterOperator'],
    investigationSteps: [
      S('oc get clusteroperators ingress', 'Check AVAILABLE/PROGRESSING/DEGRADED columns.'),
      S(
        'oc describe clusteroperator ingress',
        'Conditions and the reason/message for the degradation.'
      ),
      S('oc get pods -n openshift-ingress', 'Look for Pending/CrashLooping router Pods.'),
      S(
        'oc get ingresscontroller -n openshift-ingress-operator',
        'Verify replicas and nodePlacement.'
      ),
    ],
    resolutionActions: [
      A('restart-router', 'Restart / reschedule router Pods', 2),
      A('fix-node-placement', 'Fix router nodePlacement/tolerations', 2),
      A('revert-config', 'Revert a bad IngressController change', 2),
    ],
    ocCommands: [
      'oc get clusteroperators ingress',
      'oc describe clusteroperator ingress',
      'oc get pods -n openshift-ingress',
      'oc get ingresscontroller -n openshift-ingress-operator',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.ingress,
    resolution: { kind: 'clusteroperator', effect: 'ready', targetKind: 'ClusterOperator' },
  },
  {
    id: 'loadbalancer-pending',
    name: 'LoadBalancerPending',
    category: 'Network',
    severity: 2,
    description:
      'A Service of type LoadBalancer never receives an external IP: no MetalLB address pool/advertisement is configured or the operator is not installed.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['Service', 'IPAddressPool'],
    investigationSteps: [
      S('oc get service <service> -n <namespace>', 'EXTERNAL-IP stays <pending>.'),
      S('oc describe service <service>', 'Events show LoadBalancer provisioning failures.'),
      S('oc get ipaddresspool -n metallb-system', 'Check that an address pool exists for MetalLB.'),
      S(
        'oc get subscription -n metallb-system',
        'Verify the MetalLB operator is installed and Succeeded.'
      ),
    ],
    resolutionActions: [
      A('configure-pool', 'Create IPAddressPool + L2Advertisement', 2),
      A('install-metallb', 'Install the MetalLB operator', 2),
      A('use-nodeport', 'Switch the Service to NodePort', 1),
    ],
    ocCommands: [
      'oc get service <service>',
      'oc get ipaddresspool -n metallb-system',
      'oc get subscription -n metallb-system',
      'oc get events -n <namespace>',
    ],
    autoResolveTime: 60,
    docsUrl: DOCS.metallb,
    resolution: { kind: 'service', effect: 'assign-ip', targetKind: 'Service' },
  },

  // ═══════════════════════ SECURITY / IDENTITY / CLUSTER ═══════════════════════
  {
    id: 'unauthorized-access',
    name: 'UnauthorizedAccess',
    category: 'Security',
    severity: 4,
    description:
      'An application/ServiceAccount is denied by RBAC when calling the Kubernetes API (403 Forbidden), or a user lost access to a project.',
    visualEffect: 'flash-red',
    affectedResourceTypes: ['Deployment', 'Pod', 'ServiceAccount', 'RoleBinding'],
    investigationSteps: [
      S(
        'oc auth can-i get pods --as=system:serviceaccount:<namespace>:default',
        'Prove whether the workload ServiceAccount (usually default) is allowed.'
      ),
      S(
        'oc get rolebindings -n <namespace>',
        'Check which RoleBindings exist in the project; the required binding is missing.'
      ),
      S(
        'oc get sa -n <namespace>',
        'Confirm the ServiceAccount identity the workload Pods run as.'
      ),
      S('oc get events -n <namespace>', 'Look for 403 Forbidden responses from the API.'),
    ],
    resolutionActions: [
      A('add-rolebinding', 'Bind a role to the ServiceAccount/user', 2),
      A('fix-sa', 'Point the workload at the right ServiceAccount', 1),
    ],
    ocCommands: [
      'oc auth can-i get pods --as=system:serviceaccount:<namespace>:default',
      'oc get rolebindings -n <namespace>',
      'oc adm policy add-role-to-user view -z default -n <namespace>',
      'oc get events -n <namespace>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.scc,
    resolution: {
      kind: 'rbac',
      effect: 'restore',
      targetKind: 'RoleBinding',
      scc: 'restricted-v2',
    },
  },
  {
    id: 'htpasswd-auth-failure',
    name: 'HTPasswdAuthFailure',
    category: 'Identity',
    severity: 4,
    description:
      'HTPasswd authentication is failing: the htpass-secret/OAuth provider is misconfigured or the authentication operator is not ready, so oc login is rejected.',
    visualEffect: 'flash-red',
    affectedResourceTypes: ['OAuth', 'User', 'Identity'],
    investigationSteps: [
      S(
        'oc get oauth cluster -o yaml',
        'Verify the identityProviders entry type HTPasswd and fileData.name.'
      ),
      S(
        'oc get secret htpass-secret -n openshift-config -o jsonpath={.data.htpasswd}',
        'The secret must exist and contain the htpasswd key.'
      ),
      S('oc get pods -n openshift-authentication', 'Check that the OAuth server Pods are Running.'),
      S('oc get users', 'Check that User/Identity objects exist for the account.'),
    ],
    resolutionActions: [
      A('fix-htpasswd-secret', 'Recreate the htpasswd Secret', 1),
      A('fix-oauth', 'Fix the OAuth identity provider', 2),
      A('restart-oauth', 'Wait for/restart the OAuth rollout', 1),
    ],
    ocCommands: [
      'oc get oauth cluster -o yaml',
      'oc get secret htpass-secret -n openshift-config -o yaml',
      'oc get pods -n openshift-authentication',
      'oc get clusteroperator authentication',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.identity,
    resolution: { kind: 'oauth', effect: 'ready', targetKind: 'OAuth' },
  },
  {
    id: 'resource-quota-exceeded',
    name: 'ResourceQuotaExceeded',
    category: 'Cluster',
    severity: 3,
    description:
      'A project ResourceQuota is exhausted: new Pods are rejected with "exceeded quota" and Deployments report FailedCreate.',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['ResourceQuota', 'Pod', 'Deployment'],
    investigationSteps: [
      S('oc describe quota <quota> -n <namespace>', 'Compare Used vs Hard for cpu/memory/pods.'),
      S('oc get quota <quota> -o yaml', 'Check hard limits and scopes.'),
      S('oc describe deployment <deployment>', 'FailedCreate events name the exceeded quota.'),
      S(
        'oc events -n <namespace> --types=Warning',
        'Recent admission/quota failures (the events subcommand accepts --types; oc get events does not).'
      ),
    ],
    resolutionActions: [
      A('raise-quota', 'Increase the quota hard limits', 1),
      A('reduce-requests', 'Right-size requests/limits', 1),
      A('delete-workloads', 'Remove unused workloads', 2),
    ],
    ocCommands: [
      'oc describe quota',
      'oc get quota -o yaml',
      'oc edit resourcequota <quota>',
      'oc events --types=Warning',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.quota,
    resolution: { kind: 'quota', effect: 'clear', targetKind: 'ResourceQuota' },
  },
  {
    id: 'limitrange-violation',
    name: 'LimitRangeViolation',
    category: 'Cluster',
    severity: 3,
    description:
      'A Pod is rejected because its container requests/limits violate the project LimitRange (min/max/maxLimitRequestRatio).',
    visualEffect: 'pulse-yellow',
    affectedResourceTypes: ['LimitRange', 'Pod', 'Deployment'],
    investigationSteps: [
      S(
        'oc describe limitrange <limitrange> -n <namespace>',
        'Read min/max/default/defaultRequest/ratio.'
      ),
      S('oc get limitrange <limitrange> -o yaml', 'Exact LimitRange spec.'),
      S(
        'oc describe pod <pod>',
        'Events show "minimum cpu usage per Container is ..." or max violation.'
      ),
      S(
        'oc get deployment <deployment> -o yaml',
        'Compare the pod template resources with the LimitRange.'
      ),
    ],
    resolutionActions: [
      A('adjust-resources', 'Set requests/limits inside the allowed range', 1),
      A('raise-limitrange', 'Update the LimitRange bounds', 2),
    ],
    ocCommands: [
      'oc describe limitrange',
      'oc get limitrange -o yaml',
      'oc describe pod <pod>',
      'oc set resources deployment/<deployment> --requests=cpu=100m,memory=128Mi',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.quota,
    resolution: { kind: 'limitrange', effect: 'clear', targetKind: 'LimitRange' },
  },
  {
    id: 'cluster-resource-quota-exceeded',
    name: 'ClusterResourceQuotaExceeded',
    category: 'Cluster',
    severity: 4,
    description:
      'A ClusterResourceQuota shared across projects is exhausted, so workloads in every selected project start failing admission.',
    visualEffect: 'pulse-red',
    affectedResourceTypes: ['ClusterResourceQuota', 'Pod'],
    investigationSteps: [
      S('oc get clusterresourcequota', 'Find the CRQ and its selector.'),
      S('oc describe clusterresourcequota <clusterquota>', 'Per-namespace and total Used vs Hard.'),
      S(
        'oc get appliedclusterresourcequota -n <namespace>',
        'The quota view from the project perspective.'
      ),
      S(
        'oc describe quota -n <namespace>',
        'Check whether a project ResourceQuota is also involved.'
      ),
    ],
    resolutionActions: [
      A('raise-crq', 'Raise the ClusterResourceQuota limits', 1),
      A('cleanup-workloads', 'Scale down workloads in other projects', 2),
      A('fix-selector', 'Fix the CRQ project selector', 2),
    ],
    ocCommands: [
      'oc get clusterresourcequota',
      'oc describe clusterresourcequota <clusterquota>',
      'oc get appliedclusterresourcequota',
      'oc edit clusterresourcequota <clusterquota>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.quota,
    resolution: { kind: 'clusterquota', effect: 'clear', targetKind: 'ClusterResourceQuota' },
  },
  {
    id: 'node-not-ready',
    name: 'NodeNotReady',
    category: 'Cluster',
    severity: 5,
    description:
      'A Node is NotReady (kubelet down/unreachable); workloads are rescheduled elsewhere and cluster capacity drops.',
    visualEffect: 'pulse-red',
    affectedResourceTypes: ['Node', 'Pod'],
    investigationSteps: [
      S('oc get nodes', 'Check STATUS=NotReady / scheduling disabled.'),
      S('oc describe node <node>', 'Conditions show why (KubeletNotReady, NetworkUnavailable...).'),
      S('oc get pods -A --field-selector spec.nodeName=<node>', 'Pods on the failed node.'),
      S('oc adm top node <node>', 'Check resource pressure on the node.'),
    ],
    resolutionActions: [
      A('uncordon-node', 'Bring the Node back and uncordon it', 2),
      A('fix-kubelet', 'Restart kubelet / fix node config', 3),
      A('drain-node', 'Drain and replace the Node', 2),
    ],
    ocCommands: [
      'oc get nodes',
      'oc describe node <node>',
      'oc adm uncordon <node>',
      'oc get pods -A --field-selector spec.nodeName=<node>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.nodes,
    resolution: { kind: 'node', effect: 'ready', targetKind: 'Node' },
  },
  {
    id: 'node-disk-pressure',
    name: 'NodeDiskPressure',
    category: 'Cluster',
    severity: 4,
    description:
      'A Node reports DiskPressure: the kubelet evicts Pods and cannot pull new images until disk usage drops.',
    visualEffect: 'pulse-red',
    affectedResourceTypes: ['Node'],
    investigationSteps: [
      S(
        'oc describe node <node>',
        'Conditions show DiskPressure=True with the eviction threshold.'
      ),
      S('oc adm top node <node>', 'Node resource usage overview.'),
      S(
        'oc get events -A --field-selector involvedObject.name=<node>',
        'Eviction events on the node.'
      ),
    ],
    resolutionActions: [
      A('free-disk', 'Free node disk space', 2),
      A('evict-pods', 'Move workloads off the node', 2),
    ],
    ocCommands: [
      'oc describe node <node>',
      'oc adm top node <node>',
      'oc adm cordon <node>',
      'oc adm drain <node> --ignore-daemonsets --delete-emptydir-data',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.nodes,
    resolution: { kind: 'node', effect: 'clear', targetKind: 'Node' },
  },
  {
    id: 'node-memory-pressure',
    name: 'NodeMemoryPressure',
    category: 'Cluster',
    severity: 4,
    description:
      'A Node reports MemoryPressure; the kubelet evicts Pods, and the scheduler stops placing new workloads there.',
    visualEffect: 'pulse-red',
    affectedResourceTypes: ['Node', 'Pod'],
    investigationSteps: [
      S('oc describe node <node>', 'Conditions show MemoryPressure=True.'),
      S('oc adm top node <node>', 'Identify memory-hungry workloads.'),
      S('oc adm top pods --all-namespaces', 'Find the largest pod memory consumers.'),
    ],
    resolutionActions: [
      A('reduce-memory', 'Reduce workload memory usage', 2),
      A('add-capacity', 'Add a node / more memory', 2),
    ],
    ocCommands: [
      'oc describe node <node>',
      'oc adm top node <node>',
      'oc adm top pods -A',
      'oc adm cordon <node>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.nodes,
    resolution: { kind: 'node', effect: 'clear', targetKind: 'Node' },
  },
  {
    id: 'operator-install-failed',
    name: 'OperatorInstallFailed',
    category: 'Cluster',
    severity: 4,
    description:
      'An Operator install failed: the Subscription cannot resolve/install its CSV (catalog issue, InstallPlan failure, missing RBAC), so the operator is not available.',
    visualEffect: 'flash-red',
    affectedResourceTypes: ['Subscription', 'ClusterOperator'],
    investigationSteps: [
      S(
        'oc get subscription <subscription> -n <namespace> -o yaml',
        'Check status.installedCSV/currentCSV and conditions.'
      ),
      S('oc get csv -n <namespace>', 'Find a CSV stuck in Failed/Pending/Installing.'),
      S('oc describe subscription <subscription>', 'Conditions show resolution/install failures.'),
      S('oc get installplan -n <namespace>', 'Look for failed install plans / missing CRDs.'),
    ],
    resolutionActions: [
      A('fix-catalog', 'Fix the catalog source / channel', 2),
      A('retry-subscription', 'Delete and recreate the Subscription', 1),
      A('check-operatorgroup', 'Fix OperatorGroup/RBAC', 2),
    ],
    ocCommands: [
      'oc get subscription -A',
      'oc describe subscription <subscription>',
      'oc get csv -n <namespace>',
      'oc get installplan -n <namespace>',
    ],
    autoResolveTime: null,
    docsUrl: DOCS.operator,
    resolution: { kind: 'operator', effect: 'install', targetKind: 'Subscription' },
  },
];

// ─── Derived helpers (stable exports for engine/panel/content) ─────────────
const INCIDENT_NAMES = INCIDENT_DEFS.map((d) => d.name);

/** Map from incident name -> definition (single lookup for engine/panel). */
const INCIDENT_DEFS_BY_NAME = Object.fromEntries(INCIDENT_DEFS.map((d) => [d.name, d]));

/**
 * Temporary compatibility aliases for pre-conversion incident names that may
 * still exist in campaign/challenge data while those files are being rewritten.
 * Using an alias logs a warning in IncidentEngine.loadScriptedIncidents so the
 * mismatch is visible during integration instead of silently dropping spawns.
 */
const LEGACY_INCIDENT_ALIASES = {
  PodEviction: 'PendingScheduling',
  ServiceEndpointMissing: 'ServiceNoEndpoints',
  IngressMisconfigured: 'RouteNotAdmitted',
  HPAScalingFailure: 'HPAUnableToScale',
  EtcdLatency: 'NodeNotReady',
  APIServerOverloaded: 'NodeNotReady',
  SchedulerFailure: 'PendingScheduling',
  WebhookTimeout: 'DeploymentStuckRollout',
  CertificateExpiry: 'RouteTLSCertificateError',
  StatefulSetOrderedReadyStuck: 'DeploymentStuckRollout',
  InitContainerCrash: 'CrashLoopBackOff',
  VolumeMountFailure: 'ConfigMapMissing',
  VolumeCapacityFull: 'PVCPending',
  NodePIDPressure: 'NodeNotReady',
  WebhookAdmissionRejection: 'SCCForbidden',
};

export {
  INCIDENT_DEFS,
  INCIDENT_DEFS_BY_NAME,
  INCIDENT_NAMES,
  INCIDENT_CATEGORIES,
  SEVERITY_LEVELS,
  LEGACY_INCIDENT_ALIASES,
};
