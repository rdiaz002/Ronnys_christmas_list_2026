import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import {
  hashString, mulberry32, segment, easeInOut, easeOut, easeOutBack, makeStarShape, softDotTexture, isLightColor,
} from './util.js';
import { SKIRT_RADIUS } from './tree.js';

export const PRIORITY = {
  high: { scale: 1.3, rank: 3 },
  medium: { scale: 1, rank: 2 },
  low: { scale: 0.85, rank: 1 },
};
const priorityOf = (item) => PRIORITY[item.priority] || PRIORITY.medium;

const WRAP_COLORS = ['#b3202a', '#1f5f3a', '#c9a227', '#2c4a8a', '#7a1f3d', '#ece4d2', '#a8402c', '#244e5c'];
const PATTERNS = ['stripes', 'dots', 'stars', 'plaid', 'plain'];
const RIBBON_COLORS = ['#d4a73a', '#f3efe6', '#b3202a', '#c0c7cf'];

const RING_SPACING = 1.25;
const RING_STEP = 1.2;
const WALL = 0.025;
const OPEN_SPEED = 1 / 1.9;
const CLOSE_SPEED = 1 / 0.9;

const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
const gltfLoader = new GLTFLoader().setDRACOLoader(draco);
const textureLoader = new THREE.TextureLoader();
const sparkleTexture = softDotTexture();

function makeWrapTexture(base, accent, pattern) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = accent;
  g.strokeStyle = accent;
  switch (pattern) {
    case 'stripes':
      g.lineWidth = 16;
      for (let i = -256; i <= 256; i += 64) {
        g.beginPath();
        g.moveTo(i, 0);
        g.lineTo(i + 256, 256);
        g.stroke();
      }
      break;
    case 'dots':
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          g.beginPath();
          g.arc(col * 64 + 16 + (row % 2) * 32, row * 64 + 16, 8, 0, Math.PI * 2);
          g.fill();
        }
      }
      break;
    case 'stars': {
      const pts = makeStarShape(13, 5.5).getPoints();
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const cx = col * 64 + 16 + (row % 2) * 32;
          const cy = row * 64 + 20;
          g.beginPath();
          pts.forEach((p, i) => (i ? g.lineTo(cx + p.x, cy - p.y) : g.moveTo(cx + p.x, cy - p.y)));
          g.fill();
        }
      }
      break;
    }
    case 'plaid':
      g.globalAlpha = 0.32;
      for (let i = 0; i < 256; i += 64) {
        g.fillRect(i + 8, 0, 22, 256);
        g.fillRect(0, i + 8, 256, 22);
      }
      g.globalAlpha = 0.6;
      for (let i = 0; i < 256; i += 64) {
        g.fillRect(i + 44, 0, 3, 256);
        g.fillRect(0, i + 44, 256, 3);
      }
      g.globalAlpha = 1;
      break;
    default:
      break;
  }
  // Subtle paper grain.
  const rng = mulberry32(hashString(base + pattern));
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
    g.fillRect(rng() * 256, rng() * 256, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.4, 1.4);
  tex.anisotropy = 4;
  return tex;
}

function buildGift(item, index, envMap) {
  const rng = mulberry32(hashString(`${item.name}#${index}`));
  const s = priorityOf(item).scale;
  const w = (0.55 + rng() * 0.3) * s;
  const d = (0.5 + rng() * 0.3) * s;
  const h = (0.36 + rng() * 0.32) * s;
  const color = item.color || WRAP_COLORS[Math.floor(rng() * WRAP_COLORS.length)];
  const pattern = item.wrap || PATTERNS[Math.floor(rng() * PATTERNS.length)];
  const accent = item.accent || (isLightColor(color) ? '#b3202a' : '#f3ead8');
  let ribbon = item.ribbon;
  if (!ribbon) {
    const choices = RIBBON_COLORS.filter((c) => c.toLowerCase() !== color.toLowerCase() && c.toLowerCase() !== accent.toLowerCase());
    ribbon = choices[Math.floor(rng() * choices.length)];
  }

  const wrapMat = new THREE.MeshStandardMaterial({ map: makeWrapTexture(color, accent, pattern), roughness: 0.6 });
  const ribbonMat = new THREE.MeshStandardMaterial({ color: ribbon, metalness: 0.3, roughness: 0.45, envMap, envMapIntensity: 0.5 });
  const rw = 0.09 * s;

  const root = new THREE.Group();
  const slider = new THREE.Group();
  const box = new THREE.Group();
  root.add(slider);
  slider.add(box);
  box.rotation.y = (rng() - 0.5) * 0.6;

  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  mesh(new THREE.BoxGeometry(w, WALL, d), wrapMat, box, 0, WALL / 2, 0);

  // Four walls, each hinged at its bottom edge so it can fall outward.
  const walls = [];
  const addWall = (px, pz) => {
    const alongX = pz !== 0;
    const pivot = new THREE.Group();
    pivot.position.set(px, 0, pz);
    box.add(pivot);
    const width = alongX ? w : d;
    const ix = alongX ? 0 : -Math.sign(px) * WALL / 2;
    const iz = alongX ? -Math.sign(pz) * WALL / 2 : 0;
    mesh(alongX ? new THREE.BoxGeometry(width, h, WALL) : new THREE.BoxGeometry(WALL, h, width), wrapMat, pivot, ix, h / 2, iz);
    mesh(alongX ? new THREE.BoxGeometry(rw, h, WALL * 1.6) : new THREE.BoxGeometry(WALL * 1.6, h, rw), ribbonMat, pivot, ix, h / 2, iz);
    walls.push({ pivot, alongX, sign: Math.sign(alongX ? pz : px) });
  };
  addWall(0, d / 2);
  addWall(0, -d / 2);
  addWall(w / 2, 0);
  addWall(-w / 2, 0);

  // Lid with ribbon cross and bow.
  const lid = new THREE.Group();
  lid.position.y = h;
  box.add(lid);
  const lh = 0.09 * s;
  const ov = 0.02;
  mesh(new THREE.BoxGeometry(w + ov * 2, lh, d + ov * 2), wrapMat, lid, 0, lh / 2, 0);
  mesh(new THREE.BoxGeometry(rw, lh + 0.008, d + ov * 2 + 0.008), ribbonMat, lid, 0, lh / 2, 0);
  mesh(new THREE.BoxGeometry(w + ov * 2 + 0.008, lh + 0.008, rw), ribbonMat, lid, 0, lh / 2, 0);
  const loopGeo = new THREE.TorusGeometry(0.1 * s, 0.03 * s, 8, 24);
  [-1, 1].forEach((side) => {
    const loop = mesh(loopGeo, ribbonMat, lid, side * 0.085 * s, lh + 0.07 * s, 0);
    loop.rotation.set(0, side * 0.35, -side * 0.55);
    loop.scale.set(1, 0.72, 1);
  });
  mesh(new THREE.SphereGeometry(0.045 * s, 12, 8), ribbonMat, lid, 0, lh + 0.03 * s, 0);
  if (item.priority === 'high') {
    const topper = mesh(
      new THREE.ExtrudeGeometry(makeStarShape(0.1, 0.045), { depth: 0.02, bevelEnabled: false }).center(),
      new THREE.MeshStandardMaterial({ color: 0xffd36a, emissive: 0xffb420, emissiveIntensity: 1.6, metalness: 0.6, roughness: 0.3 }),
      lid, 0, lh + 0.24 * s, 0,
    );
    topper.castShadow = false;
  }

  const reveal = new THREE.Group();
  reveal.scale.setScalar(0.0001);
  slider.add(reveal);

  return { item, root, slider, box, walls, lid, reveal, h, size: Math.max(w, d, h), restYaw: box.rotation.y };
}

// Load a .glb and normalise it: optional rotation fix, centred, resting on y=0, fitted to `size`
// and no taller than `maxHeight`.
async function loadModel(url, rotationDeg, { size, maxHeight }, envMap) {
  const gltf = await gltfLoader.loadAsync(url);
  const obj = gltf.scene;
  if (Array.isArray(rotationDeg)) {
    obj.rotation.set(...rotationDeg.map((deg) => THREE.MathUtils.degToRad(deg || 0)));
  }
  obj.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(obj);
  const center = bounds.getCenter(new THREE.Vector3());
  const dims = bounds.getSize(new THREE.Vector3());
  obj.position.sub(new THREE.Vector3(center.x, bounds.min.y, center.z));
  obj.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => {
      if (!m || !m.isMeshStandardMaterial) return;
      // Generated models often come out fully metallic (the glTF default), which renders nearly black.
      if (m.metalness > 0.9 && !m.metalnessMap) {
        m.metalness = 0.1;
        m.roughness = Math.min(m.roughness, 0.7);
      }
      m.envMap = envMap;
      m.envMapIntensity = 0.6;
    });
  });
  const wrapper = new THREE.Group();
  wrapper.add(obj);
  wrapper.scale.setScalar(Math.min(size / (Math.max(dims.x, dims.y, dims.z) || 1), maxHeight / (dims.y || 1)));
  return wrapper;
}

export class GiftPile {
  constructor(items, { treeScale, envMap }) {
    this.group = new THREE.Group();
    this.gifts = [];
    this.byItem = new Map();
    this.pickables = [];
    this.envMap = envMap;
    this.sparkles = [];

    const ordered = items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => priorityOf(b.item).rank - priorityOf(a.item).rank || a.index - b.index);

    // Rings around the trunk. Partial rings form an arc facing the camera's starting position.
    let radius = 1.55 * treeScale + 0.25;
    let placed = 0;
    let ring = 0;
    while (placed < ordered.length) {
      const capacity = Math.max(1, Math.floor((2 * Math.PI * radius) / RING_SPACING));
      const count = Math.min(capacity, ordered.length - placed);
      const step = count === capacity ? (2 * Math.PI) / count : RING_SPACING / radius;
      const start = Math.PI / 2 - (step * (count - 1)) / 2 + (count === capacity ? (ring % 2) * step / 2 : 0);
      for (let j = 0; j < count; j++, placed++) {
        const { item, index } = ordered[placed];
        const gift = buildGift(item, index, envMap);
        const a = start + j * step;
        const onSkirt = radius < SKIRT_RADIUS * treeScale;
        gift.root.position.set(Math.cos(a) * radius, onSkirt ? 0.03 * treeScale : 0, Math.sin(a) * radius);
        gift.root.rotation.y = Math.atan2(gift.root.position.x, gift.root.position.z);
        // Inner-ring presents slide out from under the branches before unwrapping.
        gift.slideDist = Math.max(0.35, 2.15 * treeScale + 0.6 - radius);
        gift.progress = 0;
        gift.target = 0;
        gift.hover = 0;
        gift.hoverTarget = 0;
        gift.contentState = 'none';
        gift.mode = 'wrapped';
        gift.spin = 0;
        gift.root.traverse((o) => {
          if (o.isMesh) {
            o.userData.gift = gift;
            this.pickables.push(o);
          }
        });
        this.group.add(gift.root);
        this.gifts.push(gift);
        this.byItem.set(item, gift);
        if (item.model) this.#loadModel(gift, treeScale);
      }
      this.outerRadius = radius + 0.6;
      radius += RING_STEP;
      ring++;
    }
    this.outerRadius ??= 1.55 * treeScale + 0.85;
  }

  pick(raycaster) {
    // The raycaster ignores visibility, so skip the hidden boxes of unwrapped gifts.
    const visible = (o) => {
      for (; o; o = o.parent) if (!o.visible) return false;
      return true;
    };
    const hit = raycaster.intersectObjects(this.pickables, false).find((h) => visible(h.object));
    return hit ? hit.object.userData.gift : null;
  }

  setHover(gift) {
    this.gifts.forEach((g) => { g.hoverTarget = g === gift ? 1 : 0; });
  }

  open(gift) {
    gift.target = 1;
    if (gift.mode === 'wrapped') {
      this.#ensureContent(gift);
      this.#burst(gift);
    }
  }

  close(gift) {
    gift.target = 0;
  }

  // Where the camera should sit to look at an opened gift.
  focusPose(gift, { aspect, sideOffset }) {
    const portrait = aspect < 0.9;
    const out = new THREE.Vector3(gift.root.position.x, 0, gift.root.position.z);
    if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
    out.normalize();
    const base = gift.root.position.clone().addScaledVector(out, gift.slideDist);
    const target = base.add(new THREE.Vector3(0, 0.75, 0));
    if (portrait) target.y -= 0.8;
    const right = new THREE.Vector3().crossVectors(out.clone().negate(), new THREE.Vector3(0, 1, 0));
    target.addScaledVector(right, sideOffset);
    const position = target.clone().addScaledVector(out, portrait ? 4.4 * 0.9 * Math.max(1, 0.9 / aspect) : 4.4).add(new THREE.Vector3(0, 1.7, 0));
    return { target, position };
  }

  // Gifts with a model sit under the tree already unwrapped. The box shows until the model arrives
  // (and stays if it fails to load).
  #loadModel(gift, treeScale) {
    const { item } = gift;
    gift.contentState = 'loading';
    loadModel(item.model, item.modelRotation, { size: Math.max(0.8, gift.size * 1.15), maxHeight: 0.8 * treeScale }, this.envMap)
      .then((model) => {
        gift.reveal.add(model);
        model.traverse((o) => {
          if (o.isMesh) {
            o.userData.gift = gift;
            this.pickables.push(o);
          }
        });
        gift.contentState = 'model';
        gift.mode = 'unwrapped';
        gift.box.visible = false;
      })
      .catch((err) => {
        console.warn(`Couldn't load model for "${item.name}":`, err);
        gift.contentState = 'none';
        gift.modelFailed = true;
      });
  }

  // What a wrapped present reveals: its photo, or a golden star.
  #ensureContent(gift) {
    if (gift.contentState !== 'none') return;
    gift.contentState = 'loading';
    if (gift.item.image) this.#addImage(gift, gift.item.image);
    else this.#addPlaceholder(gift);
  }

  #addImage(gift, url) {
    textureLoader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
      sprite.center.set(0.5, 0);
      const aspect = tex.image.width / tex.image.height;
      const height = 1.1;
      sprite.scale.set(height * aspect, height, 1);
      sprite.position.y = 0.05;
      gift.reveal.add(sprite);
      gift.billboard = true;
      gift.contentState = 'image';
    }, undefined, () => this.#addPlaceholder(gift));
  }

  #addPlaceholder(gift) {
    const star = new THREE.Mesh(
      new THREE.ExtrudeGeometry(makeStarShape(0.32, 0.14), { depth: 0.08, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 }).center(),
      new THREE.MeshStandardMaterial({ color: 0xffd36a, emissive: 0xffb420, emissiveIntensity: 2, metalness: 0.5, roughness: 0.3 }),
    );
    star.position.y = 0.5;
    gift.reveal.add(star);
    gift.contentState = 'placeholder';
  }

  #burst(gift) {
    const count = 90;
    const pos = new Float32Array(count * 3);
    const vel = [];
    for (let i = 0; i < count; i++) {
      pos.set([0, gift.h, 0], i * 3);
      const a = Math.random() * Math.PI * 2;
      const up = 1.6 + Math.random() * 2.2;
      const out = 0.4 + Math.random() * 1.1;
      vel.push(new THREE.Vector3(Math.cos(a) * out, up, Math.sin(a) * out));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.08,
      map: sparkleTexture,
      color: new THREE.Color(0xffd27a).multiplyScalar(3),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    gift.slider.add(points);
    this.sparkles.push({ points, vel, age: -0.45 });
  }

  update(t, dt) {
    for (const g of this.gifts) {
      const speed = g.target > g.progress ? OPEN_SPEED : CLOSE_SPEED;
      g.progress += Math.sign(g.target - g.progress) * Math.min(Math.abs(g.target - g.progress), speed * dt);
      g.hover += (g.hoverTarget - g.hover) * Math.min(1, dt * 10);
      const p = g.progress;

      g.slider.position.z = easeInOut(segment(p, 0, 0.3)) * g.slideDist;

      if (g.mode === 'unwrapped') {
        // Lift and spin while selected, then settle back to its resting angle.
        const lift = easeOutBack(segment(p, 0.15, 0.7));
        g.reveal.visible = true;
        g.reveal.scale.setScalar(1);
        g.reveal.position.y = g.hover * (1 - p) * 0.08 + lift * (0.35 + Math.sin(t * 1.6) * 0.05);
        if (g.target === 1) g.spin += dt * 0.55 * p;
        else g.spin += (Math.round(g.spin / (Math.PI * 2)) * Math.PI * 2 - g.spin) * Math.min(1, dt * 3);
        g.reveal.rotation.y = g.restYaw + g.spin;
        continue;
      }

      g.box.position.y = g.hover * (1 - p) * 0.08;

      const lidP = easeOut(segment(p, 0.22, 0.52));
      const lidShrink = segment(p, 0.38, 0.55);
      g.lid.position.y = g.h + lidP * 1.4;
      g.lid.rotation.set(lidP * 0.5, lidP * 2.4, lidP * 0.7);
      g.lid.scale.setScalar(Math.max(0.0001, 1 - lidShrink));
      g.lid.visible = lidShrink < 1;

      const angle = easeOutBack(segment(p, 0.36, 0.72)) * (Math.PI / 2 - 0.03);
      for (const wall of g.walls) {
        if (wall.alongX) wall.pivot.rotation.x = wall.sign * angle;
        else wall.pivot.rotation.z = -wall.sign * angle;
      }

      const revealP = easeOutBack(segment(p, 0.55, 1));
      g.reveal.scale.setScalar(Math.max(0.0001, revealP));
      g.reveal.position.y = WALL + revealP * (0.22 + Math.sin(t * 1.6) * 0.05);
      g.reveal.visible = revealP > 0.001;
      if (!g.billboard && p > 0.5) g.reveal.rotation.y += dt * 0.55;
    }

    this.sparkles = this.sparkles.filter((s) => {
      s.age += dt;
      if (s.age < 0) return true;
      const attr = s.points.geometry.attributes.position;
      for (let i = 0; i < s.vel.length; i++) {
        s.vel[i].y -= 3.2 * dt;
        attr.setXYZ(i, attr.getX(i) + s.vel[i].x * dt, attr.getY(i) + s.vel[i].y * dt, attr.getZ(i) + s.vel[i].z * dt);
      }
      attr.needsUpdate = true;
      s.points.material.opacity = Math.max(0, 1 - s.age / 1.4);
      if (s.age > 1.4) {
        s.points.removeFromParent();
        s.points.geometry.dispose();
        s.points.material.dispose();
        return false;
      }
      return true;
    });
  }
}
