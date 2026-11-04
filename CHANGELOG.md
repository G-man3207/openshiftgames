# Changelog

All notable changes to OpenShift Games are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/).

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

- Complete rebrand from the upstream Kubernetes game to **OpenShift Games** (UI, docs, metadata,
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
