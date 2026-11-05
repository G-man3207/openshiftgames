# OpenShift Games — Conversion Specification (v1)

> **Documentation note (2026-11-04).** Learner-facing documentation now lives in the
> [GitHub wiki](https://github.com/G-man3207/openshiftgames/wiki): the EX280 Study Guide and the
> in-app EX280 Prep reference moved there from `docs/EX280-STUDY-GUIDE.md` and `docs/EXAM-PREP.md`.
> This spec, the architecture map, the declarative-engine guide, the research notes and the
> verification report remain in `docs/` as engineering records.

Status: **implemented (v1.0.0, 2026-11-03)** — authoritative build contract for the Kubernetes→OpenShift conversion. Final verification results: see `docs/verification-report.md`.
Owner: Team Lead. All conversion work MUST conform to this document. If something here is
wrong or impossible, message the Lead before changing course.

Repo: `/root/openshiftgames` (currently a GitHub fork of `rohitg00/k8sgames`, Apache-2.0).
Target: a standalone, rebranded, open-source **OpenShift Games** that teaches Red Hat
OpenShift Container Platform **4.22** and is useful preparation for **EX280 (Red Hat
Certified Specialist in OpenShift Administration, exam version EX280V422)**.

Authoritative external sources (see `docs/research/` for the details and citations):

- Exam objectives: https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam
  and the "Exam Objectives by Version" PDF (EX280V422).
- Product docs: https://docs.redhat.com/en/documentation/openshift_container_platform/4.22
- Current exam = EX280V422, 3 hours, performance-based; configs must persist across reboot.
- Current OCP docs = 4.22 (4.23 not published at time of writing).

---

## 0. Definition of done

1. No Kubernetes-branded product copy remains in the UI/README. `kubectl` is accepted only as an
   input alias in the terminal with an educational note; the game teaches and displays `oc`.
2. The game teaches the full EX280V422 objective set through campaign levels, challenges and the
   in-app EX280 Prep mode. Every V422 objective bullet is mapped to at least one level/challenge in
   `js/data/EX280Objectives.js` and the mapping is validated by the verifier.
3. New OpenShift resources are first-class in the model, palette, 3D renderer, inspector, draw mode,
   YAML export and command bar: Project, Route, BuildConfig, Build, ImageStream, Template,
   Subscription (Operator), SCC, ClusterResourceQuota, LimitRange, User, Group, OAuth,
   ClusterOperator, ClusterVersion, IPAddressPool, L2Advertisement.
4. Declarative workflows are playable: YAML apply, Kustomize overlays, Helm chart install, OpenShift
   templates with parameters, HTPasswd identity provider + login, SCC grants, quotas.
5. `scripts/verify.mjs` and `scripts/browser-test.mjs` pass; browser console has no errors on
   index/draw/EX280 Prep; screenshots are regenerated.
6. Git is detached: no `upstream` remote, fresh standalone history, NOTICE attribution to K8s Games,
   README credits the original project, no `rohitg00/k8sgames`/`k8sgames.com` links outside attribution.
7. Everything remains dependency-free vanilla ES modules + CDN Three.js 0.152 / Tailwind CDN. No build
   step, no bundler, no new npm dependencies in the repo.

---

## 1. Branding, URLs, storage keys, copy

| Item                 | Value                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Product name         | **OpenShift Games**                                                                                                    |
| Tagline              | Learn OpenShift by playing. Built for EX280.                                                                           |
| Menu subtitle        | OpenShift 4.22 Cluster Simulation · Built for EX280                                                                    |
| Repo                 | https://github.com/G-man3207/openshiftgames                                                                            |
| Canonical demo URL   | https://shifting.pro (used for og:url / og:image; README notes how to change)                                          |
| License              | Apache-2.0 (keep `LICENSE`), add `NOTICE`                                                                              |
| Command prompt       | `$ oc` (accepted input: optional leading `oc` or `kubectl`; both stripped; help says `oc`)                             |
| localStorage prefix  | `openshiftgames_` (settings key `openshiftgames_settings`, progress key `openshiftgames_progress`)                     |
| YAML export filename | `openshiftgames-cluster.yaml`                                                                                          |
| Draw page            | `/draw` → `draw.html`, title "OpenShift Draw — 3D OpenShift Architecture Diagram", watermark "OpenShift Games · /draw" |
| Theme accent         | OpenShift red `#EE0000` for brand accents / OpenShift-specific meshes; existing status colors stay                     |

Required copy:

- `<title>OpenShift Games — Learn OpenShift by Playing (EX280)</title>`
- meta description: `Learn Red Hat OpenShift by playing. Deploy apps with oc, fix CrashLoopBackOff, expose Routes, build with S2I, configure SCC/quota/RBAC — a 3D cluster simulator built for the EX280 exam.`
- og/twitter titles/descriptions mirror the above; og:url `https://shifting.pro`; og:image `https://shifting.pro/og-image.png`; twitter card summary_large_image.
- Menu footer: `Built for EX280 · based on K8s Games by Rohit (Apache-2.0) · OpenShift is a trademark of Red Hat, Inc.`
- README disclaimer: unofficial fan/education project, not affiliated with or endorsed by Red Hat; OpenShift and Red Hat are trademarks of Red Hat, Inc.

Attribution requirements (Apache-2.0):

- `NOTICE` file at repo root: derivative-work statement, original project name/URL/copyright line "K8s Games, Copyright (c) Rohit G / rohitg00", Apache-2.0.
- README "Credits & license" section with the same attribution and a link to the original repo.
- Footer credit link to https://github.com/rohitg00/k8sgames is allowed (only attribution links may reference upstream).

Forbidden outside attribution contexts: `k8sgames.com`, `rohitg00/k8sgames`, `K8s Games`, `Kubernetes Cluster Simulation`, `kubectl` UI copy (except the alias note), `K8S_BLUE` naming (rename constant), old GitHub badge fetch URLs.

---

## 2. Version target and content accuracy rules

- Target OCP **4.22**. Use apiVersions/commands from `docs/research/openshift-*.md`.
- Every level/challenge that teaches a task must show the real `oc` command and a "Learn more" link
  to a docs.redhat.com 4.22 page. These links live in level/challenge data (`docsLinks`).
- Where OpenShift behavior differs from upstream Kubernetes, teach the OpenShift behavior
  (Projects not Namespaces in UX, Routes not Ingress primarily, Deployment preferred over
  DeploymentConfig, SCCs for pod security, HTPasswd/OAuth for users, ClusterResourceQuota).
- Do not invent flags. If unsure, use the research docs; if still unsure, use a plain
  `oc apply -f` manifest or `oc edit`, and ask the Lead.
- The game is a simulator: it is acceptable to simplify mechanics, but the command syntax, resource
  kinds, apiVersions, field names and success/error semantics shown to the player must match 4.22.

---

## 3. Resource model — authoritative kind catalog

**Central registry (mandatory):** `js/data/kindRegistry.js` is the single source of truth for kinds,
apiVersions, scope, aliases, `oc get` columns, palette metadata, minimap sizes, default specs,
owner chains, explain text, and the shared manifest serializer (`toManifestObject`). It exports
`RESOURCE_KINDS`, `CLUSTER_SCOPED_KINDS`, `PLACEABLE_KINDS`, `KIND_ALIASES`, `RESOURCE_TYPES`,
`PALETTE_SECTIONS`, `apiVersionForKind`, `isClusterScopedKind`, `normalizeKind`, `createResource`,
`defaultSpecForKind`, `columnsForKind`, `explainForKind`, `minimapSize`, `toManifestObject`.
All 13+ previously hard-coded kind lists MUST derive from it. resources-dev owns finalisation of
`createResource()` so it returns rich subclasses (currently returns a plain ResourceBase fallback).
No owner may add a new kind without adding it to the registry first.

Unify the three resource-creation paths (architecture map §2.5): every path (palette, command bar,
mode setup, controllers, draw page) must go through the registry factory so UIDs, apiVersions,
defaults and rich `toYAML()`/`toDescribe()` behave identically. `ClusterState.addResource` must honour
a supplied `metadata.uid` (draw page position bug) and must not downgrade rich instances.

Cluster-scoped kinds (`isClusterScopedKind(kind) === true`): Node, Project, PersistentVolume,
StorageClass, ClusterRole, ClusterRoleBinding, SecurityContextConstraints, ClusterResourceQuota,
User, Group, ClusterOperator, ClusterVersion, OAuth.

Namespaced kinds (metadata.namespace required; default "default" = current project):
Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, CronJob, Service, Route, Ingress,
NetworkPolicy, ConfigMap, Secret, PersistentVolumeClaim, HorizontalPodAutoscaler,
PodDisruptionBudget, Role, RoleBinding, ServiceAccount, ResourceQuota, LimitRange, BuildConfig,
Build, ImageStream, Template, Subscription, IPAddressPool, L2Advertisement.

`Namespace` is retired as a game kind. All UI/data uses **`Project`**. Internal namespaced resources
keep `metadata.namespace` (a Project name). Commands may still accept `namespace`/`ns` as aliases for
`project`/`projects` where `oc` does.

### 3.1 API versions (single source of truth)

| Kind                             | apiVersion                    | Scope                    | Status model                                                                  |
| -------------------------------- | ----------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| Pod                              | v1                            | ns                       | phase Pending/Running/Succeeded/Failed, containerStatuses                     |
| Deployment                       | apps/v1                       | ns                       | replicas, readyReplicas, updatedReplicas, conditions Available/Progressing    |
| ReplicaSet                       | apps/v1                       | ns                       | replicas, readyReplicas                                                       |
| StatefulSet                      | apps/v1                       | ns                       | replicas, readyReplicas, currentRevision                                      |
| DaemonSet                        | apps/v1                       | ns                       | desiredNumberScheduled, numberReady                                           |
| Job                              | batch/v1                      | ns                       | phase Pending/Running/Complete/Failed, succeeded/failed                       |
| CronJob                          | batch/v1                      | ns                       | suspend, lastScheduleTime, active[]                                           |
| Service                          | v1                            | ns                       | type, clusterIP, ports, selector, loadBalancer.ingress                        |
| Route                            | route.openshift.io/v1         | ns                       | spec.host/path/to/tls/port, status.ingress[].conditions Admitted              |
| Ingress                          | networking.k8s.io/v1          | ns                       | rules, tls                                                                    |
| NetworkPolicy                    | networking.k8s.io/v1          | ns                       | podSelector, ingress[], egress[], policyTypes                                 |
| ConfigMap                        | v1                            | ns                       | data, binaryData                                                              |
| Secret                           | v1                            | ns                       | type, data (displayed decoded in simulator), stringData                       |
| PersistentVolumeClaim            | v1                            | ns                       | phase Pending/Bound/Lost, capacity                                            |
| PersistentVolume                 | v1                            | cluster                  | phase Available/Bound/Released, capacity, accessModes, storageClassName       |
| StorageClass                     | storage.k8s.io/v1             | cluster                  | provisioner, reclaimPolicy, volumeBindingMode                                 |
| HorizontalPodAutoscaler          | autoscaling/v2                | ns                       | currentReplicas, desiredReplicas, conditions                                  |
| PodDisruptionBudget              | policy/v1                     | ns                       | minAvailable/maxUnavailable, disruptionsAllowed                               |
| ResourceQuota                    | v1                            | ns                       | hard, used, status                                                            |
| LimitRange                       | v1                            | ns                       | limits[] {type: Container/Pod, default, defaultRequest, min, max}             |
| Role / RoleBinding               | rbac.authorization.k8s.io/v1  | ns                       | rules / roleRef, subjects                                                     |
| ClusterRole / ClusterRoleBinding | rbac.authorization.k8s.io/v1  | cluster                  | rules / roleRef, subjects                                                     |
| ServiceAccount                   | v1                            | ns                       | secrets[]                                                                     |
| Project                          | project.openshift.io/v1       | cluster                  | phase Active/Terminating, displayName                                         |
| BuildConfig                      | build.openshift.io/v1         | ns                       | source, strategy, output, triggers, status.lastVersion                        |
| Build                            | build.openshift.io/v1         | ns                       | phase New/Pending/Running/Complete/Failed/Cancelled, output                   |
| ImageStream                      | image.openshift.io/v1         | ns                       | status.tags[{tag,items[{dockerImageReference}]}], lookupPolicy                |
| Template                         | template.openshift.io/v1      | ns                       | parameters[], objects[], message                                              |
| Subscription                     | operators.coreos.com/v1alpha1 | ns (openshift-operators) | phase Installing/Succeeded/Failed, installedCSV, channel, source              |
| SecurityContextConstraints       | security.openshift.io/v1      | cluster                  | priority, allowPrivilegedContainer, runAsUser, fsGroup, users[], groups[]     |
| ClusterResourceQuota             | quota.openshift.io/v1         | cluster                  | selector.labels.matchLabels, quota.hard, status.total.used                    |
| User                             | user.openshift.io/v1          | cluster                  | fullName, groups[], identities[]                                              |
| Group                            | user.openshift.io/v1          | cluster                  | users[] (stored as spec.users in the game)                                    |
| Identity                         | user.openshift.io/v1          | cluster                  | providerName, providerUserName, user.name — auto-created only, not in palette |
| OAuth                            | config.openshift.io/v1        | cluster                  | singleton name `cluster`; spec.identityProviders[]                            |
| ClusterOperator                  | config.openshift.io/v1        | cluster                  | status.conditions Available/Progressing/Degraded, versions                    |
| ClusterVersion                   | config.openshift.io/v1        | cluster                  | singleton name `version`; status.desired.version/channel                      |
| IPAddressPool                    | metallb.io/v1beta1            | ns (metallb-system)      | addresses[]                                                                   |
| L2Advertisement                  | metallb.io/v1beta1            | ns (metallb-system)      | ipAddressPools[]                                                              |

Existing gateway/controller kinds keep their current behaviour and apiVersion (Node v1, etc.).

### 3.2 Required spec schemas / defaults (used by palette, draw, levels)

```yaml
Project: { displayName: "", description: "" }          # metadata.name is the project
Route: { host: "", path: "/", to: {kind: Service, name: "", weight: 100},
         port: {targetPort: "http"}, tls: null, wildcardPolicy: None }
   # tls when present: { termination: edge|reencrypt|passthrough,
   #                      insecureEdgeTerminationPolicy: None|Allow|Redirect,
   #                      certificate: "", key: "", caCertificate: "" }
BuildConfig: { source: {type: Git|Binary, git: {uri: "", ref: ""}, contextDir: ""},
               strategy: {type: Source|Docker, sourceStrategy: {from: {kind: ImageStreamTag, name: "nodejs:20"}},
                          dockerStrategy: {dockerfilePath: Dockerfile}},
               output: {to: {kind: ImageStreamTag, name: "app:latest"}},
               triggers: [{type: ConfigChange}, {type: ImageChange, imageChange: {}}],
               runPolicy: Serial, status: {lastVersion: 1} }
ImageStream: { lookupPolicy: {local: false}, tags: [{name: "latest", from: {kind: DockerImage, name: ""}}] }
Template: { parameters: [{name: "APP_NAME", displayName: "App name", required: true, value: "webapp"}],
            objects: [<manifest objects with ${PARAM} placeholders>], message: "..." }
Subscription: { name: "ansible-automation-platform-operator", channel: "stable",
                source: "redhat-operators", sourceNamespace: "openshift-marketplace",
                installPlanApproval: Automatic, packageName: "ansible-automation-platform-operator" }
SecurityContextConstraints: { priority: 10, allowPrivilegedContainer: false,
   allowHostDirVolumePlugin: false, allowHostNetwork: false, allowHostPorts: false,
   allowHostPID: false, allowHostIPC: false, readOnlyRootFilesystem: false,
   runAsUser: {type: MustRunAsRange|MustRunAs|RunAsAny, uidRangeMin, uidRangeMax},
   seLinuxContext: {type: MustRunAs|RunAsAny}, fsGroup: {type: MustRunAs|RunAsAny},
   supplementalGroups: {type: MustRunAs|RunAsAny}, users: [], groups: [] }
ClusterResourceQuota: { selector: {labels: {matchLabels: {}}},
   quota: {hard: {pods: "50", "requests.cpu": "10", "requests.memory": "20Gi"}} }
LimitRange: { limits: [{type: Container, default: {"cpu": "500m", "memory": "512Mi"},
   defaultRequest: {"cpu": "100m"}, min: {"cpu": "50m", "memory": "64Mi"},
   max: {"cpu": "2", "memory": "4Gi"}}] }
User: { fullName: "", groups: [], identities: [{providerName: "htpasswd", providerUserName: "alice"}] }
Group: { users: [] }
OAuth: { spec: { identityProviders: [{name: "htpasswd", type: "HTPasswd",
          htpasswd: {fileData: {name: "htpasswd-secret"}}}] } }
Service: { type: ClusterIP, selector: {app: webapp}, ports: [{port: 80, targetPort: 8080}] }
   # clusterIP/clusterIPs/ipFamilies/ipFamilyPolicy/sessionAffinity/internalTrafficPolicy
   # and port protocol/targetPort are the API-server defaults applied at create (#59/#60)
Deployment with openshift extras: { replicas, selector, strategy, template,
   triggers: [{type: ImageChange, imageChangeParams: {automatic: true,
              containerNames: ["main"], from: {kind: ImageStreamTag, name: "app:latest"}}}] }
```

Service API-server defaulting (issues #59/#60): every Service creation/update path — the rich
`Service` class, `GameEngine.applyManifestObject()` (`oc apply/create/replace -f`, `oc expose`),
`ClusterState` seeding (platform Services and project-template objects) — runs the single
`defaultServiceSpec()` helper in `js/resources/NetworkResources.js` and stores exactly what a real
kube-apiserver stores: `spec.clusterIP` (a unique `172.30.0.0/16` address allocated once at create;
`None` for headless Services), `clusterIPs`, `ipFamilies: [IPv4]`, `ipFamilyPolicy: SingleStack`,
`sessionAffinity: None`, `internalTrafficPolicy: Cluster`, per-port `protocol: TCP`/`targetPort`,
and `nodePort`/`externalTrafficPolicy` for NodePort/LoadBalancer types. An update that omits
`spec.clusterIP` preserves the allocated ClusterIP (the API server never re-allocates it), and
ExternalName Services carry none of the clusterIP fields. Service status is exactly
`{loadBalancer: {}}` for ClusterIP — no `phase`, `conditions`, `observedGeneration` or endpoint
counters. Ready endpoints have one source of truth, `ClusterState.getServiceEndpoints()` (Running
Pods matching the selector in the Service namespace); the get/describe/traffic surfaces read it and
`formatEndpointAddresses()` renders it with kubectl's truncation (first 3 `ip:port` pairs followed
by ` + N more...`, `<none>` when empty).

Default projects seeded in `ClusterState`: `default`, `openshift`, `openshift-config`,
`openshift-operators`, `openshift-ingress`, `openshift-dns`, `openshift-monitoring`,
`openshift-console`, `openshift-authentication`, `openshift-image-registry`, `kube-system`.
Default cluster resources seeded in every mode: ClusterOperators (authentication, console, dns,
ingress, monitoring, network, image-registry, kube-apiserver, openshift-apiserver,
openshift-controller-manager, operator-lifecycle-manager, storage, etcd) with
Available=True/Progressing=False/Degraded=False and version `4.22.0`; ClusterVersion `version`
(desired.version `4.22.0`, channel `stable-4.22`); SCCs `restricted-v2` and `nonroot-v2` (groups
`system:authenticated`), `restricted-v3` (not granted to `system:authenticated` in the game's
admission model), `anyuid` (no subjects) and `privileged` (platform-default admin/build subjects);
virtual identities `kubeadmin` (cluster-admin ClusterRoleBinding; no User resource — real 4.x
kubeadmin is virtual and never listed by `oc get users`) and `admin` (simulator convenience
identity, also not a User resource); the `kube-system/kubeadmin` Secret stores only a bcrypt hash of
the installer-generated password (plain text lives only in `~/auth/kubeadmin-password`);
`openshift-config` carries the installer bootstrap Secrets (`pull-secret` type
`kubernetes.io/dockerconfigjson` and `initial-service-account-private-key` type Opaque — real 4.22
never seeds the HTPasswd secret, the identity labs create it); ImageStreams in `openshift`: `nodejs`
(tags `20-ubi9`, `22-ubi9`, `latest`), `python` (`3.12-ubi9`, `latest`), `nginx` (`1.26-ubi9`,
`latest`); platform workloads the routers/DNS operators own on a real 4.22 install are seeded as
real controllers by `SimulationTick` once Nodes exist: `deployment.apps/router-default` in
`openshift-ingress` (2/2 Ready, one ReplicaSet and two shared-`pod-template-hash` Pods with the
Pod → ReplicaSet → Deployment owner chain) and `daemonset.apps/dns-default` +
`daemonset.apps/node-resolver` in `openshift-dns` (one owned Pod per Node; `dns-default` runs the
real `dns` + `kube-rbac-proxy` containers and reports READY `2/2`), together with the
`router`/`dns-default`/`node-resolver` ServiceAccounts and the host-network SCC binding. The
Deployment/DaemonSet controllers heal a deleted platform Pod; the synchronous bootstrap keeps the
paused pre-start cluster healthy and never duplicates or churns the seeded Pods. The same bootstrap
seeds the real platform Services in every mode, including the paused pre-start sandbox:
`openshift-dns/dns-default` (ClusterIP `172.30.0.10`, ports `53/UDP`, `53/TCP`, `9154/TCP`; the
Service target port is `5353` on the pod network) and `openshift-ingress/router-internal-default`
(ClusterIP, ports `80/TCP`, `443/TCP`, `1936/TCP`). `dns-default` Pods run on the pod network
(`10.x` Pod IP, `hostNetwork: false`) while `node-resolver`/the router stay hostNetwork; both DNS
DaemonSet templates carry the real `kubernetes.io/os=linux` nodeSelector shown by `oc get ds`, the
router Pods carry the
`ingresscontroller.operator.openshift.io/deployment-ingresscontroller=default` label, and every
Pod's `/etc/resolv.conf` points at `172.30.0.10` (#58).
Nodes follow one catalog shared by every mode: `worker-0`, `worker-1`, `master-0` (2-node clusters
use worker-0/worker-1; the control-plane Node carries the `control-plane,master` role labels AND the
real `node-role.kubernetes.io/master:NoSchedule` taint, so application Pods schedule onto the
workers while the platform DaemonSet Pods tolerate the taint and keep running on the master —
#55).

---

## 4. Command bar — target command catalog

Input handling: trim; accept optional leading `oc ` or `kubectl ` (strip; if `kubectl`, append an
educational hint "tip: on OpenShift, use oc"); prompt rendered as `$ oc`; support pipes
(`oc process ... | oc apply -f -`) and output redirects (`oc get deploy web -o yaml > web.yaml`) for
the virtual file system. Like a real workstation shell, also support `;`, `&&` and `||` command
sequencing (quote/escape-aware; each segment keeps its own pipes/redirects and `&&`/`||` respect the
previous segment's exit status) plus session variables — `export NAME=value`, `$NAME`/`${NAME}`
expansion and bash's `$?`/`${?}` last-exit-status parameter — in unquoted and double-quoted
arguments (not inside single quotes). The exit status is the real numeric status of the last
executed command (see §4.3), persists across segments and terminal lines, and is reset with the
shell session; a skipped `&&`/`||` segment leaves it unchanged. Unsupported shell
grammar (loops, conditionals, functions) is rejected loudly (`simulator: … not supported — run one
command per line`); never execute part of a line silently. Track every executed raw command in
`gameEngine` command history with `{raw, baseCommand, success, timestamp}`. Tab completion must
include new kinds/commands.

Required base commands and behaviour (implement in CommandBar.js; complex mutations may call
GameEngine helpers):

- Lifecycle: `oc login [-u user] [-p pass]`, `oc logout`, `oc whoami`, `oc project [name]`,
  `oc projects`, `oc new-project <name> [--description=] [--display-name=]`, `oc delete project <name>`.
- Querying: `oc get <resource> [name] [-n project] [-A] [-o wide|yaml|json|name|jsonpath=...|custom-columns=...] [-l selector] [--field-selector=...] [--sort-by=...] [--show-labels]`;
  `oc describe <resource> <name>` (kubectl-style container env/probe/volume rendering and
  `key: value` annotations, §4.4); `oc status [-n]`; `oc events`/`oc get events [-w]`;
  `oc explain <resource>[.field]`; `oc get all`.
  Include: pods, deployments, replicasets, statefulsets, daemonsets, jobs, cronjobs, services,
  routes, ingresses, networkpolicies, configmaps, secrets, pvcs, pvs, storageclasses, hpa, pdb,
  resourcequotas, limitranges, clusterresourcequotas, projects, nodes, serviceaccounts, roles,
  rolebindings, clusterroles, clusterrolebindings, users, groups, identities, scc, templates,
  buildconfigs, builds, imagestreams, imagestreamtags, subscriptions, csv, operatorgroups,
  clusteroperators (co), clusterversion, oauth, ingresscontrollers, ipaddresspools.
  Aliases per real `oc` (po, deploy, svc, route, bc, is, istag, dc→warning, ns/project, quota,
  clusterquota, scc, user, group, co, etc.).
- Logs/events/health: `oc logs <pod|deployment/name|build/name|bc/name> [-f] [--previous] [-c container] [--tail=N]`,
  `oc adm top pods|nodes` (nodes sorted by NAME with the real control-plane load and worker
  variance, §4.4), `oc get clusteroperators`, `oc get clusterversion`, `oc adm must-gather`
  (simulated output), `oc adm inspect ns/<project>` (simulated output).
- Platform Services/DNS (issues #58/#61/#62): `oc get svc,endpoints -n openshift-dns` returns the
  real `dns-default` Service (ClusterIP `172.30.0.10`, ports `53/UDP`, `53/TCP`, `9154/TCP`, named
  targetPorts `dns`/`dns-tcp`/`metrics` like a real 4.22 install) with the pod-network
  (`10.128.x–10.131.x:5353`) Endpoints, and `oc get svc -n openshift-ingress` returns
  `router-internal-default` (ClusterIP, ports `80/TCP`, `443/TCP`, `1936/TCP`) with the router Pod
  Endpoints; both Services exist in every mode, including the paused pre-start sandbox (the first
  check when DNS breaks after a NetworkPolicy change, lab 13). Both read the Service's stored
  `spec.clusterIP` and the canonical endpoint resolver (§3.2), so
  `oc get svc -o jsonpath={.spec.clusterIP}`, `oc describe svc`, `nslookup`/`dig`/`getent hosts` and
  `oc exec … curl http://<ClusterIP>:<port>` agree with the get table. All three DNS tools perform a
  real cluster-DNS resolution and share the traffic simulation's NetworkPolicy egress check
  (UDP/TCP 5353 to the `openshift-dns` dns-default Pods): when an egress policy isolates the Pod
  without that rule they print `;; connection timed out; no servers could be reached` and exit like
  the real binaries (nslookup 1, dig 9, getent hosts silent 2). `nslookup` applies the Pod's
  resolv.conf search list (bare `web` → `Name: web.<ns>.svc.cluster.local`), `dig` has its own
  real header/QUESTION/ANSWER/SERVER format (`+short` = answer IPs only, `+search` opts into the
  search list), `getent hosts` prints glibc's `%-15s %s` IP/canonical line, and unknown names print
  the real `** server can't find <name>: NXDOMAIN` line (dig: NXDOMAIN status 0) — never a
  fabricated address (issues #59/#61).
- Exec/shell: `oc exec <pod> [-c <container>] -- <command>` (real container names), `oc rsh <pod>`,
  `oc cp <file> <pod>:<path>` / `oc cp <pod>:<path> <file>`. Inside a Pod `cat /etc/resolv.conf`
  prints the real cluster DNS contract — `search <project>.svc.cluster.local svc.cluster.local
cluster.local`, `nameserver 172.30.0.10`, `options ndots:5` (issue #58) — and `cat /etc/hosts` is
  the kubelet-managed file (`# Kubernetes-managed hosts file.`, loopback/localnet lines and
  `<podIP>\t<podName>`, no Service entries, #62). `getent hosts|passwd|group` read the Pod files /
  cluster DNS. An `oc exec`/`oc rsh` command the image does not model is a real OCI exec failure —
  `error: Internal error occurred: … exec: "<cmd>": executable file not found in $PATH` followed by
  `command terminated with exit code 127` and a failed shell status, so `&&` stops and `||`
  recovers; modelled binaries are matched by basename (`/bin/cat`) (#62). A container script
  (`oc exec <pod> -- sh -c '<script>'` or `/bin/bash -c`) runs in the container's shell (see §4.4):
  single-quoted script text is expanded from the container environment (`$VAR`/`$?`, `$HOSTNAME`),
  shell builtins (`exit N`, `:`, `cd`, `export`, `unset`, assignments) exist only in that shell, and
  the script's `;`/`&&`/`||`/pipes follow the real exit-status rules (issues #64–#65).
- Mutations: `oc create <resource> <name> [flags]`, `oc apply -f <file>`, `oc create -f <file>`,
  `oc replace -f <file>`, `oc delete -f <file>`, `oc apply -k <dir>`, `oc delete <resource> <name>`,
  `oc scale <resource> <name> --replicas=N`, `oc edit <resource> <name>` (opens editor modal),
  `oc label <resource> <name> key=value`, `oc annotate ...`, `oc patch <resource> <name> -p '<json>' --type=merge|strategic`,
  `oc set env deployment/name KEY=VALUE [--from=configmap|secret/name] [--list] [--remove=KEY]`,
  `oc set image deployment/name container=image`, `oc set resources deployment/name --limits=cpu=500m,memory=512Mi --requests=...`,
  `oc set probe deployment/name --liveness|--readiness|--startup --get-url=http://:8080/healthz`
  with `--open-tcp=<port>` or the numeric flags `--initial-delay-seconds=<n>`,
  `--period-seconds=<n>`, `--timeout-seconds=<n>`, `--success-threshold=<n>`,
  `--failure-threshold=<n>`, and `--remove` (see §4.4),
  `oc set serviceaccount deployment/name <sa>`, `oc set triggers bc/name --from-image=app:latest --containers=main | --remove`,
  `oc set selector svc/name app=web` (if supported; else patch fallback),
  `oc set volumes deployment/name --add --name=data --claim-name=data --mount-path=/data`.
- Deploy: `oc new-app <image>|<imagestream>|<git-url> [--name=] [--code=] [-e KEY=VALUE]`,
  `oc new-app --template=<name> [-p KEY=VALUE] [-n project]`, `oc new-app -f <template-file> [-p ...]`,
  `oc new-build <image-stream> --name=<bc>` / `oc new-build --code=<git> --name=<bc>`,
  `oc start-build <bc> [--follow] [--from-dir=.]`, `oc cancel-build <bc>`, `oc logs -f bc/<name>`.
  The `ScalingReplicaSet` event emitted by `oc new-app` names the full deterministic ReplicaSet
  `<name>-<10-char pod-template-hash>` in every state, including the paused pre-start sandbox where
  the ReplicaSet is created only after start (the same hash the Deployment controller derives then,
  issue #58).
- Expose/networking: `oc expose svc/<name> [--name=] [--hostname=] [--path=] [-n]`,
  `oc create route edge|passthrough|reencrypt <name> --service=<svc> [--hostname=] [--path=] [--cert=] [--key=] [--ca-cert=] [--insecure-policy=Redirect]`,
  `oc get route [-o wide]`, `oc delete route <name>`.
- Identity/RBAC: `oc create user <name> [--full-name=]`, `oc delete user <name>`, `oc create group <name>`,
  `oc adm groups add-users <group> <user...>` / `oc adm groups remove-users`, `oc get users|groups|identities`,
  `oc adm policy add-role-to-user <role> <user|sa> [-n]`, `add-cluster-role-to-user`, `add-role-to-group`,
  `add-cluster-role-to-group`, `remove-*`, `oc adm policy add-scc-to-user <scc> <user|sa>`,
  `add-scc-to-group`, `remove-scc-from-user`, `oc auth can-i <verb> <resource> [--as=<user>]`,
  `oc auth can-i --list`, `oc adm policy who-can <verb> <resource>`.
- Quotas/self-service: `oc create quota <name> --hard=pods=20,requests.cpu=4,requests.memory=8Gi`,
  LimitRanges are declarative — `oc apply -f examples/limitrange.yaml` (real `oc` has no
  `create limitrange` subcommand; the simulator rejects it the same way),
  `oc create clusterquota <name> --project-label-selector=... --hard=...`,
  `oc describe quota|limitrange|clusterresourcequota`, `oc get quota|limitrange|clusterquota`.
- Templates/Operators: `oc get templates -n openshift`, `oc process -f <file> [-p K=V] [-o yaml]`,
  `oc get csv|subscriptions|operatorgroups`, `oc create -f <subscription.yaml>`,
  `oc delete subscription <name> -n openshift-operators` (uninstall), `oc delete csv <name>` (delete operator).
- Builds/images: `oc get bc|builds|is|istag`, `oc start-build`, `oc tag <src> <dst> [--scheduled]`,
  `oc import-image <is>:<tag> --from=<image> --confirm`, `oc describe is|bc|build`.
- Cluster: `oc adm cordon|uncordon|drain node/<node>`,
  `oc adm taint nodes <node> key=value:NoSchedule` — plus the kubectl-compatible empty-value form
  `<key>=:<Effect>` (e.g. `oc adm taint node master-0 node-role.kubernetes.io/master=:NoSchedule`,
  issue #58), the real removal forms `<key>-`, `<key>:<Effect>-`, `<key>=<value>:<Effect>-`, and the
  real effect validation (`NoSchedule`/`PreferNoSchedule`/`NoExecute`; anything else fails with
  `error: invalid taint effect: <effect>, unsupported taint effect`),
  `oc label node <node> key=value`, `oc debug node/<node>` (simulated shell), `oc debug deployment/<name>`.
- Files/manifests (requires ManifestEngine, section 7): `oc apply -f`, `oc create -f`, `oc apply -k`,
  `oc process -f`, `oc get ... -o yaml > file`, `oc edit` (editor persists to cluster on Save),
  `helm install|upgrade|list|uninstall`, `htpasswd -c|-b|-D <file> <user> [pass]`.
- Google-style help: `oc --help`, `oc <cmd> --help`, `help`; output the supported syntax plus a docs link.

Output formatting: mimic `oc` table headers for common kinds (route shows NAME HOST/PATH TLS TERMINATION
SERVICE PORT; build shows NAME TYPE FROM STATUS STARTED DURATION; subscription shows NAME PACKAGE
SOURCE CHANNEL; etc.). Errors use realistic language: `Error from server (NotFound): routes.route.openshift.io "x" not found`,
`Error from server (Forbidden): ...`, `error: unable to locate ...`.

RBAC: `oc auth can-i` evaluates the model in section 6. Commands themselves are NOT hard-blocked by
RBAC in v1 (except where a level/incident requires a Forbidden result via `--as`/login), but every
mutating command emits an authorization check event for objectives/achievements.

### 4.1 Service/DNS and CLI output-fidelity contracts (issues #59–#60)

The Service data model (API-server defaulting and the single ClusterIP source) is defined in §3.2;
these are the output contracts every command surface must keep:

- **ClusterIP has one source of truth (issue #59).** `oc get svc` CLUSTER-IP,
  `-o jsonpath={.spec.clusterIP}`, `-o json`/`-o yaml` `spec.clusterIP`, `oc describe svc` `IP:`
  and `IPs:`, cluster DNS answers and clusterIP traffic all read the Service's stored
  `spec.clusterIP`. `oc get svc` must never derive a display address, and a Service created by
  `oc expose`/`oc apply -f` must carry the allocated ClusterIP. Updates that omit it preserve it.
- **Service status is the real subresource (issue #59).** A ClusterIP Service's serialized `status`
  contains only `loadBalancer: {}` in YAML/JSON; no `phase`, `conditions`, `observedGeneration`,
  `readyEndpoints`, `totalEndpoints` or `endpoints[]`. Endpoint bookkeeping lives in the instance
  (`service.endpoints`) and is fed only by `ClusterState.getServiceEndpoints()`.
- **`oc describe svc` matches kubectl v1.30 (issue #59).** Header fields `IP Family Policy:`,
  `IP Families:`, `IP:`, `IPs:`, optional `External IPs:`, `External Name:`,
  `LoadBalancer Ingress:`, `Desired LoadBalancer IP:`; one block per Service port with `Port:`,
  `TargetPort:`, optional `AppProtocol:`/`NodePort:` and `Endpoints:` lines
  (`Port: <unset> 8080/TCP` for a port without a name); then `Session Affinity:`, the optional
  `External Traffic Policy:`, `HealthCheck NodePort:`, `LoadBalancer Source Ranges:` and the
  `Events:` block last. Values are tabwriter-aligned; unimplemented defaults are omitted rather
  than printed as `<none>`/`undefined`.
- **One endpoint renderer + kubectl truncation (issues #59/#60).**
  `formatEndpointAddresses()` renders ready endpoints as `ip:port` pairs: up to 3 pairs then
  ` + N more...`, `<none>` when empty. `oc get endpoints` (ENDPOINTS cell) and `oc describe svc`
  (per-port `Endpoints:`) both use it over `cluster.getServiceEndpoints(service)`, so the table and
  the describe never disagree.
- **RoleBinding ROLE shows the role kind (issue #60).** `oc get rolebinding`/
  `oc get clusterrolebinding` print the ROLE cell as `<roleRef.kind>/<roleRef.name>`
  (`ClusterRole/admin`, `Role/edit`, `ClusterRole/system:deployer`), making Role vs ClusterRole
  visible like real `oc`.
- **Unscheduled Pod describe is honest (issue #60).** A never-bound Pod has no
  `status.containerStatuses`; `oc describe pod` then prints Image/Port/Host Port/Environment/
  Mounts/Conditions (`PodScheduled False`) and the FailedScheduling event only — no `Container ID:`,
  `Image ID:`, `State:`, `Ready:` or `Restart Count:` lines. A bound/running Pod keeps the real
  kubelet status block (State Running/Ready True/restart count/IDs).
- **`oc rollout status --timeout` blocks and exits 1 (issue #60).** With `--timeout`, a stalled
  rollout streams the Waiting line, ends with `error: timed out waiting for the condition` and
  returns failure so `&&`/`||` see exit status 1 (`;` still continues); a healthy rollout completes
  within the timeout and prints `successfully rolled out`. The simulator advances its cluster clock
  synchronously in 0.25 s steps up to the timeout (600 simulated seconds cap, then the existing
  async watcher). Without `--timeout` the previous asynchronous watch behaviour is unchanged.
- **`oc expose` leaves one unnamed Service port (issue #60).** `oc expose deploy/web --port=8080`
  creates a single port with no `name` (the real oc shape) and defaulted `protocol: TCP`/
  `targetPort`, so get prints `8080/TCP` and describe prints `Port: <unset> 8080/TCP`.

### 4.2 NetworkPolicy-aware DNS, exec exit status and Pod-network contracts (issues #61–#62)

The DNS diagnostics, the exec exit-status model and the Pod networking detail are part of the
simulation contract; these are the invariants every surface must keep:

- **DNS diagnostics honour NetworkPolicy (issue #61).** `nslookup`, `dig` and `getent hosts` call
  `SimulationTick.canResolveDNS(pod)` — egress from the exec Pod to the `openshift-dns` dns-default
  Pods on UDP/TCP 5353, the same check `curl`'s name resolution uses. A blocked result prints only
  `;; connection timed out; no servers could be reached` and sets the real exit status (nslookup 1,
  dig 9, getent 2), surfaced by `oc exec` as `command terminated with exit code <N>` +
  `error: true`. Allowing 5353 (the lab-13 allow-DNS policy) restores nslookup, dig, getent and
  curl-by-name together. DNS tools must never answer from the simulator when the network forbids
  the query, and `dig` must never print the old fabricated `172.30.43.12`.
- **DNS output formats (issues #61/#62).** `nslookup` prints
  `Server:`/`Address:`/`Name:`/`Address:`; it applies the Pod's search list
  (`<ns>.svc.cluster.local svc.cluster.local cluster.local`, `options ndots:5`) so bare names print
  the canonical FQDN in `Name:`, with headless Services answering every ready Pod IP, ExternalName
  its CNAME target and unknown names the real NXDOMAIN line (exit 1). `dig` prints its real
  header/`;; QUESTION SECTION:`/`;; ANSWER SECTION:`/`;; SERVER:` format, answers
  `<qname>. 30 IN A <ClusterIP>`, supports `+short` (answer IPs only) and `+search` (default
  no-search; NXDOMAIN is status 0). `getent hosts` prints glibc's `%-15s %s`
  (IP padded, canonical name) and exits 2 silently for unknown names; `getent passwd|group` read
  the image files.
- **curl verbose ordering (issue #61).** `runExecCurl` prints `*   Trying …` only after the name
  resolved, and `* Connected …` only when the request actually connected. A DNS failure prints
  `* Could not resolve host: <host>` + `curl: (6) Could not resolve host: <host>` with no
  Trying/Connected lines; a post-resolution connection failure prints the Trying line and the real
  `(7)`/`(28)` line but never Connected; success keeps the existing Trying → Connected → response
  order.
- **Honest `oc exec`/`oc rsh` exit codes (issue #62).** `_execStage` may return an `exitCode`; the
  exec/rsh surface appends `command terminated with exit code <N>` and returns a failed result when
  it is non-zero. An unmodelled binary returns 127 with the OCI not-found wording
  (`exec: "<cmd>": executable file not found in $PATH`) and no fabricated
  `(command executed in …)`/`exit code 0` lines, so `&&` chains stop and `||` branches run.
  Modelled binaries match by basename (`/bin/cat`); `sh`/`bash` are no-ops; every real command
  reports its real status (see §4.3: `true`/`false`, `ls` 2, `cat`/`grep` 1).
- **Pod network 10.128.0.0/14 (issue #62).** `SimulationTick._generatePodIP(node)` allocates
  `status.podIP` inside the Pod's Node `spec.podCIDR` (`/23` hostPrefix, host octet 2–254, skipping
  already-assigned Pod IPs) and falls back to 10.128–10.131 when no Node/CIDR is known; scheduler,
  platform seeder and incident binder pass the Node. No runtime code may emit a `10.244.` pod IP.
  HostNetwork Pods keep the Node IP as their Pod IP.
- **Kubelet `/etc/hosts` (issue #62).** Each Pod's `/etc/hosts` (and `oc cp pod:/etc/hosts`) is the
  kubelet-managed file: `# Kubernetes-managed hosts file.`, `127.0.0.1 localhost`,
  `::1 localhost ip6-localhost ip6-loopback`, `fe00::0 ip6-localnet`, `fe00::0 ip6-mcastprefix`,
  `fe00::1 ip6-allnodes`, `fe00::2 ip6-allrouters` and `<podIP>\t<podName>` — no
  `172.30.0.1 kubernetes.default.svc` Service entry. A Pod without `status.podIP` omits only the
  final line.
- **rolebinding wide ServiceAccounts (issue #62).** The SERVICEACCOUNTS column of
  `oc get rolebinding|clusterrolebinding -o wide` prints `<subject.namespace>/<subject.name>`
  (`qa8/deployer`) like `rbac.SubjectsStrings`, falls back to the binding namespace and never
  emits a leading `/`; USERS/GROUPS are unchanged.
- **Describe Events alignment (issue #62).** kubectl's describe uses one text/tabwriter for the
  whole output, so the `Events: <none>` placeholder starts in the same column as the widest
  top-level `Label:` value printed above it. The command layer derives that column from the output
  (Service: `Events:            <none>`, 12 spaces) instead of using a fixed 10-space placeholder;
  the non-empty Events table format is unchanged.
- **dns-default named targetPorts (issue #62).** `openshift-dns/dns-default` `spec.ports` carry
  targetPort names `dns`, `dns-tcp` and `metrics` (ports unchanged 53/UDP, 53/TCP, 9154/TCP).
  `oc describe svc` prints `TargetPort: dns/UDP`, `dns-tcp/TCP`, `metrics/TCP` while the ready
  EndpointSlice/`oc get endpoints` ports resolve to 5353/5353/9154. One shared resolver
  (`NetworkResources.resolveEndpointPort`) resolves named targetPorts against the endpoint Pod's
  container ports (last matching container port, so the kube-rbac-proxy `metrics` 9154 wins over
  CoreDNS' 9153) and is used by describe, `oc get endpoints` and the traffic simulation; numeric
  targetPorts keep their previous behaviour.

### 4.3 Shell exit statuses and container coreutils (issue #63)

The simulated shell and the `oc exec`/`oc rsh` container surface share one honest exit-status model:

- **`$?` / `${?}` expansion (issue #63).** `ShellTools.lastExitCode` holds the numeric status of the
  last executed command: the CommandBar records each segment's status after it runs (`oc exec`/
  `oc rsh` return the remote command's status; a failed `oc` command is 1; a syntax error is 2;
  success is 0) and bash `$?`/`${?}` expands it in unquoted and double-quoted words, never inside
  single quotes. The value survives `;`/`&&`/`||` segments and terminal lines like a real login
  shell, a skipped segment leaves it unchanged, and a fresh shell (engine reset) starts at 0.
  Examples: `oc exec deploy/web -- nslookup web; echo rc=$?` prints `rc=1` when the exec fails,
  `export X=5; echo $X $?` prints `5 0`, and `oc exec … -- ls /nope` on one line followed by
  `echo rc=$?` prints `rc=2`. `$?` is a shell special parameter — it is never listed by
  `env`/`printenv`/`export`.
- **Real command statuses in the shell.** Commands that fail without printing an error keep their
  real status: `grep` with no match returns 1 (so `cmd | grep NOPE` makes the pipeline status 1 and
  stops a following `&&`); a pipeline's status is its last stage's status. Working `true`/`false`
  shell builtins keep the sequencing grammar honest (0 / 1).
- **Coreutils in containers (issue #63).** `true` is a silent exit 0 and `false` a silent exit 1
  inside `oc exec`/`oc rsh` (mainstream UBI images ship coreutils), surfaced by the exec/rsh
  surface as `command terminated with exit code 1` with no fabricated OCI not-found error.
- **Real container commands report their real non-zero status (issue #63).** `ls` on a missing path
  prints `ls: cannot access '<path>': No such file or directory` and exits 2; `cat` on a missing
  file exits 1; `grep` with no match exits 1. `oc exec`/`oc rsh` append
  `command terminated with exit code <N>` and return a failed result, so `&&` stops and `||`
  recovers exactly like the existing 127 not-found contract. This closes the old behaviour where a
  failing modelled command printed only its error line and the shell still saw exit 0.

### 4.4 kubectl-style describe, probe flags, container `sh -c` and node metrics (issues #64–#65)

`oc describe` and the container shell are the surfaces a player uses to verify injected config and
probes; these are the output contracts every command surface must keep:

- **kubectl-style container and probe rendering (issue #64).** An env entry with
  `valueFrom.secretKeyRef` prints
  `<set to the key 'DB_PASS' in secret 'db'>  Optional: false`, `configMapKeyRef` the
  `<set to the key 'APP_LOG' of config map 'cfg'>` wording, `fieldRef` the resolved value plus
  `(<apiVersion>:<fieldPath>)` and `resourceFieldRef` `(<resource>)` — never
  `JSON.stringify(valueFrom)`. `oc describe pod` resolves `fieldRef` from the live Pod
  (name/namespace/uid/nodeName/serviceAccountName/hostIP/podIP/labels/annotations); a Deployment
  template has no Pod, so its `fieldRef` prints the empty resolved value like kubectl. Liveness/
  Readiness/Startup print in kubectl's order (after Limits/Requests, before Environment) as
  `http-get [scheme://][host:]port/path`, `tcp-socket [host:]port` or `exec [args]` plus
  `delay=<n>s timeout=<n>s period=<n>s #success=<n> #failure=<n>`, with unset fields defaulted to
  the API-server values (0/1/10/1/3).
- **kubectl-style volume rendering (issue #65).** `describeVolumes` prints the volume name (`cfg:`)
  then the source's `Type:` line (the ConfigMap/Secret/EmptyDir/PVC/HostPath/NFS/Projected/
  DownwardAPI/CSI wording) and its fields — `Name:`/`SecretName:`/`ClaimName:`/`Path:`/`Server:`/
  `ReadOnly:`/`Optional:`, downwardAPI `Items:`, the projected sources
  (`TokenExpirationSeconds:`, `ConfigMapName:`, `SecretName:`, `DownwardAPI:`), CSI
  `Driver:`/`FSType:`/`VolumeAttributes:` — aligned per volume (keys padded to that volume's longest
  key + 2). The injected `kube-api-access-*` projected service-account volume
  (token + ConfigMap + DownwardAPI) renders, never the old bare `Type:  configMap`; an unknown
  source prints `<unknown>`.
- **`key: value` annotations (issue #65).** Both describe surfaces print annotations sorted, as
  `key: value` (labels stay `key=value`), the first entry on the `Annotations:` line and the rest
  aligned to the same value column; values longer than kubectl's 140-char `maxAnnotationLen` (or
  multiline) move to indented continuation lines, and
  `kubectl.kubernetes.io/last-applied-configuration` is hidden.
- **`oc set probe` real flag semantics (issue #64).** `--initial-delay-seconds`,
  `--period-seconds`, `--timeout-seconds`, `--success-threshold` and `--failure-threshold` reach the
  probe with their supplied values (invalid values fail with oc's `must be a non-negative integer`
  error); only the supplied fields are written, an existing handler is preserved when no handler
  flag is given, and the API server defaults delay 0s/timeout 1s/period 10s/#success 1/#failure 3.
  `--open-tcp` creates the same `tcpSocket` handler through the engine path as `--get-url` creates
  `httpGet` (host optional, port numeric or named, scheme defaults HTTP).
- **Container `sh -c` shell (issues #64–#65).** `oc exec <pod> -- sh -c '<script>'` (and
  `/bin/bash -c`) runs the script in the container shell: single-quoted text is expanded there from
  the container env (`$VAR`/`${VAR}`, `$?`), so env/secret checks print real values and `$HOSTNAME`
  prints the pod name, while double-quoted text is expanded by the workstation shell first. Shell
  builtins (`exit N`, `:`, `cd`, `export`, `unset`, `KEY=VALUE` assignments) exist only in this
  shell — `oc exec -- exit 3` is still the real missing binary (127) — and the script's
  `;`/`&&`/`||`/pipes follow the real exit-status rules. `id` prints coreutils output: the full
  `uid=… gid=0(root) groups=…` line for plain `id` and bare IDs for
  `-u`/`-g`/`-un`/`-gn`/`-G`/`-Gn`.
- **Deployment-only describe events (issue #65).** `oc describe deployment` lists only events whose
  object is the Deployment itself: the Deployment controller's `ScalingReplicaSet` series
  (`Scaled up replica set <rs> to <n>` when a rollout creates the ReplicaSet,
  `Scaled down replica set <old> to 0 from <n>` when a ReplicaSet is retired, recorded at the real
  rollout time). ReplicaSet-controller `SuccessfulCreate`/`FailedCreate` events belong to the
  ReplicaSet (`oc describe rs`, `oc get events --field-selector reason=FailedCreate`) and never
  leak into describe deploy; seeded/paused states reconstruct the same series synthetically.
- **`oc adm top nodes` (issue #65).** The metrics-server view keeps its
  NAME/CPU(cores)/CPU%/MEMORY(bytes)/MEMORY% columns and is sorted by NAME; the control-plane node is
  the busiest (≥2000m CPU, 8–12 Gi resident control-plane components, greatest CPU%), and the worker
  rows carry deterministic per-node variance (never two identical workers).

---

## 5. Controllers / simulation (SimulationTick.js)

Extend the existing fixed-step simulation with OpenShift controllers:

- `_tickProjects`: Projects become Active immediately; deletion marks Terminating.
- `_ensurePlatformWorkloads` / `_ensurePlatformServices` (issues #53G/#55/#58): once Nodes exist, seed
  the controller-owned platform workloads — `deployment.apps/router-default` + its ReplicaSet +
  Pods and the `daemonset.apps/dns-default`/`node-resolver` DaemonSets with one owned Pod per Node —
  together with the real platform Services `openshift-dns/dns-default` (ClusterIP `172.30.0.10`,
  ports `53/UDP`, `53/TCP`, `9154/TCP`, named target ports `dns`/`dns-tcp`/`metrics` resolving to
  5353/5353/9154, selector `dns.operator.openshift.io/daemonset-dns=default`) and
  `openshift-ingress/router-internal-default` (ClusterIP, ports `80/TCP`, `443/TCP`, `1936/TCP`,
  selector `ingresscontroller.operator.openshift.io/deployment-ingresscontroller=default`), in every
  mode including the paused pre-start sandbox. DNS Pods run on the pod network
  (`hostNetwork: false`, 10.128–10.131 Pod IP from the Node's `spec.podCIDR`) while
  `node-resolver`/the router stay hostNetwork; the DNS
  DaemonSet templates carry the `kubernetes.io/os=linux` nodeSelector and the router Pods the
  ingress-controller deployment label. The bootstrap runs synchronously from
  `ensureOLMDefaultsSync()` (so a paused pre-start cluster already reports the router Deployment
  `2/2` and fully-Ready DNS DaemonSets) and is
  idempotent (no duplicates/churn over long tick runs); the Deployment/DaemonSet controllers heal
  deleted platform Pods.
- `_tickPodScheduling` (issue #57): an unschedulable Pod stays `Pending` with
  `PodScheduled=False/Unschedulable`; the STATUS column shown by `oc get pod` is `Pending` (`0/1`)
  until the Pod is bound — `ContainerCreating` is a post-binding kubelet state, never a scheduler
  display — and `oc describe pod` prints `Node: <none>` while unscheduled. FailedScheduling retries
  follow the real kube-scheduler backoff (`podInitialBackoffDuration` 1 s doubling to
  `podMaxBackoffDuration` 10 s), so Event series aggregate into realistic small counts over a
  nonzero window (e.g. `(x4 over 7s)`) instead of one event per tick (`x167 over 0s`), and each
  series preserves its `firstTimestamp`; a successfully scheduled Pod discards its retry state, so a
  later eviction/reschedule starts a fresh series. A never-bound Pod genuinely has no
  `status.containerStatuses` (scheduler binding is what creates them), so `oc describe pod` omits
  the kubelet-only `Container ID:`/`Image ID:`/`State:`/`Ready:`/`Restart Count:` lines for it
  (#60); a bound/running Pod keeps the real status block. Binding also allocates `status.podIP`
  inside the Node's `spec.podCIDR` /23 (OpenShift's `10.128.0.0/14` clusterNetwork, host octet
  2–254, never an address already assigned to another Pod; hostNetwork Pods use the Node IP), and
  incident-bound Pods go through the same allocator (#62).
- `_tickProbes` / Service endpoint accounting (issues #59/#60): `ClusterState.getServiceEndpoints()`
  is the canonical ready-endpoint resolver (Running Pods matching the Service selector in the same
  project); the tick keeps the instance `service.endpoints` bookkeeping in sync with it and never
  copies endpoints into the API-object `status`, which for ClusterIP Services is exactly
  `{loadBalancer: {}}` (`_persistService()` avoids the generic ResourceBase `conditions: []`
  skeleton). `oc get endpoints`, `oc describe svc`, route/incident checks and the traffic simulation
  read that same resolver, so ENDPOINTS cells and describe lines never disagree.
- `_tickRoutes`: router ADMISSION is a host/path-ownership + TLS/config check, never an endpoints
  check (OCP 4.22 router `UniqueHost` + external-certificate validation): a Route targeting an
  existing Service stays
  `status.ingress=[{host, routerName:"default", conditions:[{type:"Admitted",status:"True",reason:"Accepted",message:"..."}], wildcardPolicy:"None"}]`
  even when the Service has zero ready endpoints (traffic then fails with 503; `oc describe route`
  shows `Endpoints: <none>`). Admitted=False is reserved for real admission failures —
  `HostAlreadyClaimed` (a host/path claimed by an older Route, usually in another project),
  `ExternalCertificateValidationFailed` (missing/unreadable `spec.tls.externalCertificate` Secret),
  `Rejected`, `InvalidTargetKind`, `ServiceNotFound`; deleting the older claim admits the waiting
  Route on the next reconcile.
  Host defaults to `<route>-<project>.apps.cluster.example.com` when spec.host empty.
- `_tickBuilds`: `oc start-build`/ConfigChange trigger creates a Build owned by the BuildConfig
  (labels buildconfig=<name>, buildconfig.openshift.io/name). Build phases:
  New(1s)→Pending(1s)→Running(6-10s)→Complete; on failure (random 15% or spec.forFailure simulation)
  phase Failed with message "build failed: ...". On Complete: add/update ImageStream tag
  `output.to.name` with `dockerImageReference=image-registry.openshift-image-registry.svc:5000/<project>/<name>:<tag>`,
  set BuildConfig.status.lastVersion, emit `build:complete`, and trigger an ImageChange rollout for
  Deployments whose container image references the ImageStreamTag or whose triggers reference it.
- `_tickImageStreams`: maintain status.tags; image references `image-registry.openshift-image-registry.svc:5000/<project>/<is>:<tag>`
  should resolve through ImageStreamTag lookups for image-change triggers.
- `_tickSubscriptions`: phase Installing for ~8s then Succeeded with installedCSV
  `<package>.v1.0.0`; on Succeeded emit `operator:installed`; deleting Subscription emits
  `operator:uninstalled`. An operator whose failure flag is set (incidents) becomes Failed.
  Real OLM resolution/upgrade semantics (OCP 4.22): a Subscription resolves its catalog channel
  immediately, so `status.currentCSV` names the resolved CSV (the `startingCSV` pin when set) before
  the first InstallPlan is approved, while `installedCSV` stays empty until that CSV succeeds. When
  the installed CSV is older than the tracked channel head, OLM immediately resolves the NEXT step
  and creates a second InstallPlan for the head CSV: for `installPlanApproval: Manual` it waits
  unapproved (`InstallPlanPending True RequiresApproval`, `currentCSV` = head, `installedCSV` = the
  pin, phase UpgradePending) and installing it upgrades/replaces the CSV; Automatic subscriptions
  auto-approve it. A dependency-resolution failure (unknown package/channel/startingCSV) reports
  only `ResolutionFailed`/`ConstraintsNotSatisfiable` — no install-plan conditions or fake CSV.
- `_tickOperatorsEffects`: if the `metallb` Subscription is Succeeded, Services of type LoadBalancer get
  `status.loadBalancer.ingress[{ip}]` from the first IPAddressPool address (only when an
  L2Advertisement references the pool); otherwise `<pending>`; emit `route:admitted`-style events.
- `_tickSCC`: when a Pod/Deployment template requests privileged:true or runAsUser:0, check the pod's
  ServiceAccount against SCCs (users/groups); if none permits, set Pod phase Failed and event
  reason Forbidden message "unable to validate against any security context constraint"; emit
  `scc:denied`.
- `_tickQuotaLimitRanges`: enforce ResourceQuota (existing `checkQuota`) and LimitRange defaults/min/max
  on pod creation (`limitrange:violation`); enforce ClusterResourceQuota across selected projects.
- `_tickOAuth`: OAuth provider changes take effect after ~5s (simulated oauth rollout); emit
  `auth:provider-ready`. A freshly seeded cluster is already settled — re-adding the baseline OAuth
  singleton/cluster reset MUST NOT start a rollout (authentication ClusterOperator stays
  Progressing=False/AsExpected); only a real `spec.identityProviders`/`spec.tokenConfig` change or a
  data change to the referenced HTPasswd Secret triggers the rollout.
- `TemplateHash.js`: the deterministic `<deployment>-<10-char pod-template-hash>` is derived from the
  canonical pod-template string (the real `fnv32a` → `rand.SafeEncodeString` shape) by one shared
  helper, so the paused pre-start `oc new-app` `ScalingReplicaSet` event and the ReplicaSet the
  Deployment controller creates after start report the same full name (issue #58).
- Node/Pod events follow real kubelet reasons only: Pods are `Scheduled → Pulling → Pulled →
Created → Started` (plus real warning reasons such as `Failed`/`BackOff`/`FailedScheduling`);
  there is no synthetic `Ready` event and no `PhaseChange` event (phase readiness is status, not an
  event). Platform Pods (`router-default`, `dns-default`, `node-resolver`) carry the same stream.
- `_tickClusterHealth`: recalc ClusterOperator conditions; emit periodic cluster state tick as today.
- Keep all existing controllers (Deployment/RS/STS/DS/Job/CronJob/HPA/probes/PVC/quota/chaos).
- Events (in addition to existing): `build:started`, `build:complete`, `build:failed`,
  `route:admitted`, `route:not-admitted`, `operator:installed`, `operator:uninstalled`,
  `scc:granted`, `scc:denied`, `login`, `logout`, `project:switched`, `manifest:applied`,
  `kustomize:applied`, `helm:installed`, `helm:uninstalled`, `template:processed`,
  `limitrange:violation`, `scc:denied`.

---

## 6. RBAC, SCC, identity simulation model

State lives on `GameEngine`: `currentUser` (default `kubeadmin`), `currentProject` (default
`default`), `authProvider` (`null` or `{type:'HTPasswd', secretName:'htpasswd-secret', namespace:'openshift-config', ready:boolean}`).
Also expose `gameEngine.cluster` methods:

- `getUser(name)`, `getGroup(name)`, `getUserGroups(user)` → includes groups whose spec.users contains user and user.spec.groups.
- `canI(userName, verb, resource, namespace)` → `{allowed, reason, role?}`. Evaluation order: cluster-admin
  (kubeadmin, system:admin) allow; ClusterRoleBindings; RoleBindings in namespace; built-in roles
  `admin`/`edit`/`view`/`self-provisioner` semantics: admin=* on namespaced resources in project,
  edit=get/list/watch/create/update/patch/delete on most workloads but not RBAC/quotas, view=get/list/watch,
  self-provisioner=create projects. Resource group wildcards supported; `verbs:["*"]`, `resources:["*"]` supported.
- SCC resolution: `sccForServiceAccount(ns, sa)` considering SCC spec.users/groups
  (`system:serviceaccount:<ns>:<sa>`, `system:authenticated`, group names).
- Helpers for commands: `grantSCC(scc, subject)`, `revokeSCC`, `addUserToGroup`, etc.
  Default state: kubeadmin has cluster-admin ClusterRoleBinding; `system:authenticated` group gets
  `restricted-v2` SCC in the game's admission model (the 4.22 docs also describe `restricted-v3` as
  the default for authenticated users on new installs — verify on a live cluster); `default`
  ServiceAccount exists in each project. Password store: virtual
  `htpasswd` file in ManifestEngine (section 7) is the source of truth for HTPasswd logins; login
  succeeds only when `authProvider.ready` and the user/password match the file, creating/updating the
  User + Identity objects and setting `currentUser`. `oc delete user` removes bindings/identity too.
  `oc login` failures follow real `oc` wording (updated 2026-11-04): unknown user with no identity
  provider configured → `Login failed (401 Unauthorized)` plus "The user \"<user>\" is not known to the
  configured identity provider: no identity provider is configured on this cluster."; bad credentials
  with an identity provider configured → `Login failed (401 Unauthorized)` plus "Verify you have provided
  the correct credentials."; provider configured but OAuth rollout not ready → a dedicated wait message.
  Failed logins never change the current session. Built-in virtual `kubeadmin`/`admin` identities still
  log in (no User resources are seeded for them, matching real 4.x); `kubeadmin` password auth validates
  against the installer's `~/auth/kubeadmin-password` copy and is removed by deleting the
  `kube-system/kubeadmin` Secret.

---

## 7. Declarative engine — manifests, Kustomize, Helm, templates (new files)

New module family owned by manifests-dev; must be dependency-free vanilla JS.

Files:

- `js/engine/YamlParser.js` — parse a practical YAML subset into plain JS objects: mappings,
  sequences, scalars (quoted/unquoted, booleans, numbers, null, `|`/`>` block scalars optional),
  comments, multiple documents separated by `---`. Export `parseYaml(text)` → `Array<object>` and
  `stringifyYaml(obj)` for editor display. Return structured errors with line numbers.
- `js/engine/ManifestEngine.js` — virtual file system + operations:
  - `listFiles()`, `readFile(path)`, `writeFile(path, text)`, `deleteFile(path)`, `resetFiles()`.
  - `applyFile(path)` → parse docs, call `gameEngine.applyManifestObject(obj)` (Lead/engine-dev
    provides this on GameEngine; it upserts a ResourceBase by kind/name/namespace and returns the
    resource), collect created/updated, emit `manifest:applied {file, resources}`.
  - `applyKustomize(dirPath)` → read `kustomization.yaml`, resolve `resources`, `namespace`,
    `namePrefix`, `commonLabels`, `images` (name/newName/newTag), `replicas`, and
    `patchesStrategicMerge` (paths to patch files). Deep-merge patch maps into base object maps
    (lists replaced). Then apply. emit `kustomize:applied {path, resources}`.
  - `processTemplate(path, params)` → substitute `${PARAM}` occurrences in strings of parsed docs,
    apply required/generated params (raise error listing missing required params); expose
    `template:processed`.
  - `installHelm(release, chartDir, valuesPath)` → render `templates/*.yaml` by substituting
    `{{ .Values.key }}` and `{{ .Release.Name }}` with a small mustache subset, then apply; store
    release record {name, chart, namespace, status, resources}; `listHelm()`, `uninstallHelm(name)`.
  - `htpasswdAdd(user, pass)`, `htpasswdUpdate(user, pass)`, `htpasswdDelete(user)`,
    `htpasswdList()` — operate on virtual file `htpasswd` (content lines `user:{SHA}<base64>`; a
    fake hash is fine, never display raw passwords). Also `readFile('htpasswd')` for editor.
  - `getState()` for objective evaluation/Exam Prep.
- `js/ui/ManifestPanel.js` — modal "Files / Manifests" panel: file tree, textarea editor with
  line numbers optional, Save, Reset, Apply -f / Apply -k buttons, error output, docs link. `init()`,
  `show()`, `hide()`, `destroy()`; self-contained DOM; opens from toolbar button `#btn-manifests`
  (index.html) and from `oc edit` commands. On `show`, uses current level's files.
- Default files in `js/data/ManifestFiles.js` (realistic 4.22 content):
  `manifests/deployment.yaml`, `manifests/service.yaml`, `manifests/route.yaml`,
  `kustomize/base/{kustomization.yaml,deployment.yaml,service.yaml}`,
  `kustomize/overlays/dev/kustomization.yaml`, `kustomize/overlays/prod/kustomization.yaml`,
  `templates/webapp-template.yaml`, `helm/webapp/{Chart.yaml,values.yaml,templates/deployment.yaml,templates/service.yaml}`,
  `htpasswd`, plus `examples/quota.yaml`, `examples/limitrange.yaml`, `examples/subscription.yaml`,
  `examples/buildconfig.yaml`, `examples/scc-grant.md` maybe.
- Levels/challenges may include `manifestFiles: ["manifests/deployment.yaml", ...]` to seed `initialFiles`
  (the panel always shows all default files; a level can highlight relevant ones via
  `focusFiles` and reset content on level start).

Engine dev integration: add `GameEngine.applyManifestObject(obj)` (upsert by kind/name/namespace,
assign apiVersion from the object or the kind map, apply labels/annotations/spec/status defaults,
emit normal cluster events) and expose `window.game.manifestEngine` (set by ManifestPanel init).

---

## 8. Incidents (js/data/IncidentDefs.js + IncidentEngine.js + IncidentPanel.js)

Keep the existing incident lifecycle/engine architecture. Rename `kubectlCommands` →
`ocCommands` throughout data/engine/panel. Every investigation step uses a real `oc` command.
Required incident set (id / name) — Lead owns final consistency; use these exact `name` values:

Pod/workload: `CrashLoopBackOff`, `ImagePullBackOff`, `OOMKilled`, `SCCForbidden`,
`PendingScheduling`, `CreateContainerConfigError`, `ReadinessProbeFailure`, `LivenessProbeFailure`,
`PodStuckTerminating`, `DeploymentStuckRollout`, `ImageStreamTagMissing`, `BuildFailed`,
`HPAUnableToScale`, `JobDeadlineExceeded`, `CronJobMissedSchedule`, `PVCPending`, `ConfigMapMissing`,
`SecretMissing`, `SecretExposed`.
Network: `ServiceNoEndpoints`, `RouteNotAdmitted`, `RouteTLSCertificateError`, `RouteHostConflict`,
`NetworkPolicyBlocking`, `DNSResolutionFailure`, `IngressDegraded`, `LoadBalancerPending`.
Security/identity: `UnauthorizedAccess`, `HTPasswdAuthFailure`.
Cluster/quota: `ResourceQuotaExceeded`, `LimitRangeViolation`, `ClusterResourceQuotaExceeded`,
`NodeNotReady`, `NodeDiskPressure`, `NodeMemoryPressure`, `OperatorInstallFailed`.

Schema:

```js
{
  id: 'crash-loop-backoff', name: 'CrashLoopBackOff',
  category: 'Pod' | 'Network' | 'Security' | 'Build' | 'Cluster' | 'Storage' | 'Identity',
  severity: 1..5, description, visualEffect,
  affectedResourceTypes: ['Pod','Deployment'],
  investigationSteps: [{ command: 'oc logs <pod> --previous', hint: '...' }, ...],  // 2-4 steps
  resolutionActions: [{ action: 'fix-image', label: '...', difficulty: 1 }, ...],    // 2-3 actions
  ocCommands: ['oc describe pod', ...],
  autoResolveTime: null | seconds,
  resolution: { kind: 'pod'|'deployment'|'node'|'route'|'build'|'operator'|'cluster', effect: 'heal'|'restore'|'clear'|'recreate', ... }
}
```

`IncidentEngine.applyResolutionEffects` implements the `resolution.effect` generically (heal target,
restore node Ready, admit route, mark build Complete, restore operator CSV, clear quota violation,
etc.) plus keep per-name special cases where needed. Incident targets can be Deployment/Pod/Node/
Route/Build/Subscription names.

---

## 9. Campaign curriculum — 20 levels, 5 chapters (js/data/CampaignLevels.js + CampaignMode.js)

Schema per level:

```js
{ id, title, chapter, chapterName, description,
  examObjectives: ['Manage OpenShift Container Platform > Create and delete projects', ...],
  docsLinks: ['https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/...'],
  objectives: [ /* objective schema below */ ],
  startingResources: [{ kind, name, spec, namespace? }],
  availableResources: ['Project', 'Deployment', ...],
  manifestFiles: ['manifests/deployment.yaml'],           // optional
  incidents: [{ type: 'CrashLoopBackOff', triggerTime: 10, target: 'web-app', severity: 2 }],
  hints: ['...', '...', '...'],
  starCriteria: { time: <seconds>, efficiency: 0.7..0.9, noFailures: bool },
  nextLevel: 2, tutorial: { steps: [{ target: 'command-bar'|'cluster-view'|'inspector'|'files'|'palette', text }] } | null }
```

Chapters and levels (titles fixed; content authors flesh out descriptions/hints/tutorials):

1. **Manage OpenShift** (Projects, CLI, querying, declarative basics)
   1. _Your First Project_ — oc whoami/status, create Project, deploy first Pod/Deployment; objectives:
      `project`, `login`, `deploy Pod`, `deploy Deployment`. Tutorial steps.
   2. _Query, Format, Filter_ — labels/selectors, `-o wide/yaml/jsonpath/custom-columns`,
      `--field-selector`, `--sort-by`, `oc explain`; objectives: `command` patterns, `label`,
      `deploy`.
   3. _Logs, Events & Health_ — deploy app, investigate CrashLoop incident with oc describe/logs/events,
      read ClusterOperators/clusterversion, `oc adm top`; objectives: `resolve CrashLoopBackOff`,
      `command oc logs`, `clusterHealth`, `investigate`.
   4. _Declarative Manifests_ — edit manifests/deployment.yaml + service.yaml, `oc apply -f`,
      update + re-apply, export with `oc get ... -o yaml >`; objectives: `manifest` files, `deploy`
      kinds, `command`.
2. **Declarative & Kustomize** (V422 Declarative Resource Management) 5. _Kustomize Base_ — apply base overlay; objectives: `kustomize` base path, `deploy`. 6. _Kustomize Overlays_ — prod overlay patches image/replicas/namespace; objectives:
   `kustomize` prod path, `image` contains, `replicas`/scale, `command`. 7. _Secrets & ConfigMaps_ — create secret/configmap via oc create -f and oc create secret,
   mount/env into Deployment; objectives: `deploy Secret`, `deploy ConfigMap`, `mount`, `envFrom`,
   `noConfigMap`. 8. _Templates & Helm_ — process OpenShift template with parameters (`oc process -f | oc apply -f -`),
   install Helm chart (`helm install`), verify resources; objectives: `template`, `helm`, `deploy`.
3. **Deploy & Expose** (V422 Deploy applications / Network security / Non-HTTP) 9. _Images, Builds & Image Streams_ — `oc new-app`, BuildConfig→Build→ImageStream complete,
   tag/digest, `oc start-build`, verify istag; objectives: `build`, `imageStream`, `deploy`,
   `command`. 10. _Rolling Updates & Rollbacks_ — update image, watch rollout, ImagePullBackOff incident,
   `oc rollout undo/status/history`; objectives: `update`, `rollback`, `resolve ImagePullBackOff`. 11. _Services & Routes_ — service selector, `oc expose svc`, edge TLS route with cert secret,
   verify Admitted; objectives: `connect`, `route`, `tls`, `deploy Secret`. 12. _Non-HTTP & Load Balancer_ — install MetalLB operator (Subscription), IPAddressPool +
   L2Advertisement, Service type LoadBalancer with EXTERNAL-IP; passthrough/reencrypt route for
   TLS app; objectives: `operator`, `serviceType LoadBalancer`, `tls passthrough`, `route`.
4. **Identity, RBAC & Self-service** (V422 Authn/authz + developer self-service) 13. _HTPasswd & Users_ — create htpasswd users, secret in openshift-config, configure OAuth,
   login as user, change password; objectives: `user`, `login`, `command htpasswd/oauth`. 14. _Groups & RBAC_ — groups, rolebindings, `oc auth can-i`, least privilege, UnauthorizedAccess
   incident; objectives: `group`, `canI`, `leastPrivilege`, `deploy RoleBinding`. 15. _Quotas, LimitRanges & Templates_ — ClusterResourceQuota, ResourceQuota, LimitRange, project
   template from `openshift` project; objectives: `quota`, `limitRange`, `template`,
   `resolve ResourceQuotaExceeded`. 16. _Service Accounts & API Access_ — SA, `oc set serviceaccount`, grant role to SA,
   token/API access + `oc auth can-i --as=system:serviceaccount:...`; objectives:
   `deploy ServiceAccount`, `canI --as`, `deploy RoleBinding`.
5. **Security & Operations** (V422 application security, operators, jobs) 17. _SCC & Privileged Apps_ — SCCForbidden incident, `oc adm policy add-scc-to-user anyuid -z default`,
   run privileged app, verify; objectives: `scc`, `privileged`, `resolve SCCForbidden`. 18. _Operators_ — install Subscription (operator group/CSV), verify Succeeded, uninstall/delete;
   objectives: `operator installed`, `operator removed`, `command`. 19. _Jobs & CronJobs_ — one-time job and cron job, verify completion/schedule, fix failed job;
   objectives: `complete Job`, `cronJob`, `resolve JobDeadlineExceeded`. 20. _EX280 Final: Production Platform_ — build a complete platform: Project, ResourceQuota,
   LimitRange, template deploy, BuildConfig→ImageStream→Deployment, Route with TLS,
   NetworkPolicy, User+Group+RBAC, SCC for SA, Operator install, Job/CronJob; objectives combine
   ~10 `deploy`/`route`/`build`/`scc`/`canI`/`operator`/`complete` objectives with
   `architectureScore` and `examScore >= 75`; time limit via starCriteria.

Objective schema (CampaignMode owns `ObjectiveEvaluator` — extract to
`js/engine/ObjectiveEvaluator.js`, exported class/function so ChallengeMode reuses it):
common `{ type, label, ... }`; supported types:

```
deploy        {kind, count?, name?}                     count existing resources of kind (or named exists)
scale         {kind, name?, replicas}                   any/name spec.replicas >= replicas
replicas      {minPerDeployment}
project       {name?, count?}                            Project exists (name required when given), status Active
login         {user}                                     currentUser === user (after oc login)
user          {name?, count?}                            User resource exists
group         {name?, users?[]}                          Group exists and contains users
canI          {verb, resource, user?, expected:true|false}
deploy        (see above)
serviceType   {kind: 'LoadBalancer'|'NodePort'|'ClusterIP', count?}
connect       {from, to}                                 Service selector matches target workloads/endpoints
route         {name?, host?, path?, termination?, service?, count?}   Route valid + admitted (status.ingress Admitted True)
tls           {enabled:true, termination?}               Route with tls (cert fields for edge/reencrypt)
build         {name?, count?}                            Build phase Complete (or named BuildConfig has completed version)
imageStream   {name, tag?}                               ImageStream exists (tag present when given)
image         {kind:'Deployment', name?, imageContains}
template      {name?, parameters?}                       template processed/applied (ManifestEngine record)
helm          {release?, chart?}                         helm release installed
kustomize     {path}                                     overlay applied successfully (ManifestEngine record)
manifest      {file}                                     file applied successfully
operator      {name, installed:true|false}               Subscription Succeeded / absent
scc           {scc, subject?, expected:true}             SCC spec.users includes subject
privileged    {count?}                                   Pod running with privileged container (and SCC allowed)
quota         {name?, namespace?, hard?}                 ResourceQuota exists (hard matches subset)
limitRange    {name?, namespace?}                        LimitRange exists
clusterQuota  {name?}                                    ClusterResourceQuota exists
complete      {kind:'Job', count?, name?}                Job phase Complete
cronJob       {count?, name?, suspended:false}
mount         {kind:'ConfigMap'|'Secret', count?, targetKind?}  Deployment volume references it
envFrom       {kind, count?}                             Deployment container envFrom/env valueFrom references it
noConfigMap   {sensitive:true}                           no ConfigMap data keys match /password|secret|token|key/i
resources     {kind:'Deployment'|'StatefulSet'}          all have requests+limits
probes        {kind, liveness:true, readiness:true}
hpa           {count?}
pdb           {count?}
bd / bound    {kind:'PersistentVolumeClaim', count?}
headless      {kind:'Service', count?}
stable        {kind:'StatefulSet'}
leastPrivilege{}                                         no Role/ClusterRole with wildcard verbs/resources; no cluster-admin binding for non-admin
distribute    {minNodes}
coverage      {kind:'DaemonSet', allNodes:true}
update        {kind, count?}
rollback      {count?}
resolve       {incidentType?, count?}
investigate   {incidentType?, progress?=0.5}
uptime        {percentage}
clusterHealth {minPercent?, allOperatorsAvailable?}
reschedule    {count?}
nodeSelector  {kind, nodeLabel?}                          pods scheduled on nodes matching label
taint         {node?, key?, effect?}
command       {pattern, count?, mustSucceed?}             executed command raw matches RegExp string
examScore     {minScore}                                  composite: objectives completed + incidents resolved + architecture score (final level)
architectureScore {minScore}
```

CampaignMode must expose `getStatus()` unchanged in shape and pass `objectiveProgress` into the
objectives panel/HUD as today. New objective types must degrade gracefully if referenced resources
are absent.

---

## 10. Challenges — 13 timed labs (js/modes/ChallengeMode.js, reuse ObjectiveEvaluator)

Keep the challenge runner architecture (`CHALLENGES`, `startChallenge`, `getStatus`, etc.).
Replace scenarios with these (id/title fixed; each 180-420s, objectives use section 9 schema,
`startingResources` + `preloadIncidents` + `availableResources` + `hints`):

1. _Three-Tier App_ — two Projects (frontend/backend), deployments, services, route to frontend.
2. _Fix CrashLoopBackOff_ — investigate + resolve CrashLoopBackOff, health ≥90%.
3. _Route with Edge TLS_ — service + `oc create route edge` with TLS secret, Admitted.
4. _Kustomize Prod Overlay_ — apply prod overlay, verify image tag + replicas via objective + command.
5. _Build & Deploy from Source_ — `oc new-app`/BuildConfig build completes, ImageStreamTag, Deployment running, Route.
6. _Quota Guardrail_ — ResourceQuota + LimitRange + project requests; deploy within limits; resolve quota incident.
7. _RBAC for a New Teammate_ — create user/group, rolebinding edit in project, `oc auth can-i` true, least privilege.
8. _SCC for a Privileged Workload_ — grant anyuid to SA, run privileged/uid-0 pod, resolve SCCForbidden.
9. _Network Isolation_ — default-deny NetworkPolicy + allow only frontend→backend, fix DNS egress.
10. _Install an Operator_ — Subscription Succeeded (+ uninstall/delete objective), MetalLB LoadBalancer service with EXTERNAL-IP.
11. _HTPasswd Onboarding_ — htpasswd users, OAuth config, login as user, group membership, permissions.
12. _EX280 Speed Run_ — mixed: project, apply manifests, build, route TLS, quota, job, RBAC; under time.
13. _Production Network Policies_ — default-deny NetworkPolicy + DNS egress + allow only gateway→ledger; graded on
    observed traffic behaviour, not on policy names (added 1.2.0).

---

## 11. EX280 Prep mode (new files: js/data/EX280Objectives.js, js/modes/ExamPrepMode.js + index.html)

A non-3D overlay opened from a new main-menu button **EX280 Prep** (id `#menu-exam-prep`), plus a
`?` keyboard hint. It does not use GameEngine modes; it reads ScoringEngine progress +
ManifestEngine state via `window.game`.

Contents:

1. **Objective tracker** — all V422 objective groups/bullets from `docs/research/exam-facts.json`
   (copy into JS data with `id`, `title`, `bullets`, `docsUrl`). For each bullet: status
   (Not started / In progress / Mastered), linked levels/challenges (click → start that level/challenge),
   key `oc` commands (copy-to-clipboard), command bar shortcut (`oc <cmd>` prefilled), "Open Red Hat docs" link.
   Mastered = linked campaign level completed OR linked challenge completed OR quick-lab passed.
   Overall progress bar (X / 55 bullets) and a study-coverage verdict (≥90% of bullets have a linked
   drill completed — coverage of the game's drills, not a Red Hat pass prediction).
2. **Quick labs** — 8-10 short "do it now" command drills with expected result, mapped to objectives:
   projects/users/route/build/kustomize/quota/scc/operator; each opens Sandbox with a seeded state and
   checks via `command`/state objectives; record pass in progress.examPrep.
3. **Cheat sheet** — grouped `oc` command reference (from research docs) with docs links; searchable filter.
4. **Exam facts** — EX280V422, 3h, performance-based, persistence requirement, recommended courses,
   official objectives link, docs base URL. Naming: redhat.com titles the exam "Red Hat Certified
   System Administrator in OpenShift exam (EX280)"; Red Hat's LMS objectives PDF calls it "Red Hat
   Certified Specialist in OpenShift Administration". Both are EX280V422 — show the official page
   title with the PDF name as a note.

Data contract: `EX280_OBJECTIVE_GROUPS = [{id, title, bullets: [{id, title, docsUrl,
levels: [ids], challenges: [ids], commands: [oc command strings], summary}]}]`;
`EX280_QUICK_LABS = [{id, title, objectiveId, setup: {startingResources, manifestFiles?},
check: [objective], hints, docsUrl}]`.
Progress stored in `ScoringEngine.progress.examPrep` (`{[bulletId]: {state:'practiced'|'mastered', updatedAt}}`)
and methods `getExamPrepProgress()`, `markExamPrep(bulletId, state)`.
All 55 official bullets must be present and mapped (Lead verifies; authored from docs/research/exam-facts.json).

---

## 12. UI surfaces, palette, draw mode

- **Palette sections** (`index.html`): Projects & Cluster (Project, Node, ClusterResourceQuota);
  Workloads (Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, CronJob);
  Builds & Images (BuildConfig, ImageStream); Networking (Service, Route, Ingress, NetworkPolicy,
  IPAddressPool, L2Advertisement); Config (ConfigMap, Secret, LimitRange, ResourceQuota, Template);
  Storage (PVC, PV, StorageClass); Scaling & Availability (HPA, PDB); Security (ServiceAccount, Role,
  RoleBinding, ClusterRole, ClusterRoleBinding, SecurityContextConstraints); Identity (User, Group,
  Subscription/Operators). All placeable kinds in section 3 appear in the palette; palette item
  `data-resource` = kind; tooltips show kind + shortcut where applicable.
- **Toolbar**: existing Auto-Align / Reset View / YAML / Help + new **Files** (`#btn-manifests`) +
  **EX280** shortcut. `/` hint says `oc`.
- **HUD**: logo "OpenShift Games"; health; counts; mode label "OpenShift 4.22"; incident bell.
- **Inspector**: tabs Overview / YAML / Describe / Events; kind-specific details for Project, Route
  (host, path, TLS, admitted), BuildConfig/Build/ImageStream, Template, Subscription, SCC, quotas,
  users/groups; YAML tab uses the resource's toYAML with correct apiVersion; Describe tab mimics
  `oc describe`; contextual actions (Expose, Start Build, Add SCC, Install Operator, Scale, Rollout,
  Delete) where meaningful.
- **Context menu**: OpenShift wording and actions (Expose Service → Route, Start Build, Rollout
  Restart/Undo, Scale, Edit YAML, Add to SCC, Delete). All labels use `oc`/OpenShift terms.
- **Help/tutorial**: rewrite for oc/OpenShift/EX280 (modes, controls, objective panel, Files panel,
  EX280 Prep, command examples, docs links). Menu descriptions updated.
- **Draw mode** (`draw.html`): palette/meta/default specs for OpenShift kinds (Project replaces
  Namespace, add Route, BuildConfig, ImageStream, Template, Subscription, SCC, ClusterResourceQuota,
  LimitRange, User, Group, IPAddressPool, L2Advertisement; keep Ingress/PV/StorageClass as advanced);
  correct apiVersions; auto-layout sections: Cluster, Workloads, Builds, Networking, Config/Storage,
  Security/Identity; connection model: Route→Service→Deployment, BuildConfig→ImageStream→Deployment,
  SCC→ServiceAccount/Pod; YAML export uses correct apiVersion; branding/meta/title/watermark updated.
- **Metrics**: `oc adm top`-style pods/nodes/cluster panel; route admissions; build queue; quota usage.
- **Settings/achievements/stats modals**: labels/data updated (Achievements count, `/60` stars stays
  20 levels × 3).
- **Achievements** (`js/data/Achievements.js`, conditions receive ScoringEngine `stats`): rewrite
  ~40 achievements OpenShift-themed. Required stat fields (ScoringEngine maintains):
  `totalPodsDeployed`, `deploymentsCreated`, `servicesCreated`, `projectsCreated` (was namespacesCreated),
  `routesCreated`, `buildsCompleted`, `imageStreamsCreated`, `templatesProcessed`, `helmReleases`,
  `manifestsApplied`, `kustomizeOverlaysApplied`, `usersCreated`, `groupsCreated`, `rolebindingsCreated`,
  `sccGrants`, `operatorsInstalled`, `incidentsResolved`, `maxConcurrentPods`, `levelsCompleted`,
  `chaptersCompleted`, `threeStarLevels`, `totalStars`, `challengesCompleted`, `threeStarChallenges`,
  `longestChaosSurvival`, `commandsExecuted`, `yamlViewed`, `architectureScore` stats, `examPrepMastered`.
- **ScoringEngine Architecture Advisor**: categories re-theme to OpenShift: highAvailability,
  security (SCC/RBAC/netpol/secrets), networking (Routes/LB/TLS), scalability (HPA/replicas),
  costEfficiency, reliability (probes/PDB), configuration (ConfigMaps/secrets/manifests),
  storage, observability (events/logs/metrics/cluster operators), organization (projects/labels/quotas).
  Keep `calculateArchitectureScore` return shape `{total, categories}`.
- **ScoringEngine stat/progress keys**: keep existing progress schema; rename `namespacesCreated` →
  `projectsCreated` with migration fallback; add new counters/events. localStorage key
  `openshiftgames_progress`; load old `k8sgames_*` keys once and migrate if present (do not lose
  existing users' progress on the original domain — best-effort migration).
- **Renderer** (`ResourceMeshes.js`): add a distinct creator for every new kind using the existing
  helpers (`createStandardMaterial`, `createGlowRing`, `createLabelSprite`, geometry helpers);
  Route: arrow/road sign; Project: folder/building; BuildConfig: gear+wrench; Build: gear; ImageStream:
  stacked disks; Template: page; Subscription/Operator: puzzle piece; SCC: shield; ClusterResourceQuota:
  bar chart; LimitRange: ruler; User: person; Group: people; ClusterOperator: status beacon;
  IPAddressPool/L2Advertisement: network nodes. OpenShift kinds use red/orange accents (#EE0000,
  #F97316) where sensible. `ClusterRenderer.autoAlign` layout map must include new kinds; Minimap
  `KIND_SIZES` add new kinds. Keep status color semantics.

---

## 13. File ownership & integration contracts

| Owner         | Files (exclusive write scope)                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lead          | `docs/CONVERSION-SPEC.md`, root `NOTICE`, git/github operations, final integration fixes                                                                                                                                                                                                                                                    |
| engine-dev    | `js/ui/CommandBar.js`, `js/engine/GameEngine.js`, `js/engine/ClusterState.js`, `js/engine/SimulationTick.js`, `js/engine/RBACEngine.js` (new, optional)                                                                                                                                                                                     |
| resources-dev | `js/resources/*.js` (incl. `ResourceBase.js` serializer helpers), new `js/resources/OpenShiftResources.js`, `js/resources/IdentityResources.js`, new `js/resources/KindClasses.js`, `js/data/kindRegistry.js` (finalise `createResource` class wiring), `js/resources/ManifestSerializer.js` (shared YAML/describe formatting if split out) |
| render-dev    | `js/rendering/*.js` (all), `js/ui/Minimap.js`, `draw.html`                                                                                                                                                                                                                                                                                  |
| campaign-dev  | `js/data/CampaignLevels.js`, `js/modes/CampaignMode.js`, `js/data/Achievements.js`, `js/engine/ObjectiveEvaluator.js` (new)                                                                                                                                                                                                                 |
| incidents-dev | `js/data/IncidentDefs.js`, `js/engine/IncidentEngine.js`, `js/ui/IncidentPanel.js`                                                                                                                                                                                                                                                          |
| modes-dev     | `js/modes/ChallengeMode.js`, `js/modes/SandboxMode.js`, `js/modes/ChaosMode.js`, `js/engine/ScoringEngine.js`, `js/ui/HUD.js`, `js/ui/InspectorPanel.js`, `js/ui/ContextMenu.js`, `js/ui/MetricsDashboard.js`, `js/ui/SettingsPanel.js`                                                                                                     |
| brand-dev     | `index.html`, `README.md`, `LICENSE` (no change), `NOTICE` (Lead), `robots.txt`, `vercel.json`, `style.css`, `og-image.html`, `js/data/EX280Objectives.js`, `js/modes/ExamPrepMode.js`, `docs/EX280-STUDY-GUIDE.md` (from research), `docs/EXAM-PREP.md`                                                                                    |
| manifests-dev | `js/engine/YamlParser.js`, `js/engine/ManifestEngine.js`, `js/ui/ManifestPanel.js`, `js/data/ManifestFiles.js`, `js/data/HelmCharts.js` (new), `docs/declarative-engine.md`                                                                                                                                                                 |
| verifier      | `scripts/verify.mjs`, `scripts/browser-test.mjs`, `scripts/lib/*`, `docs/verification-report.md`, screenshot generation (`screenshot.png`, `og-image.png` via Chrome)                                                                                                                                                                       |

Rules: never edit a file outside your scope. If a change is needed elsewhere, message the Lead with
the exact file/line and desired change. New files are allowed only in your scope or as listed.
`index.html` is owned by brand-dev; engine-dev/resources-dev/etc. must request shell changes through
Lead. All owners: run `node --check` equivalent on edited files, keep existing functionality, keep
exports stable unless the spec says otherwise, no dependencies/build step, no reformatting unrelated code.

Integration points provided by engine-dev (must be implemented early, by end of first phase):

- `GameEngine.currentUser`, `.currentProject`, `.switchProject(name)`, `.login(user)`, `.logout()`,
  `.canI(verb, resource, namespace?, user?)`, `.applyManifestObject(obj)`, `.getCommandHistory()`,
  `.recordCommand(raw, success)`; `ClusterState.getProjects()`, `.canI(...)`, `.sccForServiceAccount(...)`,
  `.grantSCC/revokeSCC`, `.getUser/.getGroup/.getUserGroups`, `.checkQuota`, LimitRange helpers.
- `ObjectiveEvaluator` contract: `evaluateObjective(obj, ctx)` → `{completed, current, target}` where
  `ctx = {clusterState, gameEngine, incidentEngine, scoringEngine, manifestEngine}`. campaign-dev
  implements all types; modes-dev ChallengeMode imports it (integration by Lead or modes-dev after
  campaign-dev announces availability).
- `ManifestEngine` API per section 7, instantiated in `ManifestPanel.init()`; sets
  `window.game.manifestEngine`; levels call `manifestEngine.resetFiles()` + optional focused files.

Dependency order: spec → phase 1 (engine-dev, resources-dev, manifests-dev, brand-dev shell, modes-dev
UI/scoring skeleton) → phase 2 (campaign-dev levels, incidents-dev data/engine, brand-dev Exam Prep +
docs) → phase 3 (verifier + integration fixes). Content authors may start structure immediately and
must read `docs/research/*.md` before finalizing copy; researchers will fact-check.

---

## 14. Verification & acceptance (verifier)

`scripts/verify.mjs` (Node, no deps) checks:

- Syntax: every `*.js` parses as ESM (`node --input-type=module --check < file`).
- Import graph: every relative import path exists; every named import exists in the target module
  (static export scan; tolerate dynamic/`window` access).
- Registry consistency: ClusterState kind list == ResourceMesh creators (or documented fallback) ==
  palette `data-resource` kinds == draw palette kinds == ResourceClasses index.html map.
- Data integrity: level/challenge/incident kinds exist; incident types referenced by levels/challenges
  exist; objective types implemented in ObjectiveEvaluator; EX280 objective mapping covers all
  official bullets; achievement stat keys exist; API version map matches spec; no `Namespace` kinds,
  no `kubectl` UI strings outside allowlist, no forbidden upstream URLs outside attribution context.
- File invariants: no external JS deps added; importmap pinned; LICENSE/NOTICE present; README has
  attribution, play instructions, EX280 coverage table.
- YAML parser self-tests: parse/stringify round-trip for default manifest files; kustomize merge test;
  helm template substitution test.
  `scripts/browser-test.mjs` (installs puppeteer-core in `/tmp/verify-tools` only; repo stays clean):
- Load index.html from a local static server; wait for menu; assert no console errors/page errors.
- Start Sandbox; assert palette has all kinds; create one of each kind via `app.placeResource(kind)`/engine;
  assert renderer meshes exist for each; assert inspector/describe/YAML render without errors.
- Run command smoke suite via `app.commandBar._executeCommand(...)`: oc whoami, oc new-project demo,
  oc create deployment web --image=nginx:latest, oc expose svc/web, oc get routes, oc set env,
  oc apply -f manifests/deployment.yaml, oc apply -k kustomize/overlays/prod, oc process -f templates/webapp-template.yaml -p APP_NAME=web, helm install webapp helm/webapp, htpasswd + oauth + login,
  oc adm policy add-scc-to-user anyuid -z default -n demo, oc auth can-i --as=..., oc create user/group,
  oc create quota + oc apply -f examples/limitrange.yaml (no `oc create limitrange` subcommand),
  oc get co, oc get clusterversion. Assert success/expected text.
- Start campaign levels 1-20 via `new CampaignMode(...)`/app and assert objectiveProgress initializes;
  start challenges 1-12; open EX280 Prep overlay; open Files panel; load draw.html and assert palette +
  YAML export.
- Screenshots (1600x900, dark): main menu, sandbox with resources, a campaign level, EX280 Prep
  overlay → save `screenshot.png` (README hero) and `docs/screenshots/*.png`; regenerate
  `og-image.png` via `og-image.html` (or composited from menu screenshot, 1200x630).
  Report failures to Lead with file/line and reproduction; Lead dispatches fixes and re-runs.
  Definition of done: both scripts pass, screenshots committed, README/study guide accurate, game playable.

---

## 15. Git / GitHub detachment & deployment (Lead only)

- Remove `upstream` remote (keep local backup bundle outside repo before rewriting history).
- Keep working tree changes; at the end create fresh standalone history (single initial commit
  authored as Gustaf Ekfeldt <G-man3207@users.noreply.github.com>) on `main`, push to a NEW
  non-fork repo `G-man3207/openshiftgames`; rename the old fork to `k8sgames-fork` via
  `gh repo rename`; set repo description/homepage/topics; verify remote content.
- Never force-push to the old fork; never push to upstream.
- Vercel: keep `vercel.json` rewrites (`/draw`); canonical URL assumed `https://shifting.pro`
  (documented in README as deployment URL to update if different). No server code.
- Root files: `README.md`, `LICENSE` (Apache-2.0 unchanged), `NOTICE`, `robots.txt` (sitemap URL
  updated/removed), `vercel.json`, `og-image.html`, `og-image.png`, `screenshot.png`, `style.css`.

---

## 16. Non-goals (v1)

- No real cluster connectivity, no backend, no accounts/auth server, no telemetry.
- Not a full Kubernetes/OpenShift API implementation: only the behaviours needed for teaching and
  for the simulator's own controllers.
- No new npm/build tooling, no framework migration, no visual redesign beyond OpenShift theming.
- DeploymentConfigs are deprecated in OCP; do not add them as a first-class game kind (a `dc` CLI
  alias may warn and map to Deployment).
- Do not delete the original project's attribution or relicense the derivative; Apache-2.0 stays.
