import * as THREE from 'three';
import { mulberry32 } from './util.js';

// Every so often a small group of reindeer wanders across the snowfield behind the tree,
// sometimes stopping to graze. ?reindeer=now sends one out straight away.

const HERD_MAX = 3;
const WALK_SPEED = 1.1;      // world units per second
const FIRST_VISIT = [6, 14]; // seconds after load
const BETWEEN = [25, 70];    // seconds between visits

const UP = new THREE.Vector3(0, 1, 0);

// A cylinder running from `a` to `b`.
function limb(a, b, r0, r1, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, dir.length(), 6), mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  mesh.castShadow = true;
  return mesh;
}

function blob(r, sx, sy, sz, mat, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 7), mat);
  mesh.scale.set(sx, sy, sz);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

// One reindeer facing +x, hooves at y = 0, about 1.6 units to the antler tips.
function buildReindeer(rng) {
  const coat = new THREE.Color(0x6e4b33).offsetHSL((rng() - 0.5) * 0.02, 0, (rng() - 0.5) * 0.08);
  const mats = {
    coat: new THREE.MeshStandardMaterial({ color: coat, roughness: 0.95, flatShading: true }),
    legs: new THREE.MeshStandardMaterial({ color: coat.clone().multiplyScalar(0.7), roughness: 0.95, flatShading: true }),
    cream: new THREE.MeshStandardMaterial({ color: 0xe8dccb, roughness: 1, flatShading: true }),
    antler: new THREE.MeshStandardMaterial({ color: 0xcbb38f, roughness: 0.8, flatShading: true }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1d1612, roughness: 0.6 }),
  };
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  body.add(blob(0.5, 1.25, 0.62, 0.55, mats.coat, 0, 1.05, 0));
  body.add(blob(0.3, 0.9, 1.05, 0.95, mats.cream, 0.5, 1.12, 0));       // chest ruff
  body.add(blob(0.09, 1, 1, 1, mats.cream, -0.62, 1.16, 0));           // tail

  // Neck and head hang off a pivot so the head can dip down to graze.
  const neck = new THREE.Group();
  neck.position.set(0.55, 1.22, 0);
  body.add(neck);
  neck.add(limb(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.3, 0.45, 0), 0.16, 0.11, mats.coat));
  const head = new THREE.Group();
  head.position.set(0.32, 0.5, 0);
  neck.add(head);
  head.add(blob(0.17, 1.45, 0.85, 0.8, mats.coat, 0.1, 0, 0));
  head.add(blob(0.1, 1.2, 0.9, 0.9, mats.cream, 0.3, -0.05, 0));       // muzzle
  head.add(blob(0.04, 1, 1, 1, mats.dark, 0.41, -0.03, 0));             // nose
  for (const side of [-1, 1]) {
    head.add(blob(0.025, 1, 1, 1, mats.dark, 0.17, 0.07, side * 0.11)); // eye
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.13, 5), mats.coat);
    ear.position.set(-0.03, 0.1, side * 0.13);
    ear.rotation.set(side * 1.0, 0, -0.4);
    head.add(ear);
    // Antlers: a swept-back beam with a few tines.
    const s = new THREE.Vector3(-0.02, 0.12, side * 0.07);
    const e1 = s.clone().add(new THREE.Vector3(-0.2, 0.42, side * 0.22));
    const e2 = e1.clone().add(new THREE.Vector3(0.14, 0.26, side * 0.08));
    head.add(limb(s, e1, 0.03, 0.024, mats.antler));
    head.add(limb(e1, e2, 0.024, 0.014, mats.antler));
    const mid = s.clone().lerp(e1, 0.55);
    head.add(limb(mid, mid.clone().add(new THREE.Vector3(0.16, 0.13, side * 0.02)), 0.018, 0.01, mats.antler));
    head.add(limb(e1, e1.clone().add(new THREE.Vector3(0.12, 0.08, side * 0.12)), 0.016, 0.009, mats.antler));
    head.add(limb(s, s.clone().add(new THREE.Vector3(0.14, 0.04, 0)), 0.016, 0.009, mats.antler)); // brow tine
  }

  // Legs swing from the hips.
  const legs = [];
  for (const [x, z, front] of [[0.42, 0.17, 1], [0.42, -0.17, 1], [-0.42, 0.17, 0], [-0.42, -0.17, 0]]) {
    const hip = new THREE.Group();
    hip.position.set(x, 0.9, z);
    body.add(hip);
    hip.add(limb(new THREE.Vector3(0, 0.05, 0), new THREE.Vector3(front ? 0.02 : -0.04, -0.48, 0), 0.08, 0.055, mats.legs));
    hip.add(limb(new THREE.Vector3(front ? 0.02 : -0.04, -0.48, 0), new THREE.Vector3(0, -0.86, 0), 0.05, 0.04, mats.legs));
    hip.add(blob(0.06, 1.2, 0.6, 1, mats.dark, 0.02, -0.88, 0));         // hoof
    legs.push(hip);
  }
  return { root, body, neck, head, legs, gait: rng() * Math.PI * 2 };
}

export class ReindeerHerd {
  constructor(scene, { extent, heightAt }) {
    this.rng = mulberry32(Date.now() & 0xffffffff);
    this.extent = extent;
    this.heightAt = heightAt;
    this.deer = Array.from({ length: HERD_MAX }, () => buildReindeer(this.rng));
    for (const d of this.deer) {
      d.root.visible = false;
      scene.add(d.root);
    }
    this.active = null;
    const now = new URLSearchParams(location.search).get('reindeer') === 'now';
    this.timer = now ? 0.5 : FIRST_VISIT[0] + this.rng() * (FIRST_VISIT[1] - FIRST_VISIT[0]);
    this.dir = new THREE.Vector3();
    this.side = new THREE.Vector3();
  }

  // Send a group across, behind the tree as seen from where the camera is now.
  spawn(camera, target) {
    const rng = this.rng;
    const toward = new THREE.Vector3().subVectors(target, camera.position).setY(0);
    if (toward.lengthSq() < 1e-6) toward.set(0, 0, -1);
    toward.normalize();
    const center = toward.clone().multiplyScalar(this.extent + 5 + rng() * 6);
    // Start and finish just outside the visible width, so phones don't wait for walkers far off-screen.
    const depth = camera.position.clone().setY(0).distanceTo(center);
    const halfHFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
    const span = depth * Math.tan(halfHFov) + 3;
    const sign = rng() < 0.5 ? -1 : 1;
    this.dir.set(-toward.z, 0, toward.x).multiplyScalar(sign);
    this.side.copy(toward);
    const count = 1 + Math.floor(rng() * HERD_MAX);
    const start = center.clone().addScaledVector(this.dir, -span);
    this.active = {
      start,
      span,
      distance: 0,
      speed: WALK_SPEED * (0.85 + rng() * 0.3),
      grazeAt: rng() < 0.65 ? span * (0.7 + rng() * 0.5) : Infinity,
      grazeFor: 4 + rng() * 4,
      grazing: 0,
      members: this.deer.slice(0, count).map((d, i) => ({
        d,
        lag: i * (1.4 + rng() * 0.8),
        offset: (rng() - 0.5) * 1.8,
        scale: 0.8 + rng() * 0.25,
        neckDip: 0,
      })),
    };
    const yaw = Math.atan2(-this.dir.z, this.dir.x);
    for (const m of this.active.members) {
      m.d.root.visible = true;
      m.d.root.rotation.y = yaw;
      m.d.root.scale.setScalar(m.scale);
    }
  }

  update(t, dt, camera, target) {
    if (!this.active) {
      this.timer -= dt;
      if (this.timer <= 0) this.spawn(camera, target);
      return;
    }
    const herd = this.active;
    const grazingNow = herd.distance >= herd.grazeAt && herd.grazing < herd.grazeFor;
    if (grazingNow) herd.grazing += dt;
    else herd.distance += herd.speed * dt;

    let allGone = true;
    for (const m of herd.members) {
      const { d } = m;
      const s = herd.distance - m.lag;
      const pos = herd.start.clone().addScaledVector(this.dir, Math.max(s, 0)).addScaledVector(this.side, m.offset);
      d.root.position.set(pos.x, this.heightAt(pos.x, pos.z), pos.z);
      d.root.visible = s > 0 && s < herd.span * 2;
      if (s < herd.span * 2) allGone = false;

      // Walk cycle: diagonal leg pairs swing together, the body bobs a little.
      const walking = !grazingNow && s > 0;
      if (walking) d.gait += dt * herd.speed * 5.5;
      const swing = walking ? Math.sin(d.gait) * 0.45 : 0;
      d.legs[0].rotation.z = swing;
      d.legs[3].rotation.z = swing;
      d.legs[1].rotation.z = -swing;
      d.legs[2].rotation.z = -swing;
      d.body.position.y = walking ? Math.abs(Math.cos(d.gait)) * 0.035 : 0;
      m.neckDip += ((grazingNow ? 1 : 0) - m.neckDip) * Math.min(1, dt * 2.5);
      d.neck.rotation.z = -m.neckDip * 1.75 + (walking ? Math.sin(d.gait * 2) * 0.04 : 0);
      d.head.rotation.z = -m.neckDip * 0.6;
    }
    if (allGone) {
      for (const m of herd.members) m.d.root.visible = false;
      this.active = null;
      this.timer = BETWEEN[0] + this.rng() * (BETWEEN[1] - BETWEEN[0]);
    }
  }
}
