# OpenShift Games

**Learn Red Hat OpenShift by playing. Built for EX280.**

OpenShift Games is a browser-based 3D OpenShift cluster simulator. Create Projects with real
`oc` commands, deploy applications, expose Routes, run S2I builds, configure SCCs, RBAC, quotas and
Operators — then investigate and fix realistic production incidents. No install, no signup, no build
step: every lab runs client-side in your browser.

**Play:** https://shifting.pro · **Draw:** https://shifting.pro/draw

**Documentation:** the learner-facing guides live in the
[GitHub wiki](https://github.com/G-man3207/openshiftgames/wiki) — start with the
[EX280 Study Guide](https://github.com/G-man3207/openshiftgames/wiki/EX280-Study-Guide) and the
[EX280 Prep mode](https://github.com/G-man3207/openshiftgames/wiki/Exam-Prep) reference. The engineering
docs (architecture map, conversion spec, declarative engine, research notes, verification report) stay in
[`docs/`](docs/).

Target platform: **Red Hat OpenShift Container Platform 4.22** (Kubernetes 1.35, CRI-O) · Exam: **EX280V422**
(“Red Hat Certified System Administrator in OpenShift exam” on redhat.com; the LMS objectives PDF lists
the credential as “Red Hat Certified Specialist in OpenShift Administration” — same objectives, both
names are shown in EX280 Prep).

![OpenShift Games — 3D OpenShift cluster simulation in the browser](screenshot.png)

---

## Features

- **`oc` terminal** — a simulated OpenShift CLI with `get`, `describe`, `apply -f`, `create`,
  `new-app`, `new-project`, `expose`, `create route`, `start-build`, `set env|image|resources|volume`,
  `rollout` (`status --timeout|history|undo`; `status --timeout` blocks like real `oc` and exits 1
  with `error: timed out waiting for the condition` on a stalled rollout, so `&&` chains stop),
  `logs` (Pods, Deployments, Jobs), `exec`, `rsh`, `cp`, `wait`,
  `diff -f`, `patch --type=strategic|merge|json`, `adm policy` (RBAC + SCC), `auth can-i`,
  `adm top`, `adm cordon|drain`, `adm taint` (all real forms, including kubectl's empty-value
  `key=:Effect`), `create quota|clusterquota` (LimitRanges are declarative —
  `oc apply -f`, there is no `oc create limitrange` subcommand), `create token`,
  `image info`, `process`, `helm` (repo/search/install/upgrade/history/rollback), `htpasswd`,
  `debug node` (interactive `chroot /host` + `systemctl`/`journalctl` kubelet troubleshooting),
  `--dry-run=client|server`, `<resource>.<group>` tokens, escaped jsonpath keys, `custom-columns`,
  `events --field-selector`, pipes, redirects and `-f -` stdin. Container names follow real `oc`
  (`oc create deployment --image=…` names the container after the image; `oc set image` never adds
  one). `oc get rolebinding|clusterrolebinding` prints the ROLE as
  `<roleRef.kind>/<roleRef.name>` (`ClusterRole/admin`, `Role/edit`), so Role vs ClusterRole is
  visible like real `oc`, and `-o wide` prints ServiceAccount subjects as `<namespace>/<name>`
  (`qa8/deployer`) like `rbac.SubjectsStrings`. `oc exec`/`oc rsh` return the remote command's exit
  status: an unmodelled binary fails with the real OCI `executable file not found in $PATH` error
  and `command terminated with exit code 127`, coreutils behave like the image's own binaries
  (`true` exits 0 silently, `false` exits 1), and a real command's failure is surfaced with its real
  status (`ls` on a missing path exits 2, `cat`/`grep` failures exit 1) followed by the real
  `command terminated with exit code <N>` line, so `&&` chains stop (`||` still runs). Cluster DNS
  is NetworkPolicy-aware: `nslookup`, `dig` and `getent hosts` query the same `openshift-dns`
  dns-default Pods on 5353 that `curl`'s name resolution uses, print the real tool formats
  (`nslookup` applies the Pod's search list, so bare `web` prints
  `Name: web.<ns>.svc.cluster.local`; `dig +short` prints just the Service ClusterIP and `dig` has
  its own header/ANSWER/SERVER format; `getent hosts` prints the glibc `IP  canonical` line) and
  fail with `;; connection timed out; no servers could be reached` plus the real exit status when
  an egress policy blocks DNS — the lab 13 diagnostic flow. Verbose `curl` prints
  `Trying`/`Connected` only in the real order (never before a name resolves, never `Connected` on a
  failed connection). RBAC is genuinely enforced: a plain user gets the real
  `Error from server (Forbidden): …` for reads and writes they are not allowed to perform.
  `oc` is the taught command; a leading `kubectl` is accepted as an alias with an educational hint.
- **A real shell around `oc`** — `vim`/`vi` (opens the manifest editor), `cat`, `echo` with
  `>`/`>>` redirects, heredocs, command substitution, `;`/`&&`/`||` sequencing, session variables
  (`export NS=default`, `$NS`/`${NS}` expansion), bash's `$?`/`${?}` exit-status parameter
  (`oc exec … -- ls /nope; echo rc=$?` → `rc=2`, `false; echo $?` → `1`) and pipes through
  `grep`, `sed`, `tail`, `head`, `cut`, `wc`, `sort`, `base64 -d`, `openssl` (including real
  `req -x509` / `x509` PEM handling), `htpasswd`, `skopeo` — so exam workflows like writing YAML in
  the terminal,
  decoding a Secret and `oc apply -f -` work as on a real workstation. Unsupported shell grammar
  (loops, conditionals) is rejected with a clear simulator message instead of silently running part
  of the line. A workstation-side `curl`
  resolves Route hosts through the router model (edge/passthrough/reencrypt, http redirect and
  NetworkPolicy reachability), with real flags and `-w/--write-out` (`%{http_code}` etc.), and
  `oc exec`/`oc rsh` show the Pod's real volumes, ConfigMaps, Secrets, service-account token and
  env, and `cat /etc/resolv.conf` inside a Pod prints the cluster DNS configuration
  (`search <project>.svc.cluster.local svc.cluster.local cluster.local`, `nameserver 172.30.0.10`,
  `options ndots:5`).
- **First-class OpenShift resources** — Project, Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet,
  Job, CronJob, Service, Route, Ingress, NetworkPolicy, ConfigMap, Secret, PVC, PV, StorageClass,
  HPA, PDB, ResourceQuota, LimitRange, ClusterResourceQuota, ServiceAccount, Role, RoleBinding,
  ClusterRole, ClusterRoleBinding, SCC, BuildConfig, Build, ImageStream, Template, Subscription,
  OperatorGroup, InstallPlan, ClusterServiceVersion, PackageManifest, MetalLB, User, Group,
  ClusterOperator, ClusterVersion, IPAddressPool, L2Advertisement, PrometheusRule, Alertmanager.
  A single central registry (`js/data/kindRegistry.js`) drives the palette, 3D renderer, inspector,
  command bar, minimap and YAML export.
- **S2I builds & ImageStreams** — `oc new-app`, BuildConfig → Build → ImageStream lifecycle, image
  change triggers and rollouts, internal registry image references. In the paused pre-start sandbox
  the `oc new-app` ScalingReplicaSet event already prints the full deterministic
  `<name>-<10-char pod-template-hash>` ReplicaSet name, and starting the simulation creates exactly
  that ReplicaSet (the `oc get rs` / `oc describe rs` output matches the event).
- **Routes & networking** — `oc expose svc/...`, edge/passthrough/reencrypt TLS Routes, Route
  admission state, Services, NetworkPolicies, MetalLB `LoadBalancer` services with EXTERNAL-IP.
  Route admission follows the real 4.22 router rules: host/path ownership (`HostAlreadyClaimed`),
  external-certificate validation and target checks — a Service with no ready endpoints does **not**
  reject the Route; the router answers 503 and `oc describe route` shows `Endpoints: <none>`, so the
  player debugs the selector/endpoints instead of chasing a fake admission failure.
  The service-ca controller issues Service serving certificates
  (`service.beta.openshift.io/serving-cert-secret-name`) and injects CA bundles
  (`inject-cabundle`) for reencrypt Routes; a default-deny policy really blocks a project's Route
  until an ingress NetworkPolicy admits the router namespace (the L20 capstone teaches the fix).
  The platform namespaces are populated by real controllers like a real install: `openshift-ingress`
  runs `deployment.apps/router-default` (2/2 Ready) with its ReplicaSet and two shared-hash router
  pods, and `openshift-dns` runs the `daemonset.apps/dns-default` + `daemonset.apps/node-resolver`
  DaemonSets with one owned Pod per Node (the `dns-default` Pods report READY `2/2`). DNS pods run
  on the pod network (`10.128.x`–`10.131.x` — each Pod IP is allocated inside its Node's
  `spec.podCIDR` `/23`, `hostNetwork: false`) while `node-resolver` and the router stay
  hostNetwork, both DNS DaemonSets show the real `kubernetes.io/os=linux` NODE SELECTOR in
  `oc get ds -n openshift-dns`, and the router pods carry
  `ingresscontroller.operator.openshift.io/deployment-ingresscontroller=default`, so the documented
  label-selected `oc delete pod -n openshift-ingress -l …` flow finds and deletes them. Those pods
  ARE the `oc debug`/NetworkPolicy labs' DNS egress target, and deleting one makes the owning
  controller heal it. The real platform Services are seeded in every mode, including the paused
  pre-start sandbox: `openshift-dns/dns-default` (ClusterIP `172.30.0.10`, ports
  `53/UDP,53/TCP,9154/TCP`) and `openshift-ingress/router-internal-default`
  (`80/TCP,443/TCP,1936/TCP`), so `oc get svc,endpoints -n openshift-dns` is the real
  DNS-troubleshooting check (lab 13) and `oc exec <pod> -- cat /etc/resolv.conf` shows the cluster
  search domains, `nameserver 172.30.0.10` and `options ndots:5`. Service objects carry the API
  server's real `spec.clusterIP` (unique `172.30.0.0/16`; `None` when headless) plus the defaulted
  `clusterIPs`/`ipFamilies`/`ipFamilyPolicy`/`sessionAffinity` and per-port `protocol`/`targetPort`,
  and that one field drives `oc get svc`, `-o yaml/json`, `-o jsonpath={.spec.clusterIP}`,
  `oc describe svc`, cluster DNS `nslookup` and `oc exec … curl http://<ClusterIP>:<port>` alike.
  Status is the real `{loadBalancer: {}}` subresource (no invented phase/conditions/endpoint
  counters), `oc describe svc` prints the kubectl v1.30 shape (`IP Family Policy: SingleStack`,
  `IP:`/`IPs:`, one `Port:`/`TargetPort:`/`Endpoints:` block per port, `Session Affinity: None`),
  `oc get endpoints` truncates the ENDPOINTS cell like kubectl
  (`ip:port,ip:port,ip:port + N more...`), and `nslookup` answers a Service name with its own
  ClusterIP (headless → ready pod IPs, ExternalName → its target) and an unknown name with the real
  `NXDOMAIN` line. The `dns-default` Service carries the real 4.22 named targetPorts
  (`TargetPort: dns/UDP`, `dns-tcp/TCP`, `metrics/TCP`) while its ready endpoints stay
  5353/5353/9154, `oc describe` aligns its `Events: <none>` placeholder like kubectl's single
  tabwriter, and each Pod's `/etc/hosts` is the kubelet-managed file
  (`# Kubernetes-managed hosts file.`, the loopback/localnet lines and `<podIP>\t<podName>` — no
  Service entry), so `oc exec … cat /etc/hosts` matches a real Pod. The control-plane Node carries
  the real
  `node-role.kubernetes.io/master:NoSchedule` taint, so application workloads schedule onto the
  workers while the tolerated DaemonSet pods keep running on the master — the taints/tolerations and
  "why is my Pod on the wrong node / Pending" troubleshooting flows behave like 4.22: an
  unschedulable Pod reports `0/1 Pending` (`ContainerCreating` only after it is bound),
  `oc describe pod` prints `Node: <none>` and no fabricated kubelet detail (no `Container ID`,
  `Image ID`, `State`, `Ready` or `Restart Count` lines until the Pod is bound — only
  Image/Port/Host Port/Environment/Mounts/Conditions), and FailedScheduling retries follow the real
  scheduler backoff (1 s doubling to 10 s max) so `oc describe`/`oc get events` show realistic
  small counts like `(x4 over 7s)` instead of a zero-second burst.
- **Declarative workflows** — a Files panel with editable YAML manifests, `oc apply -f`,
  Kustomize base/overlays (`oc apply -k`), OpenShift templates (`oc process -f … | oc apply -f -`),
  Helm charts (`helm install|upgrade|uninstall`), `--dry-run=client -o yaml` manifest skeletons,
  terminal-authored YAML (heredocs/`vim`) and an `htpasswd` file for identity labs.
- **Security & identity** — HTPasswd identity provider + `oc login` (validated against the
  `htpass-secret` Secret, like a real cluster), users/groups/identities, RBAC evaluation
  (`oc auth can-i`, `oc adm policy …`, `oc policy …`) enforced on every command, OCP 4.x SCC grants
  (RBAC bindings to `system:openshift:scc:<name>`, with the SCC users/groups lists left untouched
  like 4.x) and spec-based SCC admission: a Pod whose manifest explicitly requests
  `runAsUser: 0`, `privileged: true` or `hostNetwork` is rejected as a ReplicaSet `FailedCreate`
  and no Pod is created. The classic exam trap is modelled the way real OCP behaves: a bare
  `nginx:latest` (no `securityContext`) is **admitted** under `restricted-v2` and then crash-loops
  with `mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)` in `oc logs` — the
  `ServiceAccount` + `anyuid` grant + `oc set serviceaccount` flow, or an explicit non-root
  `runAsUser`, is the escape hatch. `htpasswd -B` writes real-shaped bcrypt hashes and login
  validates bcrypt and legacy `{SHA}` entries. The installer-side kubeadmin password is discoverable
  the real way: `cat ~/auth/kubeadmin-password`, and `oc login -u kubeadmin` without `-p` prompts for
  it like real `oc`. As in a real install, the `kube-system/kubeadmin` Secret stores only a bcrypt
  hash of that password (`oc extract secret/kubeadmin -n kube-system --to=-` prints `$2a$10$…`) and
  never the plain text; kubeadmin is a virtual user (absent from `oc get users`), and the exam
  removal step is `oc delete secret kubeadmin -n kube-system` once another cluster-admin exists.
  The full exam identity lifecycle is practised: rotate the HTPasswd password through the
  `openshift-config/htpass-secret` (`oc extract` → `htpasswd` → `oc set data`) and wait for the
  OAuth rollout, then delete a departing user and its Identity (`oc delete user` leaves the Identity
  behind).
- **Quotas & self-service** — Namespace/Project quotas, LimitRanges, ClusterResourceQuota, project
  templates (`oc adm create-bootstrap-project-template` + `project.config.openshift.io/cluster`) and
  the real `self-provisioners` ClusterRoleBinding (remove it and `oc new-project` returns Forbidden).
- **Operators (OLM)** — a software catalog of PackageManifests, OperatorGroups, Subscriptions that
  move through InstallPlan and ClusterServiceVersion phases (`Installing → Succeeded`), real
  operator effects (e.g. the MetalLB operator creates its controller/speaker pods and serves
  LoadBalancer IPs only once the MetalLB CR, IPAddressPool and L2Advertisement exist), and a correct
  two-step uninstall: deleting the Subscription keeps the CSV; deleting the CSV removes the operands.
  Operator install variants are modelled: AllNamespaces installs through the global OperatorGroup
  into `openshift-operators`, Manual `installPlanApproval` waits for the
  `oc patch installplan … approved:true` step, and `startingCSV` pins the installed version — after a
  pinned install OLM immediately resolves the channel head into a second, unapproved Manual
  InstallPlan (`InstallPlanPending True RequiresApproval`, `currentCSV` head / `installedCSV` pin), so
  the real exam decision "Manual and why" is playable end to end.
  The catalog package names follow OCP 4.x (`metallb-operator`); OLM resolves per namespace, so a
  Subscription for a package that is not in the catalog makes every Subscription in that namespace
  report `ResolutionFailed` (with no fake CSV, InstallPlan or install-plan conditions), while other
  namespaces install normally.
- **Monitoring & alerting** — `oc get prometheusrules -A`, `oc describe prometheusrule`, live
  `Alertmanager` state (`oc get|describe alertmanager -n openshift-monitoring`): the Watchdog alert
  always fires and cluster state (crash-looping or unready Pods) surfaces the matching alert rules.
- **20-level EX280 campaign (5 chapters)** — Manage OpenShift → Declarative & Kustomize →
  Deploy & Expose → Identity, RBAC & Self-service → Security & Operations, ending in a production
  platform build whose capstone only completes once its scheduled incidents are resolved. The
  capstone's node failure is fixed the real way: `oc debug node/<n>` → `chroot /host` →
  `systemctl restart kubelet` (the incidents drawer action remains as a fallback).
- **13 timed EX280 labs** — speed drills: three-tier app, CrashLoopBackOff, edge TLS Routes,
  Kustomize prod overlay, source-to-image, quota guardrail, RBAC onboarding, SCC, network isolation,
  operator install, HTPasswd onboarding, production network policies and an EX280 speed run.
- **EX280 Prep mode** — objective tracker for the official EX280V422 objective groups (with Red Hat
  docs links), quick command labs, a searchable `oc` cheat sheet, exam facts and an evidence-based
  study-coverage verdict (mastery requires the bullet’s own commands inside the linked drill run).
- **Chaos mode** — endless incident survival; **Sandbox** — free build scored 0–100 by the
  Architecture Advisor (HA, security, networking, storage, scaling, RBAC, quotas, probes, config, cost).
- **A start page worth opening** — a dark, premium landing screen with the live 3D cluster in the
  hero: a banded mode launcher, an interactive EX280 objective→drill picker built from the real
  objective data, real product captures, and a light colophon that credits K8s Games by Rohit
  (Apache-2.0), the project this one is a derivative of. Native page scrolling, 390px responsive,
  `prefers-reduced-motion` support and a progress-aware primary action.
- **3D cluster view** — Three.js r152 diorama with redesigned models for all 47 kinds, studio
  lighting, floor tier zones, camera fit-to-view, a screen-space label layer with collision culling,
  ownership/network/traffic connections, project floor planes, minimap, inspector, live metrics and
  an importable/exportable YAML view, and a visible paused state (HUD chip + pause glyph) whenever
  an overlay freezes the run. The renderer boots as the start-page hero and expands to full screen
  when a mode launches.
- **OpenShift Draw** (`/draw`) — a 3D architecture whiteboard: drag OpenShift resources, draw
  connections, edit properties, auto-layout, export YAML/PNG and share via URL.

---

## How to play

1. Pick a mode on the start page — **Campaign**, **Timed Labs**, **Sandbox**, **Chaos** — or open
   **EX280 Prep** for the objective tracker. The start page also maps each EX280 objective group to
   the campaign level and timed lab that drills it.
2. Create resources from the left palette or with the `oc` terminal (`/`). The name prompt lets you
   match the objective name (e.g. `frontend`).
3. Click a resource to inspect it (Overview / YAML / Describe / Events); right-click for actions.
4. Press `/` to open the `oc` terminal, `F` for the Files panel, `?` for EX280 Prep, `H` for help.
5. Handle incidents as they appear — diagnose with `oc describe`, `oc logs`, `oc get events` — and
   resolve them by fixing the resource state.

### Controls

| Input       | Action                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `/`         | `oc` command bar                                                                                           |
| `F`         | Files / manifests panel (`apply -f`, `apply -k`, templates, Helm; New/Import/Delete files)                 |
| `?`         | EX280 Prep (objective tracker, quick labs, cheat sheet)                                                    |
| `H`         | Help / How to play                                                                                         |
| `Space`     | Pause / resume the simulation                                                                              |
| `M`         | Metrics dashboard                                                                                          |
| `Esc`       | Close the topmost panel/overlay; with nothing open, open the pause menu (Resume, Restart level, Main menu) |
| `1–9`       | Quick-place a resource from the palette (opens the name prompt)                                            |
| Left-click  | Select resource                                                                                            |
| Left-drag   | Move resource or rotate camera                                                                             |
| Right-click | Context menu (Expose, Start Build, Scale, Rollout, Delete, …)                                              |
| Right-drag  | Pan camera                                                                                                 |
| Scroll      | Zoom                                                                                                       |

Bottom toolbar: **Auto-align** | **Reset view** | **Terminal** | **Files** | **YAML** | **EX280** | **Help**.

---

## EX280 coverage

The game is organised around the official EX280V422 objective groups. Campaign level data carries
`examObjectives` and `docsLinks`; challenges and quick labs carry docs links; the in-app EX280 Prep
tracker maps every bullet to its campaign levels, timed labs and quick labs. The table below is
derived from that same data (9 objective groups, 55 bullets; _timed labs_ are the 13 challenge drills):

| EX280V422 objective group                                                  | Where it is practiced                                                                                                                                                             | Levels                    | Timed labs          | Quick lab                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------- | ------------------------------------------ |
| Manage OpenShift Container Platform (projects, `oc` CLI, querying, health) | Campaign ch. 1, Sandbox, `oc` terminal                                                                                                                                            | 1, 2, 3, 4, 9, 10, 15, 20 | 1, 2, 4, 5, 9, 12   | Projects & the oc CLI                      |
| Declarative Resource Management (manifests, Kustomize, secrets/configmaps) | Files panel, `oc apply -f/-k`, `oc process`                                                                                                                                       | 4, 5, 6, 7, 10, 11        | 1, 3, 4, 10, 11, 12 | Kustomize prod overlay                     |
| Deploy applications (templates, Helm, builds, rollouts, Services, Routes)  | Builds/ImageStream controllers, `oc new-app`, `oc start-build`, `oc rollout`                                                                                                      | 2, 8, 10, 11, 12          | 1, 3, 5, 9, 10, 12  | Route with edge TLS                        |
| Manage authentication and authorization (HTPasswd, users, groups, RBAC)    | `oc login`, users/groups, `oc adm policy`, `oc auth can-i`                                                                                                                        | 13, 14, 16                | 7, 11, 12           | HTPasswd users & login                     |
| Configure network security (Services, Routes, NetworkPolicy, TLS)          | Route admission, TLS edge/passthrough/reencrypt, service serving certs, default-deny + router-ingress NetworkPolicy                                                               | 3, 11, 12, 20             | 3, 8, 9, 10, 13     | Service serving cert → reencrypt Route     |
| Expose non-HTTP/SNI Applications                                           | passthrough Routes, LoadBalancer services                                                                                                                                         | 12                        | 10                  | —                                          |
| Enable developer self-service (quotas, LimitRanges, project templates)     | ResourceQuota/LimitRange/ClusterResourceQuota; project-request template flow (generate → edit → create in `openshift-config` → point `project.config.openshift.io/cluster` at it) | 8, 15, 20                 | 6, 12               | ResourceQuota + LimitRange                 |
| Manage OpenShift operators (OLM)                                           | Subscription → CSV phases, operator effects, uninstall                                                                                                                            | 12, 18                    | 10                  | Install an operator                        |
| Configure application security (SCCs, service accounts, jobs/cronjobs)     | SCC grants/denials, `oc set serviceaccount`, `oc debug`, Jobs/CronJobs                                                                                                            | 7, 16, 17, 19             | 3, 7, 8, 12         | Service account + SCC grant; Job + CronJob |

Cross-cutting drills (not a separate V422 objective group): troubleshooting/operations content —
logs, events, `oc adm top`, `oc adm cordon|drain`, Jobs/CronJobs — appears in levels 3, 19, 20 and
timed labs 2, 6, 12, plus Chaos mode.

Official sources (verify against these before your exam):

- EX280 exam page: <https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam>
- OpenShift Container Platform 4.22 documentation: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22>
- OpenShift 4.22 release notes: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/release_notes>

> OpenShift Games is a study aid, not an exam dump. It simplifies cluster behaviour for teaching, and
> it is not affiliated with or endorsed by Red Hat.

---

## Run locally

There is **no build step** and no runtime dependencies to install. The app is plain ES modules
served statically (Three.js and Tailwind are loaded from CDNs; an internet connection is required
for those, and a WebGL-capable browser is required for the 3D view). The only optional `npm`
install is the dev-only formatting/linting toolchain — see
[Development tooling](#development-tooling).

```bash
git clone https://github.com/G-man3207/openshiftgames.git
cd openshiftgames
python3 -m http.server 8080
# open http://localhost:8080 for the game and http://localhost:8080/draw for the whiteboard
```

> Serve over HTTP (not `file://`) — ES modules, import maps and the optional Files/EX280 Prep panels
> rely on HTTP semantics (`/draw` is served by a static rewrite in production).

## Development tooling

The game itself stays no-build and dependency-free; the repo carries an optional, dev-only
toolchain (Prettier 3, Knip 5, husky 9) that keeps the tree clean. It is not needed to play, serve
or deploy the app, and `node_modules/` is gitignored.

```bash
npm install          # dev tooling only — no runtime dependencies
npm run format       # Prettier: rewrite all text files
npm run format:check # Prettier: strict check (same as the pre-commit gate)
npm run knip         # Knip: dead files, unused/unlisted deps, unresolved imports, binaries
npm run lint         # both gates
```

- **Prettier is strict and repo-wide** (`.prettierrc`: single quotes, semicolons, print width 100,
  ES5 trailing commas). `.prettierignore` skips `node_modules/`, binary assets, `docs/screenshots/`,
  vendored skill assets (`.taste-skill/`, `.agents/`) and `.husky/`.
- **Knip runs in "real garbage only" mode** (`knip.jsonc`): dead files, unused/unlisted
  dependencies, unresolved imports and binaries are **errors**; unused-export, duplicate-export,
  type and enum-member rules are **off by design**. This is a no-build vanilla-ESM app: much of its
  API is consumed from the inline `<script type="module">` blocks in `index.html`/`draw.html`, from
  the `window.game` runtime and from browser-context dynamic imports, which static analysis cannot
  trace — enforcing unused-export strictness would mean deleting legitimate, used code, so that
  cleanup is deliberately deferred. `scripts/knip-entrypoints.mjs` mirrors every import of the
  inline HTML modules so dead-file detection still works, and `scripts/verify.mjs` fails if the
  mirror drifts. `three` (browser import map) and `puppeteer-core` (installed out-of-repo for the
  QA harnesses) are explicitly ignored, as is `/js/*` for the browser-context import in
  `scripts/browser-test.mjs`.
- **husky pre-commit gate** (`.husky/pre-commit`) runs `prettier --check .` and `npx knip` and
  blocks the commit on any issue; if `node_modules/` is missing it tells you to run `npm install`.
  Keep the toolchain to `prettier`, `knip` and `husky`: `scripts/verify.mjs` enforces that the only
  `devDependencies` are those three, with no runtime `dependencies` and no bundler/build config.

## Deploy

The repo is a static site and deploys to any static host. The canonical demo is https://shifting.pro (hosted on Vercel; point the domain at the Vercel project):

- Canonical URL: `https://shifting.pro` (used in `og:url` / `og:image` / canonical tags;
  update `index.html`, `draw.html`, `og-image.html` and README if the domain changes).
- `vercel.json` keeps the `/draw` → `/draw.html` rewrite, cache headers and bot policy. No server
  code and no environment variables are required.
- Deploy with the Vercel dashboard (import the repo), add `shifting.pro` as the project domain, or use
  `vercel deploy` (Vercel CLI, optional).

---

## Architecture & tech

- **No build step** — vanilla ES modules + import maps. No bundler, no framework, no npm runtime
  dependencies. Tailwind is loaded from the CDN for utility classes; custom styling lives in
  `style.css` (in-game shell) and `start.css` (start page). Type is set in Schibsted Grotesk with
  JetBrains Mono reserved for real terminal/YAML code. An optional Prettier + Knip + husky dev
  toolchain guards repo hygiene — see [Development tooling](#development-tooling).
- **Three.js r152** (`https://unpkg.com/three@0.152.0/...`, pinned in the import map) powers the 3D
  cluster view and the whiteboard; WebGL is required.
- **Central kind registry** — `js/data/kindRegistry.js` is the single source of truth for kinds,
  apiVersions, scope, aliases, `oc get` columns, palette metadata, default specs, owner chains,
  explain text, minimap sizes and the shared manifest serializer. Adding a kind means adding one
  registry entry + a resource class + a mesh creator (+ optional controller/data changes).
- **Simulation** — `js/engine/SimulationTick.js` runs fixed-step OpenShift controllers: scheduler
  (real retry backoff + unschedulable-Pod `Pending` display), Pod lifecycle, Deployments/ReplicaSets,
  StatefulSets, DaemonSets, Jobs/CronJobs, HPA, PVC binding, Pod-network IP allocation inside each
  Node's `spec.podCIDR` (OpenShift's `10.128.0.0/14` clusterNetwork, `/23` per node), Services and
  endpoints (API-server ClusterIP defaulting, named/numeric targetPort resolution, one canonical
  ready-endpoint resolver, the seeded platform DNS/router Services), NetworkPolicy evaluation
  shared by the traffic simulation and the cluster-DNS diagnostics, Routes (admission),
  BuildConfig→Build→ImageStream,
  Subscriptions/operators, MetalLB LoadBalancer IPs, SCC enforcement,
  LimitRange/ResourceQuota/ClusterResourceQuota, OAuth/HTPasswd, ClusterOperator health.
- **Command layer** — `js/ui/CommandBar.js` parses `oc` commands (with pipes/redirects and tab
  completion), runs them through the RBAC authorization gate and drives the same engine APIs as the
  UI; `js/ui/ShellTools.js` is the simulated shell (heredocs, redirects, cat/echo/grep/tail/head/wc/
  vim/openssl/skopeo/htpasswd/…) that shares the ManifestEngine virtual filesystem. Cluster-DNS
  diagnostics (`nslookup`/`dig`/`getent hosts`) and verbose `curl` use the engine's NetworkPolicy
  evaluation, and `oc exec`/`oc rsh` propagate remote exit statuses (unmodelled binaries terminate
  with exit code 127).
- **Declarative engine** — `js/engine/YamlParser.js` + `js/engine/ManifestEngine.js` provide a
  virtual file system, YAML manifests, Kustomize overlays, OpenShift templates, Helm charts and
  HTPasswd file operations; `js/ui/ManifestPanel.js` is the Files panel.
- **UI** — StartMenu (the start page: live diorama stage, mode launcher, EX280 objective picker,
  scroll reveals), HUD, Inspector, ContextMenu, Metrics, Settings, Incidents, Minimap, docked `oc`
  terminal and pause overlay; `index.html` wires the shell and the palette (generated from the
  registry); `draw.html` is the whiteboard.
- **Data** — `js/data/CampaignLevels.js`, `js/data/IncidentDefs.js`, `js/data/Achievements.js`,
  `js/data/EX280Objectives.js`, `js/data/ManifestFiles.js`.

Repo layout:

```
index.html            start page markup + game shell (inline ES module)
draw.html             OpenShift Draw whiteboard
style.css             in-game design system and shell styling
start.css             start page styling (dark editorial, one accent)
img/start/            product captures used by the start page
js/data/              kind registry, campaign levels, incidents, achievements, EX280 objectives,
                      manifest files
js/engine/            GameEngine, ClusterState, SimulationTick, IncidentEngine, ScoringEngine,
                      YamlParser, ManifestEngine, ObjectiveEvaluator, RBAC helpers
js/resources/         ResourceBase + per-kind classes (OpenShift + legacy)
js/rendering/         Three.js renderer, meshes, connection lines, particles, label layer
js/ui/                CommandBar, ShellTools, HUD, Inspector, ContextMenu, Metrics, IncidentPanel,
                      Minimap, Settings, ManifestPanel, StartMenu
js/modes/             CampaignMode, ChallengeMode, ChaosMode, SandboxMode, ExamPrepMode
scripts/              verify / browser-test / visual-qa harnesses + Knip entry mirror
vercel.json           static hosting: /draw rewrite + cache/bot headers
og-image.html         OpenGraph card source (1200×630) — PNG regenerated by the verifier
package.json          dev-only toolchain (Prettier/Knip/husky); no runtime dependencies
knip.jsonc            Knip "real garbage only" configuration (documented rules)
.husky/pre-commit     pre-commit gate: prettier --check + knip
```

---

## Contributing

This is an education project. Useful contributions:

- Fix an inaccurate `oc` command/flag (cite the OpenShift 4.22 docs page in the PR).
- Add a campaign level, timed lab or incident aligned to an EX280 objective.
- Improve an EX280 Prep objective mapping or quick lab.
- Report a bug with browser, mode, level and the exact `oc` command/output.

Please keep the no-build, dependency-free architecture (`scripts/verify.mjs` checks syntax, imports,
registry consistency and forbidden legacy strings). The app must not gain runtime dependencies or a
bundler; dev tooling is limited to Prettier, Knip and husky behind the pre-commit gate (see
[Development tooling](#development-tooling)).

---

## Credits & license

OpenShift Games is a derivative work of **K8s Games** by Rohit (`rohitg00`), used under the
Apache License 2.0.

- Original project: <https://github.com/rohitg00/k8sgames>
- Original copyright: **K8s Games, Copyright (c) Rohit G / rohitg00**, Apache-2.0.
- See the [NOTICE](NOTICE) file for the derivative-work statement and full attribution.

This project is licensed under the **Apache License 2.0** — see [LICENSE](LICENSE). The original
license and copyright notices are preserved. It is an independent, unofficial study project: it is
not affiliated with, sponsored or endorsed by Red Hat, Inc. OpenShift, Red Hat and the Red Hat logo
are trademarks of Red Hat, Inc. Kubernetes is a trademark of The Linux Foundation.
