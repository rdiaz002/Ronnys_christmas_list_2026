import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createWorld } from './world.js';
import { createTree } from './tree.js';
import { GiftPile } from './gifts.js';
import { initUI } from './ui.js';
import { festiveLevel } from './season.js';
import { ReindeerHerd } from './reindeer.js';
import { easeInOut } from './util.js';

const ui = initUI();

async function loadList() {
  const res = await fetch('gifts.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  let data;
  try {
    data = await loadList();
  } catch (err) {
    ui.fatal(`Couldn't load gifts.json (${err.message}). If you opened index.html straight from disk, start a local server instead — see the README.`);
    throw err;
  }
  const items = (data.gifts || []).filter((g) => g && g.name);
  ui.setTitle(data.title, data.subtitle);
  ui.startCountdown();

  const canvas = document.getElementById('scene');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    ui.renderList(items);
    ui.noWebGL();
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;

  // The tree grows with the list.
  const treeScale = THREE.MathUtils.clamp(1 + (items.length - 1) * 0.05, 1, 1.9);
  // More snow and decorations the closer it gets to Christmas.
  const festive = festiveLevel();
  const scene = new THREE.Scene();
  const tree = createTree({ scale: treeScale, envMap, festive });
  const pile = new GiftPile(items, { treeScale, envMap });
  const world = createWorld(scene, { extent: pile.outerRadius, festive, aspect: window.innerWidth / window.innerHeight });
  const reindeer = new ReindeerHerd(scene, { extent: pile.outerRadius, heightAt: world.heightAt });
  scene.add(tree.group, pile.group);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 2.2;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  function overviewPose(azimuth = 0) {
    const aspect = window.innerWidth / window.innerHeight;
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const halfHFov = Math.atan(Math.tan(halfFov) * aspect);
    const dist = Math.max(tree.height * 1.45, pile.outerRadius / Math.tan(halfHFov));
    const target = new THREE.Vector3(0, tree.height * 0.36, 0);
    const elev = 0.2;
    const position = target.clone().add(new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elev) * dist,
      Math.sin(elev) * dist,
      Math.cos(azimuth) * Math.cos(elev) * dist,
    ));
    controls.maxDistance = dist * 1.6;
    return { position, target };
  }

  const start = overviewPose();
  camera.position.copy(start.position);
  controls.target.copy(start.target);
  controls.update();

  // Camera fly-to animation.
  let flight = null;
  function flyTo({ position, target }, duration = 1.4) {
    flight = {
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos: position,
      toTarget: target,
      t: 0,
      duration,
    };
    controls.enabled = false;
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.5, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Selection.
  let selected = null;
  let resumeTimer = null;

  function openGift(gift) {
    if (selected === gift) return;
    if (selected) pile.close(selected);
    selected = gift;
    pile.open(gift);
    pile.setHover(null);
    ui.hideTooltip();
    ui.showCard(gift.item);
    ui.hideHint();
    controls.autoRotate = false;
    clearTimeout(resumeTimer);
    const wide = window.innerWidth > 720;
    flyTo(pile.focusPose(gift, { aspect: camera.aspect, sideOffset: wide ? 0.75 : 0 }));
  }

  function closeGift() {
    if (!selected) return;
    pile.close(selected);
    selected = null;
    ui.hideCard();
    const azimuth = Math.atan2(camera.position.x, camera.position.z);
    flyTo(overviewPose(azimuth), 1.6);
    scheduleAutoRotate();
  }

  function scheduleAutoRotate() {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { if (!selected) controls.autoRotate = true; }, 12000);
  }

  ui.onClose(closeGift);
  ui.renderList(items, (item) => {
    const gift = pile.byItem.get(item);
    if (gift) openGift(gift);
  });

  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    clearTimeout(resumeTimer);
    ui.hideHint();
  });
  controls.addEventListener('end', () => { if (!selected) scheduleAutoRotate(); });

  // Pointer picking: tap/click opens a present, hover shows its name.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pickAt(x, y) {
    ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return pile.pick(raycaster);
  }

  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 500;
    down = null;
    if (moved > 6 || !quick || flight) return;
    const gift = pickAt(e.clientX, e.clientY);
    if (gift) openGift(gift);
    else closeGift();
  });

  let hoverEvent = null;
  canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') hoverEvent = e; });
  canvas.addEventListener('pointerleave', () => {
    hoverEvent = null;
    pile.setHover(null);
    ui.hideTooltip();
  });
  function processHover() {
    if (!hoverEvent) return;
    const e = hoverEvent;
    hoverEvent = null;
    const gift = down ? null : pickAt(e.clientX, e.clientY);
    canvas.style.cursor = gift ? 'pointer' : 'grab';
    pile.setHover(gift && gift !== selected ? gift : null);
    if (gift && gift !== selected) ui.showTooltip(gift.item.name, e.clientX, e.clientY);
    else ui.hideTooltip();
  }

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGift(); });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    if (!selected) {
      const pose = overviewPose(Math.atan2(camera.position.x, camera.position.z));
      camera.position.copy(pose.position);
      controls.target.copy(pose.target);
    }
  });

  const clock = new THREE.Clock();
  let firstFrame = true;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    processHover();
    world.update(t, dt, camera);
    tree.update(t);
    pile.update(t, dt);
    reindeer.update(t, dt, camera, controls.target);
    // Daylight washes out the glow of the lights; the sky also sets the overall exposure.
    bloom.strength = world.sky.bloom;
    renderer.toneMappingExposure = world.sky.exposure;

    if (flight) {
      flight.t = Math.min(1, flight.t + dt / flight.duration);
      const k = easeInOut(flight.t);
      camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
      controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
      if (flight.t >= 1) {
        flight = null;
        controls.enabled = true;
      }
    }
    controls.update();
    composer.render();

    if (firstFrame) {
      firstFrame = false;
      ui.ready();
    }
  });

  // Handy for debugging from the console.
  window.__xmas = { scene, camera, controls, pile, tree, festive, reindeer, world, openGift, closeGift };
}

main();
