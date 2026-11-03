import * as THREE from 'three';
import { RESOURCE_KINDS, normalizeKind } from '../data/kindRegistry.js';

/**
 * Kind → 3D mesh creator registry for OpenShift Games.
 *
 * Every kind in js/data/kindRegistry.js has a creator here, including the
 * non-placeable kinds that can appear in cluster state (Build, Identity, OAuth,
 * ClusterOperator, ClusterVersion). Unknown kinds still get a labelled fallback
 * cube so the renderer never crashes.
 *
 * OpenShift-specific kinds use the OpenShift red (#EE0000) / orange (#F97316)
 * accent palette; transient status still overrides the glow/emissive colour via
 * STATUS_COLORS so existing status colour semantics are preserved.
 */

// ── Palette ──────────────────────────────────────────────────────────────────
export const OPENSHIFT_RED = 0xee0000;
export const OPENSHIFT_ORANGE = 0xf97316;
const RED = 0xd73a49;
const LIGHT_RED = 0xf85149;
const ORANGE = 0xf0883e;
const GOLD = 0xe3b341;
const YELLOW = 0xd29922;
const GREEN = 0x3fb950;
const TEAL = 0x39c5cf;
const BLUE = 0x326ce5;
const LIGHT_BLUE = 0x58a6ff;
const SKY = 0x79c0ff;
const DARK_BLUE = 0x1f6feb;
const PURPLE = 0xa371f7;
const VIOLET = 0x8957e5;
const CYAN = 0x22d3ee;
const GRAY = 0x8b949e;
const DARK_GRAY = 0x6e7681;
const SLATE = 0x30363d;
const WHITE = 0xe6edf3;

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
  Active: 0xee0000,
  Progressing: 0x58a6ff,
  Updating: 0x58a6ff,
  Installing: 0xffa657,
  Suspended: 0xffa657,
  Paused: 0xffa657,
  Degraded: 0xd73a49,
  Unavailable: 0xd73a49,
  default: 0x58a6ff,
};

const EMISSIVE_INTENSITY = 0.25;

export function getStatusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.default;
}

// ── Generic helpers ──────────────────────────────────────────────────────────
function createStandardMaterial(color, status) {
  const statusColor = getStatusColor(status);
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.4,
    roughness: 0.35,
    emissive: new THREE.Color(statusColor),
    emissiveIntensity: EMISSIVE_INTENSITY,
  });
}

function createGlowMaterial(color, opacity = 0.15) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
  });
}

function createGlowRing(color, radius) {
  const ringGeo = new THREE.RingGeometry(radius * 0.8, radius * 1.2, 32);
  const ring = new THREE.Mesh(ringGeo, createGlowMaterial(color, 0.15));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.userData.isGlow = true;
  return ring;
}

function addMesh(group, geometry, material, opts = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  const { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, castShadow = true, receiveShadow = true, userData } = opts;
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  if (userData) Object.assign(mesh.userData, userData);
  group.add(mesh);
  return mesh;
}

function box(group, w, h, d, color, status, opts = {}) {
  return addMesh(group, new THREE.BoxGeometry(w, h, d), createStandardMaterial(color, status), opts);
}

function cylinder(group, rTop, rBottom, height, segments, color, status, opts = {}) {
  return addMesh(group, new THREE.CylinderGeometry(rTop, rBottom, height, segments), createStandardMaterial(color, status), opts);
}

function sphere(group, radius, color, status, opts = {}) {
  return addMesh(group, new THREE.SphereGeometry(radius, 16, 16), createStandardMaterial(color, status), opts);
}

function torus(group, radius, tube, color, status, opts = {}) {
  const {
    arc = Math.PI * 2,
    radialSegments = 8,
    tubularSegments = 24,
    ...meshOpts
  } = opts;
  return addMesh(group, new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments, arc), createStandardMaterial(color, status), meshOpts);
}

function cone(group, radius, height, segments, color, status, opts = {}) {
  return addMesh(group, new THREE.ConeGeometry(radius, height, segments), createStandardMaterial(color, status), opts);
}

function extrude(group, shape, depth, color, status, opts = {}) {
  const { bevel = true, bevelSize = 0.04, bevelThickness = 0.04, bevelSegments = 2, ...meshOpts } = opts;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel,
    bevelThickness,
    bevelSize,
    bevelSegments,
  });
  geometry.center();
  return addMesh(group, geometry, createStandardMaterial(color, status), meshOpts);
}

function flatBar(group, w, h, d, color, opts = {}) {
  return addMesh(group, new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }), opts);
}

const _labelTextureCache = new Map();

function createLabelSprite(text) {
  const cached = _labelTextureCache.get(text);
  if (cached) {
    const spriteMat = new THREE.SpriteMaterial({
      map: cached,
      transparent: true,
      depthTest: false,
      sizeAttenuation: true,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(3.5, 0.9, 1);
    sprite.userData.isLabel = true;
    return sprite;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 512;
  canvas.height = 128;

  ctx.clearRect(0, 0, 512, 128);
  ctx.font = 'bold 36px "Inter", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  ctx.fillStyle = 'rgba(13, 17, 23, 0.85)';
  const metrics = ctx.measureText(text);
  const textWidth = Math.min(metrics.width + 28, 500);
  const rh = 56;
  const rx = (512 - textWidth) / 2;
  const ry = (128 - rh) / 2;
  const r = 8;
  ctx.beginPath();
  ctx.moveTo(rx + r, ry);
  ctx.lineTo(rx + textWidth - r, ry);
  ctx.quadraticCurveTo(rx + textWidth, ry, rx + textWidth, ry + r);
  ctx.lineTo(rx + textWidth, ry + rh - r);
  ctx.quadraticCurveTo(rx + textWidth, ry + rh, rx + textWidth - r, ry + rh);
  ctx.lineTo(rx + r, ry + rh);
  ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
  ctx.lineTo(rx, ry + r);
  ctx.quadraticCurveTo(rx, ry, rx + r, ry);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(238, 0, 0, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.fillStyle = '#e6edf3';
  ctx.fillText(text, 256, 64, 480);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.userData.shared = true;
  _labelTextureCache.set(text, texture);

  const spriteMat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    sizeAttenuation: true,
  });

  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(3.5, 0.9, 1);
  sprite.userData.isLabel = true;
  return sprite;
}

function addLabel(group, resource, y = 0.9, text) {
  const labelText = text || resourceDisplayName(resource);
  const label = createLabelSprite(labelText);
  label.position.y = y;
  group.add(label);
  return label;
}

function addGlow(group, accent, radius) {
  group.add(createGlowRing(accent, radius));
}

// ── Renderable / live-resource accessors ────────────────────────────────────
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
  const status = resource?.status;
  if (typeof status === 'string') return status;
  const refStatus = resource?._ref?.status;
  if (typeof refStatus === 'string') return refStatus;
  return status?.phase || refStatus?.phase || null;
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
  shape.quadraticCurveTo(hw * 0.8, -height / 2.5, 0, -height / 2);
  shape.quadraticCurveTo(-hw * 0.8, -height / 2.5, -hw, -height / 6);
  shape.lineTo(-hw, height / 6);
  shape.quadraticCurveTo(-hw, height / 2, 0, height / 2);
  return shape;
}

function lockShape() {
  const shackle = new THREE.Shape();
  shackle.moveTo(-0.4, -0.3);
  shackle.lineTo(-0.4, 0.1);
  shackle.quadraticCurveTo(-0.4, 0.5, 0, 0.5);
  shackle.quadraticCurveTo(0.4, 0.5, 0.4, 0.1);
  shackle.lineTo(0.4, -0.3);
  shackle.lineTo(-0.4, -0.3);

  const body = new THREE.Shape();
  body.moveTo(-0.5, -0.3);
  body.lineTo(0.5, -0.3);
  body.lineTo(0.5, -0.8);
  body.lineTo(-0.5, -0.8);
  body.closePath();

  return { shackle, body };
}

function folderShape() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.9, -0.6);
  shape.lineTo(-0.35, -0.6);
  shape.lineTo(-0.2, -0.42);
  shape.lineTo(0.9, -0.42);
  shape.lineTo(0.9, 0.6);
  shape.lineTo(-0.9, 0.6);
  shape.closePath();
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
  shape.moveTo(-0.5, -0.65);
  shape.lineTo(0.32, -0.65);
  shape.lineTo(0.5, -0.46);
  shape.lineTo(0.5, 0.65);
  shape.lineTo(-0.5, 0.65);
  shape.closePath();
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

function roundedBoxGeometry(width, height, depth, radius, segments) {
  const shape = new THREE.Shape();
  const hw = width / 2 - radius;
  const hh = height / 2 - radius;

  shape.moveTo(-hw, height / 2);
  shape.lineTo(hw, height / 2);
  shape.quadraticCurveTo(width / 2, height / 2, width / 2, hh);
  shape.lineTo(width / 2, -hh);
  shape.quadraticCurveTo(width / 2, -height / 2, hw, -height / 2);
  shape.lineTo(-hw, -height / 2);
  shape.quadraticCurveTo(-width / 2, -height / 2, -width / 2, -hh);
  shape.lineTo(-width / 2, hh);
  shape.quadraticCurveTo(-width / 2, height / 2, -hw, height / 2);

  return new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: segments || 2,
  });
}

// ── Composite helpers ────────────────────────────────────────────────────────
function addPerson(group, opts = {}) {
  const { x = 0, y = 0, z = 0, scale = 1, color = TEAL, status = null, headColor = null } = opts;
  const person = new THREE.Group();
  person.position.set(x, y, z);
  person.scale.setScalar(scale);
  group.add(person);

  addMesh(person, new THREE.SphereGeometry(0.26, 16, 16), createStandardMaterial(headColor || color, status), { y: 0.92 });
  addMesh(person, new THREE.CylinderGeometry(0.24, 0.4, 0.62, 12), createStandardMaterial(color, status), { y: 0.42 });
  addMesh(person, new THREE.SphereGeometry(0.4, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), createStandardMaterial(color, status), {
    y: 0.6, rx: Math.PI, castShadow: false,
  });
  return person;
}

function addGear(group, opts = {}) {
  const {
    radius = 0.4,
    teeth = 8,
    depth = 0.16,
    color = OPENSHIFT_ORANGE,
    status = null,
    x = 0,
    y = 0.55,
    z = 0,
    tilt = 0,
  } = opts;
  const gear = new THREE.Group();
  gear.position.set(x, y, z);
  gear.rotation.x = tilt;
  group.add(gear);

  addMesh(gear, new THREE.TorusGeometry(radius * 0.72, radius * 0.24, 10, 24), createStandardMaterial(color, status));
  addMesh(gear, new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, depth * 1.6, 12), createStandardMaterial(DARK_GRAY, status), {
    rx: Math.PI / 2,
  });
  for (let i = 0; i < teeth; i++) {
    const angle = (Math.PI * 2 * i) / teeth;
    addMesh(gear, new THREE.BoxGeometry(radius * 0.28, radius * 0.24, depth), createStandardMaterial(color, status), {
      x: Math.cos(angle) * radius * 0.88,
      y: Math.sin(angle) * radius * 0.88,
      rz: angle,
    });
  }
  return gear;
}

function addChainLinks(group, count, color, status, opts = {}) {
  const { x = 0, z = 0 } = opts;
  const links = [];
  for (let i = 0; i < count; i++) {
    const link = torus(group, 0.28, 0.07, color, status, {
      x,
      y: 0.35 + i * 0.36,
      z,
      rz: i % 2 === 0 ? 0 : Math.PI / 2,
      tubularSegments: 16,
    });
    links.push(link);
  }
  return links;
}

function addPersonBadge(group, color, status) {
  // ID-card style badge used by ServiceAccount.
  addMesh(group, roundedBoxGeometry(1.0, 0.68, 0.08, 0.08, 2), createStandardMaterial(color, status), {
    y: 0.62, rx: -Math.PI / 2 + 0.22,
  });
  addMesh(group, new THREE.CylinderGeometry(0.14, 0.14, 0.03, 16), createStandardMaterial(WHITE, status), {
    y: 0.68, z: 0.06, rx: Math.PI / 2 - 0.22,
  });
  flatBar(group, 0.42, 0.04, 0.02, 0xd0d7de, { y: 0.56, z: 0.08 });
  flatBar(group, 0.3, 0.04, 0.02, 0xd0d7de, { y: 0.46, z: 0.08 });
}

function addSignalArcs(group, color, status, opts = {}) {
  const { x = 0, y = 0.5, z = 0 } = opts;
  for (let i = 0; i < 3; i++) {
    const radius = 0.28 + i * 0.2;
    const arc = torus(group, radius, 0.02, color, status, {
      x,
      y: y + i * 0.3,
      z,
      arc: Math.PI * 0.9,
      rz: Math.PI * 0.05,
      tubularSegments: 20,
      castShadow: false,
    });
    arc.rotation.x = Math.PI / 2;
    arc.rotation.z = -Math.PI / 2;
  }
}

// ── Kind creators ────────────────────────────────────────────────────────────
const CREATORS = {
  // ── Projects & cluster ────────────────────────────────────────────────────
  Project(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();

    // Project scope zone (Project replaces Namespace in OpenShift).
    const zone = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.6),
      new THREE.MeshStandardMaterial({
        color: OPENSHIFT_RED,
        transparent: true,
        opacity: 0.05,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    zone.rotation.x = -Math.PI / 2;
    zone.position.y = -0.02;
    zone.receiveShadow = true;
    group.add(zone);

    const zoneBorder = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(2.6, 2.6)),
      new THREE.LineBasicMaterial({ color: OPENSHIFT_RED, transparent: true, opacity: 0.45 }),
    );
    zoneBorder.rotation.x = -Math.PI / 2;
    zoneBorder.position.y = 0.01;
    group.add(zoneBorder);

    // Folder icon standing on the zone.
    const folder = extrude(group, folderShape(), 0.16, OPENSHIFT_RED, status, {
      y: 0.62, bevel: false,
    });
    folder.rotation.x = -0.25;
    flatBar(group, 0.5, 0.06, 0.02, 0xff8a80, { y: 0.8, z: 0.12 });
    addLabel(group, resource, 1.15);
    return group;
  },

  Node(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const platformGeom = new THREE.BoxGeometry(3.0, 0.4, 2.2);
    const platformMat = createStandardMaterial(SLATE, status);
    platformMat.metalness = 0.5;
    platformMat.roughness = 0.5;
    const platform = new THREE.Mesh(platformGeom, platformMat);
    platform.receiveShadow = true;
    platform.castShadow = true;
    group.add(platform);

    const borderMat = new THREE.LineBasicMaterial({ color: OPENSHIFT_RED, transparent: true, opacity: 0.6 });
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(platformGeom), borderMat));

    for (let i = 0; i < 3; i++) {
      addMesh(group, new THREE.BoxGeometry(0.35, 0.12, 0.35), new THREE.MeshStandardMaterial({
        color: SKY,
        emissive: new THREE.Color(OPENSHIFT_RED),
        emissiveIntensity: 0.35,
        metalness: 0.7,
        roughness: 0.3,
      }), { x: -0.6 + i * 0.6, y: 0.26 });
    }

    addMesh(group, new THREE.SphereGeometry(0.18, 12, 12), new THREE.MeshBasicMaterial({
      color: getStatusColor(status),
    }), { x: -1.2, y: 0.38, z: -0.8, userData: { isGlow: true } });

    addLabel(group, resource, 0.9);
    return group;
  },

  ClusterResourceQuota(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    box(group, 1.5, 0.12, 0.85, SLATE, status, { y: 0.06 });
    const heights = [0.5, 0.85, 1.15];
    heights.forEach((h, i) => {
      box(group, 0.26, h, 0.5, i === 2 ? LIGHT_RED : OPENSHIFT_ORANGE, status, {
        x: -0.46 + i * 0.46,
        y: 0.12 + h / 2,
      });
    });
    flatBar(group, 2.0, 0.02, 0.02, OPENSHIFT_RED, { y: 1.25, castShadow: false });
    addGlow(group, OPENSHIFT_ORANGE, 0.7);
    addLabel(group, resource, 1.55);
    return group;
  },

  ClusterOperator(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    cylinder(group, 0.5, 0.62, 0.18, 20, SLATE, status, { y: 0.09 });
    cylinder(group, 0.07, 0.09, 0.5, 10, DARK_GRAY, status, { y: 0.4 });
    const beaconMat = new THREE.MeshStandardMaterial({
      color: OPENSHIFT_RED,
      emissive: new THREE.Color(getStatusColor(status)),
      emissiveIntensity: 0.9,
      metalness: 0.3,
      roughness: 0.2,
    });
    const beacon = addMesh(group, new THREE.SphereGeometry(0.24, 20, 20), beaconMat, { y: 0.78 });
    const halo = torus(group, 0.38, 0.03, OPENSHIFT_ORANGE, status, { y: 0.78, rx: Math.PI / 2 });
    addGlow(group, getStatusColor(status), 0.55);
    addLabel(group, resource, 1.25);
    group.userData.animate = (time) => {
      const pulse = 0.85 + Math.sin(time * 3) * 0.15;
      beacon.scale.setScalar(pulse);
      beaconMat.emissiveIntensity = 0.6 + Math.sin(time * 3) * 0.25;
      halo.rotation.z = time * 0.9;
    };
    return group;
  },

  ClusterVersion(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    cylinder(group, 0.1, 0.14, 1.0, 10, DARK_GRAY, status, { y: 0.5 });
    const ringColors = [OPENSHIFT_RED, OPENSHIFT_ORANGE, GOLD];
    const rings = [];
    ringColors.forEach((color, i) => {
      const radius = 0.52 - i * 0.14;
      const ring = torus(group, radius, 0.035, color, status, { y: 0.32 + i * 0.28, rx: Math.PI / 2 });
      rings.push(ring);
    });
    cone(group, 0.13, 0.3, 8, OPENSHIFT_RED, status, { y: 1.2 });
    addGlow(group, OPENSHIFT_RED, 0.6);
    addLabel(group, resource, 1.6);
    group.userData.animate = (time) => {
      rings[0].rotation.z = time * 0.6;
      rings[1].rotation.z = -time * 0.8;
      rings[2].rotation.z = time * 1.0;
    };
    return group;
  },

  OAuth(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    // Key = identity provider.
    torus(group, 0.3, 0.09, OPENSHIFT_RED, status, { y: 1.05 });
    box(group, 0.1, 0.72, 0.1, OPENSHIFT_ORANGE, status, { y: 0.6 });
    box(group, 0.26, 0.09, 0.09, OPENSHIFT_ORANGE, status, { x: 0.12, y: 0.32 });
    box(group, 0.2, 0.09, 0.09, OPENSHIFT_ORANGE, status, { x: 0.1, y: 0.5 });
    addGlow(group, OPENSHIFT_RED, 0.5);
    addLabel(group, resource, 1.55);
    return group;
  },

  // ── Workloads ─────────────────────────────────────────────────────────────
  Pod(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const geom = new THREE.ExtrudeGeometry(hexShape(0.6), {
      depth: 0.5,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 2,
    });
    geom.center();
    const mesh = new THREE.Mesh(geom, createStandardMaterial(BLUE, status));
    mesh.castShadow = true;
    group.add(mesh);

    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.7, 6), createGlowMaterial(getStatusColor(status), 0.15));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.26;
    glow.userData.isGlow = true;
    group.add(glow);

    addGlow(group, OPENSHIFT_RED, 0.5);
    addLabel(group, resource, 0.8);

    group.userData.baseY = resource.y || 0;
    return group;
  },

  Deployment(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const geom = roundedBoxGeometry(1.4, 1.0, 0.5, 0.15, 3);
    geom.center();
    const mesh = new THREE.Mesh(geom, createStandardMaterial(DARK_BLUE, status));
    mesh.castShadow = true;
    group.add(mesh);

    const spec = resourceSpec(resource);
    const replicas = spec.replicas ?? resource.replicas ?? 1;
    const badge = new THREE.Mesh(new THREE.CircleGeometry(0.2, 16), new THREE.MeshBasicMaterial({ color: SKY }));
    badge.position.set(0.6, 0.55, 0.3);
    group.add(badge);
    const badgeLabel = createLabelSprite(String(replicas));
    badgeLabel.scale.set(0.5, 0.25, 1);
    badgeLabel.position.set(0.6, 0.55, 0.32);
    group.add(badgeLabel);

    addGlow(group, OPENSHIFT_ORANGE, 0.7);
    addLabel(group, resource, 0.9);
    return group;
  },

  ReplicaSet(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const spec = resourceSpec(resource);
    const count = Math.min(spec.replicas ?? resource.replicas ?? 3, 5);
    for (let i = 0; i < count; i++) {
      const mat = createStandardMaterial(0x388bfd, status);
      mat.transparent = true;
      mat.opacity = 1 - i * 0.15;
      addMesh(group, new THREE.BoxGeometry(1.2, 0.12, 0.9), mat, { y: i * 0.16 });
    }
    addGlow(group, 0x388bfd, 0.6);
    addLabel(group, resource, count * 0.16 + 0.5);
    return group;
  },

  StatefulSet(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const spec = resourceSpec(resource);
    const ordinals = Math.min(spec.replicas ?? resource.replicas ?? 3, 5);
    for (let i = 0; i < ordinals; i++) {
      const geom = new THREE.ExtrudeGeometry(hexShape(0.4), { depth: 0.3, bevelEnabled: false });
      geom.center();
      addMesh(group, geom, createStandardMaterial(VIOLET, status), {
        x: i * 0.9 - (ordinals - 1) * 0.45,
      });
      const ordLabel = createLabelSprite(String(i));
      ordLabel.scale.set(0.5, 0.25, 1);
      ordLabel.position.set(i * 0.9 - (ordinals - 1) * 0.45, 0.5, 0);
      group.add(ordLabel);
    }
    addGlow(group, VIOLET, 0.5);
    addLabel(group, resource, 0.8);
    return group;
  },

  DaemonSet(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const geom = new THREE.ExtrudeGeometry(starShape(0.7, 0.35, 5), {
      depth: 0.4,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.03,
      bevelSegments: 1,
    });
    geom.center();
    const mesh = new THREE.Mesh(geom, createStandardMaterial(YELLOW, status));
    mesh.castShadow = true;
    group.add(mesh);
    addGlow(group, YELLOW, 0.6);
    addLabel(group, resource, 0.9);
    group.userData.animate = (time) => {
      mesh.rotation.z = Math.sin(time * 0.5) * 0.1;
    };
    return group;
  },

  Job(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const mat = createStandardMaterial(0x7ee787, status);
    cone(group, 0.4, 0.6, 6, 0x7ee787, status, { y: 0.3 });
    const botCone = cone(group, 0.4, 0.6, 6, 0x7ee787, status, { rx: Math.PI, y: -0.3 });
    botCone.material = mat.clone();
    box(group, 0.16, 0.1, 0.16, WHITE, status, {});
    addGlow(group, 0x7ee787, 0.4);
    addLabel(group, resource, 0.9);
    group.userData.animate = (time) => {
      if (status === 'Running') group.rotation.z = Math.sin(time * 3) * 0.15;
    };
    return group;
  },

  CronJob(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const face = cylinder(group, 0.6, 0.6, 0.15, 24, 0xbc8cff, status, { rx: Math.PI / 2 });
    torus(group, 0.62, 0.05, PURPLE, status, {});
    const handMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.3,
    });
    const hourHand = addMesh(group, new THREE.BoxGeometry(0.04, 0.3, 0.04), handMat, { y: 0.15, z: 0.1 });
    const minuteHand = addMesh(group, new THREE.BoxGeometry(0.03, 0.42, 0.03), handMat.clone(), { y: 0.21, z: 0.12 });
    for (let i = 0; i < 12; i++) {
      const angle = (Math.PI / 6) * i;
      flatBar(group, 0.03, 0.08, 0.03, 0xc9d1d9, {
        x: Math.sin(angle) * 0.5, y: Math.cos(angle) * 0.5, z: 0.1, castShadow: false,
      });
    }
    addGlow(group, 0xbc8cff, 0.5);
    addLabel(group, resource, 1.0);
    group.userData.animate = (time) => {
      hourHand.rotation.z = -time * 0.2;
      minuteHand.rotation.z = -time * 1.2;
    };
    void face;
    return group;
  },

  // ── Builds & images ──────────────────────────────────────────────────────
  BuildConfig(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const gear = addGear(group, { radius: 0.42, teeth: 8, color: OPENSHIFT_ORANGE, status, tilt: 0.35 });
    // Wrench crossed over the gear.
    box(group, 0.09, 0.62, 0.09, GRAY, status, { x: 0.42, y: 0.55, z: 0.12, rz: -0.6 });
    box(group, 0.2, 0.12, 0.1, GRAY, status, { x: 0.62, y: 0.78, z: 0.12, rz: -0.6 });
    addGlow(group, OPENSHIFT_ORANGE, 0.6);
    addLabel(group, resource, 1.25);
    group.userData.animate = (time) => {
      gear.rotation.z = time * 0.4;
    };
    return group;
  },

  Build(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const gear = addGear(group, { radius: 0.5, teeth: 10, color: ORANGE, status, tilt: 0.3 });
    addGlow(group, ORANGE, 0.55);
    addLabel(group, resource, 1.25);
    group.userData.animate = (time) => {
      gear.rotation.z = time * 1.4;
    };
    return group;
  },

  ImageStream(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const spec = resourceSpec(resource);
    const tagCount = Math.max(2, Math.min((spec.tags || []).length || 2, 5));
    const disks = [];
    for (let i = 0; i < tagCount; i++) {
      const radius = 0.56 - i * 0.06;
      const disk = cylinder(group, radius, radius, 0.14, 24, i === 0 ? OPENSHIFT_ORANGE : PURPLE, status, {
        y: 0.2 + i * 0.22,
      });
      disks.push(disk);
    }
    cylinder(group, 0.07, 0.07, tagCount * 0.22 + 0.2, 10, DARK_GRAY, status, { y: 0.2 + (tagCount - 1) * 0.11 });
    addGlow(group, PURPLE, 0.6);
    addLabel(group, resource, 0.2 + tagCount * 0.22 + 0.5);
    group.userData.animate = (time) => {
      disks.forEach((disk, i) => {
        disk.position.y = 0.2 + i * 0.22 + Math.sin(time * 1.5 + i) * 0.02;
      });
    };
    return group;
  },

  // ── Networking ───────────────────────────────────────────────────────────
  Service(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    sphere(group, 0.5, LIGHT_BLUE, status);
    const ringMat = new THREE.MeshStandardMaterial({
      color: SKY,
      emissive: new THREE.Color(LIGHT_BLUE),
      emissiveIntensity: 0.3,
      metalness: 0.6,
      roughness: 0.3,
    });
    const ring = addMesh(group, new THREE.TorusGeometry(0.75, 0.06, 8, 32), ringMat, { rx: Math.PI / 2 });
    addGlow(group, BLUE, 0.6);
    addLabel(group, resource, 0.9);
    group.userData.animate = (time) => {
      ring.rotation.z = time * 0.8;
    };
    return group;
  },

  Route(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const spec = resourceSpec(resource);

    cylinder(group, 0.06, 0.09, 1.25, 8, DARK_GRAY, status, { y: 0.62 });

    const signGeom = new THREE.ExtrudeGeometry(arrowSignShape(), {
      depth: 0.13, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1,
    });
    signGeom.center();
    const sign = new THREE.Mesh(signGeom, createStandardMaterial(OPENSHIFT_RED, status));
    sign.position.set(0.16, 1.1, 0);
    sign.castShadow = true;
    group.add(sign);

    const tls = spec.tls;
    if (tls) {
      const tlsColor = tls.termination === 'passthrough' ? PURPLE : GOLD;
      const lockRing = torus(group, 0.16, 0.035, tlsColor, status, { x: 0.16, y: 1.48, z: 0.12 });
      lockRing.rotation.x = Math.PI / 2;
    } else {
      flatBar(group, 0.24, 0.05, 0.02, 0xff8a80, { x: 0.16, y: 0.78, z: 0.12, castShadow: false });
    }

    addGlow(group, OPENSHIFT_RED, 0.5);
    addLabel(group, resource, 1.7);
    group.userData.animate = (time) => {
      sign.rotation.y = Math.sin(time * 0.6) * 0.08;
    };
    return group;
  },

  Ingress(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const geom = new THREE.OctahedronGeometry(0.6, 0);
    const mat = createStandardMaterial(SKY, status);
    mat.flatShading = true;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    group.add(mesh);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geom),
      new THREE.LineBasicMaterial({ color: 0xb3d9ff, transparent: true, opacity: 0.5 }),
    );
    group.add(edges);
    addGlow(group, SKY, 0.5);
    addLabel(group, resource, 1.0);
    group.userData.animate = (time) => {
      mesh.rotation.y = time * 0.4;
      edges.rotation.y = time * 0.4;
    };
    return group;
  },

  NetworkPolicy(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    extrude(group, shieldShape(1.0, 1.2), 0.25, 0xf0883e, status, {});
    for (let i = 0; i < 3; i++) {
      flatBar(group, 0.62, 0.05, 0.03, 0xffd7a8, { y: 0.24 - i * 0.22, z: 0.16, castShadow: false });
    }
    addGlow(group, 0xf0883e, 0.5);
    addLabel(group, resource, 1.0);
    return group;
  },

  IPAddressPool(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const nodes = [
      { x: -0.55, y: 0.3, z: 0.25 },
      { x: 0.55, y: 0.3, z: 0.25 },
      { x: 0, y: 0.3, z: -0.55 },
    ];
    for (const node of nodes) {
      sphere(group, 0.18, OPENSHIFT_ORANGE, status, node);
    }
    const lineGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.55, 0.3, 0.25), new THREE.Vector3(0.55, 0.3, 0.25),
      new THREE.Vector3(0.55, 0.3, 0.25), new THREE.Vector3(0, 0.3, -0.55),
      new THREE.Vector3(0, 0.3, -0.55), new THREE.Vector3(-0.55, 0.3, 0.25),
    ]);
    group.add(new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: OPENSHIFT_ORANGE, transparent: true, opacity: 0.6 })));
    cylinder(group, 0.42, 0.52, 0.12, 20, SLATE, status, { y: 0.02 });
    addGlow(group, OPENSHIFT_ORANGE, 0.55);
    addLabel(group, resource, 0.9);
    return group;
  },

  L2Advertisement(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    sphere(group, 0.2, OPENSHIFT_RED, status, { x: -0.4, y: 0.25 });
    sphere(group, 0.2, OPENSHIFT_RED, status, { x: 0.4, y: 0.25 });
    addSignalArcs(group, OPENSHIFT_ORANGE, status, { x: 0, y: 0.55, z: 0 });
    cylinder(group, 0.45, 0.55, 0.1, 20, SLATE, status, { y: 0.02 });
    addGlow(group, OPENSHIFT_RED, 0.55);
    addLabel(group, resource, 1.55);
    return group;
  },

  // ── Config / storage ─────────────────────────────────────────────────────
  ConfigMap(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    cylinder(group, 0.35, 0.35, 0.8, 16, GOLD, status, {});
    const capMat = new THREE.MeshStandardMaterial({ color: 0xf0c84d, metalness: 0.4, roughness: 0.4 });
    addMesh(group, new THREE.CylinderGeometry(0.38, 0.38, 0.05, 16), capMat, { y: 0.42 });
    addMesh(group, new THREE.CylinderGeometry(0.38, 0.38, 0.05, 16), capMat.clone(), { y: -0.42 });
    addGlow(group, GOLD, 0.4);
    addLabel(group, resource, 0.9);
    return group;
  },

  Secret(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const shapes = lockShape();

    const shackleGeom = new THREE.ExtrudeGeometry(shapes.shackle, { depth: 0.25, bevelEnabled: false });
    shackleGeom.center();
    addMesh(group, shackleGeom, createStandardMaterial(GRAY, status), { y: 0.3 });
    const bodyGeom = new THREE.ExtrudeGeometry(shapes.body, {
      depth: 0.35, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03,
    });
    bodyGeom.center();
    addMesh(group, bodyGeom, createStandardMaterial(DARK_GRAY, status), { y: -0.15 });
    addGlow(group, DARK_GRAY, 0.5);
    addLabel(group, resource, 0.9);
    return group;
  },

  LimitRange(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const ruler = box(group, 1.85, 0.08, 0.38, YELLOW, status, { y: 0.1, rz: 0.05 });
    for (let i = 0; i < 10; i++) {
      const tall = i % 5 === 0;
      flatBar(group, 0.03, tall ? 0.14 : 0.09, 0.02, 0xffe08a, {
        x: -0.8 + i * 0.178, y: 0.18, z: 0.18, castShadow: false,
      });
    }
    addGlow(group, YELLOW, 0.55);
    addLabel(group, resource, 0.85);
    group.userData.animate = (time) => {
      ruler.rotation.y = Math.sin(time * 0.5) * 0.06;
    };
    return group;
  },

  ResourceQuota(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    box(group, 1.0, 0.8, 0.6, 0xdb6d28, status, {});
    for (let i = 0; i < 3; i++) {
      const stripeMat = new THREE.MeshStandardMaterial({
        color: 0xffa657,
        emissive: new THREE.Color(0xffa657),
        emissiveIntensity: 0.2,
      });
      addMesh(group, new THREE.BoxGeometry(1.02, 0.06, 0.62), stripeMat, { y: -0.2 + i * 0.2 });
    }
    addGlow(group, 0xdb6d28, 0.5);
    addLabel(group, resource, 0.9);
    return group;
  },

  Template(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const page = extrude(group, pageShape(), 0.06, WHITE, status, { bevel: false, y: 0.72 });
    page.rotation.y = 0.18;
    flatBar(group, 0.62, 0.04, 0.02, OPENSHIFT_ORANGE, { y: 0.95, z: 0.06, castShadow: false });
    flatBar(group, 0.66, 0.04, 0.02, 0x8b949e, { y: 0.82, z: 0.06, castShadow: false });
    flatBar(group, 0.52, 0.04, 0.02, 0x8b949e, { y: 0.68, z: 0.06, castShadow: false });
    addGlow(group, OPENSHIFT_ORANGE, 0.5);
    addLabel(group, resource, 1.35);
    group.userData.animate = (time) => {
      page.position.y = 0.72 + Math.sin(time * 1.4) * 0.04;
      page.rotation.y = 0.18 + Math.sin(time * 0.8) * 0.06;
    };
    return group;
  },

  PersistentVolume(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      cylinder(group, 0.55, 0.55, 0.16, 24, i === 0 ? TEAL : GREEN, status, { y: 0.22 + i * 0.24 });
    }
    cylinder(group, 0.08, 0.08, 0.9, 10, DARK_GRAY, status, { y: 0.45 });
    flatBar(group, 0.7, 0.05, 0.05, TEAL, { y: 0.05, z: 0.32, castShadow: false });
    addGlow(group, TEAL, 0.6);
    addLabel(group, resource, 1.25);
    return group;
  },

  PersistentVolumeClaim(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    cylinder(group, 0.5, 0.4, 0.8, 8, 0x56d364, status, {});
    const ring = addMesh(group, new THREE.TorusGeometry(0.52, 0.04, 8, 8), new THREE.MeshStandardMaterial({
      color: GREEN, metalness: 0.5, roughness: 0.3,
    }), { rx: Math.PI / 2, y: 0.2 });
    addGlow(group, 0x56d364, 0.5);
    addLabel(group, resource, 0.9);
    void ring;
    return group;
  },

  StorageClass(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const offsets = [[-0.22, 0.12], [0, 0.26], [0.22, 0.4]];
    for (const [z, y] of offsets) {
      box(group, 1.25, 0.1, 0.85, PURPLE, status, { z, y });
    }
    box(group, 0.1, 0.5, 0.1, VIOLET, status, { x: -0.5, y: 0.28 });
    addGlow(group, PURPLE, 0.6);
    addLabel(group, resource, 0.95);
    return group;
  },

  // ── Scaling & availability ───────────────────────────────────────────────
  HorizontalPodAutoscaler(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const gauge = addMesh(group, new THREE.TorusGeometry(0.55, 0.1, 8, 24, Math.PI * 1.5),
      createStandardMaterial(0xd2a8ff, status), { rz: Math.PI * 0.75 });
    const needleMat = new THREE.MeshStandardMaterial({
      color: 0xff7b72, emissive: new THREE.Color(0xff7b72), emissiveIntensity: 0.3,
    });
    const needle = addMesh(group, new THREE.ConeGeometry(0.04, 0.5, 4), needleMat, { y: 0.2 });
    addMesh(group, new THREE.SphereGeometry(0.08, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.8 }), {});
    addGlow(group, 0xd2a8ff, 0.5);
    addLabel(group, resource, 0.9);
    group.userData.animate = (time) => {
      const utilization = resource.currentUtilization || 50;
      const angle = (utilization / 100) * Math.PI * 1.5 - Math.PI * 0.75;
      needle.rotation.z = angle + Math.sin(time * 2) * 0.05;
    };
    void gauge;
    return group;
  },

  PodDisruptionBudget(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const left = extrude(group, shieldShape(0.56, 1.1), 0.22, TEAL, status, { x: -0.3, bevel: false });
    const right = extrude(group, shieldShape(0.56, 1.1), 0.22, TEAL, status, { x: 0.3, bevel: false });
    left.rotation.z = 0.08;
    right.rotation.z = -0.08;
    flatBar(group, 0.9, 0.06, 0.06, 0xffe08a, { y: 0.1, z: 0.14, castShadow: false });
    addGlow(group, TEAL, 0.55);
    addLabel(group, resource, 1.0);
    return group;
  },

  // ── Security / identity / operators ──────────────────────────────────────
  ServiceAccount(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    addPersonBadge(group, OPENSHIFT_ORANGE, status);
    addGlow(group, OPENSHIFT_RED, 0.5);
    addLabel(group, resource, 1.2);
    return group;
  },

  Role(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    extrude(group, octagonShape(0.5), 0.16, GOLD, status, { y: 0.55 });
    const star = extrude(group, starShape(0.26, 0.11, 5), 0.08, 0xffe08a, status, { y: 0.55, z: 0.14, bevel: false });
    void star;
    addGlow(group, GOLD, 0.5);
    addLabel(group, resource, 1.15);
    return group;
  },

  ClusterRole(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    extrude(group, octagonShape(0.55), 0.18, OPENSHIFT_ORANGE, status, { y: 0.6 });
    extrude(group, starShape(0.28, 0.12, 5), 0.08, 0xffe08a, status, { y: 0.6, z: 0.16, bevel: false });
    const orbit = torus(group, 0.82, 0.025, OPENSHIFT_RED, status, { y: 0.6, rx: Math.PI / 2 });
    addGlow(group, OPENSHIFT_ORANGE, 0.6);
    addLabel(group, resource, 1.2);
    group.userData.animate = (time) => {
      orbit.rotation.z = time * 0.6;
    };
    return group;
  },

  RoleBinding(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    addChainLinks(group, 2, GOLD, status);
    addGlow(group, GOLD, 0.5);
    addLabel(group, resource, 1.15);
    return group;
  },

  ClusterRoleBinding(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    addChainLinks(group, 3, OPENSHIFT_ORANGE, status);
    const orbit = torus(group, 0.8, 0.025, OPENSHIFT_RED, status, { y: 0.72, rx: Math.PI / 2 });
    addGlow(group, OPENSHIFT_ORANGE, 0.55);
    addLabel(group, resource, 1.45);
    group.userData.animate = (time) => {
      orbit.rotation.z = -time * 0.5;
    };
    return group;
  },

  SecurityContextConstraints(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const shieldGeom = new THREE.ExtrudeGeometry(shieldShape(1.1, 1.25), {
      depth: 0.3, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2,
    });
    shieldGeom.center();
    addMesh(group, shieldGeom, createStandardMaterial(OPENSHIFT_RED, status), {});
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(shieldGeom),
      new THREE.LineBasicMaterial({ color: 0xff8a80, transparent: true, opacity: 0.5 }),
    );
    group.add(edge);
    // Keyhole → pod security.
    addMesh(group, new THREE.CylinderGeometry(0.12, 0.12, 0.05, 16), new THREE.MeshStandardMaterial({
      color: 0x2b0a0a, metalness: 0.1, roughness: 0.9,
    }), { y: 0.14, z: 0.19, rx: Math.PI / 2 });
    flatBar(group, 0.08, 0.26, 0.04, 0x2b0a0a, { y: -0.06, z: 0.19, castShadow: false });
    addGlow(group, OPENSHIFT_RED, 0.55);
    addLabel(group, resource, 1.1);
    return group;
  },

  User(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    addPerson(group, { color: CYAN, headColor: LIGHT_BLUE, status });
    addGlow(group, CYAN, 0.5);
    addLabel(group, resource, 1.35);
    return group;
  },

  Group(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    addPerson(group, { x: -0.42, y: 0, z: -0.12, scale: 0.72, color: TEAL, headColor: CYAN, status });
    addPerson(group, { x: 0.42, y: 0, z: -0.12, scale: 0.72, color: TEAL, headColor: CYAN, status });
    addPerson(group, { x: 0, y: 0, z: 0.25, scale: 0.85, color: LIGHT_BLUE, headColor: WHITE, status });
    addGlow(group, CYAN, 0.55);
    addLabel(group, resource, 1.45);
    return group;
  },

  Identity(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    addPersonBadge(group, DARK_GRAY, status);
    flatBar(group, 0.36, 0.05, 0.02, OPENSHIFT_ORANGE, { y: 0.36, z: 0.08, castShadow: false });
    addGlow(group, DARK_GRAY, 0.45);
    addLabel(group, resource, 1.2);
    return group;
  },

  Subscription(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const piece = extrude(group, puzzleShape(), 0.26, OPENSHIFT_ORANGE, status, { y: 0.6 });
    piece.rotation.y = 0.4;
    const halo = torus(group, 0.62, 0.03, OPENSHIFT_RED, status, { y: 0.6, rx: Math.PI / 2 });
    addGlow(group, OPENSHIFT_ORANGE, 0.55);
    addLabel(group, resource, 1.3);
    group.userData.animate = (time) => {
      piece.rotation.y = 0.4 + Math.sin(time * 0.7) * 0.15;
      halo.rotation.z = time * 0.5;
    };
    return group;
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
  const found = Object.keys(CREATORS).find((kind) => kind.toLowerCase() === String(raw).toLowerCase());
  return found || null;
}

export class ResourceMeshFactory {
  constructor() {
    this.geometryCache = new Map();
  }

  create(resource) {
    const kind = meshKindFor(resource);
    const creator = kind ? CREATORS[kind] : null;
    const group = creator ? creator(resource) : this._createFallback(resource);
    if (group) {
      group.userData.meshKind = kind || 'Fallback';
      group.userData.resourceKind = resourceKind(resource) || kind || 'Unknown';
    }
    return group;
  }

  _createFallback(resource) {
    const status = resourceStatus(resource);
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), createStandardMaterial(GRAY, status));
    mesh.castShadow = true;
    group.add(mesh);
    addGlow(group, DARK_GRAY, 0.4);
    addLabel(group, resource, 0.8);
    return group;
  }

  updateStatus(group, status) {
    if (!group || !status) return;
    const statusColor = getStatusColor(status);
    group.traverse((child) => {
      if (!child.isMesh) return;
      if (child.userData.isLabel) return;
      if (child.userData.isGlow && child.material) {
        child.material.color.set(statusColor);
      } else if (child.material?.emissive) {
        child.material.emissive.set(statusColor);
      }
    });
  }

  dispose(group) {
    if (!group) return;
    group.traverse((child) => {
      // Labels share cached canvas textures — never dispose those.
      if (child.userData?.isLabel) return;
      if (child.geometry) child.geometry.dispose();
      const materials = Array.isArray(child.material)
        ? child.material
        : (child.material ? [child.material] : []);
      for (const material of materials) {
        if (!material) continue;
        if (material.map && !material.map.userData?.shared) material.map.dispose();
        material.dispose();
      }
    });
  }
}

export { getStatusColor as getStatusColorFor };
export default { ResourceMeshFactory, MESH_CREATOR_KINDS, MISSING_MESH_KINDS, hasMeshCreator, meshKindFor };
