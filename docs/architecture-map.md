# K8s Games → OpenShift / EX280 Conversion: Architecture Map

**Status:** read-only code archaeology, audited 2026-11-03 against `main` @ `af5dbc1`
(`chore: edge cache headers + UA-deflect bots + agent-aware robots (#33)`). Working tree was clean.
**Scope:** every file in the repo except `.git/`, `LICENSE`, images.
**Purpose:** this document is the contract between parallel conversion workstreams. It answers, for every
feature you must convert: _where the code is, what shape the data has, what is wired to what, and what is
broken/lying_. Line numbers are from the audited commit; they will drift as edits land — treat them as
anchors, not eternal truth.

> **Companion documents — read both.**
>
> - `docs/CONVERSION-SPEC.md` (Team Lead) is the **authoritative build contract**: branding, target OCP
>   4.22 / EX280V422, mandatory `js/data/kindRegistry.js`, acceptance criteria, workstream ownership.
>   Where this map's _recommendations_ differ from the spec on scope/design, follow the spec.
> - This file is the **source-code archaeology** that the spec's workstreams build against: exact
>   files/lines, data schemas, dead code, and latent bugs.
> - Note: a concurrent workstream had already created `js/data/kindRegistry.js` (new untracked file) while
>   this map was being written. The fan-out list in §2.6/§8.6 is exactly what that registry must absorb.

> **Read this first — the five structural surprises**
>
> 1. There is **no base class for game modes and no `KIND_DEFAULTS` registry**. Kind metadata is
>    duplicated across **13+ hard-coded lists** (see §8.6/§11). Adding an OpenShift kind means touching
>    _many_ files, not one.
> 2. There are **three incompatible resource-creation paths**. The UI palette instantiates rich
>    subclasses (`new RESOURCE_CLASSES[kind]`); commands/modes/draw call `ClusterState.addResource()`,
>    which **downgrades everything to a plain `ResourceBase` and regenerates the UID**. Controllers in
>    `SimulationTick` also create plain `ResourceBase` children.
> 3. **Resource subclass `tick()` methods are dead code.** All simulation lives in `SimulationTick`;
>    nothing ever calls `resource.tick()`. Same for `getShape()`/`getColor()` (geometry is hard-coded in
>    `ResourceMeshes.CREATORS`). Classes like `PersistentVolumeClaim` therefore never bind.
> 4. The **command parser does not accept a `kubectl` prefix**, even though the prompt says `$ kubectl`
>    and every hint/incident step says "type `kubectl …`". You must type `get pods`, not `kubectl get pods`.
>    This is the single best argument for doing the `kubectl`→`oc` rename as an _accept-both-prefixes_
>    change rather than a string swap.
> 5. Several campaign levels are **mathematically unwinnable** with the shipped UI (see §6.6). Any content
>    conversion must fix the objective evaluator/data-path bugs, not just re-word the levels.

---

## 0. Repository facts and hard constraints

### 0.1 File inventory (all tracked source)

| File                                                               | Lines | Role                                                                                                                                                       |
| ------------------------------------------------------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                                                       | 1,988 | Game shell. 1,558-line inline `<script type="module">` (L429–L1986) = `K8sGamesApp` + app wiring. Loads all JS modules.                                    |
| `draw.html`                                                        | 1,046 | "K8s Draw" page. 761-line inline module (L284–L1044) = `K8sDraw`.                                                                                          |
| `js/engine/GameEngine.js`                                          |   920 | `EventBus`, `GameEngine` façade, command queue/handlers, game loop, objectives/achievements/notifications, save/load (unused).                             |
| `js/engine/ClusterState.js`                                        |   758 | In-memory cluster: resource maps/indices, relationships, queries, quota bookkeeping, `addResource` factory.                                                |
| `js/engine/SimulationTick.js`                                      |   981 | **All controllers**: scheduler, pod lifecycle, Deployments/RS, STS, DS, Jobs, CronJobs, HPA, Services, quota, chaos, metrics.                              |
| `js/engine/IncidentEngine.js`                                      |   553 | Incident lifecycle, scripted/random spawning, cascade rules, health, resolution XP.                                                                        |
| `js/engine/ScoringEngine.js`                                       |   821 | XP/levels, stars, campaign/challenge progress, Architecture Advisor (10 categories), achievements.                                                         |
| `js/resources/ResourceBase.js`                                     |   486 | Base resource model (metadata/spec/status, YAML, events, owner refs, clone).                                                                               |
| `js/resources/WorkloadResources.js`                                | 1,005 | `Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, CronJob`.                                                                                       |
| `js/resources/NetworkResources.js`                                 |   437 | `Service, Ingress, NetworkPolicy`.                                                                                                                         |
| `js/resources/ConfigResources.js`                                  |   233 | `ConfigMap, Secret`.                                                                                                                                       |
| `js/resources/StorageResources.js`                                 |   312 | `PersistentVolume, StorageClass, PersistentVolumeClaim`.                                                                                                   |
| `js/resources/ClusterResources.js`                                 |   691 | `Node, Namespace, HorizontalPodAutoscaler, ResourceQuota, PodDisruptionBudget`.                                                                            |
| `js/resources/RBACResources.js`                                    |   297 | `ServiceAccount, Role, ClusterRole, RoleBinding, ClusterRoleBinding`.                                                                                      |
| `js/ui/CommandBar.js`                                              | 1,231 | Terminal UI, tokenizer/aliases/completion, 16 commands, `kubectl explain` database.                                                                        |
| `js/ui/InspectorPanel.js`                                          |   504 | Right drawer, tabs Overview/YAML/Events/Describe, Edit button.                                                                                             |
| `js/ui/HUD.js`                                                     |   450 | Top bar (counters, CPU/MEM, timer, mode, XP, speed, alerts, GitHub badge).                                                                                 |
| `js/ui/ContextMenu.js`                                             |   250 | Right-click actions per kind.                                                                                                                              |
| `js/ui/IncidentPanel.js`                                           |   449 | Left drawer, incident cards, investigation-step matching, localStorage.                                                                                    |
| `js/ui/MetricsDashboard.js`                                        |   325 | Bottom charts CPU/Memory/Network/Pod count.                                                                                                                |
| `js/ui/Minimap.js`                                                 |   281 | Canvas minimap, `KIND_SIZES`.                                                                                                                              |
| `js/ui/SettingsPanel.js`                                           |   241 | In-game settings modal (second settings system).                                                                                                           |
| `js/rendering/ClusterRenderer.js`                                  |   753 | Three.js scene, camera/OrbitControls, picking, namespace planes, animation.                                                                                |
| `js/rendering/ResourceMeshes.js`                                   |   800 | Kind → Three.js mesh registry (`CREATORS`), status colors, label sprites.                                                                                  |
| `js/rendering/ConnectionLines.js`                                  |   199 | Animated dashed ownership/network curves.                                                                                                                  |
| `js/rendering/ParticleTraffic.js`                                  |   373 | GPU traffic particles — **installed but never fed routes** (see §8.4).                                                                                     |
| `js/modes/CampaignMode.js`                                         |   626 | 20-level campaign, **objective evaluator**, stars, hints, tutorials.                                                                                       |
| `js/modes/ChallengeMode.js`                                        |   688 | `CHALLENGES` data (10 timed scenarios), separate objective evaluator, timeout.                                                                             |
| `js/modes/ChaosMode.js`                                            |   281 | Endless survival, health decay, waves.                                                                                                                     |
| `js/modes/SandboxMode.js`                                          |   288 | Free build, architecture score loop, YAML export.                                                                                                          |
| `js/data/CampaignLevels.js`                                        |   613 | 20 level definitions + `CHAPTERS`.                                                                                                                         |
| `js/data/IncidentDefs.js`                                          |   722 | 34 incident definitions + categories + severity levels.                                                                                                    |
| `js/data/Achievements.js`                                          |   416 | 45 achievements as predicate closures.                                                                                                                     |
| `style.css`                                                        | 1,611 | All custom styling (menu, palette, HUD, tutorial, modals, responsive).                                                                                     |
| `vercel.json`                                                      |    92 | Static hosting: `/draw` + `/v/:version/js/:path*` rewrites, immutable versioned module cache, revalidating app code, long-lived image cache, bot redirect. |
| `og-image.html` / `og-image.png` / `screenshot.png` / `robots.txt` |     — | Web assets only. `og-image.html` is a standalone 1200×630 marketing render, not part of the app.                                                           |
| `README.md`                                                        |   101 | Marketing copy; several claims are stale (see §0.4) — **it is a conversion surface**.                                                                      |

Totals at audit: **16,984 JS lines across 31 JS modules**, **2 HTML entry points**, ~22k source
lines total (plus `docs/`, which did not exist at the audited commit — a concurrent workstream added
`js/data/kindRegistry.js` while this map was being written; see companion-docs note above).

### 0.2 Runtime constraints (do not break these without an explicit decision)

| Constraint                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                   | Consequence for conversion                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No build step, no bundler, no package.json, no node_modules** | No `package.json` in tree (`git ls-files`); README:11,95–97                                                                                                                                                                                                                                                                                                                                | Must stay plain ES modules served statically. New modules must be imported with relative paths + explicit `.js`.                                                                                                                                                                                                                                                                                                                                                               |
| **CDN dependencies**                                            | Tailwind `https://cdn.tailwindcss.com/3.4.1` (`index.html:23`, `draw.html:23`); Three.js r152 via import map `https://unpkg.com/three@0.152.0/...` (`index.html:70–78`, `draw.html:69–77`); Google Fonts (`index.html:20–22`)                                                                                                                                                              | Requires network at load. Offline/air-gapped demo or CSP-restricted hosting breaks. Tailwind CDN emits a console warning in production.                                                                                                                                                                                                                                                                                                                                        |
| **Import maps**                                                 | `index.html:70–78` and `draw.html:69–77` (each maps `"./js/"` → `"./v/<package.json version>/js/"` plus the pinned Three.js entries)                                                                                                                                                                                                                                                       | All `three` imports in `js/rendering/*.js` and every app-module import resolve through the page's import map — every entry HTML must keep it. The `./js/` mapping is the release version: bump it with `package.json` (verify.mjs fails on drift); `vercel.json` rewrites the `/v/` prefix to the real `/js/` tree (issue #68).                                                                                                                                                |
| **WebGL required**                                              | `index.html:1624–1630` creates a probe canvas and calls `_showWebGLError()` (L1716–1745) on capability failure; any other boot error shows `_showInitError()` (L1747–1782, issue #69 P3); `draw.html` has **no** guard, `init().catch(console.error)` only                                                                                                                                 | Conversion must preserve the guard (or replace renderer). Headless tests cannot import rendering modules without a WebGL stub. Keep the capability panel and the generic init-error panel separate — a JS error must never blame the GPU.                                                                                                                                                                                                                                      |
| **Static hosting via Vercel**                                   | `vercel.json:1–92`: `/draw`→`/draw.html` rewrite (L2–6) and `/v/:version/js/:path*`→`/js/:path*` (L7–10), `ignoreCommand` (L12), long-lived image/font cache (L14–22), immutable `/v/(.*)` module cache (L23–31) before revalidation for `/js/(.*)` (L32–40) + CSS (L41–49) + HTML (L50–58) + `/` (L59–67) + `/draw` (L68–76), UA-based redirect to `/robots.txt` for AI/SEO bots (L78–91) | Keep `/draw` route if the renamed page keeps that URL. **Release rule (issues #66/#68):** a release bumps `package.json` and both entry-page import maps together; the `/v/` prefix then serves the module graph immutable under URLs the previous release never populated, while the unversioned `/js/*` path stays revalidated as the direct-access fallback. Shell out to `scripts/dev-server.mjs` for local play — a plain static server cannot resolve the `/v/` rewrite. |
| **No tests, no CI, no `.github/`**                              | `git ls-files`; no test files                                                                                                                                                                                                                                                                                                                                                              | Conversion must add at minimum a Node-based smoke harness for pure modules (see Appendix B). Node ≥ 18 works: `node --input-type=module -e "import …"`.                                                                                                                                                                                                                                                                                                                        |
| **Global browser coupling**                                     | `window.game`, `document.getElementById`, `localStorage`, `requestAnimationFrame` everywhere                                                                                                                                                                                                                                                                                               | Pure model modules (`js/resources/*`, data) are testable in Node; UI/engine are not without DOM stubs.                                                                                                                                                                                                                                                                                                                                                                         |
| **License**                                                     | Apache-2.0 (`LICENSE`)                                                                                                                                                                                                                                                                                                                                                                     | Keep headers/attribution when forking.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 0.3 External services

- `index.html:1970–1985`: `fetch('https://api.github.com/repos/rohitg00/k8sgames')` to fill GitHub star
  counts in three places (`#github-star-count` L69, `#hud-github-stars` L148, `#game-github-stars` L147);
  silently `.catch(() => {})`. There is no other network I/O in the game.
- No analytics, no backend, no auth. Everything is client-side.

### 0.4 Reality vs README claims (fix these as part of conversion)

| README claim                                                | Reality                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "25 K8s resources … each has a unique 3D shape" (README:79) | 25 `ResourceBase` subclasses exist, but only **17 kinds have a 3D mesh** (`ResourceMeshes.CREATORS` L212–740); 8 kinds render as a grey fallback cube (`_createFallback` L756–778). The **game palette exposes 17** kinds (`index.html:173–323`), the **draw palette exposes 20** (`draw.html:83–260`). |
| "29 incidents" (README:81)                                  | **34** in `INCIDENT_DEFS` (`IncidentDefs.js:1–703`).                                                                                                                                                                                                                                                    |
| "40 achievements" (README:91)                               | **45** in `ACHIEVEMENTS` (`Achievements.js:1–378`).                                                                                                                                                                                                                                                     |
| "~50K lines across 90+ files" (README:97)                   | **16,984 JS lines across 31 modules + 2 HTML files.**                                                                                                                                                                                                                                                   |
| "type real kubectl commands" (README:3/83)                  | Parser rejects the `kubectl` prefix (see §3.1).                                                                                                                                                                                                                                                         |
| "Cube … Auto-Align (K8s architecture layout)"               | Works, but tier lists include a `LimitRange` kind that does not exist (see §11 G15).                                                                                                                                                                                                                    |

---

## 1. Entry points, wiring and boot sequence

### 1.1 `index.html` — game shell

**DOM structure (before the module):**

| Region                      | Lines   | Notes for conversion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<canvas id="game-canvas">` | 55      | Single WebGL canvas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `#main-menu`                | 57–120  | `.menu-btn[data-mode]` campaign/chaos/sandbox/challenge (74–95); `/draw` link (97–101); Settings/Achievements/Stats buttons `#btn-settings/#btn-achievements/#btn-stats` (103–107); keyboard hints (109–119).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `#game-container`           | 122–324 | Game UI overlay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `#objectives-panel`         | 123–142 | Campaign/Challenge objective checklist + "Show Hint" (`#obj-panel-title`, `#obj-panel-desc`, `#obj-list`, `#hint-section`, `#hint-list`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GitHub badge                | 144–148 | `#game-github-badge`, `#game-github-stars`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `#view-toolbar`             | 149–172 | `#btn-auto-align` (150), `#btn-reset-camera` (154), `#btn-export-yaml` (158), `/` + `kubectl` chip (163–166), `#btn-help` (168).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `#resource-palette`         | 173–323 | **17 palette items** `.palette-item[data-resource=Kind]` with inline SVG + labels/tooltips: Workloads (Pod L176, Deployment L184 "Deploy", ReplicaSet L192 "RS", StatefulSet L200 "STS", DaemonSet L208 "DS", Job L216, CronJob L224); Network (Service L235 "Svc", Ingress L243, NetworkPolicy L251 "NetPol"); Config (ConfigMap L262 "CM", Secret L270); Storage (PersistentVolumeClaim L281 "PVC" — **PV and StorageClass are absent**); Cluster (Node L292, Namespace L300, HPA L308, ResourceQuota L316). Missing vs. `RESOURCE_CLASSES`: `PersistentVolume`, `StorageClass`, `PodDisruptionBudget`, `ServiceAccount`, `Role`, `ClusterRole`, `RoleBinding`, `ClusterRoleBinding`. |
| Modals                      | 326–427 | `#level-select` (326), `#challenge-select` (336), `#settings-panel` (346, static toggles `#toggle-sound/particles/shadows/grid`, `#select-difficulty`), `#achievements-panel` (380), `#stats-panel` (390), `#modal-level-complete` (400), `#modal-game-over` (412), `#loading-screen` (424).                                                                                                                                                                                                                                                                                                                                                                                            |

**Inline module (L429–L1986):**

- Imports (L429–454): `GameEngine, GAME_MODES, GAME_STATES`, `isClusterScopedKind`, `ClusterRenderer`,
  `IncidentEngine`, `ScoringEngine`, every UI panel, every mode, `CAMPAIGN_LEVELS/CHAPTERS`,
  `ACHIEVEMENTS`, `CHALLENGES`, and **all 25 resource classes** (L449–454). This import block is the
  single fan-in point for new modules on the game page.
- `RESOURCE_CLASSES` map (L456–463): kind string → class. Used by palette/drop (`placeResource` L932–977).
- `toRenderable(resource,x,y,z)` (L465–477): adapter from model object to renderer payload
  `{id, type, name, namespace, status, x,y,z, _ref}` — note renderer speaks `type`, model speaks `kind`.
- `class K8sGamesApp` (L479–1960):
  - `init()` L501–593: constructs `GameEngine({mode:'sandbox'})` (L502), `IncidentEngine` (L503),
    `ScoringEngine` (L504); panels `HUD/CommandBar/InspectorPanel/ContextMenu/MetricsDashboard/IncidentPanel/Minimap`
    (L506–512); exposes `window.game` (L514–522); menu/game/keyboard/palette bindings (L524–530);
    level/challenge/achievement builders (L528–530); WebGL probe (L532–539); `ClusterRenderer` (L544);
    `engine.onUpdate(dt => { incidentEngine.tick(dt); syncRenderState(); })` (L552–555);
    `cluster:reset` (L557), `cluster:added` (L564), `cluster:deleted` (L574) handlers; renderer
    callbacks `onSelect/onHover/onResourceMoved` (L582–592).
  - `_showWebGLError()` L595–615 — injected overlay.
  - Settings: `loadSettings` L617–625, `saveSettings` L627–629 (localStorage `k8sgames_settings`),
    toggle bindings L665–673, difficulty select L675–681 (calls `engine.setDifficulty`).
  - `bindMenuEvents` L631–719, `bindGameEvents` L721–762 (`mode:level-complete` L722, `mode:game-over`
    L731, `incident:created` L736, `ui:run-command` L749, `ui:edit-resource` L755, `ui:scale-dialog` L759).
  - `bindKeyboard` L764–807: `/` command bar, Space pause, `M` metrics, Esc, Del/Backspace delete
    selected, `?/h/H` tutorial, `1–9` palette shortcuts (L796–804). Tutorial text says `?`.
  - `handleEscape` L809–827.
  - `placeResource(kind, screenX, screenY)` **L932–977**: name prompt → `new ResourceClass({name, namespace})`
    (L938), cluster-scoped kinds get namespace `''` via `isClusterScopedKind` (L937), Node spec/phase
    special-case (L940–945), workload label+selector injection (L947–957), `screenToGround` (L960–965),
    `engine.cluster.add(resource)` (L968), then Service selector-picker (L970–972) and Ingress path-picker
    (L973–975).
  - Overlay editors: `_showIngressPathPicker` **L979–1060** (builds `ingress.spec.rules` from path→service
    rows, hard-codes `host = <name>.example.com`, pathType `Prefix`; copy mentions "Level 10"),
    `_showSelectorPicker` **L1062–1113** (sets `service.spec.selector` from a Deployment/StatefulSet),
    `_showNamePrompt` **L1115–1170** (suggestion buttons), `_getNameSuggestions` **L1172–1188** (derives
    suggested names from `modeInstance.getStatus().objectives` for `deploy`/`scale` types),
    `_showEditDialog` **L1190–1310** (labels, replicas for Deployment/STS/RS, Service selector + type;
    **no way to edit spec.template containers/resources/probes/TLS/namespace**),
    `_showScaleDialog` **L1312–1347** (`engine.queueCommand({type:'scale',…})`).
  - `getPlacementPosition` L1349–1359 (spiral placement on a ring).
  - `autoAlignResources` L1361–1420 with **tier registry L1368–1379**: namespace/node/workload/batch/pod/
    network/config/storage/scaling/rbac + unmatched bucket. Lists 30 kind strings incl. `LimitRange`.
  - `startMode` L1422–1437 (campaign/challenge open select screens; default launches sandbox/chaos).
  - `launchGame` **L1439–1498**: hides menu, clears renderer + engine (`engine.reset()` L1454,
    `setMode` L1455, `setDifficulty` L1456), initializes all panels (L1459–1465), `showTutorial` (L1469),
    starts renderer/engine (L1471–1472), constructs mode instance and starts it (L1474–1492), then
    `_initObjectivesPanel` (L1497).
  - Objectives panel: `_getLevelDef` L1500–1502, `_initObjectivesPanel` **L1504–1571** (500 ms
    `setInterval` polling `modeInstance.getStatus()` L1566–1570), `_updateObjectivesPanel` L1573–1614
    (renders `obj.label/current/target/completed`; challenge shows countdown).
  - `returnToMenu` L1616–1642: stops engine/renderer, calls mode `exit/cleanup/destroy` (L1625–1629),
    removes DOM panels L1636, clears renderer L1638–1640.
  - `syncRenderState` **L1644–1692**: per-frame status push + **the only place connections are computed**
    (ownership from `cluster.relationships` L1655–1663; network from Service selector → matching Pods
    L1665–1677 and → matching Deployments L1678–1688; `trafficVolume` 1/2/3; then
    `renderer.connectionLines.sync(...)` L1691).
  - `applySettings` L1694–1706: shadows/grid/particles. **Bug:** references `this.renderer.particleSystem`
    (L1702) but the field is `renderer.particleTraffic` → particle setting is a no-op.
  - `showTutorial(mode)` **L1708–1815**: builds the help/"How to play" overlay from
    `modeNames` L1712, `modeGoals` L1714–1719, `controls` L1721–1734, `modeRules` L1736–1765
    (sandbox/chaos/campaign/challenge prose, includes chapter summary L1751–1757 and a
    "type: `<code>kubectl create deployment frontend</code>`" example L1760).
  - Level/challenge/achievement/stats UI builders: `buildLevelSelect` L1817–1858 (chapter headers from
    `level.chapter/chapterName`; completion gating from `scoringEngine.progress.campaignProgress`),
    `buildChallengeSelect` L1860–1881, `buildAchievements` L1883–1901, `buildStats` L1903–1946
    ("K8s Games", "Total Pods", "Campaign Stars / 60", "Best Chaos Time", "XP Level"), `formatTime` L1948–1959.
  - Bootstrap L1962–1968: `const app = new K8sGamesApp(); app.init().catch(...)` + WebGL error fallback.
  - GitHub stars fetch L1970–1985.

### 1.2 `draw.html` — diagram page (`K8sDraw`)

- Static shell: `#draw-canvas` L55; `#draw-toolbar` L57–81 (`#btn-connect`, `#btn-auto-layout`,
  `#btn-export-yaml`, `#btn-export-png`, `#btn-share`, `#btn-clear`); `#resource-palette` L83–260
  (**20 kinds**: Workloads 7 + Service/Ingress/NetworkPolicy + ConfigMap/Secret + PVC + Node/Namespace/HPA/
  ResourceQuota + RBAC ServiceAccount/Role/RoleBinding); properties drawer `#draw-props` L262–270;
  help L272–278; watermark L280.
- Inline module L284–1044:
  - imports only `ClusterRenderer`, `ClusterState`, `GameEngine` (L285–287) — **no resource subclasses**.
  - `RESOURCE_CLASSES_META` **L289–310**: kind → `{api}` — the _only_ apiVersion registry used by this page.
  - `VALID_KINDS` L312, `DEFAULT_SPECS` **L314–335** (kind → spec factory `(name) => ({...})`; 20 kinds).
  - `class K8sDraw` L337; `init` L349–413: creates `GameEngine({mode:'sandbox'})`, renderer, `window.game`
    **without** incident/scoring (L353–358), binds UI, `renderer.start()`, then **disables the simulation**
    by monkey-patching `engine.simulation.tick = () => {}` (L367–368); `cluster:added` handler renders each
    resource as `Running`/`Ready` (L371–387); `cluster:deleted` L389–395; `renderer.onSelect` L397–405;
    `onResourceMoved` persists position for connection redraw (L407–410); `loadFromHash()` L412.
  - Interactions: palette drag/drop/click/touch L415–466; `placeResource` **L468–491** (name
    `<kind-lower>-N`, uid `draw-<kind>-<ts>-<rand>`, `DEFAULT_SPECS`, `cluster.addResource`);
    connection mode drawing L493–538 (uses `renderer.raycaster`, `renderer.camera`, `renderer.pickableObjects`
    directly — a cross-layer coupling); right-click=delete L531–538; double-click inline rename L540–591;
    `syncConnections` **L594–627** (custom connections + ownerReferences→ownership lines);
    toolbar handlers L629–672; keyboard L674–701 (`Escape`, `Delete/Backspace`, `1–9` placement);
    properties panel `showProps` **L715–815** (edit name/namespace/labels/replicas; delete);
    `exportYAML` **L823–855** (uses `RESOURCE_CLASSES_META` + `toYAML`); custom `toYAML` L857–899;
    `exportPNG` L901–913; `shareLink` **L915–949** (base64 JSON in `#hash`; URL `${origin}/draw#...`);
    `loadFromHash` **L951–986** (replays `VALID_KINDS` only); `autoLayout` **L988–1039** (tier list L992–1006).
  - Bootstrap L1042–1043.

### 1.3 Boot sequence (both pages)

```
index.html: DOM shell → <script type=module> → imports (25 resource classes, modes, panels)
  → K8sGamesApp.init()
      GameEngine (owns ClusterState + SimulationTick + EventBus)   L502
      IncidentEngine(GameEngine)   L503
      ScoringEngine(GameEngine)    L504
      panels created (DOM only)    L506-512
      window.game = {...}          L514-522
      WebGL probe                  L532-539
      ClusterRenderer(canvas)      L544
      engine.onUpdate(incidentEngine.tick + syncRenderState)  L552
  → main menu (no engine loop running)
  → user picks mode → launchGame(mode)
      engine.reset(); setMode; setDifficulty          L1454-1456
      panels.init()                                    L1459-1465
      showTutorial(mode)                               L1469
      renderer.start(); engine.start()                 L1471-1472   ← RAF loops live here
      new <Mode>(engine, incidentEngine?, scoringEngine) + start  L1474-1492
draw.html: imports (renderer, ClusterState, GameEngine only)
  → K8sDraw.init(): GameEngine, renderer, window.game, binds,
       renderer.start(), engine.start() with simulation.tick patched to no-op
```

### 1.4 Global objects and the EventBus contract

`index.html:514–522`:

```js
window.game = {
  engine: this.engine.eventBus, // ⚠ EventBus instance, NOT GameEngine
  cluster: this.engine.cluster, // ClusterState
  renderer: null, // ClusterRenderer (set after WebGL probe)
  gameEngine: this.engine, // the actual GameEngine
  incidentEngine: this.incidentEngine,
  scoringEngine: this.scoringEngine,
  app: this, // K8sGamesApp
};
```

`draw.html:353–358`: `{engine, cluster, renderer, gameEngine}` (no incident/scoring/app).

**This naming is a landmine:** UI modules call `window.game.engine.on(...)/.emit(...)` for events, but
`window.game.gameEngine` for command queue/difficulty/pause. `ScoringEngine` and `SimulationTick` receive
`GameEngine` directly. Also `window.game.incidentEngine` is used by `IncidentPanel.resolveIncident`
(`IncidentPanel.js:132`) and `HUD._onXPGain` reads `window.game.scoringEngine` (HUD.js:225).

`EventBus` (`GameEngine.js:5–119`): `on/once/off/emit/onAny/getHistory/clearHistory/removeAllListeners/
listenerCount`; **200-event history** (L10, L43–47); handler exceptions are caught + `console.error`
(L51–57); `on()` returns an unsubscribe function (L19). `GameEngine` aliases `on/off/emit/once`
(L141–144) so engine and bus are interchangeable to callers.

`GameEngine.MODES` / `.STATES` also attached as static props (L916–917), and named exports exist
(`{EventBus, GAME_MODES, GAME_STATES}` L919).

### 1.5 localStorage / persistence

| Key                      | Written by                                                                                      | Read by                                 | Schema                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `k8sgames_settings`      | `index.html:628` (`K8sGamesApp.saveSettings`) **and** `SettingsPanel.js:47` (different writer!) | `index.html:619`, `SettingsPanel.js:29` | **Two incompatible schemas colliding** (see G5).                                                                           |
| `k8sgames_progress`      | `ScoringEngine.js:788`                                                                          | `ScoringEngine.js:762`                  | `{xp, level, stats:{...}, achievements:[ids], campaignProgress:{}, challengeProgress:{}}`                                  |
| `k8sgames_investigation` | `IncidentPanel.js:420`                                                                          | `IncidentPanel.js:426`                  | `[{id, completedSteps:[], status}]` — but `load` looks up incidents that are never repopulated, so it is effectively dead. |

**There is no cluster save/load UI.** `GameEngine.saveState()` (L837–860) and `loadState()` (L862–900) are
fully implemented but **never called anywhere** (verified by grep). Cluster state is rebuilt from level
definitions each launch. `SettingsPanel` "Export Save" (L178–192) dumps the two localStorage blobs only.

### 1.6 YAML export — five independent implementations

1. `index.html:914–929` toolbar button: prefers `modeInstance.exportClusterYAML()` (Sandbox only), else
   joins `resource.toYAML()` docs with `\n---\n` (subclass YAML when available; generic base YAML for
   controller-created resources since they are plain `ResourceBase`).
2. `SandboxMode.exportClusterYAML()` **L150–181** + `getApiVersion` L183–200 + `cleanSpec` L202–207 +
   `toYAML` L209–240. Uses its own apiVersion map; strips `status`.
3. `draw.html:exportYAML` **L823–855** + `toYAML` L857–899. Uses `RESOURCE_CLASSES_META`; emits
   `{apiVersion, kind, metadata{name,namespace,labels}, spec}` only.
4. Resource class `toYAML()` overrides — 25 of them (see §2.2); hard-code apiVersion and hand-format
   `describe`-style status blocks; they **include `uid`, `creationTimestamp` and `status`** (not
   `kubectl apply`-clean).
5. `InspectorPanel._renderYAML()` **L296–327** — live JSON→HTML tree of the resource object (not real YAML;
   includes internal `_events`/listeners? no — it serializes `resource` object recursively, so internal
   fields like `_deleted`, `_listeners` Map serialize oddly).
   Plus `CommandBar -o yaml` is **fake**: `CommandBar.js:385–391` builds 7 lines with
   `spec: ${JSON.stringify(spec)}` on one line.

**Conversion requirement:** pick one serializer (recommend a single `toManifest()` walking a schema map),
teach it OpenShift kinds/apiVersions, make `oc apply -f` actually parse YAML, and reuse it for all five
surfaces.

### 1.7 Help / tutorial text locations

| Text                                           | Location                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| In-game help overlay ("How to Play", Controls) | `index.html:1708–1815` (`modeGoals` L1714, `controls` L1721, `modeRules` per mode L1736–1765)                         |
| Per-mode menu descriptions                     | `index.html:74–95` (`.menu-btn-desc`: Campaign/Chaos/Sandbox/Challenges)                                              |
| Palette labels + tooltips + keyboard hints     | `index.html:173–323` (labels "Deploy", "Svc", "NetPol", …), `draw.html:83–260`                                        |
| Campaign level descriptions/hints              | `js/data/CampaignLevels.js` (`description`, `hints[]`, `tutorial.steps[]`)                                            |
| Challenge descriptions/hints                   | `js/modes/ChallengeMode.js:9–289`                                                                                     |
| Incident investigation hints/commands          | `js/data/IncidentDefs.js` (`investigationSteps[].hint`, `.command`, `kubectlCommands[]`)                              |
| `kubectl explain` help DB                      | `js/ui/CommandBar.js:859–1127` (`EXPLAIN_DATA`)                                                                       |
| README marketing/controls tables               | `README.md` entire file                                                                                               |
| HTML `<title>`/meta/OG copy                    | `index.html:6–18`, `draw.html:6–18`, `og-image.html`                                                                  |
| CSS-only strings                               | `style.css` (no user text; only class names like `.menu-btn-desc` L231, `.palette-label` L378, `.tutorial-mode` L931) |

**Tutorial overlay targets are dead:** `CampaignLevels` levels 1–2 define `tutorial.steps[{target,text}]`
with targets `command-bar`, `cluster-view`, `inspector`; `CampaignMode.advanceTutorial()` emits
`campaign:tutorial-step` (`CampaignMode.js:548–570`) but **no listener exists** for that event (verified by
grep). The actual help is the static modal in §1.7. Conversion can delete/replace this cleanly.

---

## 2. Resource model (`js/resources/`)

### 2.1 `ResourceBase` contract (`ResourceBase.js`)

**UID generation** (module-level, L1–8): `<base36(now)>-<8 random base36>-<counter base36 padded 4>`.
Counter is module-global; UIDs are unique per page session but not restart-stable.

**Shape after construction** (L10–55):

```js
{
  kind: 'Deployment',
  apiVersion: 'v1',                 // ⚠ often WRONG, see §2.2 / §11 G6
  metadata: {
    name, namespace, uid,
    labels: {}, annotations: {},
    creationTimestamp: '<ISO>', deletionTimestamp: null,
    generation: 1, resourceVersion: '1',
    ownerReferences: [],            // {apiVersion,kind,name,uid,controller,blockOwnerDeletion}
    finalizers: []
  },
  spec: {},
  status: { phase: 'Pending', conditions: [], observedGeneration: 0 },
  _events: [], _maxEvents: 50, _deleted: false, _listeners: Map
}
```

Constructor accepts **two forms**: `new ResourceBase(kind, apiVersion, name, namespace)` or
`new ResourceBase(kind, metadataObject, undefined, undefined)`; subclasses all use the metadata-object form
(`super('Pod', metadata)`), so `metadata.apiVersion` is the only way a subclass can set the API version at
construction. Subclasses mostly don't (see table).

**Getters:** `name` L57, `namespace` L61, `uid` L65, `labels` L69, `annotations` L73, `age` L77,
`ageFormatted` L82, `isDeleting` L94, `fullyQualifiedName` L98 (`ns/Kind/name`), `events` L267.

**Mutation / model API:**

| Method                                                                          |        Line | Notes                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ----------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setLabel/removeLabel`                                                          |     102/108 | bump resourceVersion                                                                                                                                            |
| `setAnnotation/removeAnnotation`                                                |     114/120 |                                                                                                                                                                 |
| `matchesSelector(selector)`                                                     |         126 | simple equality on `metadata.labels`; `{}` matches all                                                                                                          |
| `matchesFieldSelector(field, value)`                                            |         134 | dotted-path lookup                                                                                                                                              |
| `addOwnerReference(owner)` / `removeOwnerReference(uid)`                        |     144/165 | controller:true, blockOwnerDeletion:true                                                                                                                        |
| `getControllerOwner()`                                                          |         173 |                                                                                                                                                                 |
| `addFinalizer/removeFinalizer`                                                  |     177/185 |                                                                                                                                                                 |
| `markForDeletion()` / `canBeRemoved()`                                          |     193/202 | deletionTimestamp + finalizers                                                                                                                                  |
| `setCondition(type,status,reason,message)` / `getCondition` / `isConditionTrue` | 209/233/237 | preserves lastTransitionTime when status unchanged                                                                                                              |
| `setPhase(phase)` / `setStatus(phase)`                                          |     242/256 | records `PhaseChange` Normal event                                                                                                                              |
| `updateSpec(partial)`                                                           |         260 | shallow Object.assign + generation++                                                                                                                            |
| `tick(deltaTime)`                                                               |         271 | **no-op; never called** (G6)                                                                                                                                    |
| `addEvent/recordEvent`                                                          |     273/277 | dedupes identical consecutive reason+message; keeps last 50; event shape `{type,reason,message,timestamp,count,source,involvedObject{kind,name,namespace,uid}}` |
| `getEvents(limit)` / `getWarningEvents()`                                       |     307/314 |                                                                                                                                                                 |
| `on/off/emit` (resource-local)                                                  |     318–344 |                                                                                                                                                                 |
| `toJSON()`                                                                      |         352 | deep-copies spec/status/metadata                                                                                                                                |
| `toYAML(indent=0)`                                                              |         371 | generic YAML for any object; subclasses override                                                                                                                |
| `clone()`                                                                       |         466 | returns **plain `ResourceBase`** (subclass lost), new UID, copies metadata/spec/status                                                                          |
| `equals` / `toString`                                                           |     476/481 | uid equality / `Kind/ns/name`                                                                                                                                   |

`toYAML()` (L371–464) is a hand-rolled emitter with quoting rules (quotes strings containing
`\n : # '` or empty). It always prints `apiVersion`, `kind`, `metadata` (name, namespace, uid, labels,
annotations, creationTimestamp, ownerReferences), `spec`, and `status`.

`recordEvent` event-shape is used by `CommandBar._cmdGet --field-selector involvedObject.name` (see §3.3)
and by `InspectorPanel._renderEvents`.

### 2.2 Kind → class → file → API version → mesh → describe/YAML

All 25 kinds are `export class X extends ResourceBase` and call `super('<Kind>', metadata)`.

| Kind                    | Class file:line            | apiVersion truth (correct)     | `.apiVersion` actually set in ctor | Mesh? (ResourceMeshes) | Custom `toYAML`/`toDescribe` |
| ----------------------- | -------------------------- | ------------------------------ | ---------------------------------- | ---------------------: | ---------------------------- |
| Pod                     | `WorkloadResources.js:3`   | `v1`                           | `v1` (correct)                     |               yes L213 | 206 / 234                    |
| Deployment              | `WorkloadResources.js:256` | `apps/v1`                      | **`v1` (wrong)**                   |               yes L252 | 374 / 409                    |
| ReplicaSet              | `WorkloadResources.js:426` | `apps/v1`                      | **`v1` (wrong)**                   |               yes L282 | 472 / 492                    |
| StatefulSet             | `WorkloadResources.js:507` | `apps/v1`                      | **`v1` (wrong)**                   |               yes L303 | 584 / 613                    |
| DaemonSet               | `WorkloadResources.js:633` | `apps/v1`                      | **`v1` (wrong)**                   |               yes L329 | 694 / 714                    |
| Job                     | `WorkloadResources.js:732` | `batch/v1`                     | **`v1` (wrong)**                   |               yes L658 | 802 / 827                    |
| CronJob                 | `WorkloadResources.js:846` | `batch/v1`                     | **`v1` (wrong)**                   |               yes L693 | 964 / 991                    |
| Service                 | `NetworkResources.js:3`    | `v1`                           | `v1` (correct)                     |               yes L357 | 84 / 121                     |
| Ingress                 | `NetworkResources.js:155`  | `networking.k8s.io/v1`         | **`v1` (wrong)**                   |               yes L389 | 235 / 267                    |
| NetworkPolicy           | `NetworkResources.js:284`  | `networking.k8s.io/v1`         | **`v1` (wrong)**                   |               yes L533 | 378 / 410                    |
| ConfigMap               | `ConfigResources.js:3`     | `v1`                           | `v1`                               |               yes L416 | 70 / 87                      |
| Secret                  | `ConfigResources.js:110`   | `v1`                           | `v1`                               |               yes L445 | 201 / 216                    |
| PersistentVolume        | `StorageResources.js:12`   | `v1`                           | sets `'v1'` L15                    |          **no (cube)** | 68 / 96                      |
| StorageClass            | `StorageResources.js:113`  | `storage.k8s.io/v1`            | sets it L116                       |          **no (cube)** | 136 / 151                    |
| PersistentVolumeClaim   | `StorageResources.js:166`  | `v1`                           | `v1`                               |   yes L477 (`PVC` key) | 267 / 293                    |
| Node                    | `ClusterResources.js:3`    | `v1`                           | `v1`                               |               yes L585 | 182 / 216                    |
| Namespace               | `ClusterResources.js:248`  | `v1`                           | `v1`                               |               yes L630 | 294 / 306                    |
| HorizontalPodAutoscaler | `ClusterResources.js:325`  | `autoscaling/v2`               | **`v1` (wrong)**                   |       yes L500 (`HPA`) | 430 / 462                    |
| ResourceQuota           | `ClusterResources.js:479`  | `v1`                           | `v1`                               |               yes L557 | 578 / 595                    |
| PodDisruptionBudget     | `ClusterResources.js:606`  | `policy/v1`                    | sets it L609                       |          **no (cube)** | 652 / 675                    |
| ServiceAccount          | `RBACResources.js:3`       | `v1`                           | sets it L6                         |          **no (cube)** | 29 / 43                      |
| Role                    | `RBACResources.js:56`      | `rbac.authorization.k8s.io/v1` | sets it L59                        |          **no (cube)** | 91 / 104                     |
| ClusterRole             | `RBACResources.js:118`     | `rbac.authorization.k8s.io/v1` | sets it L121                       |          **no (cube)** | 148 / 160                    |
| RoleBinding             | `RBACResources.js:173`     | `rbac.authorization.k8s.io/v1` | sets it L176                       |          **no (cube)** | 203 / 220                    |
| ClusterRoleBinding      | `RBACResources.js:237`     | `rbac.authorization.k8s.io/v1` | sets it L240                       |          **no (cube)** | 267 / 283                    |

**Correct API versions also live in** (must be kept in sync / unified):
`GameEngine._apiVersionForKind` L601–615, `draw.html RESOURCE_CLASSES_META` L289–310,
`SandboxMode.getApiVersion` L183–200, and the hard-coded strings inside each `toYAML`.
Six of these agree; `.apiVersion` on class instances does not (G6).

### 2.3 Per-class spec/handler brief (what conversion experts need)

**Pod** (`WorkloadResources.js:3–254`): `spec{containers[{name,image,resources{requests,limits}}],
restartPolicy, nodeName, serviceAccountName, terminationGracePeriodSeconds}`. Instance fields: `phase`,
`conditions`, `containerStatuses[{name,image,ready,started,restartCount,state,lastState}]`, CPU/mem usage +
limits, crash-loop timer/backoff (10s→×2→max 300s), OOM counters, `qosClass`, `ip`. Methods:
`isReady` L195, `getRestartCount` L199, `triggerCrash` L157, `terminate` L181. `tick` L77 dead.
`toYAML` L206 hard-codes container resources (loses probes/volumes/env).

**Deployment** (`:256–424`): `spec{replicas=3, selector.matchLabels, strategy.type=RollingUpdate,
rollingUpdate{maxSurge:'25%',maxUnavailable:'25%'}, template.metadata.labels/template.spec.containers,
revisionHistoryLimit:10}`; runtime `replicaSets[]`, `revision`, `revisionHistory[]`, ready/available/updated
counts, `isRollingOut`. **`addReplicaSet` L304 is broken** (`rs.ownerReferences.push` → own property is
undefined; should be `rs.addOwnerReference(this)`), and is never called. `triggerRollingUpdate` L309,
`rollback` L330, `scale` L337 not called by `SimulationTick` either (rollout handled in `GameEngine`).
`tick` L343 dead.

**ReplicaSet** (`:426–505`): spec replicas/selector/template; `pods[]`; `matchesSelector` L454;
`getDesiredPodCount` L465.

**StatefulSet** (`:507–631`): spec adds `serviceName` (`<name>-headless`), `podManagementPolicy:
OrderedReady`, `updateStrategy`, `volumeClaimTemplates[{metadata{name},spec{accessModes,resources.requests.
storage:'10Gi'}}]`; `getStableNetworkId` L538 (`<name>-<n>.<svc>.<ns>.svc.cluster.local`);
`addPod(pod,ordinal)` L542.

**DaemonSet** (`:633–730`): spec adds `template.spec.nodeSelector`, `tolerations`,
`updateStrategy{maxUnavailable}`; `shouldRunOnNode` L659.

**Job** (`:732–844`): spec `completions/parallelism/backoffLimit=6/activeDeadlineSeconds/template.spec.
restartPolicy:'Never'`; counters succeeded/failed/active, completionTime, isComplete/isFailed.

**CronJob** (`:846–1005`): spec `schedule:'*/5 * * * *'`, `concurrencyPolicy`, `suspend`,
`successfulJobsHistoryLimit:3`, `failedJobsHistoryLimit:1`, `startingDeadlineSeconds`,
`jobTemplate.spec...`; `_parseSchedule` L880 supports `*/n` and `0 *`/`0 0` only; `suspend()/resume()`.

**Service** (`NetworkResources.js:3–153`): `spec{type=ClusterIP, selector, ports[{name,port,targetPort,
protocol}], clusterIP (random 10.x), externalIPs, sessionAffinity, loadBalancerIP, nodePort}`; NodePort/LB
assign random nodePort 30000+; LB pending 5s then fake IP `203.0.113.x`. `updateEndpoints(pods)` L39,
`routeTraffic()` L53, `tick` L60 dead. Describe prints Endpoints list.

**Ingress** (`:155–282`): `spec{ingressClassName:'nginx', tls[], rules[{host,http.paths[{path,pathType:
'Prefix',backend.service{name,port.number}}]}], defaultBackend}`; `addTLS` L187 **never called**;
`addRule` L192; `routeRequest` L207; LB timer 3s fake IP. `toYAML` emits deprecated
`kubernetes.io/ingress.class` annotation + `ingressClassName`.

**NetworkPolicy** (`:284–437`): `spec{podSelector.matchLabels, policyTypes:['Ingress','Egress'],
ingress[{from[{podSelector|namespaceSelector}],ports[{protocol,port}]}], egress[{to...,ports...}]}`;
`evaluateIngress` L313, `evaluateEgress` L336, `updateAffectedPods` L367 (never called).

**ConfigMap** (`ConfigResources.js:3–108`): `data{}`, `binaryData{}`, `immutable`; set/delete/get data;
mount/env reference trackers (`mountedBy`, `envInjectedBy`) — never populated by engine.

**Secret** (`:110–233`): `type='Opaque'`, `data{}` base64-encoded, `stringData{}`, `immutable`; TLS type
auto-fills `tls.crt/tls.key`; dockerconfigjson auto-fills `.dockerconfigjson`; set/get/delete data.

**PersistentVolume** (`StorageResources.js:12–111`): `spec{capacity.storage, accessModes,
persistentVolumeReclaimPolicy:'Retain', storageClassName:'standard', volumeMode, hostPath|nfs|csi,
nodeAffinity, mountOptions}`; phase Available/Bound/Released/Failed; `bind/release/reclaim/markFailed`.

**StorageClass** (`:113–164`): `spec{provisioner:'kubernetes.io/no-provisioner', reclaimPolicy:'Delete',
volumeBindingMode:'WaitForFirstConsumer', allowVolumeExpansion, parameters, mountOptions}`; `isDefault`
annotation.

**PersistentVolumeClaim** (`:166–312`): `spec{accessModes:['ReadWriteOnce'], resources.requests.storage:
'10Gi', limits?, storageClassName:'standard', volumeName, volumeMode, selector}`; `bind/release/markLost`,
`getUsagePercent`; **`tick` L241 would bind after 1–4 s but is never called** (G13).

**Node** (`ClusterResources.js:3–246`): `spec{podCIDR, providerID, taints[], unschedulable}`;
`capacity{4,8Gi,110pods,50Gi}`, `allocatable{3800m,7Gi,…}`; conditions Ready/MemoryPressure/DiskPressure/
PIDPressure/NetworkUnavailable; `nodeInfo{kubeletVersion:'v1.29.2', containerRuntimeVersion:
'containerd://1.7.11', osImage:'Ubuntu 22.04'}`; `canSchedulePod` L86, `cordon/uncordon/drain` L101–120,
`addTaint/removeTaint`; `tick` L144 dead.

**Namespace** (`:248–323`): phase Active/Terminating; counts (`podCount`, `serviceCount`, …); `terminate()`
L274, `updateCounts(resources)` L280 (never called); display color generated from name.

**HPA** (`:325–477`): `spec{scaleTargetRef{apiVersion,kind,name}, minReplicas:1, maxReplicas:10,
metrics[{type:'Resource',resource{name:'cpu',target{type:'Utilization',averageUtilization:50}}}],
behavior{scaleUp/scaleDown stabilization}}`; `setTargetDeployment` **never called**; `tick` L385 dead
(engine has its own HPA loop). `toDescribe` uses `metrics[0].resource.target` shape.

**ResourceQuota** (`:479–604`): `spec.hard{cpu,memory,pods,services,configmaps,secrets,requests.*,
limits.*}`, `used{}`; `updateUsage(resources)` L517 **never called by engine** (engine keeps quota maps in
`ClusterState.resourceQuotas` instead — two competing systems). `toDescribe` prints Resource/Used/Hard.

**PodDisruptionBudget** (`:606–691`): `spec{selector.matchLabels, minAvailable|maxUnavailable,
unhealthyPodEvictionPolicy}`; `updateStatus(matchingPods)` L624 never called; `canDisrupt` L644.

**ServiceAccount / Role / ClusterRole / RoleBinding / ClusterRoleBinding** (`RBACResources.js`):

- SA: `secrets[]`, `imagePullSecrets[]`, `automountServiceAccountToken`; add/removeSecret.
- Role/ClusterRole: `spec.rules[]` (`apiGroups/resources/verbs`), `addRule/removeRule/hasWildcard` (wildcard
  used by scoring/`leastPrivilege`); ClusterRole also `aggregationRule`.
- RoleBinding/ClusterRoleBinding: `spec.roleRef{apiGroup,kind,name}`, `subjects[]`; `addSubject/
removeSubject`; subject apiGroup `''` for ServiceAccount else `rbac.authorization.k8s.io`.

### 2.4 `ClusterState` registration, indices, APIs (`ClusterState.js`)

- **`RESOURCE_KINDS`** (L9–16, 25 entries) seeds `kindIndex` for every kind. This is _not_ a default-spec
  registry — there is **no `KIND_DEFAULTS`** in the codebase (task brief's assumption is wrong).
- **`CLUSTER_SCOPED_KINDS`** (L3) = `Node, Namespace, PersistentVolume, StorageClass, ClusterRole,
ClusterRoleBinding`; exported `isClusterScopedKind(kind)` (L5–7).
- **`OWNER_CHAINS`** (L18–25) = `Deployment→[ReplicaSet], ReplicaSet→[Pod], StatefulSet→[Pod],
DaemonSet→[Pod], Job→[Pod], CronJob→[Job]`; exposed by `getExpectedChildKinds` L722.
- Constructor L28–48: `resources Map(uid→resource)`, `relationships Map(parentUid→Set(childUid))`,
  `reverseRelationships`, `kindIndex Map(kind→Set(uid))`, `namespaceIndex`, `nameIndex`
  (`kind:ns:name`→uid), `labelIndex` (`k=v`→Set(uid)), `resourceQuotas Map(ns→{hard,used})`,
  `limitRanges Map` (unused), `_watchCallbacks`, batch mode.
- **Default namespaces seeded** at construction and after `clear()`: `default, kube-system, kube-public,
kube-node-lease` with label `kubernetes.io/metadata.name` (L50–58). Conversion should swap these for
  OpenShift-appropriate defaults (`default`, `openshift-*`, `kube-*`) — but note many checks assume
  `default` exists.
- Event emission `_emitEvent` L77–100: emits **both** `cluster:<type>` and `cluster:<type>:<Kind>`
  (e.g. `cluster:added:Pod`), payload `{type,resource,kind,name,namespace,uid,timestamp,...extra}`.
  `startBatch/flushBatch` L64–75 buffer during a simulation tick.
- **`add(resource)`** L102–125: requires `instanceof ResourceBase` (throws otherwise), registers indices +
  owner relationships from `metadata.ownerReferences`.
- **`update(uid, updates)`** L127–169: accepts a `ResourceBase` (replaces spec/status) or a plain object
  (`{spec,status,metadata.{labels,annotations}}`); bumps resourceVersion, reindexes labels, emits
  `cluster:modified`.
- **`remove(uid)`** L171–214: if finalizers → `markForDeletion()` + modified event and return; otherwise
  recursively removes children (ownership graph), unindexes, emits `cluster:deleted`.
- Reads: `get` L216, `getByName(kind,name,ns)` L220, `getByKind` L227, `getAllResources` L242,
  `getResource(uid)` L246, `getByNamespace` L250, `getByKindAndNamespace` L261, `query(options)`
  L276–325 (kind/namespace/selector/fieldSelector/phase/name/sortBy/limit), `selectByLabels(kind,sel)`
  L327, `findPodsForService` L332, `findServiceForPod` L340, `getOwnerChain` L350, `getChildren` L362,
  `getDescendants` L373, `getParents` L390, `addRelationship(parentUid,childUid)` L417 (also adds owner
  ref), `getByLabel` L486, `watch(kind,cb)` L498–512.
- Quotas: `setResourceQuota(namespace, quota)` L514, `getResourceQuota` L521, `_calculateQuotaUsage`
  L525–544 (pods Running/Pending, sums container **requests**), `checkQuota(ns,cpuMillis,memMi)` L546–571
  (units: CPU millis, memory Mi), `_parseCpu` L573 (returns **millis**), `_parseMemory` L580 (returns
  **Mi**).
- `getNodeAllocatable(nodeName)` L589–620: capacity from `node.spec.cpu/memory` first (so Node objects
  created via `addResource({spec:{cpu,memory}})` use those), fallback 4000m/8192Mi; returns
  `{cpu:{capacity,used,available}, memory:{...}, podCount}` — units millis/Mi.
- `getClusterStats()` L622–660: `{nodes:{total,ready}, pods:{total,Pending,Running,Succeeded,Failed,
Unknown}, deployments:{total,available}, services:{total}, namespaces:{total}, resources:{total},
cpu:{total,used,percent}, memory:{...}}`. **This is what the HUD/MetricsDashboard/`tick` event consume.**
- `getResourceGraph()` L662–685; `snapshot()` L687–697 (JSON for save/load); `clear()` L699–720 (re-seeds
  default namespaces, emits `cluster:reset`); `getAllKinds()` L726.
- **`addResource(obj)` L730–746 — the downgrade trap:** internally constructs
  `new ResourceBase(obj.kind, {name, namespace, labels, annotations})`; **ignores `obj.metadata.uid`**,
  ignores subclass, ignores `apiVersion`; copies `spec` shallowly; applies `status.phase` only.
  Returns the new plain object. `removeResource(kind,name,ns)` L748–755.

### 2.5 Three incompatible creation paths (critical for conversion)

| Path                                                        | Code                                                                                                                                                                                                                                                                     | Instance class       | UID                                                 | API version                                 | Emits `resource:created` (scoring)                     | Subclass `toYAML/toDescribe` |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | --------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| A. UI palette / keyboard / drop                             | `index.html:932–977` (`new ResourceClass`) → `cluster.add`                                                                                                                                                                                                               | **real subclass**    | from constructor (used as position key, consistent) | possibly wrong (table §2.2)                 | **no** → not counted by ScoringEngine                  | yes                          |
| B. Command bar (`kubectl create/run/apply`)                 | `CommandBar.js:614–665, 667–695, 581–612` → `cluster.addResource`; then handler emits `resource:created` manually (L604/658/683)                                                                                                                                         | plain `ResourceBase` | **regenerated** (passed uid ignored)                | default `'v1'` (`ClusterState.addResource`) | yes                                                    | no (generic base YAML)       |
| C. Mode setup / controllers                                 | `CampaignMode.setupCluster` L144–173, `ChallengeMode.setupCluster` L371–390, `ChaosMode.setupCluster` L75–91, `SandboxMode.setupCluster` L47–63, `SimulationTick._createPodForWorkload` L867–893, `_tickDeployments` RS creation L462, `_tickCronJobs` Job creation L642 | plain `ResourceBase` | regenerated                                         | `'v1'`                                      | no (except `SandboxMode.addResource` L83–113 emits it) | no                           |
| D. `GameEngine._handleCreate/_handleApply` L433–454/480–497 | `new ResourceBase(...)` + `cluster.add`                                                                                                                                                                                                                                  | plain                | fresh                                               | `_apiVersionForKind` (correct-ish)          | no                                                     | no                           |

**Consequences you must handle:**

- `CommandBar._cmdDescribe` (L469) only prints rich `toDescribe()` for palette-created resources; for
  simulated Pods/RSs it prints the generic 8-line fallback (L473–491). Inspect a Deployment's pods and
  you get different describe output depending on how it was created.
- The simulation's own children (Pods/ReplicaSets/Jobs created by controllers) are plain, so YAML export
  from the toolbar (`index.html:914–929`) prints base-class YAML for them — often with `apiVersion: v1`
  for a ReplicaSet.
- Scoring/achievements only count command-created resources (palette placement is invisible to
  `ScoringEngine`), which also means campaign objectives that count resources still work (they read the
  cluster, not stats) but "First Pod" achievements can be missed if you only use the palette.
- Draw page positions/UID: `draw.html:468–491` stores `placedPositions` under a locally generated
  `draw-…` UID but `cluster.addResource` discards it and assigns a new UID; the `cluster:added` handler
  (L371–387) looks up `placedPositions.get(resource.uid)` → `undefined` → **x=0,z=0**. Confirmed by an
  executable test (Appendix B): `passed uid: draw-pod-123 | stored uid: mw18snp9-… | match: false`.
  Every dropped/loaded diagram resource lands at the origin until dragged. Fix by keying on the returned
  resource or by letting `addResource` honour `metadata.uid`.

### 2.6 Where new kinds must be registered (fan-out checklist)

Adding one OpenShift kind (e.g. `Route`) currently requires touching **all** of:

1. `js/resources/` new subclass + export (and `index.html:449–454` / any page imports).
2. `ClusterState.RESOURCE_KINDS` (`ClusterState.js:9`), `CLUSTER_SCOPED_KINDS` if cluster-scoped (L3),
   `OWNER_CHAINS` if it owns children (L18).
3. `index.html RESOURCE_CLASSES` L456, palette HTML L173–323, keyboard shortcut L796, `autoAlignResources`
   tiers L1368.
4. `draw.html RESOURCE_CLASSES_META` L289, `DEFAULT_SPECS` L314, palette HTML L83–260, keyboard L696,
   `autoLayout` tiers L992.
5. `GameEngine._apiVersionForKind` L601.
6. `SandboxMode.ALL_RESOURCE_TYPES` L7 + `getApiVersion` L183.
7. `CommandBar RESOURCE_TYPES` L1, `KIND_ALIASES` L13, `_dispatch`/`_cmdCreate` defaults L624, `_getHeader
ForKind` L410, `_formatResourceRow` L415, `EXPLAIN_DATA` L859.
8. `ResourceMeshes.CREATORS` L212 (else fallback cube), `STATUS_COLORS` L3.
9. `Minimap.KIND_SIZES` L10.
10. `ScoringEngine.trackResourceCreated` kind→stat map L156 and `createEmptySessionStats` L48.
11. `ContextMenu.ACTION_MAP` L1.
12. `InspectorPanel` kind-specific rendering L219–295 + `_renderDescribe` L374.
13. `ConnectionLines`/`index.html syncRenderState` if it has new relationships; `SimulationTick` if it has
    a controller; `IncidentDefs.affectedResourceTypes` if incidents target it; content files.

**Recommendation:** introduce `js/data/kindRegistry.js` exporting
`{KINDS: {Kind: {apiVersion, namespaced, class, mesh?, aliases:[], columns, explain, ownerChain, minimapSize,
palette:{section,label,icon}, apiGroups}}}` and refactor the 13 lists to derive from it. Freeze this
interface before parallel workstreams start.

---

## 3. Command engine

### 3.1 `CommandBar` (`js/ui/CommandBar.js`) — parser, aliases, completion

- **The "tokenizer" is `raw.split(/\s+/)`** (`_executeCommand` L282) and `args` are positional strings.
  There is **no quoting, no `--flag=value` normalization beyond ad-hoc `startsWith`, no YAML/file input.**
- **No prefix support:** dispatch is on `parts[0]` (L283). Typing `kubectl get pods` → `_dispatch('kubectl')`
  → `error: unknown command "kubectl"` (L315). Meanwhile the prompt renders a non-editable
  `$ kubectl` prefix (`_buildHTML` L91), echoes `$ kubectl ${raw}` (L257, L269), and all hints/incidents
  say "type `kubectl …`". `IncidentPanel` strips a leading `kubectl` before pre-filling the input
  (`IncidentPanel.js:296`) and when matching (`:372`).
- `RESOURCE_TYPES` (L1–11): ~48 plural/singular/abbrev tokens for completion only.
- `KIND_ALIASES` (L13–42): token → Kind (incl. `pods/po/pod`, `deploy/deployments/deployment`, …,
  `quota`, `pdb`, `sc`, `limitrange`).
- `COMMANDS` (L44) = `['get','describe','logs','scale','delete','apply','create','rollout','drain',
'cordon','uncordon','top','exec','label','run','explain']`.
- Completion (`_updateSuggestions` L171–194): 1 token → command prefix; 2 tokens → resource-type prefix;
  ≥3 tokens → resource-name prefix from `window.game.cluster.getResourcesByKind(kind)`; Tab cycles
  (`_tabComplete` L221–228). No flag completion.
- History: local `history[]`, Up/Down (`_navigateHistory` L164–169); not persisted.
- Easter eggs (`_checkEasterEggs` L230–245): `get coffee`, `explain life`, `run … --image=doom`,
  `delete ns kube-system` — all emit XP/achievement events; strings to rewrite/remove for EX280.
- `sudo ` special case L250–260.
- Every command echo emits `command:raw` + `command:executed` (L271–272) — `IncidentPanel` listens to
  `command:raw`, `ScoringEngine` listens to `command:executed`.
- Output is DOM lines (`_appendOutput` L1191–1197, `_escapeHTML` L1199).

### 3.2 Command → handler map (exact signatures and semantics)

All handlers return `{error: boolean, message: string}` (some add extra fields).

| Token                                                                               | Method         |    Lines | Behavior / gaps                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | -------------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get <type> [name] [-n ns] [-l k=v] [--field-selector …] [-o wide\|yaml\|jsonpath]` | `_cmdGet`      |  319–408 | Table formats per-kind `_getHeaderForKind` L410 / `_formatResourceRow` L415–443. `-o yaml` is synthetic L385–391. `--field-selector involvedObject.name=` returns **hard-coded** event lines L344–357; `spec.nodeName=` filters pods L358–365. `get events` (kind `Event`) always empty (no model). |
| `describe <type> <name>`                                                            | `_cmdDescribe` |  457–492 | Calls `res.toDescribe()` if present (L469–471), else generic fallback (L473–491).                                                                                                                                                                                                                   |
| `logs <pod> [-n ns] [--previous/-p]`                                                | `_cmdLogs`     |  494–530 | Fake log lines; `--previous` returns a canned crash trace L513–521.                                                                                                                                                                                                                                 |
| `scale <type> <name> --replicas=N`                                                  | `_cmdScale`    |  532–558 | Only `Deployment/StatefulSet/ReplicaSet` (L540); queues `{type:'scale'}` (L552).                                                                                                                                                                                                                    |
| `delete <type> <name> [-n ns]`                                                      | `_cmdDelete`   |  560–579 | Queues `{type:'delete'}`.                                                                                                                                                                                                                                                                           |
| `apply -f <filename>`                                                               | `_cmdApply`    |  581–612 | **Filename heuristic, not YAML**: `deploy` in name → Deployment, `svc/service` → Service, `node` → Node, else Pod (L586–590); fabricates a default spec.                                                                                                                                            |
| `create <type> <name> [--namespace ns]`                                             | `_cmdCreate`   |  614–665 | 18 default specs L624–643; `-n` short form **not** handled (only `--namespace`, L621); no flags for image/replicas/labels.                                                                                                                                                                          |
| `run <name> --image=img`                                                            | `_cmdRun`      |  667–695 | Creates a Pod; `konami` easter egg L689–692.                                                                                                                                                                                                                                                        |
| `label <type> <name> k=v …`                                                         | `_cmdLabel`    |  697–723 | Also supports `k-` removal. Mutates `metadata.labels` directly (no reindex in `ClusterState`).                                                                                                                                                                                                      |
| `rollout <status\|restart\|undo\|history> <type> <name>`                            | `_cmdRollout`  |  725–758 | **Space-separated form only** (`deployment nginx`), no `deployment/nginx` slash form. `status` is a canned string L738–740; `restart`/`undo` emit events only; `history` reads `res._revisionHistory` (never set by engine — always one fake row).                                                  |
| `drain <node> [--force]`                                                            | `_cmdDrain`    |  760–776 | Queues `{type:'drain'}`.                                                                                                                                                                                                                                                                            |
| `cordon/uncordon <node>`                                                            | `_cmdCordon`   |  778–794 | Queues `{type:'cordon'                                                                                                                                                                                                                                                                              | 'uncordon'}`. |
| `top nodes\|pods [name]`                                                            | `_cmdTop`      |  796–835 | Reads non-existent `n.cpuUsage`/`p.memoryUsage` fields (mostly zeros), or `status.usage` for nodes.                                                                                                                                                                                                 |
| `exec <pod> -it -- cmd`                                                             | `_cmdExec`     |  837–851 | Simulated text only.                                                                                                                                                                                                                                                                                |
| `explain <resource>[.field]`                                                        | `_cmdExplain`  | 853–1189 | Database-driven; see §3.3.                                                                                                                                                                                                                                                                          |

### 3.3 `kubectl explain` database (`CommandBar.js:859–1127`)

`EXPLAIN_DATA` shape:

```js
{
  pod: {
    kind: 'Pod',
    version: 'v1',
    description: 'Pod is a collection of containers …',
    fields: {
      'spec': 'PodSpec - Specification …',
      'spec.containers': 'Container[] - List of containers …',
      'spec.containers.image': 'string - Docker image name.',
      // dotted paths; top-level `explain pod` lists only depth<=2 paths (L1159–1164)
      // `explain pod.spec.containers` prints exact match + direct children (L1175–1186)
    }
  },
  deployment: {…}, service: {…}, node: {…}, namespace: {…}, configmap: {…}, secret: {…},
  networkpolicy: {…}, hpa: {…}, statefulset: {…}, daemonset: {…}, job: {…}, cronjob: {…},
  ingress: {…}, pvc: {…}, role: {…}, rolebinding: {…}, serviceaccount: {…}, pdb: {…},
  replicaset: {…}
}
```

20 resources; `EXPLAIN_ALIASES` L1129–1150 maps plural/abbrev → key. **No OpenShift kinds.** This is a
high-value conversion surface: add `route`, `buildconfig`, `imagestream`, `deploymentconfig`, `project`,
`template`, `scc`, `subscription`, `csv`, `operatorgroup`, `poddisruptionbudget` stays, etc.

**Output (1.14.0, issue #76):** the renderer now emits kubectl 1.35's explain v2 plaintext —
a `GROUP:` line only for non-core API groups, `KIND:`/`VERSION:` aligned like kubectl's column 13,
an optional `FIELD: <path> <Type>` line plus a wrapped 4-space `DESCRIPTION:`, and `FIELDS:` entries
as `  <path>\t<Type>` in alphabetical order on one line (enums rendered, `rollingUpdate` added for
the Deployment strategy). The curated `EXPLAIN_DATA` above is still the source and the descriptions
stay the game's teaching text; the format/field structure is the contract. Locked by
`qa-issue70-76` and `verify.mjs` §4k.

### 3.4 `GameEngine` API (`js/engine/GameEngine.js`)

`GAME_MODES` L121–126 (`campaign/sandbox/chaos/challenge`), `GAME_STATES` L128–136.

Constructor L138–200: `eventBus`, `cluster`, `simulation`, state/mode/difficulty, fixed timestep
`1000/(options.ticksPerSecond||20)` = 50 ms (L155), `_maxDeltaTime=100` (L156), game time/real time,
timeScale, score/level/experience/currency/reputation, achievements/objectives/notifications maps,
`_inputQueue`, `_commandHistory`, plugins, render/update callbacks, difficulty multipliers L191–196
(`failureRate/resourceMultiplier/scoreMultiplier` for easy/normal/hard/nightmare).

| API                                                                          |    Line | Notes                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_applyDifficulty()`                                                         |     202 | sets `simulation.randomFailureRate` = `0.002 × failureRate`                                                                                                                                                                                                                          |
| `_setupEngineEvents()`                                                       |     209 | incident/chaos/quota/cluster:added:Pod listeners (XP/notifications)                                                                                                                                                                                                                  |
| `start/stop/pause/resume/togglePause`                                        | 247–299 | RAF loop lifecycle                                                                                                                                                                                                                                                                   |
| `_gameLoop(timestamp)`                                                       | 301–355 | fixed-step loop: `_processInputQueue` → `simulation.tick(dt)` → update callbacks → `_checkObjectives`; render callbacks; emits `engine:frame`; emits `tick` ~every 500 ms with `{elapsed(gameTime ms), gameTime, realTime, fps, mode, metrics:{cpu,memory}, clusterHealth}` L340–352 |
| `queueCommand(command)`                                                      |     391 | push + timestamp; processed next fixed step                                                                                                                                                                                                                                          |
| `_executeCommand(command)`                                                   | 398–431 | emits `command:executed`; switch `create,delete,scale,apply,cordon,uncordon,drain,rollout,exec,logs`                                                                                                                                                                                 |
| `_handleCreate`                                                              | 433–454 | dead code (no caller queues `type:'create'`)                                                                                                                                                                                                                                         |
| `_handleDelete`                                                              | 456–465 | `cluster.remove`                                                                                                                                                                                                                                                                     |
| `_handleScale`                                                               | 467–478 | `resource.updateSpec({replicas})` (no `scale()` method call)                                                                                                                                                                                                                         |
| `_handleApply`                                                               | 480–497 | dead code (no caller)                                                                                                                                                                                                                                                                |
| `_handleCordon/Uncordon/Drain`                                               | 499–537 | drain skips DaemonSet pods unless `force`; `markForDeletion` on others                                                                                                                                                                                                               |
| `_handleRollout`                                                             | 539–579 | `restart` sets `kubectl.kubernetes.io/restartedAt` annotation L549 then emits `rollout:zero-downtime` if no failed pods; `undo` increments `cluster._rollbackCount` L559; `status` reads `resource.status.*`                                                                         |
| `_handleExec/_handleLogs`                                                    | 581–599 | events-as-logs                                                                                                                                                                                                                                                                       |
| `_apiVersionForKind`                                                         | 601–615 | map for all 25 kinds (correct versions)                                                                                                                                                                                                                                              |
| `setMode`                                                                    | 617–638 | chaos config toggling                                                                                                                                                                                                                                                                |
| `setDifficulty`                                                              |     640 |                                                                                                                                                                                                                                                                                      |
| `setTimeScale`                                                               |     646 | 0–10, also `simulation.setTickRate`                                                                                                                                                                                                                                                  |
| `addObjective(id,{description,condition(cluster,engine),reward,xp,timeout})` | 652–661 | **generic objective plugin point** (different from CampaignMode's `type` evaluator)                                                                                                                                                                                                  |
| `_checkObjectives`                                                           | 663–691 | evaluates `condition` functions, timeout, emits `objective:*`                                                                                                                                                                                                                        |
| `unlockAchievement`                                                          |     693 |                                                                                                                                                                                                                                                                                      |
| `addScore/addCurrency/spendCurrency`                                         | 706–719 |                                                                                                                                                                                                                                                                                      |
| `_addNotification/getNotifications/...`                                      | 721–755 |                                                                                                                                                                                                                                                                                      |
| `onRender/onUpdate`                                                          | 757/764 | callback registration returns unsubscribe                                                                                                                                                                                                                                            |
| `registerPlugin(name, plugin)` / `getPlugin`                                 | 771–781 | plugin `init(engine)` / `destroy()`; **only real plugin system**; emits `plugin:registered`; unused by game                                                                                                                                                                          |
| `getState()`                                                                 | 783–804 | HUD reads `mode/elapsed?` (note: HUD `_onTick` gets event payload, not this)                                                                                                                                                                                                         |
| `getCommandHistory(limit)`                                                   |     806 |                                                                                                                                                                                                                                                                                      |
| `reset()`                                                                    | 811–835 | stops, clears cluster+simulation, resets score/time/etc                                                                                                                                                                                                                              |
| `saveState()` / `loadState()`                                                | 837/862 | complete but **never called** (G11)                                                                                                                                                                                                                                                  |
| `destroy()`                                                                  |     902 | plugins destroy + remove listeners                                                                                                                                                                                                                                                   |

Queued commands actually used: `scale` (CommandBar L552, index scale dialog L1337), `delete` (CommandBar
L573, ContextMenu L196), `rollout restart/undo` (ContextMenu L209/L214), `cordon/uncordon/drain`
(CommandBar L770/788, ContextMenu L218–224). `create/apply/exec/logs` handlers are unreachable.

### 3.5 SimEvents catalogue (producer → consumers)

| Event                                                                                                                        | Emitted by                                            | Consumed by                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `engine:started/stopped/paused/resumed/frame`                                                                                | GameEngine                                            | (unused)                                                                                                            |
| `tick`                                                                                                                       | GameEngine L343                                       | HUD L194, Minimap L93, MetricsDashboard L111                                                                        |
| `engine:mode-changed`, `engine:difficulty-changed`, `engine:timescale-changed`, `engine:reset`, `engine:loaded`              | GameEngine                                            | (unused)                                                                                                            |
| `command:executed`                                                                                                           | GameEngine L404; CommandBar L272                      | ScoringEngine L91                                                                                                   |
| `command:raw`                                                                                                                | CommandBar L271                                       | IncidentPanel L87                                                                                                   |
| `command:exec`, `command:unknown`                                                                                            | GameEngine                                            | (unused)                                                                                                            |
| `cluster:added/modified/deleted/reset` + `cluster:<type>:<Kind>`                                                             | ClusterState L77–100, L718                            | index.html renderer sync L557–580; ScoringEngine `cluster:added:Pod` L236; SimulationTick `cluster:deleted:Pod` L11 |
| `incident:created`                                                                                                           | IncidentEngine L289                                   | index.html L736, IncidentPanel L86, HUD L195, Minimap L94                                                           |
| `incident:activated`, `incident:investigating`, `incident:step-completed`, `incident:cascade`, `incident:cascading-resolved` | IncidentEngine                                        | **(no listener except cascading-resolved in ScoringEngine L103)**                                                   |
| `incident:resolved`                                                                                                          | IncidentEngine L403, IncidentPanel L137               | HUD L196, Minimap L95, ChaosMode L67, ScoringEngine L87                                                             |
| `incident:oomkill`                                                                                                           | SimulationTick L436                                   | GameEngine L210                                                                                                     |
| `hpa:scaled`                                                                                                                 | SimulationTick L743                                   | GameEngine L216                                                                                                     |
| `chaos:podkill` / `chaos:nodefailure`                                                                                        | SimulationTick L820/L843                              | GameEngine L223/L227                                                                                                |
| `quota:exceeded`                                                                                                             | SimulationTick L802                                   | GameEngine L232                                                                                                     |
| `resource:created`                                                                                                           | CommandBar L604/658/683; SandboxMode L104             | ScoringEngine L83                                                                                                   |
| `resource:applied`                                                                                                           | CommandBar L609                                       | (unused)                                                                                                            |
| `resource:restarted` / `resource:rollback`                                                                                   | CommandBar L742/L747; GameEngine L562                 | (unused)                                                                                                            |
| `resource:healed` / `resource:rescheduled` / `cluster:dns-restored` / `security:credential-rotated`                          | IncidentEngine L435–448                               | **none — no listeners** (G9)                                                                                        |
| `rollout:zero-downtime`                                                                                                      | GameEngine L554                                       | ScoringEngine L115                                                                                                  |
| `secret:exposed-fixed`                                                                                                       | IncidentEngine L419                                   | ScoringEngine L109                                                                                                  |
| `xp:gain`                                                                                                                    | CommandBar, IncidentPanel, HUD dialogs, index         | HUD L197 (display only; does **not** add XP)                                                                        |
| `xp:gained`, `player:level-up`, `achievement:unlocked`                                                                       | ScoringEngine                                         | HUD L199 toast; index? no                                                                                           |
| `score:changed`, `notification`                                                                                              | GameEngine                                            | (unused)                                                                                                            |
| `resource:selected` / `resource:deselected` / `resource:hovered` / `resource:contextmenu`                                    | index renderer callbacks L582–588; ContextMenu        | InspectorPanel, HUD, MetricsDashboard, ContextMenu                                                                  |
| `ui:show-command-bar`                                                                                                        | IncidentPanel L301                                    | CommandBar L116                                                                                                     |
| `ui:run-command`                                                                                                             | ContextMenu L227/L230                                 | index.html L749 → `commandBar._executeCommand`                                                                      |
| `ui:edit-resource`                                                                                                           | InspectorPanel `_onEdit` (L474)                       | index.html L755                                                                                                     |
| `ui:scale-dialog`                                                                                                            | ContextMenu L205                                      | index.html L759                                                                                                     |
| `ui:toggle-incidents`                                                                                                        | HUD L181                                              | IncidentPanel L85                                                                                                   |
| `campaign:*` (`level-started/update/level-completed/level-failed/paused/resumed/hint-used/tutorial-step/…`)                  | CampaignMode                                          | **none** (index uses `mode:level-complete` only)                                                                    |
| `challenge:*`                                                                                                                | ChallengeMode                                         | none                                                                                                                |
| `chaos:*`                                                                                                                    | ChaosMode                                             | none                                                                                                                |
| `sandbox:*`, `yaml:viewed`                                                                                                   | SandboxMode                                           | ScoringEngine L97 (`yaml:viewed`)                                                                                   |
| `mode:level-complete` / `mode:game-over`                                                                                     | CampaignMode L481, ChallengeMode L588, ChaosMode L212 | index.html L722/L731 (modals)                                                                                       |
| `objective:added/completed/failed`                                                                                           | GameEngine                                            | (unused)                                                                                                            |
| `settings:changed`                                                                                                           | SettingsPanel L211                                    | (unused)                                                                                                            |
| `easter-egg:triggered`                                                                                                       | CommandBar L278, L690                                 | ScoringEngine L121                                                                                                  |
| `plugin:registered`                                                                                                          | GameEngine L776                                       | (unused)                                                                                                            |
| `simulation:tick`                                                                                                            | SimulationTick L80                                    | (unused)                                                                                                            |

### 3.6 Exact extension points for the `kubectl` → `oc` rename + new commands

**Rename `kubectl` → `oc` (mechanical, ~20 sites):**
`CommandBar.js:91` (prompt), `:257`, `:269` (echo), help/usage strings `:320, :537, :615, :669, :698,
:727, :854`; `IncidentPanel.js:296, :372` (prefix stripping — should strip `/^(kubectl|oc)\s+/`);
incident data strings in `IncidentDefs.js` (126 occurrences of `kubectl …` across
`investigationSteps[].command`, `kubectlCommands[]`); campaign hints `CampaignLevels.js` (23 occurrences);
challenge hints `ChallengeMode.js` (9); `GameEngine.js:549` annotation key
`kubectl.kubernetes.io/restartedAt` (keep the real key for compatibility, but consider
`openshift.io/…` or K8s-valid annotations); index.html tutorial/copy `:111, :165, :1726, :1747, :1760`;
README/meta.

**Strongly recommended:** keep both prefixes accepted. Insert a normalization step at the top of
`_executeCommand` (before L282):

```js
const normalized = raw.replace(/^\s*(?:kubectl|oc)\s+/, '');
```

This fixes hint/incident UX and makes the rename idempotent. Then update the displayed prompt.

**Add commands (all require a handler + `COMMANDS` entry + completions + explain entry):**

| New command                                                                           | Insert where                                                                                                       | What to clone                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `new-app` (`--image`, `--code`, `--name`, `--template`)                               | new `_cmdNewApp` in CommandBar + dispatch L298                                                                     | `_cmdCreate` L614 for resource creation; needs Deployment/Service/ImageStream/BuildConfig synthesis |
| `new-project` / `project` / `projects`                                                | `_cmdNewProject`                                                                                                   | `_cmdCreate` Namespace branch; should switch "current project"                                      |
| `expose` (`svc`, `deployment`)                                                        | `_cmdExpose`                                                                                                       | `_cmdCreate` Service defaults L627 + `RESOURCE_CLASSES` Service                                     |
| `set` (`image`, `env`, `resources`, `probe`, `volume`)                                | `_cmdSet`                                                                                                          | mutation patterns in `index._showEditDialog` L1190 + `ResourceBase.updateSpec`                      |
| `attach` / `rsync`                                                                    | optional                                                                                                           | sim-only                                                                                            |
| `auth can-i` / `adm policy`                                                           | `_cmdAuth` / `_cmdAdmPolicy`                                                                                       | RBAC model + a new evaluator (SCC/RBAC resolution)                                                  |
| `process` (templates)                                                                 | `_cmdProcess`                                                                                                      | render `Template` data → resources; no existing parser                                              |
| `create route`                                                                        | extend `_cmdCreate` + `KIND_ALIASES` + Route model                                                                 | new mesh/registry work                                                                              |
| `start-build` / `logs bc/...` / `rollout` for DC                                      | new `_cmdStartBuild` etc.                                                                                          | `_tickJobs` controller pattern (§4)                                                                 |
| `get scc`, `get route`, `get bc`, `get is`, `get dc`, `get project`, `get csv/sub/og` | widen `KIND_ALIASES` L13, `RESOURCE_TYPES` L1, `_getHeaderForKind` L410, `_formatResourceRow` L415, `EXPLAIN_DATA` | new kinds in the model registry                                                                     |
| `edit` / `patch` / `replace -f`                                                       | new handlers                                                                                                       | needs a real YAML/JSON parser (see `_cmdApply` fix)                                                 |
| `apply -f` (real)                                                                     | rewrite `_cmdApply` L581                                                                                           | YAML parser + `kindRegistry` to instantiate correct class                                           |

**Fix `_cmdGet`** to support `-A/--all-namespaces` (currently parsed into `flagArgs` L334 but ignored),
`-o yaml/name`, `-o jsonpath`, `--show-labels`, `--sort-by`, and the real event stream (there is none —
decide: synthesize from `resource.events` or leave mock).
**Fix `_cmdCreate`** to accept `-n` (L621 only understands `--namespace`).
**Fix `_cmdRollout`** to accept `kind/name` syntax (`deployment/nginx`) at L729–732.
**Fix `_cmdApply`** to parse YAML instead of filenames at L581–612.

---

## 4. Simulation / controllers (`js/engine/SimulationTick.js`)

### 4.1 Tick pipeline

`SimulationTick.tick(deltaTime)` **L43–86** (called from `GameEngine._gameLoop` L317 with `dt = 0.05 s`,
multiplied by `tickRate`):

```
tickCount++
dt = deltaTime * tickRate
cluster.startBatch()
  _tickNodes(dt)                 L88    capacity/conditions from getNodeAllocatable
  _tickPodScheduling(dt)          L124   Pending+no nodeName → _findBestNode → set nodeName/phase Running/IP
  _tickPodLifecycle(dt)           L257   container status transitions, Ready, deletion grace
  _tickContainerResources(dt)     L316   synthetic CPU/mem usage + random failures
  _tickHealthChecks(dt)           L348   liveness/readiness/startup probes vs overload
  _tickOOMKiller(dt)              L408   mem > limit → OOMKilled → CrashLoopBackOff + incident:oomkill
  _tickDeployments(dt)            L449   RS reconciliation (creates plain RS, then pods)
  _tickStatefulSets(dt)           L523   ordinal pods
  _tickDaemonSets(dt)             L550   one pod per selected node
  _tickJobs(dt)                   L577   completion/backoff; pods "succeed" after _completionTime
  if tick % 10: _tickCronJobs(dt) L630  create Job from schedule
  if tick % 15: _tickHPA(dt)      L673   CPU% → scale target spec.replicas
  if tick % 5:  _tickProbes(dt)   L779   Service endpoints count + LoadBalancer IP
  _tickQuotaEnforcement(dt)       L797   cluster.resourceQuotas check → quota:exceeded
  _recordMetrics()                L895   metricsHistory (60 entries)
  if enableChaos: _tickChaos(dt)  L812
cluster.flushBatch()
emit simulation:tick L80
```

`cluster.startBatch()` (L47) is essential: per-tick `cluster:added/modified/deleted` events are deferred
until `flushBatch()` L77 so the renderer/UI update once per tick. Any new controller must run inside the
batch.

### 4.2 Controller inventory (what exists, what it converges, extension point)

| Controller                | Method:line                                                                | Reconciles                                             | Creates / effects                                                                                                                                                                       | State today                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Node status               | `_tickNodes` L88                                                           | Node conditions/allocatable/usage from pods            | conditions MemoryPressure/PIDPressure/Ready                                                                                                                                             | Works for Node resources with `spec.cpu/memory`                                                             |
| Scheduler                 | `_tickPodScheduling` L124 + `_findBestNode` L160                           | Pending pods without `nodeName`                        | assigns node, sets `Running`, IP, conditions, `_initContainerStatuses`                                                                                                                  | NodeSelector/taints/tolerations/soft node affinity only; no SCC, no affinity/anti-affinity beyond preferred |
| Pod lifecycle             | `_tickPodLifecycle` L257                                                   | containerStatuses state machine                        | ContainerCreating→Running, Ready conditions, deletion grace                                                                                                                             | no init containers, no volumes                                                                              |
| Container resource sim    | `_tickContainerResources` L316                                             | synthetic CPU/mem; random crash                        | CrashLoopBackOff                                                                                                                                                                        | difficulty-scaled `randomFailureRate`                                                                       |
| Probes                    | `_tickHealthChecks` L348 + `_evaluateProbe` L395                           | liveness/readiness/startup                             | restarts, Ready toggles                                                                                                                                                                 | probe = "overloaded" heuristic only                                                                         |
| OOM killer                | `_tickOOMKiller` L408                                                      | mem > limit                                            | OOMKilled reset + `incident:oomkill`                                                                                                                                                    | no QoS eviction                                                                                             |
| Deployment→ReplicaSet→Pod | `_tickDeployments` L449                                                    | desired replicas, selector-matched RS                  | creates **plain** ReplicaSet L462–476 via `ResourceBase`, then pods via `_createPodForWorkload`; sets status counts/conditions; scales by creating/removing pods                        | no rolling-update strategy math; ignores `status.updatedReplicas` semantics (sets = total pods)             |
| StatefulSet               | `_tickStatefulSets` L523                                                   | ordinal pods                                           | `_createPodForWorkload(sts, sts, name-ordinal)`; removes highest ordinal                                                                                                                | no PVC binding (no volumes)                                                                                 |
| DaemonSet                 | `_tickDaemonSets` L550                                                     | one pod per selected Ready node                        | pods with `spec.nodeName` forced                                                                                                                                                        | nodeSelector only                                                                                           |
| Job                       | `_tickJobs` L577                                                           | completions/backoff/parallelism                        | pods; sets `phase Complete/Failed`, conditions                                                                                                                                          | pod success is time-based (`_completionTime`, L613–625)                                                     |
| CronJob                   | `_tickCronJobs` L630                                                       | schedule via `Date.now()` vs `status.lastScheduleTime` | creates **plain** Job L642                                                                                                                                                              | simplifies cron parsing (`_parseCronInterval` L663)                                                         |
| HPA                       | `_tickHPA` L673                                                            | target Deployment replicas from CPU util               | writes `target.spec.replicas`, `hpa.status.*`, emits `hpa:scaled`                                                                                                                       | 30 s up / 300 s down cooldown; target found by `spec.scaleTargetRef` via `getByName`                        |
| Service endpoints         | `_tickProbes` L779                                                         | ready endpoints per selector                           | `svc.status.readyEndpoints/totalEndpoints`; fake LoadBalancer IP                                                                                                                        | Ingress not reconciled                                                                                      |
| Quota enforcement         | `_tickQuotaEnforcement` L797                                               | `cluster.resourceQuotas`                               | emits `quota:exceeded`                                                                                                                                                                  | uses separate quota map (not ResourceQuota resources)                                                       |
| Chaos                     | `_tickChaos` L812                                                          | random pod kill/node fail/stress                       | events `chaos:podkill`, `chaos:nodefailure`                                                                                                                                             | gated by `setChaosConfig`                                                                                   |
| Pod factory               | `_createPodForWorkload(parent, templateSource, nameOverride)` **L867–893** | —                                                      | `new ResourceBase('Pod','v1',…)`, copies template spec via JSON clone, labels from template, `pod-template-hash`, `addOwnerReference(parent)`, `cluster.add`, `cluster.addRelationship` | **All controller-created pods are plain base objects**                                                      |
| Metrics                   | `_recordMetrics` L895                                                      | metricsHistory                                         | ring of 60 `{cpu,memory,pods,nodes}`                                                                                                                                                    | consumed by `getMetricsHistory/summary` (no caller currently? MetricsDashboard uses cluster stats directly) |

**Controllers that do NOT exist but are implied by the model:** PVC→PV binding (`PersistentVolumeClaim.tick`
dead), Ingress→Service/endpoint reconciliation (`Ingress.tick` dead), ResourceQuota object status updates
(`ResourceQuota.updateUsage` dead), PDB status (`updateStatus` dead), HPA class tick dead (engine loop
replaces it), NetworkPolicy enforcement (only `evaluateIngress/Egress` helpers, uncalled), ReplicaSet
controller as an independent loop (folded into Deployments), Service→Pod endpoint `updateEndpoints`
(`Service.updateEndpoints` uncalled).

**1.14.0 additions (issues #70–#76):** image-pull resolution now parses
`<registry>/<ns>/<name>@sha256:<digest>` references and resolves them against the ImageStream's
`status.tags[].items[].image` tag history (`_resolveContainerImagePull`), with a pre-build `:latest`
Pod honestly `ImagePullBackOff` until the first push. ServiceAccount admission rejects a missing
`serviceAccountName` as a ReplicaSet `FailedCreate`; the MetalLB LoadBalancer path emits the
controller's single canonical `Normal IPAllocated Assigned IP [...]` event with the OCP-minor CSV
`metallb-operator.v4.22.0-202610281200`; changing the project-request template rolls the simulated
openshift-apiserver for 8 game seconds before `oc new-project` applies it; and PendingScheduling
damages through the Deployment template (see §4.3). Contracts in CONVERSION-SPEC §4.7.

### 4.3 Pod lifecycle state machine (as implemented)

```
Pod created (any path)              phase: Pending (from class ctor) or passed status
 ├─ scheduler _tickPodScheduling: Pending && !spec.nodeName && node found
 │     → spec.nodeName, status.phase='Running', status.podIP, conditions PodScheduled/Initialized
 │     → containerStatuses created by _initContainerStatuses (waiting ContainerCreating)
 ├─ lifecycle _tickPodLifecycle: waiting ContainerCreating → running (started=true, ready=false),
 │     then running+started → ready=true; all ready → conditions ContainersReady/Ready
 ├─ OOM: containerStatuses[i].resources.memory > limit → state waiting CrashLoopBackOff,
 │     lastState.terminated{exitCode:137, reason:'OOMKilled'}, restartCount++, incident:oomkill
 ├─ probes: liveness fail → waiting CrashLoopBackOff; readiness fail → ready=false
 ├─ deletion (metadata.deletionTimestamp + grace period) → phase Succeeded + remove finalizer
 ├─ Job controller may set Succeeded directly (time-based; `pod.setPhase('Succeeded')`)
 └─ Never reaches `Failed` except chaos/tests and `terminate()` on class instances (unused)
```

Phases used in UI/status colors: `Pending, ContainerCreating (not a real phase), Running,
CrashLoopBackOff, Succeeded, Failed, Terminating, Complete, Available, Progressing, Suspended, Bound,
Released, Lost, Active, NotReady, Unknown` (`ResourceMeshes.STATUS_COLORS` L3–18).

**1.14.0 lifecycle contracts (issues #73/#75/#76):** a bound Pod's spec is immutable, so the
PendingScheduling incident patches the Deployment template instead (new ReplicaSet Pod Pending with
a real v1.35 `FailedScheduling` event, old Pods serving; repair via `oc rollout undo`,
`oc patch`/`oc edit` or `oc label node` — never only `oc delete pod`). CrashLoopBackOff restart
timing follows the real kubelet back-off (10 s/20 s/40 s) against Pod AGE; an incident's crash seed
rolls a new Deployment revision so new Pods crash from the first start while old Pods serve; a
NotReady Node freezes `LastHeartbeatTime` at the last kubelet post while `LastTransitionTime`
records the onset; and `oc describe pod` renders kubectl 1.35 container-state lines (Waiting prints
only `Reason`, a Terminated `Last State` prints `Started:` before `Finished:`, a Running container
prints `cri-o://<id>` + an image digest). Contracts in CONVERSION-SPEC §4.7.

### 4.4 Where OpenShift controllers must plug in

The fixed extension point is the tick pipeline §4.1 — add calls between existing controllers. Concrete
designs that fit the existing style:

1. **DeploymentConfig → ReplicationController → Pod.** Clone `_tickDeployments` (L449) into
   `_tickDeploymentConfigs(dt)`; keep `OWNER_CHAINS` extended (`DeploymentConfig→[ReplicationController]`,
   `ReplicationController→[Pod]`). Trigger (`spec.triggers` ImageChange/ConfigChange) needs an
   image-stream watch → see BuildConfig.
2. **BuildConfig → Build → ImageStream.** Clone the Job/CronJob pattern: `_tickBuilds(dt)` transitions
   Build phases (`New→Pending→Running→Complete/Failed`, time-based) and on completion **mutates the
   referenced ImageStream status tags** (`image.openshift.io/v1` ImageStream `status.tags[{tag,items[
{image,dockerImageReference}]}]`) then (optionally) triggers a new rollout on workloads with
   `imageChange` triggers. `_tickBuildConfigs(dt)` creates Builds on source change/webhook; the
   `Build→BuildConfig` owner relationship uses `cluster.addRelationship`.
3. **Route admission.** New `_tickRoutes(dt)` after `_tickProbes` L779: for every
   `Route(route.openshift.io/v1)`, resolve `spec.to{kind:'Service',name,weight}`, check target Service
   exists + has endpoints; set `status.ingress[{host,routerName,conditions:[{type:'Admitted',status:…}]}]`;
   emit `route:admitted` / `route:rejected`. Ingress can be kept as a separate kind or mapped.
4. **Project / namespace lifecycle.** No controller needed if `Project` = a `Namespace` with annotations
   (`openshift.io/display-name`, `openshift.io/requester`) + self-provisioner check. Seed
   `openshift-*` namespaces in `ClusterState._initDefaultNamespaces` L50.
5. **SCC enforcement.** Hook into `_findBestNode`/`_tickPodScheduling` and `_createPodForWorkload`:
   reject pods whose pod+container securityContext violates the bound SCC, set a `Warning FailedCreate`
   event, and leave the pod Pending (matches real UX and makes SCC incidents/objectives possible).
6. **Operators/OLM.** Model `Subscription`, `ClusterServiceVersion`, `InstallPlan`, `OperatorGroup` as
   mostly-static resources with a `_tickSubscriptions` that progresses CSV phase over ~N ticks and creates
   the operator Deployment (reuse `_createPodForWorkload` against a synthesized Deployment). No real
   operator logic needed for EX280 (install/verify/inspect is enough).
7. **Template processing.** Not a controller — a command (`oc process`) + data list; render parameters
   into a set of `{kind, name, spec}` objects and call `cluster.addResource`/new class instances.

Do **not** put OpenShift logic in the resource subclass `tick()` methods — they are never invoked
(G6); either wire a per-resource tick into `SimulationTick` or follow the existing controller style.

---

## 5. Incidents

### 5.1 Schema (`js/data/IncidentDefs.js`)

```js
{                                       // example: IncidentDefs.js:2-22
  id: 'crash-loop-backoff',
  name: 'CrashLoopBackOff',             // unique display name — cascade rules key on this
  category: 'Pod',                      // 'Pod'|'Node'|'Network'|'Storage'|'ControlPlane'|'Workload'
  severity: 3,                          // 1..5 → INCIDENT_CATEGORIES weights & SEVERITY_LEVELS XP
  description: 'A container is repeatedly crashing …',
  visualEffect: 'pulse-red',            // UI hint only (HUD/minimap use incident events)
  affectedResourceTypes: ['Pod','Deployment'],   // used for random target selection
  investigationSteps: [
    { command: 'kubectl logs <pod> --previous', hint: 'Check previous container logs for crash reason' },
    { command: 'kubectl describe pod <pod>',    hint: 'Look at Events section …' },
    { command: 'kubectl get events --field-selector involvedObject.name=<pod>', hint: '…' }
  ],
  resolutionActions: [                   // purely informational today; actionId is passed to resolve
    { action: 'fix-image', label: 'Fix container image tag', difficulty: 1 },
    { action: 'fix-command', label: 'Correct entrypoint command', difficulty: 2 },
    { action: 'fix-resources', label: 'Increase memory limit', difficulty: 1 }
  ],
  kubectlCommands: ['kubectl logs', 'kubectl describe pod', 'kubectl delete pod'],
  autoResolveTime: null                 // seconds; if set, auto-resolves (resolveIncident(id,'auto'))
}
```

- `INCIDENT_CATEGORIES` L705–712: `{Pod:#ef4444 w.3, Node:#f97316 w.2, Network:#eab308 w.2, Storage:
#8b5cf6 w.1, ControlPlane:#dc2626 w.1, Workload:#3b82f6 w.1}`.
- `SEVERITY_LEVELS` L714–720: level → `{name, color, xpReward, timeMultiplier}`: 1 Low 25 / 1.5s ×,
  2 Medium 50 / 1.2, 3 High 100 / 1.0, 4 Critical 200 / 0.8, 5 Emergency 350 / 0.6.
- `<pod>`, `<node>`, `<service>`, `<policy>`, `<ingress>`, `<namespace>` are placeholder tokens replaced by
  target name in `IncidentPanel` (L14) and in step matching (L371). `<pod>` also appears in
  `kubectlCommands` strings but those are display only.

### 5.2 `IncidentEngine` lifecycle (`js/engine/IncidentEngine.js`)

- **States** L3–8: `Created → Active → Investigating → Resolved`.
- `class Incident` L10–67: copies def fields, `investigationSteps` with `completed` flags,
  `resolutionActions`, `kubectlCommands`, `autoResolveTime`, `target`, timestamps, `investigationProgress`,
  `cascadeChildren/parent`, `comboEligible`. `activate()` L35, `startInvestigation()` L40,
  `completeInvestigationStep(i)` L46 (progress = completed/total), `resolve()` L53,
  `getResolutionTime()` L58, `isExpired(now)` L63.
- `class IncidentEngine` L69–551:
  - constructor L70–113: `activeIncidents Map`, `resolvedIncidents[]`, difficulty weights L115–133,
    cascade rules L87–110, `paused`, `comboWindow=10000`, `maxCascadeDepth=3`.
  - **`start(mode)` L146–160 installs `setInterval(() => this.tick(1000), 1000)`.** `index.html:553`
    _also_ calls `incidentEngine.tick(dt)` (dt in **seconds**, ≈0.05) every fixed sim step. So incident
    time advances at ~1.05× realtime via two different clocks/units (G12). Modes call
    `incidentEngine.start(...)` after setup.
  - `tick(deltaMs)` L178–191: accumulate elapsed, `processScriptedIncidents` (triggerTime seconds),
    `processAutoResolve`, `updateActiveIncidents` (emit `incident:activated` once), and for chaos mode
    `processChaosTick` (random spawn; difficulty = 1+floor(minutes/2) capped 10; spawn chance 1/interval;
    cap active = 5+level).
  - `selectRandomTarget(def)` L262–276: union of `affectedResourceTypes` instances; returns name or
    `'unknown'`.
  - `spawnIncident(def,target,sev)` L278–304: id `inc-<n>`, emits `incident:created` with investigation
    steps + resolution actions, schedules cascades.
  - **Cascade rules** L87–110 (parent **name** → children with probability/delay/severity):
    `NodeNotReady→PodEviction(.8,5s,2) + ServiceEndpointMissing(.5,8s,3)`;
    `OOMKilled→ReadinessProbeFailure(.6,3s,2)`;
    `DNSResolutionFailure→ServiceEndpointMissing(.7,4s,3) + ReadinessProbeFailure(.4,6s,2)`;
    `EtcdLatency→APIServerOverloaded(.6,5s,5) + SchedulerFailure(.4,8s,4)`;
    `NodeDiskPressure→PodEviction(.7,10s,2)`;
    `NodeMemoryPressure→OOMKilled(.6,5s,3) + PodEviction(.5,8s,2)`.
  - `investigateIncident` L341, `completeStep` L361 (emits `incident:step-completed`).
  - **`resolveIncident(id, actionId)` L376–425**: removes from active, adds to resolved; XP =
    severity reward × combo multiplier (25%/combo within 10 s) × 1.5 if resolved < 30 s; emits
    `incident:resolved` (+`incident:cascading-resolved`, `secret:exposed-fixed`); calls
    `applyResolutionEffects`.
  - **`applyResolutionEffects(incident, actionId)` L427–450**: switch on incident **name**; emits
    `resource:healed` / `resource:rescheduled` / `cluster:dns-restored` /
    `security:credential-rotated` — **all unhandled** (G9). It does **not** mutate any resource: no phase
    reset, no capacity restore, no node uncordon. Resolving an incident is purely a UI/XP action.
  - `getActiveIncidents()` L452 (summary incl. `investigationProgress`, `hasCascade`),
    `getIncidentDetails` L467 (full), `getStats` L491 (totalResolved, avgResolveTime, bySeverity,
    byCategory, cascadeCount, combo, difficultyLevel), `getClusterHealth` L521–529 (100 − Σ
    severity/5×15, clamped), `reset` L531, `destroy` L547.
- `IncidentPanel` (`js/ui/IncidentPanel.js`): builds `INVESTIGATION_STEPS` from defs at module load
  (L9–17, replaces `<pod>` etc. with `{name}`); filters Active/Resolved/All; click a step pre-fills the
  command bar (L291–305; strips `kubectl` prefix); `_onCommandExecuted` (L363–381) fuzzy-matches typed
  commands against steps (`_fuzzyMatchCommand` L383–411) and marks them complete; card becomes resolvable
  after **`_requiredSteps = 2`** completed (L29–30, L200) regardless of total steps; `resolveIncident`
  L126–141 calls engine + emits XP. localStorage progress save/load L413–437 is effectively dead
  (incident ids are regenerated each session).
- **Bug:** `SEVERITY_CONFIG` keys are strings `critical/warning/info` (L3–7) but `incident.severity` is a
  number from the engine and `index.html:739` passes numeric values → every card renders with the fallback
  `info` (blue) style. Cosmetic but it will show up in screenshots.

### 5.3 Full incident inventory (34)

|   # | id                              | name                         | category     | sev | affected kinds                 | auto-resolve |
| --: | ------------------------------- | ---------------------------- | ------------ | --: | ------------------------------ | -----------: |
|   1 | crash-loop-backoff              | CrashLoopBackOff             | Pod          |   3 | Pod, Deployment                |            — |
|   2 | image-pull-backoff              | ImagePullBackOff             | Pod          |   2 | Pod, Deployment                |            — |
|   3 | oom-killed                      | OOMKilled                    | Pod          |   3 | Pod, Deployment                |            — |
|   4 | pod-eviction                    | PodEviction                  | Pod          |   2 | Pod, Node                      |            — |
|   5 | readiness-probe-failure         | ReadinessProbeFailure        | Pod          |   2 | Pod, Service                   |         60 s |
|   6 | pod-stuck-terminating           | PodStuckTerminating          | Pod          |   2 | Pod                            |        120 s |
|   7 | node-not-ready                  | NodeNotReady                 | Node         |   5 | Node, Pod                      |            — |
|   8 | node-disk-pressure              | NodeDiskPressure             | Node         |   4 | Node                           |            — |
|   9 | node-memory-pressure            | NodeMemoryPressure           | Node         |   4 | Node, Pod                      |            — |
|  10 | node-pid-pressure               | NodePIDPressure              | Node         |   3 | Node                           |            — |
|  11 | service-endpoint-missing        | ServiceEndpointMissing       | Network      |   3 | Service, Deployment            |            — |
|  12 | dns-resolution-failure          | DNSResolutionFailure         | Network      |   4 | Service, Pod                   |            — |
|  13 | network-policy-blocking         | NetworkPolicyBlocking        | Network      |   3 | NetworkPolicy, Service, Pod    |            — |
|  14 | ingress-misconfigured           | IngressMisconfigured         | Network      |   3 | Ingress, Service               |            — |
|  15 | unauthorized-access             | UnauthorizedAccess           | Network      |   5 | Pod, ServiceAccount, Namespace |            — |
|  16 | pvc-pending                     | PVCPending                   | Storage      |   3 | PVC, PV                        |            — |
|  17 | volume-mount-failure            | VolumeMountFailure           | Storage      |   3 | Pod, PVC                       |            — |
|  18 | volume-capacity-full            | VolumeCapacityFull           | Storage      |   4 | PV, PVC, Pod                   |            — |
|  19 | etcd-latency                    | EtcdLatency                  | ControlPlane |   5 | Node                           |            — |
|  20 | api-server-overloaded           | APIServerOverloaded          | ControlPlane |   5 | Node                           |            — |
|  21 | scheduler-failure               | SchedulerFailure             | ControlPlane |   4 | Pod, Node                      |            — |
|  22 | webhook-timeout                 | WebhookTimeout               | ControlPlane |   4 | Pod, Deployment                |         90 s |
|  23 | deployment-stuck-rollout        | DeploymentStuckRollout       | Workload     |   3 | Deployment, ReplicaSet         |            — |
|  24 | hpa-scaling-failure             | HPAScalingFailure            | Workload     |   2 | HPA, Deployment                |            — |
|  25 | job-deadline-exceeded           | JobDeadlineExceeded          | Workload     |   2 | Job, Pod                       |            — |
|  26 | liveness-probe-failure          | LivenessProbeFailure         | Pod          |   3 | Pod, Deployment                |            — |
|  27 | certificate-expiry              | CertificateExpiry            | ControlPlane |   5 | Secret, Ingress                |            — |
|  28 | cronjob-missed-schedule         | CronJobMissedSchedule        | Workload     |   2 | CronJob, Job                   |            — |
|  29 | secret-exposed                  | SecretExposed                | ControlPlane |   5 | ConfigMap, Secret              |            — |
|  30 | statefulset-ordered-ready-stuck | StatefulSetOrderedReadyStuck | Workload     |   3 | StatefulSet, Pod               |            — |
|  31 | resource-quota-exceeded         | ResourceQuotaExceeded        | Workload     |   3 | Pod, Deployment, ResourceQuota |            — |
|  32 | init-container-crash            | InitContainerCrash           | Pod          |   3 | Pod, Deployment                |            — |
|  33 | loadbalancer-pending            | LoadBalancerPending          | Network      |   2 | Service                        |            — |
|  34 | webhook-rejection               | WebhookAdmissionRejection    | ControlPlane |   4 | Pod, Deployment                |         90 s |

Notes for conversion: every `investigationSteps[].command`, `kubectlCommands[]`, and descriptive text is
`kubectl`-worded; none reference OpenShift primitives (Route/Build/SCC/Project). New EX280 incidents to
add: ImagePullBackOff due to registry auth (internal registry), `CrashLoopBackOff` due to missing
ConfigMap/Secret, `Route` not admitted (host already claimed), `Build` failed (S2I), SCC `Forbidden` on
`runAsUser`, quota exceeded on `DeploymentConfig`, `ImageStreamTag` not found, `oc new-app` failure,
project self-provisioner denied, certificate expiry in `Route` edge TLS, `Operator` CSV failed.
Resolution for incidents must eventually mutate cluster state (currently doesn't — G9); EX280 missions
should require the _player to actually fix the resource_, then the card resolves.

**1.14.0 incident contracts (issues #73/#75/#76):** the shipped `PendingScheduling` incident now
damages through the Deployment template (new ReplicaSet Pod `Pending`, real scheduler
`FailedScheduling` wording, old Pods serving, `ProgressDeadlineExceeded` over time; no Pod-spec
mutation, no `Normal Healed` reason, no impossible aggregated counts). `UnauthorizedAccess` emits no
RBAC events — the denial is surfaced in `oc logs <workload>` — and the resolved `JobDeadlineExceeded`
message is exactly `Job was active longer than specified deadline` (no appended duration) with
`oc describe job` printing `Active Deadline Seconds:  <n>s`. MetalLB LoadBalancer events are the
controller's `Normal IPAllocated Assigned IP [...]` (single canonical emitter). Contracts in
CONVERSION-SPEC §4.7.

---

## 6. Campaign and objectives

### 6.1 `CampaignLevels` schema (`js/data/CampaignLevels.js`)

```js
{                                       // example: level 4, L88-113
  id: 4,
  title: 'CrashLoopBackOff',
  chapter: 1,
  chapterName: 'Foundations',
  description: '…long explainer…',
  objectives: [
    { type: 'resolve', incidentType: 'CrashLoopBackOff', count: 1, label: 'Diagnose and resolve …' },
    { type: 'uptime', percentage: 95, label: 'Keep cluster health above 95%' }
  ],
  startingResources: [
    { kind: 'Node', name: 'node-1', spec: { cpu: '4', memory: '8Gi', status: 'Ready' } },
    { kind: 'Deployment', name: 'web-app', spec: { replicas: 3, template: { spec: { containers: [
        { name: 'main', image: 'nginx:latest' }] } } } }
  ],
  availableResources: ['Pod', 'Deployment', 'Node'],   // NOT enforced anywhere (informational)
  incidents: [ { type: 'CrashLoopBackOff', triggerTime: 10, target: 'web-app', severity: 2 } ],
  hints: ['…3 strings…'],
  starCriteria: { time: 180, efficiency: 0.8, noFailures: false },  // seconds, 0..1, bool
  nextLevel: 5,
  tutorial: { steps: [ { target: 'command-bar', text: '…' } ] }   // only levels 1-2; dead (see §6.5)
}
```

`CHAPTERS` L605–611: 5 chapters × 4 levels. `CampaignMode` imports both; `Config` is static data — this is
the primary OpenShift content file to rewrite.

### 6.2 Level inventory (20)

|  id |  ch | title                             | objective types used                                                    | scripted incidents                                |
| --: | --: | --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
|   1 |   1 | Your First Pod                    | deploy Pod, deploy Namespace                                            | —                                                 |
|   2 |   1 | Deployments & ReplicaSets         | deploy Deployment, scale Deployment→3                                   | —                                                 |
|   3 |   1 | Scheduling & Multi-Node Clusters  | deploy Node×3, deploy Pod×6, distribute≥2 nodes                         | —                                                 |
|   4 |   1 | CrashLoopBackOff                  | resolve CrashLoopBackOff, uptime 95%                                    | CrashLoopBackOff @10s                             |
|   5 |   2 | Self-Healing & Pod Eviction       | deploy Deployment×3, replicas≥2, resolve PodEviction×2                  | PodEviction @30/60                                |
|   6 |   2 | DaemonSets: One Pod Per Node      | deploy DaemonSet, deploy Node×4, coverage                               | —                                                 |
|   7 |   2 | Jobs & CronJobs: Batch Processing | deploy Job×2, complete Job×2, deploy CronJob                            | JobDeadlineExceeded @45                           |
|   8 |   2 | Rolling Updates & Rollbacks       | update Deployment, rollback, uptime 90%                                 | ImagePullBackOff @20                              |
|   9 |   3 | Services & Service Discovery      | deploy Service×2, connect frontend→backend, serviceType NodePort        | —                                                 |
|  10 |   3 | Ingress: L7 HTTP Routing          | deploy Ingress, route /api+/web, tls                                    | —                                                 |
|  11 |   3 | NetworkPolicies: Zero Trust       | deploy NetworkPolicy×2, isolate database, allow backend→database        | UnauthorizedAccess @30                            |
|  12 |   3 | DNS Debugging                     | resolve DNSResolutionFailure, verify DNS, deploy NetworkPolicy          | DNSResolutionFailure @5                           |
|  13 |   4 | ConfigMap Essentials              | deploy ConfigMap×2, mount ConfigMap, envFrom ConfigMap                  | —                                                 |
|  14 |   4 | Secret Operations                 | deploy Secret×2, mount Secret, noConfigMap sensitive                    | SecretExposed @15                                 |
|  15 |   4 | Persistent Storage                | deploy PV×2, deploy PVC×2, bound PVC×2                                  | —                                                 |
|  16 |   4 | StatefulSet Database              | deploy StatefulSet, scale STS→3, headless Service, stable               | PodStuckTerminating @60                           |
|  17 |   5 | Production Readiness              | resources configured, probes liveness+readiness, hpa, resolve OOMKilled | OOMKilled @20, ReadinessProbeFailure @45          |
|  18 |   5 | RBAC Fortress                     | deploy Role×2, RoleBinding×2, ServiceAccount×2, leastPrivilege          | UnauthorizedAccess @25                            |
|  19 |   5 | Multi-Node Outage                 | resolve NodeNotReady×2, uptime 80%, reschedule×5, pdb                   | NodeNotReady @10/15, PodEviction @20              |
|  20 |   5 | Full Stack Production             | 9 deploy objectives + probes + architectureScore≥75                     | CrashLoopBackOff @60, NodeNotReady @120, DNS @180 |

### 6.3 Objective evaluator (`CampaignMode.updateObjectives` L191–431)

Progress objects are created at level start as `{...objective, current:0, target: obj.count||1,
completed:false}` (L104–109). Every second `update()` (ticker L127) recomputes each incomplete objective
and completion requires **all** objectives (`checkCompletion` L433–437). Unknown `type` values fall
through the switch with **no default** → objective stays incomplete forever (a content typo bricks a
level).

| `type`              | Fields read                       | Condition (CampaignMode)                                                                                             | Data-path verdict                                                                         |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `deploy`            | `kind`, `count`                   | `getResourcesByKind(kind).length >= target`                                                                          | OK (counts starting resources too)                                                        |
| `scale`             | `kind`, `replicas`                | any resource of kind with `spec.replicas >= obj.replicas`                                                            | OK (often auto-satisfied because Deployment ctor defaults replicas=3)                     |
| `resolve`           | `incidentType`, `count`           | `incidentEngine.getStats().totalResolved >= target` — **ignores incidentType**                                       | Loose (any incident counts)                                                               |
| `uptime`            | `percentage`                      | `incidentEngine.getClusterHealth() >= percentage`                                                                    | **Auto-true in a calm cluster (health=100)**                                              |
| `distribute`        | `minNodes`                        | distinct non-empty `pod.spec.nodeName` count ≥ minNodes                                                              | OK                                                                                        |
| `replicas`          | `minPerDeployment`                | every Deployment `spec.replicas >= min`                                                                              | OK                                                                                        |
| `coverage`          | `kind` (DaemonSet)                | DS-owned pods (`metadata.ownerReferences` kind=DaemonSet) node count ≥ node count                                    | OK if DS controller ran                                                                   |
| `complete`          | `kind`, `count`                   | `status.phase === 'Complete'` count                                                                                  | OK for Jobs                                                                               |
| `update`            | `kind`, `count`                   | `status.updatedReplicas > 0`                                                                                         | Loose (engine sets = total pods immediately)                                              |
| `rollback`          | `count`                           | `cluster._rollbackCount >= target` (set by `GameEngine._handleRollout undo` L559)                                    | OK                                                                                        |
| `connect`           | `from`, `to`                      | a Service named `<to>-svc` or `<to>` with non-empty `spec.selector`                                                  | OK-ish (name-based)                                                                       |
| `serviceType`       | `kind` (e.g. NodePort), `count`   | `spec.type === obj.kind`                                                                                             | OK via Edit dialog                                                                        |
| `route`             | `paths[]`                         | Ingress rule paths include all listed paths                                                                          | OK via Ingress path picker                                                                |
| `tls`               | `enabled`                         | any Ingress `spec.tls.length > 0`                                                                                    | **No code path can create TLS → UNACHIEVABLE**                                            |
| `isolate`           | `namespace`                       | a NetworkPolicy whose `spec.namespace` or `metadata.namespace` equals it                                             | Only via `create … --namespace`; palette cannot set namespace                             |
| `allow`             | `from`, `to`                      | **any** NetworkPolicy exists (length>0)                                                                              | Trivially true                                                                            |
| `investigate`       | `incidentType`                    | investigationProgress ≥ 0.5                                                                                          | Only challenges use it                                                                    |
| `verify`            | `kind`, `dnsWorking`              | cluster health ≥ 90 (ignores kind)                                                                                   | Trivially true                                                                            |
| `mount`             | `kind`, `count`                   | **just counts resources of kind** (no volume check)                                                                  | Weak                                                                                      |
| `envFrom`           | `kind`, `count`                   | same as mount                                                                                                        | Weak                                                                                      |
| `noConfigMap`       | `sensitive`                       | no ConfigMap data key matching `/password                                                                            | secret                                                                                    | key | token/i` | OK  |
| `bound`             | `kind` (PVC), `count`             | `status.phase === 'Bound'`                                                                                           | **PVC never binds (tick dead) → UNACHIEVABLE**                                            |
| `headless`          | `kind`, `count`                   | Service `spec.clusterIP === 'None'`                                                                                  | **No code path sets None → UNACHIEVABLE**                                                 |
| `stable`            | `kind` (StatefulSet)              | any StatefulSet exists                                                                                               | OK                                                                                        |
| `resources`         | `kind` (Deployment), `configured` | `d.spec.resources.requests && d.spec.resources.limits` at **Deployment top level**                                   | **Wrong path** (real path is `spec.template.spec.containers[].resources`) → UNACHIEVABLE  |
| `probes`            | `kind`, `liveness`, `readiness`   | `d.spec.livenessProbe && d.spec.readinessProbe` at **Deployment top level**                                          | **Wrong path** (real path `spec.template.spec.containers[].livenessProbe`) → UNACHIEVABLE |
| `hpa`               | `count`                           | HPA count ≥ target                                                                                                   | OK (palette HPA)                                                                          |
| `leastPrivilege`    | —                                 | no Role rule verb includes `'*'`                                                                                     | Trivially true for empty-rule Roles                                                       |
| `reschedule`        | `count`                           | `cluster._rescheduledCount` (incremented in `_tickPodScheduling` L145 when a previously-evicted owner regains a pod) | OK-ish                                                                                    |
| `pdb`               | `count`                           | PDB count ≥ target                                                                                                   | Only via `create pdb` command (palette has no PDB)                                        |
| `architectureScore` | `minScore`                        | `scoringEngine.calculateArchitectureScore(state).total >= minScore`                                                  | OK                                                                                        |

`ChallengeMode.updateObjectives` (L411–549) reimplements a subset with differences:

- `deploy` supports `name` (exact resource-name match) in addition to `count`;
- `connect` only checks a Service _name_ exists (no selector check);
- `route` reads `i.spec.rules[].paths` (wrong: real path is `rules[].http.paths`) → **broken in challenges**;
- adds `deny` (same as allow: any NetworkPolicy exists);
- no `distribute/replicas/coverage/complete/update/rollback/verify/mount/envFrom/noConfigMap/bound/stable/
resources/hpa?` (hpa included), and no default case.

**1.14.0 state-based grading (issues #71/#75):** the evaluator now lives in
`js/engine/ObjectiveEvaluator.js` and is shared by CampaignMode and ChallengeMode. Hidden-name
objectives grade cluster state: L13 credits any OAuth-referenced htpasswd Secret that logs the user
in (`oauthProvider.secretReferenced`); L13/lab 11 require the rotated hash + a successful login with
the player's own password (`password.rotate`); lab 7 grades `can-i`-equivalent RBAC;
L17/lab 8 grade an SCC grant usable by the subject (`getSCCsForSubject`) plus a Pod admitted with
`openshift.io/scc=privileged` running as the SA (`privileged.serviceAccount`). L7/L11 objectives
start false and flip only on real state. Contracts in CONVERSION-SPEC §4.7.

### 6.4 Stars, scoring, XP

- `ScoringEngine.calculateStarRating(levelId, completionTime, efficiency, hadFailures)` **L277–292**: start
  at 1 star; 2 stars if `timeMet && efficiencyMet`; 3 if also `noFailuresMet`; criteria come from
  `level.starCriteria` (seconds, 0..1, bool). `efficiency = completedObjectives / totalObjectives`
  (`CampaignMode.completeLevel` L457–459, always 1 at completion).
- `completeCampaignLevel` L294–357: stores best stars/bestTime; XP = `100 + levelId*25 + stars*50`;
  updates `stats.levelsCompleted/threeStarLevels/totalStars/levelTimes/completedWithoutHints/
chaptersCompleted`.
- Challenge stars (`completeChallenge` L359–389): 1 star if 100% completion, 2 if ≤180 s, 3 if ≤120 s;
  XP = `floor(completionPercentage*2) + stars*75`.
- Chaos survival: `recordChaosSurvival` L391–398 → `stats.longestChaosSurvival`.
- `completeLevel` emits `campaign:level-completed` + `mode:level-complete` (index shows modal with
  `data.stars/title/message`); `complete()` in ChallengeMode also emits `mode:level-complete`.
- `CampaignMode.failLevel` L489–504 exists but **is never called** — `checkFailure` L439 only sets
  `hadFailures`; campaign has no failure path (only Chaos emits `mode:game-over`).

### 6.5 Tutorial overlay targets (dead)

- Data: `CampaignLevels` level 1 `tutorial.steps`: `{target:'command-bar'}`, `{target:'cluster-view'}`,
  `{target:'inspector'}`; level 2 has `command-bar`, `inspector`.
- Runtime: `CampaignMode.advanceTutorial` L548–570 emits `campaign:tutorial-step` with `{target,text}`;
  `skipTutorial` L572. **No listener exists** for either event (verified). `index.showTutorial` L1708 is a
  separate static modal. So the "targeted tutorial" was never wired into the UI. Conversion can replace it
  with a real coach-mark system using target ids `command-bar`/`inspector`/`objectives-panel`, which are
  stable DOM ids.

### 6.6 Campaign levels that cannot be completed today (blocking bugs to fix, not just reword)

| Level | Blocking objective(s)                                     | Root cause                                                                                                                                     | Fix direction                                                                    |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 10    | `tls`                                                     | no UI/engine path can set `ingress.spec.tls` (`Ingress.addTLS` L187 never called; edit dialog L1190 can't)                                     | add TLS editing/`create route … --cert` or Objective redefinition                |
| 11    | `isolate`                                                 | palette resources always land in `default`; only `create … --namespace` can set a namespace                                                    | add project/namespace picker to palette; or edit-dialog namespace field          |
| 15    | `deploy PersistentVolume ×2`                              | **PV is not in the game palette** (`index.html:173–323`), not in `_cmdCreate` defaults, and `_cmdApply`'s filename heuristic can't produce one | add PV creation/`oc create -f` real parser                                       |
| 15    | `bound PVC ×2`                                            | `PersistentVolumeClaim.tick` L241 (which would bind) is never called (G6); no PV controller in SimulationTick                                  | add `_tickPVCs` binding controller                                               |
| 16    | `headless`                                                | no path sets `clusterIP:'None'`                                                                                                                | add service `clusterIP` field to edit dialog / `create service --clusterip=None` |
| 17    | `probes`                                                  | evaluator reads `Deployment.spec.livenessProbe` instead of container templates                                                                 | fix evaluator (and add probe editing)                                            |
| 20    | `probes`                                                  | same bug                                                                                                                                       | same                                                                             |
| (all) | any scene requiring PV/StorageClass/PDB/RBAC from palette | those kinds absent from palette                                                                                                                | extend palette or convert to command-bar-first UX                                |

Also note levels 2/4/8/19 have objectives that auto-complete immediately (`scale` default replicas=3,
`uptime` at 100% health) — the star/efficiency model gives no signal for these. EX280 conversion should
revisit all 20 levels against the new objective schema rather than translate literally.

---

## 7. Game modes

There is **no `BaseMode`**. Modes are duck-typed classes instantiated in `index.html launchGame`
(L1474–1492) and called via `modeInstance.currentLevelDef`, `.getStatus()`, `.useHint(i)`, `.nextLevel()`,
`.restart()`, `.exportClusterYAML()` (index checks method existence) and `.exit/.cleanup/.destroy`
(returnToMenu L1625–1629). A conversion can (and should) introduce a `BaseMode` with this lifecycle:

```
constructor(gameEngine, incidentEngine?, scoringEngine)
start(...) / startLevel(id) / startChallenge(id)   → emit <mode>:started
update()                                           → ticker (setInterval 1000) / emits <mode>:update
pause()/resume()/stopTicking()
getStatus()                                        → {state, title/level, elapsed/timeRemaining, objectives[], hints[], …}
useHint(index)                                     → hint string
exit()/destroy()
```

### 7.1 CampaignMode (`js/modes/CampaignMode.js`)

`CAMPAIGN_STATE` L3–10 (`menu/loading/playing/paused/completed/failed`). Constructor L13–33 sets
`gameEngine.campaignLevels = CAMPAIGN_LEVELS` (used by ScoringEngine star calc). Methods:
`getLevels` L35, `getChapters` L62, **`startLevel` L86–142** (lock check, objective progress mapping,
`setupCluster`, `incidentEngine.reset()`, `loadScriptedIncidents`, tutorial flag, `setInterval(update,1000)`),
`setupCluster` **L144–173** (`cluster.clear()` then `addResource` per starting resource with default
labels `{app:name}`; Nodes get Ready condition; Deployments without selector get one), `update` L175–189,
`updateObjectives` L191–431 (see §6.3), `checkCompletion` L433, `checkFailure` L439, `completeLevel`
L451–487, `failLevel` L489 (dead), `retryLevel` L506, `nextLevel` L511, `pause/resume` L516–530,
`useHint` L532, `advanceTutorial` L548, `skipTutorial` L572, `getCompletionPercentage` L577,
`getStatus` L583–600 (this is what the objectives panel polls), `stopTicking` L602, `exitToMenu` L609.
Emitted events (all unhandled except `mode:level-complete`): `campaign:level-started/update/level-completed/
level-failed/paused/resumed/hint-used/tutorial-step/tutorial-completed/tutorial-skipped/exit-to-menu`.

### 7.2 ChallengeMode (`js/modes/ChallengeMode.js`)

`CHALLENGE_STATE` L1–7; **`CHALLENGES` data L9–289** (10 scenarios, schema = title/description/timeLimit/
objectives[]/startingResources[]/preloadIncidents[]/availableResources[]/hints[]). `class ChallengeMode`
L291–687: `getChallenges` L308, `startChallenge` L329–369 (same setup pattern; `preloadIncidents` →
`loadScriptedIncidents`; `incidentEngine.start('challenge')`), `setupCluster` L371–390, `update` L392–409
(computes `timeRemaining`), `updateObjectives` L411–549, `checkCompletion` L557, `checkTimeout` L563,
`complete` L569–595 (emits `challenge:completed` + `mode:level-complete`), `timeout` L597–617
(partial credit), `pause/resume` L619–633, `retryChallenge` L635, `useHint` L640, `getStatus` L649–662.

**10 challenge titles:** Three-Tier Web App; Fix CrashLoopBackOff; Ingress with TLS; Network Segmentation;
Black Friday Scaling; Node Failure Recovery; StatefulSet with PVC; RBAC Fortress; DNS Resolution Failure;
Full Production Readiness.

**1.14.0 challenge contracts (issues #71/#74/#75):** the shipped runner holds the 13 timed EX280
labs. Labs 7/8/11 grade state-equivalent RBAC/password/SCC fixes through the shared
`ObjectiveEvaluator` (no hidden binding names/literals); lab 12 seeds a self-consistent TLS fixture
(UBI nginx on 8443 named `https`; passthrough Route serves 200) and teaches the immutable-Job
delete/recreate (or LimitRange `defaultRequest`) flow instead of `oc set resources job`; L7/L11
objectives start unticked; lab 1's Route-admission hint teaches host/path/certificate only; lab 3's
hint generates real cert/key files with `openssl req -x509`; and lab 8's hint creates the missing
`priv-sa` ServiceAccount. Contracts in CONVERSION-SPEC §4.7.

### 7.3 ChaosMode (`js/modes/ChaosMode.js`)

`CHAOS_STATE` L1–6; **`INITIAL_CLUSTER` L8–21**: 3 Nodes (`8` cpu, `16Gi`) + Deployments `web-frontend`
(nginx:latest), `api-backend` (node:18), `worker` (python:3.11), Services `web-svc`/`api-svc` — note the
Deployment specs use a bogus top-level `image` field (`{replicas:2,image:'nginx:latest'}`), which
`_createPodForWorkload` ignores → pods get `app:latest` from the fallback (L874–880). `class ChaosMode`
L23–279: `resetState` L38, `start` L56–73, `setupCluster` L75–91, `update` L93 (difficulty/health/waves/
game-over), `updateDifficulty` L116 (level = 1+floor(minutes/2) capped 10; chaosBudget; decay rate),
`updateHealth` L123–137 (health −= Σ(severity×2×timeFactor+decay)/60 + 0.5/60 regen per resolved),
`updateWaves` L139, `startNewWave` L158, `onIncidentResolved` L172, `checkGameOver` L188, `gameOver`
L194–217 (calls `scoringEngine.recordChaosSurvival`, emits `chaos:game-over` + `mode:game-over`),
`pause/resume`, `getStatus` L235, `restart` L258, `exit` L264. Conversion: keep as a "production
firefighting" mode; replace incidents + initial cluster with OpenShift content.

### 7.4 SandboxMode (`js/modes/SandboxMode.js`)

`SANDBOX_STATE` L1–5; **`ALL_RESOURCE_TYPES` L7–14** (26 strings — includes the non-existent
`LimitRange`); `class SandboxMode` L16–287: `start` L29–45 (3 nodes of `16` cpu/`32Gi`, 1 s ticker,
10 s architecture score timer), `setupCluster` L47, `update` L65, `addResource` L83–113 (emits
`resource:created` → this is the only mode-side creation path that counts for scoring), `removeResource`
L115, `getArchitectureScore` L127 (emits `sandbox:architecture-score`), `refreshArchitectureScore` L145,
**`exportClusterYAML` L150–181** (see §1.6), `getApiVersion` L183–200, `cleanSpec` L202, `toYAML` L209,
`pause/resume/getStatus/stopTicking/exit/destroy` L242–285.

### 7.5 Mode-specific content to convert

| Mode       | Content files                                                                                  | What changes                                                                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Campaign   | `js/data/CampaignLevels.js` (20 levels), `js/modes/CampaignMode.js` evaluator + lifecycle text | Re-theme 5 chapters to EX280 domains (projects/oc CLI → workloads/S2I → networking/routes → storage/config/security → operations/troubleshooting); replace objective types per §6.3/§6.6; hints/tutorial copy; star criteria times. |
| Challenges | `js/modes/ChallengeMode.js:9–289`                                                              | 10 timed exam-style tasks (e.g. "create project + deploy from S2I + expose route + scale"); align evaluator with new schema (fix `route` path bug).                                                                                 |
| Chaos      | `js/modes/ChaosMode.js:8–21` + IncidentDefs                                                    | OpenShift initial cluster (Deployment/DC/DCS…); new incident roster; health/XP carry-over.                                                                                                                                          |
| Sandbox    | `js/modes/SandboxMode.js:7,150–240` + `ScoringEngine` advisor                                  | New kinds in `ALL_RESOURCE_TYPES`/version map; EX280 Architecture Advisor rules (see §10.2); YAML export must emit OpenShift apiVersions.                                                                                           |

---

## 8. Rendering

### 8.1 `ResourceMeshes` (`js/rendering/ResourceMeshes.js`) — the kind→geometry/color registry

- `STATUS_COLORS` L3–18: `Running #28a745, Pending #ffa657, Succeeded #3fb950, Failed #d73a49,
CrashLoop #f85149, Terminating #8b949e, Unknown #6e7681, Bound/Available #28a745, Progressing #58a6ff,
Active #326CE5, Completed #3fb950, Suspended #ffa657, default #326CE5`. `getStatusColor` L23 drives both
  material emissive and glow ring.
- `CREATORS` object **L212–740**: `Pod L213` (extruded hexagon), `Deployment L252` (rounded rect + replica
  badge), `ReplicaSet L282` (stacked rects), `StatefulSet L303` (numbered hexagons), `DaemonSet L329`
  (star), `Service L357` (circle w/ variants), `Ingress L389` (diamond), `ConfigMap L416` (scroll),
  `Secret L445` (lock), `PVC L477` (cylinder), `HPA L500` (gauge), `NetworkPolicy L533` (shield),
  `ResourceQuota L557` (barrier), `Node L585` (platform), `Namespace L630` (floor zone),
  `Job L658` (hourglass), `CronJob L693` (clock).
- **Only 17 kinds have meshes.** Missing: `PersistentVolume`, `StorageClass`, `PodDisruptionBudget`,
  `ServiceAccount`, `Role`, `ClusterRole`, `RoleBinding`, `ClusterRoleBinding` → `_createFallback`
  L756–778 (grey cube + label). The `getShape()`/`getColor()` methods on resource classes are **never
  consumed** (grep confirms zero call sites outside `js/resources/`).
- `class ResourceMeshFactory` L745: `create(resource)` (dispatch by `resource.type` — note: **`type`, not
  `kind`**), `updateStatus(group,status)`, `dispose(group)`. Label sprites via `createLabelSprite(text)`
  L54 (canvas texture cache L52) — shows **name only**, no kind badge.
- Per-mesh `group.userData.animate(time,delta)` hooks (e.g. Pod bobbing handled separately in
  `ClusterRenderer._animateResources` L631–642 by `resourceType === 'Pod'`).

### 8.2 `ClusterRenderer` (`js/rendering/ClusterRenderer.js`)

- Constants L7–19: background `0x0d1117`, K8S blue, grid 40×20, highlight `0x58a6ff`, select `0xffa657`,
  6 namespace colors.
- Constructor L22–50: `resourceMeshes Map(id→Group)`, `namespacePlanes Map`, selection/hover, raycast; init
  scene L52 (fog), camera L58 (`45°`, pos 18,14,18), WebGLRenderer L65 (anti-alias, PCF shadows, ACES
  tone mapping), OrbitControls L80 (left rotate/right pan/scroll zoom), lights L107, grid L136, raycaster
  L188, subsystems L193 (`ResourceMeshFactory`, `ConnectionLineManager`, `ParticleTrafficSystem`).
- Interaction: `_bindEvents` L199, mouse move/down/up L234–305 (drag resource on ground, camera rotate,
  click select), `_performPick` L314, `_setSelected/_setHovered` L341/359, `_applyMeshEffect`
  L378–426 (`selected`/`hovered`/`default` recolor emissive/scale).
- Resource CRUD: **`addResource(resource)` L427–458** (expects `{id,type,name,namespace,status,x,y,z}`),
  `removeResource(id)` L459–480, `updateResource(resource)` L482–493 (position+status).
  `_ensureNamespacePlane` L506–528, `updateNamespaceBounds` L529–542.
- Connections: `addConnection/removeConnection/updateConnections` L543–553; traffic routes L555–561.
- `syncWithState(clusterState)` **L563–592** expects `clusterState.resources` values with `.id` and
  `clusterState.connections/trafficRoutes` — **these do not exist on `ClusterState`** (resources keyed by
  uid, no `connections` field) → this method is unused/dead; `index.html.syncRenderState` L1644 does the
  real work.
- Animation loop: `start` L595, `stop` L602, `_animate` L610–629 (controls update, picking, line update,
  particle update, `_animateResources`, render), `_animateResources` L631 (Pod bob + resource animate
  hooks), `focusResource` L643, `getScreenPosition` L651, `_raycastGround` L664,
  **`screenToGround(screenX,screenY)` L671–679** (used by palette placement and draw page),
  `animateToPositions(targets Map uid→{x,y,z}, duration=800)` L681–719 (eased tween; used by Auto-Align),
  `resetCamera` L721–725, `dispose` L727–753.
- **Layout:** there is no automatic topology layout in the game — positions are assigned by
  `index.getPlacementPosition` (spiral, L1349) or user drag, then Auto-Align (`index.autoAlignResources`
  L1361) sweeps resources into z-tier rows. Draw page has its own `autoLayout` (L988).

### 8.3 Connections (`js/rendering/ConnectionLines.js`) — what lines mean

- `RELATIONSHIP_COLORS` L3–9: `ownership #c9d1d9, network #58a6ff, storage #8b949e, config #d29922,
default #6e7681`.
- A connection object shape: `{id, sourceId, targetId, type, trafficVolume}` (see `addConnection` L27–77;
  `trafficVolume` controls opacity via `MIN_OPACITY + trafficVolume*0.05` L46–47).
- Rendering: quadratic bezier arc lifted by `min(distance*0.3,3)`, dashed + animated `dashOffset`
  (`update` L128–135), `sync(connectionsMap, resourceMeshes)` L137–154 diffs add/remove; helpers
  `getConnectionsForResource`, `highlight…`, `resetHighlight`, `getCurveForConnection`.
- **Game-side computation is in `index.html:syncRenderState` L1644–1692:**
  - ownership edges from `cluster.relationships` (parent→child) L1655–1663 → `own:<parent>:<child>`,
    volume 1;
  - network edges: for each Service with a non-empty selector, `cluster.selectByLabels('Pod', selector)`
    filtered to the same namespace L1665–1677 (`net:<svc>:<pod>`, volume 2) **plus** matching Deployments
    L1678–1688 (`net:<svc>:<deploy>`, volume 3).
  - No storage/config edges are produced today (types exist but unused).
- Draw page: `draw.html syncConnections` L594–627 — custom user lines (`network`) + ownerReferences
  (`ownership`).

### 8.4 `ParticleTraffic` — installed but dormant

`ParticleTrafficSystem` (L1–373) is a 2048-particle GPU point cloud (`POOL_SIZE` L3, custom shaders L20–48,
additive blending), `TRAFFIC_COLORS` L12–17: `healthy/error/slow/default`. Route shape from `addRoute`
L130–150: `{id, sourceId, targetId, curve|sourcePos/targetPos, trafficType?, requestRate?}`; `syncRoutes`
L329. **No game code ever calls `renderer.addTrafficRoute`** (grep: only the renderer wrapper L555 and
`syncWithState` L591, which itself is dead), and `index.applySettings` references
`this.renderer.particleSystem` (L1702) — a field that does not exist (should be `particleTraffic`).
So traffic particles never render. Conversion decision: either feed them from Route/Service traffic or
delete the subsystem (`_initSubsystems` L196 + dispose L750) to cut ~370 lines.

### 8.5 `Minimap` (`js/ui/Minimap.js`)

- `NAMESPACE_COLORS` L1–8: `default/kube-system/kube-public/monitoring/ingress/logging`.
- **`KIND_SIZES` L10–20** (px radius): `Node 5, Deployment 3.5, Pod 2, Service 3, ConfigMap 1.5, Secret 1.5,
Ingress 3, StatefulSet 3.5, DaemonSet 3.5`; fallback `2` (L195). Other kinds are drawn at fallback size.
- Draws from `resourcePositions` updated on `tick`/`incident:created/resolved`/`viewport:change`; incident
  resources pulse; click navigates (`_navigateTo` L113).

### 8.6 Every hard-coded kind list (the fan-out you must keep in sync or refactor)

| Where                                | Lines                                   | Contents                                                                              |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `js/engine/ClusterState.js`          | 3, 9–16, 18–25                          | cluster-scoped kinds; 25 resource kinds; owner chains                                 |
| `index.html`                         | 173–323                                 | palette DOM (17 kinds)                                                                |
| `index.html`                         | 456–463                                 | `RESOURCE_CLASSES` (25 classes)                                                       |
| `index.html`                         | 796–804                                 | keyboard shortcuts (9 kinds)                                                          |
| `index.html`                         | 1368–1379                               | auto-align tiers (30 kind strings incl. LimitRange)                                   |
| `draw.html`                          | 83–260                                  | palette DOM (20 kinds)                                                                |
| `draw.html`                          | 289–310                                 | `RESOURCE_CLASSES_META` (20 apiVersions)                                              |
| `draw.html`                          | 314–335                                 | `DEFAULT_SPECS` (20 factories)                                                        |
| `draw.html`                          | 992–1006                                | auto-layout tiers (incl. PV/StorageClass/ClusterRole/ClusterRoleBinding/LimitRange)   |
| `draw.html`                          | 696                                     | number-key map (9 kinds)                                                              |
| `js/ui/CommandBar.js`                | 1–11, 13–42, 624–643, 410–443, 859–1127 | completion types, aliases, create defaults (18), column headers/rows, explain DB (20) |
| `js/engine/GameEngine.js`            | 601–615                                 | apiVersion map (25)                                                                   |
| `js/engine/SimulationTick.js`        | 49–75, 449–779                          | controller list + `getByKind` names throughout                                        |
| `js/modes/SandboxMode.js`            | 7–14, 183–200                           | `ALL_RESOURCE_TYPES` (26), apiVersion map                                             |
| `js/modes/CampaignMode.js`           | 198–429                                 | objective `kind` strings (data-driven from levels)                                    |
| `js/modes/ChallengeMode.js`          | 9–289                                   | challenge objective/starting resource kinds                                           |
| `js/data/IncidentDefs.js`            | 1–703                                   | `affectedResourceTypes` per incident                                                  |
| `js/rendering/ResourceMeshes.js`     | 212–740                                 | `CREATORS` (17)                                                                       |
| `js/ui/Minimap.js`                   | 10–20                                   | `KIND_SIZES` (8)                                                                      |
| `js/ui/ContextMenu.js`               | 1–57                                    | `ACTION_MAP` + defaults                                                               |
| `js/engine/ScoringEngine.js`         | 48–77, 156–175                          | session stat keys, kind→stat map                                                      |
| `js/modes/Scoring`/`Achievements.js` | all                                     | conditions reference kind counts by name                                              |
| `js/ui/InspectorPanel.js`            | 219–295, 374–443                        | per-kind detail/describe renderers                                                    |

**Refactor recommendation:** `js/data/kindRegistry.js` + `js/data/openShiftKinds.js`, delete the duplicated
maps, and make palette/auto-align/minimap/explain/columns all derive from the registry. This is the
highest-leverage refactor for parallel conversion work and should be workstream 0.

---

## 9. UI text surfaces (where K8s/kubectl strings live)

| Surface               | File:lines                                                                        | Tabs / strings                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command bar           | `CommandBar.js:91, 257, 269, 320, 537, 615, 669, 698, 727, 854`; help DB 859–1127 | prompt `$ kubectl`; usage strings; `EXPLAIN_DATA` descriptions; terminal title "Terminal" L78                                                                                                                          |
| HUD top bar           | `HUD.js:44–153`                                                                   | logo text **"K8s Games"** L55; counters `Nodes/Pods/Deploy/Svc` L58–79; CPU/MEM; mode label L103; speed `1x/2x/4x`; alerts; settings; GitHub star badge L148                                                           |
| Inspector drawer      | `InspectorPanel.js:21–54, 374–443`                                                | tabs **Overview / YAML / Events / Describe** L42–47; header Edit/close; generic describe prints `API Version:  v1` **hard-coded L382**; per-kind summary blocks for Pod/Deployment/Service/Node L374–443               |
| Context menu          | `ContextMenu.js:1–57`                                                             | Pod: View Logs/Describe/Exec Into/Port Forward/Delete; Deployment: Describe/Scale/Restart/Rollback/Delete; Service: Describe/View Endpoints/Delete; Node: Describe/Top/Cordon/Uncordon/Drain; default: Describe/Delete |
| Incident panel        | `IncidentPanel.js:44–73, 194–268`                                                 | title "Incidents"; filters Active/Resolved/All; "Investigation"; "Investigate first"; "Resolve"; severity icons; hints come from `IncidentDefs`                                                                        |
| Metrics dashboard     | `MetricsDashboard.js:41–88`                                                       | 4 charts: **CPU %, Memory %, Network KB/s, Pod Count**; "Press M to toggle"; "Cluster-wide"                                                                                                                            |
| Settings (in-game)    | `SettingsPanel.js:51–117`                                                         | Difficulty (Easy/Normal/Hard/Nightmare), Display (minimap/connection lines/particle effects/auto-expand incidents), Gameplay (show hints), Camera Speed, Reset All Progress, Export Save                               |
| Settings (main menu)  | `index.html:346–378`                                                              | Sound Effects / Particles / Shadows / Grid / Difficulty select                                                                                                                                                         |
| Objectives panel      | `index.html:123–142` + `1504–1614`                                                | "Level N", description, objective checklist, "Show Hint (n)"                                                                                                                                                           |
| Menus/modals          | `index.html:57–120, 326–427, 1708–1815`                                           | mode names/descriptions; Campaign Levels; Challenges; Achievements; Statistics; Level Complete; Cluster Down; tutorial overlay text                                                                                    |
| Draw page             | `draw.html:57–82, 262–282` + `showProps` 715–815                                  | "K8s Draw — 3D Architecture Diagram", Draw Line, Auto-Layout, YAML/PNG/Share/Clear, Properties (Kind/Name/Namespace/Labels/Replicas), help lines, watermark `k8sgames.com/draw`                                        |
| HTML head / meta / OG | `index.html:6–18`, `draw.html:6–18`                                               | titles/descriptions "K8s Games - Kubernetes Cluster Management Simulation", "K8s Draw"                                                                                                                                 |
| README                | `README.md`                                                                       | entire file (modes, controls, features, tech stack claims)                                                                                                                                                             |
| `og-image.html`       | whole file                                                                        | 1200×630 marketing card titled "K8s Games"                                                                                                                                                                             |
| `robots.txt`          | whole file                                                                        | site policy (bot allow/deny) — no product strings except comments                                                                                                                                                      |
| `style.css`           | 1,611 lines                                                                       | no user-visible text; class names only (`.menu-btn-desc`, `.palette-label`, `.tutorial-mode`, `.level-title`, `.challenge-name`, …)                                                                                    |

Search commands that produced the inventory (fast way to re-verify after edits):
`grep -rn "kubectl" js/ index.html draw.html | grep -v node_modules`,
`grep -rn "K8s\|Kubernetes" js/ index.html draw.html README.md`.

Current `kubectl` string counts per file: `IncidentDefs.js` 126, `CampaignLevels.js` 23,
`CommandBar.js` 10, `ChallengeMode.js` 9, `index.html` 8, `IncidentEngine.js` 4, `IncidentPanel.js` 2,
`GameEngine.js` 1. `draw.html` 0.

---

## 10. Scoring and achievements

### 10.1 `ScoringEngine` (`js/engine/ScoringEngine.js`)

- **`XP_LEVELS` L3–34**: 30 levels with titles `Novice…CKA Candidate/Certified/CKA Master` —
  re-brand the last three (`CKA` → `EX280 Candidate / EX280 Certified / OpenShift Master`).
- `STORAGE_KEY='k8sgames_progress'` L36; constructor L38–46; `createEmptySessionStats` L48–78 (all counters
  - `resourceTypesUsed Set`); `bindEvents` L80–146 (resource:created, incident:resolved, command:executed,
    yaml:viewed, incident:cascading-resolved, secret:exposed-fixed, rollout:zero-downtime,
    easter-egg:triggered, night-owl timer); `trackResourceCreated` L148–203; `trackIncidentResolved`
    L205–229; `addXP` L231 (emits `xp:gained`, `player:level-up`); `calculateLevel/getLevelInfo` L249/261;
    `calculateStarRating/completeCampaignLevel/completeChallenge/recordChaosSurvival` L277–398;
    `checkAchievements` L704–737; `getAchievements/getProgress` L739/747; `loadProgress/saveProgress/
resetProgress` L760–812.
- **Architecture Advisor `calculateArchitectureScore(clusterState)` L400–426** → averages 10 category
  scores (each 0–100 + `recommendations[]`), stores `stats.highestArchitectureScore`, returns
  `{total, categories}`. Consumed by SandboxMode (`getArchitectureScore`) and `architectureScore`
  objectives.

| Category          | Function                     | Rules (points)                                                                                                                               |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| High Availability | `scoreHighAvailability` L428 | +40 × fraction of Deployments with replicas>1; +30 Nodes×10 (max 3); +30 PDB×15                                                              |
| Security          | `scoreSecurity` L458         | +30 NetPol×10; +25 (Roles+RoleBindings)×5; +25 Secrets×10, −15 if sensitive key in a ConfigMap; +20 SA×5                                     |
| Scalability       | `scoreScalability` L497      | +50 HPA×15; +30 × fraction of Deployments with `spec.resources.requests` (**wrong path — real requests are in containers**); +20 Nodes×5     |
| Cost Efficiency   | `scoreCostEfficiency` L521   | starts 60; −10 per Deployment replicas>5; +20 HPA×10; +20 × fraction with `spec.resources.limits` (**wrong path**)                           |
| Reliability       | `scoreReliability` L551      | +50 × fraction with `spec.livenessProbe\|\|readinessProbe` (**wrong path**); +30 × fraction replicas>1; +20 PDB×10                           |
| Networking        | `scoreNetworking` L574       | +40 × services/deployments ratio; +30 Ingress×15; +30 NetPol×10                                                                              |
| Storage           | `scoreStorage` L598          | starts 50; +25 × pvcs/statefulsets ratio; +25 PV×10; reset rec if no stateful resources                                                      |
| Configuration     | `scoreConfiguration` L623    | +40 (ConfigMaps+Secrets)×10; −20 sensitive ConfigMap; +30 Secrets×15; +30 × fraction with `spec.envFrom\|\|env` (**wrong path**)             |
| Observability     | `scoreObservability` L653    | starts 20; +40 × fraction probes (**wrong path**); +30 if a DaemonSet name matches `/monitor\|metric\|log\|fluentd\|prometheus/i`; +10 HPA×5 |
| Organization      | `scoreOrganization` L678     | +40 Namespaces×10; +30 Quota×15; +30 × fraction labeled resources                                                                            |

**EX280 conversion:** replace the 10 heuristic categories with EX280-relevant ones and fix the
container-path bugs: Projects & namespace isolation, Deployments/DC strategy, Builds & ImageStreams,
Routes/networking (Ingress removed), Storage (PVC binding, StorageClass default), Security (SCC, RBAC,
secrets), Resource management (quota/limitrange/probes), Reliability (replicas/PDB/rollouts),
Observability (probes/health/logging), Operators/OLM hygiene, Cost/efficiency.

### 10.2 Achievements (`js/data/Achievements.js`)

Schema: `{id, name, description, icon, category, condition: (stats) => boolean, xpReward}`. Categories
`ACHIEVEMENT_CATEGORIES` L403–408 (`Beginner/Intermediate/Advanced/Secret` with color+minLevel).
**45 achievements**: 10 Beginner, 10 Intermediate, 10 Advanced, 15 Secret. All conditions are closures over
`stats` keys populated by `ScoringEngine.track*` + `complete*`:
`totalPodsDeployed, namespacesCreated, deploymentsCreated, servicesCreated, incidentsResolved,
maxConcurrentPods, levelsCompleted, threeStarLevels, commandsExecuted, yamlViewed, networkPoliciesCreated,
pvcsCreated, chaptersCompleted, fastestIncidentResolve, hpasCreated, totalStars, longestChaosSurvival,
highestArchitectureScore, threeStarChallenges, uniqueResourceTypesDeployed, zeroDowntimeUpdates,
levelTimes, playedLateNight, cascadingFailuresResolved, highestCombo, foundExposedSecret,
completedWithoutHints, levelRetries, sandboxResourcesDeployed, easterEggs{}`.

**IDs:** first-pod, namespace-creator, first-deployment, first-service, first-incident, five-pods,
level-complete, three-stars, command-user, yaml-viewer, twenty-pods, full-house, incident-hunter, multi-node,
network-admin, storage-guru, chapter-complete, quick-fix, scaling-master, ten-stars, campaign-complete,
perfect-campaign, chaos-survivor, chaos-master, incident-slayer, architecture-expert, challenge-ace,
all-resources, fifty-commands, zero-downtime, speed-demon, night-owl, yaml-master, cascade-handler,
combo-king, secret-finder, no-hints, restart-warrior, sandbox-builder, ten-x-combo, doom-runner,
chaos-monkey, coffee-break, party-mode, konami-code.

Conversion: rewrite thresholds/names for OpenShift counters (routes created, builds started, projects
created, SCCs granted, quotas configured, operator installs, `oc` commands executed, etc.), drop/rebrand
easter eggs (or keep server-agnostic ones), and make palette creation count (G7) before balancing.

---

## 11. Data invariants, gotchas and latent bugs (with evidence)

Numbered for reference from task descriptions. Items marked **BLOCKER** affect conversion correctness;
**BUG** should be fixed in passing; **GOTCHA** is safe but will bite someone.

**G1 — GOTCHA — No build step / import map required.** Static ES modules only; the per-page import
maps (`index.html:70–78`, `draw.html:69–77`) resolve the pinned Three.js and map `./js/` to the
versioned `/v/<package.json version>/js/` prefix (rewritten to `/js/` by `vercel.json`, issue #68).
New modules must be imported from every entry page that needs them, and a release must bump
`package.json` plus both import-map prefixes together (`scripts/verify.mjs` fails on drift). Keep the
`no-build` constraint unless the team explicitly decides to introduce a bundler.

**G2 — GOTCHA — `window.game.engine` is an EventBus, not the GameEngine.** See §1.4. UI uses
`window.game.engine.on/emit` for events but `window.game.gameEngine` for `queueCommand/pause/
setDifficulty`. New code must follow the same split or the whole UI breaks.

**G3 — GOTCHA — WebGL is a hard requirement, and `draw.html` doesn't guard it.** `index.html:532–539`
probes and shows overlay L595–615; draw page just `init().catch(console.error)` L1042–1043 → blank page on
no-WebGL machines. If conversion adds a 2D fallback, both entry points need it.

**G4 — BLOCKER — `ClusterState.addResource()` downgrades resources and ignores passed UIDs.**
`ClusterState.js:730–746` constructs `new ResourceBase(...)` and drops `obj.metadata.uid`, `apiVersion`,
and any subclass. Verified executably:
`passed uid: draw-pod-123 | stored uid: <new> | match: false`, `class: ResourceBase`,
`toDescribe: undefined`. Effects: (a) draw-page positions lost → resources stack at origin (also breaks
shared-URL diagrams, `draw.html:951–986`); (b) controller children/Pod/RS/Job are plain (no subclass
`toYAML`/`toDescribe`); (c) `create`/`apply`/mode-created resources have `apiVersion:'v1'`.
**Fix:** add a factory that consults `kindRegistry` (or accept `metadata.uid`) and have all call sites use
it.

**G5 — BUG — Two settings systems written to the same localStorage key with different schemas.**
`index.html:617–629` writes `{sound,particles,shadows,grid,difficulty}`;
`SettingsPanel.js:8,27–49` writes `{difficulty,showMinimap,showMetrics,cameraSpeed,particleEffects,
showConnectionLines,autoExpandIncidents,showHints,soundEnabled}`. Each reader treats its own defaults as
authoritative, so opening the other menu silently resets some toggles. Merge into one settings module +
versioned key before conversion adds more settings.

**G6 — BLOCKER — Resource subclass `tick()` methods and `getShape()/getColor()` are dead code; several
`.apiVersion` values are wrong.** No call site for `resource.tick()` anywhere (only
`SimulationTick.tick`, `GameEngine._gameLoop`); no call site for `getShape/getColor` outside
`js/resources/`. Deployment/ReplicaSet/StatefulSet/DaemonSet/Job/CronJob/Ingress/NetworkPolicy/HPA set
`.apiVersion` to `'v1'` because they call `super('<Kind>', metadata)` without an apiVersion (see §2.2).
Consequences: PVC never binds, HPA/PDB/Quota class logic never runs, YAML/describe can disagree with the
object's own `apiVersion`. Converters should assume the simulation is centralized and should add a single
authoritative apiVersion resolver.

**G7 — BUG — Palette-created resources are invisible to scoring/achievements.** `placeResource`
(`index.html:932`) calls `cluster.add` and never emits `resource:created`; `ScoringEngine` only counts
`resource:created` (`ScoringEngine.js:83`), emitted from CommandBar (`:604/658/683`) and
`SandboxMode.addResource` (`:104`). So click-to-place does not advance "First Pod"/counters, while the same
resource typed via command does. This will confuse EX280 missions that mix palette and CLI.

**G8 — BUG — Command parser rejects the `kubectl` prefix that all UI copy tells players to type.**
`CommandBar.js:282–284` dispatches on token 0; no stripping; prompt says `$ kubectl` L91. `IncidentPanel`
strips the prefix before pre-filling (L296) and matching (L372) — evidence the mismatch was worked around
locally rather than fixed. Fix the parser (accept both `kubectl`/`oc`) and then rename all copy.

**G9 — BLOCKER for incident-driven objectives — Incidents never mutate cluster state.**
`IncidentEngine.applyResolutionEffects` (`IncidentEngine.js:427–450`) only emits
`resource:healed/rescheduled/cluster:dns-restored/security:credential-rotated`; a grep for listeners finds
none. `spawnIncident` also doesn't damage resources. "Resolving" is clicking a button after running the
prescribed commands. EX280 conversion should drive incidents _from_ real cluster state (e.g. a Pod in
CrashLoopBackOff creates the CrashLoop incident; changing the image/scale fixes it) and clear the incident
by watching `cluster:modified`, not by emitting unhandled events.

**G10 — BLOCKER — Several campaign objective types read the wrong data path or are unreachable.**
See §6.3/§6.6: `tls`, `bound`, `headless`, `resources`, `probes` are unwinnable, `isolate` needs namespace
control the palette doesn't have, and unknown types silently never complete. Do not translate the level
content before fixing the evaluator schema.

**G11 — GOTCHA — No cluster persistence.** `GameEngine.saveState/loadState` (L837/L862) are implemented
but never called; no UI button. `SettingsPanel` "Export Save" (L178–192) exports only
`k8sgames_progress`/`k8sgames_settings`/`k8sgames_investigation`. A reload loses the cluster; EX280
conversion may want per-project save slots.

**G12 — BUG — Incident engine is double-ticked with mixed units.** `IncidentEngine.start` installs
`setInterval(tick(1000),1000)` (L159) while `index.html:552–555` calls `incidentEngine.tick(dt)` with
`dt` in **seconds** each fixed step. Timers/auto-resolve/cascade drift. Pick one clock (prefer the fixed
step, emit `dtMs`).

**G13 — BUG — Controllers implied by the model are missing/never run:** PVC→PV binding
(`PersistentVolumeClaim.tick` dead), Ingress status (`Ingress.tick` dead), ResourceQuota status
(`updateUsage` dead; engine uses separate `cluster.resourceQuotas` map), PDB status (`updateStatus` dead),
HPA class tick (replaced by `_tickHPA` but leaves dead code), DaemonSet `desiredNumberScheduled` never
set to node count in some paths, Node `cordon()`/`drain()` helpers unused (engine mutates
`spec.unschedulable` directly). New OpenShift controllers must be added to `SimulationTick`, not to
resource classes.

**G14 — GOTCHA — Draw page disables the simulation by monkey-patch and reimplements rendering event flow.**
`draw.html:367–368` overwrites `engine.simulation.tick = () => {}` after `engine.start()`; it does not use
`ClusterRenderer.syncWithState` either. Converting rendering/model assumptions on the game page will not
automatically apply to `/draw`.

**G15 — GOTCHA — Ghost kinds exist in lists but not in the model:** `LimitRange` appears in
`CommandBar` aliases (`:41`), `SandboxMode.ALL_RESOURCE_TYPES` (`:12`), `index.autoAlignResources`
(`:1377`), `draw.autoLayout` (`:1002`) but has **no class, no `RESOURCE_KINDS` entry, no mesh, no create
default**. `Endpoints`/`Event` aliases exist in `CommandBar` (`:6, :29`) but cannot be stored. Clean these
up (or implement) before adding OpenShift kinds, or the same "listed-but-missing" problem will multiply.

**G16 — BLOCKER for EX280 — `kubectl apply -f` is a filename heuristic, not YAML parsing.**
`CommandBar._cmdApply` L581–612 guesses kind from the _filename_ (`*deploy*`→Deployment, `*svc*`→Service,
`*node*`→Node, else Pod) and fabricates a default spec. `oc apply -f` is a core EX280 command; this needs a
real (small) YAML subset parser + `kindRegistry` dispatch.

**G17 — BUG — Rollout/scale/get CLI grammar is not exam-shaped.** `rollout` requires
`rollout <action> <type> <name>` (`CommandBar.js:725–736`); `oc rollout status deployment/nginx` (slash
form) fails. `scale` requires `--replicas=` (L535) — fine — but rejects `--current-replicas`/`--resource-version`
silently. `get` ignores `-A/--all-namespaces`, `--show-labels`, `--sort-by` (parsed but unused L334–335),
and `get events` returns nothing. Fix these when adding `oc` commands so the game _teaches_ correct syntax.

**G18 — GOTCHA — GitHub badge fetch is optional but affects layout.** `index.html:1970–1985`; if blocked,
badges show `--`. No functional impact.

**G19 — GOTCHA — Vercel config is product behavior for `/draw` and for release delivery.**
`vercel.json:2–10` rewrites (`/draw`→`/draw.html`, `/v/:version/js/:path*`→`/js/:path*`), cache
headers L13–77 (immutable `/v/(.*)`, revalidated unversioned app code) and the UA-bot redirect at
L78–91. If the page is renamed (e.g. `/openshift-draw`), update the rewrites, `index.html:352/667`
links, `draw.html:378` back-link copy and README. On every release, bump `package.json` and both
import-map prefixes (`index.html:73`, `draw.html:72`) together — the `/v/:version/` rewrite is
version-agnostic, so a stale prefix would still load but lose release isolation; `scripts/verify.mjs`
fails the gate on the drift. Local play must go through `scripts/dev-server.mjs` (or any server that
emulates the `/v/` rewrite), never a bare static `http.server`.

**G20 — GOTCHA — There is no test/CI infrastructure; tests must be added.** No `package.json`, no
`.github/`, no test files. Pure modules (`js/resources`, `js/data`, `js/engine/ClusterState`,
`js/engine/SimulationTick` without EventBus side effects) import fine under Node ESM (verified: see
Appendix B). Rendering/UI need DOM/WebGL stubs (jsdom + headless WebGL would violate the no-build
constraint if committed as deps; prefer targeted pure-model tests + a manual browser checklist).

**G21 — GOTCHA — Easter eggs and hidden content are content surfaces too.** `CommandBar._checkEasterEggs`
L230–245 (`get coffee`, `explain life`, `run --image=doom`, `delete ns kube-system`), `HUD` party mode
(`_activatePartyMode` L416), achievements `doom-runner/chaos-monkey/coffee-break/party-mode/konami-code`,
Konami pod name check `CommandBar.js:689–692`. Decide keep/drop/rename during content conversion.

**G22 — GOTCHA — README/HTML meta/OG copy is part of the deliverable and currently wrong.** See §0.4;
update `README.md`, `index.html:6–18`, `draw.html:6–18`, `og-image.html`, `robots.txt` comments if the site
is rebranded.

**G23 — GOTCHA — `style.css` (1,611 lines) encodes the entire visual language.** Tailwind handles most
layout inline; custom classes for menu/palette/HUD/tutorial/responsive are in `style.css` (e.g.
`.menu-btn-desc` L231, `.palette-label` L378, `.level-title` L514, `.challenge-name` L879,
`.tutorial-mode` L931, media queries L1070/1252/1367/1393/1450). Renaming a kind changes palette
tooltips/labels only, not CSS — but new palette sections will need new CSS if they use non-Tailwind
classes. Draw page has selector `body:has(#draw-canvas) …` at L1450 — keep the `#draw-canvas` id.

**G24 — GOTCHA — Import fan-out: adding a kind to the game page requires editing the inline module.**
`index.html:429–454` explicitly imports all 25 classes; an un-imported class cannot be in
`RESOURCE_CLASSES`. `draw.html` deliberately imports none (uses `ClusterState.addResource`). When adding
OpenShift classes, update both pages' registries (draw cannot instantiate them without a new import or
registry).

**G25 — GOTCHA — `ClusterState.clear()` re-seeds 4 namespaces and emits `cluster:reset`.** Any mode that
calls `clear()` (all modes do in `setupCluster`) gets `default/kube-system/kube-public/kube-node-lease`
back. Don't accidentally assume a clean cluster. Also `GameEngine.reset()` calls `cluster.clear()` (L813).

**G26 — BUG — `CommandBar._cmdCreate` builds a `uid` but the store regenerates it** (`CommandBar.js:622`
vs `ClusterState.addResource` L730); combined with G4 this means any follow-up reference by that uid
(`#Create` notifications, etc.) is not correlated to the stored resource.

**G27 — GOTCHA — `ContextMenu` has no "Investigate" action despite campaign hints telling users to
right-click → Investigate** (README:32, `CampaignLevels.js:108, 489`). `ACTION_MAP` L1–48 only has
logs/describe/exec/scale/restart/rollback/cordon/drain/delete. The incident panel is the actual entry
point. Either add the action or fix the hints.

**G28 — GOTCHA — `MetricsDashboard` "Network KB/s" is synthetic/zero** and pods count comes from
`cluster.getClusterStats()`; after adding OpenShift kinds, HUD/Metrics counters (`Nodes/Pods/Deploy/Svc`)
will undercount. Consider replacing with `oc get`-style summarized counts.

**G29 — GOTCHA — `HUD` timer reads `state.elapsed` in milliseconds** (`HUD.js:202`, `_updateTimer` divides
by 1000) because `GameEngine` emits `elapsed: this._gameTime` in ms (L344). Keep units consistent if
refactoring the tick payload.

**G30 — GOTCHA — `ScoringEngine` stat keys are duplicated in achievements, stats panel, and README.**
Renaming a kind/stat requires touching `ScoringEngine.createEmptySessionStats` L48–78,
`trackResourceCreated` L156, `Achievements.js` predicates, `index.buildStats` L1903–1946, and any
`campaignProgress` consumers. Do a global grep for the stat key before renaming.

---

## 12. Conversion touchpoint matrix and workstream plan

### 12.1 Touchpoint matrix

| Feature / surface        | Files & functions                                                                                                                                                                      | Required OpenShift change                                                                                                                                                                                                                                                                                                                                                                                                                      | Workstream          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Terminal command surface | `CommandBar.js` all `_cmd*`, `COMMANDS` L44, prompt L91, echo L257/269, `_dispatch` L293, `_checkEasterEggs` L230                                                                      | Rename prompt/echo/usage to `oc`; accept both prefixes; add `new-app, new-project, project, expose, set, create route, start-build, process, auth, adm, apply -f (real), edit/patch/replace, get scc/route/bc/is/dc/project/csv/sub/og, rollout status dc/name`; fix `-A`, namespace `-n`, slash grammar; rebrand easter eggs                                                                                                                  | WS-A Command engine |
| Command execution        | `GameEngine.js` L391–615 (`_executeCommand` switch/handlers, `_apiVersionForKind` L601), L652–691 `addObjective`                                                                       | Add command types for new verbs; one apiVersion resolver (retire `_apiVersionForKind` in favour of registry); make create/apply actually used                                                                                                                                                                                                                                                                                                  | WS-A                |
| Resource kinds           | `js/resources/*.js` (25 classes), `ResourceBase.js`                                                                                                                                    | Add `js/resources/OpenShiftResources.js` with `Project, Route, BuildConfig, Build, ImageStream, ImageStreamTag(image refs), DeploymentConfig, ReplicationController, Template, SecurityContextConstraints, LimitRange, OperatorGroup, Subscription, ClusterServiceVersion, InstallPlan`; add fields/describes for SCC/RBAC-OpenShift (`system:admin`, `system:authenticated`), `ImageStream.status.tags`                                       | WS-B Model          |
| Kind registry fan-out    | 13 lists in §8.6 / §2.6                                                                                                                                                                | Create `js/data/kindRegistry.js` + refactor all lists; add apiVersions: `route.openshift.io/v1`, `build.openshift.io/v1`, `image.openshift.io/v1`, `apps.openshift.io/v1`, `template.openshift.io/v1`, `security.openshift.io/v1`, `project.openshift.io/v1`, `operators.coreos.com/v1alpha1`, `operators.coreos.com/v1`                                                                                                                       | WS-B (workstream 0) |
| Cluster model            | `ClusterState.js` `RESOURCE_KINDS` L9, `CLUSTER_SCOPED_KINDS` L3, `OWNER_CHAINS` L18, default namespaces L50, quotas L514–571                                                          | Add kinds/chains (`DeploymentConfig→ReplicationController→Pod`, `BuildConfig→Build`, `ImageStream` refs, `Route→Service`), seed `openshift-*` namespaces, replace quota map with real ResourceQuota/LimitRange model                                                                                                                                                                                                                           | WS-B                |
| Simulation               | `SimulationTick.js` tick L43–86 and all `_tick*`                                                                                                                                       | Add `_tickPVCs` (binding), `_tickBuildConfigs`, `_tickBuilds`, `_tickDeploymentConfigs`, `_tickRoutes`, `_tickSubscriptions`; SCC gating in scheduler; fix controller children to use registry factory (G4); image-stream trigger linkage                                                                                                                                                                                                      | WS-C Simulation     |
| Campaign content         | `js/data/CampaignLevels.js` (20 levels), `CampaignMode.js` L191–431 evaluator, L451–504 scoring hooks                                                                                  | Rewrite 5 chapters to EX280: (1) projects/oc/RBAC basics, (2) workloads S2I/BuildConfig/ImageStream, (3) routes/network/services, (4) storage/config/security (SCC), (5) operations (quota/probes/rollouts/operators). Fix objective types per §6.3/§6.6 and add OpenShift types (`createProject`, `buildComplete`, `imageStreamTag`, `routeAdmitted`, `sccGranted`, `quotaConfigured`, `dcRollout`, `templateProcessed`, `operatorInstalled`) | WS-D Content        |
| Challenges               | `ChallengeMode.js:9–289` + evaluator L411–549                                                                                                                                          | 10 timed EX280 tasks; fix `route` path bug; align objective types with new schema                                                                                                                                                                                                                                                                                                                                                              | WS-D                |
| Incidents                | `js/data/IncidentDefs.js` (34 defs), `IncidentEngine.js` (lifecycle/cascades L87–110, effects L427–450), `IncidentPanel.js`                                                            | Rewrite `kubectl`→`oc`; add OpenShift incidents (route not admitted, build failed, SCC forbidden, image pull from internal registry, ImageStreamTag missing, quota exceeded, CSV failed); make incidents state-driven (G9) and clearable by cluster change; fix severity styling/double-tick                                                                                                                                                   | WS-C/WS-D           |
| Scoring/achievements     | `ScoringEngine.js` L3–34 (XP titles), L48–78/156–175 (stats/kind map), L400–702 (advisor), `Achievements.js` (45), `index.buildStats` L1903                                            | Rebrand XP titles to EX280; expand kind→stat map; rewrite advisor categories per §10.1; rewrite achievements for OpenShift actions; fix palette-count gap (G7)                                                                                                                                                                                                                                                                                 | WS-D                |
| Rendering                | `ResourceMeshes.js` `CREATORS` L212, `STATUS_COLORS` L3; `ClusterRenderer.js` L193/427–493/610; `ConnectionLines.js`; `Minimap.js` L10; `ParticleTraffic.js`                           | Add mesh creators for new kinds (or a consistent "openShift badge" approach); add statuses (`Pending→Running→Complete` for Builds, `Admitted` for Routes); extend connection types (`route→service`, `build→imagestream`, `dc→rc`); either wire or delete particle traffic; extend `KIND_SIZES`                                                                                                                                                | WS-E Render/UI      |
| UI copy/surfaces         | `HUD.js`, `InspectorPanel.js` (tabs + `API Version: v1` L382), `ContextMenu.js`, `MetricsDashboard.js`, `SettingsPanel.js`, `index.html` palette/menu/tutorial, `draw.html` props/help | Counters → `Projects/Pods/Deploys/Routes/Builds`; inspector tabs add "Builds"/"Routes"/"SCC"; context actions per OpenShift kind (`Start Build`, `Expose`, `Edit SCC`); settings merge (G5); help copy EX280; palette sections `Projects / Workloads / Builds / Networking / Config & Security / Storage / Cluster`                                                                                                                            | WS-E                |
| Draw page                | `draw.html` L289–335 (meta/specs), palette 83–260, autoLayout 992, export 823–899, share 915–949                                                                                       | Add OpenShift kinds to META/DEFAULT_SPECS/palette/tiers/export apiVersions; fix uid/position bug (G4); draw semantics: ownership vs route/build connections                                                                                                                                                                                                                                                                                    | WS-F Draw           |
| Persistence              | `ScoringEngine` load/save; `SettingsPanel` export/reset; `GameEngine.saveState/loadState`                                                                                              | Single versioned settings module; optional save slots per mode; migration for existing `k8sgames_*` keys (or namespace keys `openshiftgames_*`)                                                                                                                                                                                                                                                                                                | WS-G Infra/test     |
| Tests & CI               | none                                                                                                                                                                                   | Add pure-Node smoke tests (cluster, simulation, objective evaluator, YAML, kindRegistry consistency), a `kindRegistry` completeness test (every kind has class/apiVersion/mesh/aliases), and an eval-report command; optionally a GitHub Action running `node --test` (no build step for the app itself)                                                                                                                                       | WS-G                |
| Hosting/docs             | `vercel.json`, `README.md`, `index.html`/`draw.html` meta, `og-image.html`                                                                                                             | Keep `/draw` or add new rewrite; keep the `/v/:version/js/:path*` rewrite + immutable `/v/` header; bump `package.json` and both import-map prefixes together on release; update descriptions/title/OG; README feature list; robots comments                                                                                                                                                                                                   | WS-G                |
| Exam curriculum source   | (new) `docs/research/ex280-*.md` from parallel research tasks                                                                                                                          | Map each EX280 objective to game content; use as acceptance criteria for levels/challenges                                                                                                                                                                                                                                                                                                                                                     | Content owner       |

### 12.2 Recommended workstreams and ordering

```
Wave 0 (blocking, 1 owner each, can run in parallel):
  WS-B0  kind registry + apiVersion resolver  (js/data/kindRegistry.js; refactor 13 lists)
  WS-G0  test harness skeleton + kindRegistry consistency test + pure-model smoke tests
  WS-D0  objective-type contract: freeze a v2 schema {type, params}, add evaluator tests (pure Node,
         no DOM) so content authors can write levels before renderers exist

Wave 1 (parallel after Wave 0 contracts are frozen):
  WS-A   `oc` parser/commands rename + accept-both-prefixes + new verbs skeleton
  WS-B   OpenShift resource classes + ClusterState chains + default namespaces
  WS-C   Simulation controllers (PVC binding first, then BuildConfig/Build/ImageStream, Route, DC,
         SCC gating, OLM)
  WS-E1  Mesh creators + status colors + minimap/auto-align tiers for new kinds
  WS-F   Draw page kind additions + uid/position fix

Wave 2 (content, after WS-B/WS-C/WS-E interfaces exist):
  WS-D   Campaign (20 levels) / Challenges (10) / Incidents (34→~45) / Achievements (45) / Advisor
  WS-E2  UI surfaces: HUD counters, Inspector tabs, ContextMenu actions, help/tutorial copy
  WS-A2  Command polish: apply -f parser, rollout slash form, get events, explain DB for OpenShift

Wave 3 (integration & QA):
  WS-G   localStorage migration, README/meta/OG, vercel, browser QA checklist, mobile/responsive pass
  Lead   end-to-end playthrough of all 20 levels + 10 challenges; verify every objective is achievable;
         verify no `kubectl` strings remain (grep gate); verify YAML exports validate with `oc apply --dry-run`
```

**Interfaces that must be frozen before parallel work starts:**

1. **Kind registry entry schema** (§2.6) — kind string, apiVersion, namespaced/cluster, class, mesh
   creator, aliases, palette metadata, owner chains, explain entry, minimap size, column headers.
2. **Resource instantiation factory** (`createResource(kind, {name, namespace, labels, spec})`) — replaces
   `ClusterState.addResource`'s downgrade; used by commands, modes, controllers, draw page.
3. **Objective v2 schema** — `{type, ...params, label}` and a pure `evaluateObjective(obj, {cluster,
incidentEngine, scoringEngine, engine})` module with unit tests, so content and engine can proceed
   independently. (Current evaluator is a 240-line switch inside `CampaignMode.updateObjectives` — move it
   out before content conversion.)
4. **Incident schema v2** — keep current shape but add `causedBy`/`clearedWhen` predicates so incidents can
   be state-driven; plus `oc`-worded steps (data-only edit).
5. **Single YAML serializer + parser** — used by toolbar export, draw export, inspector, `apply -f`,
   template processing, and tests.

### 12.3 EX280 curriculum mapping (feature → what to build)

| EX280 area (per research tasks task-1/2/3)   | Existing game structure to clone/extend                                                                           | Minimal acceptance criterion                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `oc` CLI, contexts, projects                 | `CommandBar` + new `Project` kind + `new-project/project/whoami`                                                  | `oc new-project app` then `oc get projects` lists it; objective `createProject`                              |
| Workloads (Deployment/DC), `oc new-app`, S2I | `_tickDeployments` + `_tickBuildConfigs/_tickBuilds` + `ImageStream` tags                                         | `oc new-app --image-stream=...` produces Build→(Complete)→Deployment→Pods→Service; objective `buildComplete` |
| Builds/ImageStreams/triggers                 | `_tickJobs` pattern; `Build` phases; `oc start-build`, `oc set triggers`                                          | Build log viewable, image push updates `ImageStream.status.tags[].items[].dockerImageReference`              |
| Templates                                    | new `Template` data + `oc process` command                                                                        | `oc process -f template.yaml -p KEY=VALUE \| oc apply -f -` creates resources                                |
| Routes / networking                          | `Ingress` replaced/aliased by `Route`; `_tickRoutes`; Route admission status; `oc expose svc`/`create route edge` | `route.status.ingress[0].conditions[0].status === 'True'`; TLS termination fields on Route                   |
| Scheduling                                   | `_findBestNode`, cordon/drain (already present)                                                                   | `oc adm cordon/drain/uncordon`, nodeSelector/taints reflected in Pod scheduling                              |
| Storage                                      | PV/PVC classes + new binding controller; `oc set volume`                                                          | PVC reaches `Bound`; StatefulSet volumeClaimTemplates works                                                  |
| Config/secrets                               | ConfigMap/Secret classes + `oc set env --from`, mounts                                                            | objectives assert pod env/volume refs (fix data path)                                                        |
| Security/SCC/RBAC                            | RBAC classes + `SecurityContextConstraints` + `oc adm policy` commands                                            | `oc adm policy add-scc-to-user` allows/denies pods; `oc auth can-i` result correct                           |
| Quotas/limits                                | ResourceQuota/LimitRange + `oc describe quota/limitrange`                                                         | Creation blocked when quota exceeded; LimitRange defaults applied                                            |
| Operators/OLM                                | new OLM kinds + `_tickSubscriptions`                                                                              | `oc get csv/sub/og` shows install progression; operator Deployment created                                   |
| Troubleshooting                              | IncidentEngine + `oc describe/logs/events/top/debug`                                                              | Fault injected into real resource state; fixing the resource clears incident (G9 fix)                        |

### 12.4 Risk register (top 10)

|   # | Risk                                                                                                         | Impact                            | Mitigation                                                                                                              |
| --: | ------------------------------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
|   1 | Hidden kind-registry fan-out causes half-integrated kinds (e.g. kind can be created but not rendered/scored) | High — content feels broken       | Wave 0 registry + consistency test asserting every registered kind has class/apiVersion/mesh/palette/alias/minimap/stat |
|   2 | Objective evaluator data-path bugs persist into new content                                                  | High — levels unwinnable          | Freeze objective v2 module + Node unit tests _before_ writing levels; run automated playthrough simulation              |
|   3 | Plain-`ResourceBase` downgrade keeps leaking (G4)                                                            | High — YAML/describe/export wrong | Single `createResource` factory; ban direct `cluster.addResource` via grep/CI rule                                      |
|   4 | Incidents remain cosmetic (G9), so troubleshooting missions don't teach cause→effect                         | High — EX280 value proposition    | State-driven incident v2 (`causedBy` predicate on cluster state)                                                        |
|   5 | Renaming kinds/strings breaks event payload consumers (`cluster:added:Pod`, `resource:created`, `getByKind`) | Medium                            | Registry + grep gates; keep old aliases for one release                                                                 |
|   6 | localStorage schema collision (G5) corrupts player progress between versions                                 | Medium                            | versioned key `openshiftgames_v2_*` + migration                                                                         |
|   7 | CDN-only deps break on offline/air-gapped demo                                                               | Medium                            | vendor Three.js/Tailwind locally or document network requirement explicitly                                             |
|   8 | No test harness means regressions are invisible until manual play                                            | Medium                            | Node tests for pure modules + eval-report command; CI on PRs                                                            |
|   9 | draw.html "diagram whiteboard" left behind                                                                   | Medium (nice-to-have)             | WS-F after game conversion stabilizes; otherwise hide `/draw` link                                                      |
|  10 | Scope creep on OLM/Operators (real operator behavior is out of scope)                                        | Medium                            | Limit to install/verify/inspect lifecycle ticks only                                                                    |

---

## Appendix A — Files that need conversion (checklist)

Legend: **C** = content/text rewrite, **S** = structure/code change, **N** = new file, **R** = review only
(no change expected), **F** = fix latent bug while there.

| File                                 | Req   | What                                                                                                                                                                                                |
| ------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                         | S+C   | Palette/sections/kinds, tutorial copy, menu copy, meta/OG, keyboard shortcuts, `RESOURCE_CLASSES`, auto-align tiers, settings system merge, `showTutorial` text, stats modal labels, `kubectl` chip |
| `draw.html`                          | S+C+F | `RESOURCE_CLASSES_META`, `DEFAULT_SPECS`, palette, auto-layout tiers, help copy, uid/position bug, export apiVersions                                                                               |
| `style.css`                          | R     | Only if palette/menu structural classes change; keep `#draw-canvas` selector                                                                                                                        |
| `vercel.json`                        | R/S   | If `/draw` URL changes, or on any release needing the `/v/:version/js/:path*` rewrite + immutable `/v/` header and the revalidating unversioned fallback (issues #66/#68)                           |
| `README.md`                          | C+F   | Feature lists, counts, controls, tech claims, mode descriptions                                                                                                                                     |
| `og-image.html`                      | C     | Marketing card title/copy                                                                                                                                                                           |
| `robots.txt`                         | R     | Only if rebranding comments/domains                                                                                                                                                                 |
| `js/resources/ResourceBase.js`       | S+F   | Consider a real kind/apiVersion resolver; clone() subclass survival; YAML cleanup; add `toManifest()`                                                                                               |
| `js/resources/WorkloadResources.js`  | S+F   | Add DC/RC (or new file), fix broken `addReplicaSet`/`addPod` helpers, apiVersion via super metadata, describe/YAML for OpenShift fields                                                             |
| `js/resources/NetworkResources.js`   | S+F   | Route kind (new file or here), Ingress→Route semantics, TLS/termination, describe                                                                                                                   |
| `js/resources/ConfigResources.js`    | S     | Add env/volume consumption tracking if objectives use it                                                                                                                                            |
| `js/resources/StorageResources.js`   | S+F   | PV/PVC binding fields, StorageClass default annotations, CSI-friendly describes                                                                                                                     |
| `js/resources/ClusterResources.js`   | S+F   | Project/LimitRange/SCC-related; fix HPA describe shape drift; ResourceQuota usage                                                                                                                   |
| `js/resources/RBACResources.js`      | S     | Add OpenShift default roles awareness, subject kind `User/Group/ServiceAccount`, `system:*` groups                                                                                                  |
| `js/resources/OpenShiftResources.js` | **N** | New classes: Project, Route, BuildConfig, Build, ImageStream, DeploymentConfig, ReplicationController, Template, SCC, LimitRange, OperatorGroup, Subscription, CSV, InstallPlan                     |
| `js/data/kindRegistry.js`            | **N** | Single source of truth for all kinds (apiVersion, namespaced, class, mesh, aliases, explain, palette, minimap, columns, owner chains, stats key)                                                    |
| `js/data/CampaignLevels.js`          | C+S   | All 20 levels + chapters + hints + tutorials + starCriteria, new objective types                                                                                                                    |
| `js/data/IncidentDefs.js`            | C+S   | All 34 incidents re-worded to `oc`; ~10 new OpenShift incidents; add state-driven fields                                                                                                            |
| `js/data/Achievements.js`            | C+S   | 45 achievements rebuilt for OpenShift actions/counters                                                                                                                                              |
| `js/engine/ClusterState.js`          | S+F   | Kinds/chains/default namespaces, real quota model, registry-backed `addResource`, `isClusterScopedKind` from registry                                                                               |
| `js/engine/GameEngine.js`            | S+F   | Command types for new verbs, apiVersion resolver, make create/apply reachable, save/load wiring optional, objective v2 integration                                                                  |
| `js/engine/SimulationTick.js`        | S+F   | PVC binding, BuildConfig/Build/ImageStream, Route admission, DeploymentConfig, SCC gate, OLM lifecycle, registry-backed pod/RS/Job creation                                                         |
| `js/engine/IncidentEngine.js`        | S+F   | State-driven incidents, cascade rules for new incidents, fix double-tick, resolution effects that mutate resources                                                                                  |
| `js/engine/ScoringEngine.js`         | S+C+F | EX280 XP titles, kind→stat map, advisor categories (fix container data paths), progress schema/migration, palette creation counting                                                                 |
| `js/ui/CommandBar.js`                | S+C   | `oc` prompt/echo/usage, prefix normalization, new commands, real `apply -f`, get/rollout grammar, EXPLAIN_DATA for OpenShift kinds, aliases, headers/rows, create defaults                          |
| `js/ui/InspectorPanel.js`            | S+C   | Tabs for Builds/Routes/SCC, `API Version` from resource, per-kind renderers, describe for new kinds                                                                                                 |
| `js/ui/ContextMenu.js`               | S+C   | Per-kind OpenShift actions (Start Build, Expose, Set Trigger, Edit SCC, …), Investigate action                                                                                                      |
| `js/ui/HUD.js`                       | S+C   | Counters Projects/Builds/Routes, mode labels, logo/title, XP display                                                                                                                                |
| `js/ui/IncidentPanel.js`             | S+C+F | Severity fix, step matching for `oc`, state-driven resolve, remove dead localStorage                                                                                                                |
| `js/ui/MetricsDashboard.js`          | S+C   | Optionally replace Network KB/s with builds/routes metrics; labels                                                                                                                                  |
| `js/ui/Minimap.js`                   | S     | `KIND_SIZES`/colors for new kinds                                                                                                                                                                   |
| `js/ui/SettingsPanel.js`             | S+F   | Merge settings schemas (G5), EX280 difficulty copy, localStorage keys                                                                                                                               |
| `js/rendering/ResourceMeshes.js`     | S     | `CREATORS` for new kinds or generic OpenShift badge; `STATUS_COLORS` for build/route phases                                                                                                         |
| `js/rendering/ClusterRenderer.js`    | S     | Namespace/project plane semantics, new connection types, clean dead `syncWithState`                                                                                                                 |
| `js/rendering/ConnectionLines.js`    | S     | Relationship types for route→service, build→imagestream, dc→rc                                                                                                                                      |
| `js/rendering/ParticleTraffic.js`    | R/F   | Wire routes or delete (dead subsystem)                                                                                                                                                              |
| `js/modes/CampaignMode.js`           | S+C   | Objective v2 evaluator extraction, EX280 chapter flow, tutorial wiring or removal                                                                                                                   |
| `js/modes/ChallengeMode.js`          | S+C   | New CHALLENGES data, evaluator alignment, fix route path bug                                                                                                                                        |
| `js/modes/ChaosMode.js`              | S+C   | OpenShift initial cluster, incident roster, health/waves copy                                                                                                                                       |
| `js/modes/SandboxMode.js`            | S+C+F | Kind list/version map, advisor integration, export via single serializer                                                                                                                            |
| `tests/*.test.js`                    | **N** | Pure-Node tests: registry consistency, objective evaluator, simulation controllers, YAML serializer, incident lifecycle                                                                             |
| `docs/*`                             | **N** | This map + research docs + conversion status/QA checklist                                                                                                                                           |

## Appendix B — How to verify claims in this document / run pure-model tests

No build step, no deps, Node ≥ 18:

```bash
# 1) Re-derive structural facts from source
cd /root/openshiftgames
grep -c "^export class" js/resources/*.js                # 25 classes total
grep -nE "^    [A-Za-z][A-Za-z]*\(resource\) \{" js/rendering/ResourceMeshes.js   # 17 CREATORS (+factory)
grep -rn "\.tick(" js/ index.html draw.html              # only SimulationTick/GameEngine call tick
grep -rn "getShape\|getColor" js/ | grep -v js/resources # empty => dead methods
grep -rn "localStorage" js/ index.html                   # 3 keys
ls .github package.json 2>/dev/null                      # absent => no tests/CI/build

# 2) Executable proof of the addResource downgrade/uid bug (read-only)
node --input-type=module -e "
import { ClusterState } from './js/engine/ClusterState.js';
const cs = new ClusterState(null);
const before = { kind:'Pod', name:'x',
  metadata:{ uid:'draw-pod-123', name:'x', namespace:'default', labels:{} },
  spec:{}, status:{phase:'Running'} };
const r = cs.addResource(before);
console.log('uid match:', r.uid === before.metadata.uid, '| class:', r.constructor.name);
"

# 3) Serve the game exactly as production does (static files, no build).
#    The dev server emulates vercel.json's /draw and /v/<version>/js/* rewrites
#    (with Cache-Control: no-store locally) — a plain static server cannot.
node scripts/dev-server.mjs        # open http://localhost:8080 and /draw

# 4) Suggested first test file (tests/registry.test.js) asserts:
#    - every kind in kindRegistry has: class, apiVersion, namespaced flag, aliases[0],
#      palette entry, mesh creator (or explicit allowlisted fallback), minimap size
#    - every objective type used in CampaignLevels/CHALLENGES exists in evaluateObjective
#    - every incident id/name referenced by levels/challenges exists in INCIDENT_DEFS
#    - every kind referenced by incidents' affectedResourceTypes exists in the registry
#    - YAML round-trip: oc-valid manifests for all kinds via the single serializer
```

Manual browser QA checklist for any conversion PR:

1. Main menu renders, all four modes launch, `/draw` link works.
2. Palette place → name prompt → resource appears, can be inspected (Overview/YAML/Events/Describe),
   edited, scaled, deleted; Auto-Align; YAML export downloads valid multi-doc YAML.
3. Command bar: `/`, tab completion, history, `oc get/describe/create/apply -f/scale/delete/rollout/
logs/exec/expose/new-app/new-project/start-build/top`, error messages match real `oc` closely enough
   for teaching.
4. Campaign levels 1–20 completable in order (automated `evaluateObjective` simulation + one human run of
   each chapter milestone); stars compute; reload preserves progress.
5. Challenges 1–10 completable/timeout works; Chaos survives/game-over modal; Sandbox advisor updates.
6. Incidents appear, steps match typed commands, resolve requires fixing state (post-G9), cascades work.
7. No console errors; particles/settings toggles actually take effect; minimap click navigates.
8. Reload mid-level does not corrupt progress (settings/progress schema versioning).

---

_End of map. Keep this file updated when registries, objective types, incident schema, or workstream
interfaces change — it is the shared contract for the conversion._
