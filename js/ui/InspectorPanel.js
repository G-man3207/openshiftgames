/**
 * InspectorPanel — right-hand drawer for a selected OpenShift resource.
 *
 * Tabs: Overview / YAML / Describe / Events.
 *   - Overview: status, metadata, labels/annotations plus kind-specific fields
 *     (Project, Route, BuildConfig/Build/ImageStream, Template, Subscription,
 *     SCC, ResourceQuota/LimitRange/ClusterResourceQuota, ClusterOperator/
 *     ClusterVersion, User/Group, Service, Deployment, Pod, Node) and the
 *     feature-detected action buttons.
 *   - YAML: Rich resource `toYAML({includeStatus:true})` or the shared
 *     ManifestSerializer through `toManifestYAML(resource, {includeStatus:true})`.
 *     Only apply-clean fields are emitted — never simulator `_` internals.
 *   - Describe: `oc describe` output via the resource's own `toDescribe()` when
 *     available, with a kind fallback and the shared generic formatter.
 *   - Events: real resource events (no synthetic samples).
 *
 * Actions use `window.game.gameEngine` handlers when present (exposeService,
 * startBuild, rollout, scale, addSCC*, deleteResource) and otherwise emit the
 * existing `ui:*` events consumed by index.html.
 *
 * Browser-only DOM work happens in init(); importing the module is Node-safe.
 */

import { KIND_DEFS, toManifestYAML } from '../data/kindRegistry.js';
import { describeResource } from '../resources/ManifestSerializer.js';
import { visualStatusFor } from '../rendering/ResourceStatus.js';

const PLATFORM_LABEL = 'OpenShift 4.22';
const SCALE_KINDS = new Set(['Deployment', 'ReplicaSet', 'StatefulSet']);
const ROLLOUT_KINDS = new Set(['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet']);
const IDENTITY_KINDS = new Set(['User', 'Group', 'ServiceAccount']);

const KIND_ICONS = {
  Project: 'PRJ',
  Node: 'N',
  ClusterResourceQuota: 'CRQ',
  Pod: 'P',
  Deployment: 'D',
  ReplicaSet: 'RS',
  StatefulSet: 'STS',
  DaemonSet: 'DS',
  Job: 'J',
  CronJob: 'CJ',
  BuildConfig: 'BC',
  Build: 'B',
  ImageStream: 'IS',
  Service: 'SVC',
  Route: 'R',
  Ingress: 'ING',
  NetworkPolicy: 'NP',
  IPAddressPool: 'IP',
  L2Advertisement: 'L2',
  ConfigMap: 'CM',
  Secret: 'SEC',
  LimitRange: 'LR',
  ResourceQuota: 'RQ',
  Template: 'TPL',
  PersistentVolume: 'PV',
  PersistentVolumeClaim: 'PVC',
  StorageClass: 'SC',
  HorizontalPodAutoscaler: 'HPA',
  PodDisruptionBudget: 'PDB',
  ServiceAccount: 'SA',
  Role: 'RO',
  ClusterRole: 'CR',
  RoleBinding: 'RB',
  ClusterRoleBinding: 'CRB',
  SecurityContextConstraints: 'SCC',
  User: 'U',
  Group: 'G',
  Identity: 'ID',
  OAuth: 'OA',
  Subscription: 'OP',
  ClusterOperator: 'CO',
  ClusterVersion: 'CV',
};

const KIND_COLORS = {
  Project: ['bg-openshift/15', 'text-openshift-light'],
  Route: ['bg-openshift/15', 'text-openshift-light'],
  BuildConfig: ['bg-orange-500/15', 'text-orange-400'],
  Build: ['bg-orange-500/15', 'text-orange-400'],
  ImageStream: ['bg-orange-500/15', 'text-orange-400'],
  Subscription: ['bg-purple-500/20', 'text-purple-400'],
  SecurityContextConstraints: ['bg-red-500/20', 'text-red-400'],
  ClusterOperator: ['bg-emerald-500/20', 'text-emerald-400'],
  ClusterVersion: ['bg-emerald-500/20', 'text-emerald-400'],
  Pod: ['bg-sky-500/20', 'text-sky-400'],
  Deployment: ['bg-blue-500/20', 'text-blue-400'],
  Service: ['bg-purple-500/20', 'text-purple-400'],
  Node: ['bg-green-500/20', 'text-green-400'],
  ConfigMap: ['bg-amber-500/20', 'text-amber-400'],
  Secret: ['bg-red-500/20', 'text-red-400'],
  User: ['bg-cyan-500/20', 'text-cyan-400'],
  Group: ['bg-cyan-500/20', 'text-cyan-400'],
};

const PHASE_COLORS = {
  Running: 'bg-green-400',
  Ready: 'bg-green-400',
  Active: 'bg-green-400',
  Complete: 'bg-green-400',
  Succeeded: 'bg-green-400',
  Admitted: 'bg-green-400',
  Available: 'bg-green-400',
  Pending: 'bg-yellow-400',
  New: 'bg-yellow-400',
  Installing: 'bg-yellow-400',
  Progressing: 'bg-yellow-400',
  Terminating: 'bg-orange-400',
  Cancelled: 'bg-orange-400',
  Failed: 'bg-red-400',
  CrashLoopBackOff: 'bg-red-400',
  Rejected: 'bg-red-400',
  Degraded: 'bg-red-400',
  Unavailable: 'bg-red-400',
  NotReady: 'bg-red-400',
  Suspended: 'bg-yellow-400',
  Paused: 'bg-yellow-400',
  Updating: 'bg-yellow-400',
};

export class InspectorPanel {
  constructor() {
    this.container = null;
    this.resource = null;
    this.activeTab = 'overview';
    this.visible = false;
    this._lastSignature = '';
    this._actionMessage = '';
    this._actionError = false;
    this._scaleValue = null;
    this._sccChoice = null;
    this._interacting = false;
    this._engineRef = null;
    this._engineAttached = false;

    this._boundSelect = this._onResourceSelected.bind(this);
    this._boundDeselect = this._onDeselect.bind(this);
    this._boundUpdate = this._onResourceUpdate.bind(this);
    this._boundStopped = this._onEngineStopped.bind(this);
    this._boundClick = this._onClick.bind(this);
    this._boundInput = this._onInput.bind(this);
    this._boundFocusIn = this._onFocusIn.bind(this);
    this._boundFocusOut = this._onFocusOut.bind(this);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  init() {
    if (this.container) this.destroy();

    this.container = document.createElement('div');
    this.container.id = 'inspector-panel';
    this.container.className = 'panel-side panel-right';
    this.container.setAttribute('data-testid', 'inspector-panel');
    this.container.innerHTML = this._buildShell();
    document.body.appendChild(this.container);

    this.container.addEventListener('click', this._boundClick);
    this.container.addEventListener('input', this._boundInput);
    this.container.addEventListener('change', this._boundInput);
    this.container.addEventListener('focusin', this._boundFocusIn);
    this.container.addEventListener('focusout', this._boundFocusOut);
    this._bindGameEvents();
    this._renderTab();
  }

  show() {
    if (!this.container) return;
    this.visible = true;
    this.container.classList.add('is-open');
  }

  hide() {
    if (this.container) {
      this.container.classList.remove('is-open');
    }
    this.visible = false;
    this.resource = null;
    this._lastSignature = '';
    try {
      window.game?.renderer?.deselectAll?.();
    } catch {
      /* renderer not ready */
    }
  }

  destroy() {
    this._unbindGameEvents();
    if (this.container) {
      this.container.removeEventListener('click', this._boundClick);
      this.container.removeEventListener('input', this._boundInput);
      this.container.removeEventListener('change', this._boundInput);
      this.container.removeEventListener('focusin', this._boundFocusIn);
      this.container.removeEventListener('focusout', this._boundFocusOut);
      this.container.remove();
    }
    this.container = null;
    this.resource = null;
    this.visible = false;
    this._lastSignature = '';
    this._actionMessage = '';
  }

  _onEngineStopped() {
    this.destroy();
  }

  // ─── Game wiring ───────────────────────────────────────────────────────

  _bus() {
    return window.game?.engine || window.game?.app?.engine?.eventBus || null;
  }

  _cluster() {
    return window.game?.cluster || window.game?.app?.engine?.cluster || null;
  }

  _gameEngine() {
    return window.game?.gameEngine || window.game?.app?.engine || null;
  }

  _bindGameEvents() {
    const bus = this._bus();
    if (!bus || this._engineAttached) return;
    this._engineRef = bus;
    this._engineAttached = true;
    bus.on('resource:selected', this._boundSelect);
    bus.on('resource:deselected', this._boundDeselect);
    bus.on('tick', this._boundUpdate);
    bus.on('engine:stopped', this._boundStopped);
  }

  _unbindGameEvents() {
    const bus = this._engineRef;
    if (bus) {
      bus.off?.('resource:selected', this._boundSelect);
      bus.off?.('resource:deselected', this._boundDeselect);
      bus.off?.('tick', this._boundUpdate);
      bus.off?.('engine:stopped', this._boundStopped);
    }
    this._engineRef = null;
    this._engineAttached = false;
  }

  _onResourceSelected(data) {
    let resource = data?.resource || null;
    if (!resource && data?.uid) {
      try {
        resource = this._cluster()?.getResource?.(data.uid) || null;
      } catch {
        resource = null;
      }
    }
    if (!resource) {
      this.hide();
      return;
    }
    this.resource = resource;
    this._lastSignature = this._signature(resource);
    this._actionMessage = '';
    this._actionError = false;
    this._scaleValue = null;
    this._sccChoice = null;
    this.show();
    this._renderHeader();
    this._renderTab();
  }

  _onDeselect() {
    this.hide();
  }

  _onResourceUpdate() {
    if (!this.visible || !this.resource || this._interacting) return;
    const uid = this.resource.metadata?.uid;
    if (!uid) return;
    let updated = null;
    try {
      updated = this._cluster()?.getResource?.(uid) || null;
    } catch {
      updated = null;
    }
    if (!updated) {
      this.hide();
      return;
    }
    this.resource = updated;
    const signature = this._signature(updated);
    if (signature === this._lastSignature) return;
    this._lastSignature = signature;
    this._renderHeader();
    if (this.activeTab !== 'yaml') this._renderTab();
  }

  _signature(resource) {
    const status = resource?.status || {};
    return [
      resource?.metadata?.resourceVersion,
      resource?.metadata?.generation,
      status.phase,
      status.readyReplicas,
      status.availableReplicas,
      status.updatedReplicas,
      status.numberReady,
      status.currentReplicas,
      status.installedCSV,
      status.ingress?.[0]?.conditions?.[0]?.status,
    ]
      .filter((value) => value !== undefined && value !== null)
      .join('|');
  }

  // ─── Shell / header ────────────────────────────────────────────────────

  _buildShell() {
    return `
      <div class="panel-inner">
        <div id="inspector-header" class="flex items-center justify-between px-4 py-3 border-b border-white/5" data-testid="inspector-header">
          <div class="flex items-center gap-2 min-w-0">
            <div id="inspector-icon" class="w-8 h-8 rounded-lg bg-openshift/15 flex items-center justify-center text-openshift-light text-[10px] font-bold shrink-0">OCP</div>
            <div class="min-w-0">
              <div id="inspector-name" class="text-white/90 text-sm font-semibold truncate" data-testid="inspector-name">No Selection</div>
              <div id="inspector-subtitle" class="text-white/40 text-xs truncate" data-testid="inspector-subtitle">${PLATFORM_LABEL} · select a resource</div>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button id="inspector-edit" class="hidden px-2 py-1 text-xs text-sky-400 hover:bg-sky-400/10 rounded transition-colors" title="Edit YAML (oc edit)" data-testid="inspector-edit">Edit YAML</button>
            <button id="inspector-close" class="p-1 text-white/30 hover:text-white/60 transition-colors" title="Close inspector" data-testid="inspector-close">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>

        <div id="inspector-tabs" class="flex border-b border-white/5 px-2" role="tablist" data-testid="inspector-tabs">
          <button data-tab="overview" data-testid="inspector-tab-overview" role="tab" aria-selected="true" class="px-3 py-2 text-xs text-sky-400 border-b-2 border-sky-400 font-medium transition-colors">Overview</button>
          <button data-tab="yaml" data-testid="inspector-tab-yaml" role="tab" aria-selected="false" class="px-3 py-2 text-xs text-white/40 border-b-2 border-transparent hover:text-white/60 transition-colors">YAML</button>
          <button data-tab="describe" data-testid="inspector-tab-describe" role="tab" aria-selected="false" class="px-3 py-2 text-xs text-white/40 border-b-2 border-transparent hover:text-white/60 transition-colors">Describe</button>
          <button data-tab="events" data-testid="inspector-tab-events" role="tab" aria-selected="false" class="px-3 py-2 text-xs text-white/40 border-b-2 border-transparent hover:text-white/60 transition-colors">Events</button>
        </div>

        <div id="inspector-body" class="flex-1 overflow-y-auto scrollbar-thin p-4" data-testid="inspector-body">
          <div class="text-white/30 text-sm text-center mt-8">Select a resource to inspect</div>
        </div>
      </div>
    `;
  }

  _renderHeader() {
    const r = this.resource;
    if (!r || !this.container) return;
    const kind = r.kind || 'Unknown';
    const name = r.metadata?.name || 'unnamed';
    const namespace = r.metadata?.namespace || '';
    const status = this._phaseOf(r);
    const [bgColor, textColor] = KIND_COLORS[kind] || ['bg-openshift/15', 'text-openshift-light'];
    const icon = KIND_ICONS[kind] || (kind ? kind.slice(0, 2).toUpperCase() : 'OCP');

    const iconEl = this.container.querySelector('#inspector-icon');
    if (iconEl) {
      iconEl.className = `w-8 h-8 rounded-lg ${bgColor} flex items-center justify-center ${textColor} text-[10px] font-bold shrink-0`;
      iconEl.textContent = icon;
    }
    const nameEl = this.container.querySelector('#inspector-name');
    if (nameEl) nameEl.textContent = name;
    const subtitleEl = this.container.querySelector('#inspector-subtitle');
    if (subtitleEl)
      subtitleEl.textContent = `${kind} · ${namespace || 'cluster-scoped'} · ${status}`;

    const editBtn = this.container.querySelector('#inspector-edit');
    if (editBtn) {
      editBtn.classList.remove('hidden');
      editBtn.title = `Edit ${kind}/${name} as YAML (oc edit)`;
    }
  }

  _switchTab(tab) {
    if (!this.container) return;
    this.activeTab = tab;
    this.container.querySelectorAll('#inspector-tabs [data-tab]').forEach((button) => {
      const active = button.dataset.tab === tab;
      button.className = active
        ? 'px-3 py-2 text-xs text-sky-400 border-b-2 border-sky-400 font-medium transition-colors'
        : 'px-3 py-2 text-xs text-white/40 border-b-2 border-transparent hover:text-white/60 transition-colors';
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    this._renderTab();
  }

  _renderTab() {
    const body = this.container?.querySelector('#inspector-body');
    if (!body) return;
    if (!this.resource) {
      body.innerHTML =
        '<div class="text-white/30 text-sm text-center mt-8">Select a resource to inspect</div>';
      return;
    }
    switch (this.activeTab) {
      case 'yaml':
        body.innerHTML = this._renderYAML();
        break;
      case 'describe':
        body.innerHTML = this._renderDescribe();
        break;
      case 'events':
        body.innerHTML = this._renderEvents();
        break;
      case 'overview':
      default:
        body.innerHTML = this._renderOverview();
        break;
    }
  }

  // ─── Overview ──────────────────────────────────────────────────────────

  _renderOverview() {
    const r = this.resource;
    const phase = this._phaseOf(r);
    const statusColor = PHASE_COLORS[phase] || 'bg-white/40';
    const labels = Object.entries(r.metadata?.labels || {});
    const annotations = Object.entries(r.metadata?.annotations || {});

    return `
      <div class="space-y-4" data-testid="inspector-overview">
        <div>
          <div class="text-white/30 text-xs uppercase tracking-wider mb-2">Status</div>
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full ${statusColor}"></div>
            <span class="text-white/80 text-sm">${this._escapeHTML(phase)}</span>
          </div>
        </div>

        <div>
          <div class="text-white/30 text-xs uppercase tracking-wider mb-2">Metadata</div>
          <div class="space-y-1.5">
            ${this._metaRow('Name', r.metadata?.name)}
            ${this._metaRow('Namespace', r.metadata?.namespace || 'cluster-scoped')}
            ${this._metaRow('Kind', r.kind)}
            ${this._metaRow('API Version', r.apiVersion || KIND_DEFS[r.kind]?.apiVersion)}
            ${this._metaRow('Created', this._formatTimestamp(r.metadata?.creationTimestamp))}
            ${this._metaRow('Age', this._age(r))}
          </div>
        </div>

        ${this._renderKindDetails(r)}

        ${this._section(
          'Labels',
          `<div class="flex flex-wrap gap-1">${
            labels.length
              ? labels
                  .map(
                    ([key, value]) =>
                      `<span class="px-2 py-0.5 text-xs bg-white/5 border border-white/10 rounded text-white/60" title="${this._escapeHTML(`${key}=${value}`)}">${this._escapeHTML(key)}=${this._escapeHTML(value)}</span>`
                  )
                  .join('')
              : '<span class="text-white/20 text-xs">No labels</span>'
          }</div>`
        )}

        ${this._section(
          'Annotations',
          `<div class="space-y-1">${
            annotations.length
              ? annotations
                  .map(
                    ([key, value]) =>
                      `<div class="text-xs break-words"><span class="text-white/40">${this._escapeHTML(key)}</span><span class="text-white/20">: </span><span class="text-white/60">${this._escapeHTML(value)}</span></div>`
                  )
                  .join('')
              : '<span class="text-white/20 text-xs">No annotations</span>'
          }</div>`
        )}

        ${this._renderActions(r)}
      </div>
    `;
  }

  _renderKindDetails(r) {
    const kind = r.kind || '';
    const sections = [];
    const add = (title, html, testid) => sections.push(this._section(title, html, testid));
    const kv = (label, value) => this._metaRow(label, this._text(value));

    switch (kind) {
      case 'Project': {
        const cluster = this._cluster();
        const countPods = this._countInProject(cluster, 'Pod', r.metadata?.name);
        const countRoutes = this._countInProject(cluster, 'Route', r.metadata?.name);
        const countBuilds = this._countInProject(cluster, 'Build', r.metadata?.name);
        add(
          'Project',
          [
            kv(
              'Display Name',
              r.spec?.displayName || r.metadata?.annotations?.['openshift.io/display-name'] || '-'
            ),
            kv(
              'Description',
              r.spec?.description || r.metadata?.annotations?.['openshift.io/description'] || '-'
            ),
            kv('Phase', r.status?.phase),
            kv('Pods', countPods),
            kv('Routes', countRoutes),
            kv('Builds', countBuilds),
          ].join(''),
          'inspector-project'
        );
        break;
      }
      case 'Route': {
        const ingress = r.status?.ingress?.[0];
        const condition = ingress?.conditions?.find((entry) => entry.type === 'Admitted');
        const admitted = condition ? condition.status === 'True' : Boolean(r.isAdmitted?.());
        const host =
          r.spec?.host ||
          (typeof r.effectiveHost === 'function' ? r.effectiveHost() : '<auto-generated>');
        add(
          'Route',
          [
            kv('Host / Port', host),
            kv('Path', r.spec?.path || '/'),
            kv('TLS Termination', r.spec?.tls?.termination || 'none (HTTP)'),
            kv('Insecure Policy', r.spec?.tls?.insecureEdgeTerminationPolicy || '-'),
            kv('Target Service', `${r.spec?.to?.kind || 'Service'}/${r.spec?.to?.name || '-'}`),
            kv('Target Port', r.spec?.port?.targetPort || '-'),
            kv('Weight', r.spec?.to?.weight ?? 100),
            kv('Admitted', admitted ? 'True' : 'False'),
            kv('Reason', condition?.reason || '-'),
            kv('Router', ingress?.routerName || 'default'),
            condition?.message
              ? `<div class="text-[10px] text-white/30 mt-1 break-words">${this._escapeHTML(condition.message)}</div>`
              : '',
          ].join(''),
          'inspector-route'
        );
        break;
      }
      case 'BuildConfig': {
        const strategy = r.spec?.strategy || {};
        add(
          'BuildConfig',
          [
            kv('Source Type', r.spec?.source?.type),
            kv('Git Repository', r.spec?.source?.git?.uri || '-'),
            kv('Git Ref', r.spec?.source?.git?.ref || '-'),
            kv('Context Dir', r.spec?.source?.contextDir || '-'),
            kv('Strategy', strategy.type || 'Source'),
            kv(
              'Builder Image',
              strategy.sourceStrategy?.from?.name || strategy.dockerStrategy?.dockerfilePath || '-'
            ),
            kv(
              'Output',
              `${r.spec?.output?.to?.kind || 'ImageStreamTag'}/${r.spec?.output?.to?.name || '-'}`
            ),
            kv('Latest Version', r.status?.lastVersion ?? 0),
            kv(
              'Triggers',
              (r.spec?.triggers || []).map((trigger) => trigger.type).join(', ') || '-'
            ),
          ].join(''),
          'inspector-buildconfig'
        );
        break;
      }
      case 'Build': {
        add(
          'Build',
          [
            kv('Phase', r.status?.phase),
            kv('Build Config', r.status?.config?.name || '-'),
            kv('Message', r.status?.message || '-'),
            kv('Started', r.status?.startTimestamp || '-'),
            kv('Completed', r.status?.completionTimestamp || '-'),
            kv('Duration', r.status?.duration ? `${r.status.duration}s` : '-'),
            kv('Output Image', r.status?.output?.to?.dockerImageReference || '-'),
          ].join(''),
          'inspector-build'
        );
        break;
      }
      case 'ImageStream': {
        const repository =
          (typeof r.getImageRepository === 'function'
            ? r.getImageRepository()
            : r.status?.dockerImageRepository) || '-';
        const tags = r.status?.tags?.length ? r.status.tags : r.spec?.tags || [];
        const tagsHtml = tags.length
          ? tags
              .map((tag) => {
                const name = tag.tag || tag.name || 'latest';
                const image = tag.items?.[0]?.dockerImageReference || tag.from?.name || '-';
                return `<div class="flex items-start gap-2 text-xs py-0.5"><span class="text-amber-400 font-mono shrink-0">${this._escapeHTML(name)}</span><span class="text-white/50 break-all">${this._escapeHTML(image)}</span></div>`;
              })
              .join('')
          : '<span class="text-white/20 text-xs">No tags</span>';
        add(
          'ImageStream',
          [
            kv('Image Repository', repository),
            kv('Lookup Policy', r.spec?.lookupPolicy?.local ? 'Local' : 'Source'),
            `<div class="text-white/30 text-xs uppercase tracking-wider mb-1 mt-2">Tags</div>${tagsHtml}`,
          ].join(''),
          'inspector-imagestream'
        );
        break;
      }
      case 'Template': {
        const parameters = r.spec?.parameters || [];
        add(
          'Template',
          [
            kv('Parameters', parameters.length),
            kv('Objects', (r.spec?.objects || []).length),
            kv('Message', r.spec?.message || '-'),
            `<div class="text-white/30 text-xs uppercase tracking-wider mb-1 mt-2">Parameters</div>${
              parameters.length
                ? parameters
                    .map(
                      (parameter) =>
                        `<div class="text-xs flex items-center justify-between gap-2 py-0.5"><span class="text-white/60 font-mono">${this._escapeHTML(parameter.name)}</span><span class="text-white/30">${this._escapeHTML(parameter.value ?? '<required>')}</span></div>`
                    )
                    .join('')
                : '<span class="text-white/20 text-xs">No parameters</span>'
            }`,
          ].join(''),
          'inspector-template'
        );
        break;
      }
      case 'Subscription': {
        add(
          'Operator Subscription',
          [
            kv('Package', r.spec?.packageName || r.spec?.name || '-'),
            kv('Channel', r.spec?.channel || '-'),
            kv('Source', r.spec?.source || '-'),
            kv('Source Namespace', r.spec?.sourceNamespace || '-'),
            kv('Install Plan Approval', r.spec?.installPlanApproval || '-'),
            kv('Phase', r.status?.phase),
            kv('Installed CSV', r.status?.installedCSV || '-'),
            kv('Current CSV', r.status?.currentCSV || '-'),
            kv('Reason', r.status?.reason || '-'),
            kv('Message', r.status?.message || '-'),
          ].join(''),
          'inspector-subscription'
        );
        break;
      }
      case 'SecurityContextConstraints': {
        add(
          'Security Context Constraints',
          [
            kv('Priority', r.spec?.priority),
            kv('Allow Privileged', r.spec?.allowPrivilegedContainer ? 'true' : 'false'),
            kv('Allow Host Network', r.spec?.allowHostNetwork ? 'true' : 'false'),
            kv('Allow Host Ports', r.spec?.allowHostPorts ? 'true' : 'false'),
            kv('Allow Host Dir Volume', r.spec?.allowHostDirVolumePlugin ? 'true' : 'false'),
            kv('Read Only Root Filesystem', r.spec?.readOnlyRootFilesystem ? 'true' : 'false'),
            kv('RunAsUser Strategy', r.spec?.runAsUser?.type || '-'),
            kv('SELinux Strategy', r.spec?.seLinuxContext?.type || '-'),
            kv('FSGroup Strategy', r.spec?.fsGroup?.type || '-'),
            kv('Users', (r.spec?.users || []).join(', ') || '<none>'),
            kv('Groups', (r.spec?.groups || []).join(', ') || '<none>'),
          ].join(''),
          'inspector-scc'
        );
        break;
      }
      case 'ResourceQuota': {
        add(
          'ResourceQuota',
          [
            kv('Hard', Object.keys(r.spec?.hard || {}).length),
            kv('Used', Object.keys(r.status?.used || {}).length),
            this._usageTable(r.spec?.hard, r.status?.used),
          ].join(''),
          'inspector-quota'
        );
        break;
      }
      case 'LimitRange': {
        const limits = r.spec?.limits || [];
        add(
          'LimitRange',
          limits.length
            ? limits
                .map(
                  (entry) => `<div class="p-2 bg-white/5 rounded-lg border border-white/5 mb-1">
              <div class="text-white/70 text-xs font-medium">${this._escapeHTML(entry.type || 'Container')}</div>
              <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1 text-[10px]">
                <span class="text-white/30">Default</span><span class="text-white/60">${this._escapeHTML(this._objectText(entry.default))}</span>
                <span class="text-white/30">Default Request</span><span class="text-white/60">${this._escapeHTML(this._objectText(entry.defaultRequest))}</span>
                <span class="text-white/30">Min</span><span class="text-white/60">${this._escapeHTML(this._objectText(entry.min))}</span>
                <span class="text-white/30">Max</span><span class="text-white/60">${this._escapeHTML(this._objectText(entry.max))}</span>
              </div>
            </div>`
                )
                .join('')
            : '<span class="text-white/20 text-xs">No limits defined</span>',
          'inspector-limitrange'
        );
        break;
      }
      case 'ClusterResourceQuota': {
        const hard = r.spec?.quota?.hard || r.spec?.hard || {};
        const used = r.status?.total?.used || r.status?.used || {};
        add(
          'ClusterResourceQuota',
          [
            kv('Selector', this._objectText(r.spec?.selector?.labels?.matchLabels) || '<none>'),
            kv('Namespaces', (r.status?.namespaces || []).join(', ') || '<none>'),
            this._usageTable(hard, used),
          ].join(''),
          'inspector-clusterquota'
        );
        break;
      }
      case 'ClusterOperator': {
        const conditions = r.status?.conditions || [];
        add(
          'ClusterOperator',
          [
            kv(
              'Version',
              (r.status?.versions || []).map((version) => version.version).join(', ') || '-'
            ),
            kv('Available', r.isConditionTrue?.('Available') ? 'True' : 'False'),
            kv('Progressing', r.isConditionTrue?.('Progressing') ? 'True' : 'False'),
            kv('Degraded', r.isConditionTrue?.('Degraded') ? 'True' : 'False'),
            this._conditionsTable(conditions),
          ].join(''),
          'inspector-clusteroperator'
        );
        break;
      }
      case 'ClusterVersion': {
        add(
          'ClusterVersion',
          [
            kv('Desired Version', r.status?.desired?.version || '-'),
            kv('Channel', r.spec?.channel || r.status?.desired?.channel || '-'),
            kv('Available', r.isConditionTrue?.('Available') ? 'True' : 'False'),
            kv('Progressing', r.isConditionTrue?.('Progressing') ? 'True' : 'False'),
            this._conditionsTable(r.status?.conditions || []),
          ].join(''),
          'inspector-clusterversion'
        );
        break;
      }
      case 'User': {
        add(
          'User',
          [
            kv('Full Name', r.spec?.fullName || '-'),
            kv(
              'Identities',
              (r.spec?.identities || [])
                .map(
                  (identity) =>
                    `${identity.providerName || 'htpasswd'}:${identity.providerUserName || '-'}`
                )
                .join(', ') || '<none>'
            ),
            kv('Groups', (r.spec?.groups || []).join(', ') || '<none>'),
          ].join(''),
          'inspector-user'
        );
        break;
      }
      case 'Group': {
        add(
          'Group',
          [
            kv('Users', (r.spec?.users || []).join(', ') || '<none>'),
            kv('Member Count', (r.spec?.users || []).length),
          ].join(''),
          'inspector-group'
        );
        break;
      }
      case 'Service': {
        const ports = (r.spec?.ports || [])
          .map(
            (port) =>
              `${port.name || 'port'} ${port.port}/${port.protocol || 'TCP'} → ${port.targetPort ?? port.port}`
          )
          .join(', ');
        const external = (r.status?.loadBalancer?.ingress || [])
          .map((entry) => entry.ip || entry.hostname)
          .join(', ');
        const endpoints = Array.isArray(r.endpoints)
          ? r.endpoints
              .map((endpoint) => endpoint.ip)
              .filter(Boolean)
              .join(', ')
          : '';
        add(
          'Service',
          [
            kv('Type', r.spec?.type || 'ClusterIP'),
            kv('Cluster IP', r.spec?.clusterIP || '-'),
            kv(
              'External IP',
              external || (r.spec?.type === 'LoadBalancer' ? '<pending>' : '<none>')
            ),
            kv('Ports', ports || '<none>'),
            kv('Selector', this._objectText(r.spec?.selector) || '<none>'),
            kv('Endpoints', endpoints || '<none>'),
          ].join(''),
          'inspector-service'
        );
        break;
      }
      case 'Deployment':
      case 'ReplicaSet':
      case 'StatefulSet': {
        const containers = r.spec?.template?.spec?.containers || [];
        add(
          kind,
          [
            kv('Replicas', `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 0} ready`),
            kv('Updated', r.status?.updatedReplicas ?? '-'),
            kv('Available', r.status?.availableReplicas ?? '-'),
            kv('Strategy', r.spec?.strategy?.type || '-'),
            kv('Images', containers.map((container) => container.image).join(', ') || '-'),
            this._conditionsTable(r.status?.conditions || []),
          ].join(''),
          `inspector-${kind.toLowerCase()}`
        );
        break;
      }
      case 'Pod': {
        const containers = r.status?.containerStatuses || [];
        const containerHtml = containers.length
          ? containers
              .map(
                (container) => `<div class="p-2 bg-white/5 rounded-lg border border-white/5 mb-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-white/80 text-xs font-medium">${this._escapeHTML(container.name)}</span>
                <span class="${container.ready ? 'text-green-400' : 'text-yellow-400'} text-[10px]">${container.ready ? 'Ready' : 'NotReady'}</span>
              </div>
              <div class="text-white/40 text-[10px] mt-0.5 break-all">${this._escapeHTML(container.image || '-')}</div>
              <div class="text-white/30 text-[10px] mt-0.5">Restarts: ${this._escapeHTML(container.restartCount ?? 0)} · ${this._escapeHTML(Object.keys(container.state || {})[0] || 'Unknown')}</div>
            </div>`
              )
              .join('')
          : (r.spec?.containers || [])
              .map(
                (container) =>
                  `<div class="text-xs text-white/60">${this._escapeHTML(container.name)} <span class="text-white/30">${this._escapeHTML(container.image || '')}</span></div>`
              )
              .join('') || '<span class="text-white/20 text-xs">No containers</span>';
        add(
          'Pod',
          [
            kv('Node', r.spec?.nodeName || 'unscheduled'),
            kv('Pod IP', r.status?.podIP || '-'),
            kv('QoS Class', r.status?.qosClass || '-'),
            kv('Service Account', r.spec?.serviceAccountName || 'default'),
            kv('Restarts', r.getRestartCount?.() ?? r.status?.restartCount ?? 0),
            `<div class="text-white/30 text-xs uppercase tracking-wider mb-1 mt-2">Containers</div>${containerHtml}`,
          ].join(''),
          'inspector-pod'
        );
        break;
      }
      case 'Node': {
        const ready = r.status?.conditions?.find((condition) => condition.type === 'Ready');
        const role =
          r.metadata?.labels?.['node-role.kubernetes.io/master'] !== undefined ||
          r.metadata?.labels?.['node-role.kubernetes.io/control-plane'] !== undefined
            ? 'control-plane'
            : 'worker';
        add(
          'Node',
          [
            kv('Status', ready?.status === 'True' ? 'Ready' : r.status?.phase || 'NotReady'),
            kv('Roles', role),
            kv('Unschedulable', r.spec?.unschedulable ? 'true' : 'false'),
            kv('Capacity', this._objectText(r.status?.capacity)),
            kv('Allocatable', this._objectText(r.status?.allocatable)),
            kv(
              'CPU Usage',
              r.status?.usage?.cpuPercent !== undefined ? `${r.status.usage.cpuPercent}%` : '-'
            ),
            kv(
              'Memory Usage',
              r.status?.usage?.memoryPercent !== undefined
                ? `${r.status.usage.memoryPercent}%`
                : '-'
            ),
            kv(
              'Taints',
              (r.spec?.taints || [])
                .map((taint) => `${taint.key}=${taint.value}:${taint.effect}`)
                .join(', ') || '<none>'
            ),
          ].join(''),
          'inspector-node'
        );
        break;
      }
      case 'ServiceAccount': {
        add(
          'ServiceAccount',
          [
            kv(
              'Secrets',
              (r.spec?.secrets || []).map((secret) => secret.name).join(', ') || '<none>'
            ),
            kv(
              'Image Pull Secrets',
              (r.spec?.imagePullSecrets || []).map((secret) => secret.name).join(', ') || '<none>'
            ),
            kv('Automount Token', r.spec?.automountServiceAccountToken ?? true),
          ].join(''),
          'inspector-serviceaccount'
        );
        break;
      }
      default: {
        const spec = r.spec && typeof r.spec === 'object' ? r.spec : {};
        const keys = Object.keys(spec).slice(0, 16);
        if (keys.length > 0) {
          add(
            'Spec (key fields)',
            keys.map((key) => kv(key, this._previewValue(spec[key]))).join(''),
            'inspector-spec'
          );
        }
        break;
      }
    }
    return sections.join('');
  }

  _renderActions(r) {
    const kind = r.kind || '';
    const currentUser = this._gameEngine()?.currentUser || 'kubeadmin';
    const buttons = [];
    const addButton = (action, label, options = {}) => {
      const classes = options.danger
        ? 'px-2.5 py-1.5 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors'
        : 'px-2.5 py-1.5 text-xs rounded-lg border border-white/10 text-white/70 hover:bg-white/10 transition-colors';
      buttons.push(
        `<button class="${classes}" data-inspector-action="${this._escapeHTML(action)}" data-testid="inspector-action-${this._escapeHTML(options.testid || action)}">${this._escapeHTML(label)}</button>`
      );
    };

    if (kind === 'Service') addButton('expose', 'Expose Route', { testid: 'expose' });
    if (kind === 'BuildConfig') addButton('start-build', 'Start Build', { testid: 'start-build' });
    if (ROLLOUT_KINDS.has(kind)) {
      addButton('rollout-restart', 'Rollout Restart', { testid: 'rollout-restart' });
      addButton('rollout-undo', 'Rollout Undo', { testid: 'rollout-undo' });
    }
    if (kind === 'SecurityContextConstraints') {
      addButton('grant-scc-current', `Add to SCC (${currentUser})`, { testid: 'add-scc' });
    }
    if (IDENTITY_KINDS.has(kind)) {
      buttons.push(this._renderSccPicker());
    }
    if (kind === 'Subscription') {
      if (r.status?.phase === 'Succeeded')
        addButton('uninstall-operator', 'Uninstall Operator', {
          testid: 'uninstall-operator',
          danger: true,
        });
      else addButton('install-operator', 'Install Operator', { testid: 'install-operator' });
    }
    if (kind === 'Node') {
      addButton('cordon', r.spec?.unschedulable ? 'Uncordon' : 'Cordon', { testid: 'cordon' });
    }
    if (kind === 'Project') {
      addButton('switch-project', 'Switch to Project', { testid: 'switch-project' });
    }
    addButton('edit-yaml', 'Edit YAML', { testid: 'edit-yaml' });
    addButton('delete', 'Delete', { testid: 'delete', danger: true });

    const scaleHtml = SCALE_KINDS.has(kind)
      ? `<div class="flex items-center gap-2 mt-2">
          <label class="text-white/30 text-[10px] uppercase tracking-wider" for="inspector-scale-input">Replicas</label>
          <input id="inspector-scale-input" data-inspector-scale data-testid="inspector-scale-input" type="number" min="0" max="100" value="${this._escapeHTML(this._scaleValue ?? r.spec?.replicas ?? 1)}" class="w-20 px-2 py-1 text-xs text-white bg-black/40 border border-white/15 rounded-lg outline-none focus:border-openshift/50 font-mono" />
          <button data-inspector-action="scale" data-testid="inspector-action-scale" class="px-2.5 py-1.5 text-xs rounded-lg border border-sky-500/30 text-sky-400 hover:bg-sky-500/10 transition-colors">Scale</button>
        </div>`
      : '';

    return this._section(
      'Actions',
      `<div class="flex flex-wrap gap-2" data-testid="inspector-actions">${buttons.join('')}</div>${scaleHtml}
       <div id="inspector-action-result" data-testid="inspector-action-result" class="mt-2 text-[10px] ${this._actionMessage ? '' : 'hidden'} ${this._actionError ? 'text-red-400' : 'text-green-400'}">${this._escapeHTML(this._actionMessage)}</div>`,
      'inspector-actions-section'
    );
  }

  _renderSccPicker() {
    const cluster = this._cluster();
    let names = [];
    try {
      const sccs =
        cluster?.getResourcesByKind?.('SecurityContextConstraints') ||
        cluster?.getByKind?.('SecurityContextConstraints') ||
        [];
      names = sccs
        .map((scc) => scc.metadata?.name)
        .filter(Boolean)
        .sort();
    } catch {
      names = [];
    }
    if (names.length === 0) names = ['anyuid'];
    const selected =
      this._sccChoice && names.includes(this._sccChoice)
        ? this._sccChoice
        : names.includes('anyuid')
          ? 'anyuid'
          : names[0];
    return `<div class="flex items-center gap-2">
      <select data-inspector-scc data-testid="inspector-scc-select" aria-label="Security context constraint" class="px-2 py-1.5 text-xs text-white/80 bg-black/40 border border-white/15 rounded-lg outline-none focus:border-openshift/50">
        ${names.map((name) => `<option value="${this._escapeHTML(name)}" ${name === selected ? 'selected' : ''}>${this._escapeHTML(name)}</option>`).join('')}
      </select>
      <button class="px-2.5 py-1.5 text-xs rounded-lg border border-white/10 text-white/70 hover:bg-white/10 transition-colors" data-inspector-action="add-scc" data-testid="inspector-action-add-scc">Add to SCC</button>
    </div>`;
  }

  // ─── YAML tab ──────────────────────────────────────────────────────────

  _renderYAML() {
    const yaml = this._yamlFor(this.resource);
    const kind = this.resource.kind || 'resource';
    const name = this.resource.metadata?.name || '';
    const namespace = this.resource.metadata?.namespace;
    const command = `oc get ${kind.toLowerCase()} ${name}${namespace ? ` -n ${namespace}` : ''} -o yaml`;
    return `
      <div data-testid="inspector-yaml">
        <div class="flex items-center justify-between gap-2 mb-2">
          <span class="text-white/25 text-[10px] font-mono truncate">${this._escapeHTML(command)}</span>
          <button data-inspector-action="copy-yaml" data-testid="inspector-copy-yaml" class="px-2 py-1 text-[10px] text-white/50 hover:text-white/80 border border-white/10 rounded transition-colors shrink-0">Copy</button>
        </div>
        <div class="bg-black/30 rounded-lg p-3 border border-white/5 overflow-x-auto">
          <pre class="text-xs font-mono leading-5 text-white/70 whitespace-pre">${this._escapeHTML(yaml)}</pre>
        </div>
        <p class="text-white/20 text-[10px] mt-2">Apply-clean manifest - simulator-only ${'`_`'} fields and UIDs are never exported.</p>
        <div id="inspector-yaml-status" data-testid="inspector-yaml-status" class="mt-2 text-[10px] ${this._actionMessage ? '' : 'hidden'} ${this._actionError ? 'text-red-400' : 'text-green-400'}">${this._escapeHTML(this._actionMessage)}</div>
      </div>
    `;
  }

  _yamlFor(resource) {
    if (!resource) return '# No resource selected';
    try {
      if (typeof resource.toYAML === 'function') {
        const text = resource.toYAML({ includeStatus: true });
        if (typeof text === 'string' && text.trim()) return text;
      }
    } catch {
      /* fall through to the shared serializer */
    }
    try {
      const text = toManifestYAML(resource, { includeStatus: true });
      return typeof text === 'string' && text.trim() ? text : '# No manifest data available';
    } catch {
      return '# No manifest data available';
    }
  }

  // ─── Describe tab ──────────────────────────────────────────────────────

  _renderDescribe() {
    const text = this._describeFor(this.resource);
    const kind = this.resource.kind || 'resource';
    const name = this.resource.metadata?.name || '';
    const namespace = this.resource.metadata?.namespace;
    const command = `oc describe ${kind.toLowerCase()} ${name}${namespace ? ` -n ${namespace}` : ''}`;
    return `
      <div data-testid="inspector-describe">
        <div class="text-white/25 text-[10px] font-mono mb-2 truncate">${this._escapeHTML(command)}</div>
        <div class="bg-black/30 rounded-lg p-3 border border-white/5 overflow-x-auto">
          <pre class="text-xs font-mono leading-5 text-white/70 whitespace-pre">${this._escapeHTML(text)}</pre>
        </div>
      </div>
    `;
  }

  _describeFor(resource) {
    if (!resource) return 'No resource selected.';
    try {
      if (typeof resource.toDescribe === 'function') {
        const text = resource.toDescribe();
        if (typeof text === 'string' && text.trim()) return text;
      }
    } catch {
      /* fall through */
    }
    try {
      if (typeof resource.describe === 'function') {
        const text = resource.describe();
        if (typeof text === 'string' && text.trim()) return text;
      }
    } catch {
      /* fall through */
    }
    try {
      return describeResource(resource);
    } catch {
      return `Name:         ${resource.metadata?.name || 'unknown'}\nKind:         ${resource.kind || 'Unknown'}\nAPI Version:  ${resource.apiVersion || '-'}`;
    }
  }

  // ─── Events tab ────────────────────────────────────────────────────────

  _renderEvents() {
    const r = this.resource;
    let events = [];
    try {
      events =
        typeof r.getEvents === 'function'
          ? r.getEvents(50)
          : Array.isArray(r._events)
            ? r._events
            : [];
    } catch {
      events = [];
    }
    if (!events.length) {
      return '<div data-testid="inspector-events"><div class="text-white/30 text-sm text-center mt-4">No events recorded for this resource.</div></div>';
    }
    const sorted = [...events].reverse();
    return `
      <div class="space-y-2" data-testid="inspector-events">
        ${sorted
          .map(
            (event) => `
          <div class="p-2 bg-white/5 rounded-lg border border-white/5">
            <div class="flex items-center gap-2 mb-1">
              <div class="w-1.5 h-1.5 rounded-full ${event.type === 'Warning' ? 'bg-yellow-400' : 'bg-green-400'}"></div>
              <span class="text-white/60 text-xs font-medium">${this._escapeHTML(event.reason || event.type || 'Event')}</span>
              ${event.count > 1 ? `<span class="text-white/25 text-[10px]">×${event.count}</span>` : ''}
              <span class="text-white/20 text-[10px] ml-auto">${this._escapeHTML(this._formatEventTime(event.timestamp))}</span>
            </div>
            <div class="text-white/40 text-xs pl-3.5 break-words">${this._escapeHTML(event.message || '')}</div>
          </div>
        `
          )
          .join('')}
      </div>
    `;
  }

  // ─── Actions ───────────────────────────────────────────────────────────

  _onClick(event) {
    if (!this.container) return;
    const close = event.target.closest?.('#inspector-close');
    if (close) {
      this.hide();
      return;
    }
    const edit = event.target.closest?.('#inspector-edit');
    if (edit) {
      this._runAction('edit-yaml');
      return;
    }
    const tab = event.target.closest?.('#inspector-tabs [data-tab]');
    if (tab) {
      this._switchTab(tab.dataset.tab);
      return;
    }
    const actionButton = event.target.closest?.('[data-inspector-action]');
    if (actionButton) {
      this._runAction(actionButton.dataset.inspectorAction);
    }
  }

  _onInput(event) {
    const target = event.target;
    if (!target || !target.matches) return;
    if (target.matches('[data-inspector-scale]')) {
      const value = Number.parseInt(target.value, 10);
      if (Number.isFinite(value) && value >= 0) this._scaleValue = value;
      return;
    }
    if (target.matches('[data-inspector-scc]')) {
      this._sccChoice = target.value;
    }
  }

  _onFocusIn(event) {
    if (event.target?.matches?.('[data-inspector-scale], [data-inspector-scc]'))
      this._interacting = true;
  }

  _onFocusOut() {
    setTimeout(() => {
      if (!this.container?.contains(document.activeElement)) this._interacting = false;
    }, 0);
  }

  _setActionMessage(message, isError = false) {
    this._actionMessage = message || '';
    this._actionError = Boolean(isError);
    for (const selector of ['#inspector-action-result', '#inspector-yaml-status']) {
      const el = this.container?.querySelector(selector);
      if (!el) continue;
      el.textContent = this._actionMessage;
      el.className = `mt-2 text-[10px] ${this._actionMessage ? '' : 'hidden'} ${isError ? 'text-red-400' : 'text-green-400'}`;
    }
  }

  _resultMessage(result, fallback) {
    if (!result) return fallback;
    if (typeof result === 'string') return result;
    return result.message || fallback;
  }

  _runAction(action) {
    const resource = this.resource;
    if (!resource || !action) return;
    const gameEngine = this._gameEngine();
    const cluster = this._cluster();
    const bus = this._bus();
    const kind = resource.kind;
    const name = resource.metadata?.name;
    const namespace = resource.metadata?.namespace || undefined;
    const nsFlag = namespace ? ` -n ${namespace}` : '';
    const emit = (event, data) => {
      try {
        bus?.emit?.(event, data);
      } catch {
        /* EventBus unavailable */
      }
    };
    const command = (value) => emit('ui:run-command', { command: value });
    const finish = (message, isError = false, rerender = true) => {
      this._setActionMessage(message, isError);
      if (rerender) this._renderTab();
    };

    try {
      switch (action) {
        case 'expose': {
          let result = null;
          if (typeof gameEngine?.exposeService === 'function') {
            result = gameEngine.exposeService(name, { namespace });
          }
          if (!result) {
            command(`expose svc/${name}${nsFlag}`);
            finish(`Creating a Route for Service ${name}…`);
            return;
          }
          finish(
            this._resultMessage(result, `Route for Service ${name} created`),
            result.success === false
          );
          return;
        }

        case 'start-build': {
          let result = null;
          if (typeof gameEngine?.startBuild === 'function') {
            result = gameEngine.startBuild(name, { namespace });
          }
          if (!result) {
            command(`start-build ${name}${nsFlag}`);
            finish(`Starting build for ${name}…`);
            return;
          }
          finish(
            this._resultMessage(result, `Build for ${name} started`),
            result.success === false
          );
          return;
        }

        case 'rollout-restart':
        case 'rollout-undo': {
          const subcommand = action === 'rollout-restart' ? 'restart' : 'undo';
          let result = null;
          if (typeof gameEngine?.rollout === 'function') {
            result = gameEngine.rollout(kind, subcommand, name, { namespace });
          }
          if (!result) {
            command(`rollout ${subcommand} ${kind}/${name}${nsFlag}`);
            finish(`Running oc rollout ${subcommand} ${kind}/${name}…`);
            return;
          }
          finish(
            this._resultMessage(result, `oc rollout ${subcommand} ${kind}/${name} completed`),
            result.success === false
          );
          return;
        }

        case 'scale': {
          const input = this.container?.querySelector('[data-inspector-scale]');
          const value = input ? Number.parseInt(input.value, 10) : this._scaleValue;
          if (!Number.isFinite(value) || value < 0) {
            finish('Enter a replica count greater than or equal to 0.', true);
            return;
          }
          let result = null;
          if (typeof gameEngine?.scale === 'function') {
            result = gameEngine.scale(kind, name, value, { namespace });
          } else {
            emit('ui:scale-dialog', { uid: resource.metadata?.uid, kind, name, namespace });
            finish(`Opening the scale dialog for ${kind}/${name}…`);
            return;
          }
          this._scaleValue = value;
          finish(
            this._resultMessage(result, `Scaled ${kind}/${name} to ${value} replicas`),
            result.success === false
          );
          return;
        }

        case 'grant-scc-current': {
          const currentUser = gameEngine?.currentUser || 'kubeadmin';
          let result = null;
          if (typeof gameEngine?.addSCCToUser === 'function') {
            result = gameEngine.addSCCToUser(name, currentUser);
          }
          if (!result) {
            command(`adm policy add-scc-to-user ${name} ${currentUser}`);
            finish(`Granting SCC ${name} to ${currentUser}…`);
            return;
          }
          finish(
            this._resultMessage(result, `SCC ${name} added to ${currentUser}`),
            result.success === false
          );
          return;
        }

        case 'add-scc': {
          const select = this.container?.querySelector('[data-inspector-scc]');
          const sccName = select?.value || this._sccChoice || 'anyuid';
          let result = null;
          if (
            kind === 'ServiceAccount' &&
            typeof gameEngine?.addSCCToServiceAccount === 'function'
          ) {
            result = gameEngine.addSCCToServiceAccount(sccName, name, { namespace });
          } else if (kind === 'Group' && typeof gameEngine?.addSCCToGroup === 'function') {
            result = gameEngine.addSCCToGroup(sccName, name);
          } else if (kind === 'User' && typeof gameEngine?.addSCCToUser === 'function') {
            result = gameEngine.addSCCToUser(sccName, name);
          }
          if (!result) {
            const subject = kind === 'ServiceAccount' ? `-z ${name}` : name;
            const flag = kind === 'Group' ? 'add-scc-to-group' : 'add-scc-to-user';
            command(`adm policy ${flag} ${sccName} ${subject}${nsFlag}`);
            finish(`Granting SCC ${sccName} to ${name}…`);
            return;
          }
          finish(
            this._resultMessage(result, `SCC ${sccName} added to ${name}`),
            result.success === false
          );
          return;
        }

        case 'install-operator': {
          let result = null;
          const packageName = resource.spec?.packageName || resource.spec?.name || name;
          if (typeof gameEngine?.installOperator === 'function') {
            result = gameEngine.installOperator(name, { namespace });
          }
          if (!result && resource.status) {
            resource.spec = resource.spec || {};
            resource.spec.failure = false;
            delete resource.spec.installFailed;
            resource.status.phase = 'Installing';
            resource.status.reason = 'Installing';
            resource.status.message = `installing operator ${packageName}`;
            resource._installElapsed = 0;
            cluster?.update?.(resource.metadata?.uid, resource);
            emit('operator:installing', { name, namespace, packageName });
            result = {
              success: true,
              message: `Installing operator ${packageName} in ${namespace || 'openshift-operators'}…`,
            };
          }
          if (!result) {
            command(
              `create -f examples/subscription.yaml -n ${namespace || 'openshift-operators'}`
            );
            finish('Creating the operator Subscription…');
            return;
          }
          finish(
            this._resultMessage(result, `Installing operator ${packageName}…`),
            result.success === false
          );
          return;
        }

        case 'uninstall-operator': {
          let result = null;
          if (typeof gameEngine?.deleteResource === 'function') {
            result = gameEngine.deleteResource('Subscription', name, namespace);
          } else if (cluster?.remove) {
            cluster.remove(resource.metadata?.uid);
            result = { success: true };
          }
          if (result?.success === false) {
            finish(this._resultMessage(result, 'Could not uninstall the operator.'), true);
            return;
          }
          emit('operator:uninstalled', { name, namespace });
          finish(`Operator Subscription ${name} deleted.`, false, false);
          setTimeout(() => this.hide(), 700);
          return;
        }

        case 'switch-project': {
          let result = null;
          if (typeof gameEngine?.switchProject === 'function') {
            result = gameEngine.switchProject(name);
          }
          if (!result) {
            command(`project ${name}`);
            finish(`Switching to project ${name}…`);
            return;
          }
          finish(
            this._resultMessage(result, `Now using project ${name}`),
            result.success === false
          );
          return;
        }

        case 'cordon': {
          const unschedulable = Boolean(resource.spec?.unschedulable);
          const commandName = unschedulable ? 'uncordon' : 'cordon';
          if (typeof gameEngine?.queueCommand === 'function') {
            gameEngine.queueCommand({ type: commandName, name });
            finish(`oc adm ${commandName} node/${name} requested.`);
          } else {
            command(`adm ${commandName} node/${name}`);
            finish(`Running oc adm ${commandName} node/${name}…`);
          }
          return;
        }

        case 'edit-yaml': {
          this._editYaml(resource);
          return;
        }

        case 'copy-yaml': {
          const yaml = this._yamlFor(resource);
          try {
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(yaml).then(
                () => this._setActionMessage('YAML copied to the clipboard.'),
                () =>
                  this._setActionMessage(
                    'Clipboard unavailable - select the YAML text to copy.',
                    true
                  )
              );
              return;
            }
          } catch {
            /* fall through */
          }
          this._setActionMessage('Clipboard unavailable - select the YAML text to copy.', true);
          return;
        }

        case 'delete': {
          let result = null;
          if (typeof gameEngine?.deleteResource === 'function') {
            result = gameEngine.deleteResource(kind, name, namespace);
          } else if (cluster?.remove && resource.metadata?.uid) {
            cluster.remove(resource.metadata.uid);
            result = { success: true };
          }
          if (result?.success === false) {
            finish(this._resultMessage(result, `Could not delete ${kind}/${name}.`), true);
            return;
          }
          emit('resource:deleted', { uid: resource.metadata?.uid, kind, name, namespace });
          if (kind === 'Subscription') emit('operator:uninstalled', { name, namespace });
          finish(`${kind}/${name} deleted.`, false, false);
          setTimeout(() => this.hide(), 500);
          return;
        }

        default:
          return;
      }
    } catch (error) {
      this._setActionMessage(error?.message || 'Action failed.', true);
    }
  }

  _editYaml(resource) {
    const kind = resource.kind;
    const name = resource.metadata?.name;
    const namespace = resource.metadata?.namespace;
    const commandText = `edit ${kind} ${name}${namespace ? ` -n ${namespace}` : ''}`;
    const bar = window.game?.app?.commandBar;
    const exec = bar?.executeCommand || bar?._executeCommand;
    if (typeof exec === 'function') {
      try {
        exec.call(bar, commandText);
        return;
      } catch {
        /* fall through to the event contract */
      }
    }
    try {
      this._bus()?.emit?.('ui:run-command', { command: commandText });
      if (!this._bus()) {
        window.game?.manifestPanel?.show?.(resource);
      }
    } catch {
      /* nothing else to do */
    }
  }

  // ─── Formatting helpers ────────────────────────────────────────────────

  _section(title, html, testid) {
    return `<div${testid ? ` data-testid="${this._escapeHTML(testid)}"` : ''}>
      <div class="text-white/30 text-xs uppercase tracking-wider mb-2">${this._escapeHTML(title)}</div>
      ${html}
    </div>`;
  }

  _metaRow(label, value) {
    return `<div class="flex items-start text-xs gap-2">
      <span class="text-white/30 w-24 shrink-0">${this._escapeHTML(label)}</span>
      <span class="text-white/70 break-all">${this._escapeHTML(this._text(value))}</span>
    </div>`;
  }

  _phaseOf(resource) {
    if (!resource) return 'Unknown';
    // Same derivation as the 3D status ring and label dot: condition-based kinds
    // (Route admission, ClusterOperator/ClusterVersion health, Node readiness)
    // must not fall back to the often-static status.phase.
    const status = visualStatusFor(resource, 'Active');
    if (status === 'Admitted' && resource.kind === 'Route') {
      try {
        const cluster = this._cluster();
        const service = cluster?.getRouteService?.(resource);
        const endpoints = service ? cluster?.getServiceEndpoints?.(service) : null;
        if (Array.isArray(endpoints) && endpoints.length === 0) return 'Pending';
      } catch {
        /* keep Admitted */
      }
    }
    return status;
  }

  _statusColor(phase) {
    return PHASE_COLORS[phase] || 'bg-white/40';
  }

  _usageTable(hard = {}, used = {}) {
    const keys = [...new Set([...Object.keys(hard || {}), ...Object.keys(used || {})])].sort();
    if (keys.length === 0) return '<span class="text-white/20 text-xs">No quota values</span>';
    return `<div class="mt-1 rounded-lg border border-white/5 overflow-hidden">
      <div class="grid grid-cols-3 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-wider text-white/30">
        <span>Resource</span><span class="text-right">Used</span><span class="text-right">Hard</span>
      </div>
      ${keys
        .map(
          (
            key
          ) => `<div class="grid grid-cols-3 px-2 py-1 text-[11px] font-mono ${this._quotaRowOver(key, hard, used) ? 'bg-red-500/10' : ''}">
        <span class="text-white/50 truncate">${this._escapeHTML(key)}</span>
        <span class="text-white/70 text-right">${this._escapeHTML(used?.[key] ?? '0')}</span>
        <span class="text-white/40 text-right">${this._escapeHTML(hard?.[key] ?? '-')}</span>
      </div>`
        )
        .join('')}
    </div>`;
  }

  _quotaRowOver(key, hard, used) {
    const hardValue = String(hard?.[key] ?? '');
    const usedValue = String(used?.[key] ?? '');
    if (!hardValue || hardValue === usedValue) return false;
    if (/cpu$/.test(key)) return this._parseCpu(usedValue) >= this._parseCpu(hardValue);
    if (/memory$/.test(key)) return this._parseMemory(usedValue) >= this._parseMemory(hardValue);
    const numericHard = Number.parseFloat(hardValue);
    const numericUsed = Number.parseFloat(usedValue);
    return (
      Number.isFinite(numericHard) &&
      numericHard > 0 &&
      Number.isFinite(numericUsed) &&
      numericUsed >= numericHard
    );
  }

  _parseCpu(value) {
    const text = String(value || '0');
    const number = Number.parseFloat(text) || 0;
    return text.endsWith('m') ? number : number * 1000;
  }

  _parseMemory(value) {
    const text = String(value || '0');
    const number = Number.parseFloat(text) || 0;
    if (/Ki$/.test(text)) return number / 1024;
    if (/Mi$/.test(text)) return number;
    if (/Gi$/.test(text)) return number * 1024;
    if (/Ti$/.test(text)) return number * 1024 * 1024;
    return number / (1024 * 1024);
  }

  _conditionsTable(conditions = []) {
    if (!conditions.length) return '<span class="text-white/20 text-xs">No conditions</span>';
    return `<div class="mt-1 space-y-1">
      ${conditions
        .map(
          (condition) => `<div class="flex items-center gap-2 text-[11px]">
        <span class="w-1.5 h-1.5 rounded-full ${condition.status === 'True' ? (condition.type === 'Degraded' || condition.type === 'Failing' ? 'bg-red-400' : 'bg-green-400') : 'bg-white/20'}"></span>
        <span class="text-white/60 font-mono w-24 shrink-0">${this._escapeHTML(condition.type)}</span>
        <span class="${condition.status === 'True' ? 'text-white/70' : 'text-white/35'}">${this._escapeHTML(condition.status)}</span>
        <span class="text-white/30 truncate">${this._escapeHTML(condition.reason || '')}</span>
      </div>`
        )
        .join('')}
    </div>`;
  }

  _countInProject(cluster, kind, project) {
    try {
      const resources = cluster?.getResourcesByKind?.(kind) || cluster?.getByKind?.(kind) || [];
      return resources.filter((resource) => resource.metadata?.namespace === project).length;
    } catch {
      return 0;
    }
  }

  _formatEventTime(timestamp) {
    if (!timestamp) return '';
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time)) return String(timestamp);
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  _age(resource) {
    const created = new Date(resource?.metadata?.creationTimestamp || 0).getTime();
    if (!Number.isFinite(created) || created <= 0) return 'Unknown';
    const seconds = Math.max(0, Math.floor((Date.now() - created) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  _formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown';
    const time = new Date(timestamp);
    return Number.isFinite(time.getTime()) ? time.toLocaleString() : String(timestamp);
  }

  _objectText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value))
      return value
        .map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item)))
        .join(', ');
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${item}`)
      .join(', ');
  }

  _previewValue(value) {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'object') {
      const text = JSON.stringify(value);
      return text.length > 160 ? `${text.slice(0, 160)}…` : text;
    }
    return String(value);
  }

  _text(value) {
    if (value === null || value === undefined || value === '') return '-';
    if (Array.isArray(value))
      return value.length
        ? value
            .map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item)))
            .join(', ')
        : '-';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  _escapeHTML(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
  }
}

export default InspectorPanel;
