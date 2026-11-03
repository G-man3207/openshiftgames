# Verification report — OpenShift Games (OCP 4.22 / EX280V422)

**Date:** 2026-11-03 (UTC)
**Verified tree:** `main` @ `2489136` in https://github.com/G-man3207/openshiftgames (standalone history) plus the uncommitted verification artifacts in this report (screenshots, report, browser harness); no game-code changes were made by the verifier.
**Target:** Red Hat OpenShift Container Platform **4.22** · **EX280V422**
**Canonical URL:** `https://shifting.pro` (current spec/README/index; `og:url`/`og:image` + `/draw`)
**Verdict:** **GO for release** — 0 failures in static verification and 0 failures in the full browser suite.

The verifier did not modify game code (`js/`, HTML shells, CSS, data, docs outside this report,
or git history). Changes were limited to `scripts/verify.mjs`, `scripts/browser-test.mjs`,
`docs/verification-report.md`, `docs/verification-report.json`, and image artifacts under
`docs/screenshots/`, `screenshot.png`, `og-image.png`.

---

## 1. Environment and commands

| Item | Value |
|---|---|
| Node.js | v26.10.0 |
| Static harness | `node scripts/verify.mjs --verbose` (zero dependencies) |
| Browser harness | `node scripts/browser-test.mjs` (puppeteer-core from `/tmp/verify-tools`, out of repo) |
| Browser | Google Chrome 156.0.8078.79 headless (`--headless=new`, SwiftShader WebGL via `--use-angle=swiftshader`) |
| Server | Node static server on `127.0.0.1:<ephemeral>`; production-equivalent static hosting (`/draw` rewrite tested) |
| Viewports | 1600×900 main; 1280×720 responsive sanity; 1200×630 OG card |
| Full browser run | see `docs/verification-report.json` → `environment.durationSeconds` |

Commands actually run to completion:

```bash
node scripts/verify.mjs --verbose
node scripts/browser-test.mjs
```

Individual browser areas can be re-run with
`node scripts/browser-test.mjs --only=menu,sandbox,cli,files,ui,campaign,challenges,exam,draw,responsive,shots`.
The browser script writes `docs/verification-report.json` on every run.

---

## 2. Static verification — `node scripts/verify.mjs`

```
Files checked: 45 JS modules, 79 total files
Checks passed: 696 · failures: 0 · warnings: 0
```

| Area | What was checked | Result |
|---|---|---|
| Syntax | Every `js/**/*.js` module and both inline HTML modules parse as ES modules (`node --input-type=module --check`) | PASS |
| Import graph | Every relative import target exists; every named import resolves against a static export scan (JS + `index.html`/`draw.html` inline modules + dynamic optional-panel imports) | PASS |
| Kind registry | 42 kinds; apiVersion/scope/palette/aliases/columns/defaultSpec/minimap metadata; all 42 have a mesh creator; `PALETTE_SECTIONS` covers all 37 placeable kinds exactly once; index/draw palettes registry-driven; `createResource` returns rich classes, honours supplied `metadata.uid`; `namespace` alias → `Project`; `dc` alias → `Deployment`; no retired `Namespace` kind | PASS |
| API versions | Exact 4.22 map for all kinds (spot checks include Route `route.openshift.io/v1`, BuildConfig/Build `build.openshift.io/v1`, ImageStream `image.openshift.io/v1`, Template `template.openshift.io/v1`, SCC `security.openshift.io/v1`, Project `project.openshift.io/v1`, ClusterResourceQuota `quota.openshift.io/v1`, User/Group `user.openshift.io/v1`, Subscription `operators.coreos.com/v1alpha1`, OAuth/ClusterOperator/ClusterVersion `config.openshift.io/v1`) | PASS |
| Seeded OpenShift baseline | 10 default Projects (`default`, `openshift*`, `kube-system`), 13 ClusterOperators (Available=True/Progressing=False/Degraded=False, 4.22.0), ClusterVersion `version` (`stable-4.22`, desired 4.22.0), SCCs `restricted-v2`/`nonroot-v2`/`anyuid`/`privileged`, users `kubeadmin`/`admin` + cluster-admin binding, ImageStreams `nodejs:20/18`, `python:3.12`, `nginx:1.26`; 47 seeded resources before mode Nodes; `addResource` UID preservation | PASS |
| Campaign | 20 levels / 5 chapters with spec titles; every level has `examObjectives`, 4.22 `docsLinks`, objectives, starting/available resources, 3+ hints, starCriteria; objective kinds/incidents/manifests exist; examObjective strings map to official bullets; tutorial targets valid; no kubectl/`oc export` copy | PASS |
| Challenges | 12 timed labs with exact spec titles/IDs, 180–420 s limits, objectives, starting/available resources, hints, valid preload incidents; `ChallengeMode.startChallenge/getStatus` present | PASS |
| Incidents | 36 definitions; all 35 required names present; 2+ investigation steps and resolution actions; `ocCommands` only `oc`; no kubectl; affected resource kinds exist in registry; no legacy `kubectlCommands` data field | PASS |
| EX280V422 coverage | 9 official groups / **55 official bullets**, titles/order/count distribution (14+7+6+5+6+2+5+3+7) match `docs/research/exam-facts.json`; every bullet has a docs link and at least one level/challenge mapping; 9 quick labs; 10 cheat-sheet groups; readiness threshold 0.9; exam facts (EX280V422, 4.22, 3 h) present | PASS |
| Scoring / achievements | `getExamPrepProgress()` / `markExamPrep()` and progress store; all required stat keys (with legacy aliases); 44 OpenShift-themed achievements with unique IDs/categories/conditions; referenced stats exist | PASS |
| Branding / independence | No `k8sgames.com` or `rohitg00/k8sgames` outside attribution context; the required menu attribution is the only upstream link; no “K8s Games”/“Kubernetes Cluster Simulation” UI copy outside that attribution; no `K8S_BLUE`; kubectl only in the alias/education context; title/meta/OG/twitter/theme copy; pinned Three.js 0.152 / Tailwind 3.4.1; no repo `package.json`/`node_modules`/bundler config | PASS |
| Required files / README | LICENSE, NOTICE, README, index/draw, style, vercel/robots, og source, study guide, EXAM-PREP; README EX280 coverage table (all 9 groups), credits/attribution, Apache-2.0, non-affiliation, run/deploy/Vercel instructions; canonical `shifting.pro` in index/README/OG | PASS |
| Declarative engine | `YamlParser.selfTest()`; all 19 default files parse; apply `-f`, apply `-k` prod overlay, `processTemplate` + apply, Helm install/list/uninstall, htpasswd add/verify/delete verified via imports with a real `GameEngine` | PASS |
| CommandBar / UI wiring | `executeCommand` + `_executeCommand`; `$ oc` prompt/alias; dispatch paths for required command families; index/draw element IDs; inspector/context-menu/metrics/settings/manifest-panel containers; `window.game` / `manifestEngine` / `examPrepUI` wiring | PASS |

Accepted notes (not failures): one cross-cutting EX280 bullet
(`manage-certified-technologist`) links to the official exam page rather than an OCP 4.22 chapter;
the spec allows this and the readiness/coverage tracker remains complete. The index footer’s
required attribution link to the original project is explicitly allowed by CONVERSION-SPEC §1.

---

## 3. Browser E2E — `node scripts/browser-test.mjs`

```
Browser tests: 427 passed, 0 failed, 0 warnings
Console/page errors: 0 / 0
Verdict: GO
```

| Area | Checks | Failures | What was exercised |
|---|---:|---:|---|
| Menu | 22 | 0 | exact title/meta/OG/twitter/importmap; OpenShift Games logo/subtitle; 4 mode buttons; EX280 Prep; `/draw`; required attribution; GitHub/repo link; Settings/Achievements/Stats modals; achievement count |
| Responsive | 7 | 0 | 1280×720 menu + sandbox (no horizontal overflow, palette/HUD/toolbar visible); restored 1600×900 |
| EX280 Prep | 19 | 0 | overlay; 9 groups / 55 bullets; 4 tabs; 9 quick labs; 10 cheat groups; 55 copy buttons; search filtering; copy command; readiness bar `0/55`; exam facts EX280V422/3 h; quick-lab launch → Sandbox + overlay close |
| Sandbox | 25 | 0 | Sandbox deep link; seeded ~50 resources ↔ 50 meshes; 37 palette kinds; 10 Projects, 13 ClusterOperators, 3 Nodes, 4 SCCs, 3 ImageStreams; HUD logo “OpenShift Games”, “OpenShift 4.22”; toolbar; WebGL ok |
| Files panel | 13 | 0 | `#btn-manifests`; 19 files/tree; editor + Save/Apply -f/Apply -k; `manifests/deployment.yaml` → Deployment/webapp; prod overlay → Deployment/prod-webapp; recorded apply |
| CLI / `oc` | 103 | 0 | session, nodes/co/clusterversion, projects, deployment+Route, `set env/image/resources`, cm/secret, logs/describe/rollout, apply `-f`/`-k`, `process | apply`, Helm install/list/uninstall, `new-app`, users/groups, `adm policy add-role-to-user`/`add-scc-to-user`, `auth can-i` (incl. `--as`/serviceaccount), quota/limitrange/clusterquota, route edge/TLS/YAML, get all/status/projects/explain/api-resources/events/top/must-gather, `oc edit` editor, **BuildConfig→Build→ImageStream Complete**, **Subscription Succeeded→delete**, jobs/cronjobs, cordon/uncordon, HTPasswd+OAuth+login+w wrong-password/logout; semantic assertions on every mutation |
| UI surfaces | 18 | 0 | inspector select/4 tabs/YAML/describe; context menu Expose Service → Route + Start Build + Edit/Delete; metrics 4 charts; in-game settings; keyboard `/`, `M`, `Space` pause/resume, `Esc` |
| Campaign | 128 | 0 | levels 1–20 start with exact titles, objective progress/panel, `getStatus()`; level 1 objective completion via `oc login`, `new-project`, `oc run`, `create deployment` all flip completed (100%) |
| Challenges | 72 | 0 | timed labs 1–12 start with exact titles, objective panel and `getStatus()` |
| Draw | 10 | 0 | `/draw` title/palette 37 unique kinds; watermark; YAML export has `route.openshift.io/v1`, `build.openshift.io/v1`, `project.openshift.io/v1` |
| Screenshots | 10 | 0 | all required captures + final hero/OG dimensions verified |

### State/semantics verified (not just exit codes)

- **Route:** `status.ingress[0].conditions` reaches `type=Admitted, status=True` once Deployment
  pods are Running; before endpoints exist it reports `ServiceUnavailable`.
- **Build:** BuildConfig → Build phases (`New → Pending → Running → Complete`), output ImageStream
  exists with tags, BuildConfig lastVersion updated.
- **Operator:** Subscription `Installing → Succeeded` with `installedCSV`; deleting it removes the
  Subscription; CSV visible in `oc get csv`.
- **Identity:** `htpasswd` file + `htpasswd-secret` in `openshift-config`; OAuth HTPasswd provider
  becomes ready; `oc login -u alice -p Passw0rd` works, User + Identity auto-created, wrong password
  rejected, logout/re-login works.
- **Security/self-service:** anyuid grant adds
  `system:serviceaccount:ex280-demo:default` to the SCC users; ResourceQuota, LimitRange and
  ClusterResourceQuota exist; RoleBinding/RBAC checks return allowed.
- **Mutations:** `oc set env/image/resources` values persist in the Deployment pod template.

---

## 4. Screenshots and artifacts

Generated/validated in the final run (all 1600×900 unless noted):

| File | Size | Purpose |
|---|---|---|
| [`screenshot.png`](../screenshot.png) | 1600×900, 252 KB | README hero gameplay (Sandbox, seeded cluster) |
| [`docs/screenshots/menu.png`](screenshots/menu.png) | 1600×900, 118 KB | main menu/branding |
| [`docs/screenshots/sandbox.png`](screenshots/sandbox.png) | 1600×900, 252 KB | seeded Sandbox with HUD/palette |
| [`docs/screenshots/campaign-level-1.png`](screenshots/campaign-level-1.png) | 1600×900, 254 KB | campaign level 1 + objectives |
| [`docs/screenshots/exam-prep.png`](screenshots/exam-prep.png) | 1600×900, 120 KB | EX280 Prep tracker (9 groups/55 bullets) |
| [`docs/screenshots/files-panel.png`](screenshots/files-panel.png) | 1600×900, 194 KB | Files & Manifests panel |
| [`docs/screenshots/draw.png`](screenshots/draw.png) | 1600×900, 161 KB | OpenShift Draw + YAML export |
| [`og-image.png`](../og-image.png) | 1200×630, 200 KB | Open Graph/Twitter card (`shifting.pro`) |
| [`docs/verification-report.json`](verification-report.json) | machine-readable | full pass/fail + timings + artifact metadata |

Supplementary images retained from earlier verification runs:
[`docs/screenshots/inspector.png`](screenshots/inspector.png) (1600×900, inspector detail) and
[`docs/screenshots/campaign-level-20.png`](screenshots/campaign-level-20.png) (1600×900, capstone).

---

## 5. Content-accuracy spot checks

Checked against `docs/research/exam-facts.json`, `docs/research/ex280-objectives.md`,
`docs/research/openshift-workloads-builds.md`,
`docs/research/openshift-networking-security-storage.md` (OCP 4.22 / `enterprise-4.22`):

- **Exam identity:** EX280V422, OCP 4.22, 3-hour performance-based, persistence rule; 9 groups /
  55 bullets; group distributions and bullet titles match the official list exactly.
- **API versions:** Route `route.openshift.io/v1`, BuildConfig/Build `build.openshift.io/v1`,
  ImageStream `image.openshift.io/v1`, Template `template.openshift.io/v1`, SCC
  `security.openshift.io/v1`, Project `project.openshift.io/v1`, ClusterResourceQuota
  `quota.openshift.io/v1`, User/Group `user.openshift.io/v1`, Subscription
  `operators.coreos.com/v1alpha1`, OAuth/ClusterOperator/ClusterVersion `config.openshift.io/v1`.
- **Version-sensitive behavior:** Projects rather than Namespaces in UX/model; no `Namespace` game
  kind; no `oc export` teaching (`oc get -o yaml >` instead); Deployment preferred over deprecated
  DeploymentConfig (`dc` is only a warning alias); SCCs enforced; `restricted-v2` default; HTPasswd
  via OAuth; Kustomize/Helm flows present; MetalLB IPAddressPool/L2Advertisement for bare-metal LB.
- **Observed command semantics:** `oc expose` creates an admitted Route; `oc apply -k` applies
  overlays; `oc process | oc apply` applies templates; builds and operators reach the documented
  phases; HTPasswd login and RBAC/SCC decisions behave as documented.
- **Unverified/unpublished claims:** passing score, score scale and certification validity are not
  published by Red Hat and are not stated in game copy (research flags them UNVERIFIED).
- **Coverage gap check:** all 55 bullets have at least one level/challenge mapping; one
  cross-cutting bullet uses the official exam page as its docs link (accepted; see notes below).

---

## 6. Remaining known issues

**Must fix before release:** none.

| Severity | Issue | Impact / disposition |
|---|---|---|
| Low | GitHub stars badge shows `0`/`--` when `api.github.com` is offline or rate-limited (HTTP 403) | Cosmetic only; optional fetch already fails silently and does not block the game |
| Low | Headless SwiftShader renders at low FPS, so the harness uses `engine.setTimeScale(4)` during CLI controller waits; production remains 1× | Test-harness accommodation, not a game behavior change; documented in the script |
| Low | `oc expose svc/<name>` auto-creates a missing Service from the Deployment and prints a simulator-convenience warning (real OCP would return NotFound) | Deliberate teaching convenience with an explicit warning; keep as a known simulator simplification or make it strict post-v1 |
| Low | One EX280 bullet (`manage-certified-technologist`) links to the official exam page rather than a 4.22 chapter docs page | Accepted by static verifier; all bullets remain mapped and the docs link is relevant |
| Low | docs.redhat.com URLs are validated by 4.22 URL shape, not re-fetched on every run | Research docs were fetched/verified on 2026-11-03; URLs can rot externally |
| Info | CDN dependencies (Three.js/Tailwind/fonts) and WebGL are required; no backend/real cluster by design | Consistent with CONVERSION-SPEC non-goals |

Nice-to-have (non-blocking): hide the GitHub stars placeholder when the optional API fails; add a
dedicated 4.22 docs link for the cross-cutting objective; refresh the supplementary
`campaign-level-20.png`/`inspector.png` captures in a future run if desired.

---

## 7. Release recommendation

**GO.** The definition-of-done verification gates pass on the current tree:

- static verifier: **696 checks, 0 failures, 0 warnings**;
- full browser suite: **427 checks, 0 failures, 0 warnings**, 0 console/page errors;
- all required screenshots and both hero/OG artifacts regenerated at the required dimensions;
- content accuracy and EX280V422 coverage validated against the research ground truth;
- no dependency/build-step changes and no game-code edits by the verifier.

The remaining items are low-severity/known simulator limitations, not release blockers. Lead still
owns the final commit/push (standalone history, remotes) and deployment URL confirmation
(`shifting.pro`).

---

## 8. Reproduce

```bash
# Static (zero deps)
node scripts/verify.mjs --verbose

# Browser E2E (puppeteer-core installed outside the repo)
#   mkdir -p /tmp/verify-tools && cd /tmp/verify-tools && npm init -y && npm i puppeteer-core@23
node scripts/browser-test.mjs

# Manual play
python3 -m http.server 8080   # http://localhost:8080 and http://localhost:8080/draw
```
