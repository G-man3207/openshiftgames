/**
 * EX280 Prep — non-3D overlay UI for shifting.pro.
 *
 * Provides the in-app exam prep experience required by docs/CONVERSION-SPEC.md §11:
 *   1. Objective tracker  — all 9 groups / 55 EX280V422 bullets, mastery status,
 *                           linked campaign levels/challenges, copyable oc commands, docs links.
 *   2. Quick labs         — short do-it-now drills that launch Sandbox mode.
 *   3. Cheat sheet        — searchable grouped oc command reference.
 *   4. Exam facts         — EX280V422 facts, links and disclaimers.
 *
 * Integration contract (docs/CONVERSION-SPEC.md §11/§13, brand-dev shell):
 *   - default/class export usable as `ExamPrepUI || ExamPrepMode || ExamPrep || default`
 *   - constructor: `new ExamPrepUI(gameEngine, scoringEngine, app)`
 *   - methods: init(), show(), hide(), optional destroy(); property `visible`
 *   - shell sets `window.game.examPrepUI` / `app.examPrepUI` (we also self-register)
 *   - level/challenge launch goes through `app.startMode('campaign')` +
 *     `app.launchGame('campaign'|'challenge', id)`
 *   - tests select `#exam-prep-overlay` or `[data-testid="exam-prep"]`;
 *     `getBulletCount()` must return 55.
 *
 * Progress semantics (evidence-based, #14/#20/#48-2): a bullet is MASTERED only
 * when there is drill evidence — a quick lab linked to the bullet passed its
 * live `check` evaluation, or the bullet's own example command was run
 * successfully in a COMPLETED campaign level or lab (any level/lab, not only the
 * ones mapped to the bullet). Simply completing a level (or a console shortcut
 * that writes progress) is only "Practiced", as is a matching command recorded
 * in a drill that was never completed. Bullets that the simulator cannot
 * exercise (the web console) are capped at "Practiced" and label themselves
 * documentation-only. `ScoringEngine.getExamPrepProgress()` /
 * `markExamPrep()` / `getCommandEvidence()` are feature-detected; if absent we
 * fall back to `getProgress()` and a localStorage-backed local state key
 * (openshiftgames_exam_prep).
 */

import {
  EX280_OBJECTIVE_GROUPS,
  EX280_OBJECTIVE_BULLETS,
  EX280_OBJECTIVE_COUNT,
  EX280_QUICK_LABS,
  EX280_CHEATSHEET,
  EX280_EXAM_FACTS,
  EX280_READINESS_THRESHOLD,
  getEX280ObjectiveById,
  levelTitle,
  challengeTitle,
} from '../data/EX280Objectives.js';
import { createObjectiveProgress, evaluateObjectives } from '../engine/ObjectiveEvaluator.js';
import { commandSignature } from '../engine/ScoringEngine.js';
// Display numbers for level chips (ids are stable save keys, 1.16.0).
import { levelLabel } from '../data/CampaignLevels.js';

const LOCAL_STORAGE_KEY = 'openshiftgames_exam_prep';
/** Learner-facing documentation (moved out of the repo docs/ folder to the GitHub wiki). */
const STUDY_GUIDE_URL = 'https://github.com/G-man3207/openshiftgames/wiki/EX280-Study-Guide';
const STYLE_ID = 'exam-prep-styles';
const TABS = [
  { id: 'objectives', label: 'Objective tracker', testId: 'exam-prep-tab-objectives' },
  { id: 'quicklabs', label: 'Quick labs', testId: 'exam-prep-tab-quick-labs' },
  { id: 'cheatsheet', label: 'Cheat sheet', testId: 'exam-prep-tab-cheat-sheet' },
  { id: 'facts', label: 'Exam facts', testId: 'exam-prep-tab-exam-facts' },
];

const STATUS_META = {
  mastered: { label: 'Mastered', className: 'is-mastered' },
  practiced: { label: 'Practiced', className: 'is-practiced' },
  todo: { label: 'Not started', className: 'is-todo' },
};

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]
  );

const EX280_STYLES = `
#exam-prep-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(6, 8, 11, 0.72);
  color: var(--text, #ECEEF1);
  font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
}
#exam-prep-overlay.active { display: flex; }
#exam-prep-overlay .ep-shell {
  width: min(1180px, 97vw);
  height: min(90vh, 920px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface, #111419);
  border: 1px solid var(--line-strong, #2C333E);
  border-radius: 8px;
  box-shadow: var(--shadow-float, 0 18px 44px rgba(0,0,0,.55));
  animation: epIn 0.22s ease;
}
@keyframes epIn { from { opacity: 0; transform: translateY(10px) scale(0.99); } to { opacity: 1; transform: none; } }
.ep-header {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  padding: 1rem 1.15rem 0.65rem;
  border-bottom: 1px solid var(--line, #1F242C);
  background: transparent;
}
.ep-heading { flex: 1; min-width: 0; }
.ep-eyebrow {
  font-size: 0.68rem;
  letter-spacing: 0;
  font-weight: 500;
  text-transform: none;
  color: var(--muted, #9AA1A9);
  margin-bottom: 0.2rem;
}
.ep-title { font-size: 1.3rem; font-weight: 800; line-height: 1.15; }
.ep-subtitle { font-size: 0.68rem; color: var(--text-secondary, rgba(255,255,255,0.6)); margin-top: 0.25rem; }
.ep-note { font-size: 0.6rem; color: var(--text-muted, rgba(255,255,255,0.35)); margin-top: 0.2rem; }
.ep-head-links { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.4rem; }
.ep-head-links a { font-size: 0.66rem; color: var(--muted, #9AA1A9); text-decoration: none; border-bottom: 1px solid var(--line-strong, #2C333E); }
.ep-head-links a:hover { color: var(--text, #ECEEF1); }
.ep-close {
  width: 32px; height: 32px;
  flex: none;
  display: grid; place-items: center;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.05);
  color: var(--text-secondary, rgba(255,255,255,0.6));
  font-size: 1.1rem;
  cursor: pointer;
}
.ep-close:hover { color: #fff; border-color: rgba(238,0,0,0.5); background: rgba(238,0,0,0.16); }
.ep-tabs {
  display: flex;
  gap: 0.35rem;
  padding: 0.55rem 1.15rem 0;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  overflow-x: auto;
}
.ep-tab {
  padding: 0.45rem 0.8rem;
  border-radius: 8px 8px 0 0;
  border: 1px solid transparent;
  border-bottom: none;
  background: transparent;
  color: var(--text-secondary, rgba(255,255,255,0.6));
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.ep-tab:hover { color: #fff; }
.ep-tab.active {
  color: var(--text, #ECEEF1);
  background: var(--raised-2, #1B2027);
  border-color: transparent;
}
.ep-progress-row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.6rem 1.15rem;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  background: rgba(0,0,0,0.16);
}
.ep-progress-meta { font-size: 0.68rem; color: var(--text-secondary, rgba(255,255,255,0.6)); white-space: nowrap; }
.ep-progress-meta strong { color: #fff; }
.ep-progress-track {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: rgba(255,255,255,0.10);
  overflow: hidden;
}
.ep-progress-fill {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: var(--accent, #EE0000);
  transition: width 0.35s ease, background-color 0.35s ease;
}
.ep-progress-fill.is-danger { background: var(--accent, #EE0000); }
.ep-progress-fill.is-close { background: #d29922; }
.ep-progress-fill.is-ready { background: #3fb950; }
.ep-readiness {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  padding: 0.28rem 0.6rem;
  border-radius: 4px;
  white-space: nowrap;
  border: 1px solid rgba(255,255,255,0.16);
  color: var(--text-secondary, rgba(255,255,255,0.6));
}
.ep-readiness.is-ready { color: #3fb950; border-color: rgba(63,185,80,0.5); background: rgba(63,185,80,0.12); }
.ep-readiness.is-close { color: #d29922; border-color: rgba(210,153,34,0.5); background: rgba(210,153,34,0.12); }
.ep-body { flex: 1; overflow: hidden; display: flex; }
.ep-panel { display: none; flex: 1; overflow-y: auto; padding: 0.9rem 1.15rem 1.4rem; }
.ep-panel.active { display: block; }
.ep-panel::-webkit-scrollbar { width: 10px; }
.ep-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 8px; }
.ep-toolbar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.8rem; flex-wrap: wrap; }
.ep-search {
  flex: 1;
  min-width: 220px;
  padding: 0.45rem 0.7rem;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.05);
  color: #fff;
  font-size: 0.72rem;
  font-family: inherit;
}
.ep-search:focus { outline: none; border-color: rgba(238,0,0,0.55); }
.ep-hint { font-size: 0.62rem; color: var(--text-muted, rgba(255,255,255,0.35)); }
.ep-group {
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 12px;
  margin-bottom: 0.8rem;
  overflow: hidden;
  background: rgba(255,255,255,0.02);
}
.ep-group-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.8rem;
  background: rgba(238,0,0,0.09);
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.ep-group-title { font-size: 0.82rem; font-weight: 700; flex: 1; min-width: 0; }
.ep-group-count { font-size: 0.6rem; color: var(--text-secondary, rgba(255,255,255,0.6)); white-space: nowrap; }
.ep-bullet { padding: 0.6rem 0.8rem; border-top: 1px solid rgba(255,255,255,0.06); }
.ep-bullet:first-of-type { border-top: none; }
.ep-bullet-head { display: flex; align-items: flex-start; gap: 0.55rem; }
.ep-bullet-title { flex: 1; font-size: 0.74rem; font-weight: 600; line-height: 1.35; }
.ep-status {
  flex: none;
  font-size: 0.55rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.14);
  color: var(--text-secondary, rgba(255,255,255,0.6));
}
.ep-status.is-mastered { color: #3fb950; border-color: rgba(63,185,80,0.45); background: rgba(63,185,80,0.12); }
.ep-status.is-practiced { color: #d29922; border-color: rgba(210,153,34,0.45); background: rgba(210,153,34,0.12); }
.ep-bullet-summary { font-size: 0.65rem; color: var(--text-secondary, rgba(255,255,255,0.6)); margin: 0.3rem 0 0.4rem; line-height: 1.5; }
.ep-cmds { display: flex; flex-direction: column; gap: 0.22rem; margin: 0.3rem 0; }
.ep-cmd-row { display: flex; align-items: center; gap: 0.35rem; }
.ep-cmd-row code {
  flex: 1;
  min-width: 0;
  padding: 0.28rem 0.45rem;
  border-radius: 6px;
  background: rgba(0,0,0,0.42);
  border: 1px solid rgba(255,255,255,0.08);
  color: #ffd7d3;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 0.62rem;
  overflow-wrap: anywhere;
}
.ep-icon-btn {
  flex: none;
  padding: 0.25rem 0.4rem;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.05);
  color: var(--text-secondary, rgba(255,255,255,0.6));
  font-size: 0.58rem;
  cursor: pointer;
  white-space: nowrap;
}
.ep-icon-btn:hover { color: #fff; border-color: rgba(238,0,0,0.5); background: rgba(238,0,0,0.15); }
.ep-links { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.4rem; align-items: center; }
.ep-chip {
  padding: 0.22rem 0.5rem;
  border-radius: 999px;
  border: 1px solid rgba(88,166,255,0.28);
  background: rgba(88,166,255,0.10);
  color: #9ecbff;
  font-size: 0.58rem;
  font-weight: 600;
  cursor: pointer;
}
.ep-chip:hover { background: rgba(88,166,255,0.22); color: #fff; }
.ep-chip.ep-chip-lab { border-color: rgba(249,115,22,0.35); background: rgba(249,115,22,0.12); color: #ffc89e; }
.ep-chip.ep-chip-lab:hover { background: rgba(249,115,22,0.24); color: #fff; }
.ep-doc-link { font-size: 0.6rem; color: var(--status-blue, #58a6ff); text-decoration: none; }
.ep-doc-link:hover { text-decoration: underline; }
.ep-lab-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 0.75rem; }
.ep-lab-card {
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 12px;
  padding: 0.75rem;
  background: rgba(255,255,255,0.02);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.ep-lab-card.is-done { border-color: rgba(63,185,80,0.4); background: rgba(63,185,80,0.06); }
.ep-lab-card.ep-lab-flash { box-shadow: 0 0 0 2px rgba(238,0,0,0.55), 0 0 24px rgba(238,0,0,0.25); }
.ep-lab-title { font-size: 0.78rem; font-weight: 700; }
.ep-lab-summary { font-size: 0.64rem; color: var(--text-secondary, rgba(255,255,255,0.6)); line-height: 1.5; }
.ep-lab-steps { margin: 0.25rem 0 0.1rem; padding-left: 1rem; display: flex; flex-direction: column; gap: 0.3rem; }
.ep-lab-steps li { font-size: 0.62rem; color: var(--text-secondary, rgba(255,255,255,0.6)); line-height: 1.45; }
.ep-lab-steps code {
  display: inline-block;
  margin-top: 0.14rem;
  padding: 0.16rem 0.32rem;
  border-radius: 5px;
  background: rgba(0,0,0,0.4);
  color: #ffd7d3;
  font-size: 0.6rem;
  overflow-wrap: anywhere;
}
.ep-lab-hints { font-size: 0.6rem; color: var(--text-muted, rgba(255,255,255,0.35)); }
.ep-lab-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: auto; padding-top: 0.35rem; }
.ep-btn {
  padding: 0.32rem 0.62rem;
  border-radius: 7px;
  border: 1px solid rgba(255,255,255,0.16);
  background: rgba(255,255,255,0.06);
  color: #fff;
  font-size: 0.62rem;
  font-weight: 600;
  cursor: pointer;
}
.ep-btn:hover { border-color: rgba(238,0,0,0.55); background: rgba(238,0,0,0.16); }
.ep-btn.ep-btn-primary {
  border-color: rgba(238,0,0,0.55);
  background: var(--brand-red, #EE0000);
}
.ep-btn.ep-btn-primary:hover { filter: brightness(1.15); }
.ep-btn.ep-btn-ghost { background: transparent; color: var(--text-secondary, rgba(255,255,255,0.6)); }
.ep-btn:disabled { opacity: 0.5; cursor: default; }
.ep-cheat-group { margin-bottom: 0.9rem; }
.ep-cheat-title { font-size: 0.78rem; font-weight: 700; margin-bottom: 0.4rem; }
.ep-cheat-list { display: flex; flex-direction: column; gap: 0.3rem; }
.ep-cheat-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.07);
  background: rgba(255,255,255,0.02);
}
.ep-cheat-item code {
  flex: 1;
  min-width: 0;
  color: #ffd7d3;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 0.63rem;
  overflow-wrap: anywhere;
}
.ep-cheat-note { font-size: 0.6rem; color: var(--text-secondary, rgba(255,255,255,0.6)); max-width: 40%; }
.ep-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 0.75rem; }
.ep-fact-card {
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 12px;
  padding: 0.8rem;
  background: rgba(255,255,255,0.02);
}
.ep-fact-card h4 { font-size: 0.72rem; margin-bottom: 0.4rem; color: var(--brand-orange, #F97316); }
.ep-fact-card p, .ep-fact-card li { font-size: 0.64rem; color: var(--text-secondary, rgba(255,255,255,0.6)); line-height: 1.55; }
.ep-fact-card ul { padding-left: 1rem; display: flex; flex-direction: column; gap: 0.25rem; }
.ep-fact-kv { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 0.6rem; font-size: 0.64rem; }
.ep-fact-kv dt { color: var(--text-muted, rgba(255,255,255,0.35)); }
.ep-fact-kv dd { color: var(--text-primary, rgba(255,255,255,0.92)); }
.ep-fact-note { font-size: 0.6rem; color: var(--text-muted, rgba(255,255,255,0.35)); margin-top: 0.5rem; line-height: 1.5; }
.ep-empty { padding: 1.4rem 0.5rem; text-align: center; font-size: 0.7rem; color: var(--text-muted, rgba(255,255,255,0.35)); }
.ep-live { position: absolute; left: -9999px; }
@media (max-width: 720px) {
  .ep-shell { height: 94vh; width: 99vw; }
  .ep-title { font-size: 1.05rem; }
  .ep-cheat-item { flex-wrap: wrap; }
  .ep-cheat-note { max-width: 100%; }
  .ep-progress-row { flex-wrap: wrap; }
}
`;

export class ExamPrepUI {
  /**
   * @param {object} gameEngine GameEngine instance (may be null in tests).
   * @param {object} scoringEngine ScoringEngine instance (may be null in tests).
   * @param {object} app OpenShiftGamesApp instance (may be null in tests).
   */
  constructor(gameEngine, scoringEngine, app) {
    this.gameEngine = gameEngine || null;
    this.scoringEngine = scoringEngine || null;
    this.app = app || null;
    this.visible = false;
    this.initialized = false;
    this.activeTab = 'objectives';
    this.objectiveQuery = '';
    this.cheatQuery = '';
    this._localState = null;
    this._previousFocus = null;
    this._busSubscriptions = [];
    this._bound = false;

    this._onClick = this._onClick.bind(this);
    this._onInput = this._onInput.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  init() {
    if (this.initialized) return this;
    if (typeof document === 'undefined') return this;

    this._injectStyles();
    this._buildDom();
    this._bindEvents();
    this._subscribeToProgressEvents();
    this.initialized = true;

    // Self-register for convenience (shell also assigns it after construction).
    try {
      const game = typeof window !== 'undefined' ? window.game : null;
      if (game) game.examPrepUI = this;
      if (this.app) this.app.examPrepUI = this;
    } catch {
      /* ignore */
    }

    this._renderAll();
    return this;
  }

  show() {
    this.init();
    if (!this.overlay) return this;
    const wasVisible = this.visible;
    this._previousFocus = typeof document !== 'undefined' ? document.activeElement : null;
    this.visible = true;
    this.overlay.classList.add('active');
    this.overlay.setAttribute('aria-hidden', 'false');
    this._renderAll();
    try {
      this.overlay.querySelector('.ep-close')?.focus?.({ preventScroll: true });
    } catch {
      /* ignore */
    }
    // Emit only on the hidden → visible transition: the shell listens to this
    // event to pause the mission clocks, and duplicate opens must not stack.
    if (!wasVisible) this._emit('ui:exam-prep-opened', { tab: this.activeTab });
    return this;
  }

  hide() {
    if (!this.overlay) {
      this.visible = false;
      return this;
    }
    const wasVisible = this.visible;
    this.visible = false;
    this.overlay.classList.remove('active');
    this.overlay.setAttribute('aria-hidden', 'true');
    try {
      if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
        this._previousFocus.focus({ preventScroll: true });
      }
    } catch {
      /* ignore */
    }
    this._previousFocus = null;
    // Emit only on the visible → hidden transition (no duplicate closes).
    if (wasVisible) this._emit('ui:exam-prep-closed', {});
    return this;
  }

  toggle() {
    return this.visible ? this.hide() : this.show();
  }

  destroy() {
    this._unbindEvents();
    for (const unsubscribe of this._busSubscriptions.splice(0)) {
      try {
        if (typeof unsubscribe === 'function') unsubscribe();
      } catch {
        /* ignore */
      }
    }
    try {
      this.overlay?.remove?.();
      document.getElementById(STYLE_ID)?.remove?.();
    } catch {
      /* ignore */
    }
    this.overlay = null;
    this.initialized = false;
    this.visible = false;
    return this;
  }

  /** Verifier/test hook: total number of official EX280V422 objective bullets. */
  getBulletCount() {
    return EX280_OBJECTIVE_COUNT;
  }

  /** Optional test hook: current mastery summary. */
  getProgressSummary() {
    const snapshot = this._computeSnapshot();
    return {
      mastered: snapshot.masteredCount,
      total: EX280_OBJECTIVE_COUNT,
      percent: snapshot.percent,
      ready: snapshot.ready,
    };
  }

  /** Re-read progress and re-render (used by the shell/verifier after mode changes). */
  refresh() {
    this._localState = null;
    if (this.initialized) this._renderAll();
    return this;
  }

  setTab(tabId) {
    if (!TABS.some((tab) => tab.id === tabId)) return this;
    this.activeTab = tabId;
    this._renderTabs();
    this._renderPanels();
    return this;
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = EX280_STYLES;
    document.head.appendChild(style);
  }

  _buildDom() {
    if (document.getElementById('exam-prep-overlay')) {
      this.overlay = document.getElementById('exam-prep-overlay');
    } else {
      const overlay = document.createElement('div');
      overlay.id = 'exam-prep-overlay';
      overlay.className = '';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'EX280 exam preparation');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.dataset.testid = 'exam-prep';
      overlay.innerHTML = this._shellHtml();
      document.body.appendChild(overlay);
      this.overlay = overlay;
    }

    this.tabButtons = [...this.overlay.querySelectorAll('[data-action="tab"]')];
    this.panels = [...this.overlay.querySelectorAll('.ep-panel')];
    this.objectivesList = this.overlay.querySelector('#ep-objectives-list');
    this.labsList = this.overlay.querySelector('#ep-labs-list');
    this.cheatList = this.overlay.querySelector('#ep-cheat-list');
    this.objectiveSearch = this.overlay.querySelector('#ep-objective-search');
    this.cheatSearch = this.overlay.querySelector('#ep-cheat-search');
    this.progressFill = this.overlay.querySelector('#ep-progress-fill');
    this.progressLabel = this.overlay.querySelector('#ep-progress-label');
    this.readinessBadge = this.overlay.querySelector('#ep-readiness');
  }

  _shellHtml() {
    return `
      <div class="ep-shell" role="document">
        <header class="ep-header">
          <div class="ep-heading">
            <div class="ep-eyebrow">EX280 Prep · ${escapeHtml(EX280_EXAM_FACTS.examCode)}</div>
            <h2 class="ep-title">Red Hat Certified System Administrator in OpenShift exam (EX280)</h2>
            <div class="ep-subtitle">
              EX280V422 · OpenShift ${escapeHtml(EX280_EXAM_FACTS.ocpVersion)} ·
              ${escapeHtml(String(EX280_EXAM_FACTS.durationHours))} h performance-based ·
              ${escapeHtml(String(EX280_OBJECTIVE_COUNT))} bullet points in ${escapeHtml(String(EX280_OBJECTIVE_GROUPS.length))} groups
            </div>
            <div class="ep-note">
              LMS objectives PDF name: Red Hat Certified Specialist in OpenShift Administration ·
              last verified ${escapeHtml(EX280_EXAM_FACTS.lastVerified)}
            </div>
            <div class="ep-head-links">
              <a href="${escapeHtml(EX280_EXAM_FACTS.officialExamUrl)}" target="_blank" rel="noopener noreferrer">Official EX280 exam page</a>
              <a href="${escapeHtml(EX280_EXAM_FACTS.objectivesPdfUrl)}" target="_blank" rel="noopener noreferrer">Objectives by version (PDF)</a>
              <a href="${escapeHtml(EX280_EXAM_FACTS.docsBaseUrl)}" target="_blank" rel="noopener noreferrer">OpenShift 4.22 docs</a>
              <a href="${STUDY_GUIDE_URL}" target="_blank" rel="noopener noreferrer">EX280 study guide (wiki)</a>
            </div>
          </div>
          <button type="button" class="ep-close" data-action="close" data-testid="exam-prep-close" aria-label="Close EX280 Prep">&times;</button>
        </header>

        <nav class="ep-tabs" role="tablist" aria-label="EX280 Prep sections">
          ${TABS.map(
            (tab) => `
            <button type="button" class="ep-tab" role="tab" aria-selected="false"
              data-action="tab" data-tab="${tab.id}" data-testid="${tab.testId}">${escapeHtml(tab.label)}</button>
          `
          ).join('')}
        </nav>

        <div class="ep-progress-row">
          <div class="ep-progress-meta" data-testid="exam-prep-progress">
            <span id="ep-progress-label"><strong>0 / ${escapeHtml(String(EX280_OBJECTIVE_COUNT))}</strong> bullets mastered</span>
          </div>
          <div class="ep-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${escapeHtml(String(EX280_OBJECTIVE_COUNT))}" aria-valuenow="0">
            <div class="ep-progress-fill" id="ep-progress-fill"></div>
          </div>
          <div class="ep-readiness" id="ep-readiness" data-testid="exam-prep-readiness">Keep going</div>
        </div>

        <div class="ep-body">
          <section class="ep-panel" data-tab-panel="objectives" data-testid="exam-prep-panel-objectives" role="tabpanel" aria-label="Objective tracker">
            <div class="ep-toolbar">
              <input type="search" class="ep-search" id="ep-objective-search"
                placeholder="Search objectives, commands or topics…" autocomplete="off" spellcheck="false" aria-label="Search objectives" />
              <span class="ep-hint">Mastered = drill evidence: a quick-lab check passed, or the bullet's own command run successfully in a completed campaign level or lab.</span>
            </div>
            <div id="ep-objectives-list"></div>
          </section>

          <section class="ep-panel" data-tab-panel="quicklabs" data-testid="exam-prep-panel-quick-labs" role="tabpanel" aria-label="Quick labs">
            <div class="ep-toolbar">
              <span class="ep-hint">Short do-it-now drills. Each launches a Sandbox; use the objective tracker and Red Hat docs links for depth.</span>
            </div>
            <div class="ep-lab-grid" id="ep-labs-list"></div>
          </section>

          <section class="ep-panel" data-tab-panel="cheatsheet" data-testid="exam-prep-panel-cheat-sheet" role="tabpanel" aria-label="Cheat sheet">
            <div class="ep-toolbar">
              <input type="search" class="ep-search" id="ep-cheat-search"
                placeholder="Filter oc commands…" autocomplete="off" spellcheck="false" aria-label="Search oc commands" />
              <span class="ep-hint">${escapeHtml(String(EX280_CHEATSHEET.reduce((count, group) => count + group.items.length, 0)))} verified commands.</span>
            </div>
            <div id="ep-cheat-list"></div>
          </section>

          <section class="ep-panel" data-tab-panel="facts" data-testid="exam-prep-panel-exam-facts" role="tabpanel" aria-label="Exam facts">
            <div class="ep-facts">${this._factsHtml()}</div>
          </section>
        </div>
      </div>
      <div class="ep-live" aria-live="polite" id="ep-live-message"></div>
    `;
  }

  _factsHtml() {
    const facts = EX280_EXAM_FACTS;
    return `
      <div class="ep-fact-card">
        <h4>Exam identity</h4>
        <dl class="ep-fact-kv">
          <dt>Exam code</dt><dd data-testid="exam-facts-code">${escapeHtml(facts.examCode)}</dd>
          <dt>redhat.com title</dt><dd>${escapeHtml(facts.examPageTitle)}</dd>
          <dt>LMS objectives PDF name</dt><dd>${escapeHtml(facts.lmsName)}</dd>
          <dt>OpenShift version</dt><dd>${escapeHtml(facts.ocpVersion)}</dd>
          <dt>Last verified</dt><dd>${escapeHtml(facts.lastVerified)}</dd>
        </dl>
        <p class="ep-fact-note">${escapeHtml(facts.namingNote)}</p>
      </div>

      <div class="ep-fact-card">
        <h4>Format</h4>
        <ul>
          <li>Time limit: <strong>${escapeHtml(String(facts.durationHours))}.0 hours</strong>.</li>
          <li>Hands-on, performance-based: perform real tasks on a live OpenShift ${escapeHtml(facts.ocpVersion)} cluster.</li>
          <li>Product documentation is available during the exam; outside assistance is not allowed.</li>
          <li>Results are emailed as a total score; there is no per-task feedback.</li>
        </ul>
        <p class="ep-fact-note">${escapeHtml(facts.persistenceRule)}</p>
      </div>

      <div class="ep-fact-card">
        <h4>Scoring &amp; validity</h4>
        <p>${escapeHtml(facts.scoringNote)}</p>
        <p class="ep-fact-note">Link: <a class="ep-doc-link" href="${escapeHtml(facts.programGuideUrl)}" target="_blank" rel="noopener noreferrer">Red Hat Certification Program Guide</a></p>
      </div>

      <div class="ep-fact-card">
        <h4>Recommended preparation</h4>
        <ul>${facts.recommendedPrep.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      </div>

      <div class="ep-fact-card">
        <h4>Official links</h4>
        <ul>
          <li><a class="ep-doc-link" href="${escapeHtml(facts.officialExamUrl)}" target="_blank" rel="noopener noreferrer">Official EX280 exam page</a></li>
          <li><a class="ep-doc-link" href="${escapeHtml(facts.objectivesPdfUrl)}" target="_blank" rel="noopener noreferrer">Red Hat Exam Objectives by Version (PDF)</a></li>
          <li><a class="ep-doc-link" href="${escapeHtml(facts.docsBaseUrl)}" target="_blank" rel="noopener noreferrer">OpenShift Container Platform ${escapeHtml(facts.ocpVersion)} documentation</a></li>
        </ul>
      </div>

      <div class="ep-fact-card">
        <h4>How this tracker works</h4>
        <p>The tracker covers every official EX280V422 objective bullet in Red Hat's grouping. A bullet becomes
        <strong>Mastered</strong> when a linked campaign level or challenge is completed, or when its quick lab is marked complete.
        Progress is read from the game's scoring engine and survives between sessions.</p>
      </div>
    `;
  }

  _bindEvents() {
    if (this._bound || !this.overlay) return;
    this.overlay.addEventListener('click', this._onClick);
    this.overlay.addEventListener('input', this._onInput);
    document.addEventListener('keydown', this._onKeyDown, true);
    this._bound = true;
  }

  _unbindEvents() {
    if (!this._bound) return;
    try {
      const overlay = this.overlay || document.getElementById('exam-prep-overlay');
      overlay?.removeEventListener?.('click', this._onClick);
      overlay?.removeEventListener?.('input', this._onInput);
      document.removeEventListener('keydown', this._onKeyDown, true);
    } catch {
      /* ignore */
    }
    this._bound = false;
  }

  _subscribeToProgressEvents() {
    const bus = this._bus();
    if (!bus || typeof bus.on !== 'function') return;
    const events = [
      'campaign:level-completed',
      'campaign:completed',
      'challenge:completed',
      'exam-prep:progress',
      'level:completed',
      'challenge:complete',
    ];
    for (const event of events) {
      try {
        const unsubscribe = bus.on(event, () => {
          if (this.visible) this.refresh();
        });
        this._busSubscriptions.push(unsubscribe);
      } catch {
        /* ignore unknown events */
      }
    }
  }

  // ── event handling ────────────────────────────────────────────────────────

  _onClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.dataset.action;
    switch (action) {
      case 'close':
        event.preventDefault();
        this.hide();
        break;
      case 'tab':
        event.preventDefault();
        this.setTab(target.dataset.tab || 'objectives');
        break;
      case 'copy-command':
        event.preventDefault();
        this._copyCommand(target.dataset.command || '');
        break;
      case 'start-level':
        event.preventDefault();
        this._startLevel(Number.parseInt(target.dataset.level, 10));
        break;
      case 'start-challenge':
        event.preventDefault();
        this._startChallenge(Number.parseInt(target.dataset.challenge, 10));
        break;
      case 'open-lab':
        event.preventDefault();
        this._focusLab(target.dataset.labId || '');
        break;
      case 'launch-lab':
        event.preventDefault();
        this._launchLab(target.dataset.labId || '');
        break;
      case 'mark-lab':
        event.preventDefault();
        this._markLabComplete(target.dataset.objectiveId || '', target.dataset.labId || '');
        break;
      default:
        break;
    }
  }

  _onInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id === 'ep-objective-search') {
      this.objectiveQuery = target.value.trim();
      this._renderObjectivesList();
    } else if (target.id === 'ep-cheat-search') {
      this.cheatQuery = target.value.trim();
      this._renderCheatList();
    }
  }

  _onKeyDown(event) {
    if (!this.visible) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.hide();
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  _startLevel(levelId) {
    if (!Number.isFinite(levelId) || levelId < 1) return;
    try {
      const app = this._app();
      this.hide();
      app?.startMode?.('campaign');
      app?.launchGame?.('campaign', levelId);
    } catch (error) {
      this._liveMessage(`Could not launch campaign level ${levelId}: ${error?.message || error}`);
    }
  }

  _startChallenge(challengeId) {
    if (!Number.isFinite(challengeId) || challengeId < 1) return;
    try {
      const app = this._app();
      this.hide();
      app?.launchGame?.('challenge', challengeId);
    } catch (error) {
      this._liveMessage(`Could not launch challenge ${challengeId}: ${error?.message || error}`);
    }
  }

  _launchLab(labId) {
    const lab = EX280_QUICK_LABS.find((entry) => entry.id === labId);
    if (!lab) return;
    this._markExamPrep(lab.objectiveId, 'practiced');
    try {
      const app = this._app();
      this.hide();
      app?.startMode?.('sandbox');
      const firstCommand = lab.steps?.[0]?.command || '';
      const startSandbox = () => {
        try {
          const manifestEngine = typeof window !== 'undefined' ? window.game?.manifestEngine : null;
          if (manifestEngine?.resetFiles) manifestEngine.resetFiles();
          if (app?.modeInstance?.setupQuickLab) app.modeInstance.setupQuickLab(lab);
        } catch (error) {
          console.warn('EX280 Prep: quick lab setup hook failed:', error?.message || error);
        }
        const message = firstCommand
          ? `Quick lab “${lab.title}” ready in Sandbox - start with: ${firstCommand}`
          : `Quick lab “${lab.title}” ready in Sandbox.`;
        try {
          app?._showToast?.(message);
        } catch {
          /* ignore */
        }
        this._liveMessage(message);
      };
      // Give the shell a beat to switch into game mode before seeding hints.
      if (typeof setTimeout === 'function') setTimeout(startSandbox, 450);
      else startSandbox();
      this._renderLabs();
    } catch (error) {
      this._liveMessage(`Could not launch quick lab: ${error?.message || error}`);
    }
  }

  _focusLab(labId) {
    const lab = EX280_QUICK_LABS.find((entry) => entry.id === labId);
    if (!lab) return;
    this.setTab('quicklabs');
    try {
      const card = this.overlay?.querySelector(`[data-testid="exam-lab-${lab.id}"]`);
      if (card) {
        card.classList.add('ep-lab-flash');
        card.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        setTimeout(() => card.classList.remove('ep-lab-flash'), 1600);
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Evaluate a quick lab's `check` objectives against the LIVE cluster state.
   * "Mark complete" is NOT self-attested: the same check the Sandbox tracker
   * runs must pass here before the linked EX280 bullet is marked mastered.
   * @returns {{pass: boolean, completed: number, total: number, pending: string[]}}
   */
  _evaluateLabCheck(lab) {
    const checks = Array.isArray(lab?.check) ? lab.check : [];
    if (checks.length === 0) return { pass: true, completed: 0, total: 0, pending: [] };
    const game = typeof window !== 'undefined' ? window.game : null;
    const clusterState = game?.gameEngine?.cluster || null;
    if (!clusterState) {
      return {
        pass: false,
        completed: 0,
        total: checks.length,
        pending: [
          'Launch the lab in Sandbox first - completion is checked against the live cluster.',
        ],
      };
    }
    const progress = createObjectiveProgress(checks);
    try {
      evaluateObjectives(
        checks,
        {
          clusterState,
          gameEngine: game?.gameEngine || null,
          incidentEngine: game?.incidentEngine || null,
          scoringEngine: this._scoring(),
          manifestEngine: game?.manifestEngine || null,
        },
        { progress, recheckCompleted: true }
      );
    } catch (error) {
      return {
        pass: false,
        completed: 0,
        total: checks.length,
        pending: [`Could not evaluate the lab checks: ${error?.message || error}`],
      };
    }
    const pending = progress
      .filter((objective) => !objective.completed)
      .map((objective) => objective.label || objective.type);
    return {
      pass: pending.length === 0,
      completed: progress.filter((objective) => objective.completed).length,
      total: progress.length,
      pending,
    };
  }

  _markLabComplete(objectiveId, labId) {
    if (!objectiveId) return;
    const lab = EX280_QUICK_LABS.find((entry) => entry.id === labId);
    const label = lab ? lab.title : objectiveId;
    const result = lab
      ? this._evaluateLabCheck(lab)
      : {
          pass: false,
          completed: 0,
          total: 0,
          pending: ['Unknown quick lab - launch it in Sandbox first.'],
        };
    if (!result.pass) {
      const detail = result.pending.slice(0, 3).join('; ');
      const message = `“${label}” not marked complete yet - the live check is ${result.completed}/${result.total}. Still to do: ${detail}`;
      this._liveMessage(message);
      try {
        this._app()?._showToast?.(message);
      } catch {
        /* ignore */
      }
      return false;
    }
    this._markExamPrep(objectiveId, 'mastered');
    this._renderAll();
    const message = `“${label}” check passed (${result.completed}/${result.total}) - ${this.getProgressSummary().mastered}/${EX280_OBJECTIVE_COUNT} bullets with verified evidence.`;
    this._liveMessage(message);
    try {
      this._app()?._showToast?.(message);
    } catch {
      /* ignore */
    }
    return true;
  }

  _copyCommand(command) {
    if (!command) return;
    const done = () => {
      const message = `Copied: ${command}`;
      this._liveMessage(message);
      try {
        this._app()?._showToast?.(`Copied: ${command}`);
      } catch {
        /* ignore */
      }
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(command)
          .then(done)
          .catch(() => this._fallbackCopy(command, done));
        return;
      }
    } catch {
      /* ignore */
    }
    this._fallbackCopy(command, done);
  }

  _fallbackCopy(command, done) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = command;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      done();
    } catch {
      this._liveMessage(`Copy this command: ${command}`);
    }
  }

  _liveMessage(message) {
    try {
      const region = this.overlay?.querySelector('#ep-live-message');
      if (region) region.textContent = message;
    } catch {
      /* ignore */
    }
  }

  _emit(event, data) {
    try {
      const bus = this._bus();
      bus?.emit?.(event, data);
    } catch {
      /* ignore */
    }
  }

  _bus() {
    try {
      if (this.gameEngine?.eventBus) return this.gameEngine.eventBus;
      if (typeof window !== 'undefined' && window.game?.engine) return window.game.engine;
      if (typeof window !== 'undefined' && window.game?.gameEngine?.eventBus)
        return window.game.gameEngine.eventBus;
    } catch {
      /* ignore */
    }
    return null;
  }

  _app() {
    if (this.app) return this.app;
    try {
      return typeof window !== 'undefined'
        ? window.game?.app || window.__openshiftGamesApp || null
        : null;
    } catch {
      return null;
    }
  }

  // ── progress ──────────────────────────────────────────────────────────────

  _scoring() {
    if (this.scoringEngine) return this.scoringEngine;
    try {
      return typeof window !== 'undefined' ? window.game?.scoringEngine || null : null;
    } catch {
      return null;
    }
  }

  _loadLocalState() {
    if (this._localState) return this._localState;
    const state = {};
    try {
      const raw =
        typeof localStorage !== 'undefined' ? localStorage.getItem(LOCAL_STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [id, entry] of Object.entries(parsed)) {
            if (!entry) continue;
            if (entry === 'mastered' || entry === 'practiced') state[id] = entry;
            else if (entry.state === 'mastered' || entry.state === 'practiced')
              state[id] = entry.state;
          }
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
    this._localState = state;
    return state;
  }

  _saveLocalState() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(this._localState || {}));
    } catch {
      /* ignore quota/security errors */
    }
  }

  _getExamPrepState() {
    const scoring = this._scoring();
    // Preferred API (modes-dev adds these to ScoringEngine).
    try {
      if (scoring && typeof scoring.getExamPrepProgress === 'function') {
        const normalized = this._normalizeExamPrep(scoring.getExamPrepProgress());
        if (normalized) return normalized;
      }
    } catch {
      /* ignore */
    }
    // Fallback: getProgress().examPrep.
    try {
      if (scoring && typeof scoring.getProgress === 'function') {
        const progress = scoring.getProgress();
        const normalized = this._normalizeExamPrep(progress?.examPrep);
        if (normalized) return normalized;
      }
    } catch {
      /* ignore */
    }
    // Final fallback: local storage state.
    return { ...this._loadLocalState() };
  }

  _normalizeExamPrep(raw) {
    if (!raw) return null;
    const state = {};
    const add = (id, value) => {
      if (!id) return;
      const normalized =
        value === 'mastered' || value?.state === 'mastered'
          ? 'mastered'
          : value === 'practiced' || value?.state === 'practiced'
            ? 'practiced'
            : null;
      if (!normalized) return;
      if (state[id] !== 'mastered') state[id] = normalized;
    };
    if (Array.isArray(raw)) {
      for (const id of raw) add(id, 'mastered');
      return state;
    }
    if (typeof raw !== 'object') return null;
    const nested = raw.objectives || raw.bullets || raw.states;
    if (nested) return this._normalizeExamPrep(nested) || state;
    if (Array.isArray(raw.mastered)) for (const id of raw.mastered) add(id, 'mastered');
    if (Array.isArray(raw.practiced)) for (const id of raw.practiced) add(id, 'practiced');
    if (raw.mastered && typeof raw.mastered === 'object' && !Array.isArray(raw.mastered)) {
      for (const [id, value] of Object.entries(raw.mastered)) if (value) add(id, 'mastered');
    }
    const reserved = new Set([
      'objectives',
      'bullets',
      'states',
      'mastered',
      'practiced',
      'updatedAt',
    ]);
    for (const [id, value] of Object.entries(raw)) {
      if (reserved.has(id)) continue;
      add(id, value);
    }
    return state;
  }

  _markExamPrep(objectiveId, state) {
    if (!objectiveId) return;
    const scoring = this._scoring();
    let delegated = false;
    try {
      if (scoring && typeof scoring.markExamPrep === 'function') {
        scoring.markExamPrep(objectiveId, state);
        delegated = true;
      }
    } catch (error) {
      console.warn('EX280 Prep: ScoringEngine.markExamPrep failed:', error?.message || error);
    }
    if (!delegated) {
      const local = this._loadLocalState();
      if (local[objectiveId] !== 'mastered' || state === 'mastered') {
        local[objectiveId] = state;
        this._localState = local;
        this._saveLocalState();
      }
    } else {
      // Mirror into the local fallback so progress stays visible if the API is later unavailable.
      const local = this._loadLocalState();
      if (local[objectiveId] !== 'mastered') {
        local[objectiveId] = state;
        this._localState = local;
        this._saveLocalState();
      }
    }
  }

  _progressData() {
    const scoring = this._scoring();
    let progress = {};
    try {
      if (scoring && typeof scoring.getProgress === 'function')
        progress = scoring.getProgress() || {};
    } catch {
      progress = {};
    }
    return {
      campaignProgress: progress?.campaignProgress || {},
      challengeProgress: progress?.challengeProgress || {},
      // Drill-run-scoped command evidence (#20): { 'campaign:12': [...], ... }.
      // Sandbox/chaos commands never appear here, so free play cannot inflate
      // the EX280 readiness verdict.
      drillCommandEvidence:
        progress?.drillCommandEvidence && typeof progress.drillCommandEvidence === 'object'
          ? progress.drillCommandEvidence
          : {},
      objectiveEvidence:
        progress?.objectiveEvidence && typeof progress.objectiveEvidence === 'object'
          ? progress.objectiveEvidence
          : {},
    };
  }

  _isLocked(done, map) {
    if (!map || typeof map !== 'object') return false;
    const lookup = (key) => done[key] ?? done[String(key)];
    return Boolean(lookup(map));
  }

  /** Bullets the simulator cannot exercise (no web console UI exists). */
  _isConsoleOnlyBullet(bullet) {
    return /web console/i.test(String(bullet?.title || ''));
  }

  /**
   * Does one of the bullet's own example commands appear in the successful
   * command evidence? Uses the shared normalised signature so `pods`/`pod`,
   * `deploy`/`deployment` and short resource names match.
   */
  _bulletHasCommandEvidence(bullet, commandEvidence) {
    const commands = Array.isArray(bullet?.commands) ? bullet.commands : [];
    if (commands.length === 0 || commandEvidence.length === 0) return false;
    const evidenceSignatures = commandEvidence.map((raw) => commandSignature(raw)).filter(Boolean);
    if (evidenceSignatures.length === 0) return false;
    for (const command of commands) {
      const wanted = commandSignature(command);
      if (!wanted) continue;
      const wantsOutputFormatting = /(?:^|\s)(?:-o|--output)(?:=|\s)/i.test(String(command));
      if (wantsOutputFormatting) {
        // "Format output with -o wide/yaml/json" style bullets: require an
        // output-formatting flag on an actual oc get/describe command.
        const formatted = commandEvidence.some(
          (raw) =>
            /(?:^|\s)(?:-o|--output)(?:=|\s)/i.test(raw) && /^oc\s+(get|describe)\b/i.test(raw)
        );
        if (formatted) return true;
        continue;
      }
      for (const signature of evidenceSignatures) {
        if (signature === wanted) return true;
        // Allow the learner to run a more specific form of the example command
        // (`oc get pods -o yaml` for `oc get pods`) or vice versa.
        if (signature.startsWith(`${wanted} `) || wanted.startsWith(`${signature} `)) return true;
      }
    }
    return false;
  }

  /**
   * Issue #42-5: objective-level evidence. A linked drill completed through live
   * objective evaluation records the objective TYPES it satisfied
   * (`level:<id>` / `challenge:<id>`). Bullets that declare `objectiveTypes`
   * (e.g. the SCC bullets after L17, the Job/CronJob bullets after L19/L20) are
   * evidenced by those completed objectives even when the learner used the
   * incident-panel resolution action instead of typing the exact command.
   */
  _bulletHasObjectiveEvidence(bullet, objectiveEvidence, scope, id) {
    const wanted = Array.isArray(bullet?.objectiveTypes) ? bullet.objectiveTypes : [];
    if (wanted.length === 0 || !objectiveEvidence || typeof objectiveEvidence !== 'object')
      return false;
    const keys = [`${scope}:${id}`, scope === 'level' ? `campaign:${id}` : `level:${id}`];
    const types = new Set();
    for (const key of keys) {
      for (const entry of Array.isArray(objectiveEvidence[key]) ? objectiveEvidence[key] : []) {
        types.add(String(entry).toLowerCase());
      }
    }
    return wanted.some((type) => types.has(String(type).toLowerCase()));
  }

  /**
   * Progress-map entry for a level/challenge id (numeric or string keys).
   * @param {object} map campaignProgress / challengeProgress
   * @param {number|string} id
   * @returns {object|null}
   */
  _progressEntry(map, id) {
    if (!map || typeof map !== 'object') return null;
    return map[id] ?? map[String(id)] ?? null;
  }

  /**
   * Parse a `drillCommandEvidence` key. Only campaign levels and labs
   * (challenges) are recorded by ScoringEngine; sandbox/chaos runs have no
   * active drill key, so anything else is ignored defensively.
   * @param {string} key
   * @returns {{scope: string, id: number}|null}
   */
  _drillEvidenceKey(key) {
    const match = /^(campaign|challenge):(\d+)$/.exec(String(key || ''));
    if (!match) return null;
    return { scope: match[1], id: Number(match[2]) };
  }

  /** Has the campaign level / lab referenced by a drill key been completed? */
  _drillKeyCompleted(scope, id, campaignProgress, challengeProgress) {
    const progress = scope === 'challenge' ? challengeProgress : campaignProgress;
    return Boolean(this._progressEntry(progress, id)?.completed);
  }

  /**
   * Evidence-based bullet status (#14 + #20 + #42-5 + #48-2):
   *  - mastered: a quick lab linked to the bullet passed its live check, OR one
   *    of the bullet's own commands was run during a COMPLETED campaign level or
   *    lab. The completed drill does not have to be one of the bullet's mapped
   *    levels (#48-2: evidence follows the command, not the mapping); a
   *    completed mapped drill can also be evidenced by the bullet's
   *    `objectiveTypes` recorded through live objective evaluation.
   *  - practiced: a mapped level/lab was started or completed without matching
   *    completed-drill evidence, or the bullet's own command only appears in a
   *    drill that was never completed.
   *  - todo: no evidence at all.
   * Commands typed in Sandbox/Chaos are never recorded against a drill, so free
   * play cannot inflate the verdict. Console-only bullets can never be
   * "mastered" here (the simulator has no web console UI).
   */
  _bulletStatus(bullet, examPrep, campaignProgress, challengeProgress, progressData = {}) {
    const drillEvidence = progressData.drillCommandEvidence || {};
    const objectiveEvidence = progressData.objectiveEvidence || {};
    const examState = examPrep[bullet.id];
    // 1) Explicit quick-lab check evidence (objectiveId + objectiveIds links).
    if (examState === 'mastered') return 'mastered';
    for (const quickLabId of bullet.quickLabs || []) {
      const lab = EX280_QUICK_LABS.find((entry) => entry.id === quickLabId);
      if (!lab) continue;
      if (examPrep[lab.objectiveId] === 'mastered') return 'mastered';
      if ((lab.objectiveIds || []).some((id) => examPrep[id] === 'mastered')) {
        const linked =
          lab.objectiveId === bullet.id || (lab.objectiveIds || []).includes(bullet.id);
        if (linked) return 'mastered';
      }
    }
    const consoleOnly = this._isConsoleOnlyBullet(bullet);
    // 2) Evidence from the bullet's MAPPED drills: a completed linked campaign
    // level or lab whose run recorded one of the bullet's own commands, or a
    // live objective type it declares (#42-5).
    let linkedDrillCompleted = false;
    let linkedDrillEvidence = false;
    for (const levelId of bullet.levels || []) {
      const entry = this._progressEntry(campaignProgress, levelId);
      if (!entry?.completed) continue;
      linkedDrillCompleted = true;
      const evidence = drillEvidence[`campaign:${levelId}`] || [];
      if (
        this._bulletHasCommandEvidence(bullet, evidence) ||
        this._bulletHasObjectiveEvidence(bullet, objectiveEvidence, 'level', levelId)
      ) {
        linkedDrillEvidence = true;
        break;
      }
    }
    if (!linkedDrillEvidence) {
      for (const challengeId of bullet.challenges || []) {
        const entry = this._progressEntry(challengeProgress, challengeId);
        if (!entry?.completed) continue;
        linkedDrillCompleted = true;
        const evidence = drillEvidence[`challenge:${challengeId}`] || [];
        if (
          this._bulletHasCommandEvidence(bullet, evidence) ||
          this._bulletHasObjectiveEvidence(bullet, objectiveEvidence, 'challenge', challengeId)
        ) {
          linkedDrillEvidence = true;
          break;
        }
      }
    }
    // 3) Issue #48-2: readiness evidence follows the COMMAND, not the level
    // mapping. One of the bullet's own successful commands counts from ANY
    // campaign level or lab bucket; a matching command in a COMPLETED drill
    // masters the bullet, in an unfinished drill it still counts as evidence
    // (practiced). Sandbox/chaos commands are never recorded in this map (#20),
    // so free play cannot inflate the verdict.
    let anyDrillCommandEvidence = false;
    let completedDrillCommandEvidence = false;
    for (const [key, entries] of Object.entries(drillEvidence)) {
      const drill = this._drillEvidenceKey(key);
      if (!drill) continue;
      const evidence = Array.isArray(entries) ? entries : [];
      if (!this._bulletHasCommandEvidence(bullet, evidence)) continue;
      anyDrillCommandEvidence = true;
      if (this._drillKeyCompleted(drill.scope, drill.id, campaignProgress, challengeProgress)) {
        completedDrillCommandEvidence = true;
        break;
      }
    }
    if (!consoleOnly && (linkedDrillEvidence || completedDrillCommandEvidence)) return 'mastered';
    if (examState === 'practiced') return 'practiced';
    if (linkedDrillCompleted || anyDrillCommandEvidence) return 'practiced';
    for (const levelId of bullet.levels || []) {
      if (this._progressEntry(campaignProgress, levelId)) return 'practiced';
    }
    for (const challengeId of bullet.challenges || []) {
      if (this._progressEntry(challengeProgress, challengeId)) return 'practiced';
    }
    return 'todo';
  }

  _computeSnapshot() {
    const examPrep = this._getExamPrepState();
    const progressData = this._progressData();
    const { campaignProgress, challengeProgress } = progressData;
    const statuses = new Map();
    let masteredCount = 0;
    let evidenceCount = 0;
    for (const bullet of EX280_OBJECTIVE_BULLETS) {
      const status = this._bulletStatus(
        bullet,
        examPrep,
        campaignProgress,
        challengeProgress,
        progressData
      );
      statuses.set(bullet.id, status);
      if (status === 'mastered') masteredCount += 1;
      if (status !== 'todo') evidenceCount += 1;
    }
    const percent =
      EX280_OBJECTIVE_COUNT > 0 ? Math.round((masteredCount / EX280_OBJECTIVE_COUNT) * 100) : 0;
    const ready = masteredCount / (EX280_OBJECTIVE_COUNT || 1) >= EX280_READINESS_THRESHOLD;
    return { examPrep, statuses, masteredCount, evidenceCount, percent, ready, progressData };
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  _renderAll() {
    if (!this.initialized) return;
    this._renderTabs();
    this._renderProgress();
    this._renderObjectivesList();
    this._renderLabs();
    this._renderCheatList();
    this._renderPanels();
  }

  _renderTabs() {
    for (const button of this.tabButtons || []) {
      const isActive = button.dataset.tab === this.activeTab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  _renderPanels() {
    for (const panel of this.panels || []) {
      panel.classList.toggle('active', panel.dataset.tabPanel === this.activeTab);
    }
  }

  _renderProgress() {
    const snapshot = this._computeSnapshot();
    if (this.progressFill) {
      this.progressFill.style.width = `${snapshot.percent}%`;
      // Progress-bar colour follows the readiness verdict: red < 60%,
      // amber 60–89%, green once the coverage threshold is met (#14).
      const ready = snapshot.ready;
      const almost = !ready && snapshot.percent >= 60;
      this.progressFill.classList.toggle('is-ready', ready);
      this.progressFill.classList.toggle('is-close', almost);
      this.progressFill.classList.toggle('is-danger', !ready && !almost);
    }
    if (this.progressLabel) {
      this.progressLabel.innerHTML = `<strong>${snapshot.masteredCount} / ${EX280_OBJECTIVE_COUNT}</strong> bullets with verified evidence · ${snapshot.percent}%`;
    }
    if (this.readinessBadge) {
      const ready = snapshot.ready;
      const almost = !ready && snapshot.percent >= 60;
      this.readinessBadge.classList.toggle('is-ready', ready);
      this.readinessBadge.classList.toggle('is-close', almost);
      this.readinessBadge.textContent = ready
        ? 'Drills verified'
        : almost
          ? 'Almost there'
          : 'Keep going';
      this.readinessBadge.title = `Evidence threshold: ${Math.round(EX280_READINESS_THRESHOLD * 100)}% of bullets have drill evidence (a passed quick-lab check, or the bullet's own commands run in a completed campaign level or lab). Tracked study coverage - not a Red Hat pass prediction.`;
    }
    const track = this.overlay?.querySelector('.ep-progress-track');
    if (track) track.setAttribute('aria-valuenow', String(snapshot.masteredCount));
    this._snapshot = snapshot;
  }

  _matchesQuery(query, ...values) {
    if (!query) return true;
    const needle = query.toLowerCase();
    return values.some((value) =>
      String(value ?? '')
        .toLowerCase()
        .includes(needle)
    );
  }

  _renderObjectivesList() {
    if (!this.objectivesList) return;
    const snapshot = this._snapshot || this._computeSnapshot();
    const query = this.objectiveQuery;
    let visibleCount = 0;
    const html = EX280_OBJECTIVE_GROUPS.map((group) => {
      const bullets = group.bullets.filter((bullet) => {
        const matches = this._matchesQuery(
          query,
          bullet.title,
          bullet.summary,
          bullet.id,
          ...(bullet.commands || [])
        );
        if (matches) visibleCount += 1;
        return matches;
      });
      if (bullets.length === 0) return '';
      const masteredInGroup = bullets.filter(
        (bullet) => snapshot.statuses.get(bullet.id) === 'mastered'
      ).length;
      return `
        <div class="ep-group" data-testid="exam-group-${escapeHtml(group.id)}">
          <div class="ep-group-head">
            <div class="ep-group-title">${escapeHtml(group.title)}</div>
            <div class="ep-group-count">${masteredInGroup}/${bullets.length} verified</div>
          </div>
          ${bullets.map((bullet) => this._bulletHtml(bullet, snapshot.statuses.get(bullet.id) || 'todo')).join('')}
        </div>
      `;
    }).join('');

    this.objectivesList.innerHTML =
      html || '<div class="ep-empty">No objectives match your search.</div>';
    const hint = this.overlay?.querySelector('.ep-hint');
    if (hint && query) {
      hint.textContent = `${visibleCount} of ${EX280_OBJECTIVE_COUNT} objectives match “${query}”.`;
    } else if (hint) {
      hint.textContent =
        "Mastered = drill evidence: a quick-lab check passed, or the bullet's own command run successfully in a completed campaign level or lab. A completed level alone only counts as Practiced.";
    }
  }

  _bulletHtml(bullet, statusKey) {
    const consoleOnly = this._isConsoleOnlyBullet(bullet);
    const effectiveStatus = consoleOnly && statusKey === 'mastered' ? 'practiced' : statusKey;
    const meta = STATUS_META[effectiveStatus] || STATUS_META.todo;
    const statusTitle = consoleOnly
      ? 'Documentation only: the simulator has no web-console UI, so this bullet cannot be verified here - use the docs link.'
      : "Mastered = a passed quick-lab check, or this bullet's own command run successfully in a completed campaign level or lab.";
    const commands = (bullet.commands || [])
      .map(
        (command) => `
      <div class="ep-cmd-row">
        <code>${escapeHtml(command)}</code>
        <button type="button" class="ep-icon-btn" data-action="copy-command"
          data-command="${escapeHtml(command)}" title="Copy command">Copy</button>
      </div>
    `
      )
      .join('');
    const levelChips = (bullet.levels || [])
      .map(
        (levelId) => `
      <button type="button" class="ep-chip" data-action="start-level" data-level="${levelId}"
        title="Start campaign level ${levelLabel(levelId)}: ${escapeHtml(levelTitle(levelId))}">Level ${levelLabel(levelId)}</button>
    `
      )
      .join('');
    const challengeChips = (bullet.challenges || [])
      .map(
        (challengeId) => `
      <button type="button" class="ep-chip" data-action="start-challenge" data-challenge="${challengeId}"
        title="Start challenge ${challengeId}: ${escapeHtml(challengeTitle(challengeId))}">Challenge ${challengeId}</button>
    `
      )
      .join('');
    const labChips = (bullet.quickLabs || [])
      .map((labId) => {
        const lab = EX280_QUICK_LABS.find((entry) => entry.id === labId);
        if (!lab) return '';
        return `<button type="button" class="ep-chip ep-chip-lab" data-action="open-lab" data-lab-id="${escapeHtml(lab.id)}"
        title="Open quick lab: ${escapeHtml(lab.title)}">Lab: ${escapeHtml(lab.title)}</button>`;
      })
      .join('');
    return `
      <div class="ep-bullet" data-testid="exam-objective-${escapeHtml(bullet.id)}">
        <div class="ep-bullet-head">
          <div class="ep-bullet-title">${escapeHtml(bullet.title)}</div>
          <span class="ep-status ${meta.className}" title="${escapeHtml(statusTitle)}">${meta.label}${consoleOnly ? ' · docs only' : ''}</span>
        </div>
        <div class="ep-bullet-summary">${escapeHtml(bullet.summary)}</div>
        <div class="ep-cmds">${commands}</div>
        <div class="ep-links">
          ${levelChips}${challengeChips}${labChips}
          <a class="ep-doc-link" href="${escapeHtml(bullet.docsUrl)}" target="_blank" rel="noopener noreferrer">Open Red Hat docs →</a>
        </div>
      </div>
    `;
  }

  _renderLabs() {
    if (!this.labsList) return;
    const snapshot = this._snapshot || this._computeSnapshot();
    const examPrep = snapshot.examPrep || {};
    this.labsList.innerHTML = EX280_QUICK_LABS.map((lab) => {
      const objective = getEX280ObjectiveById(lab.objectiveId);
      const isDone =
        examPrep[lab.objectiveId] === 'mastered' ||
        (lab.objectiveIds || []).some((id) => examPrep[id] === 'mastered');
      const steps = (lab.steps || [])
        .map(
          (step) => `
        <li>${escapeHtml(step.text)}${step.command ? `<br /><code>${escapeHtml(step.command)}</code>` : ''}</li>
      `
        )
        .join('');
      const hints = (lab.hints || [])
        .map((hint) => `<div class="ep-lab-hints">Tip: ${escapeHtml(hint)}</div>`)
        .join('');
      return `
        <div class="ep-lab-card ${isDone ? 'is-done' : ''}" data-testid="exam-lab-${escapeHtml(lab.id)}">
          <div class="ep-lab-title">${escapeHtml(lab.title)}</div>
          <div class="ep-lab-summary">${escapeHtml(lab.summary)}</div>
          ${objective ? `<div class="ep-lab-hints">Objective: ${escapeHtml(objective.title)}</div>` : ''}
          <ol class="ep-lab-steps">${steps}</ol>
          ${hints}
          <div class="ep-lab-actions">
            <button type="button" class="ep-btn ep-btn-primary" data-action="launch-lab" data-lab-id="${escapeHtml(lab.id)}">Launch in Sandbox</button>
            <button type="button" class="ep-btn ${isDone ? 'ep-btn-ghost' : ''}" data-action="mark-lab"
              data-lab-id="${escapeHtml(lab.id)}" data-objective-id="${escapeHtml(lab.objectiveId)}"
              title="${isDone ? 'Lab check already passed' : 'Evaluates the lab check against the live Sandbox cluster before marking the bullet complete'}"
              ${isDone ? 'disabled' : ''}>${isDone ? 'Completed' : 'Check & mark complete'}</button>
            <a class="ep-doc-link" href="${escapeHtml(lab.docsUrl)}" target="_blank" rel="noopener noreferrer">Docs →</a>
          </div>
        </div>
      `;
    }).join('');
  }

  _renderCheatList() {
    if (!this.cheatList) return;
    const query = this.cheatQuery;
    let visibleItems = 0;
    const html = EX280_CHEATSHEET.map((group) => {
      const items = group.items.filter((item) => this._matchesQuery(query, item.cmd, item.note));
      if (items.length === 0) return '';
      visibleItems += items.length;
      const rows = items
        .map(
          (item) => `
        <div class="ep-cheat-item">
          <code>${escapeHtml(item.cmd)}</code>
          <button type="button" class="ep-icon-btn" data-action="copy-command"
            data-command="${escapeHtml(item.cmd)}" title="Copy command">Copy</button>
          <span class="ep-cheat-note">${escapeHtml(item.note)}</span>
        </div>
      `
        )
        .join('');
      return `
        <div class="ep-cheat-group" data-testid="exam-cheat-${escapeHtml(group.id)}">
          <div class="ep-cheat-title">${escapeHtml(group.title)} <a class="ep-doc-link" href="${escapeHtml(group.docsUrl)}" target="_blank" rel="noopener noreferrer">docs →</a></div>
          <div class="ep-cheat-list">${rows}</div>
        </div>
      `;
    }).join('');
    this.cheatList.innerHTML = html || '<div class="ep-empty">No commands match your filter.</div>';
    const hint = this.overlay?.querySelector('[data-tab-panel="cheatsheet"] .ep-hint');
    if (hint) {
      const total = EX280_CHEATSHEET.reduce((count, group) => count + group.items.length, 0);
      hint.textContent = query
        ? `${visibleItems} of ${total} commands match “${query}”.`
        : `${total} verified commands.`;
    }
  }
}

// Aliases requested by the shell contract (`ExamPrepUI || ExamPrepMode || ExamPrep || default`).
export const ExamPrepMode = ExamPrepUI;
export const ExamPrep = ExamPrepUI;
export default ExamPrepUI;
