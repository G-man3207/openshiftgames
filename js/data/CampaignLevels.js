/**
 * CampaignLevels — the EX280 curriculum for OpenShift Games (22 levels in 5 chapters) and the
 * campaign structure helpers; the Linux & RHEL Foundations prelude lives in LinuxLevels.js.
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
// The optional Linux & RHEL Foundations prelude (chapter 0, ids 101–107).
import { LINUX_LEVELS } from './LinuxLevels.js';

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
  networkPolicy:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/network-policy',
  nodes:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/working-with-nodes',
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

/**
 * The EX280 track (chapters 1–5). Ids are stable save keys (player progress is
 * stored per id), so a new level gets a NEW id and is placed by `CHAPTERS`;
 * this array may list levels in any order — `CAMPAIGN_LEVELS` below is sorted
 * into campaign order.
 */
const OPENSHIFT_LEVELS = [
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
      {
        type: 'login',
        user: 'kubeadmin',
        label: 'Log in to the CLI as kubeadmin (oc login)',
        how: {
          explain:
            'The installer saved the `kubeadmin` password in the file `~/auth/kubeadmin-password`. `-p` takes the password, and `$(cat …)` pastes the content of that file there, so you do not type it.',
          run: ['oc login -u kubeadmin -p $(cat ~/auth/kubeadmin-password)'],
          check: 'oc whoami',
        },
      },
      {
        type: 'project',
        name: 'first-project',
        label: 'Create the Project "first-project"',
        how: {
          explain:
            'A Project is a named, separate space for your apps (Kubernetes calls it a namespace). `oc new-project` creates it and switches you into it, so your next commands run inside it.',
          run: ['oc new-project first-project'],
          check: 'oc project',
        },
      },
      {
        type: 'deploy',
        kind: 'Pod',
        name: 'hello-pod',
        running: true,
        label: 'Run a bare Pod named "hello-pod" that reaches Running',
        how: {
          explain:
            'A Pod is the smallest unit OpenShift runs. `oc run` starts one bare Pod that nothing recreates if you delete it; use this image, because a typical `nginx` image crashes here (OpenShift runs containers as a random non-root user).',
          run: ['oc run hello-pod --image=quay.io/openshift/origin-hello-openshift:latest'],
          check: 'oc get pod hello-pod',
        },
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'hello-deploy',
        running: true,
        label: 'Create the Deployment "hello-deploy" with an available replica',
        how: {
          explain:
            'A Deployment keeps a chosen number of identical Pods (replicas) running and replaces any that fail. `oc create deployment` starts it with one replica; use the same image as for the Pod, because `nginx` would crash here too.',
          run: [
            'oc create deployment hello-deploy --image=quay.io/openshift/origin-hello-openshift:latest',
          ],
          check: 'oc get deployment hello-deploy',
        },
      },
    ],
    incidents: [],
    hints: [
      'Log in first. The installer saves the kubeadmin password in its auth directory: `cat ~/auth/kubeadmin-password`, then `oc login -u kubeadmin` and type (paste) that password at the `Password:` prompt — or pass it directly with `oc login -u kubeadmin -p <password>`. The kubeadmin secret does NOT contain the password: `oc extract secret/kubeadmin -n kube-system --to=-` prints only a bcrypt hash of it (a `$2a$10$…` hash). Check `oc whoami` afterwards.',
      'Create the project: `oc new-project first-project --display-name="First Project"`. `oc project` shows the current project.',
      'Create a Deployment: `oc create deployment hello-deploy --image=quay.io/openshift/origin-hello-openshift:latest`, then verify `oc get deployments,pods`. The level also asks for a bare Pod — `oc run hello-pod --image=quay.io/openshift/origin-hello-openshift:latest` deploys one, and the Pod view mirrors `oc describe pod`.',
      'Use the image the level gives you. Many Docker Hub images, such as `nginx:latest`, expect to run as root, but OpenShift starts every container as a random non-root user, so they crash right after starting (Level 17 explains the security rules behind this). If you tried one, delete it with `oc delete pod hello-pod` and run it again with `quay.io/openshift/origin-hello-openshift:latest`.',
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
      'Every EX280 task starts with `oc get`. Learn to query resources, filter them with label selectors, reshape output with `-o wide|yaml|json|jsonpath|custom-columns`, and ask the API for documentation with `oc explain`. Everything happens in project `query-lab`, where the Deployment `web` is already running.',
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
        pattern:
          'oc\\s+(-n\\s+\\S+\\s+)?get\\s+(-n\\s+\\S+\\s+)?(\\S*,)?(deploy|deployments?|all)(\\s|,|$)',
        // A read only counts when it ran in query-lab and listed something (1.16.0).
        inspect: true,
        label: 'Use oc get to list Deployments',
        how: {
          explain:
            '`oc get` lists the objects of one kind in your current project. A Deployment is the object that keeps a set of identical Pods running; the project already has one named `web`.',
          run: ['oc get deployments'],
        },
      },
      {
        type: 'label',
        kind: 'Deployment',
        name: 'web',
        key: 'tier',
        value: 'frontend',
        label: 'Label Deployment web with tier=frontend',
        how: {
          explain:
            'A label is a `key=value` tag on an object, and selectors use labels to find objects. `oc label` puts `tier=frontend` on the Deployment `web`.',
          run: ['oc label deployment/web tier=frontend'],
          check: 'oc get deployment web --show-labels',
        },
      },
      {
        type: 'command',
        pattern: 'oc get .*(-o|--output)(=|\\s+)(wide|yaml|json|custom-columns|jsonpath|name)',
        inspect: true,
        label: 'Format output with -o wide/yaml/json/jsonpath',
        how: {
          explain:
            '`-o` changes how `oc get` prints: `wide` adds columns, `yaml` and `json` print the whole object, `jsonpath` pulls out single fields. Any one of these ticks this.',
          run: ['oc get deployments -o wide'],
        },
      },
      {
        type: 'command',
        pattern: 'oc explain ',
        label: 'Use oc explain to inspect a resource schema',
        how: {
          explain:
            '`oc explain` prints the built-in documentation of an API object. A dotted path such as `deployment.spec.replicas` zooms in on one field.',
          run: ['oc explain deployment.spec.replicas'],
        },
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'api',
        label: 'Create a second Deployment named "api"',
        how: {
          explain:
            '`oc create deployment` starts a Deployment from a container image. Create it in project `query-lab`, next to `web`: a Deployment `api` in another project does not count.',
          run: ['oc create deployment api --image=quay.io/openshift/origin-hello-openshift:latest'],
          check: 'oc get deployment api',
        },
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
      'Read the symptoms before you fix anything. About 10 seconds after the level starts, an incident rolls an invalid `APP_MODE` value into the `web-app` Deployment in project `ops-lab`: its new Pods crash on every start (CrashLoopBackOff) while the old Pods keep serving. Find the bad value in the logs and in the Deployment, correct it there (restarting or deleting Pods changes nothing), and bring cluster health back to 90% or better.',
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
        how: {
          explain:
            'Nothing to type: this stays ticked as long as the Deployment `web-app` exists in project `ops-lab`. About 10 seconds after you start the level an incident makes its new Pods crash; repair the Deployment, never delete it.',
          check: 'oc get deployment web-app',
        },
      },
      {
        type: 'command',
        pattern: 'oc (get|describe) pods?',
        // Graded on what the read showed (1.16.0): `oc get pods` in `default`
        // prints "No resources found" and does not count.
        inspect: true,
        label: 'Inspect Pods with oc get/oc describe',
        how: {
          explain:
            '`oc get pods` lists the Pods and their `STATUS`. Once the incident has started, a new Pod shows `CrashLoopBackOff`: its container keeps crashing and Kubernetes waits longer before each restart.',
          run: ['oc get pods'],
        },
      },
      {
        type: 'command',
        pattern: 'oc logs ',
        inspect: true,
        label: 'Read container logs with oc logs',
        how: {
          explain:
            '`oc logs` prints what a container wrote. `deployment/web-app` lets `oc` pick one Pod; to read a crash, run `oc logs POD --previous` with the name of the Pod that is not ready, taken from `oc get pods`.',
          run: ['oc logs deployment/web-app'],
        },
      },
      {
        type: 'investigate',
        incidentType: 'CrashLoopBackOff',
        progress: 0.5,
        label: 'Investigate the CrashLoopBackOff incident',
        how: {
          explain:
            'The incident starts about 10 seconds into the level and the Incidents panel opens on the left. Two investigation steps tick this: use two of its commands (they carry the real Pod name) or run the two below. Only commands that run in `ops-lab` and show something count; the panel counter moves with them.',
          run: ['oc describe deployment/web-app', 'oc get events --sort-by=.lastTimestamp'],
        },
      },
      {
        type: 'resolve',
        incidentType: 'CrashLoopBackOff',
        count: 1,
        label: 'Resolve the CrashLoopBackOff',
        how: {
          explain:
            'The Deployment passes `APP_MODE=debug-invalid` to its containers and the app rejects that value. `oc set env` writes a valid one into the Deployment, which then replaces the crashing Pods; restarting or deleting Pods only brings the bad value back.',
          run: ['oc set env deployment/web-app APP_MODE=production'],
          check: 'oc get pods',
        },
      },
      {
        type: 'clusterHealth',
        minPercent: 90,
        label: 'Restore cluster health to 90% or better',
        how: {
          explain:
            'Nothing to type: this ticks by itself after the incident has happened and been resolved. If it stays open the incident is still active; `oc set env deployment/web-app --list` should show `APP_MODE=production`.',
          check: 'oc get pods',
        },
      },
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
      'Crashed, or never started? CrashLoopBackOff means the container starts and then exits — read why with `oc logs <pod> --previous`. A root-expecting image such as `nginx:latest` crashes this way with `mkdir "/var/cache/nginx/client_temp" failed (13: Permission denied)`, because OpenShift runs it as a random non-root user (Level 17 covers the rules). ImagePullBackOff means the image never downloaded, and CreateContainerConfigError means a referenced ConfigMap or Secret key is missing: `oc describe pod <pod>` shows which in its State and Events.',
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
      'Stop typing long commands and describe what you want in YAML files instead. Read or edit `manifests/deployment.yaml` and `manifests/service.yaml` in the Files panel (press `F`), create the objects from them with `oc apply -f`, export the live Deployment with `oc get -o yaml`, then let `--dry-run=client -o yaml` write a new manifest for you and apply it. Everything happens in project `manifests-lab`.',
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
        how: {
          explain:
            'A manifest is a YAML file that describes an object; `oc apply -f` creates the object from it, or updates it if it exists. Read the file first in the Files panel (press `F`).',
          run: ['oc apply -f manifests/deployment.yaml'],
          check: 'oc get deployment webapp',
        },
      },
      {
        type: 'manifest',
        file: 'manifests/service.yaml',
        label: 'Apply manifests/service.yaml with oc apply -f',
        how: {
          explain:
            'The same command creates the Service: it gives the Pods of `webapp` one stable address and port inside the cluster.',
          run: ['oc apply -f manifests/service.yaml'],
          check: 'oc get service webapp',
        },
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'webapp',
        label: 'The Deployment "webapp" exists in project manifests-lab',
        how: {
          explain:
            'Nothing to type: this ticks by itself once `manifests/deployment.yaml` has created `webapp` in project `manifests-lab`. If it stays empty although `oc get deployments` shows `webapp`, you applied the file in another project: run `oc project manifests-lab`, then apply it again.',
          check: 'oc get deployment webapp',
        },
      },
      {
        type: 'deploy',
        kind: 'Service',
        name: 'webapp',
        label: 'The Service "webapp" exists in project manifests-lab',
        how: {
          explain:
            'Nothing to type: this ticks by itself once `manifests/service.yaml` has created `webapp` in project `manifests-lab`. If it stays empty although `oc get services` shows `webapp`, you applied the file in another project: run `oc project manifests-lab`, then apply it again.',
          check: 'oc get service webapp',
        },
      },
      {
        type: 'command',
        pattern: 'oc get .*(-o|--output)(=|\\s+)(yaml|json)',
        // An empty List from an empty project is not a live resource (1.16.0).
        inspect: true,
        label: 'Export a live resource with oc get -o yaml/json',
        how: {
          explain:
            '`-o yaml` prints the live object as YAML, including fields the cluster filled in, such as `status`. Add `> /tmp/webapp.yaml` to save it to a file instead of printing it.',
          run: ['oc get deployment webapp -o yaml'],
        },
      },
      // 1.16.0 curriculum review: `--dry-run=client -o yaml > file` skeletons are an
      // EX280 staple (lab 12's immutable-Job fix relies on them) and were never taught.
      {
        type: 'command',
        pattern: '^oc create (?=.*--dry-run=client)(?=.*(-o|--output)(=|\\s+)?yaml)',
        label: 'Generate a manifest skeleton with --dry-run=client -o yaml',
        how: {
          explain:
            '`--dry-run=client -o yaml` prints the YAML an `oc create` command WOULD send, without creating anything: the fastest way to start a manifest. `>` saves the output to a file instead of the screen. It works for deployments, services, secrets, configmaps, jobs, cronjobs, roles and more.',
          run: [
            'oc create deployment api --image=quay.io/openshift/origin-hello-openshift:latest --dry-run=client -o yaml > manifests/api.yaml',
          ],
          check: 'cat manifests/api.yaml',
        },
      },
      {
        type: 'manifest',
        file: 'manifests/api.yaml',
        label: 'Apply your generated manifests/api.yaml with oc apply -f',
        how: {
          explain:
            'The generated file is a normal manifest: edit it if you like (Files panel, press `F`), then create the Deployment `api` from it with `oc apply -f`.',
          run: ['oc apply -f manifests/api.yaml'],
          check: 'oc get deployment api',
        },
      },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project manifests-lab`. Open the Files panel and review `manifests/deployment.yaml`.',
      'Apply the manifests: `oc apply -f manifests/deployment.yaml` then `oc apply -f manifests/service.yaml`.',
      'Re-apply after an edit is safe and idempotent — edit the YAML in the Files panel, `oc apply -f manifests/deployment.yaml` again, then compare with `oc get deployment webapp -o yaml`.',
      'Export the live object: `oc get deployment/webapp -o yaml > /tmp/webapp.yaml` (the download/editor keeps it in the virtual file system).',
      'Never type YAML from scratch: `oc create deployment api --image=quay.io/openshift/origin-hello-openshift:latest --dry-run=client -o yaml > manifests/api.yaml` writes a ready skeleton (nothing is created yet), and `oc create job`, `cronjob`, `secret`, `configmap`, `service clusterip` and `route edge` accept the same flags. Edit the file, then `oc apply -f manifests/api.yaml`.',
    ],
    starCriteria: { time: 360, efficiency: 0.8, noFailures: true },
    nextLevel: 5,
  },

  // ═══════════════════════ CHAPTER 2 — DECLARATIVE & KUSTOMIZE ═══════════════════════
  {
    id: 5,
    title: 'Kustomize Base',
    chapter: 2,
    chapterName: 'Declarative & Kustomize',
    description:
      'Kustomize lets you keep one base set of YAML files and reuse it for every environment. Apply the folder `kustomize/base` with `oc apply -k`, then check the Deployment and Service it created. Work in project `kustomize-lab`.',
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
        how: {
          explain:
            'Kustomize builds Kubernetes objects from a folder whose `kustomization.yaml` lists the YAML files to use (see it in the Files panel, press `F`). `oc apply -k` builds and creates them; `oc kustomize kustomize/base` previews the result first.',
          run: ['oc apply -k kustomize/base'],
          check: 'oc get deployments,services',
        },
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'webapp',
        label: 'The base Deployment "webapp" was created',
        how: {
          explain:
            'Nothing to type: this ticks by itself once `oc apply -k kustomize/base` has created `webapp` in project `kustomize-lab`. If it stays empty although `oc get deployments` shows `webapp`, you applied it in another project: run `oc project kustomize-lab`, then apply it again.',
          check: 'oc get deployment webapp',
        },
      },
      {
        type: 'command',
        pattern: 'oc apply (-k|--kustomize)[ =]',
        label: 'Use oc apply -k (Kustomize rendering)',
        how: {
          explain:
            'Nothing more to type: this ticks together with the first objective, because that command is `oc apply -k` (the long form `--kustomize` counts too). Previewing with `oc kustomize … | oc apply -f -` does not.',
        },
      },
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
      'An overlay is a folder that changes the base objects for one environment: project, name prefix, image tag, replica count and patches. Apply the `prod` overlay with `oc apply -k`: it creates the Deployment `prod-webapp` in project `webapp-prod` with 3 replicas and a pinned image tag, so you can run it from any project.',
    examObjectives: ['Declarative Resource Management > Work with Kustomize overlays'],
    docsLinks: [DOCS.cli, DOCS.deployments],
    startingResources: [node('node-1'), node('node-2'), project('webapp-prod')],
    // The overlay sets `namespace: webapp-prod` itself, so the player applies it from any project.
    workProject: null,
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
        how: {
          explain:
            'An overlay is a folder that adjusts the base objects for one environment. `oc apply -k` builds the final YAML from it and creates the objects; the overlay names the project `webapp-prod` itself, so you can run it from any project.',
          run: ['oc apply -k kustomize/overlays/prod'],
          check: 'oc get deployment,service -n webapp-prod',
        },
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'prod-webapp',
        label: 'Prefixed Deployment "prod-webapp" exists',
        how: {
          explain:
            'Nothing to type: this ticks by itself once the overlay creates `prod-webapp` (the prefix `prod-` plus `webapp`) in project `webapp-prod`. If it stays empty, you applied another folder: only `kustomize/overlays/prod` creates it.',
          check: 'oc get deployment prod-webapp -n webapp-prod',
        },
      },
      {
        type: 'scale',
        kind: 'Deployment',
        name: 'prod-webapp',
        replicas: 3,
        label: 'prod-webapp runs 3 replicas (replica override)',
        how: {
          explain:
            'Nothing to type: the overlay has a `replicas:` entry that raises the count from 1 (the base) to 3, so this ticks together with the apply. `READY 3/3` in the check shows all three Pods are up.',
          check: 'oc get deployment prod-webapp -n webapp-prod',
        },
      },
      {
        type: 'image',
        kind: 'Deployment',
        name: 'prod-webapp',
        imageContains: 'origin-hello-openshift',
        label: 'prod-webapp uses the patched webapp image',
        how: {
          explain:
            'Nothing to type: the overlay pins the image tag to `1.0.0` and its patch file adds the variable `APP_ENV`, so this ticks together with the apply. The `IMAGES` column of the check shows the image in use.',
          check: 'oc get deployment prod-webapp -n webapp-prod -o wide',
        },
      },
      {
        type: 'command',
        pattern: 'oc apply (-k|--kustomize)[ =]',
        label: 'Use oc apply -k on the overlay directory',
        how: {
          explain:
            'Nothing more to type: this ticks together with the first objective, because that command is `oc apply -k` (the long form `--kustomize` counts too). Previewing with `oc kustomize … | oc apply -f -` does not.',
        },
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
      'Keep settings out of your container image: ordinary settings go in a ConfigMap, sensitive values in a Secret. Create both in project `config-lab`, then connect them to the `app` Deployment: the ConfigMap as a mounted volume, the Secret as environment variables.',
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
        // Graded in the lab project: a ConfigMap created in `default` must not tick
        // the objective (the player could not connect it to the Deployment anyway).
        namespace: 'config-lab',
        label: 'Create the ConfigMap "app-config"',
        how: {
          explain:
            'A ConfigMap holds ordinary, non-secret settings as key=value pairs. `--from-literal` puts one pair straight on the command line.',
          run: ['oc create configmap app-config --from-literal=APP_MODE=production'],
          check: 'oc get configmap app-config',
        },
      },
      {
        type: 'deploy',
        kind: 'Secret',
        name: 'db-secret',
        namespace: 'config-lab',
        label: 'Create the Secret "db-secret"',
        how: {
          explain:
            'A Secret works like a ConfigMap but is meant for sensitive values such as passwords. `generic` means a plain key=value Secret.',
          run: ['oc create secret generic db-secret --from-literal=password=s3cret'],
          check: 'oc get secret db-secret',
        },
      },
      {
        type: 'mount',
        kind: 'ConfigMap',
        count: 1,
        label: 'Mount the ConfigMap "app-config" into the "app" Deployment as a volume',
        how: {
          explain:
            'Mounting shows the keys of the ConfigMap as files inside the container (here the file `APP_MODE` appears under `/etc/app`). `oc set volume` adds the volume and the mount to the Deployment in one step; its pods restart with the change.',
          run: [
            'oc set volume deployment/app --add --name=cfg --type=configmap --configmap-name=app-config --mount-path=/etc/app',
          ],
          check: 'oc set volume deployment/app',
        },
      },
      {
        type: 'envFrom',
        kind: 'Secret',
        count: 1,
        label: 'Inject the Secret "db-secret" into the "app" Deployment as environment variables',
        how: {
          explain:
            '`oc set env --from=secret/<name>` copies every key of the Secret into the container as an environment variable (here `password`). The pods restart with the change.',
          run: ['oc set env deployment/app --from=secret/db-secret'],
          check: 'oc set env deployment/app --list',
        },
      },
      {
        type: 'noConfigMap',
        sensitive: true,
        label: 'Keep ConfigMaps free of sensitive keys (password, secret, token, key)',
        how: {
          explain:
            'Nothing to type: this rule is checked all the time and is already satisfied. It turns red if a ConfigMap gets a key named like `password`, `secret`, `token` or `key`. Sensitive values belong in a Secret, so move them there and delete the ConfigMap key.',
          check: 'oc get configmap -o yaml',
        },
      },
    ],
    incidents: [],
    hints: [
      'Work in project `config-lab`; the Deployment `app` already lives there. Run `oc project config-lab` first. If a command says `deployments.apps "app" not found`, you are in the wrong project (`oc project` shows which one).',
      'ConfigMap or Secret? Both store key=value data. Use a ConfigMap for harmless settings (`APP_MODE=production`) and a Secret for anything sensitive (`password=s3cret`). Never put a password in a ConfigMap.',
      'Order: create the ConfigMap and the Secret first, then connect them to the Deployment (`oc set volume` for the ConfigMap, `oc set env --from=secret/…` for the Secret).',
      'Verify your work with `oc set volume deployment/app` (shows the mount), `oc set env deployment/app --list` (shows the Secret keys) and `oc get configmap,secret`.',
      'Made a mistake? Remove a volume with `oc set volume deployment/app --remove --name=cfg`, or delete an object and create it again.',
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
      'Two ways to package an app. A Template is a file with parameters: `oc process` fills them in and `oc apply` creates the objects. A Helm chart is a folder that `helm install` turns into a named release. Work in project `template-lab`: read both files in the Files panel (press `F`), then run the commands in the terminal.',
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
        label: 'Process templates/webapp-template.yaml with APP_NAME=web and apply the result',
        how: {
          explain:
            'A Template is a file with parameters such as `APP_NAME`. `oc process` fills them in and prints the objects (nothing is created yet); piping that output into `oc apply -f -` creates them. The **Apply -f** button in the Files panel only stores the Template, so do this step in the terminal.',
          run: ['oc process -f templates/webapp-template.yaml -p APP_NAME=web | oc apply -f -'],
          check: 'oc get deployment,service,route',
        },
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'web',
        label: 'The template created the Deployment "web"',
        how: {
          explain:
            'Nothing to type: this ticks once the Deployment `web` from the template exists in project `template-lab`. The template also creates a Service and a Route (they make the app reachable; Level 11 covers both). If it stays empty although `oc get deployment` shows `web`, you are in another project: run `oc project`.',
          check: 'oc get deployment web',
        },
      },
      {
        type: 'helm',
        release: 'shop',
        chart: 'webapp',
        label: 'Install the Helm release "shop" from the chart helm/webapp',
        how: {
          explain:
            'A Helm chart is a folder holding `Chart.yaml`, `values.yaml` and templates. `helm install <release-name> <chart-folder>` installs it as a release named `shop`.',
          run: ['helm install shop helm/webapp'],
          check: 'helm list',
        },
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'shop',
        label: 'The chart created the Deployment "shop"',
        how: {
          explain:
            'Nothing to type: this ticks by itself once the Deployment `shop` from the release exists in project `template-lab`. If it stays empty, check `oc project` — the release installs into your current project.',
          check: 'oc get deployment shop',
        },
      },
    ],
    incidents: [],
    hints: [
      'Work in project `template-lab`. Run `oc project template-lab` first: the template and the chart both create their objects in your current project.',
      'Open the Files panel (press `F`) and read `templates/webapp-template.yaml` and `helm/webapp/` before you run anything; they show exactly what each command will create. Only read them there: **Apply -f** on the template file just stores the Template and creates no app.',
      'See which parameters the template accepts with `oc process --parameters -f templates/webapp-template.yaml`. `APP_NAME` is the one without a default value.',
      '`oc process` on its own only prints the objects; nothing exists until the output is piped into `oc apply -f -`. Add `-o yaml` to preview the result first.',
      'Confirm the Helm release with `helm list`, and both Deployments with `oc get deployments`.',
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
      "OpenShift can build a container image straight from source code. A BuildConfig is the recipe, a Build is one run of it, and the finished image is stored in an ImageStream that Deployments can use. In project `build-lab`, create an app from source, start another build, and examine the image's tags and digests.",
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
        how: {
          explain:
            '`oc new-app` builds an app from source: before the `~` goes the builder image (the Node.js tools), after it the Git repository, and `--name=webapp` names everything it creates. Look for `Build scheduled` in the output; the first Build takes about 10 seconds to reach STATUS Complete.',
          run: [
            'oc new-app openshift/nodejs:20-ubi9~https://github.com/openshift/nodejs-ex --name=webapp',
          ],
          check: 'oc get builds',
        },
      },
      {
        type: 'imageStream',
        name: 'webapp',
        tag: 'latest',
        label: 'ImageStream webapp has the :latest tag',
        how: {
          explain:
            'Nothing to type: when the Build finishes it pushes the image into the ImageStream `webapp` (the list of versions of that image) and tags it `latest`. If `oc get is webapp` shows the stream but this stays unticked, the app was created in another project: `oc project` must say `build-lab`.',
          check: 'oc get is webapp',
        },
      },
      {
        type: 'command',
        pattern: 'oc start-build ',
        label: 'Start a build with oc start-build',
        how: {
          explain:
            'A Build is one run of the BuildConfig recipe. `oc start-build webapp` queues another run, `webapp-2`, that rebuilds the image from the same source; the Builds of one BuildConfig run one after the other.',
          run: ['oc start-build webapp'],
          check: 'oc get builds',
        },
      },
      {
        type: 'command',
        // 1.16.0: graded on what the read showed — the webapp ImageStream in
        // build-lab (its registry repository) — so `oc get is` at level start
        // ("No resources found") no longer ticks, while `oc -n build-lab get is`,
        // `oc get is,istag` or `oc get all` listing the stream do.
        pattern:
          'oc (get|describe) (\\S+,)*(is|imagestreams?|imagestreamtags?|istags?|all)(?=[\\s,/.:]|$)',
        inspect: true,
        outputPattern: 'svc:5000/build-lab/webapp\\b',
        label: 'Examine the ImageStream with "oc get is" or "oc describe is"',
        how: {
          explain:
            'An ImageStream lists the versions (tags) of one image, and each tag points to one exact image by its digest, a `sha256:` fingerprint. `oc get is` lists the streams; once the first Build is Complete, `oc describe istag/webapp:latest` shows the digest, size and layers of the tag.',
          run: ['oc get is webapp', 'oc describe istag/webapp:latest'],
        },
      },
      {
        type: 'image',
        kind: 'Deployment',
        imageContains: 'webapp',
        label: 'A Deployment references the built webapp image',
        how: {
          explain:
            'Nothing to type after `oc new-app`: it creates the Deployment `webapp` for the built image, so this ticks right after it (if not, check `oc project` and `--name=webapp`). If you used the example BuildConfig instead, run `oc create deployment webapp --image=image-registry.openshift-image-registry.svc:5000/build-lab/webapp:latest`.',
          check: 'oc get deployment webapp -o wide',
        },
      },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project build-lab`. Create the build from source with `oc new-app openshift/nodejs:20-ubi9~https://github.com/openshift/nodejs-ex --name=webapp` (OCP 4.22 sample builder tags carry the `-ubi9` suffix).',
      'Watch the build: `oc logs -f bc/webapp` or `oc start-build webapp --follow`. The Build runs New → Pending → Running → Complete.',
      'Inspect the ImageStream: `oc get is webapp`, `oc describe istag/webapp:latest` — note the digest and internal registry pull spec.',
      'If your app came from the example BuildConfig instead (`oc apply -f examples/buildconfig.yaml`), start it with `oc start-build webapp --follow`, then create a Deployment that runs the built image from the internal registry: `oc create deployment webapp --image=image-registry.openshift-image-registry.svc:5000/build-lab/webapp:latest` (a bare `image: webapp:latest` is not resolved to the project ImageStream without an image trigger).',
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
      'A Deployment replaces its pods gradually (a rolling update): new pods start while the old ones keep serving. In project `rollout-lab`, update `api-server` to an image tag that does not exist, watch the new pod fail with ImagePullBackOff (it cannot download its image), then undo the update with `oc rollout undo`.',
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
        how: {
          explain:
            'A rolling update swaps old pods for new ones step by step. `oc set image` changes the image of the container named `main`; this tag does not exist, so within seconds the new pod shows ImagePullBackOff, the fault you undo next.',
          run: [
            'oc set image deployment/api-server main=quay.io/openshift/origin-hello-openshift:does-not-exist',
          ],
          check: 'oc get pods',
        },
      },
      {
        type: 'rollback',
        count: 1,
        label: 'Roll the Deployment back with oc rollout undo',
        how: {
          explain:
            '`oc rollout undo` puts the previous pod template, the one with the working image, back and replaces the failing pod. Run it once: a second undo would switch back to the bad image.',
          run: ['oc rollout undo deployment/api-server'],
          check: 'oc rollout status deployment/api-server',
        },
      },
      {
        type: 'uptime',
        percentage: 90,
        // 1.16.0: the availability of api-server itself (available vs. the
        // replicas it served at level start), not the incident health, which
        // stayed at 100 % in this incident-free level whatever happened.
        kind: 'Deployment',
        name: 'api-server',
        label: 'Keep availability at 90% or better during the rollout',
        how: {
          explain:
            'Nothing to type: this checks all the time that api-server keeps at least 90% of its pods available, and turns red if you scale it down or delete it or its working pods. A rolling update keeps the old pods serving until the new ones are ready, so the bad image costs no availability.',
          check: 'oc get deployment api-server',
        },
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
      'There is no separate incident to clear in this level: the rollback is the fix. Keep the working pods running (do not delete them or scale the Deployment down) so availability stays above 90%.',
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
      'Pods come and go, so a Service gives them one stable address, and a Route makes that Service reachable from outside the cluster. In project `route-lab`, create a Service for the `web` Deployment, make a certificate and its key with `openssl`, keep them in the TLS Secret `web-tls`, and publish `web` as an edge Route that serves that certificate (the router handles the HTTPS encryption).',
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
        how: {
          explain:
            'A Service gives pods one stable address inside the cluster. This one is named `web`, listens on port 8080 and sends traffic to port 8080 of the pods labeled `app=web`, which are the pods of the Deployment `web`.',
          run: ['oc create service clusterip web --tcp=8080:8080'],
          check: 'oc get service web',
        },
      },
      {
        type: 'connect',
        from: 'web',
        to: 'web',
        label: 'The Service selector matches the web workload',
        how: {
          explain:
            "Nothing to type: this ticks as soon as Service `web` exists in project `route-lab`, because `oc create service clusterip web` selects the label `app=web` that the Deployment's pods carry. If it stays unticked, check `oc project` and the Service name.",
          check: 'oc get endpoints web',
        },
      },
      {
        type: 'deploy',
        kind: 'Secret',
        name: 'web-tls',
        // Graded in the lab project: a Secret created in `default` must not tick
        // the objective (the Service and Route it belongs to live in `route-lab`).
        namespace: 'route-lab',
        // 1.16.0: only a real TLS Secret counts (an Opaque `web-tls` does not).
        secretType: 'kubernetes.io/tls',
        label: 'Make a certificate with openssl and keep it in the TLS Secret "web-tls"',
        how: {
          explain:
            'A TLS Secret is how OpenShift keeps a certificate and its private key, for workloads and for Routes that reference a Secret (the capstone does that). `openssl` creates a practice pair, `tls.crt` and `tls.key` (self-signed, fine for a lab); `oc create secret tls` stores both as `web-tls`.',
          run: [
            'openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=web-route-lab.apps.cluster.example.com"',
            'oc create secret tls web-tls --cert=tls.crt --key=tls.key',
          ],
          check: 'oc get secret web-tls',
        },
      },
      {
        type: 'route',
        name: 'web',
        termination: 'edge',
        label: 'Create the edge Route "web" with your certificate and get it Admitted',
        how: {
          explain:
            'A Route publishes a Service outside the cluster; `edge` means the router handles the HTTPS encryption, here with your certificate and key (`--cert`, `--key`) instead of its default one. Use `oc create route edge`, not `oc expose` (a plain Route): if a Route `web` already exists, run `oc delete route web` first.',
          run: ['oc create route edge web --service=web --cert=tls.crt --key=tls.key'],
          check: 'oc describe route web',
        },
      },
      {
        type: 'tls',
        enabled: true,
        termination: 'edge',
        // 1.16.0: the Route must carry its own certificate, not the router default.
        certificate: true,
        label: 'Terminate TLS at the Route (edge) with your own certificate',
        how: {
          explain:
            'Nothing to type: this ticks together with the Route above, because `--cert` and `--key` copy the files into the Route’s `spec.tls`. If it stays unticked, the Route was created without them (the router then serves its default certificate), is plain, or lives in another project.',
          check: 'oc get route web -o yaml',
        },
      },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project route-lab`. Create the Service: `oc create service clusterip web --tcp=8080:8080` (it selects app=web).',
      'Expose it with TLS at the Route and your certificate: `oc create route edge web --service=web --cert=tls.crt --key=tls.key` (omit the name to name the Route after the Service) — then `oc get route` shows the generated host `web-route-lab.apps.cluster.example.com` and the edge TERMINATION, and `oc describe route web` shows the Admitted event. Without `--cert`/`--key` the router serves its default wildcard certificate instead.',
      'Know the two expose forms: `oc expose svc/web --name=web-public --path=/api` creates a Route from an existing Service, while `oc expose deployment/<name>` creates ONLY a Service and never a Route (try it on another project/Deployment, not on web which already has a Service). Do not run a bare `oc expose svc/web`: it creates a plain Route named `web`, and the edge Route `web` can then only be created after `oc delete route web`.',
      'Create real TLS material first, named after the Route host: `openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=web-route-lab.apps.cluster.example.com"`, then `oc create secret tls web-tls --cert=tls.crt --key=tls.key`. Both `oc create secret tls` and `oc create route edge --cert` read those files from the virtual filesystem and fail with `error: open tls.crt: no such file or directory` when they are missing.',
      'Verify: `oc describe route web` — look for TLS Termination: edge and the Admitted condition; `oc get route web -o yaml` shows your certificate under `spec.tls.certificate`. Then `curl -k https://web-route-lab.apps.cluster.example.com` answers through the router.',
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
      'Not every app speaks HTTP through the router. In project `lb-lab`, publish the TLS app `tls-app` two ways: as a Service of type LoadBalancer with its own external IP address, and through a passthrough Route that forwards the encrypted traffic untouched. On this bare-metal cluster the platform team already installed the MetalLB operator (in its own project, `metallb-system`), which hands out those addresses: check that it is ready, then give it the configuration it needs. Installing an operator yourself comes later, in the Operators level.',
    examObjectives: [
      'Deploy applications > Expose applications to external access',
      'Configure network security > Configure networking components',
      'Configure network security > Create and edit external routes',
      'Configure network security > Secure external and internal traffic using TLS certificates',
      'Expose non-HTTP/SNI Applications > Configure a load balancer service',
      'Expose non-HTTP/SNI Applications > Configure external application access',
    ],
    docsLinks: [DOCS.metallb, DOCS.routes, DOCS.operatorOlm],
    // Two Projects are seeded (the lab and the operator's), so the project row is
    // explicit: everything the player creates outside metallb-system lives in lb-lab.
    workProject: 'lb-lab',
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('lb-lab'),
      // 1.16.0: MetalLB was installed by "the platform team". Its project, OperatorGroup
      // and Subscription are seeded (the same objects examples/operatorgroup.yaml and the
      // Operators level create) and the simulated OLM resolves the InstallPlan and brings
      // the CSV to Succeeded within a few game seconds. Installing an operator is taught
      // in the Operators level (L18); this level only uses one.
      project('metallb-system'),
      {
        kind: 'OperatorGroup',
        name: 'metallb-operatorgroup',
        namespace: 'metallb-system',
        spec: { targetNamespaces: ['metallb-system'] },
      },
      {
        kind: 'Subscription',
        name: 'metallb-operator',
        namespace: 'metallb-system',
        // Exactly the real Subscription spec: `spec.name` is the catalog package.
        spec: {
          channel: 'stable',
          installPlanApproval: 'Automatic',
          name: 'metallb-operator',
          source: 'redhat-operators',
          sourceNamespace: 'openshift-marketplace',
        },
      },
      // Self-consistent non-HTTP TLS fixture (issue #75): the nginx personality
      // serves TLS on 8443; the Service publishes port 443 named `https` and
      // targets the named container port. A passthrough Route therefore points
      // at a real TLS backend, and `curl -k https://<route-host>` answers 200.
      // Use the UBI nginx image: it runs as non-root, so restricted-v2 admits
      // and runs it — a bare `nginx:latest` is admitted but crashes as UID 0
      // (mkdir /var/cache/nginx … Permission denied), leaving 0 endpoints.
      // With two seeded Projects the default project is `default`, so both name lb-lab.
      {
        ...deployment('tls-app', {
          replicas: 2,
          image: 'registry.access.redhat.com/ubi9/nginx-122:latest',
          containerPort: 8443,
          containerPortName: 'https',
        }),
        namespace: 'lb-lab',
      },
      {
        ...service('tls-app', {
          app: 'tls-app',
          port: 443,
          portName: 'https',
          targetPort: 8443,
        }),
        namespace: 'lb-lab',
      },
    ],
    availableResources: [
      'Project',
      'Deployment',
      'Pod',
      'Service',
      'Route',
      'IPAddressPool',
      'L2Advertisement',
      'Node',
    ],
    manifestFiles: ['examples/metallb.yaml'],
    focusFiles: ['examples/metallb.yaml'],
    objectives: [
      {
        // The operator is installed for the player: the step is to read OLM's result,
        // and only a read that showed the CSV Succeeded counts (1.16.0).
        type: 'command',
        pattern:
          'oc\\s+(\\S+\\s+)*get\\s+(\\S*,)?(csv|clusterserviceversions?)(\\.operators\\.coreos\\.com)?(\\s|,|$)',
        inspect: true,
        namespace: 'metallb-system',
        outputPattern: 'Succeeded',
        label: 'Check the MetalLB operator the platform team installed (its CSV is Succeeded)',
        how: {
          explain:
            'An operator is an add-on that runs in its own project and looks after a kind of object for you. OLM installed MetalLB from a Subscription; the ClusterServiceVersion (CSV) is the installed operator version, and PHASE `Succeeded` means it is ready. It takes a few seconds after the level starts.',
          run: [
            'oc get subscription,installplan -n metallb-system',
            'oc get csv -n metallb-system',
          ],
          check: 'oc get pods -n metallb-system',
        },
      },
      {
        type: 'deploy',
        kind: 'MetalLB',
        name: 'metallb',
        namespace: 'metallb-system',
        label: 'Start MetalLB: create its MetalLB resource "metallb" in metallb-system',
        how: {
          explain:
            'An operator does nothing until you create its own kind of resource. A `MetalLB` object named `metallb` makes the operator start its controller and speaker Pods. `examples/metallb.yaml` holds it together with the address pool and the advertisement of the next two objectives.',
          run: ['oc apply -f examples/metallb.yaml'],
          check: 'oc get pods -n metallb-system',
        },
      },
      {
        type: 'deploy',
        kind: 'IPAddressPool',
        count: 1,
        namespace: 'metallb-system',
        label: 'Give MetalLB addresses to hand out (an IPAddressPool in metallb-system)',
        how: {
          explain:
            'Nothing more to type if you applied `examples/metallb.yaml`: its IPAddressPool `metallb-pool` lists the addresses MetalLB may give to LoadBalancer Services (192.168.100.200 to .210). On a real network they must be free addresses of the nodes’ subnet.',
          check: 'oc get ipaddresspools -n metallb-system',
        },
      },
      {
        type: 'deploy',
        kind: 'L2Advertisement',
        count: 1,
        namespace: 'metallb-system',
        label: 'Announce the pool on the network (an L2Advertisement in metallb-system)',
        how: {
          explain:
            'Nothing more to type if you applied `examples/metallb.yaml`: its L2Advertisement makes the speakers answer ARP requests for the pool’s addresses, so other machines can reach them. Without one a Service still gets an address from the pool, but no node announces it and nothing can reach it.',
          check: 'oc get l2advertisements -n metallb-system',
        },
      },
      {
        type: 'serviceType',
        kind: 'LoadBalancer',
        count: 1,
        namespace: 'lb-lab',
        label: 'Expose tls-app with a Service of type LoadBalancer that receives an EXTERNAL-IP',
        how: {
          explain:
            '`oc expose` creates a Service that selects the Pods of the Deployment; `--type=LoadBalancer` asks for an external address, which the MetalLB controller takes from the pool. EXTERNAL-IP shows `<pending>` until the operator, its MetalLB resource and a pool exist.',
          run: [
            'oc expose deployment tls-app --type=LoadBalancer --name=tls-app-lb --port=443 --target-port=8443',
          ],
          check: 'oc get service tls-app-lb',
        },
      },
      {
        type: 'route',
        name: 'tls-app',
        service: 'tls-app',
        termination: 'passthrough',
        targetPort: 'https',
        namespace: 'lb-lab',
        label: 'Expose tls-app with a passthrough Route targeting the Service port name https',
        how: {
          explain:
            'A passthrough Route forwards encrypted traffic untouched, so the app keeps its own certificate; it picks up the Service port named `https` by itself. If a plain Route `tls-app` (from `oc expose`) already exists, delete it first with `oc delete route tls-app`.',
          run: ['oc create route passthrough tls-app --service=tls-app'],
          check: 'oc describe route tls-app',
        },
      },
      {
        type: 'tls',
        enabled: true,
        termination: 'passthrough',
        namespace: 'lb-lab',
        label: 'Passthrough TLS termination is configured',
        how: {
          explain:
            'Nothing to type: this ticks together with the Route above, because `oc create route passthrough` sets the TLS termination to passthrough. If it stays unticked, the Route is plain or edge (see the TERMINATION column) or lives in another project.',
          check: 'oc get route',
        },
      },
    ],
    incidents: [],
    hints: [
      'Start with what the platform team left you: `oc get subscription,installplan,csv -n metallb-system` shows the Subscription (the install request), the approved InstallPlan and the CSV `metallb-operator.v4.22.0-202610281200`, which goes from Installing to Succeeded a few seconds after the level starts; `oc get pods -n metallb-system` shows the operator Pod.',
      'Configure the operator with its own resources, all in `metallb-system`: the `MetalLB` object starts the controller and the speakers, an `IPAddressPool` lists the addresses it may hand out and an `L2Advertisement` announces them on the local network. `examples/metallb.yaml` has all three; check them with `oc get metallb,ipaddresspools,l2advertisements -n metallb-system`.',
      'Give tls-app its own address: `oc expose deployment tls-app --type=LoadBalancer --name=tls-app-lb --port=443 --target-port=8443`. `oc get svc tls-app-lb` shows EXTERNAL-IP `<pending>` until MetalLB has a pool to use, then an address from the pool, and `oc describe svc tls-app-lb` shows MetalLB’s `IPAllocated` event. `oc create service loadbalancer` works too, but it selects the label `app=<service-name>`, so here it would reach no Pod.',
      'Check the seeded TLS app: `oc get deploy,svc,pods -n lb-lab` — the UBI nginx image serves TLS on container port 8443 (`https`), and the Service tls-app maps port 443 named `https` to it. A passthrough Route to a plain-HTTP backend would fail the TLS handshake, which is why this fixture is TLS end to end.',
      'Expose the non-HTTP app with a passthrough Route: `oc create route passthrough tls-app --service=tls-app` — the Route gets `spec.port.targetPort: https` (the Service port NAME, not the 8443 number). Confirm `oc describe route tls-app` shows passthrough TLS and Admitted=True, then `curl -k https://<route-host>` returns the nginx page (200).',
      'Why two ways? The router only carries HTTP, HTTPS and TLS with SNI on ports 80 and 443. A database, another TCP protocol or a client that needs a fixed IP address goes through a LoadBalancer (or NodePort) Service instead.',
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
      'OpenShift lets people log in through an identity provider. Set up the simplest one, HTPasswd: make a password file, store it in a Secret, point the cluster’s login settings (the OAuth resource) at it and log in as alice; then change her password and remove the departing user bob (his User and his Identity are separate objects, so both must go). Nothing here depends on the current project.',
    examObjectives: [
      'Manage authentication and authorization > Configure the HTPasswd identity provider for authentication',
      'Manage authentication and authorization > Create and delete users',
      'Manage authentication and authorization > Modify user passwords',
    ],
    docsLinks: [DOCS.idp, DOCS.usersGroups, DOCS.cli],
    // No objective is graded in a project: the Secret lives in openshift-config and
    // users, identities and the OAuth provider are cluster-scoped. The seeded
    // `identity-lab` project is never used, so the derived "switch to identity-lab"
    // project row would send players to a project where nothing is graded.
    workProject: null,
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
        // 1.16.0: the htpasswd TOOL adding alice (no -D). `htpasswd ` anywhere in
        // the line also matched `oc create secret … --from-file=htpasswd`, which
        // ticked this before any file existed (the Secret then held no users).
        pattern: '^(oc\\s+)?htpasswd\\s+(-(?![a-zA-Z]*D)[a-zA-Z]+\\s+)*[^-\\s]\\S*\\s+alice(\\s|$)',
        label: 'Add the user "alice" to the htpasswd file (htpasswd -c -B -b)',
        how: {
          explain:
            '`htpasswd` is the standard tool for password files. `-c` creates the file (named `htpasswd`), `-B` stores the password as a bcrypt hash (a scrambled form that cannot be reversed) and `-b` takes the password from the command line.',
          run: ['htpasswd -c -B -b htpasswd alice redhat123'],
          check: 'cat htpasswd',
        },
      },
      {
        // Issue #71: grade the resulting identity-provider state, not a hidden
        // Secret name. Any Secret the OAuth singleton references counts once
        // the auth rollout applied it (the shipped `htpass-secret` is only the
        // example name used by the hints).
        type: 'oauthProvider',
        providerType: 'HTPasswd',
        secretReferenced: true,
        label:
          'Create the htpasswd Secret and reference it from the OAuth identity provider (Secret in openshift-config)',
        how: {
          explain:
            'The first command stores the file in a Secret in `openshift-config`; the second adds an HTPasswd provider that uses it to the cluster’s login (OAuth) settings. The login pods then restart (about 5 seconds): this ticks once `oc get clusteroperators authentication` shows PROGRESSING False.',
          run: [
            'oc create secret generic htpass-secret --from-file=htpasswd -n openshift-config',
            'oc patch oauth cluster --type=merge -p \'{"spec":{"identityProviders":[{"name":"htpasswd","mappingMethod":"claim","type":"HTPasswd","htpasswd":{"fileData":{"name":"htpass-secret"}}}]}}\'',
          ],
          check: 'oc get clusteroperators authentication',
        },
      },
      {
        type: 'user',
        name: 'alice',
        // 1.16.0: a first login also creates the Identity `htpasswd:alice`;
        // `oc create user alice` alone (no Identity) does not tick.
        viaLogin: true,
        label: 'User "alice" exists after first login',
        how: {
          explain:
            'OpenShift creates a User only when someone logs in for the first time, so there is nothing to create by hand. This ticks together with the next objective, as soon as the login works. An admin can also pre-create one with `oc create user NAME` (the capstone does), but that alone never lets anyone log in and does not tick this objective.',
          run: ['oc login -u alice -p redhat123'],
          check: 'oc whoami',
        },
      },
      {
        type: 'login',
        user: 'alice',
        label: 'Log in to the CLI as alice',
        how: {
          explain:
            'Logs in with the password from your htpasswd file. If it says the identity provider is not ready, wait a few seconds for the rollout and run it again.',
          run: ['oc login -u alice -p redhat123'],
          check: 'oc whoami',
        },
      },
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
        how: {
          explain:
            'Only a cluster admin can change the Secret, so log in as kubeadmin first. Extract the file, change alice’s hash, write it back, wait until `oc get clusteroperators authentication` shows PROGRESSING False (about 5 seconds), then log in with the new password; any new password counts.',
          run: [
            'cat ~/auth/kubeadmin-password',
            'oc login -u kubeadmin -p k4t7m-q2w9x-r5n8z-p3j6v',
            'oc extract secret/htpass-secret -n openshift-config --to /tmp --confirm',
            'htpasswd -bB /tmp/htpasswd alice newpass456',
            'oc set data secret/htpass-secret -n openshift-config --from-file=htpasswd=/tmp/htpasswd',
            'oc get clusteroperators authentication',
            'oc login -u alice -p newpass456',
          ],
          check: 'oc whoami',
        },
      },
      {
        type: 'user',
        name: 'bob',
        exists: false,
        label: 'Delete the departing User "bob" (oc delete user bob)',
        how: {
          explain:
            'Deleting users needs cluster-admin, so log in as kubeadmin again first. This removes the User object only; bob’s Identity stays behind until the next objective.',
          run: ['oc login -u kubeadmin -p k4t7m-q2w9x-r5n8z-p3j6v', 'oc delete user bob'],
          check: 'oc get users',
        },
      },
      {
        type: 'identity',
        user: 'bob',
        exists: false,
        label: 'Delete bob’s Identity too (oc delete identity htpasswd:bob)',
        how: {
          explain:
            'An Identity links a login name from an identity provider (`htpasswd:bob`) to a User. Deleting the User leaves it behind, so delete it separately; the order does not matter.',
          run: ['oc delete identity htpasswd:bob'],
          check: 'oc get identities',
        },
      },
    ],
    incidents: [],
    hints: [
      'Add a user to the virtual htpasswd file with bcrypt hashes: `htpasswd -c -B -b htpasswd alice <password>` (or `htpasswd -B -b htpasswd alice <password>` to add another).',
      'Create the Secret: `oc create secret generic htpass-secret --from-file=htpasswd -n openshift-config`. The key must be named `htpasswd`; the Secret NAME is your choice — the objective grades that the OAuth provider references a real Secret with that key (the hints/examples use `htpass-secret`).',
      'Configure the provider: `oc edit oauth cluster` and add an HTPasswd identityProvider referencing `htpass-secret` (mappingMethod: claim). The simulator opens the YAML in the Files panel: add the entry under `identityProviders:`, press Save to apply it, then Esc to close the panel (the game is paused while it is open). Or do it in one line: `oc patch oauth cluster --type=merge -p \'{"spec":{"identityProviders":[{"name":"htpasswd","mappingMethod":"claim","type":"HTPasswd","htpasswd":{"fileData":{"name":"htpass-secret"}}}]}}\'`.',
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
      'Give a team the access it needs and nothing more. In project `rbac-lab`, put the existing users alice and bob into a group called `developers`, give that group a built-in role and prove it with `oc auth can-i`; then fix an UnauthorizedAccess incident, where the `web` app is refused by RBAC, the cluster’s permission system (the proof is in its log, `oc logs deploy/web`, not in events). Do not create wildcard roles.',
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
        how: {
          explain:
            'A group gives permissions to several users at once. alice and bob already exist; this command creates the group and adds both. Groups are cluster-wide, so your current project does not matter here.',
          run: ['oc adm groups new developers alice bob'],
          check: 'oc get groups',
        },
      },
      {
        type: 'deploy',
        kind: 'RoleBinding',
        count: 1,
        // 1.16.0: the binding must give edit or view to the developers group;
        // any other learner binding (e.g. the incident's ServiceAccount fix)
        // used to count.
        subjects: ['group:developers'],
        roles: ['edit', 'view'],
        label: 'Bind a role (edit/view) to the developers group in rbac-lab',
        how: {
          explain:
            'A RoleBinding gives a role to a group inside one project: here the built-in `edit` role (`view` also counts). `-n rbac-lab` names that project; without it the binding lands in your current project and the objective stays empty.',
          run: ['oc adm policy add-role-to-group edit developers -n rbac-lab'],
          check: 'oc get rolebinding -n rbac-lab',
        },
      },
      {
        type: 'canI',
        verb: 'get',
        resource: 'pods',
        user: 'alice',
        expected: true,
        label: 'alice can get pods in rbac-lab',
        how: {
          explain:
            'Nothing to type: this ticks by itself once alice is allowed to read Pods in rbac-lab, which needs the group and the binding from the previous steps. If it stays empty, check that the binding is in rbac-lab and that `oc get groups` lists alice.',
          check: 'oc auth can-i get pods --as=alice -n rbac-lab',
        },
      },
      {
        type: 'leastPrivilege',
        label: 'No wildcard Roles/ClusterRoles and no extra cluster-admin bindings',
        how: {
          explain:
            'Nothing to type: this rule is checked all the time. It ticks once you have created your first RoleBinding, and turns red if you create a Role with a wildcard `*` (all actions or all resources), or bind `cluster-admin` to anyone except the admins.',
          check: 'oc get role,rolebinding -n rbac-lab',
        },
      },
      {
        type: 'resolve',
        incidentType: 'UnauthorizedAccess',
        count: 1,
        label: 'Resolve the UnauthorizedAccess incident',
        how: {
          explain:
            'About 25 seconds after the level starts, the `web` pods are denied by RBAC: the ServiceAccount `default` (the identity they run as) may not list Pods. When the incident is active, give that ServiceAccount the built-in `view` role; a binding made earlier is removed when the incident strikes. `-z default` means the ServiceAccount named default in that project (Level 16 covers ServiceAccounts).',
          run: [
            'oc logs deploy/web -n rbac-lab',
            'oc adm policy add-role-to-user view -z default -n rbac-lab',
          ],
          check: 'oc auth can-i list pods --as=system:serviceaccount:rbac-lab:default -n rbac-lab',
        },
      },
    ],
    incidents: [{ type: 'UnauthorizedAccess', triggerTime: 25, target: 'web', severity: 3 }],
    hints: [
      'Create the group: `oc adm groups new developers alice bob` (or `oc adm groups add-users developers alice bob`).',
      'Bind a role in the project: `oc adm policy add-role-to-group edit developers -n rbac-lab`. View it with `oc get rolebinding -n rbac-lab -o yaml`.',
      'Prove the access: `oc auth can-i get pods --as=alice -n rbac-lab` (and `oc auth can-i delete deployments --as=alice -n rbac-lab`).',
      'Avoid wildcards: create precise Roles or reuse built-in `view`/`edit`. The UnauthorizedAccess incident is a missing binding for the web workload ServiceAccount — repair it with `oc adm policy add-role-to-user view -z default -n rbac-lab` (or the incident panel); the incident clears as soon as the RoleBinding exists. It appears about 25 seconds after the level starts, and a binding created before that is removed when it strikes, so repair it after the incident shows up.',
      'Find the RBAC denial where a real cluster shows it: Kubernetes does not emit events for RBAC denials — the symptom is in the application log. `oc logs deploy/web -n rbac-lab` prints a line like `WARN failed to list pods for the cache sync: pods is forbidden: User "system:serviceaccount:rbac-lab:default" cannot list resource "pods" in API group "" in the namespace "rbac-lab"` once the incident is active; `oc get sa -n rbac-lab` shows the `default` ServiceAccount the workload runs as.',
      'Objectives are checked against the live cluster, not ticked once: if you later remove a member (`oc adm groups remove-users developers bob`) or delete the binding, the matching objective turns red again. Put bob back with `oc adm groups add-users developers bob`.',
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
      'Developer self-service needs guardrails. In project `quota-lab`, apply a ResourceQuota and a LimitRange from the example files, create a ClusterResourceQuota that spans projects, set requests and limits on the `web` Deployment and clear a ResourceQuotaExceeded incident (the quota is full, so no replacement Pod can be created). Then publish a project template: generate the bootstrap `project-request` template, add a guardrail object to it, store it in `openshift-config` and point `project.config.openshift.io/cluster` at it.',
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
        label: 'Create the ResourceQuota "compute-quota" in quota-lab',
        how: {
          explain:
            'A ResourceQuota caps the total a project may use (the example allows 20 Pods, 4 CPU cores and more). `oc apply -f` creates it from the file `examples/quota.yaml`, which you can read in the Files panel (press `F`).',
          run: ['oc apply -f examples/quota.yaml'],
          check: 'oc describe quota compute-quota',
        },
      },
      {
        type: 'deploy',
        kind: 'LimitRange',
        name: 'resource-limits',
        label: 'Create the LimitRange "resource-limits" in quota-lab',
        how: {
          explain:
            'A LimitRange gives every container in the project default and maximum CPU and memory values, so Pods without their own settings still get sensible ones. Create it from the second example file.',
          run: ['oc apply -f examples/limitrange.yaml'],
          check: 'oc describe limits resource-limits',
        },
      },
      {
        type: 'deploy',
        kind: 'ClusterResourceQuota',
        name: 'team-quota',
        label: 'Create the ClusterResourceQuota "team-quota"',
        how: {
          explain:
            'A ClusterResourceQuota shares one quota across every project that matches a label selector. It is cluster-wide, so your current project does not matter; this one covers `quota-lab` and allows 10 Pods and 20 Secrets in total.',
          run: [
            'oc create clusterquota team-quota --project-label-selector=kubernetes.io/metadata.name=quota-lab --hard=pods=10 --hard=secrets=20',
          ],
          check: 'oc describe clusterresourcequota team-quota',
        },
      },
      {
        type: 'resources',
        kind: 'Deployment',
        name: 'web',
        label: 'Set container requests and limits on the Deployment "web"',
        how: {
          explain:
            'A request is what the scheduler reserves for a container; a limit is the most it may use. `oc set resources` writes both into the `web` Deployment and its Pods restart; any values count.',
          run: [
            'oc set resources deployment/web --limits=cpu=500m,memory=512Mi --requests=cpu=100m,memory=128Mi',
          ],
          check:
            "oc get deployment web -o jsonpath='{.spec.template.spec.containers[0].resources}'",
        },
      },
      {
        type: 'resolve',
        incidentType: 'ResourceQuotaExceeded',
        count: 1,
        label: 'Resolve the ResourceQuotaExceeded incident',
        how: {
          explain:
            'About 20 seconds into the level the quota fills up: the Deployment cannot create a replacement Pod and the incident appears. Raise the quota’s Pod limit and the Pod is created; do not delete the quota, the first objective needs it.',
          run: [
            'oc describe quota compute-quota',
            'oc patch quota compute-quota --type=merge -p \'{"spec":{"hard":{"pods":"5"}}}\'',
          ],
          check: 'oc get pods',
        },
      },
      {
        type: 'command',
        pattern: 'oc adm create-bootstrap-project-template',
        label: 'Generate the bootstrap project template',
        how: {
          explain:
            'Every new project is created from a project template; this prints the default one (`project-request`), and `>` saves it as `template.yaml` so you can change it. Type it exactly as shown, starting with `oc`.',
          run: ['oc adm create-bootstrap-project-template -o yaml > template.yaml'],
          check: 'cat template.yaml',
        },
      },
      {
        type: 'deploy',
        kind: 'Template',
        name: 'project-request',
        namespace: 'openshift-config',
        label: 'Create the project-request Template in openshift-config',
        how: {
          explain:
            'The Template must go into `openshift-config`: without `-n openshift-config` it lands in your current project and the objective stays empty. It is created from the `template.yaml` you saved; you may first add a guardrail under `objects:` there, such as a copy of the LimitRange from this level without its `namespace` line (Files panel, press `F`, then Save).',
          run: ['oc create -f template.yaml -n openshift-config'],
          check: 'oc get templates -n openshift-config',
        },
      },
      {
        // 1.16.0: graded on project.config.openshift.io/cluster itself (it
        // names an existing Template in openshift-config). The old command
        // regex ticked on an `oc edit` that saved nothing and never on
        // `oc apply -f` reaching the same state.
        type: 'projectRequestTemplate',
        name: 'project-request',
        label: 'Point project.config.openshift.io/cluster at the template',
        how: {
          explain:
            'This sets `spec.projectRequestTemplate.name` in the cluster-wide project settings, so `oc new-project` uses your template (the cluster needs about 8 seconds to apply it). `oc edit` or `oc apply -f` reaching the same setting counts too; the Template must already exist in `openshift-config`.',
          run: [
            'oc patch project.config.openshift.io/cluster --type=merge -p \'{"spec":{"projectRequestTemplate":{"name":"project-request"}}}\'',
          ],
          check: 'oc get project.config.openshift.io/cluster -o yaml',
        },
      },
    ],
    incidents: [
      // The incident is injected against the namespace; IncidentEngine binds it
      // to the ResourceQuota that actually exists (issue #27b).
      // `namespace` pins it to the lab project: without it, an incident that fires
      // before the player has created compute-quota (t=20 s) binds to the namespace
      // of the first seeded Pod (openshift-monitoring) and can then never be
      // resolved from quota-lab (same field the timed lab 6 quota incident uses).
      {
        type: 'ResourceQuotaExceeded',
        triggerTime: 20,
        target: 'quota-lab',
        namespace: 'quota-lab',
        severity: 3,
      },
    ],
    hints: [
      'Switch projects: `oc project quota-lab`. Apply the example quota and limits: `oc apply -f examples/quota.yaml` and `oc apply -f examples/limitrange.yaml`.',
      'Create the multi-project quota: `oc create clusterquota team-quota --project-label-selector=kubernetes.io/metadata.name=quota-lab --hard=pods=10 --hard=secrets=20`.',
      'Set container resources: `oc set resources deployment/web --limits=cpu=500m,memory=512Mi --requests=cpu=100m,memory=128Mi`.',
      'Read the quota incident like a real cluster (it appears about 20 seconds after the level starts): `oc describe rs -l app=web -n quota-lab` (or `oc get events -n quota-lab`) shows a FailedCreate event ("exceeded quota: compute-quota, requested: pods=1, used: …, limited: …"), `oc get pods` shows NO extra Pending Pod, and `oc describe quota compute-quota` shows Used == Hard for pods (a real cluster never creates a Pod it cannot admit, so Used never exceeds Hard). Raise the guardrail to let the ReplicaSet replace the Pod: `oc patch quota compute-quota --type=merge -p \'{"spec":{"hard":{"pods":"5"}}}\'` then watch `oc get pods -n quota-lab` recover.',
      'Verify: `oc describe quota compute-quota`, `oc describe limits resource-limits`, `oc describe clusterresourcequota team-quota`. Then resolve the quota incident.',
      'Publish a project template: `oc adm create-bootstrap-project-template -o yaml > template.yaml`, add a guardrail object to the template object list — for example the LimitRange from `examples/limitrange.yaml` without its `metadata.namespace` line, so every new project gets default requests/limits (edit `template.yaml` in the Files panel; the shipped `templates/webapp-template.yaml` shows the object-list shape) — then `oc create -f template.yaml -n openshift-config` and check `oc get templates -n openshift-config`. Real clusters often add a default NetworkPolicy here too; Level 20 teaches NetworkPolicies.',
      'Point the cluster at the template: `oc edit project.config.openshift.io/cluster` and set `spec.projectRequestTemplate.name: project-request`. New projects keep using the old setting for about 8 seconds, so wait until `oc get clusteroperator openshift-apiserver` shows PROGRESSING False, then `oc new-project template-check` and confirm the templated object was created (`oc get limitrange -n template-check`); `oc new-project` also switches you to the new project, so return with `oc project quota-lab`. On a real cluster `oc edit` launches `$EDITOR` (vi/vim by default) in the terminal — the simulator opens its manifest editor in the Files panel (press Save to apply, then Esc to close it; the game is paused while it is open); practise vim separately for the exam.',
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
      'An application that calls the Kubernetes API needs an identity of its own: a ServiceAccount. In project `sa-lab`, create one called `api-reader`, grant it read access with a RoleBinding and check what it may do with `oc auth can-i --as=system:serviceaccount:sa-lab:api-reader`. Optionally run the `api` Deployment as that ServiceAccount and call the API from inside its Pod.',
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
        label: 'Create the ServiceAccount "api-reader" in sa-lab',
        how: {
          explain:
            'A ServiceAccount is an identity for programs, the way a User is an identity for people. It belongs to one project, so it must be created in `sa-lab`.',
          run: ['oc create serviceaccount api-reader'],
          check: 'oc get serviceaccount api-reader',
        },
      },
      {
        type: 'deploy',
        kind: 'RoleBinding',
        count: 1,
        // 1.16.0: view → ServiceAccount api-reader, not just any binding.
        subjects: ['system:serviceaccount:sa-lab:api-reader'],
        roles: ['view'],
        label: 'Bind the view role to the ServiceAccount "api-reader" in sa-lab',
        how: {
          explain:
            'A RoleBinding gives a role to an identity. `-z api-reader` means "the ServiceAccount api-reader" (without `-z`, oc binds a User with that name instead), and the built-in `view` role allows reading most objects.',
          run: ['oc adm policy add-role-to-user view -z api-reader'],
          check: 'oc get rolebinding',
        },
      },
      {
        type: 'canI',
        verb: 'get',
        resource: 'pods',
        user: 'system:serviceaccount:sa-lab:api-reader',
        expected: true,
        label: 'api-reader can list Pods via the Kubernetes API (granted by the view role)',
        how: {
          explain:
            'Nothing to type: this ticks by itself once api-reader is allowed to read Pods in sa-lab, which the RoleBinding from the last step does. If it stays empty, the binding is in the wrong project or it names a User instead of the ServiceAccount (`-z` missing).',
          check: 'oc auth can-i get pods --as=system:serviceaccount:sa-lab:api-reader',
        },
      },
      {
        type: 'command',
        pattern: 'oc auth can-i ',
        label: 'Verify access with oc auth can-i',
        how: {
          explain:
            '`oc auth can-i` asks the cluster whether an identity may do something; `--as=` picks the identity (here `system:serviceaccount:sa-lab:api-reader`: project, then name). Expect `yes` for `get` and `no` for `delete`; type it exactly as shown, starting with `oc`.',
          run: ['oc auth can-i get pods --as=system:serviceaccount:sa-lab:api-reader'],
          check: 'oc auth can-i delete pods --as=system:serviceaccount:sa-lab:api-reader',
        },
      },
    ],
    incidents: [],
    hints: [
      'Switch projects: `oc project sa-lab`. Create the identity: `oc create serviceaccount api-reader`.',
      'Grant read access: `oc adm policy add-role-to-user view -z api-reader` (this creates a RoleBinding for the ServiceAccount).',
      'Run the app as the ServiceAccount: `oc set serviceaccount deployment/api api-reader`.',
      'Check with `oc auth can-i get pods --as=system:serviceaccount:sa-lab:api-reader -n sa-lab`.',
      'Prove the application really has API access (this is the exam check): the kubelet mounts the SA token into every Pod; use it from inside the workload — `oc exec deploy/api -- sh -c \'curl -sk -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" https://kubernetes.default.svc/api/v1/namespaces/sa-lab/pods\'`. Run it after `oc set serviceaccount` has finished rolling out (`oc get pods` shows new Pods): the old Pods still carry the `default` token. It returns the PodList JSON once the RoleBinding grants `list`/`get` on pods; without it the same request returns a 403 `Status` JSON (the token authenticates, the RBAC binding authorizes).',
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
      "In project `privileged-lab`, OpenShift refuses to create the Pod of the Deployment `privileged-app`: it asks for a privileged container, and no Security Context Constraint (SCC, OpenShift's admission rule for pods) allows that. The Deployment runs as the ServiceAccount `priv-sa`: let that account use the `privileged` SCC (`anyuid` is not enough, it only allows any user ID), then watch the Pod start and the SCCForbidden incident clear. Do not grant it to the project's `default` ServiceAccount.",
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
        // 1.16.0: dedicated means ONLY priv-sa — a grant that also reaches the
        // project's `default` ServiceAccount (e.g. add-scc-to-group … for the
        // whole project) does not tick.
        exclusive: true,
        label: 'Grant the privileged SCC to the dedicated ServiceAccount priv-sa',
        how: {
          explain:
            "An SCC (Security Context Constraint) decides which pods OpenShift admits; a privileged container (root-like power over the node) is refused until its ServiceAccount, the pod's identity, may use the `privileged` SCC. `-z priv-sa` names that account (without `-z`, `oc` takes it for a user). A grant that also reaches other accounts, like `add-scc-to-group` for the project, does not count.",
          run: ['oc adm policy add-scc-to-user privileged -z priv-sa -n privileged-lab'],
          check:
            'oc auth can-i use scc/privileged --as=system:serviceaccount:privileged-lab:priv-sa -n privileged-lab',
        },
      },
      {
        type: 'privileged',
        count: 1,
        serviceAccount: 'priv-sa',
        label: 'Run the privileged workload as priv-sa (Pod admitted by the privileged SCC)',
        how: {
          explain:
            'Nothing to type: once priv-sa may use the privileged SCC, OpenShift creates the blocked Pod by itself within a few seconds. This ticks when the Pod is Running under the `privileged` SCC; if none appears, the grant is missing or went to another project.',
          check: 'oc get pods -n privileged-lab',
        },
      },
      {
        type: 'resolve',
        incidentType: 'SCCForbidden',
        count: 1,
        label: 'Resolve the SCCForbidden incident',
        how: {
          explain:
            'Nothing to type: the incident appears about 15 seconds into the level (bell icon in the top bar) and clears by itself once priv-sa may use the privileged SCC and its Pod is Running. If you granted early, wait for it to appear and clear.',
          check: 'oc describe deployment/privileged-app -n privileged-lab',
        },
      },
    ],
    incidents: [{ type: 'SCCForbidden', triggerTime: 15, target: 'privileged-app', severity: 4 }],
    hints: [
      'See the denied workload: `oc get pods -n privileged-lab` stays empty, `oc get events -n privileged-lab` shows a FailedCreate warning — "unable to validate against any security context constraint" — and `oc describe deployment/privileged-app -n privileged-lab` reports `ReplicaFailure True FailedCreate`. On 4.x the rejected Pod is never created.',
      'Check the identity: `oc get sa -n privileged-lab` — the shipped dedicated ServiceAccount is `priv-sa` (the workload runs as it). Avoid granting elevated SCCs to the project default SA.',
      'Grant the SCC the 4.x way (creates a RoleBinding in the project to ClusterRole system:openshift:scc:privileged): `oc adm policy add-scc-to-user privileged -z priv-sa -n privileged-lab`.',
      'Verify the grant with the RBAC question, not the SCC users list (it stays unchanged on 4.x): `oc auth can-i use scc/privileged --as=system:serviceaccount:privileged-lab:priv-sa -n privileged-lab` (the grant is a RoleBinding in the project, so without `-n` this answers `no` from another project), `oc get rolebinding -n privileged-lab`, then `oc get pods -n privileged-lab` — the privileged Pod is created and Running. The objective is graded on that state, so any equivalent binding works too — e.g. a Role with apiGroups `security.openshift.io`, resources `securitycontextconstraints`, resourceNames `privileged`, verbs `use` bound to priv-sa through a RoleBinding (not only the generated `system:openshift:scc:privileged` roleRef).',
      'Admission is not runtime: a bare `nginx:latest` Pod is ADMITTED by `restricted-v2` — the SCC validates the pod SPEC, not the image USER — and then crashes with `mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)` under its random non-root UID (the Level 1/3 crash). What IS rejected at admission is a Pod that explicitly requests `runAsUser: 0`, a `privileged: true` container or a host port: the ReplicaSet shows FailedCreate and no Pod exists — exactly this level. Check the image USER before blaming the SCC.',
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
      'Operators are add-ons that extend the cluster; OpenShift installs them with OLM (Operator Lifecycle Manager). In a project you create, `metallb-system`, install MetalLB (an OperatorGroup plus a Subscription), watch the InstallPlan and the CSV (the installed version) reach Succeeded, then uninstall it. Then, in `openshift-operators`, install cert-manager for all namespaces with manual approval, pinned to an older version instead of the newest.',
    examObjectives: [
      'Manage OpenShift operators > Install an operator',
      'Manage OpenShift operators > Uninstall an operator',
      'Manage OpenShift operators > Delete an operator',
    ],
    docsLinks: [DOCS.operators, DOCS.operatorAdmin, DOCS.operatorOlm],
    // The work happens in namespaces the player creates (metallb-system) or that ship
    // with the cluster (openshift-operators); nothing is graded in the seeded
    // `operator-lab` project, so the UI must not tell the player to switch to it.
    workProject: null,
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
        how: {
          explain:
            'The operator needs its own project, an OperatorGroup (where it may act) and a Subscription (which package and channel to install). The shipped Subscription is for another operator, so `sed` (a text replacer) rewrites it for MetalLB. Ticks after about 10 seconds, when the CSV (the installed version) reaches Succeeded.',
          run: [
            'oc new-project metallb-system',
            'oc apply -f examples/operatorgroup.yaml',
            "sed 's/ansible-automation-platform-operator/metallb-operator/; s/openshift-operators/metallb-system/; s/stable-2.6/stable/' examples/subscription.yaml | oc apply -f -",
          ],
          check: 'oc get csv -n metallb-system',
        },
      },
      {
        type: 'command',
        pattern:
          'oc (get|describe) (\\S+,)*(subs?|subscriptions?|csvs?|clusterserviceversions?|installplans?|ip)(?=[\\s,/.]|$)',
        // 1.16.0: the read must show the MetalLB operator's OLM objects (any
        // project, since the operator lives in metallb-system, not operator-lab).
        inspect: true,
        namespace: '*',
        outputPattern: 'metallb',
        label: 'Verify the Subscription / CSV / InstallPlan',
        how: {
          explain:
            'These three objects show how OLM works: the Subscription is your request, the InstallPlan lists the install steps, and the CSV (ClusterServiceVersion) is the installed operator version. This ticks when one of these `oc get` or `oc describe` commands shows the MetalLB objects.',
          run: ['oc get sub,csv,installplan -n metallb-system'],
          check: 'oc get pods -n metallb-system',
        },
      },
      {
        type: 'operator',
        name: 'metallb-operator',
        installed: false,
        label: 'After installing, uninstall the operator (delete Subscription + CSV)',
        how: {
          explain:
            'Uninstalling takes two deletes, in this order: the Subscription (so OLM stops reinstalling) and then the CSV (the operator itself). The objective ticks once both are gone: after the first delete the operator is still installed and running, and deleting the CSV first would bring it back.',
          run: [
            'oc delete subscription metallb-operator -n metallb-system',
            'oc delete csv metallb-operator.v4.22.0-202610281200 -n metallb-system',
          ],
          check: 'oc get csv -n metallb-system',
        },
      },
      {
        type: 'operator',
        name: 'openshift-cert-manager-operator',
        namespace: 'openshift-operators',
        allNamespaces: true,
        installed: true,
        label:
          'Install cert-manager AllNamespaces into openshift-operators (Manual approval, pinned to v1.16.0)',
        how: {
          explain:
            "`openshift-operators` already has a global OperatorGroup, so a Subscription is enough. This file asks for manual approval and pins v1.16.0, so the plan waits for the next objective's approval. If you installed cert-manager here before, delete its Subscription, CSV and InstallPlan first.",
          run: ['oc apply -f examples/subscription-manual-pinned.yaml'],
          check: 'oc get sub,installplan -n openshift-operators',
        },
      },
      {
        type: 'installPlan',
        namespace: 'openshift-operators',
        package: 'openshift-cert-manager-operator',
        approval: 'Manual',
        approved: true,
        label: 'Approve the Manual InstallPlan of cert-manager in openshift-operators',
        how: {
          explain:
            'A Manual subscription waits for you: its InstallPlan stays unapproved until `spec.approved` is true. `$(...)` looks up the name of the v1.16.0 plan, which is random. Approve only this plan; the second one (v1.17.0) would upgrade past your pin.',
          run: [
            'oc patch installplan $(oc get installplan -n openshift-operators --no-headers | grep v1.16.0 | cut -d\' \' -f1) -n openshift-operators --type=merge -p \'{"spec":{"approved":true}}\'',
          ],
          check: 'oc get installplan -n openshift-operators',
        },
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
        how: {
          explain:
            'Nothing to type: the file you applied pins `startingCSV: cert-manager-operator.v1.16.0`, an older entry of the channel (the newest, v1.17.0, would not count). This ticks once the approved plan installs exactly that version.',
          check: 'oc get csv -n openshift-operators',
        },
      },
    ],
    incidents: [],
    hints: [
      'Create the operator namespace and its OperatorGroup: `oc new-project metallb-system`, then `oc apply -f examples/operatorgroup.yaml` (single-namespace OperatorGroup targeting metallb-system). A Subscription with no matching OperatorGroup never resolves.',
      'Find the package: `oc get packagemanifests -n openshift-marketplace` lists `metallb-operator` — the redhat-operators package name is `metallb-operator` (an old/misspelled package fails with ResolutionFailed "no operators found in package").',
      'Install: edit `examples/subscription.yaml` (Files panel, press `F`) so `spec.name` and `metadata.name` are `metallb-operator`, `metadata.namespace` is `metallb-system` and `spec.channel` is `stable` (the example ships with the Ansible channel `stable-2.6`, which MetalLB does not have: the Subscription would stay at `ResolutionFailed`), then `oc apply -f examples/subscription.yaml`.',
      'Watch OLM: `oc get sub,csv,installplan -n metallb-system` — an InstallPlan appears, then the CSV `metallb-operator.v4.22.0-202610281200` goes Installing → Succeeded; `oc get subscription -n metallb-system -o yaml` reports `status.installedCSV`.',
      'Uninstall (only after the install above reached Succeeded): `oc delete subscription metallb-operator -n metallb-system`, then confirm the CSV is STILL there with `oc get csv -n metallb-system` — deleting the Subscription does not remove the operator.',
      'Finish the uninstall by deleting the CSV itself: `oc delete csv metallb-operator.v4.22.0-202610281200 -n metallb-system` (typing `clusterserviceversion`/`csv` is the uninstall step), then confirm with `oc get csv -n metallb-system` and `oc get subscription -A`.',
      'AllNamespaces variant: no new OperatorGroup is needed — `openshift-operators` already ships the cluster-global `global-operators` group (`oc get operatorgroup -n openshift-operators`), and the Subscription must live in `openshift-operators` too. The installed CSV appears in that project (`oc get csv -n openshift-operators`), and because the install is AllNamespaces OLM also creates a copied CSV of it in every other namespace: `oc get csv -A` shows the same CSV name across the cluster (the copies have the `Copied` status reason).',
      'Discover the cert-manager package and its pinnable versions: `oc get packagemanifests -n openshift-marketplace` lists `openshift-cert-manager-operator` (channel `stable-v1`); `oc describe packagemanifest openshift-cert-manager-operator -n openshift-marketplace` lists the channel entries — the head `cert-manager-operator.v1.17.0` plus `.v1.16.0` and `.v1.15.0`. Only an entry of the channel is a valid `startingCSV`; anything else fails resolution with `ResolutionFailed` ("no operators found with name … in channel stable-v1 of package openshift-cert-manager-operator").',
      'Manual approval + pinned version: apply `examples/subscription-manual-pinned.yaml` (namespace `openshift-operators`, `installPlanApproval: Manual`, `startingCSV: cert-manager-operator.v1.16.0`), then approve the InstallPlan OLM creates: `oc patch installplan <name> -n openshift-operators --type=merge -p \'{"spec":{"approved":true}}\'`. Until then the Subscription reports `InstallPlanPending True RequiresApproval`. Once v1.16.0 is installed OLM adds a second plan (the upgrade to v1.17.0): leave it unapproved, approving it would move you past the pin.',
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
      'Batch workloads run to completion. In project `batch-lab`, the nightly Job `report-batch` fails with DeadlineExceeded because its time limit (`activeDeadlineSeconds`) is far too short. Inspect it, run a simple Job that prints its output, repair the broken Job by recreating it without that limit, and schedule recurring work with a CronJob.',
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
      {
        type: 'complete',
        kind: 'Job',
        count: 1,
        label: 'Run a Job to phase Complete',
        how: {
          explain:
            'A Job runs a Pod once and stops when the work is done. `oc create job NAME --image=IMAGE -- COMMAND` creates one; here perl prints 42 and exits, so the Job reaches status Complete within a few seconds.',
          run: ['oc create job report-job --image=perl -n batch-lab -- perl -e "print 42"'],
          check: 'oc get jobs -n batch-lab',
        },
      },
      {
        type: 'cronJob',
        name: 'cleanup',
        suspended: false,
        label: 'Create the CronJob "cleanup" (not suspended)',
        how: {
          explain:
            'A CronJob starts a Job on a schedule of five fields (minute, hour, day of month, month, weekday); `*/5 * * * *` means every 5 minutes, while words such as "every 5 min" are rejected. The first Job appears only at the next scheduled time.',
          run: [
            'oc create cronjob cleanup --image=busybox --schedule="*/5 * * * *" -n batch-lab -- sh -c date',
          ],
          check: 'oc get cronjob -n batch-lab',
        },
      },
      {
        type: 'resolve',
        incidentType: 'JobDeadlineExceeded',
        count: 1,
        label: 'Resolve the JobDeadlineExceeded incident',
        how: {
          explain:
            'A Failed Job cannot be revived: delete `report-batch` and create it again without its 8-second deadline. The incident alert (bell icon in the top bar) appears about 15 seconds into the level and clears once the new Job completes; fixing the Job before it appears works too.',
          run: [
            'oc delete job report-batch -n batch-lab',
            'oc create job report-batch --image=perl -n batch-lab -- perl -e "print 42"',
          ],
          check: 'oc get jobs -n batch-lab',
        },
      },
      {
        type: 'command',
        pattern: 'oc (create|apply) .*(job|cronjob)',
        label: 'Create the batch objects with oc create/apply',
        how: {
          explain:
            'Nothing to type: this ticks by itself once an `oc create` or `oc apply` command containing the word `job` has succeeded; the commands of the objectives above already count. A command that failed does not count.',
          check: 'oc get job,cronjob -n batch-lab',
        },
      },
    ],
    incidents: [
      { type: 'JobDeadlineExceeded', triggerTime: 15, target: 'report-batch', severity: 2 },
    ],
    hints: [
      'Switch projects: `oc project batch-lab`, then inspect the broken batch job: `oc get jobs` (report-batch is Failed), `oc describe job report-batch` — the conditions show Failed with reason `DeadlineExceeded`, and the diagnostic line `Active Deadline Seconds:  8s` says the Job was killed after 8 seconds; the events show `Job was active longer than specified deadline`. `oc get job report-batch -o yaml` confirms `activeDeadlineSeconds: 8`, far too short for the report.',
      'Read its output: `oc logs job/report-batch` (the container was killed while the report was still running). A Failed Job cannot be resumed — recreate it: `oc delete job report-batch`, then `oc create job report-batch --image=perl -- perl -e "print 42"` (a plain `oc create job` sets no deadline; for a longer one, put `activeDeadlineSeconds` in a Job manifest). The new Job completes, so the JobDeadlineExceeded incident clears.',
      'Run a second, simple Job and read its REAL stdout: `oc create job report-job --image=perl -- perl -e "print 42"`; watch `oc get jobs,pods`, then `oc logs job/report-job` prints `42` (the Pod stays around after completion, like on a real cluster).',
      'Schedule recurring work (five-field cron only — `--schedule="every 5 min"` is rejected by the API server, and the first Job only appears at the next scheduled time): `oc create cronjob cleanup --image=busybox --schedule="*/5 * * * *" -- sh -c date`.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: false },
    nextLevel: 21,
  },

  // ═══ 1.16.0 bridge levels: new ids 21/22 (ids are save keys), played before the capstone ═══
  {
    id: 21,
    title: 'Network Policies',
    chapter: 5,
    chapterName: 'Security & Operations',
    description:
      'Every Pod accepts traffic from anywhere until a NetworkPolicy selects it. In project `netpol-lab` a small shop runs `frontend`, published by the Route `frontend`, and `backend`, an internal API on port 8080. Lock it down the way the capstone needs: deny all ingress, let the OpenShift router back in so the Route keeps working, then deny egress too while keeping DNS and exactly the frontend → backend call. Policies only ever allow and they add up, so you combine small ones; the Files panel (`F`) has the OpenShift docs policies in `netpol/`.',
    examObjectives: [
      'Configure network security > Configure application network policies',
      'Configure network security > Control cluster network ingress',
      'Configure network security > Troubleshoot software defined networking',
      'Configure network security > Configure networking components',
      'Deploy applications > Work with labels and selectors',
    ],
    docsLinks: [DOCS.networkPolicy, DOCS.networkSecurity, DOCS.routes],
    startingResources: [
      node('node-1'),
      node('node-2'),
      project('netpol-lab'),
      // The frontend runs the UBI nginx image: it serves HTTP on 8080 as a non-root user
      // AND ships curl/nslookup, so `oc exec deploy/frontend -- curl …` is a real in-Pod
      // connectivity test (hello-openshift is a single binary with no shell or curl).
      deployment('frontend', {
        replicas: 2,
        image: 'registry.access.redhat.com/ubi9/nginx-122:latest',
      }),
      deployment('backend', { replicas: 2 }),
      service('frontend'),
      service('backend'),
      {
        kind: 'Route',
        name: 'frontend',
        spec: {
          to: { kind: 'Service', name: 'frontend', weight: 100 },
          port: { targetPort: 'http' },
          tls: { termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' },
          wildcardPolicy: 'None',
        },
      },
    ],
    availableResources: [
      'Project',
      'Deployment',
      'Pod',
      'Service',
      'Route',
      'NetworkPolicy',
      'Node',
    ],
    manifestFiles: [
      'netpol/deny-by-default.yaml',
      'netpol/allow-from-openshift-ingress.yaml',
      'netpol/allow-same-namespace.yaml',
      'netpol/deny-all-egress.yaml',
      'netpol/allow-dns.yaml',
      'netpol/allow-frontend-to-backend.yaml',
    ],
    focusFiles: [
      'netpol/deny-by-default.yaml',
      'netpol/allow-from-openshift-ingress.yaml',
      'netpol/allow-frontend-to-backend.yaml',
    ],
    // Graded on traffic behaviour (the labs 9/13 and capstone probes), never on policy
    // names: any hand-written policy set that produces the same reachability counts.
    objectives: [
      {
        type: 'command',
        pattern: 'oc\\s+(\\S+\\s+)*get\\s+(\\S*,)?(pods?|po|all)(\\s|,|$)',
        inspect: true,
        namespace: 'openshift-ingress',
        outputPattern: 'router-default',
        label: 'Find the router Pods in openshift-ingress that carry every Route’s traffic',
        how: {
          explain:
            'A Route is only a rule: the router Pods in the `openshift-ingress` project receive the outside traffic and connect to the Pods behind the Service. A policy will have to let that project in, and the label `policy-group.network.openshift.io/ingress` on it is what the policy matches.',
          run: [
            'oc get pods -n openshift-ingress',
            'oc get namespace openshift-ingress --show-labels',
          ],
          check: 'oc get route frontend',
        },
      },
      {
        type: 'command',
        pattern: 'oc\\s+(\\S+\\s+)*(exec|rsh)\\s.*\\bcurl\\b.*\\bbackend\\b',
        inspect: true,
        label: 'Test frontend → backend from inside a frontend Pod (oc exec … curl)',
        how: {
          explain:
            '`oc exec` runs a command inside a Pod, so `curl` from a frontend Pod calls the backend Service by name, the same path the app uses. Nothing is blocked yet, so it answers; run it again after each policy to see what changed.',
          run: ['oc exec deploy/frontend -- curl -s http://backend:8080'],
        },
      },
      {
        type: 'networkPolicy',
        probe: 'ingress-isolation',
        namespace: 'netpol-lab',
        label: 'Deny all ingress by default (a policy that selects every Pod and allows nothing)',
        how: {
          explain:
            'A NetworkPolicy applies to the Pods its `podSelector` picks, and `{}` picks all of them. This one allows no ingress, so the Pods accept no connection at all: the Route now answers 503 and frontend → backend fails. The next steps reopen one path at a time.',
          run: ['oc apply -f netpol/deny-by-default.yaml'],
          check: 'oc describe networkpolicy deny-by-default',
        },
      },
      {
        type: 'routeAccess',
        name: 'frontend',
        requireIsolation: true,
        label: 'Let the OpenShift router back in: the Route frontend answers again',
        how: {
          explain:
            'This policy admits traffic from every namespace labelled `policy-group.network.openshift.io/ingress: ""`, and on OpenShift that is `openshift-ingress`, where the router runs. The Route answers again while Pods of other projects stay locked out.',
          run: ['oc apply -f netpol/allow-from-openshift-ingress.yaml'],
          check: 'curl -k https://frontend-netpol-lab.apps.cluster.example.com',
        },
      },
      {
        type: 'networkPolicy',
        probe: 'dns-egress',
        namespace: 'netpol-lab',
        source: { kind: 'Deployment', name: 'frontend' },
        label: 'Deny all egress too, but keep DNS working (UDP and TCP 5353 to openshift-dns)',
        how: {
          explain:
            'Egress rules limit what the Pods may call. Deny everything, then allow DNS: the dns-default Pods in `openshift-dns` listen on port 5353, not 53, so the rule allows UDP and TCP 5353. Without it no Pod can even look up the name `backend`.',
          run: ['oc apply -f netpol/deny-all-egress.yaml', 'oc apply -f netpol/allow-dns.yaml'],
          check: 'oc exec deploy/frontend -- nslookup backend',
        },
      },
      {
        type: 'networkPolicy',
        probe: 'reach',
        namespace: 'netpol-lab',
        source: { kind: 'Deployment', name: 'frontend' },
        to: { kind: 'Service', name: 'backend' },
        port: 8080,
        label: 'Reopen exactly frontend → backend on port 8080 (ingress and egress)',
        how: {
          explain:
            'With policies in both directions a call needs two allows: ingress on the Pods that receive and egress on the Pods that send. `allow-same-namespace` lets the project’s own Pods in; the starter file becomes the egress rule once its placeholders name frontend and backend (edit it, or let `sed` fill them in).',
          run: [
            'oc apply -f netpol/allow-same-namespace.yaml',
            "sed -e 's/SOURCE-APP/frontend/' -e 's/TARGET-APP/backend/' netpol/allow-frontend-to-backend.yaml | oc apply -f -",
          ],
          check: 'oc exec deploy/frontend -- curl -s http://backend:8080',
        },
      },
      {
        type: 'networkPolicy',
        probe: 'deny',
        namespace: 'netpol-lab',
        source: { kind: 'Deployment', name: 'backend' },
        to: { kind: 'Service', name: 'frontend' },
        port: 8080,
        label: 'Keep backend → frontend blocked (an allow rule only opens one direction)',
        how: {
          explain:
            'Nothing to type: this guard ticks while the backend Pods cannot open a connection to the frontend. It turns red if you open egress for every Pod, for example with an egress copy of allow-same-namespace, instead of only frontend → backend.',
          check: 'oc get networkpolicy',
        },
      },
      {
        type: 'networkPolicy',
        probe: 'deny-external',
        namespace: 'netpol-lab',
        source: { kind: 'Deployment', name: 'frontend' },
        label: 'Keep the frontend away from the internet (egress stays locked)',
        how: {
          explain:
            'Nothing to type: this guard ticks once egress is denied and DNS works, so a call to an outside address fails on the egress policy itself, not on a missing DNS rule. It turns red if an egress rule lets the frontend reach any address.',
          check: 'oc describe networkpolicy allow-frontend-to-backend',
        },
      },
    ],
    incidents: [],
    hints: [
      'Follow one request before you change anything: `oc get route frontend` (the host name), `oc get endpoints frontend` (the Pod addresses behind the Service) and `oc get pods -n openshift-ingress` (the router Pods that connect to them). A NetworkPolicy filters that last hop, router → Pod, and every Pod-to-Pod call.',
      'Selectors decide everything. `podSelector: {}` means every Pod of the policy’s own project; a `podSelector` inside `from`/`to` only matches Pods of the same project; a `namespaceSelector` matches whole projects by their labels. `oc get namespace openshift-ingress --show-labels` shows the `policy-group.network.openshift.io/ingress=` label the router policy relies on.',
      'Policies only ever allow, and they add up: once any policy selects a Pod for a direction, the Pod accepts only what some policy allows in that direction. A stricter second policy cannot take back what a broad one opened; delete the broad one instead (`oc delete networkpolicy <name>`).',
      'Test like an admin: from the workstation `curl -k https://frontend-netpol-lab.apps.cluster.example.com` (503 means the router reached no Pod), from inside the cluster `oc exec deploy/frontend -- curl -s http://backend:8080` and `oc exec deploy/frontend -- nslookup backend`. A lookup that times out means the DNS egress rule (UDP/TCP 5353 to openshift-dns) is missing, not that backend is down.',
      'There is no `oc create networkpolicy` command: write YAML (Files panel New, `vim`, or a heredoc into `oc apply -f -`) and apply it. The capstone ships the same building blocks: `examples/default-deny.yaml` denies ingress and egress in one policy and `examples/allow-from-router.yaml` is the router rule.',
    ],
    starCriteria: { time: 480, efficiency: 0.7, noFailures: true },
    nextLevel: 22,
  },

  {
    id: 22,
    title: 'Nodes & Cluster Troubleshooting',
    chapter: 5,
    chapterName: 'Security & Operations',
    description:
      'Take the operator’s chair before the capstone. In project `node-lab` the `web` Deployment runs on two workers. Read the cluster’s state (nodes, resource use, node conditions, ClusterOperators), take `worker-0` out of service for maintenance without stopping `web` and bring it back. About 120 seconds in, the kubelet on `worker-1` stops and the node turns NotReady: repair it the real way, from a debug shell on the node.',
    examObjectives: [
      'Manage OpenShift Container Platform > Examine resources and cluster status',
      'Manage OpenShift Container Platform > Assess the health of an OpenShift cluster',
      'Manage OpenShift Container Platform > Troubleshoot common container, pod, and cluster events and alerts',
    ],
    docsLinks: [DOCS.nodes, DOCS.clusterResources, DOCS.cli],
    startingResources: [
      node('node-1'),
      node('node-2'),
      node('node-3'),
      project('node-lab'),
      deployment('web', { replicas: 4 }),
      service('web'),
    ],
    availableResources: ['Project', 'Deployment', 'Pod', 'Service', 'Node'],
    objectives: [
      {
        type: 'command',
        pattern: 'oc\\s+(\\S+\\s+)*get\\s+(\\S*,)?(nodes?|no)(\\s|,|$)',
        inspect: true,
        namespace: '*',
        outputPattern: 'Ready',
        label: 'List the nodes and read their STATUS and ROLES (oc get nodes)',
        how: {
          explain:
            '`oc get nodes` lists the machines of the cluster. STATUS `Ready` means the node agent (the kubelet) reports in; ROLES tells control-plane from worker machines, and `-o wide` adds their addresses, OS image and container runtime.',
          run: ['oc get nodes', 'oc get nodes -o wide'],
        },
      },
      {
        type: 'command',
        pattern: 'oc\\s+adm\\s+top\\s+(nodes?|no|pods?|po)(\\s|$)',
        inspect: true,
        namespace: '*',
        label: 'Find the busiest node and Pods (oc adm top nodes / oc adm top pods)',
        how: {
          explain:
            '`oc adm top` reads live CPU and memory use from the cluster metrics. `nodes` shows each machine and its share of what it can give to Pods; `pods -A` lists the Pods of every project, the usual way to find what fills a node.',
          run: ['oc adm top nodes', 'oc adm top pods -A'],
        },
      },
      {
        type: 'command',
        pattern: 'oc\\s+describe\\s+(nodes?|no)(\\s|/)',
        inspect: true,
        namespace: '*',
        outputPattern: 'Allocatable',
        label:
          'Read a node’s conditions, capacity, allocatable resources and taints (oc describe node)',
        how: {
          explain:
            '`oc describe node` shows the Conditions the kubelet reports (Ready, MemoryPressure, DiskPressure, PIDPressure), the Capacity of the machine, the Allocatable part left for Pods and its Taints. Compare a worker with `master-0`, whose taint keeps ordinary workloads off the control plane.',
          run: ['oc describe node worker-0', 'oc describe node master-0'],
        },
      },
      {
        type: 'command',
        pattern:
          'oc\\s+get\\s+(\\S*,)?(clusteroperators?|co)(\\.config\\.openshift\\.io)?(\\s|,|$)',
        inspect: true,
        namespace: '*',
        outputPattern: 'AVAILABLE',
        label: 'Check the platform itself: ClusterOperators and the ClusterVersion',
        how: {
          explain:
            'Each OpenShift component (ingress, DNS, authentication and more) is run by a ClusterOperator; a healthy one reads AVAILABLE True, PROGRESSING False, DEGRADED False. The ClusterVersion shows the installed release and whether an update is running.',
          run: ['oc get clusteroperators', 'oc get clusterversion'],
        },
      },
      {
        type: 'node',
        name: 'worker-0',
        drained: true,
        workloadsAvailable: true,
        label: 'Drain worker-0 for maintenance while web stays fully available',
        how: {
          explain:
            '`oc adm cordon` marks the node unschedulable, so no new Pod lands there; `oc adm drain` evicts its Pods and their Deployments recreate them on the other worker. DaemonSet Pods stay on every node (`--ignore-daemonsets`), and `--delete-emptydir-data` accepts losing their scratch space.',
          run: [
            'oc adm cordon worker-0',
            'oc adm drain worker-0 --ignore-daemonsets --delete-emptydir-data',
          ],
          check: 'oc get pods -o wide',
        },
      },
      {
        type: 'node',
        name: 'worker-0',
        drained: true,
        schedulable: true,
        ready: true,
        label: 'Maintenance done: put worker-0 back in service (uncordon)',
        how: {
          explain:
            'A drained node stays `Ready,SchedulingDisabled` until you uncordon it. `oc adm uncordon` makes it schedulable again; Pods that moved away stay where they are until something replaces them.',
          run: ['oc adm uncordon worker-0'],
          check: 'oc get nodes',
        },
      },
      {
        type: 'resolve',
        incidentType: 'NodeNotReady',
        count: 1,
        label:
          'Resolve the NodeNotReady incident: restart the kubelet on worker-1 from a debug shell',
        how: {
          explain:
            'About 120 seconds in, worker-1 turns NotReady because its kubelet stopped. `oc debug node/worker-1` opens a shell on that node, `chroot /host` switches to the node’s own tools, `systemctl status` and `journalctl` show the failure and `systemctl restart kubelet` repairs it. Type `exit` twice to get back to `oc`.',
          run: [
            'oc get nodes',
            'oc describe node worker-1',
            'oc debug node/worker-1',
            'chroot /host',
            'systemctl status kubelet',
            'journalctl -u kubelet',
            'systemctl restart kubelet',
            'exit',
            'exit',
          ],
          check: 'oc get nodes',
        },
      },
      {
        type: 'clusterHealth',
        minPercent: 90,
        allOperatorsAvailable: true,
        label: 'Cluster healthy again: every ClusterOperator Available and health at 90% or better',
        how: {
          explain:
            'Nothing to type: this ticks once the NodeNotReady incident has happened and been resolved while every ClusterOperator reports Available and none Degraded. `oc get nodes` and `oc get clusteroperators` are the checks to run after any node work.',
          check: 'oc get clusteroperators',
        },
      },
    ],
    incidents: [{ type: 'NodeNotReady', triggerTime: 120, target: 'worker-1', severity: 3 }],
    hints: [
      'Read before you act: `oc get nodes` (STATUS, ROLES, VERSION), `oc adm top nodes` and `oc adm top pods -A` (live CPU and memory), `oc describe node worker-0` (Conditions, Capacity vs Allocatable, Taints) and `oc get clusteroperators` / `oc get clusterversion` (the platform’s own health: AVAILABLE True, PROGRESSING False, DEGRADED False).',
      'Maintenance is cordon, drain, work, uncordon. `oc adm cordon worker-0` stops new Pods landing there (STATUS `Ready,SchedulingDisabled`); `oc adm drain worker-0 --ignore-daemonsets --delete-emptydir-data` evicts the rest so their controllers recreate them elsewhere. Every OpenShift node runs DaemonSet Pods (DNS, networking), so a drain without `--ignore-daemonsets` stops with an error.',
      'Wait until `oc get pods -o wide` shows every web Pod Running on another node before you uncordon. Uncordoning does not move Pods back: they stay where they were rescheduled until something replaces them (for example `oc rollout restart deployment/web`).',
      'NotReady with Conditions `Unknown` and "Kubelet stopped posting node status." means the node agent stopped. In the debug shell the prompt changes to `sh-5.1#` and the terminal talks to the node, not to `oc`, until you type `exit` twice (once to leave `chroot /host`, once to end the debug Pod).',
      'Short form for later: `oc debug node/worker-1 -- chroot /host systemctl restart kubelet` runs one command and exits. Afterwards `oc get nodes` must show worker-1 Ready and `oc get clusteroperators` nothing Degraded.',
    ],
    starCriteria: { time: 480, efficiency: 0.7, noFailures: false },
    nextLevel: 20,
  },

  {
    id: 20,
    title: 'EX280 Final: Production Platform',
    chapter: 5,
    chapterName: 'Security & Operations',
    description:
      'Capstone: build a small production platform in a project you create, `prod-platform` (you only leave it to install MetalLB in `metallb-system`). It needs a quota and limits, the `webapp` Deployment with a Service and a TLS Route, a Build that fills an ImageStream, a developer User and Group, a default-deny NetworkPolicy that still lets the router reach the Route, a Job and a CronJob. Two incidents strike on a timer (crashing webapp pods after 60 seconds, a NotReady node after 120), and the last two objectives are in-game scores, not Red Hat exam scores.',
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
    // No project is seeded: creating `prod-platform` is the first objective, and the
    // MetalLB step moves the terminal to `metallb-system`. Telling the player to
    // "switch to prod-platform" before it exists would be wrong, so no project row;
    // every command in the `how` blocks names its project with -n instead.
    workProject: null,
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
      {
        type: 'project',
        name: 'prod-platform',
        label: 'Create the Project "prod-platform"',
        how: {
          explain:
            'A project is a namespace with extras: the place where your whole platform will live. `oc new-project` creates it and switches your terminal to it.',
          run: ['oc new-project prod-platform'],
          check: 'oc get project prod-platform',
        },
      },
      // Issue #37: the capstone grades quota/limits/default-deny on PROJECT
      // STATE, not on hidden object names the level never states. Any
      // ResourceQuota / LimitRange in prod-platform counts, and so does any
      // NetworkPolicy that selects every Pod for Ingress with no allow rules.
      {
        type: 'quota',
        namespace: 'prod-platform',
        label: 'Apply a ResourceQuota in prod-platform',
        how: {
          explain:
            'A ResourceQuota caps what the whole project may use (pods, CPU, memory, ...). The shipped example is ready to use; `-n prod-platform` names the project it applies to.',
          run: ['oc apply -f examples/quota.yaml -n prod-platform'],
          check: 'oc describe quota -n prod-platform',
        },
      },
      {
        type: 'limitRange',
        namespace: 'prod-platform',
        label: 'Apply a LimitRange in prod-platform',
        how: {
          explain:
            'A LimitRange gives every container default CPU and memory requests and limits, and sets the largest and smallest values it may ask for. The shipped example is ready to use.',
          run: ['oc apply -f examples/limitrange.yaml -n prod-platform'],
          check: 'oc describe limitrange -n prod-platform',
        },
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'webapp',
        label: 'Deploy webapp from manifests/deployment.yaml',
        how: {
          explain:
            'The manifest (open the Files panel with `F` to read it) describes two replicas with resource requests, limits and a readiness probe; those also raise the Architecture Advisor score. `oc apply -f` creates the Deployment from it.',
          run: ['oc apply -f manifests/deployment.yaml -n prod-platform'],
          check: 'oc get deployment webapp -n prod-platform',
        },
      },
      {
        type: 'deploy',
        kind: 'Service',
        name: 'webapp',
        label: 'Expose webapp with a Service',
        how: {
          explain:
            'A Service gives the webapp pods one stable address inside the cluster; the Route sends traffic to it. The shipped manifest picks the pods by their label `app=webapp`.',
          run: ['oc apply -f manifests/service.yaml -n prod-platform'],
          check: 'oc get service webapp -n prod-platform',
        },
      },
      {
        type: 'route',
        name: 'webapp',
        label: 'Create an external Route "webapp" (Admitted)',
        how: {
          explain:
            'The Route in `manifests/route.yaml` reads its TLS certificate from a Secret, so it is admitted only after the Secret exists and the router may read it. Run the steps in this order; `oc describe route` names what is missing.',
          run: [
            'openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=webapp.apps.cluster.example.com"',
            'oc create secret tls webapp-tls --cert=tls.crt --key=tls.key -n prod-platform',
            'oc apply -f examples/route-external-cert-rbac.yaml -n prod-platform',
            'oc apply -f manifests/route.yaml -n prod-platform',
          ],
          check: 'oc describe route webapp -n prod-platform',
        },
      },
      {
        type: 'build',
        name: 'webapp',
        count: 1,
        label: 'Complete a Build for the webapp BuildConfig',
        how: {
          explain:
            'A BuildConfig describes how to build an image from source; every run of it is a Build. Applying the shipped BuildConfig already starts a first build, and `oc start-build` starts another one on demand.',
          run: [
            'oc apply -f examples/buildconfig.yaml -n prod-platform',
            'oc start-build webapp --follow -n prod-platform',
          ],
          check: 'oc get builds -n prod-platform',
        },
      },
      {
        type: 'imageStream',
        name: 'webapp',
        tag: 'latest',
        label: 'ImageStream webapp has the :latest tag',
        how: {
          explain:
            'Nothing to type: each finished build pushes its image into the ImageStream `webapp` under the tag `latest`, so this ticks by itself about 10 seconds after the first build completes.',
          check: 'oc get imagestreamtag -n prod-platform',
        },
      },
      {
        type: 'networkPolicy',
        probe: 'ingress-isolation',
        namespace: 'prod-platform',
        label: 'Add a default-deny NetworkPolicy in prod-platform',
        how: {
          explain:
            'A NetworkPolicy limits which pods may talk to yours. This one selects every pod and allows nothing in, so it also blocks the router in front of your Route: the next objective repairs that.',
          run: ['oc apply -f examples/default-deny.yaml -n prod-platform'],
          check: 'oc get networkpolicy -n prod-platform',
        },
      },
      {
        type: 'routeAccess',
        name: 'webapp',
        requireIsolation: true,
        label: 'Route webapp is reachable from the workstation (router allowed by NetworkPolicy)',
        how: {
          explain:
            'After default-deny the Route answers 503. A second policy that admits traffic from the namespace holding the router (labelled `policy-group.network.openshift.io/ingress`) reopens only that path. Ticks once `curl` gets an answer again.',
          run: ['oc apply -f examples/allow-from-router.yaml -n prod-platform'],
          check: 'curl -k https://webapp.apps.cluster.example.com',
        },
      },
      {
        type: 'user',
        name: 'developer',
        label: 'Create the User "developer"',
        how: {
          explain:
            'A User object normally appears when someone first logs in through an identity provider; `oc create user` creates it directly so you can put it in a group.',
          run: ['oc create user developer'],
          check: 'oc get user developer',
        },
      },
      {
        type: 'group',
        name: 'developers',
        users: ['developer'],
        label: 'Create Group "developers" containing developer',
        how: {
          explain:
            'A Group lets you give permissions to several users at once. `oc adm groups new` takes the group name followed by its members.',
          run: ['oc adm groups new developers developer'],
          check: 'oc get group developers',
        },
      },
      {
        type: 'operator',
        name: 'metallb-operator',
        installed: true,
        label: 'Install the MetalLB operator (CSV metallb-operator.v4.22.0-202610281200)',
        how: {
          explain:
            'OLM installs an operator from a project, an OperatorGroup and a Subscription; `sed` rewrites the shipped example Subscription for MetalLB. This moves your terminal to `metallb-system`, so later commands here name their project with `-n`. Ticks after about 10 seconds, when the CSV reaches Succeeded.',
          run: [
            'oc new-project metallb-system',
            'oc apply -f examples/operatorgroup.yaml',
            "sed 's/ansible-automation-platform-operator/metallb-operator/; s/openshift-operators/metallb-system/; s/stable-2.6/stable/' examples/subscription.yaml | oc apply -f -",
          ],
          check: 'oc get csv -n metallb-system',
        },
      },
      {
        type: 'complete',
        kind: 'Job',
        count: 1,
        label: 'Run a Job to phase Complete',
        how: {
          explain:
            'A Job runs a Pod once and stops when the work is done; here perl prints 42 and exits, so the Job reaches status Complete within a few seconds.',
          run: ['oc create job report-job --image=perl -n prod-platform -- perl -e "print 42"'],
          check: 'oc get jobs -n prod-platform',
        },
      },
      {
        type: 'cronJob',
        name: 'nightly',
        suspended: false,
        label: 'Create the CronJob "nightly"',
        how: {
          explain:
            'A CronJob starts a Job on a schedule of five fields (minute, hour, day of month, month, weekday); `*/5 * * * *` means every 5 minutes. The first Job appears only at the next scheduled time.',
          run: [
            'oc create cronjob nightly --image=busybox --schedule="*/5 * * * *" -n prod-platform -- sh -c date',
          ],
          check: 'oc get cronjob -n prod-platform',
        },
      },
      // Capstone gating (#20): the scheduled incidents must be RESOLVED, not
      // merely fired — finishing with CrashLoopBackOff/NodeNotReady still
      // active is impossible, and the level cannot be rushed in under 2 min.
      {
        type: 'resolve',
        incidentType: 'CrashLoopBackOff',
        count: 1,
        label: 'Resolve the scheduled CrashLoopBackOff (fires 60 s into the capstone)',
        how: {
          explain:
            'At 60 seconds the webapp pods get an invalid `APP_MODE` and crash. Find the crashing pod with `oc get pods`, read why with `oc logs POD --previous`, then set a valid value. Fix it only after the incident appears: an earlier fix is overwritten.',
          run: ['oc set env deployment/webapp APP_MODE=production -n prod-platform'],
          check: 'oc get pods -n prod-platform',
        },
      },
      {
        type: 'resolve',
        incidentType: 'NodeNotReady',
        count: 1,
        label: 'Resolve the scheduled NodeNotReady (fires 120 s into the capstone)',
        how: {
          explain:
            "At 120 seconds the node worker-1 stops reporting (NotReady; `oc get nodes` shows it). `oc debug node/worker-1` starts a helper pod on it, `chroot /host` switches to the node's own tools, and `systemctl restart kubelet` restarts the node agent.",
          run: ['oc debug node/worker-1 -- chroot /host systemctl restart kubelet'],
          check: 'oc get nodes',
        },
      },
      // NOTE: threshold is deliberately modest versus the current ScoringEngine scale...
      // a solid capstone platform scores ~34 today; modes-dev's rewritten advisor may rescale.
      {
        type: 'architectureScore',
        minScore: 25,
        // 1.16.0: rate YOUR project, not the platform's seeded workloads (the
        // whole-cluster score was ≈ 54 before prod-platform even existed).
        namespace: 'prod-platform',
        label: 'Architecture Advisor score >= 25',
        how: {
          explain:
            'Nothing to type: the Advisor rates good practice in your project `prod-platform` (replicas, probes, resource limits, quotas, NetworkPolicies, ...). It starts at 0 and passes 25 once the webapp Deployment from `manifests/deployment.yaml` runs there; it turns red again if a change drops it below 25.',
        },
      },
      {
        type: 'examScore',
        minScore: 75,
        // 1.16.0: the final gate — it completes only once every other
        // objective is done (it used to tick after ~14 of 18).
        namespace: 'prod-platform',
        label: 'Composite drill score >= 75 (in-game metric, not a Red Hat exam score)',
        how: {
          explain:
            'Nothing to type: this in-game score counts your finished objectives (60 %), the cluster health (20 %) and the Advisor score of `prod-platform` (20 %). The mission card shows it as "n/75"; it ticks last, once every other objective is done.',
        },
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
      'TLS Route with `tls.externalCertificate` (manifests/route.yaml): real OCP 4.22 admits it only after the referenced Secret exists AND the ingress router can read it - a Route applied without both stays rejected with `ExternalCertificateValidationFailed`. (1) Create the Secret in prod-platform: `openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=webapp.apps.cluster.example.com"`, then `oc create secret tls webapp-tls --cert=tls.crt --key=tls.key -n prod-platform`. (2) Grant the router read access in the same project: `oc apply -f examples/route-external-cert-rbac.yaml -n prod-platform` (a Role with get/list/watch on the named Secret plus a RoleBinding to system:serviceaccount:openshift-ingress:router). (3) Only then apply the Route: `oc apply -f manifests/route.yaml -n prod-platform`, and confirm with `oc describe route webapp -n prod-platform` (it says `exposed on router default` once the Route is Admitted, otherwise it names the rejection reason; `oc get route` has no status column). A plain `oc create route edge webapp --service=webapp` embeds no externalCertificate and needs none of this.',
      'Build: `oc apply -f examples/buildconfig.yaml` (it already outputs ImageStreamTag `webapp:latest`), then `oc start-build webapp --follow` and watch the Build reach Complete.',
      'NetworkPolicy + ingress: apply the shipped `examples/default-deny.yaml` (`networking.k8s.io/v1`, selects all Pods) with `oc apply -f examples/default-deny.yaml -n prod-platform`, then verify from the workstation: `HOST=$(oc get route webapp -n prod-platform -o jsonpath="{.spec.host}"); curl -k https://$HOST` now fails with 503 even though the Route is Admitted. Allow the router with an ingress NetworkPolicy whose `namespaceSelector.matchLabels` is `policy-group.network.openshift.io/ingress: ""` (the shipped `examples/allow-from-router.yaml`, `oc apply -f examples/allow-from-router.yaml -n prod-platform`) and re-run `curl` — it must answer again. There is no `oc create networkpolicy` subcommand; use the Files panel New/Import buttons for other policies. Also create `oc create user developer` and `oc adm groups new developers developer`.',
      'Install MetalLB the 4.x OLM way: `oc new-project metallb-system`, `oc apply -f examples/operatorgroup.yaml`, edit `examples/subscription.yaml` (spec.name/metadata.name `metallb-operator`, namespace `metallb-system`, spec.channel `stable` — the example ships with the Ansible channel `stable-2.6`, which MetalLB does not have) and apply it, wait for the CSV `metallb-operator.v4.22.0-202610281200` (`oc get csv -n metallb-system`) to reach Succeeded, then `oc apply -f examples/metallb.yaml` (MetalLB CR + IP pool + L2 advertisement).',
      'Finish with a Job (`oc create job report-job --image=perl -- perl -e "print 42"`) and a CronJob (`oc create cronjob nightly --image=busybox --schedule="*/5 * * * *" -- sh -c date`), then check `oc status`; the mission card shows the composite drill score as `n/75` until it ticks (the Architecture Advisor score is part of it, the campaign HUD has no separate gauge). The capstone is gated on the scheduled incidents being RESOLVED: CrashLoopBackOff fires 60 s in on webapp and NodeNotReady fires 120 s in on worker-1. For the CrashLoopBackOff, run `oc logs <pod> -n prod-platform --previous` (the crash names the invalid `APP_MODE`) and correct it with `oc set env deployment/webapp APP_MODE=production -n prod-platform` — an unrelated env var or `oc rollout restart` will NOT clear it. Restore the node with `oc debug node/worker-1 -- chroot /host systemctl restart kubelet` (typing `oc debug node/worker-1` on its own opens a shell on the node: run `chroot /host systemctl restart kubelet`, then `exit`, or every later `oc` command answers `bash: oc: command not found`) and confirm both incidents are gone from the Incidents panel — the level cannot complete while either is still active.',
    ],
    starCriteria: { time: 900, efficiency: 0.6, noFailures: false },
    nextLevel: null,
  },
];

// ═══════════════════════════ CAMPAIGN STRUCTURE (1.16.0) ═══════════════════════════
//
// `CHAPTERS` is the single source of truth for campaign ORDER; level ids are only
// stable save keys. Two tracks share the campaign:
//   - the optional prelude (chapter 0, Linux & RHEL Foundations, ids 101–107,
//     displayed 0.1–0.7) — it never gates the EX280 track;
//   - the EX280 track (chapters 1–5), displayed 1..N by position. Levels added
//     after 1.15.0 got new ids (21 Network Policies, 22 Nodes & Cluster
//     Troubleshooting) and sit before the capstone (id 20), so the capstone is
//     displayed as the last number while saved progress keeps its meaning.
// A level unlocks when the previous level of its own track is completed (or it
// was completed before). Every consumer (CampaignMode, the level select, the
// start page, scoring, tests) uses the helpers below instead of `id - 1`.

/** Chapter id of the optional Linux & RHEL Foundations prelude. */
const PRELUDE_CHAPTER_ID = 0;

const CHAPTER_DEFS = [
  {
    id: PRELUDE_CHAPTER_ID,
    name: 'Linux & RHEL Foundations',
    levels: [101, 102, 103, 104, 105, 106, 107],
    description:
      'Optional prelude: the RHEL command line an OpenShift admin uses every day — files, text, permissions, services, networking, packages and containers',
    prelude: true,
  },
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
    levels: [17, 18, 19, 21, 22, 20],
    description:
      'SCCs, Operators, Jobs/CronJobs, NetworkPolicies, node troubleshooting and the full EX280 capstone',
  },
];

const LEVELS_BY_ID = new Map();
for (const level of [...LINUX_LEVELS, ...OPENSHIFT_LEVELS]) LEVELS_BY_ID.set(level.id, level);

/** Chapters in campaign order, listing only levels that exist. */
const CHAPTERS = CHAPTER_DEFS.map((chapter) => ({
  ...chapter,
  levels: chapter.levels.filter((id) => LEVELS_BY_ID.has(id)),
})).filter((chapter) => chapter.levels.length > 0);

/** Every level id in campaign order (prelude first, then the EX280 track). */
const CAMPAIGN_ORDER = CHAPTERS.flatMap((chapter) => chapter.levels);
const PRELUDE_ORDER = CHAPTERS.filter((chapter) => chapter.id === PRELUDE_CHAPTER_ID).flatMap(
  (chapter) => chapter.levels
);
/** The EX280 track (chapters 1–5) in order; the capstone is its last level. */
const EX280_ORDER = CHAPTERS.filter((chapter) => chapter.id !== PRELUDE_CHAPTER_ID).flatMap(
  (chapter) => chapter.levels
);

/**
 * All levels sorted in campaign order. A level missing from `CHAPTERS` would be
 * unreachable from the level select; it is appended so deep links still work
 * and scripts/verify.mjs reports it.
 */
const CAMPAIGN_LEVELS = [
  ...CAMPAIGN_ORDER.map((id) => LEVELS_BY_ID.get(id)),
  ...[...LEVELS_BY_ID.values()].filter((level) => !CAMPAIGN_ORDER.includes(level.id)),
];

/** @param {number|string} levelId */
function getCampaignLevel(levelId) {
  return LEVELS_BY_ID.get(Number(levelId)) || null;
}

/** True for a level of the optional Linux & RHEL Foundations prelude. */
function isPreludeLevel(levelId) {
  return PRELUDE_ORDER.includes(Number(levelId));
}

function trackOrder(levelId) {
  return isPreludeLevel(levelId) ? PRELUDE_ORDER : EX280_ORDER;
}

/** The level before this one in its own track, or null for a track's first level. */
function previousLevelId(levelId) {
  const order = trackOrder(levelId);
  const index = order.indexOf(Number(levelId));
  return index > 0 ? order[index - 1] : null;
}

/** 1-based position of a level within its own track (display number, XP scaling). */
function levelOrdinal(levelId) {
  const index = trackOrder(levelId).indexOf(Number(levelId));
  return index >= 0 ? index + 1 : Number(levelId) || 1;
}

/**
 * The number players see: "0.1"–"0.7" for the prelude and the position in the
 * EX280 track otherwise ("1"…"22"), never the internal id.
 * @param {number|string} levelId
 * @returns {string}
 */
function levelLabel(levelId) {
  if (isPreludeLevel(levelId)) return `0.${levelOrdinal(levelId)}`;
  if (EX280_ORDER.includes(Number(levelId))) return String(levelOrdinal(levelId));
  return String(levelId ?? '');
}

/** Saved progress keys are JSON object keys (strings); accept both forms. */
function progressEntry(campaignProgress, levelId) {
  if (!campaignProgress || typeof campaignProgress !== 'object') return null;
  return campaignProgress[levelId] ?? campaignProgress[String(levelId)] ?? null;
}

function isLevelCompleted(levelId, campaignProgress = {}) {
  return Boolean(progressEntry(campaignProgress, levelId)?.completed);
}

/**
 * A level can be started when the previous level of its own track is completed,
 * when it is the first level of its track, or when it was completed before
 * (replay; a level inserted in front of it never re-locks finished work).
 */
function isLevelUnlocked(levelId, campaignProgress = {}) {
  const id = Number(levelId);
  if (!LEVELS_BY_ID.has(id)) return false;
  if (isLevelCompleted(id, campaignProgress)) return true;
  const previous = previousLevelId(id);
  return previous === null || isLevelCompleted(previous, campaignProgress);
}

function firstOpenLevel(order, campaignProgress) {
  return (
    order.find(
      (id) => !isLevelCompleted(id, campaignProgress) && isLevelUnlocked(id, campaignProgress)
    ) ?? null
  );
}

/** True once every level of the campaign (prelude included) is completed. */
function isCampaignComplete(campaignProgress = {}) {
  return CAMPAIGN_ORDER.every((id) => isLevelCompleted(id, campaignProgress));
}

/**
 * The level a "Start / Continue" action opens. A new player starts at the first
 * level (the Linux prelude); otherwise the player continues the track they
 * completed a level in most recently (falling back to the EX280 track), and a
 * finished campaign replays from Level 1.
 */
function continueLevelId(campaignProgress = {}) {
  const completed = CAMPAIGN_ORDER.filter((id) => isLevelCompleted(id, campaignProgress));
  if (completed.length === 0) return CAMPAIGN_ORDER[0] ?? 1;
  if (completed.length === CAMPAIGN_ORDER.length) return EX280_ORDER[0] ?? CAMPAIGN_ORDER[0];
  let latest = null;
  for (const id of completed) {
    const at = Number(progressEntry(campaignProgress, id)?.completedAt) || 0;
    if (!latest || at >= latest.at) latest = { id, at };
  }
  const preludeNext = firstOpenLevel(PRELUDE_ORDER, campaignProgress);
  const ex280Next = firstOpenLevel(EX280_ORDER, campaignProgress);
  if (latest && isPreludeLevel(latest.id) && preludeNext !== null) return preludeNext;
  return ex280Next ?? preludeNext ?? CAMPAIGN_ORDER[0];
}

export {
  CAMPAIGN_LEVELS,
  CHAPTERS,
  CAMPAIGN_ORDER,
  EX280_ORDER,
  PRELUDE_CHAPTER_ID,
  PRELUDE_ORDER,
  continueLevelId,
  getCampaignLevel,
  isCampaignComplete,
  isLevelCompleted,
  isLevelUnlocked,
  isPreludeLevel,
  levelLabel,
  levelOrdinal,
  previousLevelId,
};
