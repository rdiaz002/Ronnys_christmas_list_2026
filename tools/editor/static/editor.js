import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = (id) => document.getElementById(id);
const AUTO_COLORS = { 'f-color': '#b3202a', 'f-accent': '#f3ead8', 'f-ribbon': '#d4a73a' };
const COLOR_KEYS = { 'f-color': 'color', 'f-accent': 'accent', 'f-ribbon': 'ribbon' };

let data = null;
let version = null;
let dirty = false;
let selected = -1;
let assets = { models: [], photos: [] };

const gift = () => data.gifts[selected];

// ---------------------------------------------------------------- load / save

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function loadAll(keepSelection = false) {
  const [list, a, config] = await Promise.all([api('/api/list'), api('/api/assets'), api('/api/config')]);
  data = list.body.data;
  data.gifts ||= [];
  version = list.body.version;
  assets = a.body;
  for (const id of ['studio-link', 'studio-link-2']) $(id).href = config.body.studioUrl;
  $('site-link').href = config.body.siteUrl;
  $('title').value = data.title || '';
  $('subtitle').value = data.subtitle || '';
  setDirty(false);
  $('banner').hidden = true;
  renderList();
  select(keepSelection ? Math.min(selected, data.gifts.length - 1) : (data.gifts.length ? 0 : -1));
}

function setDirty(value) {
  dirty = value;
  const pill = $('save-state');
  pill.textContent = dirty ? '● Unsaved changes' : '✓ Saved';
  pill.className = `pill ${dirty ? 'dirty' : 'saved'}`;
  $('save-btn').disabled = !dirty;
}

function changed() {
  setDirty(true);
  renderList();
}

async function save(overwrite = false) {
  const missing = data.gifts.findIndex((g) => !String(g.name || '').trim());
  if (missing !== -1) {
    select(missing);
    $('f-name').classList.add('invalid');
    $('f-name').focus();
    return toast('Every gift needs a name.', { error: true });
  }
  $('save-btn').disabled = true;
  const res = await api('/api/list', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, version }),
  });
  if (res.ok) {
    data = res.body.data;
    version = res.body.version;
    setDirty(false);
    $('banner').hidden = true;
    renderList();
    select(selected);
    return toast('Saved ✓  Refresh the tree to see it.');
  }
  if (res.status === 409 && !overwrite) {
    const reload = confirm(
      'The list was changed somewhere else since you opened it (probably Gift Studio saved a model).\n\n' +
      'OK = load the latest version (your unsaved edits here are lost)\n' +
      'Cancel = overwrite it with your version (their change is lost)',
    );
    if (reload) return loadAll(true);
    version = res.body.version;
    return save(true);
  }
  setDirty(true);
  toast(res.body.error || 'Saving failed.', { error: true });
}

// Pick up saves made elsewhere (e.g. Gift Studio) when coming back to this tab.
window.addEventListener('focus', async () => {
  if (!data) return;
  const res = await api('/api/list');
  if (!res.ok || res.body.version === version) return;
  if (!dirty) {
    await loadAll(true);
    toast('Loaded the latest list from disk.');
  } else {
    const banner = $('banner');
    banner.replaceChildren(
      'The list was changed somewhere else (e.g. Gift Studio). ',
      Object.assign(document.createElement('button'), { className: 'chip', type: 'button', textContent: 'Load latest (discard my edits)', onclick: () => loadAll(true) }),
    );
    banner.hidden = false;
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (dirty) save();
  }
});

$('save-btn').addEventListener('click', () => save());
$('title').addEventListener('input', (e) => { data.title = e.target.value; setDirty(true); });
$('subtitle').addEventListener('input', (e) => { data.subtitle = e.target.value; setDirty(true); });

// ---------------------------------------------------------------- sidebar list

let dragFrom = null;

function renderList() {
  const list = $('gift-list');
  $('count').textContent = `(${data.gifts.length})`;
  list.replaceChildren(...data.gifts.map((g, i) => {
    const li = document.createElement('li');
    li.className = `gift-item${i === selected ? ' selected' : ''}`;
    li.draggable = true;
    const grip = Object.assign(document.createElement('span'), { className: 'grip', textContent: '⋮⋮' });
    const swatch = document.createElement('span');
    swatch.className = `swatch${g.color ? '' : ' auto'}`;
    if (g.color) swatch.style.setProperty('--c', g.color);
    const name = document.createElement('span');
    name.className = `gift-name${g.name ? '' : ' unnamed'}`;
    name.textContent = g.name || 'New gift';
    const badges = document.createElement('span');
    badges.className = 'badges';
    if (g.priority === 'high') badges.append(Object.assign(document.createElement('span'), { className: 'badge star', textContent: '★' }));
    if (g.model) badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: '3D' }));
    if (g.image) badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'photo' }));
    li.append(grip, swatch, name, badges);
    li.addEventListener('click', () => select(i));

    li.addEventListener('dragstart', (e) => {
      dragFrom = i;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => { dragFrom = null; renderList(); });
    li.addEventListener('dragover', (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      const below = e.offsetY > li.offsetHeight / 2;
      li.classList.toggle('drop-below', below);
      li.classList.toggle('drop-above', !below);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-above', 'drop-below'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragFrom === null) return;
      let to = i + (e.offsetY > li.offsetHeight / 2 ? 1 : 0);
      if (dragFrom < to) to -= 1;
      move(dragFrom, to);
    });
    return li;
  }));
}

function move(from, to) {
  if (to < 0 || to >= data.gifts.length || from === to) return renderList();
  const [item] = data.gifts.splice(from, 1);
  data.gifts.splice(to, 0, item);
  selected = to;
  changed();
  select(to);
}

$('add-btn').addEventListener('click', () => {
  data.gifts.push({ name: '', priority: 'medium', links: [] });
  changed();
  select(data.gifts.length - 1);
  $('f-name').focus();
});

// ---------------------------------------------------------------- gift form

function select(i) {
  selected = i;
  renderList();
  const has = i >= 0 && i < data.gifts.length;
  $('form').hidden = !has;
  $('empty').hidden = has;
  if (!has) return viewer.clear();
  const g = gift();
  $('form-title').textContent = g.name || 'New gift';
  $('f-name').value = g.name || '';
  $('f-name').classList.remove('invalid');
  $('f-note').value = g.note || '';
  $('f-price').value = g.price || '';
  document.querySelectorAll('input[name=priority]').forEach((r) => { r.checked = r.value === (g.priority || 'medium'); });
  $('f-wrap').value = g.wrap || '';
  for (const [id, key] of Object.entries(COLOR_KEYS)) {
    $(id).value = g[key] || AUTO_COLORS[id];
    $(id).closest('.color').classList.toggle('is-auto', !g[key]);
  }
  renderLinks();
  fillAssetSelect($('f-model'), assets.models, g.model, 'No 3D model (wrapped present)');
  fillAssetSelect($('f-image'), assets.photos, g.image, 'No photo');
  showPhoto();
  showModel();
  $('move-up').disabled = i === 0;
  $('move-down').disabled = i === data.gifts.length - 1;
}

function bindText(id, key) {
  $(id).addEventListener('input', (e) => {
    const value = e.target.value;
    if (value.trim()) gift()[key] = value;
    else delete gift()[key];
    if (key === 'name') {
      $('form-title').textContent = value || 'New gift';
      e.target.classList.remove('invalid');
    }
    changed();
  });
}
bindText('f-name', 'name');
bindText('f-note', 'note');
bindText('f-price', 'price');

document.querySelectorAll('input[name=priority]').forEach((r) => r.addEventListener('change', () => {
  gift().priority = r.value;
  changed();
}));

$('f-wrap').addEventListener('change', (e) => {
  if (e.target.value) gift().wrap = e.target.value;
  else delete gift().wrap;
  changed();
});

for (const [id, key] of Object.entries(COLOR_KEYS)) {
  $(id).addEventListener('input', (e) => {
    gift()[key] = e.target.value;
    $(id).closest('.color').classList.remove('is-auto');
    changed();
  });
}
document.querySelectorAll('[data-clear]').forEach((btn) => btn.addEventListener('click', (e) => {
  e.preventDefault();
  const id = btn.dataset.clear;
  delete gift()[COLOR_KEYS[id]];
  $(id).value = AUTO_COLORS[id];
  $(id).closest('.color').classList.add('is-auto');
  changed();
}));

// Links
function renderLinks() {
  const box = $('links');
  box.replaceChildren();
  (gift().links || []).forEach((l) => addLinkRow(l.label, l.url));
  if (!box.childElementCount) addLinkRow();
}

function addLinkRow(label = '', url = '') {
  const row = $('link-row').content.firstElementChild.cloneNode(true);
  const [lab, u, open] = [row.querySelector('.l-label'), row.querySelector('.l-url'), row.querySelector('.l-open')];
  lab.value = label;
  u.value = url;
  const sync = () => {
    open.href = /^https?:\/\//.test(u.value) ? u.value : '#';
    u.classList.toggle('invalid', !!u.value && !/^https?:\/\//.test(u.value));
  };
  sync();
  for (const input of [lab, u]) input.addEventListener('input', () => { sync(); readLinks(); });
  row.querySelector('.l-remove').addEventListener('click', () => { row.remove(); readLinks(); if (!$('links').childElementCount) addLinkRow(); });
  $('links').append(row);
}

function readLinks() {
  gift().links = [...$('links').querySelectorAll('.link-row')]
    .map((r) => ({ label: r.querySelector('.l-label').value.trim(), url: r.querySelector('.l-url').value.trim() }))
    .filter((l) => l.url)
    .map((l) => (l.label ? l : { url: l.url }));
  changed();
}
$('add-link').addEventListener('click', () => addLinkRow());

// Model & photo pickers
function fillAssetSelect(select, files, current, noneLabel) {
  const options = [new Option(noneLabel, '')];
  files.forEach((f) => options.push(new Option(f.split('/').pop(), f)));
  if (current && !files.includes(current)) options.push(new Option(`${current} (file missing!)`, current));
  select.replaceChildren(...options);
  select.value = current || '';
}

$('f-model').addEventListener('change', (e) => {
  if (e.target.value) gift().model = e.target.value;
  else {
    delete gift().model;
    delete gift().modelRotation;
  }
  changed();
  showModel();
});

$('f-image').addEventListener('change', (e) => {
  if (e.target.value) gift().image = e.target.value;
  else delete gift().image;
  changed();
  showPhoto();
});

function showPhoto() {
  const img = $('photo-preview');
  img.hidden = !gift().image;
  if (gift().image) img.src = `/${gift().image}`;
}

$('photo-upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const name = encodeURIComponent(gift().name || 'photo');
  const res = await api(`/api/photos?name=${name}`, { method: 'POST', body: file });
  if (!res.ok) return toast(res.body.error || 'Upload failed.', { error: true });
  assets.photos.push(res.body.path);
  assets.photos.sort();
  gift().image = res.body.path;
  fillAssetSelect($('f-image'), assets.photos, gift().image, 'No photo');
  showPhoto();
  changed();
  toast('Photo uploaded. Save to keep it on the gift.');
});

function showModel() {
  const has = !!gift().model;
  $('viewer-wrap').hidden = !has;
  $('rotate').hidden = !has;
  if (has) viewer.load(`/${gift().model}`, gift().modelRotation || [0, 0, 0]);
  else viewer.clear();
}

document.querySelectorAll('.chip[data-axis]').forEach((btn) => btn.addEventListener('click', () => {
  const rot = [...(gift().modelRotation || [0, 0, 0])];
  rot[Number(btn.dataset.axis)] = (rot[Number(btn.dataset.axis)] + 90) % 360;
  if (rot.some(Boolean)) gift().modelRotation = rot;
  else delete gift().modelRotation;
  viewer.setRotation(rot);
  changed();
}));
$('rot-reset').addEventListener('click', () => {
  delete gift().modelRotation;
  viewer.setRotation([0, 0, 0]);
  changed();
});

// Gift actions
$('move-up').addEventListener('click', () => move(selected, selected - 1));
$('move-down').addEventListener('click', () => move(selected, selected + 1));
$('duplicate').addEventListener('click', () => {
  const copy = structuredClone(gift());
  copy.name = `${copy.name || 'Gift'} (copy)`;
  data.gifts.splice(selected + 1, 0, copy);
  changed();
  select(selected + 1);
});
$('delete').addEventListener('click', () => {
  const index = selected;
  const [removed] = data.gifts.splice(index, 1);
  changed();
  select(Math.min(index, data.gifts.length - 1));
  toast(`Deleted “${removed.name || 'New gift'}”.`, {
    action: ['Undo', () => {
      data.gifts.splice(index, 0, removed);
      changed();
      select(index);
    }],
  });
});

// ---------------------------------------------------------------- toast

let toastTimer = null;
function toast(message, { error = false, action = null } = {}) {
  const el = $('toast');
  el.className = `toast${error ? ' error' : ''}`;
  el.replaceChildren(message);
  if (action) {
    el.append(Object.assign(document.createElement('button'), {
      className: 'chip', type: 'button', textContent: action[0],
      onclick: () => { el.hidden = true; action[1](); },
    }));
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 3500);
}

// ---------------------------------------------------------------- model preview
// Same placement as the site: apply rotation, rest on the floor, centre, fit.

const viewer = (() => {
  let renderer, scene, camera, controls, holder, inner, loader;
  let rotation = [0, 0, 0];
  let token = 0;

  function init() {
    const canvas = $('viewer');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e1630);
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
    scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x2a2030, 0.8));
    const key = new THREE.DirectionalLight(0xfff1dd, 2);
    key.position.set(2, 4, 3);
    scene.add(key);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.4, 48), new THREE.MeshStandardMaterial({ color: 0x7a1420, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50);
    camera.position.set(0, 1.3, 3);
    controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 0.5, 0);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.addEventListener('start', () => { controls.autoRotate = false; });
    const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
    loader = new GLTFLoader().setDRACOLoader(draco);
    renderer.setAnimationLoop(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * renderer.getPixelRatio())) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      controls.update();
      renderer.render(scene, camera);
    });
  }

  function place() {
    if (!inner) return;
    inner.position.set(0, 0, 0);
    inner.rotation.set(...rotation.map((d) => THREE.MathUtils.degToRad(d)));
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    inner.position.set(-c.x, -box.min.y, -c.z);
    holder.scale.setScalar(1.1 / (Math.max(size.x, size.y, size.z) || 1));
  }

  return {
    async load(url, rot) {
      if (!renderer) init();
      rotation = [...rot];
      const mine = ++token;
      try {
        const gltf = await loader.loadAsync(url);
        if (mine !== token) return;
        if (holder) scene.remove(holder);
        holder = new THREE.Group();
        inner = gltf.scene;
        inner.traverse((o) => {
          if (!o.isMesh) return;
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
      } catch {
        if (mine === token) toast(`Couldn't load ${url.slice(1)}`, { error: true });
      }
    },
    setRotation(rot) {
      rotation = [...rot];
      place();
    },
    clear() {
      token++;
      if (holder && scene) scene.remove(holder);
      holder = inner = null;
    },
  };
})();

loadAll();
