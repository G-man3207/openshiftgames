import { minimapSize, isClusterScopedKind } from '../data/kindRegistry.js';

/**
 * Minimap overlay for the OpenShift cluster view.
 *
 * Kind dot sizes come from the central registry (`minimapSize(kind)`), so every
 * OpenShift kind (Project, Route, BuildConfig, SCC, User, ...) is represented
 * without a hard-coded kind list. Colours follow the project (Namespace-replacement)
 * colour palette, with OpenShift red for cluster-scoped resources.
 */

const OPENSHIFT_RED = '#ee0000';
const OPENSHIFT_ORANGE = '#f97316';

const PROJECT_COLORS = {
  default: '#ee0000',
  openshift: '#f97316',
  'openshift-config': '#d29922',
  'openshift-operators': '#a371f7',
  'openshift-ingress': '#39c5cf',
  'openshift-monitoring': '#3fb950',
  'openshift-console': '#2f81f7',
  'openshift-authentication': '#db6d28',
  'openshift-image-registry': '#8957e5',
  'openshift-marketplace': '#b08800',
  'metallb-system': '#5a32a3',
  'kube-system': '#39c5cf',
};

const FALLBACK_PROJECT_COLORS = [
  '#60a5fa', '#34d399', '#a78bfa', '#fbbf24', '#f87171',
  '#fb923c', '#2f81f7', '#3fb950', '#d2a8ff', '#39c5cf',
];

const MINIMAP_WIDTH = 180;
const MINIMAP_HEIGHT = 118;

export class Minimap {
  constructor() {
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.visible = true;
    this.viewport = { x: 0, y: 0, w: 1, h: 1 };
    this.resourcePositions = new Map();
    this.incidentResources = new Set();
    this.pulsePhase = 0;
    this._animFrameId = null;
    this._boundTick = this._onTick.bind(this);
    this._boundIncident = this._onIncident.bind(this);
    this._boundResolve = this._onIncidentResolved.bind(this);
    this._boundViewport = this._onViewportChange.bind(this);
    this._dragging = false;
  }

  init() {
    this.container = document.createElement('div');
    this.container.id = 'minimap';
    this.container.className = 'fixed bottom-4 right-4 z-20';
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', 'Cluster map');
    this.container.innerHTML = this._buildHTML();
    document.body.appendChild(this.container);

    this.canvas = document.getElementById('minimap-canvas');
    this.ctx = this.canvas.getContext('2d');
    this._setupCanvas();
    this._bindEvents();
    this._startAnimation();
  }

  _buildHTML() {
    return `
      <div class="backdrop-blur-xl bg-white/5 border border-white/10 rounded-lg overflow-hidden shadow-xl" style="width: ${MINIMAP_WIDTH}px; height: 140px;">
        <div class="flex items-center justify-between px-2 py-1 border-b border-white/5">
          <span class="text-white/30 text-[10px] font-mono">Cluster Map</span>
          <button id="minimap-toggle" class="text-white/20 hover:text-white/40 text-[10px] transition-colors" type="button" aria-label="Collapse cluster map" aria-expanded="true">-</button>
        </div>
        <canvas id="minimap-canvas" style="width: ${MINIMAP_WIDTH}px; height: ${MINIMAP_HEIGHT}px;"></canvas>
      </div>
    `;
  }

  _setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = MINIMAP_WIDTH * dpr;
    this.canvas.height = MINIMAP_HEIGHT * dpr;
    this.ctx.scale(dpr, dpr);
  }

  _bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this._onMouseUp());
    this.canvas.addEventListener('mouseleave', () => this._onMouseUp());

    document.getElementById('minimap-toggle').addEventListener('click', () => {
      const body = this.canvas;
      if (body.style.display === 'none') {
        body.style.display = '';
        this.container.querySelector('div').style.height = '';
        document.getElementById('minimap-toggle').textContent = '-';
        document.getElementById('minimap-toggle').setAttribute('aria-label', 'Collapse cluster map');
        document.getElementById('minimap-toggle').setAttribute('aria-expanded', 'true');
      } else {
        body.style.display = 'none';
        document.getElementById('minimap-toggle').textContent = '+';
        document.getElementById('minimap-toggle').setAttribute('aria-label', 'Expand cluster map');
        document.getElementById('minimap-toggle').setAttribute('aria-expanded', 'false');
      }
    });

    const engine = window.game?.engine;
    if (engine) {
      engine.on('tick', this._boundTick);
      engine.on('incident:created', this._boundIncident);
      engine.on('incident:resolved', this._boundResolve);
      engine.on('viewport:change', this._boundViewport);
    }
  }

  _onMouseDown(e) {
    this._dragging = true;
    this._navigateTo(e);
  }

  _onMouseMove(e) {
    if (this._dragging) this._navigateTo(e);
  }

  _onMouseUp() {
    this._dragging = false;
  }

  _navigateTo(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    window.game?.engine.emit('minimap:navigate', { x, y });
    window.game?.renderer?.focusResource?.(null, x, y);
  }

  _onTick() {
    this._updatePositions();
  }

  _onIncident(data) {
    if (data.uid) this.incidentResources.add(data.uid);
  }

  _onIncidentResolved(data) {
    if (data.uid) this.incidentResources.delete(data.uid);
  }

  _onViewportChange(data) {
    this.viewport = { x: data.x ?? 0, y: data.y ?? 0, w: data.w ?? 1, h: data.h ?? 1 };
  }

  _updatePositions() {
    const cluster = window.game?.cluster;
    if (!cluster) return;

    const all = cluster.getAllResources?.() || [];
    this.resourcePositions.clear();

    for (const r of all) {
      const uid = r.metadata?.uid || r.uid;
      if (!uid) continue;

      const kind = r.kind;
      const namespace = r.metadata?.namespace || '';
      const phase = r.status?.phase || 'Active';

      const position = r._position || null;
      if (position) {
        this.resourcePositions.set(uid, { x: position.x, y: position.y, kind, namespace, status: phase });
      } else {
        const hash = this._hashString(uid);
        this.resourcePositions.set(uid, {
          x: (hash % 1000) / 1000,
          y: ((hash >> 10) % 1000) / 1000,
          kind,
          namespace,
          status: phase,
        });
      }
    }
  }

  _startAnimation() {
    const animate = () => {
      this.pulsePhase += 0.05;
      this._draw();
      this._animFrameId = requestAnimationFrame(animate);
    };
    this._animFrameId = requestAnimationFrame(animate);
  }

  _colorForResource(pos) {
    if (!pos.namespace || isClusterScopedKind(pos.kind)) {
      // Cluster-scoped resources (Project, Node, SCC, operators, ...) use brand red.
      if (pos.kind === 'Node' || pos.kind === 'Project') return OPENSHIFT_RED;
      return OPENSHIFT_ORANGE;
    }
    if (PROJECT_COLORS[pos.namespace]) return PROJECT_COLORS[pos.namespace];
    const hash = this._hashString(pos.namespace);
    return FALLBACK_PROJECT_COLORS[hash % FALLBACK_PROJECT_COLORS.length];
  }

  _draw() {
    const w = MINIMAP_WIDTH;
    const h = MINIMAP_HEIGHT;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(0, 0, w, h);

    const padding = 8;
    const drawW = w - padding * 2;
    const drawH = h - padding * 2;

    for (const [uid, pos] of this.resourcePositions) {
      const x = padding + pos.x * drawW;
      const y = padding + pos.y * drawH;
      const size = Math.max(1.5, Math.min(minimapSize(pos.kind), 20));

      const isIncident = this.incidentResources.has(uid);

      if (isIncident) {
        const pulse = Math.sin(this.pulsePhase * 3) * 0.5 + 0.5;
        const pulseRadius = size + 3 + pulse * 4;
        ctx.beginPath();
        ctx.arc(x, y, pulseRadius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(248, 113, 113, ${0.15 + pulse * 0.15})`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);

      if (pos.status === 'Failed' || pos.status === 'CrashLoopBackOff' || pos.status === 'Degraded') {
        ctx.fillStyle = '#f87171';
      } else if (pos.status === 'Pending' || pos.status === 'Progressing' || pos.status === 'Installing') {
        ctx.fillStyle = '#fbbf24';
      } else {
        ctx.fillStyle = this._colorForResource(pos);
      }

      ctx.globalAlpha = isIncident ? 1 : 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = 'rgba(238, 0, 0, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(
      padding + this.viewport.x * drawW,
      padding + this.viewport.y * drawH,
      this.viewport.w * drawW,
      this.viewport.h * drawH,
    );
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(238, 0, 0, 0.05)';
    ctx.fillRect(
      padding + this.viewport.x * drawW,
      padding + this.viewport.y * drawH,
      this.viewport.w * drawW,
      this.viewport.h * drawH,
    );
  }

  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }

  show() {
    this.visible = true;
    this.container?.classList.remove('hidden');
  }

  hide() {
    this.visible = false;
    this.container?.classList.add('hidden');
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  destroy() {
    const engine = window.game?.engine;
    if (engine) {
      engine.off?.('tick', this._boundTick);
      engine.off?.('incident:created', this._boundIncident);
      engine.off?.('incident:resolved', this._boundResolve);
      engine.off?.('viewport:change', this._boundViewport);
    }
    if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
    this.container?.remove();
  }
}
