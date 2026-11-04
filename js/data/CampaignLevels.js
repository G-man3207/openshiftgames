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

const DOCS = {
  cli: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/openshift-cli-oc',
  projects: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/projects',
  deployments: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/deployments',
  creating: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/creating-applications',
  quotas: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/quotas',
  helm: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/working-with-helm-charts',
  health: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/application-health',
  builds: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/understanding-buildconfigs',
  startBuild: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/basic-build-operations',
  buildTriggers: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/triggering-builds-build-hooks',
  imageStreams: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/managing-image-streams',
  images: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/overview-of-images',
  imageTriggers: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/triggering-updates-on-imagestream-changes',
  jobs: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/using-jobs-and-daemon-sets',
  pods: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/working-with-pods',
  clusterResources: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/working-with-clusters',
  scheduling: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/controlling-pod-placement-onto-nodes-scheduling',
  rbac: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/using-rbac',
  idp: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/configuring-identity-providers',
  usersGroups: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-authentication',
  serviceAccounts: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-creating-service-accounts',
  scc: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/managing-pod-security-policies',
  operators: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/user-tasks',
  operatorAdmin: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/administrator-tasks',
  operatorOlm: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/understanding-operators',
  routes: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes',
  metallb: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/load-balancing-with-metallb',
  networkSecurity: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/index',
  console: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/web_console/index',
};

// Small helpers keep the level data readable and avoid copy/paste drift.
const node = (name, cpu = '8', memory = '16Gi', extra = {}) => ({
  kind: 'Node',
  name,
  spec: { cpu, memory, status: 'Ready', ...extra.spec },
  ...extra,
});

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
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: {
        containers: [
          {
            name: options.containerName || 'main',
            image: options.image || 'quay.io/openshift/origin-hello-openshift:latest',
            ports: [{ containerPort: 8080, name: 'http' }],
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
    ports: [{ name: 'http', port: options.port ?? 8080, targetPort: options.targetPort ?? 8080 }],
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
      { type: 'deploy', kind: 'Pod', name: 'hello-pod', label: 'Run a bare Pod named "hello-pod"' },
      { type: 'deploy', kind: 'Deployment', name: 'hello-deploy', label: 'Create the Deployment "hello-deploy"' },
    ],
    incidents: [],
    hints: [
      'Log in first: `oc login -u kubeadmin` (or `oc login --username=kubeadmin`), then check `oc whoami`.',
      'Create the project: `oc new-project first-project --display-name="First Project"`. `oc project` shows the current project.',
      'Run a Pod: `oc run hello-pod --image=nginx:latest`. Watch it with `oc get pods -o wide`.',
      'Create a Deployment: `oc create deployment hello-deploy --image=nginx:latest`, then verify `oc get deployments,pods`.',
    ],
    starCriteria: { time: 240, efficiency: 0.75, noFailures: true },
    nextLevel: 2,
    tutorial: {
      steps: [
        {
          target: 'command-bar',
          text: 'Press / to open the command bar. OpenShift commands start with oc. Log in with: oc login -u kubeadmin',
        },
        {
          target: 'command-bar',
          text: 'Create your first Project: oc new-project first-project — Projects group and isolate your workloads.',
        },
        {
          target: 'cluster-view',
          text: 'Your Project is active. Deploy a pod with oc run hello-pod --image=nginx:latest and watch it become Running.',
        },
        {
          target: 'inspector',
          text: 'Click the Pod to open the Inspector. The Describe tab mirrors `oc describe pod`.',
        },
        {
          target: 'palette',
          text: 'You can also deploy with the palette and with `oc create deployment hello-deploy --image=nginx:latest`.',
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
      { type: 'command', pattern: 'oc get (deploy|deployment|deployments)', label: 'Use oc get to list Deployments' },
      { type: 'label', kind: 'Deployment', name: 'web', key: 'tier', value: 'frontend', label: 'Label Deployment web with tier=frontend' },
      { type: 'command', pattern: 'oc get .*(-o|--output)(=|\\s+)(wide|yaml|json|custom-columns|jsonpath|name)', label: 'Format output with -o wide/yaml/json/jsonpath' },
      { type: 'command', pattern: 'oc explain ', label: 'Use oc explain to inspect a resource schema' },
      { type: 'deploy', kind: 'Deployment', name: 'api', label: 'Create a second Deployment named "api"' },
    ],
    incidents: [],
    hints: [
      'Switch to the lab project: `oc project query-lab`, then list workloads with `oc get deployments -o wide`.',
      'Labels are how OpenShift selects resources: `oc label deployment/web tier=frontend` and query with `oc get deploy -l tier=frontend --show-labels`.',
      'Reshape output: `oc get deployment/web -o yaml`, `oc get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image`.',
      'Ask the API for docs: `oc explain deployment.spec.strategy --recursive`.',
      'Create the second Deployment with `oc create deployment api --image=nginx:latest` (or deploy it from the palette).',
    ],
    starCriteria: { time: 300, efficiency: 0.75, noFailures: true },
    nextLevel: 3,
    tutorial: {
      steps: [
        { target: 'command-bar', text: 'Start with `oc project query-lab` and `oc get deployments`. Then format with `-o wide`.' },
        { target: 'inspector', text: 'Select the web Deployment and open the YAML tab — this is the same content as `oc get deployment/web -o yaml`.' },
      ],
    },
  },

  {
    id: 3,
    title: 'Logs, Events & Health',
    chapter: 1,
    chapterName: 'Manage OpenShift',
    description:
      'Production OpenShift is about reading symptoms: `oc logs`, `oc describe`, `oc get events`, `oc adm top`, ClusterOperators and ClusterVersion. A hidden CrashLoopBackOff is breaking the web-app Deployment — investigate it and bring cluster health back to 90%+.',
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
      deployment('web-app', { replicas: 2, image: 'quay.io/openshift/origin-hello-openshift:latest' }),
    ],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Node'],
    objectives: [
      { type: 'deploy', kind: 'Deployment', name: 'web-app', label: 'Keep the web-app Deployment present while you investigate' },
      { type: 'command', pattern: 'oc (get|describe) pods?', label: 'Inspect Pods with oc get/oc describe' },
      { type: 'command', pattern: 'oc logs ', label: 'Read container logs with oc logs' },
      { type: 'investigate', incidentType: 'CrashLoopBackOff', progress: 0.5, label: 'Investigate the CrashLoopBackOff incident' },
      { type: 'resolve', incidentType: 'CrashLoopBackOff', count: 1, label: 'Resolve the CrashLoopBackOff' },
      { type: 'clusterHealth', minPercent: 90, label: 'Restore cluster health to 90% or better' },
    ],
    incidents: [{ type: 'CrashLoopBackOff', triggerTime: 10, target: 'web-app', severity: 2 }],
    hints: [
      'Switch projects: `oc project ops-lab`. Then `oc get pods` and click the failing Pod for Inspector → Events.',
      'Read the crash output: `oc logs <pod> --previous`. Then `oc describe pod <pod>` — the Events section shows Back-off restarting failed container.',
      'Correlate events: `oc get events --sort-by=.lastTimestamp`, and check cluster operators with `oc get clusteroperators`.',
      'Use the Incident panel to Investigate the CrashLoopBackOff (or run the commands it lists), then apply the resolution action to clear it.',
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
      { type: 'manifest', file: 'manifests/deployment.yaml', label: 'Apply manifests/deployment.yaml with oc apply -f' },
      { type: 'manifest', file: 'manifests/service.yaml', label: 'Apply manifests/service.yaml with oc apply -f' },
      { type: 'deploy', kind: 'Deployment', name: 'webapp', label: 'Deployment "webapp" exists in the cluster' },
      { type: 'deploy', kind: 'Service', name: 'webapp', label: 'Service "webapp" exists in the cluster' },
      { type: 'command', pattern: 'oc get .*-(o|--output)(=|\\s+)(yaml|json)', label: 'Export a live resource with oc get -o yaml/json' },
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
    examObjectives: [
      'Declarative Resource Management > Deploy applications using Kustomize',
    ],
    docsLinks: [DOCS.cli, DOCS.creating],
    startingResources: [node('node-1'), node('node-2'), project('kustomize-lab')],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Node'],
    manifestFiles: ['kustomize/base/kustomization.yaml', 'kustomize/base/deployment.yaml', 'kustomize/base/service.yaml'],
    focusFiles: ['kustomize/base/kustomization.yaml'],
    objectives: [
      { type: 'kustomize', path: 'kustomize/base', label: 'Apply the Kustomize base with oc apply -k kustomize/base' },
      { type: 'deploy', kind: 'Deployment', name: 'webapp', label: 'The base Deployment "webapp" was created' },
      { type: 'command', pattern: 'oc apply -k ', label: 'Use oc apply -k (Kustomize rendering)' },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project kustomize-lab`. On a real cluster, preview the render with `oc kustomize kustomize/base`; the simulator renders the same tree when you apply it with `oc apply -k kustomize/base`.',
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
    examObjectives: [
      'Declarative Resource Management > Work with Kustomize overlays',
    ],
    docsLinks: [DOCS.cli, DOCS.deployments],
    startingResources: [node('node-1'), node('node-2'), project('webapp-prod')],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Node'],
    manifestFiles: ['kustomize/overlays/prod/kustomization.yaml', 'kustomize/overlays/prod/patch-deployment.yaml'],
    focusFiles: ['kustomize/overlays/prod/kustomization.yaml', 'kustomize/overlays/prod/patch-deployment.yaml'],
    objectives: [
      { type: 'kustomize', path: 'kustomize/overlays/prod', label: 'Apply the prod overlay with oc apply -k kustomize/overlays/prod' },
      { type: 'deploy', kind: 'Deployment', name: 'prod-webapp', label: 'Prefixed Deployment "prod-webapp" exists' },
      { type: 'scale', kind: 'Deployment', name: 'prod-webapp', replicas: 3, label: 'prod-webapp runs 3 replicas (replica override)' },
      { type: 'image', kind: 'Deployment', name: 'prod-webapp', imageContains: 'origin-hello-openshift', label: 'prod-webapp uses the patched webapp image' },
      { type: 'command', pattern: 'oc apply -k ', label: 'Use oc apply -k on the overlay directory' },
    ],
    incidents: [],
    hints: [
      'On a real cluster, render before applying with `oc kustomize kustomize/overlays/prod` (note the `prod-` name prefix, namespace webapp-prod, image tag and replicas); the simulator renders on `oc apply -k kustomize/overlays/prod`.',
      'Apply the overlay: `oc apply -k kustomize/overlays/prod`.',
      'Verify the namespaced object: `oc get deployment -n webapp-prod` should show `prod-webapp` with 3 desired replicas.',
      'The strategic-merge patch in `patch-deployment.yaml` adds the APP_ENV=runtime env var and resource requests. Try `oc get deploy prod-webapp -n webapp-prod -o yaml`.',
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
      { type: 'deploy', kind: 'ConfigMap', name: 'app-config', label: 'Create the ConfigMap "app-config"' },
      { type: 'deploy', kind: 'Secret', name: 'db-secret', label: 'Create the Secret "db-secret"' },
      { type: 'mount', kind: 'ConfigMap', count: 1, label: 'Mount a ConfigMap into a workload volume' },
      { type: 'envFrom', kind: 'Secret', count: 1, label: 'Consume the Secret as environment variables' },
      { type: 'noConfigMap', sensitive: true, label: 'No ConfigMap contains password/secret/token/key data' },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project config-lab`. Create the config: `oc create configmap app-config --from-literal=APP_MODE=production`.',
      'Create the secret: `oc create secret generic db-secret --from-literal=password=s3cret`.',
      'Consume configuration as envFrom: run `oc set env deployment/app --from=configmap/app-config` and then `oc set env deployment/app --from=secret/db-secret`.',
      'For the volume objective run `oc edit deployment/app` and add `volumes: [{name: cfg, configMap: {name: app-config}}]` plus a container `volumeMounts: [{name: cfg, mountPath: /etc/app}]`.',
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
      'OpenShift Templates are parameterised object lists; Helm charts package workloads. Process `templates/webapp-template.yaml` with `oc process`, apply the result, then install the `helm/webapp` chart and list the release.',
    examObjectives: [
      'Deploy applications > Deploy applications from templates and Helm charts',
      'Deploy applications > Manage application deployments',
      'Enable developer self-service > Configure project templates',
    ],
    docsLinks: [DOCS.creating, DOCS.helm],
    startingResources: [node('node-1'), node('node-2'), project('template-lab')],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Route', 'Template'],
    manifestFiles: ['templates/webapp-template.yaml', 'helm/webapp/Chart.yaml', 'helm/webapp/values.yaml'],
    focusFiles: ['templates/webapp-template.yaml', 'helm/webapp/values.yaml'],
    objectives: [
      { type: 'template', name: 'webapp-template', parameters: { APP_NAME: 'web' }, label: 'Process webapp-template with APP_NAME=web and apply it' },
      { type: 'deploy', kind: 'Deployment', name: 'web', label: 'The templated Deployment "web" exists' },
      { type: 'helm', release: 'shop', chart: 'webapp', label: 'Install the Helm release "shop" from the webapp chart' },
      { type: 'deploy', kind: 'Deployment', name: 'shop', label: 'The Helm release created Deployment "shop"' },
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
    availableResources: ['Project', 'BuildConfig', 'Build', 'ImageStream', 'Deployment', 'Pod', 'Service', 'Route', 'Node'],
    manifestFiles: ['examples/buildconfig.yaml'],
    focusFiles: ['examples/buildconfig.yaml'],
    objectives: [
      { type: 'build', name: 'webapp', count: 1, label: 'A Build for the webapp BuildConfig reaches phase Complete' },
      { type: 'imageStream', name: 'webapp', tag: 'latest', label: 'ImageStream webapp has the :latest tag' },
      { type: 'command', pattern: 'oc start-build ', label: 'Start a build with oc start-build' },
      { type: 'command', pattern: 'oc (get|describe) (is|imagestream|imagestreamtag|istag)', label: 'Examine images with oc get/describe is' },
      { type: 'image', kind: 'Deployment', imageContains: 'webapp', label: 'A Deployment references the built webapp image' },
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
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
      }),
    ],
    availableResources: ['Project', 'Deployment', 'ReplicaSet', 'Pod', 'Service', 'Node'],
    objectives: [
      { type: 'update', kind: 'Deployment', name: 'api-server', label: 'Trigger a rolling update of api-server' },
      { type: 'rollback', count: 1, label: 'Roll the Deployment back with oc rollout undo' },
      { type: 'resolve', incidentType: 'ImagePullBackOff', count: 1, label: 'Resolve the ImagePullBackOff caused by the bad image' },
      { type: 'uptime', percentage: 90, label: 'Keep availability at 90% or better during the rollout' },
    ],
    incidents: [{ type: 'ImagePullBackOff', triggerTime: 20, target: 'api-server', severity: 3 }],
    hints: [
      'Switch projects: `oc project rollout-lab`. Trigger an update: `oc set image deployment/api-server main=quay.io/openshift/origin-hello-openshift:does-not-exist`.',
      'Watch the rollout and ReplicaSets: `oc rollout status deployment/api-server`, `oc get rs`, `oc rollout history deployment/api-server`.',
      'The bad image causes ImagePullBackOff. Revert with `oc rollout undo deployment/api-server` (or the Inspector → Rollout Undo action).',
      'Investigate/resolve the ImagePullBackOff in the Incident panel, then confirm `oc get pods` is healthy again.',
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
      { type: 'deploy', kind: 'Service', name: 'web', label: 'Create Service "web" selecting the web Deployment' },
      { type: 'connect', from: 'web', to: 'web', label: 'The Service selector matches the web workload' },
      { type: 'route', name: 'web', termination: 'edge', label: 'Create an edge Route "web" and get it Admitted' },
      { type: 'tls', enabled: true, termination: 'edge', label: 'Terminate TLS at the Route (edge)' },
      { type: 'deploy', kind: 'Secret', name: 'web-tls', label: 'Create the TLS Secret "web-tls"' },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project route-lab`. Create the Service: `oc create service clusterip web --tcp=8080:8080` (it selects app=web).',
      'Expose it: `oc create route edge web --service=web` — then `oc get route` shows the generated host and Admitted status.',
      'Alternative: `oc expose service/web --name=web` creates an unencrypted Route; edit it (or re-create) to add TLS termination.',
      'Create the TLS Secret: `oc create secret tls web-tls --cert=tls.crt --key=tls.key` (the simulator accepts placeholder cert files; `oc create secret generic web-tls --from-literal=tls.crt=placeholder --from-literal=tls.key=placeholder` also satisfies the Secret objective — edge Routes can use the router default certificate).',
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
      'HTTP Routes are not the only way to expose an app. Install the MetalLB operator, create a LoadBalancer Service that receives an EXTERNAL-IP, and expose a non-HTTP TLS service with a passthrough Route.',
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
      deployment('tls-app', { replicas: 2 }),
    ],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Route', 'Subscription', 'IPAddressPool', 'L2Advertisement', 'Node'],
    manifestFiles: ['examples/subscription.yaml'],
    focusFiles: ['examples/subscription.yaml'],
    objectives: [
      { type: 'operator', name: 'metallb', installed: true, label: 'Install the MetalLB operator (CSV Succeeded)' },
      { type: 'serviceType', kind: 'LoadBalancer', count: 1, label: 'Create a Service of type LoadBalancer' },
      { type: 'route', name: 'tls-app', termination: 'passthrough', label: 'Expose tls-app with a passthrough Route' },
      { type: 'tls', enabled: true, termination: 'passthrough', label: 'Passthrough TLS termination is configured' },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project lb-lab`. Install MetalLB by editing `examples/subscription.yaml` (name/package `metallb`) and running `oc apply -f examples/subscription.yaml`. The simulator installs it into `openshift-operators`; on a real cluster the MetalLB operator docs use the `metallb-system` project.',
      'Verify the operator: `oc get sub,csv -n openshift-operators` — the ClusterServiceVersion (not the Subscription) moves Installing → Succeeded; `oc describe sub metallb` shows `installedCSV`.',
      'Create the LoadBalancer Service: `oc create service loadbalancer lb --tcp=443:443` and check `oc get svc lb` for an EXTERNAL-IP.',
      'For the passthrough Route: create an IPAddressPool + L2Advertisement if needed, then `oc create route passthrough tls-app --service=tls-app`.',
      'Verify: `oc describe route tls-app` shows TLS termination passthrough and Admitted=True.',
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
      'OpenShift authenticates through identity providers. Configure an HTPasswd provider: create users in the virtual htpasswd file, store it in a Secret in openshift-config, reference it from the OAuth cluster resource, then log in as the new user.',
    examObjectives: [
      'Manage authentication and authorization > Configure the HTPasswd identity provider for authentication',
      'Manage authentication and authorization > Create and delete users',
      'Manage authentication and authorization > Modify user passwords',
    ],
    docsLinks: [DOCS.idp, DOCS.usersGroups, DOCS.cli],
    startingResources: [node('node-1'), node('node-2'), project('identity-lab')],
    availableResources: ['Project', 'User', 'Identity', 'Secret', 'OAuth', 'Group'],
    objectives: [
      { type: 'command', pattern: 'htpasswd ', label: 'Add a user to the htpasswd file (htpasswd -c/-b)' },
      { type: 'deploy', kind: 'Secret', name: 'htpass-secret', label: 'Create the htpasswd Secret' },
      { type: 'user', name: 'alice', label: 'User "alice" exists after first login' },
      { type: 'login', user: 'alice', label: 'Log in to the CLI as alice' },
    ],
    incidents: [],
    hints: [
      'Add a user to the virtual htpasswd file with bcrypt hashes: `htpasswd -c -B -b htpasswd alice <password>` (or `htpasswd -B -b htpasswd alice <password>` to add another).',
      'Create the Secret: `oc create secret generic htpass-secret --from-file=htpasswd -n openshift-config`. The key must be named `htpasswd`.',
      'Configure the provider: `oc edit oauth cluster` and add an HTPasswd identityProvider referencing `htpass-secret` (mappingMethod: claim).',
      'Wait for the authentication operator to roll out, then `oc login -u alice -p <password>` and confirm with `oc whoami`.',
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
      'Grant permissions with least privilege. Create users and a group, bind a role to the group in a project, prove the access with `oc auth can-i`, and resolve an UnauthorizedAccess incident without creating wildcard roles.',
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
    availableResources: ['Project', 'User', 'Group', 'Role', 'RoleBinding', 'ServiceAccount', 'Deployment', 'Pod'],
    objectives: [
      { type: 'group', name: 'developers', users: ['alice', 'bob'], label: 'Create Group "developers" with alice and bob' },
      { type: 'deploy', kind: 'RoleBinding', count: 1, label: 'Bind a role (edit/view) to the developers group in rbac-lab' },
      { type: 'canI', verb: 'get', resource: 'pods', user: 'alice', expected: true, label: 'alice can get pods in rbac-lab' },
      { type: 'leastPrivilege', label: 'No wildcard Roles/ClusterRoles and no extra cluster-admin bindings' },
      { type: 'resolve', incidentType: 'UnauthorizedAccess', count: 1, label: 'Resolve the UnauthorizedAccess incident' },
    ],
    incidents: [{ type: 'UnauthorizedAccess', triggerTime: 25, target: 'web', severity: 3 }],
    hints: [
      'Create the group: `oc adm groups new developers alice bob` (or `oc adm groups add-users developers alice bob`).',
      'Bind a role in the project: `oc adm policy add-role-to-group edit developers -n rbac-lab`. View it with `oc describe rolebinding -n rbac-lab`.',
      'Prove the access: `oc auth can-i get pods --as=alice -n rbac-lab` (and `oc auth can-i delete deployments --as=alice -n rbac-lab`).',
      'Avoid wildcards: create precise Roles or reuse built-in `view`/`edit`. Then investigate the UnauthorizedAccess incident and apply the fix.',
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
      'Developer self-service needs guardrails. Apply a ResourceQuota and LimitRange from the example manifests, create a ClusterResourceQuota that spans projects, set resource requests/limits on the web Deployment, resolve a ResourceQuotaExceeded incident, then publish a project template: generate the bootstrap `project-request` template, add a guardrail object to it, store it in `openshift-config` and point `project.config.openshift.io/cluster` at it.',
    examObjectives: [
      'Manage OpenShift Container Platform > Create and delete projects',
      'Enable developer self-service > Configure cluster resource quotas',
      'Enable developer self-service > Configure project quotas',
      'Enable developer self-service > Configure project resource requirements',
      'Enable developer self-service > Configure project limit ranges',
      'Enable developer self-service > Configure project templates',
    ],
    docsLinks: [DOCS.quotas, DOCS.clusterResources, DOCS.projects],
    startingResources: [node('node-1'), node('node-2'), project('quota-lab'), deployment('web', { replicas: 2 })],
    availableResources: ['Project', 'ResourceQuota', 'ClusterResourceQuota', 'LimitRange', 'Deployment', 'Pod', 'Template'],
    manifestFiles: ['examples/quota.yaml', 'examples/limitrange.yaml'],
    focusFiles: ['examples/quota.yaml', 'examples/limitrange.yaml'],
    objectives: [
      { type: 'deploy', kind: 'ResourceQuota', name: 'compute-quota', label: 'Create the project ResourceQuota "compute-quota"' },
      { type: 'deploy', kind: 'LimitRange', name: 'resource-limits', label: 'Create the LimitRange "resource-limits"' },
      { type: 'deploy', kind: 'ClusterResourceQuota', name: 'team-quota', label: 'Create the ClusterResourceQuota "team-quota"' },
      { type: 'resources', kind: 'Deployment', name: 'web', label: 'Set container requests+limits on the web Deployment' },
      { type: 'resolve', incidentType: 'ResourceQuotaExceeded', count: 1, label: 'Resolve the ResourceQuotaExceeded incident' },
      { type: 'command', pattern: 'oc adm create-bootstrap-project-template', label: 'Generate the bootstrap project template' },
      { type: 'deploy', kind: 'Template', name: 'project-request', namespace: 'openshift-config', label: 'Create the project-request Template in openshift-config' },
      { type: 'command', pattern: 'oc (edit|patch) project\\.config', label: 'Point project.config.openshift.io/cluster at the template' },
    ],
    incidents: [{ type: 'ResourceQuotaExceeded', triggerTime: 20, target: 'quota-lab', severity: 3 }],
    hints: [
      'Switch projects: `oc project quota-lab`. Apply the example quota and limits: `oc apply -f examples/quota.yaml` and `oc apply -f examples/limitrange.yaml`.',
      'Create the multi-project quota: `oc create clusterquota team-quota --project-label-selector=name=quota-lab --hard=pods=10 --hard=secrets=20`.',
      'Set container resources: `oc set resources deployment/web --limits=cpu=500m,memory=512Mi --requests=cpu=100m,memory=128Mi`.',
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
      { type: 'deploy', kind: 'ServiceAccount', name: 'api-reader', label: 'Create ServiceAccount "api-reader"' },
      { type: 'deploy', kind: 'RoleBinding', count: 1, label: 'Bind the view role to the api-reader ServiceAccount' },
      { type: 'canI', verb: 'get', resource: 'pods', user: 'system:serviceaccount:sa-lab:api-reader', expected: true, label: 'api-reader can get pods via the API' },
      { type: 'command', pattern: 'oc auth can-i ', label: 'Verify access with oc auth can-i' },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project sa-lab`. Create the identity: `oc create serviceaccount api-reader`.',
      'Grant read access: `oc adm policy add-role-to-user view -z api-reader` (this creates a RoleBinding for the ServiceAccount).',
      'Run the app as the ServiceAccount: `oc set serviceaccount deployment/api api-reader`.',
      'Check with `oc auth can-i get pods --as=system:serviceaccount:sa-lab:api-reader -n sa-lab`.',
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
      'Security Context Constraints are OpenShift\'s pod admission gate. A workload is being rejected because no SCC allows its requested securityContext. Grant the privileged SCC to the project ServiceAccount (anyuid allows arbitrary UIDs but not privileged containers), run the privileged app, and clear the SCCForbidden incident.',
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
      deployment('privileged-app', { replicas: 1 }),
    ],
    availableResources: ['Project', 'Deployment', 'Pod', 'SecurityContextConstraints', 'ServiceAccount', 'RoleBinding'],
    objectives: [
      { type: 'scc', scc: 'privileged', subject: 'system:serviceaccount:*:default', expected: true, label: 'Grant the privileged SCC to the project default ServiceAccount' },
      { type: 'privileged', count: 1, label: 'Run a privileged workload container (or UID 0 app)' },
      { type: 'resolve', incidentType: 'SCCForbidden', count: 1, label: 'Resolve the SCCForbidden incident' },
    ],
    incidents: [{ type: 'SCCForbidden', triggerTime: 15, target: 'privileged-app', severity: 4 }],
    hints: [
      'Check which SCC applies: `oc get scc`, then `oc adm policy who-can use scc privileged`.',
      'Grant the SCC to the ServiceAccount: `oc adm policy add-scc-to-user privileged -z default -n privileged-lab`.',
      'Run privileged: `oc edit deployment/privileged-app`, then add `securityContext: {privileged: true}` to the container spec (or `oc patch deployment/privileged-app --type=merge -p \'{"spec":{"template":{"spec":{"containers":[{"name":"main","securityContext":{"privileged":true}}]}}}}\'`) — this only admits with the privileged SCC granted above.',
      'Verify with `oc describe scc privileged | grep -A2 Users`, `oc get pods`, and resolve the SCCForbidden incident in the Incident panel.',
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
      'Operators extend the cluster API. Install an operator from a Subscription, watch the CSV reach Succeeded, then uninstall it cleanly by deleting the Subscription and CSV. Both install and removal are EX280 objectives.',
    examObjectives: [
      'Manage OpenShift operators > Install an operator',
      'Manage OpenShift operators > Uninstall an operator',
      'Manage OpenShift operators > Delete an operator',
    ],
    docsLinks: [DOCS.operators, DOCS.operatorAdmin, DOCS.operatorOlm],
    startingResources: [node('node-1'), node('node-2'), project('operator-lab')],
    availableResources: ['Project', 'Subscription', 'ClusterOperator'],
    manifestFiles: ['examples/subscription.yaml'],
    focusFiles: ['examples/subscription.yaml'],
    objectives: [
      { type: 'operator', name: 'metallb', installed: true, label: 'Install operator "metallb" (CSV reaches Succeeded)' },
      { type: 'command', pattern: 'oc (get|describe) (sub|subscription|csv|installplan)', label: 'Verify the Subscription / CSV / InstallPlan' },
      { type: 'operator', name: 'metallb', installed: false, label: 'After installing, uninstall the operator (delete Subscription + CSV)' },
    ],
    incidents: [],
    hints: [
      'Install: edit `examples/subscription.yaml` so metadata.name, spec.name and the package are `metallb`, then `oc apply -f examples/subscription.yaml`.',
      'Watch OLM: `oc get sub,csv,installplan -n openshift-operators` — the CSV goes Installing → Succeeded, and `oc get sub metallb -o yaml` then reports `status.installedCSV`.',
      'Uninstall (only after the install above reached Succeeded): `oc delete subscription metallb -n openshift-operators`, then delete the CSV shown by `oc get csv -n openshift-operators`.',
      'Confirm removal with `oc get csv -n openshift-operators` and `oc get subscription -A`.',
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
      'Batch workloads run to completion. Create a Job that succeeds, a CronJob that schedules future runs, and fix a JobDeadlineExceeded incident so the batch pipeline finishes reliably.',
    examObjectives: [
      'Configure application security > Deploy jobs to perform one-time tasks',
      'Configure application security > Configure Kubernetes cron jobs',
    ],
    docsLinks: [DOCS.jobs, DOCS.cli],
    startingResources: [node('node-1'), node('node-2'), project('batch-lab')],
    availableResources: ['Project', 'Job', 'CronJob', 'Pod', 'Node'],
    objectives: [
      { type: 'complete', kind: 'Job', count: 1, label: 'Run a Job to phase Complete' },
      { type: 'cronJob', name: 'cleanup', suspended: false, label: 'Create the CronJob "cleanup" (not suspended)' },
      { type: 'resolve', incidentType: 'JobDeadlineExceeded', count: 1, label: 'Resolve the JobDeadlineExceeded incident' },
      { type: 'command', pattern: 'oc (create|apply) .*(job|cronjob)', label: 'Create the batch objects with oc create/apply' },
    ],
    incidents: [{ type: 'JobDeadlineExceeded', triggerTime: 30, target: 'report-job', severity: 2 }],
    hints: [
      'Switch projects: `oc project batch-lab`. Run a one-off Job: `oc create job report-job --image=perl -- perl -e "print 42"`.',
      'Watch it complete: `oc get jobs,pods`, then `oc logs job/report-job`.',
      'Schedule recurring work: `oc create cronjob cleanup --image=busybox --schedule="*/5 * * * *" -- sh -c date`.',
      'Investigate the JobDeadlineExceeded incident in the Incident panel, fix the Job (raise `activeDeadlineSeconds` or `backoffLimit`), and resolve it.',
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
      'Capstone. Build a complete production platform the way EX280 expects: a Project with quota and limits, the webapp Deployment + Service + TLS Route, a source Build feeding an ImageStream, a developer User/Group with a NetworkPolicy, MetalLB, a Job and a CronJob, plus an Architecture Advisor score of 25 or more and a composite drill score of 75 or more (both are in-game metrics, not Red Hat exam scores).',
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
    docsLinks: [DOCS.quotas, DOCS.deployments, DOCS.routes, DOCS.builds, DOCS.operators, DOCS.jobs, DOCS.networkSecurity],
    startingResources: [node('node-1', '16', '32Gi'), node('node-2', '16', '32Gi'), node('node-3', '16', '32Gi')],
    availableResources: [
      'Project', 'ResourceQuota', 'LimitRange', 'Deployment', 'Pod', 'Service', 'Route',
      'Secret', 'NetworkPolicy', 'BuildConfig', 'Build', 'ImageStream', 'Template',
      'Subscription', 'User', 'Group', 'RoleBinding', 'ServiceAccount', 'SecurityContextConstraints',
      'Job', 'CronJob', 'Node',
    ],
    manifestFiles: ['manifests/deployment.yaml', 'manifests/service.yaml', 'manifests/route.yaml', 'examples/quota.yaml', 'examples/limitrange.yaml', 'examples/buildconfig.yaml', 'examples/subscription.yaml', 'examples/default-deny.yaml'],
    focusFiles: ['manifests/deployment.yaml', 'manifests/route.yaml', 'examples/quota.yaml', 'examples/default-deny.yaml'],
    objectives: [
      { type: 'project', name: 'prod-platform', label: 'Create the Project "prod-platform"' },
      { type: 'deploy', kind: 'ResourceQuota', name: 'compute-quota', label: 'Apply a project ResourceQuota' },
      { type: 'deploy', kind: 'LimitRange', name: 'resource-limits', label: 'Apply a project LimitRange' },
      { type: 'deploy', kind: 'Deployment', name: 'webapp', label: 'Deploy webapp from manifests/deployment.yaml' },
      { type: 'deploy', kind: 'Service', name: 'webapp', label: 'Expose webapp with a Service' },
      { type: 'route', name: 'webapp', label: 'Create an external Route "webapp" (Admitted)' },
      { type: 'build', name: 'webapp', count: 1, label: 'Complete a Build for the webapp BuildConfig' },
      { type: 'imageStream', name: 'webapp', tag: 'latest', label: 'ImageStream webapp has the :latest tag' },
      { type: 'deploy', kind: 'NetworkPolicy', name: 'default-deny', label: 'Add a default-deny NetworkPolicy' },
      { type: 'user', name: 'developer', label: 'Create the User "developer"' },
      { type: 'group', name: 'developers', users: ['developer'], label: 'Create Group "developers" containing developer' },
      { type: 'operator', name: 'metallb', installed: true, label: 'Install the MetalLB operator' },
      { type: 'complete', kind: 'Job', count: 1, label: 'Run a Job to phase Complete' },
      { type: 'cronJob', name: 'nightly', suspended: false, label: 'Create the CronJob "nightly"' },
      // NOTE: threshold is deliberately modest versus the current ScoringEngine scale...
      // a solid capstone platform scores ~34 today; modes-dev's rewritten advisor may rescale.
      { type: 'architectureScore', minScore: 25, label: 'Architecture Advisor score >= 25' },
      { type: 'examScore', minScore: 75, label: 'Composite drill score >= 75 (in-game metric, not a Red Hat exam score)' },
    ],
    incidents: [
      { type: 'CrashLoopBackOff', triggerTime: 60, target: 'webapp', severity: 2 },
      { type: 'NodeNotReady', triggerTime: 120, target: 'node-2', severity: 3 },
    ],
    hints: [
      'Create the platform project: `oc new-project prod-platform`, then apply the quota/limits with `oc apply -f examples/quota.yaml` and `oc apply -f examples/limitrange.yaml`.',
      'Deploy the app: `oc apply -f manifests/deployment.yaml`, `oc apply -f manifests/service.yaml`, then expose a Route: `oc create route edge webapp --service=webapp`. Enable ports/health probes in the YAML for a higher Architecture Advisor score.',
      'Build: `oc apply -f examples/buildconfig.yaml` (it already outputs ImageStreamTag `webapp:latest`), then `oc start-build webapp --follow` and watch the Build reach Complete.',
      'Security/self-service: `oc create user developer`, `oc adm groups new developers developer`, apply the shipped `examples/default-deny.yaml` (a `networking.k8s.io/v1` NetworkPolicy that selects all pods) with `oc apply -f examples/default-deny.yaml -n prod-platform` — there is no `oc create networkpolicy` subcommand; use the Files panel New/Import buttons if you want to edit or add manifests. Install MetalLB from `examples/subscription.yaml` (edit its name/package to metallb first).',
      'Finish with a Job (`oc create job report-job --image=perl -- perl -e "print 42"`), a CronJob (`oc create cronjob nightly --image=busybox --schedule="*/5 * * * *" -- sh -c date`), then check `oc status` and the Architecture Advisor in the HUD.',
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
