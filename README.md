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
  `rollout` (`status --timeout|history|undo`), `logs` (Pods, Deployments, Jobs), `exec`, `rsh`, `cp`, `wait`,
  `diff -f`, `patch --type=strategic|merge|json`, `adm policy` (RBAC + SCC), `auth can-i`,
  `adm top`, `adm cordon|drain`, `create quota|limitrange|clusterquota`, `create token`,
  `image info`, `process`, `helm` (repo/search/install/upgrade/history/rollback), `htpasswd`,
  `--dry-run=client|server`, `<resource>.<group>` tokens, `jsonpath`/`custom-columns`,
  `events --field-selector`, pipes, redirects and `-f -` stdin. Container names follow real `oc`
  (`oc create deployment --image=…` names the container after the image; `oc set image` never adds
  one). RBAC is genuinely enforced: a plain user gets the real
  `Error from server (Forbidden): …` for reads and writes they are not allowed to perform.
  `oc` is the taught command; a leading `kubectl` is accepted as an alias with an educational hint.
- **A real shell around `oc`** — `vim`/`vi` (opens the manifest editor), `cat`, `echo` with
  `>`/`>>` redirects, heredocs, command substitution, and pipes through `grep`, `sed`, `tail`,
  `head`, `wc`, `sort`, `openssl`, `htpasswd`, `skopeo` (including `grep -A/-B/-C` context) — so
  exam workflows like writing YAML in the terminal and `oc apply -f -` work exactly as on a real
  workstation.
- **First-class OpenShift resources** — Project, Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet,
  Job, CronJob, Service, Route, Ingress, NetworkPolicy, ConfigMap, Secret, PVC, PV, StorageClass,
  HPA, PDB, ResourceQuota, LimitRange, ClusterResourceQuota, ServiceAccount, Role, RoleBinding,
  ClusterRole, ClusterRoleBinding, SCC, BuildConfig, Build, ImageStream, Template, Subscription,
  OperatorGroup, InstallPlan, ClusterServiceVersion, PackageManifest, MetalLB, User, Group,
  ClusterOperator, ClusterVersion, IPAddressPool, L2Advertisement.
  A single central registry (`js/data/kindRegistry.js`) drives the palette, 3D renderer, inspector,
  command bar, minimap and YAML export.
- **S2I builds & ImageStreams** — `oc new-app`, BuildConfig → Build → ImageStream lifecycle, image
  change triggers and rollouts, internal registry image references.
- **Routes & networking** — `oc expose svc/...`, edge/passthrough/reencrypt TLS Routes, Route
  admission state, Services, NetworkPolicies, MetalLB `LoadBalancer` services with EXTERNAL-IP.
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
  validates bcrypt and legacy `{SHA}` entries.
- **Quotas & self-service** — Namespace/Project quotas, LimitRanges, ClusterResourceQuota, project
  templates (`oc adm create-bootstrap-project-template` + `project.config.openshift.io/cluster`) and
  the real `self-provisioners` ClusterRoleBinding (remove it and `oc new-project` returns Forbidden).
- **Operators (OLM)** — a software catalog of PackageManifests, OperatorGroups, Subscriptions that
  move through InstallPlan and ClusterServiceVersion phases (`Installing → Succeeded`), real
  operator effects (e.g. the MetalLB operator creates its controller/speaker pods and serves
  LoadBalancer IPs only once the MetalLB CR, IPAddressPool and L2Advertisement exist), and a correct
  two-step uninstall: deleting the Subscription keeps the CSV; deleting the CSV removes the operands.
  The catalog package names follow OCP 4.x (`metallb-operator`); OLM resolves per namespace, so a
  Subscription for a package that is not in the catalog makes every Subscription in that namespace
  report `ResolutionFailed` (with no fake CSV or InstallPlan), while other namespaces install
  normally.
- **20-level EX280 campaign (5 chapters)** — Manage OpenShift → Declarative & Kustomize →
  Deploy & Expose → Identity, RBAC & Self-service → Security & Operations, ending in a production
  platform build whose capstone only completes once its scheduled incidents are resolved.
- **12 timed EX280 labs** — speed drills: three-tier app, CrashLoopBackOff, edge TLS Routes,
  Kustomize prod overlay, source-to-image, quota guardrail, RBAC onboarding, SCC, network isolation,
  operator install, HTPasswd onboarding and an EX280 speed run.
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
derived from that same data (9 objective groups, 55 bullets; _timed labs_ are the 12 challenge drills):

| EX280V422 objective group                                                  | Where it is practiced                                                                                                                                                             | Levels                    | Timed labs          | Quick lab                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------- | ------------------------------------------ |
| Manage OpenShift Container Platform (projects, `oc` CLI, querying, health) | Campaign ch. 1, Sandbox, `oc` terminal                                                                                                                                            | 1, 2, 3, 4, 9, 10, 15, 20 | 1, 2, 4, 5, 9, 12   | Projects & the oc CLI                      |
| Declarative Resource Management (manifests, Kustomize, secrets/configmaps) | Files panel, `oc apply -f/-k`, `oc process`                                                                                                                                       | 4, 5, 6, 7, 10, 11        | 1, 3, 4, 10, 11, 12 | Kustomize prod overlay                     |
| Deploy applications (templates, Helm, builds, rollouts, Services, Routes)  | Builds/ImageStream controllers, `oc new-app`, `oc start-build`, `oc rollout`                                                                                                      | 2, 8, 10, 11, 12          | 1, 3, 5, 9, 10, 12  | Route with edge TLS                        |
| Manage authentication and authorization (HTPasswd, users, groups, RBAC)    | `oc login`, users/groups, `oc adm policy`, `oc auth can-i`                                                                                                                        | 13, 14, 16                | 7, 11, 12           | HTPasswd users & login                     |
| Configure network security (Services, Routes, NetworkPolicy, TLS)          | Route admission, TLS edge/passthrough, default-deny NetworkPolicy                                                                                                                 | 3, 11, 12, 20             | 3, 8, 9, 10         | —                                          |
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
- **Simulation** — `js/engine/SimulationTick.js` runs fixed-step OpenShift controllers: scheduler,
  Pod lifecycle, Deployments/ReplicaSets, StatefulSets, DaemonSets, Jobs/CronJobs, HPA, PVC binding,
  Services/endpoints, Routes (admission), BuildConfig→Build→ImageStream, Subscriptions/operators,
  MetalLB LoadBalancer IPs, SCC enforcement, LimitRange/ResourceQuota/ClusterResourceQuota,
  OAuth/HTPasswd, ClusterOperator health.
- **Command layer** — `js/ui/CommandBar.js` parses `oc` commands (with pipes/redirects and tab
  completion), runs them through the RBAC authorization gate and drives the same engine APIs as the
  UI; `js/ui/ShellTools.js` is the simulated shell (heredocs, redirects, cat/echo/grep/tail/head/wc/
  vim/openssl/skopeo/htpasswd/…) that shares the ManifestEngine virtual filesystem.
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
