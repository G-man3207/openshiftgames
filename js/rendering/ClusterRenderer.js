import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ResourceMeshFactory } from './ResourceMeshes.js';
import { ResourceLabelLayer } from './ResourceLabels.js';
import { ConnectionLineManager } from './ConnectionLines.js';
import { ParticleTrafficSystem } from './ParticleTraffic.js';
import { computeConnections } from './RelationGraph.js';
import { RESOURCE_KINDS, paletteMeta, KIND_SECTIONS } from '../data/kindRegistry.js';

/**
 * 3D CLUSTER DIORAMA — ART DIRECTION (v2)
 * =======================================================================
 * The cluster is not a game level, it is a designed diagram: a dark instrument
 * stage on which the OpenShift object model is arranged like a city plan. Legible
 * first, atmospheric second. Reference mood: a high-end systems product render —
 * quiet, precise, expensive.
 *
 * GROUND / THE STAGE
 *   • Background and floor are deep neutral charcoal-blue (#0A0C10 / #0C1016),
 *     never red-brown. The floor is a soft radial lift (#141A23 centre) that
 *     falls off to the background under fog, so the diorama floats in darkness.
 *   • Faint gridded structure only: minor grid every 2u (≈9% white-blue), major
 *     grid every 10u (≈22%), one calm centre line pair. No brand red on the floor.
 *   • Auto-align tiers read as calm rounded bands with a hairline rule and one
 *     understated floor-set section name (11-13px equivalent, +0.22em tracking,
 *     ~35% opacity) — placed on the floor, never floating pills.
 *
 * LIGHT — three-point, low ambient
 *   • Key: cool white (0xDFE9FF) from upper-front-right, the only shadow caster.
 *   • Rim: warm OpenShift-red/orange (0xFF5A3C) from behind-left, no shadows.
 *   • Fill: desaturated blue (0x4A6A9A) from front-left, low.
 *   • Hemisphere + tiny ambient keep shadows readable, never washed out.
 *   • ACES filmic tone mapping, exposure tuned so the scene has contrast without
 *     crushing blacks (see EXPOSURE). Contact shadow = one instanced radial AO
 *     plane under every model plus the key light's soft PCF shadow map.
 *   • FogExp2 tuned so the far tiers read as depth, not haze.
 *
 * MATERIALS
 *   • One family: matte micro-metal (metalness 0.34 / roughness 0.52), chamfered.
 *   • Body colour is the same charcoal family for every kind; each palette section
 *     contributes exactly one muted category accent (see ResourceMeshes HUE).
 *   • Status colour is an additive emissive ring on the pedestal only — green
 *     running / amber pending / red failed. Body forms are never status-washed.
 *   • Selection = amber ring + gentle scale; hover = cool blue ring. Nothing glows
 *     unless it means something.
 *
 * CAMERA
 *   • 3/4 aerial: azimuth ≈30° off +Z, elevation ≈41°. fitToView() computes the
 *     bounding sphere of all models and frames it inside the current canvas aspect,
 *     leaving insets for the HUD (top) and toolbar (bottom).
 *   • Launch = fitted view with an 850ms ease-out pull-in from slightly wider and
 *     higher. resetCamera() returns to the fitted view. autoAlign completion refits.
 *   • Menu showcase: ~1.24× wider framing, slow auto-orbit, gentle pointer parallax.
 *
 * MOTION
 *   • Only meaningful motion: status rings breathe slowly, a few kinds have a
 *     mechanical idle (gear, clock, gyro), selection lifts 6%. No bobbing toys.
 *   • Connection curves are dim by default, brighten for the selected/hovered
 *     object's relations. Traffic particles are small, slow and sparse.
 *
 * LABELS
 *   • HTML overlay (ResourceLabels.js): 11.5px Inter, dark scrim, status dot,
 *     priority + collision culling, distance fade, max ~26 in game / 9 in menu.
 *     Constant screen size — labels never scale into mush again.
 *
 * OWNERSHIP / PRESENTATION (v3)
 *   • "Mine": resources the player created carry one thin OpenShift-red floor ring
 *     just outside the pedestal + a very low warm underglow, breathing once every
 *     ~8s. Seeded defaults keep their status halos only. `playerCreated` is a uid
 *     Set and the treatment lives on child meshes, so it survives layout tweens,
 *     status updates and selection; it casts no shadows and adds no label boxes.
 *   • Mine-only focus (`setHighlightMine`) hides everything else and frames the
 *     player's set; "Platform" presentation (`setPlatformPresentation`) hides or
 *     dims the seeded platform defaults while the level's working set stays lit.
 *     Both are presentation-only: positions, connections, autoAlign and cluster
 *     state are untouched; hidden groups simply leave picking, labels and fit
 *     bounds (all of which already read `group.visible`).
 *   • Creation spotlight: `pulseResource` (expanding rings) and
 *     `focusResourceBriefly` (ease in/hold/return) are transient and cancelled by
 *     user camera input, a new fit, menu mode or teardown.
 */

// ── Palette / constants ──────────────────────────────────────────────────────
const BACKGROUND_COLOR = 0x080a0e;
const FOG_COLOR = 0x080a0e;
const FOG_DENSITY = 0.0045;

export const OPENSHIFT_RED = 0xee0000;
export const OPENSHIFT_ORANGE = 0xf97316;
const HIGHLIGHT_COLOR = 0x8ab4ff;
const SELECT_COLOR = 0xffa657;

const CAMERA_FOV = 42;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 500;
const BASE_AZIMUTH = 0.42; // radians off +Z (≈24°) — enough 3/4 for depth, not a diagonal sprawl
const BASE_ELEVATION = 0.68; // radians above the floor (≈39°)
const MENU_AZIMUTH = 0.72; // menu showcase: more cinematic 3/4 rotation
const MENU_ELEVATION = 0.64;

const FLOOR_RADIUS = 170;
const GRID_EXTENT = 200;
const GRID_MINOR_STEP = 2;
const GRID_MAJOR_STEP = 10;

const EXPOSURE = 1.2;
const EXPOSURE_MENU = 1.46;
const MENU_KEY_INTENSITY = 2.85;
const MENU_AMBIENT_INTENSITY = 0.62;
const BASE_KEY_INTENSITY = 2.35;
const BASE_AMBIENT_INTENSITY = 0.5;
const PIXEL_RATIO_CAP = 2;

const PROJECT_OPACITY = 0.05;

/**
 * Auto-align layout tiers, ordered back→front along +Z in OpenShift flow order:
 * Cluster/Projects → Workloads → Builds → Networking → Config/Storage →
 * Security/Identity → Scaling. Kind → tier is derived from the registry palette
 * sections (see KIND_TIER below); no hard-coded legacy-only lists.
 */
export const LAYOUT_TIERS = Object.freeze([
  { id: 'cluster', spacing: 4.0, rowSpacing: 3.0 },
  { id: 'workloads', spacing: 3.8, rowSpacing: 3.0 },
  { id: 'builds', spacing: 3.8, rowSpacing: 3.0 },
  { id: 'network', spacing: 3.8, rowSpacing: 3.0 },
  { id: 'config', spacing: 3.6, rowSpacing: 3.0 },
  { id: 'storage', spacing: 3.6, rowSpacing: 3.0 },
  { id: 'security', spacing: 3.2, rowSpacing: 2.8 },
  { id: 'identity', spacing: 3.6, rowSpacing: 3.0 },
  { id: 'scaling', spacing: 3.4, rowSpacing: 3.0 },
  { id: 'misc', spacing: 3.2, rowSpacing: 3.0 },
]);

/**
 * The auto-align layout is a compact block, not a 200-unit-wide line of specks:
 *   • each tier wraps into centred rows of at most MAX_ROW_WIDTH,
 *   • only tiers that actually contain resources occupy depth (empty tiers collapse),
 *   • tiers advance front-to-back from an overall centre so the diorama stays grouped.
 */
const MAX_ROW_WIDTH = 50;
const TIER_GAP = 1.8;
const LAYOUT_CENTER_Z = 4.5;
const TIER_BAND_DEPTH = 2.2;

const SECTION_TO_TIER = {
  projects: 'cluster',
  workloads: 'workloads',
  builds: 'builds',
  network: 'network',
  config: 'config',
  storage: 'storage',
  scaling: 'scaling',
  security: 'security',
  identity: 'identity',
};

/** kind → layout tier id, derived from the central registry. */
export const KIND_TIER = Object.freeze((() => {
  const map = {};
  for (const kind of RESOURCE_KINDS) {
    const section = paletteMeta(kind)?.section || 'projects';
    map[kind] = SECTION_TO_TIER[section] || 'misc';
  }
  return map;
})());

const TIER_SECTION = {
  cluster: 'projects',
  workloads: 'workloads',
  builds: 'builds',
  network: 'network',
  config: 'config',
  storage: 'storage',
  security: 'security',
  identity: 'identity',
  scaling: 'scaling',
  misc: null,
};

const SECTION_LABELS = Object.fromEntries(KIND_SECTIONS.map((section) => [section.id, section.label]));

/** One calm accent per auto-align tier (matches the model category accents). */
const TIER_ACCENTS = {
  cluster: 0xd85a4a,
  workloads: 0x5b83d6,
  builds: 0xd98a4a,
  network: 0x5aa7d6,
  config: 0xc2a04a,
  storage: 0x4fb47f,
  security: 0xd85a4a,
  identity: 0x3fb0aa,
  scaling: 0x9b7fd4,
  misc: 0x7285a0,
};

const PROJECT_COLORS = [
  0xee0000, 0xf97316, 0x2f81f7, 0x3fb950, 0xa371f7,
  0x39c5cf, 0xd29922, 0xf85149, 0xdb6d28, 0x8957e5,
  0xb08800, 0x5a32a3,
];

/** Known OpenShift projects get stable brand-adjacent colours. */
const NAMED_PROJECT_COLORS = {
  default: 0xee0000,
  openshift: 0xf97316,
  'openshift-config': 0xd29922,
  'openshift-operators': 0xa371f7,
  'openshift-ingress': 0x39c5cf,
  'openshift-monitoring': 0x3fb950,
  'openshift-console': 0x2f81f7,
  'openshift-authentication': 0xdb6d28,
  'openshift-image-registry': 0x8957e5,
  'openshift-marketplace': 0xb08800,
  'openshift-network-operator': 0xf85149,
  'metallb-system': 0x5a32a3,
  'kube-system': 0x39c5cf,
};

/** Hero showcase: only the most legible, story-carrying objects are shown. */
const SHOWCASE_CAP = 24;
/** Kinds that tell the application story in the hero (admin plumbing is not one). */
const SHOWCASE_APP_KINDS = new Set([
  'Deployment', 'Pod', 'Service', 'Route', 'StatefulSet', 'DaemonSet', 'ReplicaSet',
  'Job', 'CronJob', 'BuildConfig', 'Build', 'ImageStream', 'Ingress', 'ConfigMap',
  'Secret', 'PersistentVolumeClaim', 'PersistentVolume', 'NetworkPolicy',
  'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'Subscription', 'Template',
  'ResourceQuota', 'LimitRange',
]);
const SHOWCASE_PRIORITY = {
  Node: 100,
  Project: 90,
  Deployment: 80,
  Pod: 78,
  Service: 76,
  Route: 74,
  StatefulSet: 72,
  DaemonSet: 70,
  ReplicaSet: 68,
  Job: 66,
  CronJob: 64,
  BuildConfig: 62,
  ImageStream: 60,
  Ingress: 58,
  ConfigMap: 56,
  Secret: 54,
  PersistentVolumeClaim: 52,
  PersistentVolume: 50,
  NetworkPolicy: 48,
  HorizontalPodAutoscaler: 40,
  PodDisruptionBudget: 38,
  Subscription: 30,
  Template: 20,
  ResourceQuota: 18,
  LimitRange: 18,
  User: 14,
  Group: 14,
  ServiceAccount: 12,
  SecurityContextConstraints: 10,
  Role: 10,
  ClusterRole: 10,
  RoleBinding: 10,
  ClusterRoleBinding: 10,
  OAuth: 8,
  Identity: 8,
  ClusterVersion: 6,
  ClusterOperator: 5,
};

const _sharedRingGeometry = new THREE.RingGeometry(1.0, 1.14, 56);
_sharedRingGeometry.userData.shared = true;

const _sharedSelectRingGeometry = new THREE.RingGeometry(1.0, 1.16, 64);
_sharedSelectRingGeometry.userData.shared = true;

/**
 * "Yours" signature for player-created resources: one thin OpenShift-red floor
 * ring just outside the pedestal plus a warm, very low underglow. It is
 * deliberately different from the status halo (which sits inside the footprint
 * and changes colour with phase): the mine ring never changes colour, breathes
 * very slowly, casts no shadow and does not affect labels' collision boxes.
 */
const MINE_ACCENT = 0xff3529;
const MINE_RING_OPACITY = 0.34;
const MINE_POOL_OPACITY = 0.1;
const MINE_BREATH_SPEED = 0.8;
/** Seeded platform defaults that are revealed are dimmed, not hidden: they are
 *  context, not the working set. Dimming multiplies material colours so no
 *  transparency sorting / shadow changes are introduced. */
const PLATFORM_DIM_FACTOR = 0.32;
const PLATFORM_DIM_STATUS = 0.34;

const _sharedMineRingGeometry = new THREE.RingGeometry(1.0, 1.062, 72);
_sharedMineRingGeometry.userData.shared = true;
const _sharedMinePoolGeometry = new THREE.PlaneGeometry(1, 1);
_sharedMinePoolGeometry.rotateX(-Math.PI / 2);
_sharedMinePoolGeometry.userData.shared = true;

function kindOf(resource) {
  return resource?.kind || resource?.type || resource?._ref?.kind || 'Unknown';
}

function uidOf(resource) {
  return resource?.uid || resource?.metadata?.uid || resource?.id || null;
}

function nameOf(resource) {
  return resource?.metadata?.name || resource?.name || '';
}

function tierOf(kind) {
  return KIND_TIER[kind] || 'misc';
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute auto-align world positions for resources.
 * @param {Array<object>} resources
 * @returns {Map<string, {x:number,y:number,z:number}>} uid → position
 */
export function layoutTargets(resources, options = {}) {
  const {
    maxRowWidth = MAX_ROW_WIDTH,
    tierGap = TIER_GAP,
    centerZ = LAYOUT_CENTER_Z,
  } = options;
  const targets = new Map();
  const buckets = new Map(LAYOUT_TIERS.map((tier) => [tier.id, []]));

  for (const resource of resources || []) {
    const uid = uidOf(resource);
    if (!uid) continue;
    const tierId = tierOf(kindOf(resource));
    if (!buckets.has(tierId)) buckets.set(tierId, []);
    buckets.get(tierId).push(resource);
  }

  // Pass 1: sort + decide rows/columns per occupied tier.
  const plan = [];
  for (const tier of LAYOUT_TIERS) {
    const items = buckets.get(tier.id) || [];
    if (items.length === 0) continue;
    items.sort((a, b) => {
      const kindCompare = String(kindOf(a)).localeCompare(String(kindOf(b)));
      if (kindCompare !== 0) return kindCompare;
      return String(nameOf(a)).localeCompare(String(nameOf(b)));
    });
    const spacing = tier.spacing;
    const columns = Math.max(1, Math.floor(maxRowWidth / spacing) + 1);
    const rows = Math.ceil(items.length / columns);
    const rowSpacing = tier.rowSpacing || 3;
    const rowSpan = (rows - 1) * rowSpacing;
    plan.push({ tier, items, columns, rows, rowSpacing, rowSpan, depth: rowSpan + TIER_BAND_DEPTH });
  }

  // Pass 2: stack the occupied tiers back-to-front and centre the whole block.
  const totalDepth = plan.reduce((sum, entry) => sum + entry.depth, 0)
    + Math.max(0, plan.length - 1) * tierGap;
  let cursor = centerZ - totalDepth / 2;
  for (const entry of plan) {
    const centerZ = cursor + entry.depth / 2;
    const { tier, items, columns, rows, rowSpacing } = entry;
    items.forEach((resource, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const itemsInRow = Math.min(columns, items.length - row * columns);
      const totalWidth = (itemsInRow - 1) * tier.spacing;
      const startX = -totalWidth / 2;
      const zOffset = (row - (rows - 1) / 2) * rowSpacing;
      targets.set(uidOf(resource), {
        x: startX + column * tier.spacing,
        y: 0,
        z: centerZ + zOffset,
      });
    });
    cursor += entry.depth + tierGap;
  }

  return targets;
}

export class ClusterRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.resourceMeshes = new Map();
    this.projectPlanes = new Map();
    // Backwards-compatible alias (old code/minimap paths used namespacePlanes).
    this.namespacePlanes = this.projectPlanes;
    // Ownership: resources the player creates during the run (palette / oc /
    // manifests) are "mine", seeded OpenShift defaults are not. Members are uids,
    // so the marks survive layout animation, status updates and camera moves.
    this.playerCreated = new Set();
    this.highlightMine = false;
    // Presentation filter: seeded platform defaults can be hidden/dimmed while
    // the working set (level starting resources + Nodes + player creations) stays
    // legible. Hidden groups leave picking, labels and fitToView automatically
    // (everything reads group.visible), so autoAlign/connections are unaffected.
    this.platformUids = new Set();
    this.platformRevealed = true;
    this.platformDimmed = false;
    this.autoRevealUids = new Set();
    this._minePoolTexture = null;
    this._minePulses = [];
    this._focusAnimation = null;
    this.selectedResource = null;
    this.hoveredResource = null;
    this.mouse = new THREE.Vector2(-999, -999);
    this._clickStart = new THREE.Vector2();
    this._didDrag = false;
    this._dragCandidate = null;
    this.projectColorIndex = 0;
    this.running = false;
    this.frameId = null;
    this.lastFrameTime = 0;
    this.onSelect = null;
    this.onHover = null;
    this.onResourceMoved = null;
    this._draggingResource = null;
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.menuMode = false;
    this._fitDone = false;
    this._introPlayed = false;
    this._fitAnimation = null;
    this._layoutAnimation = null;
    this._lastFit = null;
    this._needsHoverPick = false;
    this._lastHoverPick = 0;
    this._parallax = { x: 0, y: 0 };
    this._parallaxTarget = { x: 0, y: 0 };
    this._parallaxHandler = null;
    this._refitTimer = null;
    this.autoRefitEnabled = true;
    this._labelContext = { menuMode: false };
    this._azimuth = BASE_AZIMUTH;
    this._elevation = BASE_ELEVATION;
    this.menuShowcaseSubset = true;
    this._showcaseApplied = false;
    this._particlesBeforeMenu = true;

    this._initScene();
    this._initCamera();
    this._initRenderer();
    this._initControls();
    this._initLights();
    this._initFloor();
    this._initGrid();
    this._initTierBands();
    this._initContactShadows();
    this._initRaycaster();
    this._initSubsystems();
    this._bindEvents();
  }

  // ── Scene / camera / renderer ────────────────────────────────────────────
  _initScene() {
    this.scene = new THREE.Scene();
    // Solid calibrated background that the floor's vignette resolves into — no
    // visible horizon arc, no dome. Depth comes from fog + light falloff.
    this.scene.background = new THREE.Color(BACKGROUND_COLOR);
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  }

  _createBackgroundTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(256, 330, 40, 256, 330, 420);
    gradient.addColorStop(0, '#0f141c');
    gradient.addColorStop(0.45, '#0b0e14');
    gradient.addColorStop(0.78, '#080a0e');
    gradient.addColorStop(1, '#06070a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 512);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  _initCamera() {
    const { width, height } = this._viewportSize();
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, width / height, CAMERA_NEAR, CAMERA_FAR);
    const dir = this._cameraDirection();
    this.camera.position.copy(dir.multiplyScalar(72)).add(new THREE.Vector3(0, 0, 5));
    this.camera.lookAt(0, 0, 5);
  }

  _cameraDirection(azimuth = this._azimuth ?? BASE_AZIMUTH, elevation = this._elevation ?? BASE_ELEVATION) {
    const cosElevation = Math.cos(elevation);
    return new THREE.Vector3(
      Math.sin(azimuth) * cosElevation,
      Math.sin(elevation),
      Math.cos(azimuth) * cosElevation,
    );
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    const { width, height } = this._viewportSize();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
    // `false` = never touch canvas CSS size; layout (fullscreen or a hero window)
    // is owned by the page, and resize() reads clientWidth/clientHeight.
    this.renderer.setSize(width, height, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.rotateSpeed = 0.65;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.7;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 220;
    this.controls.maxPolarAngle = Math.PI / 2.08;
    this.controls.minPolarAngle = 0.16;
    this.controls.autoRotateSpeed = 0.32;
    this.controls.target.set(0, 0, 5);
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.update();
  }

  // ── Lighting ─────────────────────────────────────────────────────────────
  _initLights() {
    this.ambientLight = new THREE.AmbientLight(0x2a3c55, BASE_AMBIENT_INTENSITY);
    this.scene.add(this.ambientLight);

    this.hemiLight = new THREE.HemisphereLight(0xb2c8e8, 0x0a0d12, 0.58);
    this.scene.add(this.hemiLight);

    // Key — cool, upper-front-right, sole shadow caster.
    this.keyLight = new THREE.DirectionalLight(0xe4edff, BASE_KEY_INTENSITY);
    this.keyLight.position.set(26, 46, 30);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.left = -52;
    this.keyLight.shadow.camera.right = 52;
    this.keyLight.shadow.camera.top = 52;
    this.keyLight.shadow.camera.bottom = -52;
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 140;
    this.keyLight.shadow.bias = -0.0006;
    this.keyLight.shadow.normalBias = 0.03;
    this.keyLight.target.position.set(0, 0, 5);
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    // Rim — warm OpenShift red from behind-left.
    this.rimLight = new THREE.DirectionalLight(0xff6a4a, 0.55);
    this.rimLight.position.set(-34, 22, -40);
    this.rimLight.target.position.set(0, 0, 5);
    this.scene.add(this.rimLight);
    this.scene.add(this.rimLight.target);

    // Fill — desaturated blue from the front-left, low and broad.
    this.fillLight = new THREE.DirectionalLight(0x58789f, 0.55);
    this.fillLight.position.set(-22, 14, 34);
    this.fillLight.target.position.set(0, 0, 5);
    this.scene.add(this.fillLight);
    this.scene.add(this.fillLight.target);
  }

  // ── Floor ────────────────────────────────────────────────────────────────
  _initFloor() {
    this.floorGroup = new THREE.Group();
    const texture = this._createFloorTexture();
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      metalness: 0.04,
      roughness: 0.97,
    });
    const geometry = new THREE.CircleGeometry(FLOOR_RADIUS, 96);
    const floor = new THREE.Mesh(geometry, material);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    this.floorGroup.add(floor);

    // Very faint studio light pool under the diorama.
    const poolTexture = this._createRadialTexture([
      [0, 'rgba(120,150,200,0.05)'],
      [0.55, 'rgba(80,110,160,0.025)'],
      [1, 'rgba(0,0,0,0)'],
    ]);
    const poolGeometry = new THREE.CircleGeometry(44, 64);
    const poolMaterial = new THREE.MeshBasicMaterial({
      map: poolTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pool = new THREE.Mesh(poolGeometry, poolMaterial);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.002;
    this.floorGroup.add(pool);

    this.scene.add(this.floorGroup);
  }

  _createFloorTexture() {
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.02, size / 2, size / 2, size * 0.5);
    gradient.addColorStop(0, '#19212c');
    gradient.addColorStop(0.3, '#131a23');
    gradient.addColorStop(0.58, '#0e131a');
    gradient.addColorStop(0.82, '#0a0d12');
    gradient.addColorStop(1, '#080a0e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  _createRadialTexture(stops) {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  // ── Grid ─────────────────────────────────────────────────────────────────
  _initGrid() {
    this.gridGroup = new THREE.Group();

    const half = GRID_EXTENT / 2;
    const buildLines = (step, color, opacity, y) => {
      const points = [];
      for (let value = -half; value <= half + 0.001; value += step) {
        points.push(-half, y, value, half, y, value);
        points.push(value, y, -half, value, y, half);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      const lines = new THREE.LineSegments(geometry, material);
      lines.renderOrder = 0;
      this.gridGroup.add(lines);
      return lines;
    };

    buildLines(GRID_MINOR_STEP, 0x3a506e, 0.085, 0.002);
    buildLines(GRID_MAJOR_STEP, 0x53708f, 0.2, 0.003);

    const axisGeometry = new THREE.BufferGeometry();
    axisGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -half, 0.004, 0, half, 0.004, 0,
      0, 0.004, -half, 0, 0.004, half,
    ], 3));
    const axisLines = new THREE.LineSegments(axisGeometry, new THREE.LineBasicMaterial({
      color: 0x6d8bab, transparent: true, opacity: 0.24, depthWrite: false,
    }));
    this.gridGroup.add(axisLines);

    this.scene.add(this.gridGroup);
  }

  // ── Tier bands + floor section names ─────────────────────────────────────
  _initTierBands() {
    this.tierGroup = new THREE.Group();
    this.tierBands = new Map();

    const bandTexture = this._createBandTexture();
    for (const tier of LAYOUT_TIERS) {
      const group = new THREE.Group();
      group.visible = false;

      const accent = TIER_ACCENTS[tier.id] || TIER_ACCENTS.misc;
      const fillGeometry = new THREE.PlaneGeometry(1, 1);
      const fillMaterial = new THREE.MeshBasicMaterial({
        map: bandTexture,
        color: accent,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      });
      const fill = new THREE.Mesh(fillGeometry, fillMaterial);
      fill.rotation.x = -Math.PI / 2;
      fill.renderOrder = 1;
      group.add(fill);

      const ruleGeometry = new THREE.PlaneGeometry(1, 0.035);
      const ruleMaterial = new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      const rule = new THREE.Mesh(ruleGeometry, ruleMaterial);
      rule.rotation.x = -Math.PI / 2;
      rule.renderOrder = 1;
      group.add(rule);

      const labelTexture = this._createFloorTextTexture(this._tierLabel(tier.id));
      const labelMaterial = new THREE.MeshBasicMaterial({
        map: labelTexture,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      });
      const labelGeometry = new THREE.PlaneGeometry(12.3, 1.15);
      const label = new THREE.Mesh(labelGeometry, labelMaterial);
      label.rotation.x = -Math.PI / 2;
      label.renderOrder = 2;
      group.add(label);

      group.userData.tierId = tier.id;
      this.tierGroup.add(group);
      this.tierBands.set(tier.id, { group, fill, rule, label, width: 10 });
    }
    this.scene.add(this.tierGroup);

    // Canvas-drawn floor names must use the real UI webfont; redraw once it loads.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => this._refreshFloorTextTextures()).catch(() => {});
    }
  }

  _refreshFloorTextTextures() {
    if (!this.tierBands) return;
    for (const tier of LAYOUT_TIERS) {
      const band = this.tierBands.get(tier.id);
      if (!band) continue;
      const next = this._createFloorTextTexture(this._tierLabel(tier.id));
      band.label.material.map?.dispose?.();
      band.label.material.map = next;
      band.label.material.needsUpdate = true;
    }
  }

  _tierLabel(tierId) {
    const section = TIER_SECTION[tierId];
    const label = section ? SECTION_LABELS[section] : 'Other';
    return (label || tierId).toUpperCase();
  }

  _createBandTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.22, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(0.78, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  _createFloorTextTexture(text) {
    const width = 1024;
    const height = 96;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.font = '600 40px "Schibsted Grotesk", "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(216, 230, 246, 0.96)';
    const tracking = 12;
    const chars = [...text];
    const widths = chars.map((char) => ctx.measureText(char).width);
    const totalWidth = widths.reduce((sum, value) => sum + value, 0) + tracking * (chars.length - 1);
    let x = width / 2 - totalWidth / 2;
    chars.forEach((char, index) => {
      ctx.fillText(char, x + widths[index] / 2, height / 2);
      x += widths[index] + tracking;
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.() || 1;
    return texture;
  }

  /** Recompute tier band geometry from current resource positions (layout-agnostic). */
  _refreshTierBands() {
    if (!this.tierBands) return;
    const bounds = new Map();
    for (const group of this.resourceMeshes.values()) {
      if (group.visible === false) continue;
      const kind = group.userData?.resourceKind;
      const tier = tierOf(kind);
      const footprint = group.userData?.footprint || 1.1;
      const entry = bounds.get(tier) || { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, count: 0 };
      entry.minX = Math.min(entry.minX, group.position.x - footprint);
      entry.maxX = Math.max(entry.maxX, group.position.x + footprint);
      entry.minZ = Math.min(entry.minZ, group.position.z);
      entry.maxZ = Math.max(entry.maxZ, group.position.z);
      entry.count += 1;
      bounds.set(tier, entry);
    }

    for (const tier of LAYOUT_TIERS) {
      const band = this.tierBands.get(tier.id);
      if (!band) continue;
      const entry = bounds.get(tier.id);
      if (!entry || entry.count === 0) {
        band.group.visible = false;
        continue;
      }
      band.group.visible = true;
      const width = Math.max(11, entry.maxX - entry.minX + 7);
      const centerX = (entry.minX + entry.maxX) / 2;
      const centerZ = (entry.minZ + entry.maxZ) / 2;
      const depth = Math.max(TIER_BAND_DEPTH, entry.maxZ - entry.minZ + TIER_BAND_DEPTH);
      band.width = width;
      band.depth = depth;
      band.fill.position.set(centerX, 0.006, centerZ);
      band.fill.scale.set(width, depth, 1);
      band.rule.position.set(centerX, 0.008, centerZ + depth / 2);
      band.rule.scale.set(width, 1, 1);
      band.label.position.set(centerX, 0.012, centerZ + depth / 2 + 0.92);
      band.fill.visible = true;
      band.rule.visible = true;
      band.label.visible = true;
    }
  }

  // ── Contact shadows (one instanced draw call) ────────────────────────────
  _initContactShadows() {
    this._contactDummy = new THREE.Object3D();
    this._contactTexture = this._createRadialTexture([
      [0, 'rgba(255,255,255,0.85)'],
      [0.42, 'rgba(255,255,255,0.4)'],
      [0.75, 'rgba(255,255,255,0.12)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      map: this._contactTexture,
      color: 0x000000,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
    });
    this._contactShadows = new THREE.InstancedMesh(geometry, material, 512);
    this._contactShadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._contactShadows.frustumCulled = false;
    this._contactShadows.renderOrder = 1;
    this._contactShadows.count = 0;
    this.scene.add(this._contactShadows);
  }

  _updateContactShadows() {
    const mesh = this._contactShadows;
    if (!mesh) return;
    let index = 0;
    for (const group of this.resourceMeshes.values()) {
      if (group.visible === false) continue;
      if (index >= mesh.instanceMatrix.count) break;
      const scale = Math.max(1.4, (group.userData?.footprint || 1.1) * 2.9);
      this._contactDummy.position.set(group.position.x, 0.01, group.position.z);
      this._contactDummy.scale.set(scale, 1, scale);
      this._contactDummy.rotation.set(0, 0, 0);
      this._contactDummy.updateMatrix();
      mesh.setMatrixAt(index, this._contactDummy.matrix);
      index += 1;
    }
    mesh.count = index;
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ── Subsystems ───────────────────────────────────────────────────────────
  _initRaycaster() {
    this.raycaster = new THREE.Raycaster();
    this.pickableObjects = [];
  }

  _initSubsystems() {
    this.meshFactory = new ResourceMeshFactory();
    this.particleTraffic = new ParticleTrafficSystem(this.scene);
    // Alias used by the settings panel ("particles" toggle).
    this.particleSystem = this.particleTraffic;
    this.connectionLines = new ConnectionLineManager(this.scene, this.particleTraffic);
    this.labelLayer = new ResourceLabelLayer(this);
  }

  // ── Events ───────────────────────────────────────────────────────────────
  _bindEvents() {
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onMouseLeave = () => {
      this._needsHoverPick = true;
      this._setHovered(null);
    };
    this._onResize = () => this.resize({ refit: this.menuMode });
    this._onWindowBlur = () => {
      this._draggingResource = null;
      this._dragCandidate = null;
      this.controls.enabled = !this.menuMode;
    };
    this._onWheel = () => {
      if (this._focusAnimation) this._cancelFocusAnimation(true);
    };
    this._onContextMenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      this.mouse.y = -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersects = this.raycaster.intersectObjects(this.pickableObjects, true);
      if (intersects.length > 0) {
        let target = intersects[0].object;
        while (target.parent && !target.userData.resourceId) target = target.parent;
        if (target.userData.resourceId && window.game?.engine) {
          window.game.engine.emit('resource:contextmenu', {
            uid: target.userData.resourceId,
            x: event.clientX,
            y: event.clientY,
          });
        }
      }
    };

    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    this.canvas.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('mouseleave', this._onMouseLeave);
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('resize', this._onResize);
    window.addEventListener('blur', this._onWindowBlur);

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (this.menuMode) this.resize({ refit: true });
        else this.resize();
      });
      this._resizeObserver.observe(this.canvas);
    }
  }

  _handleMouseMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;

    if (this._draggingResource) {
      const pos = this._raycastGround(this.mouse);
      if (pos) {
        const group = this.resourceMeshes.get(this._draggingResource);
        if (group) {
          group.position.x = pos.x;
          group.position.z = pos.z;
          this.connectionLines.updatePositions(this.resourceMeshes);
          this._refreshTierBands();
        }
      }
      return;
    }

    const dx = event.clientX - this._clickStart.x;
    const dy = event.clientY - this._clickStart.y;
    if (Math.sqrt(dx * dx + dy * dy) > 4) {
      if (this._dragCandidate && !this._didDrag) {
        this._draggingResource = this._dragCandidate;
        this._dragCandidate = null;
        this.controls.enabled = false;
        this.canvas.style.cursor = 'grabbing';
      }
      this._didDrag = true;
    }

    if (!this.menuMode) this._needsHoverPick = true;
  }

  _handleMouseDown(event) {
    if (event.button !== 0 || this.menuMode) return;
    if (this._focusAnimation) this._cancelFocusAnimation(true);
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    this._clickStart.set(event.clientX, event.clientY);
    this._didDrag = false;
    this._dragCandidate = null;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.pickableObjects, true);
    if (intersects.length > 0) {
      let target = intersects[0].object;
      while (target.parent && !target.userData.resourceId) target = target.parent;
      if (target.userData.resourceId) this._dragCandidate = target.userData.resourceId;
    }
  }

  _handleMouseUp(event) {
    if (this._draggingResource) {
      const resourceId = this._draggingResource;
      this._draggingResource = null;
      this.controls.enabled = !this.menuMode;
      this.canvas.style.cursor = 'default';
      const group = this.resourceMeshes.get(resourceId);
      if (group && this.onResourceMoved) {
        this.onResourceMoved(resourceId, { x: group.position.x, y: 0, z: group.position.z });
      }
      this._didDrag = false;
      this._refreshTierBands();
      return;
    }

    if (event.button === 0 && !this._didDrag) this._performPick(true);
    this._didDrag = false;
    this._dragCandidate = null;
  }

  _performPick(isClick) {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.pickableObjects, true);

    if (intersects.length > 0) {
      let target = intersects[0].object;
      while (target.parent && !target.userData.resourceId) target = target.parent;
      if (target.userData.resourceId) {
        if (isClick) this._setSelected(target.userData.resourceId);
        else this._setHovered(target.userData.resourceId);
        return;
      }
    }

    if (isClick) this._setSelected(null);
    else this._setHovered(null);
  }

  // ── Selection / hover ────────────────────────────────────────────────────
  _setSelected(resourceId) {
    if (this.selectedResource === resourceId) return;

    if (this.selectedResource) {
      const previous = this.resourceMeshes.get(this.selectedResource);
      if (previous) this._setGroupEmphasis(previous, previous.userData.resourceId === this.hoveredResource ? 'hovered' : 'default');
    }

    this.selectedResource = resourceId;

    if (resourceId) {
      const group = this.resourceMeshes.get(resourceId);
      if (group) this._setGroupEmphasis(group, 'selected');
      this.connectionLines?.highlightConnectionsForResource?.(resourceId);
    } else {
      this.connectionLines?.resetHighlight?.();
    }

    if (this.onSelect) this.onSelect(resourceId);
  }

  _setHovered(resourceId) {
    if (this.menuMode) resourceId = null;
    if (this.hoveredResource === resourceId) return;

    if (this.hoveredResource && this.hoveredResource !== this.selectedResource) {
      const previous = this.resourceMeshes.get(this.hoveredResource);
      if (previous) this._setGroupEmphasis(previous, 'default');
    }

    this.hoveredResource = resourceId;
    this.canvas.style.cursor = resourceId ? 'pointer' : 'default';

    if (resourceId && resourceId !== this.selectedResource) {
      const group = this.resourceMeshes.get(resourceId);
      if (group) this._setGroupEmphasis(group, 'hovered');
    }

    if (this.onHover) this.onHover(resourceId);
  }

  /** Visual emphasis for hover/selection: glow ring + scale, never a material wash. */
  _setGroupEmphasis(group, effect) {
    if (!group) return;
    const ring = group.userData.selectRing;
    if (ring) {
      if (effect === 'selected') {
        ring.visible = true;
        ring.material.color.set(SELECT_COLOR);
        ring.material.opacity = 0.9;
      } else if (effect === 'hovered') {
        ring.visible = true;
        ring.material.color.set(HIGHLIGHT_COLOR);
        ring.material.opacity = 0.55;
      } else {
        ring.visible = false;
        ring.material.opacity = 0;
      }
    }
    group.userData.targetScale = effect === 'selected' ? 1.08 : effect === 'hovered' ? 1.04 : 1;
    const statusMaterial = group.userData.statusMaterial;
    if (statusMaterial) {
      statusMaterial.opacity = (group.userData.statusBaseOpacity ?? 0.5) * (effect === 'default' ? 1 : 1.4);
    }
  }

  /** Legacy entry point used by draw.html. */
  _applyMeshEffect(group, effect) {
    this._setGroupEmphasis(group, effect || 'default');
  }

  deselectAll() {
    this._setSelected(null);
    this._setHovered(null);
  }

  // ── Ownership ("mine") ───────────────────────────────────────────────────
  /**
   * Mark a resource uid as player-created ("yours"). Safe to call before the
   * mesh exists (launchGame re-adds renderables from a snapshot); the visual is
   * applied when addResource() runs. The treatment is a persistent thin red
   * ring + warm underglow at pedestal level — no shadows, no label boxes.
   * @param {string} uid
   * @returns {boolean} true when the uid was newly marked
   */
  markPlayerCreated(uid) {
    if (!uid) return false;
    const isNew = !this.playerCreated.has(uid);
    this.playerCreated.add(uid);
    const group = this.resourceMeshes.get(uid);
    if (group) this._applyOwnershipVisual(group, true);
    if (isNew && this.highlightMine) {
      this._rebuildPickableList();
      this._updateContactShadows();
    }
    return isNew;
  }

  /**
   * Remove the "yours" treatment for one uid (e.g. the resource was deleted).
   * @param {string} uid
   */
  unmarkPlayerCreated(uid) {
    if (!uid || !this.playerCreated.has(uid)) return;
    this.playerCreated.delete(uid);
    const group = this.resourceMeshes.get(uid);
    if (group) this._applyOwnershipVisual(group, false);
    if (this.highlightMine) {
      this._rebuildPickableList();
      this._updateContactShadows();
    }
  }

  /** Drop every ownership mark (cluster reset / returning to the start page). */
  clearPlayerCreated() {
    for (const uid of [...this.playerCreated]) {
      const group = this.resourceMeshes.get(uid);
      if (group) this._applyOwnershipVisual(group, false);
    }
    this.playerCreated.clear();
    this._clearMinePulses();
    if (this.highlightMine) this._applyMineEmphasis({ fit: false });
  }

  /**
   * Replace the whole ownership set in one call (used by ResourceSpotlight when
   * re-syncing after a reset).
   * @param {Iterable<string>} uids
   */
  setPlayerCreated(uids) {
    const next = new Set(uids || []);
    for (const uid of [...this.playerCreated]) {
      if (!next.has(uid)) this.unmarkPlayerCreated(uid);
    }
    for (const uid of next) this.markPlayerCreated(uid);
  }

  /** @param {string} uid @returns {boolean} */
  isPlayerCreated(uid) {
    return Boolean(uid && this.playerCreated.has(uid));
  }

  /** @returns {string[]} */
  getPlayerCreatedUids() {
    return [...this.playerCreated];
  }

  /**
   * Focus mode: keep the player's resources lit while the seeded defaults are
   * hidden (calm "only what I made" stage) and frame the camera on them. Turning
   * it off restores every object and the full view.
   * @param {boolean} enabled
   * @param {{fit?:boolean}} [options]
   * @returns {boolean} the resulting mode
   */
  setHighlightMine(enabled, options = {}) {
    const next = Boolean(enabled) && !this.menuMode;
    const changed = this.highlightMine !== next;
    this.highlightMine = next;
    this._applyMineEmphasis({ fit: changed && options.fit !== false });
    return this.highlightMine;
  }

  /** Frame only the player-created resources (falls back to false when none). */
  framePlayerCreated(options = {}) {
    if (this.menuMode) return false;
    const mineVisible = [...this.playerCreated].some((uid) => {
      const group = this.resourceMeshes.get(uid);
      return group && group.visible !== false;
    });
    if (!mineVisible) return false;
    return this.fitToView({
      animate: true,
      duration: 760,
      padding: 1.24,
      minDistance: 18,
      ...options,
      filter: (group) => this.playerCreated.has(group.userData.resourceId),
    });
  }

  /** Apply/remove the persistent "yours" visual on a resource group. */
  _applyOwnershipVisual(group, mine) {
    if (!group) return;
    group.userData.isMine = Boolean(mine);
    if (mine) {
      this._ensureMineAccent(group);
      if (group.userData.mineRing) group.userData.mineRing.visible = true;
      if (group.userData.minePool) group.userData.minePool.visible = true;
      if (this.highlightMine) group.visible = true;
    } else {
      this._removeMineAccent(group);
      if (this.highlightMine) group.visible = false;
    }
  }

  _ensureMinePoolTexture() {
    if (!this._minePoolTexture) {
      this._minePoolTexture = this._createRadialTexture([
        [0, 'rgba(255,255,255,0.92)'],
        [0.42, 'rgba(255,255,255,0.34)'],
        [0.78, 'rgba(255,255,255,0.08)'],
        [1, 'rgba(255,255,255,0)'],
      ]);
      this._minePoolTexture.userData.shared = true;
    }
    return this._minePoolTexture;
  }

  /** Lazily add the ring + underglow children to a marked group. */
  _ensureMineAccent(group) {
    if (!group || group.userData.mineRing) return;
    const footprint = group.userData?.footprint || 1.1;

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: MINE_ACCENT,
      transparent: true,
      opacity: MINE_RING_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(_sharedMineRingGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.017;
    ring.scale.setScalar(footprint * 1.2);
    ring.renderOrder = 3;
    ring.castShadow = false;
    ring.receiveShadow = false;
    ring.userData.isGlow = true;
    ring.userData.noPick = true;
    group.add(ring);

    const poolMaterial = new THREE.MeshBasicMaterial({
      map: this._ensureMinePoolTexture(),
      color: MINE_ACCENT,
      transparent: true,
      opacity: MINE_POOL_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pool = new THREE.Mesh(_sharedMinePoolGeometry, poolMaterial);
    pool.position.y = 0.006;
    pool.scale.setScalar(footprint * 4.6);
    pool.renderOrder = 2;
    pool.castShadow = false;
    pool.receiveShadow = false;
    pool.userData.isGlow = true;
    pool.userData.noPick = true;
    group.add(pool);

    group.userData.mineRing = ring;
    group.userData.minePool = pool;
    group.userData.minePhase = ((group.position.x * 12.9898 + group.position.z * 78.233) % (Math.PI * 2)) || 0;
  }

  _removeMineAccent(group) {
    if (!group) return;
    for (const key of ['mineRing', 'minePool']) {
      const mesh = group.userData[key];
      if (!mesh) continue;
      group.remove(mesh);
      mesh.material?.dispose?.();
      group.userData[key] = null;
    }
  }

  // ── Presentation filter (working set vs seeded platform) ─────────────────
  /**
   * Configure the working-set presentation.
   *
   * @param {{uids?:Iterable<string>, revealed?:boolean, dim?:boolean,
   *          autoReveal?:Iterable<string>}} [state]
   *   uids       — seeded platform defaults (everything not in the working set)
   *   revealed   — show platform defaults at all (false = working set only)
   *   dim        — draw revealed platform defaults dimmed (clean-lab sessions)
   *   autoReveal — platform uids that must stay visible because the current
   *                objective or an active incident refers to them
   * @param {{fit?:boolean}} [options] fit the camera after applying
   */
  setPlatformPresentation(state = {}, options = {}) {
    if (state.uids !== undefined) this.platformUids = new Set(state.uids || []);
    if (state.revealed !== undefined) this.platformRevealed = Boolean(state.revealed);
    if (state.dim !== undefined) this.platformDimmed = Boolean(state.dim);
    if (state.autoReveal !== undefined) this.autoRevealUids = new Set(state.autoReveal || []);
    this._applyPresentation({ fit: options.fit === true });
  }

  /** Drop the presentation filter and show the full diorama (start-page hero). */
  clearPlatformPresentation() {
    this.platformUids = new Set();
    this.platformRevealed = true;
    this.platformDimmed = false;
    this.autoRevealUids = new Set();
    this._applyPresentation({ fit: false });
  }

  /** @returns {string[]} */
  getPlatformUids() {
    return [...this.platformUids];
  }

  /** @param {string} uid @returns {boolean} */
  isPlatformResource(uid) {
    return Boolean(uid && this.platformUids.has(uid));
  }

  /** @returns {boolean} */
  isPlatformRevealed() {
    return this.platformRevealed;
  }

  /**
   * One place that derives visibility/dim for every group. Precedence:
   *   menu showcase > Mine-only emphasis > platform filter.
   * Hidden groups are excluded from picking (rebuilt), labels (they skip
   * hidden groups), camera fit and tier bands because everything reads
   * `group.visible`. Positions, connections and layout are untouched.
   */
  _applyPresentation({ fit = false } = {}) {
    for (const [id, group] of this.resourceMeshes) {
      if (this.menuMode) {
        this._setGroupDim(group, false);
        continue;
      }
      const placement = this._computeGroupPresentation(id);
      group.visible = placement.visible;
      this._setGroupDim(group, placement.dimmed);
    }

    if (!this.menuMode) {
      const visible = (uid) => {
        const group = this.resourceMeshes.get(uid);
        return Boolean(group && group.visible !== false);
      };
      if (this.selectedResource && !visible(this.selectedResource)) this._setSelected(null);
      if (this.hoveredResource && !visible(this.hoveredResource)) this._setHovered(null);
    }

    this._rebuildPickableList();
    this.connectionLines?.updatePositions?.(this.resourceMeshes);
    this._refreshTierBands();
    this._updateContactShadows();
    if (!fit || this.menuMode) return;
    if (this.highlightMine) this.framePlayerCreated({ animate: true, duration: 720 });
    else this.fitToView({ animate: true, duration: 640 });
  }

  /** @param {string} id @returns {{visible:boolean, dimmed:boolean}} */
  _computeGroupPresentation(id) {
    const isMine = this.playerCreated.has(id);
    const isPlatform = this.platformUids.has(id);
    const autoRevealed = this.autoRevealUids.has(id);
    let visible = true;
    if (this.highlightMine) visible = isMine;
    else if (isPlatform && !this.platformRevealed && !autoRevealed) visible = false;
    const dimmed = visible && isPlatform && this.platformDimmed && !this.highlightMine;
    return { visible, dimmed };
  }

  /** Apply the presentation to one group (used by addResource). */
  _applyGroupPresentation(group) {
    if (!group) return;
    const id = group.userData?.resourceId;
    if (this.menuMode) {
      this._setGroupDim(group, false);
      return;
    }
    const { visible, dimmed } = this._computeGroupPresentation(id);
    group.visible = visible;
    this._setGroupDim(group, dimmed);
  }

  /**
   * Dim/un-dim a group by multiplying its material colours (no transparency
   * flag flips, no shadow changes). Originals are kept on the materials so the
   * operation is idempotent and reversible.
   */
  _setGroupDim(group, dimmed) {
    if (!group) return;
    const next = Boolean(dimmed);
    if (Boolean(group.userData.dimmed) === next) return;
    group.userData.dimmed = next;
    if (next) {
      const touched = [];
      group.traverse((child) => {
        if (!child.isMesh) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if (!material || !material.color) continue;
          if (material.userData?._platformDim) continue;
          material.userData = material.userData || {};
          material.userData._platformDim = {
            color: material.color.getHex(),
            emissive: material.emissive?.getHex?.(),
            emissiveIntensity: material.emissiveIntensity,
          };
          material.color.multiplyScalar(PLATFORM_DIM_FACTOR);
          if (material.emissive) material.emissive.multiplyScalar(0.35);
          touched.push(material);
        }
      });
      group.userData._dimMaterials = touched;
    } else {
      for (const material of group.userData._dimMaterials || []) {
        const backup = material.userData?._platformDim;
        if (!backup) continue;
        material.color.setHex(backup.color);
        if (material.emissive && backup.emissive !== undefined) material.emissive.setHex(backup.emissive);
        if (backup.emissiveIntensity !== undefined) material.emissiveIntensity = backup.emissiveIntensity;
        delete material.userData._platformDim;
      }
      group.userData._dimMaterials = [];
    }
  }

  /** @deprecated alias kept for the Mine toggle; now shared with the filter. */
  _applyMineEmphasis({ fit = false } = {}) {
    this._applyPresentation({ fit });
  }

  // ── Creation spotlight ───────────────────────────────────────────────────
  /**
   * One-shot expanding-ring pulse on a resource so a newcomer can see where a
   * freshly created object landed. Uses shared geometry and a short-lived
   * material; no shadows and nothing persists after the pulse.
   * @param {string} uid
   * @param {{duration?:number, rings?:number, delay?:number}} [options]
   * @returns {boolean}
   */
  pulseResource(uid, options = {}) {
    const group = this.resourceMeshes.get(uid);
    if (!group || !this.running || group.visible === false) return false;
    const { duration = 2200, rings = 2, delay = 0 } = options;
    const base = Math.max(1.2, (group.userData?.footprint || 1.1) * 1.45);
    const pulse = { uid, group, start: performance.now() + delay, duration, rings: [] };
    for (let index = 0; index < rings; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: MINE_ACCENT,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(_sharedMineRingGeometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.019 + index * 0.0005;
      mesh.scale.setScalar(base);
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.isGlow = true;
      mesh.userData.noPick = true;
      group.add(mesh);
      pulse.rings.push({ mesh, material, base, delay: index * 240 });
    }
    this._minePulses.push(pulse);
    return true;
  }

  _updateMinePulses(now) {
    if (!this._minePulses.length) return;
    for (let index = this._minePulses.length - 1; index >= 0; index -= 1) {
      const pulse = this._minePulses[index];
      const elapsed = now - pulse.start;
      let alive = elapsed < pulse.duration;
      for (const ring of pulse.rings) {
        const t = (elapsed - ring.delay) / 1000;
        if (t < 0) {
          ring.mesh.visible = false;
          alive = true;
          continue;
        }
        if (t >= 1) {
          ring.mesh.visible = false;
          continue;
        }
        alive = true;
        const ease = 1 - Math.pow(1 - t, 3);
        ring.mesh.visible = true;
        ring.mesh.scale.setScalar(ring.base * (1 + ease * 1.7));
        ring.material.opacity = 0.62 * Math.pow(1 - t, 2);
      }
      if (!alive) {
        this._disposePulse(pulse);
        this._minePulses.splice(index, 1);
      }
    }
  }

  _disposePulse(pulse) {
    for (const ring of pulse.rings || []) {
      ring.mesh.parent?.remove(ring.mesh);
      ring.material?.dispose?.();
    }
  }

  _clearMinePulses() {
    for (const pulse of this._minePulses) this._disposePulse(pulse);
    this._minePulses = [];
  }

  /**
   * Brief, calm camera acknowledgment: ease in toward a freshly created object,
   * hold for a beat, then return to the exact previous view. Cancelled by any
   * user canvas interaction or by a new fit. No-op in menu/showcase mode.
   * @param {string} uid
   * @param {{duration?:number, hold?:number, returnDuration?:number}} [options]
   * @returns {boolean}
   */
  focusResourceBriefly(uid, options = {}) {
    if (this.menuMode || !this.camera) return false;
    const group = this.resourceMeshes.get(uid);
    if (!group || group.visible === false) return false;
    if (this._focusAnimation) this._cancelFocusAnimation(false);

    const { duration = 520, hold = 700, returnDuration = 760 } = options;
    const savedPosition = this.camera.position.clone();
    const savedTarget = this.controls.target.clone();
    const offset = savedPosition.clone().sub(savedTarget);
    const currentDistance = Math.max(this.controls.minDistance || 6, offset.length());
    const direction = offset.normalize();

    const height = group.userData?.height || 1.8;
    const footprint = group.userData?.footprint || 1.1;
    const focusTarget = new THREE.Vector3(
      group.position.x,
      Math.max(0.25, height * 0.35),
      group.position.z,
    );
    // Gentle acknowledgement, not a jump cut: ~1/3 closer than the fitted view,
    // and never closer than a comfortable read distance.
    const framedDistance = clamp(Math.max(footprint * 9, 18), 14, 30);
    const endDistance = Math.min(currentDistance, framedDistance);
    const endPosition = focusTarget.clone().addScaledVector(direction, endDistance);

    const animation = {
      id: null,
      phase: 'in',
      phaseStart: performance.now(),
      duration: Math.max(1, duration),
      hold: Math.max(0, hold),
      returnDuration: Math.max(1, returnDuration),
      savedPosition,
      savedTarget,
      endPosition,
      endTarget: focusTarget,
    };
    this._focusAnimation = animation;
    this.controls.enabled = false;

    const step = () => {
      const active = this._focusAnimation;
      if (!active) return;
      const now = performance.now();
      if (active.phase === 'in') {
        const t = Math.min(1, (now - active.phaseStart) / active.duration);
        const ease = easeOutCubic(t);
        this.camera.position.lerpVectors(active.savedPosition, active.endPosition, ease);
        this.controls.target.lerpVectors(active.savedTarget, active.endTarget, ease);
        if (t >= 1) {
          active.phase = 'hold';
          active.phaseStart = now;
        }
      } else if (active.phase === 'hold') {
        if (now - active.phaseStart >= active.hold) {
          active.phase = 'out';
          active.phaseStart = now;
          active.holdPosition = this.camera.position.clone();
          active.holdTarget = this.controls.target.clone();
        }
      } else {
        const t = Math.min(1, (now - active.phaseStart) / active.returnDuration);
        const ease = easeOutCubic(t);
        this.camera.position.lerpVectors(active.holdPosition, active.savedPosition, ease);
        this.controls.target.lerpVectors(active.holdTarget, active.savedTarget, ease);
        if (t >= 1) {
          this._focusAnimation = null;
          this.controls.enabled = !this.menuMode;
          this.controls.update();
          return;
        }
      }
      this.camera.lookAt(this.controls.target);
      active.id = requestAnimationFrame(step);
    };
    animation.id = requestAnimationFrame(step);
    return true;
  }

  _cancelFocusAnimation(restore = false) {
    const animation = this._focusAnimation;
    if (!animation) return false;
    if (animation.id) cancelAnimationFrame(animation.id);
    this._focusAnimation = null;
    if (restore) {
      this.camera.position.copy(animation.savedPosition);
      this.controls.target.copy(animation.savedTarget);
      this.camera.lookAt(this.controls.target);
    }
    this.controls.enabled = !this.menuMode;
    this.controls.update();
    return true;
  }

  // ── Resource lifecycle ───────────────────────────────────────────────────
  /**
   * @param {{id:string, kind?:string, type?:string, name?:string, namespace?:string,
   *          status?:string, x?:number, y?:number, z?:number, _ref?:object}} resource
   */
  addResource(resource) {
    const id = resource.id || uidOf(resource._ref) || uidOf(resource);
    if (!id || this.resourceMeshes.has(id)) return;

    const kind = kindOf(resource);
    const normalized = { ...resource, id, kind };
    const group = this.meshFactory.create(normalized);
    if (!group) return;

    group.userData.resourceId = id;
    group.userData.resourceType = kind;
    group.userData.resourceKind = kind;
    group.userData.resourceNamespace = normalized.namespace || normalized._ref?.metadata?.namespace || '';
    group.position.set(resource.x || 0, resource.y || 0, resource.z || 0);

    group.traverse((child) => {
      if (child.isMesh) {
        child.userData.resourceId = id;
        if (child.userData.isGlow) child.castShadow = false;
        child.receiveShadow = true;
      }
    });

    // Hover/selection glow ring under the model.
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLOR,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(_sharedSelectRingGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.014;
    ring.scale.setScalar(Math.max(1.1, (group.userData.footprint || 1) * 1.5));
    ring.visible = false;
    ring.userData.isGlow = true;
    ring.userData.noPick = true;
    group.userData.selectRing = ring;
    group.add(ring);

    this.scene.add(group);
    this.resourceMeshes.set(id, group);

    // Player-created resources carry the persistent "yours" signature. The uid
    // may already be marked before the mesh exists (launchGame re-adds meshes
    // from a cluster snapshot without events), hence the set lookup here.
    const mine = resource.playerCreated === true || this.playerCreated.has(id);
    if (resource.playerCreated === true) this.playerCreated.add(id);
    if (mine) this._applyOwnershipVisual(group, true);
    if (this.menuMode) group.visible = true;
    else this._applyGroupPresentation(group);

    this._rebuildPickableList();
    this._refreshTierBands();
    this._updateContactShadows();

    const namespace = resource.namespace || resource._ref?.metadata?.namespace;
    if (namespace && kind !== 'Project') this._ensureProjectPlane(namespace);

    // New resources (controllers, oc new-app, palette) can appear after the launch
    // fit at spiral positions outside the framed box. Re-fit shortly after they land.
    this._scheduleRefit();
  }

  removeResource(resourceId) {
    const group = this.resourceMeshes.get(resourceId);
    if (!group) return;

    this.scene.remove(group);
    this.meshFactory.dispose(group);

    this.resourceMeshes.delete(resourceId);
    this.playerCreated.delete(resourceId);
    this._rebuildPickableList();
    this._refreshTierBands();
    this._updateContactShadows();

    if (this.selectedResource === resourceId) this._setSelected(null);
    if (this.hoveredResource === resourceId) this._setHovered(null);
    this._scheduleRefit();
  }

  /** Debounced refit so late-arriving resources never sit outside the frame. */
  _scheduleRefit() {
    if (!this.autoRefitEnabled || this.menuMode || !this.running) return;
    if (this._refitTimer) clearTimeout(this._refitTimer);
    this._refitTimer = setTimeout(() => {
      this._refitTimer = null;
      if (!this.running || this.menuMode) return;
      this.fitToView({ animate: true, duration: 620 });
    }, 420);
  }

  updateResource(resource) {
    const id = resource.id || uidOf(resource._ref) || uidOf(resource);
    const group = this.resourceMeshes.get(id);
    if (!group) return;

    if (resource.x !== undefined) group.position.x = resource.x;
    if (resource.y !== undefined) group.position.y = resource.y;
    if (resource.z !== undefined) group.position.z = resource.z;

    const status = typeof resource.status === 'string'
      ? resource.status
      : (resource.status?.phase || resource._ref?.status?.phase);
    if (status) {
      this.meshFactory.updateStatus(group, status);
      group.userData.status = status;
    }
  }

  _rebuildPickableList() {
    this.pickableObjects = [];
    for (const group of this.resourceMeshes.values()) {
      if (group.visible === false) continue;
      group.traverse((child) => {
        if (!child.isMesh) return;
        if (child.userData.isLabel || child.userData.noPick) return;
        this.pickableObjects.push(child);
      });
    }
  }

  // ── Project zones (API compatibility; drawn only when bounds are supplied) ─
  _projectColor(project) {
    if (NAMED_PROJECT_COLORS[project] !== undefined) return NAMED_PROJECT_COLORS[project];
    let hash = 0;
    for (let i = 0; i < project.length; i++) hash = (hash * 31 + project.charCodeAt(i)) | 0;
    return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
  }

  _ensureProjectPlane(project) {
    if (this.projectPlanes.has(project)) return;

    const color = this._projectColor(project);
    const planeGeometry = new THREE.PlaneGeometry(6, 6);
    const planeMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: PROJECT_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.01;
    plane.visible = false;
    plane.userData.isProjectPlane = true;

    this.scene.add(plane);
    this.projectPlanes.set(project, { mesh: plane, color });
  }

  /** @deprecated kept for old callers; use _ensureProjectPlane. */
  _ensureNamespacePlane(namespace) {
    return this._ensureProjectPlane(namespace);
  }

  updateProjectBounds(project, bounds) {
    const entry = this.projectPlanes.get(project);
    if (!entry) return;

    const width = Math.max(1, bounds.maxX - bounds.minX + 4);
    const depth = Math.max(1, bounds.maxZ - bounds.minZ + 4);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;

    entry.mesh.geometry.dispose();
    entry.mesh.geometry = new THREE.PlaneGeometry(width, depth);
    entry.mesh.position.set(centerX, -0.01, centerZ);
    entry.mesh.visible = true;
  }

  /** @deprecated kept for old callers; use updateProjectBounds. */
  updateNamespaceBounds(namespace, bounds) {
    return this.updateProjectBounds(namespace, bounds);
  }

  // ── Connections / traffic ────────────────────────────────────────────────
  addConnection(connection) {
    this.connectionLines.addConnection(connection, this.resourceMeshes);
  }

  removeConnection(connectionId) {
    this.connectionLines.removeConnection(connectionId);
  }

  updateConnections() {
    this.connectionLines.updatePositions(this.resourceMeshes);
  }

  addTrafficRoute(route) {
    this.particleTraffic.addRoute(route);
  }

  removeTrafficRoute(routeId) {
    this.particleTraffic.removeRoute(routeId);
  }

  setParticlesEnabled(enabled) {
    this.particleTraffic.setEnabled(enabled);
  }

  /**
   * Recompute and draw all relationship edges (Route→Service→Deployment,
   * BuildConfig→ImageStream→Deployment, SCC→ServiceAccount/Pod, Project containment,
   * RBAC/storage/config/operator edges + ownership) from live cluster state.
   */
  syncConnectionsFromCluster(clusterState, options = {}) {
    if (!clusterState) return new Map();
    const connections = computeConnections(clusterState, options);
    this.connectionLines.sync(connections, this.resourceMeshes);
    return connections;
  }

  // ── Layout ───────────────────────────────────────────────────────────────
  /**
   * Auto-align all resources into the OpenShift flow tiers, then refit the camera.
   * @param {object} clusterState
   * @param {{duration?:number, filter?:(resource)=>boolean, fit?:boolean}} [options]
   */
  autoAlign(clusterState, options = {}) {
    if (!clusterState) return new Map();
    const { duration = 800, filter = null, fit = true } = options;
    const all = typeof clusterState.getAllResources === 'function'
      ? clusterState.getAllResources()
      : Array.from(clusterState.resources?.values?.() || []);
    const resources = filter ? all.filter(filter) : all;
    const targets = layoutTargets(resources);
    const intro = duration > 0 && !this._introPlayed && !this.menuMode;
    this.animateToPositions(targets, duration, { fit, intro });
    if (duration <= 0 && fit) this.fitToView({ animate: false });
    return targets;
  }

  animateToPositions(targets, duration = 800, options = {}) {
    const { fit = true, intro = false } = options;
    const startTime = performance.now();
    const startPositions = new Map();

    for (const [uid] of targets) {
      const group = this.resourceMeshes.get(uid);
      if (group) {
        startPositions.set(uid, {
          x: group.position.x,
          y: group.position.y,
          z: group.position.z,
        });
      }
    }

    if (this._layoutAnimation) cancelAnimationFrame(this._layoutAnimation.id);
    const animation = { id: null };
    this._layoutAnimation = animation;

    const apply = (ease) => {
      for (const [uid, target] of targets) {
        const group = this.resourceMeshes.get(uid);
        const start = startPositions.get(uid);
        if (!group || !start) continue;
        group.position.x = start.x + (target.x - start.x) * ease;
        group.position.y = start.y + (target.y - start.y) * ease;
        group.position.z = start.z + (target.z - start.z) * ease;
      }
      this.connectionLines.updatePositions(this.resourceMeshes);
      this._updateContactShadows();
    };

    if (duration <= 0) {
      apply(1);
      this._layoutAnimation = null;
      this._refreshTierBands();
      if (fit) this.fitToView({ animate: false });
      return;
    }

    const step = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      apply(ease);
      if (t < 1) {
        animation.id = requestAnimationFrame(step);
      } else {
        this._layoutAnimation = null;
        this._refreshTierBands();
        if (fit) {
          this.fitToView({ animate: true, duration: 820, intro });
        }
      }
    };
    animation.id = requestAnimationFrame(step);
  }

  syncWithState(clusterState) {
    if (!clusterState) return;

    const currentIds = new Set(this.resourceMeshes.keys());
    const stateIds = new Set();

    const resources = typeof clusterState.getAllResources === 'function'
      ? clusterState.getAllResources()
      : Array.from(clusterState.resources?.values?.() || []);

    // New resources enter at their auto-align slot instead of piling at the origin
    // (important for the start-page showcase, which seeds before launching a mode).
    const targets = layoutTargets(resources);

    for (const resource of resources) {
      const uid = uidOf(resource);
      if (!uid) continue;
      stateIds.add(uid);
      if (currentIds.has(uid)) {
        const existing = this.resourceMeshes.get(uid);
        this.updateResource({
          id: uid,
          status: resource.status?.phase || resource.status,
          x: existing?.position.x,
          y: existing?.position.y,
          z: existing?.position.z,
        });
      } else {
        const target = targets.get(uid) || { x: 0, y: 0, z: 0 };
        this.addResource({
          ...resource,
          id: uid,
          x: resource.x ?? target.x,
          y: resource.y ?? target.y,
          z: resource.z ?? target.z,
        });
      }
    }

    for (const id of currentIds) {
      if (!stateIds.has(id)) this.removeResource(id);
    }

    if (clusterState.connections) {
      this.connectionLines.sync(clusterState.connections, this.resourceMeshes);
    } else {
      this.syncConnectionsFromCluster(clusterState);
    }

    if (clusterState.trafficRoutes) {
      this.particleTraffic.syncRoutes(clusterState.trafficRoutes);
    }

    this._refreshTierBands();
  }

  // ── Camera framing ───────────────────────────────────────────────────────
  /** Width of the left UI dock that overlays the canvas (0 when hidden). */
  _uiLeftInset() {
    if (this.menuMode || typeof document === 'undefined') return 0;
    const { width } = this._viewportSize();
    let inset = 0;
    const rightOf = (id) => {
      try {
        const element = document.getElementById(id);
        if (!element) return 0;
        const rect = element.getBoundingClientRect();
        if (!rect.width || rect.height < 10) return 0;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return 0;
        return rect.right;
      } catch {
        return 0;
      }
    };
    inset = Math.max(inset, rightOf('resource-palette'));
    // Campaign/timed-lab objectives float over the left of the canvas; the level
    // furniture should not hide behind them. Capped so narrow viewports do not
    // squeeze the diorama into a sliver.
    inset = Math.max(inset, Math.min(rightOf('objectives-panel'), width * 0.28));
    return Math.max(0, Math.min(inset, width * 0.45));
  }

  _viewportSize() {
    return {
      width: Math.max(1, this.canvas.clientWidth || window.innerWidth || 1),
      height: Math.max(1, this.canvas.clientHeight || window.innerHeight || 1),
    };
  }

  /** Bounding box of every model in the scene (or a sensible empty-stage box). */
  _computeBounds() {
    const box = new THREE.Box3();
    let count = 0;
    for (const group of this.resourceMeshes.values()) {
      if (group.visible === false) continue;
      const footprint = group.userData?.footprint || 1.1;
      const height = group.userData?.height || 1.8;
      box.expandByPoint(new THREE.Vector3(group.position.x - footprint, 0, group.position.z - footprint));
      box.expandByPoint(new THREE.Vector3(group.position.x + footprint, group.position.y + height, group.position.z + footprint));
      count += 1;
    }
    if (count === 0) {
      box.set(new THREE.Vector3(-15, 0, -16), new THREE.Vector3(15, 3, 27));
    }
    return box;
  }

  /**
   * Fit points: model bounds + label anchors + floor section names. Labels and
   * floor names are part of the composition, so the fit must not crop them.
   */
  _computeFitPoints(filter = null) {
    const points = [];
    const box = new THREE.Box3();
    let count = 0;

    for (const group of this.resourceMeshes.values()) {
      if (group.visible === false) continue;
      if (filter && !filter(group)) continue;
      const footprint = group.userData?.footprint || 1.1;
      const height = group.userData?.height || 1.8;
      const labelY = group.position.y + (group.userData?.labelY ?? height + 0.4);
      box.expandByPoint(new THREE.Vector3(group.position.x - footprint, 0, group.position.z - footprint));
      box.expandByPoint(new THREE.Vector3(
        group.position.x + footprint,
        group.position.y + height,
        group.position.z + footprint,
      ));
      points.push(new THREE.Vector3(group.position.x, labelY, group.position.z));
      count += 1;
    }

    if (count === 0) {
      box.set(new THREE.Vector3(-15, 0, -16), new THREE.Vector3(15, 3, 27));
    }

    for (const band of filter ? [] : (this.tierBands?.values?.() || [])) {
      if (!band.group.visible) continue;
      // The tinted zone itself must stay inside the frame, otherwise a tier row
      // visually runs off the edge even when its models are framed.
      const halfWidth = Math.max(band.width || 12, 12) / 2;
      const halfDepth = Math.max(band.depth || TIER_BAND_DEPTH, TIER_BAND_DEPTH) / 2;
      const centreX = band.fill.position.x;
      const centreZ = band.fill.position.z;
      points.push(new THREE.Vector3(centreX - halfWidth, 0.02, centreZ - halfDepth));
      points.push(new THREE.Vector3(centreX + halfWidth, 0.02, centreZ + halfDepth));
      const labelHalfWidth = (12.3 * band.label.scale.x) / 2;
      const labelHalfDepth = (1.15 * band.label.scale.y) / 2;
      points.push(new THREE.Vector3(
        band.label.position.x - labelHalfWidth, 0.02, band.label.position.z - labelHalfDepth,
      ));
      points.push(new THREE.Vector3(
        band.label.position.x + labelHalfWidth, 0.02, band.label.position.z + labelHalfDepth,
      ));
    }

    for (let index = 0; index < 8; index++) {
      points.push(new THREE.Vector3(
        index & 1 ? box.max.x : box.min.x,
        index & 2 ? box.max.y : box.min.y,
        index & 4 ? box.max.z : box.min.z,
      ));
    }

    return { box, points };
  }

  /**
   * Frame every resource inside the current canvas aspect.
   * @param {{padding?:number, animate?:boolean, duration?:number,
   *          insets?:{top?:number,bottom?:number,left?:number,right?:number},
   *          intro?:boolean, filter?:(group:THREE.Group)=>boolean}} [options]
   */
  fitToView(options = {}) {
    const {
      padding = this.menuMode ? 1.06 : 1.04,
      animate = false,
      duration = 820,
      intro = false,
      filter = null,
      // A clean session can legitimately contain only two Nodes: without a floor
      // the fit would push the camera into the pedestals. The sandbox/menu fits
      // are already far away, so this only affects small working sets.
      minDistance = this.menuMode ? 0 : 30,
    } = options;
    const { width, height } = this._viewportSize();
    if (width < 4 || height < 4 || !this.camera) return;

    // A fresh fit always wins over a creation focus tween.
    if (this._focusAnimation) this._cancelFocusAnimation(false);

    const { box, points } = this._computeFitPoints(typeof filter === 'function' ? filter : null);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(6, sphere.radius);

    // Keep content clear of the HUD (top) and command toolbar (bottom); in the
    // start-page hero there are no overlays, so use the whole frame. When a
    // presentation filter is active (clean session / Mine / Platform hidden) the
    // palette dock is part of the safe area, so the working set is centred in the
    // visible canvas instead of hiding behind it.
    const presentationActive = this.highlightMine || (this.platformUids.size > 0 && !this.platformRevealed);
    const leftInset = presentationActive ? this._uiLeftInset() : 0;
    const baseInsets = this.menuMode
      ? { top: 0, bottom: 0, left: 0, right: 0 }
      : { top: 52, bottom: 58, left: leftInset, right: 0 };
    const insetScale = Math.min(1, height / 780);
    const insets = {
      top: (options.insets?.top ?? baseInsets.top) * insetScale,
      bottom: (options.insets?.bottom ?? baseInsets.bottom) * insetScale,
      left: (options.insets?.left ?? baseInsets.left) * insetScale,
      right: (options.insets?.right ?? baseInsets.right) * insetScale,
    };
    const usableHeight = Math.max(120, height - insets.top - insets.bottom);
    const usableWidth = Math.max(160, width - insets.left - insets.right);

    const direction = this._cameraDirection();
    const target = center.clone();
    target.y = Math.max(0.4, center.y * 0.6 + 0.4);

    // Camera-space basis for the candidate framing.
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const tanV = Math.tan(verticalFov / 2);
    const tanH = tanV * (width / height);
    const fractionX = usableWidth / width;
    const fractionY = usableHeight / height;

    const forward = direction.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    // 1) Minimum distance that keeps every fit point inside the usable frame.
    let requiredDistance = 0;
    for (const point of points) {
      const relative = point.clone().sub(target);
      const alongView = relative.dot(forward);
      const lateralX = Math.abs(relative.dot(right));
      const lateralY = Math.abs(relative.dot(up));
      requiredDistance = Math.max(
        requiredDistance,
        lateralX / (tanH * fractionX) - alongView,
        lateralY / (tanV * fractionY) - alongView,
      );
    }

    // 2) Iterate so the framed content actually fills the target share of the
    // viewport (a pure corner fit leaves large empty diagonals), and re-centre the
    // projected point cloud inside the usable rect.
    const targetFill = clamp((this.menuMode ? 0.94 : 0.9) / Math.max(0.6, padding), 0.45, 0.97);
    const labelTopMargin = 40; // px of label reserved above each anchor
    const maxDistance = Math.max(this.controls.maxDistance, requiredDistance * 2);
    let distance = clamp(Math.max(6, requiredDistance), this.controls.minDistance, maxDistance);

    for (let iteration = 0; iteration < 4; iteration++) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const point of points) {
        const relative = point.clone().sub(target);
        const depth = distance + relative.dot(forward);
        if (depth < 0.5) continue;
        const ndcX = relative.dot(right) / (depth * tanH);
        const ndcY = relative.dot(up) / (depth * tanV);
        minX = Math.min(minX, ndcX);
        maxX = Math.max(maxX, ndcX);
        minY = Math.min(minY, ndcY);
        maxY = Math.max(maxY, ndcY);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) break;

      const spanX = (maxX - minX) / 2 / fractionX;
      const spanY = (maxY - minY) / 2 / fractionY + labelTopMargin / usableHeight;
      const fill = Math.max(spanX, spanY);
      if (fill > 1e-4) {
        const adjustment = clamp(fill / targetFill, 0.6, 1.8);
        distance = clamp(distance * adjustment, this.controls.minDistance, maxDistance);
      }

      // Re-centre: move the target (and therefore the camera) so the projected
      // point cloud sits in the middle of the usable frame.
      const centreX = (minX + maxX) / 2;
      const centreY = (minY + maxY) / 2;
      if (Math.abs(centreX) > 0.005 || Math.abs(centreY) > 0.005) {
        target.addScaledVector(right, centreX * tanH * distance);
        target.addScaledVector(up, centreY * tanV * distance);
      }
    }

    distance = clamp(distance, this.controls.minDistance, maxDistance);
    if (minDistance > 0) distance = Math.max(distance, Math.min(minDistance, maxDistance));

    // Centre the composition inside the *usable* rect, not the raw viewport: with
    // the palette dock on the left the working set should sit right of it.
    const rectCentreX = (insets.left + usableWidth / 2) / width * 2 - 1;
    if (Math.abs(rectCentreX) > 0.001) {
      target.addScaledVector(right, -rectCentreX * tanH * distance);
    }

    const cameraPosition = target.clone().addScaledVector(direction, distance);

    this.controls.maxDistance = Math.max(220, distance * 1.7);
    this._lastFit = {
      center: target.clone(),
      distance,
      radius,
      position: cameraPosition.clone(),
    };

    if (animate) {
      if (intro) {
        // Reveal from slightly wider and higher, then settle into the fitted view.
        const wide = target.clone().addScaledVector(direction, distance * 1.3);
        wide.y += distance * 0.08;
        this.camera.position.copy(wide);
        this.controls.target.copy(target);
        this.camera.lookAt(target);
        this._fitDone = true;
        this._animateCameraTo(cameraPosition, target, 880);
      } else {
        this._animateCameraTo(cameraPosition, target, duration);
      }
    } else {
      if (this._fitAnimation) {
        cancelAnimationFrame(this._fitAnimation.id);
        this._fitAnimation = null;
      }
      this.camera.position.copy(cameraPosition);
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      this.controls.enabled = !this.menuMode;
      this.controls.update();
      this._fitDone = true;
    }
    if (intro) this._introPlayed = true;
    return this._lastFit;
  }

  _animateCameraTo(position, target, duration) {
    if (this._fitAnimation) cancelAnimationFrame(this._fitAnimation.id);
    const animation = {
      id: null,
      startTime: performance.now(),
      duration: Math.max(1, duration),
      startPosition: this.camera.position.clone(),
      endPosition: position.clone(),
      startTarget: this.controls.target.clone(),
      endTarget: target.clone(),
    };
    this._fitAnimation = animation;
    this.controls.enabled = false;

    const step = () => {
      const t = Math.min(1, (performance.now() - animation.startTime) / animation.duration);
      const ease = easeOutCubic(t);
      this.camera.position.lerpVectors(animation.startPosition, animation.endPosition, ease);
      this.controls.target.lerpVectors(animation.startTarget, animation.endTarget, ease);
      this.camera.lookAt(this.controls.target);
      if (t < 1) {
        animation.id = requestAnimationFrame(step);
      } else {
        this._fitAnimation = null;
        this.controls.enabled = !this.menuMode;
        this.controls.update();
        this._fitDone = true;
        if (this.menuMode) {
          this.controls.autoRotate = true;
          this.controls.update();
        }
      }
    };
    animation.id = requestAnimationFrame(step);
  }

  resetCamera() {
    return this.fitToView({ animate: false });
  }

  /** Enable/disable the debounced auto-refit after resource changes. */
  setAutoRefit(enabled) {
    this.autoRefitEnabled = Boolean(enabled);
  }

  // ── Resize ───────────────────────────────────────────────────────────────
  /**
   * Recompute renderer size + camera aspect from canvas.clientWidth/clientHeight.
   * Call after reparenting the canvas (e.g. start-page hero ↔ fullscreen).
   * @param {{refit?:boolean}} [options]
   */
  resize(options = {}) {
    if (!this.renderer || !this.camera) return null;
    const { width, height } = this._viewportSize();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.labelLayer?.refresh();
    if (options.refit && (this.menuMode || !this._fitDone)) {
      this.fitToView({ animate: false });
    }
    return { width, height };
  }

  /** Back-compat alias for the old private resize handler. */
  _handleResize() {
    return this.resize({ refit: this.menuMode });
  }

  // ── Menu showcase ────────────────────────────────────────────────────────
  /**
   * Start-page showcase mode: slow auto-orbit, gentle pointer parallax, wider
   * framing, no user orbit/zoom (the hero belongs to the page). Safe to call
   * before any resources exist and safe to call repeatedly.
   */
  /** Hide all but the ~24 most legible objects and lay them out compactly. */
  _applyShowcaseSubset() {
    const entries = [...this.resourceMeshes.entries()];
    for (const [, group] of entries) group.visible = true;
    this._showcaseApplied = false;

    if (!this.menuShowcaseSubset || entries.length <= SHOWCASE_CAP) {
      this._refreshTierBands();
      this._updateContactShadows();
      this._rebuildPickableList();
      return;
    }

    const priorityOf = (group) => SHOWCASE_PRIORITY[group.userData.resourceKind] ?? 4;
    const nameOfGroup = (group) => group.userData.displayName || '';

    // Busiest project namespaces first — the hero should show where the apps live.
    const namespaceCounts = new Map();
    for (const [, group] of entries) {
      const namespace = group.userData.resourceNamespace;
      if (!namespace) continue;
      if (!SHOWCASE_APP_KINDS.has(group.userData.resourceKind)) continue;
      namespaceCounts.set(namespace, (namespaceCounts.get(namespace) || 0) + 1);
    }

    const chosen = new Set();
    const pick = (predicate, limit) => {
      const list = entries
        .filter(([id, group]) => !chosen.has(id) && predicate(group))
        .sort((a, b) => priorityOf(b[1]) - priorityOf(a[1])
          || nameOfGroup(a[1]).localeCompare(nameOfGroup(b[1])));
      for (const [id] of list.slice(0, Math.max(0, limit))) chosen.add(id);
    };

    // 1. Nodes — the hardware anchors of the diorama.
    pick((group) => group.userData.resourceKind === 'Node', 3);
    // 2. The busiest Projects.
    const projects = entries
      .filter(([id, group]) => !chosen.has(id) && group.userData.resourceKind === 'Project')
      .sort((a, b) => {
        const difference = (namespaceCounts.get(nameOfGroup(b[1])) || 0)
          - (namespaceCounts.get(nameOfGroup(a[1])) || 0);
        return difference || nameOfGroup(a[1]).localeCompare(nameOfGroup(b[1]));
      });
    for (const [id] of projects.slice(0, 4)) chosen.add(id);
    // 3. The application story: workloads, builds, networking, config, storage.
    pick((group) => SHOWCASE_APP_KINDS.has(group.userData.resourceKind), 15);
    // 4. Fill the remaining slots with compact "extras" that add story variety.
    pick((group) => {
      const kind = group.userData.resourceKind;
      return kind !== 'Project' && kind !== 'Node' && (SHOWCASE_PRIORITY[kind] ?? 0) >= 18;
    }, SHOWCASE_CAP - chosen.size);

    for (const [id, group] of entries) group.visible = chosen.has(id);

    const showcased = [];
    for (const [id, group] of entries) {
      if (!chosen.has(id)) continue;
      showcased.push({
        uid: id,
        kind: group.userData.resourceKind,
        metadata: { name: group.userData.displayName },
      });
    }
    // Showcase layout is a squarer block than the game plan, so the small hero
    // window (≈600x504) can frame it large instead of as a thin wide strip.
    const targets = layoutTargets(showcased, { maxRowWidth: 16, tierGap: 1.25, centerZ: 3 });
    for (const [id, target] of targets) {
      const group = this.resourceMeshes.get(id);
      if (group) group.position.set(target.x, 0, target.z);
    }

    this.connectionLines.updatePositions(this.resourceMeshes);
    this._refreshTierBands();
    this._updateContactShadows();
    this._rebuildPickableList();
    this._showcaseApplied = true;
  }

  _clearShowcaseSubset() {
    for (const group of this.resourceMeshes.values()) group.visible = true;
    this._showcaseApplied = false;
    this.connectionLines.updatePositions(this.resourceMeshes);
    this._refreshTierBands();
    this._updateContactShadows();
    this._rebuildPickableList();
    if (!this.menuMode) this._applyPresentation({ fit: false });
  }

  /** Toggle the hero subsetting (default on). */
  setShowcaseSubset(enabled) {
    this.menuShowcaseSubset = Boolean(enabled);
    if (this.menuMode) this._applyShowcaseSubset();
  }

  _applyTierLabelScale() {
    for (const band of this.tierBands?.values?.() || []) {
      band.label.scale.set(1, 1, 1);
      band.label.visible = !this.menuMode;
      band.label.material.opacity = 0.8;
    }
  }

  setMenuMode(enabled) {
    const next = Boolean(enabled);
    if (this.menuMode === next) {
      if (next) this.fitToView({ animate: false });
      return;
    }
    this.menuMode = next;

    if (next) {
      this._cancelFocusAnimation(true);
      this._clearMinePulses();
      // The start-page hero owns its own showcase subset; never leave the
      // mine-only filter or platform dimming active behind it.
      this.highlightMine = false;
      for (const group of this.resourceMeshes.values()) this._setGroupDim(group, false);
      this.deselectAll();
      this.controls.enabled = false;
      this.controls.autoRotate = true;
      this.controls.autoRotateSpeed = 0.3;
      this.controls.enablePan = false;
      this.controls.enableZoom = false;
      this.controls.enableRotate = false;
      this._parallax.x = 0;
      this._parallax.y = 0;
      this._parallaxTarget.x = 0;
      this._parallaxTarget.y = 0;
      this._bindPointerParallax();
      this._azimuth = MENU_AZIMUTH;
      this._elevation = MENU_ELEVATION;
      if (this.renderer) this.renderer.toneMappingExposure = EXPOSURE_MENU;
      if (this.keyLight) this.keyLight.intensity = MENU_KEY_INTENSITY;
      if (this.ambientLight) this.ambientLight.intensity = MENU_AMBIENT_INTENSITY;
      this._particlesBeforeMenu = this.particleTraffic.enabled;
      this.particleTraffic.setEnabled(false);
      this._applyShowcaseSubset();
      this._applyTierLabelScale();
      this.fitToView({ animate: true, duration: 900 });
      this._introPlayed = true;
    } else {
      this.controls.autoRotate = false;
      this.controls.enabled = true;
      this.controls.enablePan = true;
      this.controls.enableZoom = true;
      this.controls.enableRotate = true;
      this._unbindPointerParallax();
      this._parallax.x = 0;
      this._parallax.y = 0;
      this._parallaxTarget.x = 0;
      this._parallaxTarget.y = 0;
      this._azimuth = BASE_AZIMUTH;
      this._elevation = BASE_ELEVATION;
      if (this.renderer) this.renderer.toneMappingExposure = EXPOSURE;
      if (this.keyLight) this.keyLight.intensity = BASE_KEY_INTENSITY;
      if (this.ambientLight) this.ambientLight.intensity = BASE_AMBIENT_INTENSITY;
      this.particleTraffic.setEnabled(this._particlesBeforeMenu !== false);
      this._clearShowcaseSubset();
      this._applyTierLabelScale();
      this.fitToView({ animate: true, duration: 700 });
    }
    this._labelContext = { menuMode: this.menuMode };
  }

  get isMenuMode() {
    return this.menuMode;
  }

  _bindPointerParallax() {
    if (this._parallaxHandler) return;
    this._parallaxHandler = (event) => {
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      this._parallaxTarget.x = (event.clientX / width - 0.5) * 2;
      this._parallaxTarget.y = (event.clientY / height - 0.5) * 2;
    };
    window.addEventListener('pointermove', this._parallaxHandler, { passive: true });
  }

  _unbindPointerParallax() {
    if (!this._parallaxHandler) return;
    window.removeEventListener('pointermove', this._parallaxHandler);
    this._parallaxHandler = null;
  }

  // ── Labels / settings helpers ────────────────────────────────────────────
  setLabelsVisible(visible) {
    this.labelLayer?.setVisible(visible);
  }

  setLabelsEnabled(enabled) {
    this.labelLayer?.setEnabled(enabled);
  }

  setShadowsEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.renderer) this.renderer.shadowMap.enabled = next;
    if (this.keyLight) this.keyLight.castShadow = next;
  }

  // ── Render loop ──────────────────────────────────────────────────────────
  start() {
    if (this.running) return;
    this.resize();
    this.running = true;
    this.lastFrameTime = performance.now();
    this.labelLayer?.setVisible(true);
    this._animate();
  }

  stop() {
    this.running = false;
    this._cancelFocusAnimation(false);
    this._clearMinePulses();
    if (this._refitTimer) {
      clearTimeout(this._refitTimer);
      this._refitTimer = null;
    }
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.labelLayer?._hideAll?.();
  }

  _animate() {
    if (!this.running) return;
    this.frameId = requestAnimationFrame(() => this._animate());

    const now = performance.now();
    const delta = Math.min((now - this.lastFrameTime) / 1000, 0.06);
    this.lastFrameTime = now;

    // Shadows setting is owned by index.html via renderer.shadowMap.enabled.
    if (this.keyLight && this.renderer) {
      const shadowsOn = Boolean(this.renderer.shadowMap.enabled);
      if (this.keyLight.castShadow !== shadowsOn) this.keyLight.castShadow = shadowsOn;
    }

    if (this._fitAnimation || this._focusAnimation) {
      // Camera is driven by the fit/focus tweens.
    } else {
      if (this.menuMode) this._updateParallax(delta);
      this.controls.update();
    }

    if (this._needsHoverPick && !this._draggingResource && !this.menuMode) {
      const since = now - this._lastHoverPick;
      if (since > 45) {
        this._needsHoverPick = false;
        this._lastHoverPick = now;
        this._performPick(false);
      }
    }

    this.connectionLines.update(delta);
    this.particleTraffic.update(delta);
    this._animateResources(delta, now);
    this._updateMinePulses(now);

    const focus = this._lastFit?.center || this.controls.target;
    this._labelContext.menuMode = this.menuMode;
    this._labelContext.focus = focus;
    try {
      this.labelLayer?.update(this._labelContext);
    } catch (error) {
      console.warn('ClusterRenderer: label update failed', error);
    }

    this.renderer.render(this.scene, this.camera);
  }

  _updateParallax(delta) {
    const damp = Math.min(1, delta * 2.4);
    this._parallax.x += (this._parallaxTarget.x - this._parallax.x) * damp;
    this._parallax.y += (this._parallaxTarget.y - this._parallax.y) * damp;
    const base = this._lastFit?.center;
    if (!base) return;
    this.controls.target.x = base.x + this._parallax.x * 0.85;
    this.controls.target.z = base.z + this._parallax.y * 0.55;
    this.controls.target.y = base.y;
  }

  _animateResources(delta, now) {
    const time = now * 0.001;
    const settle = Math.min(1, delta * 9);
    for (const group of this.resourceMeshes.values()) {
      const targetScale = group.userData.targetScale ?? 1;
      const current = group.scale.x;
      if (Math.abs(current - targetScale) > 0.001) {
        const next = current + (targetScale - current) * settle;
        group.scale.setScalar(next);
      } else if (current !== targetScale) {
        group.scale.setScalar(targetScale);
      }

      const isMine = this.playerCreated.has(group.userData.resourceId);

      // "Yours": a very slow breath on the red ring/underglow (never a chase light).
      const mineRing = group.userData.mineRing;
      if (mineRing) {
        const phase = group.userData.minePhase || 0;
        const breathe = 0.5 + 0.5 * Math.sin(time * MINE_BREATH_SPEED + phase);
        mineRing.material.opacity = MINE_RING_OPACITY - 0.1 + 0.16 * breathe;
        if (group.userData.minePool) {
          group.userData.minePool.material.opacity = MINE_POOL_OPACITY - 0.04 + 0.09 * breathe;
        }
      }

      const statusMaterial = group.userData.statusMaterial;
      if (statusMaterial) {
        const base = group.userData.statusBaseOpacity ?? 0.5;
        const hovered = group.userData.resourceId === this.hoveredResource;
        const selected = group.userData.resourceId === this.selectedResource;
        const boost = (selected ? 1.45 : hovered ? 1.2 : 1) * (isMine ? 1.12 : 1)
          * (group.userData.dimmed ? PLATFORM_DIM_STATUS : 1);
        if (group.userData.statusPulse) {
          const pulse = 0.68 + 0.32 * Math.sin(time * (this.menuMode ? 1.1 : 1.9) + group.position.x * 0.7);
          statusMaterial.opacity = base * boost * pulse;
        } else {
          const resting = this.menuMode ? 0.7 + 0.14 * Math.sin(time * 0.8 + group.position.z) : 1;
          statusMaterial.opacity = base * boost * resting;
        }
      }

      if (group.userData.animate) {
        group.userData.animate(time, delta);
      }
    }
    this._updateContactShadows();
  }

  // ── Picking helpers ──────────────────────────────────────────────────────
  focusResource(resourceId, normalizedX, normalizedY) {
    if (resourceId) {
      const group = this.resourceMeshes.get(resourceId);
      if (!group) return;
      this.controls.target.copy(group.position);
      this.controls.update();
      return;
    }
    if (typeof normalizedX === 'number' && typeof normalizedY === 'number') {
      const targetX = (normalizedX - 0.5) * GRID_EXTENT * 0.6;
      const targetZ = (normalizedY - 0.5) * GRID_EXTENT * 0.6;
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      this.controls.target.set(targetX, 0, targetZ);
      this.camera.position.copy(this.controls.target).add(offset);
      this.controls.update();
    }
  }

  getScreenPosition(resourceId) {
    const group = this.resourceMeshes.get(resourceId);
    if (!group) return null;

    const position = group.position.clone();
    position.y += group.userData?.labelY ? group.userData.labelY * 0.4 : 0.6;
    position.project(this.camera);

    return {
      x: (position.x + 1) / 2 * this._viewportSize().width,
      y: (-position.y + 1) / 2 * this._viewportSize().height,
    };
  }

  _raycastGround(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const intersection = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this._groundPlane, intersection);
    return hit ? intersection : null;
  }

  screenToGround(screenX, screenY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((screenX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((screenY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    const pos = this._raycastGround(ndc);
    return pos ? { x: pos.x, y: 0, z: pos.z } : null;
  }

  // ── Teardown ─────────────────────────────────────────────────────────────
  dispose() {
    this.stop();
    if (this._fitAnimation) cancelAnimationFrame(this._fitAnimation.id);
    if (this._layoutAnimation) cancelAnimationFrame(this._layoutAnimation.id);
    this._unbindPointerParallax();
    this._resizeObserver?.disconnect?.();

    this.controls.dispose();
    this._cancelFocusAnimation(false);
    this._clearMinePulses();
    this._minePoolTexture?.dispose?.();
    this._minePoolTexture = null;

    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.canvas.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('mouseleave', this._onMouseLeave);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    this.canvas.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('blur', this._onWindowBlur);

    for (const id of [...this.resourceMeshes.keys()]) this.removeResource(id);

    for (const entry of this.projectPlanes.values()) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
    }
    this.projectPlanes.clear();

    this.connectionLines.dispose();
    this.particleTraffic.dispose();
    this.labelLayer?.dispose();

    // Floor / grid / tier bands.
    this.floorGroup?.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry?.dispose?.();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!material) continue;
        if (material.map && !material.map.userData?.shared) material.map.dispose();
        material.dispose();
      }
    });
    this.scene.remove(this.floorGroup);

    this.gridGroup?.traverse((child) => {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    });
    this.scene.remove(this.gridGroup);

    for (const band of this.tierBands?.values?.() || []) {
      band.fill.geometry.dispose();
      band.fill.material.map?.dispose?.();
      band.fill.material.dispose();
      band.rule.geometry.dispose();
      band.rule.material.dispose();
      band.label.geometry.dispose();
      band.label.material.map?.dispose?.();
      band.label.material.dispose();
    }
    this.tierBands?.clear?.();
    this.scene.remove(this.tierGroup);

    if (this._contactShadows) {
      this.scene.remove(this._contactShadows);
      this._contactShadows.geometry.dispose();
      this._contactShadows.material.map?.dispose?.();
      this._contactShadows.material.dispose();
    }
    _sharedRingGeometry.userData.shared = true;

    for (const light of [this.keyLight, this.rimLight, this.fillLight]) {
      light?.dispose?.();
      light?.shadow?.map?.dispose?.();
    }

    if (this.scene.background?.dispose) this.scene.background.dispose();
    this.renderer.dispose();
  }
}

export default { ClusterRenderer, LAYOUT_TIERS, KIND_TIER, layoutTargets };
