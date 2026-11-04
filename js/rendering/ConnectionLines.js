import * as THREE from 'three';

/**
 * Connection line manager for the OpenShift cluster view.
 *
 * Draws the semantic edges computed by js/rendering/RelationGraph.js:
 * ownership / containment / network / route / build / image / security /
 * identity / storage / config / scaling / operator (+ custom draw-page lines).
 *
 * When a ParticleTrafficSystem is supplied, route/network/build edges also spawn
 * animated traffic particles (see ParticleTraffic.js).
 */

export const RELATIONSHIP_COLORS = {
  ownership:    0x8899ab,
  containment:  0x56657a,
  network:      0x5b9fd4,
  route:        0xd94a42, // softened OpenShift red
  build:        0xd98a4a, // softened OpenShift orange
  image:        0x9a86cc,
  security:     0xc2a04a,
  identity:     0x4fa9a4,
  storage:      0x6f8a86,
  config:       0xb79a4a,
  scaling:      0x9c86c9,
  operator:     0xd08a54,
  custom:       0x5b9fd4,
  default:      0x56657a,
};

/**
 * Base opacity per relationship — containment edges touch almost every resource and
 * must stay near-invisible, while the OpenShift delivery path (route/build/operator)
 * is allowed a little more presence. Hover/selection multiplies these.
 */
export const RELATIONSHIP_OPACITY = {
  ownership:    0.14,
  containment:  0.045,
  network:      0.2,
  route:        0.3,
  build:        0.24,
  image:        0.2,
  security:     0.16,
  identity:     0.16,
  storage:      0.14,
  config:       0.16,
  scaling:      0.16,
  operator:     0.2,
  custom:       0.26,
  default:      0.12,
};

/** Human-readable relationship labels (used by tooltips / debugging). */
export const RELATIONSHIP_LABELS = {
  ownership: 'owner reference',
  containment: 'project membership',
  network: 'service selector',
  route: 'Route → Service',
  build: 'build → image',
  image: 'image stream → workload',
  security: 'SCC grant',
  identity: 'RBAC binding',
  storage: 'storage binding',
  config: 'config reference',
  scaling: 'autoscaler / budget',
  operator: 'operator install',
  custom: 'drawn connection',
};

const DASH_SIZE = 0.16;
const GAP_SIZE = 0.28;
const CURVE_SEGMENTS = 36;
const FLOW_SPEED = 0.35;
const BASE_LINE_WIDTH = 1;
const MIN_OPACITY = 0.05;
const MAX_OPACITY = 0.62;
const HOVER_OPACITY = 0.58;
const ARC_RATIO = 0.14;
const ARC_MAX = 1.7;

export function colorForRelationship(type) {
  return RELATIONSHIP_COLORS[type] || RELATIONSHIP_COLORS.default;
}

export class ConnectionLineManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./ParticleTraffic.js').ParticleTrafficSystem} [particleTraffic]
   */
  constructor(scene, particleTraffic = null) {
    this.scene = scene;
    this.particleTraffic = particleTraffic;
    this.connections = new Map();
    this.lineGroup = new THREE.Group();
    this.scene.add(this.lineGroup);
  }

  addConnection(connection, resourceMeshes) {
    if (this.connections.has(connection.id)) return;

    const sourceGroup = resourceMeshes.get(connection.sourceId);
    const targetGroup = resourceMeshes.get(connection.targetId);
    if (!sourceGroup || !targetGroup) return;

    const sourcePos = sourceGroup.position.clone();
    const targetPos = targetGroup.position.clone();

    const midpoint = new THREE.Vector3().lerpVectors(sourcePos, targetPos, 0.5);
    const distance = sourcePos.distanceTo(targetPos);
    // A shallow arc reads as a conduit; a tall one reads as a mistake.
    midpoint.y += Math.min(distance * ARC_RATIO, ARC_MAX) + 0.35;

    const curve = new THREE.QuadraticBezierCurve3(sourcePos, midpoint, targetPos);
    const points = curve.getPoints(CURVE_SEGMENTS);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);

    const relationColor = colorForRelationship(connection.type);
    const trafficVolume = connection.trafficVolume || 1;
    const baseOpacity = RELATIONSHIP_OPACITY[connection.type] ?? RELATIONSHIP_OPACITY.default;
    const opacity = Math.min(baseOpacity * (0.85 + trafficVolume * 0.1), MAX_OPACITY);

    const material = new THREE.LineDashedMaterial({
      color: relationColor,
      dashSize: DASH_SIZE,
      gapSize: GAP_SIZE,
      transparent: true,
      opacity,
      linewidth: BASE_LINE_WIDTH,
    });

    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    line.userData.connectionId = connection.id;
    line.userData.sourceId = connection.sourceId;
    line.userData.targetId = connection.targetId;
    line.userData.type = connection.type;
    line.userData.flowOffset = 0;
    line.userData.flowSpeed = FLOW_SPEED * (0.6 + Math.random() * 0.5);
    line.userData.curve = curve;
    line.userData.baseOpacity = opacity;
    line.userData.baseColor = relationColor;

    this.lineGroup.add(line);
    this.connections.set(connection.id, {
      line,
      connection,
      curve,
      sourcePos: sourcePos.clone(),
      targetPos: targetPos.clone(),
      midpoint: midpoint.clone(),
    });
  }

  removeConnection(connectionId) {
    const entry = this.connections.get(connectionId);
    if (!entry) return;

    this.lineGroup.remove(entry.line);
    entry.line.geometry.dispose();
    entry.line.material.dispose();
    this.connections.delete(connectionId);
  }

  updatePositions(resourceMeshes) {
    for (const [id, entry] of this.connections) {
      const sourceGroup = resourceMeshes.get(entry.connection.sourceId);
      const targetGroup = resourceMeshes.get(entry.connection.targetId);

      if (!sourceGroup || !targetGroup) {
        this.removeConnection(id);
        continue;
      }

      // Hidden resources (e.g. the menu showcase subset) take their edges with them.
      entry.line.visible = sourceGroup.visible !== false && targetGroup.visible !== false;

      const sourcePos = sourceGroup.position;
      const targetPos = targetGroup.position;

      if (sourcePos.distanceToSquared(entry.sourcePos) < 0.001 &&
          targetPos.distanceToSquared(entry.targetPos) < 0.001) {
        continue;
      }

      entry.sourcePos.copy(sourcePos);
      entry.targetPos.copy(targetPos);

      const midpoint = new THREE.Vector3().lerpVectors(sourcePos, targetPos, 0.5);
      const distance = sourcePos.distanceTo(targetPos);
      midpoint.y += Math.min(distance * ARC_RATIO, ARC_MAX) + 0.35;
      entry.midpoint.copy(midpoint);

      const curve = new THREE.QuadraticBezierCurve3(
        sourcePos.clone(), midpoint, targetPos.clone(),
      );
      entry.curve = curve;
      entry.line.userData.curve = curve;

      const points = curve.getPoints(CURVE_SEGMENTS);
      entry.line.geometry.dispose();
      entry.line.geometry = new THREE.BufferGeometry().setFromPoints(points);
      entry.line.computeLineDistances();
    }
  }

  update(delta) {
    for (const entry of this.connections.values()) {
      const line = entry.line;
      line.userData.flowOffset += line.userData.flowSpeed * delta;
      line.material.dashOffset = -line.userData.flowOffset;
    }
  }

  /**
   * Diff the connection map against the rendered lines.
   * @param {Map<string, object>} connectionsMap
   * @param {Map<string, THREE.Group>} resourceMeshes
   */
  sync(connectionsMap, resourceMeshes) {
    const newIds = new Set();

    for (const [id, conn] of connectionsMap) {
      newIds.add(id);
      if (!this.connections.has(id)) {
        this.addConnection(conn, resourceMeshes);
      }
    }

    for (const id of [...this.connections.keys()]) {
      if (!newIds.has(id)) {
        this.removeConnection(id);
      }
    }

    this.updatePositions(resourceMeshes);

    if (this.particleTraffic) {
      this.particleTraffic.syncFromConnections(connectionsMap, resourceMeshes);
    }
  }

  getConnectionsForResource(resourceId) {
    const result = [];
    for (const entry of this.connections.values()) {
      if (entry.connection.sourceId === resourceId ||
          entry.connection.targetId === resourceId) {
        result.push(entry.connection);
      }
    }
    return result;
  }

  highlightConnectionsForResource(resourceId) {
    for (const entry of this.connections.values()) {
      const isRelated = entry.connection.sourceId === resourceId ||
                        entry.connection.targetId === resourceId;
      entry.line.material.opacity = isRelated ? HOVER_OPACITY : MIN_OPACITY;
      entry.line.material.color.set(isRelated ? entry.line.userData.baseColor : 0x33404f);
      entry.line.userData.flowSpeed = FLOW_SPEED * (isRelated ? 3.2 : 0.6);
    }
  }

  resetHighlight() {
    for (const entry of this.connections.values()) {
      entry.line.material.opacity = entry.line.userData.baseOpacity ?? MIN_OPACITY;
      entry.line.material.color.set(entry.line.userData.baseColor ?? colorForRelationship(entry.connection.type));
      entry.line.userData.flowSpeed = FLOW_SPEED * (0.6 + Math.random() * 0.5);
    }
  }

  getCurveForConnection(connectionId) {
    const entry = this.connections.get(connectionId);
    return entry ? entry.curve : null;
  }

  getConnectionCount() {
    return this.connections.size;
  }

  dispose() {
    for (const id of [...this.connections.keys()]) {
      this.removeConnection(id);
    }
    this.scene.remove(this.lineGroup);
    this.particleTraffic = null;
  }
}
