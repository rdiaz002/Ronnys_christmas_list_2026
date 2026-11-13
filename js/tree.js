import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, makeStarShape, segment } from './util.js';

// The tree is modelled at unit scale and the whole group is scaled up as the list grows.
const LAYERS = 7;
const BASE_Y = 1.05;
const BASE_R = 2.0;
const STEP = 0.56;
export const SKIRT_RADIUS = 2.1;

const LAYER_DEFS = Array.from({ length: LAYERS }, (_, i) => {
  const f = i / (LAYERS - 1);
  const bottom = BASE_Y + i * STEP;
  const height = STEP * 2.3 * (1 - f * 0.25);
  return { bottom, height, top: bottom + height, radius: BASE_R * (1 - f * 0.82) };
});
const TREE_TOP = LAYER_DEFS[LAYERS - 1].top;

// Outer silhouette radius of the (undeformed) tree at height y.
function radiusAt(y) {
  let r = 0;
  for (const L of LAYER_DEFS) {
    if (y >= L.bottom && y <= L.top) r = Math.max(r, (L.radius * (L.top - y)) / L.height);
  }
  return r;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// `festive` (0..1, see season.js) sets how much snow and how many decorations are on the tree.
export function createTree({ scale = 1, envMap, festive = 1 }) {
  const rng = mulberry32(1225);
  const group = new THREE.Group();
  const lerp = THREE.MathUtils.lerp;
  const snowColor = new THREE.Color(0xeef3fa);

  // Trunk and skirt.
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.27, 1.4, 12),
    new THREE.MeshStandardMaterial({ color: 0x4a2f1d, roughness: 0.95 }),
  );
  trunk.position.y = 0.7;
  trunk.castShadow = true;
  group.add(trunk);

  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(SKIRT_RADIUS, SKIRT_RADIUS + 0.05, 0.03, 64),
    new THREE.MeshStandardMaterial({ color: 0x7a1420, roughness: 1 }),
  );
  skirt.position.y = 0.015;
  skirt.receiveShadow = true;
  group.add(skirt);
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(SKIRT_RADIUS + 0.03, 0.06, 8, 96),
    new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 1 }),
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 0.03;
  group.add(trim);

  // Branch layers: open cones with jagged, drooping tips, and patches of snow on the outer branches.
  const snowCover = festive * 0.3;
  LAYER_DEFS.forEach((L, i) => {
    const geo = new THREE.ConeGeometry(L.radius, L.height, 56, 6, true);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const green = new THREE.Color(0x1d4f2c).offsetHSL(0, 0, (rng() - 0.5) * 0.03);
    const v = new THREE.Vector3();
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k);
      const u = 0.5 - v.y / L.height; // 0 at the apex, 1 at the rim
      const ang = Math.atan2(v.z, v.x);
      const tips = Math.pow(0.5 + 0.5 * Math.cos(ang * 16 + i * 1.7), 2);
      const noise = Math.sin(ang * 29 + i * 3.1 + v.y * 9) * Math.cos(ang * 13 - v.y * 5);
      const s = 1 + u * u * (0.16 * tips - 0.04) + noise * 0.05 * u;
      const patch = 0.5 + 0.5 * Math.sin(ang * 41 + i * 7.3) * Math.cos(ang * 17 - v.y * 11 + i);
      (u > 0.3 && patch < snowCover ? snowColor : green).toArray(colors, k * 3);
      v.x *= s;
      v.z *= s;
      v.y -= u * u * L.height * (0.1 + 0.12 * tips);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = L.bottom + L.height / 2;
    mesh.castShadow = true;
    group.add(mesh);
  });

  // Needle tufts for a bushier silhouette, more of them snow-dusted as Christmas nears.
  const tuftCount = 1500;
  const tuftSnow = 0.03 + festive * 0.22;
  const tuftGeo = new THREE.ConeGeometry(0.05, 0.34, 5);
  tuftGeo.rotateX(Math.PI / 2);
  const tufts = new THREE.InstancedMesh(tuftGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), tuftCount);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const totalR = LAYER_DEFS.reduce((sum, L) => sum + L.radius, 0);
  for (let i = 0; i < tuftCount; i++) {
    let pick = rng() * totalR;
    const L = LAYER_DEFS.find((d) => (pick -= d.radius) <= 0) || LAYER_DEFS[0];
    const u = 0.3 + 0.7 * Math.sqrt(rng());
    const a = rng() * Math.PI * 2;
    const r = L.radius * u;
    const y = L.top - u * L.height - u * u * L.height * 0.16;
    dummy.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    dummy.lookAt(dummy.position.x + Math.cos(a), y - 0.4, dummy.position.z + Math.sin(a));
    dummy.scale.setScalar(0.7 + rng() * 0.6);
    dummy.updateMatrix();
    tufts.setMatrixAt(i, dummy.matrix);
    if (rng() < tuftSnow) color.setHSL(0.58, 0.2, 0.85);
    else color.setHSL(0.36 + rng() * 0.04, 0.45, 0.14 + rng() * 0.08);
    tufts.setColorAt(i, color);
  }
  tufts.castShadow = true;
  group.add(tufts);

  // Glass baubles: a handful on Nov 1, the full set by Christmas Eve.
  const baubleColors = [0xb3202a, 0xd9a83c, 0xc8ccd6, 0x8e1b2c, 0xe9c46a, 0x2a4f8f].map((c) => new THREE.Color(c));
  const baubleMax = 64;
  const baubles = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshStandardMaterial({ metalness: 0.85, roughness: 0.18, envMap, envMapIntensity: 1.2 }),
    baubleMax,
  );
  for (let i = 0; i < baubleMax; i++) {
    const y = BASE_Y + 0.25 + rng() * (TREE_TOP - BASE_Y - 0.8);
    const a = rng() * Math.PI * 2;
    const r = radiusAt(y) * 0.95;
    dummy.position.set(Math.cos(a) * r, y - 0.1, Math.sin(a) * r);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(0.08 + 0.05 * (1 - y / TREE_TOP) + rng() * 0.025);
    dummy.updateMatrix();
    baubles.setMatrixAt(i, dummy.matrix);
    baubles.setColorAt(i, baubleColors[Math.floor(rng() * baubleColors.length)]);
  }
  baubles.count = Math.round(lerp(6, baubleMax, festive));
  baubles.castShadow = true;
  group.add(baubles);

  // Spiral string of twinkling lights. Slots are shuffled so a partial string is spread evenly.
  const bulbMax = 240;
  const turns = 8.5;
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.038, 8, 6), new THREE.MeshBasicMaterial(), bulbMax);
  const bulbBase = [];
  const bulbPhase = [];
  const bulbSpeed = [];
  const warm = new THREE.Color(0xffc98a);
  const multi = [0xff5a4a, 0x5adf7a, 0x5aa8ff, 0xffb347].map((c) => new THREE.Color(c));
  const slots = shuffle(Array.from({ length: bulbMax }, (_, i) => i / bulbMax), rng);
  slots.forEach((f, i) => {
    const y = BASE_Y + 0.1 + f * (TREE_TOP - BASE_Y - 0.45);
    const a = f * turns * Math.PI * 2;
    const r = radiusAt(y) + 0.02;
    dummy.position.set(Math.cos(a) * r, y - 0.05, Math.sin(a) * r);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    bulbs.setMatrixAt(i, dummy.matrix);
    bulbBase.push(rng() < 0.65 ? warm : multi[Math.floor(rng() * multi.length)]);
    bulbPhase.push(rng() * Math.PI * 2);
    bulbSpeed.push(0.8 + rng() * 2.2);
    bulbs.setColorAt(i, bulbBase[i]);
  });
  bulbs.count = Math.round(lerp(40, bulbMax, festive));
  group.add(bulbs);

  // Gold bead garlands, swagged around the tree and hung bottom-up from about mid-November.
  const strandHeights = [1.55, 2.25, 2.95, 3.6, 4.2, 4.75];
  const beadPositions = [];
  strandHeights.forEach((h, k) => {
    const swags = Math.max(3, Math.round(radiusAt(h) * 4.5));
    const offset = k * 0.7;
    for (let s = 0; s < swags; s++) {
      const a0 = offset + (s / swags) * Math.PI * 2;
      const a1 = offset + ((s + 1) / swags) * Math.PI * 2;
      const arc = radiusAt(h) * (a1 - a0);
      const beads = Math.max(6, Math.round(arc / 0.055));
      for (let b = 0; b < beads; b++) {
        const t = b / beads;
        const y = h - 0.2 * Math.sin(Math.PI * t);
        const a = lerp(a0, a1, t);
        const r = radiusAt(y) + 0.035;
        beadPositions.push([Math.cos(a) * r, y, Math.sin(a) * r]);
      }
    }
  });
  const beads = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.022, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xe0b44c, metalness: 0.9, roughness: 0.25, envMap, envMapIntensity: 1.3 }),
    beadPositions.length,
  );
  beadPositions.forEach(([x, y, z], i) => {
    dummy.position.set(x, y, z);
    dummy.updateMatrix();
    beads.setMatrixAt(i, dummy.matrix);
  });
  beads.count = Math.floor(beadPositions.length * segment(festive, 0.3, 0.85));
  group.add(beads);

  // Red velvet bows for the final stretch.
  const loop = new THREE.TorusGeometry(0.075, 0.025, 6, 16);
  const loopL = loop.clone().scale(1, 0.7, 1).rotateZ(0.5).translate(-0.065, 0.02, 0);
  const loopR = loop.clone().scale(1, 0.7, 1).rotateZ(-0.5).translate(0.065, 0.02, 0);
  const tailL = new THREE.BoxGeometry(0.035, 0.13, 0.015).rotateZ(-0.35).translate(-0.03, -0.07, 0);
  const tailR = new THREE.BoxGeometry(0.035, 0.13, 0.015).rotateZ(0.35).translate(0.03, -0.07, 0);
  const knot = new THREE.SphereGeometry(0.03, 8, 6);
  const bowGeo = mergeGeometries([loopL, loopR, tailL, tailR, knot]);
  const bowMax = 18;
  const bows = new THREE.InstancedMesh(bowGeo, new THREE.MeshStandardMaterial({ color: 0xa3121f, roughness: 0.6 }), bowMax);
  for (let i = 0; i < bowMax; i++) {
    const y = BASE_Y + 0.4 + ((i + rng() * 0.8) / bowMax) * (TREE_TOP - BASE_Y - 1.1);
    const a = i * 2.39996 + rng() * 0.4; // golden-angle spread
    const r = radiusAt(y) * 1.04 + 0.04;
    dummy.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    dummy.lookAt(dummy.position.x * 2, y, dummy.position.z * 2);
    dummy.scale.setScalar(1.5);
    dummy.updateMatrix();
    bows.setMatrixAt(i, dummy.matrix);
  }
  // Bows go up from the bottom of the tree first.
  bows.count = Math.round(bowMax * segment(festive, 0.55, 1));
  bows.castShadow = true;
  group.add(bows);

  // Star topper, glowing brighter as the day gets closer.
  const starGlow = lerp(0.7, 2.4, festive);
  const star = new THREE.Mesh(
    new THREE.ExtrudeGeometry(makeStarShape(0.36, 0.15), {
      depth: 0.08, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2,
    }).center(),
    new THREE.MeshStandardMaterial({ color: 0xffd36a, emissive: 0xffb420, emissiveIntensity: starGlow, metalness: 0.5, roughness: 0.3 }),
  );
  star.position.y = TREE_TOP + 0.28;
  group.add(star);
  const starLight = new THREE.PointLight(0xffd27a, 4, 6, 1.5);
  starLight.position.copy(star.position);
  group.add(starLight);

  // Warm glow from the lights spilling onto the presents.
  const glowBase = lerp(4, 7, festive);
  const glows = [0, 1, 2].map((i) => {
    const light = new THREE.PointLight(0xffa860, glowBase, 10, 1.4);
    const a = (i / 3) * Math.PI * 2 + 0.5;
    light.position.set(Math.cos(a) * 2.6, 2.4, Math.sin(a) * 2.6);
    group.add(light);
    return light;
  });

  group.scale.setScalar(scale);

  const tmp = new THREE.Color();
  function update(t) {
    for (let i = 0; i < bulbs.count; i++) {
      const w = 0.5 + 0.5 * Math.sin(t * bulbSpeed[i] + bulbPhase[i]);
      bulbs.setColorAt(i, tmp.copy(bulbBase[i]).multiplyScalar(1.4 + 2.6 * w * w));
    }
    bulbs.instanceColor.needsUpdate = true;
    star.rotation.y = Math.sin(t * 0.4) * 0.5;
    starLight.intensity = (starGlow / 2.4) * (4 + Math.sin(t * 2.3) * 0.6);
    glows.forEach((g, i) => { g.intensity = glowBase + Math.sin(t * 3.1 + i * 2) * 0.6 + Math.sin(t * 7.3 + i) * 0.3; });
  }

  return { group, height: (TREE_TOP + 0.6) * scale, update };
}
