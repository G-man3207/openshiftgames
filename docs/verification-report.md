# Verification report — OpenShift Games (OCP 4.22 / EX280V422)

**Date:** 2026-11-04 (UTC)
**Verified tree:** `main` @ the 1.2.0 release commit (this report is committed with it) in
https://github.com/G-man3207/openshiftgames
**Target:** Red Hat OpenShift Container Platform **4.22** · **EX280V422**
**Canonical URL:** `https://shifting.pro` (current spec/README/index; `og:url`/`og:image` + `/draw`)
**Verdict:** **GO for release** — 0 failures in static verification (942 checks), 0 failures
in the full browser suite (1220 checks), visual QA PASS (96 checks, 0 failures), a
clean Prettier/Knip gate, and per-issue headless coverage for every GitHub issue #1–#36.

Release 1.1.5 closed the original QA report (#1–#14): RBAC enforcement, 4.x identity/SCC models,
real `oc`/`helm` fidelity, the OLM flow, timed-lab/capstone fixes and the incidents-drawer layout.
Release 1.1.6 closed the QA **retest** report (#15–#21): image-pull vs. crash-looping lab state,
real container naming, rollout-status race/`--timeout`, OLM catalog fidelity, the remaining CLI
gaps, the restricted-v2 `nginx:latest` trap, the capstone incident gate, stricter readiness
evidence and the HUD paused indicator. Release 1.1.7 closed the third QA pass (#22–#26): the
timed-lab 02 soft-lock, lab-02 diagnostics fidelity, Helm 3 history/rollback semantics, the
corrected restricted-v2 `nginx` runtime model, the remaining CLI leftovers and the dev-only
Prettier/Knip/husky toolchain.

**Release 1.2.0 closes the fourth QA pass (#27–#36)** — every open issue on the tracker — and is
the biggest fidelity release since the conversion: incident self-healing, a CLI node-troubleshooting
session, namespace-safe destructive verbs, a workstation shell (`base64`/`openssl`/`curl`/`exec`
content), service-ca serving certificates + router-aware NetworkPolicy evaluation, OpenShift
project defaults (SAs/RoleBindings/dockercfg/oauth pods), state-based grading (behaviour probes for
NetworkPolicy/OAuth/login), realistic job/quota scenarios, a 13th timed lab "Production Network
Policies", standard templates, a monitoring/alerting data model with `PrometheusRule`/`Alertmanager`,
kustomize v5 examples, the post-campaign handover screen and the full CLI output-fidelity list.

---

## 1. Environment and commands

| Item             | Value                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Node.js          | v26.10.0                                                                                                     |
| Dev tooling      | Prettier 3.9, Knip 5.88, husky 9 — dev-only, `npm install`, no runtime dependencies or build step            |
| Static harness   | `node scripts/verify.mjs --verbose` (zero dependencies)                                                      |
| Browser harness  | `node scripts/browser-test.mjs` (puppeteer-core from `/tmp/verify-tools`, out of repo)                       |
| Browser          | Google Chrome headless (`--headless=new`, SwiftShader WebGL via `--use-angle=swiftshader`)                   |
| Server           | Node static server on `127.0.0.1:<ephemeral>`; production-equivalent static hosting (`/draw` rewrite tested) |
| Viewports        | 1600×900 main; 1280×720 responsive sanity; 390×844 start page; 1200×630 OG card                              |
| Full browser run | 1220 checks in 614 s — see `docs/verification-report.json` → `environment.durationSeconds`                   |

Commands actually run to completion on the release tree:

```bash
npm install                 # dev-only toolchain (optional to play; the game has no runtime deps)
npm run lint                # prettier --check . + knip — the same gate the husky hook runs
node scripts/verify.mjs --verbose
node scripts/browser-test.mjs
node scripts/visual-qa.mjs --strict
```

Individual browser areas can be re-run with
`node scripts/browser-test.mjs --only=menu,sandbox,cli,files,ui,campaign,challenges,exam,draw,responsive,regressions,qa-incidents,qa-scenarios,qa-cli,qa-workstation,qa-openshift,qa-grading,qa-coverage,shots`.
The browser script writes `docs/verification-report.json` on every run.

The 1.2.0 acceptance coverage for issues #27–#36 lives permanently in `scripts/browser-test.mjs`
in seven dedicated sections (`qa-incidents`, `qa-scenarios`, `qa-cli`, `qa-workstation`,
`qa-openshift`, `qa-grading`, `qa-coverage`) plus the expanded `cli`/`campaign`/`challenges`
regressions. The out-of-repo per-issue repro suites from earlier rounds remain under `/tmp`
(`/tmp/incidents`, `/tmp/scenarios`, `/tmp/cli-safety`, `/tmp/workstation`, `/tmp/openshift-details`,
`/tmp/grading`, `/tmp/coverage`).

---

## 2. Static verification — `node scripts/verify.mjs`

```
Files checked: 55 JS modules, 117 total files
Checks passed: 942 · failures: 0 · warnings: 0
```

| Area                      | What was checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Result |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Syntax                    | Every `js/**/*.js` module and both inline HTML modules parse as ES modules                                                                                                                                                                                                                                                                                                                                                                                                                            | PASS   |
| Import graph              | Every relative import target exists; every named import resolves against a static export scan (JS + `index.html`/`draw.html` inline modules + dynamic optional-panel imports)                                                                                                                                                                                                                                                                                                                         | PASS   |
| Kind registry             | 49 kinds; apiVersion/scope/palette/aliases/columns/defaultSpec/minimap metadata; every kind has a mesh creator (49/49); `PALETTE_SECTIONS` covers the same 37 placeable kinds exactly once; new monitoring kinds `PrometheusRule`/`Alertmanager` (`monitoring.coreos.com/v1`, non-placeable, mesh-backed); new OLM/cluster kinds verified; palette runtime-generated in both HTML shells                                                                                                              | PASS   |
| API versions              | Exact 4.22 map for all kinds incl. Route `route.openshift.io/v1`, BuildConfig/Build `build.openshift.io/v1`, ImageStream `image.openshift.io/v1`, Template `template.openshift.io/v1`, SCC `security.openshift.io/v1`, Project `project.openshift.io/v1`, ClusterResourceQuota `quota.openshift.io/v1`, User/Group/Identity `user.openshift.io/v1`, Subscription/OperatorGroup/InstallPlan/CSV, PackageManifest, MetalLB, monitoring `monitoring.coreos.com/v1`, OAuth/ClusterOperator/ClusterVersion | PASS   |
| Seeded OpenShift baseline | 10 default Projects, 13 ClusterOperators (4.22.0), ClusterVersion `version` (`stable-4.22`), the 14 default SCCs, users kubeadmin/admin + cluster-admin binding, real `self-provisioners` CRB, ImageStreams, the 4-package OLM catalog + `global-operators`, project bootstrap (builder/default/deployer SAs, admin + image-puller/builder/deployer RoleBindings, dockercfg Secrets), oauth-openshift pods, monitoring rules + Alertmanager, 69+ seeded resources; `addResource` UID preservation     | PASS   |
| Campaign                  | 20 levels / 5 chapters with spec titles; every level has `examObjectives`, 4.22 `docsLinks`, objectives, starting/available resources, 3+ hints, starCriteria; objective kinds/incidents/manifests exist; new objectives (password, identity, installPlan, subscription, routeAccess, networkPolicy, oauthProvider) implemented in the evaluator; L20 capstone carries the incident gates + router-ingress objective; tutorial targets valid; no kubectl/`oc export` copy                             | PASS   |
| Challenges                | **13** timed labs with exact spec titles/IDs, 180–420 s limits, objectives, starting/available resources, hints, valid preload incidents; new lab 13 "Production Network Policies" ships a starter-only default-deny file and four behaviour-graded objectives; `ChallengeMode.startChallenge/getStatus` present; investigation objectives accept owned-pod logs/describe                                                                                                                             | PASS   |
| Incidents                 | 36 definitions; all 35 required names present; 2+ investigation steps and resolution actions; suggested commands resolve to real Pods/Deployments; `ocCommands` only `oc`; corrected Job/quota scenarios (dedicated L19 broken Job, no phantom quota pod)                                                                                                                                                                                                                                             | PASS   |
| EX280V422 coverage        | 9 official groups / **55 official bullets**, titles/order/count distribution match `docs/research/exam-facts.json`; every bullet has a docs link and at least one level/challenge mapping; 10 quick labs (incl. serving-cert → reencrypt Route and HTPasswd rotation); 10 cheat-sheet groups; readiness threshold 0.9; exam facts EX280V422 / 4.22 / 3 h present                                                                                                                                      | PASS   |
| Scoring / achievements    | `getExamPrepProgress()` / `markExamPrep()` and progress store; per-bullet evidence collection; all required stat keys; 44 OpenShift-themed achievements (challenge-veteran now 13 labs); referenced stats exist                                                                                                                                                                                                                                                                                       | PASS   |
| Branding / independence   | No legacy branding outside the delimited attribution; kubectl only in alias/education context (the standard `kubectl.kubernetes.io/*` annotation key is explicitly allowed as a real Kubernetes key, not player copy); pinned Three.js 0.152 / Tailwind 3.4.1                                                                                                                                                                                                                                         | PASS   |
| Required files / README   | LICENSE, NOTICE, README, index/draw, style, vercel/robots, og source; README GitHub wiki links; README EX280 coverage table (9 groups, 13 timed labs); credits/attribution; Apache-2.0; run/deploy/Vercel instructions; canonical `shifting.pro`                                                                                                                                                                                                                                                      | PASS   |
| Dev tooling contract      | Private `package.json` 1.2.0 + devDependencies exactly prettier/knip/husky; no runtime deps or bundler config; `scripts/knip-entrypoints.mjs` mirrors every inline HTML import (incl. EX280Objectives for the handover) and `verify.mjs` enforces it; pre-commit hook runs both gates                                                                                                                                                                                                                 | PASS   |
| Declarative engine        | `YamlParser.selfTest()`; 26 default manifest files parse (incl. the operator Subscription variants, allow-from-router policy and kustomize v5 examples); apply `-f`, apply `-k` prod overlay, processTemplate + apply, Helm install/list/uninstall, htpasswd add/verify/delete verified via imports with a real `GameEngine`; kustomize `labels:`/`patches:`/`commonLabels` semantics verified                                                                                                        | PASS   |
| CommandBar / UI wiring    | `executeCommand` + RBAC authorization gate; dispatch paths for every command family incl. the shell layer; new `oc debug node` session, `_rowCells` monitoring printers, completed-pod/CrashLoop exec guards; index/draw element IDs and `window.game` wiring; handover overlay wiring                                                                                                                                                                                                                | PASS   |

Accepted notes (not failures): two new non-spec monitoring kinds are expected additions (registered
in the expected catalog); one cross-cutting EX280 bullet links to the official exam page rather than
a 4.22 chapter; the index footer's required upstream attribution link is explicitly allowed by
CONVERSION-SPEC §1.

---

## 3. Browser E2E — `node scripts/browser-test.mjs`

```
Browser tests: 1220 passed, 0 failed, 0 warnings
Console/page errors: 0 / 0
Verdict: GO
```

| Area                          | Checks | Failures | What was exercised                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | -----: | -------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu                          |     22 |        0 | exact title/meta/OG/twitter/importmap; branding; 4 mode buttons; EX280 Prep; `/draw`; attribution; Settings/Achievements/Stats modals                                                                                                                                                                                                                                                          |
| Responsive                    |      7 |        0 | 1280x720 menu + sandbox (no horizontal overflow, palette/HUD/toolbar visible); restored 1600x900                                                                                                                                                                                                                                                                                               |
| Tutorial                      |     17 |        0 | level-start help modal, coach-card sequencing, viewport bounds, H help key, clock pause/resume arbitration, skip clears marks                                                                                                                                                                                                                                                                  |
| EX280 Prep                    |     19 |        0 | overlay; 9 groups / 55 bullets; 4 tabs; 10 quick labs; 10 cheat groups; copy buttons; search; readiness bar; exam facts; quick-lab launch                                                                                                                                                                                                                                                      |
| Sandbox                       |     25 |        0 | deep link; seeded resources ↔ meshes (incl. monitoring baseline); 37 palette kinds; projects/COs/Nodes/SCCs/ImageStreams; HUD; toolbar; WebGL ok                                                                                                                                                                                                                                               |
| Files panel                   |     26 |        0 | `#btn-manifests`; file tree; editor + Save/Apply -f/Apply -k; kustomize v5 base/prod overlays apply with correct labels/selectors; recorded apply                                                                                                                                                                                                                                              |
| CLI / `oc`                    |    217 |        0 | session, projects, get/describe/output fidelity, write-verb namespace safety, apply/create idempotency, Routes/TLS, set env/image/resources/volume, helm, new-app, users/groups, `adm policy`/`auth can-i`, quotas/limits/CRQ, OLM, jobs/cronjobs, cordon/uncordon, HTPasswd+OAuth, RBAC Forbidden, dry-run, rollout, shell commands and the 1.2.0 workstation tools (all semantic assertions) |
| UI surfaces                   |     29 |        0 | inspector/4 tabs/YAML/describe; context menu; metrics; settings; keyboard; EX280 Prep pause; deployment status labels                                                                                                                                                                                                                                                                          |
| Campaign                      |    147 |        0 | levels 1–20 start with exact titles, objective progress/panel/status; level 1 completion flow; L3/L20 incident gates; L20 node recovery + router-ingress objectives                                                                                                                                                                                                                            |
| Challenges                    |    114 |        0 | timed labs 1–13 start, objective panels/status; footer/clock behaviour; lab 2/6/8/9/11/13 end-to-end (including the new behaviour-graded network-policy lab); countdown freeze/resume                                                                                                                                                                                                          |
| Follow-up                     |     26 |        0 | project-template flow, HTPasswd rotation, role `--verb/--resource` flags → `auth can-i`, dry-run YAML pipelines                                                                                                                                                                                                                                                                                |
| Regressions                   |     22 |        0 | minimap first-click collapse; restart/next-level layout fidelity; single incident panel after relaunch; drawer clears mission card/view toolbar; Esc cleanup                                                                                                                                                                                                                                   |
| QA #27/#28 (`qa-incidents`)   |     91 |        0 | L17 SCCForbidden self-heals from state CLI-only (13); L15 quota heals from state CLI-only (19); lab 8 fix-before-trigger (9); lab 6 quota heals from state (11); L20 NodeNotReady recovered via `oc debug`/`systemctl restart kubelet` (24); L3 CrashLoop seed/fix contract (9); repaired Job never force-completed/no empty logs (6)                                                          |
| QA #31 (`qa-scenarios`)       |     68 |        0 | seeded L3/L20 CrashLoop APP_MODE cause; L19 dedicated broken Job + real `oc logs job/x`; Job/Pod status Completed; lab 1 mysql crash loop + 3306; lab 12 compute-quota-without-LimitRange; L15 truthful quota/RS event model                                                                                                                                                                   |
| QA #29/#36 (`qa-cli`)         |     77 |        0 | namespace-exact write verbs; AlreadyExists; apply unchanged; delete -l; describe-all; `ls` semantics; silent redirects; dry-run `-o name`; uid/timestamps; kustomize output/selectors; `-o wide`/endpoints/istag/build/route/service/jsonpath/quota/cronjob/events/rollout output fidelity                                                                                                     |
| QA #32/#33 (`qa-workstation`) |    114 |        0 | base64/openssl req+x509/secret tls/cut; exec/rsh volumes+env+crashloop guards; workstation curl edge/passthrough/reencrypt + redirect + DNS + `-k`; service-ca serving cert + cabundle for reencrypt Routes; L20 end-to-end default-deny → curl 503 (Route Admitted) → allow-from-router → curl 200 + `routeAccess` objective                                                                  |
| QA #35 (`qa-openshift`)       |     50 |        0 | default SAs/RoleBindings/dockercfg; `who-can use scc` + `scc-subject-review -f`; SCC investigation progress; 4.x `add-scc-to-user` output; `add-role-to-group` naming; OAuth pods/rollout consistency; `set env --from` per-key refs; `start-build --follow`; ns `--show-labels`/CRQ selector; `oc run --overrides` rejection; login password validation                                       |
| QA #30 (`qa-grading`)         |     38 |        0 | lab 9 hand-written NetworkPolicy set 6/6 behaviour; lab 11 heredoc/patch/apply OAuth state; login latch across user switches; User only after first login; L2 wrong-namespace label never ticks                                                                                                                                                                                                |
| QA #34 (`qa-coverage`)        |     91 |        0 | standard templates (get/process/new-app); alerting model (rules/Alertmanager/live alerts); post-campaign handover + checklist persistence; kustomize v5; L13 password rotation + delete User/Identity; lab 13 Production Network Policies; L18 AllNamespaces/Manual/startingCSV; lab 10 variants; L1 intro trap-free                                                                           |
| Draw                          |     10 |        0 | `/draw` title/palette 37 unique kinds; watermark; YAML export API versions                                                                                                                                                                                                                                                                                                                     |
| Screenshots                   |     10 |        0 | all required captures + final hero/OG dimensions verified                                                                                                                                                                                                                                                                                                                                      |

---

## 3b. QA-pass verification (#27–#36)

A fourth full QA playthrough of the 1.1.7 build (CLI-first, L1–L20 plus all timed labs) reported
ten issues (#27–#36). Every item was reproduced, fixed and is covered by a durable regression
section; the tree keeps the full per-issue evidence permanently in `scripts/browser-test.mjs`.

| Issue                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#27** P1 — incidents only heal on a cluster write; unresolvable targets never heal; SCC heal re-pends the running pod | IncidentEngine state reconciliation runs on the simulation tick (throttled, pause-aware) and is shared with the cluster:modified watcher; null-target early return moved into per-type checks; quota incidents bind to the quota actually damaged; state-driven SCC resolutions no longer heal an already-healthy workload                    | `qa-incidents`: L17 SCCForbidden self-heals from state CLI-only (13 checks), L15 quota heals from state CLI-only (19), lab 8 fix-before-trigger (9), lab 6 quota heals (11) |
| **#28** P1 — NodeNotReady has no CLI fix; cordoned/NotReady display; node naming                                        | `oc debug node/<n>` interactive session (`chroot /host`, `systemctl status/restart kubelet`, `journalctl -u kubelet`, `exit`) + one-shot form; `systemctl restart kubelet` is the state-driven NodeNotReady fix (drawer preserved); nodes are worker-0/worker-1/master-0 with real ROLES and `NotReady,SchedulingDisabled`                    | `qa-incidents` L20 NodeNotReady recovered via `oc debug`/`systemctl` (24 checks), `cli` node/verify regressions                                                             |
| **#29** P1 — destructive verbs fall through to another namespace; `oc create` on existing says "configured"             | Every write verb resolves namespace-exactly (no cross-project fallback); `AlreadyExists` for named/`-f`/server-dry-run creates; `delete -l/--all`; server-style NotFound; re-apply unchanged without a generation bump; `describe <type>` with no name lists all                                                                              | `qa-cli` (77 checks), `cli`/`files`/`campaign` regressions                                                                                                                  |
| **#30** P2 — objectives graded on hidden names/command regexes                                                          | Behaviour-based `networkPolicy` probes (default-deny, DNS 5353, reach/deny) for lab 9; `oauthProvider` state for lab 11; login-history latch; first-login User semantics; namespace-correct label grading                                                                                                                                     | `qa-grading` (38 checks)                                                                                                                                                    |
| **#31** P2 — generic CrashLoop any-change fix; L19 job hijack; job status; mysql; quota models                          | Seeded bad image + APP_MODE contract with fix-only healing; dedicated L19 failing Job + real job logs/status; completed Pods retained, no undefined-phase events; mysql-80 image profile with real missing-MYSQL_* log and 3306; compute-quota-without-LimitRange admission; truthful L15 quota model (no phantom pod, Used<=Hard, RS events) | `qa-scenarios` (68 checks), campaign/challenges/cli regression 474/0                                                                                                        |
| **#32** P2 — missing workstation tools                                                                                  | Real `base64 -d/-w0`, `openssl req -x509`/`x509` PEM round-trip, `cut -c`, workstation `curl` through the router, exec/rsh volume/env content and crashloop/completed guards                                                                                                                                                                  | `qa-workstation` (114 checks)                                                                                                                                               |
| **#33** P2 — service serving certs; router after default-deny                                                           | service-ca controller issues serving-cert Secrets and injects CA bundles; reencrypt Route flow; router-aware NetworkPolicy evaluation blocks the Route until a router-ingress allow policy exists; L20 end-to-end grades it                                                                                                                   | `qa-workstation` L20 end-to-end block (curl 503 → allow → 200 + routeAccess objective)                                                                                      |
| **#34** P3 — EX280 coverage gaps                                                                                        | Password-rotation objective (extract→htpasswd→set data→OAuth rollout→login) and User+Identity deletion; 13th timed lab "Production Network Policies"; L18 AllNamespaces/Manual-approval/startingCSV; standard templates; PrometheusRule/Alertmanager alerting; kustomize v5 examples; post-campaign handover; L1 intro moved trap to L3       | `qa-coverage` (91 checks), `challenges` 13-lab regression (114)                                                                                                             |
| **#35** P3 — OpenShift platform details                                                                                 | Project bootstrap SAs/RoleBindings/dockercfg + oauth pods; `who-can use scc`/`scc-subject-review -f`; 4.x SCC output; `add-role-to-group` naming; OAuth rollout consistency; `set env --from` per-key refs; `start-build --follow`; ns LABELS + CRQ selector; `run --overrides`; login password validation; SCC investigation progress        | `qa-openshift` (50 checks)                                                                                                                                                  |
| **#36** P4 — collected CLI output differences                                                                           | `ls` children/relative names, silent redirects, `-o name` dry-run, UUID/second timestamps, kustomize `---`/selector fixes, `-o wide`, endpoints, istag/digest/build output, rollout history/status wording, route/service formatting, JSONPath escaped/unset, nodePorts, quota alignment, CronJob TIMEZONE, describe-deploy events            | `qa-cli` (77 checks)                                                                                                                                                        |

Shared gates for this pass (run on the release tree): `node scripts/verify.mjs` **942/0**
(0 warnings); full browser suite **1220/0** (0 warnings, 0 console/page errors, GO);
`node scripts/visual-qa.mjs --strict` **PASS** (96 checks, 0 failures, pre-existing
informational heuristics only); `npx prettier --check .` **0** unformatted files and `npx knip`
**0** issues.

---

## 4. Screenshots and artifacts

Generated/validated in the final run (all 1600×900 unless noted):

| File                                                                                                  | Purpose                                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`screenshot.png`](../screenshot.png)                                                                 | README hero gameplay (Sandbox, seeded cluster)                   |
| [`docs/screenshots/menu.png`](screenshots/menu.png)                                                   | main menu/branding                                               |
| [`docs/screenshots/sandbox.png`](screenshots/sandbox.png)                                             | seeded Sandbox with HUD/palette (incl. alerting objects)         |
| [`docs/screenshots/campaign-level-1.png`](screenshots/campaign-level-1.png)                           | campaign level 1 + objectives (trimmed intro)                    |
| [`docs/screenshots/exam-prep.png`](screenshots/exam-prep.png)                                         | EX280 Prep tracker (9 groups/55 bullets, evidence-based verdict) |
| [`docs/screenshots/files-panel.png`](screenshots/files-panel.png)                                     | Files & Manifests panel (kustomize v5 examples)                  |
| [`docs/screenshots/draw.png`](screenshots/draw.png)                                                   | OpenShift Draw + YAML export                                     |
| [`docs/screenshots/regressions-campaign-restart.png`](screenshots/regressions-campaign-restart.png)   | campaign restart/next-level layout regression capture            |
| [`docs/screenshots/regressions-minimap-collapsed.png`](screenshots/regressions-minimap-collapsed.png) | minimap first-click collapse regression capture                  |
| [`og-image.png`](../og-image.png)                                                                     | Open Graph/Twitter card (`shifting.pro`, 1200×630)               |
| [`docs/verification-report.json`](verification-report.json)                                           | machine-readable: pass/fail + timings + artifact metadata        |

Supplementary images retained from earlier verification runs:
[`docs/screenshots/incidents-drawer.png`](screenshots/incidents-drawer.png) (incidents drawer),
[`docs/screenshots/inspector.png`](screenshots/inspector.png) (inspector detail) and
[`docs/screenshots/campaign-level-20.png`](screenshots/campaign-level-20.png) (capstone).

---

## 5. Content-accuracy spot checks

Checked against `docs/research/exam-facts.json`, `docs/research/ex280-objectives.md`,
`docs/research/openshift-workloads-builds.md`,
`docs/research/openshift-networking-security-storage.md` (OCP 4.22 / `enterprise-4.22`):

- **Exam identity:** EX280V422, OCP 4.22, 3-hour performance-based, persistence rule; 9 groups /
  55 bullets; group distributions and bullet titles match the official list exactly.
- **API versions:** see the static-verification table above (incl. `monitoring.coreos.com/v1` for
  PrometheusRule/Alertmanager).
- **Version-sensitive behavior:** Projects rather than Namespaces; no `Namespace` game kind; no
  `oc export` teaching; Deployment preferred over deprecated DeploymentConfig; `restricted-v2`
  default SCC with spec-based admission; SCC grants via 4.x RBAC bindings; HTPasswd via OAuth
  Secret + OAuth rollout; Kustomize v5 `labels:`/`patches:`; Helm 3 revision/rollback output;
  operator AllNamespaces/Manual-approval/startingCSV variants; MetalLB IPAddressPool/
  L2Advertisement; service-ca serving certificates; router-ingress NetworkPolicy.
- **Observed command semantics:** namespace-exact write verbs; `AlreadyExists` vs `apply` unchanged;
  `oc debug node` kubelet troubleshooting; real `oc get/describe` column/output fidelity; RBAC
  Forbidden paths; dry-run; JSONPath escaping; `oc set env --from` per-key refs; `oс start-build
--follow`; ServiceAccount + SCC grant verification via `who-can`/`scc-subject-review`;
  admitted-then-crash-looping `nginx` runtime behaviour; mysql missing-`MYSQL_*` crash loop;
  quota-without-LimitRange admission and ReplicaSet FailedCreate events; node NotReady recovery
  through `systemctl restart kubelet`.
- **Content corrections in 1.1.5:** RBAC enforcement, 4.x identity/SCC models, real `oc`/`helm`
  fidelity, OLM flow, timed-lab/capstone fixes, incidents drawer layout.
- **Content corrections in 1.1.6:** timed lab 02 pullable-but-crashing image; `metallb-operator`
  catalog + CSV; L20 scheduled-incident gate; readiness evidence scoped to the linked drill run;
  generic CrashLoopBackOff hint; DNS 5353 references.
- **Content corrections in 1.1.7:** corrected restricted-v2 `nginx` runtime model; live-metric
  `describe` output; Helm 3 history/rollback; per-namespace OLM resolution; image-pull tokens
  matched anywhere in the tag.
- **Content corrections in 1.2.0:** L3/L20 CrashLoopBackOff seeded `APP_MODE` cause; L19 dedicated
  failing Job; lab 1 mysql profile; lab 12 compute-quota trap; L15 truthful quota model; lab 9
  behaviour-graded NetworkPolicy; lab 11 OAuth state grading + login latch; L13 real password
  rotation + User/Identity deletion; L18 operator install variants; new lab 13 Production Network
  Policies; standard templates; PrometheusRule/Alertmanager alerting; kustomize v5 examples;
  post-campaign handover; L1 intro trap moved to L3; node/ROLE naming; default project RBAC/SAs/
  dockercfg; ClusterResourceQuota selector hints now use `kubernetes.io/metadata.name`.
- **Unverified/unpublished claims:** passing score, score scale and certification validity are not
  published by Red Hat and are not stated in game copy (research flags them UNVERIFIED).

---

## 6. Known limitations (residual, non-blocking)

| Severity | Issue                                                                                                                                                                                                                                                                                                           | Impact / disposition                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low      | `oc rollout status` prints the blocking waiting line immediately and appends the final/deadline/timeout line asynchronously; the blocking semantics of real `oc` are approximated for a browser shell                                                                                                           | Documented simulator mapping; exact progress-deadline and `--timeout` errors are shown, L10 and the round-2 race repros verify them               |
| Low      | Image pullability is a simulator heuristic: internal registry references resolve ImageStreamTags; external images use failure tokens matched anywhere in the tag and known-good tags keep pulling/recovering                                                                                                    | Deliberate (no external registry knowledge); L10 and timed lab 02 use explicit good/bad tags, `:v9-nope` → `:latest` recovery is browser-verified |
| Low      | Known root-image security personas are runtime, not admission: only `nginx` and `mysql-80` are modelled as canonical root images, admitted by a non-root SCC and then crash-looping with their real permission/env logs; other root images stay admitted unless the Pod spec requests `runAsUser: 0`/privileged | Deliberate teaching scope; the documented anyuid ServiceAccount fix path is browser-verified                                                      |
| Low      | A Subscription for an unknown package latches `ResolutionFailed` for the whole namespace/OperatorGroup (correct OLM semantics); editing it to a valid package retries resolution                                                                                                                                | Documented behaviour; install path verified end-to-end                                                                                            |
| Low      | `sim.getEvents()` returns both Normal and Warning resource events; the CLI de-duplicates them for `oc get events`                                                                                                                                                                                               | Harness-verified; no visible duplication                                                                                                          |
| Low      | Deployments keep the real default `progressDeadlineSeconds: 600` except where a lab seeds a shorter value (L10 = 45 s)                                                                                                                                                                                          | Realistic; a stalled rollout in another level can take 10 simulated minutes to report the deadline                                                |
| Low      | The PackageManifest catalog is a 4-package simulation (3D resource budget) and is re-seeded if deleted                                                                                                                                                                                                          | Deliberate; deployment/CSV/InstallPlan behaviour is modelled in full                                                                              |
| Low      | MetalLB speaker is a normal Pod (no hostNetwork/privileged) because the default SA has no SCC grant there; the operator/CR/pool/advertisement + EXTERNAL-IP wiring is what is exercised                                                                                                                         | Deliberate teaching simplification                                                                                                                |
| Low      | NetworkPolicy evaluation covers Pod-to-Pod traffic and (since 1.2.0) router/node traffic for Routes; hostNetwork edge cases and egress ipBlock semantics are simplified                                                                                                                                         | Deliberate scope; documents the exam-relevant behaviour                                                                                           |
| Low      | The monitoring stack is a data simulation: rules/Alertmanager objects, matching pod/service/route and live alert evaluation are modelled, but Prometheus itself is not run                                                                                                                                      | Deliberate (no container runtime); EX280 inspection commands are exercised end-to-end                                                             |
| Low      | GitHub stars badge shows `0`/`--` when `api.github.com` is offline or rate-limited (HTTP 403)                                                                                                                                                                                                                   | Cosmetic only; the optional fetch fails silently                                                                                                  |
| Low      | Headless SwiftShader renders at low FPS, so the browser harness uses `engine.setTimeScale(4)` during controller waits; production remains 1×                                                                                                                                                                    | Test-harness accommodation                                                                                                                        |
| Low      | One EX280 bullet (`manage-certified-technologist`) links to the official exam page rather than a 4.22 chapter docs page                                                                                                                                                                                         | Accepted by the static verifier; all bullets remain mapped                                                                                        |
| Low      | The new password-rotation objective's `requireLogin` evidence cache is lazily created when the rotated hash first verifies; an extremely fast pasted command sequence can capture the login baseline after the login (real learners are unaffected)                                                             | Documented edge; browser acceptance uses realistic pacing; the core hash/rollout state grading is exact                                           |
| Info     | The `visual-qa` harness reports informational heuristic warnings (tightly packed/small elements); `--strict` fails only on check failures                                                                                                                                                                       | Triaged as non-blocking; 0 failures in the final run                                                                                              |
| Info     | Contributors need `npm install` for the dev-only Prettier/Knip/husky gate; playing, serving and deploying the game need neither the toolchain nor a build step                                                                                                                                                  | Dev-only by design; the husky hook prints the `npm install` instruction when the directory is missing                                             |
| Info     | CDN dependencies (Three.js/Tailwind/fonts) and WebGL are required; no backend/real cluster by design                                                                                                                                                                                                            | Consistent with CONVERSION-SPEC non-goals                                                                                                         |
| Info     | Incident-managed Pods (annotation `openshiftgames.io/incident`) are managed by the incident engine rather than the generic Pod lifecycle                                                                                                                                                                        | Required by the incident scenarios                                                                                                                |

---

## 7. Release recommendation

**GO.** The definition-of-done verification gates pass on the release tree:

- static verifier: **942 checks, 0 failures, 0 warnings** (55 JS modules,
  117 files);
- full browser suite: **1220 checks, 0 failures, 0 warnings**, 0 console/page errors;
- visual QA: **96 checks, 0 failures**, `--strict` PASS (pre-existing informational
  heuristics only);
- dev tooling gate: `npx prettier --check .` **0** unformatted files and `npx knip` **0** issues,
  enforced by the husky pre-commit hook; `scripts/verify.mjs` enforces the dev-only contract;
- every GitHub issue (#1–#36) and the incidents-drawer overlap UX bug has targeted headless
  coverage that passes, in addition to the full-suite coverage;
- all required screenshots and both hero/OG artifacts regenerated at the required dimensions;
- content accuracy and EX280V422 coverage validated against the research ground truth;
- no game-code changes by the verifier and no runtime dependency/build-step changes.

The remaining items are low-severity/known simulator limitations, not release blockers.

---

## 8. Reproduce

```bash
# Dev tooling gate (optional to play; dev-only, no runtime dependencies)
npm install
npm run lint                  # npx prettier --check . + npx knip

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
