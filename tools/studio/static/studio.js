import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = (id) => document.getElementById(id);
const STAGE_LABELS = {
  cutout: 'Removing the background',
  shape: 'Imagining the 3D shape',
  mesh: 'Building the mesh',
  texture: 'Painting the texture',
  compress: 'Compressing',
};

let gifts = [];
let currentJob = null;
let rotation = [0, 0, 0];
let photoFile = null;

// ---------------------------------------------------------------- status

async function pollStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    const pill = $('model-status');
    pill.textContent = s.model.status === 'ready' ? '● Ready' : s.model.message;
    pill.className = `pill pill-${s.model.status}`;
    $('site-link').href = s.siteUrl;
    if (s.model.status === 'loading') setTimeout(pollStatus, 1500);
  } catch {
    $('model-status').textContent = 'Studio server not reachable';
    $('model-status').className = 'pill pill-error';
    setTimeout(pollStatus, 3000);
  }
}

// ---------------------------------------------------------------- gift picker

async function loadGifts(selectIndex) {
  gifts = await (await fetch('/api/gifts')).json();
  const select = $('gift-select');
  select.replaceChildren();
  const add = (value, text) => select.append(Object.assign(document.createElement('option'), { value, textContent: text }));
  add('new', '➕ New gift…');
  gifts.forEach((g) => add(String(g.index), `${g.name}${g.model ? '  · has 3D' : ''}`));
  select.value = selectIndex != null ? String(selectIndex) : (gifts.find((g) => !g.model)?.index ?? 'new').toString();
  syncGiftForm();
}

function syncGiftForm() {
  $('new-gift').hidden = $('gift-select').value !== 'new';
}

function addLinkRow(label = '', url = '') {
  const row = $('link-row').content.firstElementChild.cloneNode(true);
  row.querySelector('.l-label').value = label;
  row.querySelector('.l-url').value = url;
  row.querySelector('.icon-btn').addEventListener('click', () => row.remove());
  $('ng-links').append(row);
}

function newGiftFields() {
  return {
    name: $('ng-name').value.trim(),
    note: $('ng-note').value.trim(),
    price: $('ng-price').value.trim(),
    priority: $('ng-priority').value,
    links: [...$('ng-links').querySelectorAll('.link-row')]
      .map((r) => ({ label: r.querySelector('.l-label').value.trim(), url: r.querySelector('.l-url').value.trim() }))
      .filter((l) => l.url),
  };
}

// ---------------------------------------------------------------- photo input

function setPhoto(file) {
  if (!file || !file.type.startsWith('image/')) return;
  photoFile = file;
  const img = $('photo-preview');
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $('drop').classList.add('has-photo');
  $('drop-text').textContent = `${file.name} · click to change`;
}

$('photo').addEventListener('change', (e) => setPhoto(e.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => setPhoto(e.dataTransfer.files[0]));
$('s-fr').addEventListener('input', (e) => { $('fr-out').textContent = Number(e.target.value).toFixed(2); });

// ---------------------------------------------------------------- jobs

function show(section) {
  for (const id of ['empty', 'progress', 'done', 'failed']) $(id).hidden = id !== section;
}

function formError(msg) {
  $('form-error').textContent = msg || '';
  $('form-error').hidden = !msg;
}

$('make-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError('');
  if ($('gift-select').value === 'new' && !$('ng-name').value.trim()) return formError('Give the new gift a name.');
  if (!photoFile) return formError('Pick a photo first.');
  const settings = {
    foreground_ratio: Number($('s-fr').value),
    resolution: Number($('s-res').value),
    max_faces: Number($('s-faces').value),
    texture_size: Number($('s-tex').value),
    bake_texture: $('s-bake').checked,
    compress: $('s-compress').checked,
    segmenter: $('s-seg').value,
  };
  const body = new FormData();
  body.append('photo', photoFile);
  body.append('settings', JSON.stringify(settings));
  $('make-btn').disabled = true;
  try {
    const res = await fetch('/api/jobs', { method: 'POST', body });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || 'Upload failed');
    currentJob = job;
    rotation = [0, 0, 0];
    delete $('early-cutout').dataset.job;
    $('save-msg').hidden = true;
    renderProgress(job);
    show('progress');
    pollJob(job.id);
  } catch (err) {
    formError(err.message);
    $('make-btn').disabled = false;
  }
});

async function pollJob(id, failures = 0) {
  let job;
  try {
    const res = await fetch(`/api/jobs/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    job = await res.json();
  } catch {
    if (!currentJob || currentJob.id !== id) return;
    // A few misses can be a blip; after that the studio has stopped (or restarted and forgotten the job).
    if (failures < 5) return setTimeout(() => pollJob(id, failures + 1), 1500);
    $('make-btn').disabled = false;
    $('fail-msg').textContent = 'Lost contact with the studio. It has stopped or restarted (for example, the computer ran out of memory). Start it again with run.sh, then press "Make it 3D" again.';
    show('failed');
    return;
  }
  if (!currentJob || currentJob.id !== id) return;
  currentJob = job;
  if (job.status === 'done') {
    $('make-btn').disabled = false;
    showResult(job);
  } else if (job.status === 'error') {
    $('make-btn').disabled = false;
    $('fail-msg').textContent = job.message;
    show('failed');
  } else {
    renderProgress(job);
    setTimeout(() => pollJob(id), 1000);
  }
}

function renderProgress(job) {
  $('progress-title').textContent = job.status === 'queued'
    ? (job.queuePosition > 1 ? `Waiting in line (#${job.queuePosition})…` : 'Waiting for the model to finish loading…')
    : 'Working on it…';
  const stages = job.settings?.compress === false ? job.stages.filter((s) => s !== 'compress') : job.stages;
  const activeIdx = stages.indexOf(job.stage);
  $('stages').replaceChildren(...stages.map((s, i) => {
    const li = document.createElement('li');
    li.textContent = STAGE_LABELS[s] || s;
    if (job.status === 'running') li.className = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
    return li;
  }));
  $('elapsed').textContent = job.elapsed ? `${Math.round(job.elapsed)} s so far` : '';
  const early = $('early-cutout');
  early.hidden = !job.cutout;
  if (job.cutout && !early.dataset.job) {
    early.dataset.job = job.id;
    early.querySelector('img').src = `${job.cutout}?t=${Date.now()}`;
  }
}

function showResult(job) {
  const r = job.result;
  show('done');
  $('cutout').src = `${r.cutout}?t=${Date.now()}`;
  const mb = (b) => (b / 1e6).toFixed(1);
  const total = Object.values(r.timings).reduce((a, b) => a + b, 0);
  $('stats').textContent = `${r.faces.toLocaleString()} triangles · ${mb(r.bytes)} MB${r.compressed ? ` (from ${mb(r.raw_bytes)} MB)` : ''} · ${r.textured ? 'textured' : 'vertex colours'} · made in ${Math.round(total)} s`;
  viewer.load(`${r.model}?t=${Date.now()}`);
}

// ---------------------------------------------------------------- save

$('save-btn').addEventListener('click', async () => {
  if (!currentJob) return;
  const selected = $('gift-select').value;
  const payload = { modelRotation: rotation, useCutout: $('use-cutout').checked };
  if (selected === 'new') {
    payload.new = newGiftFields();
    if (!payload.new.name) {
      $('save-msg').hidden = false;
      $('save-msg').className = 'error';
      $('save-msg').textContent = 'Give the new gift a name (step 1) first.';
      return;
    }
  } else {
    payload.index = Number(selected);
  }
  $('save-btn').disabled = true;
  try {
    const res = await fetch(`/api/jobs/${currentJob.id}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Save failed');
    $('save-msg').className = 'success';
    $('save-msg').replaceChildren(
      `✓ Saved "${out.gift.name}" → ${out.gift.model}. `,
      Object.assign(document.createElement('a'), { href: out.siteUrl, target: '_blank', rel: 'noopener', textContent: 'See it under the tree ↗' }),
    );
    $('save-msg').hidden = false;
    if (selected === 'new') {
      ['ng-name', 'ng-note', 'ng-price'].forEach((id) => { $(id).value = ''; });
      $('ng-links').replaceChildren();
      addLinkRow();
    }
    const saved = await (await fetch('/api/gifts')).json();
    await loadGifts(saved.find((g) => g.name === out.gift.name)?.index);
  } catch (err) {
    $('save-msg').className = 'error';
    $('save-msg').textContent = err.message;
    $('save-msg').hidden = false;
  } finally {
    $('save-btn').disabled = false;
  }
});

$('retry-btn').addEventListener('click', () => {
  document.querySelector('details.settings').open = true;
  document.querySelector('details.settings').scrollIntoView({ behavior: 'smooth' });
});

document.querySelectorAll('.chip[data-axis]').forEach((btn) => btn.addEventListener('click', () => {
  const axis = Number(btn.dataset.axis);
  rotation[axis] = (rotation[axis] + 90) % 360;
  viewer.setRotation(rotation);
}));
$('rot-reset').addEventListener('click', () => {
  rotation = [0, 0, 0];
  viewer.setRotation(rotation);
});

// ---------------------------------------------------------------- 3D preview
// Placement mirrors the site (js/gifts.js): rotate, rest on the floor, centre, fit.

const viewer = (() => {
  const canvas = $('viewer');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1630);
  const envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.environment = envMap;
  scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x2a2030, 0.8));
  const key = new THREE.DirectionalLight(0xfff1dd, 2);
  key.position.set(2, 4, 3);
  key.castShadow = true;
  scene.add(key);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1.6, 48), new THREE.MeshStandardMaterial({ color: 0x7a1420, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50);
  camera.position.set(0, 1.4, 3.2);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.55, 0);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.2;
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
  const loader = new GLTFLoader().setDRACOLoader(draco);
  let holder = null;
  let inner = null;

  function place() {
    if (!inner) return;
    inner.position.set(0, 0, 0);
    inner.rotation.set(...rotation.map((d) => THREE.MathUtils.degToRad(d)));
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    inner.position.set(-c.x, -box.min.y, -c.z);
    holder.scale.setScalar(1.2 / (Math.max(size.x, size.y, size.z) || 1));
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  renderer.setAnimationLoop(() => {
    resize();
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    async load(url) {
      const gltf = await loader.loadAsync(url);
      if (holder) scene.remove(holder);
      holder = new THREE.Group();
      inner = gltf.scene;
      inner.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        for (const m of [].concat(o.material)) {
          if (m?.isMeshStandardMaterial && m.metalness > 0.9 && !m.metalnessMap) {
            m.metalness = 0.1;
            m.roughness = Math.min(m.roughness, 0.7);
          }
        }
      });
      holder.add(inner);
      scene.add(holder);
      place();
      controls.autoRotate = true;
    },
    setRotation() { place(); },
  };
})();

// ---------------------------------------------------------------- init

$('gift-select').addEventListener('change', syncGiftForm);
$('add-link').addEventListener('click', () => addLinkRow());
addLinkRow();
loadGifts();
pollStatus();
