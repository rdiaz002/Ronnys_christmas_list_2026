import * as THREE from 'three';

// The sky through a winter day, by the viewer's local clock (hours). Values blend smoothly between keys.
//
// Preview other times with ?time=17:15, and other moon phases with ?moon=0.5 (0 = new, 0.5 = full).
const NIGHT = {
  top: 0x03081a, horizon: 0x1a2547, hemiSky: 0x6b7fb8, hemiGround: 0x262c40, hemi: 0.9,
  light: 0xa9bcff, lightI: 1.1, stars: 1, bloom: 0.7, exposure: 1.05,
};
const KEYS = [
  [0, NIGHT],
  [5.5, NIGHT],
  [6.75, { top: 0x2b3a6b, horizon: 0xd99a86, hemiSky: 0x9a93bd, hemiGround: 0x3a3446, hemi: 1.0, light: 0xffb38a, lightI: 1.1, stars: 0.25, bloom: 0.55, exposure: 1.0 }],
  [8, { top: 0x5a8fd6, horizon: 0xcfe1f3, hemiSky: 0xbcd4f0, hemiGround: 0x59606f, hemi: 1.5, light: 0xfff0dc, lightI: 2.2, stars: 0, bloom: 0.35, exposure: 0.92 }],
  [12, { top: 0x4d86d8, horizon: 0xd9e8f6, hemiSky: 0xc4dbf5, hemiGround: 0x5f6575, hemi: 1.6, light: 0xfff6ea, lightI: 2.5, stars: 0, bloom: 0.3, exposure: 0.9 }],
  [15.25, { top: 0x5b86c6, horizon: 0xe9dcc8, hemiSky: 0xc8cfe0, hemiGround: 0x5d5a66, hemi: 1.4, light: 0xffe0b0, lightI: 2.0, stars: 0, bloom: 0.35, exposure: 0.92 }],
  [16.5, { top: 0x3a4d8c, horizon: 0xdf9677, hemiSky: 0x9a8aa8, hemiGround: 0x3c3242, hemi: 1.0, light: 0xff9a5a, lightI: 1.3, stars: 0.1, bloom: 0.55, exposure: 1.0 }],
  [17.5, { top: 0x111d48, horizon: 0x52508e, hemiSky: 0x6b74b0, hemiGround: 0x2a2c44, hemi: 0.9, light: 0xa9bcff, lightI: 0.9, stars: 0.6, bloom: 0.65, exposure: 1.05 }],
  [19, NIGHT],
  [24, NIGHT],
];
const COLOR_KEYS = ['top', 'horizon', 'hemiSky', 'hemiGround', 'light'];
const NUMBER_KEYS = ['hemi', 'lightI', 'stars', 'bloom', 'exposure'];

// Winter sun: up around 7:15, down around 16:45, never very high.
const SUNRISE = 7.25;
const SUNSET = 16.75;
const SUN_PEAK = THREE.MathUtils.degToRad(26);

const params = new URLSearchParams(location.search);

function forcedHour() {
  const m = /^(\d{1,2}):(\d{2})$/.exec(params.get('time') || '');
  return m ? (Number(m[1]) % 24) + Number(m[2]) / 60 : null;
}

export function currentHour(now = new Date()) {
  return forcedHour() ?? now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

const keyColors = KEYS.map(([, k]) => Object.fromEntries(COLOR_KEYS.map((c) => [c, new THREE.Color(k[c])])));

// Fills `out` (reused every frame) with the sky for the given hour.
export function skyAt(hour, out) {
  let i = 0;
  while (i < KEYS.length - 2 && hour >= KEYS[i + 1][0]) i++;
  const [h0, a] = KEYS[i];
  const [h1, b] = KEYS[i + 1];
  const t = THREE.MathUtils.smoothstep(hour, h0, h1);
  for (const c of COLOR_KEYS) (out[c] ||= new THREE.Color()).lerpColors(keyColors[i][c], keyColors[i + 1][c], t);
  for (const n of NUMBER_KEYS) out[n] = THREE.MathUtils.lerp(a[n], b[n], t);

  // Sun path: rises in the east (+x), crosses the south (+z, behind the opening view), sets in the west.
  const f = (hour - SUNRISE) / (SUNSET - SUNRISE);
  const elevation = Math.sin(Math.PI * THREE.MathUtils.clamp(f, -0.15, 1.15)) * SUN_PEAK;
  (out.sunDir ||= new THREE.Vector3()).set(
    Math.cos(Math.PI * f) * Math.cos(elevation),
    Math.sin(elevation),
    Math.sin(Math.PI * f) * Math.cos(elevation),
  ).normalize();
  out.daylight = THREE.MathUtils.smoothstep(elevation, -0.04, 0.12);
  return out;
}

// Fraction of the lunar cycle: 0 = new moon, 0.5 = full moon.
export function moonPhase(now = new Date()) {
  const forced = parseFloat(params.get('moon'));
  if (Number.isFinite(forced)) return ((forced % 1) + 1) % 1;
  const synodic = 29.530588853;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const days = (now.getTime() - knownNewMoon) / 864e5;
  return (((days / synodic) % 1) + 1) % 1;
}
