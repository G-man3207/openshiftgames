/**
 * Central kind registry for OpenShift Games.
 *
 * SINGLE SOURCE OF TRUTH for OpenShift resource kinds: apiVersion, scope,
 * owner chains, CLI aliases, `oc get` columns, palette metadata, minimap sizes,
 * default specs and explain blurbs.
 *
 * All other modules (ClusterState, GameEngine, CommandBar, index.html palette,
 * draw.html, ResourceMeshes, Minimap, SandboxMode, InspectorPanel, ...) MUST
 * derive their kind lists/metadata from this file instead of keeping their own
 * hard-coded copies. Adding a kind = adding one entry here + a resource class +
 * a mesh creator (+ optional controller/data changes).
 *
 * `createResource(kind, meta)` returns the rich resource subclass from
 * `js/resources/KindClasses.js` (KIND_CLASSES), with the registry
 * apiVersion/default spec/scope applied, caller overrides deep-merged and
 * `metadata.uid` honoured. `registerKindClass()` can override/extend the map.
 *
 * `toManifestObject(resource, opts)` and `toManifestYAML(resource, opts)`
 * delegate to the shared `js/resources/ManifestSerializer.js`; YAML output is
 * apply-clean (no uid/creationTimestamp/status unless `opts.includeStatus`).
 *
 * Keep the public API below stable; other workstreams build against it.
 */

import { ResourceBase } from '../resources/ResourceBase.js';
import { KIND_CLASSES } from '../resources/KindClasses.js';
import {
  deepClone,
  deepMerge,
  normalizeManifestObject,
  toManifestObject as serializeManifestObject,
  toManifestYAML as serializeManifestYAML,
  stringifyYAML,
} from '../resources/ManifestSerializer.js';

/** @typedef {'Project'|'Route'|'BuildConfig'|string} KindName */

export const KIND_SECTIONS = [
  { id: 'projects', label: 'Projects & Cluster' },
  { id: 'workloads', label: 'Workloads' },
  { id: 'builds', label: 'Builds & Images' },
  { id: 'network', label: 'Networking' },
  { id: 'config', label: 'Config' },
  { id: 'storage', label: 'Storage' },
  { id: 'scaling', label: 'Scaling & Availability' },
  { id: 'security', label: 'Security' },
  { id: 'identity', label: 'Identity & Operators' },
];

/**
 * @type {Record<string, {
 *   apiVersion: string,
 *   namespaced: boolean,
 *   placeable?: boolean,
 *   ownerChain?: string[]|null,
 *   aliases?: string[],
 *   columns?: string,
 *   defaultNamespace?: string,
 *   palette?: { section: string, label: string, shortcut?: string },
 *   minimapSize?: number,
 *   mesh?: string,
 *   defaultSpec?: () => object,
 *   explain?: string,
 * }>}
 */
const K = {};

// ─── Cluster / projects ─────────────────────────────────────────────────────
K.Project = {
  apiVersion: 'project.openshift.io/v1',
  namespaced: false,
  aliases: ['project', 'projects', 'proj', 'namespace', 'namespaces', 'ns'],
  columns: 'NAME                              DISPLAY NAME   STATUS',
  palette: { section: 'projects', label: 'Project' },
  minimapSize: 18,
  defaultSpec: () => ({ displayName: '', description: '' }),
  explain:
    'Project is an OpenShift resource that maps to a Kubernetes Namespace, adding\n' +
    'display metadata and project-scoped administration. `oc new-project <name>`\n' +
    'creates a project and switches to it.',
};
K.Node = {
  apiVersion: 'v1',
  namespaced: false,
  aliases: ['node', 'nodes', 'no'],
  columns: 'NAME        STATUS   ROLES           AGE   VERSION',
  palette: { section: 'projects', label: 'Node' },
  minimapSize: 20,
  defaultSpec: () => ({ cpu: '4', memory: '8Gi', taints: [], unschedulable: false }),
  explain:
    'Node is a worker or control-plane machine registered with the cluster.\n' +
    'oc adm cordon/drain/uncordon manage scheduling; oc label node sets labels\n' +
    'used by node selectors and affinity.',
};
K.ClusterResourceQuota = {
  apiVersion: 'quota.openshift.io/v1',
  namespaced: false,
  aliases: ['clusterresourcequota', 'clusterresourcequotas', 'clusterquota', 'crq'],
  columns: 'NAME              AGE   REQUEST   LIMIT',
  palette: { section: 'projects', label: 'ClusterQuota' },
  minimapSize: 16,
  // Hard limits are never defaulted: a ClusterResourceQuota created with
  // `--hard=pods=10` must contain exactly that one limit, not invented
  // requests.cpu / requests.memory entries (issue #14).
  defaultSpec: () => ({
    selector: { labels: { matchLabels: {} } },
    quota: { hard: {} },
  }),
  explain:
    'ClusterResourceQuota applies a quota across all projects selected by labels.\n' +
    'Unlike ResourceQuota it is cluster-scoped and can constrain multiple projects\n' +
    'at once (common for self-service developer projects).',
};

// ─── Workloads ─────────────────────────────────────────────────────────────
K.Pod = {
  apiVersion: 'v1',
  namespaced: true,
  aliases: ['pod', 'pods', 'po'],
  ownerChain: null,
  columns: 'NAME       READY   STATUS    RESTARTS   AGE',
  palette: { section: 'workloads', label: 'Pod', shortcut: '1' },
  minimapSize: 8,
  defaultSpec: () => ({ containers: [{ name: 'main', image: 'nginx:latest', ports: [{ containerPort: 8080 }] }] }),
  explain:
    'Pod is the smallest deployable unit: one or more containers sharing network\n' +
    'and storage. OpenShift runs pods under a SecurityContextConstraint; use a\n' +
    'Deployment rather than creating bare pods in production.',
};
K.Deployment = {
  apiVersion: 'apps/v1',
  namespaced: true,
  ownerChain: ['ReplicaSet'],
  aliases: ['deployment', 'deployments', 'deploy'],
  columns: 'NAME       READY   UP-TO-DATE   AVAILABLE   AGE',
  palette: { section: 'workloads', label: 'Deploy', shortcut: '2' },
  minimapSize: 14,
  defaultSpec: () => ({
    replicas: 3,
    selector: { matchLabels: { app: 'app' } },
    strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } },
    template: {
      metadata: { labels: { app: 'app' } },
      spec: { containers: [{ name: 'main', image: 'nginx:latest', ports: [{ containerPort: 8080 }] }] },
    },
    revisionHistoryLimit: 10,
    progressDeadlineSeconds: 600,
  }),
  explain:
    'Deployment declares a desired replica count and template; OpenShift creates\n' +
    'ReplicaSets and Pods, performs rolling updates and keeps rollout history for\n' +
    'oc rollout undo. `apps/v1` Deployments have no spec.triggers field: image\n' +
    'triggers are requested with the image.openshift.io/triggers annotation\n' +
    '(`oc set triggers deploy/<name> --from-image=<image>:<tag> -c <container>`).',
};
K.ReplicaSet = {
  apiVersion: 'apps/v1',
  namespaced: true,
  ownerChain: ['Pod'],
  aliases: ['replicaset', 'replicasets', 'rs'],
  columns: 'NAME              DESIRED   CURRENT   READY   AGE',
  palette: { section: 'workloads', label: 'RS', shortcut: '3' },
  minimapSize: 12,
  defaultSpec: () => ({
    replicas: 3,
    selector: { matchLabels: { app: 'app' } },
    template: { metadata: { labels: { app: 'app' } }, spec: { containers: [{ name: 'main', image: 'nginx:latest' }] } },
  }),
  explain: 'ReplicaSet ensures a stable number of Pod replicas; normally managed by a Deployment.',
};
K.StatefulSet = {
  apiVersion: 'apps/v1',
  namespaced: true,
  ownerChain: ['Pod'],
  aliases: ['statefulset', 'statefulsets', 'sts'],
  columns: 'NAME       READY   AGE',
  palette: { section: 'workloads', label: 'STS', shortcut: '4' },
  minimapSize: 14,
  defaultSpec: () => ({
    replicas: 3,
    serviceName: 'app',
    selector: { matchLabels: { app: 'app' } },
    template: { metadata: { labels: { app: 'app' } }, spec: { containers: [{ name: 'main', image: 'nginx:latest' }] } },
  }),
  explain:
    'StatefulSet provides stable pod names and per-pod storage (volumeClaimTemplates)\n' +
    'for stateful workloads such as databases.',
};
K.DaemonSet = {
  apiVersion: 'apps/v1',
  namespaced: true,
  ownerChain: ['Pod'],
  aliases: ['daemonset', 'daemonsets', 'ds'],
  columns: 'NAME       DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR   AGE',
  palette: { section: 'workloads', label: 'DS', shortcut: '5' },
  minimapSize: 14,
  defaultSpec: () => ({
    selector: { matchLabels: { app: 'agent' } },
    template: { metadata: { labels: { app: 'agent' } }, spec: { containers: [{ name: 'main', image: 'nginx:latest' }] } },
  }),
  explain: 'DaemonSet runs exactly one Pod on every (matching) node — node agents, log collectors, CNI.',
};
K.Job = {
  apiVersion: 'batch/v1',
  namespaced: true,
  ownerChain: ['Pod'],
  aliases: ['job', 'jobs'],
  columns: 'NAME   COMPLETIONS   DURATION   AGE',
  palette: { section: 'workloads', label: 'Job', shortcut: '6' },
  minimapSize: 12,
  defaultSpec: () => ({
    completions: 1,
    parallelism: 1,
    template: { spec: { restartPolicy: 'Never', containers: [{ name: 'main', image: 'busybox:latest', command: ['sh', '-c', 'echo done'] }] } },
  }),
  explain: 'Job runs Pods to completion; use oc create job --from=cronjob/<name> for manual runs.',
};
K.CronJob = {
  apiVersion: 'batch/v1',
  namespaced: true,
  ownerChain: ['Job'],
  aliases: ['cronjob', 'cronjobs', 'cj'],
  columns: 'NAME       SCHEDULE      SUSPEND   ACTIVE   LAST SCHEDULE   AGE',
  palette: { section: 'workloads', label: 'CronJob', shortcut: '7' },
  minimapSize: 12,
  defaultSpec: () => ({
    schedule: '*/5 * * * *',
    concurrencyPolicy: 'Allow',
    suspend: false,
    jobTemplate: {
      spec: {
        template: {
          spec: { restartPolicy: 'Never', containers: [{ name: 'main', image: 'busybox:latest', command: ['sh', '-c', 'date'] }] },
        },
      },
    },
  }),
  explain: 'CronJob creates Jobs on a cron schedule (`oc get cronjobs`, `oc patch cronjob ... -p \'{"spec":{"suspend":false}}\'`).',
};

// ─── Builds & images ───────────────────────────────────────────────────────
K.BuildConfig = {
  apiVersion: 'build.openshift.io/v1',
  namespaced: true,
  ownerChain: ['Build'],
  aliases: ['buildconfig', 'buildconfigs', 'bc'],
  columns: 'NAME      TYPE      FROM      LATEST',
  palette: { section: 'builds', label: 'BuildConfig' },
  minimapSize: 14,
  defaultSpec: () => ({
    source: { type: 'Git', git: { uri: '', ref: '' }, contextDir: '' },
    // Exactly one strategy object; the resource class fills the concrete
    // sourceStrategy/dockerStrategy/customStrategy for the selected type.
    strategy: { type: 'Source' },
    output: { to: { kind: 'ImageStreamTag', name: 'app:latest' } },
    triggers: [{ type: 'ConfigChange' }, { type: 'ImageChange', imageChange: {} }],
    runPolicy: 'Serial',
  }),
  explain:
    'BuildConfig describes how to build an image from source (Source/S2I or Dockerfile)\n' +
    'and where to push it (ImageStreamTag). Exactly one strategy object must be set\n' +
    '(sourceStrategy for Source, dockerStrategy for Docker). oc start-build runs it;\n' +
    'ConfigChange/ImageChange triggers start new builds.',
};
K.Build = {
  apiVersion: 'build.openshift.io/v1',
  namespaced: true,
  placeable: false,
  ownerChain: ['Pod'],
  aliases: ['build', 'builds'],
  columns: 'NAME      TYPE      FROM      STATUS     STARTED   DURATION',
  palette: { section: 'builds', label: 'Build' },
  minimapSize: 12,
  defaultSpec: () => ({
    source: { type: 'Git', git: { uri: '', ref: '' } },
    strategy: {
      type: 'Source',
      sourceStrategy: { from: { kind: 'ImageStreamTag', name: 'nodejs:20-ubi9', namespace: 'openshift' } },
    },
    output: { to: { kind: 'ImageStreamTag', name: 'app:latest' } },
    serviceAccount: 'builder',
  }),
  explain: 'Build is one execution of a BuildConfig. Phases: New → Pending → Running → Complete/Failed/Cancelled.',
};
K.ImageStream = {
  apiVersion: 'image.openshift.io/v1',
  namespaced: true,
  aliases: ['imagestream', 'imagestreams', 'is'],
  columns: 'NAME      IMAGE REPOSITORY                     TAGS     UPDATED',
  palette: { section: 'builds', label: 'ImageStream' },
  minimapSize: 14,
  defaultSpec: () => ({ lookupPolicy: { local: false }, tags: [] }),
  explain:
    'ImageStream tracks image tags/digests and gives an internal registry reference\n' +
    'image-registry.openshift-image-registry.svc:5000/<project>/<name>:<tag>.\n' +
    'oc tag / oc import-image manage tags; ImageStreamTags can trigger deployments.',
};

// ─── Networking ────────────────────────────────────────────────────────────
K.Service = {
  apiVersion: 'v1',
  namespaced: true,
  aliases: ['service', 'services', 'svc'],
  columns: 'NAME      TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)   AGE',
  palette: { section: 'network', label: 'Service' },
  minimapSize: 12,
  defaultSpec: () => ({ type: 'ClusterIP', selector: { app: 'app' }, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] }),
  explain:
    'Service provides a stable virtual IP/DNS name for a label-selected set of Pods.\n' +
    'OpenShift supports ClusterIP, NodePort, LoadBalancer and ExternalName services.',
};
K.Route = {
  apiVersion: 'route.openshift.io/v1',
  namespaced: true,
  aliases: ['route', 'routes'],
  columns: 'NAME      HOST/PORT                              PATH      SERVICES   PORT   TERMINATION   WILDCARD',
  palette: { section: 'network', label: 'Route' },
  minimapSize: 14,
  // Real oc expose routes omit `path` and `tls` (omitempty); the API assigns
  // `host` on admission. Keep them absent unless the caller supplies them.
  defaultSpec: () => ({
    host: '',
    to: { kind: 'Service', name: 'app', weight: 100 },
    port: { targetPort: 'http' },
    wildcardPolicy: 'None',
  }),
  explain:
    'Route exposes a Service externally through the OpenShift ingress router.\n' +
    'TLS termination modes: edge, reencrypt, passthrough. `oc expose svc/<name>`\n' +
    'creates a plain HTTP route; `oc create route edge ... --cert/--key` adds TLS.',
};
K.Ingress = {
  apiVersion: 'networking.k8s.io/v1',
  namespaced: true,
  aliases: ['ingress', 'ingresses', 'ing'],
  columns: 'NAME      CLASS   HOSTS   ADDRESS   PORTS   AGE',
  palette: { section: 'network', label: 'Ingress' },
  minimapSize: 14,
  defaultSpec: () => ({
    rules: [{ host: 'app.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'app', port: { number: 8080 } } } }] } }],
  }),
  explain:
    'Ingress is the upstream Kubernetes L7 resource. On OpenShift, Routes are the\n' +
    'native way to expose applications; Ingress is served by the ingress controller.',
};
K.NetworkPolicy = {
  apiVersion: 'networking.k8s.io/v1',
  namespaced: true,
  aliases: ['networkpolicy', 'networkpolicies', 'netpol'],
  columns: 'NAME      POD-SELECTOR   AGE',
  palette: { section: 'network', label: 'NetPol' },
  minimapSize: 12,
  defaultSpec: () => ({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] }),
  explain:
    'NetworkPolicy is an allow-list firewall for Pods. A policy selecting all pods\n' +
    'with empty podSelector and Ingress/Egress policyTypes gives default-deny; DNS\n' +
    'egress to port 53 must then be explicitly allowed.',
};
K.IPAddressPool = {
  apiVersion: 'metallb.io/v1beta1',
  namespaced: true,
  defaultNamespace: 'metallb-system',
  aliases: ['ipaddresspool', 'ipaddresspools', 'ippool'],
  columns: 'NAME      AGE',
  palette: { section: 'network', label: 'IPAddressPool' },
  minimapSize: 12,
  defaultSpec: () => ({ addresses: ['192.168.100.200-192.168.100.210'], autoAssign: true, avoidBuggyIPs: false }),
  explain:
    'MetalLB IPAddressPool defines external IP ranges for LoadBalancer services.\n' +
    'Requires the MetalLB Operator and an L2Advertisement selecting the pool.',
};
K.L2Advertisement = {
  apiVersion: 'metallb.io/v1beta1',
  namespaced: true,
  defaultNamespace: 'metallb-system',
  aliases: ['l2advertisement', 'l2advertisements', 'l2adv'],
  columns: 'NAME      AGE',
  palette: { section: 'network', label: 'L2Advert' },
  minimapSize: 12,
  defaultSpec: () => ({ ipAddressPools: ['default'] }),
  explain: 'L2Advertisement tells MetalLB to advertise a pool over Layer 2 on the cluster nodes.',
};

// ─── Config / storage ──────────────────────────────────────────────────────
K.ConfigMap = {
  apiVersion: 'v1',
  namespaced: true,
  aliases: ['configmap', 'configmaps', 'cm'],
  columns: 'NAME      DATA   AGE',
  palette: { section: 'config', label: 'CM' },
  minimapSize: 10,
  defaultSpec: () => ({ data: { 'app.properties': 'greeting=hello' } }),
  explain: 'ConfigMap holds non-sensitive configuration as keys/files; consume via envFrom, env valueFrom or volume mounts.',
};
K.Secret = {
  apiVersion: 'v1',
  namespaced: true,
  aliases: ['secret', 'secrets'],
  columns: 'NAME      TYPE     DATA   AGE',
  palette: { section: 'config', label: 'Secret' },
  minimapSize: 10,
  defaultSpec: () => ({ type: 'Opaque', data: {} }),
  explain:
    'Secret holds sensitive data (Opaque, kubernetes.io/tls, dockerconfigjson, basic-auth\n' +
    'or HTPasswd file secrets). oc create secret generic/tls/docker-registry create them.',
};
K.LimitRange = {
  apiVersion: 'v1',
  namespaced: true,
  aliases: ['limitrange', 'limitranges', 'limits'],
  columns: 'NAME      CREATED AT',
  palette: { section: 'config', label: 'LimitRange' },
  minimapSize: 12,
  defaultSpec: () => ({
    limits: [{ type: 'Container', default: { cpu: '500m', memory: '512Mi' }, defaultRequest: { cpu: '100m' }, min: { cpu: '50m', memory: '64Mi' }, max: { cpu: '2', memory: '4Gi' } }],
  }),
  explain: 'LimitRange supplies default requests/limits and enforces min/max per Pod or Container in a project.',
};
K.ResourceQuota = {
  apiVersion: 'v1',
  namespaced: true,
  aliases: ['resourcequota', 'resourcequotas', 'quota'],
  columns: 'NAME      AGE   REQUEST   LIMIT',
  palette: { section: 'config', label: 'ResourceQuota' },
  minimapSize: 14,
  defaultSpec: () => ({ hard: { pods: '20', 'requests.cpu': '4', 'requests.memory': '8Gi', 'limits.cpu': '8', 'limits.memory': '16Gi' } }),
  explain: 'ResourceQuota caps aggregate resource usage/object counts in a project; oc describe quota shows hard/used.',
};
K.Template = {
  apiVersion: 'template.openshift.io/v1',
  namespaced: true,
  aliases: ['template', 'templates'],
  columns: 'NAME      DESCRIPTION   PARAMETERS   OBJECTS',
  palette: { section: 'config', label: 'Template' },
  minimapSize: 14,
  defaultSpec: () => ({
    parameters: [{ name: 'APP_NAME', displayName: 'Application name', description: 'Name used for the deployed application', required: true, value: 'webapp' }],
    objects: [
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: '${APP_NAME}' }, spec: { replicas: 2, selector: { matchLabels: { app: '${APP_NAME}' } }, template: { metadata: { labels: { app: '${APP_NAME}' } }, spec: { containers: [{ name: 'main', image: 'nginx:latest' }] } } } },
      { apiVersion: 'v1', kind: 'Service', metadata: { name: '${APP_NAME}' }, spec: { selector: { app: '${APP_NAME}' }, ports: [{ port: 8080, targetPort: 8080 }] } },
    ],
    message: 'Application ${APP_NAME} deployed.',
  }),
  explain:
    'Template is an OpenShift manifest with parameters. `oc process -f template.yaml -p KEY=VALUE`\n' +
    'renders it; `oc new-app --template=<name>` instantiates cluster templates.',
};
K.PersistentVolume = {
  apiVersion: 'v1',
  namespaced: false,
  aliases: ['persistentvolume', 'persistentvolumes', 'pv'],
  columns: 'NAME      CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS      CLAIM   STORAGECLASS   VOLUMEATTRIBUTESCLASS   REASON   AGE',
  palette: { section: 'storage', label: 'PV' },
  minimapSize: 14,
  defaultSpec: () => ({ capacity: { storage: '10Gi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', storageClassName: '' }),
  explain: 'PersistentVolume is cluster storage provisioned by an admin or dynamically by a StorageClass.',
};
K.PersistentVolumeClaim = {
  apiVersion: 'v1',
  namespaced: true,
  aliases: ['persistentvolumeclaim', 'persistentvolumeclaims', 'pvc'],
  columns: 'NAME      STATUS   VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE',
  palette: { section: 'storage', label: 'PVC' },
  minimapSize: 12,
  defaultSpec: () => ({ accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } } }),
  explain: 'PersistentVolumeClaim requests storage; the cluster binds it to a PV or dynamically provisions one.',
};
K.StorageClass = {
  apiVersion: 'storage.k8s.io/v1',
  namespaced: false,
  aliases: ['storageclass', 'storageclasses', 'sc'],
  columns: 'NAME      PROVISIONER   RECLAIMPOLICY   VOLUMEBINDINGMODE   ALLOWVOLUMEEXPANSION   AGE',
  palette: { section: 'storage', label: 'StorageClass' },
  minimapSize: 12,
  defaultSpec: () => ({ provisioner: 'kubernetes.io/no-provisioner', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer' }),
  explain: 'StorageClass describes a storage provisioner; `oc get storageclass` shows the default class.',
};

// ─── Scaling / availability ────────────────────────────────────────────────
K.HorizontalPodAutoscaler = {
  apiVersion: 'autoscaling/v2',
  namespaced: true,
  aliases: ['horizontalpodautoscaler', 'horizontalpodautoscalers', 'hpa'],
  columns: 'NAME      REFERENCE            TARGETS   MINPODS   MAXPODS   REPLICAS   AGE',
  palette: { section: 'scaling', label: 'HPA' },
  minimapSize: 12,
  defaultSpec: () => ({ scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'app' }, minReplicas: 2, maxReplicas: 10, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }] }),
  explain: 'HPA scales a workload based on CPU/memory/custom metrics. Needs resource requests and the metrics server.',
};
K.PodDisruptionBudget = {
  apiVersion: 'policy/v1',
  namespaced: true,
  aliases: ['poddisruptionbudget', 'poddisruptionbudgets', 'pdb'],
  columns: 'NAME      MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE',
  palette: { section: 'scaling', label: 'PDB' },
  minimapSize: 12,
  defaultSpec: () => ({ minAvailable: 1, selector: { matchLabels: { app: 'app' } } }),
  explain: 'PDB limits voluntary disruptions (node drains/upgrades) to keep availability.',
};

// ─── Security / identity ───────────────────────────────────────────────────
K.ServiceAccount = {
  apiVersion: 'v1',
  namespaced: true,
  aliases: ['serviceaccount', 'serviceaccounts', 'sa'],
  columns: 'NAME      SECRETS   AGE',
  palette: { section: 'security', label: 'SA' },
  minimapSize: 10,
  defaultSpec: () => ({ secrets: [], imagePullSecrets: [], automountServiceAccountToken: true }),
  explain: 'ServiceAccount is the identity Pods use to talk to the Kubernetes/OpenShift API. Grant it RBAC roles and SCCs.',
};
K.Role = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  namespaced: true,
  aliases: ['role', 'roles'],
  columns: 'NAME      CREATED AT',
  palette: { section: 'security', label: 'Role' },
  minimapSize: 10,
  // Real API allows an empty rules list; `oc create role`/YAML fill it in.
  defaultSpec: () => ({ rules: [] }),
  explain:
    'Role grants namespaced permissions; bind it with a RoleBinding. Set rules with\n' +
    '`oc create role <name> --verb=<verbs> --resource=<resources>` or in YAML; avoid\n' +
    'wildcard verbs/resources (least privilege).',
};
K.ClusterRole = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  namespaced: false,
  aliases: ['clusterrole', 'clusterroles'],
  columns: 'NAME      CREATED AT',
  palette: { section: 'security', label: 'ClusterRole' },
  minimapSize: 10,
  // Real API allows an empty rules list; `oc create clusterrole`/YAML fill it in.
  defaultSpec: () => ({ rules: [] }),
  explain:
    'ClusterRole grants cluster-wide permissions; bind it with a ClusterRoleBinding or\n' +
    'a namespaced RoleBinding. Rules are set with --verb/--resource or in YAML.',
};
K.RoleBinding = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  namespaced: true,
  aliases: ['rolebinding', 'rolebindings'],
  columns: 'NAME      ROLE      AGE   USERS   GROUPS   SERVICEACCOUNTS',
  palette: { section: 'security', label: 'RoleBinding' },
  minimapSize: 10,
  defaultSpec: () => ({ roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'view' }, subjects: [{ kind: 'User', name: 'developer' }] }),
  explain: 'RoleBinding binds a Role/ClusterRole to users, groups or service accounts in a project.',
};
K.ClusterRoleBinding = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  namespaced: false,
  aliases: ['clusterrolebinding', 'clusterrolebindings'],
  columns: 'NAME      ROLE      AGE   USERS   GROUPS   SERVICEACCOUNTS',
  palette: { section: 'security', label: 'ClusterRoleBinding' },
  minimapSize: 10,
  defaultSpec: () => ({ roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' }, subjects: [{ kind: 'User', name: 'developer' }] }),
  explain: 'ClusterRoleBinding grants a ClusterRole cluster-wide.',
};
K.SecurityContextConstraints = {
  apiVersion: 'security.openshift.io/v1',
  namespaced: false,
  aliases: ['securitycontextconstraints', 'securitycontextconstraint', 'scc'],
  columns: 'NAME              PRIV   CAPS   SELINUX    RUNASUSER   FSGROUP    SUPGROUP   PRIORITY   READONLYROOTFS   VOLUMES',
  palette: { section: 'security', label: 'SCC' },
  minimapSize: 14,
  // API-shaped default for an SCC created by an admin (docs restricted-style
  // template). Defaults shipped by OpenShift 4.22 have API-shaped fields too;
  // the exact per-SCC specs are seeded in ClusterState.defaultSCCDefinitions().
  defaultSpec: () => ({
    priority: null,
    allowPrivilegedContainer: false,
    allowHostDirVolumePlugin: false,
    allowHostNetwork: false,
    allowHostPorts: false,
    allowHostPID: false,
    allowHostIPC: false,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: false,
    defaultAddCapabilities: null,
    allowedCapabilities: ['NET_BIND_SERVICE'],
    requiredDropCapabilities: ['ALL'],
    runAsUser: { type: 'MustRunAsRange' },
    seLinuxContext: { type: 'MustRunAs' },
    fsGroup: { type: 'MustRunAs' },
    supplementalGroups: { type: 'MustRunAs' },
    seccompProfiles: ['runtime/default'],
    volumes: ['configMap', 'csi', 'downwardAPI', 'emptyDir', 'ephemeral', 'image', 'persistentVolumeClaim', 'projected', 'secret'],
    users: [],
    groups: [],
  }),
  explain:
    'SCC controls what Pods may do (privileged, hostPath, UID ranges, SELinux...).\n' +
    'The 4.22 default SCCs are: anyuid, hostaccess, hostmount-anyuid,\n' +
    'hostmount-anyuid-v2, hostnetwork, hostnetwork-v2, nested-container, node-exporter,\n' +
    'nonroot, nonroot-v2, privileged, restricted, restricted-v2, restricted-v3\n' +
    '(restricted-v3 is the most restrictive and the default for authenticated users\n' +
    'on new installs; node-exporter is installed by the monitoring operator).\n' +
    'Grant with oc adm policy add-scc-to-user <scc> -z <serviceaccount> -n <project>.',
};
K.User = {
  apiVersion: 'user.openshift.io/v1',
  namespaced: false,
  aliases: ['user', 'users'],
  columns: 'NAME      UID   FULL NAME   IDENTITIES',
  palette: { section: 'identity', label: 'User' },
  minimapSize: 10,
  defaultSpec: () => ({ fullName: '', groups: [], identities: [] }),
  explain: 'User is an OpenShift identity created on login (e.g. via HTPasswd) or by an admin. Groups bundle users for RBAC.',
};
K.Group = {
  apiVersion: 'user.openshift.io/v1',
  namespaced: false,
  aliases: ['group', 'groups'],
  columns: 'NAME      USERS   AGE',
  palette: { section: 'identity', label: 'Group' },
  minimapSize: 10,
  defaultSpec: () => ({ users: [] }),
  explain: 'Group collects users; bind roles to groups with oc adm policy add-role-to-group.',
};
K.Identity = {
  apiVersion: 'user.openshift.io/v1',
  namespaced: false,
  placeable: false,
  aliases: ['identity', 'identities'],
  columns: 'NAME      IDP NAME   IDP USER NAME   USER NAME   USER UID',
  palette: { section: 'identity', label: 'Identity' },
  minimapSize: 8,
  defaultSpec: () => ({ providerName: 'htpasswd', providerUserName: '', user: { name: '' } }),
  explain: 'Identity links a provider login (e.g. HTPasswd username) to an OpenShift User.',
};
K.OAuth = {
  apiVersion: 'config.openshift.io/v1',
  namespaced: false,
  placeable: false,
  aliases: ['oauth'],
  columns: 'NAME      AGE',
  palette: { section: 'identity', label: 'OAuth' },
  minimapSize: 10,
  defaultSpec: () => ({
    identityProviders: [
      {
        name: 'htpasswd',
        mappingMethod: 'claim',
        type: 'HTPasswd',
        htpasswd: { fileData: { name: 'htpasswd-secret' } },
      },
    ],
  }),
  explain: 'OAuth cluster config defines identity providers (HTPasswd, LDAP, OIDC...). Edit with `oc edit oauth cluster`.',
};
K.Subscription = {
  apiVersion: 'operators.coreos.com/v1alpha1',
  namespaced: true,
  aliases: ['subscription', 'subscriptions', 'sub', 'operator', 'operators'],
  columns: 'NAME      PACKAGE   SOURCE             CHANNEL',
  palette: { section: 'identity', label: 'Operator' },
  minimapSize: 14,
  defaultNamespace: 'openshift-operators',
  defaultSpec: () => ({
    name: 'ansible-automation-platform-operator',
    channel: 'stable',
    source: 'redhat-operators',
    sourceNamespace: 'openshift-marketplace',
    installPlanApproval: 'Automatic',
    packageName: 'ansible-automation-platform-operator',
  }),
  explain:
    'Subscription installs an Operator through Operator Lifecycle Manager (OLM) in\n' +
    'openshift-operators. `oc get subscriptions,csv,operatorgroups`; uninstall by\n' +
    'deleting the Subscription and its CSV.',
};
K.ClusterOperator = {
  apiVersion: 'config.openshift.io/v1',
  namespaced: false,
  placeable: false,
  aliases: ['clusteroperator', 'clusteroperators', 'co'],
  columns: 'NAME      VERSION   AVAILABLE   PROGRESSING   DEGRADED   SINCE',
  palette: { section: 'projects', label: 'ClusterOperator' },
  minimapSize: 12,
  defaultSpec: () => ({}),
  explain: 'ClusterOperator reports the health of a core OpenShift component (Available/Progressing/Degraded).',
};
K.ClusterVersion = {
  apiVersion: 'config.openshift.io/v1',
  namespaced: false,
  placeable: false,
  aliases: ['clusterversion', 'clusterversions', 'cv'],
  columns: 'NAME      VERSION   AVAILABLE   PROGRESSING   SINCE   STATUS',
  palette: { section: 'projects', label: 'ClusterVersion' },
  minimapSize: 12,
  defaultSpec: () => ({ channel: 'stable-4.22' }),
  explain: 'ClusterVersion is the singleton describing the desired/current OCP version (oc get clusterversion).',
};

K.OperatorGroup = {
  apiVersion: 'operators.coreos.com/v1',
  namespaced: true,
  placeable: false,
  aliases: ['operatorgroup', 'operatorgroups', 'og'],
  columns: 'NAME      AGE',
  palette: { section: 'identity', label: 'OperatorGroup' },
  minimapSize: 12,
  defaultNamespace: 'openshift-operators',
  defaultSpec: () => ({ targetNamespaces: [] }),
  explain:
    'OperatorGroup configures which namespaces the Operators installed in its\n' +
    'namespace watch. One OperatorGroup per namespace; AllNamespaces installs\n' +
    'live in openshift-operators (global-operators), SingleNamespace installs\n' +
    'require an OperatorGroup in the target project.',
};
K.InstallPlan = {
  apiVersion: 'operators.coreos.com/v1alpha1',
  namespaced: true,
  placeable: false,
  aliases: ['installplan', 'installplans', 'ip'],
  columns: 'NAME              CSV                            APPROVAL    APPROVED',
  palette: { section: 'identity', label: 'InstallPlan' },
  minimapSize: 12,
  defaultNamespace: 'openshift-operators',
  defaultSpec: () => ({ approval: 'Automatic', approved: false, clusterServiceVersionNames: [] }),
  explain:
    'InstallPlan is the calculated set of resources OLM installs/upgrades for a\n' +
    'Subscription. Automatic plans are approved for you; Manual plans wait for\n' +
    '`spec.approved: true` (console: Install Plan -> Approve).',
};
K.ClusterServiceVersion = {
  apiVersion: 'operators.coreos.com/v1alpha1',
  namespaced: true,
  placeable: false,
  aliases: ['clusterserviceversion', 'clusterserviceversions', 'csv'],
  columns: 'NAME           DISPLAY            VERSION   REPLACES   PHASE',
  palette: { section: 'identity', label: 'CSV' },
  minimapSize: 13,
  defaultNamespace: 'openshift-operators',
  defaultSpec: () => ({
    displayName: '',
    version: '1.0.0',
    maturity: 'stable',
    installModes: [
      { type: 'OwnNamespace', supported: true },
      { type: 'SingleNamespace', supported: true },
      { type: 'MultiNamespace', supported: false },
      { type: 'AllNamespaces', supported: true },
    ],
    customresourcedefinitions: { owned: [] },
  }),
  explain:
    'ClusterServiceVersion is the installed "operator instance" record: versioned\n' +
    'metadata plus the install strategy OLM runs. Phase Installing -> Succeeded.\n' +
    'Deleting the CSV (not just the Subscription) is the real uninstall step.',
};
K.PackageManifest = {
  apiVersion: 'packages.operators.coreos.com/v1',
  namespaced: false,
  placeable: false,
  aliases: ['packagemanifest', 'packagemanifests'],
  columns: 'NAME           DISPLAY          VERSION   CATALOG   SOURCE',
  palette: { section: 'identity', label: 'Package' },
  minimapSize: 11,
  defaultSpec: () => ({ packageName: '', defaultChannel: 'stable', channels: [] }),
  explain:
    'PackageManifest is the cluster-scoped software-catalog entry for one\n' +
    'operator package (channels, current CSV, catalog source).\n' +
    '`oc get packagemanifests -n openshift-marketplace` lists the catalog.',
};
K.MetalLB = {
  apiVersion: 'metallb.io/v1beta1',
  namespaced: true,
  placeable: false,
  aliases: ['metallb', 'metallbs'],
  columns: 'NAME      AGE',
  palette: { section: 'network', label: 'MetalLB' },
  minimapSize: 14,
  defaultNamespace: 'metallb-system',
  defaultSpec: () => ({ nodeSelector: {}, speaker: { frr: {}, logLevel: 'info' }, controller: { logLevel: 'info' } }),
  explain:
    'MetalLB is the MetalLB Operator operand CR: the operator only deploys the\n' +
    'controller and speaker pods (in metallb-system) after this instance exists.\n' +
    'Create IPAddressPool + L2Advertisement to hand out LoadBalancer EXTERNAL-IPs.',
};

// ─── Derived exports ───────────────────────────────────────────────────────

/** All kinds in canonical order (palette order follows sections). */
export const KIND_DEFS = K;
export const RESOURCE_KINDS = Object.keys(K);
export const CLUSTER_SCOPED_KINDS = RESOURCE_KINDS.filter((k) => !K[k].namespaced);
export const PLACEABLE_KINDS = RESOURCE_KINDS.filter((k) => K[k].placeable !== false);

/** CLI aliases → canonical kind. Includes plural/singular forms and short names. */
export const KIND_ALIASES = (() => {
  /** @type {Record<string,string>} */
  const map = {};
  for (const [kind, def] of Object.entries(K)) {
    map[kind.toLowerCase()] = kind;
    map[`${kind.toLowerCase()}s`] = kind;
    for (const a of def.aliases || []) map[a.toLowerCase()] = kind;
  }
  // App-specific aliases. Only aliases whose real target is a different *game*
  // kind are kept here; they must be a genuine API alias, never a different kind.
  map.dc = 'Deployment'; // DeploymentConfig (apps.openshift.io/v1) is deprecated in 4.22; CLI layer warns
  map.deploymentconfig = 'Deployment';
  map.deploymentconfigs = 'Deployment';
  map.istag = 'ImageStream'; // `oc get istag` is served by a virtual view in the CLI
  map.imagestreamtag = 'ImageStream';
  map.imagestreamtags = 'ImageStream';
  map.ic = 'Ingress'; // IngressController (operator.openshift.io/v1) is served by a virtual view
  map.ingresscontroller = 'Ingress';
  map.ingresscontrollers = 'Ingress';
  // NOTE: `csv`/`operatorgroup`/`og` intentionally do NOT alias to Subscription —
  // they are distinct OLM kinds, and mapping them to Subscription made
  // `oc apply -f operatorgroup.yaml` create a Subscription (see HANDOFF in the
  // platform fix log; the kinds themselves are a follow-up feature).
  return map;
})();

/** Flat alias list used by terminal autocompletion (e.g. "pods", "deploy"). */
export const RESOURCE_TYPES = Object.keys(KIND_ALIASES);

/** Ordered palette groups with their kinds. */
export const PALETTE_SECTIONS = KIND_SECTIONS.map((section) => ({
  ...section,
  kinds: PLACEABLE_KINDS.filter((k) => (K[k].palette?.section || 'projects') === section.id),
}));

export function apiVersionForKind(kind) {
  return K[kind]?.apiVersion || 'v1';
}

export function isClusterScopedKind(kind) {
  return K[kind]?.namespaced === false;
}

export function isPlaceableKind(kind) {
  return K[kind]?.placeable !== false;
}

export function getOwnerChain(kind) {
  return K[kind]?.ownerChain || [];
}

export function columnsForKind(kind) {
  return K[kind]?.columns || 'NAME      AGE';
}

export function explainForKind(kind) {
  return K[kind]?.explain || '';
}

export function paletteMeta(kind) {
  return K[kind]?.palette || { section: 'projects', label: kind };
}

export function minimapSize(kind) {
  return K[kind]?.minimapSize || 10;
}

export function defaultSpecForKind(kind) {
  const def = K[kind]?.defaultSpec;
  if (!def) return {};
  try {
    return def();
  } catch {
    return {};
  }
}

/**
 * Normalise a CLI resource token to a canonical kind.
 * @param {string} token
 * @returns {string|null}
 */
export function normalizeKind(token) {
  if (!token) return null;
  return KIND_ALIASES[String(token).toLowerCase()] || null;
}

/**
 * Default namespace for a namespaced kind (the project the resource belongs to
 * when the caller does not pass one). Most kinds default to `default`.
 * @param {string} kind
 * @returns {string}
 */
export function defaultNamespaceForKind(kind) {
  if (K[kind]?.namespaced === false) return '';
  return K[kind]?.defaultNamespace || 'default';
}

/** Extra/overridden classes registered at runtime (hint: tests, mods). */
const registeredClasses = new Map();

/**
 * Register or override the resource class used by `createResource(kind, ...)`.
 * All kinds shipped with the game are already registered via KIND_CLASSES;
 * this exists for tests/extensions without editing the central map.
 * @param {string} kind @param {Function} ResourceClass
 */
export function registerKindClass(kind, ResourceClass) {
  if (typeof ResourceClass !== 'function') {
    throw new TypeError('registerKindClass(kind, ResourceClass) requires a constructor');
  }
  registeredClasses.set(kind, ResourceClass);
  return ResourceClass;
}

/**
 * Resolve the rich resource class for a kind (null when unknown).
 * @param {string} kind
 * @returns {Function|null}
 */
export function getKindClass(kind) {
  return registeredClasses.get(kind) || KIND_CLASSES[kind] || null;
}

/**
 * Create a resource of `kind` through the central factory.
 *
 * Every creation path (palette, command bar, mode setup, controllers, draw
 * page, ManifestEngine apply) must use this function so UIDs, apiVersions,
 * scope, deep-cloned defaults and rich `toYAML()`/`describe()` behave the same
 * everywhere.
 *
 * Accepted `meta` forms:
 *   { name, namespace?, labels?, annotations?, spec?, status?, uid? }
 *   a full manifest object { apiVersion, kind, metadata, spec, status }
 *     (spec-less kinds such as SCC/Template/User are normalised automatically)
 *
 * @param {string} kind
 * @param {object} [meta]
 * @returns {ResourceBase}
 */
export function createResource(kind, meta = {}) {
  if (!K[kind]) {
    // Unknown kind: still build a plain resource with the conventional apiVersion.
    const fallback = new ResourceBase(kind, 'v1', meta?.name || 'unnamed', meta?.namespace ?? 'default');
    if (meta?.labels) Object.assign(fallback.metadata.labels, meta.labels);
    if (meta?.annotations) Object.assign(fallback.metadata.annotations, meta.annotations);
    if (meta?.spec) fallback.spec = deepClone(meta.spec);
    return fallback;
  }

  const isManifest = Boolean(meta) && (typeof meta.metadata === 'object' || (meta.kind && meta.apiVersion && !meta.name));
  const normalised = isManifest ? normalizeManifestObject(meta) : null;

  const def = K[kind];
  const namespaced = def.namespaced !== false;
  const source = normalised || meta || {};
  const name = source.name || 'unnamed';
  const namespace = namespaced ? source.namespace || defaultNamespaceForKind(kind) : '';
  const ResourceClass = getKindClass(kind);

  let resource;
  if (ResourceClass) {
    resource = new ResourceClass({
      ...source,
      name,
      namespace,
      apiVersion: source.apiVersion || apiVersionForKind(kind),
    });
  } else {
    resource = new ResourceBase(kind, apiVersionForKind(kind), name, namespace);
  }

  // Guarantee the canonical apiVersion/scope even if a constructor defaulted.
  if (source.apiVersion) resource.apiVersion = source.apiVersion;
  else resource.apiVersion = apiVersionForKind(kind);
  resource.metadata.namespace = namespace;

  // Fill any spec keys the class did not set from the registry defaults
  // (class defaults win; caller overrides win over both). Everything is deep-cloned.
  resource.spec = deepMerge(defaultSpecForKind(kind), resource.spec || {});
  if (source.spec && !isManifest) resource.spec = deepMerge(resource.spec, source.spec);

  if (source.uid) resource.metadata.uid = String(source.uid);
  if (source.labels && Object.keys(source.labels).length > 0) {
    resource.metadata.labels = deepMerge(resource.metadata.labels, source.labels);
  }
  if (source.annotations && Object.keys(source.annotations).length > 0) {
    resource.metadata.annotations = deepMerge(resource.metadata.annotations, source.annotations);
  }
  if (normalised?.ownerReferences?.length) resource.metadata.ownerReferences = deepClone(normalised.ownerReferences);
  if (normalised?.finalizers?.length) resource.metadata.finalizers = deepClone(normalised.finalizers);
  if (source.status) resource.status = deepMerge(resource.status, source.status);

  return resource;
}

/**
 * Build an apply-clean Kubernetes/OpenShift manifest object from a resource.
 * Single serializer used by the Inspector YAML tab, `oc get -o yaml`, YAML
 * export, draw export and ManifestEngine round-trips. Drops uid/timestamps/
 * status by default; `opts.includeStatus` keeps status.
 *
 * @param {ResourceBase|object} resource
 * @param {{includeStatus?: boolean}} [opts]
 * @returns {object}
 */
export function toManifestObject(resource, opts = {}) {
  return serializeManifestObject(resource, opts);
}

/**
 * YAML string form of `toManifestObject` (apply-clean unless includeStatus).
 * @param {ResourceBase|object} resource
 * @param {{includeStatus?: boolean}} [opts]
 * @returns {string}
 */
export function toManifestYAML(resource, opts = {}) {
  return serializeManifestYAML(resource, opts);
}

// Re-export the shared YAML emitter so CLI/render/draw code can use one
// serializer without importing js/resources/ManifestSerializer.js directly.
export { stringifyYAML, KIND_CLASSES };

export default {
  KIND_DEFS,
  KIND_SECTIONS,
  RESOURCE_KINDS,
  CLUSTER_SCOPED_KINDS,
  PLACEABLE_KINDS,
  KIND_ALIASES,
  RESOURCE_TYPES,
  PALETTE_SECTIONS,
  KIND_CLASSES,
  apiVersionForKind,
  isClusterScopedKind,
  isPlaceableKind,
  defaultNamespaceForKind,
  getOwnerChain,
  columnsForKind,
  explainForKind,
  paletteMeta,
  minimapSize,
  defaultSpecForKind,
  normalizeKind,
  getKindClass,
  registerKindClass,
  createResource,
  toManifestObject,
  toManifestYAML,
  stringifyYAML,
};
