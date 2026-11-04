/**
 * EX280 Prep mode data — official exam objectives, quick labs, cheat sheet and facts.
 *
 * Authored from (and cross-checked against) the research docs:
 *   docs/research/ex280-objectives.md
 *   docs/research/ex280-study-guide.md
 *   docs/research/exam-facts.json
 *
 * Source of truth: Red Hat EX280V422 exam objectives (redhat.com exam page) and
 * OpenShift Container Platform 4.22 documentation (docs.redhat.com).
 * Last verified: 2026-11-03.
 *
 * Contract (docs/CONVERSION-SPEC.md §11):
 *   EX280_OBJECTIVE_GROUPS = [{ id, title, bullets: [{ id, title, docsUrl, levels, challenges, commands, summary }] }]
 *   EX280_QUICK_LABS = [{ id, title, objectiveId, setup, check, hints, docsUrl }]
 *
 * This file is pure data (no DOM, no imports) so it can be imported from the game
 * boot path and from Node syntax checks without side effects.
 */

export const EX280_READINESS_THRESHOLD = 0.9;

export const EX280_EXAM_FACTS = {
  examCode: 'EX280V422',
  examPageTitle: 'Red Hat Certified System Administrator in OpenShift exam (EX280)',
  lmsName: 'Red Hat Certified Specialist in OpenShift Administration',
  namingNote:
    'Red Hat titles the exam "Red Hat Certified System Administrator in OpenShift exam (EX280)" on redhat.com, while the LMS Exam Objectives by Version PDF lists it as "Red Hat Certified Specialist in OpenShift Administration". Both refer to EX280V422.',
  ocpVersion: '4.22',
  durationHours: 3,
  groupCount: 9,
  bulletCount: 55,
  delivery:
    'Hands-on, performance-based exam on a live OpenShift Container Platform 4.22 cluster. Product documentation is available during the exam; outside assistance is not allowed.',
  persistenceRule:
    'Configurations and services must persist and remain functional across the normal platform lifecycle (and a reboot) without manual intervention.',
  resultsNote:
    'Results are emailed by Red Hat Certification Central as a total score only; no per-task feedback is provided.',
  scoringNote:
    'Red Hat does not publish the passing score, score scale or certification validity period on the exam page. Verify the Red Hat Certification Program Guide before quoting them.',
  recommendedPrep: [
    'Red Hat System Administration I (RH124) or comparable experience; RHCSA strongly recommended but not required.',
    'Red Hat OpenShift Administration I: Containers & Kubernetes (DO180) or comparable experience.',
    'Red Hat OpenShift Administration II: Operating a Production Kubernetes Cluster (DO280) or comparable experience.',
    'Experience with container technology is recommended.',
  ],
  officialExamUrl:
    'https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam',
  objectivesPdfUrl:
    'https://training-lms.redhat.com/public_content/redhat/training/Red%20Hat%20Certification%20Exam%20Objectives%20by%20Version.pdf',
  programGuideUrl:
    'https://docs.redhat.com/en/documentation/red_hat_learning_subscription/1-latest/html/red_hat_certification_program_guide/index',
  docsBaseUrl: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22',
  lastVerified: '2026-11-03',
};

/** Fixed campaign level titles (mirrors docs/CONVERSION-SPEC.md §9 — the game is the source of truth). */
export const EX280_LEVEL_TITLES = {
  1: 'Your First Project',
  2: 'Query, Format, Filter',
  3: 'Logs, Events & Health',
  4: 'Declarative Manifests',
  5: 'Kustomize Base',
  6: 'Kustomize Overlays',
  7: 'Secrets & ConfigMaps',
  8: 'Templates & Helm',
  9: 'Images, Builds & Image Streams',
  10: 'Rolling Updates & Rollbacks',
  11: 'Services & Routes',
  12: 'Non-HTTP & Load Balancer',
  13: 'HTPasswd & Users',
  14: 'Groups & RBAC',
  15: 'Quotas, LimitRanges & Templates',
  16: 'Service Accounts & API Access',
  17: 'SCC & Privileged Apps',
  18: 'Operators',
  19: 'Jobs & CronJobs',
  20: 'EX280 Final: Production Platform',
};

/** Fixed challenge titles (mirrors docs/CONVERSION-SPEC.md §10 — the game is the source of truth). */
export const EX280_CHALLENGE_TITLES = {
  1: 'Three-Tier App',
  2: 'Fix CrashLoopBackOff',
  3: 'Route with Edge TLS',
  4: 'Kustomize Prod Overlay',
  5: 'Build & Deploy from Source',
  6: 'Quota Guardrail',
  7: 'RBAC for a New Teammate',
  8: 'SCC for a Privileged Workload',
  9: 'Network Isolation',
  10: 'Install an Operator',
  11: 'HTPasswd Onboarding',
  12: 'EX280 Speed Run',
};

/* ────────────────────────────────────────────────────────────────────────────
 * Docs base URLs used per bullet (all verified HTTP 200 on 2026-11-03)
 * ──────────────────────────────────────────────────────────────────────────── */
const DOCS = {
  cliTools:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index',
  webConsole:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/web_console/index',
  nodes:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index',
  monitoring:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/monitoring/index',
  buildingApps:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index',
  images:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/index',
  imageStreams:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/managing-image-streams',
  ingressLb:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/index',
  routes:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes',
  networkSecurity:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/index',
  networkPolicy:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/network-policy',
  auth: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index',
  rbac: 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/using-rbac',
  serviceAccounts:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-creating-service-accounts',
  operators:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/index',
  quotas:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/scalability_and_performance/compute-resource-quotas',
  cliRef:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/openshift-cli-oc',
  projects:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/projects',
  htpasswdIdp:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/configuring-identity-providers',
  sccDocs:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/managing-pod-security-policies',
  jobsDocs:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/using-jobs-and-daemon-sets',
  metallbDocs:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/load-balancing-with-metallb',
  operatorUserTasks:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/user-tasks',
  operatorAdminTasks:
    'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/administrator-tasks',
};

/* ────────────────────────────────────────────────────────────────────────────
 * Official EX280V422 objectives — 9 groups, 55 bullets (verbatim wording).
 * ──────────────────────────────────────────────────────────────────────────── */
export const EX280_OBJECTIVE_GROUPS = [
  {
    id: 'manage-ocp',
    title: 'Manage OpenShift Container Platform',
    docsUrl: DOCS.cliTools,
    bullets: [
      {
        id: 'manage-web-console',
        title: 'Use the web console to manage and configure an OpenShift cluster',
        summary:
          'Navigate the Administrator and Developer perspectives: create projects, deploy from an image or Git, inspect workloads, manage users/operators and check cluster health. The simulator has no web-console UI — use the docs link for the console walkthrough and drill the equivalent oc commands here.',
        docsUrl: DOCS.webConsole,
        levels: [1, 3, 20],
        challenges: [12],
        commands: [
          `oc whoami`,
          `oc get routes -n openshift-console`,
          `oc get projects`,
          `oc get pods -n openshift-console`,
        ],
      },
      {
        id: 'manage-cli',
        title: 'Use the command-line interface to manage and configure an OpenShift cluster',
        summary:
          'Log in, select the working project, inspect context/status and run oc commands against the cluster.',
        docsUrl: DOCS.cliRef,
        levels: [1, 2, 4],
        challenges: [12],
        commands: [
          `oc login -u <user>`,
          `oc whoami`,
          `oc status`,
          `oc project <project>`,
          `oc config view`,
          `oc api-resources`,
        ],
      },
      {
        id: 'manage-create-delete-projects',
        title: 'Create and delete projects',
        summary:
          'Create projects with display name/description, switch between them and delete them. Projects are OpenShift API objects that wrap namespaces.',
        docsUrl: DOCS.projects,
        levels: [1, 15],
        challenges: [1, 12],
        quickLabs: ['lab-projects'],
        commands: [
          `oc new-project web --display-name="Web Team" --description="Web workloads"`,
          `oc projects`,
          `oc project web`,
          `oc get projects`,
          `oc delete project web`,
        ],
      },
      {
        id: 'manage-locate-images',
        title: 'Locate and examine container images',
        summary:
          'Find images and image streams, read pull specs and inspect tags, digests and image metadata.',
        docsUrl: DOCS.imageStreams,
        levels: [9],
        challenges: [5],
        commands: [
          `oc get imagestreams -n openshift`,
          `oc describe is/<name>`,
          `oc describe istag/<image-stream>:<tag>`,
          `oc get istag`,
        ],
      },
      {
        id: 'manage-images-tags-digests',
        title: 'Identify images using tags and digests',
        summary:
          'Explain mutable tags vs immutable digests, tag image streams, import images and read the image ID / sha256 digest from an ImageStreamTag.',
        docsUrl: DOCS.imageStreams,
        levels: [9],
        challenges: [5],
        commands: [
          `oc tag openshift/ruby:2.0 ruby:static-2.0`,
          `oc tag --alias=true openshift/ruby:2.0 ruby:latest`,
          `oc import-image <imagestreamtag> --from=<image> --confirm`,
          `oc describe istag/<image-stream>:<tag>`,
          `oc get istag <image-stream>:<tag> -o jsonpath='{.image.dockerImageMetadata.Id}'`,
        ],
      },
      {
        id: 'manage-query-format-filter',
        title: 'Query, format, and filter attributes of Kubernetes resources',
        summary:
          'Use output formats (wide, yaml, json, jsonpath, custom-columns), label selectors, field selectors and sorting to query resources precisely.',
        docsUrl: DOCS.cliRef,
        levels: [2],
        challenges: [12],
        commands: [
          `oc get pods -o wide`,
          `oc get deployment web -o yaml`,
          `oc get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\\n"}{end}'`,
          `oc get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName`,
          `oc get pods -l app=web --show-labels`,
          `oc get pods --field-selector spec.nodeName=<node>`,
          `oc explain pods.spec.containers`,
        ],
      },
      {
        id: 'manage-import-export-manifests',
        title: 'Import, export, and configure Kubernetes resources',
        summary:
          'Create/apply/replace resources from YAML, export a live object to a manifest and edit configuration declaratively. oc export does not exist in OpenShift 4.',
        docsUrl: DOCS.cliRef,
        levels: [4],
        challenges: [4, 12],
        commands: [
          `oc create -f deployment.yaml`,
          `oc apply -f k8s/`,
          `oc replace -f web.yaml`,
          `oc get deployment web -o yaml > web.yaml`,
          `oc create -f -`,
          `oc delete -f web.yaml`,
        ],
      },
      {
        id: 'manage-examine-status',
        title: 'Examine resources and cluster status',
        summary:
          'Inspect nodes, pods, deployments, ClusterOperators and the ClusterVersion to understand the state of the cluster and its workloads.',
        docsUrl: DOCS.nodes,
        levels: [3, 20],
        challenges: [2],
        commands: [
          `oc get nodes -o wide`,
          `oc get pods -A`,
          `oc describe node <node>`,
          `oc get clusteroperators`,
          `oc get clusterversion`,
          `oc status`,
        ],
      },
      {
        id: 'manage-monitor-events-alerts',
        title: 'Monitor cluster events and alerts',
        summary:
          'Read resource events and understand how alerts surface in the web console and Alertmanager in openshift-monitoring.',
        docsUrl: DOCS.monitoring,
        levels: [3],
        challenges: [2],
        commands: [
          `oc get events -n web`,
          `oc get events --sort-by=.lastTimestamp`,
          `oc get pods -n openshift-monitoring`,
          `oc get route alertmanager-main -n openshift-monitoring`,
        ],
      },
      {
        id: 'manage-view-logs',
        title: 'View logs',
        summary:
          'Stream pod, deployment, build and previous-instance logs and combine them with describe/events during troubleshooting.',
        docsUrl: DOCS.nodes,
        levels: [3],
        challenges: [2, 5],
        commands: [
          `oc logs -f <pod> -c <container>`,
          `oc logs deployment/web`,
          `oc logs -f bc/<buildconfig>`,
          `oc logs --previous <pod>`,
        ],
      },
      {
        id: 'manage-assess-health',
        title: 'Assess the health of an OpenShift cluster',
        summary:
          'Check node readiness, ClusterOperator Available/Degraded/Progressing states, ClusterVersion and top resource consumers before making changes.',
        docsUrl: DOCS.nodes,
        levels: [3, 20],
        challenges: [2],
        commands: [
          `oc get nodes -o wide`,
          `oc get co`,
          `oc get clusteroperators authentication`,
          `oc adm top nodes`,
          `oc adm top pods`,
          `oc get clusterversion`,
        ],
      },
      {
        id: 'manage-troubleshoot',
        title: 'Troubleshoot common container, pod, and cluster events and alerts',
        summary:
          'Diagnose ImagePullBackOff, CrashLoopBackOff, Pending, SCC/quota admission failures and route admission using describe, events, logs and debug.',
        docsUrl: DOCS.nodes,
        levels: [3, 10],
        challenges: [2, 9],
        commands: [
          `oc describe pod <pod>`,
          `oc get events -n <project>`,
          `oc logs <pod>`,
          `oc debug deployment/web`,
          `oc debug node/<node>`,
          `oc adm must-gather`,
          `oc adm inspect clusteroperator`,
        ],
      },
      {
        id: 'manage-use-docs',
        title: 'Use product documentation',
        summary:
          'Be able to navigate docs.redhat.com for OpenShift 4.22 quickly during the exam (CLI reference, Authentication, Network security, Ingress and load balancing, Building applications, Nodes, Operators).',
        docsUrl: EX280_EXAM_FACTS.docsBaseUrl,
        levels: [1, 20],
        challenges: [12],
        commands: [`oc help`, `oc explain <kind>`, `oc api-resources`],
      },
      {
        id: 'manage-certified-technologist',
        title: 'Be prepared to perform all tasks of a Red Hat Certified Technologist in OpenShift',
        summary:
          'Combine every objective fluently and without step-by-step hints; the final game level is a timed end-to-end platform build.',
        docsUrl: EX280_EXAM_FACTS.officialExamUrl,
        levels: [20],
        challenges: [12],
        commands: [
          `oc apply -f deployment.yaml`,
          `oc expose svc/web`,
          `oc adm policy add-role-to-user edit alice -n web`,
          `oc get co`,
        ],
      },
    ],
  },

  {
    id: 'declarative-resource-management',
    title: 'Declarative Resource Management',
    docsUrl: DOCS.buildingApps,
    bullets: [
      {
        id: 'declarative-work-manifests',
        title: 'Work with resource manifests',
        summary:
          'Author and validate apiVersion/kind/metadata/spec YAML, understand current apiVersions and apply multi-document manifests idempotently.',
        docsUrl: DOCS.buildingApps,
        levels: [4],
        challenges: [4, 12],
        commands: [
          `oc apply -f deployment.yaml`,
          `oc explain deployment.spec`,
          `oc diff -f deployment.yaml`,
          `oc create -f manifest.yaml`,
        ],
      },
      {
        id: 'declarative-deploy-yaml',
        title: 'Deploy applications from YAML resource manifests',
        summary:
          'Deploy a Deployment plus Service (and Route) from YAML, verify the rollout and confirm the resources exist in the project.',
        docsUrl: DOCS.buildingApps,
        levels: [4, 11],
        challenges: [1, 12],
        commands: [
          `oc apply -f deployment.yaml`,
          `oc apply -f service.yaml`,
          `oc get deploy,svc,pods`,
          `oc rollout status deployment/web`,
        ],
      },
      {
        id: 'declarative-update-deployments',
        title: 'Update application deployments',
        summary:
          'Update image, replicas and environment on a Deployment (manifest re-apply or oc set) and watch the new rollout complete.',
        docsUrl: DOCS.buildingApps,
        levels: [4, 10],
        challenges: [10],
        commands: [
          `oc set image deployment/web web=quay.io/example/web:v2`,
          `oc scale deployment/web --replicas=3`,
          `oc set env deployment/web APP_MODE=prod`,
          `oc rollout status deployment/web`,
          `oc rollout history deployment/web`,
        ],
      },
      {
        id: 'declarative-kustomize',
        title: 'Deploy applications using Kustomize',
        summary:
          'Create a kustomization.yaml with resources/namespace/images/replicas, apply it with oc apply -k and inspect the rendered output with oc kustomize.',
        docsUrl: DOCS.cliTools,
        levels: [5],
        challenges: [4],
        quickLabs: ['lab-kustomize'],
        commands: [`oc apply -k base/`, `oc kustomize base/`, `oc get deploy -n <namespace>`],
      },
      {
        id: 'declarative-kustomize-overlays',
        title: 'Work with Kustomize overlays',
        summary:
          'Keep a base and add environment overlays that patch namespace, image tags, replicas and settings, then apply the prod overlay.',
        docsUrl: DOCS.cliTools,
        levels: [6],
        challenges: [4],
        commands: [
          `oc kustomize overlays/prod`,
          `oc apply -k overlays/prod`,
          `oc get deployment -n prod -o yaml`,
        ],
      },
      {
        id: 'declarative-secrets',
        title: 'Create and use secrets',
        summary:
          'Create Opaque/TLS/docker-registry secrets with oc create secret, generate YAML with --dry-run=client and consume secrets as env/envFrom/volumes.',
        docsUrl: DOCS.buildingApps,
        levels: [7],
        challenges: [3, 11],
        commands: [
          `oc create secret generic db-secret --from-literal=username=app --from-literal=password='S3cret!'`,
          `oc create secret tls web-tls --cert=tls.crt --key=tls.key`,
          `oc create secret generic db-secret --from-literal=username=app --dry-run=client -o yaml`,
          `oc set env deployment/web --from=secret/db-secret`,
        ],
      },
      {
        id: 'declarative-configmaps',
        title: 'Create and use configuration maps',
        summary:
          'Create ConfigMaps from literals, files and env files, then consume them as environment variables or mounted volumes; never store credentials in them.',
        docsUrl: DOCS.buildingApps,
        levels: [7],
        challenges: [12],
        commands: [
          `oc create configmap app-config --from-literal=APP_MODE=prod --from-file=config.properties`,
          `oc create configmap app-config --from-env-file=app.env`,
          `oc set env deployment/web --from=configmap/app-config`,
          `oc get configmap app-config -o yaml`,
        ],
      },
    ],
  },

  {
    id: 'deploy-applications',
    title: 'Deploy applications',
    docsUrl: DOCS.buildingApps,
    bullets: [
      {
        id: 'deploy-templates-helm',
        title: 'Deploy applications from templates and Helm charts',
        summary:
          'Process OpenShift templates with parameters and install the shipped local Helm chart (`helm/webapp`) with install/upgrade/status/uninstall, then verify the created resources.',
        docsUrl: DOCS.buildingApps,
        levels: [8],
        challenges: [12],
        commands: [
          `oc get templates -n openshift`,
          `oc process -f templates/webapp-template.yaml --parameters`,
          `oc process -f templates/webapp-template.yaml -p REPLICA_COUNT=3 | oc create -f -`,
          `oc new-app --template=rails-postgresql-example --param=DATABASE_USER=app`,
          `helm install shop helm/webapp`,
          `helm list`,
          `helm upgrade shop helm/webapp`,
          `helm status shop`,
          `helm uninstall shop`,
        ],
      },
      {
        id: 'deploy-manage-deployments',
        title: 'Manage application deployments',
        summary:
          'Use Deployments (apps/v1) and oc rollout to update, pause, resume, restart and roll back application revisions; manage scale and image updates.',
        docsUrl: DOCS.buildingApps,
        levels: [8, 10],
        challenges: [5, 12],
        commands: [
          `oc new-app https://github.com/sclorg/nodejs-ex.git --name=app`,
          `oc rollout status deployment/app`,
          `oc rollout history deployment/app`,
          `oc rollout undo deployment/app`,
          `oc rollout restart deployment/app`,
        ],
      },
      {
        id: 'deploy-replica-sets',
        title: 'Work with replica sets',
        summary:
          'Inspect ReplicaSets created by a Deployment, understand that each pod-template revision gets a new ReplicaSet and how that enables rollbacks.',
        docsUrl: DOCS.buildingApps,
        levels: [10],
        challenges: [10],
        commands: [`oc get rs`, `oc describe rs <replicaset>`, `oc get deployment web -o yaml`],
      },
      {
        id: 'deploy-labels-selectors',
        title: 'Work with labels and selectors',
        summary:
          'Apply labels/annotations, query with selectors and keep Deployment selectors consistent with pod template labels and Service selectors.',
        docsUrl: DOCS.buildingApps,
        levels: [2, 11],
        challenges: [1, 9],
        commands: [
          `oc label deployment/web tier=frontend`,
          `oc annotate deployment/web owner=team-a`,
          `oc get pods -l app=web`,
          `oc get all --show-labels`,
        ],
      },
      {
        id: 'deploy-configure-services',
        title: 'Configure services',
        summary:
          'Create ClusterIP/headless/NodePort/LoadBalancer services, select pods correctly, and inspect endpoints/EndpointSlices.',
        docsUrl: DOCS.ingressLb,
        levels: [11],
        challenges: [1, 3],
        commands: [
          `oc expose deployment/web --port=8080`,
          `oc create service clusterip my-svc --tcp=8080:8080`,
          `oc get svc`,
          `oc get endpoints`,
          `oc describe service web`,
        ],
      },
      {
        id: 'deploy-expose-external',
        title: 'Expose applications to external access',
        summary:
          'Expose a Service with an HTTP Route, secure it with edge/passthrough/reencrypt TLS and verify the Route is admitted.',
        docsUrl: DOCS.routes,
        levels: [11, 12],
        challenges: [1, 3],
        quickLabs: ['lab-route-tls'],
        commands: [
          `oc expose svc/web`,
          `oc create route edge web --service=web --hostname=web.apps.example.com --cert=tls.crt --key=tls.key`,
          `oc get routes`,
          `oc get route web -o jsonpath='{.spec.host}'`,
          `oc get ingresses.config/cluster -o jsonpath={.spec.domain}`,
        ],
      },
    ],
  },

  {
    id: 'authentication-authorization',
    title: 'Manage authentication and authorization',
    docsUrl: DOCS.auth,
    bullets: [
      {
        id: 'auth-htpasswd',
        title: 'Configure the HTPasswd identity provider for authentication',
        summary:
          'Create an htpasswd file, store it in the openshift-config secret and configure the OAuth CR to use it, then log in as a local user.',
        docsUrl: DOCS.htpasswdIdp,
        levels: [13],
        challenges: [11],
        quickLabs: ['lab-users-htpasswd'],
        commands: [
          `htpasswd -c -B -b users.htpasswd alice 'Passw0rd!'`,
          `oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config`,
          `oc edit oauth cluster`,
          `oc login -u alice`,
        ],
      },
      {
        id: 'auth-users',
        title: 'Create and delete users',
        summary:
          'Manage users through the configured identity provider and, as a power user, create/delete User and Identity objects correctly.',
        docsUrl: DOCS.htpasswdIdp,
        levels: [13],
        challenges: [11],
        commands: [
          `oc create user ajones --full-name="Adam Jones"`,
          `oc get users`,
          `oc delete user alice`,
          `oc delete identity my_htpasswd_provider:alice`,
        ],
      },
      {
        id: 'auth-passwords',
        title: 'Modify user passwords',
        summary:
          'Rotate an htpasswd password safely: extract the htpasswd file from the secret, change the hash, write it back with `oc set data`, wait for the OAuth rollout and log in with the new password; clean up the affected user/identity when removing accounts.',
        docsUrl: DOCS.htpasswdIdp,
        levels: [13],
        challenges: [11],
        commands: [
          `oc extract secret/htpass-secret -n openshift-config --to /tmp --confirm`,
          `htpasswd -bB /tmp/htpasswd alice 'NewPassw0rd!'`,
          `oc set data secret/htpass-secret -n openshift-config --from-file=htpasswd=/tmp/htpasswd`,
          `oc get clusteroperator authentication`,
          `oc login -u alice -p 'NewPassw0rd!'`,
          `oc create secret generic htpass-secret --from-file=htpasswd=/tmp/htpasswd --dry-run=client -o yaml -n openshift-config | oc replace -f -`,
        ],
      },
      {
        id: 'auth-groups',
        title: 'Create and manage groups',
        summary:
          'Create groups, add/remove users and verify membership before granting permissions to the group.',
        docsUrl: DOCS.rbac,
        levels: [14],
        challenges: [7, 11],
        commands: [
          `oc adm groups new web-team alice bob`,
          `oc adm groups add-users web-team carol`,
          `oc adm groups remove-users web-team bob`,
          `oc get groups`,
          `oc describe group web-team`,
        ],
      },
      {
        id: 'auth-permissions',
        title: 'Modify user and group permissions',
        summary:
          'Bind namespace or cluster roles to users/groups, create custom roles and verify effective permissions with oc auth can-i.',
        docsUrl: DOCS.rbac,
        levels: [14, 16],
        challenges: [7, 12],
        commands: [
          `oc adm policy add-role-to-user edit alice -n web`,
          `oc adm policy add-role-to-group view web-team -n web`,
          `oc adm policy add-cluster-role-to-user cluster-admin alice`,
          `oc create role podview --verb=get --resource=pod -n web`,
          `oc auth can-i create pods -n web`,
        ],
      },
    ],
  },

  {
    id: 'network-security',
    title: 'Configure network security',
    docsUrl: DOCS.networkSecurity,
    bullets: [
      {
        id: 'net-configure-components',
        title: 'Configure networking components',
        summary:
          'Understand the cluster network configuration, the IngressController/router, the default ingress domain and how Services connect to pods.',
        docsUrl: DOCS.ingressLb,
        levels: [11, 12],
        challenges: [3],
        commands: [
          `oc get network/cluster -o yaml`,
          `oc get ingresscontroller -n openshift-ingress-operator`,
          `oc get deployment -n openshift-ingress`,
          `oc get ingresses.config/cluster -o jsonpath={.spec.domain}`,
        ],
      },
      {
        id: 'net-troubleshoot-sdn',
        title: 'Troubleshoot software defined networking',
        summary:
          'Verify service endpoints, test connectivity from inside the cluster, inspect router/network pods and use oc debug node for node-level networking checks.',
        docsUrl: DOCS.networkSecurity,
        levels: [3, 11],
        challenges: [9],
        commands: [
          `oc get endpoints`,
          `oc get pods -n openshift-ingress`,
          `oc run tmp-shell --rm -i -t --image=registry.redhat.io/ubi9/ubi-minimal -- sh`,
          `oc debug node/<node>`,
          `oc get networkpolicy`,
        ],
      },
      {
        id: 'net-routes',
        title: 'Create and edit external routes',
        summary:
          'Create unsecured and TLS routes, understand host/path rules, wildcard policy and route admission status.',
        docsUrl: DOCS.routes,
        levels: [11, 12],
        challenges: [3, 10],
        commands: [
          `oc expose svc/web`,
          `oc create route edge web --service=web --cert=tls.crt --key=tls.key`,
          `oc get routes`,
          `oc edit route web`,
          `oc describe route web`,
        ],
      },
      {
        id: 'net-control-ingress',
        title: 'Control cluster network ingress',
        summary:
          'Implement default-deny ingress and targeted allow rules for applications; verify with in-cluster connectivity tests.',
        docsUrl: DOCS.networkPolicy,
        levels: [20],
        challenges: [9],
        commands: [
          `oc apply -f deny-by-default.yaml -n web`,
          `oc get networkpolicy -n web`,
          `oc describe networkpolicy deny-by-default -n web`,
        ],
      },
      {
        id: 'net-tls',
        title: 'Secure external and internal traffic using TLS certificates',
        summary:
          'Create TLS secrets, configure edge/reencrypt routes with certificate chains and destination CA certificates, and validate with curl/openssl.',
        docsUrl: DOCS.routes,
        levels: [11, 12],
        challenges: [3, 8],
        commands: [
          `oc create secret tls web-tls --cert=tls.crt --key=tls.key`,
          `oc create route edge web --service=web --cert=tls.crt --key=tls.key --ca-cert=ca.crt`,
          `oc create route reencrypt reenc --service=reenc --cert=tls.crt --key=tls.key --dest-ca-cert=destca.crt`,
          `oc get route web -o yaml`,
        ],
      },
      {
        id: 'net-network-policies',
        title: 'Configure application network policies',
        summary:
          'Write NetworkPolicies with pod/namespace selectors and ports: default deny, allow same namespace, allow a labelled namespace, and restore DNS/ingress access.',
        docsUrl: DOCS.networkPolicy,
        levels: [20],
        challenges: [9],
        commands: [
          `oc apply -f allow-frontend.yaml -n web`,
          `oc label namespace prod purpose=production`,
          `oc get networkpolicy`,
          `oc run test-$RANDOM --namespace=prod --rm -i -t --image=registry.redhat.io/ubi9/ubi-minimal -- sh`,
        ],
      },
    ],
  },

  {
    id: 'expose-non-http-sni',
    title: 'Expose non-HTTP/SNI Applications',
    docsUrl: DOCS.ingressLb,
    bullets: [
      {
        id: 'nonhttp-load-balancer-service',
        title: 'Configure a load balancer service',
        summary:
          'Create a Service with type LoadBalancer, obtain an external IP (cloud LB, or MetalLB on bare metal) and verify connectivity for non-HTTP protocols.',
        docsUrl: DOCS.metallbDocs,
        levels: [12],
        challenges: [10],
        commands: [
          `oc create service loadbalancer app-lb --tcp=8081:8080`,
          `oc get svc app-lb -o wide`,
          `oc describe svc app-lb`,
          `oc get ipaddresspools -n metallb-system`,
        ],
      },
      {
        id: 'nonhttp-external-access',
        title: 'Configure external application access',
        summary:
          'Use NodePort and LoadBalancer services for TCP/UDP applications that Routes cannot carry, and TLS passthrough Routes for SNI-based protocols.',
        docsUrl: DOCS.routes,
        levels: [12],
        challenges: [10],
        commands: [
          `oc create service nodeport db --tcp=3306:3306`,
          `oc create route passthrough tls-app --service=tls-app --port=443`,
          `oc get svc,routes`,
          `oc get endpoints`,
        ],
      },
    ],
  },

  {
    id: 'enable-developer-self-service',
    title: 'Enable developer self-service',
    docsUrl: DOCS.quotas,
    bullets: [
      {
        id: 'selfservice-cluster-quotas',
        title: 'Configure cluster resource quotas',
        summary:
          'Create ClusterResourceQuota objects that aggregate limits across projects selected by labels or annotations, and inspect them from a project.',
        docsUrl: DOCS.quotas,
        levels: [15],
        challenges: [6],
        commands: [
          `oc create clusterquota team-quota --project-label-selector=team=web --hard=pods=10 --hard=secrets=20`,
          `oc create clusterresourcequota for-name --project-label-selector=name=frontend --hard=pods=10`,
          `oc describe clusterresourcequota team-quota`,
          `oc describe AppliedClusterResourceQuota -n web`,
        ],
      },
      {
        id: 'selfservice-project-quotas',
        title: 'Configure project quotas',
        summary:
          'Create ResourceQuota objects for compute, storage and object counts, then read used vs hard limits.',
        docsUrl: DOCS.quotas,
        levels: [15],
        challenges: [6],
        quickLabs: ['lab-quota'],
        commands: [
          `oc create quota compute-quota --hard=pods=4,requests.cpu=1,requests.memory=1Gi,limits.cpu=2,limits.memory=2Gi`,
          `oc create quota objects --hard=configmaps=10,secrets=10,services=10,count/deployments.apps=2`,
          `oc describe quota compute-quota -n web`,
          `oc get quota`,
        ],
      },
      {
        id: 'selfservice-resource-requirements',
        title: 'Configure project resource requirements',
        summary:
          'Set container requests/limits (or let a LimitRange default them), understand QoS and why pods are rejected once a compute quota exists.',
        docsUrl: DOCS.quotas,
        levels: [15, 20],
        challenges: [6],
        commands: [
          `oc set resources deployment web -c=web --limits=cpu=200m,memory=512Mi --requests=cpu=100m,memory=128Mi`,
          `oc get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\\t"}{.status.qosClass}{"\\n"}{end}'`,
          `oc describe quota compute-quota -n web`,
        ],
      },
      {
        id: 'selfservice-limit-ranges',
        title: 'Configure project limit ranges',
        summary:
          'Create a LimitRange that supplies default requests/limits and enforces min/max per container, pod and PVC.',
        docsUrl: DOCS.quotas,
        levels: [15],
        challenges: [6],
        quickLabs: ['lab-quota'],
        commands: [
          `oc create -f examples/limitrange.yaml -n web`,
          `oc get limits -n web`,
          `oc describe limits resource-limits -n web`,
        ],
      },
      {
        id: 'selfservice-project-templates',
        title: 'Configure project templates',
        summary:
          'Customize the template OpenShift uses for self-service project creation: generate the bootstrap `project-request` template, add guardrails (for example a NetworkPolicy) to its object list, store it in `openshift-config`, point the `project.config.openshift.io/cluster` singleton at it and verify that a new project inherits the objects. On a real cluster `oc edit` opens `$EDITOR` (vi/vim) in the terminal; the simulator opens its manifest editor instead.',
        docsUrl: DOCS.projects,
        levels: [15, 8],
        challenges: [12],
        commands: [
          `oc adm create-bootstrap-project-template -o yaml > template.yaml`,
          `oc create -f template.yaml -n openshift-config`,
          `oc get templates -n openshift-config`,
          `oc edit project.config.openshift.io/cluster`,
          `oc new-project template-check`,
        ],
      },
    ],
  },

  {
    id: 'manage-operators',
    title: 'Manage OpenShift operators',
    docsUrl: DOCS.operators,
    bullets: [
      {
        id: 'ops-install',
        title: 'Install an operator',
        summary:
          'Install from OperatorHub or CLI: create an OperatorGroup only for SingleNamespace installs, create a Subscription, approve the InstallPlan when manual and wait for the CSV to succeed. The simulator ships a local Subscription example (`examples/subscription.yaml`).',
        docsUrl: DOCS.operatorUserTasks,
        levels: [12, 18],
        challenges: [10],
        quickLabs: ['lab-operator'],
        commands: [
          `oc get packagemanifests -n openshift-marketplace`,
          `oc get operatorgroup -n <namespace>`,
          `oc apply -f examples/subscription.yaml`,
          `oc get sub,csv,installplan -n <namespace>`,
          `oc describe sub <subscription> -n <namespace>`,
        ],
      },
      {
        id: 'ops-uninstall',
        title: 'Uninstall an operator',
        summary:
          'Uninstall correctly by deleting the Subscription (or via the console) and removing an OperatorGroup created only for that operator.',
        docsUrl: DOCS.operatorAdminTasks,
        levels: [18],
        challenges: [10],
        commands: [
          `oc get sub,csv -n <namespace>`,
          `oc delete subscription.operators.coreos.com <subscription> -n <namespace>`,
          `oc get csv -n <namespace>`,
        ],
      },
      {
        id: 'ops-delete',
        title: 'Delete an operator',
        summary:
          'Delete the ClusterServiceVersion associated with the removed subscription, clean up operands/CRs and confirm nothing remains.',
        docsUrl: DOCS.operatorAdminTasks,
        levels: [18],
        challenges: [10],
        commands: [
          `oc get subscription.operators.coreos.com <subscription> -n <namespace> -o yaml | grep currentCSV`,
          `oc delete clusterserviceversion <csv> -n <namespace>`,
          `oc get csv,sub,installplan -n <namespace>`,
        ],
      },
    ],
  },

  {
    id: 'configure-application-security',
    title: 'Configure application security',
    docsUrl: DOCS.auth,
    bullets: [
      {
        id: 'security-service-accounts',
        title: 'Configure and manage service accounts',
        summary:
          'Create service accounts, inspect image-pull secrets and tokens, assign an SA to a workload and bind roles to it.',
        docsUrl: DOCS.serviceAccounts,
        levels: [16],
        challenges: [8, 12],
        quickLabs: ['lab-scc'],
        commands: [
          `oc create sa robot`,
          `oc describe sa robot`,
          `oc create token robot`,
          `oc set serviceaccount deployment/web robot`,
          `oc adm policy add-role-to-user view -z robot -n web`,
        ],
      },
      {
        id: 'security-privileged',
        title: 'Run privileged applications',
        summary:
          'Run pods/deployments with privileged or host-level securityContext only after granting an SCC that allows it to the pod service account.',
        docsUrl: DOCS.sccDocs,
        levels: [17],
        challenges: [8],
        commands: [
          `oc adm policy add-scc-to-user privileged -z robot -n web`,
          `oc get pod <pod> -o jsonpath='{.metadata.annotations.openshift\\.io/scc}'`,
          `oc get deployment privileged-app -o yaml`,
        ],
      },
      {
        id: 'security-scc',
        title: 'Manage and apply permissions using security context constraints',
        summary:
          'Inspect SCCs, grant/revoke SCCs to users, groups and service accounts, and troubleshoot Forbidden security context errors without editing default SCCs.',
        docsUrl: DOCS.sccDocs,
        levels: [17],
        challenges: [8],
        quickLabs: ['lab-scc'],
        commands: [
          `oc get scc`,
          `oc describe scc restricted-v2`,
          `oc adm policy add-scc-to-user anyuid -z robot -n web`,
          `oc adm policy add-scc-to-group privileged system:serviceaccounts:web`,
          `oc adm policy who-can use scc privileged`,
          `oc auth can-i use scc/privileged --as=system:serviceaccount:web:robot`,
        ],
      },
      {
        id: 'security-secrets',
        title: 'Create and apply secrets to manage sensitive information',
        summary:
          'Create and consume secrets (env, envFrom, volume), use TLS/dockerconfigjson types and keep sensitive values out of ConfigMaps.',
        docsUrl: DOCS.auth,
        levels: [7, 17],
        challenges: [3, 8],
        commands: [
          `oc create secret generic api-key --from-literal=token=abc123`,
          `oc set env deployment/web --from=secret/api-key`,
          `oc create secret tls web-tls --cert=tls.crt --key=tls.key`,
          `oc get secret api-key -o yaml`,
        ],
      },
      {
        id: 'security-api-access',
        title: 'Configure application access to Kubernetes APIs',
        summary:
          'Give an application a service account with least-privilege RBAC and a bound token (oc create token or projected volume) to call the Kubernetes/OpenShift API.',
        docsUrl: DOCS.serviceAccounts,
        levels: [16],
        challenges: [7, 12],
        commands: [
          `oc create sa robot`,
          `oc adm policy add-role-to-user view -z robot -n web`,
          `oc create token robot --duration 10m`,
          `oc auth can-i list pods --as=system:serviceaccount:web:robot -n web`,
        ],
      },
      {
        id: 'security-jobs',
        title: 'Deploy jobs to perform one-time tasks',
        summary:
          'Create batch/v1 Jobs with completions/parallelism/backoffLimit and verify successful completion and logs.',
        docsUrl: DOCS.jobsDocs,
        levels: [19],
        challenges: [12],
        quickLabs: ['lab-jobs'],
        commands: [
          `oc create job pi --image=perl -- perl -Mbignum=bpi -wle 'print bpi(2000)'`,
          `oc get jobs`,
          `oc describe job pi`,
          `oc logs job/pi`,
          `oc delete job pi`,
        ],
      },
      {
        id: 'security-cronjobs',
        title: 'Configure Kubernetes cron jobs',
        summary:
          'Create batch/v1 CronJobs with schedules, concurrency policy and deadline handling; verify spawned Jobs and suspend/resume.',
        docsUrl: DOCS.jobsDocs,
        levels: [19],
        challenges: [12],
        commands: [
          `oc create cronjob pi --image=perl --schedule='*/1 * * * *' -- perl -Mbignum=bpi -wle 'print bpi(2000)'`,
          `oc get cronjobs`,
          `oc get jobs`,
          `oc patch cronjob pi -p '{"spec":{"suspend":true}}' --type=merge`,
        ],
      },
    ],
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Quick labs — 9 short do-it-now drills (CONVERSION-SPEC §11 quick labs).
 * setup.startingResources is a seed hint; the UI launches Sandbox and shows the
 * steps even when the engine seeding hooks are not available yet.
 * ──────────────────────────────────────────────────────────────────────────── */
export const EX280_QUICK_LABS = [
  {
    id: 'lab-projects',
    title: 'Projects & the oc CLI',
    objectiveId: 'manage-create-delete-projects',
    objectiveIds: ['manage-cli', 'manage-create-delete-projects'],
    docsUrl: DOCS.cliTools,
    mode: 'sandbox',
    summary:
      'Create a project, deploy a workload into it and clean it up again — the fundamental exam loop.',
    setup: { startingResources: [], manifestFiles: [] },
    check: [
      { type: 'project', name: 'ex280-lab' },
      { type: 'deploy', kind: 'Deployment', count: 1 },
    ],
    hints: [
      'oc new-project sets your current project; verify with oc project.',
      'Use oc get pods to confirm the Deployment created a pod.',
    ],
    steps: [
      {
        command: `oc new-project ex280-lab --display-name="EX280 Lab"`,
        text: 'Create and switch to a new project.',
      },
      {
        command: `oc new-app --image=registry.redhat.io/ubi9/ubi-minimal --name=lab-app`,
        text: 'Deploy a workload from a container image.',
      },
      { command: `oc get pods`, text: 'Confirm a pod is created in the new project.' },
      { command: `oc delete project ex280-lab`, text: 'Delete the project and everything in it.' },
    ],
  },
  {
    id: 'lab-users-htpasswd',
    title: 'HTPasswd users & login',
    objectiveId: 'auth-htpasswd',
    objectiveIds: ['auth-htpasswd', 'auth-users', 'auth-passwords'],
    docsUrl: DOCS.auth,
    mode: 'sandbox',
    summary:
      'Add a local user through the htpasswd secret and OAuth provider, log in, then rotate that user password the way the exam expects.',
    setup: { startingResources: [], manifestFiles: [] },
    check: [
      { type: 'login', user: 'ex280-user' },
      { type: 'user', name: 'ex280-user' },
    ],
    hints: [
      'The htpasswd file key inside the secret must be named htpasswd.',
      'The OAuth CR is a cluster singleton named cluster.',
      'After changing the secret, give the authentication operator a few seconds to roll out before logging in with the new password.',
    ],
    steps: [
      {
        command: `htpasswd -c -B -b users.htpasswd ex280-user 'Passw0rd!'`,
        text: 'Create the htpasswd file (bcrypt hashes).',
      },
      {
        command: `oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config`,
        text: 'Store the file in the openshift-config project.',
      },
      {
        command: `oc edit oauth cluster`,
        text: 'Add an HTPasswd identityProvider to the OAuth cluster singleton: name htpasswd, fileData.name htpass-secret, mappingMethod claim.',
      },
      { command: `oc login -u ex280-user`, text: 'Log in as the new user and check oc whoami.' },
      {
        command: `oc extract secret/htpass-secret -n openshift-config --to /tmp --confirm`,
        text: 'Rotate the password: extract the htpasswd file from the secret.',
      },
      {
        command: `htpasswd -bB /tmp/htpasswd ex280-user 'Rotated0rd!'`,
        text: 'Set a new bcrypt hash in the extracted file.',
      },
      {
        command: `oc set data secret/htpass-secret -n openshift-config --from-file=htpasswd=/tmp/htpasswd`,
        text: 'Write the updated file back into the secret and wait for the authentication operator rollout.',
      },
      {
        command: `oc login -u ex280-user -p 'Rotated0rd!'`,
        text: 'Log in with the rotated password to verify it took effect.',
      },
    ],
  },
  {
    id: 'lab-route-tls',
    title: 'Route with edge TLS',
    objectiveId: 'deploy-expose-external',
    objectiveIds: ['deploy-expose-external', 'net-tls', 'net-routes'],
    docsUrl: DOCS.routes,
    mode: 'sandbox',
    summary:
      'Expose a Service with an edge TLS Route using a certificate secret and verify it is admitted.',
    setup: {
      startingResources: [],
      manifestFiles: ['manifests/service.yaml', 'manifests/route.yaml'],
    },
    check: [
      { type: 'route', name: 'web', termination: 'edge' },
      { type: 'tls', enabled: true, termination: 'edge' },
    ],
    hints: [
      'Create a kubernetes.io/tls secret with tls.crt and tls.key before the edge route.',
      'oc create route edge needs --service and a certificate/key pair.',
    ],
    steps: [
      { command: `oc new-project web`, text: 'Create a project for the app.' },
      {
        command: `oc create secret tls web-tls --cert=tls.crt --key=tls.key`,
        text: 'Create the TLS secret.',
      },
      {
        command: `oc create route edge web --service=web --hostname=web.apps.example.com --cert=tls.crt --key=tls.key`,
        text: 'Create an edge-terminated Route.',
      },
      {
        command: `oc get route web -o yaml`,
        text: 'Check status.ingress conditions for Admitted=True.',
      },
    ],
  },
  {
    id: 'lab-build-imagestream',
    title: 'BuildConfig → Build → ImageStream',
    objectiveId: 'deploy-manage-deployments',
    objectiveIds: [
      'deploy-manage-deployments',
      'manage-locate-images',
      'manage-images-tags-digests',
    ],
    docsUrl: DOCS.buildingApps,
    mode: 'sandbox',
    summary:
      'Create an application build from source, wait for the Build to complete and read the resulting ImageStreamTag.',
    setup: { startingResources: [], manifestFiles: ['examples/buildconfig.yaml'] },
    check: [
      { type: 'build', count: 1 },
      { type: 'imageStream', name: 'app', tag: 'latest' },
    ],
    hints: [
      'oc new-app with a Git URL or oc start-build on an existing BuildConfig both create a Build.',
      'oc logs -f bc/<name> streams the build log.',
    ],
    steps: [
      { command: `oc new-project build-lab`, text: 'Create a project for the build.' },
      {
        command: `oc new-app https://github.com/sclorg/nodejs-ex.git --name=app`,
        text: 'Create the app, BuildConfig and ImageStream.',
      },
      { command: `oc logs -f bc/app`, text: 'Follow the build log until it completes.' },
      {
        command: `oc get is app -o yaml`,
        text: 'Read status.tags for the latest ImageStreamTag digest.',
      },
    ],
  },
  {
    id: 'lab-kustomize',
    title: 'Kustomize prod overlay',
    objectiveId: 'declarative-kustomize',
    objectiveIds: ['declarative-kustomize', 'declarative-kustomize-overlays'],
    docsUrl: DOCS.cliTools,
    mode: 'sandbox',
    summary:
      'Apply a base deployment, then a prod overlay that changes namespace, image and replicas.',
    setup: {
      startingResources: [],
      manifestFiles: [
        'kustomize/base/deployment.yaml',
        'kustomize/base/kustomization.yaml',
        'kustomize/overlays/prod/kustomization.yaml',
      ],
    },
    check: [
      { type: 'kustomize', path: 'kustomize/overlays/prod' },
      { type: 'deploy', kind: 'Deployment', count: 1 },
    ],
    hints: [
      'kustomization.yaml lists resources and can set namespace, images and replicas.',
      'Preview a kustomization without applying it: `oc kustomize <dir>` prints the rendered YAML; apply it with `oc apply -k <dir>`.',
    ],
    steps: [
      {
        command: `oc apply -k kustomize/overlays/prod`,
        text: 'Preview the rendered overlay with `oc kustomize kustomize/overlays/prod`, then apply it into the webapp-prod namespace with `oc apply -k kustomize/overlays/prod`.',
      },
      {
        command: `oc get deployment -n webapp-prod`,
        text: 'Verify the image tag and replica count match the overlay.',
      },
    ],
  },
  {
    id: 'lab-quota',
    title: 'ResourceQuota + LimitRange',
    objectiveId: 'selfservice-project-quotas',
    objectiveIds: [
      'selfservice-project-quotas',
      'selfservice-limit-ranges',
      'selfservice-resource-requirements',
    ],
    docsUrl: DOCS.quotas,
    mode: 'sandbox',
    summary:
      'Cap a project with a compute quota and a LimitRange, then deploy a compliant workload.',
    setup: {
      startingResources: [{ kind: 'Project', name: 'quota-lab' }],
      manifestFiles: ['examples/quota.yaml', 'examples/limitrange.yaml'],
    },
    check: [
      { type: 'quota', name: 'compute-quota', namespace: 'quota-lab' },
      { type: 'limitRange', namespace: 'quota-lab' },
    ],
    hints: [
      'A pod may be rejected when a compute quota exists and it has no requests/limits.',
      'A LimitRange defaultRequest/default fills those values automatically.',
    ],
    steps: [
      { command: `oc new-project quota-lab`, text: 'Create the project.' },
      {
        command: `oc create quota compute-quota --hard=pods=4,requests.cpu=1,requests.memory=1Gi --namespace=quota-lab`,
        text: 'Create a compute quota.',
      },
      {
        command: `oc create -f examples/limitrange.yaml -n quota-lab`,
        text: 'Create a LimitRange with defaults.',
      },
      { command: `oc get quota,limits -n quota-lab`, text: 'Verify both objects exist.' },
    ],
  },
  {
    id: 'lab-scc',
    title: 'Service account + SCC grant',
    objectiveId: 'security-scc',
    objectiveIds: [
      'security-service-accounts',
      'security-scc',
      'security-privileged',
      'security-api-access',
    ],
    docsUrl: DOCS.auth,
    mode: 'sandbox',
    summary:
      'Create a service account, grant it an SCC and validate the pod annotation that proves it took effect.',
    setup: {
      startingResources: [],
      manifestFiles: [],
    },
    check: [{ type: 'scc', scc: 'anyuid', subject: 'system:serviceaccount:scc-lab:robot' }],
    hints: [
      'Grant the SCC to the workload service account with -z, not to default if you can avoid it.',
      'The pod annotation openshift.io/scc reveals which SCC admitted it.',
    ],
    steps: [
      { command: `oc new-project scc-lab`, text: 'Create the project.' },
      { command: `oc create sa robot -n scc-lab`, text: 'Create the service account.' },
      {
        command: `oc adm policy add-scc-to-user anyuid -z robot -n scc-lab`,
        text: 'Grant anyuid to the service account.',
      },
      {
        command: `oc get pod <pod> -o jsonpath='{.metadata.annotations.openshift\\.io/scc}'`,
        text: 'Confirm the pod was admitted by anyuid.',
      },
    ],
  },
  {
    id: 'lab-operator',
    title: 'Install an operator',
    objectiveId: 'ops-install',
    objectiveIds: ['ops-install', 'ops-uninstall', 'ops-delete'],
    docsUrl: DOCS.operators,
    mode: 'sandbox',
    summary:
      'Install the MetalLB operator from a Subscription, watch the CSV succeed and then uninstall it.',
    setup: {
      startingResources: [{ kind: 'Project', name: 'operators-lab' }],
      manifestFiles: ['examples/subscription.yaml'],
    },
    check: [{ type: 'operator', name: 'metallb', installed: true }],
    hints: [
      'The simulator installs into the openshift-operators project (AllNamespaces); a real cluster documents MetalLB in metallb-system.',
      'The Subscription needs channel, name, source and sourceNamespace; the CSV (not the Subscription) reports Installing → Succeeded.',
    ],
    steps: [
      {
        command: `oc new-project operators-lab`,
        text: 'Create a project to hold operator operands.',
      },
      {
        command: `oc get packagemanifests -n openshift-marketplace`,
        text: 'Find the operator package, channel and catalog source.',
      },
      {
        command: `oc apply -f examples/subscription.yaml`,
        text: 'First edit examples/subscription.yaml in the Files panel so metadata.name, spec.name and the package are metallb, then create the Subscription.',
      },
      {
        command: `oc get sub,csv,installplan -n openshift-operators`,
        text: 'Wait for the CSV to reach Succeeded (oc describe sub metallb shows installedCSV).',
      },
      {
        command: `oc delete subscription metallb -n openshift-operators`,
        text: 'Uninstall by deleting the Subscription, then the CSV it installed.',
      },
    ],
  },
  {
    id: 'lab-jobs',
    title: 'Job + CronJob',
    objectiveId: 'security-jobs',
    objectiveIds: ['security-jobs', 'security-cronjobs'],
    docsUrl: DOCS.nodes,
    mode: 'sandbox',
    summary:
      'Run a one-time Job to completion and create a CronJob that spawns Jobs on a schedule.',
    setup: { startingResources: [{ kind: 'Project', name: 'jobs-lab' }], manifestFiles: [] },
    check: [
      { type: 'complete', kind: 'Job', count: 1 },
      { type: 'cronJob', count: 1 },
    ],
    hints: [
      'Jobs use restartPolicy Never or OnFailure.',
      'CronJob schedules use standard five-field cron syntax.',
    ],
    steps: [
      { command: `oc new-project jobs-lab`, text: 'Create the project.' },
      {
        command: `oc create job pi --image=perl -- perl -Mbignum=bpi -wle 'print bpi(2000)'`,
        text: 'Create and launch a one-time Job.',
      },
      { command: `oc get jobs`, text: 'Wait for the Job to show COMPLETIONS 1/1.' },
      {
        command: `oc create cronjob pi --image=perl --schedule='*/1 * * * *' -- perl -Mbignum=bpi -wle 'print bpi(2000)'`,
        text: 'Create a CronJob that runs every minute.',
      },
    ],
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Cheat sheet — searchable grouped oc command reference.
 * ──────────────────────────────────────────────────────────────────────────── */
export const EX280_CHEATSHEET = [
  {
    id: 'cli-projects',
    title: 'CLI & projects',
    docsUrl: DOCS.cliTools,
    items: [
      { cmd: `oc login -u <user>`, note: 'Interactive login (or oc login --token=<token>).' },
      { cmd: `oc whoami`, note: 'Current user.' },
      { cmd: `oc status`, note: 'Quick overview of the current project.' },
      {
        cmd: `oc new-project <name> --display-name="..." --description="..."`,
        note: 'Create and switch to a project.',
      },
      { cmd: `oc projects`, note: 'List projects you can access.' },
      { cmd: `oc project <name>`, note: 'Switch current project.' },
      { cmd: `oc delete project <name>`, note: 'Delete a project and its resources.' },
      { cmd: `oc api-resources`, note: 'List supported API resources.' },
      { cmd: `oc explain <kind>.<field>`, note: 'Field documentation from the server.' },
    ],
  },
  {
    id: 'query-format',
    title: 'Query, format, filter',
    docsUrl: DOCS.cliTools,
    items: [
      { cmd: `oc get pods -o wide`, note: 'Wide output (node, IP).' },
      { cmd: `oc get deploy -o yaml`, note: 'Full object YAML.' },
      {
        cmd: `oc get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\\n"}{end}'`,
        note: 'Extract fields.',
      },
      {
        cmd: `oc get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName`,
        note: 'Tabular custom columns.',
      },
      { cmd: `oc get pods -l app=web --show-labels`, note: 'Filter by label and show labels.' },
      { cmd: `oc get pods --field-selector spec.nodeName=<node>`, note: 'Field selector.' },
      { cmd: `oc get events --sort-by=.lastTimestamp`, note: 'Sort events by recency.' },
      { cmd: `oc get pods -A`, note: 'All projects.' },
    ],
  },
  {
    id: 'manifests',
    title: 'Manifests, secrets, config',
    docsUrl: DOCS.buildingApps,
    items: [
      { cmd: `oc apply -f <file|dir>`, note: 'Declarative create/update.' },
      { cmd: `oc apply -k <kustomize-dir>`, note: 'Apply a Kustomize target.' },
      { cmd: `oc kustomize <dir>`, note: 'Render Kustomize output without applying.' },
      { cmd: `oc create -f <file>`, note: 'Create from YAML/JSON.' },
      { cmd: `oc replace -f <file>`, note: 'Replace an existing object.' },
      {
        cmd: `oc get deploy web -o yaml > web.yaml`,
        note: 'Export a resource (oc export is removed).',
      },
      { cmd: `oc diff -f <file>`, note: 'Show differences before applying.' },
      {
        cmd: `oc edit <kind>/<name>`,
        note: 'Live-edit an object. Real oc opens $EDITOR (vi/vim by default) in the terminal; the simulator opens its manifest editor.',
      },
      {
        cmd: `oc extract secret/<name> -n <ns> --to <dir> --confirm`,
        note: 'Extract a secret (or configmap) to files, e.g. the htpasswd database.',
      },
      {
        cmd: `oc set data secret/<name> -n <ns> --from-file=<key>=<path>`,
        note: 'Update one key in an existing secret/configmap (password rotation).',
      },
      {
        cmd: `oc create secret generic <name> --from-file=<key>=<path> --dry-run=client -o yaml -n <ns> | oc replace -f -`,
        note: 'Alternative rotate pipeline — one correctly piped command.',
      },
      {
        cmd: `oc create secret generic <name> --from-literal=K=V --from-file=<key>=<path>`,
        note: 'Create an Opaque secret.',
      },
      {
        cmd: `oc create secret tls <name> --cert=tls.crt --key=tls.key`,
        note: 'Create a kubernetes.io/tls secret.',
      },
      {
        cmd: `oc create configmap <name> --from-literal=K=V --from-file=<path> --from-env-file=<file>`,
        note: 'Create a ConfigMap.',
      },
      {
        cmd: `oc set env deployment/web --from=secret/<name>`,
        note: 'Inject a secret into env vars.',
      },
    ],
  },
  {
    id: 'workloads',
    title: 'Workloads, rollouts, services',
    docsUrl: DOCS.buildingApps,
    items: [
      {
        cmd: `oc new-app <git-url> --name=<name>`,
        note: 'Create an app from source (BuildConfig chain).',
      },
      { cmd: `oc new-app --image=<image> --name=<name>`, note: 'Create an app from an image.' },
      { cmd: `oc rollout status deployment/<name>`, note: 'Wait for a rollout.' },
      { cmd: `oc rollout history deployment/<name>`, note: 'List revisions.' },
      { cmd: `oc rollout undo deployment/<name>`, note: 'Roll back to the previous revision.' },
      { cmd: `oc rollout restart deployment/<name>`, note: 'Restart pods with a new ReplicaSet.' },
      {
        cmd: `oc set image deployment/<name> <container>=<image>`,
        note: 'Update a deployment image.',
      },
      { cmd: `oc scale deployment/<name> --replicas=<n>`, note: 'Scale a deployment.' },
      {
        cmd: `oc set resources deployment <name> -c=<container> --limits=cpu=200m,memory=512Mi`,
        note: 'Set requests/limits.',
      },
      {
        cmd: `oc set triggers deploy/<name> --from-image=<is>:<tag> -c <container>`,
        note: 'Image change trigger.',
      },
      { cmd: `oc expose svc/<name>`, note: 'Create an HTTP route for a service.' },
      {
        cmd: `oc create route edge <name> --service=<svc> --cert=tls.crt --key=tls.key`,
        note: 'Edge TLS route.',
      },
      {
        cmd: `oc create route passthrough <name> --service=<svc> --port=8080`,
        note: 'Passthrough TLS route.',
      },
      {
        cmd: `oc create service loadbalancer <name> --tcp=8080:8080`,
        note: 'LoadBalancer service for non-HTTP.',
      },
      {
        cmd: `oc create service nodeport <name> --tcp=3306:3306`,
        note: 'NodePort service (30000-32767).',
      },
      {
        cmd: `oc get ingresses.config/cluster -o jsonpath={.spec.domain}`,
        note: 'Default apps domain.',
      },
    ],
  },
  {
    id: 'builds-images',
    title: 'Builds & images',
    docsUrl: DOCS.images,
    items: [
      { cmd: `oc start-build <buildconfig> --follow`, note: 'Start and stream a build.' },
      { cmd: `oc logs -f bc/<buildconfig>`, note: 'Build logs.' },
      { cmd: `oc get bc,builds,is`, note: 'Build and image inventory.' },
      { cmd: `oc describe is/<name>`, note: 'ImageStream tags, digests, pull spec.' },
      { cmd: `oc describe istag/<is>:<tag>`, note: 'One ImageStreamTag in detail.' },
      { cmd: `oc tag <source> <dest-is>:<tag>`, note: 'Create a permanent tag.' },
      { cmd: `oc tag --alias=true <source> <dest-is>:<tag>`, note: 'Create a tracking tag.' },
      {
        cmd: `oc import-image <istag> --from=<image> --confirm`,
        note: 'Import an external image.',
      },
      {
        cmd: `oc delete bc <name>`,
        note: 'Delete a BuildConfig (add --cascade=orphan to avoid cascading dependent objects).',
      },
    ],
  },
  {
    id: 'auth-rbac',
    title: 'Users, groups, RBAC',
    docsUrl: DOCS.auth,
    items: [
      {
        cmd: `htpasswd -c -B -b users.htpasswd <user> <password>`,
        note: 'Create the htpasswd file.',
      },
      {
        cmd: `oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config`,
        note: 'HTPasswd secret.',
      },
      { cmd: `oc edit oauth cluster`, note: 'Configure the OAuth CR (type HTPasswd).' },
      {
        cmd: `oc create user <name> --full-name="..."`,
        note: 'Create a User object (power user).',
      },
      {
        cmd: `oc delete user <name>; oc delete identity <provider>:<name>`,
        note: 'Remove a user completely.',
      },
      { cmd: `oc adm groups new <group> <users...>`, note: 'Create a group.' },
      { cmd: `oc adm groups add-users <group> <users...>`, note: 'Manage membership.' },
      {
        cmd: `oc adm policy add-role-to-user <role> <user> -n <ns>`,
        note: 'Namespace role binding.',
      },
      {
        cmd: `oc adm policy add-role-to-group <role> <group> -n <ns>`,
        note: 'Group role binding.',
      },
      {
        cmd: `oc adm policy add-cluster-role-to-user <role> <user>`,
        note: 'Cluster-wide role binding.',
      },
      {
        cmd: `oc create role <name> --verb=get,list,watch --resource=pods,configmaps -n <ns>`,
        note: 'Custom namespaced role (comma-separated --verb/--resource flags).',
      },
      { cmd: `oc auth can-i <verb> <resource> -n <ns>`, note: 'Check permissions.' },
      {
        cmd: `oc auth can-i list pods --as=system:serviceaccount:<ns>:<sa>`,
        note: 'Check as a service account.',
      },
    ],
  },
  {
    id: 'security-scc',
    title: 'Service accounts, SCC, app security',
    docsUrl: DOCS.auth,
    items: [
      { cmd: `oc create sa <name>`, note: 'Create a service account.' },
      { cmd: `oc create token <sa> [--duration 10m]`, note: 'Request a bound API token.' },
      { cmd: `oc set serviceaccount deployment <deploy> <sa>`, note: 'Run a workload as an SA.' },
      { cmd: `oc get scc`, note: 'List security context constraints.' },
      { cmd: `oc describe scc <name>`, note: 'Inspect an SCC.' },
      {
        cmd: `oc adm policy add-scc-to-user <scc> -z <sa>`,
        note: 'Grant an SCC to a service account.',
      },
      { cmd: `oc adm policy add-scc-to-group <scc> <group>`, note: 'Grant an SCC to a group.' },
      { cmd: `oc adm policy who-can use scc <scc>`, note: 'Who can use an SCC.' },
      { cmd: `oc auth can-i use scc/<scc>`, note: 'Check SCC RBAC only.' },
      { cmd: `oc create job <name> --image=<img> -- <cmd>`, note: 'One-time Job.' },
      {
        cmd: `oc create cronjob <name> --image=<img> --schedule='*/1 * * * *' -- <cmd>`,
        note: 'Scheduled Job.',
      },
    ],
  },
  {
    id: 'quotas-selfservice',
    title: 'Quotas & self-service',
    docsUrl: DOCS.quotas,
    items: [
      {
        cmd: `oc create quota <name> --hard=pods=4,requests.cpu=1,limits.memory=2Gi`,
        note: 'Project ResourceQuota.',
      },
      {
        cmd: `oc create quota <name> --hard=count/deployments.apps=2`,
        note: 'Object-count quota.',
      },
      {
        cmd: `oc create clusterquota <name> --project-label-selector=k=v --hard=pods=10`,
        note: 'ClusterResourceQuota by label.',
      },
      {
        cmd: `oc describe AppliedClusterResourceQuota -n <ns>`,
        note: 'Quota applied to a project.',
      },
      { cmd: `oc create -f examples/limitrange.yaml -n <ns>`, note: 'Create a LimitRange.' },
      { cmd: `oc get limits -n <ns>`, note: 'List LimitRanges.' },
      { cmd: `oc describe limits <name> -n <ns>`, note: 'Inspect limits/defaults.' },
      {
        cmd: `oc adm create-bootstrap-project-template -o yaml > template.yaml`,
        note: 'Generate the default project-request template (4.22: a fresh cluster has no stored template until you create one).',
      },
      {
        cmd: `oc create -f template.yaml -n openshift-config`,
        note: 'Store the customized project template.',
      },
      { cmd: `oc get templates -n openshift-config`, note: 'Stored project templates.' },
      {
        cmd: `oc edit project.config.openshift.io/cluster`,
        note: 'Point spec.projectRequestTemplate.name at project-request ($EDITOR=vi/vim on a real cluster; simulator opens the manifest editor).',
      },
      { cmd: `oc new-project <name>`, note: 'New projects inherit the template objects.' },
    ],
  },
  {
    id: 'operators',
    title: 'Operators (OLM)',
    docsUrl: DOCS.operators,
    items: [
      { cmd: `oc get packagemanifests -n openshift-marketplace`, note: 'Catalog packages.' },
      {
        cmd: `oc describe packagemanifests <operator> -n openshift-marketplace`,
        note: 'Channels/install modes.',
      },
      {
        cmd: `oc get operatorgroup -n <ns>`,
        note: 'Inspect OperatorGroups (required for SingleNamespace installs).',
      },
      {
        cmd: `oc apply -f examples/subscription.yaml`,
        note: 'Subscribe to an operator (shipped local example).',
      },
      { cmd: `oc get sub,csv,installplan -n <ns>`, note: 'Operator install status.' },
      { cmd: `oc describe sub <name> -n <ns>`, note: 'Conditions and installedCSV.' },
      {
        cmd: `oc delete subscription.operators.coreos.com <name> -n <ns>`,
        note: 'Uninstall: delete subscription.',
      },
      { cmd: `oc delete clusterserviceversion <csv> -n <ns>`, note: 'Delete the CSV.' },
    ],
  },
  {
    id: 'health-troubleshooting',
    title: 'Cluster health & troubleshooting',
    docsUrl: DOCS.nodes,
    items: [
      { cmd: `oc get nodes -o wide`, note: 'Node status/roles/IPs.' },
      { cmd: `oc get co`, note: 'ClusterOperator health.' },
      { cmd: `oc get clusteroperators authentication`, note: 'One operator in detail.' },
      { cmd: `oc get clusterversion`, note: 'Cluster version/channel.' },
      { cmd: `oc adm top nodes`, note: 'Node CPU/memory usage.' },
      { cmd: `oc adm top pods -A`, note: 'Pod resource usage.' },
      { cmd: `oc describe pod <pod>`, note: 'Status, containers and events.' },
      { cmd: `oc logs -f <pod> -c <container>`, note: 'Follow container logs.' },
      { cmd: `oc logs --previous <pod>`, note: 'Logs from the previous container instance.' },
      { cmd: `oc get events -n <ns>`, note: 'Recent events.' },
      { cmd: `oc debug deployment/<name>`, note: 'Debug a copy of the workload pod.' },
      { cmd: `oc debug node/<node>`, note: 'Root shell on a node.' },
      { cmd: `oc adm must-gather`, note: 'Collect diagnostics.' },
      { cmd: `oc adm inspect clusteroperator`, note: 'Namespace/operator dump.' },
      { cmd: `oc get network/cluster -o yaml`, note: 'Cluster network config.' },
      {
        cmd: `oc get ingresscontroller -n openshift-ingress-operator`,
        note: 'Ingress controller/router config.',
      },
    ],
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers / derived data
 * ──────────────────────────────────────────────────────────────────────────── */
export const EX280_OBJECTIVE_BULLETS = EX280_OBJECTIVE_GROUPS.flatMap((group) =>
  group.bullets.map((bullet) => ({
    ...bullet,
    groupId: group.id,
    groupTitle: group.title,
  }))
);

export const EX280_OBJECTIVE_COUNT = EX280_OBJECTIVE_BULLETS.length;

const OBJECTIVES_BY_ID = new Map(EX280_OBJECTIVE_BULLETS.map((bullet) => [bullet.id, bullet]));

export function getEX280ObjectiveById(id) {
  return OBJECTIVES_BY_ID.get(id) || null;
}

export function getEX280GroupById(id) {
  return EX280_OBJECTIVE_GROUPS.find((group) => group.id === id) || null;
}

export function levelTitle(levelId) {
  return EX280_LEVEL_TITLES[levelId] || `Campaign level ${levelId}`;
}

export function challengeTitle(challengeId) {
  return EX280_CHALLENGE_TITLES[challengeId] || `Challenge ${challengeId}`;
}
