/**
 * ChallengeMode — 12 timed OpenShift 4.22 / EX280 labs (CONVERSION-SPEC §10).
 *
 * Keeps the original challenge runner/state machine and public API
 * (`CHALLENGES`, `startChallenge`, `getStatus`, `restart`, `exit`, ...) but:
 *  - scenarios are the exact 12 from CONVERSION-SPEC §10,
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

/** Two-to-three Ready worker Nodes for a lab cluster. */
function nodes(count = 2, cpu = '16', memory = '32Gi') {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'Node',
    name: `node-${index + 1}`,
    labels: { role: 'worker', 'node-role.kubernetes.io/worker': '' },
    spec: { cpu, memory, pods: 250 },
    status: { phase: 'Running' },
  }));
}

function project(name, displayName = name) {
  return {
    kind: 'Project',
    name,
    spec: { displayName, description: `${displayName} OpenShift project` },
    status: { phase: 'Active' },
  };
}

function deployment(name, {
  namespace = 'default',
  replicas = 2,
  image = DEFAULT_IMAGE,
  app = name,
  labels = {},
  containerPort = 8080,
  securityContext = null,
  serviceAccountName = null,
} = {}) {
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

function service(name, {
  namespace = 'default',
  app = name,
  selector = null,
  port = 8080,
  targetPort = 8080,
  type = 'ClusterIP',
} = {}) {
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

function route(name, {
  namespace = 'default',
  serviceName = name,
  host = '',
  path = '/',
  termination = 'edge',
  insecureEdgeTerminationPolicy = 'Redirect',
} = {}) {
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
};

// ─── the 12 challenges (CONVERSION-SPEC §10) ───────────────────────────────

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
      { type: 'deploy', kind: 'Deployment', name: 'frontend', namespace: 'frontend', label: 'Deploy frontend in project frontend' },
      { type: 'deploy', kind: 'Deployment', name: 'backend', namespace: 'backend', label: 'Deploy backend in project backend' },
      { type: 'deploy', kind: 'Deployment', name: 'database', namespace: 'backend', label: 'Deploy database tier in project backend' },
      { type: 'deploy', kind: 'Service', name: 'frontend', namespace: 'frontend', label: 'Create Service frontend' },
      { type: 'deploy', kind: 'Service', name: 'backend', namespace: 'backend', label: 'Create Service backend' },
      { type: 'deploy', kind: 'Service', name: 'database', namespace: 'backend', label: 'Create Service database' },
      { type: 'route', name: 'frontend', service: 'frontend', label: 'Expose the frontend with an admitted Route' },
    ],
    startingResources: nodes(3),
    availableResources: ['Project', 'Deployment', 'Service', 'Route', 'ConfigMap', 'Secret'],
    hints: [
      'Create both projects first: oc new-project frontend && oc new-project backend',
      'Deploy each tier with oc new-app --image=quay.io/openshift/origin-hello-openshift:latest --name=<tier> -n <project> (frontend in frontend; backend and database in backend).',
      'oc new-app creates both a Deployment and a Service. Verify with oc get deploy,svc -n frontend and -n backend',
      'Expose the frontend Service: oc expose svc/frontend -n frontend (or oc create route edge...)',
      'A Route is only Admitted when its Service has ready endpoints: oc get route frontend -n frontend -o wide',
    ],
  },
  {
    id: 2,
    title: 'Fix CrashLoopBackOff',
    description:
      'The payment-service Deployment is crash looping: image `quay.io/example/payments:v2-bad-config` pulls fine but the app exits with status 1 on an invalid configuration. Read the crash output with oc logs/describe on the real Pods, fix the workload (image/command/env — restarting does not help), and restore health to at least 90%.',
    timeLimit: 240,
    docsLinks: [DOCS.health, DOCS.cli],
    objectives: [
      { type: 'investigate', incidentType: 'CrashLoopBackOff', progress: 0.5, label: 'Investigate the CrashLoopBackOff incident' },
      { type: 'resolve', incidentType: 'CrashLoopBackOff', count: 1, label: 'Resolve CrashLoopBackOff' },
      { type: 'uptime', percentage: 90, label: 'Restore cluster health to at least 90%' },
      {
        type: 'command',
        pattern: 'oc\\s+(logs|describe)\\s+.*payment-service',
        count: 1,
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
      'Read the crash output: oc logs deployment/payment-service --previous — the app exits with status 1 because :v2-bad-config ships an invalid configuration. The image pulls fine, so this is a CrashLoopBackOff, not ImagePullBackOff.',
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
      { type: 'deploy', kind: 'Secret', name: 'app-tls', namespace: 'web', label: 'Create TLS Secret app-tls' },
      { type: 'route', name: 'app', service: 'app-svc', termination: 'edge', label: 'Create an admitted edge Route' },
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
      'Create the TLS material Secret (the simulator supplies a self-signed pair if the files are absent):',
      'oc create secret tls app-tls --cert=tls.crt --key=tls.key -n web',
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
      { type: 'kustomize', path: 'kustomize/overlays/prod', label: 'Apply kustomize/overlays/prod' },
      { type: 'scale', kind: 'Deployment', name: 'prod-webapp', replicas: 3, label: 'prod-webapp runs 3 replicas' },
      { type: 'image', kind: 'Deployment', name: 'prod-webapp', imageContains: 'origin-hello-openshift', label: 'prod-webapp uses the prod image' },
      {
        type: 'command',
        pattern: 'apply\\s+-k\\s+kustomize/overlays/prod',
        count: 1,
        label: 'Apply the overlay with oc apply -k',
      },
    ],
    startingResources: [...nodes(2), project('webapp-prod', 'Webapp production')],
    manifestFiles: ['kustomize/base/kustomization.yaml', 'kustomize/overlays/prod/kustomization.yaml', 'kustomize/overlays/prod/patch-deployment.yaml'],
    focusFiles: ['kustomize/overlays/prod/kustomization.yaml', 'kustomize/overlays/prod/patch-deployment.yaml'],
    availableResources: ['Project', 'Deployment', 'Service'],
    hints: [
      'Review kustomize/overlays/prod/kustomization.yaml in the Files panel: namespace, namePrefix, images, replicas and patchesStrategicMerge.',
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
      { type: 'imageStream', name: 'webapp', tag: 'latest', label: 'ImageStream webapp:latest exists' },
      { type: 'deploy', kind: 'Deployment', name: 'webapp', label: 'Deployment webapp exists' },
      { type: 'route', name: 'webapp', service: 'webapp', label: 'Route webapp is admitted' },
    ],
    startingResources: nodes(2),
    manifestFiles: ['examples/buildconfig.yaml'],
    focusFiles: ['examples/buildconfig.yaml'],
    availableResources: ['BuildConfig', 'Build', 'ImageStream', 'Deployment', 'Service', 'Route', 'Project'],
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
      { type: 'deploy', kind: 'Deployment', name: 'api', namespace: 'quota-lab', label: 'Deploy api in quota-lab' },
      { type: 'resources', kind: 'Deployment', name: 'api', label: 'api containers have requests and limits' },
      { type: 'resolve', incidentType: 'ResourceQuotaExceeded', count: 1, label: 'Resolve ResourceQuotaExceeded' },
      {
        type: 'command',
        pattern: '(create\\s+(quota|limitrange))|(apply.*(quota|limitrange))',
        count: 1,
        label: 'Create the guardrails with oc create or oc apply',
      },
    ],
    startingResources: [...nodes(2), project('quota-lab', 'Quota lab')],
    preloadIncidents: [
      { type: 'ResourceQuotaExceeded', target: 'team-quota', namespace: 'quota-lab', severity: 3, triggerTime: 30 },
    ],
    manifestFiles: ['examples/quota.yaml', 'examples/limitrange.yaml'],
    focusFiles: ['examples/quota.yaml', 'examples/limitrange.yaml'],
    availableResources: ['Project', 'ResourceQuota', 'LimitRange', 'ClusterResourceQuota', 'Deployment', 'Service', 'Route'],
    hints: [
      'Switch to the project: oc project quota-lab',
      'Create the project quota: oc create quota team-quota --hard=pods=10,requests.cpu=4,requests.memory=8Gi',
      'Create the LimitRange: oc create limitrange team-limits --default=cpu=500m,memory=512Mi --default-request=cpu=100m,memory=128Mi --max=cpu=2,memory=4Gi',
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
      { type: 'group', name: 'developers', users: ['developer'], label: 'Group developers contains developer' },
      { type: 'deploy', kind: 'RoleBinding', name: 'edit-developers', namespace: 'team-dev', label: 'RoleBinding grants edit in team-dev' },
      { type: 'canI', verb: 'delete', resource: 'pods', user: 'developer', namespace: 'team-dev', expected: true, label: 'developer can delete Pods in team-dev' },
      { type: 'leastPrivilege', label: 'No wildcard or non-admin cluster-admin grants' },
      {
        type: 'command',
        pattern: 'add-role-to-(user|group)|auth\\s+can-i',
        count: 1,
        label: 'Use oc adm policy / oc auth can-i',
      },
    ],
    startingResources: [...nodes(2), project('team-dev', 'Team development')],
    availableResources: ['Project', 'User', 'Group', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding'],
    hints: [
      'Create the user and group: oc create user developer; oc adm groups new developers developer',
      'Bind the built-in edit ClusterRole at project scope: oc adm policy add-role-to-group edit developers -n team-dev',
      'Prove it: oc auth can-i delete pods --as=developer -n team-dev',
      'Inspect the binding: oc get rolebinding edit-developers -n team-dev -o yaml',
      'Avoid cluster-admin and wildcard rules; edit is enough for a developer in one project.',
    ],
  },
  {
    id: 8,
    title: 'SCC for a Privileged Workload',
    description:
      'Admit a workload that requests elevated security with a SecurityContextConstraint: apply the privileged app manifest, create a dedicated ServiceAccount, grant the privileged SCC to that ServiceAccount with a 4.x RBAC binding, and resolve the SCCForbidden incident. anyuid allows an arbitrary UID but NOT privileged containers — privileged: true needs the privileged SCC. Never grant privileged to the project default SA.',
    timeLimit: 300,
    docsLinks: [DOCS.scc, DOCS.rbac],
    objectives: [
      { type: 'deploy', kind: 'Deployment', name: 'privileged-app', namespace: 'secure', label: 'Create privileged-app in project secure' },
      { type: 'deploy', kind: 'ServiceAccount', name: 'priv-sa', namespace: 'secure', label: 'Create the dedicated ServiceAccount priv-sa' },
      { type: 'scc', scc: 'privileged', subject: 'system:serviceaccount:secure:priv-sa', label: 'Grant the privileged SCC to the dedicated ServiceAccount priv-sa' },
      { type: 'privileged', count: 1, label: 'Get a privileged: true Pod admitted and Running' },
      { type: 'resolve', incidentType: 'SCCForbidden', count: 1, label: 'Resolve SCCForbidden' },
      {
        type: 'command',
        pattern: 'add-scc-to-(user|group)',
        count: 1,
        label: 'Grant the SCC with oc adm policy',
      },
    ],
    startingResources: [...nodes(2), project('secure', 'Secure workloads')],
    preloadIncidents: [
      { type: 'SCCForbidden', target: 'privileged-app', namespace: 'secure', severity: 4, triggerTime: 40 },
    ],
    manifestFiles: ['challenges/privileged-app.yaml'],
    focusFiles: ['challenges/privileged-app.yaml'],
    availableResources: ['Project', 'Deployment', 'ServiceAccount', 'SecurityContextConstraints', 'Role', 'RoleBinding'],
    hints: [
      'Apply the workload: oc apply -f challenges/privileged-app.yaml — it runs as the dedicated ServiceAccount priv-sa and requests privileged: true.',
      'The rejected Pod is never created on 4.x: oc get pods -n secure stays empty and oc describe deployment/privileged-app -n secure shows FailedCreate / "unable to validate against any security context constraint".',
      'Create the dedicated identity: oc create sa priv-sa -n secure (or keep the one from the manifest) — do NOT grant elevated SCCs to the default ServiceAccount.',
      'Grant the SCC the 4.x way: oc adm policy add-scc-to-user privileged -z priv-sa -n secure (creates a RoleBinding to ClusterRole system:openshift:scc:privileged; the SCC users list stays unchanged).',
      'Verify with RBAC, not the SCC users list: oc auth can-i use scc/privileged --as=system:serviceaccount:secure:priv-sa; oc get rolebinding -n secure; then oc get pods -n secure shows the admitted Pod Running.',
      'The SCCForbidden incident clears as soon as the binding exists; the incident panel resolution action is only for exploring the fault.',
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
      { type: 'deploy', kind: 'NetworkPolicy', name: 'deny-by-default', namespace: 'shop', label: 'Create default-deny NetworkPolicy' },
      { type: 'deploy', kind: 'NetworkPolicy', name: 'allow-dns-egress', namespace: 'shop', label: 'Allow DNS egress on port 5353 (dns-default Pod port)' },
      { type: 'deploy', kind: 'NetworkPolicy', name: 'allow-frontend-to-backend', namespace: 'shop', label: 'Allow frontend ingress to backend' },
      { type: 'deploy', kind: 'NetworkPolicy', name: 'allow-frontend-egress', namespace: 'shop', label: 'Allow frontend egress to backend' },
      { type: 'resolve', incidentType: 'DNSResolutionFailure', count: 1, label: 'Resolve DNSResolutionFailure' },
      {
        type: 'command',
        pattern: '(networkpolicy|netpol)',
        count: 1,
        label: 'Apply or edit a NetworkPolicy',
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
      { type: 'DNSResolutionFailure', target: 'backend', namespace: 'shop', severity: 4, triggerTime: 45 },
    ],
    manifestFiles: ['challenges/shop-networkpolicy.yaml'],
    focusFiles: ['challenges/shop-networkpolicy.yaml'],
    availableResources: ['Project', 'NetworkPolicy', 'Deployment', 'Service', 'Route'],
    hints: [
      'Apply the policy set from the Files panel: oc apply -f challenges/shop-networkpolicy.yaml',
      'A NetworkPolicy is additive: the default-deny selects every Pod, then explicit allow rules re-open only the paths you name.',
      'DNS is required: on OpenShift the dns-default Pods listen on 5353, so the egress rule must allow UDP and TCP 5353 to the openshift-dns namespace — port 53 does NOT unblock name resolution.',
      'Verify: oc get networkpolicy -n shop; oc describe networkpolicy deny-by-default -n shop; then test from a Pod with oc exec deploy/frontend -- curl -sv http://backend:8080',
      'Resolve DNSResolutionFailure from the incident panel (allow-DNS-egress) after applying the rule — or just apply the corrected allow-dns-egress policy and the incident clears.',
    ],
  },
  {
    id: 10,
    title: 'Install an Operator',
    description:
      'Install the MetalLB Operator with OLM, create the IPAddressPool and L2Advertisement, expose a LoadBalancer Service with an external IP, and uninstall an unwanted operator Subscription.',
    timeLimit: 360,
    docsLinks: [DOCS.operators, DOCS.metallb],
    objectives: [
      { type: 'operator', name: 'metallb-operator', installed: true, label: 'MetalLB operator CSV (metallb-operator.v0.14.9) reaches Succeeded' },
      { type: 'deploy', kind: 'IPAddressPool', name: 'metallb-pool', namespace: 'metallb-system', label: 'Create IPAddressPool metallb-pool' },
      { type: 'deploy', kind: 'L2Advertisement', name: 'metallb-l2', namespace: 'metallb-system', label: 'Create L2Advertisement metallb-l2' },
      { type: 'serviceType', kind: 'LoadBalancer', count: 1, label: 'Create a LoadBalancer Service' },
      { type: 'operator', name: 'ansible-automation-platform', installed: false, label: 'Uninstall the old AAP operator Subscription' },
      {
        type: 'command',
        pattern: '(metallb-operator|loadbalancer|delete\\s+subscription)',
        count: 1,
        label: 'Use oc apply/oc get for the operator or Service',
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
          channel: 'stable',
          source: 'redhat-operators',
          sourceNamespace: 'openshift-marketplace',
          installPlanApproval: 'Automatic',
        },
        status: { phase: 'Succeeded', installedCSV: 'ansible-automation-platform-operator.v1.0.0' },
      },
    ],
    manifestFiles: ['examples/subscription.yaml', 'challenges/metallb-operator.yaml'],
    focusFiles: ['challenges/metallb-operator.yaml'],
    availableResources: ['Project', 'Subscription', 'IPAddressPool', 'L2Advertisement', 'Service', 'Deployment'],
    hints: [
      'Apply the whole OLM manifest set (OperatorGroup + Subscription for package metallb-operator + MetalLB CR + IPAddressPool + L2Advertisement, all in metallb-system): oc apply -f challenges/metallb-operator.yaml',
      'Watch OLM: oc get sub,csv,installplan -n metallb-system — an InstallPlan appears, then the CSV metallb-operator.v0.14.9 reaches Succeeded; oc get subscription -n metallb-system -o yaml shows status.installedCSV (redhat-operators package name is metallb-operator).',
      'Create a LoadBalancer Service in the store project: oc create service loadbalancer web-lb --tcp=80:8080 -n store',
      'Check the EXTERNAL-IP column: oc get svc web-lb -n store (MetalLB assigns it from metallb-pool/L2Advertisement).',
      'Uninstall the old AAP operator properly: oc delete subscription ansible-automation-platform-operator -n openshift-operators, then delete its CSV — read the name from oc get csv -n openshift-operators (aap-operator.v2.6.0) and run oc delete csv aap-operator.v2.6.0 -n openshift-operators — deleting the Subscription alone leaves the operator installed.',
      'Confirm: oc get csv,sub -n openshift-operators is empty (CSV gone = uninstalled).',
    ],
  },
  {
    id: 11,
    title: 'HTPasswd Onboarding',
    description:
      'Configure HTPasswd authentication end-to-end: create an htpasswd entry, store it in openshift-config, apply the OAuth identity provider, log in as the new user, add group membership and grant project permissions.',
    timeLimit: 360,
    docsLinks: [DOCS.idp, DOCS.auth, DOCS.rbac],
    objectives: [
      { type: 'command', pattern: 'htpasswd', count: 1, label: 'Create an htpasswd entry' },
      { type: 'deploy', kind: 'Secret', name: 'htpass-secret', namespace: 'openshift-config', label: 'Create htpass-secret in openshift-config' },
      { type: 'command', pattern: '(apply|replace|edit).*oauth|oauth.*(apply|replace)', count: 1, label: 'Apply the OAuth identity provider' },
      { type: 'user', name: 'alice', label: 'User alice exists' },
      { type: 'login', user: 'alice', label: 'Log in as alice' },
      { type: 'group', name: 'developers', users: ['alice'], label: 'Group developers contains alice' },
      { type: 'deploy', kind: 'RoleBinding', namespace: 'onboarding', count: 1, label: 'Grant project access in onboarding' },
      { type: 'canI', verb: 'get', resource: 'pods', user: 'alice', namespace: 'onboarding', expected: true, label: 'alice can get Pods in onboarding' },
    ],
    startingResources: [...nodes(2), project('onboarding', 'Onboarding')],
    manifestFiles: ['htpasswd', 'challenges/oauth-htpasswd.yaml'],
    focusFiles: ['htpasswd', 'challenges/oauth-htpasswd.yaml'],
    availableResources: ['Project', 'User', 'Group', 'Identity', 'OAuth', 'Secret', 'RoleBinding', 'ServiceAccount'],
    hints: [
      'Create the htpasswd entry (the simulator has a virtual htpasswd file): htpasswd -c -b htpasswd alice openshift',
      'Store it in openshift-config with the mandatory htpasswd key: oc create secret generic htpass-secret --from-file=htpasswd=htpasswd -n openshift-config',
      'Apply the OAuth provider from the Files panel: oc apply -f challenges/oauth-htpasswd.yaml',
      'Wait for the OAuth rollout, then log in: oc login -u alice -p openshift; oc whoami',
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
      { type: 'manifest', file: 'manifests/deployment.yaml', label: 'Apply manifests/deployment.yaml' },
      { type: 'deploy', kind: 'Deployment', name: 'webapp', namespace: 'prod', label: 'Deployment webapp is running in prod' },
      { type: 'build', name: 'builder', label: 'Build builder completes' },
      { type: 'imageStream', name: 'builder', tag: 'latest', label: 'ImageStream builder:latest exists' },
      { type: 'route', name: 'webapp', service: 'webapp', termination: 'edge', label: 'Edge-TLS Route webapp is admitted' },
      { type: 'quota', name: 'prod-quota', namespace: 'prod', label: 'Create ResourceQuota prod-quota' },
      { type: 'complete', kind: 'Job', name: 'db-migrate', label: 'Job db-migrate completes' },
      { type: 'user', name: 'developer', label: 'Create User developer' },
      { type: 'canI', verb: 'get', resource: 'pods', user: 'developer', namespace: 'prod', expected: true, label: 'developer can get Pods in prod' },
      {
        type: 'command',
        pattern: 'apply\\s+-f|new-build|start-build',
        count: 1,
        label: 'Use declarative apply and/or a build',
      },
    ],
    startingResources: nodes(3),
    manifestFiles: ['manifests/deployment.yaml', 'manifests/service.yaml', 'manifests/route.yaml'],
    focusFiles: ['manifests/deployment.yaml', 'manifests/service.yaml', 'manifests/route.yaml'],
    availableResources: ['Project', 'Deployment', 'Service', 'Route', 'BuildConfig', 'ImageStream', 'ResourceQuota', 'Job', 'User', 'RoleBinding'],
    hints: [
      'Create and switch to the project: oc new-project prod',
      'Apply the app manifests in order: oc apply -f manifests/deployment.yaml; oc apply -f manifests/service.yaml; oc apply -f manifests/route.yaml',
      'Create and start a build: oc new-build nodejs:20 --name=builder; oc start-build builder',
      'Create the quota: oc create quota prod-quota --hard=pods=20,requests.cpu=4,requests.memory=8Gi',
      'Run the Job: oc create job db-migrate --image=busybox:latest; oc get job db-migrate -w',
      'Grant RBAC: oc create user developer; oc adm policy add-role-to-user edit developer -n prod',
      'Verify the Route is admitted and the Job completes before the timer runs out.',
    ],
  },
];

const REGISTRY_KINDS = new Set(RESOURCE_KINDS);

// Keep `availableResources` honest: every advertised kind must exist in the
// central registry (single source of truth). Unknown entries are dropped
// rather than silently teaching a non-existent resource.
for (const challenge of CHALLENGES) {
  if (Array.isArray(challenge.availableResources)) {
    challenge.availableResources = challenge.availableResources.filter((kind) => REGISTRY_KINDS.has(kind));
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
      if (typeof this.gameEngine.clearCommandHistory === 'function') this.gameEngine.clearCommandHistory();
      else if (Array.isArray(this.gameEngine._commandHistory)) this.gameEngine._commandHistory.length = 0;
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
        console.warn(`ChallengeMode: could not seed ${descriptor?.kind}/${descriptor?.name}`, error);
      }
    }
  }

  addStartingResource(clusterState, descriptor) {
    if (!descriptor || !descriptor.kind) return null;
    const name = descriptor.name;
    const namespace = descriptor.namespace
      || descriptor.metadata?.namespace
      || (descriptor.kind === 'Project' ? '' : 'default');
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
      spec.template.spec.containers = spec.template.spec.containers || [{
        name: 'main',
        image: DEFAULT_IMAGE,
        ports: [{ name: 'http', containerPort: 8080 }],
      }];
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
    if (typeof window !== 'undefined' && window.game?.manifestEngine) return window.game.manifestEngine;
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
    const focusFiles = Array.isArray(def.focusFiles) && def.focusFiles.length > 0
      ? def.focusFiles
      : files;
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
    if (this.state === CHALLENGE_STATE.COMPLETED || this.state === CHALLENGE_STATE.FAILED) return null;
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
        result = this.scoringEngine.completeChallenge(
          this.currentChallenge,
          completionTime,
          100,
          { timeLimit: this.currentChallengeDef?.timeLimit, usedHints: this.usedHints }
        );
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
    if (this.state === CHALLENGE_STATE.COMPLETED || this.state === CHALLENGE_STATE.FAILED) return null;
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
      (challenge) => challenge.id === this.currentChallenge || String(challenge.id) === String(this.currentChallenge)
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
