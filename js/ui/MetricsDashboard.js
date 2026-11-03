/**
 * MetricsDashboard — "OpenShift metrics" panel (M key / `oc adm top`).
 *
 * Shows the OpenShift operations view for the simulated 4.22 cluster:
 *   - cluster CPU / memory percentages and the `oc adm top pods|nodes` tables
 *   - Routes admitted and Builds running
 *   - ResourceQuota / ClusterResourceQuota usage
 *   - ClusterOperator health and ClusterVersion
 *
 * Structural ids kept from the previous dashboard: `metrics-dashboard`
 * (outer, removed by index.html's returnToMenu), `metrics-close`,
 * `metrics-scope`, `metrics-canvas-*`, `metrics-cpu-val`, etc. The visible
 * panel itself is `#metrics-panel`.
 *
 * The M shortcut is handled by index.html while the game shell is running. A
 * standalone dashboard (tests, embeds) binds its own M handler; this avoids
 * the historical double-toggle where both listeners fired.
 *
 * Browser-only DOM work happens after init(); the module is Node-import safe.
 */

import { parseCpuMillis, parseMemoryMi } from '../engine/ClusterState.js';

const WINDOW_SIZE = 60;

const CHART_COLORS = {
  cpu: { line: '#60a5fa', fill: 'rgba(96, 165, 250, 0.10)' },
  memory: { line: '#c084fc', fill: 'rgba(192, 132, 252, 0.10)' },
  network: { line: '#34d399', fill: 'rgba(52, 211, 153, 0.10)' },
  pods: { line: '#fbbf24', fill: 'rgba(251, 191, 36, 0.10)' },
};

function hashText(text) {
  let hash = 0;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function formatCpu(millis) {
  const value = Number(millis) || 0;
  if (value >= 1000) {
    const cores = value / 1000;
    return Number.isInteger(cores) ? String(cores) : cores.toFixed(2);
  }
  return `${Math.round(value)}m`;
}

function formatMemory(mebibytes) {
  const value = Number(mebibytes) || 0;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}Gi`;
  return `${Math.round(value)}Mi`;
}

export class MetricsDashboard {
  constructor() {
    this.container = null;
    this.visible = false;
    this.canvases = {};
    this.contexts = {};
    this.data = { cpu: [], memory: [], network: [], pods: [] };
    this.selectedResource = null;
    this._lastStats = null;
    this._htmlCache = {};
    this._engineRef = null;
    this._engineAttached = false;

    this._boundKeydown = this._onKeydown.bind(this);
    this._boundTick = this._onTick.bind(this);
    this._boundSelect = this._onResourceSelect.bind(this);
    this._boundDeselect = this._onResourceDeselect.bind(this);
    this._boundResize = this._onResize.bind(this);
    this._boundClose = this._onClose.bind(this);
    this._boundStopped = this._onEngineStopped.bind(this);
    this._ownsMKey = false;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  init() {
    if (this.container) this.destroy();

    this._ownsMKey = !window.game?.app;
    this.container = document.createElement('div');
    this.container.id = 'metrics-dashboard';
    this.container.className = 'fixed bottom-0 left-0 right-0 z-30 transform translate-y-full transition-transform duration-300 ease-out';
    this.container.setAttribute('data-testid', 'metrics-dashboard');
    this.container.innerHTML = this._buildHTML();
    document.body.appendChild(this.container);

    this._initCanvases();
    this._bindEvents();
    this._bindGameEvents();
    this._renderAll();
  }

  show() {
    if (!this.container) return;
    this.visible = true;
    this.container.classList.remove('translate-y-full');
    this.container.classList.add('translate-y-0');
    // Render synchronously so the panel is never shown with stale/empty tables
    // (the cluster may have been seeded after init()), then resize + redraw on
    // the next frame once the transform has settled.
    this._resizeCanvases();
    this._renderAll();
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        this._resizeCanvases();
        this._draw();
      });
    }
  }

  hide() {
    if (!this.container) return;
    this.visible = false;
    this.container.classList.remove('translate-y-0');
    this.container.classList.add('translate-y-full');
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  destroy() {
    this._unbindGameEvents();
    document.removeEventListener('keydown', this._boundKeydown);
    window.removeEventListener('resize', this._boundResize);
    this.container?.querySelector('#metrics-close')?.removeEventListener('click', this._boundClose);
    this.container?.remove();
    this.container = null;
    this.canvases = {};
    this.contexts = {};
    this.visible = false;
    this._htmlCache = {};
  }

  _onEngineStopped() {
    this.destroy();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  _bus() {
    return window.game?.engine || window.game?.app?.engine?.eventBus || null;
  }

  _cluster() {
    return window.game?.cluster || window.game?.app?.engine?.cluster || null;
  }

  _list(kind) {
    try {
      const cluster = this._cluster();
      const resources = cluster?.getResourcesByKind?.(kind) || cluster?.getByKind?.(kind) || [];
      return Array.isArray(resources) ? resources : [];
    } catch {
      return [];
    }
  }

  _stats() {
    try {
      const stats = this._cluster()?.getClusterStats?.();
      return stats && typeof stats === 'object' ? stats : null;
    } catch {
      return null;
    }
  }

  _setText(id, value) {
    const element = this._query(`#${id}`);
    if (element) element.textContent = String(value);
  }

  _setHTML(id, html) {
    const element = this._query(`#${id}`);
    if (!element) return;
    if (this._htmlCache[id] === html) return;
    element.innerHTML = html;
    this._htmlCache[id] = html;
  }

  _query(selector) {
    return this.container?.querySelector(selector) || null;
  }

  _escapeHTML(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
  }

  // ─── Markup ────────────────────────────────────────────────────────────

  _buildHTML() {
    return `
      <div id="metrics-panel" data-testid="metrics-panel" class="backdrop-blur-xl bg-white/5 border-t border-white/10 shadow-2xl" style="height: 430px;">
        <div class="flex items-center justify-between px-4 py-2 border-b border-white/5" style="height: 42px;">
          <div class="flex items-center gap-3">
            <span class="text-white/60 text-xs font-semibold uppercase tracking-wider">OpenShift metrics</span>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold text-openshift bg-openshift/10 border border-openshift/30">oc adm top</span>
            <span id="metrics-scope" class="text-white/20 text-xs" data-testid="metrics-scope">Cluster-wide</span>
            <span id="metrics-cluster-version" class="text-white/20 text-[10px] font-mono" data-testid="metrics-cluster-version">OpenShift 4.22</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-white/20 text-xs">Press M to toggle</span>
            <button id="metrics-close" class="p-1 text-white/30 hover:text-white/60 transition-colors" aria-label="Close metrics" data-testid="metrics-close">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="px-3 pb-2 flex flex-col gap-2" style="height: calc(100% - 42px); min-height: 0;">
          <div class="grid grid-cols-5 gap-2 shrink-0 pt-2">
            ${this._summaryCard('Cluster CPU', 'metrics-cluster-cpu', 'text-blue-400', 'Average node CPU usage')}
            ${this._summaryCard('Cluster Memory', 'metrics-cluster-mem', 'text-purple-400', 'Average node memory usage')}
            ${this._summaryCard('Routes admitted', 'metrics-routes-admitted', 'text-emerald-400', 'Admitted / total Routes')}
            ${this._summaryCard('Builds running', 'metrics-builds-running', 'text-orange-400', 'Builds in New/Pending/Running')}
            ${this._summaryCard('ClusterOperators', 'metrics-operator-health', 'text-sky-400', 'Available / total')}
          </div>

          <div class="grid grid-cols-4 gap-2 shrink-0" style="height: 108px;">
            ${this._chartBox('cpu', 'CPU %', 'metrics-cpu-val', CHART_COLORS.cpu.line)}
            ${this._chartBox('memory', 'Memory %', 'metrics-mem-val', CHART_COLORS.memory.line)}
            ${this._chartBox('network', 'Network KB/s', 'metrics-net-val', CHART_COLORS.network.line)}
            ${this._chartBox('pods', 'Pod Count', 'metrics-pods-val', CHART_COLORS.pods.line)}
          </div>

          <div class="grid grid-cols-12 gap-3 flex-1 min-h-0">
            <div class="col-span-5 min-h-0 flex flex-col">
              <div class="flex items-center justify-between text-[10px] uppercase tracking-wider text-white/30 mb-1 shrink-0">
                <span>oc adm top pods</span><span class="text-white/20 normal-case tracking-normal">CPU(cores) · MEMORY(bytes)</span>
              </div>
              <div id="metrics-pods" data-testid="metrics-pods" class="flex-1 min-h-0 overflow-auto rounded-lg bg-black/20 border border-white/5 p-1"></div>
            </div>
            <div class="col-span-4 min-h-0 flex flex-col">
              <div class="flex items-center justify-between text-[10px] uppercase tracking-wider text-white/30 mb-1 shrink-0">
                <span>oc adm top nodes</span><span class="text-white/20 normal-case tracking-normal">CPU / MEMORY</span>
              </div>
              <div id="metrics-nodes" data-testid="metrics-nodes" class="flex-1 min-h-0 overflow-auto rounded-lg bg-black/20 border border-white/5 p-1"></div>
            </div>
            <div class="col-span-3 min-h-0 flex flex-col gap-2">
              <div class="min-h-0 flex-1 flex flex-col">
                <div class="text-[10px] uppercase tracking-wider text-white/30 mb-1 shrink-0">Quota usage</div>
                <div id="metrics-quota" data-testid="metrics-quota" class="flex-1 min-h-0 overflow-auto rounded-lg bg-black/20 border border-white/5 p-1"></div>
              </div>
              <div class="min-h-0 flex-1 flex flex-col">
                <div class="text-[10px] uppercase tracking-wider text-white/30 mb-1 shrink-0">ClusterOperator health</div>
                <div id="metrics-operators" data-testid="metrics-operators" class="flex-1 min-h-0 overflow-auto rounded-lg bg-black/20 border border-white/5 p-1"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  _summaryCard(label, id, colorClass, title) {
    return `<div class="rounded-lg bg-black/20 border border-white/5 px-2 py-1.5" title="${this._escapeHTML(title)}">
      <div class="text-[9px] uppercase tracking-wider text-white/30">${this._escapeHTML(label)}</div>
      <div id="${id}" class="text-sm font-mono font-semibold ${colorClass}" data-testid="${id}">0</div>
    </div>`;
  }

  _chartBox(key, label, valueId, color) {
    return `<div class="relative rounded-lg bg-white/5 border border-white/5 overflow-hidden">
      <div class="absolute top-0 left-0 text-[9px] text-white/30 z-10 px-1">${this._escapeHTML(label)}</div>
      <div class="absolute top-0 right-0 text-[10px] font-mono z-10 px-1" id="${valueId}" style="color: ${color}">0</div>
      <canvas id="metrics-canvas-${key}" class="w-full h-full"></canvas>
    </div>`;
  }

  _initCanvases() {
    this.canvases = {};
    this.contexts = {};
    for (const key of ['cpu', 'memory', 'network', 'pods']) {
      const canvas = this._query(`#metrics-canvas-${key}`);
      if (!canvas) continue;
      this.canvases[key] = canvas;
      try {
        this.contexts[key] = canvas.getContext('2d');
      } catch {
        this.contexts[key] = null;
      }
    }
    this._resizeCanvases();
  }

  _resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    for (const [key, canvas] of Object.entries(this.canvases)) {
      if (!canvas || !this.contexts[key]) continue;
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.width = width;
      canvas.height = height;
      this.contexts[key].setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // ─── Wiring ────────────────────────────────────────────────────────────

  _bindEvents() {
    this._query('#metrics-close')?.addEventListener('click', this._boundClose);
    window.addEventListener('resize', this._boundResize);
    if (this._ownsMKey) document.addEventListener('keydown', this._boundKeydown);
  }

  _bindGameEvents() {
    const bus = this._bus();
    if (!bus || this._engineAttached) return;
    this._engineRef = bus;
    this._engineAttached = true;
    bus.on('tick', this._boundTick);
    bus.on('resource:selected', this._boundSelect);
    bus.on('resource:deselected', this._boundDeselect);
    bus.on('engine:stopped', this._boundStopped);
  }

  _unbindGameEvents() {
    const bus = this._engineRef;
    if (bus) {
      bus.off?.('tick', this._boundTick);
      bus.off?.('resource:selected', this._boundSelect);
      bus.off?.('resource:deselected', this._boundDeselect);
      bus.off?.('engine:stopped', this._boundStopped);
    }
    this._engineRef = null;
    this._engineAttached = false;
  }

  _onClose() {
    this.hide();
  }

  _onKeydown(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== 'm' && event.key !== 'M') return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    this.toggle();
  }

  _onResize() {
    if (!this.visible) return;
    this._resizeCanvases();
    this._draw();
  }

  _onResourceDeselect() {
    this.selectedResource = null;
    this._setText('metrics-scope', 'Cluster-wide');
  }

  _onResourceSelect(data) {
    let resource = data?.resource || null;
    if (!resource && data?.uid) {
      try {
        resource = this._cluster()?.getResource?.(data.uid) || null;
      } catch {
        resource = null;
      }
    }
    this.selectedResource = resource;
    this._setText('metrics-scope', resource ? `Resource: ${resource.metadata?.name || 'Unknown'}` : 'Cluster-wide');
  }

  // ─── Tick / data ───────────────────────────────────────────────────────

  _onTick(state) {
    try {
      this._ingest(state || {});
    } catch {
      /* never let a metrics render break the simulation loop */
    }
  }

  _ingest(state) {
    const stats = this._stats();
    this._lastStats = stats;
    const pods = this._list('Pod');
    const runningPods = pods.filter((pod) => pod.status?.phase === 'Running').length;

    const cpu = Number(stats?.cpu?.percent ?? state?.metrics?.cpu ?? 0) || 0;
    const memory = Number(stats?.memory?.percent ?? state?.metrics?.memory ?? 0) || 0;
    const podCount = Number(stats?.pods?.total ?? pods.length) || 0;
    const network = runningPods * (2 + Math.sin(this.data.network.length * 0.1) * 1.5);

    if (this.selectedResource) {
      const resource = this.selectedResource;
      this.data.cpu.push(this._clampPercent(resource.status?.usage?.cpuPercent ?? resource.cpuUsage ?? cpu * (0.3 + Math.random() * 0.4)));
      this.data.memory.push(this._clampPercent(resource.status?.usage?.memoryPercent ?? resource.memoryUsage ?? memory * (0.3 + Math.random() * 0.4)));
      this.data.network.push(Math.max(0, network * (0.1 + Math.random() * 0.3)));
      this.data.pods.push(podCount);
    } else {
      this.data.cpu.push(this._clampPercent(cpu));
      this.data.memory.push(this._clampPercent(memory));
      this.data.network.push(network);
      this.data.pods.push(podCount);
    }

    for (const key of Object.keys(this.data)) {
      while (this.data[key].length > WINDOW_SIZE) this.data[key].shift();
    }

    this._updateChartLabels();
    this._updateSummary(stats, pods);
    if (this.visible) {
      this._renderTables(stats, pods);
      this._draw();
    }
  }

  _clampPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, numeric));
  }

  _updateChartLabels() {
    const last = (key) => {
      const numeric = Number(this.data[key][this.data[key].length - 1]);
      return Number.isFinite(numeric) ? numeric : 0;
    };
    this._setText('metrics-cpu-val', `${Math.round(last('cpu'))}%`);
    this._setText('metrics-mem-val', `${Math.round(last('memory'))}%`);
    this._setText('metrics-net-val', `${Math.round(last('network'))}`);
    this._setText('metrics-pods-val', `${Math.round(last('pods'))}`);
  }

  _updateSummary(stats, pods) {
    const cpu = Number(stats?.cpu?.percent ?? this.data.cpu[this.data.cpu.length - 1] ?? 0) || 0;
    const memory = Number(stats?.memory?.percent ?? this.data.memory[this.data.memory.length - 1] ?? 0) || 0;
    const routes = stats?.routes || { total: this._list('Route').length, admitted: 0 };
    const builds = stats?.builds || { running: this._list('Build').filter((build) => ['New', 'Pending', 'Running'].includes(build.status?.phase)).length };
    const operators = stats?.clusterOperators || this._operatorHealth();

    this._setText('metrics-cluster-cpu', `${Math.round(cpu)}%`);
    this._setText('metrics-cluster-mem', `${Math.round(memory)}%`);
    this._setText('metrics-routes-admitted', `${routes.admitted ?? 0}/${routes.total ?? 0}`);
    this._setText('metrics-builds-running', String(builds.running ?? 0));
    this._setText('metrics-operator-health', `${operators.available ?? 0}/${operators.total ?? 0}`);

    const version = this._clusterVersion();
    if (version) this._setText('metrics-cluster-version', `OpenShift ${version}`);
  }

  _clusterVersion() {
    const versions = this._list('ClusterVersion');
    const resource = versions[0];
    return resource?.status?.desired?.version || resource?.spec?.desired?.version || '';
  }

  _operatorHealth() {
    const operators = this._list('ClusterOperator');
    let available = 0;
    let degraded = 0;
    for (const operator of operators) {
      const conditions = operator.status?.conditions || [];
      const isAvailable = typeof operator.isConditionTrue === 'function'
        ? operator.isConditionTrue('Available')
        : conditions.some((condition) => condition.type === 'Available' && condition.status === 'True');
      const isDegraded = typeof operator.isConditionTrue === 'function'
        ? operator.isConditionTrue('Degraded')
        : conditions.some((condition) => condition.type === 'Degraded' && condition.status === 'True');
      if (isAvailable) available += 1;
      if (isDegraded) degraded += 1;
    }
    return { total: operators.length, available, degraded };
  }

  // ─── Tables ────────────────────────────────────────────────────────────

  _renderAll() {
    try {
      const stats = this._stats();
      this._lastStats = stats;
      const pods = this._list('Pod');
      this._updateSummary(stats, pods);
      this._renderTables(stats, pods);
      this._draw();
    } catch {
      this._setHTML('metrics-pods', '<div class="text-white/25 text-[10px] p-2">Metrics unavailable.</div>');
    }
  }

  _renderTables(stats, podsInput) {
    const cluster = this._cluster();
    if (!cluster) {
      const empty = '<div class="text-white/25 text-[10px] p-2">Start a game mode to see OpenShift metrics.</div>';
      this._setHTML('metrics-pods', empty);
      this._setHTML('metrics-nodes', empty);
      this._setHTML('metrics-quota', empty);
      this._setHTML('metrics-operators', empty);
      return;
    }

    const pods = Array.isArray(podsInput) ? podsInput : this._list('Pod');
    this._setHTML('metrics-pods', this._podsTable(pods));
    this._setHTML('metrics-nodes', this._nodesTable());
    this._setHTML('metrics-quota', this._quotaTable());
    this._setHTML('metrics-operators', this._operatorsTable(stats));
  }

  _podsTable(pods) {
    if (!pods.length) return '<div class="text-white/25 text-[10px] p-2">No Pods in the cluster.</div>';
    const rows = pods.map((pod) => {
      const usage = this._podUsage(pod);
      return { pod, ...usage };
    }).sort((left, right) => right.cpu - left.cpu || right.memory - left.memory).slice(0, 20);

    return `<table class="w-full text-[10px] font-mono" data-testid="metrics-pods-table">
      <thead class="text-white/25"><tr>
        <th class="text-left px-1 py-0.5 font-normal">NAME</th>
        <th class="text-left px-1 py-0.5 font-normal">PROJECT</th>
        <th class="text-right px-1 py-0.5 font-normal">CPU</th>
        <th class="text-right px-1 py-0.5 font-normal">MEMORY</th>
      </tr></thead>
      <tbody>${rows.map(({ pod, cpu, memory }) => `<tr class="border-t border-white/5">
        <td class="px-1 py-0.5 text-white/70 truncate max-w-[110px]" title="${this._escapeHTML(pod.metadata?.name)}">${this._escapeHTML(pod.metadata?.name)}</td>
        <td class="px-1 py-0.5 text-white/35 truncate max-w-[80px]" title="${this._escapeHTML(pod.metadata?.namespace)}">${this._escapeHTML(pod.metadata?.namespace || '—')}</td>
        <td class="px-1 py-0.5 text-right text-blue-300">${this._escapeHTML(formatCpu(cpu))}</td>
        <td class="px-1 py-0.5 text-right text-purple-300">${this._escapeHTML(formatMemory(memory))}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  _podUsage(pod) {
    const running = pod.status?.phase === 'Running';
    let cpu = 0;
    let memory = 0;
    for (const container of pod.spec?.containers || []) {
      cpu += parseCpuMillis(container.resources?.requests?.cpu ?? container.resources?.limits?.cpu ?? 0);
      memory += parseMemoryMi(container.resources?.requests?.memory ?? container.resources?.limits?.memory ?? 0);
    }
    cpu += parseCpuMillis(pod.status?.usage?.cpu ?? 0);
    memory += parseMemoryMi(pod.status?.usage?.memory ?? 0);

    // Bare pods created from the palette have no requests; show a stable,
    // simulated usage number so `oc adm top pods` is still informative.
    if (running && cpu === 0) cpu = 5 + (hashText(pod.metadata?.uid || pod.metadata?.name) % 45);
    if (running && memory === 0) memory = 32 + (hashText(pod.metadata?.name || '') % 128);
    if (!running) return { cpu: Math.max(0, Math.round(cpu)), memory: Math.max(0, Math.round(memory)) };
    return { cpu: Math.round(cpu), memory: Math.round(memory) };
  }

  _nodeAllocatable(node) {
    try {
      return this._cluster()?.getNodeAllocatable?.(node.metadata?.name) || null;
    } catch {
      return null;
    }
  }

  _nodesTable() {
    const nodes = this._list('Node');
    if (!nodes.length) return '<div class="text-white/25 text-[10px] p-2">No Nodes registered.</div>';
    const rows = nodes.map((node) => {
      const alloc = this._nodeAllocatable(node);
      const cpuUsed = Number(alloc?.cpu?.used ?? node.status?.usage?.cpu ?? 0) || 0;
      const cpuCapacity = Number(alloc?.cpu?.capacity ?? parseCpuMillis(node.spec?.cpu || node.status?.capacity?.cpu || '4')) || 0;
      const memUsed = Number(alloc?.memory?.used ?? node.status?.usage?.memory ?? 0) || 0;
      const memCapacity = Number(alloc?.memory?.capacity ?? parseMemoryMi(node.spec?.memory || node.status?.capacity?.memory || '8Gi')) || 0;
      const cpuPercent = cpuCapacity > 0 ? Math.round((cpuUsed / cpuCapacity) * 100) : 0;
      const memPercent = memCapacity > 0 ? Math.round((memUsed / memCapacity) * 100) : 0;
      const ready = typeof node.isConditionTrue === 'function'
        ? node.isConditionTrue('Ready')
        : (node.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
      return { node, cpuUsed, cpuPercent, memUsed, memPercent, ready };
    }).sort((left, right) => String(left.node.metadata?.name).localeCompare(String(right.node.metadata?.name)));

    return `<table class="w-full text-[10px] font-mono" data-testid="metrics-nodes-table">
      <thead class="text-white/25"><tr>
        <th class="text-left px-1 py-0.5 font-normal">NAME</th>
        <th class="text-right px-1 py-0.5 font-normal">CPU</th>
        <th class="text-right px-1 py-0.5 font-normal">CPU%</th>
        <th class="text-right px-1 py-0.5 font-normal">MEM</th>
        <th class="text-right px-1 py-0.5 font-normal">MEM%</th>
      </tr></thead>
      <tbody>${rows.map(({ node, cpuUsed, cpuPercent, memUsed, memPercent, ready }) => `<tr class="border-t border-white/5">
        <td class="px-1 py-0.5 text-white/70 truncate max-w-[110px]" title="${this._escapeHTML(node.metadata?.name)}">
          <span class="inline-block w-1.5 h-1.5 rounded-full ${ready ? 'bg-green-400' : 'bg-red-400'} mr-1"></span>${this._escapeHTML(node.metadata?.name)}
        </td>
        <td class="px-1 py-0.5 text-right text-blue-300">${this._escapeHTML(formatCpu(cpuUsed))}</td>
        <td class="px-1 py-0.5 text-right ${cpuPercent > 80 ? 'text-red-400' : 'text-white/50'}">${cpuPercent}%</td>
        <td class="px-1 py-0.5 text-right text-purple-300">${this._escapeHTML(formatMemory(memUsed))}</td>
        <td class="px-1 py-0.5 text-right ${memPercent > 80 ? 'text-red-400' : 'text-white/50'}">${memPercent}%</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  _quotaTable() {
    const quotas = this._list('ResourceQuota');
    const clusterQuotas = this._list('ClusterResourceQuota');
    if (!quotas.length && !clusterQuotas.length) {
      return '<div class="text-white/25 text-[10px] p-2">No ResourceQuota or ClusterResourceQuota configured.</div>';
    }
    const rows = [];
    for (const quota of quotas) {
      const hard = quota.spec?.hard || {};
      const used = quota.status?.used || {};
      const keys = Object.keys(hard).slice(0, 2);
      const detail = keys.map((key) => `${key} ${used[key] ?? 0}/${hard[key]}`).join(' · ') || 'no hard limits';
      const percent = this._quotaPercent(hard, used);
      rows.push(`<div class="px-1 py-0.5 border-b border-white/5 last:border-0">
        <div class="flex items-center justify-between gap-1">
          <span class="text-white/60 truncate" title="${this._escapeHTML(`${quota.metadata?.namespace}/${quota.metadata?.name}`)}">${this._escapeHTML(quota.metadata?.namespace || '')}/${this._escapeHTML(quota.metadata?.name)}</span>
          <span class="${percent >= 100 ? 'text-red-400' : percent >= 80 ? 'text-yellow-400' : 'text-white/30'}">${Math.round(percent)}%</span>
        </div>
        <div class="text-white/25 truncate">${this._escapeHTML(detail)}</div>
      </div>`);
    }
    for (const quota of clusterQuotas) {
      const hard = quota.spec?.quota?.hard || quota.spec?.hard || {};
      const used = quota.status?.total?.used || quota.status?.used || {};
      const keys = Object.keys(hard).slice(0, 2);
      rows.push(`<div class="px-1 py-0.5 border-b border-white/5 last:border-0">
        <div class="flex items-center justify-between gap-1">
          <span class="text-white/60 truncate" title="${this._escapeHTML(`clusterquota/${quota.metadata?.name}`)}">clusterquota/${this._escapeHTML(quota.metadata?.name)}</span>
          <span class="text-white/30">${Object.keys(hard).length} keys</span>
        </div>
        <div class="text-white/25 truncate">${this._escapeHTML(keys.map((key) => `${key} ${used[key] ?? 0}/${hard[key]}`).join(' · ') || 'no hard limits')}</div>
      </div>`);
    }
    return rows.join('');
  }

  _quotaPercent(hard, used) {
    let worst = 0;
    for (const key of Object.keys(hard || {})) {
      const hardValue = String(hard[key]);
      const usedValue = String(used?.[key] ?? '0');
      let ratio = 0;
      if (/cpu/.test(key)) {
        const hardCpu = parseCpuMillis(hardValue);
        ratio = hardCpu > 0 ? (parseCpuMillis(usedValue) / hardCpu) * 100 : 0;
      } else if (/memory/.test(key)) {
        const hardMemory = parseMemoryMi(hardValue);
        ratio = hardMemory > 0 ? (parseMemoryMi(usedValue) / hardMemory) * 100 : 0;
      } else {
        const hardNumber = Number.parseFloat(hardValue);
        ratio = Number.isFinite(hardNumber) && hardNumber > 0 ? ((Number.parseFloat(usedValue) || 0) / hardNumber) * 100 : 0;
      }
      if (Number.isFinite(ratio)) worst = Math.max(worst, ratio);
    }
    return Math.max(0, worst);
  }

  _operatorsTable(stats) {
    const operators = this._list('ClusterOperator');
    if (!operators.length) return '<div class="text-white/25 text-[10px] p-2">No ClusterOperators reported.</div>';
    const health = stats?.clusterOperators || this._operatorHealth();
    const degraded = operators.filter((operator) => {
      const conditions = operator.status?.conditions || [];
      return conditions.some((condition) => condition.type === 'Degraded' && condition.status === 'True')
        || conditions.some((condition) => condition.type === 'Available' && condition.status === 'False');
    });
    const lines = degraded.slice(0, 4).map((operator) => `<div class="px-1 py-0.5 flex items-center gap-1 border-b border-white/5 last:border-0">
      <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>
      <span class="text-white/60 truncate">${this._escapeHTML(operator.metadata?.name)}</span>
      <span class="text-red-400/80 ml-auto text-[9px]">degraded</span>
    </div>`).join('');
    return `<div class="px-1 py-0.5 text-[10px] ${health.degraded > 0 ? 'text-yellow-400' : 'text-green-400'}">
        ${health.available ?? 0}/${health.total ?? operators.length} Available${health.degraded ? ` · ${health.degraded} degraded` : ' · all healthy'}
      </div>
      ${lines || '<div class="px-1 py-0.5 text-white/25 text-[10px]">All ClusterOperators Available.</div>'}`;
  }

  // ─── Charts ────────────────────────────────────────────────────────────

  _draw() {
    if (!this.visible) return;
    this._drawChart('cpu', this.data.cpu, CHART_COLORS.cpu, '%', 100);
    this._drawChart('memory', this.data.memory, CHART_COLORS.memory, '%', 100);
    this._drawChart('network', this.data.network, CHART_COLORS.network, '', null);
    this._drawChart('pods', this.data.pods, CHART_COLORS.pods, '', null);
    this._updateChartLabels();
  }

  _drawChart(key, data, colors, suffix, fixedMax) {
    const ctx = this.contexts[key];
    const canvas = this.canvases[key];
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    if (width <= 1 || height <= 1) return;

    ctx.clearRect(0, 0, width, height);
    if (!Array.isArray(data) || data.length < 2) return;

    const padding = { top: 18, right: 4, bottom: 4, left: 4 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    if (chartWidth <= 0 || chartHeight <= 0) return;

    let maxValue = fixedMax;
    if (maxValue === null) {
      maxValue = Math.max(...data) * 1.2;
      if (!Number.isFinite(maxValue) || maxValue < 1) maxValue = 1;
      maxValue = this._niceMax(maxValue);
    }

    const gridLines = 4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 0.5;
    for (let index = 1; index < gridLines; index += 1) {
      const y = padding.top + (chartHeight / gridLines) * index;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    const points = data.map((value, index) => {
      const numeric = Number(value);
      const safe = Number.isFinite(numeric) ? numeric : 0;
      return {
        x: padding.left + (index / (WINDOW_SIZE - 1)) * chartWidth,
        y: padding.top + chartHeight - (Math.max(0, Math.min(maxValue, safe)) / maxValue) * chartHeight,
      };
    });

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const controlX = (previous.x + current.x) / 2;
      ctx.bezierCurveTo(controlX, previous.y, controlX, current.y, current.x, current.y);
    }
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const lastPoint = points[points.length - 1];
    ctx.lineTo(lastPoint.x, padding.top + chartHeight);
    ctx.lineTo(points[0].x, padding.top + chartHeight);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartHeight);
    gradient.addColorStop(0, colors.fill);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = colors.line;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _niceMax(value) {
    if (!Number.isFinite(value) || value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const normalized = value / magnitude;
    if (normalized <= 1) return magnitude;
    if (normalized <= 2) return 2 * magnitude;
    if (normalized <= 5) return 5 * magnitude;
    return 10 * magnitude;
  }
}

export default MetricsDashboard;
