/**
 * Simulated platform versions — the single source of truth for OpenShift vs
 * Kubernetes version facts shown by the game.
 *
 * The target platform is OpenShift Container Platform 4.22, which runs
 * Kubernetes 1.35 with CRI-O as the container runtime (see
 * docs/research/openshift-workloads-builds.md, release-notes source [R36]).
 *
 * Before this module the numbers were scattered across the resource classes, the
 * command layer and the cluster seed; the node `VERSION` column still reported a
 * pre-fork Kubernetes build (v1.29.2) while `oc version` reported another one.
 * Keep every player-visible version string derived from here so `oc version`,
 * `oc get nodes`, `oc describe node` and the ClusterVersion singleton agree.
 *
 * These are simulated values for a study game; they are not a claim about any
 * real cluster's build identifiers.
 */

/** Platform release the game emulates. */
export const OCP_VERSION = '4.22.0';
/** Git version string printed by the client (`oc version`). */
export const OCP_GIT_VERSION = 'v4.22.0';
/** OpenShift update channel exposed by the ClusterVersion singleton. */
export const OCP_CHANNEL = 'stable-4.22';

/** Kubernetes version shipped in OpenShift 4.22. */
export const KUBERNETES_VERSION = '1.35.0';
/**
 * Kubernetes git version as printed by `oc version` / `oc get nodes`. OpenShift
 * node builds carry the platform build suffix, so kubelet and server agree.
 */
export const KUBERNETES_GIT_VERSION = 'v1.35.0+3f6a91c';
/** Kubelet version reported by a Node's status.nodeInfo. */
export const KUBELET_VERSION = KUBERNETES_GIT_VERSION;

/** CRI-O is OpenShift's container runtime (not containerd/docker). */
export const CRIO_VERSION = '1.35.2-1.rhaos4.22.git3f6a91c';
/** Container Runtime Version shown by `oc describe node`. */
export const CRIO_RUNTIME = `cri-o://${CRIO_VERSION}`;

/** Kustomize version printed by `oc version`. */
export const KUSTOMIZE_VERSION = 'v5.6.0';

/** osImage reported by a Red Hat Enterprise Linux CoreOS node. */
export const RHCOS_OS_IMAGE = 'Red Hat Enterprise Linux CoreOS 422.94.202610281503-0 (Plow)';
/** Kernel shipped with that RHCOS release. */
export const NODE_KERNEL_VERSION = '5.14.0-570.24.1.el9_6.x86_64';
