# Guidance QA findings (1.15.0)

While authoring and replaying the per-objective guidance for all 20 campaign levels, every level was
played in a real browser by a "confused newcomer": staying in `default`, reading the objective label
literally, skipping a prerequisite, fixing too early or too late. This file keeps what that pass found.
**Fixed** items shipped in 1.15.0; **Open** items were deliberately left alone (grading and simulator
behaviour is locked by the 22k-line browser suite, so each one deserves its own change and test).

## Fixed in 1.15.0

| Where                        | Problem                                                                                                                                                                                                           | Fix                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| every level                  | Lab project only in hint #1; right commands in `default` silently never ticked                                                                                                                                    | Mission-card project row, wrong-project objective notes, level text names the project   |
| terminal                     | `command` objectives matched the raw typed text, so leaving out the optional `oc ` never ticked (L15/L16)                                                                                                         | Unprefixed oc subcommands are recorded as `oc <line>`                                   |
| terminal                     | History arrows inverted (Up did nothing, Down recalled the newest)                                                                                                                                                | Up walks back, Down forward                                                             |
| L8                           | Files panel **Apply -f** on a Template only stores it; `oc process` alone only prints; nothing explained                                                                                                          | Files-panel tip + `template-not-processed` / `-not-applied` / `-wrong-parameters` notes |
| L8                           | `oc new-app -f <template-file>` did not count as processing + applying the template                                                                                                                               | `ManifestEngine.markTemplateApplied()`                                                  |
| L7, L11                      | ConfigMap/Secret objectives ticked from any project, then the next step failed with `not found`                                                                                                                   | `namespace` on the objective (graded in the lab project)                                |
| L19                          | Recreating the failed Job **before** t=15 s: the scheduled incident re-broke the NEW Job (stuck Active)                                                                                                           | `IncidentEngine._damageJob` leaves a replacement of the seeded Job alone                |
| L15                          | `ResourceQuotaExceeded` (t=20 s) bound to `openshift-monitoring` when the quota was created later: unsolvable                                                                                                     | `namespace: 'quota-lab'` on the incident                                                |
| L17                          | Incidents panel suggested `-z privileged-app` (the Deployment) instead of the ServiceAccount `priv-sa`                                                                                                            | Panel uses the incident's damaged subject                                               |
| L4                           | `oc get … --output yaml` / `--output=json` never ticked (misplaced regex group)                                                                                                                                   | Pattern fixed                                                                           |
| L5, L6                       | `oc apply --kustomize …` ticked the Kustomize objective but not the `oc apply -k` command objective                                                                                                               | Pattern accepts `-k` and `--kustomize`                                                  |
| L2                           | `oc -n <lab> get deployments`, `oc get all`, `oc get pods,deployments` did not tick "list Deployments"                                                                                                            | Pattern widened                                                                         |
| L12, L18, L20                | Hint said to edit `examples/subscription.yaml` but not `spec.channel`; the file ships `stable-2.6` (Ansible), MetalLB only has `stable` → silent `ResolutionFailed`                                               | Hints and how-tos set the channel                                                       |
| L10, L11, L15, L17, L19, L20 | Hints that described things that do not exist (a L10 "incident", `oc get route` "Admitted" column, FailedCreate event on `oc describe deployment`, Advisor gauge in the HUD, a non-existent `oc create job` flag) | Corrected                                                                               |
| UI                           | Raw backticks in hints, the level intro and achievement toasts; intro listed only 6 objectives                                                                                                                    | Rendered as code; all objectives listed                                                 |

## Open — grading (objective ticks when it should not, or not when it should)

| Level    | Finding                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L9       | "Build … reaches phase Complete" ticks when the Build is **created** (`evaluateBuild` falls back to `lastVersion > 0`), right after `oc new-app`, while `oc get builds` still says Running.                        |
| L9       | `command` objectives need the resource right after the verb (`oc -n x get is`, `oc get all` do not tick) yet tick on empty output or in the wrong project (`oc get is` at level start).                            |
| L10      | Completes with ONE command (`oc rollout undo deployment/api-server`: undo on a single revision bumps the generation → update ✔ + rollback ✔; uptime ✔ from the start).                                             |
| L10      | "Keep availability at 90%" can never turn red (`evaluateUptime` reads incident health; scaling to 0 or deleting the Deployment still reads 100).                                                                   |
| L11      | Any Secret named `web-tls` counts (type unchecked); L12 Route port is not checked (`--port=8443` still ticks "port name https").                                                                                   |
| L13      | `command` objective `htpasswd ` also matches `oc create secret … --from-file=htpasswd` (empty Secret) and then objective 2 stays stuck; objective 3 ticks from `oc create user alice` without a login.             |
| L14, L16 | Count-only RoleBinding objectives accept any non-bootstrap binding (e.g. the ServiceAccount binding that repairs the incident).                                                                                    |
| L15      | Objective 8 is graded by command regex only: ticks on `oc edit project.config…` even if nothing was saved, not when the same state is reached with `oc apply -f`.                                                  |
| L17      | `add-scc-to-group privileged system:serviceaccounts:<ns>` ticks everything although it also grants the `default` ServiceAccount (the description says not to).                                                     |
| L18      | Objective 3 ("delete Subscription + CSV") ticks after deleting the Subscription alone.                                                                                                                             |
| L18      | A re-created Subscription reuses a stale InstallPlan: no new Manual plan, head CSV installed despite `startingCSV`, objective 5 can never tick (workaround: `oc delete installplan --all -n openshift-operators`). |
| L20      | "Architecture Advisor ≥ 25" is already ticked at level start (score ≈ 54); the composite score ticks after ~14 of 18 objectives; "Complete a Build" ticks when the build **starts**.                               |
| L3       | Investigation / "inspect Pods" tick from commands that saw nothing (`oc get events` in `default`); the Incidents panel "0/4 investigated" uses a different matcher than the engine.                                |

## Open — simulator fidelity

- **Scope:** `oc describe deployment web-app` from `default` prints the `ops-lab` Deployment while `get`, `logs`
  and `set env` say NotFound (L3). `oc apply -k <overlay> -n default` overrides the overlay's namespace (L6) and
  `oc new-app -f F -n other` ignores `-n` (objects land in the current project).
- **Too lenient:** logged out, `oc get / run / create deployment` work and tick objectives, and
  `oc login --token=<anything>` logs in as kubeadmin (L1); `oc create deployment X` / `oc create job|cronjob`
  without `--image` succeed; `oc create service web`, `oc create subscription x`, `oc create networkpolicy x`
  (which satisfies L20's NetworkPolicy objective) exist although real `oc` has no such forms/subcommands;
  `{"spec":{"approved":"true"}}` (string) is accepted and ignored; `oc new-app <image> <repo>` (space instead of
  `~`) prints Success but creates no BuildConfig/Build; re-running `oc new-app` prints `created` again and starts
  another build.
- **Too strict / missing:** glued `-owide` / `-oyaml`, `oc logs -l <selector>`, `helm upgrade --install`,
  JSONPath filters `[?(@…)]`; `oc new-app --template=<name>` does not record the template for the L8 objective.
- **Incident side effects:** a fix made before a scheduled incident re-seeds its value is overwritten
  (L3 `APP_MODE` at t=10 s, L14 RoleBindings at t=25 s, L20 `APP_MODE` at t=60 s) — by design, but silent; the
  how-tos say to fix after the incident appears.
- **Cosmetic:** the incident-created Pod shows the toast "YOU CREATED Pod … red ring marks it as yours";
  `oc describe oauth cluster` prints `Mapping Method:claim`; interactive `oc debug node/…` gives no cue that the
  terminal is now inside a node shell (every later `oc` says `bash: oc: command not found` until `exit`).
- **Files panel / `oc edit`:** opening the Files panel pauses the simulation, incident and mission clocks
  ("Paused · Files open"), which makes `oc edit oauth cluster` look stuck. It is intentional (the panel freezes
  the run), but nothing in the `oc edit` output says so; the level-13/15 hints now do.

## Replaying guidance

`scripts/browser-test.mjs --only=qa-guidance-replay` starts each level, switches to the lab project the mission
card names, runs every `objective.how.run` / `how.check` through the real command bar (letting the simulation and
incident clocks run, waiting for scheduled incidents before their fix) and requires the level to complete.
Levels that need extra simulated time (operator installs, builds, the authentication-operator rollout) have
settle times in `SETTLE_BY_LEVEL`.
