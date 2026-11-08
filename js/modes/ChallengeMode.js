/**
 * ChallengeMode — 13 timed OpenShift 4.22 / EX280 labs (CONVERSION-SPEC §10).
 *
 * Keeps the original challenge runner/state machine and public API
 * (`CHALLENGES`, `startChallenge`, `getStatus`, `restart`, `exit`, ...) but:
 *  - scenarios are the 13 from CONVERSION-SPEC §10 (lab 13 "Production Network
 *    Policies" is the 1.1.8 coverage addition for issue #34),
 *  - objectives are evaluated by js/engine/ObjectiveEvaluator.js (no duplicate
 *    objective logic),
 *  - starting resources go through ClusterState.addResource() so the registry
 *    factory, owner chains and rich classes are used,
 *  - manifests/Files panel integration seeds challenge-specific YAML via the
 *    shared ManifestEngine (no edits outside the mode).
 *
 * No engine edits: every optional engine API is feature-detected so this mode
 * also works against partially-integrated builds and in Node test harnesses.
 */

import {
  createObjectiveProgress,
  evaluateObjectives,
  getObjectiveSummary,
} from '../engine/ObjectiveEvaluator.js';
import { catalogNode } from '../engine/ClusterState.js';
import { RESOURCE_KINDS } from '../data/kindRegistry.js';

const CHALLENGE_STATE = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const DOCS_BASE = 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html';
const DOCS = {
  cli: `${DOCS_BASE}/cli_tools/openshift-cli-oc`,
  projects: `${DOCS_BASE}/building_applications/projects`,
  deployments: `${DOCS_BASE}/building_applications/deployments`,
  creating: `${DOCS_BASE}/building_applications/creating-applications`,
  quotas: `${DOCS_BASE}/building_applications/quotas`,
  health: `${DOCS_BASE}/building_applications/application-health`,
  routes: `${DOCS_BASE}/ingress_and_load_balancing/routes`,
  metallb: `${DOCS_BASE}/ingress_and_load_balancing/load-balancing-with-metallb`,
  network: `${DOCS_BASE}/network_security/index`,
  scc: `${DOCS_BASE}/authentication_and_authorization/managing-pod-security-policies`,
  rbac: `${DOCS_BASE}/authentication_and_authorization/using-rbac`,
  auth: `${DOCS_BASE}/authentication_and_authorization/understanding-authentication`,
  idp: `${DOCS_BASE}/authentication_and_authorization/configuring-identity-providers`,
  builds: `${DOCS_BASE}/builds_using_buildconfig/understanding-buildconfigs`,
  buildOps: `${DOCS_BASE}/builds_using_buildconfig/basic-build-operations`,
  images: `${DOCS_BASE}/images/managing-image-streams`,
  operators: `${DOCS_BASE}/operators/user-tasks`,
  jobs: `${DOCS_BASE}/nodes/using-jobs-and-daemon-sets`,
  kustomize: `${DOCS_BASE}/building_applications/creating-applications`,
};

const DEFAULT_IMAGE = 'quay.io/openshift/origin-hello-openshift:latest';

// ─── starting-resource helpers ─────────────────────────────────────────────

/**
 * Ready Nodes for a lab cluster, built from the shared machine catalog (#53F):
 * 2 nodes are `worker-0`/`worker-1`, 3 nodes add the `master-0` control-plane
 * machine — exactly the names/roles campaign levels and the sandbox show.
 */
function nodes(count = 2, cpu = '16', memory = '32Gi') {
  return Array.from({ length: count }, (_, index) => {
    const machine = catalogNode(index);
    return {
      kind: 'Node',
      name: machine.name,
      labels: machine.labels,
      spec: { cpu, memory, pods: 250 },
      status: { phase: 'Running' },
    };
  });
}

function project(name, displayName = name) {
  return {
    kind: 'Project',
    name,
    spec: { displayName, description: `${displayName} OpenShift project` },
    status: { phase: 'Active' },
  };
}

function deployment(
  name,
  {
    namespace = 'default',
    replicas = 2,
    image = DEFAULT_IMAGE,
    app = name,
    labels = {},
    containerPort = 8080,
    securityContext = null,
    serviceAccountName = null,
  } = {}
) {
  const container = {
    name: 'main',
    image,
    ports: [{ name: 'http', containerPort }],
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    },
  };
  if (securityContext) container.securityContext = securityContext;
  const podSpec = { containers: [container] };
  if (serviceAccountName) podSpec.serviceAccountName = serviceAccountName;
  return {
    kind: 'Deployment',
    name,
    namespace,
    labels: { app, ...labels },
    spec: {
      replicas,
      selector: { matchLabels: { app } },
      template: {
        metadata: { labels: { app, ...labels } },
        spec: podSpec,
      },
    },
  };
}

function service(
  name,
  {
    namespace = 'default',
    app = name,
    selector = null,
    port = 8080,
    targetPort = 8080,
    type = 'ClusterIP',
  } = {}
) {
  return {
    kind: 'Service',
    name,
    namespace,
    labels: { app },
    spec: {
      type,
      selector: selector || { app },
      ports: [{ name: 'http', port, targetPort, protocol: 'TCP' }],
    },
  };
}

function route(
  name,
  {
    namespace = 'default',
    serviceName = name,
    host = '',
    path = '/',
    termination = 'edge',
    insecureEdgeTerminationPolicy = 'Redirect',
  } = {}
) {
  const spec = {
    host,
    path,
    to: { kind: 'Service', name: serviceName, weight: 100 },
    port: { targetPort: 'http' },
    wildcardPolicy: 'None',
  };
  if (termination) {
    spec.tls = { termination, insecureEdgeTerminationPolicy };
  }
  return { kind: 'Route', name, namespace, spec };
}

// ─── challenge-specific manifest files (seeded into the virtual FS) ────────

const CHALLENGE_FILES = {
  8: {
    'challenges/privileged-app.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: privileged-app
  namespace: secure
  labels:
    app: privileged-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: privileged-app
  template:
    metadata:
      labels:
        app: privileged-app
    spec:
      serviceAccountName: priv-sa
      containers:
        - name: main
          image: quay.io/openshift/origin-hello-openshift:latest
          securityContext:
            privileged: true
`,
  },
  9: {
    'challenges/shop-networkpolicy.yaml': `# Default deny, then allow DNS egress and exactly one app path:
# frontend -> backend (ingress on backend + egress from frontend).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-by-default
  namespace: shop
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress: []
  egress: []
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: shop
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: openshift-dns
      ports:
        - protocol: UDP
          port: 5353
        - protocol: TCP
          port: 5353
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend-to-backend
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend-egress
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: frontend
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: backend
      ports:
        - protocol: TCP
          port: 8080
`,
  },
  10: {
    'challenges/metallb-operator.yaml': `# MetalLB the 4.x OLM way: OperatorGroup + Subscription in metallb-system,
# then the operator operand (MetalLB CR) + an address pool + L2 advertisement.
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: metallb-operatorgroup
  namespace: metallb-system
spec:
  targetNamespaces:
    - metallb-system
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: metallb-operator
  namespace: metallb-system
spec:
  channel: stable
  installPlanApproval: Automatic
  name: metallb-operator
  source: redhat-operators
  sourceNamespace: openshift-marketplace
---
apiVersion: metallb.io/v1beta1
kind: MetalLB
metadata:
  name: metallb
  namespace: metallb-system
spec: {}
---
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: metallb-pool
  namespace: metallb-system
spec:
  addresses:
    - 192.168.100.200-192.168.100.210
  autoAssign: true
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: metallb-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - metallb-pool
`,
  },
  11: {
    'challenges/oauth-htpasswd.yaml': `apiVersion: config.openshift.io/v1
kind: OAuth
metadata:
  name: cluster
spec:
  identityProviders:
    - name: htpasswd
      mappingMethod: claim
      type: HTPasswd
      htpasswd:
        fileData:
          name: htpass-secret
`,
  },
  13: {
    // Starter policy only: the project is isolated, but the learner still has to
    // write the DNS-egress and directional gateway -> ledger allow rules. This
    // fixes the old lab-9 complaint that the provided file gave full marks.
    'challenges/payments-networkpolicy.yaml': `# Zero-trust starting point: isolate the payments project first.
# NetworkPolicies are additive - add the DNS egress and the gateway -> ledger
# allow rules yourself. This lab grades traffic behaviour, not object names.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: payments
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress: []
  egress: []
`,
  },
};

// ─── the 13 challenges (CONVERSION-SPEC §10 + #34 lab 13) ───────────────────

const CHALLENGES = [
  {
    id: 1,
    title: 'Three-Tier App',
    description:
      'Stand up two Projects (frontend and backend), deploy the frontend, backend API and database tiers, expose their Services and route external traffic to the frontend. This is the classic EX280 project + Deployment + Service + Route workflow.',
    timeLimit: 420,
    docsLinks: [DOCS.projects, DOCS.deployments, DOCS.routes],
    objectives: [
      { type: 'project', name: 'frontend', label: 'Create project frontend' },
      { type: 'project', name: 'backend', label: 'Create project backend' },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'frontend',
        namespace: 'frontend',
        label: 'Deploy frontend in project frontend',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'backend',
        namespace: 'backend',
        label: 'Deploy backend in project backend',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'database',
        namespace: 'backend',
        label: 'Deploy database tier in project backend',
      },
      {
        type: 'deploy',
        kind: 'Service',
        name: 'frontend',
        namespace: 'frontend',
        label: 'Create Service frontend',
      },
      {
        type: 'deploy',
        kind: 'Service',
        name: 'backend',
        namespace: 'backend',
        label: 'Create Service backend',
      },
      {
        type: 'deploy',
        kind: 'Service',
        name: 'database',
        namespace: 'backend',
        label: 'Create Service database',
      },
      {
        type: 'route',
        name: 'frontend',
        service: 'frontend',
        label: 'Expose the frontend with an admitted Route',
      },
    ],
    startingResources: nodes(3),
    availableResources: ['Project', 'Deployment', 'Service', 'Route', 'ConfigMap', 'Secret'],
    hints: [
      'Create both projects first: oc new-project frontend && oc new-project backend',
      'Deploy the frontend and backend tiers with oc new-app --image=quay.io/openshift/origin-hello-openshift:latest --name=<tier> -n <project> (frontend in frontend; backend in backend).',
      'Deploy the database tier from the real MySQL image: oc new-app --image=registry.redhat.io/rhel9/mysql-80 --name=database -n backend. It CrashLoopBackOffs until credentials are supplied - oc get pods -n backend shows CrashLoopBackOff and oc logs <pod> -n backend prints "You must either specify the following environment variables: MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE or MYSQL_ROOT_PASSWORD". Fix it the exam way: oc set env deployment/database -n backend MYSQL_ROOT_PASSWORD=secretpw MYSQL_DATABASE=appdb, then watch the new Pods become Running.',
      'oc new-app creates both a Deployment and a Service; the generated Service exposes the image port (3306/TCP for MySQL, 8080 for the hello-openshift image). Verify with oc get deploy,svc -n frontend and -n backend',
      'Expose the frontend Service: oc expose svc/frontend -n frontend (or oc create route edge...)',
      'A Route is Admitted on host/path/certificate validity, not on backend health: with no ready endpoints the Route is still Admitted=True while requests from the workstation fail with 503 and the router logs an error. Verify both: oc get route frontend -n frontend -o wide and curl -k https://<route-host>.',
    ],
  },
  {
    id: 2,
    title: 'Fix CrashLoopBackOff',
    description:
      'The payment-service Deployment is crash looping: image `quay.io/example/payments:v2-bad-config` pulls fine but the app exits with status 1 on an invalid configuration. Read the crash output with oc logs/describe on the real Pods, fix the workload (image/command/env - restarting does not help), and restore health to at least 90%.',
    timeLimit: 240,
    docsLinks: [DOCS.health, DOCS.cli],
    objectives: [
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
        label: 'Resolve CrashLoopBackOff',
      },
      { type: 'uptime', percentage: 90, label: 'Restore cluster health to at least 90%' },
      {
        type: 'command',
        pattern: 'oc\\s+(logs|describe)\\s+.*payment-service',
        count: 1,
        // 1.16.0: the read must have shown something (not a NotFound/empty read).
        inspect: true,
        label: 'Diagnose the failing workload with oc logs/describe',
      },
    ],
    startingResources: [
      ...nodes(2),
      deployment('payment-service', {
        namespace: 'default',
        replicas: 3,
        image: 'quay.io/example/payments:v2-bad-config',
      }),
    ],
    // Fire immediately: the image pulls but the app crashes on startup, so the
    // pre-start/lab state is CrashLoopBackOff (never ImagePullBackOff, #15).
    preloadIncidents: [
      { type: 'CrashLoopBackOff', target: 'payment-service', severity: 3, triggerTime: 0 },
    ],
    availableResources: ['Pod', 'Deployment', 'Service', 'ConfigMap', 'Secret'],
    hints: [
      'Open the incident bell (the suggested commands use the real Pod name), or list the replicas first: oc get pods -l app=payment-service',
      'Read the crash output: oc logs deployment/payment-service --previous - the app exits with status 1 because :v2-bad-config ships an invalid configuration. The image pulls fine, so this is a CrashLoopBackOff, not ImagePullBackOff.',
      'Describe the workload: oc describe deployment/payment-service; the Pods show CrashLoopBackOff and a growing restart count, and the Events show Back-off restarting failed container (not Failed to pull image).',
      'Fix the root cause, not the symptom: oc set image deployment/payment-service main=quay.io/openshift/origin-hello-openshift:latest (or use the incident panel). oc delete pod / oc rollout restart alone only brings the same bad configuration back.',
      'Confirm recovery: oc get pods -l app=payment-service (all Running, 0 restarts) and check the health bar is back to 90%+.',
    ],
  },
  {
    id: 3,
    title: 'Route with Edge TLS',
    description:
      'Secure an existing application with edge TLS: create a kubernetes.io/tls Secret, create an edge Route with oc create route edge, and verify the Route is Admitted by the router.',
    timeLimit: 300,
    docsLinks: [DOCS.routes, DOCS.network],
    objectives: [
      {
        type: 'deploy',
        kind: 'Secret',
        name: 'app-tls',
        namespace: 'web',
        // 1.16.0: a TLS Secret, not any Secret named app-tls.
        secretType: 'kubernetes.io/tls',
        label: 'Create TLS Secret app-tls',
      },
      {
        type: 'route',
        name: 'app',
        service: 'app-svc',
        termination: 'edge',
        label: 'Create an admitted edge Route',
      },
      { type: 'tls', name: 'app', termination: 'edge', label: 'Route uses edge TLS termination' },
      {
        type: 'command',
        pattern: 'create\\s+route\\s+edge',
        count: 1,
        label: 'Use oc create route edge',
      },
    ],
    startingResources: [
      ...nodes(2),
      project('web', 'Web frontend'),
      deployment('app', { namespace: 'web', replicas: 2, app: 'app' }),
      service('app-svc', { namespace: 'web', app: 'app', port: 8080 }),
    ],
    availableResources: ['Secret', 'Route', 'Service', 'Deployment', 'Project'],
    hints: [
      'Create real TLS material first - `oc create secret tls` reads the cert/key files from the virtual filesystem, so a missing file fails with `error: open tls.crt: no such file or directory`. Generate a self-signed pair: openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=app.apps.cluster.example.com"',
      'Create the TLS Secret from those files: oc create secret tls app-tls --cert=tls.crt --key=tls.key -n web',
      'Create the edge Route: oc create route edge app --service=app-svc --cert=tls.crt --key=tls.key -n web',
      'Verify admission and TLS: oc get route app -n web -o yaml; look for status.ingress[0].conditions type=Admitted, status=True',
      'For a Secret-referencing Route, OCP 4.22 supports spec.tls.externalCertificate with a kubernetes.io/tls Secret.',
    ],
  },
  {
    id: 4,
    title: 'Kustomize Prod Overlay',
    description:
      'Apply the production Kustomize overlay, which composes the base resources and patches in the prod namespace, name prefix, image tag and replica count. Verify the rendered Deployment.',
    timeLimit: 300,
    docsLinks: [DOCS.kustomize, DOCS.deployments],
    objectives: [
      {
        type: 'kustomize',
        path: 'kustomize/overlays/prod',
        label: 'Apply kustomize/overlays/prod',
      },
      {
        type: 'scale',
        kind: 'Deployment',
        name: 'prod-webapp',
        replicas: 3,
        label: 'prod-webapp runs 3 replicas',
      },
      {
        type: 'image',
        kind: 'Deployment',
        name: 'prod-webapp',
        imageContains: 'origin-hello-openshift',
        label: 'prod-webapp uses the prod image',
      },
      {
        type: 'command',
        pattern: 'apply\\s+-k\\s+kustomize/overlays/prod',
        count: 1,
        label: 'Apply the overlay with oc apply -k',
      },
    ],
    startingResources: [...nodes(2), project('webapp-prod', 'Webapp production')],
    manifestFiles: [
      'kustomize/base/kustomization.yaml',
      'kustomize/overlays/prod/kustomization.yaml',
      'kustomize/overlays/prod/patch-deployment.yaml',
    ],
    focusFiles: [
      'kustomize/overlays/prod/kustomization.yaml',
      'kustomize/overlays/prod/patch-deployment.yaml',
    ],
    availableResources: ['Project', 'Deployment', 'Service'],
    hints: [
      'Review kustomize/overlays/prod/kustomization.yaml in the Files panel: it uses v5 `labels:` (with includeSelectors) and `patches:` targeting the Deployment - namespace, namePrefix, images and replicas are composed on top. (`patchesStrategicMerge`/`commonLabels` are deprecated.)',
      'Apply the overlay: oc apply -k kustomize/overlays/prod',
      'Verify the rendered objects: oc get deploy,svc -n webapp-prod',
      'The Deployment is named prod-webapp after namePrefix; oc get deploy prod-webapp -n webapp-prod -o yaml shows image and replicas.',
    ],
  },
  {
    id: 5,
    title: 'Build & Deploy from Source',
    description:
      'Use oc new-app with a Git source to create the BuildConfig, run the S2I build to completion, confirm the ImageStreamTag, wait for the Deployment to roll out and expose it with a Route.',
    timeLimit: 360,
    docsLinks: [DOCS.builds, DOCS.buildOps, DOCS.images],
    objectives: [
      {
        type: 'command',
        pattern: '(new-app|new-build|start-build)',
        count: 1,
        label: 'Create/start a build with oc new-app or oc start-build',
      },
      { type: 'build', name: 'webapp', label: 'Build for webapp completes' },
      {
        type: 'imageStream',
        name: 'webapp',
        tag: 'latest',
        label: 'ImageStream webapp:latest exists',
      },
      { type: 'deploy', kind: 'Deployment', name: 'webapp', label: 'Deployment webapp exists' },
      { type: 'route', name: 'webapp', service: 'webapp', label: 'Route webapp is admitted' },
    ],
    startingResources: nodes(2),
    manifestFiles: ['examples/buildconfig.yaml'],
    focusFiles: ['examples/buildconfig.yaml'],
    availableResources: [
      'BuildConfig',
      'Build',
      'ImageStream',
      'Deployment',
      'Service',
      'Route',
      'Project',
    ],
    hints: [
      'Create the app from source (this also starts build #1): oc new-app https://github.com/openshift/nodejs-ex --name=webapp',
      'Watch the build: oc get builds; oc logs -f bc/webapp',
      'Confirm the output tag: oc get imagestreamtag webapp:latest',
      'Expose the Service after the rollout: oc expose svc/webapp; oc get route webapp',
      'Alternatively create the BuildConfig from examples/buildconfig.yaml, then oc start-build webapp.',
    ],
  },
  {
    id: 6,
    title: 'Quota Guardrail',
    description:
      'Enable developer self-service guardrails in quota-lab: create a ResourceQuota and a LimitRange, deploy an app with explicit requests/limits, and clear the ResourceQuotaExceeded incident.',
    timeLimit: 360,
    docsLinks: [DOCS.quotas, DOCS.deployments],
    objectives: [
      { type: 'quota', namespace: 'quota-lab', label: 'Create a ResourceQuota in quota-lab' },
      { type: 'limitRange', namespace: 'quota-lab', label: 'Create a LimitRange in quota-lab' },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'api',
        namespace: 'quota-lab',
        label: 'Deploy api in quota-lab',
      },
      {
        type: 'resources',
        kind: 'Deployment',
        name: 'api',
        label: 'api containers have requests and limits',
      },
      {
        type: 'resolve',
        incidentType: 'ResourceQuotaExceeded',
        count: 1,
        label: 'Resolve ResourceQuotaExceeded',
      },
      {
        type: 'command',
        // Issue #38: `oc create limitrange` does not exist (the CLI rejects it
        // like real oc), so only real forms count: `oc create quota` or YAML
        // applied with `oc apply`.
        pattern: '(create\\s+quota)|(apply.*(quota|limitrange))',
        count: 1,
        label: 'Create the guardrails with oc apply (or oc create quota)',
      },
    ],
    startingResources: [...nodes(2), project('quota-lab', 'Quota lab')],
    preloadIncidents: [
      {
        type: 'ResourceQuotaExceeded',
        target: 'team-quota',
        namespace: 'quota-lab',
        severity: 3,
        triggerTime: 30,
      },
    ],
    manifestFiles: ['examples/quota.yaml', 'examples/limitrange.yaml'],
    focusFiles: ['examples/quota.yaml', 'examples/limitrange.yaml'],
    availableResources: [
      'Project',
      'ResourceQuota',
      'LimitRange',
      'ClusterResourceQuota',
      'Deployment',
      'Service',
      'Route',
    ],
    hints: [
      'Switch to the project: oc project quota-lab',
      'Create the project quota: oc create quota team-quota --hard=pods=10,requests.cpu=4,requests.memory=8Gi',
      // Issue #38: real oc/kubectl have no `create limitrange` subcommand. Teach
      // the declarative path instead (the shipped example sets default/defaultRequest/min/max).
      'Create the LimitRange from YAML (there is no `oc create limitrange` subcommand): oc apply -f examples/limitrange.yaml - it sets default cpu 500m/memory 512Mi, defaultRequest cpu 100m/memory 128Mi and max cpu 2/memory 4Gi. Any LimitRange in quota-lab counts, so a heredoc such as `oc apply -f - <<EOF … EOF` works too.',
      'Deploy within the guardrails: oc create deployment api --image=quay.io/openshift/origin-hello-openshift:latest',
      'Set requests/limits: oc set resources deployment/api --requests=cpu=100m,memory=128Mi --limits=cpu=500m,memory=512Mi',
      'Resolve the ResourceQuotaExceeded incident from the incident panel (raise the quota or right-size requests).',
    ],
  },
  {
    id: 7,
    title: 'RBAC for a New Teammate',
    description:
      'Onboard developer to the team-dev project: create the User, add them to the developers Group, bind the built-in edit ClusterRole with a RoleBinding, prove access with oc auth can-i and keep permissions least-privileged.',
    timeLimit: 300,
    docsLinks: [DOCS.rbac, DOCS.cli],
    objectives: [
      { type: 'user', name: 'developer', label: 'Create User developer' },
      {
        type: 'group',
        name: 'developers',
        users: ['developer'],
        label: 'Group developers contains developer',
      },
      {
        // Issue #71: grade the resulting RBAC state (what `oc auth can-i`
        // reports), not a binding literally named `edit`. Any RoleBinding that
        // gives developers edit in team-dev counts — the generated `edit`,
        // `edit-0`, or the player's own `dev-edit`.
        type: 'canI',
        verb: 'update',
        resource: 'deployments',
        user: 'developer',
        namespace: 'team-dev',
        expected: true,
        label: 'RoleBinding grants edit in team-dev (developer can update Deployments)',
      },
      {
        type: 'canI',
        verb: 'delete',
        resource: 'pods',
        user: 'developer',
        namespace: 'team-dev',
        expected: true,
        label: 'developer can delete Pods in team-dev',
      },
      { type: 'leastPrivilege', label: 'No wildcard or non-admin cluster-admin grants' },
      {
        type: 'command',
        pattern: 'add-role-to-(user|group)|auth\\s+can-i',
        count: 1,
        label: 'Use oc adm policy / oc auth can-i',
      },
    ],
    startingResources: [...nodes(2), project('team-dev', 'Team development')],
    availableResources: [
      'Project',
      'User',
      'Group',
      'Role',
      'RoleBinding',
      'ClusterRole',
      'ClusterRoleBinding',
    ],
    hints: [
      'Create the user and group: oc create user developer; oc adm groups new developers developer',
      'Bind the built-in edit ClusterRole at project scope: oc adm policy add-role-to-group edit developers -n team-dev (or create your own binding: oc create rolebinding dev-edit --clusterrole=edit --group=developers -n team-dev)',
      'Prove it: oc auth can-i delete pods --as=developer -n team-dev and oc auth can-i update deployments --as=developer -n team-dev - the lab grades these answers, not the binding name.',
      'Inspect the binding: oc get rolebinding -n team-dev -o yaml (a reused binding such as dev-edit is just as valid as one named edit).',
      'Avoid cluster-admin and wildcard rules; edit is enough for a developer in one project.',
    ],
  },
  {
    id: 8,
    title: 'SCC for a Privileged Workload',
    description:
      'Admit a workload that requests elevated security with a SecurityContextConstraint: apply the privileged app manifest, create a dedicated ServiceAccount, grant the privileged SCC to that ServiceAccount with a 4.x RBAC binding, and resolve the SCCForbidden incident. anyuid allows an arbitrary UID but NOT privileged containers - privileged: true needs the privileged SCC. Never grant privileged to the project default SA.',
    timeLimit: 300,
    docsLinks: [DOCS.scc, DOCS.rbac],
    objectives: [
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'privileged-app',
        namespace: 'secure',
        label: 'Create privileged-app in project secure',
      },
      {
        type: 'deploy',
        kind: 'ServiceAccount',
        name: 'priv-sa',
        namespace: 'secure',
        label: 'Create the dedicated ServiceAccount priv-sa',
      },
      {
        type: 'scc',
        scc: 'privileged',
        subject: 'system:serviceaccount:secure:priv-sa',
        // 1.16.0: dedicated — a grant that also reaches `default` does not count.
        exclusive: true,
        label: 'Grant the privileged SCC to the dedicated ServiceAccount priv-sa',
      },
      {
        type: 'privileged',
        count: 1,
        namespace: 'secure',
        serviceAccount: 'priv-sa',
        label: 'Get a privileged: true Pod admitted and Running as priv-sa',
      },
      { type: 'resolve', incidentType: 'SCCForbidden', count: 1, label: 'Resolve SCCForbidden' },
      {
        // Issue #71: the label asks for the oc adm policy flow, but the grade is
        // the resulting RBAC state — `oc auth can-i use scc/privileged` for the
        // dedicated ServiceAccount, whatever binding (generated or hand-written)
        // grants it.
        type: 'canI',
        verb: 'use',
        resource: 'scc/privileged',
        user: 'system:serviceaccount:secure:priv-sa',
        namespace: 'secure',
        expected: true,
        label: 'Grant the SCC with oc adm policy (priv-sa can use scc/privileged)',
      },
    ],
    startingResources: [...nodes(2), project('secure', 'Secure workloads')],
    preloadIncidents: [
      {
        type: 'SCCForbidden',
        target: 'privileged-app',
        namespace: 'secure',
        severity: 4,
        triggerTime: 40,
      },
    ],
    manifestFiles: ['challenges/privileged-app.yaml'],
    focusFiles: ['challenges/privileged-app.yaml'],
    availableResources: [
      'Project',
      'Deployment',
      'ServiceAccount',
      'SecurityContextConstraints',
      'Role',
      'RoleBinding',
    ],
    hints: [
      'Apply the workload: oc apply -f challenges/privileged-app.yaml - it sets serviceAccountName: priv-sa and requests privileged: true. The manifest does NOT create that ServiceAccount.',
      'The rejected Pod is never created on 4.x: oc get pods -n secure stays empty and oc describe deployment/privileged-app -n secure shows FailedCreate - either "unable to validate against any security context constraint" (SCC denial) or, before the grant, `error looking up service account secure/priv-sa: serviceaccount "priv-sa" not found` when the ServiceAccount is missing.',
      'Create the dedicated identity (the manifest only references it): oc create sa priv-sa -n secure - do NOT grant elevated SCCs to the default ServiceAccount.',
      'Grant the SCC the 4.x way: oc adm policy add-scc-to-user privileged -z priv-sa -n secure (creates a RoleBinding to ClusterRole system:openshift:scc:privileged; the SCC users list stays unchanged).',
      'Verify with RBAC, not the SCC users list: oc auth can-i use scc/privileged --as=system:serviceaccount:secure:priv-sa; oc get rolebinding -n secure; then oc get pods -n secure shows the admitted Pod Running as priv-sa.',
      'The SCCForbidden incident clears when the state is right - the ServiceAccount can use the privileged SCC and its privileged Pod is Running; the incident panel resolution action is only for exploring the fault.',
    ],
  },
  {
    id: 9,
    title: 'Network Isolation',
    description:
      'Implement zero-trust project networking in shop: default-deny all traffic, allow only DNS egress and the frontend → backend path, then clear the DNSResolutionFailure incident caused by a missing DNS egress rule.',
    timeLimit: 300,
    docsLinks: [DOCS.network, DOCS.routes],
    objectives: [
      // Graded on resulting traffic behaviour (issue #30): the simulator's own
      // NetworkPolicy evaluator probes reachability, DNS egress and default
      // isolation, so any correct hand-written policy set passes — the object
      // names are the learner's choice.
      {
        type: 'networkPolicy',
        probe: 'default-deny',
        namespace: 'shop',
        label: 'Deny all traffic by default (Ingress and Egress)',
      },
      {
        type: 'networkPolicy',
        probe: 'dns-egress',
        namespace: 'shop',
        source: { kind: 'Deployment', name: 'frontend' },
        label: 'Allow DNS egress on port 5353 (dns-default Pod port)',
      },
      {
        type: 'networkPolicy',
        probe: 'reach',
        namespace: 'shop',
        source: { kind: 'Deployment', name: 'frontend' },
        to: { kind: 'Service', name: 'backend' },
        port: 8080,
        label: 'Allow frontend → backend on port 8080',
      },
      {
        type: 'networkPolicy',
        probe: 'deny',
        namespace: 'shop',
        source: { kind: 'Deployment', name: 'backend' },
        to: { kind: 'Service', name: 'frontend' },
        port: 8080,
        label: 'Deny backend → frontend traffic',
      },
      {
        type: 'networkPolicy',
        probe: 'deny-external',
        namespace: 'shop',
        source: { kind: 'Deployment', name: 'frontend' },
        label: 'Deny external (internet) egress',
      },
      {
        type: 'resolve',
        incidentType: 'DNSResolutionFailure',
        count: 1,
        label: 'Resolve DNSResolutionFailure',
      },
    ],
    startingResources: [
      ...nodes(3),
      project('shop', 'Shop'),
      deployment('frontend', { namespace: 'shop', replicas: 2, app: 'frontend' }),
      deployment('backend', { namespace: 'shop', replicas: 2, app: 'backend' }),
      service('frontend', { namespace: 'shop', app: 'frontend' }),
      service('backend', { namespace: 'shop', app: 'backend' }),
    ],
    preloadIncidents: [
      {
        type: 'DNSResolutionFailure',
        target: 'backend',
        namespace: 'shop',
        severity: 4,
        triggerTime: 45,
      },
    ],
    manifestFiles: ['challenges/shop-networkpolicy.yaml'],
    focusFiles: ['challenges/shop-networkpolicy.yaml'],
    availableResources: ['Project', 'NetworkPolicy', 'Deployment', 'Service', 'Route'],
    hints: [
      'Apply the provided policy set: oc apply -f challenges/shop-networkpolicy.yaml - or write your own equivalent policies; the check probes traffic behaviour, not NetworkPolicy object names.',
      'A NetworkPolicy is additive: a default-deny policy that selects every Pod isolates the project, then explicit allow rules re-open only the paths you name.',
      'DNS is required: on OpenShift the dns-default Pods listen on 5353, so the egress rule must allow UDP and TCP 5353 to the openshift-dns namespace - port 53 does NOT unblock name resolution.',
      'Verify from a Pod: oc get networkpolicy -n shop; then oc exec deploy/frontend -- curl -sv http://backend:8080 (allowed) and try http://frontend:8080 from the backend (blocked) and an external host from the frontend (blocked).',
      'Resolve the DNSResolutionFailure incident by allowing egress to the openshift-dns namespace on 5353 (UDP and TCP) - the incident clears as soon as the policy is present.',
    ],
  },
  {
    id: 10,
    title: 'Install an Operator',
    description:
      'Install the MetalLB Operator with OLM, create the IPAddressPool and L2Advertisement, expose a LoadBalancer Service with an external IP, and uninstall an unwanted operator Subscription. Then install the Pipelines operator AllNamespaces in openshift-operators (the cluster-global OperatorGroup) - no new OperatorGroup is needed there.',
    timeLimit: 420,
    docsLinks: [DOCS.operators, DOCS.metallb],
    objectives: [
      {
        type: 'operator',
        name: 'metallb-operator',
        installed: true,
        label: 'MetalLB operator CSV (metallb-operator.v4.22.0-202610281200) reaches Succeeded',
      },
      {
        type: 'deploy',
        kind: 'IPAddressPool',
        name: 'metallb-pool',
        namespace: 'metallb-system',
        label: 'Create IPAddressPool metallb-pool',
      },
      {
        type: 'deploy',
        kind: 'L2Advertisement',
        name: 'metallb-l2',
        namespace: 'metallb-system',
        label: 'Create L2Advertisement metallb-l2',
      },
      {
        type: 'serviceType',
        kind: 'LoadBalancer',
        count: 1,
        label: 'Create a LoadBalancer Service',
      },
      {
        type: 'operator',
        name: 'ansible-automation-platform',
        installed: false,
        // 1.16.0: an uninstall is Subscription AND CSV (aap-operator.v2.6.0) gone.
        label: 'Uninstall the old AAP operator (Subscription and its CSV)',
      },
      {
        type: 'command',
        pattern: '(metallb-operator|loadbalancer|delete\\s+subscription)',
        count: 1,
        label: 'Use oc apply/oc get for the operator or Service',
      },
      {
        type: 'operator',
        name: 'openshift-pipelines-operator-rh',
        namespace: 'openshift-operators',
        allNamespaces: true,
        installed: true,
        label:
          'Install the Pipelines operator AllNamespaces in openshift-operators (global OperatorGroup)',
      },
    ],
    startingResources: [
      ...nodes(3),
      project('metallb-system', 'MetalLB'),
      project('store', 'Store'),
      {
        kind: 'Subscription',
        name: 'ansible-automation-platform-operator',
        namespace: 'openshift-operators',
        spec: {
          name: 'ansible-automation-platform-operator',
          packageName: 'ansible-automation-platform-operator',
          // Real Red Hat catalog channel for the AAP 2.6 package (issue #46).
          channel: 'stable-2.6',
          source: 'redhat-operators',
          sourceNamespace: 'openshift-marketplace',
          installPlanApproval: 'Automatic',
        },
        status: { phase: 'Succeeded', installedCSV: 'aap-operator.v2.6.0' },
      },
    ],
    manifestFiles: [
      'examples/subscription.yaml',
      'challenges/metallb-operator.yaml',
      'examples/subscription-pipelines.yaml',
    ],
    focusFiles: ['challenges/metallb-operator.yaml'],
    availableResources: [
      'Project',
      'Subscription',
      'IPAddressPool',
      'L2Advertisement',
      'Service',
      'Deployment',
    ],
    hints: [
      'Apply the whole OLM manifest set (OperatorGroup + Subscription for package metallb-operator + MetalLB CR + IPAddressPool + L2Advertisement, all in metallb-system): oc apply -f challenges/metallb-operator.yaml',
      'Watch OLM: oc get sub,csv,installplan -n metallb-system - an InstallPlan appears, then the CSV metallb-operator.v4.22.0-202610281200 reaches Succeeded; oc get subscription -n metallb-system -o yaml shows status.installedCSV (redhat-operators package name is metallb-operator).',
      'Create a LoadBalancer Service in the store project: oc create service loadbalancer web-lb --tcp=80:8080 -n store',
      'Check the EXTERNAL-IP column: oc get svc web-lb -n store (MetalLB assigns it from metallb-pool/L2Advertisement; oc describe svc web-lb and oc get events show MetalLB’s Normal IPAllocated event - Assigned IP ["192.168.100.200"]).',
      'Uninstall the old AAP operator properly: oc delete subscription ansible-automation-platform-operator -n openshift-operators, then delete its CSV - read the name from oc get csv -n openshift-operators (aap-operator.v2.6.0) and run oc delete csv aap-operator.v2.6.0 -n openshift-operators - deleting the Subscription alone leaves the operator installed.',
      'AllNamespaces variant: apply examples/subscription-pipelines.yaml (Subscription for openshift-pipelines-operator-rh in openshift-operators) - the cluster-global global-operators OperatorGroup is already there, so no OperatorGroup is needed; watch oc get sub,csv -n openshift-operators until the Pipelines CSV reaches Succeeded.',
      'Confirm the AAP uninstall: oc get csv -n openshift-operators no longer lists the AAP CSV (the Pipelines Subscription/CSV from the AllNamespaces install may still be present).',
    ],
  },
  {
    id: 11,
    title: 'HTPasswd Onboarding',
    description:
      'Configure HTPasswd authentication end-to-end: create an htpasswd entry, store it in openshift-config, apply the OAuth identity provider, log in as the new user, add group membership and grant project permissions - then rotate that user password the real way and log in with the new one.',
    timeLimit: 420,
    docsLinks: [DOCS.idp, DOCS.auth, DOCS.rbac],
    objectives: [
      {
        type: 'command',
        // 1.16.0: the htpasswd tool adding a user (not `--from-file=htpasswd`, not -D).
        pattern: '^(oc\\s+)?htpasswd\\s+(-(?![a-zA-Z]*D)[a-zA-Z]+\\s+)*[^-\\s]\\S*\\s+[^-\\s]\\S*',
        count: 1,
        label: 'Create an htpasswd entry',
      },
      {
        type: 'deploy',
        kind: 'Secret',
        name: 'htpass-secret',
        namespace: 'openshift-config',
        label: 'Create htpass-secret in openshift-config',
      },
      // Graded on resulting state (issue #30): the OAuth singleton must
      // reference the htpass-secret HTPasswd provider and the authentication
      // rollout must have applied it. Heredoc `oc apply -f -`,
      // `oc apply -f idp.yaml` and `oc patch oauth cluster` all count.
      {
        type: 'oauthProvider',
        providerType: 'HTPasswd',
        secretName: 'htpass-secret',
        label: 'Activate the OAuth HTPasswd identity provider (htpass-secret)',
      },
      {
        type: 'user',
        name: 'alice',
        // 1.16.0: created by a first login (has an Identity), not `oc create user`.
        viaLogin: true,
        label: 'User alice exists (created on first login)',
      },
      { type: 'login', user: 'alice', label: 'Log in as alice' },
      {
        // Issue #71: state-graded rotation — the player's OWN new password
        // counts. The hash must change after an earlier successful login, and a
        // later login must authenticate the new hash.
        type: 'password',
        user: 'alice',
        rotate: true,
        requireLogin: true,
        label: 'Rotate alice’s htpasswd password and log in with the new password',
      },
      {
        type: 'group',
        name: 'developers',
        users: ['alice'],
        label: 'Group developers contains alice',
      },
      {
        type: 'deploy',
        kind: 'RoleBinding',
        namespace: 'onboarding',
        count: 1,
        // 1.16.0: the access must be granted to alice (or her group).
        subjects: ['user:alice', 'group:developers'],
        label: 'Grant project access in onboarding',
      },
      {
        type: 'canI',
        verb: 'get',
        resource: 'pods',
        user: 'alice',
        namespace: 'onboarding',
        expected: true,
        label: 'alice can get Pods in onboarding',
      },
    ],
    startingResources: [...nodes(2), project('onboarding', 'Onboarding')],
    manifestFiles: ['htpasswd', 'challenges/oauth-htpasswd.yaml'],
    focusFiles: ['htpasswd', 'challenges/oauth-htpasswd.yaml'],
    availableResources: [
      'Project',
      'User',
      'Group',
      'Identity',
      'OAuth',
      'Secret',
      'RoleBinding',
      'ServiceAccount',
    ],
    hints: [
      'Create the htpasswd entry (the simulator has a virtual htpasswd file): htpasswd -c -b htpasswd alice openshift',
      'Store it in openshift-config with the mandatory htpasswd key: oc create secret generic htpass-secret --from-file=htpasswd=htpasswd -n openshift-config',
      'Configure the provider from the Files panel: oc apply -f challenges/oauth-htpasswd.yaml - or write the OAuth manifest yourself and oc apply -f idp.yaml / cat <<EOF | oc apply -f - / oc patch oauth cluster --type=merge -p \'{"spec":…}\'. The check grades the resulting OAuth state, not the command.',
      'Wait for the OAuth rollout, then log in: oc login -u alice -p openshift; oc whoami',
      'Rotate the password with YOUR OWN new password: oc extract secret/htpass-secret -n openshift-config --to /tmp --confirm; htpasswd -bB /tmp/htpasswd alice "<new-password>"; oc set data secret/htpass-secret -n openshift-config --from-file=htpasswd=/tmp/htpasswd - the operator restarts oauth-openshift, so wait for the rollout (oc get clusteroperators authentication) before oc login -u alice -p "<new-password>" (the old password is rejected until then). There is no fixed password: the check grades state - alice’s hash changed after a successful login and a later login with the new password succeeds.',
      'Create the group with the user (or add later): oc adm groups new developers alice  # oc adm groups add-users developers alice',
      'Grant project access: oc adm policy add-role-to-user edit alice -n onboarding',
      'Verify: oc auth can-i get pods --as=alice -n onboarding',
    ],
  },
  {
    id: 12,
    title: 'EX280 Speed Run',
    description:
      'A mixed exam-style sprint under time: create a project, apply manifests, build from source, expose an edge-TLS Route, set a quota, run a Job to completion and grant RBAC to a developer.',
    timeLimit: 420,
    docsLinks: [DOCS.creating, DOCS.builds, DOCS.routes, DOCS.quotas, DOCS.jobs, DOCS.rbac],
    objectives: [
      { type: 'project', name: 'prod', label: 'Create project prod' },
      {
        type: 'manifest',
        file: 'manifests/deployment.yaml',
        label: 'Apply manifests/deployment.yaml',
      },
      {
        type: 'deploy',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'prod',
        label: 'Deployment webapp is running in prod',
      },
      { type: 'build', name: 'builder', label: 'Build builder completes' },
      {
        type: 'imageStream',
        name: 'builder',
        tag: 'latest',
        label: 'ImageStream builder:latest exists',
      },
      {
        type: 'route',
        name: 'webapp',
        service: 'webapp',
        termination: 'edge',
        label: 'Edge-TLS Route webapp is admitted',
      },
      {
        type: 'quota',
        name: 'prod-quota',
        namespace: 'prod',
        label: 'Create ResourceQuota prod-quota',
      },
      { type: 'complete', kind: 'Job', name: 'db-migrate', label: 'Job db-migrate completes' },
      { type: 'user', name: 'developer', label: 'Create User developer' },
      {
        type: 'canI',
        verb: 'get',
        resource: 'pods',
        user: 'developer',
        namespace: 'prod',
        expected: true,
        label: 'developer can get Pods in prod',
      },
      {
        type: 'command',
        pattern: 'apply\\s+-f|new-build|start-build',
        count: 1,
        label: 'Use declarative apply and/or a build',
      },
    ],
    startingResources: nodes(3),
    manifestFiles: [
      'manifests/deployment.yaml',
      'manifests/service.yaml',
      'manifests/route.yaml',
      'examples/route-external-cert-rbac.yaml',
    ],
    focusFiles: [
      'manifests/deployment.yaml',
      'manifests/service.yaml',
      'manifests/route.yaml',
      'examples/route-external-cert-rbac.yaml',
    ],
    availableResources: [
      'Project',
      'Deployment',
      'Service',
      'Route',
      'BuildConfig',
      'ImageStream',
      'ResourceQuota',
      'Job',
      'User',
      'RoleBinding',
    ],
    hints: [
      'Create and switch to the project: oc new-project prod',
      'Apply the app manifests in order: oc apply -f manifests/deployment.yaml; oc apply -f manifests/service.yaml.',
      // Issue #39: manifests/route.yaml uses tls.externalCertificate. Real OCP 4.22
      // only admits it once the referenced Secret exists AND the ingress router can
      // read it, so the Route step must come after these two prerequisites.
      'TLS Route prerequisites (manifests/route.yaml uses tls.externalCertificate): create the Secret and the router read RBAC first - openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=webapp.apps.cluster.example.com"; oc create secret tls webapp-tls --cert=tls.crt --key=tls.key -n prod; oc apply -f examples/route-external-cert-rbac.yaml -n prod. Without both the Route stays Admitted=False (ExternalCertificateValidationFailed).',
      'Then apply the Route: oc apply -f manifests/route.yaml -n prod; oc get route webapp -n prod and confirm Admitted.',
      'Create and start a build: oc new-build nodejs:20-ubi9 --name=builder; oc start-build builder',
      'Create the quota: oc create quota prod-quota --hard=pods=20,requests.cpu=4,requests.memory=8Gi',
      'Run the Job: oc create job db-migrate --image=busybox:latest. Trap: a compute quota without a LimitRange rejects a Pod that omits requests - no Pod is created and oc describe job db-migrate -n prod shows a FailedCreate event ("failed quota: prod-quota: must specify requests.cpu,requests.memory"). A Job’s pod template is IMMUTABLE, so updating the resources of an existing Job with `oc set resources` is rejected (The Job \\"db-migrate\\" is invalid: spec.template: Invalid value: …: field is immutable): delete the Job and recreate it from a manifest that sets the requests - oc create job db-migrate --image=busybox:latest --dry-run=client -o yaml > job.yaml, add resources.requests.cpu: 100m and memory: 128Mi to the container, then oc delete job db-migrate and oc apply -f job.yaml (a `cat <<EOF | oc apply -f -` manifest works too). Watch it Complete with oc get job db-migrate -w.',
      'Grant RBAC: oc create user developer; oc adm policy add-role-to-user edit developer -n prod',
      'Verify the Route is admitted and the Job completes before the timer runs out.',
    ],
  },
  {
    id: 13,
    title: 'Production Network Policies',
    description:
      'Make the payments project zero-trust: deny all ingress and egress by default, then re-open only the DNS egress and the gateway → ledger API path on port 8080 - while keeping the reverse direction blocked. A default-deny policy is provided in challenges/payments-networkpolicy.yaml; apply it (or write your own), then add the allow rules. The lab grades traffic behaviour, not NetworkPolicy object names.',
    timeLimit: 300,
    docsLinks: [DOCS.network],
    objectives: [
      {
        type: 'networkPolicy',
        probe: 'default-deny',
        namespace: 'payments',
        label: 'Deny all ingress and egress in payments by default',
      },
      {
        type: 'networkPolicy',
        probe: 'dns-egress',
        namespace: 'payments',
        source: { kind: 'Deployment', name: 'gateway' },
        label: 'Allow DNS egress on UDP/TCP 5353 to openshift-dns',
      },
      {
        type: 'networkPolicy',
        probe: 'reach',
        namespace: 'payments',
        source: { kind: 'Deployment', name: 'gateway' },
        to: { kind: 'Service', name: 'ledger' },
        port: 8080,
        label: 'Allow gateway → ledger on port 8080',
      },
      {
        type: 'networkPolicy',
        probe: 'deny',
        namespace: 'payments',
        source: { kind: 'Deployment', name: 'ledger' },
        to: { kind: 'Service', name: 'gateway' },
        port: 8080,
        label: 'Keep ledger → gateway blocked (the allow is directional)',
      },
    ],
    startingResources: [
      ...nodes(3),
      project('payments', 'Payments'),
      deployment('gateway', { namespace: 'payments', replicas: 2, app: 'gateway' }),
      deployment('ledger', { namespace: 'payments', replicas: 2, app: 'ledger' }),
      service('gateway', { namespace: 'payments', app: 'gateway' }),
      service('ledger', { namespace: 'payments', app: 'ledger' }),
    ],
    manifestFiles: ['challenges/payments-networkpolicy.yaml'],
    focusFiles: ['challenges/payments-networkpolicy.yaml'],
    availableResources: ['Project', 'NetworkPolicy', 'Deployment', 'Service', 'Pod'],
    hints: [
      'Isolate the project first with the provided default-deny policy: oc apply -f challenges/payments-networkpolicy.yaml (or write your own equivalent) - NetworkPolicies are additive, so the deny isolates the project and each allow rule re-opens exactly one path. No policy is applied to payments at start.',
      'DNS: allow egress to the openshift-dns namespace on BOTH UDP and TCP port 5353 (the dns-default Pods listen on 5353, not 53). Without it, gateway cannot resolve ledger and every call fails.',
      'Direction matters: with default-deny in both directions you need an egress rule on gateway AND an ingress rule on ledger. Do not mirror those rules for ledger → gateway - the deny objective proves the path stays closed.',
      'Verify as the workloads: oc exec deploy/gateway -n payments -- curl -sv http://ledger:8080 (allowed), oc exec deploy/ledger -n payments -- curl -sv http://gateway:8080 (blocked), and oc get networkpolicy -n payments.',
      'The check probes the traffic evaluator: hand-written policies with any names/selectors are fine as long as the resulting traffic behaviour matches.',
    ],
  },
];

const REGISTRY_KINDS = new Set(RESOURCE_KINDS);

// Keep `availableResources` honest: every advertised kind must exist in the
// central registry (single source of truth). Unknown entries are dropped
// rather than silently teaching a non-existent resource.
for (const challenge of CHALLENGES) {
  if (Array.isArray(challenge.availableResources)) {
    challenge.availableResources = challenge.availableResources.filter((kind) =>
      REGISTRY_KINDS.has(kind)
    );
  }
}

// ─── the runner ────────────────────────────────────────────────────────────

class ChallengeMode {
  constructor(gameEngine, incidentEngine, scoringEngine) {
    this.gameEngine = gameEngine;
    this.incidentEngine = incidentEngine;
    this.scoringEngine = scoringEngine;
    this.state = CHALLENGE_STATE.MENU;
    this.currentChallenge = null;
    this.currentChallengeDef = null;
    this.objectiveProgress = [];
    this.startTime = 0;
    this.elapsedTime = 0;
    this.timeRemaining = 0;
    this.pausedTime = 0;
    this.pauseStart = 0;
    this.ticker = null;
    this.usedHints = false;
    this.challengeFilesSeeded = false;
    this.hadFailures = false;

    if (this.gameEngine) this.gameEngine.challengeLevels = CHALLENGES;
  }

  // ─── menu data ────────────────────────────────────────────────────────────

  getChallenges() {
    let progress = { challengeProgress: {} };
    try {
      progress = this.scoringEngine?.getProgress?.() || progress;
    } catch {
      /* defensive */
    }
    const challengeProgress = progress.challengeProgress || {};
    return CHALLENGES.map((challenge) => {
      const saved = challengeProgress[challenge.id] ?? challengeProgress[String(challenge.id)];
      return {
        id: challenge.id,
        title: challenge.title,
        description: challenge.description,
        timeLimit: challenge.timeLimit,
        objectiveCount: challenge.objectives.length,
        docsLinks: challenge.docsLinks || [],
        completed: Boolean(saved?.completed),
        stars: saved?.stars || 0,
        bestTime: saved?.bestTime || null,
      };
    });
  }

  // ─── challenge lifecycle ──────────────────────────────────────────────────

  startChallenge(challengeId) {
    const def = CHALLENGES.find(
      (challenge) => challenge.id === challengeId || String(challenge.id) === String(challengeId)
    );
    if (!def) return false;

    this.currentChallenge = def.id;
    this.currentChallengeDef = def;
    this.state = CHALLENGE_STATE.PLAYING;
    this.pausedTime = 0;
    this.pauseStart = 0;
    this.elapsedTime = 0;
    this.timeRemaining = def.timeLimit;
    this.usedHints = false;
    this.hadFailures = false;
    this.challengeFilesSeeded = false;

    this.objectiveProgress = createObjectiveProgress(def.objectives);

    try {
      this.setupCluster(def);
    } catch (error) {
      console.warn(`ChallengeMode: setupCluster failed for challenge ${def.id}`, error);
    }

    try {
      this.setupIncidents(def);
    } catch (error) {
      console.warn(`ChallengeMode: setupIncidents failed for challenge ${def.id}`, error);
    }

    this.seedChallengeFiles(def);

    this.state = CHALLENGE_STATE.PLAYING;
    this.startTime = Date.now();

    // Readiness evidence is scoped to this timed-lab run (#20).
    try {
      this.scoringEngine?.beginDrillEvidence?.('challenge', def.id);
    } catch (error) {
      console.warn('ChallengeMode: beginDrillEvidence failed', error);
    }
    try {
      this.incidentEngine?.start?.('challenge');
    } catch (error) {
      console.warn('ChallengeMode: incident engine start failed', error);
    }

    this.startTicking();

    this.emit('challenge:started', {
      challengeId: def.id,
      title: def.title,
      description: def.description,
      timeLimit: def.timeLimit,
      objectives: this.objectiveProgress.slice(),
      availableResources: def.availableResources,
      docsLinks: def.docsLinks || [],
      manifestFiles: def.manifestFiles || [],
      focusFiles: def.focusFiles || [],
    });

    return true;
  }

  /**
   * Seed the simulated OpenShift cluster.
   * ClusterState.clear() re-seeds the default 4.22 baseline, so challenge
   * resources are name-based and added after it. Projects are created first.
   */
  setupCluster(def) {
    const clusterState = this.gameEngine?.cluster;
    if (!clusterState) return;

    if (typeof clusterState.clear === 'function') clusterState.clear();

    // Reset challenge-scoped controller counters.
    clusterState._rollbackCount = 0;
    clusterState._rescheduledCount = 0;
    clusterState._rescheduledPods = 0;

    // Command objectives should only see commands issued during this challenge.
    try {
      if (typeof this.gameEngine.clearCommandHistory === 'function')
        this.gameEngine.clearCommandHistory();
      else if (Array.isArray(this.gameEngine._commandHistory))
        this.gameEngine._commandHistory.length = 0;
    } catch {
      /* non-fatal */
    }

    // Every challenge is an administrative lab: start as kubeadmin/default.
    if (this.gameEngine) {
      this.gameEngine.currentUser = 'kubeadmin';
      try {
        if (typeof clusterState.getProject !== 'function' || clusterState.getProject('default')) {
          this.gameEngine.currentProject = 'default';
        }
      } catch {
        this.gameEngine.currentProject = 'default';
      }
    }

    const resources = Array.isArray(def.startingResources) ? def.startingResources : [];
    const ordered = [
      ...resources.filter((resource) => resource.kind === 'Project'),
      ...resources.filter((resource) => resource.kind !== 'Project'),
    ];

    for (const descriptor of ordered) {
      try {
        this.addStartingResource(clusterState, descriptor);
      } catch (error) {
        console.warn(
          `ChallengeMode: could not seed ${descriptor?.kind}/${descriptor?.name}`,
          error
        );
      }
    }
  }

  addStartingResource(clusterState, descriptor) {
    if (!descriptor || !descriptor.kind) return null;
    const name = descriptor.name;
    const namespace =
      descriptor.namespace ||
      descriptor.metadata?.namespace ||
      (descriptor.kind === 'Project' ? '' : 'default');
    const labels = { app: name, ...(descriptor.labels || {}) };

    const added = clusterState.addResource({
      kind: descriptor.kind,
      name,
      namespace,
      labels,
      annotations: descriptor.annotations || {},
      spec: descriptor.spec || {},
      status: descriptor.status || {},
    });
    if (!added) return null;

    if (descriptor.kind === 'Project') {
      if (typeof clusterState.ensureProjectDefaults === 'function') {
        clusterState.ensureProjectDefaults(added);
      }
      return added;
    }

    if (descriptor.kind === 'Node' && typeof added.setCondition === 'function') {
      try {
        added.setPhase?.('Running');
        added.setCondition('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status');
        clusterState.update(added.uid, added);
      } catch {
        /* ignore */
      }
    }

    if (descriptor.kind === 'Deployment') {
      const spec = added.spec || {};
      spec.replicas = spec.replicas ?? 1;
      spec.selector = spec.selector || { matchLabels: { app: name } };
      spec.template = spec.template || {};
      spec.template.metadata = spec.template.metadata || {};
      spec.template.metadata.labels = { app: name, ...(spec.template.metadata.labels || {}) };
      spec.template.spec = spec.template.spec || {};
      spec.template.spec.containers = spec.template.spec.containers || [
        {
          name: 'main',
          image: DEFAULT_IMAGE,
          ports: [{ name: 'http', containerPort: 8080 }],
        },
      ];
    }

    if (descriptor.kind === 'Service') {
      const spec = added.spec || {};
      if (!spec.selector || Object.keys(spec.selector).length === 0) spec.selector = { app: name };
      if (spec.type === undefined) spec.type = 'ClusterIP';
    }

    if (descriptor.kind === 'Route') {
      const spec = added.spec || {};
      spec.to = spec.to || { kind: 'Service', name: descriptor.service || name, weight: 100 };
      spec.wildcardPolicy = spec.wildcardPolicy || 'None';
    }

    return added;
  }

  setupIncidents(def) {
    const incidentEngine = this.incidentEngine;
    if (!incidentEngine) return;
    if (typeof incidentEngine.reset === 'function') incidentEngine.reset();
    const incidents = Array.isArray(def.preloadIncidents) ? def.preloadIncidents : [];
    if (incidents.length > 0 && typeof incidentEngine.loadScriptedIncidents === 'function') {
      incidentEngine.loadScriptedIncidents(incidents);
    }
  }

  // ─── Files panel seeding (CONVERSION-SPEC §7) ─────────────────────────────

  getManifestEngine() {
    if (this.gameEngine?.manifestEngine) return this.gameEngine.manifestEngine;
    if (typeof window !== 'undefined' && window.game?.manifestEngine)
      return window.game.manifestEngine;
    return null;
  }

  /**
   * Seed challenge-specific files into the ManifestEngine, resetting the
   * virtual FS to the default manifest set first. Safe to call when the
   * ManifestPanel has not been initialised yet (returns false; retried on the
   * next tick).
   */
  seedChallengeFiles(def = this.currentChallengeDef) {
    if (!def) return false;
    const manifestEngine = this.getManifestEngine();
    if (!manifestEngine || typeof manifestEngine.writeFile !== 'function') return false;

    try {
      if (typeof manifestEngine.resetFiles === 'function') manifestEngine.resetFiles();
      const files = CHALLENGE_FILES[def.id] || {};
      for (const [path, content] of Object.entries(files)) {
        manifestEngine.writeFile(path, content);
      }
    } catch (error) {
      console.warn('ChallengeMode: could not seed challenge manifest files', error);
      return false;
    }

    this.challengeFilesSeeded = true;

    // Focus the Files panel on the lab's files (index.html also calls this
    // after launch; duplicate calls are idempotent).
    const files = [
      ...(Array.isArray(def.manifestFiles) ? def.manifestFiles : []),
      ...Object.keys(CHALLENGE_FILES[def.id] || {}),
    ];
    const focusFiles =
      Array.isArray(def.focusFiles) && def.focusFiles.length > 0 ? def.focusFiles : files;
    if (typeof window !== 'undefined' && window.game?.manifestPanel?.setContext) {
      try {
        window.game.manifestPanel.setContext({ manifestFiles: files, focusFiles });
      } catch {
        /* ignore panel wiring errors */
      }
    }
    return true;
  }

  // ─── per-second tick ──────────────────────────────────────────────────────

  startTicking() {
    this.stopTicking();
    this.ticker = setInterval(() => this.update(), 1000);
  }

  stopTicking() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  update() {
    if (this.state !== CHALLENGE_STATE.PLAYING) return;

    this.elapsedTime = (Date.now() - this.startTime - this.pausedTime) / 1000;
    this.timeRemaining = Math.max(0, (this.currentChallengeDef?.timeLimit || 0) - this.elapsedTime);

    if (!this.challengeFilesSeeded) this.seedChallengeFiles();

    this.updateObjectives();
    this.checkCompletion();
    this.checkTimeout();

    this.emit('challenge:update', {
      challengeId: this.currentChallenge,
      elapsedTime: Math.round(this.elapsedTime),
      timeRemaining: Math.round(this.timeRemaining),
      objectives: this.objectiveProgress,
      summary: getObjectiveSummary(this.objectiveProgress),
      completionPercentage: this.getCompletionPercentage(),
      activeIncidents: this.getActiveIncidents().length,
      clusterHealth: this.getClusterHealth(),
    });
  }

  /** Evaluation context passed to ObjectiveEvaluator (CONVERSION-SPEC §13). */
  buildEvaluationContext() {
    return {
      clusterState: this.gameEngine?.cluster || null,
      gameEngine: this.gameEngine || null,
      incidentEngine: this.incidentEngine || null,
      scoringEngine: this.scoringEngine || null,
      manifestEngine: this.getManifestEngine(),
      objectiveProgress: this.objectiveProgress,
      levelDef: this.currentChallengeDef,
    };
  }

  updateObjectives() {
    if (!this.currentChallengeDef || !Array.isArray(this.currentChallengeDef.objectives)) return;
    evaluateObjectives(this.currentChallengeDef.objectives, this.buildEvaluationContext(), {
      progress: this.objectiveProgress,
      // End-state evaluation: un-doing an action while the lab is live must
      // un-tick the objective (no latched completion).
      recheckCompleted: true,
    });
  }

  getCompletionPercentage() {
    return getObjectiveSummary(this.objectiveProgress).percentage;
  }

  checkCompletion() {
    if (this.objectiveProgress.length === 0) return;
    if (this.objectiveProgress.every((objective) => objective.completed)) this.complete();
  }

  checkTimeout() {
    if (this.timeRemaining <= 0) this.timeout();
  }

  complete() {
    if (this.state === CHALLENGE_STATE.COMPLETED || this.state === CHALLENGE_STATE.FAILED)
      return null;
    this.state = CHALLENGE_STATE.COMPLETED;
    this.stopTicking();
    try {
      this.incidentEngine?.stop?.();
    } catch {
      /* ignore */
    }

    const completionTime = this.elapsedTime;
    let result = { stars: 1, xpEarned: 0 };
    try {
      if (typeof this.scoringEngine?.completeChallenge === 'function') {
        this.scoringEngine._lastObjectiveTypes = this.objectiveProgress
          .map((objective) => String(objective?.type || '').toLowerCase())
          .filter(Boolean);
        result = this.scoringEngine.completeChallenge(this.currentChallenge, completionTime, 100, {
          timeLimit: this.currentChallengeDef?.timeLimit,
          usedHints: this.usedHints,
        });
      }
    } catch (error) {
      console.warn('ChallengeMode: completeChallenge failed', error);
    }

    const data = {
      challengeId: this.currentChallenge,
      title: this.currentChallengeDef?.title || `Challenge ${this.currentChallenge}`,
      completionTime: Math.round(completionTime),
      timeLimit: this.currentChallengeDef?.timeLimit || 0,
      stars: result?.stars || 1,
      xpEarned: result?.xpEarned || 0,
      completionPercentage: 100,
      usedHints: this.usedHints,
      // End-state contract for the shell (HANDOFF GAME-014): when
      // `isLastChallenge` is true the "Next Level" button must become
      // "Finish"/"Menu"; otherwise `nextChallenge()` advances the lab.
      completed: true,
      failed: false,
      endState: 'completed',
      isLastChallenge: this.isLastChallenge(),
      totalChallenges: CHALLENGES.length,
      nextChallengeId: this.nextChallengeId(),
    };

    this.emit('challenge:completed', data);
    this.emit('mode:level-complete', {
      ...data,
      message: `Finished in ${Math.round(completionTime)}s / ${data.timeLimit}s. +${data.xpEarned} XP`,
    });

    return result;
  }

  timeout() {
    if (this.state === CHALLENGE_STATE.COMPLETED || this.state === CHALLENGE_STATE.FAILED)
      return null;
    this.state = CHALLENGE_STATE.FAILED;
    this.stopTicking();
    try {
      this.incidentEngine?.stop?.();
    } catch {
      /* ignore */
    }

    const percentage = this.getCompletionPercentage();
    let result = { stars: 0, xpEarned: 0 };
    try {
      if (typeof this.scoringEngine?.completeChallenge === 'function') {
        result = this.scoringEngine.completeChallenge(
          this.currentChallenge,
          this.currentChallengeDef?.timeLimit || 0,
          percentage,
          { timeLimit: this.currentChallengeDef?.timeLimit, usedHints: this.usedHints }
        );
      }
    } catch (error) {
      console.warn('ChallengeMode: completeChallenge (timeout) failed', error);
    }

    const payload = {
      event: 'challenge:timeout',
      mode: 'challenge',
      challengeId: this.currentChallenge,
      title: this.currentChallengeDef?.title || null,
      completionPercentage: percentage,
      xpEarned: result?.xpEarned || 0,
      stars: result?.stars || 0,
      timeLimit: this.currentChallengeDef?.timeLimit || 0,
      completionTime: Math.round(this.elapsedTime),
      usedHints: this.usedHints,
      // Clear failure transition: the shell should show a "timed lab failed"
      // modal with Retry / Menu (HANDOFF GAME-013). State is already FAILED and
      // the ticker/incident engine are stopped.
      completed: false,
      failed: true,
      endState: 'failed',
      reason: 'timeout',
      retryable: true,
      isLastChallenge: this.isLastChallenge(),
      totalChallenges: CHALLENGES.length,
      nextChallengeId: this.nextChallengeId(),
      objectives: this.objectiveProgress.map((objective) => ({
        label: objective.label || objective.type,
        completed: Boolean(objective.completed),
        current: objective.current || 0,
        target: objective.target || 1,
      })),
    };
    this.emit('challenge:timeout', payload);

    return result;
  }

  pause() {
    if (this.state !== CHALLENGE_STATE.PLAYING) return;
    this.state = CHALLENGE_STATE.PAUSED;
    this.pauseStart = Date.now();
    try {
      this.incidentEngine?.pause?.();
    } catch {
      /* ignore */
    }
    this.emit('challenge:paused', { challengeId: this.currentChallenge });
  }

  resume() {
    if (this.state !== CHALLENGE_STATE.PAUSED) return;
    this.state = CHALLENGE_STATE.PLAYING;
    this.pausedTime += Date.now() - this.pauseStart;
    try {
      this.incidentEngine?.resume?.();
    } catch {
      /* ignore */
    }
    this.emit('challenge:resumed', { challengeId: this.currentChallenge });
  }

  retryChallenge() {
    if (!this.currentChallenge) return false;
    return this.startChallenge(this.currentChallenge);
  }

  /** Alias used by index.html's game-over modal. */
  restart() {
    return this.retryChallenge();
  }

  /** Alias used by programmatic launchers. */
  start() {
    if (this.state === CHALLENGE_STATE.PLAYING) return true;
    if (this.currentChallenge && this.currentChallengeDef) return this.retryChallenge();
    return this.startChallenge(1);
  }

  /** Next challenge id in the catalog, or null for the last lab. */
  nextChallengeId() {
    const index = CHALLENGES.findIndex(
      (challenge) =>
        challenge.id === this.currentChallenge ||
        String(challenge.id) === String(this.currentChallenge)
    );
    if (index < 0 || index + 1 >= CHALLENGES.length) return null;
    return CHALLENGES[index + 1].id;
  }

  isLastChallenge() {
    return this.nextChallengeId() === null;
  }

  hasNextChallenge() {
    return this.nextChallengeId() !== null;
  }

  isCompleted() {
    return this.state === CHALLENGE_STATE.COMPLETED;
  }

  isFailed() {
    return this.state === CHALLENGE_STATE.FAILED;
  }

  /** True for both terminal states (completed or timed out). */
  isFinished() {
    return this.isCompleted() || this.isFailed();
  }

  /** Advance to the next timed lab; emits an event instead of dead-ending at the last one. */
  nextChallenge() {
    const nextId = this.nextChallengeId();
    if (nextId === null) {
      this.emit('challenge:all-complete', {
        challengeId: this.currentChallenge,
        totalChallenges: CHALLENGES.length,
        message: 'All timed labs complete.',
      });
      return false;
    }
    return this.startChallenge(nextId);
  }

  useHint(index) {
    const hints = this.currentChallengeDef?.hints || [];
    const hint = hints[index];
    if (hint === undefined) return null;
    this.usedHints = true;
    this.emit('challenge:hint-used', {
      challengeId: this.currentChallenge,
      hintIndex: index,
      hint,
    });
    return hint;
  }

  // ─── status helpers consumed by index.html/HUD ────────────────────────────

  getClusterHealth() {
    try {
      if (typeof this.incidentEngine?.getClusterHealth === 'function') {
        return this.incidentEngine.getClusterHealth();
      }
    } catch {
      /* ignore */
    }
    return 100;
  }

  getActiveIncidents() {
    try {
      if (typeof this.incidentEngine?.getActiveIncidents === 'function') {
        return this.incidentEngine.getActiveIncidents() || [];
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  getStatus() {
    return {
      state: this.state,
      finished: this.isFinished(),
      completed: this.isCompleted(),
      failed: this.isFailed(),
      isLastChallenge: this.isLastChallenge(),
      hasNextChallenge: this.hasNextChallenge(),
      challengeId: this.currentChallenge,
      title: this.currentChallengeDef?.title || null,
      description: this.currentChallengeDef?.description || '',
      elapsedTime: Math.round(this.elapsedTime),
      timeRemaining: Math.round(this.timeRemaining),
      timeLimit: this.currentChallengeDef?.timeLimit || 0,
      objectives: this.objectiveProgress,
      completionPercentage: this.getCompletionPercentage(),
      activeIncidents: this.getActiveIncidents().length,
      clusterHealth: this.getClusterHealth(),
      hints: this.currentChallengeDef?.hints || [],
      availableResources: this.currentChallengeDef?.availableResources || [],
      docsLinks: this.currentChallengeDef?.docsLinks || [],
      manifestFiles: this.currentChallengeDef?.manifestFiles || [],
      focusFiles: this.currentChallengeDef?.focusFiles || [],
      usedHints: this.usedHints,
    };
  }

  emit(event, payload) {
    try {
      this.gameEngine?.emit?.(event, payload);
    } catch (error) {
      console.warn(`ChallengeMode: failed to emit ${event}`, error);
    }
  }

  exitToMenu() {
    this.stopTicking();
    try {
      this.incidentEngine?.stop?.();
    } catch {
      /* ignore */
    }
    this.state = CHALLENGE_STATE.MENU;
    this.currentChallenge = null;
    this.currentChallengeDef = null;
    this.objectiveProgress = [];
    this.emit('challenge:exit-to-menu', {});
  }

  /** index.html lifecycle compatibility. */
  exit() {
    this.exitToMenu();
  }

  cleanup() {
    this.exitToMenu();
  }

  destroy() {
    this.stopTicking();
    this.gameEngine = null;
    this.incidentEngine = null;
    this.scoringEngine = null;
    this.currentChallengeDef = null;
    this.objectiveProgress = [];
  }
}

export { ChallengeMode, CHALLENGE_STATE, CHALLENGES };
