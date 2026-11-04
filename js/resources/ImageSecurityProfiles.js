/**
 * ImageSecurityProfiles — known container-image security personalities.
 *
 * OpenShift SCC admission looks at the *Pod spec*, not at the image, so a bare
 * `nginx:latest` container (no securityContext) passes `restricted-v2`
 * admission on paper. On a real cluster the classic exam trap is that the
 * nginx image still tries to run as root (UID 0) and bind port 80, which
 * restricted-v2 rejects — the workload never becomes healthy.
 *
 * The simulator models this as an *effective* security request: images in this
 * table are treated as requesting `runAsUser: 0` unless the Pod/container
 * explicitly overrides the UID. The normal SCC admission path then rejects
 * them for restricted-v2/nonroot SCCs and admits them only under anyuid /
 * privileged (like a real cluster).
 *
 * This is deliberately separate from `js/engine/RBACEngine.js`'s
 * `podSecurityRequest()`: that function must keep honouring only *explicit*
 * pod-spec requests (SCC admission is spec-based). The image profile is an
 * engine-level heuristic layered in front of it.
 */

/**
 * @typedef {{
 *   id: string,
 *   description: string,
 *   runAsUser: number,
 *   ports: number[],
 *   matches: (image: string) => boolean,
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
 * exam traps only (nginx runs as UID 0 and binds port 80).
 * @type {KnownImageSecurityProfile[]}
 */
export const KNOWN_IMAGE_SECURITY_PROFILES = Object.freeze([
  {
    id: 'nginx-root-port80',
    description: 'nginx runs as UID 0 and binds port 80',
    runAsUser: 0,
    ports: [80],
    matches: isNginxImage,
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
 * Build the Pod spec the SCC admission path should evaluate: known root images
 * contribute an effective `runAsUser: 0` unless the Pod/container overrides it.
 * Returns a new spec object (the caller's spec is never mutated).
 *
 * @param {object} podSpec
 * @returns {object}
 */
export function applyKnownImageSecurityProfiles(podSpec) {
  const spec = podSpec && typeof podSpec === 'object' ? podSpec : {};
  const containers = Array.isArray(spec.containers) ? spec.containers : [];
  if (containers.length === 0) return spec;

  const podRunAsUser = spec.securityContext && typeof spec.securityContext.runAsUser === 'number'
    ? spec.securityContext.runAsUser
    : undefined;
  if (podRunAsUser !== undefined) return spec; // explicit Pod-level UID wins

  let changed = false;
  const effectiveContainers = containers.map((container) => {
    if (!container || typeof container !== 'object') return container;
    const explicitRunAsUser = container.securityContext && typeof container.securityContext.runAsUser === 'number'
      ? container.securityContext.runAsUser
      : undefined;
    if (explicitRunAsUser !== undefined) return container;
    const profile = knownImageSecurityProfile(container.image);
    if (!profile) return container;
    changed = true;
    return {
      ...container,
      securityContext: {
        ...(container.securityContext || {}),
        runAsUser: profile.runAsUser,
      },
    };
  });
  if (!changed) return spec;
  return { ...spec, containers: effectiveContainers };
}

/**
 * Message fragment describing why a known image is not admissible under the
 * resolved SCC (used to enrich controller events when useful).
 * @param {object} podSpec
 * @returns {string}
 */
export function knownImageSecurityProfileViolation(podSpec) {
  const containers = (podSpec && Array.isArray(podSpec.containers) ? podSpec.containers : []);
  for (const container of containers) {
    const profile = knownImageSecurityProfile(container?.image);
    if (profile) return `image ${container.image} ${profile.description}`;
  }
  return '';
}

export default { KNOWN_IMAGE_SECURITY_PROFILES, knownImageSecurityProfile, applyKnownImageSecurityProfiles, knownImageSecurityProfileViolation };
