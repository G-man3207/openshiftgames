# Changelog

All notable changes to shifting.pro are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/).

## [1.16.2] — 2026-11-09

### Fixed

- **Chaos mode incident targets.** A random `CronJobMissedSchedule` with no CronJob or Job in the
  cluster bound the first platform Pod (`alertmanager-main-0` in `openshift-monitoring`). The
  Incidents panel then taught `oc get cronjob alertmanager-main-0`, onset damage never applied, and
  unsuspending that name could not resolve the incident. The same lookup bound `JobDeadlineExceeded`
  to that Pod. A random spawn now stays on an affected kind, and borrows a Pod only when the
  incident is about Pods; when nothing of the right kind exists the engine creates one (a suspended
  CronJob, or a Failed Job) that the taught command can repair. The version is bumped to 1.16.2
  (`package.json` and both import maps) because module URLs are versioned (`/v/<version>/js/…`,
  cached as immutable).

## [1.16.1] — 2026-11-09

### Fixed

- **`oc get bc` / `oc get builds` FROM column.** The column printed the builder image
  (`nodejs:20-ubi9`), including for a binary build. OpenShift 4.22's table printer
  (`describeSourceShort` in openshift-apiserver
  `pkg/build/printers/internalversion/printer.go`) prints the source: `Git`, `Git@<ref>`,
  `Git@<7-char commit>`, `Dockerfile`, `Dockerfile,Git`, `Binary`. A custom-strategy BuildConfig
  prints `CustomStrategy.From.Name` instead. A Git build records `spec.revision.git.commit` when it
  leaves `New`, so `oc get builds` shows `Git@<commit>` after the clone the way a real cluster does.
  The version is bumped to 1.16.1 (`package.json` and both import maps) because module URLs are
  versioned (`/v/<version>/js/…`, cached as immutable).

## [1.16.0] — 2026-11-08

Curriculum and correctness release. A review of the whole campaign found concepts used before they
were taught: the capstone required a default-deny NetworkPolicy that still admits the router and an
`oc debug node` → `chroot /host` → `systemctl restart kubelet` repair that no level taught, Level 12
installed the MetalLB operator through OLM six levels before the Operators level, Level 1 explained SCC
admission sixteen levels before SCCs, and the EX280 staple `--dry-run=client -o yaml > file` was never
taught. 1.16.0 adds two EX280 levels before the capstone (**Network Policies** and **Nodes & Cluster
Troubleshooting**), an optional seven-level **Linux & RHEL Foundations** prelude played on a simulated
RHEL 9 workstation, reworks Levels 11 and 12, fixes every open grading finding and the open simulator
fidelity findings, and closes the five checks that made the last full browser run NO-GO. Saved progress
keeps its meaning: level ids are stable save keys, campaign order comes from the chapter table and
display numbers are positional (the capstone keeps id 20 and is shown as Level 22). The game stays
no-build and dependency-free. The version is bumped to 1.16.0 (`package.json` and both import maps)
because module URLs are versioned (`/v/<version>/js/…`, cached as immutable).

### Added

- **Linux & RHEL Foundations prelude (chapter 0, levels 0.1–0.7).** Optional and never gating Level 1;
  a new player's "Start campaign" opens 0.1 and 0.7 hands over to Level 1. Seven short, realistic tasks
  on the lab workstation, each tied to OpenShift work: 0.1 The Shell & the Filesystem (organise an
  `~/ex280` workspace), 0.2 Read, Search & Pipe Text (pull ERROR lines, counts and failing Pods out of a
  saved `oc logs` file), 0.3 Edit Files & the Shell Environment (write and fix YAML, `sed`, heredocs,
  `KUBE_EDITOR`, `$(…)`, quoting, a script with a shebang), 0.4 Users, Permissions & SELinux (take back a
  root-owned `~/.kube/config`, `chmod 600`, `getenforce`, `restorecon`), 0.5 Processes, Services & Logs
  (kill a runaway process, read a failed httpd's journal, fix it, start ≠ enable, `chronyd`), 0.6
  Networking & the Firewall (routes, DNS for `*.apps`, a stale `/etc/hosts` entry that beats DNS,
  firewalld runtime vs `--permanent`) and 0.7 Packages & Containers (install the missing OpenShift CLI
  with `dnf`, rootless `podman`, logs, image digests with `skopeo`). Every objective is graded from workstation state and has an authored
  how-to that the browser suite replays. New achievement: **Linux Foundations**.
- **Simulated RHEL 9 workstation** (`js/engine/LinuxHost.js`, `js/ui/LinuxCommands.js`):
  `[student@workstation ~]$` on RHEL 9.6 with SELinux enforcing; a filesystem with modes, owners,
  SELinux contexts and symlinks (home and `/tmp` file contents stay in the Files-panel store, so
  `oc apply -f` and the panel see the same files), users/groups, processes, systemd units with a journal
  and config-validated failures (httpd/sshd, generic `failWhen` hooks), dnf/rpm, the network
  (`/etc/hosts` before DNS, lab DNS for the cluster names), firewalld runtime/permanent and rootless
  podman. About 110 commands with real RHEL output and exit codes, a shell cwd honoured by every command
  (including `oc apply -f` relative paths), globbing/brace expansion and real permission errors. Lab
  sudo is passwordless (the terminal cannot answer a password prompt). Level seeds (`levelDef.linuxHost`)
  are applied by `CampaignMode.seedLinuxHost()`; host-state objective types `file`, `service`,
  `process`, `package`, `firewall`, `container`, `selinux`, `linuxUser`, `cwd`, `env` and `ran`.
- **Level 20 — Network Policies** (id 21, project `netpol-lab`): trace Route → router → Service → Pod,
  deny all ingress, let the OpenShift router back in (`policy-group.network.openshift.io/ingress`),
  deny egress but keep DNS on 5353, reopen exactly frontend → backend on 8080, with guards that keep
  backend → frontend and frontend → internet blocked. Graded by real reachability, never by policy
  names; the OpenShift docs policies ship in the Files panel under `netpol/`.
- **Level 21 — Nodes & Cluster Troubleshooting** (id 22, project `node-lab`): `oc get nodes`,
  `oc adm top`, `oc describe node`, ClusterOperators/ClusterVersion, cordon → drain → uncordon, and a
  NodeNotReady incident fixed the real way (`oc debug node/worker-1` → `chroot /host` →
  `systemctl status kubelet` / `journalctl -u kubelet` → `systemctl restart kubelet`). New `node`
  objective type (ready / schedulable / drained / workloads available) with self-explaining notes.
- **Campaign structure with stable ids.** `js/data/CampaignLevels.js` exports the order, unlock, Continue
  and label helpers every launcher now uses (`CAMPAIGN_ORDER`, `EX280_ORDER`, `PRELUDE_ORDER`,
  `isLevelUnlocked`, `continueLevelId`, `levelLabel`, …): a level unlocks when the previous level of its
  own track is completed or it was completed before (an inserted level never re-locks finished work), and
  "Continue" follows the track the player worked in most recently. The level select, start page, EX280
  Prep chips, HUD, pause and intro cards, scoring, achievements and the post-campaign handover use them
  instead of `id - 1`.
- **Level 4** now teaches `oc create … --dry-run=client -o yaml > manifests/api.yaml` and applying the
  generated manifest.
- **Tests.** New browser sections `qa-campaign-structure`, `qa-linux-shell`, `qa-linux-levels`,
  `qa-bridge-levels`, `qa-grading-1160` and `qa-sim-1160`; new static blocks §4l (Linux workstation),
  §4m (grading), §4n (simulator), §5L (prelude levels) and §5B (bridge levels) in `scripts/verify.mjs`,
  whose campaign checks were rewritten for the new structure (order, labels, unlock and Continue rules,
  no `id - 1` unlocking left). `REPLAY_LEVELS=<ids>` limits the guidance replay while authoring; the
  replay now lets 2 game-seconds pass before a level's first command (a first command could race the
  seeded Deployment's first ReplicaSet on a loaded host) and loads the app before a targeted run; two
  `qa-issue43` expectations now include the real `command terminated with exit code 28` line.

### Changed

- **Level 12** configures a MetalLB operator the platform team already installed (its OperatorGroup and
  Subscription are seeded; the player verifies the CSV, then creates the MetalLB/IPAddressPool/
  L2Advertisement operand, a LoadBalancer Service with `oc expose deployment … --type=LoadBalancer` and the
  passthrough Route). Level 18 remains where OLM installs are taught.
- **Level 11**: the openssl certificate and the `web-tls` Secret come first, and the edge Route must serve
  that certificate (`oc create route edge web --service=web --cert=tls.crt --key=tls.key`).
- **Curriculum order fixes:** SCC admission details (`restricted-v2`, `runAsUser: 0`) moved from L1/L3 to
  L17 (L1/L3 keep the plain "root-expecting images crash" lesson); L8 explains the Service and Route its
  template creates; L13 introduces `oc create user`; L14 explains `-z default`; L15's project-template
  guardrail is a LimitRange (NetworkPolicies come later).
- **EX280 mapping:** ids 21/22 added to their bullets, `ops-install` is Level 18 only, L3 is off
  "Troubleshoot software defined networking" and L8 off "Configure project templates"; the cheat sheet
  gained a Network policies group and node-maintenance commands.
- **Mission card:** objective labels render `code`, and Linux commands in hints and how-tos become
  "put in terminal" chips like `oc` commands. Prelude level numbers render as pills.
- **Achievements and stats** derive their totals from the level data ("Campaign Graduate" counts the 22
  EX280 levels, "Star Master" all campaign stars, chapters exclude the optional prelude).
- `CampaignMode` only gives seeded application objects the default `app=<name>` label (a Node showed
  `app=worker-0`).

### Fixed

- **Grading follows state everywhere** (every item from `docs/guidance-qa-findings.md` "Open — grading"):
  - L9/L20 and labs 5/12: "Build … Complete" ticked when a Build was created (the BuildConfig counter);
    now only a Build of that BuildConfig in phase Complete counts.
  - Read-command objectives (L2, L3, L4, L9, L18, lab 2) matched typed text and ticked on empty output
    or in the wrong project; an `inspect` read now counts only if it succeeded, ran in the lab project
    (or `-A`) and printed something. The terminal records each command's output and project, and global
    flags before the verb (`oc -n x get is`) match.
  - L3: the Incidents panel had its own pre-execution matcher (failures counted); one matcher in
    IncidentEngine now feeds the engine and the panel.
  - L10: one `oc rollout undo` ticked update and rollback, and availability could never turn red; both
    now read the Deployment's ReplicaSet history and availability is the api-server's own replicas.
  - L11/lab 3 accepted any Secret named `web-tls` (now `kubernetes.io/tls`); the L12 Route port is checked.
  - L13/lab 11: the `htpasswd` pattern matched the Secret command, and `oc create user` counted as a
    login (a User now needs the Identity a real login creates).
  - L14/L16/lab 11: any RoleBinding counted; it must grant the right role to the right subject.
  - L15 objective 8 graded the typed `oc edit`; a new `projectRequestTemplate` type reads the config.
  - L17/lab 8: a project-wide group SCC grant counted as "dedicated"; a grant that also reaches the
    `default` ServiceAccount no longer does (the note offers the remove command).
  - L18/lab 10: deleting the Subscription alone counted as an uninstall (the CSV must go too); a
    re-created Subscription reused a stale InstallPlan — plans are now owned by their Subscription and
    garbage-collected with it, so a pinned Manual install gets a fresh plan.
  - L20: the Architecture Advisor objective was ticked at level start and the composite score after
    14 of 18 objectives; both now score `prod-platform` only and the composite ticks last.
  - Unticked objectives explain the new rules (read-wrong-project, read-showed-nothing,
    build-not-complete, secret-wrong-type, rolebinding-wrong-grant, scc-over-broad, operator-csv-left,
    user-not-logged-in, exam-score-gated).
- **Last full run's NO-GO checks:** `KubePodCrashLooping` blinked off for one tick at every kubelet
  restart (the real rule is `max_over_time(…[5m])`; the coverage test also used a pullable image); the #51
  checks sampled a new-revision Pod on its unscheduled first tick (bounded wait); a stalled CDN download
  timed out a cold isolated page (one retry, logged); the GitHub-stars fetch now runs only on
  `shifting.pro` (no CORS console error elsewhere).
- **Simulator fidelity** (every "Open — simulator fidelity" item but the ones listed as open in
  `docs/guidance-qa-findings.md`):
  - `oc describe`/`exec`/`rsh` no longer fall back to another project's object; `-n` that disagrees with a
    manifest's namespace gives kubectl's mismatch error (`apply|create|replace|delete -f`/`-k`);
    `oc new-app -f|--template` honours `-n`.
  - After `oc logout` API calls run as `system:anonymous` and get the real Forbidden; `logout`, `whoami`,
    `whoami -t`, `project` and `version` print the real logged-out output; `oc login --token` accepts
    only tokens the cluster issued.
  - `oc create` requires `--image`/`--schedule` like real `oc`; forms real `oc` lacks (`create service
web`, `create subscription|networkpolicy|group|pod`) fail with its errors; a missing `--from-file` is
    an error; `"approved":"true"` (a string) is rejected by InstallPlan validation; `oc new-app <builder>
<repo>` builds the repo with that builder and a re-run fails with `already exists`.
  - Added glued `-owide`/`-oyaml`, `oc logs -l` (+`--prefix`/`--tail`/`--all-containers`),
    `helm upgrade --install`, JSONPath filters/slices/unions; `oc new-app --template` ticks L8.
  - Controllers create ReplicaSets/Pods/Jobs with their ownerReferences (no "YOU CREATED Pod" toast for
    an incident's Pod); `oc describe oauth` uses the real layout; `oc debug node` shows `sh-5.1#` and
    how to leave; `oc edit` says the run is paused while the Files panel is open.
  - `oc rollout undo` on a single revision errors like real `oc`; `oc adm drain` follows kubectl 1.35
    (DaemonSet/emptyDir/`--force` filters), cordon is the unschedulable taint, `alertmanager-main-N` is
    StatefulSet-owned; `oc adm top pods -A`; `oc exec … curl` exit codes; `oc describe networkpolicy`
    layout; a Subscription's `spec.name` is its package; the router answers with OpenShift's real
    "Application is not available" 503 page.
- **DaemonSet pods vs taints:** an untolerated NoSchedule taint deleted a node's running
  `dns-default`/`node-resolver` pods (and they were recreated on untaint). Like Kubernetes'
  `NodeShouldRunDaemonPod`, NoSchedule now only blocks new daemon pods — the running one stays and is
  reported in `numberMisscheduled`; only a selector mismatch or an untolerated NoExecute taint removes it.
  This was also the cause of the intermittent `#58` "no platform churn" failure.
- **"Pod Rookie" unlocked at level start:** platform DaemonSet Pods of a level's seeded Nodes were counted
  as the player's Pods; controller-owned and platform-namespace Pods no longer count.
- **Achievements panel** printed the icon key ("trophy", "graduation") as text above every achievement;
  it now shows a star glyph like the unlock toast.
- **Terminal:** Tab completion replaced the whole input line with a deep path (it now completes the
  current word, one path segment at a time); `$USER` was the OpenShift user instead of the Linux user
  `student`; a bare shell command such as `cp` was recorded as `oc cp` (so `command` objectives and EX280
  evidence for `htpasswd …` never matched) and was RBAC-checked like an `oc` command.
- **Targeted guidance replay** (`--only=qa-guidance-replay`) failed on `about:blank` before loading the app.

### Known gaps

- Still open, with notes in `docs/guidance-qa-findings.md`: Pods on a NotReady node stay Ready (no
  eviction), MetalLB withholds an address until an L2Advertisement exists (real MetalLB assigns it and only
  announces it later), client dry runs that print server defaults, and Chaos mode can aim a CronJob
  incident at a Pod. `vim FILE` opens the Files panel editor rather than an in-terminal vim, and lab
  `sudo` never prompts for a password. The `oc get bc|builds` FROM column was fixed in 1.16.1.

## [1.15.0] — 2026-11-07

Player-guidance pass after a live play-test: a learner got stuck on campaign level 7 or 8 and found the
instructions and the help tooltips unclear. Reproduced in a real browser, the causes were structural, not
specific to two levels. The commands lived in sequential hints that did not match the objectives; 18 of
20 levels (L2–L19) start the player in `default` while the lab is graded in a seeded project — a precondition only
hint #1 mentioned, and since the grader is deliberately project-scoped the right commands in the wrong
project silently refused to tick; the level intro's "First moves" were just the first three hints (L7 told
players to inject the ConfigMap as environment variables while the objective wanted a volume mount, and never
showed the volume command); with the terminal open the hint list was a ~120 px scroller of raw backticks;
the Files panel's primary **Apply -f** on a Template only stores it, with no objective ticking and no
explanation; and `command` objectives never ticked when the optional `oc ` prefix was left out. 1.15.0 adds
a guidance system to the mission card, authors a verified how-to for every objective of all 20 levels
(110 objectives), makes unticked objectives explain themselves, and turns the how-tos into executable test
data. The game stays no-build and dependency-free. The version is bumped to 1.15.0 (`package.json` and both import maps) because module URLs are
versioned (`/v/<version>/js/…`, cached as immutable): returning players only receive these changes under
the new prefix.

### Added

- **Mission card: where to work.** A project row names the lab project the level is graded in and, when
  the player is somewhere else, shows the one command that fixes it (click it to put it in the terminal).
  It is derived from the level's single seeded Project (15 levels); `workProject: null` opts a level out
  (L6, L13 and L18 seed a project that is not where the work happens; L20 seeds none), so the row never
  points anywhere wrong.
- **Per-objective how-to ("Show me how").** `objective.how = { explain, run[], check }` on all 110
  objectives: what the step does in plain language, the exact commands (each with **Copy** and **Put in
  terminal**) and one read-only check command. It is opt-in under **Next step**, counts as a hint (it
  never fails a level) and is authored data, not UI copy.
- **Self-explaining objectives.** `explainObjective()` (`ObjectiveEvaluator.js`) attaches
  `objective.note` to an unticked objective: `wrong-project` (the resource exists in another project than
  the one graded, with `oc project <lab>`), `sensitive-configmap-key`, and for templates
  `template-not-processed` (only stored by Apply -f), `template-not-applied` (only rendered by
  `oc process`) and `template-wrong-parameters` — each with the pipeline that fixes it. Notes show under
  Next step and under the objective row and never change what ticks.
- **Help (`H`) is a "where am I" view mid-level.** For guided levels it shows the done objectives, the
  current step, why it is not ticking and its how-to; the launch intro shows three orientation steps
  (work in the project, open the terminal, Show me how) instead of the first three hints.
- **Command chips.** `` `oc …` `` spans in hints, notes and steps are clickable chips that put the command
  in the terminal (`CommandBar.prefill(text, { focus })`, which never overwrites a pending `oc login`
  password prompt); `show({ focus })` can open the terminal without taking focus.
- **Files panel tips.** A Template file says that **Apply -f** only stores it and shows the
  `oc process … | oc apply -f -` pipeline; a Helm chart file says to `helm install` the whole chart.
- **Executable guidance.** `scripts/verify.mjs` locks the schema (typeable single-line commands, no
  placeholders, no `kubectl`, `workProject` must be `null` or a seeded Project; +319 checks); the new
  `qa-guidance` browser section covers the UI, the notes and the engine changes below; `qa-guidance-replay`
  replays every authored `how.run` / `how.check` for all 20 levels in a real browser (switching to the
  lab project, waiting for scheduled incidents, letting operators/builds settle) and requires each level to
  complete. `docs/guidance-qa-findings.md` records what the newcomer pass found and what is still open.

### Changed

- **Levels 7 and 8 rewritten first.** Plain-language descriptions, labels that name what and where,
  hints reduced to genuine tips, and (L7/L8) the Secret/ConfigMap objectives graded in the lab project.
  L8's Files-panel trap and the missing `--kustomize`/`-n`/`--output` command forms are covered too.
  Other levels' descriptions, ambiguous labels and wrong hints were corrected where the replay found them
  (L2–L6 project wording; L9–L12 MetalLB/Route hints; L13–L16 `oc edit` pause, FailedCreate on the
  ReplicaSet, project-template rollout; L17–L20 SCC/Job/MetalLB hints; see the findings file).
- **Hints are readable with the terminal open.** They render in the scrolling card body (no 120 px nested
  scroller), commands as code, with the footer button hiding once all are shown. On short windows
  (≤ 820 px high) the terminal dock is 256 px and the card hides its title/description while the terminal is
  open (the top bar shows the title; Help has the full text); on taller screens the description clamps to
  three lines and expands on click.
- **Level intro.** Renders `` `code` `` in the description, lists every objective (it cut the list at 6) and
  its button reads "Back to the level" when reopened mid-level.
- **Project-scoped grading** for the L7 ConfigMap/Secret and L11 `web-tls` objectives (previously a
  resource created in `default` ticked them and the next step failed with `not found`).
- **`oc new-app -f <template-file> -p …`** counts as processing and applying the template (L8), through the
  same record as `oc process … | oc apply -f -` (`ManifestEngine.markTemplateApplied`).
- **Recorded commands.** The `oc ` prefix is optional in the terminal; an unprefixed oc subcommand is now
  recorded as `oc <line>` so `command` objectives (`oc auth can-i`, `oc apply -k`, …) tick either way.
  Shell commands and lines that already carry `oc`/`kubectl` stay as typed.
- **Command objectives:** L2 accepts `oc -n <lab> get deployments`, `oc get all` and comma lists; L4 accepts
  `--output yaml|json`; L5/L6 accept `oc apply --kustomize`.

### Fixed

- **L19 early-fix trap.** Recreating the failed `report-batch` Job before the scheduled
  JobDeadlineExceeded incident (t=15 s) no longer gets the new Job flipped to Failed with the incident stuck
  Active: the incident remembers the seeded Job's uid and leaves a replacement alone, then self-heals.
- **L15 soft-lock.** The scheduled ResourceQuotaExceeded incident bound to `openshift-monitoring` when the
  quota was created after t=20 s and could not be resolved from the CLI; it is now bound to `quota-lab`.
- **L17 incidents panel** suggested the grant for the Deployment name (`-z privileged-app`) instead of the
  damaged ServiceAccount (`priv-sa`); it now uses the incident's damaged subject.
- **Terminal history:** ArrowUp does nothing and ArrowDown recalled the newest command; Up now walks back
  and Down forward, like a shell.
- **Raw backticks** in achievement toasts and the achievements panel.

## [1.14.0] — 2026-11-05

Sixteenth QA pass on 1.13.0: closes all seven open issues of the 1.13.0 live retest (#70–#76) —
four P2 bugs in the S2I, grading, RBAC and incident layers, the P2 immutable-Job trap, and the two
collected fidelity batches (#75 P3, #76 P4). A completed S2I build's own digest image now resolves
against the ImageStream tag history, so the `oc new-app` rollout starts the built code instead of
sticking in ImagePullBackOff, and a pre-build `<ns>/<name>:latest` Pod is honestly un-pullable
until the first successful push. Identity, RBAC and SCC objectives grade cluster state — the OAuth
IdP's referenced Secret, a changed htpasswd hash plus a successful login with the new password,
`oc auth can-i` for the subject, and a Pod admitted with `openshift.io/scc=privileged` as the
service account — instead of hidden names, passwords or binding names, and L17/lab 8 resolve for
any state-equivalent SCC grant. `oc create role --resource=securitycontextconstraints|scc` resolves
the resource to `security.openshift.io`, `oc set resources job/<name>` is rejected with the API
server's immutable-pod-template error (lab 12's hint teaches delete/recreate or a LimitRange), and
PendingScheduling now patches the Deployment template — a new ReplicaSet Pod stays Pending with a
real default-scheduler FailedScheduling event while the old Pods keep serving — instead of mutating
a Running Pod's immutable nodeSelector. The collected batches fix the remaining output and
behaviour differences: kubectl 1.35's `oc explain` v2 plaintext template, JSONPath list/object
arrays, Kustomize's legacy sort order, `oc new-app`'s `8080-tcp`/`3306-tcp` Service port names (and
the Route PORT column), the real `oc login` project text, name-sorted list output, `helm list`
timestamps, MetalLB's `IPAllocated` event and OCP-minor CSV name, kubectl-backed `oc describe pod`
container state lines with real `cri-o://` IDs and image digests, canonical quota quantities,
populated Identity UIDs, the Job `Active Deadline Seconds:` line, plain-text hello-openshift
bodies, frozen NotReady-node heartbeats, CrashLoopBackOff timing consistent with Pod AGE, L3
crashes from the first start, L14 RBAC denials discovered in `oc logs` (no invented events), L16
in-cluster API PodList/403/401 evidence, the L12 passthrough-TLS fixture with the real
handshake-failure diagnostic, lab 8 ServiceAccount admission, corrected lab 1/3/8/12 hints, L7/L11
objectives that no longer start ticked, and shell `$(...)` at the end of a word with a real `/tmp`
mapping and `echo`'s single newline. These behaviours are locked by the new permanent
`qa-issue70-76` browser-regression section and `scripts/verify.mjs` §4k static locks. The game
stays no-build and dependency-free.

### Added

- **State-based grading for identity, RBAC and SCC objectives (issue #71).** The hidden-name
  objectives grade the cluster state a correct solution produces, in the style of the existing
  L18/lab 9/lab 13 grading. L13's htpasswd Secret objective accepts any Secret the
  `oauth/cluster` identity provider references and that actually logs the user in (not just a
  Secret named `htpass-secret`); the L13/lab 11 password-rotation objective grades that the user's
  htpasswd hash changed after a successful login and that a login with the new password succeeded,
  so a player's own password works (the hinted literal stays a hint). The lab 7 RoleBinding
  objective grades `can-i`-equivalent state for the subject in `team-dev` — any binding whose
  ClusterRole/Role grants `edit` to the `developers` group — and adding "edit" to an existing
  working binding no longer dead-ends the hint command. L17's SCCForbidden incident resolves and
  grades on state: a Role/RoleBinding with `apiGroups: ["security.openshift.io"]`,
  `resourceNames: ["privileged"]`, `verbs: ["use"]` or the `system:openshift:scc:privileged`
  binding is credited once a Pod is admitted with `openshift.io/scc: privileged` running as
  `priv-sa`, and lab 8 accepts the equivalent state-level grant while keeping the `oc adm policy`
  hint. The evaluator grew explicit state objective types — `oauthProvider.secretReferenced`,
  `password.rotate`, `privileged.serviceAccount` and a state-based `scc` check resolved through
  `getSCCsForSubject` — so labels describe the evidence rather than a hidden name. The new
  permanent `qa-issue70-76` section and `verify.mjs` §4k locks cover each case end-to-end.
- **In-cluster Kubernetes API access from `oc exec` (issue #75).**
  `oc exec … -- sh -c 'curl -sk -H "Authorization: Bearer $(cat
/var/run/secrets/kubernetes.io/serviceaccount/token)"
https://kubernetes.default.svc/api/v1/namespaces/<ns>/pods'` now goes through the simulated
  kube-apiserver front door: a ServiceAccount authorised by RBAC gets the real single-line PodList
  JSON for the namespace, an unauthorised or anonymous request gets the 403 `Status` JSON with
  kubectl's `pods is forbidden: User "system:serviceaccount:<ns>:<sa>" cannot list resource "pods"
in API group "" in the namespace "<ns>"`, and an invalid bearer token is rejected with 401
  Unauthorized — the L16 "application access to Kubernetes APIs" evidence, with the shell quoting
  and container `$(...)` expansion needed to run the exact one-liner.
- **MetalLB controller events and OCP-minor CSV versioning (issue #76).** With the MetalLB operator
  installed, a LoadBalancer Service gets the MetalLB controller's
  `Normal IPAllocated Assigned IP ["192.168.150.200"]` event from the single canonical emission
  path (the cloud-provider `EnsuredLoadBalancer … From Service` text is gone from the simulation),
  and the operator CSV follows the redhat-operators bundle's OCP-minor versioning
  `metallb-operator.v4.22.0-202610281200` instead of upstream `v0.14.9` in the seed, the install
  flow, the hints and the locks.
- **kubectl 1.35 `oc explain` v2 output (issue #76).** `oc explain` renders kubectl 1.35's v2
  plaintext template from the shared explain data: a `GROUP:` line only for non-core API groups,
  `KIND:`/`VERSION:` headers aligned like kubectl's column 13, a blank line, `DESCRIPTION:` with
  the text wrapped at 76 columns and indented 4, then `FIELDS:` with one
  `  <path>\t<Type>` entry per field in alphabetical order (single-line, like the template; enum
  types are listed); a field request prints `FIELD: strategy <DeploymentStrategy>` first and only
  that field's description and children (`oc explain deployment.spec.strategy` lists
  `rollingUpdate` before `type`). The descriptions stay the game's curated teaching text — the
  format and field structure are what match the target kubectl.
- **JSONPath list/object marshalling (issue #76).** `-o jsonpath` marshals list and object values
  like client-go's `jsonpath.go`: `{.spec.template.spec.containers[0].env}` prints
  `[{"name":"APP_ENV","value":"production"}]` and `{.spec.ports}` a bracketed JSON array, while
  scalars and list-of-scalars formatting keeps its existing kubectl shape (escaped keys, ranges and
  filters unchanged).
- **Kustomize legacy resource ordering (issue #76).** `oc kustomize` and `oc apply -k` render and
  apply resources in Kustomize's `SortOrderTransformer` legacy order (ConfigMap → Service →
  Deployment, so a Service is emitted before a Deployment), and `-o yaml` and the apply order agree
  deterministically.
- **Real `/tmp` virtual filesystem and shell finalization (issues #75/#76).** Workspace redirects
  and reads address one virtual `/tmp` directory: `oc get … > /tmp/webapp.yaml`, `cat
/tmp/webapp.yaml`, `ls /tmp`, `rm` and `oc apply -f /tmp/…` all agree (the old `~/tmp/` shadow
  tree is gone), `echo` prints exactly one trailing newline, and `$(...)` at the end of a word
  expands cleanly, so `curl -s http://$(oc get route webapp -o jsonpath={.spec.host})` works. The
  word-final substitution is hardened by quote-aware expansion, and Route admission now applies its
  defaults synchronously (`applyAdmissionDefaults`), so a freshly admitted Route always has
  `spec.host` populated when the substitution reads it.
- **Permanent QA coverage (issues #70–#76).** New `qa-issue70-76` browser-regression section
  (146 checks) and matching `scripts/verify.mjs` §4k static-fidelity locks
  (61 checks) pin every 1.14.0 contract; the existing `cli`/`campaign`/`challenges`/`qa-*` sections
  were updated where they encoded the old behaviour.

### Changed

- **S2I image references and built-image rollouts (issue #70).** `_resolveContainerImagePull` parses
  `<registry>/<ns>/<name>@sha256:<digest>` as a digest reference and resolves it against the
  ImageStream's tag history (`status.tags[].items[].image`); a digest that matches an entry pulls
  the exact image the build produced, and only an unknown digest falls back to a real pull failure
  (`manifest unknown`). A pre-build Pod that references `<ns>/<name>:latest` before any push stays
  `ImagePullBackOff` until the first successful build creates that tag, then recovers and the
  ImageChange rollout starts the built image. Both L9 flows (`oc new-app
openshift/nodejs:20-ubi9~…` and lab 5's `oc new-app https://…`) reach Running with the digest and
  the Route serves the built code.
- **PendingScheduling damages through the Deployment (issue #73).** The incident patches the
  Deployment template with a bad `nodeSelector` instead of mutating a bound Pod's immutable spec: a
  new ReplicaSet rolls out, its Pod is `Pending` with the real v1.35 default-scheduler event
  `0/<N> nodes are available: <M> node(s) didn't match Pod's node affinity/selector.`, the old
  Pods keep serving within `maxUnavailable`, and the Deployment reaches `ProgressDeadlineExceeded`
  over time. No `Normal Healed` kubelet reason and no impossible `(xN over 0s)` counts are
  emitted; `oc get pods -o wide` shows a node name for scheduled Pods and `<none>` for the Pending
  one (never a node InternalIP), whose `oc describe` is `Node: <none>`/`Pending` with no Running
  container state. `oc rollout undo`, `oc patch`/`oc edit` removing the selector and
  `oc label node` all heal the incident; `oc delete pod` is no longer the only fix.
- **Job pod templates are immutable (issue #74).** `oc set resources job/<name>` (and CronJob pod
  templates) is rejected like a real API server —
  `The Job "<name>" is invalid: spec.template: Invalid value: ...: field is immutable` — with no
  mutation and no completion, and only a suspended Job's scheduling directives may change. `oc
create job|cronjob … --dry-run=client -o yaml` names the container after the object (kubectl's
  `create_job.go`). Lab 12's hint now teaches deleting the Jobs and recreating from an edited
  dry-run YAML with `resources.requests` (or adding a LimitRange `defaultRequest` and recreating).
- **CLI output fidelity (issue #76).** `oc new-app` names Service ports
  `fmt.Sprintf("%d-%s", port, protocol)` (`8080-tcp`, `3306-tcp`, not `http`) and the Route PORT
  column follows; `oc create route passthrough <name> --service=<svc>` sets
  `spec.port.targetPort` to the Service port's name when named, else its number. `oc login` prints
  loginoptions.go's project text — several projects:
  `You have access to the following projects and can switch between them with 'oc project
<projectname>':`, a blank line, the current project as `  * <name>` (two spaces) and the others
  four-space indented, then `Using project "<name>".`; exactly one project:
  `You have one project on this server: "<name>"` and the same `Using project` line. Lists (`oc get
all` and every list output, including `-o name/yaml/json`) are sorted by name like the API
  server, never creation order. `helm list` UPDATED prints helm's real Go timestamp
  (`YYYY-MM-DD HH:MM:SS.fffffffff +0000 UTC`) instead of an age. hello-openshift answers plain text
  `Hello OpenShift!` + newline like the origin image, not an HTML `<html><body>` wrapper.
- **`oc describe` and status detail (issue #76).** `oc describe pod` prints kubectl 1.35's
  container state block: a Waiting container prints only `Reason` (no `Message:`), a Terminated
  `Last State` prints `Started:` before `Finished:`, and a Running container prints
  `Container ID: cri-o://<id>` and a real image digest (`Image ID: …@sha256:…`) instead of
  `<none>` (deterministic per Pod/container, stable across describes and ticks). `oc describe job`
  prints `Active Deadline Seconds:  8s` whenever the field is set — L19's diagnostic line.
  `oc describe quota` prints canonical `resource.Quantity` values (`1000m` → `1`, `1024Mi` → `1Gi`)
  and `oc get identities` fills the USER UID column. A NotReady Node's `LastHeartbeatTime` freezes
  at the last kubelet post while `LastTransitionTime` records the change (no advancing heartbeat
  under "Kubelet stopped posting node status"), CrashLoopBackOff restart timing is physically
  consistent with Pod AGE (10 s/20 s/40 s kubelet back-off; no `RESTARTS 2` at `AGE 5s`), and fast
  busybox Jobs complete promptly instead of idling ~25 s while their logs already show completion.
- **Incident and content realism (issue #75).** L3 now crashes from the first start: the
  CrashLoopBackOff incident's `seed:` rolls the Deployment to `APP_MODE=debug-invalid`, so new Pods
  crash immediately with honest RESTARTS/AGE and the log line `configuration validation failed:
APP_MODE has an unsupported value`, while the old Pods keep serving (no late mutation of healthy
  Running Pods). L14's UnauthorizedAccess no longer invents RBAC events — the symptom is in
  `oc logs deploy/web` as the real `pods is forbidden: User "system:serviceaccount:rbac-lab:default"
cannot list resource "pods" in API group "" in the namespace "rbac-lab"`. L19's DeadlineExceeded
  message is exactly `Job was active longer than specified deadline` (no appended `(8s)`). Lab 12
  seeds a self-consistent TLS fixture (UBI nginx personality on containerPort 8443 named `https`,
  Service port 443 named `https` → targetPort 8443): `oc create route passthrough tls-app
--service=tls-app` is admitted with `spec.port.targetPort: https` and `curl -k https://<host>`
  returns 200, while a passthrough Route to a plain-HTTP backend fails the handshake with
  `curl: (35) error:0A00010B:SSL routines::wrong version number` (exit status 35; `-k` does not
  bypass a handshake failure). Lab 8's Deployment with `serviceAccountName: priv-sa` and no
  ServiceAccount gets no Pod: the ReplicaSet records `Error creating: pods "<pod>" is forbidden:
error looking up service account secure/priv-sa: serviceaccount "priv-sa" not found`, and the
  hint requires creating `priv-sa` (the manifest creates none). L7's volume-mount objective and
  L11's Service-selector objective start unticked and flip only on real state; lab 1's Route hint
  teaches the real admission rule (host/path/certificate — endpoints are irrelevant, a missing
  endpoint set returns 503), the lab 3/L11/EX280 TLS hints teach the real `openssl req -x509`
  certificate flow (`oc create secret tls … --cert=missing.crt` now fails with the real
  `error: open missing.crt: no such file or directory`), and the SCC `FailedCreate` message now
  appends the per-provider reasons
  (`unable to validate against any security context constraint: [provider "anyuid": Forbidden: not
usable by user or serviceaccount, spec.containers[0].securityContext.privileged: Invalid value:
true: Privileged containers are not allowed, ...]`).
- **Project-request template rollout (issue #76).** Changing
  `project.config.openshift.io/cluster.spec.projectRequestTemplate` no longer takes effect
  instantly: the simulated openshift-apiserver rolls out for exactly 8 game seconds (the
  ClusterOperator reports `Progressing=True reason=Working`), and only after that window does the
  next `oc new-project` apply the template.
- **Docs.** README, CONVERSION-SPEC (§4.7 and the touched notes), the architecture-map's live rows
  (§3.3 explain database, §4.2/§4.3 lifecycle, §5.3/§6.3/§7.2 notes) and the verification report
  describe the S2I digest rollout, state-based grading, Role API-group resolution, immutable Job
  templates, the PendingScheduling rollout, the explain/describe/jsonpath/Kustomize/new-app/
  login/list/helm/MetalLB/shell contracts and the incident-content corrections (issues #70–#76);
  the verification report records the sixteenth QA pass.

### Fixed

- **S2I's own build output was unpullable (issue #70 P2).** `name@sha256:…` was parsed as a tag
  named `sha256:…` and resolved through `resolveImageStreamTag`, so a completed build's Deployment
  Pod went `ImagePullBackOff` ("manifest unknown") forever; the digest now resolves against
  `status.tags[].items[].image`, the built image really starts, and a pre-build `:latest` Pod is
  honestly un-pullable until the first push. L9 and lab 5 rollouts now finish and serve the built
  code.
- **Working identity/RBAC/SCC solutions were rejected by hidden names or values (issue #71 P2).**
  A Secret named `my-htp` referenced from `oauth/cluster`, a player-chosen rotated password, a
  `dev-edit` RoleBinding granting `edit` to `developers`, and an equivalent custom Role+RoleBinding
  for `system:openshift:scc:privileged` are all credited now (grading reads the same state the
  verifier does), and the L17/lab 8 incidents resolve from that state within the normal heal tick
  instead of staying open.
- **`oc create role --resource=securitycontextconstraints|scc` wrote `apiGroups: [""]` (issue #72
  P2).** A custom `use` Role silently granted nothing; the resource token now resolves through the
  kind→API-group map (`security.openshift.io` for SCCs, `route.openshift.io`, `image.openshift.io`,
  `build.openshift.io`, `apps`, …) for every `oc create role|clusterrole --resource=…`, including
  the `scc` short name, `resource.group`, subresources, comma lists and `--api-group`, so
  `oc auth can-i use scc/privileged --as=…` answers yes and the privileged Pod is admitted.
- **PendingScheduling mutated a Running Pod's immutable `nodeSelector` and invented events (issue
  #73 P2).** The damage is now a Deployment-template rollout (see Changed); the fabricated
  `Normal Healed` kubelet event, the `(x3 over 0s)` count, the node InternalIP in the NODE column
  and the impossible Pending-yet-Running describe are gone, and the incident is fixed by the
  realistic repair paths instead of being a delete-Pod drill.
- **`oc set resources job/…` succeeded although a Job's pod template is immutable (issue #74 P2).**
  It is rejected with the API server's exact `spec.template: … field is immutable` error and no
  state change; the dry-run container naming and the lab-12 hint are corrected so the level teaches
  the exam-correct delete/recreate (or LimitRange) flow.
- **Collected debug signals and hints differed from a real cluster (issue #75 P3).** L3's late
  crash onset, L14's invented RBAC events, L16's generic Hello page instead of the API's
  PodList/403, L19's missing `Active Deadline Seconds:` and `(8s)`-suffixed event, L12's
  inconsistent TLS seed/200 response, lab 8's Running Pod without its ServiceAccount, the
  pre-ticked L7/L11 objectives, the wrong lab 1/3/8 hints and the word-final `$(...)` failure are
  all fixed and covered by `qa-issue70-76`.
- **Collected CLI/describe/MetalLB/filesystem differences (issue #76 P4).** explain's pre-1.27
  output, unbracketed JSONPath lists, file-order Kustomize output, `http` new-app port names, the
  old `oc login` project text, creation-ordered lists, `0s` helm timestamps, the cloud-provider/
  MetalLB event and CSV mismatch, the wrong describe container-state/quota/identity/Job lines, the
  advancing NotReady heartbeat, impossible CrashLoopBackOff timing, the `~/tmp` redirect shadow
  tree, the extra `echo` blank line, the HTML hello-openshift body, the generic SCC FailedCreate
  message and the instant project-request-template change are all fixed with one canonical behavior
  and permanent locks.

## [1.13.0] — 2026-11-05

Fifteenth QA pass on 1.12.0: closes both open issues of the 1.12.0 live retest (#68–#69) — the P1
returning-visitor crash caused by a mixed-release JavaScript graph (#68) and the P3/P4 boot-error
overlay + kubectl 1.35 `oc describe svc` gaps (#69). 1.12.0's revalidating unversioned app code is
kept as the direct-access fallback, but release delivery of the ES-module graph now uses immutable
versioned URLs: each release points the import maps in `index.html` and `draw.html` at
`./v/<package.json version>/js/`, `vercel.json` rewrites `/v/:version/js/:path*` to `/js/:path*`,
and that prefix is served `public, max-age=31536000, immutable`, so a returning visitor can never
mix a new entry document with modules cached from a previous release. Boot failures are honest
now: only a failed WebGL capability probe shows the "WebGL Not Available" panel; every other
init/renderer error shows a new `init-error` panel with the real message, a hard-reload hint and a
GitHub report link. `oc describe svc` matches kubectl 1.35 / OCP 4.22: it prints the
API-server-defaulted `Internal Traffic Policy:  Cluster` after `Session Affinity` and the
operator-set `Traffic Distribution:` after the LoadBalancer source ranges, the seeded
`openshift-dns/dns-default` Service carries `spec.trafficDistribution: PreferSameNode`, and the
`Events:` placeholder moved to the shared tabwriter column (19 spaces after `Events:`). The game
stays no-build and dependency-free.

### Added

- **Versioned module URLs for release-safe caching (issue #68).** Both entry pages' import maps map
  `"./js/"` to `"./v/1.13.0/js/"`, so the browser resolves the whole ES-module graph — every
  static/dynamic `import` of a `./js/` specifier and every relative import written inside a module
  — under the versioned prefix. `vercel.json` rewrites `/v/:version/js/:path*` to `/js/:path*` and
  serves `/v/(.*)` with `Cache-Control: public, max-age=31536000, immutable`; `package.json` is the
  version single source and `scripts/verify.mjs` fails when either import-map value drifts from
  it. The new permanent `qa-issue68` browser-regression section proves the served versioned
  rewrite/immutable header, that a fresh game/draw load requests only versioned module URLs, the
  import-map-driven `fetch()` probe, and the returning-visitor release simulation in which a module
  replaced under the new version prefix really executes.
- **Generic boot-failure overlay (issue #69 P3).** `index.html` gains `_showInitError(err)`: a
  `#init-error` overlay (`role="alert"`) titled **The game failed to load**, showing the real
  error message in `#init-error-message` (written with `textContent`, never interpolated as HTML),
  a hard-reload hint (`Ctrl+Shift+R` / `Cmd+Shift+R`) and a link to open a GitHub issue with the
  message. The WebGL capability panel (`#webgl-error`, "WebGL Not Available") is now reserved for a
  failed `webgl`/`webgl2` context probe; the renderer-constructor catch calls
  `_showInitError` directly, and the top-level `init().catch` branches to it unless
  `_webglFailed` is set. The new permanent
  `qa-issue69` browser-regression section injects an init failure (generic panel, exact message, no
  WebGL panel) and forces a real WebGL capability failure (WebGL panel, no generic panel).
- **kubectl 1.35 describe-svc lines and `dns-default` `trafficDistribution` (issue #69 P4).**
  `Service.toDescribe()` prints `Internal Traffic Policy:` after the external traffic policy when
  `spec.internalTrafficPolicy` is set (the API server defaults it to `Cluster` for every
  non-ExternalName Service) and `Traffic Distribution:` after the LoadBalancer source ranges when
  `spec.trafficDistribution` is set. `SimulationTick` seeds the platform
  `openshift-dns/dns-default` Service with `spec.trafficDistribution: PreferSameNode` (the
  cluster-dns-operator's release-4.22 asset) when it seeds the platform Service, so
  `oc describe svc dns-default -n openshift-dns` prints it and
  `oc get svc dns-default -n openshift-dns -o jsonpath={.spec.trafficDistribution}` answers it.
  Because `Internal Traffic Policy:` (24 chars) is the longest top-level label, tabwriter pads
  labels of ClusterIP Services to 26 chars, so every describe value starts at column 27 — e.g.
  `Session Affinity:         None`, `Internal Traffic Policy:  Cluster`,
  `Traffic Distribution:     PreferSameNode` — while an ExternalName Service prints neither new
  line (the API server strips both fields there).
- **Permanent QA coverage and release-rule locks (issues #68–#69).** The browser harness now
  emulates the real `vercel.json` rewrites (compiling `:param`/`:path*` sources to regexes and
  substituting captures into the destination) and computes cache headers from the original request
  path plus ETags from the resolved file, so the immutable versioned path is exercised exactly as
  on Vercel; new `qa-issue68` and `qa-issue69` sections sit next to `qa-issue66`/`qa-issue67`.
  `scripts/verify.mjs` grew the matching `§4j` static-fidelity locks: `package.json` and both
  import maps must agree on the version, `index.html` and `draw.html` must keep `./js/` specifiers
  while the import map supplies the versioned prefix, `vercel.json` must keep the `/v/` rewrite and
  immutable header, `_showInitError`/`_webglFailed` gating must stay split between generic and
  WebGL failures, and the describe-svc/trafficDistribution contract is instantiated headlessly.

### Changed

- **`vercel.json` release-delivery rules (issue #68).** New rewrite
  `/v/:version/js/:path*` → `/js/:path*`, and a new `/v/(.*)` header rule serving
  `public, max-age=31536000, immutable`, placed ahead of the unversioned `/js/(.*)` revalidation
  rule. `/js/(.*)`, CSS, HTML, `/` and `/draw` keep
  `Cache-Control: public, max-age=0, must-revalidate` as the fallback that still revalidates
  direct/unversioned access; images/fonts keep the long-lived cache, and the `/draw` rewrite,
  `ignoreCommand` and bot redirect are unchanged. Release rule: bump `package.json` and both
  import-map prefixes (`index.html`, `draw.html`) together — `scripts/verify.mjs` fails when they
  drift — and do it on EVERY deploy that changes `js/` or the entry documents, because an unchanged
  `/v/<version>/` prefix keeps old cached modules for a year.
- **`_moduleExists()` probes resolve through the import map (issue #68).** `fetch()` bypasses import
  maps, so a plain `./js/...` HEAD probe would have hit the unversioned URL while `import()` loaded
  the versioned one. `index.html` now parses the import map into `MODULE_IMPORT_MAP`, derives
  `JS_MODULE_BASE`/`resolveModulePath()` and calls `fetch(resolveModulePath(path))`, so optional
  panels (Files panel etc.) probe the same URL the module graph loads.
- README, CONVERSION-SPEC §4.5, the architecture-map hosting/import-map rows (including G19) and
  the verification report describe the versioned immutable module URLs with their revalidating
  entry-document fallback, the release bump rule, the `init-error` panel and the kubectl 1.35
  describe-svc contract (issues #68–#69); the verification report records the fifteenth QA pass.

### Fixed

- **Returning visitors crashed on start with "WebGL Not Available" after a release (issue #68
  P1).** The revalidated entry document could still boot against a module graph cached from a
  previous release, because module URLs did not change between releases; the mixed graph failed
  during boot and the old overlay blamed the player's GPU/driver. Every module URL now
  carries the release version, so a new `index.html` imports URLs the old cached graph never
  populated — a release changes every module URL and can never mix two versions — while the
  entry document/import map and the unversioned `/js/*` path keep revalidating as the
  direct-access fallback. The returning-visitor scenario is reproduced end-to-end in `qa-issue68`.
- **Any `init()`/renderer exception showed the hardware-acceleration panel (issue #69 P3).** A
  JavaScript/release error told the player to enable hardware acceleration or update drivers even
  though the graphics stack was fine. Only a failed WebGL capability probe may show that panel now;
  every other boot failure shows the real error message plus a hard-reload hint, and the renderer
  catch no longer sets `_webglFailed`.
- **`oc describe svc` lagged kubectl 1.35 and the `Events:` placeholder was one tabwriter column
  short (issue #69 P4).** Describe omitted the API-server-defaulted
  `Internal Traffic Policy:  Cluster` and the operator-set `Traffic Distribution:` line (the
  seeded `dns-default` carried no `spec.trafficDistribution`), and the `Events:` placeholder had
  12 spaces (aligned to the old 17-char widest label `Session Affinity:`). Both lines now print
  in kubectl 1.35's order and the shared tabwriter column moved to 27 (26-char padding), so an
  unversioned ClusterIP Service describe ends with `Events:` + 19 spaces and ExternalName
  Services correctly print neither of the new lines.

## [1.12.0] — 2026-11-05

Fourteenth QA pass on 1.11.0: closes both open issues of the live 1.11.0 retest (#66–#67) — the P2
stale/mixed-release JavaScript cache (#66) and the P2 player-set probes that `describe` displayed but
the kubelet tick never evaluated (#67), plus the P4 `OldReplicaSets` check against the kubectl 1.35
sources. Returning visitors now revalidate the unversioned app code through Vercel's ETags instead of
running a day/month-old module graph, and every Pod probe is genuinely evaluated: a failing readiness
probe turns the Pod `0/1 Running`, emits kubectl's `Readiness probe failed: …` event and removes it
from the Service endpoints (the Route answers 503 until the probe is fixed and recovers on the same
tick); a failing liveness/startup probe restarts the container with the real
`Container <name> failed liveness probe, will be restarted` event, RESTARTS climbing into
CrashLoopBackOff; `oc set probe … -- <command>` stores a real `exec` handler that runs in the same
simulated container filesystem as `oc exec`. `OldReplicaSets` was verified against kubectl 1.35 (all
old ReplicaSets, including `(0/0 replicas created)` ones — not `<none>`) and locked. The game stays
no-build and dependency-free.

### Added

- **Kubelet evaluation of player-set probes (issue #67).** The simulation tick now evaluates every
  running Pod's `httpGet`, `tcpSocket` and `exec` probes against the simulated container.
  `initialDelaySeconds` is measured from the container's (re)start, later attempts run every
  `periodSeconds` of simulated time, and consecutive `failureThreshold`/`successThreshold` results
  decide the probe state. httpGet/tcpSocket resolve numeric or named ports across the Pod's
  containers (one shared network namespace; a Pod that declares no ports keeps the permissive legacy
  behaviour) and report kubelet's exact text — `Get "http://<podIP>:<port><path>": dial tcp
<podIP>:<port>: connect: connection refused` / `dial tcp <podIP>:<port>: connect: connection
refused`. The simulated app serves `/` plus the conventional health endpoints (`/healthz`,
  `/health`, `/readyz`, `/ready`, `/livez`, `/live`); hello-openshift is a Go catch-all that answers
  every path; any other path is `HTTP probe failed with statuscode: 404`. Exec probes run through the
  same container executor as `oc exec`, so `/tmp/healthy` really fails with `cat: /tmp/healthy: No
such file or directory` while a present file succeeds (a bare Node engine falls back to the
  deterministic container-command model). A failed readiness probe sets Ready/ContainersReady False,
  records a throttled `Warning Unhealthy` event with the handler's real message and drops the Pod
  from Service endpoints (recovery repopulates them in the same tick, keeping `_readyAt`). A failed
  liveness/startup probe restarts the container (exit 137, last state reason `Error`, `Normal Killing
Container <name> failed liveness probe, will be restarted`), increments RESTARTS and backs off into
  CrashLoopBackOff; startup probes gate liveness/readiness until they pass. The CPU/memory-overload
  chaos failure source is preserved as an additional thresholded failure.
- **Exec probes on `oc set probe` (issue #67).** `oc set probe <kind>/<name>
--liveness|--readiness|--startup -- <command> [args…]` stores `exec: {command: argv}` plus the
  API-server timing defaults (delay 0s, timeout 1s, period 10s, #success 1, #failure 3), replacing any
  previous handler. Everything after `--` is argv verbatim (pflag-faithful: flags after `--` belong to
  the command), `--remove` still wins, and mixing a handler flag (`--get-url`/`--open-tcp`) with a
  command fails with an oc-style one-handler usage error.
- **Production cache policy + ETag revalidation coverage (issue #66).** The browser harness now
  serves the repository with the real `vercel.json` `Cache-Control` rules plus ETag/`If-None-Match`
  304 handling (and a mutable module override), so the suite exercises the real "returning visitor
  after a release" HTTP-cache path; a new `qa-issue66` section proves a changed unversioned module is
  revalidated and executed on the next navigation. `verify.mjs` §4i additionally locks the header
  contract statically.

### Changed

- **`vercel.json` cache policy (issue #66).** `/js/(.*)`, CSS, HTML, `/` and `/draw` are served
  `Cache-Control: public, max-age=0, must-revalidate` (the old `max-age=86400, s-maxage=604800,
stale-while-revalidate=2592000` is gone for app code), so Vercel's ETag answers one `304` per
  unchanged module and a `200` whenever a release changed it. Only images/fonts keep the long-lived
  cache; `/draw` rewrite, `ignoreCommand` and the bot redirect are unchanged.
- **Container exec simulation accepts argv (issue #67).** `CommandBar._simulateExecCommand` accepts
  the exec probe's pre-tokenized argv array as well as the existing raw command string (so
  `sh -c '<script with spaces>'` is never re-split), and `index.html` wires the executor into
  `SimulationTick.setContainerExecEvaluator` so probes and `oc exec` share one simulated container
  filesystem, environment and exit statuses.
- README, CONVERSION-SPEC (§4.5), the architecture-map `vercel.json` notes and the verification
  report describe the release-safe cache policy, the evaluated probes and the kubectl 1.35
  `OldReplicaSets` finding (issues #66–#67); the verification report records the fourteenth QA pass.

### Fixed

- **Returning visitors ran stale (or mixed-version) JavaScript after a release (issue #66).**
  Unversioned `/js/*` modules were cached for 24 h (CDN 7 days, `stale-while-revalidate` 30 days) and
  `index.html` never changed between releases, so nothing busted the module cache: a browser kept
  executing the previous release (and could mix modules from two releases). App code now revalidates
  on every navigation via ETag (`public, max-age=0, must-revalidate`); the browser suite reproduces
  the report and proves the next navigation runs the new module.
- **Player-set probes were displayed but never evaluated (issue #67).** A wrong readiness probe left
  the Pod `1/1 Ready` and kept it in Service endpoints, so the player learned that a broken probe was
  harmless. The tick now evaluates the template's own probes: failing readiness flips the Pod to
  `0/1 Running`, `oc describe pod` shows kubectl's `Readiness probe failed: Get "http://<podIP>:9999/nope":
dial tcp <podIP>:9999: connect: connection refused`, the endpoints drop the Pod and the Route
  returns 503; a failing liveness probe produces `Liveness probe failed: cat: /tmp/healthy: No such
file or directory` + `Container <name> failed liveness probe, will be restarted`, RESTARTS climbs
  and the Pod reaches CrashLoopBackOff.
- **`oc set probe … -- <cmd>` stored `httpGet /healthz` instead of `exec.command` (issue #67).** The
  command after `--` was silently ignored and the probe fell back to an HTTP handler; it now stores
  `exec: {command: ['cat', '/tmp/healthy']}` and `oc describe deploy` prints `Liveness:  exec [cat
/tmp/healthy] delay=0s timeout=1s period=10s #success=1 #failure=3`.
- **`OldReplicaSets` P4 note verified as correct for OCP 4.22 (issue #67 P4).** The report expected a
  finished rollout to show `OldReplicaSets: <none>`. kubectl 1.35 (`GetAllReplicaSetsInChunks` +
  `describe_test.go`) prints ALL old ReplicaSets, including `bar-001 (0/0 replicas created)`; the
  game already matches the target platform, so the behavior is kept (with a source comment and a
  permanent regression lock) instead of being changed to the pre-1.27 output.

## [1.11.0] — 2026-11-05

Thirteenth QA pass on 1.10.0: closes both open issues of the 1.10.0 CLI retest (#64–#65) — the P3
describe/exec gaps in how a player verifies injected config and probes (#64) and the P4
`sh -c`/`oc describe`/`oc adm top` differences (#65). `oc describe deployment` and `oc describe pod`
now render like kubectl: env `valueFrom` entries print kubectl's placeholders
(`<set to the key 'DB_PASS' in secret 'db'>  Optional: false`, the
`<set to the key 'APP_LOG' of config map 'cfg'>` form and the fieldRef/resourceFieldRef forms)
instead of raw JSON, Liveness/Readiness/Startup lines print their real handler and
`delay=/timeout=/period=/#success=/#failure=` suffix, `Volumes:` print the full
`Type:`/`Name:`/`Optional:` blocks for every modelled source (including the injected
`kube-api-access-*` projected service-account volume), and annotations print as sorted multiline
`key: value` while labels stay `key=value`. `oc set probe` honours `--initial-delay-seconds`,
`--period-seconds`, `--timeout-seconds`, `--success-threshold` and `--failure-threshold`
(previously ignored and forced `initialDelaySeconds: 5`), updates only the fields the player
supplied while preserving the existing handler, lets the API server default the rest, and
`--open-tcp` goes through the same engine path. `oc exec`/`oc rsh -- sh -c '<script>'` now runs the
script in the container's shell: single-quoted `$DB_PASS`/`$APP_MODE` expand from the container env
(`s3cr3t prod`), `$HOSTNAME` prints the pod name, shell builtins work
(`sh -c "exit 3"; echo rc=$?` → `command terminated with exit code 3` + `rc=3`) and
`id -u`/`-g`/`-un`/`-gn`/`-G`/`-Gn` print bare IDs like coreutils, while a double-quoted
`$APP_MODE` is still expanded by the workstation shell first and direct `oc exec -- exit 3` stays the
real missing-binary 127. `oc describe deployment` shows only the Deployment controller's own
`ScalingReplicaSet` series — one `Scaled up replica set <rs> to <n>` per rollout ReplicaSet and
`Scaled down replica set <old> to 0 from <n>` when a ReplicaSet is retired, at the real rollout time
(no more ReplicaSet `SuccessfulCreate` rows and no `Scaled up` event named after a ReplicaSet that
did not exist yet) — and `oc adm top nodes` is sorted by NAME with a realistically busy control
plane and per-node worker variance. The game stays no-build and dependency-free.

### Added

- **kubectl-style `oc describe` container and volume rendering (issues #64/#65).** Both
  `oc describe deployment` and `oc describe pod` expand env `valueFrom` entries into kubectl's
  text: secret and ConfigMap key refs print `<set to the key 'DB_PASS' in secret 'db'>  Optional: false` and
  `<set to the key 'APP_LOG' of config map 'cfg'>  Optional: false`, fieldRef entries print the
  resolved value plus `(<apiVersion>:<fieldPath>)` and resourceFieldRef entries the resource name —
  never the raw JSON object. Liveness/Readiness/Startup probes print in kubectl's order and format
  (`Readiness:  http-get http://:8080/ delay=2s timeout=1s period=10s #success=1 #failure=3`,
  `tcp-socket :PORT`, `exec [… cmds]`) with the API-server defaults for unset timing fields.
  `Volumes:` renders kubectl's `Type:`/`Name:`/`Optional:` field blocks for configMap, secret,
  emptyDir, PVC, hostPath, NFS, projected, downwardAPI, CSI and unknown sources, aligned per volume
  — including the injected `kube-api-access-*` projected service-account volume, whose
  `TokenExpirationSeconds:`, `ConfigMapName:` and `DownwardAPI:` fields now print. Annotations print
  as sorted multiline `key: value` pairs (labels stay `key=value`, long or multiline values move to
  continuation lines, and `kubectl.kubernetes.io/last-applied-configuration` is hidden).
- **`oc exec`/`oc rsh -- sh -c '<script>'` runs a container shell (issues #64/#65).** Single-quoted
  script text reaches the container's shell untouched and is expanded there from the container
  environment, so `sh -c 'echo $DB_PASS $APP_MODE'` prints `s3cr3t prod` and
  `sh -c 'echo $HOSTNAME'` the pod name, while a double-quoted `$APP_MODE` is still expanded by the
  workstation shell first (empty in the container), exactly like real bash. The shell builtins
  `exit N`, `:`, `cd`, `export`, `unset` and assignments are recognised only inside the script —
  `sh -c "exit 3"; echo rc=$?` reports `command terminated with exit code 3` and the same line sees
  `rc=3`, while direct `oc exec -- exit 3` keeps the authentic missing-binary result (127) — and
  `;`/`&&`/`||`/pipes inside the script follow the real exit-status rules.
- **`oc set probe` numeric flags and `--open-tcp` pass-through (issue #64).**
  `--initial-delay-seconds`, `--period-seconds`, `--timeout-seconds`, `--success-threshold` and
  `--failure-threshold` are now honoured (the probe used to ignore them and force
  `initialDelaySeconds: 5`), and `--open-tcp` uses the same engine path as `--get-url` instead of a
  separate fallback. Real `oc` semantics: only the supplied fields change, an existing probe's
  handler is preserved, and unset timing/threshold fields get the API-server defaults (delay 0s,
  timeout 1s, period 10s, #success 1, #failure 3).

### Changed

- **`oc describe deployment` events are the Deployment controller's own series (issue #65).** The
  describe output no longer mixes in ReplicaSet-controller rows: real `oc describe deploy` shows only
  `ScalingReplicaSet` events recorded on the Deployment, and the engine now records one
  `Scaled up replica set <rs> to <n>` per rollout ReplicaSet plus
  `Scaled down replica set <old> to 0 from <n>` when the controller retires an old ReplicaSet — at
  the actual rollout time, so the newest event's age matches the newest ReplicaSet's AGE (the old
  event named the newest ReplicaSet but was timed before that ReplicaSet existed). Seeded and paused
  states reconstruct the same series synthetically. `SuccessfulCreate`/`FailedCreate` stay on the
  ReplicaSet: `oc describe rs` shows them and `oc get events --field-selector reason=FailedCreate`
  is unchanged.
- **`oc adm top nodes` is sorted and realistic (issue #65).** Rows are sorted by NAME, the
  control-plane node is now the busiest (several cores, with the ~8–12 Gi resident control-plane
  components and the greatest CPU%), and the worker rows carry deterministic per-node variance so no
  two workers print identical usage; the NAME/CPU(cores)/CPU%/MEMORY(bytes)/MEMORY% columns are
  unchanged.
- README and CONVERSION-SPEC describe the kubectl-style describe renderers, the `oc set probe`
  flags, the container `sh -c` shell and the sorted `oc adm top nodes` output (issues #64–#65); the
  verification report records the thirteenth QA pass.

### Fixed

- **`oc describe` printed raw `valueFrom` JSON and omitted probes (issue #64).** A secret-backed env
  showed `DB_PASS:  {"secretKeyRef":{"name":"db","key":"DB_PASS"}}` and readiness/liveness/startup
  probes did not appear at all; both now render the kubectl text above, with the probe line placed
  in kubectl's Limits → Requests → probes → Environment order.
- **`oc set probe --initial-delay-seconds` was ignored (issue #64).** The flag (and the other
  numeric probe flags) did not reach the API object: `-o jsonpath=…readinessProbe.initialDelaySeconds`
  showed the forced 5 instead of the requested value; it now shows the supplied value (2 in the
  issue's repro).
- **`sh -c 'echo $DB_PASS'` printed the variable literally (issue #64).** Single-quoted container
  scripts were not expanded, so a correct secret injection looked broken; the container shell now
  expands `$VAR`/`${VAR}`/`$?` from the container env, making the issue's `s3cr3t prod` and
  `$HOSTNAME` → pod name cases work.
- **`sh -c "exit 3"` reported a missing binary and `id -u` printed the whole identity line
  (issue #65).** `exit` is a shell builtin, not `/usr/bin/exit`, so the container shell now honours
  it with the real status (surfaced as `command terminated with exit code 3`, `$?` sees 3), and the
  `id` flags `-u`/`-g`/`-un`/`-gn`/`-G`/`-Gn` print bare IDs like coreutils while the plain `id`
  line is unchanged.
- **`oc describe deploy` leaked ReplicaSet events and mis-timed `ScalingReplicaSet` (issue #65).**
  `SuccessfulCreate` from replicaset-controller appeared under describe deploy, and the single
  scaling event named the newest ReplicaSet while carrying an age from before it existed; describe
  deploy now shows only the Deployment's own correctly-timed series (see Changed).
- **`oc describe` volumes and annotations did not match kubectl (issue #65).** A ConfigMap volume
  printed `cfg: Type: configMap` instead of `Type: ConfigMap (a volume populated by a ConfigMap)` +
  `Name:` + `Optional:`, and annotations printed `key=value` (label syntax) instead of sorted
  multiline `key: value`.
- **`oc adm top nodes` showed identical workers, an unsorted table and an idle control plane
  (issue #65).** `worker-0`/`worker-1` had the same 175m/418Mi, rows were not sorted by NAME and
  `master-0` sat at 70m/112Mi; the table now looks like a real metrics-server snapshot (master
  busiest, workers distinct) with the same columns.

### Tests

- New permanent `qa-issue64` browser-regression section (27 checks) covering every report item
  end-to-end: the issue's exact command sequence (new-project → deployment → secret/configmap env →
  readiness/liveness probes with `--initial-delay-seconds`), the secret/ConfigMap env placeholders,
  the readiness/liveness probe lines, no raw `valueFrom` JSON, the `--initial-delay-seconds=2`
  jsonpath, and the `sh -c` single-quote/double-quote env contracts plus `printenv`/`$HOSTNAME`.
- New permanent `qa-issue65` browser-regression section (32 checks) covering three rollouts → four
  ReplicaSets with one correctly-timed `Scaled up replica set <rs> to 1` row per ReplicaSet,
  `Scaled down replica set <old> to 0 from 1` rows for retired sets, no ReplicaSet-controller rows,
  annotation/label formats on `describe deploy` and `describe pod`, the aligned ConfigMap volume
  block, `exit 3`/`rc=3`, the full `id` line vs `id -u`/`-g`/`-un`, and the sorted, busy,
  non-identical `oc adm top nodes` rows.
- `scripts/verify.mjs` grew the matching §4h static-fidelity locks (10 checks) that drive the same
  GameEngine/SandboxMode/CommandBar fixture without a browser and fail the fast gate on any
  describe/probe/exec/events/metrics regression.
- Legacy #36/#43 assertions were corrected to the real describe-deploy event contract: the #36
  FailedCreate evidence is now read from `oc describe rs <newRS>` (and the
  `oc get events --field-selector reason=FailedCreate` output), `describe deploy` is asserted to
  stay free of ReplicaSet-controller rows, and #43 gained the same `randomFailureRate = 0`
  determinism guard as #61–#63.
- Static gate: **1084 checks, 0 failures, 0 warnings** (56 JS modules, 118 files); full
  browser suite: **1986 checks, 0 failures, 0 warnings** (1042 s,
  0 console/page errors, GO); `visual-qa --strict`: **PASS** (94 checks, 0 failures,
  31 informational warnings); see `docs/verification-report.md`.

## [1.10.0] — 2026-11-05

Twelfth QA pass on 1.9.0: closes the four P4 findings of the 1.9.0 CLI retest (issue #63) — three
in the shell/`oc exec` exit-status layer and one in the Lab 13 copy. The simulated workstation shell
now expands bash's `$?` / `${?}` special parameter: the CommandBar records every executed segment's
real numeric status (success 0, failed `oc` command 1, syntax error 2, and the remote status
returned by `oc exec`/`oc rsh`), keeps it across `;`/`&&`/`||` segments and terminal lines exactly
like a login shell, and expands it in unquoted and double-quoted words (never inside single quotes)
while keeping it out of `env`/`printenv`. Inside containers, `true`/`false` are now real coreutils
(`true` silent exit 0, `false` silent exit 1) instead of missing binaries, and a modelled command's
non-zero status is finally reported: `ls /nope` exits 2 (`ls: cannot access …` + `command
terminated with exit code 2`), `cat` on a missing file exits 1 and `grep` with no match exits 1, so
`&&` chains stop and `||` recovers for every failing modelled container command — not just the
existing 127 not-found case — and a pipeline's status is its last stage's status. Lab 13's
description and first hint no longer imply a default-deny policy is already seeded: a default-deny
policy is provided in `challenges/payments-networkpolicy.yaml`, and the learner applies it (or
writes their own) before adding the allow rules; `oc get netpol -n payments` is empty at start. The
game stays no-build and dependency-free.

### Added

- **`$?` / `${?}` in the simulated shell (issue #63).** `ShellTools.lastExitCode` now holds the
  numeric status of the last executed command and `expandShellVariables()` expands bash's special
  status parameter in unquoted and double-quoted words (single quotes keep it literal); it is a
  shell parameter, so `env`/`printenv`/`export` never list it. The issue's examples work as on a
  real workstation: `oc exec deploy/web -- nslookup web; echo rc=$?` prints `rc=1` when the exec
  fails, `export X=5; echo $X $?` prints `5 0`, and `$?` persists across terminal lines and engine
  resets (fresh shell = 0).
- **Container coreutils `true`/`false` (issue #63).** Every UBI image ships coreutils, so
  `oc exec`/`oc rsh` now model `true` as a silent exit 0 and `false` as a silent exit 1, surfaced by
  the exec/rsh surface as `command terminated with exit code 1` (with no fabricated OCI
  `executable file not found` error and no `command executed in …` line).
- **Real exit statuses from modelled container commands (issue #63).** `_execStage` reports the
  real status of the commands it models: `ls` on a missing path prints
  `ls: cannot access '<path>': No such file or directory` and exits 2, `cat` on a missing file exits
  1 and `grep` with no match is silent and exits 1. `oc exec`/`oc rsh` append the real
  `command terminated with exit code <N>` and return a failed result, so `&&` stops and `||`
  recovers for every such failure, exactly like the 127 not-found contract.

### Changed

- **The shell's exit status is one numeric, persistent model (issue #63).** Each executed segment
  records its status (`oc exec`/`oc rsh` return the remote status; other failures are 1; a syntax
  error is 2; success is 0), a skipped `&&`/`||` segment leaves it unchanged, and `_runSegment`
  reports a pipeline's last-stage status. This also preserves `grep`'s real exit 1 on no match (a
  failed shell status without a printed error), so `cmd | grep NOPE` stops a following `&&` and
  `echo $?` reads 1.
- **Lab 13 description and first hint (issue #63).** The description now reads "A default-deny
  policy is provided in `challenges/payments-networkpolicy.yaml`; apply it (or write your own),
  then add the allow rules." and the first hint starts with the provided policy apply step and
  states that no policy is applied to `payments` at start — matching `startingResources` (Project,
  Deployments, Services only) and the first objective ("Deny all ingress and egress…").
- README and CONVERSION-SPEC describe the `$?`/exit-status model, the container coreutils and real
  exit statuses, and the corrected Lab 13 copy (issues #63); the verification report records the
  twelfth QA pass.

### Fixed

- **`$?` was printed literally (issue #63).** The shell expanded `$NAME`/`${NAME}` but not the
  special `?` parameter, so `oc exec …; echo rc=$?` printed `rc=$?` and `echo $X $?` printed `5 $?`.
  Both now print the real status (`rc=1`, `5 0`) on the same line and on following lines.
- **`true`/`false` appeared to be missing binaries (issue #63).** `oc exec … -- false` no longer
  fails with the OCI `executable file not found in $PATH` error + exit 127; it is the real coreutil
  failure (exit 1).
- **Failing real commands looked like successes (issue #63).** `oc exec … -- ls /nope` printed only
  `ls: cannot access …` and the shell still saw success — a following `&&` ran. It now prints the
  real `command terminated with exit code 2`, exits 2 and stops the chain (`||` recovers); `cat` and
  `grep` failures likewise exit 1.
- **Lab 13 read as if its policy was already seeded (issue #63).** "You start from a seeded
  default-deny policy" is replaced with the provided-file/apply-it wording, so the description
  agrees with the empty `oc get netpol -n payments` at the start and with the first objective.

### Tests

- New permanent `qa-issue63` browser-regression section (28 checks) covering every report item
  end-to-end: same-line and cross-line `$?`/`${?}` (including the issue's `nslookup; echo rc=$?`
  shape), `export X=5; echo $X $?`, single-quote literal / double-quote expansion, `env` not
  listing `?`, container `true`/`false` + `||` recovery, `ls`/`cat`/`grep`/`rsh` real statuses with
  `&&`/`||` chaining, the preserved 127 not-found contract, and Lab 13's provided-policy
  description/hint, on-screen objectives panel and empty-netpol start state.
- `scripts/verify.mjs` grew the matching §4g static-fidelity locks (9 checks) that drive the same
  CommandBar fixture without a browser and fail the fast gate on any shell/exec/Lab 13 regression.
- Static gate: **1072 checks, 0 failures, 0 warnings** (56 JS modules, 118 files); full browser
  suite: **1921 checks, 0 failures, 0 warnings** (976 s,
  0 console/page errors, GO); `visual-qa --strict`: **PASS** (94 checks, 0 failures,
  30 informational warnings); see `docs/verification-report.md`.

## [1.9.0] — 2026-11-05

Eleventh QA pass on 1.8.0: closes the two open report items (#61–#62) from the 1.8.0 CLI retest.
The simulated cluster DNS is now NetworkPolicy-aware: `nslookup`, `dig` and the new `getent hosts`
run through the same egress check as `curl`'s name resolution (UDP/TCP 5353 to the `openshift-dns`
dns-default Pods), so after a default-deny egress policy all four diagnostics fail together with the
real timeout line and real exit statuses, and adding the lab-13 allow-DNS policy brings them back
together. `nslookup` applies the Pod's `/etc/resolv.conf` search list (bare `web` prints
`Name: web.<namespace>.svc.cluster.local`), `dig` gets its own real output format (`+short` prints
just the Service ClusterIP, `+search` opts into the search list, NXDOMAIN is dig's own status 0 and
a blocked DNS egress is status 9), and verbose `curl` only prints `Trying`/`Connected` in the real
order — never before a name resolves, never `Connected` on a failed connection. `oc exec`/`oc rsh`
are honest about unmodelled binaries: the OCI runtime reports `executable file not found in $PATH`,
the command terminates with exit code 127 and the result is a failure, so `&&` chains stop and `||`
recovery branches run. The Pod network is OpenShift's real `10.128.0.0/14` (each Pod gets an IP
inside its Node's `spec.podCIDR` `/23`, 10.128–10.131, never the kubeadm `10.244` range), the Pod
`/etc/hosts` is the kubelet-managed file with the Pod's own IP/name and no Service entries,
`oc get rolebinding -o wide` prints ServiceAccount subjects as `namespace/name`, `oc describe`'s
`Events: <none>` placeholder is tabwriter-aligned like kubectl, and the `openshift-dns/dns-default`
Service carries the real named targetPorts (`dns/UDP`, `dns-tcp/TCP`, `metrics/TCP`) while its
Endpoints stay 5353/5353/9154. The game stays no-build and dependency-free.

### Added

- **NetworkPolicy-aware cluster-DNS diagnostics (issue #61).** `nslookup`, `dig` and `getent hosts`
  run through `SimulationTick.canResolveDNS()` — the same check the traffic simulation uses for
  `curl`'s name resolution, i.e. egress from the Pod to the `openshift-dns` dns-default Pods on
  UDP/TCP 5353. Under default-deny egress plus a same-namespace allow policy they all report
  `;; connection timed out; no servers could be reached` and exit like the real binaries
  (nslookup 1, dig 9, getent hosts silent 2, surfaced by `oc exec` as
  `command terminated with exit code <N>`); adding the lab-13 allow-DNS rule (`port: 5353`)
  restores them together.
- **Real `dig` output (issue #61).** `dig <name>` prints the real dig header/QUESTION/ANSWER/SERVER
  sections and answers with the Service's stored `spec.clusterIP` (headless Services with the ready
  Pod IPs, ExternalName with its target); `+short` prints just the answer IP(s), `+search` applies
  the Pod's resolv.conf search list (`dig` itself defaults to no search); an unknown name is
  NXDOMAIN with dig's status 0 and a blocked DNS egress is status 9.
- **`getent hosts` (issues #61/#62).** Resolves `/etc/hosts` and cluster DNS through the same
  search list and NetworkPolicy check, prints glibc's `%-15s %s` layout (padded IP, canonical FQDN)
  and exits 2 silently when the name cannot be resolved; `getent passwd|group` read the image files.
- **Honest `oc exec`/`oc rsh` exit codes (issue #62).** Binaries the image does not model fail with
  the containerd/kubelet OCI wording (`exec: "<cmd>": executable file not found in $PATH`), print
  `command terminated with exit code 127` and return a failed command result, so `&&` stops and
  `||` recovers like real oc. Modelled binaries are matched by basename (`/bin/cat`) and
  `sh`/`bash` are real no-ops; existing commands keep their previous exit semantics.

### Changed

- **The Pod network is OpenShift's `10.128.0.0/14` (issue #62).** `SimulationTick._generatePodIP()`
  allocates the Pod IP inside the Pod's Node `spec.podCIDR` (`/23`, hostPrefix 23, host octet
  2–254, skipping addresses already assigned) and falls back to 10.128–10.131 when no Node/CIDR is
  known; the platform seeder, the scheduler and the incident binder all pass the Node through, so
  every `-o wide` IP and endpoint address is realistic and no `10.244.` remains in the runtime.
- **Pod `/etc/hosts` is the kubelet-managed file (issue #62).** `# Kubernetes-managed hosts file.`,
  the loopback/localnet `fe00::` lines and `<podIP>\t<podName>` — with no `172.30.0.1
kubernetes.default.svc` Service entry; `getent hosts` answers the Pod's own hostname from it.
- **`oc get rolebinding|clusterrolebinding -o wide` (issue #62).** SERVICEACCOUNTS prints
  `<subject.namespace>/<subject.name>` (`qa8/deployer`, `qa8/builder`) like `rbac.SubjectsStrings`,
  falling back to the binding namespace and never emitting a leading `/`; USERS/GROUPS are
  unchanged.
- **`oc describe` Events alignment (issue #62).** The `Events: <none>` placeholder is aligned to
  the same tabwriter column as the widest top-level `Label:` above it — `oc describe svc` now
  prints `Events:            <none>` (12 spaces), matching the real single-tabwriter describe.
- **`openshift-dns/dns-default` named targetPorts (issue #62).** The Service ports carry the real
  4.22 targetPort names (`dns`/`dns-tcp` on CoreDNS → 5353, `metrics` on the kube-rbac-proxy
  sidecar → 9154); `oc describe svc` prints `TargetPort: dns/UDP`, `dns-tcp/TCP`, `metrics/TCP`
  while the ready EndpointSlice ports stay 5353/5353/9154. Named targetPorts now resolve against
  the endpoint Pod's container ports in one shared helper used by describe, `oc get endpoints` and
  the traffic simulation.
- **`nslookup` applies the Pod search list (issues #61/#62).** Bare names expand through
  `<ns>.svc.cluster.local`, `svc.cluster.local` and `cluster.local` with `options ndots:5`, so
  `nslookup web` prints `Name:\tweb.<ns>.svc.cluster.local`; explicit FQDNs keep resolving as
  before.

### Fixed

- **DNS answers while egress is blocked (issue #61).** `nslookup`/`dig` no longer answer when the
  Pod cannot reach dns-default on 5353, and `dig` no longer returns the old fabricated
  `172.30.43.12`; every DNS tool reads the real Service ClusterIP and the real NetworkPolicy
  verdict.
- **curl verbose order (issue #61).** `curl -v` prints `Trying` only after the name resolved and
  `Connected` only when the request actually connected; a DNS failure prints the real
  `* Could not resolve host: …` + `curl: (6) …` with no Trying/Connected lines, so the diagnostic
  points at the DNS egress problem instead of a fake connection.
- **Unknown exec commands silently "succeeding" (issue #62).** `oc exec … -- foobar` no longer
  prints `(command executed in …)` / `exit code 0`; it fails with the real not-found OCI error and
  exit 127, so a following `&&` command does not run.
- **Old pod-network and kubelet details (issue #62).** 10.244 Pod IPs, the Service entry in
  `/etc/hosts`, bare service-account names in rolebinding `-o wide`, the one-column-short describe
  Events placeholder and numeric dns-default targetPorts are all replaced with the real 4.22
  shapes above.

### Tests

- New permanent `qa-issue61-62` browser-regression section (54 checks) covering every report item
  end-to-end — NetworkPolicy-blocked/restored nslookup/dig/getent/curl, DNS output formats and exit
  codes, exec not-found/exit-127 + `&&`/`||` chaining, the 10.128.0.0/14 pod network and Node
  podCIDR containment, the kubelet `/etc/hosts`, rolebinding-wide ServiceAccounts, describe Events
  alignment and the named dns-default targetPorts — plus updated #44/#59–#60 assertions.
- `scripts/verify.mjs` grew the matching §4f static-fidelity locks (16 checks) that fail the fast
  gate if any contract regresses without launching a browser.
- Static gate: **1063 checks, 0 failures, 0 warnings** (56 JS modules, 118 files); full browser
  suite: **1893 checks, 0 failures, 0 warnings** (971 s,
  0 console/page errors, GO); `visual-qa --strict`: **PASS** (94 checks, 0 failures,
  26 informational warnings); see `docs/verification-report.md`.

## [1.8.0] — 2026-11-05

Tenth QA pass on 1.7.0: closes the two open report items (#59–#60) from the 1.7.0 CLI playthrough.
The release gives the simulated API server a real Service data model: one defaulting helper assigns
the ClusterIP fields once at create on every creation path — the rich `Service` class,
`GameEngine.applyManifestObject` (`oc apply/create/replace -f`, `oc expose`), the `ClusterState`
seed of platform Services and project-template objects — and `oc get svc`, `-o yaml/json`,
`-o jsonpath={.spec.clusterIP}`, `oc describe svc`, cluster DNS `nslookup` and
`oc exec … curl http://<ClusterIP>:<port>` all read that same field, so the ClusterIP is no longer a
display value nothing else agrees with. Service status is exactly `{loadBalancer: {}}` for ClusterIP
Services (the real 4.22 subresource — no invented phase, conditions or endpoint counters), the
Endpoints view and `oc describe svc` share one canonical ready-endpoint resolver, and
`oc get endpoints` truncates the ENDPOINTS cell like kubectl. `oc describe svc` now reproduces the
real kubectl v1.30 tabwriter output (IP Family Policy/IP Families/IP/IPs, one
Port/TargetPort/Endpoints block per port, optional External IPs/External Name/LoadBalancer
Ingress/NodePort/HealthCheck NodePort/LoadBalancer Source Ranges, Session Affinity and Events last),
and cluster DNS resolves Service names to their own ClusterIP (headless Services to the ready Pod
IPs, ExternalName to its target) while unknown names get the real NXDOMAIN line instead of a
fabricated address. The CLI also stops fabricating kubelet detail for a never-bound Pod
(`oc describe pod` shows no Container ID/Image ID/State/Ready/Restart Count until the Pod is bound),
prints `<RoleRef.kind>/<RoleRef.name>` in the RoleBinding ROLE column, leaves `oc expose` with one
unnamed Service port like real oc, and makes `oc rollout status <deploy> --timeout=5s` on a stalled
rollout block and exit 1 with `error: timed out waiting for the condition`, so `&&` chains stop
(`;` still runs). The game stays no-build and dependency-free.

### Added

- **A real Service data model and API-server defaulting (issue #59).**
  `js/resources/NetworkResources.js` owns one `defaultServiceSpec()` helper that applies exactly the
  defaults the 4.22 kube-apiserver applies: every Service created through the rich class,
  `GameEngine.applyManifestObject` (`oc apply/create/replace -f`, `oc expose`), the `ClusterState`
  seed (platform Services included) and project-template objects gets `spec.clusterIP` (a unique
  `172.30.0.0/16` address; `None` for headless Services), `clusterIPs`, `ipFamilies: [IPv4]`,
  `ipFamilyPolicy: SingleStack`, `sessionAffinity: None`, `internalTrafficPolicy: Cluster` and port
  `protocol`/`targetPort` defaults once at create; updates and re-applies preserve the allocated
  clusterIP. `oc get svc`, `-o yaml/json`, `-o jsonpath={.spec.clusterIP}`, `oc describe svc`,
  cluster DNS and `oc exec … curl http://<ClusterIP>` all read that one field.
- **Real `oc describe svc` output (issue #59).** The describe is the real kubectl v1.30 shape:
  `IP Family Policy: SingleStack`, `IP Families: IPv4`, `IP:`/`IPs:`, one
  `Port:`/`TargetPort:`/`Endpoints:` block per port (`Port: <unset> 8080/TCP` for the unnamed port
  `oc expose deploy/web --port=8080` creates, like real oc), tabwriter-aligned columns,
  `Session Affinity: None`, External IPs/External Name/LoadBalancer Ingress/NodePort/HealthCheck
  NodePort/LoadBalancer Source Ranges only when set, and Events last. Endpoints come from the
  canonical ready-endpoint resolver, so they agree with `oc get endpoints`.
- **Real cluster-DNS answers for `nslookup` (issue #59).**
  `nslookup <svc>.<ns>.svc.cluster.local`/`.svc`/`<svc>.<ns>`/bare names resolve to the Service's
  own ClusterIP, headless Services resolve to all ready pod IPs, ExternalName resolves to its
  target, and an unknown name prints the real `** server can't find <name>: NXDOMAIN` line instead
  of a fabricated address. `oc exec … curl http://<ClusterIP>:<port>` routes through the same
  Service's ready endpoints.
- **Blocking `oc rollout status --timeout` (issue #60).** On a stalled rollout the command now
  blocks like real oc: it prints the Waiting line, ends with
  `error: timed out waiting for the condition` and exits 1, so a following `&&` command does not
  run (`;` still does). The simulation advances its cluster clock synchronously in 0.25 s steps up
  to the timeout (600 simulated-second cap, then the existing async watcher); a healthy rollout
  completes within the timeout and prints the waiting lines + `successfully rolled out`. The
  no-timeout behaviour is unchanged.

### Changed

- **Service status and the Endpoints view are canonical API shapes (issues #59/#60).** A ClusterIP
  Service's `status` is exactly `{loadBalancer: {}}` — the invented `phase`, `conditions`,
  `observedGeneration`, `readyEndpoints`, `totalEndpoints` and `endpoints[]` fields are gone. Ready
  endpoints have one source of truth (`ClusterState.getServiceEndpoints()`), mirrored into the
  internal `service.endpoints` bookkeeping; `oc get endpoints`, `oc describe svc` and the traffic
  simulation all read it, and the ENDPOINTS cell truncates like kubectl (first 3 `ip:port` pairs followed by ` + N more...`).
- **`oc expose` leaves a single unnamed Service port (issue #60).**
  `oc expose deploy/web --port=8080` now creates the same port shape real oc does, so the get table
  prints `8080/TCP` and describe prints `Port: <unset> 8080/TCP`.
- README and CONVERSION-SPEC describe the Service defaulting/single-source contract, the real
  describe-svc/endpoints/DNS output and the CLI fixes (issues #59–#60); the verification report
  records the tenth QA pass.

### Fixed

- **ClusterIP is no longer a display-only value (issue #59).** Previously `oc get svc` printed a
  hash-derived ClusterIP that nothing else agreed with and `oc expose` left `spec.clusterIP` empty
  (the apply path dropped the API defaults), so `-o jsonpath={.spec.clusterIP}` was empty, describe
  showed `IP: <none>`, `Endpoints: <none>` and `Session Affinity: undefined`, and
  `curl <ClusterIP>` returned 000. Now one allocation is stored on the object and every surface
  reads it.
- **`oc get svc -o yaml` no longer invents status (issue #59).** The fabricated
  `phase`/`conditions`/`readyEndpoints`/`totalEndpoints`/`endpoints[]` status fields are removed;
  YAML/JSON round-trips the real spec defaults plus `{loadBalancer: {}}`.
- **`oc describe svc` matches real kubectl output (issue #59).** Per-port
  Port/TargetPort/Endpoints blocks, `IP Family Policy`/`IP Families`/`IP`/`IPs`,
  `Session Affinity: None`, aligned columns and only-when-set optional lines; the platform
  `dns-default` Service describes with its real `dns`/`dns-tcp`/`metrics` ports and the
  pod-network `10.x:5353` endpoints.
- **Unscheduled-Pod describe is honest (issue #60).** A never-bound Pod now genuinely has no
  `status.containerStatuses`, so `oc describe pod` omits `Container ID:`, `Image ID:`, `State:`,
  `Ready:` and `Restart Count:` and shows only Image/Port/Host Port/Environment/Mounts/Conditions
  (`PodScheduled False`) plus the FailedScheduling event; bound/running Pods keep their real State
  Running/Ready True/restart-count block.
- **`oc get rolebinding` prints the role kind (issue #60).** The ROLE column is
  `<roleRef.kind>/<roleRef.name>` (`ClusterRole/admin`, `Role/edit`,
  `ClusterRole/system:deployer`), so Role vs ClusterRole is visible like real oc.
- **`oc rollout status --timeout` reports failure to the shell (issue #60).** A timed-out rollout
  now exits 1 for `&&`/`||` chaining instead of reporting success.

### Tests

- New permanent `qa-issue59-60` browser-regression section (41 checks) covering every report item
  (ClusterIP single source across get/jsonpath/describe/DNS/curl, Service status shape,
  describe-svc per-port format, endpoints truncation, rolebinding ROLE, unscheduled-Pod describe,
  blocking rollout timeout + shell exit status), plus updated #58 endpoint-truncation assertions.
  `scripts/verify.mjs` grew the matching §4e static-fidelity locks (16 checks) that fail the fast
  gate if any of those contracts regress without launching a browser.
- Static gate: **1046 checks, 0 failures, 0 warnings** (56 JS modules, 118 files); full browser
  suite: **1839 checks, 0 failures, 0 warnings** (982 s, 0 console/page errors, GO);
  `visual-qa --strict`: **PASS** (94 checks, 0 failures, 31 informational warnings);
  see `docs/verification-report.md`.

## [1.7.0] — 2026-11-05

Ninth QA pass on 1.6.0: closes the two open report items (#57–#58) from the 1.6.0 CLI playthrough.
The release makes the last container/platform-fidelity surfaces behave like a real 4.22 install: the
platform bootstrap seeds the real `openshift-dns/dns-default` (ClusterIP `172.30.0.10`) and
`openshift-ingress/router-internal-default` Services in every mode — including the paused pre-start
sandbox — so `oc get svc,endpoints -n openshift-dns` is the real DNS-troubleshooting check and lab 13
works; DNS Pods move to the pod network (`10.x`, `hostNetwork: false`) while `node-resolver` and the
router stay hostNetwork; both DNS DaemonSets carry the real `kubernetes.io/os=linux` template
nodeSelector and the router Pods the ingress-controller label docs select on; and
`oc exec … cat /etc/resolv.conf` prints the real cluster DNS contract. Unschedulable Pods now report
`0/1 Pending` (not `ContainerCreating`) with `Node: <none>` in `oc describe`, and FailedScheduling
retries use the real scheduler backoff so the event series read as realistic small counts over a
nonzero window instead of `(x167 over 0s)`. The release also accepts the kubectl empty-value
`oc adm taint node <n> key=:Effect` grammar and prints the full deterministic ReplicaSet name in the
paused pre-start `oc new-app` ScalingReplicaSet event. The game stays no-build and dependency-free.

### Added

- **Real platform Services in every mode (issue #58).** The platform bootstrap now seeds the two
  Services a real 4.22 install carries: `openshift-dns/dns-default` (ClusterIP `172.30.0.10`, ports
  `53/UDP`, `53/TCP`, `9154/TCP`) and `openshift-ingress/router-internal-default` (ClusterIP, ports
  `80/TCP`, `443/TCP`, `1936/TCP`), in every mode including the paused pre-start sandbox.
  `oc get svc -n openshift-dns` / `oc get svc -n openshift-ingress` return them,
  `oc get endpoints -n openshift-dns` lists the pod-network DNS Pod IPs on `5353`, and
  `oc get svc,endpoints -n openshift-dns` — the first check when DNS breaks after a NetworkPolicy
  change (lab 13) — works end to end. `oc exec <pod> -- cat /etc/resolv.conf` shows the matching
  cluster DNS contract: the `<project>.svc.cluster.local svc.cluster.local cluster.local` search
  domains, `nameserver 172.30.0.10` and `options ndots:5`.
- **Real DNS Pod networking and platform-pod detail (issue #58).** `dns-default` Pods now run on the
  pod network with `10.x` Pod IPs and `hostNetwork: false`; `node-resolver` and the router stay
  hostNetwork. Both DNS DaemonSet templates carry the real `kubernetes.io/os=linux` nodeSelector,
  shown in the `NODE SELECTOR` column of `oc get ds -n openshift-dns`, and router Pods carry
  `ingresscontroller.operator.openshift.io/deployment-ingresscontroller=default`, so the
  label-selected `oc delete pod -n openshift-ingress -l …` flow documented by Red Hat finds and
  deletes them (the Deployment controller heals them, as before).
- **Real scheduler retry backoff and event series (issue #57).** FailedScheduling retries follow the
  real kube-scheduler backoff (`podInitialBackoffDuration` 1 s, doubling, `podMaxBackoffDuration`
  10 s maximum) instead of recording one failed attempt per simulation tick, so `oc describe pod` /
  `oc get events` aggregate into realistic small counts over a nonzero window (e.g. `(x4 over 7s)`)
  instead of a zero-second burst such as `(x167 over 0s)`, and a failure series preserves its
  `firstTimestamp`. A Pod whose scheduling succeeds leaves the unschedulable queue — its retry state
  is discarded, so a later eviction/reschedule starts a fresh event series like a real cluster.

### Changed

- README and CONVERSION-SPEC describe the seeded platform Services, DNS Pod networking/nodeSelector/
  router label, the scheduler/Pending and `exec`/`resolv.conf` fidelity and the taint/new-app fixes
  (issues #57–#58); the verification report records the ninth QA pass.

### Fixed

- **Unschedulable Pods show `Pending`, not `ContainerCreating` (issue #57).** `oc get pod` prints
  `0/1 Pending` for every unbound Pod — an excess CPU request, both workers cordoned, or a recreated
  router Pod with no node available — matching the real API phase; `ContainerCreating` only appears
  once the Pod is bound to a node and the kubelet is pulling. `oc describe pod` prints `Node: <none>`
  for an unscheduled Pod instead of a derived worker, so the "Pod is Pending → describe →
  FailedScheduling" troubleshooting flow points at the scheduler, not at the image or volumes.
- **`oc adm taint` accepts the kubectl empty-value grammar (issue #58).**
  `oc adm taint node <node> <key>=:<Effect>` (e.g.
  `oc adm taint node master-0 node-role.kubernetes.io/master=:NoSchedule`) is parsed like real
  `kubectl` instead of returning `invalid taint spec`; the removal forms (`<key>-`,
  `<key>:<Effect>-`, `<key>=<value>:<Effect>-`) keep working.
- **Full ReplicaSet name in the paused `oc new-app` event (issue #58).** In the paused pre-start
  sandbox the `ScalingReplicaSet` event now prints the full deterministic
  `<name>-<10-char pod-template-hash>` ReplicaSet name instead of a truncated `pre-667`-style
  prefix, and after start the Deployment creates exactly that ReplicaSet, so
  `oc get rs` / `oc describe rs` match the event.

## [1.6.0] — 2026-11-05

Eighth QA pass on 1.5.0: closes the two open report items (#55–#56) from the 1.5.0 CLI playthrough.
The release makes the simulated platform behave like a real 4.22 install: the control-plane Node
carries its `node-role.kubernetes.io/master:NoSchedule` taint (application Pods spread over the
workers, DaemonSet Pods tolerate the taint and keep running on the master), and the platform
workloads are now owned by real controllers (`deployment.apps/router-default` + its ReplicaSet,
`daemonset.apps/dns-default`/`node-resolver` with one owned Pod per Node) instead of static objects.
It also fixes the collected output differences: OLM Manual upgrades show the real CSV `REPLACES`
chain and roll the operator Deployment's pod template into a new ReplicaSet, multi-kind `oc get`
prefixes virtual Endpoints (`endpoints/<svc>`), `dns-default` reports the real two-container
`2/2` READY, and the stale "no endpoints available" Route-admission event/wording left over from
the #52 fix is gone. The game stays no-build and dependency-free.

### Added

- **Real control-plane taint and scheduler contract (issue #55A).** Every mode and campaign level
  seeds the control-plane Node with the real `node-role.kubernetes.io/master:NoSchedule` taint
  (derived from the machine's control-plane/master role labels when the Node object is created), so
  application workloads created with `oc new-app`, Deployments, Jobs and bare Pods schedule onto
  `worker-0`/`worker-1` and never onto `master-0`. The existing taint/toleration scheduler surfaces
  the real `FailedScheduling` message (`0/N nodes are available: N node(s) had untolerated
taint {node-role.kubernetes.io/master: …}`) when a workload cannot tolerate it, and the platform
  DaemonSet Pods (`dns-default`, `node-resolver`) carry the master/control-plane plus
  not-ready/unreachable tolerations so they keep running on the master. `Nodes` also register the
  real `kubernetes.io/os`/`kubernetes.io/arch` kubelet labels that platform workloads select on.
- **Controller-owned platform workloads (issue #55B).** `openshift-ingress` now contains a real
  `deployment.apps/router-default` (2/2 Ready) with one ReplicaSet and two router Pods that share
  its `pod-template-hash` and owner chain (Pod → ReplicaSet → Deployment). `openshift-dns` contains
  the real `daemonset.apps/dns-default` and `daemonset.apps/node-resolver`, each owning exactly one
  Pod per Node; the `dns-default` Pods run the real `dns` + `kube-rbac-proxy` containers and report
  READY `2/2`. `oc get deploy,rs -n openshift-ingress`, `oc get ds -n openshift-dns`,
  `oc describe deploy router-default` and `oc rollout status deployment/router-default` all work,
  Pod deletion is healed by the actual Deployment/DaemonSet controllers, the platform
  ServiceAccounts (`router`, `dns-default`, `node-resolver`) and the host-network SCC binding exist
  as on a real install, and the synchronous bootstrap keeps the platform healthy in the paused
  pre-start sandbox with no Pod churn or duplicates over long tick runs.
- **Real `oc adm taint` removal grammar (#55).** `oc adm taint node <node> <key>:<Effect>-`,
  `<key>=<value>:<Effect>-` and `<key>-` now remove the matching taint (the effect/value are parsed
  before matching); previously the effect stayed glued to the key comparison, so the command
  printed "untainted" without changing anything. The control-plane taint is never re-added by the
  tick loop.

### Changed

- **OLM Manual upgrades roll a new operator ReplicaSet (issue #56A/B).** A channel upgrade installs
  the new ClusterServiceVersion with the correct `spec.replaces` chain derived from the catalog
  channel's ordered entries (v1.17.0 replaces v1.16.0; a pinned v1.16.0 install records it replaces
  v1.15.0), so `oc get csv` shows the `REPLACES` column and `oc describe csv` prints the Replaces
  line. The upgrade also applies the new CSV's install strategy to the existing operator Deployment:
  the image moves to the new version, the immutable selector is preserved, and the Deployment
  controller rolls a NEW ReplicaSet/`pod-template-hash`/Pod while the old ReplicaSet is scaled to
  zero and kept for history.
- **Multi-kind `oc get` Endpoints prefix (issue #56).** `oc get pods,endpoints,route` (and any
  multi-type request that includes the virtual Endpoints view) prints the NAME cell as
  `endpoints/<service>` like the other kinds; the single-kind `oc get endpoints` table keeps the
  plain name, and `-A`, `-o name|yaml|json|jsonpath|custom-columns` and empty-section omission are
  unchanged.
- **Truthful Route admission output (issue #56).** A Route the router has not evaluated yet (e.g.
  after `oc expose` in the paused pre-start sandbox) no longer fabricates the removed #52
  `Warning ServiceUnavailable … not admitted: no endpoints available` event: the synthetic event
  table only prints the real `Admitted` condition, so the event appears as `Normal Admitted` once
  the simulation ticks. `oc status` reports `router default (not yet evaluated)` / `(Admitted)` /
  `(NOT admitted: <condition reason>)` instead of claiming missing endpoints block admission.

## [1.5.0] — 2026-11-05

Seventh QA pass on 1.4.0: closes the five open report items (#50–#54) from the 1.4.0 CLI playthrough.
The release gives the terminal a real shell layer (`;`/`&&`/`||` sequencing, session variables with
`export`/`$VAR`, loud rejection of unsupported shell grammar), makes Route admission follow the real
4.22 router (host/path ownership and TLS/external-certificate checks only — missing endpoints stay
Admitted and answer 503), makes the L20 capstone CrashLoop incident behave like a real bad rollout
(only the new revision crash-loops, surge/unavailable limits are respected, `oc rollout undo` heals),
teaches the real Manual `startingCSV` → next-step upgrade InstallPlan, and fixes the collected
output/state differences (settled authentication ClusterOperator, exact kubelet event stream,
`oc -n` flag errors, `curl -sI` headers, multi-name Subscription delete, exact debug-node resolution,
one node naming catalog across modes, populated platform namespaces/pods and the landing-page lab
count). The game stays no-build and dependency-free.

### Added

- **Real shell sequencing and variables (issue #50).** The terminal accepts `;`, `&&` and `||`
  chaining (quote/escape-aware; `&&`/`||` honour the previous segment's exit status), session
  variables (`export NS=default`, `$NS`/`${NS}` expansion in unquoted and double-quoted arguments,
  single quotes protected), `true`/`false`/`unset` builtins and bare `VAR=$(…)` assignment, so Red Hat
  doc one-liners such as `HOST=$(oc get route web -o jsonpath='{.spec.host}'); curl -k https://$HOST`
  run as written. Loops/conditionals/functions are rejected with a clear `simulator: … not supported
— run one command per line` message instead of silently dropping part of the line; `-f -` stdin,
  heredocs, `$(...)`, pipes and redirects keep working.
- **Route host-claim admission (issue #52).** The router models the OCP 4.22 `UniqueHost` admission
  plugin: the oldest Route for a host/path is admitted and later claims report `Admitted=False,
reason=HostAlreadyClaimed` with the real message; deleting the older claim admits the waiting Route.
  The real-target and external-certificate gates stay. A Route whose Service has no ready endpoints
  stays Admitted=True (the router answers 503 and `oc describe route` prints `Endpoints: <none>`), so
  the usual `oc get endpoints` → `oc describe svc` → selector debugging flow is taught correctly.
- **Manual `startingCSV` upgrade resolution (issue #53D).** OLM resolves the catalog graph
  immediately: `status.currentCSV` names the pinned CSV before the first InstallPlan is approved; a
  Manual subscription whose installed pin is older than the channel head immediately gets a second
  unapproved InstallPlan (`InstallPlanPending True RequiresApproval`, currentCSV=head,
  installedCSV=pin, phase UpgradePending); approving it upgrades the CSV (old CSV replaced, operator
  Deployment re-owned) to `Succeeded`. Automatic subscriptions auto-approve the upgrade, as real OLM
  does. `startingCSV`-pin grading (L18) is unchanged.
- **Populated platform namespaces (issue #53G).** Every cluster seeds the `openshift-dns` Project and
  the installer `openshift-config` Secrets (`pull-secret` kubernetes.io/dockerconfigjson and
  `initial-service-account-private-key` Opaque, both extractable), plus controller-owned platform Pods
  with the real kubelet lifecycle: two `openshift-ingress/router-default-*` Pods and one
  `openshift-dns/dns-default-*` + `node-resolver-*` Pod per Node. Lab 13's DNS-egress lesson and the
  first Route/OAuth debugging steps now target objects that actually exist.
- **One node catalog across every mode (issue #53F).** Sandbox, timed labs and Chaos now seed the same
  realistic machines as the campaign — `worker-0`, `worker-1`, `master-0`
  (`control-plane,master` roles; 2-node clusters use the two workers) — so hints, `oc get nodes`
  output and `oc debug node/<n>` muscle memory transfer between modes. `oc debug` resolves real node
  names exactly and only forward-maps legacy `node-N` campaign names; a wrong name returns the real
  NotFound instead of silently starting a debug Pod on another machine.
- **Real pod event stream (issue #54e).** The kubelet lifecycle stream is recorded once by the engine
  as `Scheduled → Pulling → Pulled → Created → Started` (`default-scheduler` FROM for scheduling,
  `kubelet` for container events, plus real `Failed`/`BackOff` warnings); the synthetic `Ready` and
  `PhaseChange` reasons are gone, so `oc describe pod`/`oc get events` match a real cluster.
- **Virtual Endpoints in multi-kind `oc get` (issue #52 follow-up).** `oc get pods,endpoints,route`
  and `-o name|yaml|json|jsonpath` work instead of failing with "the server doesn't have a resource
  type "endpoints"".

### Changed

- **L20 CrashLoopBackOff is a real bad rollout (issue #51).** The scheduled incident seeds the faulty
  `APP_MODE` into the Deployment and only the new revision's Pods crash-loop; the old ReplicaSet keeps
  its replicas Running/Ready and the Service keeps serving, with RollingUpdate
  maxSurge/maxUnavailable honoured. `oc rollout undo` (and `--to-revision=<n>`) now heals: it restores
  the previous template, scales the good ReplicaSet back up and the bad one to zero, and clears the
  incident.
- **Settled fresh cluster (issue #54f).** Re-seeding the baseline OAuth singleton no longer starts an
  OAuth rollout, so a fresh sandbox `oc get co` shows authentication `PROGRESSING False` like a real
  settled install; an actual identity-provider/htpasswd-Secret change still triggers the rollout.
- **OLM resolution failures (issue #54b).** A `ResolutionFailed`/`ConstraintsNotSatisfiable`
  Subscription no longer also reports a simulator-only `InstallPlanPending False NoInstallPlan`
  condition.
- **Landing copy (issue #54).** The start page stats line now says 13 timed labs (was 12), matching the
  mode card and "Thirteen timed labs" copy.
- **`oc exec … curl localhost:<port>` (issue #54d).** Requests to the Pod's own loopback/port hit the
  container's real app (origin-hello-openshift answers its real body) and generic bodies use the
  Pod's actual container name (`webapp`), never `main`.
- README and CONVERSION-SPEC describe the real shell layer, router admission, OLM upgrade
  resolution, the node catalog and the seeded platform namespaces.

### Fixed

- `oc -n` / `oc --namespace` with no value now print the real
  `error: flag needs an argument: 'n' in -n` / `error: flag needs an argument: --namespace` instead of
  an unknown-command error, including before `get`/`delete`/`logs`/… (issue #54).
- `curl -sI` (and `-I`/`-i`) print plain `HTTP/1.1 200 OK`/header lines — no verbose `< ` prefix and no
  body for `-I`; `-v` keeps the verbose `< ` format (issue #54).
- `oc delete sub a b -n openshift-operators` deletes every requested Subscription (one deleted line
  each), reports missing names like real `oc` and honours `--ignore-not-found`, while keeping the CSV
  uninstall semantics (issue #53E).
- The L20 "Create an external Route webapp (Admitted)" / "Route webapp is reachable" objectives no
  longer un-tick when an unrelated Service-selector incident breaks the endpoints; the reachability
  objective follows the router's 503/200 behaviour (issue #52).

### Tooling

- Permanent `qa-issue50-54` browser-regression section (151 assertions) covering every report item,
  plus updated expectations for the changed platform behaviour (node names, event stream, Route
  admission, OLM upgrade status, platform namespaces, 13 timed labs) and new `scripts/verify.mjs`
  static locks (11 default Projects incl. `openshift-dns`, the openshift-config bootstrap Secrets, the
  shared node catalog, absent `sandbox-node-`/`chaos-node-` literals, no Ready/PhaseChange kubelet
  reasons, 13-lab landing copy).

## [1.4.0] — 2026-11-05

Sixth QA pass on 1.3.0: closes the six open report items (#44–#49) from the 1.3.0 CLI playthrough.
The release restores the `oc -n <ns> <verb>` argument order that crashed every command (P1), makes
`kube-system/kubeadmin` store only a bcrypt hash the way a real install does, hardens OLM catalog
resolution (channel/`startingCSV` validation, the real Red Hat package name/channel, the Manual
approval condition, discoverable channel entries and AllNamespaces copied CSVs) and grades the L18
pin objective on state, and fixes the collected CLI output/behavior differences (new-build
ConfigChange builds, node-debug prompts and stopped-kubelet conditions, workstation internet/silent
`curl`, `oc new-app` container naming, ScalingReplicaSet events, `set env --list`, Job runtime,
describe indentation). The game stays no-build and dependency-free.

### Added

- **OLM channel entries and copied CSVs (issue #46).** `PackageManifest.status.channels[*].entries`
  now lists every pinnable CSV of a channel, so `oc describe packagemanifest` (new `Entries` block)
  and `oc get packagemanifest … -o jsonpath='{.status.channels[*].entries}'` are how a player
  discovers a valid `startingCSV`. AllNamespaces CSVs are projected into the other namespaces as
  real copied CSVs (status reason `Copied`, source phase mirrored, `olm.targetNamespaces`
  annotation stripped) and GC'd with their source, so `oc get csv -A` shows the operator watching
  every namespace.
- **Cross-level readiness evidence (issue #48).** EX280 Prep now credits a bullet from a matching
  successful command recorded in _any_ completed campaign level or timed lab, not only the level a
  bullet is mapped to; a matching command in an unfinished drill still counts as Practiced, and
  Sandbox/Chaos runs never inflate the verdict. The L20 secrets/networking bullets from the report
  are now evidenced by L20's own commands.
- **Workstation internet smoke test (issue #49).** `curl https://example.com` (and the other IANA
  example domains) now answers with the real Example Domain page and a trusted certificate, like an
  exam workstation with outbound connectivity; every other external host keeps the real
  `curl: (6) Could not resolve host` failure. Routes always win when a Route claims the host.

### Changed

- **L18 grades the pin on platform state (issue #48).** The "Pin the install with startingCSV"
  objective no longer demands the hard-coded `cert-manager-operator.v1.15.0`/`channel: stable`
  values: it ticks when the installed CSV equals the player's own `startingCSV` pin and that pin is
  a valid older entry of the channel rather than the channel head. Pinning v1.16.0 or v1.15.0 both
  count; pinning the head does not. The shipped `examples/subscription-manual-pinned.yaml` and the
  L18 hints use the real Red Hat package (`openshift-cert-manager-operator`, channel `stable-v1`,
  pinned v1.16.0).
- **kubeadmin is virtual and hash-only in-cluster (issues #45, #48).** The installer-side plain-text
  password (real `xxxxx-xxxxx-xxxxx-xxxxx` format) lives only in `~/auth/kubeadmin-password`;
  `kube-system/kubeadmin` stores just a genuine `$2a$10$…` bcrypt hash, so `oc extract
secret/kubeadmin -n kube-system --to=-` prints the hash and can no longer recover the password.
  kubeadmin and the simulator's `admin` are virtual identities with no User resources (a real 4.x
  `oc get users` never lists them; `oc delete user kubeadmin` is NotFound), and the docs/hints now
  teach the exam-relevant removal step, `oc delete secret kubeadmin -n kube-system` once another
  cluster-admin exists.
- **L1/L13/EX280/README copy and CONVERSION-SPEC** describe the hash-only Secret, the installer
  password file as the only recovery path, and the kubeadmin removal procedure.

### Fixed

- **Global flags before the `oc` verb (issue #44, P1).** `oc -n <ns> <verb>`, `oc --namespace=<ns>
<verb>` and every command copied from the Red Hat docs no longer fail with `error: internal command
failure: Assignment to constant variable.` — the global-flag hoisting now rewrites a mutable token
  array, and both flag positions work.
- **OLM resolution fidelity (issue #46).** A Subscription with a channel the catalog does not publish
  now fails resolution with the real `ResolutionFailed` condition/message (instead of silently doing
  nothing); `startingCSV` is validated against the channel entries and an unknown pin fails with
  "no operators found with name … in channel … of package …"; a Manual `installPlanApproval`
  reports `InstallPlanPending True RequiresApproval` (was inverted `False`); the catalog package is
  the real `openshift-cert-manager-operator` channel `stable-v1`; `oc get packagemanifests` prints
  the real `NAME CATALOG AGE` columns.
- **Lab 13 hint (issue #47).** With default-deny seeded in both directions, the hint now says the
  path needs **both** an egress rule on gateway **and** an ingress rule on ledger (it said "or"),
  which matches the behaviour the lab grades.
- **Collected CLI output/behavior differences (issue #49).** Route admission events now use the
  Route's `Admitted` condition reason/message (`ExternalCertificateValidationFailed` etc.) instead of
  a generic `no endpoints available`; `oc new-build` lets the ConfigChange trigger start `<name>-1`
  immediately (serial `start-build` queue unchanged); `oc debug node/x` shows the real `sh-5.1#`
  toolbox/host prompt (before and after `chroot /host`, plus `Pod IP:` and the "press enter" hint);
  a stopped kubelet makes Ready/MemoryPressure/DiskPressure/PIDPressure `Unknown` /
  `NodeStatusUnknown` / "Kubelet stopped posting node status." and NetworkUnavailable no longer
  contradicts itself (`False` / `RouteCreated` / "ovn-kube cleared kubelet-set NoRouteCreated");
  silent `curl` failures print nothing instead of `error: command failed`; `oc new-app
--image=… --name=database` names the container `database`; ScalingReplicaSet events carry the full
  ReplicaSet name and scale direction; `oc set env deploy --all --list` prints one header per
  container and no `<none>` placeholders; trivial one-shot Jobs (`perl -e "print 42"`, `sleep N`)
  complete with honest simulation runtimes instead of ~30 s; `oc describe alertmanager` aligns the
  Labels/Annotations value column at 14 like the real tabwriter output.

### Tooling

- Permanent `qa-issue44-49` browser-regression section covering every report item, plus updated
  assertions for the changed platform behaviour (new-build auto-start, node-debug prompts,
  hash-only kubeadmin secret, virtual users, OLM package naming/columns, copied CSVs,
  state-graded L18 pin, node conditions).
- `scripts/verify.mjs` seed checks now assert a fresh 4.22 cluster seeds **no** User resources
  (kubeadmin/admin are virtual) while keeping the cluster-admin ClusterRoleBinding subject check.

## [1.3.0] — 2026-11-04

Fifth QA pass on 1.2.0: closes the seven open report items (#37–#43) from the 1.2.0 CLI playthrough.
The release makes the capstone grade platform state instead of hidden object names, models the real
`tls.externalCertificate` Route admission gate, gives NotReady nodes real taints instead of a fake
cordon, adds service-account token mounts and the interactive `oc login` password prompt, honours
Linux label-selector semantics for namespaces, fixes the collected CLI-output differences and makes
the post-campaign handover honest about what a Developer Sandbox can do. The game stays no-build and
dependency-free.

### Added

- **Real namespace bootstrap (issue #43).** Every seeded and newly created project now carries the
  real `kube-root-ca.crt` (Kubernetes root-CA publishing) and `openshift-service-ca.crt`
  (service-ca `inject-cabundle`) ConfigMaps; the CA bundles are generated by the simulated CA so
  `oc extract … | openssl x509` parses them. `openshift.io/requester` now lives on the
  Namespace/Project, not on the default ServiceAccount, so `oc describe sa default` matches 4.22.
- **Service-account token in Pods (issue #42).** Every Pod (unless `automountServiceAccountToken:
false`) gets the real projected `kube-api-access-*` volume and read-only mount, so
  `oc exec … -- ls /var/run/secrets/kubernetes.io/serviceaccount` shows `token`, `ca.crt`,
  `namespace` and `service-ca.crt`, and the L16 “configure application access to the Kubernetes API”
  workflow works end to end.
- **Interactive `oc login` password prompt (issue #42).** `oc login -u kubeadmin` without `-p` now
  prompts for the password (masked input, empty line/Ctrl+C cancels, real 401 wording) instead of
  logging in silently; `-p`/`--token` are unchanged, and non-password simulator users keep the local
  convenience login, now explicitly marked as a simulator hint. The installer-side
  `~/auth/kubeadmin-password` file (plus `oc extract secret/kubeadmin -n kube-system --to=-`) makes
  the kubeadmin password discoverable; `~`/`$HOME` expand in shell file commands.
- **Real Route `tls.externalCertificate` admission (issue #39).** A Route that references an
  external certificate stays `Admitted=False` with reason `ExternalCertificateValidationFailed`
  (real aggregate message) until the `kubernetes.io/tls` Secret exists **and**
  `system:serviceaccount:openshift-ingress:router` can `get/list/watch` it; the fix is the real Role
  with `resourceNames` + RoleBinding. A new virtual manifest,
  `examples/route-external-cert-rbac.yaml`, ships that RBAC.
- **`oc new-build` / `oc new-app --image` ImageStream output (issue #42).** Both commands create and
  print the output ImageStream up front (`imagestream.image.openshift.io "X" created`) as real `oc`
  does; the `--follow` build log stream also covers queued serial builds.
- **Label-selector engine for `oc get -l` (issue #41).** Key-only existence, `!key`, `key in (…)`,
  `notin`, `=` and `!=` selectors are honoured for every `oc get`, and `--show-labels` renders the
  real labels. `openshift-ingress` now carries the real
  `policy-group.network.openshift.io/ingress=""` and `network.openshift.io/policy-group=ingress`
  labels, every namespace gets the automatic `kubernetes.io/metadata.name`, and NetworkPolicy
  `namespaceSelector` matching uses real LabelSelector semantics.
- **Workstation curl/openssl fidelity (issue #43).** `curl` gained real `-w/--write-out` expansion
  (`%{http_code}`, `%{url_effective}`, `%{remote_port}`, escapes), `-o`/`-s`/`-S`/`-i`/`-I`/`-k`/`-L`/
  `-m`, correct `/dev/null` handling and scheme-default ports; NetworkPolicy-dropped traffic now
  reports `curl: (28) Connection timed out after 30000 milliseconds` while genuine refusals stay
  `(7) … Connection refused` (also inside `oc exec … -- curl`). `openssl x509 -noout -enddate`
  prints `notAfter=`, and a leaf certificate's subject no longer gains an invented
  `O = shifting.pro`.
- **State-graded capstone (issue #37).** L20 now accepts **any** ResourceQuota / LimitRange in
  `prod-platform` and any NetworkPolicy that selects all Pods for Ingress with no allow rules — the
  hidden `compute-quota`/`resource-limits`/`default-deny` names are gone. The “Route reachable from
  the workstation” objective only ticks after an isolation policy plus a router-allow policy exist.

### Fixed

- **Capstone grading and readiness evidence (issues #37, #42).** L20 grades project state (above);
  completed L20/L17 work evidences the Job, CronJob and SCC EX280 bullets even on gated-bypass runs
  where the work was done via the panel or a heredoc (objectives feed the evidence snapshot).
  L17’s description no longer asks the player to create the shipped `priv-sa` ServiceAccount.
- **Lab 6 teaches a real command (issue #38).** `oc create limitrange` does not exist in `oc`/
  `kubectl`; the simulator now rejects it with the real unknown-subcommand error and the lab hint
  uses `oc apply -f examples/limitrange.yaml` (YAML heredoc alternative documented).
- **Node failure realism (issue #43).** A NotReady node is no longer falsely cordoned: it keeps
  `NotReady` in the STATUS column and receives the real `node.kubernetes.io/unreachable` /
  `not-ready` `NoSchedule`+`NoExecute` taints, cleared when the kubelet is restarted; `oc describe
node` renders the real five-column conditions table (TYPE/STATUS/LASTHEARTBEATTIME/
  LASTTRANSITIONTIME/REASON/MESSAGE) with real kubelet reasons, messages and heartbeat updates.
- **Builds and CrashLoop scenario (issue #42).** `oc start-build X` while `X-1` runs now creates the
  queued `X-2` (phase New) under the Serial run policy instead of erroring; the controller starts
  the oldest queued build when the BuildConfig is idle and never runs two at once. The
  CrashLoopBackOff log blames only the invalid `APP_MODE` value with a neutral image, so the fix is
  the env var rather than `oc set image`.
- **Collected CLI output differences (issue #43).** Multi-type `oc get deploy,pods` /
  `jobs,cronjobs` prints `deployment.apps/…` / `job.batch/…` name prefixes and omits empty types
  (one “No resources found” only when nothing matched); Pod/ReplicaSet names use a real 10-char
  `pod-template-hash` and 5-char pod suffix; `oc get secrets` sorts by name; `oc get events`
  aggregates as `(xN over <age-of-first>)` (no more `over 0s`); `oc describe quota` has no Events
  section; `oc rollout restart` prints `deployment.apps/x restarted`; `oc set env deploy --all
--list` works; the quota FailedCreate event appears once with the real `limited: pods=1` wording;
  `journalctl` prints the correct weekday and node hostname; `chroot /host` renders the real
  `sh-5.1#` prompt and `chroot /host <cmd>` executes the trailing command; the OAuth-rollout 401
  learning aid is marked as a simulator hint.
- **`oc new-app` pod labels (issue #42).** Pods created for an `oc new-app` Deployment carry the
  OpenShift `deployment=<name>` pod-template label, so `oc get pods -l deployment=<name>` works.
- **Handover screen (issue #40).** The post-campaign checklist now points the full-cluster redo
  (L13/L14/L17 need cluster-admin) at OpenShift Local (crc)/SNO including `crc console --credentials`
  for the kubeadmin password, and marks the Developer Sandbox as project-scoped only (L1–L11-style
  work) instead of suggesting it for work that would hit Forbidden.

## [1.2.0] — 2026-11-04

Fourth QA pass on 1.1.7 and the biggest platform-fidelity release since the conversion: closes the
ten open report items (#27–#36), including the three P1 blockers (incidents only healing after a
cluster write, the capstone node failure having no CLI fix, and destructive `oc` verbs falling
through to another project's namespace), and adds a workstation shell, a real monitoring/alerting
data model and a 13th timed lab. The game stays no-build and dependency-free.

### Added

- **Node troubleshooting from the CLI (issue #28).** `oc debug node/<name>` opens an interactive
  node session: `chroot /host`, `systemctl status|restart kubelet`, `journalctl -u kubelet [| tail]`
  and `exit`, plus the one-shot `oc debug node/x -- chroot /host <cmd>`. Restarting the kubelet is
  the state-driven fix for the capstone's NodeNotReady incident — the drawer action remains as a
  fallback. Nodes now have real names and roles (`worker-0`, `worker-1`, `master-0`; ROLES `worker`
  / `control-plane,master`) and a cordoned NotReady node prints `NotReady,SchedulingDisabled`.
- **Workstation shell tools (issue #32).** Real `base64 -d`/`-w0` (standalone, pipes, Secret
  decoding), `openssl req -x509`/`x509` with genuine PEM files that round-trip through
  `oc create secret tls` and `openssl x509`, `cut -c` in pipes, and a workstation-side `curl` that
  resolves Route hosts through the router (edge/passthrough/reencrypt, http→https redirect, DNS
  errors, NetworkPolicy reachability). `oc exec`/`oc rsh` now show the Pod's real volumes,
  ConfigMaps, Secrets and env, and fail correctly for CrashLoopBackOff/completed containers.
- **Service-ca and router networking (issue #33).** The service-ca controller issues Service serving
  certificates (`service.beta.openshift.io/serving-cert-secret-name`) and injects CA bundles
  (`inject-cabundle`), enabling the full serving-cert → reencrypt Route flow (also shipped as a new
  quick lab). A default-deny NetworkPolicy now really blocks a project's Route; the fix is an
  ingress policy admitting the router namespace (`policy-group.network.openshift.io/ingress: ""`),
  and the L20 capstone grades the end-to-end curl 503 → allow → curl 200 flow.
- **Monitoring and alerting (issue #34).** New non-placeable `PrometheusRule` and `Alertmanager`
  kinds, seeded rule sets and `alertmanager-main` (Service, reencrypt Route, two Running pods).
  Alerts are evaluated from live cluster state (Watchdog always fires; crash-looping/unready Pods
  surface their rule) and are inspectable with `oc get prometheusrules -A`,
  `oc describe prometheusrule` and `oc describe alertmanager main`.
- **Standard OpenShift templates (issue #34).** `httpd-example`, `mysql-persistent` and
  `postgresql-persistent` ship with real parameter lists and generator expressions, so
  `oc get templates -n openshift`, `oc process --parameters`, `oc process | oc apply -f -` and
  `oc new-app --template=… -p …` work like the exam expects.
- **New objective types and content (issues #30/#34).**
  - Behaviour-graded `networkPolicy` objectives (a default-deny, DNS 5353 egress and the
    frontend→backend allow/deny probes are evaluated through the NetworkPolicy engine, not names),
    `oauthProvider` (grade the resulting OAuth state), `password` (HTPasswd rotation with the OAuth
    rollout and a login latch on the rotated Secret), `identity`, `routeAccess`, `installPlan` and
    `subscription`, plus `user.exists:false`, `operator.namespace/allNamespaces` and a real
    login-history latch for login objectives.
  - **13th timed lab "Production Network Policies"**: payments namespace, gateway/ledger
    deployments; learners write the default-deny, DNS egress and gateway→ledger allow rules
    themselves — graded on observed traffic.
  - **L13 HTPasswd & Users** now requires the real password-rotation flow (`oc extract` →
    `htpasswd -B -b` → `oc set data secret/htpass-secret` → wait for the OAuth rollout → log in
    with the new password) and deleting a departing user **and** their Identity
    (`oc delete user bob` leaves `htpasswd:bob` behind).
  - **L18 Operators** adds the install variants: AllNamespaces install through the global
    OperatorGroup into `openshift-operators`, Manual `installPlanApproval` (`oc patch installplan …
'{"spec":{"approved":true}}'`), and a pinned `startingCSV`; lab 10 gains an AllNamespaces
    pipelines variant.
  - **L1's welcome card** no longer leads with the restricted-v2 nginx trap; the detailed
    admission-vs-runtime explanation moved to a troubleshooting hint on L3.
  - **Post-campaign handover**: "Finish campaign" now opens a closing screen with the run's results,
    weakest EX280 bullets and a persisted checklist to set up a real cluster (OpenShift Local /
    Developer Sandbox) and redo L5/L9/L13/L14/L17, instead of silently returning to the start page.
- **OpenShift project defaults (issue #35).** New projects get the real bootstrap objects:
  `builder`/`default`/`deployer` ServiceAccounts, dockercfg Secrets (shown under Image pull /
  Mountable secrets in `oc describe sa`), and the `admin` + `system:image-pullers/builders` +
  `system:deployers` RoleBindings. `openshift-authentication` now runs `oauth-openshift-*` pods, so
  OAuth changes genuinely require a rollout wait before login (L13 and lab 11 consistent).
- **Kustomize v5 examples and a kustomize engine refresh (issues #34/#36).** Shipped kustomizations
  use v5 `labels:` (with `includeSelectors`) and `patches:`; deprecated `commonLabels`/
  `patchesStrategicMerge` remain supported, `commonLabels` now correctly propagates into selectors,
  and `oc kustomize` output no longer starts with `---`.

### Fixed

- **Incidents only healed on a cluster write (issue #27).** A throttled state-reconciliation pass
  now runs on the simulation tick (pause-aware), so fixing a resource resolves its incident without
  an unrelated write; incidents with unresolvable/binding targets (quota) now heal from state and
  bind to the quota actually damaged; a state-driven SCC resolution no longer re-pends an already
  Running, admitted privileged Pod.
- **CLI write safety (issue #29).** Every write verb (delete/label/annotate/patch/scale/edit/rollout/
  set/expose/autoscale) is namespace-exact — no more silently modifying the same-named resource in
  another project; `oc create` on an existing object returns the real
  `Error from server (AlreadyExists)`; `oc delete pod -l/--all` works; `oc scale`/NotFound messages
  use the server form; re-applying an unchanged manifest prints `… unchanged` and no longer bumps
  `generation`; `oc describe <type>` with no name lists all objects (including quotas).
- **Collected CLI output fidelity (issue #36).** `ls` lists immediate children with plain names,
  redirects are silent, `--dry-run=client -o name` works, `uid` is a UUID and timestamps are
  second-precision, `get deploy -o wide` shows CONTAINERS/IMAGES, endpoints print address lists,
  image digests/istags are realistic (`@sha256:…`, internal-registry URLs, S2I command), Builds
  show real STARTED/DURATION/FROM, rollout undo produces revisions 2→3 and ImagePullBackOff rollout
  status uses the updated-replicas wording, passthrough Route PORT matches the backend, `describe
route` shows the real host/path, jsonpath handles unset fields/escaped dots, LoadBalancer ports
  show nodeports, quota describe columns line up, CronJob TIMEZONE is `<none>` and FailedCreate
  events appear in `describe deployment`.
- **Scenario realism (issue #31).** The L3/L20 CrashLoopBackOff is now caused by a seeded bad image
  plus `APP_MODE=debug-invalid` and only heals when that value is corrected (unrelated env changes
  and `rollout restart` no longer "fix" it); L19's JobDeadlineExceeded targets its own broken Job so
  the player's job completes and logs real output, completed Pods stay available for `oc logs`,
  Job STATUS is `Complete`/`Failed` and Pods are `Completed`; a new mysql image profile teaches the
  missing-`MYSQL_*` crash-loop with 3306/TCP; a compute quota without LimitRange forbids
  request-less pods; the L15 quota incident no longer creates a phantom Pending Pod or
  Used>Hard — the ReplicaSet reports the real `exceeded quota` event and raising the quota recovers.
- **State-based grading (issue #30).** Lab 9 is graded on observed NetworkPolicy behaviour (a
  hand-written equivalent gets full marks), lab 11 grades the resulting OAuth provider state
  (heredoc/`oc patch`/apply all count), login objectives latch on real login events (switching users
  does not untick them), lab 11's "User alice exists" waits for the real first login, and L2's label
  objective is namespace-correct.
- **OpenShift platform details (issue #35).** SCC verification is real: `who-can use scc` lists the
  granted `system:serviceaccount:<ns>:<sa>`, `scc-subject-review -f` reviews the file's pod spec,
  `add-scc-to-user` prints the 4.x `clusterrole…/system:openshift:scc:<name> added: "<sa>"` form,
  and SCC investigation commands now count toward incident progress. `add-role-to-group` uses the
  real `edit`/`edit-0` binding names; `oc set env --from=secret/…` creates per-key `valueFrom`
  entries and `--list` reports their source; `oc start-build --follow` streams and only reports
  success when the build completes; `oc get ns/projects --show-labels` has a LABELS column and
  ClusterResourceQuota selector matching understands `kubernetes.io/metadata.name`; `oc run
--overrides` is deep-merged through API/SCC admission and direct Pod creation is quota-admitted;
  `oc login -u kubeadmin -p …` validates the password when one is supplied; and `add-scc-to-user` /
  OAuth changes now honour the real rollout/validation ordering.

### Tests

- The durable browser suite grew from 685 to **1220 checks** in a full run, with seven
  new per-issue regression sections: `qa-incidents` (#27/#28), `qa-scenarios` (#31), `qa-cli`
  (#29/#36), `qa-workstation` (#32/#33), `qa-openshift` (#35), `qa-grading` (#30) and
  `qa-coverage` (#34). Every section passes standalone (`--only=…`).
- Static verification grew from 899 to **942 checks** (`node scripts/verify.mjs`),
  including the two new monitoring kinds and the 13-lab catalog.
- README, the conversion spec and the EX280 study guide updated for the 13 timed labs, the alerting
  model and the new workstation/node/shift-left content; the verification report was regenerated
  from a full-suite run, and the screenshots/OG card were re-captured.

## [1.1.7] — 2026-11-04

QA-retest follow-up on 1.1.6: closes the five new report items (#22–#26) — a timed-lab
soft-lock, lab-02 diagnostics fidelity, Helm 3 history/rollback semantics, the real
restricted-v2 `nginx` runtime model and the remaining CLI fidelity leftovers — and adds a
dev-only toolchain (Prettier + soft Knip + husky pre-commit gate) with a substantially larger
browser regression suite.

### Added

- **A dev-only toolchain; the game stays no-build and dependency-free.** Prettier 3 formats the
  whole repo; Knip 5 runs in "real garbage only" mode (dead files, unused/unlisted dependencies,
  unresolved imports and binaries are errors; unused-export/duplicate-export rules are off by
  design because the inline-HTML, `window.game` and browser-context API cannot be traced
  statically); husky 9 installs a pre-commit gate that blocks a commit on either check. The new
  `npm run format` / `format:check` / `knip` / `lint` scripts cover both gates,
  `scripts/knip-entrypoints.mjs` mirrors the inline HTML modules' imports so dead-file detection
  works, and `scripts/verify.mjs` now enforces the precise contract (private `package.json`,
  dev-only dependencies `prettier`/`knip`/`husky`, no runtime dependencies, no bundler/build config,
  `node_modules/` untracked, hook contents and entry-mirror coverage) instead of banning a manifest
  outright. See README → Development tooling.
- **Browser regression coverage grew from 566 to 685 checks:** timed lab 02 end-to-end plus its
  diagnostics, campaign L3/L20 incident gates, the nginx admitted-then-crash-looping model and the
  anyuid fix path, Helm history/rollback, `describe` fidelity and all the CLI leftovers below.

### Fixed

- **Timed lab 02 soft-lock** (issue #22): the uptime/cluster-health activation baseline is now
  captured at level start (`IncidentEngine.start()`/`reset()`) instead of lazily at the first
  objective evaluation, so the `triggerTime: 0` CrashLoopBackOff preload no longer counts against
  the learner and "Restore cluster health to at least 90%" ticks after the documented image fix.
  The same latent soft-lock on campaign L10 (a level with no incident plan) falls back to the plain
  health check. Regression coverage completes lab 02 end to end (4/4 objectives, health ≥ 90,
  3/3 Ready) and asserts the campaign L3 `clusterHealth` and L20 `resolve` gates.
- **Lab 02 diagnostics fidelity** (issue #23): `oc describe pod` prints the live Pod spec image
  (not a stale preload image), a real scheduled `Node:` (`name/ip`, never `<none>/<none>`) and no
  longer leaks simulator-internal `openshiftgames*` annotations — they are also scrubbed from
  `-o yaml`/`-o json` while genuine annotations (e.g. `openshift.io/scc`) stay visible.
  `oc describe deployment` has a real `Pod Template:` (containers, image, env, limits) and a
  `NewReplicaSet: <hash> (<n>/<n> replicas created)` line, and its `Available`/`Progressing`
  conditions derive from real availability (`Available False MinimumReplicasUnavailable` while
  crash-looping, `True` once healthy). The 3D Deployment label no longer sticks on "Pending", and
  Pods damaged by a `triggerTime: 0` preload are bound to a real Node before the damage is applied.
- **Helm 3 history/rollback semantics** (issue #24): only the latest revision is `deployed` and
  older revisions are `superseded`; a rollback to revision N re-deploys **revision N's chart and
  values** (the drill's `web` rolls back to `nginx-15.0.0`); the `CHART` column has no repository
  prefix and `APP VERSION` matches the chart (`1.25.3`); `helm install`/`upgrade` print the real
  NAME/LAST DEPLOYED/NAMESPACE/STATUS/REVISION/TEST SUITE shape with no `CHART:` line, and
  `helm list` matches the deployed revision.
- **`nginx:latest` under restricted-v2 is now the real runtime trap** (issue #25): SCC admission
  is spec-based again, so a bare `nginx:latest` Pod (no `securityContext`) is **admitted** under
  `restricted-v2` (`openshift.io/scc: restricted-v2`) and then crash-loops with
  `nginx: [emerg] mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)` in
  `oc logs`, growing restart counts and `BackOff` events. The documented
  `oc create sa` → `oc adm policy add-scc-to-user anyuid -z` → `oc set serviceaccount` fix path
  re-admits the Pod under `anyuid` and it runs; an explicit `runAsUser: 0`/`privileged` spec still
  gets a ReplicaSet `FailedCreate` with no Pod. L1 campaign copy teaches the corrected symptom.
- **CLI fidelity leftovers** (issue #26): `oc exec`/`oc rsh` print the
  `Defaulting container name` hint only for multi-container Pods; `htpasswd` prints the real
  `Adding`/`Updating`/`Deleting password for user …` messages and honours `-c`/`-b`/`-D` semantics;
  repeated `FailedCreate` retries aggregate into one Event row with an `(x10 over 1m)` LAST SEEN
  suffix while `--field-selector` still filters; a minimal `sed` (`-n A,Bp`, `s///`, inside
  `oc … | sed …` pipes and on virtual files) exists in the shell; `oc rollout status` on a rollout
  whose new ReplicaSet is in `ImagePullBackOff` reports the
  `… of … updated replicas are available…` line instead of the old-replica-termination one;
  image-pull failure tokens are matched anywhere in the tag (`:v9-nope` now fails and recovers to
  `:latest`, which still pulls); and OLM resolves per namespace, so an unresolvable package makes
  **every** Subscription in that namespace report `ResolutionFailed/ConstraintsNotSatisfiable`
  with no CSV/InstallPlan, while a healthy namespace still installs.

### Tests

- `npx prettier --check .` — 0 unformatted files; `npx knip` — 0 issues (dev-only toolchain).
- `node scripts/verify.mjs` — **899 static checks**, 0 failures, 0 warnings (54 JS modules,
  116 files).
- `node scripts/browser-test.mjs` — **685 headless-browser checks**, 0 failures, 0 warnings,
  0 console/page errors; verdict GO.
- `node scripts/visual-qa.mjs --strict` — PASS, 96 checks, 0 failures (28 pre-existing
  informational heuristics).
- Per-issue headless repros for #22–#26 re-run green; the permanent browser suite now carries
  their acceptance coverage.

---

## [1.1.6] — 2026-11-04

QA-retest follow-up on 1.1.5: closes the seven new report items (#15–#21) — image-pull
versus crash-looping states, container naming, rollout-status races and `--timeout`,
OLM package fidelity, the remaining CLI gaps/output differences, the restricted-v2
`nginx:latest` trap, a capstone gate that requires resolution, stricter readiness
evidence, and a visible “paused” indicator while an overlay freezes the run.

### Added

- **A visible paused indicator.** Overlays that freeze the simulation (Files & Manifests —
  including when opened with `vim`, the level guide, EX280 Prep, the pause card) now show a
  `Paused · Files open` chip in the HUD, mirror the pause glyph/tooltip on the pause button and
  announce the state with `aria-live`. OLM installs and rollouts no longer look stuck when the
  run is paused (issue #20).
- `oc rollout status --timeout=<duration>` with the real
  `error: timed out waiting for the condition` failure (issue #17).
- `helm search repo [--versions]`, `oc set serviceaccount cronjob/...`, and `grep -A/-B/-C`
  context flags (attached and spaced) in the simulated shell (issue #19).
- The HUD/CLI now expose real Events: `oc get events --field-selector reason=FailedCreate`
  (and `type=Warning,reason=FailedCreate`) lists SCC-rejection events (issue #21).

### Changed

- **`oc create deployment` names containers like real `oc`** — after the image basename
  (`quay.io/openshift/origin-hello-openshift:latest` → `origin-hello-openshift`, `nginx:1.26` →
  `nginx`); `oc run` keeps the run name. `oc set image` now hard-fails on an unknown container
  (`error: unable to find container named "…"`) and never adds a container (issue #16).
- **`oc rollout status` waits for the controller** to observe the new generation: an immediate
  status after `oc set image` prints
  `Waiting for deployment "…" spec update to be observed by the deployment controller...` instead
  of a false “successfully rolled out” (issue #17).
- **OLM catalog now matches OCP 4.x docs:** the package is `metallb-operator`
  (CSV `metallb-operator.v0.14.9`); a Subscription for a package that is not in the catalog fails
  with `ResolutionFailed` / “no operators found in package …” and creates no InstallPlan/CSV/
  operator Deployment; the seeded Subscription no longer shows phantom
  `InstallPlanPending/RequiresApproval` conditions before the controller runs (issue #18).
- **`nginx:latest` is a real restricted-v2 trap:** the default restricted-v2 SCC rejects it
  (binds port 80 / runs as root) — a Deployment gets `ReplicaFailure/FailedCreate` and no Pod is
  ever created; a bare `oc run --image=nginx:latest` is Forbidden. Explicit non-root `runAsUser`,
  an `anyuid`/`privileged` grant, and the supported image
  `quay.io/openshift/origin-hello-openshift:latest` (now the palette/default workload image) are
  the escape hatches. L1 teaches the trap; a Failed pod can no longer satisfy the “run a
  Pod/Deployment” objectives (issue #20).
- **Readiness requires in-run evidence:** command evidence only counts inside the linked
  level/challenge run (`progress.drillCommandEvidence` scoped per drill); sandbox/chaos probing no
  longer inflates the verdict (all-levels-complete + sandbox probing stays 0/55 instead of 50/55);
  a completed level without its own commands is “Practiced”; the console bullet stays
  “Practiced · docs only” (issue #20).
- **Capstone completion requires resolving the incidents:** L20 now uses `resolve` objectives for
  the scheduled CrashLoopBackOff (60 s) and NodeNotReady (120 s) incidents, so finishing while
  either is still active is impossible (issue #20).
- **CLI output fidelity** (issue #21): `oc project -q` prints only the name; Routes from
  `oc expose svc` have an empty `spec.path`/PATH cell; login with no projects prints the real
  “You don't have any projects…” message; `--dry-run=client -o yaml` omits `metadata.namespace`
  unless `-n` was given; `oc describe rs -l` supports label selectors; `oc get ns` uses
  `NAME STATUS AGE` while `oc get projects` keeps its project layout; a fresh HPA shows
  `TARGETS <unknown>/50%`; `oc exec … -- whoami` under restricted-v2 reports the missing user
  ID; `oc describe istag` NotFound for unknown streams; and
  `oc adm policy add-role-to-user view -z default` prints
  `clusterrole.rbac.authorization.k8s.io/view added: "default"`.
- **`htpasswd -B` writes bcrypt hashes** (`$2y$10$…`, fresh salt per call) and login verifies
  bcrypt, real `{SHA}` and legacy simulator entries; the extract → htpasswd → `oc set data` →
  login rotation flow works with `-B` (issue #21).
- CronJob hints/commands are container-agnostic where the deployment wasn’t created by
  `oc create deployment`; CrashLoopBackOff log annotations use the Pod’s actual container name.

### Fixed

- **Timed lab 02 no longer starts in ImagePullBackOff** (issue #15): the image is
  `quay.io/example/payments:v2-bad-config` (pulls, then crashes with exit code 1); the
  CrashLoopBackOff incident fires at `triggerTime: 0` and the crash log names the real image and
  exit code. `:broken` tags are still treated as unpullable — which is the point of the trap.
- **DNS policy auto-repair uses port 5353** (`dns-default`) instead of 53 (issue #20); the
  remaining port-53 mention in the NetworkPolicy explain text was corrected too.

### Tests

- `node scripts/verify.mjs` — 816 static checks, 0 failures (54 JS modules).
- `node scripts/browser-test.mjs` — 566 headless-browser checks, 0 failures, 0 console/page
  errors. New regression coverage: file-panel pause indicator (also for `vim`-opened panels),
  nginx:latest restricted-v2 rejection (no Pod, RS FailedCreate, Events field-selector), L1
  supported-image flow.
- Re-run of every round-1 and round-2 per-issue repro suite (nginx/OLM/rollout race/HPA-events,
  bcrypt/mixed-file identity, container naming/rollout timeout/grep/helm/output fidelity,
  lab-02/capstone/readiness, incident drawer/overlap) — all green.

---

## [1.1.5] — 2026-11-04

Exam-fidelity release: the open GitHub QA report (issues #1–#14), the terminal, RBAC/identity,
OLM and the incident/campaign flows now behave like a real OpenShift 4.22 cluster — and the
incidents drawer no longer covers the level brief or the view toolbar.

### Added

- **A simulated shell around `oc`** (issue #11): `vim`/`vi` (opens the Files editor), `cat`,
  `echo` with `>`/`>>` redirects, heredocs, command substitution (`$(openssl rand -hex 16)`),
  pipes through `grep`, `tail`, `head`, `wc`, `sort`, `openssl`, `htpasswd`, `skopeo`, plus
  `ls`/`cp`/`mv`/`rm`/`touch`. Terminal-authored YAML is immediately available to
  `oc apply -f` and in the Files panel. Only real `oc` commands get the automatic `oc`
  prefix now — `cat file` and `htpasswd …` run as shell commands instead of `oc cat`.
- **Missing oc surface for the exam** (issue #11): `oc policy add-role-to-user/-group`,
  `oc describe istag/<is>:<tag>`, `oc logs job/<name>`, `oc image info`, `skopeo inspect`,
  `oc create token`, `oc exec deploy/<name>`, `oc set serviceaccount cronjob/<name>`,
  `oc diff -f`, `oc autoscale`, `oc rsh`, `oc cp`, `oc wait`,
  `helm repo add/search` + `helm history/rollback` + `helm install repo/chart --version`,
  `jsonpath`/`custom-columns` on the previously table-only paths, `NAMESPACE` for
  `oc get csv -A`, and `<resource>.<group>` tokens (`deployment.apps`,
  `clusterrolebinding.rbac`, `route.route.openshift.io`).
- **Real OLM flow** (issue #9): OperatorGroup, InstallPlan and ClusterServiceVersion kinds (and
  `MetalLB`), a PackageManifest software catalog, `Subscription → InstallPlan → CSV` progression
  (CSV named after the package), correct uninstall (deleting a Subscription keeps the CSV; deleting
  the CSV removes the operands), and MetalLB operand pods + `EXTERNAL-IP` only after the MetalLB
  CR, IPAddressPool and L2Advertisement exist.
- **Evidence-based EX280 readiness verdict** (issue #14): a bullet counts only with drill evidence
  (a quick-lab check that actually passed, or a linked level/challenge completed after exercising
  the bullet's own commands); a completed level alone is "Practiced", and the web-console bullet is
  capped at "docs only". The coverage bar is red → amber → green.

### Changed

- **RBAC is enforced on every command** (issue #2): `oc get/describe/logs/events`, deletes and
  cross-project mutations return the real `Error from server (Forbidden): …` for users without the
  permission; plain users no longer see `openshift-*` projects; `oc auth can-i` and the command
  gate share one model; `-f/-k` objects go through per-object authorization.
- **OCP 4.x SCC grants** (issue #13): `oc adm policy add-scc-to-user/-to-group` create
  (Cluster)RoleBindings to `system:openshift:scc:<name>` and leave the SCC `users`/`groups` lists
  untouched; denied workloads surface as a ReplicaSet `FailedCreate` and **no Pod is created**;
  incident resolution and L17/C8 objectives are binding-aware and teach a dedicated ServiceAccount.
- **HTPasswd authentication** (issue #12) validates against the IdP-referenced `htpass-secret`
  Secret in `openshift-config`, not a local root `htpasswd` file; rotation is
  `oc extract` → `htpasswd` → `oc set data secret`; `oc delete user` no longer deletes the
  Identity (that is a separate `oc delete identity`).
- **`oc patch` honours `--type`** (issue #6): strategic merge (default) merges container lists by
  name so the image survives a securityContext patch; a patch that would leave a container without
  an image is rejected like a real API server and does not mutate the object; JSON merge and JSON
  patch types are supported.
- **`oc set volume`/`oc set volumes`** (issue #5) rewritten against the real `oc` flags
  (`--configmap-name`, `--secret-name`, `--claim-size`, `-m/--mount-path`, `--read-only`,
  `--default-mode`, `--overwrite`, `-c` globs, list mode) with the real validation messages;
  invented flags are rejected.
- **`--dry-run=client|server`** (issue #8) prints the manifest (`-o yaml|json|name`) and mutates
  nothing across create/apply/replace, `-f -` stdin, directories and `-k` overlays.
- **`oc expose deployment/x`** (issue #10) creates only a Service; the Route needs
  `oc expose svc/x` (or `oc create route …`), and `--service=x` without a name defaults to the
  service name; passthrough Routes no longer invent `path: /`.
- **Rollouts** (issue #7): a Deployment rolled to a non-existent image puts every new Pod into
  `ImagePullBackOff`, keeps the old ReplicaSet serving per `maxUnavailable`, marks the Deployment
  `ProgressDeadlineExceeded` and makes `oc rollout status` fail with
  `error: deployment "x" exceeded its progress deadline`; `oc rollout history/undo` use the real
  ReplicaSet revisions.
- **The incidents drawer no longer overlaps the mission card or the view toolbar.** While it is
  open, the objectives panel and the bottom toolbar (Auto-align / Reset view / Terminal / Files /
  YAML / EX280 / Help) slide to its right; on narrow viewports the drawer covers the mission card
  instead of colliding with it.
- **Campaign content follows the fixed command semantics**: hint commands across the campaign,
  timed labs and incidents were executed end-to-end and updated (OLM flow, SCC verification,
  `oc set volume`, patch types, expose/route, rollout, dry-run, DNS policy port 5353, L6/L8/L1/L10
  corrections).

### Fixed

- **Incident panel showed “0 active” and campaign levels soft-locked** (issue #1): `init()` is now
  idempotent (a level change/retry no longer appends a second panel with frozen HTML), the panel is
  the single ingestion path (`Resolved ([object Object])` gone), new incidents force the Active
  filter, and the panel reconciles with the engine on open.
- **Timed lab 02 soft-locked if the root cause was fixed before “investigating”** (issue #4):
  suggested commands resolve the real damaged Pod, `oc logs/describe` on any owned Pod advances the
  investigation, and resolving the incident implies investigation. Crash logs are per-Pod/per-image;
  healthy pods reject `--previous` with the real BadRequest; restart-until-green no longer counts as
  a fix.
- **Self-provisioner removal really disables project creation** (issue #3): the real default
  `self-provisioners` ClusterRoleBinding is seeded, removing the subject makes `oc new-project`
  return Forbidden, and `oc describe/patch clusterrolebinding self-provisioners` work.
- **CLI repairs auto-resolve incidents** (issue #1 follow-up): granting `view` to the damaged
  ServiceAccount in L14 and recreating/fixing the Job in L19 resolve their incidents and complete
  the objective.
- **Capstone can no longer be skipped** (issue #14): L20 completion is gated on the scheduled
  CrashLoopBackOff and NodeNotReady incidents; objectives are end-state evaluated, so removing a
  user from a group un-ticks the L14 objective.
- **Stale current project after a level change** (issue #14): cluster-scoped commands such as
  `oc create namespace X` no longer fail with the previous level's namespace `NotFound`.
- **CronJob invalid schedules, ghost ClusterResourceQuota limits, DNS egress port 53 and the
  un-evaluated NetworkPolicies** (issue #14): invalid cron strings are rejected and Jobs are not
  created immediately; ClusterResourceQuota hard limits match exactly what was asked for;
  NetworkPolicy evaluation now gates `oc exec … -- curl` with DNS via `dns-default` port 5353.
- **Landing page said “Continue · level 20” after the campaign was complete** (issue #14) — it now
  offers “Replay the campaign”.

### Tests

- `node scripts/verify.mjs` — 808 static checks, 0 failures.
- `node scripts/browser-test.mjs` — 552 headless-browser checks, 0 failures (menu, responsive,
  tutorial, CLI, incident panel, campaign, timed labs, EX280 Prep, Files, draw and regressions),
  plus per-issue repro scripts for every item above.

---

## [1.1.4] — 2026-11-04

Two interaction fixes: the cluster map now collapses on the first click, and restarting a level
(or retrying / advancing) lays the cluster out exactly like a fresh start.

### Fixed

- **The cluster map collapses on the first click.** The minimap card carried a fixed 140px inline
  height while the collapse handler only hid its canvas, so the first click removed the dots but
  left an empty 180×140 panel behind; only a later expand/collapse cycle shrank it. The card is now
  content-sized, and a single `_collapsed` state drives canvas visibility plus the `-`/`+` glyph,
  `aria-label` and `aria-expanded` together, so the very first click shrinks it to the header. This
  also removes the pre-existing 2px canvas clipping in the expanded card (180×142).
- **Restarting a level auto-aligns the cluster again.** Fresh launches ran the renderer's
  registry-derived auto-align after the mode seeded the cluster, but restart/retry/next-level
  rebuilt the cluster through `cluster.clear()` without it: the ~56 seeded OpenShift resources
  stacked on one random point and the level resources landed on a ring, so users had to press Auto
  Align by hand to recover the original layout. The post-launch layout is now a shared
  `_layoutClusterAfterModeStart()` step used by fresh launch, campaign/chaos/challenge restart, the
  game-over Retry action and Next Level; it re-creates any missing meshes, auto-aligns, refits the
  camera, syncs connections and records the final positions. On campaign level 1 the restarted
  layout matches a fresh launch exactly (58/58 unique positions, position-multiset delta 0.0000,
  camera within 0.002 units).
- Added a `regressions` section to `scripts/browser-test.mjs`
  (`node scripts/browser-test.mjs --only=regressions`) covering both: the first-click collapse and
  toggle state/anchoring, plus restart/next-level layout fidelity against the fresh-launch layout.

---

## [1.1.3] — 2026-11-04

Laptop-layout release: the open `oc` terminal dock and the view toolbar no longer bury the
campaign objectives panel on short laptop viewports (e.g. a MacBook 14" browser at 1512×900).

### Fixed

- **The objectives panel now reserves space for bottom docks.** Opening the terminal used to
  slide a 308px full-width dock over the bottom of the panel, hiding the hints and the “Show hint”
  button; because the panel was not overflowing it could not be scrolled, so the only workaround
  was closing the terminal. The panel's max-height is now dock-aware
  (`--bottom-ui` + `body.terminal-open` / `body.metrics-open`), so it ends above the view toolbar
  (which in turn sits above the terminal), and its body scrolls when the viewport is short. The
  same treatment applies to the metrics dashboard: it no longer covers the objectives panel, hints
  or palette when opened with the terminal closed. The slide-in inspector/incident side panels and
  the resource palette also stop above an open dock, so their last rows, footer and console tabs
  stay reachable.
- **The hint affordance stays in reach.** The mission hint section is now a fixed footer outside the
  scrolling objectives body, so “Show hint” remains visible on short viewports (the hint list
  scrolls internally and is height-capped while a dock is open so it never squeezes the objectives
  out), and a revealed hint scrolls itself into view instead of silently landing below the fold.
- Added a `campaign-level1-terminal-laptop` regression state to `scripts/visual-qa.mjs`
  (1512×900, campaign level 1 + open terminal) asserting the panel/toolbar/dock gaps, panel
  scrollability, hint-button hit target and palette clearance.

---

## [1.1.2] — 2026-11-04

External-review follow-up: real project-template flow, HTPasswd password rotation, and the
`oc extract` / `oc set data` / `oc create role` flag surface.

### Fixed

- **“Configure project templates” now teaches the real 4.22 flow** (objective tracker, cheat sheet and
  campaign level 15 drill): `oc adm create-bootstrap-project-template -o yaml > template.yaml` →
  add guardrail objects (e.g. a NetworkPolicy) → `oc create -f template.yaml -n openshift-config` →
  `oc edit project.config.openshift.io/cluster` (`spec.projectRequestTemplate.name: project-request`)
  → `oc new-project …` to verify inheritance. Removed the incorrect `oc edit template project-request`
  recipe and the “simulator does not model …” disclaimer.
- **“Modify user passwords” and the HTPasswd quick lab now use the documented rotation flow**:
  `oc extract secret/htpass-secret -n openshift-config --to /tmp --confirm` → `htpasswd -bB` →
  `oc set data secret/htpass-secret … --from-file=htpasswd=/tmp/htpasswd` → wait for the OAuth
  rollout → log in with the new password. The `--dry-run=client -o yaml | oc replace -f -`
  alternative is shown as one correctly piped command.
- **Cheat sheet additions**: `oc extract`, `oc set data`, a generic `oc edit` row with the `$EDITOR`
  (vi/vim) note for real clusters, `oc adm create-bootstrap-project-template`,
  `oc get templates -n openshift-config`, `oc edit project.config.openshift.io/cluster`, and
  `oc create role` with comma-separated `--verb`/`--resource` flags.
- **Campaign level 15** now includes project-template objectives (generate the bootstrap template,
  create `project-request` in `openshift-config`, point `project.config` at it) and matching hints,
  so the “Configure project templates” objective is genuinely drilled; README coverage row updated.

---

## [1.1.1] — 2026-11-04

Content-accuracy audit release. A read-only audit of the EX280 content and data (exam objectives,
campaign, quick labs, incidents, achievements, README/wiki facts) against the live redhat.com exam
page, the Red Hat LMS “Exam Objectives by Version” PDF and the OpenShift Container Platform 4.22
documentation. The only behaviour change in this release is the pause/`Esc` flow noted below.

### Fixed

- **`Esc` closes the topmost surface first** — command bar → Files/manifests → inspector / metrics / incidents / context menus → level or timed-lab select → Help → EX280 Prep, then the pause overlay; the 1.1.0 note that listed “panels → Files → help → EX280 → pause” predates the docked command bar and in-game panels and is superseded.
- **EX280V422 facts re-verified** — 9 objective groups / 55 bullets unchanged and byte-identical to
  the official list (exam page + LMS PDF, 2026-11-04); EX280V422 is still the current version and
  OCP 4.22 is still the current stable release (`4-stable` = 4.22.21; 4.23 is nightly/CI only).
  README now shows both official exam names instead of only one.
- **Per-bullet Red Hat docs links** — 17 bullets now link the 4.22 chapter that documents the task
  (projects chapter, HTPasswd identity-provider chapter, SCC chapter, jobs/CronJob chapter,
  MetalLB chapter, Operator user/administrator tasks) instead of only the guide index. All URLs
  return HTTP 200 on the exact 4.22 path.
- **Campaign → objective mapping is now generated from one source of truth** — every level’s
  `examObjectives` is the exact reverse of the per-bullet level mapping (24 asymmetric claims removed),
  and the README coverage table is derived from the same data instead of a hand-maintained summary.
- **Level 2 “label Deployment web with tier=frontend”** no longer auto-completes: the seeded
  Deployment no longer starts with the target label.
- **Level 17 SCC lesson corrected** — a privileged workload now requires granting the `privileged`
  SCC (not `anyuid`, which only allows arbitrary UIDs); description, objective label and hints fixed.
- **Real OCP 4.22 command/reference fixes** — the capstone NetworkPolicy hint no longer uses the
  nonexistent `oc create networkpolicy` (apply a YAML manifest instead); incident hints now use
  `oc events --types=…`, `oc adm policy who-can use scc <name>` and FQDN `nslookup`; the cheat sheet
  recommends `--cascade=orphan`; image-tag examples qualify `openshift/ruby:…`; the S2I builder tag
  is `nodejs:20-ubi9`; level 13 htpasswd hints use bcrypt (`-B`) and the documented `htpass-secret`
  name; the L9 hint explains the internal-registry image reference.
- **Quick labs** — HTPasswd lab uses `oc edit oauth cluster` (no unseeded `oauth.yaml`), quota lab
  applies `examples/limitrange.yaml`, operator lab installs the simulator-supported MetalLB package
  and checks the CSV, and the route lab no longer seeds a Project that its first step creates.
- **Incidents** — `RouteNotAdmitted` no longer lists “missing endpoints” as an admission cause;
  `CronJobMissedSchedule` no longer claims an invalid cron expression can exist on a CronJob;
  OLM guidance now says the **CSV** (not the Subscription) reports `Installing → Succeeded`;
  level 3 uses a valid image so the CrashLoopBackOff lesson is not mixed with ImagePullBackOff.
- **Achievements** — “EX280 Ready” renamed “Campaign Graduate” (completing levels is not exam
  readiness), “Say It With oc” is now unlockable from `commandsExecuted`, and the RBAC description
  matches its condition.
- **EX280 Prep copy** — the 55 items are called bullet points (matching the official structure), and
  the badge now reads “Exam-ready coverage” with a tooltip stating it measures tracked study
  coverage, not a Red Hat pass prediction.

## [1.1.0] — 2026-11-04

A presentation-and-feel release: a new start page, a rebuilt 3D cluster view, and an in-game design
system. Gameplay, the engine and the EX280 content are unchanged apart from the pause/`Esc` flow.

### Added

- **New start page** (`index.html`, `start.css`, `js/ui/StartMenu.js`) — a dark, editorial landing
  screen with the live Three.js cluster in the hero stage: banded mode launcher, interactive EX280
  objective→drill picker built from `js/data/EX280Objectives.js`, real product captures with a
  legible caption, and a light colophon crediting **K8s Games by Rohit** (Apache-2.0) as the original
  project. Native document scrolling, 390px responsive layout, `prefers-reduced-motion` support,
  keyboard-driven objective tabs and a progress-aware primary action (“Continue · level N”).
- **3D cluster-view overhaul** (`js/rendering/*`) — redesigned models for all 42 kinds, studio
  lighting (cool key, OpenShift-red rim, ground tier zones), compact auto-align layout, camera
  `fitToView()` with a cinematic intro, and a new screen-space label layer
  (`js/rendering/ResourceLabels.js`) with collision culling, priority LOD and status dots. The
  renderer boots as the menu showcase; the canvas lives inside the start-page hero and expands to
  full screen when a mode launches.
- **In-game design system** (`style.css`, `js/ui/*`) — flat surfaces separated by tone steps, single
  type family with tabular figures, one radius and one spacing scale. New HUD, mission/objectives
  card, palette with search and collapsible groups, docked `oc` terminal, redesigned campaign and
  timed-lab select, restyled inspector/files/metrics/EX280 Prep panels, and toast/feedback styling.
- `scripts/visual-qa.mjs` — repeatable screenshot + layout-audit matrix over the start page
  (5 viewports) and 14 in-game states, with console-error, overflow and clipping probes.
- `img/start/` — product captures used by the start page, and a redesigned OpenGraph card
  (`og-image.html`) generated by the browser suite.

### Changed

- **Documentation** — the learner-facing guides moved from `docs/` to the
  [GitHub wiki](https://github.com/G-man3207/openshiftgames/wiki): the
  [EX280 Study Guide](https://github.com/G-man3207/openshiftgames/wiki/EX280-Study-Guide) (exam
  expectations, version-sensitive facts, a 12-session plan, common traps) and the
  [EX280 Prep mode](https://github.com/G-man3207/openshiftgames/wiki/Exam-Prep) reference (tabs,
  quick labs, readiness rule and the full objective → game-content matrix). `docs/` now keeps the
  engineering records only: architecture map, conversion spec, declarative-engine guide, research
  notes, verification report and screenshots. The README links the wiki; `scripts/verify.mjs` checks
  the links.

- **Typeface** is now Schibsted Grotesk for UI and marketing surfaces (was Inter); JetBrains Mono is
  reserved for real terminal/YAML code.
- **`Esc`/`Space`/the HUD pause button now open a real pause overlay** (Resume, Restart level, Main
  menu with confirmation) instead of silently discarding the run or freezing the engine without
  pause. Pausing stops the mission clocks too (campaign elapsed time and timed-lab countdown), so the
  “clock is paused” promise is true. `H` still opens help, `?` EX280 Prep.
- **Auto-Align** now delegates to the renderer's layout, so resources and camera are fitted together.
- The start page owns the document scroll; the 3D canvas is reparented between the hero stage and the
  full-screen game view on launch and return.
- Start-page attribution is now enforced by `scripts/verify.mjs` through marker-delimited
  `upstream-attribution` regions (and a positive check that the homage exists).
- Browser suite: the UI suite asserts the new pause-overlay `Esc` behaviour.

### Fixed

- **`oc` fidelity (namespaces and auth)** — namespaced requests against a project that does not exist
  now fail like the real CLI (`Error from server (NotFound): namespaces "<ns>" not found`) across
  `get`/`describe`/`delete`/`apply -f`/`create`/`status`/`logs`, while cluster-scoped kinds and `-A`
  are unaffected. `-n` now re-targets `apply/create/replace -f` objects (including multi-document files
  and piped `-f -`) into the requested namespace. `oc login` failures use real `oc` wording
  (401 + "not known to the configured identity provider" / "Verify you have provided the correct
  credentials") instead of blaming HTPasswd, and failed logins never change the session.
  `oc get --raw /version` returns the server version JSON.
- **Every full-screen surface pauses the mission clock** — help (`H`), EX280 Prep (`?`) and the Files &
  Manifests panel (`F`) now freeze the campaign elapsed time and the timed-lab countdown, and resume
  exactly once when the last of them closes. `Esc` closes them in order (panels → Files → help → EX280
  → pause) instead of opening the pause card behind an open overlay; launch and quit clear all pause
  state.
- **A campaign session starts clean** — campaign and timed-lab levels now open with only their own
  working set (level starting resources + Nodes) instead of ~47 seeded platform objects. The seeded
  platform defaults are one click away behind a `Platform 47` HUD toggle and are dimmed when revealed;
  anything the current objective or an active incident references is auto-revealed. Sandbox and Chaos
  keep the full scene.
- **You can always find your own resources** — player-created resources carry a persistent red "yours"
  accent, are labelled with a stronger priority, and a `Mine N` HUD control emphasises/frames them
  (with an empty-state hint). Creating a resource gives a short pulse + gentle camera focus so a
  newcomer sees where it landed.

- **Platform version consistency** — a new `js/data/platformVersions.js` is the single source of truth
  for the emulated release (OCP 4.22.0, Kubernetes 1.35, CRI-O, RHCOS image and kernel). The pre-fork
  Kubernetes relic in the node model (`kubeletVersion v1.29.2`, `containerd://1.7.11`) is gone:
  `oc version`, `oc get nodes`, `oc describe node`, `oc get/describe clusteroperators` and the
  ClusterVersion singleton now agree. Node capacity/allocatable are kept in sync with the node spec
  and reported in real quantity units (`cpu: 16`, `allocatable cpu: 15750m`), including the pod limit.
- Level select no longer shows the start menu through a translucent backdrop.
- The “Built for a desktop” notice no longer covers the start page on phones; it appears only when a
  mode is launched at ≤900px, with “Continue anyway” and “Back to main menu”.
- Start-page mobile layout: no horizontal overflow, two-line hero headline at every width, nav action
  hidden at ≤700px, homage section full-bleed.
- 3D scene: unreadable sprite labels replaced; Auto-Align no longer forces the old single-row
  “starfield” layout; camera no longer leaves most of the cluster off-screen.
- `og-image.png` regenerated from the new card; `screenshot.png` and `docs/screenshots/*` regenerated.

## [1.0.1] — 2026-11-04

### Fixed

- Level tutorial no longer shows the “How to play” modal and the coach-mark card simultaneously
  (the card previously covered the modal’s dismiss button). Coach marks now start after the modal
  is dismissed.
- Coach-mark card no longer jumps sideways when clicking **Next**: the wrapper owns the centering
  transform, so the per-step entrance animation cannot translate the card by `-50%`.
- Removed full-viewport `box-shadow` animation from the cluster-view highlight (static ring
  instead) to stop repaint jank while the 3D canvas is highlighted.
- Added a 12-check `tutorial` regression section to the browser suite (437 checks total).

## [1.0.0] — 2026-11-03

Initial standalone release: a Kubernetes learning game converted into an OpenShift 4.22 / EX280
study game.

### Added — OpenShift platform model

- 42 first-class resource kinds with correct apiVersions and scope, including OpenShift-specific
  Project, Route, BuildConfig, Build, ImageStream, Template, Subscription (Operator),
  SecurityContextConstraints, ClusterResourceQuota, LimitRange, User, Group, Identity, OAuth,
  ClusterOperator, ClusterVersion, IPAddressPool and L2Advertisement.
- Central kind registry (`js/data/kindRegistry.js`) driving the palette, 3D renderer, `oc get`
  columns, aliases, defaults and the shared manifest serializer.
- Seeded OpenShift cluster state: default projects, ClusterOperators, ClusterVersion 4.22, SCCs,
  HTPasswd/OAuth identity, ImageStreams in the `openshift` project and a project-request Template.
- Simulation controllers: Project lifecycle, Route admission, BuildConfig→Build→ImageStream with
  image-change rollouts, OLM Subscriptions, MetalLB LoadBalancer IPs, SCC enforcement,
  LimitRange/ResourceQuota/ClusterResourceQuota, OAuth rollout and ClusterOperator health.

### Added — `oc` CLI and declarative workflows

- Full simulated `oc` terminal (`$ oc`), accepting `kubectl` as a documented alias, with pipes,
  output redirects, tab completion, help/explain and realistic tables/errors.
- Commands covering the EX280V422 surface: `login/logout/whoami/project/new-project`, `get`/`describe`
  with `-o yaml|json|wide|name|jsonpath|custom-columns|-l/--field-selector/--sort-by`, `apply -f/-k`,
  `create` (incl. routes, users/groups, quotas, limitranges, clusterquotas), `new-app`, `start-build`,
  `expose`, `set env|image|resources|probe|serviceaccount|triggers|volumes`, `rollout`, `adm policy`,
  `auth can-i`, `adm cordon/drain/taint/top`, `process`, `tag`, `import-image`, `helm`, `htpasswd`,
  `debug`, `must-gather` and more.
- Files panel with a virtual filesystem for manifests, Kustomize base/overlays (including
  `patchesStrategicMerge`, `images`, `replicas`, `commonLabels`, `namePrefix`), OpenShift templates
  with parameter substitution, Helm chart rendering and an `htpasswd` file for identity labs.

### Added — EX280 curriculum and learning modes

- 20-level, 5-chapter EX280 campaign mapped to the official objective groups, ending in a production
  platform capstone.
- 12 timed EX280 labs (three-tier app, CrashLoopBackOff, edge TLS routes, Kustomize overlay, S2I,
  quota guardrail, RBAC onboarding, SCC, network isolation, operator install, HTPasswd onboarding,
  speed run).
- **EX280 Prep** mode: tracker for all 9 groups / **55 official EX280V422 bullets** with Red Hat
  docs links, level/challenge cross-links, 9 quick labs, searchable 109-command cheat sheet, exam
  facts and a readiness verdict.
- 36 OpenShift-oriented incidents (CrashLoopBackOff, ImagePullBackOff, SCCForbidden, RouteNotAdmitted,
  BuildFailed, quota/limitrange violations, OAuth failures, operator install failures, …) that
  actually mutate and heal cluster state, with real `oc` investigation steps.
- 44 OpenShift-themed achievements, XP/star progression, Architecture Advisor scoring and a study
  guide (`docs/EX280-STUDY-GUIDE.md`).

### Added — 3D experience and docs

- OpenShift-themed 3D cluster view: new meshes for all 42 kinds, Project floor zones, route/build/
  image/operator/RBAC/storage relationship graph, traffic particles, minimap and auto-layout.
- OpenShift Draw (`/draw`): registry-driven palette, diagramming, YAML/PNG export and share links.
- Rewritten `README.md`, in-app help/tutorials, `NOTICE` attribution, Open Graph card, screenshots,
  conversion specification, architecture map, and 4.22-based research references under `docs/`.

### Changed

- Complete rebrand from the upstream Kubernetes game to **shifting.pro** (UI, docs, metadata,
  storage keys with best-effort migration of legacy progress/settings, canonical links).
- Repository detached from the upstream project: fresh standalone git history, Apache-2.0 preserved,
  attribution retained in NOTICE/README.
- Replaced Kubernetes copy with OpenShift terminology throughout (Projects instead of Namespaces in
  the UX, Routes as the primary exposure object, `oc` as the taught CLI).

### Verification

- `node scripts/verify.mjs` — 0 failures; `node scripts/browser-test.mjs --all-levels` — 437/437
  checks across menu, sandbox, CLI, UI surfaces, all 20 campaign levels, all 12 labs, Files, EX280 Prep,
  Draw and responsive layouts.
  See `docs/verification-report.md`.
