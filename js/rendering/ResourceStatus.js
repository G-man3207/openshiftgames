/**
 * ResourceStatus — shared derivation of a resource's *visual* status.
 *
 * The 3D diorama (pedestal status ring), the HTML label layer and the
 * InspectorPanel header must all agree with what `oc get` / `oc describe`
 * report. Several OpenShift kinds communicate their real state through
 * `status.conditions` rather than `status.phase`:
 *
 *   • ClusterOperator  — Degraded/Available/Progressing conditions
 *                        (`status.phase` is permanently "Active")
 *   • ClusterVersion   — Available/Progressing/Failing conditions
 *   • Route            — `status.ingress[].conditions[]` type=Admitted
 *                        (`status.phase` is not updated by the route controller)
 *   • Node             — Ready condition
 *   • Deployment       — Available/Progressing conditions
 *                        (`status.phase` is only the constructor default
 *                        "Pending" and is never updated by the controller —
 *                        issue #23: the 3D label stayed "Pending" forever)
 *
 * `visualStatusFor(resource)` is the single source of truth for the visual
 * layer: it resolves the live resource (`resource._ref` for renderer
 * snapshots), prefers condition-derived state for these kinds and otherwise
 * falls back to `status.phase` / `status.state`.
 *
 * The module is dependency-free (no THREE, no DOM) so it can be imported by
 * rendering code, the inspector and Node-side checks.
 */

/** Statuses that deserve an attention suffix in the label layer (and a pulse). */
export const ATTENTION_STATUSES = Object.freeze([
  'Pending',
  'New',
  'Installing',
  'Progressing',
  'Updating',
  'Degraded',
  'Unavailable',
  'Rejected',
  'Failed',
  'CrashLoop',
  'CrashLoopBackOff',
  'NotReady',
  'Terminating',
  'Suspended',
  'Paused',
]);

const ATTENTION_SET = new Set(ATTENTION_STATUSES);

/** Normal (non-attention) statuses — used to decide label text. */
export function isAttentionStatus(status) {
  return ATTENTION_SET.has(String(status || ''));
}

/** Resolve the live resource behind a renderer snapshot (`{..., _ref}`). */
function refOf(resource) {
  if (!resource || typeof resource !== 'object') return null;
  return resource._ref && typeof resource._ref === 'object' ? resource._ref : resource;
}

function kindOf(resource, ref) {
  return String(resource?.kind || resource?.type || ref?.kind || ref?.type || '');
}

function statusObject(ref) {
  return ref && typeof ref.status === 'object' && ref.status !== null ? ref.status : null;
}

function phaseOf(resource, ref) {
  if (typeof ref?.status === 'string') return ref.status;
  const fromRef = ref?.status?.phase || ref?.status?.state;
  if (fromRef) return String(fromRef);
  if (typeof resource?.status === 'string') return resource.status;
  const fromPhase = resource?.status?.phase || resource?.status?.state;
  return fromPhase ? String(fromPhase) : null;
}

function conditionStatus(conditions, type) {
  if (!Array.isArray(conditions)) return null;
  const condition = conditions.find((entry) => entry && entry.type === type);
  return condition ? String(condition.status || '') : null;
}

function hasCondition(conditions, type, status) {
  return conditionStatus(conditions, type) === status;
}

/** First Admitted condition of a Route (status.ingress[].conditions[]). */
function routeAdmittedCondition(ref) {
  const ingress = Array.isArray(ref?.status?.ingress) ? ref.status.ingress : [];
  for (const entry of ingress) {
    const conditions = Array.isArray(entry?.conditions) ? entry.conditions : [];
    const admitted = conditions.find((condition) => condition && condition.type === 'Admitted');
    if (admitted) return admitted;
  }
  return null;
}

/**
 * Derive the status string the visual layer should show.
 *
 * @param {object|null} resource live resource or renderer snapshot (`{kind,status,_ref}`)
 * @param {string|null} [fallback] status to use when nothing else is known
 * @returns {string}
 */
export function visualStatusFor(resource, fallback = null) {
  const ref = refOf(resource);
  if (!ref && !resource) return fallback || 'Unknown';
  const kind = kindOf(resource, ref);
  const phase = phaseOf(resource, ref);
  const conditions = statusObject(ref)?.conditions;

  switch (kind) {
    case 'Route': {
      const admitted = routeAdmittedCondition(ref);
      if (admitted) {
        if (String(admitted.status) === 'True') return 'Admitted';
        const reason = String(admitted.reason || '');
        // A router-rejected route is a hard failure; "no endpoints yet" is pending.
        return /reject|invalid/i.test(reason) ? 'Rejected' : 'Pending';
      }
      // Routes seeded by the showcase/menu may carry an explicit phase only.
      if (phase && phase !== 'Active' && phase !== 'Pending') return phase;
      return 'Pending';
    }

    case 'ClusterOperator': {
      if (hasCondition(conditions, 'Degraded', 'True')) return 'Degraded';
      if (hasCondition(conditions, 'Available', 'False')) return 'Unavailable';
      if (hasCondition(conditions, 'Progressing', 'True')) return 'Progressing';
      if (hasCondition(conditions, 'Available', 'True')) return 'Available';
      return phase && phase !== 'Active' ? phase : fallback || 'Unknown';
    }

    case 'ClusterVersion': {
      if (hasCondition(conditions, 'Failing', 'True')) return 'Degraded';
      if (hasCondition(conditions, 'Available', 'False')) return 'Unavailable';
      if (hasCondition(conditions, 'Progressing', 'True')) return 'Progressing';
      if (hasCondition(conditions, 'Available', 'True')) return 'Available';
      return phase && phase !== 'Active' ? phase : fallback || 'Unknown';
    }

    case 'Node': {
      const ready = conditionStatus(conditions, 'Ready');
      if (ready === 'True') return 'Ready';
      if (ready === 'False' || ready === 'Unknown') return 'NotReady';
      return phase === 'Running' ? 'Ready' : phase || fallback || 'Unknown';
    }

    case 'Deployment': {
      // Deployment.status.phase is never updated by the controller (it stays at
      // the constructor's "Pending"), so the visual layer must derive the real
      // state from the Available/Progressing conditions + replica counts (#23).
      const desired = Math.max(0, Number(ref?.spec?.replicas ?? 1) || 0);
      const available = Number(ref?.status?.availableReplicas ?? 0) || 0;
      const progressing = Array.isArray(conditions)
        ? conditions.find((condition) => condition && condition.type === 'Progressing')
        : null;
      if (hasCondition(conditions, 'ReplicaFailure', 'True')) return 'Failed';
      if (hasCondition(conditions, 'Available', 'True')) {
        // A mid-rollout Deployment is Available but not yet fully updated.
        return desired === 0 || available >= desired ? 'Running' : 'Progressing';
      }
      if (hasCondition(conditions, 'Available', 'False')) {
        const deadlineExceeded =
          String(progressing?.status) === 'False' &&
          String(progressing?.reason) === 'ProgressDeadlineExceeded';
        return deadlineExceeded ? 'Failed' : 'Progressing';
      }
      // No controller conditions yet (freshly applied object): keep the honest
      // phase rather than inventing a state.
      return phase && phase !== 'Pending' ? phase : fallback || 'Pending';
    }

    default:
      return phase || fallback || 'Active';
  }
}

export default { visualStatusFor, isAttentionStatus, ATTENTION_STATUSES };
