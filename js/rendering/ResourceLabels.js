import * as THREE from 'three';
import { getStatusColor } from './ResourceMeshes.js';
import { visualStatusFor, isAttentionStatus } from './ResourceStatus.js';

/**
 * Screen-space resource labels for the 3D cluster diorama.
 *
 * The old implementation drew each name as a 3D sprite: distance-scaled, blurry at
 * the fitted camera distance, and prone to stacking into unreadable black clusters.
 * This layer is an HTML overlay instead, which gives true 11.5px UI type, a subtle
 * dark scrim, per-label opacity fades, priority + collision culling (LOD) and an
 * honest status dot — while staying entirely inside this module (inline styles, no
 * CSS or index.html edits needed).
 *
 * Mount: absolutely positioned inside the canvas' parent element, immediately after
 * the canvas, `pointer-events: none`, clipped by the parent. It therefore follows the
 * canvas when the canvas is reparented into the start-page hero stage, and never
 * draws over HUD/game UI (which live in a higher stacking context).
 *
 * Public methods (see ClusterRenderer for the wiring):
 *   update(context)      — call once per rendered frame
 *   setVisible(bool)     — show/hide the whole layer
 *   refresh()            — force re-measure after layout changes
 *   dispose()
 */

const FONT_STACK =
  "'Schibsted Grotesk', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const LABEL_FONT_SIZE = 13;
const LABEL_HEIGHT = 22;
const LABEL_GAP = 16; // px between anchor point and label bottom edge (game)
const LABEL_GAP_MENU = 28; // extra clearance in the hero window
const MAX_LABELS_MENU = 6;
const UPDATE_INTERVAL = 1000 / 30; // 30 Hz is plenty for labels

/** Higher bias = survives culling longer. Mirrors how a newcomer reads the scene. */
const KIND_BIAS = {
  Project: 7,
  Node: 7,
  ClusterOperator: 5,
  Service: 4,
  Route: 3,
  Deployment: 3,
  Pod: 2,
  BuildConfig: 2,
  ImageStream: 2,
  PersistentVolumeClaim: 2,
  ConfigMap: 2,
  Secret: 2,
  SecurityContextConstraints: 2,
  Subscription: 2,
  User: 2,
  Group: 2,
};

/** Menu labels: one label per name, keeping the most meaningful kind. */
const KIND_DEDUPE_PRIORITY = {
  Project: 100,
  Node: 95,
  Deployment: 85,
  StatefulSet: 84,
  DaemonSet: 83,
  Job: 82,
  CronJob: 81,
  ReplicaSet: 80,
  Pod: 70,
  BuildConfig: 60,
  ImageStream: 58,
  Service: 55,
  Route: 52,
  Ingress: 50,
  ConfigMap: 45,
  Secret: 44,
  PersistentVolumeClaim: 42,
  PersistentVolume: 40,
  HorizontalPodAutoscaler: 35,
  PodDisruptionBudget: 34,
  NetworkPolicy: 30,
};

function hexToCss(hex) {
  return `#${Number(hex || 0x58a6ff)
    .toString(16)
    .padStart(6, '0')}`;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export class ResourceLabelLayer {
  /**
   * @param {import('./ClusterRenderer.js').ClusterRenderer} renderer
   */
  constructor(renderer) {
    this.renderer = renderer;
    this.canvas = renderer.canvas;
    this.camera = renderer.camera;
    this.controls = renderer.controls;

    this.labels = new Map(); // resourceId → label record
    this.layer = null;
    this.visible = true;
    this.enabled = true;
    this._acc = 0;
    this._lastTick = 0;
    this._lastRectSignature = '';
    this._lastParent = null;
    this._projected = new THREE.Vector3();

    this._mounted = false;
    this._mount();
  }

  // ── Mounting ──────────────────────────────────────────────────────────────
  _mount() {
    if (this._mounted) return;
    const layer = document.createElement('div');
    layer.className = 'cluster-label-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = [
      'position:absolute',
      'left:0px',
      'top:0px',
      'width:0px',
      'height:0px',
      'z-index:0',
      'pointer-events:none',
      'overflow:hidden',
      'contain:layout paint style',
    ].join(';');
    this.layer = layer;
    this._insertLayer();
    this._mounted = true;
    this._lastTick = performance.now();
  }

  _insertLayer() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    if (this.layer.parentElement !== parent) {
      // Re-append after the canvas so the label layer paints above the WebGL canvas
      // but still below later UI siblings / higher stacking contexts.
      parent.appendChild(this.layer);
      this._lastParent = parent;
      this._lastRectSignature = '';
    }
  }

  /** Position/measure the layer over the canvas; returns false when it can't render. */
  _syncRect() {
    const canvas = this.canvas;
    const layer = this.layer;
    if (!canvas || !layer || !canvas.isConnected) return false;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width < 8 || height < 8) {
      layer.style.opacity = '0';
      return false;
    }
    const shown = this.visible && this.enabled;
    layer.style.opacity = shown ? '1' : '0';
    if (!shown) return false;

    const rect = canvas.getBoundingClientRect();
    const offsetParent = layer.offsetParent || document.body;
    const parentRect = offsetParent.getBoundingClientRect();
    const left = rect.left - parentRect.left - offsetParent.clientLeft + offsetParent.scrollLeft;
    const top = rect.top - parentRect.top - offsetParent.clientTop + offsetParent.scrollTop;

    const signature = `${Math.round(left)},${Math.round(top)},${Math.round(width)},${Math.round(height)}`;
    if (signature !== this._lastRectSignature) {
      this._lastRectSignature = signature;
      layer.style.left = `${Math.round(left)}px`;
      layer.style.top = `${Math.round(top)}px`;
      layer.style.width = `${Math.round(width)}px`;
      layer.style.height = `${Math.round(height)}px`;
    }
    return true;
  }

  // ── Label elements ────────────────────────────────────────────────────────
  _createLabel(id, group) {
    const el = document.createElement('div');
    el.className = 'cluster-label';
    el.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'display:none',
      'white-space:nowrap',
      `font-family:${FONT_STACK}`,
      `font-size:${LABEL_FONT_SIZE}px`,
      'line-height:1',
      'font-weight:550',
      'letter-spacing:0.005em',
      'color:#dbe3ee',
      'background:rgba(10,13,19,0.62)',
      'border:1px solid rgba(255,255,255,0.06)',
      'border-radius:5px',
      'padding:4px 7px 4px 6px',
      'transform:translate3d(0,0,0)',
      'will-change:transform,opacity',
      'contain:layout style',
      'user-select:none',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText = [
      'display:inline-block',
      'width:5px',
      'height:5px',
      'border-radius:50%',
      'margin-right:5px',
      'vertical-align:1px',
      'background:#58a6ff',
    ].join(';');
    const text = document.createElement('span');
    const status = document.createElement('span');
    status.style.cssText = 'margin-left:5px;color:rgba(219,227,238,0.55);font-weight:500;';
    text.textContent = group.userData?.displayName || id;
    el.appendChild(dot);
    el.appendChild(text);
    el.appendChild(status);
    this.layer.appendChild(el);

    // Labels are the most obvious affordance on a model: make the chip clickable
    // so it selects the resource instead of falling through to the canvas and
    // deselecting whatever the learner was inspecting.
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.title = `${group.userData?.resourceKind || 'Resource'}/${group.userData?.displayName || id}`;

    const record = {
      id,
      kind: group.userData?.resourceKind || 'Unknown',
      name: group.userData?.displayName || id,
      status: undefined,
      mine: false,
      dimmed: false,
      el,
      dot,
      text,
      statusEl: status,
      group,
      labelY: group.userData?.labelY ?? 2.2,
      width: 0,
      height: LABEL_HEIGHT,
      state: '',
      transform: '',
      opacity: -1,
      displayed: false,
      visibleNow: false,
    };
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.renderer?.selectResource?.(record.id);
    });
    return record;
  }

  _measure(info) {
    if (info.width > 0) return;
    const el = info.el;
    el.style.display = 'block';
    el.style.visibility = 'hidden';
    info.width = Math.ceil(el.offsetWidth) || Math.ceil(info.name.length * 6.4 + 28);
    info.height = Math.ceil(el.offsetHeight) || LABEL_HEIGHT;
    el.style.visibility = '';
    el.style.display = 'none';
    info.displayed = false;
  }

  _applyState(info, state) {
    if (!info.el || info.state === state) return;
    info.state = state;
    const el = info.el;
    const mine = Boolean(info.mine);
    if (state === 'selected') {
      el.style.borderColor = 'rgba(255,166,87,0.55)';
      el.style.background = 'rgba(22,15,9,0.76)';
      el.style.color = '#ffe2c2';
    } else if (state === 'hovered') {
      el.style.borderColor = 'rgba(120,170,255,0.45)';
      el.style.background = 'rgba(10,14,22,0.74)';
      el.style.color = '#eef4ff';
    } else if (mine) {
      el.style.borderColor = 'rgba(238,0,0,0.42)';
      el.style.background = 'rgba(24,10,11,0.78)';
      el.style.color = '#ffe9e6';
    } else if (info.dimmed) {
      el.style.borderColor = 'rgba(255,255,255,0.035)';
      el.style.background = 'rgba(10,13,19,0.44)';
      el.style.color = '#8b939d';
    } else {
      el.style.borderColor = 'rgba(255,255,255,0.06)';
      el.style.background = 'rgba(10,13,19,0.62)';
      el.style.color = '#dbe3ee';
    }
    // The inset bar is independent of state so a "yours" label stays recognisable
    // while selected/hovered. It never changes the label's measured box.
    el.style.boxShadow = mine ? 'inset 2px 0 0 0 #ee0000' : 'none';
  }

  /** Sync the dimmed state (seeded platform defaults revealed in a clean lab). */
  _syncDim(info, group) {
    const dimmed = Boolean(group?.userData?.dimmed);
    if (info.dimmed === dimmed) return;
    info.dimmed = dimmed;
    info.state = '';
  }

  /** Sync the "yours" label accent (player-created resources only). */
  _syncMine(info, group) {
    const mineSet = this.renderer?.playerCreated;
    const mine = mineSet instanceof Set ? mineSet.has(info.id) : Boolean(group?.userData?.isMine);
    if (info.mine === mine) return;
    info.mine = mine;
    info.state = '';
  }

  _syncStatus(info, group) {
    // Prefer the status the renderer derived for this group (it is refreshed
    // every tick and includes Route endpoint refinement); fall back to deriving
    // it from the live resource when the renderer has not pushed one yet.
    const status =
      group?.userData?.status ||
      visualStatusFor(group?.userData?.resourceRef || null, null) ||
      null;
    if (info.status === status) return;
    info.status = status;
    if (info.dot) {
      const color = hexToCss(getStatusColor(status));
      info.dot.style.background = color;
      info.dot.style.boxShadow = 'none';
    }
    if (info.text) {
      info.text.textContent = info.name;
      if (info.statusEl) info.statusEl.textContent = isAttentionStatus(status) ? `· ${status}` : '';
      info.width = 0; // re-measure: the attention suffix changes the box
    }
  }

  _syncName(info, group) {
    const name = group?.userData?.displayName;
    if (name && info.name !== name) {
      info.name = name;
      if (info.text) info.text.textContent = name;
      if (info.el) info.el.title = `${group?.userData?.resourceKind || info.kind}/${name}`;
      info.width = 0;
    }
  }

  /** Sync DOM records with the renderer resource set. */
  _syncRecords() {
    const resources = this.renderer.resourceMeshes;
    for (const [id, group] of resources) {
      let info = this.labels.get(id);
      if (!info) {
        info = this._createLabel(id, group);
        this.labels.set(id, info);
      }
      info.group = group;
      info.kind = group.userData?.resourceKind || info.kind;
      info.labelY = group.userData?.labelY ?? 2.2;
      this._syncName(info, group);
      this._syncStatus(info, group);
      this._syncMine(info, group);
      this._syncDim(info, group);
    }
    for (const [id, info] of [...this.labels]) {
      if (!resources.has(id)) {
        info.el?.remove();
        this.labels.delete(id);
      }
    }
  }

  // ── Frame update ──────────────────────────────────────────────────────────
  /**
   * @param {{menuMode?:boolean, focus?:THREE.Vector3, fitRadius?:number}} [context]
   */
  update(context = {}) {
    const now = performance.now();
    const delta = now - this._lastTick;
    this._lastTick = now;
    this._acc += delta;

    if (!this._mounted || !this.visible || !this.enabled) {
      this._hideAll();
      return;
    }
    if (!this.canvas.isConnected) return;
    this._insertLayer();
    if (!this._syncRect()) {
      this._hideAll();
      return;
    }
    if (this._acc < UPDATE_INTERVAL) return;
    this._acc = 0;

    this._syncRecords();
    const resources = this.renderer.resourceMeshes;
    if (!resources || resources.size === 0) {
      this._hideAll();
      return;
    }

    const menuMode = Boolean(context.menuMode);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const camera = this.camera;
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const selected = this.renderer.selectedResource;
    const hovered = this.renderer.hoveredResource;
    const focus = context.focus || this.controls.target;
    const camPos = camera.position;
    const focusDistance = Math.max(6, camPos.distanceTo(focus));

    const candidates = [];
    for (const [id, info] of this.labels) {
      const group = info.group;
      if (!group) continue;
      if (group.visible === false) continue;
      this._projected.set(group.position.x, group.position.y + info.labelY, group.position.z);
      const camDistance = camPos.distanceTo(this._projected);
      const worldX = this._projected.x;
      const worldZ = this._projected.z;
      this._projected.project(camera);
      if (this._projected.z > 1 || this._projected.z < -1) continue;
      const ndcX = this._projected.x;
      const ndcY = this._projected.y;
      if (Math.abs(ndcX) > 1.06 || Math.abs(ndcY) > 1.06) continue;

      const isSelected = id === selected;
      const isHovered = id === hovered;
      const kindBias = KIND_BIAS[info.kind] || 0;
      const dFocus = Math.hypot(worldX - focus.x, worldZ - focus.z);
      const isMine = Boolean(info.mine);
      // Player-created objects win label collisions against seeded defaults: the
      // label layer is the first place a newcomer looks for "the thing I made".
      const priority = isSelected
        ? -1e6
        : isHovered
          ? -9e5
          : dFocus * 1.35 +
            camDistance * 0.22 -
            kindBias * 2 -
            (isMine ? 26 : 0) +
            (info.dimmed ? 18 : 0);

      // Distance fade relative to the framed camera distance — depth, not haze.
      const ratio = camDistance / focusDistance;
      let opacity = clamp01(1.24 - ratio * 0.62);
      if (opacity < 0.16) continue;
      // The hero window is small: keep its labels confidently present instead of
      // fading them like distant game labels.
      if (menuMode) opacity = Math.max(0.64, opacity);
      // Revealed platform labels recede: the working set is the foreground.
      if (info.dimmed) opacity *= 0.6;

      candidates.push({ info, ndcX, ndcY, priority, opacity, isSelected, isHovered, isMine });
    }

    // One label per resource name in every mode (a Project, Deployment and Service
    // can all be called "checkout"/"default"): keep the highest-priority kind, and
    // always keep an explicitly selected/hovered object.
    const labelGap = menuMode ? LABEL_GAP_MENU : LABEL_GAP;
    const ranked = candidates.map((candidate) => ({
      ...candidate,
      rank:
        (candidate.isSelected ? 1000 : 0) +
        (candidate.isHovered ? 900 : 0) +
        (candidate.isMine ? 140 : 0) -
        (candidate.info.dimmed ? 60 : 0) +
        (KIND_DEDUPE_PRIORITY[candidate.info.kind] || 0),
    }));
    ranked.sort((a, b) => b.rank - a.rank || a.priority - b.priority);
    const byName = new Map();
    for (const candidate of ranked) {
      const key = candidate.info.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, candidate);
    }
    const pooled = [...byName.values()].sort((a, b) => a.priority - b.priority);

    const area = width * height;
    const cap = menuMode ? MAX_LABELS_MENU : area >= 1_150_000 ? 26 : area >= 780_000 ? 20 : 13;

    const placed = [];
    const visibleIds = new Set();
    let visibleCount = 0;

    for (const candidate of pooled) {
      const info = candidate.info;
      const important = candidate.isSelected || candidate.isHovered;
      if (!important && visibleCount >= cap) continue;

      this._measure(info);
      const x = (candidate.ndcX * 0.5 + 0.5) * width;
      const y = (-candidate.ndcY * 0.5 + 0.5) * height;
      const rawLeft = x - info.width / 2;
      const left = Math.max(4, Math.min(width - info.width - 4, rawLeft));
      const top = y - labelGap - info.height;
      const centreX = left + info.width / 2;

      if (!important && this._overlaps(placed, left, top, info)) continue;

      placed.push({
        left: left - 4,
        top: top - 3,
        right: left + info.width + 4,
        bottom: top + info.height + 3,
      });
      visibleIds.add(info.id);
      visibleCount += 1;

      const el = info.el;
      if (!info.displayed) {
        el.style.display = 'block';
        info.displayed = true;
      }
      const transform = `translate3d(${centreX.toFixed(1)}px, ${(y - labelGap).toFixed(1)}px, 0) translate(-50%, -100%)`;
      if (info.transform !== transform) {
        info.transform = transform;
        el.style.transform = transform;
      }
      const alpha = Math.round(candidate.opacity * 100) / 100;
      if (info.opacity !== alpha) {
        info.opacity = alpha;
        el.style.opacity = String(alpha);
      }
      this._applyState(
        info,
        candidate.isSelected ? 'selected' : candidate.isHovered ? 'hovered' : 'default'
      );
    }

    for (const info of this.labels.values()) {
      if (info.displayed && !visibleIds.has(info.id)) this._hide(info);
    }
  }

  _overlaps(placed, left, top, info) {
    const right = left + info.width;
    const bottom = top + info.height;
    for (const rect of placed) {
      if (left < rect.right && right > rect.left && top < rect.bottom && bottom > rect.top)
        return true;
    }
    return false;
  }

  _hide(info) {
    if (!info) return;
    if (info.displayed) {
      info.el.style.display = 'none';
      info.displayed = false;
    }
  }

  _hideAll() {
    for (const info of this.labels.values()) this._hide(info);
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (!visible) this._hideAll();
    if (this.layer) this.layer.style.opacity = visible && this.enabled ? '1' : '0';
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this._hideAll();
  }

  refresh() {
    this._lastRectSignature = '';
    this._syncRect();
  }

  dispose() {
    if (this.layer) {
      this.layer.remove();
      this.layer = null;
    }
    this.labels.clear();
    this._mounted = false;
  }
}

export default { ResourceLabelLayer };
