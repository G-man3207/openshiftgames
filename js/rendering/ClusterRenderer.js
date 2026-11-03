import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ResourceMeshFactory } from './ResourceMeshes.js';
import { ConnectionLineManager } from './ConnectionLines.js';
import { ParticleTrafficSystem } from './ParticleTraffic.js';
import { computeConnections } from './RelationGraph.js';
import { RESOURCE_KINDS, paletteMeta } from '../data/kindRegistry.js';

/**
 * 3D OpenShift cluster renderer.
 *
 * Owns the Three.js scene/camera/controls, the resource mesh map, connection lines
 * and particle traffic. Kind→mesh dispatch lives in ResourceMeshes.js; kind→layout
 * tier mapping is derived from the central kindRegistry palette sections so new
 * OpenShift kinds automatically get a place in the auto-align layout.
 */

const BACKGROUND_COLOR = 0x0d1117;
/** OpenShift brand red (replaces the old Kubernetes blue accent). */
const OPENSHIFT_RED = 0xee0000;
const OPENSHIFT_ORANGE = 0xf97316;
const GRID_SIZE = 40;
const GRID_DIVISIONS = 20;
const HIGHLIGHT_COLOR = 0x58a6ff;
const SELECT_COLOR = 0xffa657;
const PROJECT_OPACITY = 0.04;

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

/**
 * Auto-align layout tiers, ordered back→front along +Z in OpenShift flow order:
 * Cluster/Projects → Workloads → Builds → Networking → Config/Storage →
 * Security/Identity → Scaling. Kind → tier is derived from the registry palette
 * sections (see KIND_TIER below); no hard-coded legacy-only lists.
 */
export const LAYOUT_TIERS = Object.freeze([
  { id: 'cluster', z: -20, spacing: 6.5 },
  { id: 'workloads', z: -13, spacing: 4.4 },
  { id: 'builds', z: -6, spacing: 4.2 },
  { id: 'network', z: 0, spacing: 4.6 },
  { id: 'config', z: 6, spacing: 4.2 },
  { id: 'storage', z: 11, spacing: 4.2 },
  { id: 'security', z: 16, spacing: 3.8 },
  { id: 'identity', z: 21, spacing: 4.4 },
  { id: 'scaling', z: 25, spacing: 3.8 },
  { id: 'misc', z: 29, spacing: 3.5 },
]);

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

/**
 * Compute auto-align world positions for resources.
 * @param {Array<object>} resources
 * @returns {Map<string, {x:number,y:number,z:number}>} uid → position
 */
export function layoutTargets(resources) {
  const targets = new Map();
  const buckets = new Map(LAYOUT_TIERS.map((tier) => [tier.id, []]));

  for (const resource of resources || []) {
    const uid = uidOf(resource);
    if (!uid) continue;
    const tierId = tierOf(kindOf(resource));
    if (!buckets.has(tierId)) buckets.set(tierId, []);
    buckets.get(tierId).push(resource);
  }

  for (const tier of LAYOUT_TIERS) {
    const items = buckets.get(tier.id) || [];
    if (items.length === 0) continue;
    items.sort((a, b) => {
      const kindCompare = String(kindOf(a)).localeCompare(String(kindOf(b)));
      if (kindCompare !== 0) return kindCompare;
      return String(nameOf(a)).localeCompare(String(nameOf(b)));
    });
    const totalWidth = (items.length - 1) * tier.spacing;
    const startX = -totalWidth / 2;
    items.forEach((resource, index) => {
      targets.set(uidOf(resource), { x: startX + index * tier.spacing, y: 0, z: tier.z });
    });
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
    this.selectedResource = null;
    this.hoveredResource = null;
    this.mouse = new THREE.Vector2(-999, -999);
    this._clickStart = new THREE.Vector2();
    this._didDrag = false;
    this.projectColorIndex = 0;
    this.running = false;
    this.frameId = null;
    this.lastFrameTime = 0;
    this.onSelect = null;
    this.onHover = null;
    this.onResourceMoved = null;
    this._draggingResource = null;
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this._initScene();
    this._initCamera();
    this._initRenderer();
    this._initControls();
    this._initLights();
    this._initGrid();
    this._initRaycaster();
    this._initSubsystems();
    this._bindEvents();
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND_COLOR);
    this.scene.fog = new THREE.FogExp2(BACKGROUND_COLOR, 0.006);
  }

  _initCamera() {
    const aspect = this.canvas.clientWidth / this.canvas.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 500);
    this.camera.position.set(18, 14, 18);
    this.camera.lookAt(0, 0, 0);
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.rotateSpeed = 0.8;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.8;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 80;
    this.controls.maxPolarAngle = Math.PI / 2.1;
    this.controls.minPolarAngle = 0.1;
    this.controls.target.set(0, 0, 0);
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

  _initLights() {
    this.ambientLight = new THREE.AmbientLight(0x8899bb, 0.7);
    this.scene.add(this.ambientLight);

    const hemiLight = new THREE.HemisphereLight(0x88aaff, 0x222244, 0.4);
    this.scene.add(hemiLight);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
    this.directionalLight.position.set(20, 40, 20);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.set(2048, 2048);
    this.directionalLight.shadow.camera.left = -50;
    this.directionalLight.shadow.camera.right = 50;
    this.directionalLight.shadow.camera.top = 50;
    this.directionalLight.shadow.camera.bottom = -50;
    this.directionalLight.shadow.camera.near = 0.5;
    this.directionalLight.shadow.camera.far = 100;
    this.directionalLight.shadow.bias = -0.001;
    this.scene.add(this.directionalLight);

    const rimLight = new THREE.DirectionalLight(OPENSHIFT_RED, 0.4);
    rimLight.position.set(-15, 10, -15);
    this.scene.add(rimLight);

    const fillLight = new THREE.DirectionalLight(0x446688, 0.3);
    fillLight.position.set(-10, 5, 20);
    this.scene.add(fillLight);
  }

  _initGrid() {
    this.gridGroup = new THREE.Group();
    const gridMaterial = new THREE.LineBasicMaterial({
      color: OPENSHIFT_RED,
      transparent: true,
      opacity: 0.1,
    });

    const halfSize = GRID_SIZE / 2;
    const step = GRID_SIZE / GRID_DIVISIONS;
    const gridGeometry = new THREE.BufferGeometry();
    const vertices = [];

    for (let i = -halfSize; i <= halfSize; i += step) {
      vertices.push(i, 0, -halfSize, i, 0, halfSize);
      vertices.push(-halfSize, 0, i, halfSize, 0, i);
    }

    gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const gridLines = new THREE.LineSegments(gridGeometry, gridMaterial);
    this.gridGroup.add(gridLines);

    const axesMaterial = new THREE.LineBasicMaterial({
      color: OPENSHIFT_RED,
      transparent: true,
      opacity: 0.25,
    });
    const axesGeometry = new THREE.BufferGeometry();
    axesGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -halfSize, 0, 0, halfSize, 0, 0,
      0, 0, -halfSize, 0, 0, halfSize,
    ], 3));
    const axesLines = new THREE.LineSegments(axesGeometry, axesMaterial);
    this.gridGroup.add(axesLines);

    const groundSize = GRID_SIZE * 2;
    const groundGeometry = new THREE.PlaneGeometry(groundSize, groundSize);
    // Matte, radially faded floor: avoids the grazing-angle specular glare a glossy
    // ground plane produces under ACES tone mapping and fades into the background.
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x150a0c,
      metalness: 0.2,
      roughness: 0.92,
      transparent: true,
      opacity: 0.55,
      alphaMap: this._createGroundFadeTexture(),
      depthWrite: false,
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.1;
    ground.receiveShadow = true;
    this.gridGroup.add(ground);

    this.scene.add(this.gridGroup);
  }

  _createGroundFadeTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(128, 128, 16, 128, 128, 128);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.5)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

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
  }

  _bindEvents() {
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onResize = this._handleResize.bind(this);
    this._onContextMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersects = this.raycaster.intersectObjects(this.pickableObjects, true);
      if (intersects.length > 0) {
        let target = intersects[0].object;
        while (target.parent && !target.userData.resourceId) {
          target = target.parent;
        }
        if (target.userData.resourceId && window.game?.engine) {
          window.game.engine.emit('resource:contextmenu', {
            uid: target.userData.resourceId,
            x: e.clientX,
            y: e.clientY,
          });
        }
      }
    };

    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    this.canvas.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('resize', this._onResize);
  }

  _handleMouseMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    if (this._draggingResource) {
      const pos = this._raycastGround(this.mouse);
      if (pos) {
        const group = this.resourceMeshes.get(this._draggingResource);
        if (group) {
          group.position.x = pos.x;
          group.position.z = pos.z;
        }
      }
      return;
    }

    const dx = event.clientX - this._clickStart.x;
    const dy = event.clientY - this._clickStart.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 4) {
      if (this._dragCandidate && !this._didDrag) {
        this._draggingResource = this._dragCandidate;
        this._dragCandidate = null;
        this.controls.enabled = false;
        this.canvas.style.cursor = 'grabbing';
      }
      this._didDrag = true;
    }
  }

  _handleMouseDown(event) {
    if (event.button === 0) {
      this._clickStart.set(event.clientX, event.clientY);
      this._didDrag = false;
      this._dragCandidate = null;

      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersects = this.raycaster.intersectObjects(this.pickableObjects, true);
      if (intersects.length > 0) {
        let target = intersects[0].object;
        while (target.parent && !target.userData.resourceId) {
          target = target.parent;
        }
        if (target.userData.resourceId) {
          this._dragCandidate = target.userData.resourceId;
        }
      }
    }
  }

  _handleMouseUp(event) {
    if (this._draggingResource) {
      const rid = this._draggingResource;
      this._draggingResource = null;
      this.controls.enabled = true;
      this.canvas.style.cursor = 'default';
      const group = this.resourceMeshes.get(rid);
      if (group && this.onResourceMoved) {
        this.onResourceMoved(rid, { x: group.position.x, y: 0, z: group.position.z });
      }
      this._didDrag = false;
      return;
    }

    if (event.button === 0 && !this._didDrag) {
      this._performPick(true);
    }
    this._didDrag = false;
    this._dragCandidate = null;
  }

  _handleResize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  _performPick(isClick) {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.pickableObjects, true);

    if (intersects.length > 0) {
      let target = intersects[0].object;
      while (target.parent && !target.userData.resourceId) {
        target = target.parent;
      }

      if (target.userData.resourceId) {
        if (isClick) {
          this._setSelected(target.userData.resourceId);
        } else {
          this._setHovered(target.userData.resourceId);
        }
        return;
      }
    }

    if (isClick) {
      this._setSelected(null);
    } else {
      this._setHovered(null);
    }
  }

  _setSelected(resourceId) {
    if (this.selectedResource === resourceId) return;

    if (this.selectedResource) {
      const prevGroup = this.resourceMeshes.get(this.selectedResource);
      if (prevGroup) this._applyMeshEffect(prevGroup, 'default');
    }

    this.selectedResource = resourceId;

    if (resourceId) {
      const group = this.resourceMeshes.get(resourceId);
      if (group) this._applyMeshEffect(group, 'selected');
    }

    if (this.onSelect) this.onSelect(resourceId);
  }

  _setHovered(resourceId) {
    if (this.hoveredResource === resourceId) return;

    if (this.hoveredResource && this.hoveredResource !== this.selectedResource) {
      const prevGroup = this.resourceMeshes.get(this.hoveredResource);
      if (prevGroup) this._applyMeshEffect(prevGroup, 'default');
    }

    this.hoveredResource = resourceId;
    this.canvas.style.cursor = resourceId ? 'pointer' : 'default';

    if (resourceId && resourceId !== this.selectedResource) {
      const group = this.resourceMeshes.get(resourceId);
      if (group) this._applyMeshEffect(group, 'hovered');
    }

    if (this.onHover) this.onHover(resourceId);
  }

  _applyMeshEffect(group, effect) {
    if (!group) return;
    group.traverse((child) => {
      if (!child.isMesh || child.userData.isLabel) return;
      const mat = child.material;
      if (!mat) return;

      const hasEmissive = mat.isMeshStandardMaterial || mat.isMeshPhongMaterial || mat.isMeshLambertMaterial;

      switch (effect) {
        case 'selected':
          if (hasEmissive) {
            mat.emissiveIntensity = 0.5;
            mat.emissive.set(SELECT_COLOR);
          } else if (mat.color) {
            if (!child.userData.baseColor) child.userData.baseColor = mat.color.getHex();
            mat.color.set(SELECT_COLOR);
          }
          if (child.userData.originalScale) {
            child.scale.copy(child.userData.originalScale).multiplyScalar(1.08);
          }
          break;
        case 'hovered':
          if (hasEmissive) {
            mat.emissiveIntensity = 0.3;
            mat.emissive.set(HIGHLIGHT_COLOR);
          } else if (mat.color) {
            if (!child.userData.baseColor) child.userData.baseColor = mat.color.getHex();
            mat.color.set(HIGHLIGHT_COLOR);
          }
          break;
        default:
          if (hasEmissive) {
            if (child.userData.baseEmissive) {
              mat.emissive.copy(child.userData.baseEmissive);
              mat.emissiveIntensity = child.userData.baseEmissiveIntensity || 0.15;
            } else {
              mat.emissiveIntensity = 0.15;
            }
          } else if (child.userData.baseColor !== undefined) {
            mat.color.set(child.userData.baseColor);
          }
          if (child.userData.originalScale) {
            child.scale.copy(child.userData.originalScale);
          }
          break;
      }
    });
  }

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
    group.position.set(resource.x || 0, resource.y || 0, resource.z || 0);

    group.traverse((child) => {
      if (child.isMesh) {
        child.userData.resourceId = id;
        child.userData.originalScale = child.scale.clone();
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material && child.material.emissive) {
          child.userData.baseEmissive = child.material.emissive.clone();
          child.userData.baseEmissiveIntensity = child.material.emissiveIntensity;
        }
      }
    });

    this.scene.add(group);
    this.resourceMeshes.set(id, group);
    this._rebuildPickableList();

    const namespace = resource.namespace || resource._ref?.metadata?.namespace;
    if (namespace && kind !== 'Project') {
      this._ensureProjectPlane(namespace);
    }
  }

  removeResource(resourceId) {
    const group = this.resourceMeshes.get(resourceId);
    if (!group) return;

    this.scene.remove(group);
    this.meshFactory.dispose(group);

    this.resourceMeshes.delete(resourceId);
    this._rebuildPickableList();

    if (this.selectedResource === resourceId) this._setSelected(null);
    if (this.hoveredResource === resourceId) this._setHovered(null);
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
    }
  }

  _rebuildPickableList() {
    this.pickableObjects = [];
    for (const group of this.resourceMeshes.values()) {
      group.traverse((child) => {
        if (child.isMesh && !child.userData.isLabel) {
          this.pickableObjects.push(child);
        }
      });
    }
  }

  _projectColor(project) {
    if (NAMED_PROJECT_COLORS[project] !== undefined) return NAMED_PROJECT_COLORS[project];
    let hash = 0;
    for (let i = 0; i < project.length; i++) hash = (hash * 31 + project.charCodeAt(i)) | 0;
    return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
  }

  _ensureProjectPlane(project) {
    if (this.projectPlanes.has(project)) return;

    const color = this._projectColor(project);
    const planeGeom = new THREE.PlaneGeometry(6, 6);
    const planeMat = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: PROJECT_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const plane = new THREE.Mesh(planeGeom, planeMat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.05;
    plane.receiveShadow = true;
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

    const width = bounds.maxX - bounds.minX + 4;
    const depth = bounds.maxZ - bounds.minZ + 4;
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;

    entry.mesh.geometry.dispose();
    entry.mesh.geometry = new THREE.PlaneGeometry(width, depth);
    entry.mesh.position.set(centerX, -0.05, centerZ);
  }

  /** @deprecated kept for old callers; use updateProjectBounds. */
  updateNamespaceBounds(namespace, bounds) {
    return this.updateProjectBounds(namespace, bounds);
  }

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
   *
   * @param {object} clusterState
   * @param {{extraConnections?: Iterable<object>, includeContainment?: boolean}} [options]
   * @returns {Map<string, object>} connection map
   */
  syncConnectionsFromCluster(clusterState, options = {}) {
    if (!clusterState) return new Map();
    const connections = computeConnections(clusterState, options);
    this.connectionLines.sync(connections, this.resourceMeshes);
    return connections;
  }

  /**
   * Auto-align all resources into the OpenShift flow tiers.
   * @param {object} clusterState
   * @param {{duration?:number, filter?:(resource)=>boolean}} [options]
   * @returns {Map<string, {x:number,y:number,z:number}>}
   */
  autoAlign(clusterState, options = {}) {
    if (!clusterState) return new Map();
    const { duration = 800, filter = null } = options;
    const all = typeof clusterState.getAllResources === 'function'
      ? clusterState.getAllResources()
      : Array.from(clusterState.resources?.values?.() || []);
    const resources = filter ? all.filter(filter) : all;
    const targets = layoutTargets(resources);
    this.animateToPositions(targets, duration);
    return targets;
  }

  syncWithState(clusterState) {
    if (!clusterState) return;

    const currentIds = new Set(this.resourceMeshes.keys());
    const stateIds = new Set();

    const resources = typeof clusterState.getAllResources === 'function'
      ? clusterState.getAllResources()
      : Array.from(clusterState.resources?.values?.() || []);

    for (const resource of resources) {
      const uid = uidOf(resource);
      if (!uid) continue;
      stateIds.add(uid);
      if (currentIds.has(uid)) {
        this.updateResource({
          id: uid,
          status: resource.status?.phase || resource.status,
          x: this.resourceMeshes.get(uid)?.position.x,
          y: this.resourceMeshes.get(uid)?.position.y,
          z: this.resourceMeshes.get(uid)?.position.z,
        });
      } else {
        this.addResource(resource);
      }
    }

    for (const id of currentIds) {
      if (!stateIds.has(id)) {
        this.removeResource(id);
      }
    }

    if (clusterState.connections) {
      this.connectionLines.sync(clusterState.connections, this.resourceMeshes);
    } else {
      this.syncConnectionsFromCluster(clusterState);
    }

    if (clusterState.trafficRoutes) {
      this.particleTraffic.syncRoutes(clusterState.trafficRoutes);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this._animate();
  }

  stop() {
    this.running = false;
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }

  _animate() {
    if (!this.running) return;
    this.frameId = requestAnimationFrame(() => this._animate());

    const now = performance.now();
    const delta = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    this.controls.update();

    if (!this._didDrag) {
      this._performPick(false);
    }

    this.connectionLines.update(delta);
    this.particleTraffic.update(delta);
    this._animateResources(delta);

    this.renderer.render(this.scene, this.camera);
  }

  _animateResources(delta) {
    const time = performance.now() * 0.001;
    for (const [id, group] of this.resourceMeshes) {
      if (group.userData.resourceType === 'Pod') {
        const phase = id.charCodeAt(0) % 7;
        group.position.y = (group.userData.baseY || 0) + Math.sin(time * 2 + phase) * 0.08;
      }
      if (group.userData.animate) {
        group.userData.animate(time, delta);
      }
    }
  }

  /**
   * Focus a resource, or (when resourceId is null) pan the camera to a normalised
   * minimap position (0..1, 0..1).
   */
  focusResource(resourceId, normalizedX, normalizedY) {
    if (resourceId) {
      const group = this.resourceMeshes.get(resourceId);
      if (!group) return;
      this.controls.target.copy(group.position);
      this.controls.update();
      return;
    }
    if (typeof normalizedX === 'number' && typeof normalizedY === 'number') {
      const targetX = (normalizedX - 0.5) * GRID_SIZE;
      const targetZ = (normalizedY - 0.5) * GRID_SIZE;
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      this.controls.target.set(targetX, 0, targetZ);
      this.camera.position.copy(this.controls.target).add(offset);
      this.controls.update();
    }
  }

  getScreenPosition(resourceId) {
    const group = this.resourceMeshes.get(resourceId);
    if (!group) return null;

    const pos = group.position.clone();
    pos.project(this.camera);

    return {
      x: (pos.x + 1) / 2 * this.canvas.clientWidth,
      y: (-pos.y + 1) / 2 * this.canvas.clientHeight,
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
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1,
    );
    const pos = this._raycastGround(ndc);
    return pos ? { x: pos.x, y: 0, z: pos.z } : null;
  }

  animateToPositions(targets, duration = 800) {
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

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      for (const [uid, target] of targets) {
        const group = this.resourceMeshes.get(uid);
        const start = startPositions.get(uid);
        if (!group || !start) continue;

        group.position.x = start.x + (target.x - start.x) * ease;
        group.position.y = start.y + (target.y - start.y) * ease;
        group.position.z = start.z + (target.z - start.z) * ease;
      }

      this.connectionLines.updatePositions(this.resourceMeshes);

      if (t < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }

  resetCamera() {
    this.camera.position.set(18, 14, 18);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  dispose() {
    this.stop();

    this.controls.dispose();

    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.canvas.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('resize', this._onResize);

    for (const id of [...this.resourceMeshes.keys()]) {
      this.removeResource(id);
    }

    for (const entry of this.projectPlanes.values()) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
    }
    this.projectPlanes.clear();

    this.connectionLines.dispose();
    this.particleTraffic.dispose();
    this.renderer.dispose();
  }
}
