# Verification report — OpenShift Games (OCP 4.22 / EX280V422)

**Date:** 2026-11-04 (UTC)
**Verified tree:** `main` @ the 1.1.5 release commit (this report is committed with it) in
https://github.com/G-man3207/openshiftgames
**Target:** Red Hat OpenShift Container Platform **4.22** · **EX280V422**
**Canonical URL:** `https://shifting.pro` (current spec/README/index; `og:url`/`og:image` + `/draw`)
**Verdict:** **GO for release** — 0 failures in static verification and 0 failures in the full
browser suite, plus per-issue headless repro scripts for every GitHub issue #1–#14 and the
incidents-drawer overlap UX bug.

Release 1.1.5 closes the open QA report: RBAC is enforced, identity/SCC use the OCP 4.x models,
`oc`/`helm` command fidelity was reworked against the real CLI, the OLM flow is playable, timed labs
and the capstone can no longer soft-lock or be skipped, and the incidents drawer no longer covers
the level brief or the view toolbar.

---

## 1. Environment and commands

| Item | Value |
|---|---|
| Node.js | v26.10.0 |
| Static harness | `node scripts/verify.mjs --verbose` (zero dependencies) |
| Browser harness | `node scripts/browser-test.mjs` (puppeteer-core from `/tmp/verify-tools`, out of repo) |
| Browser | Google Chrome headless (`--headless=new`, SwiftShader WebGL via `--use-angle=swiftshader`) |
| Server | Node static server on `127.0.0.1:<ephemeral>`; production-equivalent static hosting (`/draw` rewrite tested) |
| Viewports | 1600×900 main; 1280×720 responsive sanity; 390×844 start page; 1200×630 OG card |
| Full browser run | see `docs/verification-report.json` → `environment.durationSeconds` |

Commands actually run to completion:

```bash
node scripts/verify.mjs --verbose
node scripts/browser-test.mjs
```

Individual browser areas can be re-run with
`node scripts/browser-test.mjs --only=menu,sandbox,cli,files,ui,campaign,challenges,exam,draw,responsive,regressions,shots`.
The browser script writes `docs/verification-report.json` on every run.

Per-issue headless repro scripts used during the 1.1.5 work (kept outside the repo, listed for
reproduction): `/tmp/rbac-engine/{harness,repro-browser,repro-cli-gate}.mjs`,
`/tmp/cli/repro-{5,8,10,11a,11b,7,shell,hints,groupref}.mjs`,
`/tmp/runtime/{repro-runtime,repro-l10,repro-campaign-olm-scc,repro-exec}.mjs` and
`/tmp/verify-lead/issue1.mjs` (incident panel + drawer overlap).

---

## 2. Static verification — `node scripts/verify.mjs`

```
Files checked: 53 JS modules, 92 total files
Checks passed: 808 · failures: 0 · warnings: 0
```

| Area | What was checked | Result |
|---|---|---|
| Syntax | Every `js/**/*.js` module and both inline HTML modules parse as ES modules (`node --input-type=module --check`) | PASS |
| Import graph | Every relative import target exists; every named import resolves against a static export scan (JS + `index.html`/`draw.html` inline modules + dynamic optional-panel imports) | PASS |
| Kind registry | 47 kinds; apiVersion/scope/palette/aliases/columns/defaultSpec/minimap metadata; every kind has a mesh creator; `PALETTE_SECTIONS` covers all 37 placeable kinds exactly once; index/draw palettes registry-driven; `createResource` returns rich classes, honours supplied `metadata.uid`; new OLM kinds (`OperatorGroup`, `InstallPlan`, `ClusterServiceVersion`, cluster-scoped `PackageManifest`, `MetalLB`) registered with the correct API versions/aliases; `namespace` alias → `Project`; `dc` alias → `Deployment`; no retired `Namespace` kind | PASS |
| API versions | Exact 4.22 map for all kinds (spot checks include Route `route.openshift.io/v1`, BuildConfig/Build `build.openshift.io/v1`, ImageStream `image.openshift.io/v1`, Template `template.openshift.io/v1`, SCC `security.openshift.io/v1`, Project `project.openshift.io/v1`, ClusterResourceQuota `quota.openshift.io/v1`, User/Group `user.openshift.io/v1`, Subscription/OperatorGroup `operators.coreos.com/v1`/`v1alpha1`, InstallPlan/ClusterServiceVersion `operators.coreos.com/v1alpha1`, PackageManifest `packages.operators.coreos.com/v1`, MetalLB `metallb.io/v1beta1`, OAuth/ClusterOperator/ClusterVersion `config.openshift.io/v1`) | PASS |
| Seeded OpenShift baseline | 10 default Projects (`default`, `openshift*`, `kube-system`), 13 ClusterOperators (Available=True/Progressing=False/Degraded=False, 4.22.0), ClusterVersion `version` (`stable-4.22`, desired 4.22.0), the 14 default SCCs, users `kubeadmin`/`admin` + cluster-admin binding, the real `self-provisioners` ClusterRoleBinding, ImageStreams `nodejs:20/18`, `python:3.12`, `nginx:1.26`, the 4-package OLM catalog + `global-operators` OperatorGroup; 66 seeded resources before mode Nodes; `addResource` UID preservation | PASS |
| Campaign | 20 levels / 5 chapters with spec titles; every level has `examObjectives`, 4.22 `docsLinks`, objectives, starting/available resources, 3+ hints, starCriteria; objective kinds/incidents/manifests exist; the L20 capstone carries the incident gates; examObjective strings map to official bullets; tutorial targets valid; no kubectl/`oc export` copy | PASS |
| Challenges | 12 timed labs with exact spec titles/IDs, 180–420 s limits, objectives, starting/available resources, hints, valid preload incidents; `ChallengeMode.startChallenge/getStatus` present; investigation objective accepts owned-pod logs/describe | PASS |
| Incidents | 36 definitions; all 35 required names present; 2+ investigation steps and resolution actions; suggested commands resolve to real Pods/Deployments; `ocCommands` only `oc`; no kubectl; affected resource kinds exist in registry; no legacy `kubectlCommands` data field | PASS |
| EX280V422 coverage | 9 official groups / **55 official bullets**, titles/order/count distribution (14+7+6+5+6+2+5+3+7) match `docs/research/exam-facts.json`; every bullet has a docs link and at least one level/challenge mapping; 9 quick labs; 10 cheat-sheet groups; readiness threshold 0.9; exam facts (EX280V422, 4.22, 3 h) present | PASS |
| Scoring / achievements | `getExamPrepProgress()` / `markExamPrep()` and progress store; per-bullet evidence collection (drill/quick-lab checks; console bullet capped at docs-only); all required stat keys (with legacy aliases); 44 OpenShift-themed achievements with unique IDs/categories/conditions; referenced stats exist | PASS |
| Branding / independence | No `k8sgames.com` or `rohitg00/k8sgames` outside attribution context; the required menu attribution is the only upstream link; no “K8s Games”/“Kubernetes Cluster Simulation” UI copy outside that attribution; no `K8S_BLUE`; kubectl only in the alias/education context; title/meta/OG/twitter/theme copy; pinned Three.js 0.152 / Tailwind 3.4.1; no repo `package.json`/`node_modules`/bundler config | PASS |
| Required files / README | LICENSE, NOTICE, README, index/draw, style, vercel/robots, og source; README GitHub wiki + study-guide/Exam-Prep links; README EX280 coverage table (all 9 groups), credits/attribution, Apache-2.0, non-affiliation, run/deploy/Vercel instructions; canonical `shifting.pro` in index/README/OG | PASS |
| Declarative engine | `YamlParser.selfTest()`; all 19 default files parse; apply `-f`, apply `-k` prod overlay, `processTemplate` + apply, Helm install/list/uninstall, htpasswd add/verify/delete verified via imports with a real `GameEngine`; `--dry-run=client` output is API-shaped | PASS |
| CommandBar / UI wiring | `executeCommand` + `_executeCommand`; `$ oc` prompt/alias; the RBAC authorization gate is wired before dispatch; dispatch paths for required command families incl. the new shell layer (`js/ui/ShellTools.js`); index/draw element IDs; inspector/context-menu/metrics/settings/manifest-panel/incident-panel containers; `window.game` / `manifestEngine` / `examPrepUI` wiring | PASS |

Accepted notes (not failures): one cross-cutting EX280 bullet
(`manage-certified-technologist`) links to the official exam page rather than an OCP 4.22 chapter;
the spec allows this and the readiness/coverage tracker remains complete. The index footer’s
required attribution link to the original project is explicitly allowed by CONVERSION-SPEC §1.

---

## 3. Browser E2E — `node scripts/browser-test.mjs`

```
Browser tests: 552 passed, 0 failed, 0 warnings
Console/page errors: 0 / 0
Verdict: GO
```

| Area | Checks | Failures | What was exercised |
|---|---:|---:|---|
| Menu | 22 | 0 | exact title/meta/OG/twitter/importmap; OpenShift Games logo/subtitle; 4 mode buttons; EX280 Prep; `/draw`; required attribution; GitHub/repo link; Settings/Achievements/Stats modals; achievement count |
| Responsive | 7 | 0 | 1280×720 menu + sandbox (no horizontal overflow, palette/HUD/toolbar visible); restored 1600×900 |
| Tutorial | 17 | 0 | level-start help modal, coach-card sequencing, viewport bounds and stable x-position across Next, H re-opens help, clock pause/resume arbitration, skip clears coach marks |
| EX280 Prep | 19 | 0 | overlay; 9 groups / 55 bullets; 4 tabs; 9 quick labs; 10 cheat groups; 55 copy buttons; search filtering; copy command; readiness bar `0/55`; exam facts EX280V422/3 h; quick-lab launch → Sandbox + overlay close |
| Sandbox | 25 | 0 | Sandbox deep link; seeded resources ↔ meshes (incl. OLM catalog); 37 palette kinds; 10 Projects, 13 ClusterOperators, 3 Nodes, 14 SCCs, 3 ImageStreams; HUD logo/version; toolbar; WebGL ok |
| Files panel | 18 | 0 | `#btn-manifests`; 19 files/tree; editor + Save/Apply -f/Apply -k; `manifests/deployment.yaml` → Deployment/webapp; prod overlay → Deployment/prod-webapp; recorded apply |
| CLI / `oc` | 137 | 0 | session, nodes/co/clusterversion, projects, deployment+Route, `set env/image/resources`, cm/secret, logs/describe/rollout, apply `-f`/`-k`, process, Helm, `new-app`, users/groups, `adm policy add-role-to-user`/`add-scc-to-user`, `auth can-i` (incl. `--as`/serviceaccount), quota/limitrange/clusterquota, route edge/TLS/YAML, get all/status/explain/api-resources/events/top/must-gather, `oc edit` editor, BuildConfig→Build→ImageStream Complete, OLM Subscription→CSV Succeeded and uninstall, jobs/cronjobs, cordon/uncordon, HTPasswd+OAuth login/rotation, RBAC Forbidden paths, dry-run, set volume, expose Service-vs-Route, strategic merge, rollout deadline/history/undo, shell commands; semantic assertions on every mutation |
| UI surfaces | 28 | 0 | inspector select/4 tabs/YAML/describe; context menu Expose Service → Route + Start Build + Edit/Delete; metrics 4 charts; in-game settings; keyboard `/`, `M`, `Space` pause/resume, `Esc`; EX280 Prep open/close pause/resume |
| Campaign | 135 | 0 | levels 1–20 start with exact titles, objective progress/panel, `getStatus()`; level 1 objective completion via `oc login`, `new-project`, `oc run`, `create deployment` all flip completed (100%) |
| Challenges | 77 | 0 | timed labs 1–12 start with exact titles, objective panel and `getStatus()`; countdown freezes while Files is open and resumes after it closes |
| Follow-up | 26 | 0 | real project-template flow (bootstrap template + project.config patch + custom template), HTPasswd password rotation via extract→htpasswd→set data, role `--verb/--resource` flags feeding `oc auth can-i`, dry-run YAML pipelines |
| Regressions | 21 | 0 | minimap first-click collapse + toggle state/anchoring; restart/next-level layout fidelity vs fresh launch; OLM catalog laid out with the platform; single incident panel after relaunch, engine-truth header count, drawer clears the mission card and view toolbar, Esc cleans state |
| Draw | 10 | 0 | `/draw` title/palette 37 unique kinds; watermark; YAML export has `route.openshift.io/v1`, `build.openshift.io/v1`, `project.openshift.io/v1` |
| Screenshots | 10 | 0 | all required captures + final hero/OG dimensions verified |

### State/semantics verified (not just exit codes)

- **RBAC:** a plain htpasswd user receives real `Error from server (Forbidden): …` for
  `oc get nodes`, `oc get pods`, `oc describe node`, `oc logs`, cross-project deletes and
  `oc delete project`; the project list is filtered (no `openshift-*`); adding a role through
  `oc policy`/`oc adm policy` makes the denied command succeed; kubeadmin is unaffected.
- **Self-provisioner:** the seeded `self-provisioners` ClusterRoleBinding is editable
  (`oc describe/patch clusterrolebinding.rbac self-provisioners`); removing
  `system:authenticated:oauth` from it makes `oc new-project` return Forbidden, restoring the group
  re-enables creation.
- **HTPasswd:** login validates against the `htpass-secret` data in `openshift-config`; overwriting
  the root htpasswd file does not change authentication; extract → `htpasswd` → `oc set data secret`
  rotates the password; `oc delete user` keeps the Identity and `oc delete identity` removes it.
- **SCC (4.x model):** `oc adm policy add-scc-to-user/-to-group` create a (Cluster)RoleBinding to
  `system:openshift:scc:<name>` and leave the SCC `users`/`groups` lists untouched; a rejected
  privileged workload creates **no Pod** — the ReplicaSet reports
  `ReplicaFailure/FailedCreate: unable to validate against any security context constraint`; after
  the grant the Pod runs with `openshift.io/scc=privileged`; restricted-v2 rejects explicit
  privileged/root requests.
- **Merge patch:** default `oc patch` is strategic (containers merge by `name`, image preserved);
  `--type=merge` list replacement that would drop the image is rejected
  (`Error from server (Invalid): … image: Required value`) and does not mutate the object;
  `--type=json` RFC 6902 operations apply/reject correctly.
- **Rollouts:** `oc set image` to a missing tag puts every new Pod in `ImagePullBackOff`, the old
  ReplicaSet keeps serving, the Deployment reaches `ProgressDeadlineExceeded` and
  `oc rollout status` prints Waiting then fails with
  `error: deployment "x" exceeded its progress deadline`; history shows real revisions and undo
  restores the previous image and 3/3 Ready.
- **OLM:** `oc get packagemanifests -n openshift-marketplace`, `oc get installplan`,
  `oc get sub,csv` and `oc get csv -A` resolve; Subscription → InstallPlan → CSV
  (`<package>.vX.Y.Z`) → Succeeded → operator Deployment; deleting the Subscription keeps the CSV,
  deleting the CSV removes the operator (real uninstall); MetalLB assigns EXTERNAL-IPs only after
  the operator, MetalLB CR, IPAddressPool and L2Advertisement exist (controller + speaker pods in
  `metallb-system`).
- **CLI fidelity:** `oc set volume(s)` real flags/list/claim-size/PVC; `--dry-run=client|server`
  prints YAML (`-o yaml|json|name`) and never mutates; `oc expose deployment` creates only a
  Service while `oc expose svc` creates a Route; `oc logs job/x`, `oc exec deploy/x`,
  `oc describe istag`, `oc image info`, `skopeo inspect`, `oc create token`, `oc diff -f`,
  `oc rsh`, `oc cp`, `oc wait`, helm repo/search/history/rollback, `<resource>.<group>` tokens and
  `jsonpath` all produce real output.
- **Shell layer:** heredocs, `>`/`>>` redirects, command substitution, pipes and
  cat/echo/grep/tail/head/wc/vim work in the terminal; `vim`/`vi` opens the Files editor for new or
  existing files; terminal-created YAML is `oc apply -f`-able; shell lines are echoed as shell, not
  as `oc`.
- **Incident panel:** one panel only after level changes/retries; header/active count match
  `incidentEngine.getActiveIncidents()`; newly spawned incidents are always visible; resolved cards
  never render `[object Object]`; Esc closes it; the drawer shifts the objectives panel and the view
  toolbar instead of covering them (1492×1232, 1024×768, 390×844).
- **Timed labs / capstone:** the investigation objective advances from `oc logs/describe` on an
  owned Pod and from resolving the incident; the L20 capstone stays open until the scheduled
  CrashLoopBackOff and NodeNotReady incidents fire; L14/ L17 / L18 / L19 objectives reach completion
  and end-state objectives un-tick (e.g. `oc adm groups remove-users`).
- **Readiness / EX280 Prep:** the readiness verdict requires per-bullet evidence (completing all
  levels via the console no longer yields 55/55; a completed level alone is “Practiced”; the console
  bullet stays docs-only); the progress bar goes red → amber → green; quick labs evaluate their
  live `check` before “mark complete”.
- **Network/Policy:** `oc exec deploy/x -- curl` is allowed/denied according to NetworkPolicies;
  DNS resolution requires the 5353 egress rule (53 alone does not work); CronJob schedules are
  validated and respected.
- **Controller semantics:** Route reaches `Admitted=True` once Pods are Running; BuildConfig →
  Build `Complete` with output ImageStream tags; Deployment controller creates Running Pods; Jobs,
  CronJobs, quotas/limitranges, cordon/drain and `oc adm top` behave like the API.

---

## 4. Screenshots and artifacts

Generated/validated in the final run (all 1600×900 unless noted):

| File | Purpose |
|---|---|
| [`screenshot.png`](../screenshot.png) | README hero gameplay (Sandbox, seeded cluster) |
| [`docs/screenshots/menu.png`](screenshots/menu.png) | main menu/branding |
| [`docs/screenshots/sandbox.png`](screenshots/sandbox.png) | seeded Sandbox with HUD/palette |
| [`docs/screenshots/campaign-level-1.png`](screenshots/campaign-level-1.png) | campaign level 1 + objectives |
| [`docs/screenshots/exam-prep.png`](screenshots/exam-prep.png) | EX280 Prep tracker (9 groups/55 bullets, evidence-based verdict) |
| [`docs/screenshots/files-panel.png`](screenshots/files-panel.png) | Files & Manifests panel |
| [`docs/screenshots/draw.png`](screenshots/draw.png) | OpenShift Draw + YAML export |
| [`og-image.png`](../og-image.png) | Open Graph/Twitter card (`shifting.pro`, 1200×630) |
| [`docs/verification-report.json`](verification-report.json) | machine-readable: pass/fail + timings + artifact metadata |

Supplementary images retained from earlier verification runs:
[`docs/screenshots/inspector.png`](screenshots/inspector.png) (inspector detail) and
[`docs/screenshots/campaign-level-20.png`](screenshots/campaign-level-20.png) (capstone).

---

## 5. Content-accuracy spot checks

Checked against `docs/research/exam-facts.json`, `docs/research/ex280-objectives.md`,
`docs/research/openshift-workloads-builds.md`,
`docs/research/openshift-networking-security-storage.md` (OCP 4.22 / `enterprise-4.22`):

- **Exam identity:** EX280V422, OCP 4.22, 3-hour performance-based, persistence rule; 9 groups /
  55 bullets; group distributions and bullet titles match the official list exactly.
- **API versions:** see the static-verification table above (including the new OLM kinds).
- **Version-sensitive behavior:** Projects rather than Namespaces in UX/model; no `Namespace` game
  kind; no `oc export` teaching (`oc get -o yaml >` instead); Deployment preferred over deprecated
  DeploymentConfig (`dc` is only a warning alias); `restricted-v2` default SCC; SCC grants use the
  4.x RBAC binding model; HTPasswd via OAuth Secret; Kustomize/Helm flows present; MetalLB
  IPAddressPool/L2Advertisement for bare-metal LB; OLM OperatorGroup/InstallPlan/CSV lifecycle.
- **Observed command semantics:** RBAC Forbidden paths, self-provisioner removal, dry-run output,
  `oc expose` Service-vs-Route split, strategic merge behavior, rollout deadline and history,
  builds/operators reaching the documented phases, and HTPasswd login/RBAC/SCC decisions all behave
  as documented for OCP 4.22.
- **Content corrections in 1.1.5:** L1 no longer claims an image-only rejection under
  restricted-v2; L3/timed lab 02 use per-Pod/per-image crash logs and no longer teach
  restart-until-green; L6 `APP_ENV=production`; L8 describes application Templates + Helm;
  L12/L18/C10 teach the OLM OperatorGroup → Subscription → InstallPlan → CSV flow (uninstall =
  delete Subscription **then** CSV); L17/C8 teach a dedicated ServiceAccount SCC grant and verify it
  through RBAC, not through the SCC users list; DNS egress uses `dns-default` port 5353.
- **Unverified/unpublished claims:** passing score, score scale and certification validity are not
  published by Red Hat and are not stated in game copy (research flags them UNVERIFIED).

---

## 6. Known limitations (residual, non-blocking)

| Severity | Issue | Impact / disposition |
|---|---|---|
| Low | `oc rollout status` in the terminal prints the blocking “Waiting …” line immediately and appends the final/deadline line asynchronously via a poll + event watch; the blocking semantics of real `oc` are approximated for a browser shell | Documented simulator mapping; the exact deadline error is shown and L10 verifies it |
| Low | Image pullability is a simulator heuristic: internal registry references resolve real ImageStreamTags, external tags are assumed pullable unless the tag/repo looks missing (`does-not-exist`, `not-found`, …). An arbitrary unknown external tag will not fail | Deliberate (no external registry knowledge); L10 uses an obviously-missing tag |
| Low | Deployments keep the real default `progressDeadlineSeconds: 600` except where a lab seeds a shorter value (L10 = 45 s) | Realistic; a stalled rollout in another level can take 10 simulated minutes to report the deadline |
| Low | The PackageManifest catalog is a 4-package simulation (3D resource budget) and is re-seeded if deleted | Deliberate; deployment/CSV/InstallPlan behaviour is modelled in full |
| Low | MetalLB speaker is a normal Pod (no hostNetwork/privileged) because the default SA has no SCC grant there; the operator/CR/pool/advertisement + EXTERNAL-IP wiring is what is exercised | Deliberate teaching simplification |
| Low | NetworkPolicy evaluation covers Pod-to-Pod traffic (ingress+egress, selectors, ipBlock, ports); Routes/hostNetwork traffic is not policy-evaluated. DNS is modelled as `dns-default` on 5353 | Deliberate scope; documents the exam-relevant behaviour |
| Low | GitHub stars badge shows `0`/`--` when `api.github.com` is offline or rate-limited (HTTP 403) | Cosmetic only; the optional fetch fails silently |
| Low | Headless SwiftShader renders at low FPS, so the browser harness uses `engine.setTimeScale(4)` during controller waits; production remains 1× | Test-harness accommodation |
| Low | One EX280 bullet (`manage-certified-technologist`) links to the official exam page rather than a 4.22 chapter docs page | Accepted by the static verifier; all bullets remain mapped |
| Info | CDN dependencies (Three.js/Tailwind/fonts) and WebGL are required; no backend/real cluster by design | Consistent with CONVERSION-SPEC non-goals |
| Info | Incident-managed Pods (annotation `openshiftgames.io/incident`) are managed by the incident engine rather than the generic Pod lifecycle | Required by the incident scenarios |

---

## 7. Release recommendation

**GO.** The definition-of-done verification gates pass on the release tree:

- static verifier: **808 checks, 0 failures, 0 warnings** (53 JS modules, 92 files);
- full browser suite: **552 checks, 0 failures, 0 warnings**, 0 console/page errors;
- every open GitHub issue (#1–#14) and the incidents-drawer overlap UX bug has a targeted headless
  repro that passes, in addition to the full-suite coverage;
- all required screenshots and both hero/OG artifacts regenerated at the required dimensions;
- content accuracy and EX280V422 coverage validated against the research ground truth;
- no dependency/build-step changes and no game-code edits by the verifier.

The remaining items are low-severity/known simulator limitations, not release blockers.

---

## 8. Reproduce

```bash
# Static (zero deps)
node scripts/verify.mjs --verbose

# Browser E2E (puppeteer-core installed outside the repo)
#   mkdir -p /tmp/verify-tools && cd /tmp/verify-tools && npm init -y && npm i puppeteer-core@23
node scripts/browser-test.mjs

# Visual/responsive QA (screenshots + collision/overflow checks)
node scripts/visual-qa.mjs --strict

# Manual play
python3 -m http.server 8080   # http://localhost:8080 and http://localhost:8080/draw
```
