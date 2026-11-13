// "Ho ho ho!" for the star easter egg.
//
// If sounds/hohoho.mp3 exists it is played as-is. Otherwise the laugh is synthesised: a deep,
// soft voice shaped by "oh" vowel formants, a breathy "h" before each syllable, a little
// vibrato, three syllables stepping down in pitch, a warm low-pass and a short room reverb.
// Everything is tuned for a soft, rounded laugh rather than a buzzy one.

// "Ho Ho Ho, Merry Christmas!" by Cloud-10 on Freesound (CC0): https://freesound.org/s/536245/
const CLIP_URL = 'sounds/hohoho.mp3';

let ctx = null;
let clip; // { buffer, offset, gain }, null if there is no clip, undefined until checked
// Fetch the clip's bytes early so the first click doesn't wait on the network.
const clipBytes = fetch(CLIP_URL).then((res) => (res.ok ? res.arrayBuffer() : null)).catch(() => null);
let voiceWave = null;
let noise = null;
let reverb = null;

function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Soft glottal pulse: overtones fall away steeply, so the voice is round rather than buzzy.
    const n = 32;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) imag[k] = 1 / k ** 2.3;
    voiceWave = ctx.createPeriodicWave(real, imag);

    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const len = Math.floor(ctx.sampleRate * 1.4);
    const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = impulse.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    reverb = ctx.createConvolver();
    reverb.buffer = impulse;
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    reverb.connect(wet).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

async function loadClip() {
  if (clip !== undefined) return clip;
  try {
    const bytes = await clipBytes;
    if (!bytes) return (clip = null);
    const buffer = await audio().decodeAudioData(bytes);
    // Skip any silence at the start (so the click feels instant) and even out the volume.
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (const x of data) peak = Math.max(peak, Math.abs(x));
    let first = 0;
    while (first < data.length && Math.abs(data[first]) < peak * 0.02) first++;
    clip = { buffer, offset: Math.max(0, first / buffer.sampleRate - 0.05), gain: peak > 0 ? 0.8 / peak : 1 };
  } catch {
    clip = null;
  }
  return clip;
}

function syllable(ac, out, start, pitch, length, loudness) {
  // Breath: filtered noise for the "h".
  const breath = ac.createBufferSource();
  breath.buffer = noise;
  breath.loop = true;
  const breathFilter = ac.createBiquadFilter();
  breathFilter.type = 'bandpass';
  breathFilter.frequency.value = 700;
  breathFilter.Q.value = 0.6;
  const breathGain = ac.createGain();
  breathGain.gain.setValueAtTime(0, start);
  breathGain.gain.linearRampToValueAtTime(0.16 * loudness, start + 0.08);
  breathGain.gain.linearRampToValueAtTime(0.03 * loudness, start + 0.16);
  breathGain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  breath.connect(breathFilter).connect(breathGain).connect(out);
  breath.start(start);
  breath.stop(start + length + 0.05);

  // Voice: glottal buzz with a falling pitch and a little vibrato.
  const voice = ac.createOscillator();
  voice.setPeriodicWave(voiceWave);
  const voiceStart = start + 0.06;
  voice.frequency.setValueAtTime(pitch * 1.08, voiceStart);
  voice.frequency.exponentialRampToValueAtTime(pitch * 0.82, start + length);
  const vibrato = ac.createOscillator();
  vibrato.frequency.value = 5.5;
  const vibratoDepth = ac.createGain();
  vibratoDepth.gain.value = pitch * 0.015;
  vibrato.connect(vibratoDepth).connect(voice.frequency);

  const voiceGain = ac.createGain();
  // Ease in over ~120 ms and let it trail off, instead of starting and stopping abruptly.
  voiceGain.gain.setValueAtTime(0, voiceStart);
  voiceGain.gain.linearRampToValueAtTime(loudness, voiceStart + 0.12);
  voiceGain.gain.setTargetAtTime(0, start + length * 0.5, length * 0.18);

  // "Oh" vowel formants, gliding slightly towards "oo" as the syllable closes.
  for (const [f0, f1, q, gain] of [[500, 410, 5, 1], [860, 740, 6, 0.5], [2400, 2300, 8, 0.04]]) {
    const formant = ac.createBiquadFilter();
    formant.type = 'bandpass';
    formant.Q.value = q;
    formant.frequency.setValueAtTime(f0, voiceStart);
    formant.frequency.linearRampToValueAtTime(f1, start + length);
    const g = ac.createGain();
    g.gain.value = gain * 5;
    voice.connect(formant).connect(g).connect(voiceGain);
    breathFilter.connect(formant);
  }
  voiceGain.connect(out);
  voice.start(voiceStart);
  vibrato.start(voiceStart);
  voice.stop(start + length + 0.4);
  vibrato.stop(start + length + 0.4);
}

function synthesise(ac) {
  const now = ac.currentTime + 0.03;
  const master = ac.createGain();
  master.gain.value = 0.42;
  // Warm low-pass takes the edge off; a gentle compressor just evens out the three syllables.
  const warm = ac.createBiquadFilter();
  warm.type = 'lowpass';
  warm.frequency.value = 1500;
  warm.Q.value = 0.5;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 20;
  comp.ratio.value = 3;
  comp.attack.value = 0.03;
  comp.release.value = 0.25;
  master.connect(warm);
  warm.connect(comp).connect(ac.destination);
  warm.connect(reverb);
  // A slightly different laugh every time.
  const base = 105 + Math.random() * 15;
  syllable(ac, master, now, base * 1.12, 0.36, 1);
  syllable(ac, master, now + 0.42, base, 0.32, 0.85);
  syllable(ac, master, now + 0.82, base * 0.9, 0.48, 0.8);
}

export async function hoHoHo() {
  const ac = audio(); // created inside the click, so browsers allow sound
  const recorded = await loadClip();
  if (recorded) {
    const src = ac.createBufferSource();
    src.buffer = recorded.buffer;
    const gain = ac.createGain();
    gain.gain.value = recorded.gain;
    src.connect(gain).connect(ac.destination);
    src.start(0, recorded.offset);
    return 'clip';
  }
  synthesise(ac);
  return 'synth';
}
