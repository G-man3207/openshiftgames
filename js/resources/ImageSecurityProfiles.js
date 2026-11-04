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
 * A second class of image personality is configuration-driven: the MySQL image
 * starts fine as an arbitrary UID but refuses to boot until database
 * credentials are supplied in the environment ("You must either specify the
 * following environment variables: MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 * or MYSQL_ROOT_PASSWORD"). That is the classic `oc new-app --image=… → crash →
 * oc set env` exercise (issue #31).
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
 *   runAsUser: number|null,
 *   ports: number[],
 *   matches: (image: string) => boolean,
 *   failureMode?: 'nonroot-scc'|'missing-env',
 *   requiresEnvironment?: string[][],
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
 * Does the image reference point at a MySQL server image (`mysql`, `mysql-80`,
 * `rhel9/mysql-80`, `mysql:8.0`, `mariadb`-style tags included)? The sclorg
 * MySQL images all share the same startup contract.
 */
function isMysqlImage(image) {
  const basename = imageBasename(image);
  if (!basename) return false;
  if (/^mysql(-\d+)?$/.test(basename)) return true;
  if (/^mariadb(-\d+)?$/.test(basename)) return true;
  return false;
}

/**
 * Known image personalities. Keep this list intentionally tiny; it models the
 * classic exam traps only.
 * @type {KnownImageSecurityProfile[]}
 */
export const KNOWN_IMAGE_SECURITY_PROFILES = Object.freeze([
  {
    id: 'nginx-root-port80',
    description: 'nginx runs as UID 0 and writes to root-owned /var/cache/nginx',
    runAsUser: 0,
    ports: [80],
    matches: isNginxImage,
    failureMode: 'nonroot-scc',
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
  {
    id: 'mysql-missing-credentials',
    description:
      'sclorg MySQL images need database credentials in the environment before they start',
    runAsUser: null, // supports an arbitrary UID — no SCC workaround needed
    ports: [3306],
    matches: isMysqlImage,
    failureMode: 'missing-env',
    // Either the complete application-user triple or MYSQL_ROOT_PASSWORD:
    // each inner array is one acceptable combination.
    requiresEnvironment: [
      ['MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'],
      ['MYSQL_ROOT_PASSWORD'],
    ],
    // The real sclorg entrypoint aborts with this message and exits 1, so the
    // Pod CrashLoopBackOffs until `oc set env` supplies the credentials (#31).
    runtimeFailure: {
      exitCode: 1,
      lastStateReason: 'Error',
      logLines: [
        'You must either specify the following environment variables:',
        "  * MYSQL_USER (regex: '^[a-zA-Z0-9_]+$')",
        "  * MYSQL_PASSWORD (regex: '^[a-zA-Z0-9_]+$')",
        "  * MYSQL_DATABASE (regex: '^[a-zA-Z0-9_]+$')",
        'Or the following environment variable:',
        "  * MYSQL_ROOT_PASSWORD (regex: '^[a-zA-Z0-9_]+$')",
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
 * The runtime failure persona of an image (nginx root crash, MySQL missing
 * credentials…). Returns null for images with no known runtime personality.
 *
 * The caller decides whether the failure applies: a `nonroot-scc` failure only
 * happens when the Pod is admitted by a non-root SCC, while a `missing-env`
 * failure happens whenever the required environment is absent.
 *
 * @param {string} image
 * @returns {KnownImageSecurityProfile['runtimeFailure']|null}
 */
export function knownImageRuntimeFailure(image) {
  const profile = knownImageSecurityProfile(image);
  return profile?.runtimeFailure || null;
}

/**
 * The container port an image listens on by default (e.g. nginx 80, MySQL
 * 3306); used as the `oc new-app` default when no `--port` is given so the
 * generated Service exposes the real image port (issue #31 lab 1).
 * @param {string} image
 * @returns {number|null}
 */
export function knownImageDefaultPort(image) {
  const profile = knownImageSecurityProfile(image);
  return profile?.ports?.[0] ?? null;
}

/**
 * Does a container's environment satisfy the image's startup requirements?
 * `valueFrom` references are treated as absent unless they resolve to a
 * non-empty literal (the simulator does not interpolate ConfigMap/Secret refs
 * into the image contract).
 * @param {{env?: Array<{name?: string, value?: unknown}>}} container
 * @param {KnownImageSecurityProfile} profile
 * @returns {boolean}
 */
export function imageEnvironmentSatisfied(container, profile) {
  if (!profile) return true;
  const requirements = profile.requiresEnvironment || [];
  if (requirements.length === 0) return true;
  const supplied = new Set(
    (container?.env || [])
      .filter((entry) => entry && entry.name && entry.value !== undefined && entry.value !== null)
      .map((entry) => String(entry.name))
  );
  return requirements.some((combination) => combination.every((envName) => supplied.has(envName)));
}

/**
 * Public helper returning the profiles' advertised ports (used by `oc new-app`
 * consumers that only have an image reference).
 * @param {string} image
 * @returns {number[]}
 */
export function knownImagePorts(image) {
  const profile = knownImageSecurityProfile(image);
  return profile?.ports ? [...profile.ports] : [];
}

export default {
  KNOWN_IMAGE_SECURITY_PROFILES,
  knownImageSecurityProfile,
  knownImageRuntimeFailure,
  knownImageDefaultPort,
  knownImagePorts,
  imageEnvironmentSatisfied,
};
