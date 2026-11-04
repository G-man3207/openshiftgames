# Verification report — OpenShift Games (OCP 4.22 / EX280V422)

**Date:** 2026-11-04 (UTC)
**Verified tree:** `main` @ the 1.3.0 release commit (this report is committed with it) in
https://github.com/G-man3207/openshiftgames
**Target:** Red Hat OpenShift Container Platform **4.22** · **EX280V422**
**Canonical URL:** `https://shifting.pro` (current spec/README/index; `og:url`/`og:image` + `/draw`)
**Verdict:** **GO for release** — 0 failures in static verification (958 checks), 0 failures
in the full browser suite (1399 checks), visual QA PASS (96 checks, 0 failures), a
clean Prettier/Knip gate, and per-issue headless coverage for every GitHub issue #1–#43.

Release 1.1.5 closed the original QA report (#1–#14): RBAC enforcement, 4.x identity/SCC models,
real `oc`/`helm` fidelity, the OLM flow, timed-lab/capstone fixes and the incidents-drawer layout.
Release 1.1.6 closed the QA **retest** report (#15–#21): image-pull vs. crash-looping lab state,
real container naming, rollout-status race/`--timeout`, OLM catalog fidelity, the remaining CLI
gaps, the restricted-v2 `nginx:latest` trap, the capstone incident gate, stricter readiness
evidence and the HUD paused indicator. Release 1.1.7 closed the third QA pass (#22–#26): the
timed-lab 02 soft-lock, lab-02 diagnostics fidelity, Helm 3 history/rollback semantics, the
corrected restricted-v2 `nginx` runtime model, the remaining CLI leftovers and the dev-only
Prettier/Knip/husky toolchain. Release 1.2.0 closed the fourth QA pass (#27–#36): incident
self-healing, CLI node troubleshooting, namespace-safe destructive verbs, workstation shell
content, service-ca/router networking, real project defaults, state-based grading, monitoring and
alerting, templates and the 13th timed lab.

**Release 1.3.0 closes the fifth QA pass (#37–#43)** — every open issue on the tracker: the
capstone now grades ResourceQuota/LimitRange/default-deny on project state instead of hidden names,
`tls.externalCertificate` Routes get the real 4.22 admission gate (Secret + router RBAC), NotReady
nodes receive real taints instead of a fake cordon, Pods mount the service-account token volume,
`oc login` prompts for the kubeadmin password (discoverable via `~/auth/kubeadmin-password`),
`oc get -l` honours real label-selector semantics, the collected CLI-output differences are fixed,
lab 6 stops teaching the non-existent `oc create limitrange`, and the post-campaign handover is
honest about what a Developer Sandbox can do.

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
| Full browser run | 1399 checks in 682 s — see `docs/verification-report.json` → `environment.durationSeconds`                   |

Commands actually run to completion on the release tree:

```bash
npm install                 # dev-only toolchain (optional to play; the game has no runtime deps)
npm run lint                # prettier --check . + knip — the same gate the husky hook runs
node scripts/verify.mjs --verbose
node scripts/browser-test.mjs
node scripts/visual-qa.mjs --strict
```

Individual browser areas can be re-run with
`node scripts/browser-test.mjs --only=menu,sandbox,cli,files,ui,campaign,challenges,exam,draw,responsive,regressions,shots,qa-incidents,qa-scenarios,qa-cli,qa-workstation,qa-openshift,qa-grading,qa-coverage,qa-issue37,qa-issue38-41,qa-issue39-40,qa-issue42,qa-issue42-evidence,qa-issue43`.
The browser script writes `docs/verification-report.json` on every run.

The 1.3.0 acceptance coverage for issues #37–#43 lives permanently in `scripts/browser-test.mjs`
in six dedicated sections (`qa-issue37`, `qa-issue38-41`, `qa-issue39-40`, `qa-issue42`,
`qa-issue42-evidence`, `qa-issue43`), alongside the 1.2.0 sections (`qa-incidents`, `qa-scenarios`,
`qa-cli`, `qa-workstation`, `qa-openshift`, `qa-grading`, `qa-coverage`) and the expanded
`cli`/`campaign`/`challenges` regressions. The out-of-repo repro suites from the fix workstreams
remain under `/tmp/qa-1.3/` (`cli-core`, `shell-tools`, `engine`, `state`, `content`,
`qa-integration`).

---

## 2. Static verification — `node scripts/verify.mjs`

```
Files checked: 55 JS modules, 117 total files
Checks passed: 958 · failures: 0 · warnings: 0
```

| Area                      | What was checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Result |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Syntax                    | Every `js/**/*.js` module and both inline HTML modules parse as ES modules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | PASS   |
| Import graph              | Every relative import target exists; every named import resolves against a static export scan (JS + `index.html`/`draw.html` inline modules + dynamic optional-panel imports)                                                                                                                                                                                                                                                                                                                                                                                                   | PASS   |
| Kind registry             | 49 kinds; apiVersion/scope/palette/aliases/columns/defaultSpec/minimap metadata; every kind has a mesh creator (49/49); `PALETTE_SECTIONS` covers the same 37 placeable kinds exactly once; monitoring kinds `PrometheusRule`/`Alertmanager` (non-placeable, mesh-backed); palette runtime-generated in both shells                                                                                                                                                                                                                                                             | PASS   |
| API versions              | Exact 4.22 map for all kinds incl. Route `route.openshift.io/v1`, BuildConfig/Build `build.openshift.io/v1`, ImageStream `image.openshift.io/v1`, Template `template.openshift.io/v1`, SCC `security.openshift.io/v1`, Project `project.openshift.io/v1`, ClusterResourceQuota `quota.openshift.io/v1`, User/Group/Identity `user.openshift.io/v1`, Subscription/OperatorGroup/InstallPlan/CSV, PackageManifest, MetalLB, monitoring `monitoring.coreos.com/v1`, OAuth/ClusterOperator/ClusterVersion                                                                           | PASS   |
| Seeded OpenShift baseline | 10 default Projects, 13 ClusterOperators (4.22.0), ClusterVersion `version` (`stable-4.22`), the 14 default SCCs, users kubeadmin/admin + cluster-admin binding, real `self-provisioners` CRB, ImageStreams, the 4-package OLM catalog + `global-operators`, project bootstrap (builder/default/deployer SAs, admin + image-puller/builder/deployer RoleBindings, dockercfg Secrets), oauth-openshift pods, monitoring rules + Alertmanager, **99 seeded resources incl. `kube-root-ca.crt` and `openshift-service-ca.crt` in every namespace**; `addResource` UID preservation | PASS   |
| Campaign                  | 20 levels / 5 chapters with spec titles; every level has `examObjectives`, 4.22 `docsLinks`, objectives, starting/available resources, 3+ hints, starCriteria; objective kinds/incidents/manifests exist; new objectives (password, identity, installPlan, subscription, routeAccess, networkPolicy, oauthProvider) implemented in the evaluator; **L20 grades quota/LimitRange/default-deny on `prod-platform` state (no hidden names) and its router-ingress objective sets `requireIsolation`**; tutorial targets valid; no kubectl/`oc export` copy                         | PASS   |
| Challenges                | **13** timed labs with exact spec titles/IDs, 180–420 s limits, objectives, starting/available resources, hints, valid preload incidents; lab 13 "Production Network Policies" ships a starter-only default-deny file and four behaviour-graded objectives; **lab 6 teaches `oc apply -f examples/limitrange.yaml` and its command objective cannot match the non-existent `oc create limitrange`**; `ChallengeMode.startChallenge/getStatus` present                                                                                                                           | PASS   |
| Incidents                 | 36 definitions; all required names present; 2+ investigation steps and resolution actions; suggested commands resolve to real Pods/Deployments; `ocCommands` only `oc`; corrected Job/quota scenarios (dedicated L19 broken Job, no phantom quota pod); **L3/L20 CrashLoop seeds carry only the invalid `APP_MODE` env with a neutral image**                                                                                                                                                                                                                                   | PASS   |
| EX280V422 coverage        | 9 official groups / **55 official bullets**, titles/order/count distribution match `docs/research/exam-facts.json`; every bullet has a docs link and at least one level/challenge mapping; **Job/CronJob and SCC bullets declare `objectiveTypes` so completed drills evidence them**; 10 quick labs (incl. serving-cert → reencrypt Route and HTPasswd rotation); 10 cheat-sheet groups; readiness threshold 0.9; exam facts EX280V422 / 4.22 / 3 h present                                                                                                                    | PASS   |
| Scoring / achievements    | `getExamPrepProgress()` / `markExamPrep()` and progress store; per-bullet evidence collection (command + objective evidence); all required stat keys; 44 OpenShift-themed achievements (challenge-veteran now 13 labs); referenced stats exist                                                                                                                                                                                                                                                                                                                                  | PASS   |
| QA regression invariants  | Static locks for the 1.3.0 fixes: L20 state objective shapes + `requireIsolation`; no shipped hint teaches `oc create limitrange` and lab 6 teaches the YAML flow; `examples/route-external-cert-rbac.yaml` ships and is wired into L20; handover documents OpenShift Local/crc (`crc console --credentials`) and the Sandbox project scope; L17 copy matches the shipped `priv-sa`; crash seeds inject only `APP_MODE`; kubeadmin password discovery and evidence contracts present                                                                                            | PASS   |
| Branding / independence   | No legacy branding outside the delimited attribution; kubectl only in alias/education context (the standard `kubectl.kubernetes.io/*` annotation key is explicitly allowed as a real Kubernetes key, not player copy); pinned Three.js 0.152 / Tailwind 3.4.1                                                                                                                                                                                                                                                                                                                   | PASS   |
| Required files / README   | LICENSE, NOTICE, README, index/draw, style, vercel/robots, og source; README GitHub wiki links; README EX280 coverage table (9 groups, 13 timed labs); credits/attribution; Apache-2.0; run/deploy/Vercel instructions; canonical `shifting.pro`                                                                                                                                                                                                                                                                                                                                | PASS   |
| Dev tooling contract      | Private `package.json` 1.3.0 + devDependencies exactly prettier/knip/husky; no runtime deps or bundler config; `scripts/knip-entrypoints.mjs` mirrors every inline HTML import (incl. EX280Objectives for the handover) and `verify.mjs` enforces it; pre-commit hook runs both gates                                                                                                                                                                                                                                                                                           | PASS   |
| Declarative engine        | `YamlParser.selfTest()`; **27** default manifest files parse (incl. operator Subscription variants, allow-from-router policy, kustomize v5 examples and the new `examples/route-external-cert-rbac.yaml`); apply `-f`, apply `-k` prod overlay, processTemplate + apply, Helm install/list/uninstall, htpasswd add/verify/delete verified via imports with a real `GameEngine`; kustomize `labels:`/`patches:`/`commonLabels` semantics verified                                                                                                                                | PASS   |
| CommandBar / UI wiring    | `executeCommand` + RBAC authorization gate; dispatch paths for every command family incl. the shell layer; `oc debug node` session, interactive `oc login` password prompt, label-selector engine, multi-type `get` name prefixes, `ShellTools.runExecCurl` delegation, `_rowCells` monitoring printers, completed-pod/CrashLoop exec guards; index/draw element IDs and `window.game` wiring; handover overlay wiring                                                                                                                                                          | PASS   |

Accepted notes (not failures): two new non-spec monitoring kinds are expected additions (registered
in the expected catalog); one cross-cutting EX280 bullet links to the official exam page rather than
a 4.22 chapter; the index footer's required upstream attribution link is explicitly allowed by
CONVERSION-SPEC §1.

---

## 3. Browser E2E — `node scripts/browser-test.mjs`

```
Browser tests: 1399 passed, 0 failed, 0 warnings
Console/page errors: 0 / 0
Verdict: GO
```

| Area                          | Checks | Failures | What was exercised                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -----: | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu                          |     22 |        0 | exact title/meta/OG/twitter/importmap; branding; 4 mode buttons; EX280 Prep; `/draw`; attribution; Settings/Achievements/Stats modals                                                                                                                                                                                                                                                                                                                                                             |
| Responsive                    |      7 |        0 | 1280x720 menu + sandbox (no horizontal overflow, palette/HUD/toolbar visible); restored 1600x900                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tutorial                      |     17 |        0 | level-start help modal, coach-card sequencing, viewport bounds, H help key, clock pause/resume arbitration, skip clears marks                                                                                                                                                                                                                                                                                                                                                                     |
| EX280 Prep                    |     19 |        0 | overlay; 9 groups / 55 bullets; 4 tabs; 10 quick labs; 10 cheat groups; copy buttons; search; readiness bar; exam facts; quick-lab launch                                                                                                                                                                                                                                                                                                                                                         |
| Sandbox                       |     25 |        0 | deep link; seeded resources ↔ meshes (incl. monitoring + CA-ConfigMap baseline); 37 palette kinds; projects/COs/Nodes/SCCs/ImageStreams; HUD; toolbar; WebGL ok                                                                                                                                                                                                                                                                                                                                   |
| Files panel                   |     26 |        0 | `#btn-manifests`; file tree (incl. `auth/kubeadmin-password`); editor + Save/Apply -f/Apply -k; kustomize v5 base/prod overlays apply with correct labels/selectors; recorded apply                                                                                                                                                                                                                                                                                                               |
| CLI / `oc`                    |    218 |        0 | session, projects, get/describe/output fidelity, write-verb namespace safety, apply/create idempotency, Routes/TLS, set env/image/resources/volume, helm, new-app, users/groups, `adm policy`/`auth can-i`, quotas/limits/CRQ, OLM, jobs/cronjobs, cordon/uncordon, HTPasswd+OAuth, RBAC Forbidden, dry-run, rollout, label selectors, login prompt, shell commands and the 1.2.0 workstation tools                                                                                               |
| UI surfaces                   |     29 |        0 | inspector/4 tabs/YAML/describe; context menu; metrics; settings; keyboard; EX280 Prep pause; deployment status labels                                                                                                                                                                                                                                                                                                                                                                             |
| Campaign                      |    147 |        0 | levels 1–20 start with exact titles, objective progress/panel/status; level 1 completion flow; L3/L20 incident gates; L20 node recovery + router-ingress objectives; state-graded capstone objectives                                                                                                                                                                                                                                                                                             |
| Challenges                    |    114 |        0 | timed labs 1–13 start, objective panels/status; footer/clock behaviour; lab 2/6/8/9/11/13 end-to-end (including behaviour-graded network policies and the lab-6 YAML LimitRange flow); countdown freeze/resume                                                                                                                                                                                                                                                                                    |
| Follow-up                     |     26 |        0 | project-template flow, HTPasswd rotation, role `--verb/--resource` flags → `auth can-i`, dry-run YAML pipelines                                                                                                                                                                                                                                                                                                                                                                                   |
| Regressions                   |     22 |        0 | minimap first-click collapse; restart/next-level layout fidelity; single incident panel after relaunch; drawer clears mission card/view toolbar; Esc cleanup                                                                                                                                                                                                                                                                                                                                      |
| QA #27/#28 (`qa-incidents`)   |     92 |        0 | L17 SCCForbidden self-heals from state CLI-only (13); L15 quota heals from state CLI-only (19); lab 8 fix-before-trigger (9); lab 6 quota heals from state (11); L20 NodeNotReady recovered via `oc debug`/`systemctl restart kubelet` (25, incl. #43 taints/no-cordon); L3 CrashLoop seed/fix contract (9); repaired Job never force-completed (6)                                                                                                                                               |
| QA #31 (`qa-scenarios`)       |     68 |        0 | seeded L3/L20 CrashLoop APP_MODE cause; L19 dedicated broken Job + real job logs/status; Job/Pod status Completed; lab 1 mysql crash loop + 3306; lab 12 compute-quota-without-LimitRange; L15 truthful quota/RS event model                                                                                                                                                                                                                                                                      |
| QA #29/#36 (`qa-cli`)         |     77 |        0 | namespace-exact write verbs; AlreadyExists; apply unchanged; delete -l; describe-all; `ls` semantics; silent redirects; dry-run `-o name`; uid/timestamps; kustomize output/selectors; `-o wide`/endpoints/istag/build/route/service/jsonpath/quota/cronjob/events/rollout output fidelity                                                                                                                                                                                                        |
| QA #32/#33 (`qa-workstation`) |    114 |        0 | base64/openssl req+x509/secret tls/cut; exec/rsh volumes+env+crashloop guards; workstation curl edge/passthrough/reencrypt + redirect + DNS + `-k`; service-ca serving cert + cabundle; L20 default-deny → curl 503 → allow-from-router → 200 + routeAccess objective                                                                                                                                                                                                                             |
| QA #35 (`qa-openshift`)       |     51 |        0 | default SAs/RoleBindings/dockercfg; requester annotation on the namespace; `who-can use scc` + `scc-subject-review -f`; 4.x `add-scc-to-user`; `add-role-to-group` naming; OAuth pods/rollout; `set env --from`; `start-build --follow`; ns `--show-labels`/CRQ selector; `run --overrides`; login password validation + prompt                                                                                                                                                                   |
| QA #30 (`qa-grading`)         |     38 |        0 | lab 9 hand-written NetworkPolicy set 6/6 behaviour; lab 11 heredoc/patch/apply OAuth state; login latch across user switches; User only after first login; L2 wrong-namespace label never ticks                                                                                                                                                                                                                                                                                                   |
| QA #34 (`qa-coverage`)        |     91 |        0 | standard templates; alerting model; post-campaign handover + checklist persistence (7 items); kustomize v5; L13 password rotation + delete User/Identity; lab 13 Production Network Policies; L18 AllNamespaces/Manual/startingCSV; lab 10 variants; L1 intro trap-free                                                                                                                                                                                                                           |
| QA #37 (`qa-issue37`)         |     20 |        0 | L20 state-graded ResourceQuota/LimitRange/default-deny with custom names; `routeAccess` pending before isolation and while the router is blocked, ticks after a router-allow; legacy `routeAccess` compatibility                                                                                                                                                                                                                                                                                  |
| QA #38/#41 (`qa-issue38-41`)  |     23 |        0 | `oc create limitrange` rejection + subcommand list + creates nothing; YAML LimitRange flow; lab 6 hint/pattern + CLI-only completion; key-only/`!key`/`in`/`notin`/equality selectors; only `openshift-ingress` has the ingress policy-group labels; engine LabelSelector semantics                                                                                                                                                                                                               |
| QA #39/#40 (`qa-issue39-40`)  |     28 |        0 | externalCertificate Route `ExternalCertificateValidationFailed` (secret-not-found + router-SA permission) → rejected with Secret only → Admitted after shipped RBAC; handover DOM shows OpenShift Local/crc (`crc console --credentials`), project-scoped-only Sandbox, L13/L14/L17 cluster-admin notes, 7 items 0/7                                                                                                                                                                              |
| QA #42 (`qa-issue42`)         |     44 |        0 | new-build/new-app ImageStream output; serial `start-build` queue X-2 (phase New, no start timestamp, never two Running, FIFO) + `--follow`; exec/rsh SA token files; `~/auth/kubeadmin-password` == `ClusterState.KUBEADMIN_PASSWORD` + extract path; login prompt (wrong→401, cancel, typed password, `-p` unchanged); neutral-image/APP_MODE-only crash log; L17 copy                                                                                                                           |
| QA #42 evidence               |      7 |        0 | gated-bypass L20→Job/CronJob and L17→SCC bullet evidence from completed objectives; objective-evidence-only path; incomplete L20 does NOT evidence; L1/L13 password-discovery copy                                                                                                                                                                                                                                                                                                                |
| QA #43 (`qa-issue43`)         |     54 |        0 | multi-type get prefixes/empty-type omission/single "No resources found"; secrets sorted; events `(xN over …)`; describe quota no Events; rollout wording; set env --all --list; quota FailedCreate once + `limited: pods=1`; project CA ConfigMaps + annotations; requester on Namespace; 10-char RS hash/5-char pod suffix; new-app `deployment=`; describe-node 5-column conditions; chroot/journalctl; curl `-w`/443/(28); openssl; Simulator hint; NotReady taints without SchedulingDisabled |
| Draw                          |     10 |        0 | `/draw` title/palette 37 unique kinds; watermark; YAML export API versions                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Screenshots                   |     10 |        0 | all required captures + final hero/OG dimensions verified                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## 3b. QA-pass verification (#37–#43)

A fifth full QA playthrough of the 1.2.0 build (CLI-first, L1–L20 plus all timed labs) reported
seven issues (#37–#43). Every item was reproduced, fixed and is covered by a durable regression
section; the tree keeps the full per-issue evidence permanently in `scripts/browser-test.mjs`.

| Issue                                                                                                                                                                                | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **#37** P2 — L20 grades quota/LimitRange/default-deny on hidden names; router-reach objective ticks before isolation exists                                                          | L20 objectives are state-based (`quota`, `limitRange`, `networkPolicy` probe `ingress-isolation` — any matching object in `prod-platform`); `routeAccess` gained an opt-in `requireIsolation` gate requiring ingress isolation + a router-allow policy + end-to-end reach; other routeAccess users keep legacy semantics                                                                                                                                                                    | `qa-issue37` (20 checks); `campaign` L20 regressions; `verify.mjs` static lock                                                              |
| **#38** P2 — lab 6 hint teaches `oc create limitrange`, which does not exist (simulator accepted it)                                                                                 | The simulator rejects `oc create limitrange` with real oc's unknown-subcommand error and subcommand list; lab 6 hint/flow use `oc apply -f examples/limitrange.yaml`; the objective no longer credits the fake command                                                                                                                                                                                                                                                                      | `qa-issue38-41` (23 checks); fixed `cli` regression; `verify.mjs` hint scan                                                                 |
| **#39** P2 — externalCertificate Route is Admitted although the Secret and router RBAC are missing                                                                                   | Real 4.22 gate: `Admitted=False` reason `ExternalCertificateValidationFailed` (real aggregate message) until the `kubernetes.io/tls` Secret exists AND `system:serviceaccount:openshift-ingress:router` has get/list/watch (Role `resourceNames` + RoleBinding); then `Admitted=True`; dynamic re-rejection; new `examples/route-external-cert-rbac.yaml`; hints teach the order                                                                                                            | `qa-issue39-40` (28 checks); fixer repros (engine 33/33, content 23/23)                                                                     |
| **#40** P2 — handover suggests the Developer Sandbox for L13/L14/L17, which need cluster-admin                                                                                       | Handover copy/links send the full checklist to OpenShift Local (crc)/SNO (`crc start`, `crc console --credentials`), mark the Sandbox project-scoped only (L1–L11-style work), and flag L13/L14/L17 as cluster-admin work (not Sandbox)                                                                                                                                                                                                                                                     | `qa-issue39-40` (28 checks, real DOM); fixer repro 13/13                                                                                    |
| **#41** P2 — `oc get ns -l policy-group…` ignores the selector and shows no policy-group labels                                                                                      | Real LabelSelector engine for `oc get -l` (key-only existence, `!key`, `in`, `notin`, `=`, `!=`) and `--show-labels`; `openshift-ingress` carries the real ingress policy-group labels; every namespace gets `kubernetes.io/metadata.name`; NetworkPolicy `namespaceSelector` real semantics; `allow-from-router` works end to end                                                                                                                                                          | `qa-issue38-41` (23 checks); fixer repros (CLI 81/81, state 62/62 + router 13/13)                                                           |
| **#42** P3 — start-build queue/--follow, no SA token in Pods, CrashLoop log blames the image, undiscoverable kubeadmin password, readiness evidence on gated runs, L17 text mismatch | Serial runPolicy queues `X-2` (New) and starts FIFO; `--follow` streams queued builds; `new-build`/`new-app --image` create+print the ImageStream; every Pod mounts the projected SA volume/token files; crash log names only `APP_MODE`; `oc login` prompts and `~/auth/kubeadmin-password` + `oc extract secret/kubeadmin` make the password discoverable (L1/L13/EX280 copy); readiness evidence accepts state-derived objective evidence; L17 copy matches shipped `priv-sa`            | `qa-issue42` (44) + `qa-issue42-evidence` (7); fixer repros (CLI 81/81, campaign-login 11/11, engine 180/180, content 122/122, shell 56/56) |
| **#43** P4 — collected CLI output differences (get prefixes/sorting/hashes, curl, node taints/conditions, quota/events, project CAs, annotations, openssl, rollout/set env, hints)   | All 20 report bullets fixed: multi-type get prefixes + empty-type omission; real 10-char hash + 5-char pod suffix; secrets sorted; curl `-w`/scheme ports/`(28)` vs `(7)`; NotReady taints (no cordon) + condition columns; quota `limited: pods=1`, one FailedCreate, event aggregation, no describe-quota Events; CA ConfigMaps; requester on Namespace; new-app `deployment=` label; openssl enddate/subject; rollout wording; `set env --all --list`; Simulator hint; journalctl/chroot | `qa-issue43` (54 checks); fixed `cli`/`qa-openshift` regressions; fixer repros (CLI 81/81, shell 56/56, engine 180/180, state 62/62)        |

Shared gates for this pass (run on the release tree): `node scripts/verify.mjs --verbose`
**958/0** (0 warnings); full browser suite **1399/0** (0 warnings, 0 console/page errors, GO,
682 s); `node scripts/visual-qa.mjs --strict` **PASS** (96 checks, 0 failures, 22 pre-existing
informational heuristics); `npx prettier --check .` **0** unformatted files and `npx knip`
**0** issues.

---

## 4. Screenshots and artifacts

Generated/validated in the final run (all 1600×900 unless noted):

| File                                                                                                  | Purpose                                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`screenshot.png`](../screenshot.png)                                                                 | README hero gameplay (Sandbox, seeded cluster)                   |
| [`docs/screenshots/menu.png`](screenshots/menu.png)                                                   | main menu/branding                                               |
| [`docs/screenshots/sandbox.png`](screenshots/sandbox.png)                                             | seeded Sandbox with HUD/palette (incl. alerting + CA objects)    |
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
  L2Advertisement; service-ca serving certificates; router-ingress NetworkPolicy; Route
  `tls.externalCertificate` admission with router RBAC; kubeadmin password in
  `kube-system/kubeadmin` + installer `auth/kubeadmin-password`; Kubernetes root-CA publishing
  (`kube-root-ca.crt`) and service-ca (`openshift-service-ca.crt`) ConfigMaps; projected
  service-account token volume; interactive `oc login` password prompt; real LabelSelector
  semantics for `oc get -l`; quota messages with keyed quantities
  (`requested: pods=1, used: pods=1, limited: pods=1`); Node conditions with
  LASTHEARTBEATTIME/LASTTRANSITIONTIME and unreachable/not-ready taints instead of a cordon.
- **Observed command semantics:** namespace-exact write verbs; `AlreadyExists` vs `apply` unchanged;
  `oc debug node` kubelet troubleshooting; real `oc get/describe` column/output fidelity; RBAC
  Forbidden paths; dry-run; JSONPath escaping; `oc set env --from` per-key refs; `oc start-build
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
- **Content corrections in 1.3.0:** L20 state-based grading + router-isolation gate; lab 6 YAML
  LimitRange; externalCertificate Secret → router RBAC → Route order (+ new RBAC example manifest);
  handover crc/SNO vs Sandbox scope; L17 text vs shipped `priv-sa`; kubeadmin password discovery
  (`~/auth/kubeadmin-password`, `oc extract`, prompt) in L1/L13/EX280 copy; Job/CronJob/SCC
  evidence links; neutral crash images with `APP_MODE`-only causes; `oc create limitrange` removed
  from README/CONVERSION-SPEC and the simulator.
- **Unverified/unpublished claims:** passing score, score scale and certification validity are not
  published by Red Hat and are not stated in game copy (research flags them UNVERIFIED).

---

## 6. Known limitations (residual, non-blocking)

| Severity | Issue                                                                                                                                                                                                                                                                                                                                  | Impact / disposition                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low      | `oc rollout status` prints the blocking waiting line immediately and appends the final/deadline/timeout line asynchronously; the blocking semantics of real `oc` are approximated for a browser shell                                                                                                                                  | Documented simulator mapping; exact progress-deadline and `--timeout` errors are shown, L10 and the round-2 race repros verify them               |
| Low      | Image pullability is a simulator heuristic: internal registry references resolve ImageStreamTags; external images use failure tokens matched anywhere in the tag and known-good tags keep pulling/recovering                                                                                                                           | Deliberate (no external registry knowledge); L10 and timed lab 02 use explicit good/bad tags, `:v9-nope` → `:latest` recovery is browser-verified |
| Low      | Known root-image security personas are runtime, not admission: only `nginx` and `mysql-80` are modelled as canonical root images, admitted by a non-root SCC and then crash-looping; other root images stay admitted unless the Pod spec requests `runAsUser: 0`/privileged                                                            | Deliberate teaching scope; the documented anyuid ServiceAccount fix path is browser-verified                                                      |
| Low      | `oc login` prompts for the password only for identities whose password the simulated cluster knows (kubeadmin, HTPasswd provider users); other simulator users (e.g. `admin`, users created by `oc create user`, group exercises) log in directly and the output carries a marked `Simulator hint:` explaining the real-cluster prompt | Deliberate training affordance; the kubeadmin prompt and `-p` paths are browser-verified, L13/RBAC flows stay playable                            |
| Low      | `oc set env --all KEY=VALUE` bulk mutation is not simulated (only the `--all --list` inspection form shipped in #43); the simulator returns an explicit "not simulated" error rather than silently doing nothing                                                                                                                       | Documented limitation; `--all --list` and per-deployment `set env` are browser-verified                                                           |
| Low      | `oc get events -o wide` prints the standard columns without the extra FIRST SEEN/COUNT/NAME columns of real `oc` (the aggregated `LAST SEEN (xN over …)` form matches real output)                                                                                                                                                     | Cosmetic fidelity gap outside the reported issue; the standard and jsonpath forms are exact                                                       |
| Low      | Only Routes with `spec.tls.externalCertificate` are gated on the Secret + router RBAC (inline/edge/passthrough TLS Routes and `oc create route edge` are unchanged); the router then serves the simulated Route without a TLS handshake against the external certificate material                                                      | Scope of #39 matches real 4.22 admission control; the admission/condition/describe contract is browser-verified                                   |
| Low      | A Subscription for an unknown package latches `ResolutionFailed` for the whole namespace/OperatorGroup (correct OLM semantics); editing it to a valid package retries resolution                                                                                                                                                       | Documented behaviour; install path verified end-to-end                                                                                            |
| Low      | `sim.getEvents()` returns both Normal and Warning resource events; the CLI de-duplicates them for `oc get events`                                                                                                                                                                                                                      | Harness-verified; no visible duplication                                                                                                          |
| Low      | Deployments keep the real default `progressDeadlineSeconds: 600` except where a lab seeds a shorter value (L10 = 45 s)                                                                                                                                                                                                                 | Realistic; a stalled rollout in another level can take 10 simulated minutes to report the deadline                                                |
| Low      | The PackageManifest catalog is a 4-package simulation (3D resource budget) and is re-seeded if deleted                                                                                                                                                                                                                                 | Deliberate; deployment/CSV/InstallPlan behaviour is modelled in full                                                                              |
| Low      | MetalLB speaker is a normal Pod (no hostNetwork/privileged) because the default SA has no SCC grant there; the operator/CR/pool/advertisement + EXTERNAL-IP wiring is what is exercised                                                                                                                                                | Deliberate teaching simplification                                                                                                                |
| Low      | NetworkPolicy evaluation covers Pod-to-Pod traffic and router/node traffic for Routes; hostNetwork edge cases and egress ipBlock semantics are simplified                                                                                                                                                                              | Deliberate scope; documents the exam-relevant behaviour                                                                                           |
| Low      | The monitoring stack is a data simulation: rules/Alertmanager objects, matching pod/service/route and live alert evaluation are modelled, but Prometheus itself is not run                                                                                                                                                             | Deliberate (no container runtime); EX280 inspection commands are exercised end-to-end                                                             |
| Low      | GitHub stars badge shows `0`/`--` when `api.github.com` is offline or rate-limited (HTTP 403)                                                                                                                                                                                                                                          | Cosmetic only; the optional fetch fails silently                                                                                                  |
| Low      | Headless SwiftShader renders at low FPS, so the browser harness uses `engine.setTimeScale(4)` during controller waits; production remains 1×                                                                                                                                                                                           | Test-harness accommodation                                                                                                                        |
| Low      | One EX280 bullet (`manage-certified-technologist`) links to the official exam page rather than a 4.22 chapter docs page                                                                                                                                                                                                                | Accepted by the static verifier; all bullets remain mapped                                                                                        |
| Low      | The password-rotation objective's `requireLogin` evidence cache is lazily created when the rotated hash first verifies; an extremely fast pasted command sequence can capture the login baseline after the login (real learners are unaffected)                                                                                        | Documented edge; browser acceptance uses realistic pacing; the core hash/rollout state grading is exact                                           |
| Low      | The new namespace CA ConfigMaps count toward `configmaps` ResourceQuota usage in every project (real 4.22 behaviour); no shipped level/challenge uses a `configmaps` quota                                                                                                                                                             | Matches real clusters; documented for future content                                                                                              |
| Info     | The `visual-qa` harness reports informational heuristic warnings (tightly packed/small elements); `--strict` fails only on check failures                                                                                                                                                                                              | Triaged as non-blocking; 0 failures in the final run (22 informational warnings)                                                                  |
| Info     | Contributors need `npm install` for the dev-only Prettier/Knip/husky gate; playing, serving and deploying the game need neither the toolchain nor a build step                                                                                                                                                                         | Dev-only by design; the husky hook prints the `npm install` instruction when the directory is missing                                             |
| Info     | CDN dependencies (Three.js/Tailwind/fonts) and WebGL are required; no backend/real cluster by design                                                                                                                                                                                                                                   | Consistent with CONVERSION-SPEC non-goals                                                                                                         |
| Info     | Incident-managed Pods (annotation `openshiftgames.io/incident`) are managed by the incident engine rather than the generic Pod lifecycle                                                                                                                                                                                               | Required by the incident scenarios                                                                                                                |

---

## 7. Release recommendation

**GO.** The definition-of-done verification gates pass on the release tree:

- static verifier: **958 checks, 0 failures, 0 warnings** (55 JS modules,
  117 files);
- full browser suite: **1399 checks, 0 failures, 0 warnings**, 0 console/page errors;
- visual QA: **96 checks, 0 failures**, `--strict` PASS (22 pre-existing informational
  heuristics only);
- dev tooling gate: `npx prettier --check .` **0** unformatted files and `npx knip` **0** issues,
  enforced by the husky pre-commit hook; `scripts/verify.mjs` enforces the dev-only contract;
- every GitHub issue (#1–#43) has targeted headless coverage that passes, in addition to the
  full-suite coverage;
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
