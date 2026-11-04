/**
 * ImageSecurityProfiles — known container-image security personalities.
 *
 * OpenShift SCC admission looks at the *Pod spec*, not at the image. A bare
 * `nginx:latest` container (no `securityContext`) therefore PASSES
 * `restricted-v2` admission and gets an arbitrary UID from the namespace
 * range; the image then fails at RUNTIME because it expects to start as UID 0
 * and write to root-owned paths (`/var/cache/nginx`, port 80). The classic exam
 * trap is therefore NOT an admission rejection: the Pod is admitted
 * (`openshift.io/scc: restricted-v2`) and ends up CrashLoopBackOff with
 * `nginx: [emerg] mkdir() "/var/cache/nginx/client_temp" failed (13: Permission
 * denied)` in `oc logs` (issue #25).
 *
 * This module is the single source of truth for those image personalities. It
 * is consumed by the kubelet-side pod lifecycle, never by SCC admission:
 * admission must keep honouring only *explicit* pod-spec requests
 * (`js/engine/RBACEngine.js` `podSecurityRequest()`). An image that needs root
 * only runs once the Pod is admitted by an anyuid/privileged-style SCC.
 */

/**
 * @typedef {{
 *   id: string,
 *   description: string,
 *   runAsUser: number,
 *   ports: number[],
 *   matches: (image: string) => boolean,
 *   runtimeFailure: {
 *     exitCode: number,
 *     lastStateReason: string,
 *     logLines: string[],
 *   },
 * }} KnownImageSecurityProfile
 */

/** Repository basename without registry/tag/digest (e.g. `quay.io/foo/nginx:1.2` → `nginx`). */
function imageBasename(image) {
  let ref = String(image || '').trim();
  if (!ref) return '';
  // Strip digest and tag (tag colon must come after the last slash — a registry
  // port such as `image-registry…svc:5000/ns/name:tag` keeps its host colon).
  const atIndex = ref.indexOf('@');
  if (atIndex >= 0) ref = ref.slice(0, atIndex);
  const slashIndex = ref.lastIndexOf('/');
  const colonIndex = ref.lastIndexOf(':');
  if (colonIndex > slashIndex) ref = ref.slice(0, colonIndex);
  const basename = ref.slice(ref.lastIndexOf('/') + 1).toLowerCase();
  // `library/nginx` forms normalize to the repository name itself.
  return basename;
}

/** Does the image reference point at the Docker-official `nginx` repository? */
function isNginxImage(image) {
  const basename = imageBasename(image);
  if (basename === 'nginx') return true;
  const ref = String(image || '').toLowerCase();
  return /(^|\/)library\/nginx(@|:|$)/.test(ref) || /^docker\.io\/library\/nginx(@|:|$)/.test(ref);
}

/**
 * Known root images. Keep this list intentionally tiny; it models the classic
 * exam traps only (nginx runs as UID 0 and owns /var/cache/nginx + port 80).
 * @type {KnownImageSecurityProfile[]}
 */
export const KNOWN_IMAGE_SECURITY_PROFILES = Object.freeze([
  {
    id: 'nginx-root-port80',
    description: 'nginx runs as UID 0 and writes to root-owned /var/cache/nginx',
    runAsUser: 0,
    ports: [80],
    matches: isNginxImage,
    // What actually happens when the image starts under a non-root SCC: the
    // kubelet starts the container with the namespace UID, nginx cannot create
    // its temp dir and exits 1 — `oc logs` shows the permission-denied emerge
    // line. This is the runtime half of the classic EX280 nginx trap (#25).
    runtimeFailure: {
      exitCode: 1,
      lastStateReason: 'Error',
      logLines: [
        "/docker-entrypoint.sh: 68: /docker-entrypoint.sh: mkdir: cannot create directory '/var/cache/nginx/client_temp': Permission denied",
        'nginx: [emerg] mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)',
      ],
    },
  },
]);

/**
 * Look up the security profile of a container image.
 * @param {string} image
 * @returns {KnownImageSecurityProfile|null}
 */
export function knownImageSecurityProfile(image) {
  if (!image) return null;
  return KNOWN_IMAGE_SECURITY_PROFILES.find((profile) => profile.matches(String(image))) || null;
}

/**
 * The runtime failure persona of an image that must start as root (nginx).
 * Returns null for images with no known runtime personality.
 *
 * @param {string} image
 * @returns {KnownImageSecurityProfile['runtimeFailure']|null}
 */
export function knownImageRuntimeFailure(image) {
  const profile = knownImageSecurityProfile(image);
  return profile?.runtimeFailure || null;
}

export default {
  KNOWN_IMAGE_SECURITY_PROFILES,
  knownImageSecurityProfile,
  knownImageRuntimeFailure,
};
