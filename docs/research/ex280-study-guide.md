# EX280V422 Practical Study Guide — Commands, One-Screen Labs, and Game Mapping

**Verified 2026-11-03** against OpenShift Container Platform **4.22** docs and the official EX280V422 objectives. Companion to `ex280-objectives.md`; machine-readable data in `exam-facts.json`.

- Exam: **EX280V422 — Red Hat Certified Specialist in OpenShift Administration** (redhat.com page still says "Red Hat Certified System Administrator in OpenShift"), **3.0 h**, performance-based, based on **OCP 4.22**, configs must persist across reboot.
- Official objectives: <https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam> (accessed 2026-11-03)
- Objectives-by-version PDF (`EX280V422`): <https://training-lms.redhat.com/public_content/redhat/training/Red%20Hat%20Certification%20Exam%20Objectives%20by%20Version.pdf> (accessed 2026-11-03)
- Product docs base: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22>

Verification legend: commands without a marker come from OCP 4.22 documentation modules (openshift-docs branch `enterprise-4.22`) and docs pages were fetched HTTP 200 on 2026-11-03. Commands marked **†** are standard Kubernetes/`oc` patterns that did not appear verbatim in the fetched 4.22 doc modules — they are safe, but the game should not claim them as doc-verified.

---

## 1. How this guide maps to the game

The game target (internal design, see `docs/CONVERSION-SPEC.md` §9–11) is 20 campaign levels in 5 chapters, 12 challenges, and an EX280 Prep mode that tracks all 9 groups / 55 bullets with `docsUrl` links. Current repository data already provides the real sandbox scenarios: the shipped **20 OpenShift campaign levels**, **12 timed challenge labs**, and **36 incident definitions** in `js/data/IncidentDefs.js` (e.g. `CrashLoopBackOff`, `ImagePullBackOff`, `ResourceQuotaExceeded`, `LoadBalancerPending`, `RouteTLSCertificateError`, `UnauthorizedAccess`, `NetworkPolicyBlocking`, `RouteNotAdmitted`, `SecretExposed`, `JobDeadlineExceeded`, `CronJobMissedSchedule`; pre-conversion names such as `CertificateExpiry` and `IngressMisconfigured` still resolve through `LEGACY_INCIDENT_ALIASES`).

| EX280V422 group                         | Campaign levels                                                                                            | Timed labs                                                      | Useful incidents / game concepts                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Manage OpenShift Container Platform     | 1 Your First Project; 2 Query, Format, Filter; 3 Logs, Events & Health; 4 Declarative Manifests            | Fix CrashLoopBackOff; EX280 Speed Run                           | `CrashLoopBackOff`, `ImagePullBackOff`, `NodeNotReady`, `ServiceNoEndpoints`, `DeploymentStuckRollout` |
| Declarative Resource Management         | 4 Declarative Manifests; 5 Kustomize Base; 6 Kustomize Overlays; 7 Secrets & ConfigMaps                    | Kustomize Prod Overlay; EX280 Speed Run                         | `SecretExposed`, `DeploymentStuckRollout`; game "Files" panel + manifest apply                         |
| Deploy applications                     | 8 Templates & Helm; 9 Images, Builds & Image Streams; 10 Rolling Updates & Rollbacks; 11 Services & Routes | Three-Tier App; Build & Deploy from Source; Route with Edge TLS | `ImagePullBackOff`, `RouteNotAdmitted`, `ServiceNoEndpoints`, `DeploymentStuckRollout`                 |
| Manage authentication and authorization | 13 HTPasswd & Users; 14 Groups & RBAC                                                                      | RBAC for a New Teammate; HTPasswd Onboarding                    | `UnauthorizedAccess`                                                                                   |
| Configure network security              | 11 Services & Routes; 20 EX280 Final (NetworkPolicy step)                                                  | Network Isolation; Route with Edge TLS                          | `NetworkPolicyBlocking`, `DNSResolutionFailure`, `RouteTLSCertificateError`, `SCCForbidden`            |
| Expose non-HTTP/SNI Applications        | 12 Non-HTTP & Load Balancer                                                                                | Install an Operator                                             | `LoadBalancerPending`                                                                                  |
| Enable developer self-service           | 15 Quotas, LimitRanges & Templates                                                                         | Quota Guardrail                                                 | `ResourceQuotaExceeded`                                                                                |
| Manage OpenShift operators              | 12 Non-HTTP & Load Balancer; 18 Operators                                                                  | Install an Operator                                             | `OperatorInstallFailed`; Subscription/CSV resolution kinds in the conversion spec                      |
| Configure application security          | 16 Service Accounts & API Access; 17 SCC & Privileged Apps; 19 Jobs & CronJobs                             | SCC for a Privileged Workload; EX280 Speed Run                  | `UnauthorizedAccess`, `SecretExposed`, `JobDeadlineExceeded`, `CronJobMissedSchedule`                  |

**EX280 Prep quick labs (recommended set, from the conversion spec):** projects/login · users+OAuth login · edge route with TLS secret · BuildConfig→ImageStream→Deployment · Kustomize overlay · ResourceQuota+LimitRange · SCC grant · Operator subscription · Job+CronJob. Each quick lab should show the exact `oc` command, an "Open Red Hat docs" link from the table in §4, and check state with the ObjectiveEvaluator types (`project`, `login`, `route`, `tls`, `build`, `imageStream`, `kustomize`, `quota`, `limitRange`, `scc`, `operator`, `complete`, `cronJob`).

**Terminal rule for the conversion:** accept `oc` and `kubectl` prefixes while teaching/dispensing `oc` only (the legacy parser currently rejects a `kubectl` prefix even though hints say `kubectl …`).

---

## 2. Suggested 12-session study plan

| Session | Focus                                                                                                   | Game content                                                      |
| ------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1       | CLI, projects, web console, querying/formatting/filtering                                               | Levels 1–2                                                        |
| 2       | Logs, events, cluster health, troubleshooting workflow                                                  | Level 3; Fix CrashLoopBackOff challenge                           |
| 3       | Manifests, apply/update, export/import, labels/selectors, rollouts/rollbacks                            | Levels 4, 10; EX280 Speed Run (segment)                           |
| 4       | Secrets & ConfigMaps; consuming them via env/volumes                                                    | Level 7                                                           |
| 5       | Kustomize base + overlays                                                                               | Levels 5–6; Kustomize Prod Overlay challenge                      |
| 6       | Templates (parameters, process/apply) and Helm charts                                                   | Level 8                                                           |
| 7       | Images, ImageStreams, tags/digests, builds, triggers                                                    | Level 9; Build & Deploy from Source challenge                     |
| 8       | Services, routes, TLS edge/passthrough/reencrypt, route admission, non-HTTP LB/NodePort                 | Levels 11–12; Route with Edge TLS challenge                       |
| 9       | HTPasswd provider, users, groups, passwords, RBAC                                                       | Levels 13–14; HTPasswd Onboarding + RBAC challenges               |
| 10      | SCCs, privileged apps, service accounts, Kubernetes API access                                          | Levels 16–17; SCC for a Privileged Workload challenge             |
| 11      | ClusterResourceQuota/ResourceQuota/LimitRange/project templates/self-service; jobs + cronjobs           | Levels 15, 19, 20; Quota Guardrail + Network Isolation challenges |
| 12      | Operators; full timed mock (project→quota→template→build→route TLS→networkpolicy→RBAC→SCC→operator→job) | Level 20; EX280 Speed Run                                         |

Exam discipline to practise from session 1: no auto-completion hints, read `oc describe`/events before acting, and make state persistent (objects created via manifests, not one-off edits that a reboot would lose). The exam explicitly says configurations must persist.

---

## 3. Objective-by-objective drills

Each drill is one screen: what you should be able to do end-to-end without notes.

### 3.1 Manage OpenShift Container Platform

**Key commands**

```bash
oc login -u user1                      # interactive password or --token=<token>
oc whoami; oc whoami --show-context; oc status
oc new-project web --display-name="Web Team" --description="Web workloads"
oc projects; oc project web; oc delete project web
oc api-resources; oc explain pods.spec.containers
oc get pods -o wide
oc get deploy -o yaml
oc get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'
oc get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName
oc get pods -l app=web --show-labels
oc get pods --field-selector spec.nodeName=<node>          # verified doc example
oc get events -n web
oc logs -f <pod> -c <container>
oc logs deployment/web
oc get nodes -o wide; oc describe node <node>; oc adm top nodes; oc adm top pods
oc get co; oc get clusteroperators authentication          # ClusterOperator health
oc get clusterversion                                     # † standard cluster version check
oc describe pod <pod>                                      # Events section is the key
oc debug node/<node>; oc debug deployment/web
oc adm inspect clusteroperator; oc adm must-gather
```

**One-screen lab.** Log in as a normal user, create project `web`, deploy a two-container app from a manifest, break the image tag and fix it, then answer: which node is it on, why did the pod restart, which events fired, what does the ClusterOperator tree say, and where are the logs for each container. Ability to answer all six from `oc` output is the level-3 exit criterion.

**Common traps.** `oc logs` with multiple containers needs `-c`; `oc describe pod` Events not `oc get pods`; `oc get events` sorted by time (`--sort-by=.lastTimestamp` †); `oc debug node/X` shells the node via a privileged pod (SCC-sensitive), while `oc debug deployment/X` copies the workload's pod; ClusterOperator ≠ OLM operator (CVO-managed vs OLM-managed).

**Docs:** CLI tools <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index> · Nodes <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index> · Monitoring <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/monitoring/index> · Web console <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/web_console/index>

### 3.2 Declarative Resource Management

**Key commands**

```bash
oc create -f deployment.yaml; oc apply -f k8s/; oc delete -f deployment.yaml
oc get deployment web -o yaml > web.yaml      # export (oc export is removed)
oc replace -f web.yaml
oc edit deployment/web; oc patch deployment/web -p '{"spec":{"replicas":2}}' --type=merge
oc apply -k base/; oc kustomize overlays/prod
oc create configmap app-config --from-literal=APP_MODE=prod --from-file=config.properties
oc create secret generic db-secret --from-literal=username=app --from-literal=password='S3cret!'
oc create secret generic db-secret --from-literal=username=app --from-literal=password='S3cret!' \
  --dry-run=client -o yaml | oc apply -f -
oc create secret tls web-tls --cert=tls.crt --key=tls.key
oc set env deployment/web --from=secret/db-secret
```

Minimal Kustomize layout to be able to write on demand:

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
namespace: prod
images:
  - name: quay.io/example/web
    newTag: v2
replicas:
  - name: web
    count: 3
```

**One-screen lab.** Take a `base/` Deployment+Service, add a `prod` overlay that changes namespace, image tag, and replicas, apply it with `oc apply -k overlays/prod`, then prove the running Deployment has the overlay's image/replicas/namespace. Add an app secret and consume it as an env var; add a ConfigMap and mount it as a volume.

**Common traps.** `oc apply -f` does not accept a directory of overlays unless it has a `kustomization.yaml` (`oc apply -k`); strategic merge patches need the right target kind/name; a Deployment's `spec.selector` is immutable (re-create if labels must change); secrets are base64 not encrypted; do not put credentials in ConfigMaps.

**Docs:** Building applications <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index> · CLI tools <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index>

### 3.3 Deploy applications

**Key commands**

```bash
oc new-app https://github.com/sclorg/nodejs-ex.git --name=app
oc new-app --image=registry.redhat.io/ubi9/httpd-24:latest --name=web
oc new-app my-stream:v1
oc new-app --template=rails-postgresql-example --param=DATABASE_USER=app
oc process -f template.yaml --parameters
oc process -f template.yaml -p REPLICA_COUNT=3 | oc create -f -
oc get templates -n openshift
helm repo add openshift-helm-charts https://charts.openshift.io/; helm repo update
helm install example-vault openshift-helm-charts/hashicorp-vault   # verified docs example
helm list                                                          # verified docs example
oc get deploy,rs,pods
oc rollout status deployment/web; oc rollout history deployment/web
oc rollout undo deployment/web                                     # verified docs: deployment/abc
oc rollout restart deployment/web
oc set image deployment/web web=quay.io/example/web:v2
oc scale deployment/web --replicas=3                               # † (docs show dc/ examples)
oc set triggers deploy/example --from-image=example:latest -c web
oc label deployment/web tier=frontend
oc expose deployment/web --port=8080                               # † (docs show oc expose pod/ and oc expose svc/)
oc expose svc/web                                                  # creates an HTTP Route
```

**One-screen lab.** Deploy a Git-sourced app with `oc new-app --name`, watch the BuildConfig→Build→ImageStream→Deployment chain, attach a Service and a Route, change the image, watch `oc rollout status`, inspect ReplicaSets, roll back with `oc rollout undo`, then repeat the same deployment from a parameterized template and from a Helm chart.

**Common traps.** Image triggers on a Deployment are an `image.openshift.io/triggers` annotation managed by `oc set triggers` (DeploymentConfig used native triggers); `oc rollout undo` needs history; Services only select ready pods; `oc new-app` may create a Route only when it can infer one; `oc new-app` with an ImageStream name across projects needs pull permissions; Helm releases are cluster-scoped per namespace (`helm list -n`).

**Docs:** Building applications <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index> · Images <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/index> · Managing image streams <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/managing-image-streams> · Ingress and load balancing <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/index>

### 3.4 Manage authentication and authorization

**Key commands**

```bash
# HTPasswd provider
htpasswd -c -B -b users.htpasswd alice 'Passw0rd!'
oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config
oc apply -f oauth.yaml        # OAuth CR, config.openshift.io/v1, name cluster, type HTPasswd
oc login -u alice
# change password / add user
htpasswd -bB users.htpasswd alice 'NewPassw0rd!'
oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd \
  --dry-run=client -o yaml -n openshift-config | oc replace -f -
oc delete user alice; oc delete identity my_htpasswd_provider:alice
# users/groups (power user)
oc create user ajones --full-name="Adam Jones"
oc adm groups new web-team alice bob
oc adm groups add-users web-team carol
oc get groups; oc describe group web-team
# permissions
oc adm policy add-role-to-user edit alice -n web
oc adm policy add-cluster-role-to-user cluster-admin alice      # verified docs example
oc adm policy add-role-to-group view web-team -n web
oc policy add-role-to-user view system:serviceaccount:web:robot
oc auth can-i create pods -n web
oc auth can-i list pods --as=system:serviceaccount:dev:foo -n prod
oc adm policy who-can delete pods -n web
```

Minimal OAuth CR:

```yaml
apiVersion: config.openshift.io/v1
kind: OAuth
metadata:
  name: cluster
spec:
  identityProviders:
    - name: my_htpasswd_provider
      mappingMethod: claim
      type: HTPasswd
      htpasswd:
        fileData:
          name: htpass-secret
```

**One-screen lab.** Add two HTPasswd users, configure the OAuth provider, log in as one, create a group containing both, grant `edit` on a project to the group, prove with `oc auth can-i` and by acting as the user, then change one user's password and delete the other user (including User/Identity cleanup).

**Common traps.** OAuth CR is a cluster singleton named `cluster`; the htpasswd key in the secret must be `htpasswd`; existing users keep tokens until expiry unless User/Identity are deleted; `oc adm policy` is for bindings, `oc policy` also works for SA convenience; `mappingMethod: claim` for htpasswd users; roles `view/edit/admin` are namespace-scoped, `cluster-admin` is not; `oc auth can-i` answers for the current user unless `--as` is given.

**Docs:** Authentication and authorization <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index> · RBAC <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/using-rbac>

### 3.5 Configure network security

**Key commands**

```bash
oc get network/cluster -o yaml
oc get network/cluster -o jsonpath='{.status.clusterNetwork[*]}'
oc get ingresscontroller -n openshift-ingress-operator
oc get deployment -n openshift-ingress
oc get ingresses.config/cluster -o jsonpath={.spec.domain}
oc expose svc/web
oc create route edge web --service=web --hostname=web.apps.example.com --cert=tls.crt --key=tls.key
oc create route passthrough secure --service=secure --port=8443
oc create route reencrypt reenc --service=reenc --cert=tls.crt --key=tls.key --dest-ca-cert=destca.crt
oc get routes; oc get route web -o jsonpath='{.spec.host}'
oc -n openshift-ingress-operator patch ingresscontroller/default \
  --patch '{"spec":{"routeAdmission":{"namespaceOwnership":"InterNamespaceAllowed"}}}' --type=merge
oc apply -f deny-by-default.yaml
oc get networkpolicy; oc describe networkpolicy deny-by-default
```

Default-deny NetworkPolicy (verified YAML shape):

```yaml
kind: NetworkPolicy
apiVersion: networking.k8s.io/v1
metadata:
  name: deny-by-default
  namespace: web
spec:
  podSelector: {}
  ingress: []
```

Allow frontend→backend only:

```yaml
kind: NetworkPolicy
apiVersion: networking.k8s.io/v1
metadata:
  name: backend-allow-frontend
spec:
  podSelector:
    matchLabels: { app: backend }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: frontend }
      ports:
        - protocol: TCP
          port: 8080
```

Allow ingress-controller traffic (verified label key in docs project-template example uses `policy-group.network.openshift.io/ingress`; older label is `network.openshift.io/policy-group: ingress` — check the exact label for your cluster with `oc get ns openshift-ingress --show-labels` **†** and do not hand-apply reserved labels to custom namespaces):

```yaml
kind: NetworkPolicy
apiVersion: networking.k8s.io/v1
metadata:
  name: allow-from-openshift-ingress
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              policy-group.network.openshift.io/ingress: ''
```

DNS egress after default-deny (common OVN-K pattern; the DNS namespaces are `openshift-dns`/`openshift-dns-operator`, docs describe their own deny-by-default policies — this policy shape is a convention †):

```yaml
kind: NetworkPolicy
apiVersion: networking.k8s.io/v1
metadata:
  name: allow-dns-egress
spec:
  podSelector: {}
  policyTypes: [Egress]
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
```

**One-screen lab.** Isolate project `backend` with default-deny, allow only `frontend` pods to reach it on port 8080, allow its own DNS egress, prove with in-cluster `curl`/`wget` from both namespaces, then expose a service with an edge TLS route and verify the route is Admitted and serves HTTPS.

**Common traps.** Applying default-deny without DNS egress breaks resolution ("name resolution fails" after an isolation change); `namespaceSelector` matches namespace labels (use `kubernetes.io/metadata.name` for a named namespace); NetworkPolicy is additive only; passthrough routes cannot use path-based routing; edge routes need cert+key, reencrypt needs `destinationCACertificate`; `oc expose svc` creates an unsecured route (or uses a default cert only if cluster config says so) — secure routes need `oc create route`.

**Docs:** Network security <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/index> · Network policy <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/network-policy> · Routes <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes>

### 3.6 Expose non-HTTP/SNI Applications

**Key commands**

```bash
oc create service nodeport db --tcp=3306:3306
oc create service loadbalancer app --tcp=8081:8080
oc get svc app -o wide                 # EXTERNAL-IP
oc create route passthrough tls-app --service=tls-app --port=443
```

Service YAML (verified shape from docs LoadBalancer example):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: app-lb
spec:
  type: LoadBalancer
  selector:
    app: app
  ports:
    - name: http
      port: 8080
      targetPort: 8080
```

**One-screen lab.** Expose a non-HTTP TCP service two ways: NodePort, then LoadBalancer. On a bare-metal cluster, install MetalLB via the OperatorHub/Subscription route first so `LoadBalancer` gets an EXTERNAL-IP; verify with `oc get svc -o wide` and connect from outside the cluster. Also expose a TLS server with a passthrough route and confirm the client sees the backend certificate.

**Common traps.** Routes only handle HTTP/HTTPS/SNI — TCP/UDP needs NodePort/LoadBalancer/ExternalIP; NodePort range 30000–32767; `oc expose svc` is the wrong tool for non-HTTP; MetalLB is required for LoadBalancer on on-prem/bare metal; source-range restrictions may need the IngressController's allowed source ranges rather than `loadBalancerSourceRanges` (docs note).

**Docs:** Ingress and load balancing <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/index> · Operators <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/index>

### 3.7 Enable developer self-service

**Key commands**

```bash
oc create quota compute-quota --hard=pods=4,requests.cpu=1,requests.memory=1Gi,limits.cpu=2,limits.memory=2Gi
oc create quota core-objects --hard=configmaps=10,secrets=10,services=10,count/deployments.apps=2
oc describe quota compute-quota -n web
oc create clusterquota team-quota --project-label-selector=team=web --hard=pods=10 --hard=secrets=20
oc create clusterresourcequota for-name --project-label-selector=name=frontend --hard=pods=10
oc describe AppliedClusterResourceQuota -n web
oc adm policy remove-cluster-role-from-group self-provisioner system:authenticated:oauth   # † disable self-provisioning
oc describe clusterrolebinding.rbac self-provisioners
oc patch clusterrolebinding.rbac self-provisioners -p '{"subjects": null}'
# project templates (a fresh 4.22 cluster has no stored template):
oc adm create-bootstrap-project-template -o yaml > template.yaml
oc create -f template.yaml -n openshift-config
oc edit project.config.openshift.io/cluster    # spec.projectRequestTemplate.name: project-request
oc new-project template-check                  # verify the template objects are inherited
```

LimitRange (verified docs YAML, trimmed):

```yaml
apiVersion: 'v1'
kind: 'LimitRange'
metadata:
  name: 'resource-limits'
spec:
  limits:
    - type: 'Container'
      max: { cpu: '2', memory: '1Gi' }
      min: { cpu: '100m', memory: '4Mi' }
      default: { cpu: '300m', memory: '200Mi' }
      defaultRequest: { cpu: '200m', memory: '100Mi' }
```

**One-screen lab.** Cap a project with a compute ResourceQuota, deploy above the quota and read the admission error, then add a LimitRange so pods get default requests/limits automatically. Create a ClusterResourceQuota for all projects with a label, then generate a custom project template (`oc adm create-bootstrap-project-template -o yaml`), add a NetworkPolicy object, create it in `openshift-config`, wire it through `project.config.openshift.io/cluster` and prove a new project inherits it. Finally disable self-provisioning and confirm `oc new-project` is denied for a normal user.

**Common traps.** Once a compute quota exists, pods must set requests/limits (or a LimitRange default must supply them); quota admission errors mention the exceeded resource; scopes (`BestEffort`, `NotTerminating`, `Terminating`) matter; ClusterResourceQuota is cluster-scoped and selected by project labels/annotations; a fresh 4.22 cluster has no stored project template — generate one with `oc adm create-bootstrap-project-template`, create it in `openshift-config`, and point `project.config.openshift.io/cluster` at it (`spec.projectRequestTemplate.name`); self-provisioner role binding is protected — patch the binding annotation before removing subjects.

**Docs:** Using quotas and limit ranges <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/scalability_and_performance/compute-resource-quotas> · Building applications <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index>

### 3.8 Manage OpenShift operators

**Key commands**

```bash
oc get packagemanifests -n openshift-marketplace
oc describe packagemanifests <operator_name> -n openshift-marketplace
oc apply -f operatorgroup.yaml
oc apply -f subscription.yaml
oc get sub,csv,installplan -n <namespace>
oc describe sub <subscription_name> -n <namespace>
oc get csv -n <namespace>
oc delete subscription.operators.coreos.com <subscription_name> -n <namespace>
oc delete clusterserviceversion <csv_name> -n <namespace>
oc get catalogsources -n openshift-marketplace
```

OperatorGroup (SingleNamespace, verified docs YAML):

```yaml
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: web-operators
  namespace: web
spec:
  targetNamespaces:
    - web
```

Subscription (verified docs YAML):

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: <subscription_name>
  namespace: <namespace>
spec:
  channel: stable
  name: <operator_name>
  source: redhat-operators
  sourceNamespace: openshift-marketplace
  installPlanApproval: Automatic
```

**One-screen lab.** Install an operator through the web console (OperatorHub → Install → AllNamespaces or SingleNamespace), then repeat the equivalent from CLI: OperatorGroup + Subscription, watch InstallPlan, wait for CSV `Succeeded`, verify a CR/operand exists. Uninstall from the console, then repeat from CLI: delete Subscription, delete CSV, confirm the CSV and operands are gone.

**Common traps.** `AllNamespaces` operators go into `openshift-operators` (existing `global-operators` OperatorGroup); `SingleNamespace` needs its own OperatorGroup in that namespace (only one per namespace); operator pods are created by OLM, not by your manifests; manual approval (`installPlanApproval: Manual`) requires approving the InstallPlan (web console is the documented path; CLI is `oc patch installplan <name> -n <ns> --type=merge -p '{"spec":{"approved":true}}'` †); deleting an operator means Subscription + CSV cleanup, not deleting the OperatorGroup of a shared namespace blindly; ClusterOperators (CVO) are not OLM subscriptions.

**Docs:** Operators <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/index>

### 3.9 Configure application security

**Key commands**

```bash
# service accounts
oc create sa robot
oc describe sa robot
oc get sa
oc create token robot
oc create token robot --duration 10m
oc set serviceaccount deployment nginx-deployment serviceaccount1
oc adm policy add-role-to-user view -z robot -n web
oc auth can-i list pods --as=system:serviceaccount:web:robot -n web
# SCC
oc get scc
oc describe scc restricted-v2
oc adm policy add-scc-to-user privileged -z robot -n web
oc adm policy add-scc-to-group anyuid system:serviceaccounts:web
oc adm policy who-can use scc privileged
oc auth can-i use scc/privileged --as=system:serviceaccount:web:robot
oc get pod <pod> -o jsonpath='{.metadata.annotations.openshift\.io/scc}'
# secrets
oc create secret generic api-key --from-literal=token=abc123
oc set env deployment/web --from=secret/api-key
# jobs / cronjobs
oc create job pi --image=perl -- perl -Mbignum=bpi -wle 'print bpi(2000)'
oc create cronjob pi --image=perl --schedule='*/1 * * * *' -- perl -Mbignum=bpi -wle 'print bpi(2000)'
oc get jobs,cronjobs; oc logs job/pi
```

Privileged workload (needs an SCC that allows it):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: privileged-app
spec:
  replicas: 1
  selector:
    matchLabels: { app: privileged-app }
  template:
    metadata:
      labels: { app: privileged-app }
    spec:
      serviceAccountName: robot
      containers:
        - name: app
          image: quay.io/example/priv-app:latest
          securityContext:
            privileged: true
```

Job (verified docs YAML, trimmed) and CronJob:

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: pi }
spec:
  parallelism: 1
  completions: 1
  backoffLimit: 6
  template:
    spec:
      containers:
        - name: pi
          image: perl
          command: ['perl', '-Mbignum=bpi', '-wle', 'print bpi(2000)']
      restartPolicy: OnFailure
```

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: pi }
spec:
  schedule: '*/1 * * * *'
  concurrencyPolicy: 'Replace'
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: pi
              image: perl
              command: ['perl', '-Mbignum=bpi', '-wle', 'print bpi(2000)']
          restartPolicy: OnFailure
```

**One-screen lab.** Create SA `robot`, bind a `view` Role, create a token, use it against the API (`oc auth can-i` / `curl -H "Authorization: Bearer …"`), then deploy an app that needs root: observe the `Forbidden … security context constraint` error, grant an appropriate SCC (`anyuid`/custom), verify the pod's `openshift.io/scc` annotation, and clean up by removing the SCC from the SA (or deleting the SA). Finish by running a one-time Job and a CronJob and proving Job completion.

**Common traps.** `privileged: true` only works if an SCC allows it — grant to the workload's service account, not `default`, when possible; do not edit default SCCs (upgrade overwrites); `restricted-v2` is granted to all authenticated users; adding a securityContext that violates the SCC gives admission failures, not image errors; long-lived SA token Secrets no longer auto-created since 4.16 — use `oc create token`/projected tokens; Jobs need `restartPolicy: Never|OnFailure`; a Job with `activeDeadlineSeconds` that fires gets failed; CronJob `startingDeadlineSeconds`/`suspend`/history limits are common edits.

**Docs:** Authentication and authorization (SCC, service accounts) <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index> · Service accounts <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-creating-service-accounts> · Nodes (jobs/cronjobs) <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index>

---

## 4. Command cheat sheet (OCP 4.22-verified flags)

### CLI / context

| Task               | Command                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Log in             | `oc login -u <user>`, `oc login --token=<token>`, `oc login <server>`                                                                            |
| Identity/context   | `oc whoami`, `oc whoami --show-context`, `oc status`, `oc config view` **†**                                                                     |
| Projects           | `oc new-project <p> --display-name="…" --description="…"`, `oc projects`, `oc project <p>`, `oc delete project <p>`                              |
| API discovery      | `oc api-resources`, `oc explain <kind>.<field>`, `oc explain pods --recursive`                                                                   |
| Output formats     | `-o wide`, `-o yaml`, `-o json`, `-o jsonpath=…`, `-o go-template=…`, `-o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName`                |
| Select/filter/sort | `-l/--selector app=web`, `--field-selector spec.nodeName=<node>`, `--sort-by=.metadata.creationTimestamp` **†**, `-A`, `-n <ns>`                 |
| Import/export      | `oc create -f`, `oc apply -f`, `oc replace -f`, `oc delete -f`, `oc get <kind>/<name> -o yaml > file`, `oc apply -k <dir>`, `oc kustomize <dir>` |

### Workloads

| Task                                    | Command                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Note_                                  | 4.22 docs show `oc set probe`/`oc set volume` examples on DeploymentConfig (`dc/`); the same flags apply to `deployment/` pod-template objects.                                                                                                                                                                               |
| Create app                              | `oc new-app <git-url> --name=<name>`, `oc new-app --image=<image> --name=<name>`, `oc new-app <is>:<tag>`, `oc new-app --template=<t> --param=K=V`, `oc new-app --file=<template> --param=K=V`                                                                                                                                |
| Deploy                                  | `oc apply -f deployment.yaml`, `oc create deployment` **†** (prefer manifests)                                                                                                                                                                                                                                                |
| Scale                                   | `oc scale deployment/<name> --replicas=<n>` **†** (docs use `dc/`)                                                                                                                                                                                                                                                            |
| Image update                            | `oc set image deployment/<name> <container>=<image>`                                                                                                                                                                                                                                                                          |
| Env / resources / probes / SA / volumes | `oc set env deployment/<name> K=V`, `oc set resources deployment <name> -c=<c> --limits=cpu=200m,memory=512Mi`, `oc set probe dc/<name> --readiness --get-url=http://:8080/healthz`, `oc set serviceaccount deployment <deploy> <sa>`, `oc set volume deployment/<name> --add --name=v1 -t pvc --claim-name=pvc1 --overwrite` |
| Rollouts                                | `oc rollout status deployment/<name>`, `oc rollout history deployment/<name>`, `oc rollout undo deployment/<name>`, `oc rollout restart deployment/<name>`                                                                                                                                                                    |
| Triggers                                | `oc set triggers deploy/<name> --from-image=<project>/<is>:<tag> -c <container>`                                                                                                                                                                                                                                              |
| Logs                                    | `oc logs -f <pod> -c <container>`, `oc logs deployment/<name>`, `oc logs --previous` **†**, `oc logs -f bc/<buildconfig>`                                                                                                                                                                                                     |

### Builds & images

| Task         | Command                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Builds       | `oc start-build <buildconfig> --follow`, `oc start-build <bc> --from-repo=../repo --commit=v2`, `oc logs -f bc/<name>`, `oc delete bc <name>` (add `--cascade=false` to keep builds)                         |
| ImageStreams | `oc get is -n openshift`, `oc describe is/<name>`, `oc describe istag/<is>:<tag>`, `oc tag <src> <is>:<tag>`, `oc tag --alias=true ruby:2.0 ruby:latest`, `oc import-image <istag> --from=<image> --confirm` |
| Image lookup | `oc set image-lookup deploy/mysql`, `oc set image-lookup imagestream --list`                                                                                                                                 |

### Networking

| Task            | Command                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Services        | `oc expose deployment/<name> --port=<port>`, `oc create service clusterip\|nodeport\|loadbalancer` **verified forms:** `oc create service clusterip my-cs --tcp=5678:8080`, `oc create service nodeport my-ns --tcp=5678:8080`, `oc create service loadbalancer my-lbs --tcp=5678:8080`                                                                                         |
| Routes          | `oc expose svc/<name>`, `oc expose service nginx --hostname=www.example.com --path=/nginx`, `oc create route edge --service=<svc> --cert=tls.crt --key=tls.key --ca-cert=ca.crt --hostname=<host>`, `oc create route passthrough <name> --service=<svc> --port=8080`, `oc create route reencrypt <name> --service=<svc> --cert=tls.crt --key=tls.key --dest-ca-cert=destca.crt` |
| Route facts     | default domain: `oc get ingresses.config/cluster -o jsonpath={.spec.domain}`; host: `oc get route <name> -o jsonpath='{.spec.host}'`                                                                                                                                                                                                                                            |
| NetworkPolicy   | `oc apply -f <policy>.yaml -n <ns>`, `oc get networkpolicy`, `oc describe networkpolicy <name>`, `oc delete -f <policy>.yaml`                                                                                                                                                                                                                                                   |
| Cluster network | `oc get network.config/cluster`, `oc get network/cluster -o jsonpath='{.status.clusterNetwork[*]}'`, `oc get ingresscontroller -n openshift-ingress-operator`, `oc get deployment -n openshift-ingress`                                                                                                                                                                         |

### Authn/authz/security

| Task             | Command                                                                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RBAC             | `oc adm policy add-role-to-user <role> <user> -n <ns>`, `add-role-to-group`, `add-cluster-role-to-user`, `remove-role-from-user`, `remove-cluster-role-from-user`; `oc create role <name> --verb=get --resource=pod -n <ns>`; `oc create clusterrole <name> --verb=get --resource=pod` |
| Verify           | `oc auth can-i <verb> <resource>`, `oc auth can-i list pods --as=system:serviceaccount:<ns>:<sa> -n <ns>`, `oc adm policy who-can <verb> <resource>`                                                                                                                                   |
| Groups/users     | `oc adm groups new <g> <users...>`, `oc adm groups add-users`, `oc adm groups remove-users`, `oc create user <name> --full-name="…"`, `oc delete user`, `oc delete identity <provider>:<user>`                                                                                         |
| HTPasswd         | `htpasswd -c -B -b users.htpasswd <user> <pw>`, `oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config`, `oc apply -f oauth.yaml`                                                                                                             |
| Service accounts | `oc create sa <name>`, `oc create token <sa> [--duration 10m]`, `oc policy add-role-to-user <role> -z <sa>`, `oc set serviceaccount deployment <deploy> <sa>`                                                                                                                          |
| SCCs             | `oc get scc`, `oc describe scc <name>`, `oc adm policy add-scc-to-user <scc> -z <sa>`, `oc adm policy add-scc-to-group <scc> <group>`, `oc adm policy who-can use scc <scc>`, `oc auth can-i use scc/<scc>`                                                                            |
| Secrets          | `oc create secret generic <n> --from-literal=K=V --from-file=<key>=<path>`, `oc create secret tls <n> --cert=tls.crt --key=tls.key`, `oc create secret docker-registry …`, `--dry-run=client -o yaml`, `oc set env deployment/<d> --from=secret/<n>`                                   |
| ConfigMaps       | `oc create configmap <n> --from-literal=K=V --from-file=<path> --from-env-file=file.env`                                                                                                                                                                                               |

### Quotas, jobs, operators

| Task          | Command                                                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project quota | `oc create quota <n> --hard=pods=4,requests.cpu=1,limits.memory=2Gi`, `oc describe quota <n>`, `oc get quota`                                                                                                                                                           |
| Cluster quota | `oc create clusterquota <n> --project-label-selector=k=v --hard=pods=10`, `oc create clusterresourcequota <n> --project-annotation-selector=<k>=<v> --hard=pods=10`, `oc describe AppliedClusterResourceQuota`                                                          |
| LimitRange    | `oc create -f limitrange.yaml -n <ns>`, `oc get limits`, `oc describe limits <n> -n <ns>`                                                                                                                                                                               |
| Jobs          | `oc create job <n> --image=<img> -- <cmd>`, `oc get jobs`, `oc logs job/<n>`                                                                                                                                                                                            |
| CronJobs      | `oc create cronjob <n> --image=<img> --schedule='*/1 * * * *' -- <cmd>`, `oc get cronjobs`                                                                                                                                                                              |
| Operators     | `oc get packagemanifests -n openshift-marketplace`, `oc apply -f operatorgroup.yaml`, `oc apply -f subscription.yaml`, `oc get sub,csv,installplan -n <ns>`, `oc delete subscription.operators.coreos.com <n> -n <ns>`, `oc delete clusterserviceversion <csv> -n <ns>` |
| Health        | `oc get nodes -o wide`, `oc get co`, `oc adm top nodes`, `oc adm top pods`, `oc get events`, `oc adm must-gather`, `oc adm inspect clusteroperator`, `oc debug node/<node>`                                                                                             |

---

## 5. Common traps that cost points on performance exams

1. **Persistence.** Anything you create imperatively (`oc run`, `oc create` without a saved manifest) still counts, but edits that rely on a pod staying alive don't survive; use controllers/manifests. Exam performance rule is explicit about persistence.
2. **Wrong project.** Almost every object is namespace-scoped; `oc project <ns>` or `-n` on every command. Check `oc project` before debugging "missing" resources.
3. **Read before you fix.** Events + `oc describe` first; restarting/deleting blindly loses evidence and may cascade.
4. **SCC vs securityContext.** A pod spec that requests privileged/root/capabilities must be admitted by an SCC granted to the pod's service account. Default SCC edits are reverted on upgrade.
5. **DeploymentConfig habits.** If you learned old DO280 material: `oc rollout undo dc/<name>`, `oc set triggers dc/...` still exist, but new manifests should use apps/v1 Deployment; `oc logs -f dc/<name>` works for legacy only.
6. **`oc export` does not exist.** Export with `oc get ... -o yaml`.
7. **SA tokens.** Don't expect a token Secret to appear on `oc describe sa`; use `oc create token`.
8. **Routes vs Services.** Routes attach to a Service; Services select pods; a Route with no endpoints shows errors in `oc describe route`/`oc get routes`. Edge can use a supplied cert+key or fall back to the router's default certificate; reencrypt needs a destination CA.
9. **NetworkPolicy default-deny breaks DNS and ingress.** Allow DNS egress and ingress-controller traffic explicitly.
10. **Quota requires requests/limits.** After a compute quota, pods without requests/limits are rejected unless a LimitRange supplies defaults.
11. **Templates are namespace-scoped.** To make one available to developers, it must be in their project's namespace or the `openshift` namespace. The project-creation template is separate: a fresh 4.22 cluster stores none; generate one with `oc adm create-bootstrap-project-template`, create it in `openshift-config`, and reference it from `project.config.openshift.io/cluster`.
12. **ClusterOperator ≠ OLM operator.** `oc get co` is CVO health; `oc get csv/sub` is OLM.
13. **Verify, don't assume.** For every task: `oc get` the object, `oc describe` it, and test the externally visible behavior (curl route, connect NodePort, run job to completion).

---

## 6. Not on EX280V422 (don't over-invest)

- **Storage deep dive** (PV/PVC lifecycle, storage classes, CSI details, StatefulSets as a study section) — removed as an explicit objective vs V412K. Keep only what manifests need (e.g. a PVC referenced by a template, a ConfigMap/Secret volume).
- **Reliability deep dive** (standalone health probes, HPA, compute limits as their own section) — removed as an explicit section vs V412K; probes/requests may still appear inside manifests.
- **Cluster updates** (OCP upgrade, deprecated-API audit, operator updates) — removed from V422; DO280's older chapter on updates is not an exam objective.
- **Building custom S2I builder images, Jenkins, Pipelines, GitOps** — not in the objective text; do not prioritize.
- **Advanced ingress**: router sharding, HSTS policies, gateway API, MetalLB BGP/VRF — beyond the objective wording; know only the basics needed for "load balancer service" and "external application access".

---

## 7. Verification notes / gaps

- All docs links above were fetched 2026-11-03; guide index pages and the specific chapter pages linked in the table returned HTTP 200. Some deeper topics link the guide index rather than a chapter because published chapter slugs are not always the source filename.
- Commands marked **†** are standard `oc`/`kubectl` patterns not found verbatim in the fetched OCP 4.22 modules; they are safe to teach but the game's "verified from docs" claim should exclude them.
- Passing score/validity: not published on the exam page; program guide could not be extracted — see `exam-facts.json.scoring_and_validity`.
- Current official DO280 outline could not be fetched (redhat.com DO280 page 404, 2026-11-03); partner outline (OCP 4.14-based) was used only as a sanity check and is flagged as stale.
- The game mapping table is based on the internal `docs/CONVERSION-SPEC.md` curriculum contract, not an external source; if the Lead changes level/challenge IDs, only that table needs updating.
