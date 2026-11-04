import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RESOURCE_KINDS, normalizeKind } from '../data/kindRegistry.js';
import { visualStatusFor } from './ResourceStatus.js';

/**
 * Kind → 3D model registry for OpenShift Games — "instrument diorama" language.
 *
 * ART DIRECTION (see ClusterRenderer.js header for the full document)
 * ----------------------------------------------------------------
 * Every kind is built from one shared vocabulary so 42 different resources read as
 * one designed set, not 42 unrelated props:
 *
 *   1. Pedestal — a dark lathed plinth with a chamfered edge, a faint machined inlay
 *      ring and one additive status ring. Footprint is the only size signal.
 *   2. Body — matte micro-metal (metalness 0.34 / roughness 0.52), charcoal-blue
 *      `MAT.body` family. Colour is never used as a wash; only the silhouette, a few
 *      edge strips and one small category accent carry the kind's hue.
 *   3. Category accent — a single muted hue per registry palette section, so tiers
 *      read as colour-coded at a glance (projects red, workloads blue, builds amber,
 *      network sky, config gold, storage green, scaling violet, security red-orange,
 *      identity teal).
 *   4. Status — the additive pedestal ring (and its slow pulse) is the only place
 *      semantic status colour appears. Body shapes stay neutral.
 *   5. Bevels — RoundedBoxGeometry / bevelled extrusions / lathed forms; no raw boxes
 *      or cylinders are allowed to be the dominant form.
 *
 * Contact shadows are rendered by ClusterRenderer as a single instanced mesh (see
 * ClusterRenderer._initContactShadows); each group exposes `userData.footprint`
 * for that system, `userData.labelY` for the HTML label layer, and
 * `userData.statusMaterial` for status updates.
 *
 * The public API is unchanged: CREATORS + ResourceMeshFactory.create / updateStatus /
 * dispose, MESH_CREATOR_KINDS / MISSING_MESH_KINDS / hasMeshCreator / meshKindFor.
 */

// ── Palette ──────────────────────────────────────────────────────────────────
export const OPENSHIFT_RED = 0xee0000;
export const OPENSHIFT_ORANGE = 0xf97316;

/** Muted material family — the "instrument" body metal. */
const MAT = {
  body: 0x35424f,
  bodyDark: 0x202834,
  bodyLight: 0x4a596c,
  metal: 0x66788f,
  pedestal: 0x161d26,
  pedestalTop: 0x26313f,
  ink: 0x10151b,
  white: 0xdbe4f0,
};

/** Category accents, one per palette section. Calm, not neon. */
const HUE = {
  open: 0xe8453c, // Close to OpenShift red but softer so 10 Projects don't glow.
  warm: 0xe07a3f,
  amber: 0xd9a544,
  green: 0x4fb47f,
  teal: 0x3fb0aa,
  sky: 0x5aa7d6,
  blue: 0x5b83d6,
  violet: 0x9b7fd4,
  ice: 0xb9cbe0,
  slate: 0x7285a0,
};

const STATUS_COLORS = {
  Running: 0x28a745,
  Ready: 0x28a745,
  Pending: 0xffa657,
  New: 0xffa657,
  Succeeded: 0x3fb950,
  Complete: 0x3fb950,
  Completed: 0x3fb950,
  Failed: 0xd73a49,
  Cancelled: 0x8b949e,
  CrashLoop: 0xf85149,
  CrashLoopBackOff: 0xf85149,
  Terminating: 0x8b949e,
  Terminated: 0x8b949e,
  Unknown: 0x6e7681,
  Bound: 0x28a745,
  Available: 0x28a745,
  Admitted: 0x28a745,
  Active: 0x2ea043,
  Progressing: 0x58a6ff,
  Updating: 0x58a6ff,
  Installing: 0xffa657,
  Suspended: 0xffa657,
  Paused: 0xffa657,
  Degraded: 0xd73a49,
  Unavailable: 0xd73a49,
  Rejected: 0xd73a49,
  NotReady: 0xd73a49,
  NotAdmitted: 0xffa657,
  default: 0x58a6ff,
};

/** Statuses whose ring should breathe slowly. */
const PULSING_STATUSES = new Set([
  'Pending',
  'New',
  'Progressing',
  'Updating',
  'Installing',
  'Suspended',
  'Paused',
  'Failed',
  'CrashLoop',
  'CrashLoopBackOff',
  'Degraded',
  'Unavailable',
  'Rejected',
  'NotReady',
  'NotAdmitted',
]);

export function getStatusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.default;
}

// ── Geometry constants ───────────────────────────────────────────────────────
const PEDESTAL_HEIGHT = 0.18;
const TAU = Math.PI * 2;

const _ringCache = new Map();
function ringGeometry(inner, outer, segments = 48) {
  const key = `${inner}:${outer}:${segments}`;
  if (!_ringCache.has(key)) {
    const geo = new THREE.RingGeometry(inner, outer, segments);
    geo.userData.shared = true;
    _ringCache.set(key, geo);
  }
  return _ringCache.get(key);
}

const _pedestalCache = new Map();
function pedestalGeometry(radius) {
  const key = radius.toFixed(2);
  if (!_pedestalCache.has(key)) {
    const r = radius;
    const h = PEDESTAL_HEIGHT;
    const profile = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(r * 0.9, 0),
      new THREE.Vector2(r, h * 0.24),
      new THREE.Vector2(r, h * 0.74),
      new THREE.Vector2(r * 0.9, h),
      new THREE.Vector2(0, h),
    ];
    const geo = new THREE.LatheGeometry(profile, 24);
    geo.userData.shared = true;
    _pedestalCache.set(key, geo);
  }
  return _pedestalCache.get(key);
}

const STATUS_RING_GEO = ringGeometry(0.86, 0.945, 56);
const INLAY_RING_GEO = ringGeometry(0.5, 0.62);
const TOKEN_RING_GEO = ringGeometry(0.9, 1.0, 40);

// ── Material helpers ─────────────────────────────────────────────────────────
/** Matte micro-metal body material. Never tinted by status. */
function mat(color, opts = {}) {
  const { metalness = 0.34, roughness = 0.52, emissive = 0x000000, emissiveIntensity = 0 } = opts;
  return new THREE.MeshStandardMaterial({
    color,
    metalness,
    roughness,
    emissive,
    emissiveIntensity,
  });
}

/** Unlit edge/accent material — reads as a machined emissive inlay. */
function glow(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
}

/** Unlit additive ring used for status halos. */
function statusRingMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ── Mesh / geometry helpers ──────────────────────────────────────────────────
function addMesh(group, geometry, material, opts = {}) {
  const {
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    sx = 1,
    sy = 1,
    sz = 1,
    castShadow = true,
    receiveShadow = true,
    renderOrder = 0,
    userData,
  } = opts;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  mesh.renderOrder = renderOrder;
  if (userData) Object.assign(mesh.userData, userData);
  group.add(mesh);
  return mesh;
}

/** Rounded, bevel-edged slab — the workhorse body form. */
function slab(group, w, h, d, color, opts = {}) {
  const radius = Math.min(w, h, d) * (opts.round ?? 0.22);
  const geo = new RoundedBoxGeometry(w, h, d, 2, Math.max(0.02, radius));
  const material = opts.material || mat(color, opts);
  return addMesh(group, geo, material, opts);
}

function disc(group, radius, height, color, opts = {}) {
  const geo = new THREE.CylinderGeometry(radius, radius, height, opts.segments ?? 28);
  return addMesh(group, geo, opts.material || mat(color, opts), opts);
}

function torus(group, radius, tube, color, opts = {}) {
  const { arc = TAU, radialSegments = 10, tubularSegments = 36, ...meshOpts } = opts;
  const geo = new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments, arc);
  return addMesh(group, geo, meshOpts.material || mat(color, meshOpts), meshOpts);
}

function strap(group, w, h, d, color, opts = {}) {
  return addMesh(group, new THREE.BoxGeometry(w, h, d), glow(color, opts.opacity ?? 1), {
    castShadow: false,
    receiveShadow: false,
    ...opts,
  });
}

function extruded(group, shape, depth, color, opts = {}) {
  const {
    bevel = true,
    bevelSize = 0.035,
    bevelThickness = 0.035,
    bevelSegments = 2,
    ...meshOpts
  } = opts;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel,
    bevelThickness,
    bevelSize,
    bevelSegments,
    curveSegments: 10,
  });
  geo.center();
  return addMesh(group, geo, meshOpts.material || mat(color, meshOpts), meshOpts);
}

// ── Shape helpers ────────────────────────────────────────────────────────────
function hexShape(radius) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function starShape(outerRadius, innerRadius, points) {
  const shape = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (Math.PI / points) * i - Math.PI / 2;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function shieldShape(width, height) {
  const shape = new THREE.Shape();
  const hw = width / 2;
  shape.moveTo(0, height / 2);
  shape.quadraticCurveTo(hw, height / 2, hw, height / 6);
  shape.lineTo(hw, -height / 6);
  shape.quadraticCurveTo(hw * 0.78, -height / 2.55, 0, -height / 2);
  shape.quadraticCurveTo(-hw * 0.78, -height / 2.55, -hw, -height / 6);
  shape.lineTo(-hw, height / 6);
  shape.quadraticCurveTo(-hw, height / 2, 0, height / 2);
  return shape;
}

function folderShape() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.86, -0.58);
  shape.lineTo(-0.32, -0.58);
  shape.lineTo(-0.16, -0.4);
  shape.lineTo(0.86, -0.4);
  shape.quadraticCurveTo(0.94, -0.4, 0.94, -0.31);
  shape.lineTo(0.94, 0.54);
  shape.quadraticCurveTo(0.94, 0.63, 0.85, 0.63);
  shape.lineTo(-0.86, 0.63);
  shape.quadraticCurveTo(-0.94, 0.63, -0.94, 0.54);
  shape.lineTo(-0.94, -0.49);
  shape.quadraticCurveTo(-0.94, -0.58, -0.86, -0.58);
  return shape;
}

function arrowSignShape() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.62, -0.17);
  shape.lineTo(0.2, -0.17);
  shape.lineTo(0.2, -0.34);
  shape.lineTo(0.72, 0);
  shape.lineTo(0.2, 0.34);
  shape.lineTo(0.2, 0.17);
  shape.lineTo(-0.62, 0.17);
  shape.closePath();
  return shape;
}

function pageShape() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.48, -0.66);
  shape.lineTo(0.3, -0.66);
  shape.lineTo(0.5, -0.44);
  shape.lineTo(0.5, 0.66);
  shape.lineTo(-0.48, 0.66);
  shape.quadraticCurveTo(-0.56, 0.66, -0.56, 0.58);
  shape.lineTo(-0.56, -0.58);
  shape.quadraticCurveTo(-0.56, -0.66, -0.48, -0.66);
  return shape;
}

function puzzleShape() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.45, -0.45);
  shape.lineTo(0.45, -0.45);
  shape.lineTo(0.45, -0.14);
  shape.quadraticCurveTo(0.74, -0.14, 0.74, 0.06);
  shape.quadraticCurveTo(0.74, 0.26, 0.45, 0.26);
  shape.lineTo(0.45, 0.45);
  shape.lineTo(-0.45, 0.45);
  shape.closePath();
  return shape;
}

function octagonShape(radius) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i + Math.PI / 8;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function triangleShape(radius) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 3; i++) {
    const angle = (TAU / 3) * i - Math.PI / 2;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

// ── Pedestal / stage ─────────────────────────────────────────────────────────
function buildPedestal(group, radius, status) {
  const plinth = addMesh(
    group,
    pedestalGeometry(radius),
    mat(MAT.pedestal, { metalness: 0.55, roughness: 0.42 }),
    {
      y: 0,
    }
  );
  plinth.name = 'pedestal';

  // Machined top inlay ring.
  addMesh(group, INLAY_RING_GEO, glow(MAT.metal, 0.5), {
    y: PEDESTAL_HEIGHT + 0.001,
    rx: -Math.PI / 2,
    sx: radius,
    sy: radius,
    castShadow: false,
    receiveShadow: false,
  });

  // Status halo ring (sole carrier of semantic status colour).
  const statusMaterial = statusRingMaterial(getStatusColor(status));
  const statusMesh = addMesh(group, STATUS_RING_GEO, statusMaterial, {
    y: PEDESTAL_HEIGHT + 0.003,
    rx: -Math.PI / 2,
    sx: radius,
    sy: radius,
    castShadow: false,
    receiveShadow: false,
    renderOrder: 2,
  });

  group.userData.statusMaterial = statusMaterial;
  group.userData.statusRing = statusMesh;
  group.userData.statusBaseOpacity = 0.5;
  group.userData.status = status || null;
  group.userData.statusPulse = PULSING_STATUSES.has(status);
  group.userData.footprint = radius * 1.12;
  return PEDESTAL_HEIGHT;
}

/**
 * Start a kind model: pedestal first, then the creator adds the body on top.
 * @returns {{group: THREE.Group, status: string|null, top: number, radius: number}}
 */
function stage(resource, options = {}) {
  const radius = (options.radius ?? 0.95) * 1.12;
  const status = resourceStatus(resource);
  const group = new THREE.Group();
  const top = buildPedestal(group, radius, status);
  return { group, status, top, radius };
}

/** Finish a kind model: derive label anchor + footprint from real bounds. */
function finish(group) {
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  box.getSize(size);
  group.userData.labelY = box.max.y + 0.4;
  group.userData.height = box.max.y;
  group.userData.footprint = Math.max(size.x, size.z) * 0.62;
  return group;
}

// ── Composite props ──────────────────────────────────────────────────────────
function addBust(
  group,
  { x = 0, y = 0, z = 0, scale = 1, color = HUE.teal, accent = HUE.ice } = {}
) {
  const bust = new THREE.Group();
  bust.position.set(x, y, z);
  bust.scale.setScalar(scale);
  group.add(bust);

  // Shoulders: a halved, bevelled disc.
  addMesh(bust, new THREE.SphereGeometry(0.4, 20, 12, 0, TAU, 0, Math.PI / 2), mat(color), {
    y: 0.02,
    rx: Math.PI,
    sy: 0.9,
  });
  // Neck.
  addMesh(bust, new THREE.CylinderGeometry(0.11, 0.13, 0.14, 14), mat(MAT.bodyDark), { y: 0.2 });
  // Head.
  addMesh(bust, new THREE.SphereGeometry(0.23, 20, 16), mat(color, { roughness: 0.42 }), {
    y: 0.44,
  });
  // Face accent line.
  strap(bust, 0.16, 0.03, 0.02, accent, { y: 0.44, z: 0.205, opacity: 0.8 });
  return bust;
}

function addGear(
  group,
  { x = 0, y = 0, z = 0, radius = 0.5, teeth = 10, color = HUE.warm, tilt = 0 } = {}
) {
  const gear = new THREE.Group();
  gear.position.set(x, y, z);
  gear.rotation.x = tilt;
  group.add(gear);

  const thickness = 0.16;
  addMesh(
    gear,
    new THREE.CylinderGeometry(radius * 0.78, radius * 0.78, thickness, 24),
    mat(color),
    { rx: Math.PI / 2 }
  );
  addMesh(
    gear,
    new THREE.CylinderGeometry(radius * 0.22, radius * 0.22, thickness * 1.5, 16),
    mat(MAT.bodyDark),
    { rx: Math.PI / 2 }
  );
  for (let i = 0; i < teeth; i++) {
    const angle = (TAU * i) / teeth;
    const tooth = new THREE.BoxGeometry(radius * 0.22, radius * 0.2, thickness);
    addMesh(gear, tooth, mat(color), {
      x: Math.cos(angle) * radius * 0.86,
      y: Math.sin(angle) * radius * 0.86,
      rz: angle,
    });
  }
  return gear;
}

function addChainLinks(
  group,
  count,
  color,
  { x = 0, y = 0, z = 0, step = 0.34, radius = 0.26 } = {}
) {
  const links = [];
  for (let i = 0; i < count; i++) {
    links.push(
      torus(group, radius, 0.06, color, {
        x,
        y: y + i * step,
        z,
        rz: i % 2 === 0 ? 0 : Math.PI / 2,
        tubularSegments: 20,
      })
    );
  }
  return links;
}

function addSignalArcs(group, color, { x = 0, y = 0, z = 0 } = {}) {
  const arcs = [];
  for (let i = 0; i < 3; i++) {
    const arc = torus(group, 0.26 + i * 0.16, 0.018, color, {
      x,
      y: y + i * 0.16,
      z,
      arc: Math.PI * 0.8,
      rz: Math.PI * 0.1,
      tubularSegments: 22,
    });
    arc.rotation.x = Math.PI / 2;
    arc.rotation.z = -Math.PI / 2;
    arcs.push(arc);
  }
  return arcs;
}

// ── Live-resource accessors ──────────────────────────────────────────────────
function resourceDisplayName(resource) {
  return resource?.name || resource?.metadata?.name || resource?.id || 'unnamed';
}

function resourceKind(resource) {
  return resource?.kind || resource?.type || resource?._ref?.kind || null;
}

function resourceSpec(resource) {
  return resource?.spec || resource?._ref?.spec || {};
}

function resourceStatus(resource) {
  // Condition-derived kinds (ClusterOperator, Route, ClusterVersion, Node) must
  // not fall back to the often-static `status.phase`; ResourceStatus owns the rules.
  const fallback = typeof resource?.status === 'string' ? resource.status : null;
  return visualStatusFor(resource, fallback);
}

function replicaCount(resource, fallback = 3) {
  const spec = resourceSpec(resource);
  const value = spec.replicas ?? resource?.replicas ?? fallback;
  return Math.max(1, Math.min(Number(value) || fallback, 5));
}

/** Show/centre the pre-built replica tick marks of a Deployment model. */
function applyReplicaMarks(group, replicas) {
  const marks = group?.userData?.replicaMarks;
  if (!Array.isArray(marks) || marks.length === 0) return false;
  const count = Math.max(0, Math.min(Number(replicas) || 0, marks.length));
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    mark.visible = i < count;
    mark.position.x = (i - (count - 1) / 2) * 0.16;
  }
  group.userData.replicaCount = count;
  return true;
}

// ── Kind creators ────────────────────────────────────────────────────────────
const CREATORS = {
  // ── Projects & cluster ────────────────────────────────────────────────────
  Project(resource) {
    const { group, top, status } = stage(resource, { radius: 1.02 });
    // Folder standing on a slight backward tilt.
    const folder = extruded(group, folderShape(), 0.24, MAT.bodyLight, {
      y: top + 0.62,
      rx: -0.32,
      bevelSize: 0.04,
    });
    folder.rotation.y = 0.06;
    // Folder tab accent.
    strap(group, 0.5, 0.05, 0.02, HUE.open, { y: top + 1.02, z: 0.24, opacity: 0.9 });
    // Project "scope" token under the folder.
    addMesh(group, TOKEN_RING_GEO, glow(HUE.open, 0.22), {
      y: top + 0.012,
      rx: -Math.PI / 2,
      sx: 0.9,
      sy: 0.9,
      castShadow: false,
    });
    addMesh(
      group,
      new THREE.BoxGeometry(1.5, 0.026, 1.5),
      mat(MAT.bodyDark, { metalness: 0.2, roughness: 0.8 }),
      {
        y: top + 0.006,
        castShadow: false,
        receiveShadow: true,
      }
    );
    void status;
    return finish(group);
  },

  Node(resource) {
    const { group, top } = stage(resource, { radius: 1.4 });
    // Wide server deck with ventilation fins — the "hardware" silhouette.
    slab(group, 1.9, 0.34, 1.25, MAT.body, { y: top + 0.19, round: 0.12 });
    slab(group, 1.55, 0.1, 0.95, MAT.bodyDark, { y: top + 0.4, round: 0.15 });
    for (let i = 0; i < 4; i++) {
      slab(group, 1.5, 0.1, 0.11, MAT.bodyLight, { y: top + 0.5, z: -0.32 + i * 0.22, round: 0.3 });
      strap(group, 0.9, 0.016, 0.012, HUE.sky, {
        y: top + 0.56,
        z: -0.32 + i * 0.22,
        opacity: 0.55,
      });
    }
    // Control-plane antennae.
    addMesh(group, new THREE.CylinderGeometry(0.03, 0.05, 0.5, 8), mat(MAT.metal), {
      x: -0.7,
      y: top + 0.62,
      z: 0.42,
    });
    addMesh(group, new THREE.SphereGeometry(0.07, 12, 12), glow(HUE.ice), {
      x: -0.7,
      y: top + 0.9,
      z: 0.42,
    });
    strap(group, 1.5, 0.03, 0.02, HUE.sky, { y: top + 0.075, z: 0.65, opacity: 0.75 });
    return finish(group);
  },

  ClusterResourceQuota(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    const heights = [0.34, 0.62, 0.9];
    heights.forEach((height, index) => {
      slab(group, 0.3, height, 0.44, index === 2 ? HUE.warm : MAT.bodyLight, {
        x: -0.34 + index * 0.34,
        y: top + height / 2 + 0.04,
        round: 0.3,
      });
      strap(group, 0.24, 0.018, 0.02, HUE.amber, {
        x: -0.34 + index * 0.34,
        y: top + height + 0.05,
        opacity: 0.7,
      });
    });
    slab(group, 1.35, 0.07, 0.62, MAT.bodyDark, { y: top + 0.05, round: 0.2 });
    return finish(group);
  },

  ClusterOperator(resource) {
    const { group, top } = stage(resource, { radius: 0.95 });
    disc(group, 0.34, 0.1, MAT.body, { y: top + 0.05 });
    addMesh(group, new THREE.CylinderGeometry(0.045, 0.07, 0.62, 10), mat(MAT.metal), {
      y: top + 0.42,
    });
    const beaconMaterial = mat(HUE.warm, {
      metalness: 0.2,
      roughness: 0.3,
      emissive: new THREE.Color(HUE.warm),
      emissiveIntensity: 0.9,
    });
    const beacon = addMesh(group, new THREE.SphereGeometry(0.2, 20, 16), beaconMaterial, {
      y: top + 0.84,
    });
    const halo = torus(group, 0.33, 0.02, HUE.amber, { y: top + 0.84, rx: Math.PI / 2 });
    group.userData.animate = (time) => {
      const pulse = 0.9 + Math.sin(time * 1.6) * 0.1;
      beacon.scale.setScalar(pulse);
      beaconMaterial.emissiveIntensity = 0.7 + Math.sin(time * 1.6) * 0.25;
      halo.rotation.z = time * 0.4;
    };
    return finish(group);
  },

  ClusterVersion(resource) {
    const { group, top } = stage(resource, { radius: 0.95 });
    addMesh(group, new THREE.CylinderGeometry(0.035, 0.055, 1.05, 10), mat(MAT.metal), {
      y: top + 0.55,
    });
    const rings = [];
    [HUE.open, HUE.warm, HUE.amber].forEach((color, index) => {
      const ring = torus(group, 0.5 - index * 0.1, 0.028, color, {
        y: top + 0.42 + index * 0.24,
        rx: Math.PI / 2,
      });
      rings.push(ring);
    });
    addMesh(group, new THREE.SphereGeometry(0.15, 18, 14), glow(HUE.warm), { y: top + 0.42 });
    addMesh(group, new THREE.ConeGeometry(0.1, 0.18, 10), mat(HUE.warm), { y: top + 1.16 });
    group.userData.animate = (time) => {
      rings[0].rotation.z = time * 0.35;
      rings[1].rotation.z = -time * 0.5;
      rings[2].rotation.z = time * 0.65;
    };
    return finish(group);
  },

  OAuth(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    // Key: upright bow + shaft + two teeth.
    torus(group, 0.24, 0.07, HUE.open, { x: -0.2, y: top + 0.95, rz: Math.PI / 2 });
    slab(group, 0.12, 0.9, 0.12, MAT.bodyLight, { x: 0.06, y: top + 0.5, round: 0.4 });
    slab(group, 0.2, 0.1, 0.1, HUE.warm, { x: 0.2, y: top + 0.2, round: 0.4 });
    slab(group, 0.16, 0.1, 0.1, HUE.warm, { x: 0.18, y: top + 0.4, round: 0.4 });
    addMesh(group, new THREE.CylinderGeometry(0.09, 0.09, 0.05, 14), mat(MAT.bodyDark), {
      x: -0.2,
      y: top + 0.95,
      rz: Math.PI / 2,
    });
    return finish(group);
  },

  // ── Workloads ─────────────────────────────────────────────────────────────
  Pod(resource) {
    const { group, top } = stage(resource, { radius: 0.86 });
    // Hexagonal capsule — the canonical workload token.
    const body = addMesh(
      group,
      new THREE.CylinderGeometry(0.5, 0.5, 1.0, 6),
      mat(HUE.blue, { roughness: 0.44 }),
      {
        y: top + 0.54,
        ry: Math.PI / 6,
      }
    );
    addMesh(group, new THREE.CylinderGeometry(0.5, 0.5, 0.08, 6), glow(HUE.ice, 0.75), {
      y: top + 1.1,
      ry: Math.PI / 6,
      castShadow: false,
    });
    const collar = torus(group, 0.53, 0.028, HUE.sky, {
      y: top + 0.62,
      rx: Math.PI / 2,
      tubularSegments: 6,
    });
    collar.rotation.z = Math.PI / 6;
    addMesh(group, new THREE.SphereGeometry(0.07, 12, 12), glow(HUE.ice), { y: top + 1.16 });
    void body;
    return finish(group);
  },

  Deployment(resource) {
    const { group, top } = stage(resource, { radius: 1.0 });
    const replicas = replicaCount(resource, 3);
    // Layered plates = declarative rollout.
    const plateWidths = [1.5, 1.16, 0.82];
    for (let i = 0; i < 3; i++) {
      slab(group, plateWidths[i], 0.16, 0.9 - i * 0.16, MAT.bodyLight, {
        y: top + 0.16 + i * 0.22,
        round: 0.28,
      });
      strap(group, plateWidths[i] * 0.66, 0.02, 0.02, i === 2 ? HUE.ice : HUE.blue, {
        y: top + 0.25 + i * 0.22,
        z: 0.42 - i * 0.08,
        opacity: 0.75,
      });
    }
    // Rollout chevron.
    strap(group, 0.32, 0.03, 0.02, HUE.ice, { y: top + 0.78, z: 0.16, rz: 0.6, opacity: 0.8 });
    strap(group, 0.32, 0.03, 0.02, HUE.ice, { y: top + 0.78, z: 0.16, rz: -0.6, opacity: 0.8 });
    // Replica tick marks. Build the full range up-front so `oc scale` can show
    // live desired replicas; ResourceMeshFactory#updateReplicaCount adjusts them.
    const marks = [];
    const maxMarks = 5;
    for (let i = 0; i < maxMarks; i++) {
      marks.push(
        strap(group, 0.04, 0.02, 0.04, HUE.sky, {
          x: (i - (replicas - 1) / 2) * 0.16,
          y: top + 0.1,
          z: 0.46,
          opacity: 0.85,
        })
      );
    }
    group.userData.replicaMarks = marks;
    group.userData.replicaCount = replicas;
    applyReplicaMarks(group, replicas);
    return finish(group);
  },

  ReplicaSet(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    const count = Math.min(replicaCount(resource, 3), 4);
    slab(group, 1.36, 0.12, 0.52, MAT.bodyDark, { y: top + 0.07, round: 0.3 });
    for (let i = 0; i < count; i++) {
      slab(group, 0.26, 0.34, 0.3, MAT.bodyLight, {
        x: (i - (count - 1) / 2) * 0.32,
        y: top + 0.31,
        round: 0.28,
      });
      strap(group, 0.14, 0.03, 0.02, HUE.sky, {
        x: (i - (count - 1) / 2) * 0.32,
        y: top + 0.2,
        z: 0.17,
        opacity: 0.8,
      });
    }
    return finish(group);
  },

  StatefulSet(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    const count = Math.min(replicaCount(resource, 3), 4);
    // Ordered ordinal stack — persistent identity per replica.
    for (let i = 0; i < count; i++) {
      disc(group, 0.42, 0.24, i === count - 1 ? HUE.violet : MAT.bodyLight, {
        x: (i - (count - 1) / 2) * 0.1,
        y: top + 0.18 + i * 0.27,
        z: i * 0.02,
      });
      strap(group, 0.6, 0.02, 0.02, i === count - 1 ? HUE.ice : HUE.violet, {
        y: top + 0.32 + i * 0.27,
        opacity: 0.65,
      });
    }
    addMesh(group, new THREE.SphereGeometry(0.06, 12, 12), glow(HUE.ice), {
      y: top + 0.34 + count * 0.27,
    });
    return finish(group);
  },

  DaemonSet(resource) {
    const { group, top } = stage(resource, { radius: 0.95 });
    disc(group, 0.32, 0.12, MAT.body, { y: top + 0.06 });
    addMesh(group, new THREE.CylinderGeometry(0.05, 0.08, 0.34, 10), mat(MAT.metal), {
      y: top + 0.28,
    });
    // Hub + one agent cube per node in a tilted ring.
    const ring = new THREE.Group();
    ring.position.y = top + 0.6;
    ring.rotation.x = 0.34;
    group.add(ring);
    addMesh(ring, new THREE.SphereGeometry(0.17, 18, 14), mat(HUE.teal, { roughness: 0.4 }));
    torus(ring, 0.62, 0.018, HUE.teal, { rx: Math.PI / 2 });
    for (let i = 0; i < 4; i++) {
      const angle = (TAU * i) / 4;
      slab(ring, 0.16, 0.16, 0.16, MAT.bodyLight, {
        x: Math.cos(angle) * 0.62,
        z: Math.sin(angle) * 0.62,
        round: 0.24,
      });
    }
    group.userData.animate = (time) => {
      ring.rotation.y = time * 0.25;
    };
    return finish(group);
  },

  Job(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    // Run-to-completion triangle.
    const prism = extruded(group, triangleShape(0.55), 0.42, HUE.green, {
      y: top + 0.62,
      bevelSize: 0.05,
      bevelThickness: 0.05,
    });
    prism.rotation.y = 0.2;
    slab(group, 0.5, 0.08, 0.5, MAT.bodyDark, { y: top + 0.06, round: 0.3 });
    strap(group, 0.52, 0.03, 0.02, HUE.green, { y: top + 0.12, z: 0.3, opacity: 0.8 });
    return finish(group);
  },

  CronJob(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    // Upright clock face.
    const face = disc(group, 0.52, 0.14, MAT.bodyLight, {
      y: top + 0.62,
      rx: Math.PI / 2,
      z: 0.06,
    });
    torus(group, 0.53, 0.045, HUE.violet, { y: top + 0.62, z: 0.06 });
    const handMaterial = glow(HUE.ice);
    const hour = addMesh(group, new THREE.BoxGeometry(0.035, 0.24, 0.03), handMaterial, {
      y: top + 0.72,
      z: 0.16,
    });
    const minute = addMesh(group, new THREE.BoxGeometry(0.025, 0.34, 0.03), handMaterial.clone(), {
      y: top + 0.77,
      z: 0.17,
    });
    for (let i = 0; i < 12; i++) {
      const angle = (TAU / 12) * i;
      strap(group, 0.025, 0.05, 0.02, HUE.slate, {
        x: Math.sin(angle) * 0.4,
        y: top + 0.62 + Math.cos(angle) * 0.4,
        z: 0.14,
        rz: -angle,
        opacity: 0.7,
      });
    }
    void face;
    group.userData.animate = (time) => {
      hour.rotation.z = -time * 0.08;
      minute.rotation.z = -time * 0.5;
    };
    return finish(group);
  },

  // ── Builds & images ──────────────────────────────────────────────────────
  BuildConfig(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    const gear = addGear(group, {
      y: top + 0.72,
      z: 0.02,
      radius: 0.44,
      color: HUE.warm,
      tilt: Math.PI / 2,
    });
    // Config wrench crossing the gear.
    slab(group, 0.07, 0.52, 0.07, MAT.metal, {
      x: 0.34,
      y: top + 0.62,
      z: 0.12,
      rz: -0.5,
      round: 0.4,
    });
    slab(group, 0.16, 0.1, 0.09, MAT.metal, {
      x: 0.5,
      y: top + 0.82,
      z: 0.12,
      rz: -0.5,
      round: 0.3,
    });
    group.userData.animate = (time) => {
      gear.rotation.z = time * 0.22;
    };
    return finish(group);
  },

  Build(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    const gear = addGear(group, {
      y: top + 0.72,
      z: 0.02,
      radius: 0.52,
      teeth: 12,
      color: HUE.warm,
      tilt: Math.PI / 2,
    });
    // Progress arc above the gear.
    const arc = torus(group, 0.62, 0.022, HUE.amber, {
      y: top + 0.72,
      z: 0.04,
      arc: Math.PI * 1.35,
      tubularSegments: 40,
    });
    group.userData.animate = (time) => {
      gear.rotation.z = time * 0.7;
      arc.rotation.z = -time * 0.3;
    };
    return finish(group);
  },

  ImageStream(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    addMesh(group, new THREE.CylinderGeometry(0.04, 0.05, 1.15, 10), mat(MAT.metal), {
      y: top + 0.6,
    });
    const spec = resourceSpec(resource);
    const tagCount = Math.max(2, Math.min((spec.tags || []).length || 3, 4));
    const layers = [];
    for (let i = 0; i < tagCount; i++) {
      const layer = disc(
        group,
        0.46 - i * 0.05,
        0.1,
        i === tagCount - 1 ? HUE.amber : MAT.bodyLight,
        {
          y: top + 0.28 + i * 0.2,
          ry: i * 0.18,
        }
      );
      layers.push(layer);
      strap(group, 0.5 - i * 0.05, 0.02, 0.02, HUE.amber, {
        y: top + 0.34 + i * 0.2,
        opacity: 0.6,
      });
    }
    group.userData.animate = (time) => {
      layers.forEach((layer, i) => {
        layer.position.y = top + 0.28 + i * 0.2 + Math.sin(time * 0.8 + i) * 0.012;
      });
    };
    return finish(group);
  },

  // ── Networking ───────────────────────────────────────────────────────────
  Service(resource) {
    const { group, top } = stage(resource, { radius: 0.95 });
    disc(group, 0.28, 0.1, MAT.bodyDark, { y: top + 0.05 });
    const sphereMaterial = mat(HUE.sky, { metalness: 0.5, roughness: 0.28 });
    addMesh(group, new THREE.SphereGeometry(0.4, 26, 20), sphereMaterial, { y: top + 0.58 });
    const ringA = torus(group, 0.62, 0.026, HUE.sky, { y: top + 0.58, rx: Math.PI / 2 + 0.34 });
    const ringB = torus(group, 0.74, 0.018, HUE.ice, {
      y: top + 0.58,
      rx: Math.PI / 2 - 0.2,
      opacity: 0.6,
    });
    for (let i = 0; i < 3; i++) {
      const angle = (TAU / 3) * i;
      strap(group, 0.05, 0.05, 0.18, HUE.ice, {
        x: Math.cos(angle) * 0.4,
        y: top + 0.58,
        z: Math.sin(angle) * 0.4,
        ry: -angle,
        opacity: 0.8,
      });
    }
    group.userData.animate = (time) => {
      ringA.rotation.z = time * 0.35;
      ringB.rotation.z = -time * 0.22;
    };
    return finish(group);
  },

  Route(resource) {
    const { group, top } = stage(resource, { radius: 0.88 });
    const spec = resourceSpec(resource);
    // Sign post + routed arrow.
    slab(group, 0.1, 1.3, 0.1, MAT.bodyLight, { y: top + 0.7, round: 0.4 });
    const sign = extruded(group, arrowSignShape(), 0.14, MAT.bodyLight, {
      y: top + 1.16,
      x: 0.14,
      bevelSize: 0.03,
    });
    strap(group, 0.62, 0.035, 0.02, HUE.open, { y: top + 1.16, x: 0.14, z: 0.09, opacity: 0.9 });
    if (spec.tls) {
      const tlsColor = spec.tls.termination === 'passthrough' ? HUE.violet : HUE.amber;
      torus(group, 0.13, 0.03, tlsColor, { y: top + 1.52, x: -0.08, rx: Math.PI / 2 });
    }
    group.userData.animate = (time) => {
      sign.rotation.y = Math.sin(time * 0.4) * 0.06;
    };
    return finish(group);
  },

  Ingress(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    const geometry = new THREE.OctahedronGeometry(0.5, 0);
    const material = mat(HUE.sky, { metalness: 0.55, roughness: 0.32, flatShading: true });
    const gem = addMesh(group, geometry, material, { y: top + 0.68 });
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: HUE.ice, transparent: true, opacity: 0.45 })
    );
    edges.position.copy(gem.position);
    group.add(edges);
    torus(group, 0.6, 0.022, HUE.sky, { y: top + 0.16, rx: Math.PI / 2 });
    group.userData.animate = (time) => {
      gem.rotation.y = time * 0.25;
      edges.rotation.y = time * 0.25;
    };
    return finish(group);
  },

  NetworkPolicy(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    const shield = extruded(group, shieldShape(0.95, 1.12), 0.22, MAT.bodyLight, {
      y: top + 0.7,
      bevelSize: 0.04,
    });
    void shield;
    for (let i = 0; i < 3; i++) {
      strap(group, 0.56, 0.05, 0.03, HUE.warm, {
        y: top + 0.48 + i * 0.18,
        z: 0.14,
        opacity: 0.8,
      });
    }
    return finish(group);
  },

  IPAddressPool(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    disc(group, 0.62, 0.08, MAT.bodyDark, { y: top + 0.04 });
    const points = [
      new THREE.Vector3(-0.38, top + 0.18, 0.22),
      new THREE.Vector3(0.38, top + 0.18, 0.22),
      new THREE.Vector3(0, top + 0.18, -0.38),
    ];
    for (const point of points) {
      addMesh(group, new THREE.SphereGeometry(0.13, 16, 12), mat(HUE.warm, { roughness: 0.4 }), {
        x: point.x,
        y: point.y,
        z: point.z,
      });
    }
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      points[0],
      points[1],
      points[1],
      points[2],
      points[2],
      points[0],
    ]);
    group.add(
      new THREE.LineSegments(
        lineGeometry,
        new THREE.LineBasicMaterial({
          color: HUE.amber,
          transparent: true,
          opacity: 0.5,
        })
      )
    );
    return finish(group);
  },

  L2Advertisement(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    disc(group, 0.55, 0.08, MAT.bodyDark, { y: top + 0.04 });
    addMesh(group, new THREE.SphereGeometry(0.14, 16, 12), mat(HUE.open), {
      x: -0.32,
      y: top + 0.2,
    });
    addMesh(group, new THREE.SphereGeometry(0.14, 16, 12), mat(HUE.open), {
      x: 0.32,
      y: top + 0.2,
    });
    addSignalArcs(group, HUE.warm, { x: 0, y: top + 0.55 });
    return finish(group);
  },

  // ── Config / storage ─────────────────────────────────────────────────────
  ConfigMap(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    // Binder of key/value entries.
    const binder = slab(group, 1.1, 0.78, 0.3, MAT.bodyLight, {
      y: top + 0.56,
      rx: -0.16,
      round: 0.16,
    });
    binder.rotation.y = 0.08;
    for (let i = 0; i < 3; i++) {
      strap(group, 0.7 - i * 0.1, 0.035, 0.02, HUE.amber, {
        y: top + 0.78 - i * 0.16,
        z: 0.18,
        opacity: 0.75,
      });
    }
    slab(group, 0.24, 0.08, 0.36, MAT.bodyDark, { y: top + 0.12, round: 0.3 });
    return finish(group);
  },

  Secret(resource) {
    const { group, top } = stage(resource, { radius: 0.88 });
    // Padlock.
    const body = slab(group, 0.8, 0.58, 0.36, MAT.bodyLight, { y: top + 0.42, round: 0.2 });
    void body;
    const shackle = torus(group, 0.26, 0.06, MAT.metal, {
      y: top + 0.86,
      arc: Math.PI,
      tubularSegments: 22,
    });
    shackle.rotation.z = Math.PI;
    strap(group, 0.34, 0.05, 0.03, HUE.amber, { y: top + 0.5, z: 0.2, opacity: 0.85 });
    addMesh(group, new THREE.CylinderGeometry(0.07, 0.07, 0.04, 14), mat(MAT.bodyDark), {
      y: top + 0.42,
      z: 0.2,
      rx: Math.PI / 2,
    });
    return finish(group);
  },

  LimitRange(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    slab(group, 1.5, 0.1, 0.38, MAT.bodyLight, { y: top + 0.14, rz: 0.03, round: 0.3 });
    for (let i = 0; i < 10; i++) {
      const tall = i % 5 === 0;
      strap(group, 0.03, tall ? 0.16 : 0.1, 0.02, HUE.amber, {
        x: -0.64 + i * 0.142,
        y: top + 0.26,
        z: 0.16,
        opacity: tall ? 0.95 : 0.6,
      });
    }
    slab(group, 0.22, 0.16, 0.4, MAT.bodyDark, { y: top + 0.08, x: 0.66, round: 0.3 });
    return finish(group);
  },

  ResourceQuota(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    slab(group, 0.95, 0.72, 0.66, MAT.bodyLight, { y: top + 0.44, round: 0.18 });
    for (let i = 0; i < 3; i++) {
      strap(group, 0.72, 0.05, 0.02, HUE.warm, {
        y: top + 0.28 + i * 0.18,
        z: 0.34,
        opacity: 0.7,
      });
    }
    slab(group, 0.98, 0.06, 0.69, MAT.bodyDark, { y: top + 0.82, round: 0.3 });
    return finish(group);
  },

  Template(resource) {
    const { group, top } = stage(resource, { radius: 0.88 });
    const page = extruded(group, pageShape(), 0.08, MAT.bodyLight, {
      y: top + 0.68,
      bevelSize: 0.02,
    });
    page.rotation.y = 0.14;
    for (let i = 0; i < 3; i++) {
      strap(group, i === 0 ? 0.5 : 0.62, 0.04, 0.02, i === 0 ? HUE.warm : HUE.slate, {
        y: top + 0.88 - i * 0.16,
        z: 0.06,
        opacity: i === 0 ? 0.9 : 0.6,
      });
    }
    group.userData.animate = (time) => {
      page.position.y = top + 0.68 + Math.sin(time * 0.7) * 0.02;
    };
    return finish(group);
  },

  PersistentVolume(resource) {
    const { group, top } = stage(resource, { radius: 1.0 });
    addMesh(group, new THREE.CylinderGeometry(0.04, 0.06, 1.0, 10), mat(MAT.metal), {
      y: top + 0.52,
    });
    for (let i = 0; i < 3; i++) {
      disc(group, 0.54 - i * 0.02, 0.16, i === 0 ? HUE.green : MAT.bodyLight, {
        y: top + 0.24 + i * 0.26,
      });
      torus(group, 0.5, 0.02, HUE.green, { y: top + 0.33 + i * 0.26, rx: Math.PI / 2 });
    }
    return finish(group);
  },

  PersistentVolumeClaim(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    // Short volume puck with a connector — a claim, not the disk itself.
    const puck = disc(group, 0.48, 0.5, HUE.green, { y: top + 0.32 });
    void puck;
    torus(group, 0.5, 0.04, MAT.metal, { y: top + 0.32, rx: Math.PI / 2 });
    addMesh(group, new THREE.CylinderGeometry(0.12, 0.16, 0.16, 12), mat(MAT.bodyDark), {
      y: top + 0.66,
    });
    strap(group, 0.6, 0.04, 0.02, HUE.green, { y: top + 0.2, z: 0.34, opacity: 0.7 });
    return finish(group);
  },

  StorageClass(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    // Tiered plates = storage classes / provisioner levels.
    for (let i = 0; i < 3; i++) {
      slab(group, 1.24 - i * 0.16, 0.1, 0.86 - i * 0.1, i === 2 ? HUE.violet : MAT.bodyLight, {
        y: top + 0.16 + i * 0.2,
        z: -0.16 + i * 0.16,
        round: 0.24,
      });
    }
    slab(group, 0.08, 0.58, 0.08, MAT.metal, { x: -0.42, y: top + 0.42, round: 0.4 });
    strap(group, 0.7, 0.025, 0.02, HUE.violet, { y: top + 0.52, opacity: 0.75 });
    return finish(group);
  },

  // ── Scaling & availability ───────────────────────────────────────────────
  HorizontalPodAutoscaler(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    const gauge = torus(group, 0.52, 0.06, HUE.violet, {
      y: top + 0.62,
      z: 0.02,
      arc: Math.PI * 1.5,
      tubularSegments: 36,
    });
    gauge.rotation.z = Math.PI * 0.75;
    const needleMaterial = mat(HUE.ice, {
      emissive: new THREE.Color(HUE.ice),
      emissiveIntensity: 0.35,
    });
    const needle = addMesh(group, new THREE.ConeGeometry(0.035, 0.44, 6), needleMaterial, {
      y: top + 0.74,
      z: 0.1,
    });
    disc(group, 0.09, 0.08, MAT.bodyDark, { y: top + 0.62, z: 0.1, rx: Math.PI / 2 });
    // Gauge scale ticks along the same arc the needle sweeps.
    const arcPosition = (utilization) => {
      const t = Math.max(0, Math.min(100, utilization)) / 100;
      const theta = Math.PI * 0.25 + t * Math.PI * 1.5;
      return { x: Math.sin(theta) * 0.64, y: top + 0.62 + Math.cos(theta) * 0.64 };
    };
    for (let i = 0; i < 5; i++) {
      strap(group, 0.02, 0.05, 0.02, HUE.violet, {
        ...arcPosition((i / 4) * 100),
        z: 0.03,
        opacity: 0.55,
      });
    }
    // Target marker: the configured CPU target for this autoscaler.
    const targetMarker = addMesh(group, new THREE.SphereGeometry(0.045, 10, 8), glow(HUE.amber), {
      y: top + 0.62,
      z: 0.04,
    });
    // The renderer passes a snapshot (`resource._ref` is the live simulation
    // object). Read the live status metrics through the ref so the gauge tracks
    // ticks instead of being baked in at creation time.
    const liveRef = resource?._ref || resource;
    const currentUtilizationOf = () => {
      const metrics = liveRef?.status?.currentMetrics;
      const fromMetrics = Array.isArray(metrics)
        ? metrics.find((entry) => entry?.resource?.current?.averageUtilization !== undefined)
        : null;
      const raw =
        fromMetrics?.resource?.current?.averageUtilization ??
        liveRef?.status?.currentCPUUtilizationPercentage ??
        liveRef?.currentUtilization ??
        liveRef?.status?.currentUtilization ??
        0;
      const value = Number(raw);
      return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
    };
    const targetUtilizationOf = () => {
      const metric = (liveRef?.spec?.metrics || [])[0];
      const raw =
        metric?.resource?.target?.averageUtilization ??
        metric?.resource?.targetAverageUtilization ??
        50;
      const value = Number(raw);
      return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
    };
    group.userData.animate = (time) => {
      const current = currentUtilizationOf();
      const target = targetUtilizationOf();
      const angle = (current / 100) * Math.PI * 1.5 - Math.PI * 0.75;
      needle.rotation.z = angle + Math.sin(time * 1.2) * 0.02;
      const marker = arcPosition(target);
      targetMarker.position.set(marker.x, marker.y, 0.04);
    };
    return finish(group);
  },

  PodDisruptionBudget(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    const left = extruded(group, shieldShape(0.48, 1.0), 0.2, MAT.bodyLight, {
      x: -0.28,
      y: top + 0.66,
      bevelSize: 0.03,
    });
    const right = extruded(group, shieldShape(0.48, 1.0), 0.2, MAT.bodyLight, {
      x: 0.28,
      y: top + 0.66,
      bevelSize: 0.03,
    });
    left.rotation.z = 0.07;
    right.rotation.z = -0.07;
    strap(group, 0.68, 0.05, 0.04, HUE.teal, { y: top + 0.56, z: 0.13, opacity: 0.85 });
    return finish(group);
  },

  // ── Security / identity / operators ──────────────────────────────────────
  ServiceAccount(resource) {
    const { group, top } = stage(resource, { radius: 0.88 });
    // ID badge on a stand.
    const badge = slab(group, 0.78, 0.56, 0.1, MAT.bodyLight, {
      y: top + 0.56,
      rx: -0.22,
      round: 0.16,
    });
    badge.rotation.y = 0.04;
    addMesh(group, new THREE.CylinderGeometry(0.11, 0.11, 0.03, 18), mat(HUE.warm), {
      y: top + 0.67,
      z: 0.1,
      rx: Math.PI / 2 - 0.22,
    });
    strap(group, 0.34, 0.04, 0.02, HUE.warm, { y: top + 0.5, z: 0.1, opacity: 0.8 });
    strap(group, 0.26, 0.04, 0.02, HUE.slate, { y: top + 0.4, z: 0.1, opacity: 0.7 });
    slab(group, 0.34, 0.08, 0.3, MAT.bodyDark, { y: top + 0.1, round: 0.3 });
    return finish(group);
  },

  Role(resource) {
    const { group, top } = stage(resource, { radius: 0.88 });
    // Octagonal permission medal + star.
    const medal = extruded(group, octagonShape(0.5), 0.16, MAT.bodyLight, {
      y: top + 0.66,
      rx: -0.12,
      bevelSize: 0.03,
    });
    void medal;
    extruded(group, starShape(0.24, 0.1, 5), 0.06, HUE.amber, {
      y: top + 0.66,
      z: 0.12,
      rx: -0.12,
      bevelSize: 0.02,
    });
    strap(group, 0.42, 0.035, 0.02, HUE.amber, { y: top + 0.2, z: 0.24, opacity: 0.65 });
    return finish(group);
  },

  ClusterRole(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    extruded(group, octagonShape(0.54), 0.18, MAT.bodyLight, {
      y: top + 0.68,
      rx: -0.12,
      bevelSize: 0.03,
    });
    extruded(group, starShape(0.26, 0.11, 5), 0.06, HUE.warm, {
      y: top + 0.68,
      z: 0.13,
      rx: -0.12,
      bevelSize: 0.02,
    });
    const orbit = torus(group, 0.76, 0.02, HUE.warm, { y: top + 0.68, rx: Math.PI / 2 + 0.22 });
    group.userData.animate = (time) => {
      orbit.rotation.z = time * 0.3;
    };
    return finish(group);
  },

  RoleBinding(resource) {
    const { group, top } = stage(resource, { radius: 0.88 });
    addChainLinks(group, 2, HUE.amber, { y: top + 0.4 });
    slab(group, 0.4, 0.08, 0.3, MAT.bodyDark, { y: top + 0.06, round: 0.3 });
    return finish(group);
  },

  ClusterRoleBinding(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    addChainLinks(group, 3, HUE.warm, { y: top + 0.32 });
    const orbit = torus(group, 0.72, 0.018, HUE.warm, { y: top + 0.7, rx: Math.PI / 2 + 0.2 });
    group.userData.animate = (time) => {
      orbit.rotation.z = -time * 0.26;
    };
    return finish(group);
  },

  SecurityContextConstraints(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    const shield = extruded(group, shieldShape(1.0, 1.18), 0.26, MAT.bodyLight, {
      y: top + 0.72,
      bevelSize: 0.04,
    });
    void shield;
    // Keyhole = pod security.
    addMesh(group, new THREE.CylinderGeometry(0.1, 0.1, 0.05, 16), mat(MAT.bodyDark), {
      y: top + 0.8,
      z: 0.16,
      rx: Math.PI / 2,
    });
    strap(group, 0.07, 0.24, 0.04, MAT.bodyDark, { y: top + 0.62, z: 0.16, opacity: 0.9 });
    strap(group, 0.62, 0.035, 0.02, HUE.open, { y: top + 0.3, z: 0.18, opacity: 0.75 });
    return finish(group);
  },

  User(resource) {
    const { group, top } = stage(resource, { radius: 0.86 });
    addBust(group, { y: top + 0.12, scale: 1.0, color: HUE.teal, accent: HUE.ice });
    return finish(group);
  },

  Group(resource) {
    const { group, top } = stage(resource, { radius: 0.95 });
    addBust(group, { x: -0.3, z: 0.16, y: top + 0.08, scale: 0.6, color: HUE.teal });
    addBust(group, { x: 0.3, z: 0.16, y: top + 0.08, scale: 0.6, color: HUE.teal });
    addBust(group, { y: top + 0.1, z: -0.16, scale: 0.72, color: HUE.sky, accent: HUE.ice });
    return finish(group);
  },

  Identity(resource) {
    const { group, top } = stage(resource, { radius: 0.84 });
    slab(group, 0.7, 0.5, 0.12, MAT.bodyLight, { y: top + 0.52, rx: -0.2, round: 0.2 });
    addMesh(group, new THREE.SphereGeometry(0.1, 16, 12), mat(HUE.slate), {
      y: top + 0.66,
      z: 0.08,
    });
    strap(group, 0.34, 0.04, 0.02, HUE.sky, { y: top + 0.48, z: 0.08, opacity: 0.8 });
    return finish(group);
  },

  Subscription(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    const piece = extruded(group, puzzleShape(), 0.24, MAT.bodyLight, {
      y: top + 0.66,
      bevelSize: 0.035,
    });
    piece.rotation.y = 0.42;
    strap(group, 0.4, 0.05, 0.03, HUE.warm, { y: top + 0.66, z: 0.2, opacity: 0.85 });
    const halo = torus(group, 0.66, 0.02, HUE.warm, { y: top + 0.66, rx: Math.PI / 2 + 0.3 });
    group.userData.animate = (time) => {
      piece.rotation.y = 0.42 + Math.sin(time * 0.4) * 0.1;
      halo.rotation.z = time * 0.28;
    };
    return finish(group);
  },

  // ── OLM / operators ───────────────────────────────────────────────────────
  OperatorGroup(resource) {
    const { group, top } = stage(resource, { radius: 0.92 });
    slab(group, 1.35, 0.14, 1.15, MAT.body, { y: top + 0.09, round: 0.16 });
    for (let index = 0; index < 3; index += 1) {
      slab(group, 0.92, 0.07, 0.17, MAT.bodyLight, {
        y: top + 0.24 + index * 0.14,
        round: 0.3,
      });
      strap(group, 0.72, 0.014, 0.012, HUE.open, {
        y: top + 0.27 + index * 0.14,
        z: 0.05,
        opacity: 0.6,
      });
    }
    torus(group, 0.5, 0.02, HUE.open, { y: top + 0.66, rx: Math.PI / 2 });
    return finish(group);
  },

  InstallPlan(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    slab(group, 1.2, 0.1, 1.2, MAT.bodyDark, { y: top + 0.07, round: 0.14 });
    for (let index = 0; index < 3; index += 1) {
      slab(group, 1.0 - index * 0.16, 0.05, 0.18, MAT.bodyLight, {
        y: top + 0.2 + index * 0.12,
        round: 0.3,
      });
      strap(group, 0.18, 0.03, 0.02, HUE.warm, {
        x: 0.44 - index * 0.08,
        y: top + 0.23 + index * 0.12,
        opacity: 0.8,
      });
    }
    return finish(group);
  },

  ClusterServiceVersion(resource) {
    const { group, top } = stage(resource, { radius: 0.95 });
    disc(group, 0.36, 0.12, MAT.body, { y: top + 0.06 });
    addMesh(group, new THREE.CylinderGeometry(0.05, 0.08, 0.5, 10), mat(MAT.metal), {
      y: top + 0.4,
    });
    const badge = addMesh(group, new THREE.IcosahedronGeometry(0.26, 0), glow(HUE.ice, 0.55), {
      y: top + 0.8,
    });
    const halo = torus(group, 0.42, 0.02, HUE.ice, { y: top + 0.8, rx: Math.PI / 2 + 0.25 });
    group.userData.animate = (time) => {
      badge.rotation.y = time * 0.5;
      halo.rotation.z = time * 0.3;
    };
    return finish(group);
  },

  PackageManifest(resource) {
    const { group, top } = stage(resource, { radius: 1.0 });
    slab(group, 1.5, 0.07, 1.2, MAT.bodyDark, { y: top + 0.15, round: 0.1 });
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        addMesh(group, new THREE.BoxGeometry(0.3, 0.12, 0.3), glow(HUE.warm, 0.32), {
          x: -0.44 + column * 0.44,
          y: top + 0.24,
          z: -0.22 + row * 0.44,
        });
      }
    }
    return finish(group);
  },

  MetalLB(resource) {
    const { group, top } = stage(resource, { radius: 0.95 });
    disc(group, 0.4, 0.1, MAT.body, { y: top + 0.05 });
    addMesh(group, new THREE.CylinderGeometry(0.04, 0.06, 0.6, 10), mat(MAT.metal), {
      y: top + 0.4,
    });
    addMesh(group, new THREE.CylinderGeometry(0.02, 0.02, 1.0, 8), mat(MAT.metal), {
      y: top + 0.8,
      rx: Math.PI / 2,
      rz: Math.PI / 2,
      z: 0,
    });
    const beaconMaterial = mat(HUE.sky, {
      metalness: 0.2,
      roughness: 0.3,
      emissive: new THREE.Color(HUE.sky),
      emissiveIntensity: 0.9,
    });
    const beacon = addMesh(group, new THREE.SphereGeometry(0.16, 16, 12), beaconMaterial, {
      y: top + 0.78,
    });
    group.userData.animate = (time) => {
      beacon.position.y = top + 0.78 + Math.sin(time * 2.2) * 0.05;
      beaconMaterial.emissiveIntensity = 0.7 + Math.sin(time * 2.2) * 0.25;
    };
    return finish(group);
  },

  PrometheusRule(resource) {
    const { group, top } = stage(resource, { radius: 0.9 });
    // Alerting-rule slate: a rule book standing on the pedestal.
    slab(group, 1.0, 0.82, 0.09, MAT.body, { y: top + 0.6, rx: -0.18, round: 0.12 });
    for (let i = 0; i < 4; i += 1) {
      strap(group, 0.62 - i * 0.06, 0.035, 0.012, HUE.warm, {
        x: -0.04 + i * 0.02,
        y: top + 0.85 - i * 0.17,
        z: 0.07,
        rx: -0.18,
        opacity: 0.55,
      });
    }
    // Firing-alert beacon: the amber lamp that marks "this rule is evaluating".
    const beaconMaterial = mat(HUE.amber, {
      metalness: 0.2,
      roughness: 0.3,
      emissive: new THREE.Color(HUE.amber),
      emissiveIntensity: 0.9,
    });
    const beacon = addMesh(group, new THREE.SphereGeometry(0.11, 16, 12), beaconMaterial, {
      x: 0.44,
      y: top + 1.02,
      z: 0.02,
    });
    const halo = torus(group, 0.2, 0.014, HUE.amber, {
      x: 0.44,
      y: top + 1.02,
      z: 0.02,
      rx: Math.PI / 2,
      opacity: 0.5,
    });
    group.userData.animate = (time) => {
      beaconMaterial.emissiveIntensity = 0.65 + Math.sin(time * 1.8) * 0.3;
      halo.rotation.z = time * 0.4;
    };
    return finish(group);
  },

  Alertmanager(resource) {
    const { group, top } = stage(resource, { radius: 1.0 });
    // Notification routing table: one mast that fans alerts out to receivers.
    disc(group, 0.7, 0.07, MAT.bodyDark, { y: top + 0.05, round: 0.1 });
    addMesh(group, new THREE.CylinderGeometry(0.05, 0.09, 0.7, 12), mat(MAT.metal), {
      y: top + 0.38,
    });
    for (let i = 0; i < 3; i += 1) {
      const angle = (Math.PI * 2 * i) / 3 - Math.PI / 2;
      const x = Math.cos(angle) * 0.46;
      const z = Math.sin(angle) * 0.46;
      slab(group, 0.26, 0.16, 0.26, MAT.bodyLight, { x, y: top + 0.16, z, round: 0.3 });
      strap(group, 0.12, 0.02, 0.02, HUE.teal, {
        x,
        y: top + 0.25,
        z,
        opacity: 0.8,
      });
    }
    // Notification beacon: pulses while the receiver routing is live.
    const beaconMaterial = mat(HUE.teal, {
      metalness: 0.2,
      roughness: 0.3,
      emissive: new THREE.Color(HUE.teal),
      emissiveIntensity: 0.9,
    });
    const beacon = addMesh(group, new THREE.SphereGeometry(0.15, 16, 12), beaconMaterial, {
      y: top + 0.82,
    });
    const halo = torus(group, 0.27, 0.015, HUE.teal, {
      y: top + 0.82,
      rx: Math.PI / 2 + 0.3,
      opacity: 0.5,
    });
    group.userData.animate = (time) => {
      beacon.position.y = top + 0.82 + Math.sin(time * 2.4) * 0.03;
      beaconMaterial.emissiveIntensity = 0.6 + Math.sin(time * 1.6) * 0.3;
      halo.rotation.z = time * 0.5;
    };
    return finish(group);
  },
};

// Legacy renderable type aliases (older cluster state / links may use short names).
const MESH_ALIASES = {
  HPA: 'HorizontalPodAutoscaler',
  PVC: 'PersistentVolumeClaim',
  PV: 'PersistentVolume',
  SC: 'StorageClass',
  ISTAG: 'ImageStream',
  BC: 'BuildConfig',
  RS: 'ReplicaSet',
  STS: 'StatefulSet',
  DS: 'DaemonSet',
  CJ: 'CronJob',
  SA: 'ServiceAccount',
  CM: 'ConfigMap',
  NETPOL: 'NetworkPolicy',
  PDB: 'PodDisruptionBudget',
  SCC: 'SecurityContextConstraints',
  CRB: 'ClusterRoleBinding',
  CR: 'ClusterRole',
};

/** Canonical kinds in js/data/kindRegistry.js that have a dedicated creator. */
export const MESH_CREATOR_KINDS = Object.freeze(Object.keys(CREATORS));

/** Kinds from the registry with no dedicated creator (must be empty). */
export const MISSING_MESH_KINDS = Object.freeze(RESOURCE_KINDS.filter((kind) => !CREATORS[kind]));

export function hasMeshCreator(kind) {
  return Boolean(kind && CREATORS[kind]);
}

/** Resolve a renderable/resource to the canonical creator key. */
export function meshKindFor(resource) {
  const raw = resourceKind(resource);
  if (!raw) return null;
  if (CREATORS[raw]) return raw;
  if (MESH_ALIASES[raw]) return MESH_ALIASES[raw];
  const normalized = normalizeKind(raw);
  if (normalized && CREATORS[normalized]) return normalized;
  // Case-insensitive match (e.g. "pod" from a saved share link).
  const found = Object.keys(CREATORS).find(
    (kind) => kind.toLowerCase() === String(raw).toLowerCase()
  );
  return found || null;
}

export class ResourceMeshFactory {
  constructor() {
    this.geometryCache = new Map();
  }

  create(resource) {
    const kind = meshKindFor(resource);
    const creator = kind ? CREATORS[kind] : null;
    let group;
    try {
      group = creator ? creator(resource) : this._createFallback(resource);
    } catch (error) {
      console.warn(`ResourceMeshes: ${kind || 'unknown'} creator failed, using fallback`, error);
      group = this._createFallback(resource);
    }
    if (group) {
      group.userData.meshKind = kind || 'Fallback';
      group.userData.resourceKind = resourceKind(resource) || kind || 'Unknown';
      group.userData.displayName = resourceDisplayName(resource);
    }
    return group;
  }

  _createFallback(resource) {
    const { group, top: pedestalTop } = stage(resource, { radius: 0.86 });
    slab(group, 0.62, 0.62, 0.62, MAT.body, { y: pedestalTop + 0.42, round: 0.16 });
    strap(group, 0.4, 0.04, 0.04, HUE.slate, { y: pedestalTop + 0.76, opacity: 0.8 });
    return finish(group);
  }

  updateStatus(group, status) {
    if (!group || !status) return;
    const statusColor = getStatusColor(status);
    group.userData.status = status;
    group.userData.statusPulse = PULSING_STATUSES.has(status);
    const material = group.userData.statusMaterial;
    if (material) {
      material.color.set(statusColor);
      material.opacity = group.userData.statusBaseOpacity ?? 0.62;
    }
  }

  /**
   * Update the replica tick marks of a Deployment-like model after `oc scale`.
   * @param {THREE.Group} group
   * @param {number} replicas desired replica count
   * @returns {boolean} true when the model has updatable marks
   */
  updateReplicaCount(group, replicas) {
    return applyReplicaMarks(group, replicas);
  }

  dispose(group) {
    if (!group) return;
    group.traverse((child) => {
      if (child.geometry && !child.geometry.userData?.shared) child.geometry.dispose();
      const materials = Array.isArray(child.material)
        ? child.material
        : child.material
          ? [child.material]
          : [];
      for (const material of materials) {
        if (!material) continue;
        if (material.map && !material.map.userData?.shared) material.map.dispose();
        material.dispose();
      }
    });
  }
}

export { getStatusColor as getStatusColorFor };
export default {
  ResourceMeshFactory,
  MESH_CREATOR_KINDS,
  MISSING_MESH_KINDS,
  hasMeshCreator,
  meshKindFor,
};
