/**
 * TemplateHash.js — deterministic `pod-template-hash` helpers shared by the
 * simulation engine and the CLI.
 *
 * A real Deployment controller names each ReplicaSet `<deployment>-<hash>` where
 * the hash is
 *
 *   pod-template-hash = rand.SafeEncodeString(fmt.Sprint(fnv32a(template)))
 *
 * (`kubernetes/pkg/controller/deployment`). The simulator reproduces that
 * algorithm exactly, and both the controller (js/engine/SimulationTick.js) and
 * the CLI (js/ui/CommandBar.js, which must predict the ReplicaSet name before a
 * paused pre-start cluster has ticked) import it from here so the two can never
 * drift apart again (issue #58: the paused `oc new-app` ScalingReplicaSet event
 * printed a truncated numeric name instead of the real hash suffix).
 *
 * @module engine/TemplateHash
 */

/** k8s.io/apimachinery `rand.String` safe alphabet (no vowels / look-alikes). */
export const RAND_SAFE_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';

/** Default pod template a Deployment controller assumes when spec.template is absent. */
export const DEFAULT_DEPLOYMENT_POD_TEMPLATE = {
  spec: { containers: [{ name: 'main', image: 'app:latest' }] },
};

/**
 * JSON with recursively sorted keys, so semantically identical templates always
 * hash identically (the real controller hashes the serialised pod template).
 * @param {*} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * FNV-1a 32-bit hash (the digest the Kubernetes Deployment controller hashes a
 * pod template with before SafeEncodeString-ing it).
 * @param {string} value
 * @returns {number} unsigned 32-bit digest
 */
export function fnv1aHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic 10-character `pod-template-hash` for a Pod template, shaped
 * exactly like the real Deployment controller's (`5d8f7c9b6`). The 32-bit FNV
 * digest is rendered as 10 decimal digits and every digit is mapped through the
 * k8s safe alphabet, so only `bcdfghjklmnpqrstvwxz2456789` can appear.
 * @param {object} [template] Pod template (`{metadata, spec}`)
 * @returns {string}
 */
export function templateHash(template) {
  const digest = fnv1aHash(stableStringify(template || {}));
  return String(digest)
    .padStart(10, '0')
    .split('')
    .map((digit) => RAND_SAFE_ALPHABET[digit.charCodeAt(0) % RAND_SAFE_ALPHABET.length])
    .join('');
}

/**
 * The name the Deployment controller will give the ReplicaSet for a Deployment's
 * current pod template: `<deployment>-<pod-template-hash>`. Safe to call before
 * the controller has ticked (paused pre-start sandbox), so CLI events can print
 * the same name it will later create (issue #58).
 * @param {object} deployment Deployment resource (instance or manifest object)
 * @returns {string|null}
 */
export function deploymentReplicaSetName(deployment) {
  const name = deployment?.metadata?.name || deployment?.name;
  if (!name) return null;
  const template = deployment?.spec?.template || DEFAULT_DEPLOYMENT_POD_TEMPLATE;
  return `${name}-${templateHash(template)}`;
}
