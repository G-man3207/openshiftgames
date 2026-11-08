/**
 * StartMenu — start page behaviour for OpenShift Games.
 *
 * The start page markup lives in index.html (`#main-menu.sp`); this module adds
 * the live parts: the 3D cluster diorama in the hero stage (the canvas is
 * reparented into the stage while the menu is up), the EX280 objective picker,
 * progress-aware primary action, nav/scroll state and section reveals.
 *
 * It is deliberately small and defensive: if the 3D renderer or the engine is
 * unavailable the page still works (the stage simply stays dark), and no JS
 * error can block starting a mode.
 */

import { EX280_OBJECTIVE_GROUPS } from '../data/EX280Objectives.js';
// Campaign order, unlocking and display numbers (ids are stable save keys).
import {
  CAMPAIGN_ORDER,
  continueLevelId,
  isCampaignComplete,
  isLevelUnlocked,
  levelLabel,
  levelOrdinal,
} from '../data/CampaignLevels.js';

const MAX_VISIBLE_BULLETS = 8;

function compressNumbers(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  for (const value of sorted) {
    if (start === null) {
      start = value;
      prev = value;
      continue;
    }
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}–${prev}`);
    start = value;
    prev = value;
  }
  if (start !== null) parts.push(start === prev ? String(start) : `${start}–${prev}`);
  return parts.join(', ');
}

function bulletIcon() {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m3 8.5 3 3 7-7"/></svg>';
}

function arrowIcon(direction = 'right') {
  const d = direction === 'diagonal' ? 'M4 12 12 4M6 4h6v6' : 'M2 8h11M9 3.5 13.5 8 9 12.5';
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

export class StartMenu {
  constructor(app) {
    this.app = app;
    this.root = null;
    this.stageMount = null;
    this.canvas = null;
    this.observer = null;
    this.readoutTimer = null;
    this.selectedGroupId = EX280_OBJECTIVE_GROUPS[0]?.id || null;
    this._boundScroll = this._onScroll.bind(this);
    this._boundReadouts = this._updateReadouts.bind(this);
  }

  init() {
    this.root = document.getElementById('main-menu');
    this.stageMount = document.getElementById('sp-stage-mount');
    if (!this.root || !this.stageMount) return;

    document.documentElement.classList.add('sp-js');
    document.documentElement.classList.add('sp-menu-open');
    document.body.classList.add('sp-menu-open');

    this._bindPrimaryActions();
    this._bindScrollState();
    this._bindReveals();
    this._renderExamGroups();
    this._selectExamGroup(this.selectedGroupId);
    this._updatePrimaryLabel();
    this._updateReadouts();
    this.readoutTimer = window.setInterval(this._boundReadouts, 2500);

    // The GitHub API is rate-limited/unavailable offline: don't leave a "--" or a
    // lonely "0" in the nav.
    window.setTimeout(() => {
      const count = document.getElementById('github-star-count');
      const text = count?.textContent?.trim();
      if (count && (text === '--' || text === '0')) {
        count.closest('.sp-gh-stars')?.classList.add('is-empty');
      }
    }, 3200);
  }

  // ── Canvas / showcase ────────────────────────────────────────────────────

  /** Move the live renderer canvas into the hero stage and start the showcase. */
  attachStage() {
    if (!this.root || !this.stageMount) return;
    const canvas = document.getElementById('game-canvas');
    if (!canvas) return;
    this.canvas = canvas;
    if (canvas.parentElement !== this.stageMount) {
      this.stageMount.appendChild(canvas);
    }
    this._observeStage();
    this._resizeRenderer();
  }

  /** Move the canvas back to the body as the full-screen game view. */
  detachStage() {
    const canvas = this.canvas || document.getElementById('game-canvas');
    if (!canvas) return;
    this._stageObserver?.disconnect?.();
    this._stageObserver = null;
    if (canvas.parentElement !== document.body) {
      document.body.insertBefore(canvas, document.body.firstChild);
    }
    this.canvas = null;
    this._resizeRenderer();
  }

  /**
   * The renderer sizes itself from the canvas' client box, so keep the canvas at
   * 100% of the stage and re-run the resize when the stage changes size.
   */
  _observeStage() {
    if (!this.stageMount || !('ResizeObserver' in window)) return;
    this._stageObserver?.disconnect?.();
    this._stageObserver = new ResizeObserver(() => {
      const canvas = this.canvas;
      if (!canvas) return;
      canvas.style.width = '';
      canvas.style.height = '';
      this._resizeRenderer();
    });
    this._stageObserver.observe(this.stageMount);
  }

  _resizeRenderer() {
    const canvas = this.canvas;
    if (canvas) {
      canvas.style.width = '';
      canvas.style.height = '';
    }
    const renderer = this.app?.renderer;
    try {
      if (renderer && typeof renderer.resize === 'function') {
        renderer.resize();
      }
      window.dispatchEvent(new Event('resize'));
    } catch (err) {
      console.warn('OpenShift Games: start page scene resize failed', err);
    }
  }

  /**
   * Build (or rebuild) the idle cluster diorama shown in the hero stage and in
   * the menu behind it: default seeded OpenShift cluster, auto-aligned, framed,
   * slowly orbiting.
   */
  showScene() {
    const app = this.app;
    const renderer = app?.renderer;
    if (!renderer) return;
    try {
      document.documentElement.classList.add('sp-menu-open');
      document.body.classList.add('sp-menu-open');
      this.attachStage();
      for (const uid of [...(renderer.resourceMeshes?.keys?.() || [])])
        renderer.removeResource(uid);
      app.placedPositions?.clear?.();

      // Seed the default OpenShift 4.22 cluster (Projects, operators, SCCs, users, ...)
      // plus a small, plausible workload so the diorama says what the product is.
      app.engine?.cluster?.clear?.();
      this._seedShowcaseCluster(app.engine?.cluster);
      for (const resource of app.engine?.cluster?.getAllResources?.() || []) {
        const uid = resource.uid || resource.metadata?.uid;
        if (!uid || renderer.resourceMeshes?.has?.(uid)) continue;
        const pos = app.getPlacementPosition?.() || { x: 0, y: 0, z: 0 };
        app.placedPositions?.set?.(uid, pos);
        renderer.addResource?.({
          id: uid,
          kind: resource.kind,
          type: resource.kind,
          name: resource.name || resource.metadata?.name,
          namespace: resource.namespace || resource.metadata?.namespace,
          status: resource.status?.phase || resource.status || 'Active',
          x: pos.x,
          y: pos.y,
          z: pos.z,
          _ref: resource,
        });
      }

      if (typeof renderer.autoAlign === 'function') {
        renderer.autoAlign(app.engine.cluster, { duration: 0 });
      }
      if (typeof renderer.syncConnectionsFromCluster === 'function') {
        renderer.syncConnectionsFromCluster(app.engine.cluster);
      }
      if (typeof renderer.fitToView === 'function') {
        renderer.fitToView({ animate: false });
      } else if (typeof renderer.resetCamera === 'function') {
        renderer.resetCamera();
      }
      if (typeof renderer.setMenuMode === 'function') renderer.setMenuMode(true);
      renderer.start?.();
      this._updateReadouts();
      this._updatePrimaryLabel();
      window.scrollTo(0, this._savedScroll || 0);
    } catch (err) {
      console.warn('OpenShift Games: start page scene failed', err);
    }
  }

  /** Leave menu scene mode (called when a game mode launches). */
  hideScene() {
    try {
      this._savedScroll = window.scrollY || document.documentElement.scrollTop || 0;
      document.documentElement.classList.remove('sp-menu-open');
      document.body.classList.remove('sp-menu-open');
      this.app?.renderer?.setMenuMode?.(false);
      this.detachStage();
      window.scrollTo(0, 0);
    } catch (err) {
      console.warn('OpenShift Games: start page scene teardown failed', err);
    }
  }

  /**
   * A small, plausible cluster for the start-page diorama: three nodes and a
   * checkout app with a build, a route and a bound volume. It is replaced by the
   * real mode cluster the moment a mode launches (engine.reset()).
   */
  _seedShowcaseCluster(cluster) {
    if (!cluster || typeof cluster.addResource !== 'function') return;
    const resources = [
      { kind: 'Node', name: 'master-0', status: { phase: 'Ready' } },
      { kind: 'Node', name: 'worker-0', status: { phase: 'Ready' } },
      { kind: 'Node', name: 'worker-1', status: { phase: 'Ready' } },
      { kind: 'Project', name: 'checkout' },
      { kind: 'Project', name: 'payments' },
      { kind: 'BuildConfig', name: 'checkout', namespace: 'checkout', status: { phase: 'Active' } },
      { kind: 'ImageStream', name: 'checkout', namespace: 'checkout', status: { phase: 'Active' } },
      {
        kind: 'Deployment',
        name: 'checkout',
        namespace: 'checkout',
        status: { phase: 'Available' },
      },
      {
        kind: 'Deployment',
        name: 'payments',
        namespace: 'payments',
        status: { phase: 'Available' },
      },
      {
        kind: 'Pod',
        name: 'checkout-6f9c9-2x7lq',
        namespace: 'checkout',
        status: { phase: 'Running' },
      },
      {
        kind: 'Pod',
        name: 'checkout-6f9c9-9p4rb',
        namespace: 'checkout',
        status: { phase: 'Running' },
      },
      {
        kind: 'Pod',
        name: 'payments-7d4b8-5kwmz',
        namespace: 'payments',
        status: { phase: 'Running' },
      },
      { kind: 'Service', name: 'checkout', namespace: 'checkout', status: { phase: 'Active' } },
      { kind: 'Service', name: 'payments', namespace: 'payments', status: { phase: 'Active' } },
      { kind: 'Route', name: 'checkout', namespace: 'checkout', status: { phase: 'Admitted' } },
      {
        kind: 'ConfigMap',
        name: 'checkout-config',
        namespace: 'checkout',
        status: { phase: 'Active' },
      },
      { kind: 'Secret', name: 'payments-tls', namespace: 'payments', status: { phase: 'Active' } },
      { kind: 'PVC', name: 'checkout-data', namespace: 'checkout', status: { phase: 'Bound' } },
    ];
    for (const resource of resources) {
      try {
        cluster.addResource(resource);
      } catch (err) {
        console.warn('OpenShift Games: showcase resource failed', resource.kind, err);
      }
    }
  }

  // ── Primary actions ──────────────────────────────────────────────────────

  _bindPrimaryActions() {
    const primary = document.getElementById('sp-cta-primary');
    primary?.addEventListener('click', () => this._startCampaign());
    document.getElementById('sp-cta-sandbox')?.addEventListener('click', () => {
      this.app?.startMode?.('sandbox');
    });

    // Footer + secondary launchers: any [data-start-mode] starts that mode.
    for (const el of this.root.querySelectorAll('[data-start-mode]')) {
      el.addEventListener('click', () => {
        const mode = el.getAttribute('data-start-mode');
        if (!mode) return;
        this.app?.startMode?.(mode);
      });
    }

    // Any control that opens the EX280 Prep tracker.
    for (const el of this.root.querySelectorAll('[data-exam-prep]')) {
      el.addEventListener('click', () => this.app?.showExamPrep?.());
    }
  }

  _startCampaign() {
    const next = this._nextCampaignLevel();
    this.app?.startMode?.('campaign');
    if (next) {
      // startMode() has set currentMode and built the level select; jump straight in.
      this.app?.launchGame?.('campaign', next);
    }
  }

  _campaignProgress() {
    try {
      return this.app?.scoringEngine?.getProgress?.()?.campaignProgress || {};
    } catch {
      return {};
    }
  }

  /** The level "Start / Continue" opens (shared rule with the level select). */
  _nextCampaignLevel() {
    try {
      return continueLevelId(this._campaignProgress());
    } catch {
      return CAMPAIGN_ORDER[0] || 1;
    }
  }

  /** True when the player can start this level now (never launch a locked level). */
  _isCampaignLevelOpen(levelId) {
    try {
      return isLevelUnlocked(levelId, this._campaignProgress());
    } catch {
      return false;
    }
  }

  _updatePrimaryLabel() {
    const label = document.getElementById('sp-cta-label');
    if (!label) return;
    try {
      const campaign = this._campaignProgress();
      const completed = CAMPAIGN_ORDER.filter((id) => campaign[id]?.completed);
      if (completed.length === 0) {
        label.textContent = 'Start the campaign';
        return;
      }
      if (isCampaignComplete(campaign)) {
        // Reporting "Continue · level 22" after the capstone was already
        // confusing: the campaign is finished, so offer a replay instead.
        label.textContent = 'Replay the campaign';
        return;
      }
      const next = this._nextCampaignLevel();
      label.textContent = `Continue · level ${levelLabel(next)}`;
    } catch {
      label.textContent = 'Start the campaign';
    }
  }

  // ── Live cluster readouts ────────────────────────────────────────────────

  _updateReadouts() {
    const cluster = window.game?.cluster || this.app?.engine?.cluster;
    if (!cluster || !this.root || this.root.classList.contains('hidden')) return;
    const count = (kind) => {
      try {
        const list = cluster.getResourcesByKind?.(kind) || cluster.getByKind?.(kind) || [];
        return Array.isArray(list) ? list.length : 0;
      } catch {
        return 0;
      }
    };
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(value);
    };
    set('sp-r-projects', count('Project'));
    set('sp-r-nodes', count('Node'));
    const pods = (() => {
      try {
        return cluster.getResourcesByKind?.('Pod') || cluster.getByKind?.('Pod') || [];
      } catch {
        return [];
      }
    })();
    const running = pods.filter((pod) => (pod.status?.phase || pod.status) === 'Running').length;
    set('sp-r-pods', `${running}`);
  }

  // ── Nav + reveal ─────────────────────────────────────────────────────────

  _bindScrollState() {
    const nav = document.getElementById('sp-nav');
    if (!nav) return;
    window.addEventListener('scroll', this._boundScroll, { passive: true });
    this.root.addEventListener('scroll', this._boundScroll, { passive: true });
    this._onScroll();
  }

  _onScroll() {
    const nav = document.getElementById('sp-nav');
    if (!nav) return;
    const top = window.scrollY || document.documentElement.scrollTop || this.root?.scrollTop || 0;
    nav.classList.toggle('is-stuck', top > 8);
  }

  _bindReveals() {
    const targets = this.root.querySelectorAll('.sp-reveal');
    if (!targets.length) return;
    if (!('IntersectionObserver' in window)) {
      for (const el of targets) el.classList.add('is-in');
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          this.observer.unobserve(entry.target);
        }
      },
      { root: this.root, rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    for (const el of targets) this.observer.observe(el);
  }

  // ── EX280 objective picker ───────────────────────────────────────────────

  _renderExamGroups() {
    const list = document.getElementById('sp-exam-list');
    if (!list) return;
    list.innerHTML = EX280_OBJECTIVE_GROUPS.map(
      (group) => `
        <button type="button" class="sp-exam-btn" role="tab" aria-selected="false"
                data-group="${group.id}" aria-controls="sp-exam-detail">
          <span class="sp-exam-btn-name">${this._escape(group.title)}</span>
          <span class="sp-exam-btn-count">${group.bullets.length} objective${group.bullets.length === 1 ? '' : 's'}</span>
        </button>`
    ).join('');
    for (const btn of list.querySelectorAll('.sp-exam-btn')) {
      btn.addEventListener('click', () => this._selectExamGroup(btn.dataset.group));
      btn.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const buttons = [...list.querySelectorAll('.sp-exam-btn')];
        const index = buttons.indexOf(btn);
        const nextIndex =
          event.key === 'ArrowDown'
            ? (index + 1) % buttons.length
            : (index - 1 + buttons.length) % buttons.length;
        buttons[nextIndex]?.focus();
        buttons[nextIndex]?.click();
      });
    }
  }

  _selectExamGroup(groupId) {
    const group =
      EX280_OBJECTIVE_GROUPS.find((entry) => entry.id === groupId) || EX280_OBJECTIVE_GROUPS[0];
    if (!group) return;
    this.selectedGroupId = group.id;

    for (const btn of this.root.querySelectorAll('.sp-exam-btn')) {
      btn.setAttribute('aria-selected', btn.dataset.group === group.id ? 'true' : 'false');
    }

    const detail = document.getElementById('sp-exam-detail');
    if (!detail) return;

    // Level ids are save keys: order them by campaign position and show their
    // display numbers (the capstone is id 20 but the last numbered level).
    const levels = [...new Set(group.bullets.flatMap((bullet) => bullet.levels || []))].sort(
      (a, b) => CAMPAIGN_ORDER.indexOf(a) - CAMPAIGN_ORDER.indexOf(b)
    );
    const challenges = [
      ...new Set(group.bullets.flatMap((bullet) => bullet.challenges || [])),
    ].sort((a, b) => a - b);
    const visible = group.bullets.slice(0, MAX_VISIBLE_BULLETS);
    const remaining = group.bullets.length - visible.length;
    // Campaign levels unlock in order; never launch a locked level (the game would
    // bounce the player to their Continue level). Offer the first open level, or
    // the level select if this group starts further along.
    const openLevel = levels.find((id) => this._isCampaignLevelOpen(id)) || null;
    const nextChallenge = challenges[0] || null;

    detail.innerHTML = `
      <h3>${this._escape(group.title)}</h3>
      <p class="sp-exam-meta">
        ${group.bullets.length} objective${group.bullets.length === 1 ? '' : 's'}
        ${levels.length ? ` · practised in levels ${compressNumbers(levels.map((id) => levelOrdinal(id)))}` : ''}
        ${challenges.length ? ` · labs ${compressNumbers(challenges)}` : ''}
      </p>
      <ul class="sp-exam-bullets">
        ${visible.map((bullet) => `<li>${bulletIcon()}<span>${this._escape(bullet.title)}</span></li>`).join('')}
      </ul>
      ${remaining > 0 ? `<p class="sp-exam-more">and ${remaining} more, tracked in EX280 Prep.</p>` : ''}
      <div class="sp-exam-actions">
        ${
          openLevel
            ? `<button type="button" class="sp-btn-small" id="sp-exam-start" data-level="${openLevel}">Start level ${levelLabel(openLevel)}${arrowIcon()}</button>`
            : '<button type="button" class="sp-btn-small" id="sp-exam-start" data-level="">Open campaign' +
              arrowIcon() +
              '</button>'
        }
        ${
          nextChallenge
            ? `<button type="button" class="sp-btn-small" id="sp-exam-lab" data-start-challenge="${nextChallenge}">Timed lab ${nextChallenge}${arrowIcon()}</button>`
            : ''
        }
        <a class="sp-text-link" href="${group.docsUrl}" target="_blank" rel="noopener">Red Hat docs ${arrowIcon('diagonal')}</a>
      </div>`;

    document.getElementById('sp-exam-start')?.addEventListener('click', (event) => {
      const level = Number(event.currentTarget?.dataset?.level || 0);
      this.app?.startMode?.('campaign');
      if (level) this.app?.launchGame?.('campaign', level);
    });
    const labBtn = document.getElementById('sp-exam-lab');
    labBtn?.addEventListener('click', () => {
      const id = Number(labBtn.dataset.startChallenge);
      if (!id) return;
      this.app?.startMode?.('challenge');
      this.app?.launchGame?.('challenge', id);
    });
  }

  _escape(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (ch) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[ch]
    );
  }

  destroy() {
    this.observer?.disconnect?.();
    this.observer = null;
    if (this.readoutTimer) window.clearInterval(this.readoutTimer);
    this.readoutTimer = null;
    this.root?.removeEventListener?.('scroll', this._boundScroll);
    window.removeEventListener?.('scroll', this._boundScroll);
  }
}

export default StartMenu;
