/**
 * ResourceSpotlight — keeps a session's 3D view clean and makes the player's
 * own resources findable.
 *
 * TWO PROBLEMS, ONE OWNERSHIP MODEL
 * A fresh cluster seeds ~50 OpenShift platform defaults (10 Projects, SAs, SCCs,
 * RBAC users, 13 ClusterOperators, ClusterVersion, ImageStreams, Template,
 * OAuth). That seed is deliberate — objectives and `oc` output use it — but the
 * VIEW should not show it first:
 *   A. A campaign/timed-lab session must look CLEAN: only the level's starting
 *      resources, the Nodes and anything the player creates are shown; seeded
 *      platform defaults live behind the HUD "Platform N" toggle (visible but
 *      dimmed when revealed).
 *   B. A first-timer must be able to find the object they just created among the
 *      ~50 pedestals: player-created resources get a quiet red "yours" ring and
 *      a "Mine N" HUD toggle/frame action; new creations pulse + briefly focus
 *      the camera.
 *
 * PLATFORM vs WORKING SET RULE
 *   - The module snapshots every cluster uid when it starts and again one
 *     macrotask after `cluster:reset` (ClusterState re-seeds synchronously and
 *     then modes add their starting resources in the same task).
 *   - Working set = the level/challenge `startingResources` (resolved by
 *     kind/name/namespace) + every Node (the cluster hardware is always shown) +
 *     everything the player creates later.
 *   - Platform = every other uid from the snapshot, i.e. the seeded OpenShift
 *     defaults. `Platform N` counts those (live, in the cluster).
 *   - Clean-lab modes (campaign/challenge) start with the platform hidden;
 *     sandbox/chaos start with it visible and undimmed (the toggle lets the
 *     player hide it for a clean workspace).
 *   - Auto-reveal: a platform resource referenced by the current objective
 *     (kind/name objectives, SCC grants, cluster-health objects…) or by an
 *     active incident (`incident.uid`) is always shown, dimmed like the rest of
 *     the revealed platform. Recomputed on a slow interval and on incident
 *     events, never on every frame.
 *   - Returning to the menu destroys this module, which clears the renderer's
 *     ownership and platform chrome — the start-page hero keeps the full
 *     showcase diorama.
 *
 * OWNERSHIP (MINE) RULE
 *   1. Anything added after the baseline snapshot that is not a `seed-` uid is
 *      player-created: palette, `oc create`, `oc new-project`, `oc apply -f`,
 *      plus controller children of the player's workloads (a Pod you caused to
 *      exist is yours too). Only direct creations (no ownerReferences, not the
 *      auto-provisioned default ServiceAccount) are announced, so a Deployment
 *      spawns its Pods quietly.
 *   2. `resource:created` / `resource:applied` (kind/name/namespace, no uid) are
 *      resolved through ClusterState and force-marked — redundant with (1) but
 *      keeps CLI creations correct if a snapshot lands at an awkward moment.
 *   3. Incident-engine target objects (`openshiftgames.io/incident-target`) are
 *      never claimed as "yours"; they are platform/incident context.
 *   EDGE CASES: a player resource created inside the <1 tick settling window
 *   after a reset would fold into the baseline (unreachable without code running
 *   inside a synchronous mode setup); incident-repair restorations count as
 *   yours; ownership is per-run and cleared on reset/menu.
 *
 * SAFETY
 * Every renderer/mode access is optional (menu, other modes). The creation toast
 * is a pointer-events:none status chip under the HUD and camera focus is skipped
 * while a tutorial modal/coach mark is up, so nothing fights the level tutorial.
 */

/** ClusterState seeds every OpenShift platform default with this uid prefix. */
const SEED_UID_PREFIX = 'seed-';
/** Baseline re-snapshot after cluster:reset (modes seed synchronously after it). */
const BASELINE_SETTLE_MS = 0;
/** Wait for the renderer's debounced auto-refit before nudging the camera. */
const FOCUS_DELAY_MS = 1180;
/** Minimum gap between creation camera nudges. */
const FOCUS_COOLDOWN_MS = 2600;
const TOAST_VISIBLE_MS = 4200;
const TOAST_EXIT_MS = 260;
/** Auto-reveal poll (objectives/incidents) — deliberately slow. */
const AUTO_REVEAL_INTERVAL_MS = 1600;

const INCIDENT_ANNOTATION = 'openshiftgames.io/incident-target';
const CLEAN_MODES = new Set(['campaign', 'challenge']);

function uidOf(resource) {
  return resource?.uid || resource?.metadata?.uid || null;
}

function nameOf(resource) {
  return resource?.metadata?.name || resource?.name || '';
}

function namespaceOf(resource) {
  return resource?.metadata?.namespace || resource?.namespace || '';
}

export class ResourceSpotlight {
  /**
   * @param {import('./HUD.js').HUD} [hud]
   */
  constructor(hud = null) {
    this.hud = hud;
    this._bus = null;
    this._attached = false;

    // Player-created ("mine").
    this.mine = new Set();
    this.mineMode = false;
    this._lastResource = null;

    // Platform vs working set.
    this.baseline = new Set();
    this.platform = new Set();
    this.platformRevealed = true;
    this.platformDim = false;
    this.autoReveal = new Set();
    this._autoRevealSignature = '';

    // Timers / renderer retry.
    this._settling = false;
    this._settlingCandidates = [];
    this._baselineTimer = null;
    this._focusTimer = null;
    this._autoRevealTimer = null;
    this._pendingRendererMarks = new Set();
    this._lastFocusStartedAt = 0;

    // Toast.
    this._toastEl = null;
    this._toastTimer = null;
    this._toastExitTimer = null;

    this._onAdded = (data) => this._safe(() => this._handleAdded(data));
    this._onDeleted = (data) => this._safe(() => this._handleDeleted(data));
    this._onReset = () => this._safe(() => this._handleReset());
    this._onCreated = (data) => this._safe(() => this._handleResourceEvent(data));
    this._onApplied = (data) => this._safe(() => this._handleResourceEvent(data));
    this._onIncident = () => this._safe(() => this._refreshAutoReveal());
    this._onModeChanged = () => this._safe(() => this._refreshCount());
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init() {
    if (this._attached) this.destroy();
    this.mine.clear();
    this.platform.clear();
    this.autoReveal.clear();
    this._autoRevealSignature = '';
    this.baseline.clear();
    this._settling = false;
    this._settlingCandidates = [];
    this.mineMode = false;
    this.platformRevealed = true;
    this.platformDim = false;
    this._lastResource = null;
    this._snapshotBaseline();

    const renderer = this._renderer();
    if (renderer) {
      renderer.clearPlayerCreated?.();
      renderer.clearPlatformPresentation?.();
      renderer.setHighlightMine?.(false);
    }

    const bus = this._eventBus();
    if (bus) {
      this._bus = bus;
      this._attached = true;
      for (const [event, handler] of this._listenerPairs()) {
        try {
          bus.on?.(event, handler);
        } catch {
          /* bus variant without on() */
        }
      }
    }

    clearInterval(this._autoRevealTimer);
    this._autoRevealTimer = setInterval(() => {
      this._safe(() => this._refreshAutoReveal());
    }, AUTO_REVEAL_INTERVAL_MS);

    this._syncHud();
  }

  destroy() {
    this._clearTimers();
    this._hideToast();
    if (this._bus) {
      for (const [event, handler] of this._listenerPairs()) {
        try {
          this._bus.off?.(event, handler);
        } catch {
          /* ignore */
        }
      }
    }
    this._bus = null;
    this._attached = false;

    // Never leave ownership/platform chrome behind on the start-page hero.
    const renderer = this._renderer();
    if (renderer) {
      renderer.setHighlightMine?.(false);
      renderer.clearPlatformPresentation?.();
      renderer.clearPlayerCreated?.();
    }
    this.mine.clear();
    this.platform.clear();
    this.autoReveal.clear();
    this.baseline.clear();
    this._pendingRendererMarks.clear();
    this.mineMode = false;
    this.platformRevealed = true;
    this.platformDim = false;
    this._settling = false;
    this._settlingCandidates = [];
  }

  _listenerPairs() {
    return [
      ['cluster:added', this._onAdded],
      ['cluster:deleted', this._onDeleted],
      ['cluster:reset', this._onReset],
      ['engine:reset', this._onReset],
      ['resource:created', this._onCreated],
      ['resource:applied', this._onApplied],
      ['incident:created', this._onIncident],
      ['incident:activated', this._onIncident],
      ['incident:resolved', this._onIncident],
      ['engine:mode-changed', this._onModeChanged],
    ];
  }

  // ── Public HUD API ────────────────────────────────────────────────────────

  /** Number of marked player resources still present in the live cluster. */
  getCount() {
    return this._countPresent(this.mine);
  }

  /** Number of seeded platform defaults still present in the live cluster. */
  getPlatformCount() {
    return this._countPresent(this.platform);
  }

  isMineMode() {
    return this.mineMode;
  }

  isPlatformRevealed() {
    return this.platformRevealed;
  }

  toggleMineMode() {
    return this.setMineMode(!this.mineMode);
  }

  /**
   * @param {boolean} enabled
   * @param {{fit?:boolean}} [options]
   * @returns {boolean} resulting mode
   */
  setMineMode(enabled, options = {}) {
    const next = Boolean(enabled);
    if (next && this.getCount() === 0) {
      this.showEmptyHint();
      this._syncHud();
      return false;
    }
    this.mineMode = next;
    if (next) this._cancelFocus();
    this._renderer()?.setHighlightMine?.(this.mineMode, { fit: options.fit !== false });
    this._syncHud();
    return this.mineMode;
  }

  /** HUD focus action: frame the player's resources (camera only, defaults stay). */
  frameMine() {
    if (this.getCount() === 0) {
      this.showEmptyHint();
      return false;
    }
    const renderer = this._renderer();
    if (!renderer?.framePlayerCreated) return false;
    this._cancelFocus();
    const framed = renderer.framePlayerCreated({ animate: true });
    if (framed) {
      // One quiet pulse per owned object so the frame lands with a reason.
      let index = 0;
      for (const uid of this.mine) {
        if (!renderer.playerCreated?.has?.(uid)) continue;
        const group = renderer.resourceMeshes?.get?.(uid);
        if (!group || group.visible === false) continue;
        renderer.pulseResource?.(uid, { duration: 1500, rings: 1, delay: index * 60 });
        index += 1;
      }
    }
    return Boolean(framed);
  }

  /** HUD "Platform N": reveal/hide the seeded defaults. Always exits Mine first. */
  togglePlatform() {
    if (this.mineMode) this.setMineMode(false, { fit: false });
    return this.setPlatformRevealed(!this.platformRevealed, { fit: true });
  }

  /**
   * @param {boolean} revealed
   * @param {{fit?:boolean}} [options]
   * @returns {boolean} resulting reveal state
   */
  setPlatformRevealed(revealed, options = {}) {
    this.platformRevealed = Boolean(revealed);
    this._recomputeAutoReveal();
    this._applyPlatformPresentation({ fit: options.fit !== false });
    return this.platformRevealed;
  }

  showEmptyHint() {
    this._renderToast({
      kicker: 'Nothing of yours yet',
      title: 'Create a resource to make it yours',
      meta: 'Palette or oc — new objects get a red ring and a Mine count',
    });
  }

  /** Refresh everything cheap/idempotent (HUD tick or external callers). */
  refresh() {
    this._flushRendererMarks();
    this._refreshCount();
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  _handleAdded(payload) {
    const resource = payload?.resource;
    const uid = uidOf(resource) || payload?.uid;
    if (!uid) return;
    if (this._settling) {
      this._settlingCandidates.push({ uid, resource });
      return;
    }
    if (!this._shouldClaim(uid, resource)) return;
    this._claim(uid, resource);
  }

  _handleDeleted(payload) {
    const uid = payload?.uid || uidOf(payload?.resource);
    if (!uid) return;
    let changed = false;
    if (this.mine.delete(uid)) {
      this._renderer()?.unmarkPlayerCreated?.(uid);
      changed = true;
    }
    if (this.platform.delete(uid)) {
      this.autoReveal.delete(uid);
      changed = true;
    }
    if (changed) this._syncHud();
  }

  _handleResourceEvent(payload) {
    const uid = this._resolveUid(payload);
    if (!uid) return;
    const resource = this._cluster()?.getResource?.(uid) || payload?.resource || null;
    if (this._settling) {
      this._settlingCandidates.push({ uid, resource });
      return;
    }
    if (!this._shouldClaim(uid, resource)) return;
    this._claim(uid, resource);
  }

  _handleReset() {
    this._settling = true;
    this._settlingCandidates = [];
    this.mine.clear();
    this.platform.clear();
    this.autoReveal.clear();
    this._autoRevealSignature = '';
    this._clearTimers(true);
    this._cancelFocus();
    this._hideToast();
    this.mineMode = false;
    this.platformRevealed = true;
    this.platformDim = false;
    this._pendingRendererMarks.clear();
    const renderer = this._renderer();
    renderer?.clearPlayerCreated?.();
    renderer?.clearPlatformPresentation?.();
    renderer?.setHighlightMine?.(false);
    this._syncHud();

    // ClusterState.clear() re-seeds BEFORE it emits cluster:reset; modes then add
    // their starting resources synchronously in the same task. One macrotask
    // later the new baseline (platform + level assets) fully exists.
    this._baselineTimer = setTimeout(() => {
      this._baselineTimer = null;
      this._snapshotBaseline();
      const candidates = this._settlingCandidates;
      this._settlingCandidates = [];
      this._settling = false;
      for (const { uid, resource } of candidates) {
        if (!this._shouldClaim(uid, resource)) continue;
        this._claim(uid, resource);
      }
      this._rebuildPlatformSet();
      this._recomputeAutoReveal();
      this._applyPlatformPresentation({ fit: true });
      this._refreshCount();
      clearInterval(this._autoRevealTimer);
      this._autoRevealTimer = setInterval(() => {
        this._safe(() => this._refreshAutoReveal());
      }, AUTO_REVEAL_INTERVAL_MS);
    }, BASELINE_SETTLE_MS);
  }

  _claim(uid, resource) {
    if (!uid || this.mine.has(uid)) return;
    this.mine.add(uid);
    this._lastResource = resource || null;
    this._applyRendererMark(uid);
    this._syncHud();
    if (this._isDirectCreation(resource)) this._announce(uid, resource);
  }

  // ── Ownership rule ────────────────────────────────────────────────────────

  _snapshotBaseline() {
    const cluster = this._cluster();
    this.baseline.clear();
    let resources = [];
    try {
      resources = cluster?.getAllResources?.() || [];
    } catch {
      resources = [];
    }
    for (const resource of resources) {
      const uid = uidOf(resource);
      if (uid) this.baseline.add(uid);
    }
  }

  /** @returns {boolean} true when a newly added resource belongs to the player. */
  _shouldClaim(uid, resource) {
    if (!uid) return false;
    if (typeof uid === 'string' && uid.startsWith(SEED_UID_PREFIX)) return false;
    if (this.baseline.has(uid)) return false;
    if (this._isIncidentTarget(resource)) return false;
    // A controller child of a seeded/level object (ReplicaSet/Pod of a starting
    // Deployment) is level furniture: it stays visible as part of the working set
    // but must not show the red "yours" ring or inflate the Mine count. Children
    // of objects the player created are still mine.
    if (this._ownerChainState(resource) === 'baseline') return false;
    return true;
  }

  /**
   * Walk ownerReferences to classify a controller-created resource:
   * 'mine' (an ancestor was player-created), 'baseline' (an ancestor belongs to
   * the seed/level furniture), 'root' (no owners) or 'unknown'.
   */
  _ownerChainState(resource) {
    let current = resource;
    for (let depth = 0; depth < 4; depth += 1) {
      const owners = current?.metadata?.ownerReferences;
      if (!Array.isArray(owners) || owners.length === 0) return 'root';
      const owner = owners[0];
      let ownerUid = owner?.uid || null;
      if (!ownerUid)
        ownerUid = uidOf(this._findResource(owner?.kind, owner?.name, owner?.namespace));
      if (!ownerUid) return 'unknown';
      if (this.mine.has(ownerUid)) return 'mine';
      if (this.baseline.has(ownerUid) || this.platform.has(ownerUid)) return 'baseline';
      current = this._cluster()?.getResource?.(ownerUid) || null;
      if (!current) return 'unknown';
    }
    return 'unknown';
  }

  _isIncidentTarget(resource) {
    const annotations = resource?.metadata?.annotations || resource?._ref?.metadata?.annotations;
    if (!annotations) return false;
    return annotations[INCIDENT_ANNOTATION] === 'true' || annotations[INCIDENT_ANNOTATION] === true;
  }

  /** Direct creation = an object the player asked for (not a controller child). */
  _isDirectCreation(resource) {
    if (!resource) return true;
    const owners = resource?.metadata?.ownerReferences;
    if (Array.isArray(owners) && owners.length > 0) return false;
    if (resource.kind === 'ServiceAccount' && nameOf(resource) === 'default') return false;
    return true;
  }

  _resolveUid(payload) {
    if (!payload) return null;
    if (payload.uid) return payload.uid;
    if (uidOf(payload.resource)) return uidOf(payload.resource);
    const kind = payload.kind;
    const name = payload.name || nameOf(payload.resource);
    if (!kind || !name) return null;
    const namespace = payload.namespace;
    const cluster = this._cluster();
    if (!cluster) return null;
    try {
      const scopedNamespace = namespace === undefined || namespace === null ? 'default' : namespace;
      const byName = cluster.getByName?.(kind, name, scopedNamespace);
      if (byName) return uidOf(byName);
    } catch {
      /* fall through to a linear scan */
    }
    try {
      const match = (cluster.getAllResources?.() || []).find(
        (candidate) =>
          candidate.kind === kind &&
          nameOf(candidate) === name &&
          (namespace === undefined || namespaceOf(candidate) === namespace)
      );
      if (match) return uidOf(match);
    } catch {
      /* no cluster */
    }
    return null;
  }

  // ── Platform vs working set ──────────────────────────────────────────────

  /** Rebuild the platform set from the post-mode-setup baseline. */
  _rebuildPlatformSet() {
    const cluster = this._cluster();
    const working = new Set();

    // Nodes are the cluster hardware: always part of the working set.
    try {
      for (const node of cluster?.getByKind?.('Node') || []) {
        const uid = uidOf(node);
        if (uid) working.add(uid);
      }
    } catch {
      /* no cluster */
    }

    // Level/challenge starting resources are the session's furniture.
    const levelDef = this._levelDef();
    for (const descriptor of levelDef?.startingResources || []) {
      const found = this._findResource(descriptor?.kind, descriptor?.name, descriptor?.namespace);
      const uid = uidOf(found);
      if (uid) working.add(uid);
    }

    this.platform = new Set();
    for (const uid of this.baseline) {
      if (!working.has(uid)) this.platform.add(uid);
    }

    const clean = CLEAN_MODES.has(this._mode());
    this.platformRevealed = !clean;
    this.platformDim = clean;
  }

  /** @returns {Set<string>} platform uids the objective/incidents currently need. */
  _computeAutoReveal() {
    const referenced = new Set();
    const cluster = this._cluster();

    // Active incidents point at a resolved target uid.
    try {
      const incidents = window.game?.incidentEngine?.getActiveIncidents?.() || [];
      for (const incident of incidents) {
        if (incident?.uid) {
          referenced.add(incident.uid);
          continue;
        }
        const target = incident?.target;
        if (!target) continue;
        const match = (cluster?.getAllResources?.() || []).find(
          (candidate) =>
            nameOf(candidate) === target &&
            (!incident.namespace || namespaceOf(candidate) === incident.namespace)
        );
        if (match) referenced.add(uidOf(match));
      }
    } catch {
      /* incident engine not ready */
    }

    // Current level/challenge objectives may reference platform defaults
    // (SCCs, ClusterVersion, ImageStreams, projects…): never hide those.
    const levelDef = this._levelDef();
    if (levelDef && CLEAN_MODES.has(this._mode())) {
      for (const objective of levelDef.objectives || []) {
        this._collectObjectiveRefs(objective, referenced);
      }
    }

    const next = new Set();
    for (const uid of referenced) {
      if (uid && this.platform.has(uid)) next.add(uid);
    }
    return next;
  }

  _refreshAutoReveal() {
    const next = this._computeAutoReveal();
    const signature = [...next].sort().join('|');
    if (signature === this._autoRevealSignature) return;
    this._autoRevealSignature = signature;
    this.autoReveal = next;
    this._applyPlatformPresentation({ fit: false });
  }

  _recomputeAutoReveal() {
    this.autoReveal = this._computeAutoReveal();
    this._autoRevealSignature = [...this.autoReveal].sort().join('|');
  }

  /** Add any existing platform resource referenced by an objective. */
  _collectObjectiveRefs(objective, out) {
    if (!objective) return;
    const add = (kind, name, namespace) => {
      const found = this._findResource(kind, name, namespace);
      const uid = uidOf(found);
      if (uid) out.add(uid);
    };
    const type = objective.type;

    if (objective.kind && objective.name) add(objective.kind, objective.name, objective.namespace);
    if (objective.resource) {
      add(objective.resource.kind, objective.resource.name, objective.resource.namespace);
    }
    if (type === 'operator') add('Subscription', objective.operator || objective.name);
    if (type === 'scc') add('SecurityContextConstraints', objective.scc || objective.name);
    if (type === 'clusterHealth') add('ClusterVersion', 'version');
    if (type === 'user') add('User', objective.user || objective.name);
    if (type === 'group') add('Group', objective.group || objective.name);
    if (type === 'imageStream')
      add('ImageStream', objective.imageStream || objective.name, objective.namespace);
    if (type === 'image' && !objective.kind)
      add('ImageStream', objective.imageStream || objective.name);
    // e.g. scc objective subject "system:serviceaccount:secure:default"
    if (typeof objective.subject === 'string') {
      const match = /^system:serviceaccount:([^:]+):(.+)$/.exec(objective.subject);
      if (match) add('ServiceAccount', match[2], match[1]);
    }
  }

  _applyPlatformPresentation({ fit = false } = {}) {
    this._renderer()?.setPlatformPresentation?.(
      {
        uids: this.platform,
        revealed: this.platformRevealed,
        dim: this.platformDim,
        autoReveal: this.autoReveal,
      },
      { fit: fit === true }
    );
    this._syncHud();
  }

  _findResource(kind, name, namespace) {
    if (!kind || !name) return null;
    const cluster = this._cluster();
    if (!cluster) return null;
    try {
      const scoped = namespace === undefined || namespace === null ? 'default' : namespace;
      const byName = cluster.getByName?.(kind, name, scoped);
      if (byName) return byName;
    } catch {
      /* fall through */
    }
    try {
      return (
        (cluster.getAllResources?.() || []).find(
          (candidate) =>
            candidate.kind === kind &&
            nameOf(candidate) === name &&
            (namespace === undefined || namespaceOf(candidate) === namespace)
        ) || null
      );
    } catch {
      return null;
    }
  }

  // ── Renderer sync ─────────────────────────────────────────────────────────

  _applyRendererMark(uid) {
    const renderer = this._renderer();
    if (!renderer?.markPlayerCreated) {
      this._pendingRendererMarks.add(uid);
      return;
    }
    try {
      renderer.markPlayerCreated(uid);
    } catch {
      this._pendingRendererMarks.add(uid);
    }
  }

  _flushRendererMarks() {
    if (!this._pendingRendererMarks.size) return;
    const renderer = this._renderer();
    if (!renderer?.markPlayerCreated) return;
    for (const uid of this._pendingRendererMarks) this._applyRendererMark(uid);
    this._pendingRendererMarks.clear();
  }

  // ── Creation feedback ─────────────────────────────────────────────────────

  _announce(uid, resource) {
    const renderer = this._renderer();
    try {
      renderer?.pulseResource?.(uid, { duration: 2200, rings: 2 });
    } catch {
      /* renderer without pulse support */
    }
    this._showCreationToast(resource || this._cluster()?.getResource?.(uid));
    this._scheduleFocus(uid);
  }

  _scheduleFocus(uid) {
    clearTimeout(this._focusTimer);
    this._focusTimer = null;
    const renderer = this._renderer();
    if (!renderer || renderer.isMenuMode || this.mineMode) return;
    this._focusTimer = setTimeout(() => {
      this._focusTimer = null;
      const activeRenderer = this._renderer();
      if (!activeRenderer || activeRenderer.isMenuMode) return;
      if (!this.mine.has(uid)) return;
      if (this._tutorialBusy()) return;
      // At most one camera acknowledgment every few seconds: creating a burst is
      // not a reason to keep moving the player's view.
      if (performance.now() - this._lastFocusStartedAt < FOCUS_COOLDOWN_MS) return;
      const group = activeRenderer.resourceMeshes?.get?.(uid);
      if (!group || group.visible === false) return;
      this._lastFocusStartedAt = performance.now();
      try {
        activeRenderer.focusResourceBriefly?.(uid);
      } catch {
        /* older renderer */
      }
    }, FOCUS_DELAY_MS);
  }

  /** True while an intro modal or coach mark is on screen (never fight the tutorial). */
  _tutorialBusy() {
    try {
      if (document.getElementById('tutorial-overlay')) return true;
      if (document.querySelector('.coach-card-wrap')) return true;
      if (document.getElementById('pause-overlay')?.classList.contains('active')) return true;
      return false;
    } catch {
      return false;
    }
  }

  _cancelFocus() {
    clearTimeout(this._focusTimer);
    this._focusTimer = null;
    try {
      this._renderer()?._cancelFocusAnimation?.(false);
    } catch {
      /* ignore */
    }
  }

  // ── Toast (pointer-events: none — it can never block the game) ────────────

  _showCreationToast(resource) {
    const kind = resource?.kind || 'Resource';
    const name = nameOf(resource);
    const namespace = namespaceOf(resource);
    const parts = [];
    if (namespace) parts.push(`in ${namespace}`);
    parts.push('red ring marks it as yours');
    this._renderToast({
      kicker: 'You created',
      title: name ? `${kind} · ${name}` : kind,
      meta: parts.join(' · '),
    });
  }

  _renderToast({ kicker, title, meta }) {
    if (typeof document === 'undefined') return;
    let el = this._toastEl;
    if (!el || !el.isConnected) {
      el = document.createElement('div');
      el.id = 'resource-spotlight-toast';
      el.className = 'spotlight-toast';
      el.setAttribute('data-testid', 'spotlight-toast');
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.innerHTML = `
        <span class="spotlight-toast-mark" aria-hidden="true"><span></span></span>
        <span class="spotlight-toast-body">
          <span class="spotlight-toast-kicker"></span>
          <span class="spotlight-toast-title"></span>
          <span class="spotlight-toast-meta"></span>
        </span>`;
      document.body.appendChild(el);
      this._toastEl = el;
    }
    el.classList.remove('spotlight-toast-out');
    const setText = (selector, value) => {
      const node = el.querySelector(selector);
      if (node) node.textContent = value;
    };
    setText('.spotlight-toast-kicker', kicker);
    setText('.spotlight-toast-title', title);
    setText('.spotlight-toast-meta', meta);

    clearTimeout(this._toastTimer);
    clearTimeout(this._toastExitTimer);
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null;
      if (this._toastEl) this._toastEl.classList.add('spotlight-toast-out');
      this._toastExitTimer = setTimeout(() => this._hideToast(), TOAST_EXIT_MS);
    }, TOAST_VISIBLE_MS);
  }

  _hideToast() {
    clearTimeout(this._toastTimer);
    clearTimeout(this._toastExitTimer);
    this._toastTimer = null;
    this._toastExitTimer = null;
    if (this._toastEl) {
      this._toastEl.remove();
      this._toastEl = null;
    } else if (typeof document !== 'undefined') {
      document.getElementById('resource-spotlight-toast')?.remove();
    }
  }

  // ── HUD sync / helpers ────────────────────────────────────────────────────

  _countPresent(uids) {
    if (!uids.size) return 0;
    const cluster = this._cluster();
    if (!cluster) return uids.size;
    const resources = cluster.resources;
    if (resources && typeof resources.has === 'function') {
      let count = 0;
      for (const uid of uids) if (resources.has(uid)) count += 1;
      return count;
    }
    let count = 0;
    for (const uid of uids) {
      try {
        if (cluster.getResource?.(uid)) count += 1;
      } catch {
        count += 1;
      }
    }
    return count;
  }

  _refreshCount() {
    this._flushRendererMarks();
    this._syncHud();
  }

  _syncHud() {
    this.hud?.setMineCount?.(this.getCount());
    this.hud?.setMineActive?.(this.mineMode);
    this.hud?.setPlatformCount?.(this.getPlatformCount());
    this.hud?.setPlatformRevealed?.(this.platformRevealed);
  }

  _clearTimers(keepAutoReveal = false) {
    clearTimeout(this._baselineTimer);
    clearTimeout(this._focusTimer);
    clearTimeout(this._toastTimer);
    clearTimeout(this._toastExitTimer);
    this._baselineTimer = null;
    this._focusTimer = null;
    this._toastTimer = null;
    this._toastExitTimer = null;
    if (!keepAutoReveal) {
      clearInterval(this._autoRevealTimer);
      this._autoRevealTimer = null;
    }
  }

  _mode() {
    return window.game?.app?.currentMode || null;
  }

  _levelDef() {
    const instance = window.game?.app?.modeInstance;
    return instance?.currentLevelDef || instance?.currentChallengeDef || null;
  }

  _eventBus() {
    return window.game?.engine || window.game?.app?.engine?.eventBus || null;
  }

  _renderer() {
    return window.game?.renderer || window.game?.app?.renderer || null;
  }

  _cluster() {
    return (
      window.game?.cluster ||
      window.game?.app?.engine?.cluster ||
      window.game?.gameEngine?.cluster ||
      null
    );
  }

  _safe(fn) {
    try {
      return fn();
    } catch (error) {
      console.warn('ResourceSpotlight: handler failed', error);
      return undefined;
    }
  }
}

export default ResourceSpotlight;
