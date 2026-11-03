# Changelog

All notable changes to OpenShift Games are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
aims to follow [Semantic Versioning](https://semver.org/).

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
