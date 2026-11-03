import { ResourceBase } from './ResourceBase.js';
import { deepClone } from './ManifestSerializer.js';

function parseStorageBytes(storage) {
  if (typeof storage === 'number') return storage;
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  for (const [suffix, multiplier] of Object.entries(units)) {
    if (String(storage).endsWith(suffix)) return parseFloat(storage) * multiplier;
  }
  const parsed = parseFloat(storage);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class PersistentVolume extends ResourceBase {
  constructor(metadata = {}) {
    super('PersistentVolume', { ...metadata, namespace: '', apiVersion: metadata.apiVersion || 'v1' });
    const defaults = {
      capacity: { storage: metadata.capacity || '10Gi' },
      accessModes: deepClone(metadata.accessModes || ['ReadWriteOnce']),
      persistentVolumeReclaimPolicy: metadata.reclaimPolicy || 'Retain',
      storageClassName: metadata.storageClassName || 'standard',
      volumeMode: metadata.volumeMode || 'Filesystem',
    };
    if (metadata.hostPath) defaults.hostPath = { path: metadata.hostPath };
    if (metadata.nfs) defaults.nfs = deepClone(metadata.nfs);
    if (metadata.csi) defaults.csi = deepClone(metadata.csi);
    if (metadata.claimRef) defaults.claimRef = deepClone(metadata.claimRef);
    if (metadata.nodeAffinity) defaults.nodeAffinity = deepClone(metadata.nodeAffinity);
    if (metadata.mountOptions) defaults.mountOptions = deepClone(metadata.mountOptions);
    this._initSpec(defaults, metadata.spec);
    this.capacityBytes = parseStorageBytes(this.spec.capacity?.storage);
    this._setInitialStatus({ phase: 'Available' });
  }

  get phase() {
    return this.status.phase;
  }

  set phase(value) {
    this.status.phase = value;
  }

  bind(pvcName, pvcNamespace, pvcUid) {
    this.spec.claimRef = { name: pvcName, namespace: pvcNamespace, uid: pvcUid };
    this.setPhase('Bound');
    this.addEvent('Normal', 'Bound', `Bound to PVC ${pvcNamespace}/${pvcName}`);
    return this;
  }

  release() {
    this.setPhase('Released');
    this.addEvent('Normal', 'Released', 'Released from claim');
    return this;
  }

  reclaim() {
    if (this.spec.persistentVolumeReclaimPolicy === 'Delete') {
      this.setPhase('Failed');
    } else {
      delete this.spec.claimRef;
      this.setPhase('Available');
    }
    return this;
  }

  markFailed(reason) {
    this.setPhase('Failed');
    this.addEvent('Warning', 'VolumeFailed', reason || 'Volume is in a failed state');
    return this;
  }

  toDescribe() {
    const claim = this.spec.claimRef;
    return `Name:            ${this.metadata.name}
Labels:          ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:     ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Finalizers:      [kubernetes.io/pv-protection]
StorageClass:    ${this.spec.storageClassName}
Status:          ${this.status.phase}
Claim:           ${claim ? `${claim.namespace}/${claim.name}` : '<none>'}
Reclaim Policy:  ${this.spec.persistentVolumeReclaimPolicy}
Access Modes:    ${(this.spec.accessModes || []).join(', ')}
VolumeMode:      ${this.spec.volumeMode}
Capacity:        ${this.spec.capacity?.storage}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

export class StorageClass extends ResourceBase {
  constructor(metadata = {}) {
    super('StorageClass', { ...metadata, namespace: '', apiVersion: metadata.apiVersion || 'storage.k8s.io/v1' });
    const isDefault = metadata.isDefault || metadata.default === true;
    if (isDefault) {
      this.metadata.annotations['storageclass.kubernetes.io/is-default-class'] = 'true';
    }
    const defaults = {
      provisioner: metadata.provisioner || 'kubernetes.io/no-provisioner',
      reclaimPolicy: metadata.reclaimPolicy || 'Delete',
      volumeBindingMode: metadata.volumeBindingMode || 'WaitForFirstConsumer',
      allowVolumeExpansion: metadata.allowVolumeExpansion ?? false,
    };
    if (metadata.parameters && Object.keys(metadata.parameters).length > 0) {
      defaults.parameters = deepClone(metadata.parameters);
    }
    if (metadata.mountOptions) defaults.mountOptions = deepClone(metadata.mountOptions);
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  get isDefault() {
    return this.metadata.annotations['storageclass.kubernetes.io/is-default-class'] === 'true';
  }

  toDescribe() {
    return `Name:                  ${this.metadata.name}
IsDefaultClass:        ${this.isDefault ? 'Yes' : 'No'}
Annotations:           ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Provisioner:           ${this.spec.provisioner}
Parameters:            ${Object.entries(this.spec.parameters || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
AllowVolumeExpansion:  ${this.spec.allowVolumeExpansion}
MountOptions:          ${(this.spec.mountOptions || []).join(', ') || '<none>'}
ReclaimPolicy:         ${this.spec.reclaimPolicy}
VolumeBindingMode:     ${this.spec.volumeBindingMode}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

export class PersistentVolumeClaim extends ResourceBase {
  constructor(metadata = {}) {
    super('PersistentVolumeClaim', { ...metadata, apiVersion: metadata.apiVersion || 'v1' });
    const defaults = {
      accessModes: deepClone(metadata.accessModes || ['ReadWriteOnce']),
      resources: {
        requests: { storage: metadata.storageRequest || metadata.storage || '10Gi' },
        ...(metadata.storageLimit ? { limits: { storage: metadata.storageLimit } } : {}),
      },
      storageClassName: metadata.storageClassName || 'standard',
      volumeMode: metadata.volumeMode || 'Filesystem',
    };
    if (metadata.volumeName) defaults.volumeName = metadata.volumeName;
    if (metadata.selector) defaults.selector = deepClone(metadata.selector);
    this._initSpec(defaults, metadata.spec);
    this.capacityBytes = parseStorageBytes(this.spec.resources?.requests?.storage);
    this.mountedBy = [];
    this.usedBytes = 0;
    this._setInitialStatus({
      phase: 'Pending',
      accessModes: [],
      capacity: {},
      conditions: [],
    });
  }

  get phase() {
    return this.status.phase;
  }

  set phase(value) {
    this.status.phase = value;
  }

  get boundVolume() {
    return this.spec.volumeName || null;
  }

  get capacity() {
    return this.status.capacity;
  }

  _formatBytes(bytes) {
    if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)}Ti`;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}Gi`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}Mi`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}Ki`;
    return `${bytes}`;
  }

  bind(volumeName) {
    this.spec.volumeName = volumeName;
    this.status.capacity = { storage: this.spec.resources?.requests?.storage };
    this.status.accessModes = deepClone(this.spec.accessModes || []);
    this.status.conditions = [
      {
        type: 'Bound',
        status: 'True',
        lastTransitionTime: new Date().toISOString(),
        reason: 'Bound',
        message: `Bound to ${volumeName}`,
      },
    ];
    this.setPhase('Bound');
    this.addEvent('Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${volumeName}`);
    return this;
  }

  release() {
    this.setPhase('Released');
    this.addEvent('Normal', 'Released', 'PVC released');
    return this;
  }

  markLost() {
    this.setPhase('Lost');
    this.addEvent('Warning', 'VolumeLost', 'Bound volume is no longer available');
    return this;
  }

  addMountReference(podName) {
    if (!this.mountedBy.includes(podName)) this.mountedBy.push(podName);
  }

  removeMountReference(podName) {
    this.mountedBy = this.mountedBy.filter((name) => name !== podName);
  }

  getUsagePercent() {
    if (!this.capacityBytes) return 0;
    return (this.usedBytes / this.capacityBytes) * 100;
  }

  toDescribe() {
    return `Name:          ${this.metadata.name}
Namespace:     ${this.metadata.namespace}
StorageClass:  ${this.spec.storageClassName}
Status:        ${this.status.phase}
Volume:        ${this.spec.volumeName || '<none>'}
Labels:        ${Object.entries(this.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Annotations:   ${Object.entries(this.metadata.annotations).map(([k, v]) => `${k}=${v}`).join(', ') || '<none>'}
Finalizers:    [kubernetes.io/pvc-protection]
Capacity:      ${this.status.capacity?.storage || '<pending>'}
Access Modes:  ${(this.spec.accessModes || []).join(', ')}
VolumeMode:    ${this.spec.volumeMode}
Used By:       ${this.mountedBy.join(', ') || '<none>'}
Conditions:
${(this.status.conditions || []).map((c) => `  Type: ${c.type}  Status: ${c.status}  Reason: ${c.reason}`).join('\n') || '  <none>'}
Events:
${this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`).join('\n')}`;
  }
}

export { parseStorageBytes };
export default { PersistentVolume, StorageClass, PersistentVolumeClaim };
