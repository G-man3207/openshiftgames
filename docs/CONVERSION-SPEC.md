# OpenShift Games — Conversion Specification (v1)

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

| Item | Value |
|---|---|
| Product name | **OpenShift Games** |
| Tagline | Learn OpenShift by playing. Built for EX280. |
| Menu subtitle | OpenShift 4.22 Cluster Simulation · Built for EX280 |
| Repo | https://github.com/G-man3207/openshiftgames |
| Canonical demo URL | https://shifting.pro (used for og:url / og:image; README notes how to change) |
| License | Apache-2.0 (keep `LICENSE`), add `NOTICE` |
| Command prompt | `$ oc` (accepted input: optional leading `oc` or `kubectl`; both stripped; help says `oc`) |
| localStorage prefix | `openshiftgames_` (settings key `openshiftgames_settings`, progress key `openshiftgames_progress`) |
| YAML export filename | `openshiftgames-cluster.yaml` |
| Draw page | `/draw` → `draw.html`, title "OpenShift Draw — 3D OpenShift Architecture Diagram", watermark "OpenShift Games · /draw" |
| Theme accent | OpenShift red `#EE0000` for brand accents / OpenShift-specific meshes; existing status colors stay |

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

| Kind | apiVersion | Scope | Status model |
|---|---|---|---|
| Pod | v1 | ns | phase Pending/Running/Succeeded/Failed, containerStatuses |
| Deployment | apps/v1 | ns | replicas, readyReplicas, updatedReplicas, conditions Available/Progressing |
| ReplicaSet | apps/v1 | ns | replicas, readyReplicas |
| StatefulSet | apps/v1 | ns | replicas, readyReplicas, currentRevision |
| DaemonSet | apps/v1 | ns | desiredNumberScheduled, numberReady |
| Job | batch/v1 | ns | phase Pending/Running/Complete/Failed, succeeded/failed |
| CronJob | batch/v1 | ns | suspend, lastScheduleTime, active[] |
| Service | v1 | ns | type, clusterIP, ports, selector, loadBalancer.ingress |
| Route | route.openshift.io/v1 | ns | spec.host/path/to/tls/port, status.ingress[].conditions Admitted |
| Ingress | networking.k8s.io/v1 | ns | rules, tls |
| NetworkPolicy | networking.k8s.io/v1 | ns | podSelector, ingress[], egress[], policyTypes |
| ConfigMap | v1 | ns | data, binaryData |
| Secret | v1 | ns | type, data (displayed decoded in simulator), stringData |
| PersistentVolumeClaim | v1 | ns | phase Pending/Bound/Lost, capacity |
| PersistentVolume | v1 | cluster | phase Available/Bound/Released, capacity, accessModes, storageClassName |
| StorageClass | storage.k8s.io/v1 | cluster | provisioner, reclaimPolicy, volumeBindingMode |
| HorizontalPodAutoscaler | autoscaling/v2 | ns | currentReplicas, desiredReplicas, conditions |
| PodDisruptionBudget | policy/v1 | ns | minAvailable/maxUnavailable, disruptionsAllowed |
| ResourceQuota | v1 | ns | hard, used, status |
| LimitRange | v1 | ns | limits[] {type: Container/Pod, default, defaultRequest, min, max} |
| Role / RoleBinding | rbac.authorization.k8s.io/v1 | ns | rules / roleRef, subjects |
| ClusterRole / ClusterRoleBinding | rbac.authorization.k8s.io/v1 | cluster | rules / roleRef, subjects |
| ServiceAccount | v1 | ns | secrets[] |
| Project | project.openshift.io/v1 | cluster | phase Active/Terminating, displayName |
| BuildConfig | build.openshift.io/v1 | ns | source, strategy, output, triggers, status.lastVersion |
| Build | build.openshift.io/v1 | ns | phase New/Pending/Running/Complete/Failed/Cancelled, output |
| ImageStream | image.openshift.io/v1 | ns | status.tags[{tag,items[{dockerImageReference}]}], lookupPolicy |
| Template | template.openshift.io/v1 | ns | parameters[], objects[], message |
| Subscription | operators.coreos.com/v1alpha1 | ns (openshift-operators) | phase Installing/Succeeded/Failed, installedCSV, channel, source |
| SecurityContextConstraints | security.openshift.io/v1 | cluster | priority, allowPrivilegedContainer, runAsUser, fsGroup, users[], groups[] |
| ClusterResourceQuota | quota.openshift.io/v1 | cluster | selector.labels.matchLabels, quota.hard, status.total.used |
| User | user.openshift.io/v1 | cluster | fullName, groups[], identities[] |
| Group | user.openshift.io/v1 | cluster | users[] (stored as spec.users in the game) |
| Identity | user.openshift.io/v1 | cluster | providerName, providerUserName, user.name — auto-created only, not in palette |
| OAuth | config.openshift.io/v1 | cluster | singleton name `cluster`; spec.identityProviders[] |
| ClusterOperator | config.openshift.io/v1 | cluster | status.conditions Available/Progressing/Degraded, versions |
| ClusterVersion | config.openshift.io/v1 | cluster | singleton name `version`; status.desired.version/channel |
| IPAddressPool | metallb.io/v1beta1 | ns (metallb-system) | addresses[] |
| L2Advertisement | metallb.io/v1beta1 | ns (metallb-system) | ipAddressPools[] |

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
Deployment with openshift extras: { replicas, selector, strategy, template,
   triggers: [{type: ImageChange, imageChangeParams: {automatic: true,
              containerNames: ["main"], from: {kind: ImageStreamTag, name: "app:latest"}}}] }
```

Default projects seeded in `ClusterState`: `default`, `openshift`, `openshift-config`,
`openshift-operators`, `openshift-ingress`, `openshift-monitoring`, `openshift-console`,
`openshift-authentication`, `openshift-image-registry`, `kube-system`.
Default cluster resources seeded in every mode: ClusterOperators (authentication, console, dns,
ingress, monitoring, network, image-registry, kube-apiserver, openshift-apiserver,
openshift-controller-manager, operator-lifecycle-manager, storage, etcd) with
Available=True/Progressing=False/Degraded=False and version `4.22.0`; ClusterVersion `version`
(desired.version `4.22.0`, channel `stable-4.22`); SCCs `restricted-v2` and `nonroot-v2` (groups
`system:authenticated`), `anyuid` and `privileged` (no subjects); users `kubeadmin` (cluster-admin
binding) and `admin`; ImageStreams in `openshift`: `nodejs` (tags 20, 18), `python` (tag 3.12),
`nginx` (tag 1.26); Nodes as specified per level/mode.

---

## 4. Command bar — target command catalog

Input handling: trim; accept optional leading `oc ` or `kubectl ` (strip; if `kubectl`, append an
educational hint "tip: on OpenShift, use oc"); prompt rendered as `$ oc`; support pipes
(`oc process ... | oc apply -f -`) and output redirects (`oc get deploy web -o yaml > web.yaml`) for
the virtual file system. Track every executed raw command in `gameEngine` command history with
`{raw, baseCommand, success, timestamp}`. Tab completion must include new kinds/commands.

Required base commands and behaviour (implement in CommandBar.js; complex mutations may call
GameEngine helpers):
- Lifecycle: `oc login [-u user] [-p pass]`, `oc logout`, `oc whoami`, `oc project [name]`,
  `oc projects`, `oc new-project <name> [--description=] [--display-name=]`, `oc delete project <name>`.
- Querying: `oc get <resource> [name] [-n project] [-A] [-o wide|yaml|json|name|jsonpath=...|custom-columns=...] [-l selector] [--field-selector=...] [--sort-by=...] [--show-labels]`;
  `oc describe <resource> <name>`; `oc status [-n]`; `oc events`/`oc get events [-w]`;
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
  `oc adm top pods|nodes`, `oc get clusteroperators`, `oc get clusterversion`, `oc adm must-gather`
  (simulated output), `oc adm inspect ns/<project>` (simulated output).
- Mutations: `oc create <resource> <name> [flags]`, `oc apply -f <file>`, `oc create -f <file>`,
  `oc replace -f <file>`, `oc delete -f <file>`, `oc apply -k <dir>`, `oc delete <resource> <name>`,
  `oc scale <resource> <name> --replicas=N`, `oc edit <resource> <name>` (opens editor modal),
  `oc label <resource> <name> key=value`, `oc annotate ...`, `oc patch <resource> <name> -p '<json>' --type=merge|strategic`,
  `oc set env deployment/name KEY=VALUE [--from=configmap|secret/name] [--list] [--remove=KEY]`,
  `oc set image deployment/name container=image`, `oc set resources deployment/name --limits=cpu=500m,memory=512Mi --requests=...`,
  `oc set probe deployment/name --liveness|--readiness --get-url=http://:8080/healthz | --remove`,
  `oc set serviceaccount deployment/name <sa>`, `oc set triggers bc/name --from-image=app:latest --containers=main | --remove`,
  `oc set selector svc/name app=web` (if supported; else patch fallback),
  `oc set volumes deployment/name --add --name=data --claim-name=data --mount-path=/data`.
- Deploy: `oc new-app <image>|<imagestream>|<git-url> [--name=] [--code=] [-e KEY=VALUE]`,
  `oc new-app --template=<name> [-p KEY=VALUE] [-n project]`, `oc new-app -f <template-file> [-p ...]`,
  `oc new-build <image-stream> --name=<bc>` / `oc new-build --code=<git> --name=<bc>`,
  `oc start-build <bc> [--follow] [--from-dir=.]`, `oc cancel-build <bc>`, `oc logs -f bc/<name>`.
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
  `oc create limitrange <name> --default=cpu=500m,memory=512Mi --default-request=... --max=...` (or -f),
  `oc create clusterquota <name> --project-label-selector=... --hard=...`,
  `oc describe quota|limitrange|clusterresourcequota`, `oc get quota|limitrange|clusterquota`.
- Templates/Operators: `oc get templates -n openshift`, `oc process -f <file> [-p K=V] [-o yaml]`,
  `oc get csv|subscriptions|operatorgroups`, `oc create -f <subscription.yaml>`,
  `oc delete subscription <name> -n openshift-operators` (uninstall), `oc delete csv <name>` (delete operator).
- Builds/images: `oc get bc|builds|is|istag`, `oc start-build`, `oc tag <src> <dst> [--scheduled]`,
  `oc import-image <is>:<tag> --from=<image> --confirm`, `oc describe is|bc|build`.
- Cluster: `oc adm cordon|uncordon|drain node/<node>`, `oc adm taint nodes <node> key=value:NoSchedule`,
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

---

## 5. Controllers / simulation (SimulationTick.js)

Extend the existing fixed-step simulation with OpenShift controllers:
- `_tickProjects`: Projects become Active immediately; deletion marks Terminating.
- `_tickRoutes`: resolve Service + Endpoints; if the Service has ≥1 ready endpoint, set
  `status.ingress=[{host, routerName:"default", conditions:[{type:"Admitted",status:"True",reason:"Accepted",message:"..."}], wildcardPolicy:"None"}]`;
  else Admitted=False reason "ServiceUnavailable" message "no endpoints available".
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
  `auth:provider-ready`.
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
`restricted-v2` SCC; `default` ServiceAccount exists in each project. Password store: virtual
`htpasswd` file in ManifestEngine (section 7) is the source of truth for HTPasswd logins; login
succeeds only when `authProvider.ready` and the user/password match the file, creating/updating the
User + Identity objects and setting `currentUser`. `oc delete user` removes bindings/identity too.
`oc login` as a user without OAuth configured fails with
`Login failed (401 Unauthorized): HTPasswd identity provider is not configured`.

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
   1. *Your First Project* — oc whoami/status, create Project, deploy first Pod/Deployment; objectives:
      `project`, `login`, `deploy Pod`, `deploy Deployment`. Tutorial steps.
   2. *Query, Format, Filter* — labels/selectors, `-o wide/yaml/jsonpath/custom-columns`,
      `--field-selector`, `--sort-by`, `oc explain`; objectives: `command` patterns, `label`,
      `deploy`.
   3. *Logs, Events & Health* — deploy app, investigate CrashLoop incident with oc describe/logs/events,
      read ClusterOperators/clusterversion, `oc adm top`; objectives: `resolve CrashLoopBackOff`,
      `command oc logs`, `clusterHealth`, `investigate`.
   4. *Declarative Manifests* — edit manifests/deployment.yaml + service.yaml, `oc apply -f`,
      update + re-apply, export with `oc get ... -o yaml >`; objectives: `manifest` files, `deploy`
      kinds, `command`.
2. **Declarative & Kustomize** (V422 Declarative Resource Management)
   5. *Kustomize Base* — apply base overlay; objectives: `kustomize` base path, `deploy`.
   6. *Kustomize Overlays* — prod overlay patches image/replicas/namespace; objectives:
      `kustomize` prod path, `image` contains, `replicas`/scale, `command`.
   7. *Secrets & ConfigMaps* — create secret/configmap via oc create -f and oc create secret,
      mount/env into Deployment; objectives: `deploy Secret`, `deploy ConfigMap`, `mount`, `envFrom`,
      `noConfigMap`.
   8. *Templates & Helm* — process OpenShift template with parameters (`oc process -f | oc apply -f -`),
      install Helm chart (`helm install`), verify resources; objectives: `template`, `helm`, `deploy`.
3. **Deploy & Expose** (V422 Deploy applications / Network security / Non-HTTP)
   9. *Images, Builds & Image Streams* — `oc new-app`, BuildConfig→Build→ImageStream complete,
      tag/digest, `oc start-build`, verify istag; objectives: `build`, `imageStream`, `deploy`,
      `command`.
   10. *Rolling Updates & Rollbacks* — update image, watch rollout, ImagePullBackOff incident,
       `oc rollout undo/status/history`; objectives: `update`, `rollback`, `resolve ImagePullBackOff`.
   11. *Services & Routes* — service selector, `oc expose svc`, edge TLS route with cert secret,
       verify Admitted; objectives: `connect`, `route`, `tls`, `deploy Secret`.
   12. *Non-HTTP & Load Balancer* — install MetalLB operator (Subscription), IPAddressPool +
       L2Advertisement, Service type LoadBalancer with EXTERNAL-IP; passthrough/reencrypt route for
       TLS app; objectives: `operator`, `serviceType LoadBalancer`, `tls passthrough`, `route`.
4. **Identity, RBAC & Self-service** (V422 Authn/authz + developer self-service)
   13. *HTPasswd & Users* — create htpasswd users, secret in openshift-config, configure OAuth,
       login as user, change password; objectives: `user`, `login`, `command htpasswd/oauth`.
   14. *Groups & RBAC* — groups, rolebindings, `oc auth can-i`, least privilege, UnauthorizedAccess
       incident; objectives: `group`, `canI`, `leastPrivilege`, `deploy RoleBinding`.
   15. *Quotas, LimitRanges & Templates* — ClusterResourceQuota, ResourceQuota, LimitRange, project
       template from `openshift` project; objectives: `quota`, `limitRange`, `template`,
       `resolve ResourceQuotaExceeded`.
   16. *Service Accounts & API Access* — SA, `oc set serviceaccount`, grant role to SA,
       token/API access + `oc auth can-i --as=system:serviceaccount:...`; objectives:
       `deploy ServiceAccount`, `canI --as`, `deploy RoleBinding`.
5. **Security & Operations** (V422 application security, operators, jobs)
   17. *SCC & Privileged Apps* — SCCForbidden incident, `oc adm policy add-scc-to-user anyuid -z default`,
       run privileged app, verify; objectives: `scc`, `privileged`, `resolve SCCForbidden`.
   18. *Operators* — install Subscription (operator group/CSV), verify Succeeded, uninstall/delete;
       objectives: `operator installed`, `operator removed`, `command`.
   19. *Jobs & CronJobs* — one-time job and cron job, verify completion/schedule, fix failed job;
       objectives: `complete Job`, `cronJob`, `resolve JobDeadlineExceeded`.
   20. *EX280 Final: Production Platform* — build a complete platform: Project, ResourceQuota,
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

## 10. Challenges — 12 timed labs (js/modes/ChallengeMode.js, reuse ObjectiveEvaluator)

Keep the challenge runner architecture (`CHALLENGES`, `startChallenge`, `getStatus`, etc.).
Replace scenarios with these (id/title fixed; each 180-420s, objectives use section 9 schema,
`startingResources` + `preloadIncidents` + `availableResources` + `hints`):

1. *Three-Tier App* — two Projects (frontend/backend), deployments, services, route to frontend.
2. *Fix CrashLoopBackOff* — investigate + resolve CrashLoopBackOff, health ≥90%.
3. *Route with Edge TLS* — service + `oc create route edge` with TLS secret, Admitted.
4. *Kustomize Prod Overlay* — apply prod overlay, verify image tag + replicas via objective + command.
5. *Build & Deploy from Source* — `oc new-app`/BuildConfig build completes, ImageStreamTag, Deployment running, Route.
6. *Quota Guardrail* — ResourceQuota + LimitRange + project requests; deploy within limits; resolve quota incident.
7. *RBAC for a New Teammate* — create user/group, rolebinding edit in project, `oc auth can-i` true, least privilege.
8. *SCC for a Privileged Workload* — grant anyuid to SA, run privileged/uid-0 pod, resolve SCCForbidden.
9. *Network Isolation* — default-deny NetworkPolicy + allow only frontend→backend, fix DNS egress.
10. *Install an Operator* — Subscription Succeeded (+ uninstall/delete objective), MetalLB LoadBalancer service with EXTERNAL-IP.
11. *HTPasswd Onboarding* — htpasswd users, OAuth config, login as user, group membership, permissions.
12. *EX280 Speed Run* — mixed: project, apply manifests, build, route TLS, quota, job, RBAC; under time.

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
   Overall progress bar (X / 55 objectives) and readiness verdict (Ready ≥90% mastered).
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

| Owner | Files (exclusive write scope) |
|---|---|
| Lead | `docs/CONVERSION-SPEC.md`, root `NOTICE`, git/github operations, final integration fixes |
| engine-dev | `js/ui/CommandBar.js`, `js/engine/GameEngine.js`, `js/engine/ClusterState.js`, `js/engine/SimulationTick.js`, `js/engine/RBACEngine.js` (new, optional) |
| resources-dev | `js/resources/*.js` (incl. `ResourceBase.js` serializer helpers), new `js/resources/OpenShiftResources.js`, `js/resources/IdentityResources.js`, new `js/resources/KindClasses.js`, `js/data/kindRegistry.js` (finalise `createResource` class wiring), `js/resources/ManifestSerializer.js` (shared YAML/describe formatting if split out) |
| render-dev | `js/rendering/*.js` (all), `js/ui/Minimap.js`, `draw.html` |
| campaign-dev | `js/data/CampaignLevels.js`, `js/modes/CampaignMode.js`, `js/data/Achievements.js`, `js/engine/ObjectiveEvaluator.js` (new) |
| incidents-dev | `js/data/IncidentDefs.js`, `js/engine/IncidentEngine.js`, `js/ui/IncidentPanel.js` |
| modes-dev | `js/modes/ChallengeMode.js`, `js/modes/SandboxMode.js`, `js/modes/ChaosMode.js`, `js/engine/ScoringEngine.js`, `js/ui/HUD.js`, `js/ui/InspectorPanel.js`, `js/ui/ContextMenu.js`, `js/ui/MetricsDashboard.js`, `js/ui/SettingsPanel.js` |
| brand-dev | `index.html`, `README.md`, `LICENSE` (no change), `NOTICE` (Lead), `robots.txt`, `vercel.json`, `style.css`, `og-image.html`, `js/data/EX280Objectives.js`, `js/modes/ExamPrepMode.js`, `docs/EX280-STUDY-GUIDE.md` (from research), `docs/EXAM-PREP.md` |
| manifests-dev | `js/engine/YamlParser.js`, `js/engine/ManifestEngine.js`, `js/ui/ManifestPanel.js`, `js/data/ManifestFiles.js`, `js/data/HelmCharts.js` (new), `docs/declarative-engine.md` |
| verifier | `scripts/verify.mjs`, `scripts/browser-test.mjs`, `scripts/lib/*`, `docs/verification-report.md`, screenshot generation (`screenshot.png`, `og-image.png` via Chrome) |

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
  oc create quota/limitrange, oc get co, oc get clusterversion. Assert success/expected text.
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
