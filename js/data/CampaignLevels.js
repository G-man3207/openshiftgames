/**
 * CampaignLevels — 20-level EX280 curriculum for OpenShift Games.
 *
 * Content source of truth: docs/CONVERSION-SPEC.md §9 (fixed chapter/level
 * titles and objective schema) + docs/research/ex280-objectives.md +
 * docs/research/openshift-workloads-builds.md + docs/research/openshift-networking-security-storage.md
 * (OCP 4.22, EX280V422, researched 2026-11-03).
 *
 * Every hint/description uses `oc` (never kubectl). Objectives use ONLY the
 * objective types implemented in js/engine/ObjectiveEvaluator.js; every
 * referenced kind exists in js/data/kindRegistry.js and every incident name
 * matches js/data/IncidentDefs.js (CONVERSION-SPEC §8).
 *
 * Level fields:
 *   id, title, chapter, chapterName, description,
 *   examObjectives: ['<group> > <official bullet>', ...],
 *   docsLinks: [docs.redhat.com 4.22 URL, ...],
 *   objectives: [{ type, label, ...type-specific-fields }],
 *   startingResources: [{ kind, name, namespace?, labels?, annotations?, spec?, status? }],
 *   availableResources: [kind, ...],
 *   manifestFiles/focusFiles: [virtual file paths from js/data/ManifestFiles.js],
 *   incidents: [{ type, triggerTime, target, severity }],
 *   hints: [3-5 real `oc` command hints],
 *   starCriteria: { time, efficiency, noFailures },
 *   nextLevel: number|null,
 *   tutorial: { steps: [{ target: 'command-bar'|'cluster-view'|'inspector'|'files'|'palette', text }] } | null,
 *   startingUser: 'kubeadmin' | null   // custom: null = log the player out at level start
 *
 * The engine seeds a default 4.22 cluster (10 Projects, Nodes need to be added,
 * SA/SCC/ClusterRole/ClusterOperator/ClusterVersion/OAuth/ImageStreams/Template
 * defaults). Level resources are therefore NAME-based and must not collide with
 * seeded defaults.
 */

// Campaign machines come from the same catalog every mode uses (#53F). The
// import is data-only (ClusterState is the engine's seed module and has no DOM
// dependencies), so the level data and per-mode seeds cannot drift apart.
import { NODE_CATALOG, catalogNode } from '../engine/ClusterState.js';

const DOCS = {
  cli: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/openshift-cli-oc',
  projects:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/projects',
  deployments:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/deployments',
  creating:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/creating-applications',
  quotas:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/quotas',
  helm: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/working-with-helm-charts',
  health:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/application-health',
  builds:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/understanding-buildconfigs',
  startBuild:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/basic-build-operations',
  buildTriggers:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/triggering-builds-build-hooks',
  imageStreams:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/managing-image-streams',
  images:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/overview-of-images',
  imageTriggers:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/triggering-updates-on-imagestream-changes',
  jobs: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/using-jobs-and-daemon-sets',
  pods: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/working-with-pods',
  clusterResources:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/working-with-clusters',
  scheduling:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/controlling-pod-placement-onto-nodes-scheduling',
  rbac: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/using-rbac',
  idp: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/configuring-identity-providers',
  usersGroups:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-authentication',
  serviceAccounts:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-creating-service-accounts',
  scc: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/managing-pod-security-policies',
  operators:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/user-tasks',
  operatorAdmin:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/administrator-tasks',
  operatorOlm:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/understanding-operators',
  routes:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes',
  metallb:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/load-balancing-with-metallb',
  networkSecurity:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/index',
  console:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/web_console/index',
};

// Small helpers keep the level data readable and avoid copy/paste drift.
/**
 * Campaign clusters present realistic OCP machines (#28 P4). Level data is
 * authored with the legacy `node-1..3` names; this helper maps those onto the
 * SHARED machine catalog in ClusterState (imported below, #53F) so campaign,
 * labs, sandbox and chaos all show `worker-0`, `worker-1`, `master-0` with
 * `worker` / `control-plane,master` roles. An explicit non-legacy name is kept
 * verbatim so the helper stays usable for custom nodes.
 */
const node = (name, cpu = '8', memory = '16Gi', extra = {}) => {
  const legacyIndex = String(name || '').match(/^node-(\d+)$/i);
  const legacyPosition = legacyIndex ? Math.max(0, Number(legacyIndex[1]) - 1) : 0;
  const catalogEntry = catalogNode(legacyPosition % NODE_CATALOG.length);
  const resolvedName = legacyIndex ? catalogEntry.name : name;
  const { spec: extraSpec, labels: extraLabels, ...rest } = extra;
  return {
    kind: 'Node',
    name: resolvedName,
    ...rest,
    labels: {
      ...catalogEntry.labels,
      'kubernetes.io/hostname': resolvedName,
      ...(extraLabels || {}),
    },
    spec: { cpu, memory, status: 'Ready', ...extraSpec },
  };
};

const project = (name, extra = {}) => ({
  kind: 'Project',
  name,
  spec: { displayName: name, description: extra.description || '' },
});

const deployment = (name, options = {}) => ({
  kind: 'Deployment',
  name,
  labels: { app: name, ...(options.labels || {}) },
  spec: {
    replicas: options.replicas ?? 2,
    ...(options.progressDeadlineSeconds
      ? { progressDeadlineSeconds: options.progressDeadlineSeconds }
      : {}),
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: {
        ...(options.serviceAccountName ? { serviceAccountName: options.serviceAccountName } : {}),
        containers: [
          {
            name: options.containerName || 'main',
            image: options.image || 'quay.io/openshift/origin-hello-openshift:latest',
            ports: [
              {
                containerPort: options.containerPort ?? 8080,
                name: options.containerPortName || 'http',
              },
            ],
            ...(options.env ? { env: options.env } : {}),
            ...(options.securityContext ? { securityContext: options.securityContext } : {}),
            ...(options.resources ? { resources: options.resources } : {}),
          },
        ],
      },
    },
  },
});

const service = (name, options = {}) => ({
  kind: 'Service',
  name,
  spec: {
    type: options.type || 'ClusterIP',
    selector: options.selector || { app: options.app || name },
    ports: [
      {
        name: options.portName || 'http',
        port: options.port ?? 8080,
        targetPort: options.targetPort ?? 8080,
      },
    ],
  },
});

/**
 * Batch/v1 Job starting resource. `command` is the container argv, so the
 * simulator can render its real stdout in `oc logs job/<name>` (issue #31).
 */
const job = (name, options = {}) => ({
  kind: 'Job',
  name,
  labels: { app: name, 'job-name': name },
  spec: {
    ...(options.activeDeadlineSeconds
      ? { activeDeadlineSeconds: options.activeDeadlineSeconds }
      : {}),
    ...(options.estimatedDurationSeconds
      ? { estimatedDurationSeconds: options.estimatedDurationSeconds }
      : {}),
    ...(options.backoffLimit !== undefined ? { backoffLimit: options.backoffLimit } : {}),
    template: {
      metadata: { labels: { app: name, 'job-name': name } },
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'main',
            image: options.image || 'perl',
            ...(options.command ? { command: options.command } : {}),
          },
        ],
      },
    },
  },
});

const CAMPAIGN_LEVELS = [
  // ═══════════════════════════ CHAPTER 1 — MANAGE OPENSHIFT ═══════════════════════════
  {
    id: 1,
    title: 'Your First Project',
    chapter: 1,
    chapterName: 'Manage OpenShift',
    description:
      'Welcome to OpenShift. A Project is the OpenShift-facing representation of a Kubernetes namespace: it isolates your workloads and is what you create and switch between with `oc new-project` / `oc project`. In this level you will log in to the CLI, create your first Project, and deploy both a bare Pod and a Deployment.',
    examObjectives: [
      'Manage OpenShift Container Platform > Use the web console to manage and configure an OpenShift cluster',
      'Manage OpenShift Container Platform > Use the command-line interface to manage and configure an OpenShift cluster',
      'Manage OpenShift Container Platform > Create and delete projects',
      'Manage OpenShift Container Platform > Use product documentation',
    ],
    docsLinks: [DOCS.cli, DOCS.projects, DOCS.console],
    startingUser: null, // starts logged out: `oc login -u kubeadmin` is part of the level
    startingResources: [node('node-1'), node('node-2')],
    availableResources: ['Project', 'Pod', 'Deployment', 'Node'],
    objectives: [
      { type: 'login', user: 'kubeadmin', label: 'Log in to the CLI as kubeadmin (oc login)' },
      { type: 'project', name: 'first-project', label: 'Create the Project "first-project"' },
      {
        type: 'deploy',
        kind: 'Pod',
        name: 'hello-pod',
        running: true,
        label: 'Run a bare Pod named "hello-pod" that reaches Running',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'hello-deploy',
        running: true,
        label: 'Create the Deployment "hello-deploy" with an available replica',
      },
    ],
    incidents: [],
    hints: [
      'Log in first. The installer saves the kubeadmin password in its auth directory: `cat ~/auth/kubeadmin-password`, then `oc login -u kubeadmin` and type (paste) that password at the `Password:` prompt — or pass it directly with `oc login -u kubeadmin -p <password>`. The kubeadmin secret does NOT contain the password: `oc extract secret/kubeadmin -n kube-system --to=-` prints only a bcrypt hash of it (a `$2a$10$…` hash). Check `oc whoami` afterwards.',
      'Create the project: `oc new-project first-project --display-name="First Project"`. `oc project` shows the current project.',
      'Create a Deployment: `oc create deployment hello-deploy --image=quay.io/openshift/origin-hello-openshift:latest`, then verify `oc get deployments,pods`. The level also asks for a bare Pod — `oc run hello-pod --image=quay.io/openshift/origin-hello-openshift:latest` deploys one, and the Pod view mirrors `oc describe pod`.',
      'Trap worth knowing (not required here): a bare `oc run hello-pod --image=nginx:latest` is ADMITTED by `restricted-v2` — admission only validates the pod spec, not the image USER — and then crashes, because nginx cannot write `/var/cache/nginx` under the arbitrary non-root UID it is assigned. Use a non-root image like `quay.io/openshift/origin-hello-openshift:latest` for a healthy workload.',
      'What IS rejected at admission: a Pod that explicitly requests `runAsUser: 0`, a `privileged: true` container or a host port (the controller shows FailedCreate and no Pod exists). If you tried the nginx trap, delete it before re-running with the supported image: `oc delete pod hello-pod`.',
    ],
    starCriteria: { time: 240, efficiency: 0.75, noFailures: true },
    nextLevel: 2,
    tutorial: {
      steps: [
        {
          target: 'command-bar',
          text: 'Press / to open the command bar. OpenShift commands start with oc. Read the kubeadmin password with cat ~/auth/kubeadmin-password, then log in with: oc login -u kubeadmin (type the password at the Password: prompt).',
        },
        {
          target: 'command-bar',
          text: 'Create your first Project: oc new-project first-project — Projects group and isolate your workloads.',
        },
        {
          target: 'cluster-view',
          text: 'Your Project is active. Deploy a pod with oc run hello-pod --image=quay.io/openshift/origin-hello-openshift:latest and watch it become Running.',
        },
        {
          target: 'inspector',
          text: 'Click the Pod to open the Inspector. The Describe tab mirrors `oc describe pod`.',
        },
        {
          target: 'palette',
          text: 'You can also deploy with the palette and with `oc create deployment hello-deploy --image=quay.io/openshift/origin-hello-openshift:latest`.',
        },
      ],
    },
  },

  {
    id: 2,
    title: 'Query, Format, Filter',
    chapter: 1,
    chapterName: 'Manage OpenShift',
    description:
      'Every EX280 task starts with `oc get`. Learn to query resources, filter them with label selectors, reshape output with `-o wide|yaml|json|jsonpath|custom-columns`, and ask the API for documentation with `oc explain`.',
    examObjectives: [
      'Manage OpenShift Container Platform > Use the command-line interface to manage and configure an OpenShift cluster',
      'Manage OpenShift Container Platform > Query, format, and filter attributes of Kubernetes resources',
      'Deploy applications > Work with labels and selectors',
    ],
    docsLinks: [DOCS.cli, DOCS.deployments],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('query-lab'),
      deployment('web', { replicas: 2 }),
    ],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Node'],
    objectives: [
      {
        type: 'command',
        pattern: 'oc get (deploy|deployment|deployments)',
        label: 'Use oc get to list Deployments',
      },
      {
        type: 'label',
        kind: 'Deployment',
        name: 'web',
        key: 'tier',
        value: 'frontend',
        label: 'Label Deployment web with tier=frontend',
      },
      {
        type: 'command',
        pattern: 'oc get .*(-o|--output)(=|\\s+)(wide|yaml|json|custom-columns|jsonpath|name)',
        label: 'Format output with -o wide/yaml/json/jsonpath',
      },
      {
        type: 'command',
        pattern: 'oc explain ',
        label: 'Use oc explain to inspect a resource schema',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'api',
        label: 'Create a second Deployment named "api"',
      },
    ],
    incidents: [],
    hints: [
      'Switch to the lab project: `oc project query-lab`, then list workloads with `oc get deployments -o wide`.',
      'Labels are how OpenShift selects resources: `oc label deployment/web tier=frontend` and query with `oc get deploy -l tier=frontend --show-labels`.',
      'Reshape output: `oc get deployment/web -o yaml`, `oc get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image`.',
      'Ask the API for docs: `oc explain deployment.spec.strategy --recursive`.',
      'Create the second Deployment with `oc create deployment api --image=quay.io/openshift/origin-hello-openshift:latest` (or deploy it from the palette).',
    ],
    starCriteria: { time: 300, efficiency: 0.75, noFailures: true },
    nextLevel: 3,
    tutorial: {
      steps: [
        {
          target: 'command-bar',
          text: 'Start with `oc project query-lab` and `oc get deployments`. Then format with `-o wide`.',
        },
        {
          target: 'inspector',
          text: 'Select the web Deployment and open the YAML tab — this is the same content as `oc get deployment/web -o yaml`.',
        },
      ],
    },
  },

  {
    id: 3,
    title: 'Logs, Events & Health',
    chapter: 1,
    chapterName: 'Manage OpenShift',
    description:
      'Production OpenShift is about reading symptoms: `oc logs`, `oc describe`, `oc get events`, `oc adm top`, ClusterOperators and ClusterVersion. An incident rolls an invalid `APP_MODE` value into the web-app Deployment: its container exits 1 on startup, so the NEW Pods are CrashLoopBackOff from their first start while the old Pods keep serving. Read the crash reason, fix the faulty configuration value (not just the Pod — adding an unrelated env var or restarting the Pod changes nothing), and bring cluster health back to 90%+.',
    examObjectives: [
      'Manage OpenShift Container Platform > Use the web console to manage and configure an OpenShift cluster',
      'Manage OpenShift Container Platform > Examine resources and cluster status',
      'Manage OpenShift Container Platform > Monitor cluster events and alerts',
      'Manage OpenShift Container Platform > View logs',
      'Manage OpenShift Container Platform > Assess the health of an OpenShift cluster',
      'Manage OpenShift Container Platform > Troubleshoot common container, pod, and cluster events and alerts',
      'Configure network security > Troubleshoot software defined networking',
    ],
    docsLinks: [DOCS.pods, DOCS.health, DOCS.cli],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('ops-lab'),
      // The level starts HEALTHY; the CrashLoopBackOff incident rolls the bad
      // APP_MODE value into the Deployment template (seed below), exactly like
      // L20. The crash is therefore honest from the first start of the NEW
      // Pods — the old ones keep serving until the rollout is corrected (#75).
      deployment('web-app', { replicas: 2 }),
    ],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Node'],
    objectives: [
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'web-app',
        label: 'Keep the web-app Deployment present while you investigate',
      },
      {
        type: 'command',
        pattern: 'oc (get|describe) pods?',
        label: 'Inspect Pods with oc get/oc describe',
      },
      { type: 'command', pattern: 'oc logs ', label: 'Read container logs with oc logs' },
      {
        type: 'investigate',
        incidentType: 'CrashLoopBackOff',
        progress: 0.5,
        label: 'Investigate the CrashLoopBackOff incident',
      },
      {
        type: 'resolve',
        incidentType: 'CrashLoopBackOff',
        count: 1,
        label: 'Resolve the CrashLoopBackOff',
      },
      { type: 'clusterHealth', minPercent: 90, label: 'Restore cluster health to 90% or better' },
    ],
    incidents: [
      {
        type: 'CrashLoopBackOff',
        triggerTime: 10,
        target: 'web-app',
        severity: 2,
        // Issue #75: the incident rolls the invalid APP_MODE into the
        // Deployment template (the level starts healthy), so the replacement
        // Pods crash from their FIRST start instead of healthy Pods mutating in
        // place. The incident only clears when that value is CORRECTED — not
        // when any other env/annotation changes (issue #31).
        seed: {
          env: { name: 'APP_MODE', value: 'debug-invalid' },
        },
        fix: {
          env: {
            name: 'APP_MODE',
            allowed: ['production', 'prod', 'development', 'dev'],
          },
        },
      },
    ],
    hints: [
      'Switch projects: `oc project ops-lab`. The Deployment was healthy until the incident rolled a bad env value into its template — the NEW Pods crash from their first start (no restart can fix a wrong configuration), while the old Pods keep serving. `oc get pods` and click a failing Pod for Inspector → Events.',
      'Read the crash output: `oc logs <pod> --previous` — `configuration validation failed: APP_MODE has an unsupported value`. `oc describe pod <pod>` shows a growing restart count and Back-off restarting failed container from the Pod’s own first start.',
      'Correlate events: `oc get events --sort-by=.lastTimestamp`, and check cluster operators with `oc get clusteroperators`.',
      'Inspect the fault: `oc describe deployment/web-app` shows the rollout is not progressing, and `oc get deployment/web-app -o yaml` shows the container env sets `APP_MODE=debug-invalid`. Correct the TEMPLATE value: `oc set env deployment/web-app APP_MODE=production` — the controller then rolls out fresh Pods. Anything else fails: `oc set env deployment/web-app FOO=bar` (unrelated variable), `oc rollout restart` and deleting a crashing Pod only recreate the same broken configuration, so the incident keeps firing.',
      'Related trap (admission ≠ runtime): a `nginx:latest` Pod is ADMITTED by `restricted-v2` — the SCC validates the pod spec, not the image USER — and then crashes with `mkdir "/var/cache/nginx/client_temp" failed (13: Permission denied)`. Check the image USER before blaming the SCC; a Pod that explicitly requests `runAsUser: 0` IS rejected at admission (FailedCreate).',
    ],
    starCriteria: { time: 360, efficiency: 0.7, noFailures: false },
    nextLevel: 4,
  },

  {
    id: 4,
    title: 'Declarative Manifests',
    chapter: 1,
    chapterName: 'Manage OpenShift',
    description:
      'Stop typing commands and start applying YAML. Edit the provided `manifests/deployment.yaml` and `manifests/service.yaml` in the Files panel, apply them with `oc apply -f`, then export the live object with `oc get -o yaml`. This is the core V422 "Declarative Resource Management" workflow.',
    examObjectives: [
      'Manage OpenShift Container Platform > Use the command-line interface to manage and configure an OpenShift cluster',
      'Manage OpenShift Container Platform > Import, export, and configure Kubernetes resources',
      'Declarative Resource Management > Work with resource manifests',
      'Declarative Resource Management > Deploy applications from YAML resource manifests',
      'Declarative Resource Management > Update application deployments',
    ],
    docsLinks: [DOCS.cli, DOCS.creating, DOCS.deployments],
    startingResources: [node('node-1'), node('node-2'), project('manifests-lab')],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Route', 'Node'],
    manifestFiles: ['manifests/deployment.yaml', 'manifests/service.yaml'],
    focusFiles: ['manifests/deployment.yaml', 'manifests/service.yaml'],
    objectives: [
      {
        type: 'manifest',
        file: 'manifests/deployment.yaml',
        label: 'Apply manifests/deployment.yaml with oc apply -f',
      },
      {
        type: 'manifest',
        file: 'manifests/service.yaml',
        label: 'Apply manifests/service.yaml with oc apply -f',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'webapp',
        label: 'Deployment "webapp" exists in the cluster',
      },
      {
        type: 'deploy',
        kind: 'Service',
        name: 'webapp',
        label: 'Service "webapp" exists in the cluster',
      },
      {
        type: 'command',
        pattern: 'oc get .*-(o|--output)(=|\\s+)(yaml|json)',
        label: 'Export a live resource with oc get -o yaml/json',
      },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project manifests-lab`. Open the Files panel and review `manifests/deployment.yaml`.',
      'Apply the manifests: `oc apply -f manifests/deployment.yaml` then `oc apply -f manifests/service.yaml`.',
      'Re-apply after an edit is safe and idempotent — edit the YAML in the Files panel, `oc apply -f manifests/deployment.yaml` again, then compare with `oc get deployment webapp -o yaml`.',
      'Export the live object: `oc get deployment/webapp -o yaml > /tmp/webapp.yaml` (the download/editor keeps it in the virtual file system).',
    ],
    starCriteria: { time: 300, efficiency: 0.8, noFailures: true },
    nextLevel: 5,
  },

  // ═══════════════════════ CHAPTER 2 — DECLARATIVE & KUSTOMIZE ═══════════════════════
  {
    id: 5,
    title: 'Kustomize Base',
    chapter: 2,
    chapterName: 'Declarative & Kustomize',
    description:
      'Kustomize lets you own one base set of manifests and reuse it everywhere. Render the `kustomize/base` directory and apply it with `oc apply -k`, then verify the generated Deployment and Service.',
    examObjectives: ['Declarative Resource Management > Deploy applications using Kustomize'],
    docsLinks: [DOCS.cli, DOCS.creating],
    startingResources: [node('node-1'), node('node-2'), project('kustomize-lab')],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Node'],
    manifestFiles: [
      'kustomize/base/kustomization.yaml',
      'kustomize/base/deployment.yaml',
      'kustomize/base/service.yaml',
    ],
    focusFiles: ['kustomize/base/kustomization.yaml'],
    objectives: [
      {
        type: 'kustomize',
        path: 'kustomize/base',
        label: 'Apply the Kustomize base with oc apply -k kustomize/base',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'webapp',
        label: 'The base Deployment "webapp" was created',
      },
      { type: 'command', pattern: 'oc apply -k ', label: 'Use oc apply -k (Kustomize rendering)' },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project kustomize-lab`. Preview the render with `oc kustomize kustomize/base`, then apply it with `oc apply -k kustomize/base`.',
      'Apply the base: `oc apply -k kustomize/base`.',
      'Verify with `oc get deployments,services` — the base creates a Deployment and a Service both named webapp.',
      'Edit `kustomize/base/deployment.yaml` (for example replicas) and re-run `oc apply -k kustomize/base` to see the change.',
    ],
    starCriteria: { time: 300, efficiency: 0.8, noFailures: true },
    nextLevel: 6,
  },

  {
    id: 6,
    title: 'Kustomize Overlays',
    chapter: 2,
    chapterName: 'Declarative & Kustomize',
    description:
      'Overlays apply environment-specific changes on top of a base: namespace, name prefix, image tag, replica count and patches. Apply the prod overlay and verify the prefixed Deployment lands in the webapp-prod project with 3 replicas and the pinned image patch.',
    examObjectives: ['Declarative Resource Management > Work with Kustomize overlays'],
    docsLinks: [DOCS.cli, DOCS.deployments],
    startingResources: [node('node-1'), node('node-2'), project('webapp-prod')],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Node'],
    manifestFiles: [
      'kustomize/overlays/prod/kustomization.yaml',
      'kustomize/overlays/prod/patch-deployment.yaml',
    ],
    focusFiles: [
      'kustomize/overlays/prod/kustomization.yaml',
      'kustomize/overlays/prod/patch-deployment.yaml',
    ],
    objectives: [
      {
        type: 'kustomize',
        path: 'kustomize/overlays/prod',
        label: 'Apply the prod overlay with oc apply -k kustomize/overlays/prod',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'prod-webapp',
        label: 'Prefixed Deployment "prod-webapp" exists',
      },
      {
        type: 'scale',
        kind: 'Deployment',
        name: 'prod-webapp',
        replicas: 3,
        label: 'prod-webapp runs 3 replicas (replica override)',
      },
      {
        type: 'image',
        kind: 'Deployment',
        name: 'prod-webapp',
        imageContains: 'origin-hello-openshift',
        label: 'prod-webapp uses the patched webapp image',
      },
      {
        type: 'command',
        pattern: 'oc apply -k ',
        label: 'Use oc apply -k on the overlay directory',
      },
    ],
    incidents: [],
    hints: [
      'Preview the render first with `oc kustomize kustomize/overlays/prod` (note the `prod-` name prefix, namespace webapp-prod, image tag and replicas), then apply it with `oc apply -k kustomize/overlays/prod`.',
      'Apply the overlay: `oc apply -k kustomize/overlays/prod`.',
      'Verify the namespaced object: `oc get deployment -n webapp-prod` should show `prod-webapp` with 3 desired replicas.',
      'The strategic-merge patch in `patch-deployment.yaml` adds the APP_ENV=production env var and resource requests. Try `oc get deploy prod-webapp -n webapp-prod -o yaml`.',
    ],
    starCriteria: { time: 360, efficiency: 0.75, noFailures: true },
    nextLevel: 7,
  },

  {
    id: 7,
    title: 'Secrets & ConfigMaps',
    chapter: 2,
    chapterName: 'Declarative & Kustomize',
    description:
      'Configuration belongs outside the image. Create a ConfigMap and a Secret, consume the ConfigMap as a mounted volume and the Secret as environment variables, and make sure no sensitive key leaks into a ConfigMap.',
    examObjectives: [
      'Declarative Resource Management > Create and use secrets',
      'Declarative Resource Management > Create and use configuration maps',
      'Configure application security > Create and apply secrets to manage sensitive information',
    ],
    docsLinks: [DOCS.pods, DOCS.cli, DOCS.deployments],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('config-lab'),
      deployment('app', { replicas: 2 }),
    ],
    availableResources: ['Project', 'Deployment', 'Pod', 'ConfigMap', 'Secret'],
    objectives: [
      {
        type: 'deploy',
        kind: 'ConfigMap',
        name: 'app-config',
        label: 'Create the ConfigMap "app-config"',
      },
      { type: 'deploy', kind: 'Secret', name: 'db-secret', label: 'Create the Secret "db-secret"' },
      {
        type: 'mount',
        kind: 'ConfigMap',
        count: 1,
        label: 'Mount a ConfigMap into a workload volume',
      },
      {
        type: 'envFrom',
        kind: 'Secret',
        count: 1,
        label: 'Consume the Secret as environment variables',
      },
      {
        type: 'noConfigMap',
        sensitive: true,
        label: 'No ConfigMap contains password/secret/token/key data',
      },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project config-lab`. Create the config: `oc create configmap app-config --from-literal=APP_MODE=production`.',
      'Create the secret: `oc create secret generic db-secret --from-literal=password=s3cret`.',
      'Consume configuration as envFrom: run `oc set env deployment/app --from=configmap/app-config` and then `oc set env deployment/app --from=secret/db-secret`.',
      'Mount the ConfigMap as a volume with real oc flags: `oc set volume deployment/app --add --name=cfg --type=configmap --configmap-name=app-config --mount-path=/etc/app`. List volumes with `oc set volumes deployment/app`; remove one with `oc set volume deployment/app --remove --name=cfg`.',
      'Verify with `oc get configmap,secret` and `oc get deployment/app -o yaml`.',
    ],
    starCriteria: { time: 360, efficiency: 0.75, noFailures: true },
    nextLevel: 8,
  },

  {
    id: 8,
    title: 'Templates & Helm',
    chapter: 2,
    chapterName: 'Declarative & Kustomize',
    description:
      'Application Templates are parameterised object lists that ship with an app; Helm charts package workloads. Process `templates/webapp-template.yaml` with `oc process`, apply the result, then install the `helm/webapp` chart and list the release. (Project templates — the bootstrap `project-request` Template used by `oc new-project` — are covered in Level 15.)',
    examObjectives: [
      'Deploy applications > Deploy applications from templates and Helm charts',
      'Deploy applications > Manage application deployments',
    ],
    docsLinks: [DOCS.creating, DOCS.helm],
    startingResources: [node('node-1'), node('node-2'), project('template-lab')],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Route', 'Template'],
    manifestFiles: [
      'templates/webapp-template.yaml',
      'helm/webapp/Chart.yaml',
      'helm/webapp/values.yaml',
    ],
    focusFiles: ['templates/webapp-template.yaml', 'helm/webapp/values.yaml'],
    objectives: [
      {
        type: 'template',
        name: 'webapp-template',
        parameters: { APP_NAME: 'web' },
        label: 'Process webapp-template with APP_NAME=web and apply it',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'web',
        label: 'The templated Deployment "web" exists',
      },
      {
        type: 'helm',
        release: 'shop',
        chart: 'webapp',
        label: 'Install the Helm release "shop" from the webapp chart',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'shop',
        label: 'The Helm release created Deployment "shop"',
      },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project template-lab`. Inspect parameters with `oc process --parameters -f templates/webapp-template.yaml`.',
      'Process and create in one pipeline: `oc process -f templates/webapp-template.yaml -p APP_NAME=web | oc apply -f -`.',
      'Render only with `oc process -f templates/webapp-template.yaml -p APP_NAME=web -o yaml` if you want to inspect first.',
      'Install the chart: `helm install shop helm/webapp`, then confirm with `helm list`.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: true },
    nextLevel: 9,
  },

  // ═══════════════════════ CHAPTER 3 — DEPLOY & EXPOSE ═══════════════════════
  {
    id: 9,
    title: 'Images, Builds & Image Streams',
    chapter: 3,
    chapterName: 'Deploy & Expose',
    description:
      'OpenShift builds images from source: a BuildConfig produces a Build, the Build pushes into an ImageStream, and Deployments consume ImageStreamTags. Create an app from source, start a build, watch it complete, then examine tags and digests.',
    examObjectives: [
      'Manage OpenShift Container Platform > Locate and examine container images',
      'Manage OpenShift Container Platform > Identify images using tags and digests',
    ],
    docsLinks: [DOCS.builds, DOCS.startBuild, DOCS.imageStreams, DOCS.imageTriggers],
    startingResources: [node('node-1'), node('node-2'), project('build-lab')],
    availableResources: [
      'Project',
      'BuildConfig',
      'Build',
      'ImageStream',
      'Deployment',
      'Pod',
      'Service',
      'Route',
      'Node',
    ],
    manifestFiles: ['examples/buildconfig.yaml'],
    focusFiles: ['examples/buildconfig.yaml'],
    objectives: [
      {
        type: 'build',
        name: 'webapp',
        count: 1,
        label: 'A Build for the webapp BuildConfig reaches phase Complete',
      },
      {
        type: 'imageStream',
        name: 'webapp',
        tag: 'latest',
        label: 'ImageStream webapp has the :latest tag',
      },
      { type: 'command', pattern: 'oc start-build ', label: 'Start a build with oc start-build' },
      {
        type: 'command',
        pattern: 'oc (get|describe) (is|imagestream|imagestreamtag|istag)',
        label: 'Examine images with oc get/describe is',
      },
      {
        type: 'image',
        kind: 'Deployment',
        imageContains: 'webapp',
        label: 'A Deployment references the built webapp image',
      },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project build-lab`. Create the build from source with `oc new-app openshift/nodejs:20-ubi9~https://github.com/openshift/nodejs-ex --name=webapp` (OCP 4.22 sample builder tags carry the `-ubi9` suffix).',
      'Watch the build: `oc logs -f bc/webapp` or `oc start-build webapp --follow`. The Build runs New → Pending → Running → Complete.',
      'Inspect the ImageStream: `oc get is webapp`, `oc describe istag/webapp:latest` — note the digest and internal registry pull spec.',
      'If your app came from the example BuildConfig instead, start it with `oc start-build webapp --follow`, then point a Deployment at the internal registry: `image: image-registry.openshift-image-registry.svc:5000/build-lab/webapp:latest` (a bare `image: webapp:latest` is not resolved to the project ImageStream without an image trigger).',
    ],
    starCriteria: { time: 480, efficiency: 0.7, noFailures: false },
    nextLevel: 10,
  },

  {
    id: 10,
    title: 'Rolling Updates & Rollbacks',
    chapter: 3,
    chapterName: 'Deploy & Expose',
    description:
      'Deployments roll out image changes through ReplicaSets. Update `api-server` to a new image, watch the rollout, then discover the new image is bad (ImagePullBackOff) and roll back with `oc rollout undo` while keeping availability above 90%.',
    examObjectives: [
      'Manage OpenShift Container Platform > Troubleshoot common container, pod, and cluster events and alerts',
      'Declarative Resource Management > Update application deployments',
      'Deploy applications > Manage application deployments',
      'Deploy applications > Work with replica sets',
    ],
    docsLinks: [DOCS.deployments, DOCS.cli, DOCS.health],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('rollout-lab'),
      deployment('api-server', {
        replicas: 3,
        image: 'quay.io/openshift/origin-hello-openshift:latest',
        progressDeadlineSeconds: 45,
        resources: {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        },
      }),
    ],
    availableResources: ['Project', 'Deployment', 'ReplicaSet', 'Pod', 'Service', 'Node'],
    objectives: [
      {
        type: 'update',
        kind: 'Deployment',
        name: 'api-server',
        label: 'Trigger a rolling update of api-server',
      },
      { type: 'rollback', count: 1, label: 'Roll the Deployment back with oc rollout undo' },
      {
        type: 'uptime',
        percentage: 90,
        label: 'Keep availability at 90% or better during the rollout',
      },
    ],
    // The bad-image rollout is the incident: the new ReplicaSet Pods stay in
    // ImagePullBackOff, `oc rollout status` fails with the progress deadline,
    // and `oc rollout undo` is the remediation. No scripted incident needed.
    incidents: [],
    hints: [
      'Switch projects: `oc project rollout-lab`. Trigger the update: `oc set image deployment/api-server main=quay.io/openshift/origin-hello-openshift:does-not-exist`.',
      'Watch the rollout block: `oc rollout status deployment/api-server` waits, then fails with `error: deployment "api-server" exceeded its progress deadline` (progressDeadlineSeconds is 45 on this Deployment). The new pods stay ImagePullBackOff; the old ReplicaSet keeps serving — check `oc get rs` and `oc rollout history deployment/api-server`.',
      'The bad image never becomes available. Revert with `oc rollout undo deployment/api-server` and confirm `oc rollout status deployment/api-server` and `oc get pods` are healthy again.',
      'The ImagePullBackOff incident clears once the Deployment template is rolled back to the good image; the Incident panel resolution action is the alternative path.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: false },
    nextLevel: 11,
  },

  {
    id: 11,
    title: 'Services & Routes',
    chapter: 3,
    chapterName: 'Deploy & Expose',
    description:
      'Pods are ephemeral; Services give them stable endpoints and Routes expose them outside the cluster. Create a Service that selects your Deployment, expose it as an edge-TLS Route, verify it is Admitted, and store the TLS material in a Secret.',
    examObjectives: [
      'Declarative Resource Management > Deploy applications from YAML resource manifests',
      'Deploy applications > Work with labels and selectors',
      'Deploy applications > Configure services',
      'Deploy applications > Expose applications to external access',
      'Configure network security > Configure networking components',
      'Configure network security > Troubleshoot software defined networking',
      'Configure network security > Create and edit external routes',
      'Configure network security > Secure external and internal traffic using TLS certificates',
    ],
    docsLinks: [DOCS.routes, DOCS.cli, DOCS.deployments],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('route-lab'),
      deployment('web', { replicas: 2 }),
    ],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Route', 'Secret', 'Node'],
    objectives: [
      {
        type: 'deploy',
        kind: 'Service',
        name: 'web',
        label: 'Create Service "web" selecting the web Deployment',
      },
      {
        type: 'connect',
        from: 'web',
        to: 'web',
        label: 'The Service selector matches the web workload',
      },
      {
        type: 'route',
        name: 'web',
        termination: 'edge',
        label: 'Create an edge Route "web" and get it Admitted',
      },
      {
        type: 'tls',
        enabled: true,
        termination: 'edge',
        label: 'Terminate TLS at the Route (edge)',
      },
      { type: 'deploy', kind: 'Secret', name: 'web-tls', label: 'Create the TLS Secret "web-tls"' },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project route-lab`. Create the Service: `oc create service clusterip web --tcp=8080:8080` (it selects app=web).',
      'Expose it with TLS at the Route: `oc create route edge web --service=web` (omit the name to name the Route after the Service) — then `oc get route` shows the generated host and Admitted status.',
      'Know the two expose forms: `oc expose svc/web --name=web-public --path=/api` creates a Route from an existing Service, while `oc expose deployment/<name>` creates ONLY a Service and never a Route (try it on another project/Deployment, not on web which already has a Service).',
      'Create real TLS material, then the Secret: `openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=web.apps.cluster.example.com"`, then `oc create secret tls web-tls --cert=tls.crt --key=tls.key` — `oc create secret tls` reads those files from the virtual filesystem and fails with `error: open tls.crt: no such file or directory` when they are missing (edge Routes can use the router default certificate, but the Secret itself must be real).',
      'Verify: `oc describe route web` — look for TLS Termination: edge and the Admitted condition.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: true },
    nextLevel: 12,
  },

  {
    id: 12,
    title: 'Non-HTTP & Load Balancer',
    chapter: 3,
    chapterName: 'Deploy & Expose',
    description:
      'HTTP Routes are not the only way to expose an app. Install the MetalLB operator, create a LoadBalancer Service that receives an EXTERNAL-IP, and expose a TLS-serving non-HTTP backend (nginx on 8443) with a passthrough Route that targets the Service port by name.',
    examObjectives: [
      'Deploy applications > Expose applications to external access',
      'Configure network security > Configure networking components',
      'Configure network security > Create and edit external routes',
      'Configure network security > Secure external and internal traffic using TLS certificates',
      'Expose non-HTTP/SNI Applications > Configure a load balancer service',
      'Expose non-HTTP/SNI Applications > Configure external application access',
      'Manage OpenShift operators > Install an operator',
    ],
    docsLinks: [DOCS.metallb, DOCS.routes, DOCS.operatorOlm],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('lb-lab'),
      // Self-consistent non-HTTP TLS fixture (issue #75): the nginx personality
      // serves TLS on 8443; the Service publishes port 443 named `https` and
      // targets the named container port. A passthrough Route therefore points
      // at a real TLS backend, and `curl -k https://<route-host>` answers 200.
      // Use the UBI nginx image: it runs as non-root, so restricted-v2 admits
      // and runs it — a bare `nginx:latest` is admitted but crashes as UID 0
      // (mkdir /var/cache/nginx … Permission denied), leaving 0 endpoints.
      deployment('tls-app', {
        replicas: 2,
        image: 'registry.access.redhat.com/ubi9/nginx-122:latest',
        containerPort: 8443,
        containerPortName: 'https',
      }),
      service('tls-app', {
        namespace: 'lb-lab',
        app: 'tls-app',
        port: 443,
        portName: 'https',
        targetPort: 8443,
      }),
    ],
    availableResources: [
      'Project',
      'Deployment',
      'Pod',
      'Service',
      'Route',
      'Subscription',
      'IPAddressPool',
      'L2Advertisement',
      'Node',
    ],
    manifestFiles: [
      'examples/subscription.yaml',
      'examples/operatorgroup.yaml',
      'examples/metallb.yaml',
    ],
    focusFiles: [
      'examples/operatorgroup.yaml',
      'examples/subscription.yaml',
      'examples/metallb.yaml',
    ],
    objectives: [
      {
        type: 'operator',
        name: 'metallb-operator',
        installed: true,
        label: 'Install the MetalLB operator (CSV metallb-operator.v4.22.0-202610281200 Succeeded)',
      },
      {
        type: 'serviceType',
        kind: 'LoadBalancer',
        count: 1,
        label: 'Create a Service of type LoadBalancer',
      },
      {
        type: 'route',
        name: 'tls-app',
        service: 'tls-app',
        termination: 'passthrough',
        label: 'Expose tls-app with a passthrough Route targeting the Service port name https',
      },
      {
        type: 'tls',
        enabled: true,
        termination: 'passthrough',
        label: 'Passthrough TLS termination is configured',
      },
    ],
    incidents: [],
    hints: [
      'Find the catalog package: `oc get packagemanifests -n openshift-marketplace` lists `metallb-operator` (the redhat-operators package name is `metallb-operator`, not `metallb`); `oc describe packagemanifests metallb-operator -n openshift-marketplace` shows channel `stable` and currentCSV.',
      'Install the operator the 4.x way: `oc new-project metallb-system`, then apply the shipped single-namespace OperatorGroup: `oc apply -f examples/operatorgroup.yaml`. A Subscription without a matching OperatorGroup never installs.',
      'Edit `examples/subscription.yaml` so `spec.name` is `metallb-operator`, metadata.name is `metallb-operator` and metadata.namespace is `metallb-system`, then `oc apply -f examples/subscription.yaml`. OLM creates an InstallPlan and then the CSV `metallb-operator.v4.22.0-202610281200` in metallb-system. A misspelled/old package (`metallb`) fails with ResolutionFailed "no operators found in package".',
      'Verify OLM: `oc get sub,csv,installplan -n metallb-system` — the ClusterServiceVersion (not the Subscription) moves Installing → Succeeded; `oc get csv -n metallb-system` shows `metallb-operator.v4.22.0-202610281200` and `oc get subscription -n metallb-system -o yaml` shows `status.installedCSV`.',
      'Create the operand: `oc apply -f examples/metallb.yaml` (MetalLB CR + IPAddressPool + L2Advertisement in metallb-system), then `oc get pods -n metallb-system` shows the controller/speaker Pods.',
      'Create the LoadBalancer Service in lb-lab: `oc project lb-lab` then `oc create service loadbalancer lb --tcp=443:443`; `oc get svc lb` now gets an EXTERNAL-IP from the pool (MetalLB reports it with a `Normal IPAllocated Assigned IP ["192.168.100.200"]` event — `oc describe svc lb` / `oc get events`).',
      'Check the seeded TLS app: `oc get deploy,svc,pods -n lb-lab` — the UBI nginx image serves TLS on container port 8443 (`https`), and the Service tls-app maps port 443 named `https` to it. A passthrough Route to a plain-HTTP backend would fail the TLS handshake, which is why this fixture is TLS end to end.',
      'Expose the non-HTTP app with a passthrough Route: `oc create route passthrough tls-app --service=tls-app` — the Route gets `spec.port.targetPort: https` (the Service port NAME, not the 8443 number). Confirm `oc describe route tls-app` shows passthrough TLS and Admitted=True, then `curl -k https://<route-host>` returns the nginx page (200).',
    ],
    starCriteria: { time: 480, efficiency: 0.65, noFailures: false },
    nextLevel: 13,
  },

  // ═══════════════════════ CHAPTER 4 — IDENTITY, RBAC & SELF-SERVICE ═══════════════════════
  {
    id: 13,
    title: 'HTPasswd & Users',
    chapter: 4,
    chapterName: 'Identity, RBAC & Self-service',
    description:
      'OpenShift authenticates through identity providers. Configure an HTPasswd provider: create users in the virtual htpasswd file, store it in a Secret in openshift-config, reference it from the OAuth cluster resource, then log in as the new user. Then cover the two lifecycle tasks EX280 expects: rotate that user password the real way (extract the secret, change the hash with `htpasswd`, write it back with `oc set data`, wait for the OAuth rollout and log in with the new password) and clean up a departing user — deleting the User does NOT remove its Identity, so both objects have to go.',
    examObjectives: [
      'Manage authentication and authorization > Configure the HTPasswd identity provider for authentication',
      'Manage authentication and authorization > Create and delete users',
      'Manage authentication and authorization > Modify user passwords',
    ],
    docsLinks: [DOCS.idp, DOCS.usersGroups, DOCS.cli],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('identity-lab'),
      // Cleanup target for the "create and delete users" bullet: the departing
      // user bob already has a User AND an Identity (created on an earlier
      // login), so deleting the User leaves the Identity behind until it is
      // deleted too (real OpenShift 4.x semantics).
      { kind: 'User', name: 'bob', spec: { fullName: 'Bob (departing contractor)', groups: [] } },
      {
        kind: 'Identity',
        name: 'htpasswd:bob',
        spec: { providerName: 'htpasswd', providerUserName: 'bob', user: { name: 'bob' } },
      },
    ],
    availableResources: ['Project', 'User', 'Identity', 'Secret', 'OAuth', 'Group'],
    objectives: [
      {
        type: 'command',
        pattern: 'htpasswd ',
        label: 'Add a user to the htpasswd file (htpasswd -c/-b)',
      },
      {
        // Issue #71: grade the resulting identity-provider state, not a hidden
        // Secret name. Any Secret the OAuth singleton references counts once
        // the auth rollout applied it (the shipped `htpass-secret` is only the
        // example name used by the hints).
        type: 'oauthProvider',
        providerType: 'HTPasswd',
        secretReferenced: true,
        label: 'Create the htpasswd Secret and reference it from the OAuth identity provider',
      },
      { type: 'user', name: 'alice', label: 'User "alice" exists after first login' },
      { type: 'login', user: 'alice', label: 'Log in to the CLI as alice' },
      {
        // Issue #71: state-graded rotation — the player's own new password
        // counts. No literal password is hard-coded; the objective proves the
        // hash changed after an earlier successful login and that a later
        // login authenticated the new hash.
        type: 'password',
        user: 'alice',
        rotate: true,
        requireLogin: true,
        label:
          'Rotate alice’s htpasswd password and log in with the new password (extract → htpasswd → oc set data → OAuth rollout)',
      },
      {
        type: 'user',
        name: 'bob',
        exists: false,
        label: 'Delete the departing User "bob" (oc delete user bob)',
      },
      {
        type: 'identity',
        user: 'bob',
        exists: false,
        label: 'Delete bob’s Identity too (oc delete identity htpasswd:bob)',
      },
    ],
    incidents: [],
    hints: [
      'Add a user to the virtual htpasswd file with bcrypt hashes: `htpasswd -c -B -b htpasswd alice <password>` (or `htpasswd -B -b htpasswd alice <password>` to add another).',
      'Create the Secret: `oc create secret generic htpass-secret --from-file=htpasswd -n openshift-config`. The key must be named `htpasswd`; the Secret NAME is your choice — the objective grades that the OAuth provider references a real Secret with that key (the hints/examples use `htpass-secret`).',
      'Configure the provider: `oc edit oauth cluster` and add an HTPasswd identityProvider referencing `htpass-secret` (mappingMethod: claim).',
      'Wait for the authentication operator to roll out, then `oc login -u alice -p <password>` and confirm with `oc whoami`.',
      'Going back to cluster-admin after logging in as alice: the installer keeps the kubeadmin password in its auth directory — `cat ~/auth/kubeadmin-password`, then `oc login -u kubeadmin -p <password>` (or log in without `-p` and type it at the `Password:` prompt). The kube-system/kubeadmin Secret stores only a bcrypt hash (`oc extract secret/kubeadmin -n kube-system --to=-` prints `$2a$10$…`), so it cannot recover the password. The exam-relevant use of that secret is removing kubeadmin once another cluster-admin exists: `oc delete secret kubeadmin -n kube-system`.',
      'Rotate the password the exam way with YOUR OWN new password: `oc extract secret/htpass-secret -n openshift-config --to /tmp --confirm`, then `htpasswd -bB /tmp/htpasswd alice "<new-password>"`, then `oc set data secret/htpass-secret -n openshift-config --from-file=htpasswd=/tmp/htpasswd`. The authentication operator watches the secret, restarts the oauth-openshift pods and keeps the old password until the rollout completes — logging in too early is rejected, so wait for `oc get clusteroperators authentication` and then `oc login -u alice -p "<new-password>"`. The objective is graded on state (alice’s hash changed after a successful login and a later login with the new password succeeds), so any new password works.',
      'Clean up the departing user: `oc delete user bob` removes the User but leaves the Identity `htpasswd:bob` behind (a stale login mapping), so finish with `oc delete identity htpasswd:bob` and verify `oc get users` / `oc get identities` are clean.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: true },
    nextLevel: 14,
  },

  {
    id: 14,
    title: 'Groups & RBAC',
    chapter: 4,
    chapterName: 'Identity, RBAC & Self-service',
    description:
      'Grant permissions with least privilege. Create users and a group, bind a role to the group in a project, prove the access with `oc auth can-i`, and resolve an UnauthorizedAccess incident — the denial is visible in the application log (`oc logs deploy/web`), not in Kubernetes events — without creating wildcard roles.',
    examObjectives: [
      'Manage authentication and authorization > Create and manage groups',
      'Manage authentication and authorization > Modify user and group permissions',
    ],
    docsLinks: [DOCS.rbac, DOCS.usersGroups],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('rbac-lab'),
      deployment('web', { replicas: 2 }),
      { kind: 'User', name: 'alice', spec: { fullName: 'Alice Developer', groups: [] } },
      { kind: 'User', name: 'bob', spec: { fullName: 'Bob Developer', groups: [] } },
    ],
    availableResources: [
      'Project',
      'User',
      'Group',
      'Role',
      'RoleBinding',
      'ServiceAccount',
      'Deployment',
      'Pod',
    ],
    objectives: [
      {
        type: 'group',
        name: 'developers',
        users: ['alice', 'bob'],
        label: 'Create Group "developers" with alice and bob',
      },
      {
        type: 'deploy',
        kind: 'RoleBinding',
        count: 1,
        label: 'Bind a role (edit/view) to the developers group in rbac-lab',
      },
      {
        type: 'canI',
        verb: 'get',
        resource: 'pods',
        user: 'alice',
        expected: true,
        label: 'alice can get pods in rbac-lab',
      },
      {
        type: 'leastPrivilege',
        label: 'No wildcard Roles/ClusterRoles and no extra cluster-admin bindings',
      },
      {
        type: 'resolve',
        incidentType: 'UnauthorizedAccess',
        count: 1,
        label: 'Resolve the UnauthorizedAccess incident',
      },
    ],
    incidents: [{ type: 'UnauthorizedAccess', triggerTime: 25, target: 'web', severity: 3 }],
    hints: [
      'Create the group: `oc adm groups new developers alice bob` (or `oc adm groups add-users developers alice bob`).',
      'Bind a role in the project: `oc adm policy add-role-to-group edit developers -n rbac-lab`. View it with `oc get rolebinding -n rbac-lab -o yaml`.',
      'Prove the access: `oc auth can-i get pods --as=alice -n rbac-lab` (and `oc auth can-i delete deployments --as=alice -n rbac-lab`).',
      'Avoid wildcards: create precise Roles or reuse built-in `view`/`edit`. The UnauthorizedAccess incident is a missing binding for the web workload ServiceAccount — repair it with `oc adm policy add-role-to-user view -z default -n rbac-lab` (or the incident panel); the incident clears as soon as the RoleBinding exists.',
      'Find the RBAC denial where a real cluster shows it: Kubernetes does not emit events for RBAC denials — the symptom is in the application log. `oc logs deploy/web -n rbac-lab` prints a line like `WARN failed to list pods for the cache sync: pods is forbidden: User "system:serviceaccount:rbac-lab:default" cannot list resource "pods" in API group "" in the namespace "rbac-lab"` once the incident is active; `oc get sa -n rbac-lab` shows the `default` ServiceAccount the workload runs as.',
      'End-state check: `oc adm groups remove-users developers bob` removes bob from the group on the spot — re-run `oc get groups` to confirm membership, because objectives are evaluated against the live cluster, not on a one-time tick.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: false },
    nextLevel: 15,
  },

  {
    id: 15,
    title: 'Quotas, LimitRanges & Templates',
    chapter: 4,
    chapterName: 'Identity, RBAC & Self-service',
    description:
      'Developer self-service needs guardrails. Apply a ResourceQuota and LimitRange from the example manifests, create a ClusterResourceQuota that spans projects, set resource requests/limits on the web Deployment, resolve a ResourceQuotaExceeded incident (the quota is full, so the ReplicaSet cannot create a replacement Pod — no Pod object appears, Used never exceeds Hard), then publish a project template: generate the bootstrap `project-request` template, add a guardrail object to it, store it in `openshift-config` and point `project.config.openshift.io/cluster` at it.',
    examObjectives: [
      'Manage OpenShift Container Platform > Create and delete projects',
      'Enable developer self-service > Configure cluster resource quotas',
      'Enable developer self-service > Configure project quotas',
      'Enable developer self-service > Configure project resource requirements',
      'Enable developer self-service > Configure project limit ranges',
      'Enable developer self-service > Configure project templates',
    ],
    docsLinks: [DOCS.quotas, DOCS.clusterResources, DOCS.projects],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('quota-lab'),
      deployment('web', { replicas: 2 }),
    ],
    availableResources: [
      'Project',
      'ResourceQuota',
      'ClusterResourceQuota',
      'LimitRange',
      'Deployment',
      'Pod',
      'Template',
    ],
    manifestFiles: ['examples/quota.yaml', 'examples/limitrange.yaml'],
    focusFiles: ['examples/quota.yaml', 'examples/limitrange.yaml'],
    objectives: [
      {
        type: 'deploy',
        kind: 'ResourceQuota',
        name: 'compute-quota',
        label: 'Create the project ResourceQuota "compute-quota"',
      },
      {
        type: 'deploy',
        kind: 'LimitRange',
        name: 'resource-limits',
        label: 'Create the LimitRange "resource-limits"',
      },
      {
        type: 'deploy',
        kind: 'ClusterResourceQuota',
        name: 'team-quota',
        label: 'Create the ClusterResourceQuota "team-quota"',
      },
      {
        type: 'resources',
        kind: 'Deployment',
        name: 'web',
        label: 'Set container requests+limits on the web Deployment',
      },
      {
        type: 'resolve',
        incidentType: 'ResourceQuotaExceeded',
        count: 1,
        label: 'Resolve the ResourceQuotaExceeded incident',
      },
      {
        type: 'command',
        pattern: 'oc adm create-bootstrap-project-template',
        label: 'Generate the bootstrap project template',
      },
      {
        type: 'deploy',
        kind: 'Template',
        name: 'project-request',
        namespace: 'openshift-config',
        label: 'Create the project-request Template in openshift-config',
      },
      {
        type: 'command',
        pattern: 'oc (edit|patch) project\\.config',
        label: 'Point project.config.openshift.io/cluster at the template',
      },
    ],
    incidents: [
      // The incident is injected against the namespace; IncidentEngine binds it
      // to the ResourceQuota that actually exists (issue #27b).
      { type: 'ResourceQuotaExceeded', triggerTime: 20, target: 'quota-lab', severity: 3 },
    ],
    hints: [
      'Switch projects: `oc project quota-lab`. Apply the example quota and limits: `oc apply -f examples/quota.yaml` and `oc apply -f examples/limitrange.yaml`.',
      'Create the multi-project quota: `oc create clusterquota team-quota --project-label-selector=kubernetes.io/metadata.name=quota-lab --hard=pods=10 --hard=secrets=20`.',
      'Set container resources: `oc set resources deployment/web --limits=cpu=500m,memory=512Mi --requests=cpu=100m,memory=128Mi`.',
      'Read the quota incident like a real cluster: `oc describe deployment/web -n quota-lab` shows a FailedCreate event ("exceeded quota: compute-quota, requested: pods=1, used: …, limited: …"), `oc get pods` shows NO extra Pending Pod, and `oc describe quota compute-quota` shows Used == Hard for pods (a real cluster never creates a Pod it cannot admit, so Used never exceeds Hard). Raise the guardrail to let the ReplicaSet replace the Pod: `oc patch quota compute-quota --type=merge -p \'{"spec":{"hard":{"pods":"5"}}}\'` then watch `oc get pods -n quota-lab` recover.',
      'Verify: `oc describe quota compute-quota`, `oc describe limits resource-limits`, `oc describe clusterresourcequota team-quota`. Then resolve the quota incident.',
      'Publish a project template: `oc adm create-bootstrap-project-template -o yaml > template.yaml`, add a NetworkPolicy object to the template object list (edit `template.yaml` in the Files panel; the shipped `templates/webapp-template.yaml` shows the object-list shape), then `oc create -f template.yaml -n openshift-config` and check `oc get templates -n openshift-config`.',
      'Point the cluster at the template: `oc edit project.config.openshift.io/cluster` and set `spec.projectRequestTemplate.name: project-request`, then `oc new-project template-check` and confirm the templated object was created. On a real cluster `oc edit` launches `$EDITOR` (vi/vim by default) in the terminal — the simulator opens its manifest editor; practise vim separately for the exam.',
    ],
    starCriteria: { time: 480, efficiency: 0.7, noFailures: false },
    nextLevel: 16,
  },

  {
    id: 16,
    title: 'Service Accounts & API Access',
    chapter: 4,
    chapterName: 'Identity, RBAC & Self-service',
    description:
      'Applications need their own identity when they call the Kubernetes API. Create a ServiceAccount, grant it read access with a RoleBinding, run the app as that ServiceAccount, and verify the access with `oc auth can-i --as=system:serviceaccount:...`.',
    examObjectives: [
      'Manage authentication and authorization > Modify user and group permissions',
      'Configure application security > Configure and manage service accounts',
      'Configure application security > Configure application access to Kubernetes APIs',
    ],
    docsLinks: [DOCS.serviceAccounts, DOCS.rbac, DOCS.cli],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('sa-lab'),
      deployment('api', { replicas: 2 }),
    ],
    availableResources: ['Project', 'ServiceAccount', 'Role', 'RoleBinding', 'Deployment', 'Pod'],
    objectives: [
      {
        type: 'deploy',
        kind: 'ServiceAccount',
        name: 'api-reader',
        label: 'Create ServiceAccount "api-reader"',
      },
      {
        type: 'deploy',
        kind: 'RoleBinding',
        count: 1,
        label: 'Bind the view role to the api-reader ServiceAccount',
      },
      {
        type: 'canI',
        verb: 'get',
        resource: 'pods',
        user: 'system:serviceaccount:sa-lab:api-reader',
        expected: true,
        label:
          'api-reader can list Pods via the Kubernetes API (verified inside the Pod with curl)',
      },
      { type: 'command', pattern: 'oc auth can-i ', label: 'Verify access with oc auth can-i' },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project sa-lab`. Create the identity: `oc create serviceaccount api-reader`.',
      'Grant read access: `oc adm policy add-role-to-user view -z api-reader` (this creates a RoleBinding for the ServiceAccount).',
      'Run the app as the ServiceAccount: `oc set serviceaccount deployment/api api-reader`.',
      'Check with `oc auth can-i get pods --as=system:serviceaccount:sa-lab:api-reader -n sa-lab`.',
      'Prove the application really has API access (this is the exam check): the kubelet mounts the SA token into every Pod; use it from inside the workload — `oc exec deploy/api -- sh -c \'curl -sk -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" https://kubernetes.default.svc/api/v1/namespaces/sa-lab/pods\'`. It returns the PodList JSON once the RoleBinding grants `list`/`get` on pods; without it the same request returns a 403 `Status` JSON (the token authenticates, the RBAC binding authorizes).',
    ],
    starCriteria: { time: 360, efficiency: 0.75, noFailures: true },
    nextLevel: 17,
  },

  // ═══════════════════════ CHAPTER 5 — SECURITY & OPERATIONS ═══════════════════════
  {
    id: 17,
    title: 'SCC & Privileged Apps',
    chapter: 5,
    chapterName: 'Security & Operations',
    description:
      "Security Context Constraints are OpenShift's pod admission gate. A workload is being rejected because no SCC allows its requested securityContext. The workload already runs as the shipped dedicated ServiceAccount priv-sa — grant the privileged SCC to that ServiceAccount with an OCP 4.x RBAC binding (anyuid allows arbitrary UIDs but not privileged containers), run the privileged app, and clear the SCCForbidden incident. Do not grant privileged to the project default ServiceAccount.",
    examObjectives: [
      'Configure application security > Run privileged applications',
      'Configure application security > Manage and apply permissions using security context constraints',
      'Configure application security > Create and apply secrets to manage sensitive information',
    ],
    docsLinks: [DOCS.scc, DOCS.rbac, DOCS.serviceAccounts],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('privileged-lab'),
      { kind: 'ServiceAccount', name: 'priv-sa' },
      deployment('privileged-app', {
        replicas: 1,
        serviceAccountName: 'priv-sa',
        securityContext: { privileged: true },
      }),
    ],
    availableResources: [
      'Project',
      'Deployment',
      'Pod',
      'SecurityContextConstraints',
      'ServiceAccount',
      'RoleBinding',
      'ClusterRoleBinding',
    ],
    objectives: [
      {
        type: 'scc',
        scc: 'privileged',
        subject: 'system:serviceaccount:privileged-lab:priv-sa',
        expected: true,
        label: 'Grant the privileged SCC to the dedicated ServiceAccount priv-sa',
      },
      {
        type: 'privileged',
        count: 1,
        serviceAccount: 'priv-sa',
        label: 'Run the privileged workload as priv-sa (Pod admitted by the privileged SCC)',
      },
      {
        type: 'resolve',
        incidentType: 'SCCForbidden',
        count: 1,
        label: 'Resolve the SCCForbidden incident',
      },
    ],
    incidents: [{ type: 'SCCForbidden', triggerTime: 15, target: 'privileged-app', severity: 4 }],
    hints: [
      'See the denied workload: `oc get pods -n privileged-lab` stays empty and `oc describe deployment/privileged-app -n privileged-lab` shows a FailedCreate event — "unable to validate against any security context constraint". On 4.x the rejected Pod is never created.',
      'Check the identity: `oc get sa -n privileged-lab` — the shipped dedicated ServiceAccount is `priv-sa` (the workload runs as it). Avoid granting elevated SCCs to the project default SA.',
      'Grant the SCC the 4.x way (creates a RoleBinding in the project to ClusterRole system:openshift:scc:privileged): `oc adm policy add-scc-to-user privileged -z priv-sa -n privileged-lab`.',
      'Verify the grant with the RBAC question, not the SCC users list (it stays unchanged on 4.x): `oc auth can-i use scc/privileged --as=system:serviceaccount:privileged-lab:priv-sa`, `oc get rolebinding -n privileged-lab`, then `oc get pods -n privileged-lab` — the privileged Pod is created and Running. The objective is graded on that state, so any equivalent binding works too — e.g. a Role with apiGroups `security.openshift.io`, resources `securitycontextconstraints`, resourceNames `privileged`, verbs `use` bound to priv-sa through a RoleBinding (not only the generated `system:openshift:scc:privileged` roleRef).',
      "Prove admission: `oc get pod -n privileged-lab -o jsonpath='{.items[*].metadata.annotations.openshift\\.io/scc}'` prints `privileged`. The SCCForbidden incident clears once the state is right — the ServiceAccount can use the privileged SCC and its privileged Pod is Running; the panel resolution action is only for exploring the fault.",
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: false },
    nextLevel: 18,
  },

  {
    id: 18,
    title: 'Operators',
    chapter: 5,
    chapterName: 'Security & Operations',
    description:
      "Operators extend the cluster API. Start with the SingleNamespace MetalLB install (OperatorGroup + Subscription), watch the InstallPlan and CSV reach Succeeded, then uninstall it cleanly: deleting the Subscription leaves the ClusterServiceVersion, deleting the CSV is the actual uninstall. Then cover the OLM variants EX280 expects: an AllNamespaces install in openshift-operators (no new OperatorGroup — the cluster-global one already exists), Manual InstallPlan approval (the install stops at RequiresApproval until you patch `spec.approved`), and pinning one of the channel's published CSV entries with `startingCSV` instead of taking the channel head (the cert-manager package is the real Red Hat `openshift-cert-manager-operator`, channel `stable-v1`).",
    examObjectives: [
      'Manage OpenShift operators > Install an operator',
      'Manage OpenShift operators > Uninstall an operator',
      'Manage OpenShift operators > Delete an operator',
    ],
    docsLinks: [DOCS.operators, DOCS.operatorAdmin, DOCS.operatorOlm],
    startingResources: [node('node-1'), node('node-2'), project('operator-lab')],
    availableResources: ['Project', 'Subscription', 'ClusterOperator'],
    manifestFiles: [
      'examples/subscription.yaml',
      'examples/operatorgroup.yaml',
      'examples/subscription-manual-pinned.yaml',
    ],
    focusFiles: [
      'examples/operatorgroup.yaml',
      'examples/subscription.yaml',
      'examples/subscription-manual-pinned.yaml',
    ],
    objectives: [
      {
        type: 'operator',
        name: 'metallb-operator',
        installed: true,
        label: 'Install operator "metallb-operator" (CSV reaches Succeeded)',
      },
      {
        type: 'command',
        pattern: 'oc (get|describe) (sub|subscription|csv|installplan)',
        label: 'Verify the Subscription / CSV / InstallPlan',
      },
      {
        type: 'operator',
        name: 'metallb-operator',
        installed: false,
        label: 'After installing, uninstall the operator (delete Subscription + CSV)',
      },
      {
        type: 'operator',
        name: 'openshift-cert-manager-operator',
        namespace: 'openshift-operators',
        allNamespaces: true,
        installed: true,
        label:
          'Install cert-manager AllNamespaces into openshift-operators (global OperatorGroup, no new OperatorGroup)',
      },
      {
        type: 'installPlan',
        namespace: 'openshift-operators',
        package: 'openshift-cert-manager-operator',
        approval: 'Manual',
        approved: true,
        label:
          'Approve the Manual InstallPlan (oc patch installplan <name> -n openshift-operators --type=merge)',
      },
      {
        type: 'subscription',
        name: 'openshift-cert-manager-operator',
        namespace: 'openshift-operators',
        package: 'openshift-cert-manager-operator',
        channel: 'stable-v1',
        installPlanApproval: 'Manual',
        // State-graded (#48.1): the installed CSV must equal the player's own
        // startingCSV pin and must not be the channel head. Any valid older
        // channel entry (v1.16.0, v1.15.0, …) satisfies this.
        pinnedInstall: true,
        label: 'Pin the install with a valid non-head startingCSV (installed CSV equals the pin)',
      },
    ],
    incidents: [],
    hints: [
      'Create the operator namespace and its OperatorGroup: `oc new-project metallb-system`, then `oc apply -f examples/operatorgroup.yaml` (single-namespace OperatorGroup targeting metallb-system). A Subscription with no matching OperatorGroup never resolves.',
      'Find the package: `oc get packagemanifests -n openshift-marketplace` lists `metallb-operator` — the redhat-operators package name is `metallb-operator` (an old/misspelled package fails with ResolutionFailed "no operators found in package").',
      'Install: edit `examples/subscription.yaml` so `spec.name` is `metallb-operator`, metadata.name is `metallb-operator` and metadata.namespace is `metallb-system`, then `oc apply -f examples/subscription.yaml`.',
      'Watch OLM: `oc get sub,csv,installplan -n metallb-system` — an InstallPlan appears, then the CSV `metallb-operator.v4.22.0-202610281200` goes Installing → Succeeded; `oc get subscription -n metallb-system -o yaml` reports `status.installedCSV`.',
      'Uninstall (only after the install above reached Succeeded): `oc delete subscription metallb-operator -n metallb-system`, then confirm the CSV is STILL there with `oc get csv -n metallb-system` — deleting the Subscription does not remove the operator.',
      'Finish the uninstall by deleting the CSV itself: `oc delete csv metallb-operator.v4.22.0-202610281200 -n metallb-system` (typing `clusterserviceversion`/`csv` is the uninstall step), then confirm with `oc get csv -n metallb-system` and `oc get subscription -A`.',
      'AllNamespaces variant: no new OperatorGroup is needed — `openshift-operators` already ships the cluster-global `global-operators` group (`oc get operatorgroup -n openshift-operators`), and the Subscription must live in `openshift-operators` too. The installed CSV appears in that project (`oc get csv -n openshift-operators`), and because the install is AllNamespaces OLM also creates a copied CSV of it in every other namespace: `oc get csv -A` shows the same CSV name across the cluster (the copies have the `Copied` status reason).',
      'Discover the cert-manager package and its pinnable versions: `oc get packagemanifests -n openshift-marketplace` lists `openshift-cert-manager-operator` (channel `stable-v1`); `oc describe packagemanifest openshift-cert-manager-operator -n openshift-marketplace` lists the channel entries — the head `cert-manager-operator.v1.17.0` plus `.v1.16.0` and `.v1.15.0`. Only an entry of the channel is a valid `startingCSV`; anything else fails resolution with `ResolutionFailed` ("no operators found with name … in channel stable-v1 of package openshift-cert-manager-operator").',
      'Manual approval + pinned version: apply `examples/subscription-manual-pinned.yaml` (namespace `openshift-operators`, `installPlanApproval: Manual`, `startingCSV: cert-manager-operator.v1.16.0`), then approve the InstallPlan OLM creates: `oc patch installplan <name> -n openshift-operators --type=merge -p \'{"spec":{"approved":true}}\'`. Until then the Subscription reports `InstallPlanPending True RequiresApproval`.',
      'Prove the pin: `oc get sub,csv,installplan -n openshift-operators` — `status.installedCSV` and the CSV are `cert-manager-operator.v1.16.0`, not the channel-head v1.17.0. The objective is graded on exactly that: the installed CSV equals YOUR `startingCSV`, and that pin is not the channel head — pinning v1.15.0 counts too.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: true },
    nextLevel: 19,
  },

  {
    id: 19,
    title: 'Jobs & CronJobs',
    chapter: 5,
    chapterName: 'Security & Operations',
    description:
      'Batch workloads run to completion. The nightly `report-batch` Job was created with an `activeDeadlineSeconds` that is far too short, so it reliably fails with DeadlineExceeded. Inspect the failed Job, run a simple Job that really prints its output, repair the broken Job by recreating it with a longer deadline, and schedule recurring work with a CronJob.',
    examObjectives: [
      'Configure application security > Deploy jobs to perform one-time tasks',
      'Configure application security > Configure Kubernetes cron jobs',
    ],
    docsLinks: [DOCS.jobs, DOCS.cli],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('batch-lab'),
      // Seeded faulty batch Job (#31): a too-short activeDeadlineSeconds while
      // the report takes much longer, so the Job fails on its own. The
      // JobDeadlineExceeded incident targets THIS Job — it never hijacks a Job
      // the player creates.
      job('report-batch', {
        image: 'perl',
        command: ['/bin/sh', '-c', 'echo "starting report generation"; sleep 600'],
        activeDeadlineSeconds: 8,
        estimatedDurationSeconds: 600,
        backoffLimit: 0,
      }),
    ],
    availableResources: ['Project', 'Job', 'CronJob', 'Pod', 'Node'],
    objectives: [
      { type: 'complete', kind: 'Job', count: 1, label: 'Run a Job to phase Complete' },
      {
        type: 'cronJob',
        name: 'cleanup',
        suspended: false,
        label: 'Create the CronJob "cleanup" (not suspended)',
      },
      {
        type: 'resolve',
        incidentType: 'JobDeadlineExceeded',
        count: 1,
        label: 'Resolve the JobDeadlineExceeded incident',
      },
      {
        type: 'command',
        pattern: 'oc (create|apply) .*(job|cronjob)',
        label: 'Create the batch objects with oc create/apply',
      },
    ],
    incidents: [
      { type: 'JobDeadlineExceeded', triggerTime: 15, target: 'report-batch', severity: 2 },
    ],
    hints: [
      'Switch projects: `oc project batch-lab`, then inspect the broken batch job: `oc get jobs` (report-batch is Failed), `oc describe job report-batch` — the conditions show Failed with reason `DeadlineExceeded`, and the diagnostic line `Active Deadline Seconds:  8s` says the Job was killed after 8 seconds; the events show `Job was active longer than specified deadline`. `oc get job report-batch -o yaml` confirms `activeDeadlineSeconds: 8`, far too short for the report.',
      'Read its output: `oc logs job/report-batch` (the container was killed while the report was still running). A Failed Job cannot be resumed — raise the deadline by recreating it: `oc delete job report-batch` then `oc create job report-batch --image=perl --active-deadline-seconds=600 -- perl -e "print 42"`. That new Job completes, so the JobDeadlineExceeded incident clears.',
      'Run a second, simple Job and read its REAL stdout: `oc create job report-job --image=perl -- perl -e "print 42"`; watch `oc get jobs,pods`, then `oc logs job/report-job` prints `42` (the Pod stays around after completion, like on a real cluster).',
      'Schedule recurring work (five-field cron only — `--schedule="every 5 min"` is rejected by the API server, and the first Job only appears at the next scheduled time): `oc create cronjob cleanup --image=busybox --schedule="*/5 * * * *" -- sh -c date`.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: false },
    nextLevel: 20,
  },

  {
    id: 20,
    title: 'EX280 Final: Production Platform',
    chapter: 5,
    chapterName: 'Security & Operations',
    description:
      'Capstone. Build a complete production platform the way EX280 expects: a Project with quota and limits, the webapp Deployment + Service + TLS Route, a source Build feeding an ImageStream, a developer User/Group with a NetworkPolicy (default-deny must also block the Route when checked from the workstation — an ingress policy that allows the router namespace restores it), MetalLB, a Job and a CronJob, plus an Architecture Advisor score of 25 or more and a composite drill score of 75 or more (both are in-game metrics, not Red Hat exam scores).',
    examObjectives: [
      'Manage OpenShift Container Platform > Use the web console to manage and configure an OpenShift cluster',
      'Manage OpenShift Container Platform > Examine resources and cluster status',
      'Manage OpenShift Container Platform > Assess the health of an OpenShift cluster',
      'Manage OpenShift Container Platform > Use product documentation',
      'Manage OpenShift Container Platform > Be prepared to perform all tasks of a Red Hat Certified Technologist in OpenShift',
      'Configure network security > Control cluster network ingress',
      'Configure network security > Configure application network policies',
      'Enable developer self-service > Configure project resource requirements',
    ],
    docsLinks: [
      DOCS.quotas,
      DOCS.deployments,
      DOCS.routes,
      DOCS.builds,
      DOCS.operators,
      DOCS.jobs,
      DOCS.networkSecurity,
    ],
    startingResources: [
      node('node-1', '16', '32Gi'),
      node('node-2', '16', '32Gi'),
      node('node-3', '16', '32Gi'),
    ],
    availableResources: [
      'Project',
      'ResourceQuota',
      'LimitRange',
      'Deployment',
      'Pod',
      'Service',
      'Route',
      'Secret',
      'NetworkPolicy',
      'BuildConfig',
      'Build',
      'ImageStream',
      'Template',
      'Subscription',
      'User',
      'Group',
      'RoleBinding',
      'ServiceAccount',
      'SecurityContextConstraints',
      'Job',
      'CronJob',
      'Node',
    ],
    manifestFiles: [
      'manifests/deployment.yaml',
      'manifests/service.yaml',
      'manifests/route.yaml',
      'examples/route-external-cert-rbac.yaml',
      'examples/quota.yaml',
      'examples/limitrange.yaml',
      'examples/buildconfig.yaml',
      'examples/subscription.yaml',
      'examples/operatorgroup.yaml',
      'examples/metallb.yaml',
      'examples/default-deny.yaml',
      'examples/allow-from-router.yaml',
    ],
    focusFiles: [
      'manifests/deployment.yaml',
      'manifests/route.yaml',
      'examples/route-external-cert-rbac.yaml',
      'examples/quota.yaml',
      'examples/default-deny.yaml',
      'examples/allow-from-router.yaml',
    ],
    objectives: [
      { type: 'project', name: 'prod-platform', label: 'Create the Project "prod-platform"' },
      // Issue #37: the capstone grades quota/limits/default-deny on PROJECT
      // STATE, not on hidden object names the level never states. Any
      // ResourceQuota / LimitRange in prod-platform counts, and so does any
      // NetworkPolicy that selects every Pod for Ingress with no allow rules.
      {
        type: 'quota',
        namespace: 'prod-platform',
        label: 'Apply a project ResourceQuota',
      },
      {
        type: 'limitRange',
        namespace: 'prod-platform',
        label: 'Apply a project LimitRange',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'webapp',
        label: 'Deploy webapp from manifests/deployment.yaml',
      },
      { type: 'deploy', kind: 'Service', name: 'webapp', label: 'Expose webapp with a Service' },
      { type: 'route', name: 'webapp', label: 'Create an external Route "webapp" (Admitted)' },
      {
        type: 'build',
        name: 'webapp',
        count: 1,
        label: 'Complete a Build for the webapp BuildConfig',
      },
      {
        type: 'imageStream',
        name: 'webapp',
        tag: 'latest',
        label: 'ImageStream webapp has the :latest tag',
      },
      {
        type: 'networkPolicy',
        probe: 'ingress-isolation',
        namespace: 'prod-platform',
        label: 'Add a default-deny NetworkPolicy',
      },
      {
        type: 'routeAccess',
        name: 'webapp',
        requireIsolation: true,
        label: 'Route webapp is reachable from the workstation (router allowed by NetworkPolicy)',
      },
      { type: 'user', name: 'developer', label: 'Create the User "developer"' },
      {
        type: 'group',
        name: 'developers',
        users: ['developer'],
        label: 'Create Group "developers" containing developer',
      },
      {
        type: 'operator',
        name: 'metallb-operator',
        installed: true,
        label: 'Install the MetalLB operator (CSV metallb-operator.v4.22.0-202610281200)',
      },
      { type: 'complete', kind: 'Job', count: 1, label: 'Run a Job to phase Complete' },
      { type: 'cronJob', name: 'nightly', suspended: false, label: 'Create the CronJob "nightly"' },
      // Capstone gating (#20): the scheduled incidents must be RESOLVED, not
      // merely fired — finishing with CrashLoopBackOff/NodeNotReady still
      // active is impossible, and the level cannot be rushed in under 2 min.
      {
        type: 'resolve',
        incidentType: 'CrashLoopBackOff',
        count: 1,
        label: 'Resolve the scheduled CrashLoopBackOff (fires 60 s into the capstone)',
      },
      {
        type: 'resolve',
        incidentType: 'NodeNotReady',
        count: 1,
        label: 'Resolve the scheduled NodeNotReady (fires 120 s into the capstone)',
      },
      // NOTE: threshold is deliberately modest versus the current ScoringEngine scale...
      // a solid capstone platform scores ~34 today; modes-dev's rewritten advisor may rescale.
      { type: 'architectureScore', minScore: 25, label: 'Architecture Advisor score >= 25' },
      {
        type: 'examScore',
        minScore: 75,
        label: 'Composite drill score >= 75 (in-game metric, not a Red Hat exam score)',
      },
    ],
    incidents: [
      // Capstone CrashLoopBackOff (#31): the incident SEEDS the faulty
      // configuration into the webapp Deployment when it fires, then damages the
      // Pods. Issue #42-3: only APP_MODE is wrong — the image stays neutral, so
      // the crash log blames the env var instead of teaching `oc set image`.
      // Resolution requires correcting APP_MODE; an unrelated env var or
      // `oc rollout restart` does not heal it.
      {
        type: 'CrashLoopBackOff',
        triggerTime: 60,
        target: 'webapp',
        severity: 2,
        seed: {
          env: { name: 'APP_MODE', value: 'debug-invalid' },
        },
        fix: {
          env: {
            name: 'APP_MODE',
            allowed: ['production', 'prod', 'development', 'dev'],
          },
        },
      },
      { type: 'NodeNotReady', triggerTime: 120, target: 'worker-1', severity: 3 },
    ],
    hints: [
      'Create the platform project: `oc new-project prod-platform`, then apply the quota/limits with `oc apply -f examples/quota.yaml` and `oc apply -f examples/limitrange.yaml`.',
      'Deploy the app: `oc apply -f manifests/deployment.yaml` and `oc apply -f manifests/service.yaml`. Enable ports/health probes in the YAML for a higher Architecture Advisor score.',
      // Issue #39: manifests/route.yaml uses tls.externalCertificate, which real
      // OCP 4.22 only admits once the Secret AND the router RBAC exist. Teach
      // that order instead of letting the Route look admitted with nothing behind it.
      'TLS Route with `tls.externalCertificate` (manifests/route.yaml): real OCP 4.22 admits it only after the referenced Secret exists AND the ingress router can read it - a Route applied without both stays rejected with `ExternalCertificateValidationFailed`. (1) Create the Secret in prod-platform: `openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=webapp.apps.cluster.example.com"`, then `oc create secret tls webapp-tls --cert=tls.crt --key=tls.key -n prod-platform`. (2) Grant the router read access in the same project: `oc apply -f examples/route-external-cert-rbac.yaml -n prod-platform` (a Role with get/list/watch on the named Secret plus a RoleBinding to system:serviceaccount:openshift-ingress:router). (3) Only then apply the Route: `oc apply -f manifests/route.yaml -n prod-platform`, and confirm `oc get route webapp -n prod-platform` reports Admitted. A plain `oc create route edge webapp --service=webapp` embeds no externalCertificate and needs none of this.',
      'Build: `oc apply -f examples/buildconfig.yaml` (it already outputs ImageStreamTag `webapp:latest`), then `oc start-build webapp --follow` and watch the Build reach Complete.',
      'NetworkPolicy + ingress: apply the shipped `examples/default-deny.yaml` (`networking.k8s.io/v1`, selects all Pods) with `oc apply -f examples/default-deny.yaml -n prod-platform`, then verify from the workstation: `HOST=$(oc get route webapp -n prod-platform -o jsonpath="{.spec.host}"); curl -k https://$HOST` now fails with 503 even though the Route is Admitted. Allow the router with an ingress NetworkPolicy whose `namespaceSelector.matchLabels` is `policy-group.network.openshift.io/ingress: ""` (the shipped `examples/allow-from-router.yaml`, `oc apply -f examples/allow-from-router.yaml -n prod-platform`) and re-run `curl` — it must answer again. There is no `oc create networkpolicy` subcommand; use the Files panel New/Import buttons for other policies. Also create `oc create user developer` and `oc adm groups new developers developer`.',
      'Install MetalLB the 4.x OLM way: `oc new-project metallb-system`, `oc apply -f examples/operatorgroup.yaml`, edit `examples/subscription.yaml` (spec.name/metadata.name `metallb-operator`, namespace `metallb-system`) and apply it, wait for the CSV `metallb-operator.v4.22.0-202610281200` (`oc get csv -n metallb-system`) to reach Succeeded, then `oc apply -f examples/metallb.yaml` (MetalLB CR + IP pool + L2 advertisement).',
      'Finish with a Job (`oc create job report-job --image=perl -- perl -e "print 42"`) and a CronJob (`oc create cronjob nightly --image=busybox --schedule="*/5 * * * *" -- sh -c date`), then check `oc status` and the Architecture Advisor in the HUD. The capstone is gated on the scheduled incidents being RESOLVED: CrashLoopBackOff fires 60 s in on webapp and NodeNotReady fires 120 s in on worker-1. For the CrashLoopBackOff, run `oc logs <pod> -n prod-platform --previous` (the crash names the invalid `APP_MODE`) and correct it with `oc set env deployment/webapp APP_MODE=production -n prod-platform` — an unrelated env var or `oc rollout restart` will NOT clear it. Restore the node (`oc debug node/worker-1`, then `chroot /host systemctl restart kubelet`) and confirm both incidents are gone from the Incidents panel — the level cannot complete while either is still active.',
    ],
    starCriteria: { time: 900, efficiency: 0.6, noFailures: false },
    nextLevel: null,
  },
];

const CHAPTERS = [
  {
    id: 1,
    name: 'Manage OpenShift',
    levels: [1, 2, 3, 4],
    description: 'Projects, CLI, querying, logs/health and declarative manifests',
  },
  {
    id: 2,
    name: 'Declarative & Kustomize',
    levels: [5, 6, 7, 8],
    description: 'Kustomize base/overlays, Secrets/ConfigMaps, Templates and Helm',
  },
  {
    id: 3,
    name: 'Deploy & Expose',
    levels: [9, 10, 11, 12],
    description: 'Builds/ImageStreams, rolling updates, Services/Routes and LoadBalancer',
  },
  {
    id: 4,
    name: 'Identity, RBAC & Self-service',
    levels: [13, 14, 15, 16],
    description: 'HTPasswd users, groups/RBAC, quotas/limits and ServiceAccounts',
  },
  {
    id: 5,
    name: 'Security & Operations',
    levels: [17, 18, 19, 20],
    description: 'SCCs, Operators, Jobs/CronJobs and the full EX280 capstone',
  },
];

export { CAMPAIGN_LEVELS, CHAPTERS };
