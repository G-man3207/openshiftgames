/**
 * IncidentPanel.js — OpenShift incident side panel (EX280 conversion).
 *
 * Responsibilities:
 *  - Render active/resolved incidents with OpenShift categories + severity.
 *  - Show investigation steps (`oc ...` commands), the incident's ocCommands and
 *    a docs link; clicking a step pre-fills the command bar.
 *  - Fuzzy-match commands the player actually runs against investigation steps
 *    (both `oc` and legacy `kubectl` prefixes are stripped) and sync progress
 *    back to IncidentEngine.
 *  - Resolve incidents through their resolutionActions so IncidentEngine can
 *    mutate the cluster back to a healthy state.
 *
 * Kept integration contracts (brand-dev shell / HUD / modes):
 *  - DOM ids: #incident-panel, #incident-list, #incident-count, #incident-close;
 *    `[data-filter]` status tabs; `[data-incident-id]` cards.
 *  - Public API: init(), show(), hide(), toggle(), destroy(),
 *    addIncident(type, severity, resource, message, uid), resolveIncident(id).
 *  - Events consumed: incident:created, incident:resolved, incident:activated,
 *    ui:toggle-incidents, command:raw, command:executed,
 *    incident:count (emitted), xp:gain (emitted for display only).
 *
 * Deliberately dependency-free (no imports except the shared incident data) and
 * defensive: this panel must never break the render loop.
 */

import { INCIDENT_DEFS_BY_NAME, INCIDENT_CATEGORIES, SEVERITY_LEVELS } from '../data/IncidentDefs.js';

const ENGINE_ANNOTATION = 'openshiftgames.io/incident';
const LEGACY_STORAGE_KEY = 'k8sgames_investigation';
const STORAGE_KEY = 'openshiftgames_investigation';

/** Severity number → Tailwind styling (the old code keyed on 'critical'/'warning'/'info' strings → bug G?). */
const SEVERITY_STYLE = {
  1: { icon: '\u2139', border: 'border-green-500/20', bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-400', label: 'Low' },
  2: { icon: '\u26a0', border: 'border-yellow-500/20', bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400', label: 'Medium' },
  3: { icon: '\u26a0', border: 'border-orange-500/25', bg: 'bg-orange-500/10', text: 'text-orange-400', dot: 'bg-orange-400', label: 'High' },
  4: { icon: '\u{1f6a8}', border: 'border-red-500/30', bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400', label: 'Critical' },
  5: { icon: '\u{1f525}', border: 'border-red-600/40', bg: 'bg-red-600/15', text: 'text-red-300', dot: 'bg-red-500', label: 'Emergency' },
};

const CATEGORY_ORDER = ['Pod', 'Network', 'Security', 'Build', 'Cluster', 'Storage', 'Identity'];

/** Tokens replaced in investigation commands: <pod>, <node>, <route>, … */
const TARGET_TOKENS = [
  'pod', 'deployment', 'node', 'service', 'route', 'build', 'buildconfig',
  'imagestream', 'imagestreamtag', 'configmap', 'secret', 'networkpolicy',
  'ingress', 'pvc', 'pv', 'job', 'cronjob', 'hpa', 'quota', 'limitrange',
  'clusterquota', 'subscription', 'user', 'group', 'serviceaccount', 'scc',
];
const NAMESPACE_TOKENS = ['namespace', 'project'];

const normalizeCommand = (value) =>
  String(value || '')
    .trim()
    .replace(/^(?:kubectl|oc)\s+/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

export class IncidentPanel {
  constructor() {
    this.container = null;
    this.visible = false;
    this.incidents = [];
    this.nextId = 1;
    this.statusFilter = 'active';
    this.categoryFilter = 'all';
    this._requiredSteps = 2;
    this._timerInterval = null;
    this._unsubscribers = [];
    this._boundToggle = this._onToggle.bind(this);
    this._boundCreated = this._onNewIncident.bind(this);
    this._boundResolved = this._onIncidentResolved.bind(this);
    this._boundActivated = this._onIncidentActivated.bind(this);
    this._boundCommand = this._onCommandExecuted.bind(this);
    this._recentCommands = [];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  init() {
    this.container = document.createElement('div');
    this.container.id = 'incident-panel';
    this.container.className =
      'panel-side panel-left';
    this.container.innerHTML = this._buildHTML();
    document.body.appendChild(this.container);
    this._bindEvents();
    this._startTimers();
    this._loadInvestigationProgress();
    this._renderList();
  }

  destroy() {
    for (const off of this._unsubscribers) {
      try {
        off();
      } catch (err) {
        /* ignore */
      }
    }
    this._unsubscribers = [];
    if (this._timerInterval) clearInterval(this._timerInterval);
    this._timerInterval = null;
    this.container?.remove();
    this.container = null;
  }

  show() {
    if (!this.container) return;
    this.visible = true;
    this.container.classList.add('is-open');
    this._renderList();
  }

  hide() {
    if (!this.container) return;
    this.visible = false;
    this.container.classList.remove('is-open');
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  // ── HTML scaffold ────────────────────────────────────────────────────────
  _buildHTML() {
    const categoryButtons = CATEGORY_ORDER.map((category) => {
      const meta = INCIDENT_CATEGORIES[category] || { label: category, color: '#94a3b8' };
      return `<button data-category-filter="${category}" title="${this._escapeHTML(meta.label)}"
        class="px-2 py-0.5 rounded-full text-[10px] border border-white/10 text-white/40 hover:text-white/70 hover:border-white/25 transition-colors">${this._escapeHTML(category)}</button>`;
    }).join('');

    return `
      <div class="panel-inner">
        <div class="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
            </svg>
            <span class="text-white/90 text-sm font-semibold">Incidents</span>
            <span id="incident-count" class="text-xs text-white/30 font-mono">0</span>
          </div>
          <button id="incident-close" class="p-1 text-white/30 hover:text-white/60 transition-colors" title="Close incident panel">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="flex border-b border-white/5">
          <button data-filter="active" class="flex-1 px-3 py-2 text-xs text-red-400 border-b-2 border-red-400 font-medium transition-colors">Active</button>
          <button data-filter="resolved" class="flex-1 px-3 py-2 text-xs text-white/40 border-b-2 border-transparent hover:text-white/60 transition-colors">Resolved</button>
          <button data-filter="all" class="flex-1 px-3 py-2 text-xs text-white/40 border-b-2 border-transparent hover:text-white/60 transition-colors">All</button>
        </div>

        <div id="incident-category-filters" class="flex items-center gap-1 px-2 py-1.5 border-b border-white/5 overflow-x-auto scrollbar-thin">
          <button data-category-filter="all" class="px-2 py-0.5 rounded-full text-[10px] border bg-white/10 border-white/25 text-white/80 transition-colors">All</button>
          ${categoryButtons}
        </div>

        <div id="incident-list" class="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
          <div class="text-white/20 text-sm text-center mt-8">No incidents reported</div>
        </div>
      </div>
    `;
  }

  _bindEvents() {
    document.getElementById('incident-close')?.addEventListener('click', () => this.hide());

    this.container?.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => this._setStatusFilter(btn.dataset.filter));
    });
    this.container?.querySelectorAll('[data-category-filter]').forEach((btn) => {
      btn.addEventListener('click', () => this._setCategoryFilter(btn.dataset.categoryFilter));
    });

    const engine = window.game?.engine;
    if (engine && typeof engine.on === 'function') {
      this._unsubscribers.push(engine.on('ui:toggle-incidents', this._boundToggle));
      this._unsubscribers.push(engine.on('incident:created', this._boundCreated));
      this._unsubscribers.push(engine.on('incident:resolved', this._boundResolved));
      this._unsubscribers.push(engine.on('incident:activated', this._boundActivated));
      this._unsubscribers.push(engine.on('command:raw', this._boundCommand));
      this._unsubscribers.push(engine.on('command:executed', this._boundCommand));
    }
  }

  /** One panel timer only (no double-tick): it only refreshes elapsed labels. */
  _startTimers() {
    if (this._timerInterval) clearInterval(this._timerInterval);
    this._timerInterval = setInterval(() => {
      if (this.visible) this._updateTimers();
    }, 1000);
  }

  _onToggle() {
    this.toggle();
  }

  // ── Filters ──────────────────────────────────────────────────────────────
  _setStatusFilter(filter) {
    this.statusFilter = filter || 'active';
    this.container?.querySelectorAll('[data-filter]').forEach((btn) => {
      const active = btn.dataset.filter === this.statusFilter;
      btn.className = active
        ? 'flex-1 px-3 py-2 text-xs text-red-400 border-b-2 border-red-400 font-medium transition-colors'
        : 'flex-1 px-3 py-2 text-xs text-white/40 border-b-2 border-transparent hover:text-white/60 transition-colors';
    });
    this._renderList();
  }

  _setCategoryFilter(category) {
    this.categoryFilter = category || 'all';
    this.container?.querySelectorAll('[data-category-filter]').forEach((btn) => {
      const active = btn.dataset.categoryFilter === this.categoryFilter;
      btn.className = active
        ? 'px-2 py-0.5 rounded-full text-[10px] border bg-white/10 border-white/25 text-white/80 transition-colors'
        : 'px-2 py-0.5 rounded-full text-[10px] border border-white/10 text-white/40 hover:text-white/70 hover:border-white/25 transition-colors';
    });
    this._renderList();
  }

  _emptyMessage() {
    if (this.statusFilter === 'active') return 'No active incidents';
    if (this.statusFilter === 'resolved') return 'No resolved incidents';
    return 'No incidents recorded';
  }

  _getFilteredIncidents() {
    return this.incidents.filter((incident) => {
      if (this.statusFilter === 'active' && incident.status !== 'active') return false;
      if (this.statusFilter === 'resolved' && incident.status !== 'resolved') return false;
      if (this.categoryFilter !== 'all' && incident.category !== this.categoryFilter) return false;
      return true;
    });
  }

  _getActiveCount() {
    return this.incidents.filter((incident) => incident.status === 'active').length;
  }

  // ── Incident ingestion ───────────────────────────────────────────────────
  _formatStepCommand(command, incident) {
    const target = incident.target || 'unknown';
    const namespace =
      incident.namespace ||
      window.game?.gameEngine?.currentProject ||
      window.game?.cluster?.currentProject ||
      'default';
    return String(command || '')
      .replace(new RegExp(`<(${TARGET_TOKENS.join('|')})>`, 'g'), target)
      .replace(new RegExp(`<(${NAMESPACE_TOKENS.join('|')})>`, 'g'), namespace);
  }

  _lookupDef(name) {
    if (INCIDENT_DEFS_BY_NAME[name]) return INCIDENT_DEFS_BY_NAME[name];
    const byId = Object.values(INCIDENT_DEFS_BY_NAME).find((def) => def.id === name);
    return byId || null;
  }

  /** Build a panel incident from an `incident:created` payload (engine summary + extras). */
  _incidentFromEvent(data = {}) {
    const payload = data.incident && typeof data.incident === 'object' ? { ...data.incident, ...data } : { ...data };
    const def = this._lookupDef(payload.name) || this._lookupDef(payload.defId) || null;
    const name = payload.name || def?.name || 'Unknown';
    const steps = (payload.investigationSteps || def?.investigationSteps || []).map((step) => ({
      command: step.command || '',
      hint: step.hint || '',
      completed: Boolean(step.completed),
    }));
    const ocCommands = payload.ocCommands || def?.ocCommands || [];
    const resolutionActions = payload.resolutionActions || def?.resolutionActions || [];
    return {
      id: this.nextId++,
      engineIncidentId: payload.id || null,
      name,
      defId: def?.id || payload.defId || null,
      category: payload.category || def?.category || 'Pod',
      severity: Number(payload.severity || def?.severity || 3),
      target: payload.target || 'unknown',
      namespace: payload.namespace || '',
      uid: payload.uid || null,
      message: payload.description || payload.message || def?.description || 'An incident occurred',
      docsUrl: payload.docsUrl || def?.docsUrl || null,
      steps,
      ocCommands,
      resolutionActions,
      resolution: payload.resolution || def?.resolution || null,
      timestamp: Date.now(),
      status: 'active',
      resolvedAt: null,
      expanded: true,
      completedSteps: new Set(),
      lastAction: null,
    };
  }

  _findByEngineId(engineIncidentId) {
    if (!engineIncidentId) return null;
    return this.incidents.find((incident) => incident.engineIncidentId === engineIncidentId) || null;
  }

  _onNewIncident(data = {}) {
    const engineIncidentId = data.id || data.engineIncidentId || null;
    const existing = this._findByEngineId(engineIncidentId);
    if (existing) {
      // The shell also calls addIncident() from its own incident:created
      // listener — update instead of duplicating the card.
      existing.lastAction = data;
      this._renderList();
      return;
    }
    const incident = this._incidentFromEvent(data);
    this.incidents.unshift(incident);
    this._emitCount();
    this.show();
    this._renderList();
  }

  _onIncidentActivated(data = {}) {
    const incident = this._findByEngineId(data.id);
    if (incident && incident.status === 'active') this._renderList();
  }

  _onIncidentResolved(data = {}) {
    const incident = this._findByEngineId(data.id);
    if (!incident) return;
    incident.status = 'resolved';
    incident.resolvedAt = Date.now();
    incident.lastAction = data.action || 'manual';
    if (typeof data.xpEarned === 'number') incident.xpEarned = data.xpEarned;
    this._emitCount();
    if (this.visible) this._renderList();
  }

  /** Legacy public API used by index.html shell: addIncident(type, severity, resource, message, uid). */
  addIncident(type, severity, resource, message, uid) {
    this._onNewIncident({ name: type, severity, target: resource, description: message, id: uid });
  }

  // ── Investigation step matching ──────────────────────────────────────────
  _onCommandExecuted(data = {}) {
    const raw = String(data.command || data.raw || '').trim();
    if (!raw) return;
    this._recentCommands.push(raw);
    if (this._recentCommands.length > 20) this._recentCommands.shift();

    let changed = false;
    for (const incident of this.incidents) {
      if (incident.status !== 'active') continue;
      incident.steps.forEach((step, index) => {
        if (incident.completedSteps.has(index)) return;
        const expected = this._formatStepCommand(step.command, incident);
        if (this._fuzzyMatchCommand(raw, expected)) {
          incident.completedSteps.add(index);
          changed = true;
          if (incident.engineIncidentId) {
            window.game?.incidentEngine?.completeStep?.(incident.engineIncidentId, index);
          }
          window.game?.engine?.emit('xp:gain', { amount: 10, source: 'investigation' });
        }
      });
    }
    if (changed) {
      if (this.visible) this._renderList();
      this._saveInvestigationProgress();
    }
  }

  /** Fuzzy compare: exact → prefix → same base command → shared first 2-3 tokens. */
  _fuzzyMatchCommand(userCmd, stepCmd) {
    const u = normalizeCommand(userCmd);
    const s = normalizeCommand(stepCmd);
    if (!u || !s) return false;
    if (u === s) return true;
    if (u.startsWith(s) || s.startsWith(u)) return true;

    const uParts = u.split(' ');
    const sParts = s.split(' ');
    if (uParts.length < 2 || sParts.length < 2) return false;
    if (uParts[0] !== sParts[0]) return false;

    // `oc get pod` vs `oc get pods` — singular/plural resources.
    const singular = (token) => token.replace(/s$/, '');
    if (singular(uParts[1]) === singular(sParts[1])) {
      if (uParts.length >= 3 && sParts.length >= 3) {
        return singular(uParts[2]) === singular(sParts[2]) || uParts[2].startsWith(sParts[2]) || sParts[2].startsWith(uParts[2]);
      }
      return true;
    }

    const prefixLen = Math.min(uParts.length, sParts.length, 3);
    return uParts.slice(0, prefixLen).join(' ') === sParts.slice(0, prefixLen).join(' ');
  }

  // ── Resolution ───────────────────────────────────────────────────────────
  resolveIncident(localId, actionId) {
    const incident = this.incidents.find((entry) => entry.id === localId);
    if (!incident || incident.status === 'resolved') return false;

    const engine = window.game?.incidentEngine;
    if (incident.engineIncidentId && engine) {
      const result = engine.resolveIncident(incident.engineIncidentId, actionId || 'manual');
      if (!result) return false;
      // Engine emits incident:resolved → _onIncidentResolved updates the card.
      incident.status = 'resolved';
      incident.resolvedAt = Date.now();
      incident.lastAction = actionId || 'manual';
      this._emitCount();
      if (this.visible) this._renderList();
      return true;
    }

    // Local-only fallback (no engine, e.g. panel demo): resolve visually.
    incident.status = 'resolved';
    incident.resolvedAt = Date.now();
    window.game?.engine?.emit('incident:resolved', { id: null, name: incident.name, severity: incident.severity });
    window.game?.engine?.emit('xp:gain', { amount: this._getXPForResolve(incident), source: 'incident-panel' });
    this._emitCount();
    if (this.visible) this._renderList();
    return true;
  }

  _getXPForResolve(incident) {
    const elapsed = (incident.resolvedAt - incident.timestamp) / 1000;
    if (elapsed < 30) return 50;
    if (elapsed < 60) return 30;
    if (elapsed < 120) return 20;
    return 10;
  }

  _canResolve(incident) {
    if (incident.status !== 'active') return false;
    if (incident.steps.length === 0) return true;
    const required = Math.min(this._requiredSteps, incident.steps.length);
    return incident.completedSteps.size >= required;
  }

  _emitCount() {
    window.game?.engine?.emit('incident:count', { count: this._getActiveCount() });
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  _renderList() {
    if (!this.container) return;
    const list = this.container.querySelector('#incident-list');
    if (!list) return;
    const filtered = this._getFilteredIncidents();

    const countEl = this.container.querySelector('#incident-count');
    if (countEl) countEl.textContent = String(this._getActiveCount());

    if (filtered.length === 0) {
      list.innerHTML = `<div class="text-white/20 text-sm text-center mt-8">${this._emptyMessage()}</div>`;
      return;
    }

    list.innerHTML = filtered.map((incident) => this._renderCard(incident)).join('');
    this._bindCardEvents(list);
  }

  _renderCard(incident) {
    const style = SEVERITY_STYLE[incident.severity] || SEVERITY_STYLE[3];
    const category = INCIDENT_CATEGORIES[incident.category] || { label: incident.category, color: '#94a3b8' };
    const elapsed = this._formatElapsed(Date.now() - incident.timestamp);
    const stars = this._getStarRating(incident);
    const completedCount = incident.completedSteps.size;
    const canResolve = this._canResolve(incident);
    const steps = incident.steps;
    const commandList = incident.ocCommands || [];
    const actions = incident.resolutionActions || [];

    const stepRows = steps
      .map((step, index) => {
        const command = this._formatStepCommand(step.command, incident);
        const done = incident.completedSteps.has(index);
        return `
          <div class="flex items-start gap-2 group">
            <span class="text-[11px] w-4 text-center mt-1 ${done ? 'text-green-400' : 'text-white/15'}">${done ? '\u2713' : '\u25cb'}</span>
            <button class="flex-1 text-left px-2 py-1 text-[11px] font-mono ${done ? 'text-green-400/60 bg-green-400/5' : 'text-white/40 hover:text-white/60 bg-white/5 hover:bg-white/10'} rounded transition-colors run-cmd"
              data-cmd="${this._escapeHTML(command.replace(/^(?:kubectl|oc)\s+/i, ''))}" title="${this._escapeHTML(step.hint || 'Pre-fill this oc command')}">
              ${this._escapeHTML(command)}
            </button>
          </div>`;
      })
      .join('');

    const commandRows = commandList.length
      ? `<div class="mt-1.5 pt-1.5 border-t border-white/5">
           <div class="text-white/30 text-[10px] uppercase tracking-wider mb-1">Useful oc commands</div>
           <div class="space-y-0.5">
             ${commandList
               .slice(0, 5)
               .map(
                 (command) => `
               <button class="w-full text-left px-2 py-0.5 text-[10px] font-mono text-sky-300/70 hover:text-sky-200 bg-sky-400/5 hover:bg-sky-400/10 rounded transition-colors run-cmd"
                 data-cmd="${this._escapeHTML(this._formatStepCommand(command, incident).replace(/^(?:kubectl|oc)\s+/i, ''))}" title="Pre-fill this command">
                 ${this._escapeHTML(this._formatStepCommand(command, incident))}
               </button>`
               )
               .join('')}
           </div>
         </div>`
      : '';

    const actionButtons = actions
      .map(
        (action) => `
        <button class="action-btn px-2 py-0.5 text-[10px] rounded border transition-colors ${
          canResolve
            ? 'text-green-400 border-green-400/30 hover:bg-green-400/10'
            : 'text-white/20 border-white/10 cursor-not-allowed'
        }" data-action="${this._escapeHTML(action.action)}" ${canResolve ? '' : 'disabled title="Investigate first"'}>
          ${this._escapeHTML(action.label)}${action.difficulty ? ` <span class="text-white/25">\u2605${action.difficulty}</span>` : ''}
        </button>`
      )
      .join('');

    return `
      <div class="rounded-lg border ${style.border} ${style.bg} overflow-hidden" data-incident-id="${incident.id}" data-category="${this._escapeHTML(incident.category)}">
        <div class="px-3 py-2.5">
          <div class="flex items-start gap-2">
            <span class="text-sm ${style.text} mt-0.5">${style.icon}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-white/80 text-xs font-medium">${this._escapeHTML(incident.name)}</span>
                <span class="text-[9px] px-1.5 py-0.5 rounded-full border border-white/10 text-white/40" style="color:${category.color}">${this._escapeHTML(incident.category)}</span>
                ${incident.status === 'active' ? `<span class="flex items-center gap-1"><svg class="w-3 h-3 ${style.text} animate-pulse" fill="currentColor" viewBox="0 0 24 24"><path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg></span>` : ''}
              </div>
              <div class="text-white/40 text-xs mt-0.5 truncate">${this._escapeHTML(incident.target)}${incident.namespace ? ` <span class="text-white/20">(${this._escapeHTML(incident.namespace)})</span>` : ''}</div>
              <div class="text-white/30 text-[10px] mt-1">${this._escapeHTML(incident.message)}</div>
            </div>
            <div class="text-right shrink-0">
              <div class="text-white/20 text-[10px] font-mono incident-timer">${elapsed}</div>
              ${incident.status === 'resolved' ? `<div class="text-[10px] mt-0.5">${stars}</div>` : `<div class="text-[9px] mt-0.5 ${style.text}">${style.label}</div>`}
            </div>
          </div>

          ${
            incident.expanded && steps.length > 0
              ? `<div class="mt-2 pt-2 border-t border-white/5">
                   <div class="flex items-center justify-between mb-1.5">
                     <div class="text-white/30 text-[10px] uppercase tracking-wider">Investigation</div>
                     ${incident.status === 'active' ? `<div class="text-[10px] font-mono ${completedCount >= Math.min(this._requiredSteps, steps.length) ? 'text-green-400' : 'text-white/30'}">${completedCount}/${steps.length} investigated</div>` : ''}
                   </div>
                   <div class="space-y-1">${stepRows}</div>
                   ${incident.docsUrl || commandRows ? '<div class="mt-1.5 flex items-center gap-2">' : ''}
                   ${incident.docsUrl ? `<a class="docs-link text-[10px] text-sky-400/70 hover:text-sky-300 underline" href="${this._escapeHTML(incident.docsUrl)}" target="_blank" rel="noopener noreferrer">Red Hat docs \u2197</a>` : ''}
                   ${incident.docsUrl || commandRows ? '</div>' : ''}
                   ${commandRows}
                 </div>`
              : ''
          }

          <div class="flex items-center gap-1.5 mt-2 flex-wrap">
            ${steps.length > 0 ? `<button class="toggle-expand text-[10px] text-white/30 hover:text-white/50 transition-colors">${incident.expanded ? 'Hide steps' : 'Investigate'}</button>` : ''}
            ${
              incident.status === 'active'
                ? `<div class="ml-auto flex items-center gap-1">
                     ${actionButtons}
                     ${
                       canResolve
                         ? `<button class="resolve-btn px-2 py-0.5 text-[10px] text-green-400 hover:bg-green-400/10 rounded transition-colors" data-action="manual">Resolve</button>`
                         : `<span class="flex items-center gap-1 text-[10px] text-white/20" title="Run the investigation commands first">
                              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                              Investigate first
                            </span>`
                     }
                   </div>`
                : `<span class="ml-auto text-[10px] text-green-400/50">Resolved${incident.lastAction ? ` (${this._escapeHTML(incident.lastAction)})` : ''}</span>`
            }
          </div>
        </div>
      </div>
    `;
  }

  _bindCardEvents(list) {
    list.querySelectorAll('.toggle-expand').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('[data-incident-id]');
        const incident = this._findByLocalId(card?.dataset.incidentId);
        if (incident) {
          incident.expanded = !incident.expanded;
          this._renderList();
        }
      });
    });

    list.querySelectorAll('.resolve-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('[data-incident-id]');
        const incident = this._findByLocalId(card?.dataset.incidentId);
        if (incident) this.resolveIncident(incident.id, btn.dataset.action || 'manual');
      });
    });

    list.querySelectorAll('.action-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const card = btn.closest('[data-incident-id]');
        const incident = this._findByLocalId(card?.dataset.incidentId);
        if (incident) this.resolveIncident(incident.id, btn.dataset.action || 'manual');
      });
    });

    list.querySelectorAll('.run-cmd').forEach((btn) => {
      btn.addEventListener('click', () => {
        const command = btn.dataset.cmd || '';
        if (!command) return;
        const stripped = command.replace(/^(?:kubectl|oc)\s+/i, '');
        const cmdInput = document.getElementById('cmd-input');
        if (cmdInput) {
          cmdInput.value = stripped;
          cmdInput.focus();
          const cmdBar = document.getElementById('command-bar');
          if (cmdBar?.classList.contains('translate-y-full')) {
            window.game?.engine?.emit('ui:show-command-bar');
          }
        } else {
          window.game?.engine?.emit('ui:run-command', { command });
        }
      });
    });
  }

  _findByLocalId(id) {
    return this.incidents.find((incident) => String(incident.id) === String(id)) || null;
  }

  // ── Misc helpers ─────────────────────────────────────────────────────────
  _getStarRating(incident) {
    if (incident.status !== 'resolved' || !incident.resolvedAt) return '';
    const elapsed = (incident.resolvedAt - incident.timestamp) / 1000;
    let stars = 1;
    if (elapsed < 30) stars = 3;
    else if (elapsed < 60) stars = 2;
    const filled = '\u2605'.repeat(stars);
    const empty = '\u2605'.repeat(3 - stars);
    return `<span class="text-amber-400">${filled}</span><span class="text-white/10">${empty}</span>`;
  }

  _formatElapsed(ms) {
    const secs = Math.max(0, Math.floor(ms / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  _updateTimers() {
    if (!this.container) return;
    this.container.querySelectorAll('[data-incident-id]').forEach((card) => {
      const incident = this._findByLocalId(card.dataset.incidentId);
      if (!incident || incident.status !== 'active') return;
      const timer = card.querySelector('.incident-timer');
      if (timer) timer.textContent = this._formatElapsed(Date.now() - incident.timestamp);
    });
  }

  _escapeHTML(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  _saveInvestigationProgress() {
    try {
      const data = this.incidents.map((incident) => ({
        engineIncidentId: incident.engineIncidentId,
        name: incident.name,
        target: incident.target,
        completedSteps: Array.from(incident.completedSteps || []),
        status: incident.status,
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      /* storage may be unavailable */
    }
  }

  _loadInvestigationProgress() {
    try {
      let stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
          stored = legacy;
          localStorage.setItem(STORAGE_KEY, legacy);
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
      }
      if (!stored) return;
      const data = JSON.parse(stored);
      if (!Array.isArray(data)) return;
      // Best-effort: engine incident ids are per-session, so only apply data
      // whose id/name/target still match an existing card.
      for (const saved of data) {
        const incident = this.incidents.find(
          (entry) =>
            (saved.engineIncidentId && entry.engineIncidentId === saved.engineIncidentId) ||
            (!saved.engineIncidentId && entry.name === saved.name && entry.target === saved.target)
        );
        if (incident && Array.isArray(saved.completedSteps)) {
          incident.completedSteps = new Set(saved.completedSteps);
        }
      }
    } catch (err) {
      /* ignore corrupt storage */
    }
  }
}

export default IncidentPanel;
