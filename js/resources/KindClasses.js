/**
 * KindClasses — the Kind → resource class registry.
 *
 * Importing this module gives every consumer (kindRegistry, CLI, inspector,
 * tests, ...) the concrete rich resource classes without importing each file
 * individually. `js/data/kindRegistry.js` uses `KIND_CLASSES` to implement
 * `createResource()`.
 *
 * Contract:
 *   - `KIND_CLASSES[kind]` is the class whose constructor accepts a single
 *     optional metadata object: `new Class({ name, namespace, spec?, ... })`.
 *   - Every kind in kindRegistry.RESOURCE_KINDS must have exactly one entry.
 *   - No circular imports: this module imports only resource class files;
 *     resource classes import ResourceBase + ManifestSerializer only.
 */

import { Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, CronJob } from './WorkloadResources.js';
import { Service, Ingress, NetworkPolicy } from './NetworkResources.js';
import { ConfigMap, Secret } from './ConfigResources.js';
import { PersistentVolume, StorageClass, PersistentVolumeClaim } from './StorageResources.js';
import { Node, HorizontalPodAutoscaler, ResourceQuota, PodDisruptionBudget } from './ClusterResources.js';
import { ServiceAccount, Role, ClusterRole, RoleBinding, ClusterRoleBinding } from './RBACResources.js';
import {
  Project,
  Route,
  BuildConfig,
  Build,
  ImageStream,
  Template,
  Subscription,
  SecurityContextConstraints,
  ClusterResourceQuota,
  LimitRange,
  OAuth,
  ClusterOperator,
  ClusterVersion,
  IPAddressPool,
  L2Advertisement,
} from './OpenShiftResources.js';
import { User, Group, Identity } from './IdentityResources.js';

/** @type {Record<string, typeof import('./ResourceBase.js').ResourceBase>} */
export const KIND_CLASSES = Object.freeze({
  // Projects & cluster
  Project,
  Node,
  ClusterResourceQuota,
  // Workloads
  Pod,
  Deployment,
  ReplicaSet,
  StatefulSet,
  DaemonSet,
  Job,
  CronJob,
  // Builds & images
  BuildConfig,
  Build,
  ImageStream,
  // Networking
  Service,
  Route,
  Ingress,
  NetworkPolicy,
  IPAddressPool,
  L2Advertisement,
  // Config
  ConfigMap,
  Secret,
  LimitRange,
  ResourceQuota,
  Template,
  // Storage
  PersistentVolume,
  PersistentVolumeClaim,
  StorageClass,
  // Scaling & availability
  HorizontalPodAutoscaler,
  PodDisruptionBudget,
  // Security
  ServiceAccount,
  Role,
  ClusterRole,
  RoleBinding,
  ClusterRoleBinding,
  SecurityContextConstraints,
  // Identity & operators
  User,
  Group,
  Identity,
  OAuth,
  Subscription,
  ClusterOperator,
  ClusterVersion,
});

/**
 * Look up the rich class for a kind (null when unknown).
 * @param {string} kind
 * @returns {Function|null}
 */
export function classForKind(kind) {
  return KIND_CLASSES[kind] || null;
}

export {
  // Re-export every class so consumers can take Route/Project/etc. from this module.
  Project,
  Node,
  ClusterResourceQuota,
  Pod,
  Deployment,
  ReplicaSet,
  StatefulSet,
  DaemonSet,
  Job,
  CronJob,
  BuildConfig,
  Build,
  ImageStream,
  Service,
  Route,
  Ingress,
  NetworkPolicy,
  IPAddressPool,
  L2Advertisement,
  ConfigMap,
  Secret,
  LimitRange,
  ResourceQuota,
  Template,
  PersistentVolume,
  PersistentVolumeClaim,
  StorageClass,
  HorizontalPodAutoscaler,
  PodDisruptionBudget,
  ServiceAccount,
  Role,
  ClusterRole,
  RoleBinding,
  ClusterRoleBinding,
  SecurityContextConstraints,
  User,
  Group,
  Identity,
  OAuth,
  Subscription,
  ClusterOperator,
  ClusterVersion,
};

export default KIND_CLASSES;
