import * as THREE from 'three';
import { mulberry32, softDotTexture } from './util.js';
import { currentHour, skyAt, moonPhase } from './daytime.js';

const MOON_RADIUS = 7;

// Where the moon hangs: low in the sky, just left of the tree in the opening view.
// Narrow (phone) screens get it closer to the tree and a little lower, clear of the title.
function moonPosition(aspect) {
  const halfHFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(22.5)) * aspect);
  const azimuth = THREE.MathUtils.clamp(halfHFov * 0.72, THREE.MathUtils.degToRad(7), THREE.MathUtils.degToRad(21));
  const elevation = THREE.MathUtils.degToRad(aspect < 0.9 ? 4.5 : 7);
  const d = 150;
  return new THREE.Vector3(-Math.sin(azimuth) * d, 4 + Math.tan(elevation) * d, -Math.cos(azimuth) * d);
}
// Moonlight comes from the front-left so the tree isn't backlit at night.
const MOONLIGHT_DIR = new THREE.Vector3(-8, 16, 6).normalize();

const MOON_SHADER = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float phase;     // 0 new, 0.5 full
    uniform float dark;      // how dark the sky is: 0 day, 1 night
    uniform vec3 color;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      vec3 n = vec3(p, sqrt(1.0 - r2));
      float a = phase * 6.2831853;
      vec3 sun = vec3(sin(a), 0.0, -cos(a));      // waxing = lit from the right
      float lit = smoothstep(-0.04, 0.12, dot(n, sun));
      float maria = noise(p * 3.0 + 4.0) * 0.65 + noise(p * 8.0) * 0.35;
      float albedo = mix(1.0, 0.68, smoothstep(0.45, 0.72, maria));
      float limb = mix(0.72, 1.0, n.z);
      vec3 col = color * albedo * limb * max(lit, 0.05 * dark);
      float edge = smoothstep(1.0, 0.94, r2);
      // At night the unlit side still blocks stars; by day it disappears into the blue.
      float alpha = edge * mix(lit, max(lit, 0.92), dark * dark) * mix(0.55, 1.0, dark);
      gl_FragColor = vec4(col, alpha);
    }`,
};

// Sky that follows the viewer's clock, the moon (in its real phase), sun, snowy ground,
// distant pines and falling snow. `festive` (0..1, see season.js) controls how heavy the snow is.
export function createWorld(scene, { extent, festive = 1, aspect = 16 / 9 }) {
  const rng = mulberry32(2026);
  const sky = skyAt(currentHour(), {});
  const horizon = sky.horizon.clone();
  const fogDensity = THREE.MathUtils.lerp(0.016, 0.022, festive);
  scene.fog = new THREE.FogExp2(horizon, fogDensity);

  // Sky dome with a vertical gradient.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(200, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: sky.top.clone() },
        bottom: { value: horizon },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 bottom;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          gl_FragColor = vec4(mix(bottom, top, pow(h, 0.55)), 1.0);
        }`,
    }),
  );
  dome.renderOrder = -2;
  scene.add(dome);

  // Stars.
  const starCount = 1400;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(0.08 + rng() * 0.92);
    starPos.set([
      Math.sin(phi) * Math.cos(theta) * 180,
      Math.cos(phi) * 180,
      Math.sin(phi) * Math.sin(theta) * 180,
    ], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xdfe6ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85, depthWrite: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -1;
  scene.add(stars);

  // Moon: a lit sphere drawn on a camera-facing disc, plus a soft glow.
  const phase = moonPhase();
  const fullness = (1 - Math.cos(phase * Math.PI * 2)) / 2; // 0 new → 1 full
  const moonMat = new THREE.ShaderMaterial({
    ...MOON_SHADER,
    uniforms: {
      phase: { value: phase },
      dark: { value: 1 },
      color: { value: new THREE.Color(0xfff4dc).multiplyScalar(1.3) },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const moon = new THREE.Mesh(new THREE.PlaneGeometry(MOON_RADIUS * 2, MOON_RADIUS * 2), moonMat);
  const moonPos = moonPosition(aspect);
  moon.position.copy(moonPos);
  scene.add(moon);
  const glowTex = softDotTexture();
  const moonGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xbfd0ff, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  moonGlow.scale.setScalar(MOON_RADIUS * 6);
  moonGlow.position.copy(moonPos);
  scene.add(moonGlow);

  // Sun: a glowing disc that follows the time of day.
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: new THREE.Color(0xfff2d6).multiplyScalar(4), transparent: true, depthWrite: false, fog: false,
  }));
  sun.scale.setScalar(26);
  scene.add(sun);

  // Ground: flat around the tree, gentle snow drifts further out.
  const heightAt = (x, z) => {
    const drift = (Math.sin(x * 0.3) * Math.cos(z * 0.27) + Math.sin(x * 0.11 + z * 0.07)) * 0.3;
    return drift * THREE.MathUtils.smoothstep(Math.hypot(x, z), extent + 3, extent + 12);
  };
  const groundGeo = new THREE.PlaneGeometry(160, 160, 160, 160);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, heightAt(gp.getX(i), gp.getZ(i)));
  groundGeo.computeVertexNormals();
  // A thin frosty dusting in early November, deep white snow by Christmas.
  const groundColor = new THREE.Color(0x9fadb8).lerp(new THREE.Color(0xe6edf7), festive);
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ color: groundColor, roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);

  // Distant pine forest.
  const pineCount = 140;
  const pineGeo = new THREE.ConeGeometry(1, 1, 7);
  pineGeo.translate(0, 0.5, 0);
  const pines = new THREE.InstancedMesh(pineGeo, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), pineCount);
  const dummy = new THREE.Object3D();
  const pineGreen = new THREE.Color(0x10291d);
  const pineSnow = new THREE.Color(0x8a9bb0);
  const pineColor = new THREE.Color();
  for (let i = 0; i < pineCount; i++) {
    const a = rng() * Math.PI * 2;
    const r = extent + 22 + rng() * 50;
    const h = 4 + rng() * 6;
    dummy.position.set(Math.cos(a) * r, -0.2, Math.sin(a) * r);
    dummy.scale.set(h * 0.32, h, h * 0.32);
    dummy.updateMatrix();
    pines.setMatrixAt(i, dummy.matrix);
    pines.setColorAt(i, pineColor.copy(pineGreen).lerp(pineSnow, festive * (0.3 + rng() * 0.5)));
  }
  scene.add(pines);

  // Lights: sky fill plus one key light that is the sun by day and the moon by night.
  const hemi = new THREE.HemisphereLight(0x6b7fb8, 0x262c40, 0.9);
  scene.add(hemi);
  const keyLight = new THREE.DirectionalLight(0xa9bcff, 1.1);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  const s = extent + 3;
  Object.assign(keyLight.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 60 });
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight);

  // Falling snow.
  const flakeMax = 4000;
  const flakeCount = Math.round(flakeMax * THREE.MathUtils.lerp(0.15, 1, festive));
  const area = Math.max(22, extent * 3);
  const height = 18;
  const flakePos = new Float32Array(flakeCount * 3);
  const fallSpeed = THREE.MathUtils.lerp(0.8, 1.15, festive);
  const flakeSpeed = new Float32Array(flakeCount);
  const flakePhase = new Float32Array(flakeCount);
  for (let i = 0; i < flakeCount; i++) {
    flakePos.set([(rng() - 0.5) * 2 * area, rng() * height, (rng() - 0.5) * 2 * area], i * 3);
    flakeSpeed[i] = (0.35 + rng() * 0.7) * fallSpeed;
    flakePhase[i] = rng() * Math.PI * 2;
  }
  const flakeGeo = new THREE.BufferGeometry();
  flakeGeo.setAttribute('position', new THREE.BufferAttribute(flakePos, 3));
  const snow = new THREE.Points(flakeGeo, new THREE.PointsMaterial({
    size: 0.09, map: softDotTexture(), transparent: true, depthWrite: false, opacity: 0.9,
  }));
  snow.frustumCulled = false;
  scene.add(snow);

  const keyDir = new THREE.Vector3();
  let lastSky = -Infinity;

  function applySky(hour) {
    skyAt(hour, sky);
    dome.material.uniforms.top.value.copy(sky.top);
    horizon.copy(sky.horizon);
    scene.fog.color.copy(sky.horizon);
    hemi.color.copy(sky.hemiSky);
    hemi.groundColor.copy(sky.hemiGround);
    hemi.intensity = sky.hemi;
    keyLight.color.copy(sky.light);
    keyLight.intensity = sky.lightI;
    // Below the horizon the sun hands over to moonlight from the front-left.
    const sunUp = Math.max(sky.sunDir.y, 0.12);
    keyDir.set(sky.sunDir.x, sunUp, sky.sunDir.z).normalize().lerp(MOONLIGHT_DIR, 1 - sky.daylight).normalize();
    keyLight.position.copy(keyDir).multiplyScalar(25);
    starMat.opacity = 0.85 * sky.stars;
    stars.visible = sky.stars > 0.01;
    const night = 1 - sky.daylight;
    moonMat.uniforms.dark.value = sky.stars;
    // Clearer air by day, so the forest doesn't fade into a whiteout.
    scene.fog.density = fogDensity * THREE.MathUtils.lerp(1, 0.5, sky.daylight);
    moonGlow.material.opacity = 0.35 * fullness * night;
    sun.position.copy(sky.sunDir).multiplyScalar(170);
    sun.visible = sky.sunDir.y > -0.05;
  }
  applySky(currentHour());

  function update(t, dt, camera) {
    // The clock moves slowly; re-blend the sky a couple of times a second.
    if (t - lastSky > 0.5) {
      lastSky = t;
      applySky(currentHour());
    }
    moon.quaternion.copy(camera.quaternion);
    for (let i = 0; i < flakeCount; i++) {
      const k = i * 3;
      flakePos[k] += Math.sin(t * 0.6 + flakePhase[i]) * 0.18 * dt;
      flakePos[k + 1] -= flakeSpeed[i] * dt;
      if (flakePos[k + 1] < 0) flakePos[k + 1] += height;
    }
    flakeGeo.attributes.position.needsUpdate = true;
  }

  return { update, heightAt, sky };
}
