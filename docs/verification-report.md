# Verification report — OpenShift Games v1.0.0

Date: 2026-11-03
Target: Red Hat OpenShift Container Platform **4.22** · Exam **EX280V422**
Repository state: standalone release (fresh history), branch `main`.

## Verdict

**GO for release.** Static verification and the full headless-browser suite pass with no failures.
Known limitations are documented at the end and are consistent with the simulator's non-goals
(no backend, no real cluster).

## Environment

| Item | Value |
|---|---|
| Node.js | v26.10.0 |
| Harness | `scripts/verify.mjs` (static, zero deps), `scripts/browser-test.mjs` (puppeteer-core in `/tmp/verify-tools`) |
| Browser | Google Chrome 156 headless, SwiftShader WebGL (`--use-angle=swiftshader`) |
| Server | Node static server on `127.0.0.1` (same semantics as Vercel static hosting) |
| Viewport | 1600×900 (`og-image.png` at 1200×630) |

## Static verification — `node scripts/verify.mjs`

```
Files checked: 45 JS modules, 79 total files
Checks passed: 696 · failures: 0 · warnings: 0
```

Coverage:

- **Syntax** — every `.js` module parses as an ES module.
- **Import graph** — all relative import targets exist and every named import resolves to an export.
- **Kind registry** — 42 kinds with apiVersion/scope; palette sections cover all 37 placeable kinds;
  every kind has a dedicated 3D mesh creator; index.html/draw.html palettes are registry-driven.
- **Campaign** — 20 levels / 5 chapters, all with examObjectives, docsLinks, starting/available
  resources, hints, star criteria; all objective types implemented in `ObjectiveEvaluator`
  (53 declared types); all referenced kinds and incident names exist; no `kubectl` copy.
- **Challenges** — 12 timed labs with valid objectives and incidents.
- **EX280 mapping** — 9 objective groups / **55 official V422 bullets**, each mapped to at least one
  level/challenge with a docs.redhat.com 4.22 URL.
- **Incidents** — 36 definitions, real `oc` investigation commands, resolution actions + descriptors;
  no `kubectl` in incident data.
- **Manifest engine** — YAML parser self-test (27 cases), all 19 default files parse, 18 YAML docs.
- **Branding/independence** — no non-attribution upstream references; no `kubectl` UI copy outside
  the documented alias; no legacy `Namespace` kind; LICENSE/NOTICE/README present; upstream links
  only in attribution context.

## Browser E2E — `node scripts/browser-test.mjs --all-levels`

```
Browser tests: 424 passed, 0 failed, 0 warnings · verdict: GO
```


| Area | Checks | Result |
|---|---|---|
| Menu / branding / meta / OG / GitHub badge / draw link / EX280 Prep entry / modals | 25+ | PASS |
| Sandbox boot: renderer + seeded OpenShift cluster (10 Projects, 13 ClusterOperators, 4 SCCs, 3 ImageStreams, 3 Nodes), palette of 37 placeable kinds, seeded meshes, inspector, metrics | 30+ | PASS |
| `oc` CLI suite — session, get/describe, projects, workloads, services/routes/TLS, configmaps/secrets, env/image/resources, RBAC/SCC, quotas/limitranges/clusterquotas, users/groups, builds→ImageStreams, subscriptions/operators, jobs/cronjobs, apply `-f`/`-k`, process pipes, HTPasswd+OAuth login, edit/editor | 100+ | PASS |
| Campaign levels 1–20 start with objectives/status; chapters, hints, docs links intact | 60+ | PASS |
| Timed labs 1–12 start with objectives | 24 | PASS |
| Files panel — 19 default files, edit/apply/apply -k, error handling, panel render | 20+ | PASS |
| EX280 Prep overlay — official 9 groups / 55 bullets, tabs, search, readiness, quick labs | 20+ | PASS |
| OpenShift Draw — palette, branding, OpenShift kinds, YAML/PNG export, share links | 10+ | PASS |
| UI surfaces — inspector 4 tabs, context menu actions, metrics, settings, keyboard shortcuts | 20+ | PASS |
| Console — no uncaught page errors; no unexpected console errors | 2 | PASS |

Screenshots captured (reviewed): `docs/screenshots/menu.png`, `sandbox.png`, `inspector.png`,
`campaign-level-1.png`, `campaign-level-20.png`, `files-panel.png`, `exam-prep.png`, `draw.png`.
Hero image `screenshot.png` (1600×900) and Open Graph card `og-image.png` (1200×630) regenerated.

## Manual content spot checks

- Route TLS modes, `oc create route edge|reencrypt|passthrough`, admission conditions, and
  `oc expose svc` behaviour checked against `docs/research/openshift-networking-security-storage.md`
  (OCP 4.22 docs / openshift-docs `enterprise-4.22`).
- Builds/ImageStreams, templates, OLM subscriptions, Kustomize/Helm and quota behaviour checked
  against `docs/research/openshift-workloads-builds.md`.
- Exam identity/version, 9 groups / 55 bullets and version-sensitive flags checked against
  `docs/research/exam-facts.json` (EX280V422, OCP 4.22, 3 h performance-based, persistence rule;
  passing score is unpublished and is not stated in the game).
- Attribution/trademark: NOTICE + README contain the K8s Games attribution and Red Hat
  non-affiliation/trademark statements; LICENSE remains Apache-2.0.

## Known limitations (accepted for v1)

- Simulator only: no real cluster/API server; commands are simulated, logs/exec/watch are snapshots.
- CDN dependencies (Three.js 0.152, Tailwind) require network access; WebGL is required for 3D.
- YAML parser supports a practical subset (no anchors/merge keys/custom tags); Kustomize supports
  the documented subset; Helm is a simplified local renderer; htpasswd hashes are simulated.
- GitHub stars badge request can be rate-limited (403) without affecting functionality.
- Passing score, certification validity and current DO280 outline are not published by Red Hat and
  are intentionally not invented in-game.

## Reproduce

```bash
node scripts/verify.mjs
node scripts/browser-test.mjs --all-levels   # requires puppeteer-core in /tmp/verify-tools
python3 -m http.server 8080                  # manual play: http://localhost:8080
```
