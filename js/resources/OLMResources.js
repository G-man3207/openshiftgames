/**
 * OLM (Operator Lifecycle Manager) resource classes — OpenShift 4.22 / EX280.
 *
 * Classic OLM object model used by the EX280 "Manage OpenShift operators"
 * objectives:
 *   - OperatorGroup           operators.coreos.com/v1          (namespaced)
 *   - Subscription            operators.coreos.com/v1alpha1    (js/resources/OpenShiftResources.js)
 *   - InstallPlan             operators.coreos.com/v1alpha1    (namespaced)
 *   - ClusterServiceVersion   operators.coreos.com/v1alpha1    (namespaced)
 *   - PackageManifest         packages.operators.coreos.com/v1 (cluster-scoped)
 *
 * MetalLB's operand CR (`MetalLB`, metallb.io/v1beta1) also lives here because
 * it is created/destroyed by the operator controller in SimulationTick.
 *
 * All classes extend ResourceBase and follow the same contract as the rest of
 * js/resources: constructor accepts just `{ name, namespace? }`, defaults are
 * deep-cloned, status skeletons exist immediately, and `toDescribe()` renders
 * an `oc describe`-shaped body.
 */

import { ResourceBase } from './ResourceBase.js';

const timestamp = () => new Date().toISOString();

/** Default install modes reported by an OLM ClusterServiceVersion. */
const DEFAULT_INSTALL_MODES = [
  { type: 'OwnNamespace', supported: true },
  { type: 'SingleNamespace', supported: true },
  { type: 'MultiNamespace', supported: false },
  { type: 'AllNamespaces', supported: true },
];

function renderKeyValueLines(entries) {
  const rows = entries.filter(([, value]) => value !== undefined && value !== null && String(value) !== '');
  return rows.map(([label, value]) => `  ${label}:${' '.repeat(Math.max(1, 26 - label.length))}${value}`).join('\n');
}

// ─── OperatorGroup ─────────────────────────────────────────────────────────

export class OperatorGroup extends ResourceBase {
  constructor(metadata = {}) {
    super('OperatorGroup', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'operators.coreos.com/v1',
    });
    const targetNamespaces = metadata.targetNamespaces
      || metadata.spec?.targetNamespaces
      || (metadata.namespace ? [metadata.namespace] : []);
    this._initSpec({ targetNamespaces: [...targetNamespaces] }, metadata.spec);
    this._setInitialStatus({
      namespaces: [...(this.spec.targetNamespaces || [])],
      lastUpdated: timestamp(),
      conditions: [],
    });
  }

  /** AllNamespaces installs (no explicit targetNamespaces) are cluster-global. */
  isAllNamespaces() {
    return !Array.isArray(this.spec.targetNamespaces) || this.spec.targetNamespaces.length === 0;
  }

  toDescribe() {
    const targets = this.isAllNamespaces() ? ['<all namespaces>'] : this.spec.targetNamespaces;
    return [
      `Name:           ${this.metadata.name}`,
      `Namespace:      ${this.metadata.namespace}`,
      `Labels:         ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}`,
      `Annotations:    ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}`,
      'API Version:    operators.coreos.com/v1',
      'Kind:           OperatorGroup',
      'Metadata:',
      `  Creation Timestamp:  ${this.metadata.creationTimestamp}`,
      'Spec:',
      '  Target Namespaces:',
      ...targets.map((namespace) => `    ${namespace}`),
      'Status:',
      `  Last Updated:  ${this.status.lastUpdated || this.metadata.creationTimestamp}`,
      '  Namespaces:',
      ...(this.status.namespaces || []).map((namespace) => `    ${namespace}`),
      'Events:',
      `${this.events.slice(-10).map((event) => `  ${event.type}\t${event.reason}\t${event.message}`).join('\n') || '  <none>'}`,
    ].join('\n');
  }
}

// ─── InstallPlan ───────────────────────────────────────────────────────────

export class InstallPlan extends ResourceBase {
  constructor(metadata = {}) {
    super('InstallPlan', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'operators.coreos.com/v1alpha1',
    });
    const csvNames = metadata.clusterServiceVersionNames
      || metadata.spec?.clusterServiceVersionNames
      || (metadata.csvName ? [metadata.csvName] : []);
    this._initSpec(
      {
        approval: metadata.approval || 'Automatic',
        approved: metadata.approved === true,
        clusterServiceVersionNames: [...csvNames],
        source: metadata.source || '',
        sourceNamespace: metadata.sourceNamespace || '',
        generation: 1,
      },
      metadata.spec
    );
    this._setInitialStatus({
      phase: 'RequiresApproval',
      plan: [],
      conditions: [],
      startTime: null,
      completionTime: null,
    });
  }

  get needsApproval() {
    return this.spec.approval === 'Manual' && this.spec.approved !== true;
  }

  setPlan(csvName, version = '1.0.0') {
    this.status.plan = [{
      resolving: '',
      resource: {
        apiVersion: 'operators.coreos.com/v1alpha1',
        kind: 'ClusterServiceVersion',
        name: csvName,
        version,
      },
      status: 'Created',
    }];
    this._bumpResourceVersion();
    return this;
  }

  markComplete() {
    this.status.phase = 'Complete';
    this.status.startTime = this.status.startTime || timestamp();
    this.status.completionTime = timestamp();
    this.status.plan = (this.status.plan || []).map((entry) => ({ ...entry, status: 'Created' }));
    this.setCondition('Installed', 'True', 'InstallPlanComplete', 'install plan approved and installed');
    this._bumpResourceVersion();
    return this;
  }

  toDescribe() {
    const planRows = (this.status.plan || []).map((entry) => {
      const name = entry.resource?.name || entry.name || '<none>';
      return `    ${name}`;
    });
    return [
      `Name:            ${this.metadata.name}`,
      `Namespace:       ${this.metadata.namespace}`,
      `Labels:          ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}`,
      `Annotations:     ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}`,
      'API Version:     operators.coreos.com/v1alpha1',
      'Kind:            InstallPlan',
      'Metadata:',
      `  Creation Timestamp:  ${this.metadata.creationTimestamp}`,
      'Spec:',
      `  Approval:      ${this.spec.approval}`,
      `  Approved:      ${this.spec.approved === true}`,
      '  Cluster Service Version Names:',
      ...(this.spec.clusterServiceVersionNames || []).map((name) => `    ${name}`),
      `  Generation:    ${this.metadata.generation || 1}`,
      'Status:',
      `  Phase:         ${this.status.phase}`,
      '  Plan:',
      ...(planRows.length ? planRows : ['    <none>']),
      'Events:',
      `${this.events.slice(-10).map((event) => `  ${event.type}\t${event.reason}\t${event.message}`).join('\n') || '  <none>'}`,
    ].join('\n');
  }
}

// ─── ClusterServiceVersion ─────────────────────────────────────────────────

export class ClusterServiceVersion extends ResourceBase {
  constructor(metadata = {}) {
    super('ClusterServiceVersion', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'operators.coreos.com/v1alpha1',
    });
    const packageName = metadata.packageName || metadata.displayName || metadata.name || 'operator';
    const displayName = metadata.displayName
      || String(packageName).replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
    const version = metadata.version || '1.0.0';
    this._initSpec(
      {
        displayName,
        description: metadata.description || '',
        version,
        maturity: 'stable',
        installModes: metadata.installModes || DEFAULT_INSTALL_MODES.map((mode) => ({ ...mode })),
        install: {
          strategy: 'deployment',
          spec: {
            deployments: [{
              name: `${String(metadata.name || packageName).replace(/\.v\d+.*$/, '')}-controller-manager`,
              spec: {
                replicas: 1,
                selector: { matchLabels: { name: `${packageName}-operator` } },
                template: {
                  metadata: { labels: { name: `${packageName}-operator` } },
                  spec: {
                    serviceAccountName: 'default',
                    containers: [{
                      name: 'manager',
                      image: metadata.image || `${String(packageName).replace(/-operator$/, '')}-operator:latest`,
                      resources: { requests: { cpu: '10m', memory: '64Mi' }, limits: { cpu: '200m', memory: '256Mi' } },
                    }],
                  },
                },
              },
            }],
          },
        },
        customresourcedefinitions: { owned: metadata.ownedCrds ? [...metadata.ownedCrds] : [] },
        provider: { name: metadata.provider || 'Red Hat' },
      },
      metadata.spec
    );
    this._setInitialStatus({
      phase: 'Installing',
      reason: 'InstallWaiting',
      message: `waiting for InstallPlan to install ${String(packageName)}`,
      conditions: [],
    });
  }

  get packageName() {
    return this.spec.displayName || this.metadata.name;
  }

  markInstalling(message = '') {
    this.status.phase = 'Installing';
    this.status.reason = 'InstallWaiting';
    this.status.message = message || `installing ${this.metadata.name}`;
    this.setCondition('InstallWaiting', 'True', 'Installing', this.status.message);
    this._bumpResourceVersion();
    return this;
  }

  markSucceeded() {
    this.status.phase = 'Succeeded';
    this.status.reason = 'InstallSucceeded';
    this.status.message = `install strategy completed with no errors`;
    this.status.installPlanRef = this.status.installPlanRef || null;
    this.setCondition('Deployed', 'True', 'InstallSucceeded', this.status.message);
    this._bumpResourceVersion();
    return this;
  }

  markFailed(reason, message) {
    this.status.phase = 'Failed';
    this.status.reason = reason || 'InstallFailed';
    this.status.message = message || 'operator install failed';
    this.setCondition('Deployed', 'False', this.status.reason, this.status.message);
    this._bumpResourceVersion();
    return this;
  }

  toDescribe() {
    const conditions = (this.status.conditions || []).map(
      (condition) => `    Type:      ${condition.type}\n    Status:    ${condition.status}\n    Reason:    ${condition.reason || '<none>'}\n    Message:   ${condition.message || '<none>'}`
    );
    return [
      `Name:           ${this.metadata.name}`,
      `Namespace:      ${this.metadata.namespace}`,
      `Labels:         ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}`,
      `Annotations:    ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}`,
      'API Version:    operators.coreos.com/v1alpha1',
      'Kind:           ClusterServiceVersion',
      'Metadata:',
      `  Creation Timestamp:  ${this.metadata.creationTimestamp}`,
      'Spec:',
      renderKeyValueLines([
        ['Display Name', this.spec.displayName],
        ['Version', this.spec.version],
        ['Provider', this.spec.provider?.name || ''],
        ['Maturity', this.spec.maturity],
      ]),
      '  Install Modes:',
      ...(this.spec.installModes || []).map((mode) => `    ${mode.type}: ${mode.supported === true}`),
      'Status:',
      `  Phase:        ${this.status.phase}`,
      `  Reason:       ${this.status.reason || '<none>'}`,
      `  Message:      ${this.status.message || '<none>'}`,
      '  Conditions:',
      ...(conditions.length ? conditions : ['    <none>']),
      'Events:',
      `${this.events.slice(-10).map((event) => `  ${event.type}\t${event.reason}\t${event.message}`).join('\n') || '  <none>'}`,
    ].join('\n');
  }
}

// ─── PackageManifest (cluster-scoped catalog entry) ────────────────────────

export class PackageManifest extends ResourceBase {
  constructor(metadata = {}) {
    super('PackageManifest', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'packages.operators.coreos.com/v1',
    });
    const packageName = metadata.packageName || metadata.name || 'package';
    const channelName = metadata.defaultChannel || 'stable';
    this._initSpec(
      {
        packageName,
        defaultChannel: channelName,
        channels: metadata.channels ? [...metadata.channels] : [],
      },
      metadata.spec
    );
    this._setInitialStatus({
      catalogSource: metadata.catalogSource || 'redhat-operators',
      catalogSourceNamespace: metadata.catalogSourceNamespace || 'openshift-marketplace',
      packageName,
      defaultChannel: this.spec.defaultChannel,
      channels: metadata.statusChannels || [],
      provider: metadata.provider || { name: 'Red Hat' },
    });
  }

  /** Current CSV of the default channel (from the catalog data). */
  get currentCSV() {
    const channels = this.status.channels || this.spec.channels || [];
    const defaultChannel = this.status.defaultChannel || this.spec.defaultChannel;
    const channel = channels.find((entry) => entry.name === defaultChannel) || channels[0];
    if (channel?.currentCSV) return channel.currentCSV;
    const specChannel = (this.spec.channels || []).find((entry) => entry.name === defaultChannel) || (this.spec.channels || [])[0];
    return specChannel?.currentCSV || '';
  }

  get currentCSVVersion() {
    const match = String(this.currentCSV || '').match(/\.v?(\d+\.\d+\.\d+)/);
    return match ? match[1] : '1.0.0';
  }

  toDescribe() {
    const channels = this.status.channels || this.spec.channels || [];
    return [
      `Name:        ${this.metadata.name}`,
      'Package Name: ' + (this.status.packageName || this.spec.packageName),
      `Default Channel:  ${this.status.defaultChannel || this.spec.defaultChannel}`,
      `Source:      ${this.status.catalogSource || '<none>'}`,
      `Source Namespace: ${this.status.catalogSourceNamespace || '<none>'}`,
      'Provider:    ' + (this.status.provider?.name || '<none>'),
      'Channels:',
      ...channels.map((channel) => `  Name:     ${channel.name}\n    Current CSV:  ${channel.currentCSV || '<none>'}`),
      'Events:',
      `${this.events.slice(-10).map((event) => `  ${event.type}\t${event.reason}\t${event.message}`).join('\n') || '  <none>'}`,
    ].join('\n');
  }
}

// ─── MetalLB operand CR ────────────────────────────────────────────────────

export class MetalLB extends ResourceBase {
  constructor(metadata = {}) {
    super('MetalLB', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'metallb.io/v1beta1',
    });
    this._initSpec(
      {
        nodeSelector: metadata.nodeSelector || {},
        speaker: metadata.speaker || { frr: {}, logLevel: 'info' },
        controller: metadata.controller || { logLevel: 'info' },
      },
      metadata.spec
    );
    this._setInitialStatus({
      phase: 'Ready',
      conditions: [{
        type: 'Ready',
        status: 'True',
        reason: 'MetalLBReady',
        message: 'MetalLB is running',
        lastTransitionTime: timestamp(),
      }],
    });
  }

  toDescribe() {
    return [
      `Name:           ${this.metadata.name}`,
      `Namespace:      ${this.metadata.namespace}`,
      `Labels:         ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}`,
      'API Version:    metallb.io/v1beta1',
      'Kind:           MetalLB',
      'Spec:',
      '  Controller:   {}',
      '  Speaker:      {}',
      'Status:',
      `  Phase:        ${this.status.phase}`,
      'Events:',
      `${this.events.slice(-10).map((event) => `  ${event.type}\t${event.reason}\t${event.message}`).join('\n') || '  <none>'}`,
    ].join('\n');
  }
}

export default { OperatorGroup, InstallPlan, ClusterServiceVersion, PackageManifest, MetalLB };
