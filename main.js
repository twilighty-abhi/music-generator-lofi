// Procedural lofi generator: chords, melody, drums, bass and FX, all generated live.

// ---------- Seeded randomness ----------

// Same seed => same track (as long as mood/density aren't changed mid-play)
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng = Math.random;
const rand = (min, max) => min + rng() * (max - min);
const chance = (p) => rng() < p;
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const midiToNote = (m) => Tone.Frequency(m, "midi").toNote();
const randomSeed = () => Math.random().toString(36).slice(2, 8);

// ---------- Music theory ----------

const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const MODES = {
  major: {
    scale: [0, 2, 4, 5, 7, 9, 11],
    pentatonic: [0, 2, 4, 7, 9],
    roman: ["Imaj7", "ii7", "iii7", "IVmaj7", "V7", "vi7", "viiø7"],
    // Scale degrees (0-indexed): classic lofi / jazz progressions
    progressions: [
      [1, 4, 0, 5], // ii - V - I - vi
      [0, 5, 1, 4], // I - vi - ii - V
      [5, 3, 0, 4], // vi - IV - I - V
      [3, 2, 1, 0], // IV - iii - ii - I
      [1, 4, 0, 0], // ii - V - I - I
      [3, 4, 2, 5], // IV - V - iii - vi
    ],
  },
  minor: {
    scale: [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 3, 5, 7, 10],
    roman: ["i7", "iiø7", "IIImaj7", "iv7", "v7", "VImaj7", "VII7"],
    progressions: [
      [0, 3, 6, 2], // i - iv - VII - III
      [5, 6, 0, 0], // VI - VII - i - i
      [1, 4, 0, 5], // iiø - v - i - VI
      [0, 5, 3, 4], // i - VI - iv - v
      [3, 4, 0, 0], // iv - v - i - i
      [0, 6, 5, 4], // i - VII - VI - v
    ],
  },
};

const mode = () => MODES[state.mood];

// Scale step -> semitone offset, walking up across octaves
const scaleStep = (step) => mode().scale[step % 7] + 12 * Math.floor(step / 7);

// Stack thirds on a scale degree: 7th chord, sometimes with a 9th
function buildChord(key, degree) {
  const steps = [0, 2, 4, 6];
  if (chance(0.5)) steps.push(8);
  return steps.map((s) => 48 + key + scaleStep(degree + s));
}

// ---------- State ----------

const state = {
  seed: "",
  mood: "major",
  key: 0,
  bpm: 80,
  melodyDensity: 0.4,
  autoArrange: true,
  progression: MODES.major.progressions[0],
  melody: [],
  step: 0,
  breakdownUntil: 0,
};

function applySeed(seed) {
  state.seed = seed;
  rng = mulberry32(hashString(seed));
  state.key = Math.floor(rand(0, 12));
  state.bpm = Math.round(rand(70, 88));
  state.step = 0;
  state.breakdownUntil = 0;
  Tone.Transport.bpm.value = state.bpm;
  ui.seed.value = seed;
  ui.bpmLabel.textContent = state.bpm;
  setControl("bpm", state.bpm);
  history.replaceState(null, "", "#" + encodeURIComponent(seed));
}

// 32 eighth-note steps (4 bars): a 2-bar motif, then a varied repeat
function generateMelody() {
  const notes = [];
  for (let oct = 0; oct < 2; oct++) {
    for (const p of mode().pentatonic) notes.push(60 + state.key + p + 12 * oct);
  }
  let idx = Math.floor(notes.length / 2);
  const motif = [];
  for (let i = 0; i < 16; i++) {
    if (chance(state.melodyDensity)) {
      idx = Math.max(0, Math.min(notes.length - 1, idx + pick([-2, -1, -1, 1, 1, 2])));
      motif.push(notes[idx]);
    } else {
      motif.push(null);
    }
  }
  const variation = motif.map((n) => (n !== null && chance(0.3) ? pick(notes) : n));
  state.melody = motif.concat(variation);
}

// ---------- Audio graph ----------

let audio = null;

function buildAudio() {
  // Master lofi chain
  const limiter = new Tone.Limiter(-3).toDestination();
  const reverb = new Tone.Reverb({ decay: 2.5, wet: controlValue("reverb") }).connect(limiter);
  const wobble = new Tone.Vibrato({ frequency: 0.4, depth: controlValue("wobble") }).connect(reverb);
  const dirt = new Tone.Distortion({ distortion: 0.1, wet: 0.3 }).connect(wobble);
  const lowpass = new Tone.Filter(controlValue("warmth"), "lowpass").connect(dirt);

  const analyser = new Tone.Analyser("fft", 64);
  limiter.connect(analyser);
  const recorder = new Tone.Recorder();
  limiter.connect(recorder);

  // One channel per layer, for the mixer
  const channels = {};
  for (const layer of LAYERS) {
    channels[layer.id] = new Tone.Channel().connect(layer.id === "vinyl" ? limiter : lowpass);
  }

  const keys = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.02, decay: 1.2, sustain: 0.35, release: 1.8 },
    volume: -16,
  }).connect(channels.keys);

  const delay = new Tone.FeedbackDelay({ delayTime: "8n.", feedback: 0.3, wet: 0.25 }).connect(channels.melody);
  const lead = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.01, decay: 0.4, sustain: 0.2, release: 0.6 },
    volume: -14,
  }).connect(delay);

  const bass = new Tone.MonoSynth({
    oscillator: { type: "triangle" },
    filter: { Q: 1, type: "lowpass" },
    filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.5, baseFrequency: 150, octaves: 2 },
    envelope: { attack: 0.01, decay: 0.5, sustain: 0.6, release: 0.4 },
    volume: -8,
  }).connect(channels.bass);

  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.05,
    octaves: 6,
    envelope: { attack: 0.001, decay: 0.4, sustain: 0 },
    volume: -4,
  }).connect(channels.drums);

  const snare = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.001, decay: 0.15, sustain: 0 },
    volume: -12,
  }).connect(channels.drums);

  const hatFilter = new Tone.Filter(7000, "highpass").connect(channels.drums);
  const hat = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0 },
    volume: -20,
  }).connect(hatFilter);

  // Vinyl: constant hiss plus random crackle clicks (bypasses the lowpass)
  const hiss = new Tone.Noise({ type: "pink", volume: -38 }).connect(channels.vinyl);
  const crackleFilter = new Tone.Filter(2500, "highpass").connect(channels.vinyl);
  const crackle = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.004, sustain: 0 },
    volume: -26,
  }).connect(crackleFilter);

  return { keys, lead, bass, kick, snare, hat, hiss, crackle, lowpass, reverb, wobble, analyser, recorder, channels };
}

// ---------- UI ----------

const $ = (id) => document.getElementById(id);
const ui = {
  toggle: $("toggle"),
  newTrack: $("newTrack"),
  record: $("record"),
  download: $("download"),
  seed: $("seed"),
  mood: $("mood"),
  key: $("key"),
  bpmLabel: $("bpmLabel"),
  bar: $("bar"),
  chord: $("chord"),
  section: $("section"),
  viz: $("viz"),
};

const CONTROLS = [
  { id: "bpm", label: "tempo", min: 60, max: 100, step: 1, value: 80, fmt: (v) => v,
    apply: (v) => { state.bpm = v; Tone.Transport.bpm.value = v; ui.bpmLabel.textContent = v; } },
  { id: "warmth", label: "warmth", min: 800, max: 8000, step: 50, value: 3000, fmt: (v) => (v / 1000).toFixed(1) + "k",
    apply: (v) => audio && audio.lowpass.frequency.rampTo(v, 0.1) },
  { id: "swing", label: "swing", min: 0, max: 0.6, step: 0.01, value: 0.3, fmt: (v) => Math.round(v * 100) + "%",
    apply: (v) => { Tone.Transport.swing = v; } },
  { id: "reverb", label: "reverb", min: 0, max: 0.7, step: 0.01, value: 0.25, fmt: (v) => Math.round(v * 100) + "%",
    apply: (v) => audio && (audio.reverb.wet.value = v) },
  { id: "wobble", label: "tape wobble", min: 0, max: 0.3, step: 0.01, value: 0.06, fmt: (v) => Math.round(v * 100) + "%",
    apply: (v) => audio && (audio.wobble.depth.value = v) },
  { id: "density", label: "melody", min: 0, max: 0.9, step: 0.05, value: 0.4, fmt: (v) => Math.round(v * 100) + "%",
    apply: (v) => { state.melodyDensity = v; } },
];

const LAYERS = [
  { id: "keys", label: "keys" },
  { id: "melody", label: "melody" },
  { id: "bass", label: "bass" },
  { id: "drums", label: "drums" },
  { id: "vinyl", label: "vinyl" },
];

const controlInputs = {};

function addSlider(container, { id, label, min, max, step, value, fmt, apply }) {
  const lab = document.createElement("label");
  lab.htmlFor = "ctl-" + id;
  lab.textContent = label;
  const input = Object.assign(document.createElement("input"), { type: "range", id: "ctl-" + id, min, max, step, value });
  const out = document.createElement("output");
  out.textContent = fmt(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    apply(v);
  });
  container.append(lab, input, out);
  controlInputs[id] = { input, out, fmt };
}

function controlValue(id) {
  return Number(controlInputs[id].input.value);
}

function setControl(id, v) {
  const c = controlInputs[id];
  c.input.value = v;
  c.out.textContent = c.fmt(v);
}

function buildUI() {
  const controls = $("controls");
  for (const c of CONTROLS) addSlider(controls, c);

  const mixer = $("mixer");
  for (const layer of LAYERS) {
    const mute = Object.assign(document.createElement("button"), { className: "mute", textContent: layer.label });
    mute.title = "mute / unmute";
    mute.addEventListener("click", () => {
      mute.classList.toggle("on");
      if (audio) audio.channels[layer.id].mute = mute.classList.contains("on");
    });
    const input = Object.assign(document.createElement("input"), { type: "range", min: -30, max: 6, step: 1, value: 0 });
    input.setAttribute("aria-label", layer.label + " volume");
    const out = document.createElement("output");
    out.textContent = "0 dB";
    input.addEventListener("input", () => {
      out.textContent = input.value + " dB";
      if (audio) audio.channels[layer.id].volume.rampTo(Number(input.value), 0.05);
    });
    mixer.append(mute, input, out);
    layer.mute = mute;
    layer.volume = input;
  }

  const arrange = Object.assign(document.createElement("button"), { className: "mute on", textContent: "auto-arrange" });
  arrange.title = "occasionally drop the drums for a 2-bar breakdown";
  arrange.addEventListener("click", () => {
    state.autoArrange = arrange.classList.toggle("on");
  });
  controls.append(arrange, document.createElement("span"), document.createElement("span"));
}

// Push current mixer UI state onto freshly built channels
function syncMixer() {
  for (const layer of LAYERS) {
    audio.channels[layer.id].mute = layer.mute.classList.contains("on");
    audio.channels[layer.id].volume.value = Number(layer.volume.value);
  }
}

// ---------- Visualizer ----------

function drawViz() {
  const canvas = ui.viz;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const bins = audio ? audio.analyser.getValue() : new Float32Array(64).fill(-Infinity);
  const n = 40; // skip the mostly-empty top of the spectrum
  const bw = w / n;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  for (let i = 0; i < n; i++) {
    const level = Math.max(0, Math.min(1, (bins[i] + 100) / 80));
    const bh = Math.max(2, level * h);
    ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
  }
  requestAnimationFrame(drawViz);
}

// ---------- Sequencer ----------

function onStep(time) {
  const { keys, lead, bass, kick, snare, hat } = audio;
  const step = state.step++;
  const pos = step % 8; // eighth note within the bar
  const bar = Math.floor(step / 8);
  const m = mode();

  // Evolution: maybe change key every 32 bars, new progression every 8 bars,
  // new melody every 4 bars, occasional drum breakdown
  if (pos === 0) {
    if (bar > 0 && bar % 32 === 0 && chance(0.5)) state.key = Math.floor(rand(0, 12));
    if (bar % 8 === 0) state.progression = pick(m.progressions);
    if (bar % 4 === 0) generateMelody();
    if (state.autoArrange && bar % 16 === 14 && chance(0.5)) state.breakdownUntil = bar + 2;
  }

  const degree = state.progression[bar % 4];
  const breakdown = bar < state.breakdownUntil;

  // Chords: one per bar, lightly strummed and humanized
  if (pos === 0) {
    const chord = buildChord(state.key, degree);
    chord.forEach((n, i) => {
      keys.triggerAttackRelease(midiToNote(n), "1m", time + i * 0.018 + rand(0, 0.01), rand(0.35, 0.5));
    });
    const keyName = NOTE_NAMES[state.key] + " " + state.mood;
    const chordName = NOTE_NAMES[(state.key + m.scale[degree]) % 12] + " (" + m.roman[degree] + ")";
    Tone.Draw.schedule(() => {
      ui.key.textContent = keyName;
      ui.chord.textContent = chordName;
      ui.bar.textContent = bar + 1;
      ui.section.textContent = breakdown ? "· breakdown" : "";
    }, time);
  }

  // Bass: root on beat 1, sometimes a fifth or an approach note
  const root = 36 + state.key + m.scale[degree];
  if (pos === 0) bass.triggerAttackRelease(midiToNote(root), "4n.", time, 0.9);
  if (pos === 3 && chance(0.4)) bass.triggerAttackRelease(midiToNote(root + 7), "8n", time, 0.6);
  if (pos === 7 && chance(0.3)) bass.triggerAttackRelease(midiToNote(root + pick([-1, 2])), "8n", time, 0.5);

  // Drums: boom-bap with random ghost notes and dropped hats
  const kickHit = pos === 0 || pos === 5 || (pos === 3 && chance(0.2)) || (pos === 7 && chance(0.15));
  const ghost = chance(0.08);
  const hatHit = chance(0.85);
  const hatJitter = rand(0, 0.008);
  if (!breakdown) {
    if (kickHit) kick.triggerAttackRelease("C1", "8n", time, pos === 0 ? 1 : 0.8);
    if (pos === 2 || pos === 6) snare.triggerAttackRelease("16n", time, 0.8);
    else if (ghost) snare.triggerAttackRelease("32n", time, 0.25);
    if (hatHit) hat.triggerAttackRelease("32n", time + hatJitter, pos % 2 === 0 ? 0.6 : 0.35);
  }

  // Melody
  const note = state.melody[step % 32];
  if (note !== null && note !== undefined) {
    lead.triggerAttackRelease(midiToNote(note), pick(["8n", "4n"]), time + rand(0, 0.015), rand(0.4, 0.7));
  }
}

// Crackle uses Math.random so it doesn't disturb the seeded sequence
function onCrackle(time) {
  if (Math.random() < 0.3) {
    audio.crackle.triggerAttackRelease("64n", time + Math.random() * 0.05, 0.2 + Math.random() * 0.8);
  }
}

// ---------- Transport controls ----------

let initialized = false;
const isPlaying = () => Tone.Transport.state === "started";

async function play() {
  await Tone.start();
  if (!initialized) {
    audio = buildAudio();
    syncMixer();
    Tone.Transport.swing = controlValue("swing");
    Tone.Transport.swingSubdivision = "8n";
    new Tone.Loop(onStep, "8n").start(0);
    new Tone.Loop(onCrackle, "16n").start(0);
    initialized = true;
  }
  applySeed(ui.seed.value.trim() || randomSeed());
  audio.hiss.start();
  Tone.Transport.start("+0.1");
  ui.toggle.textContent = "■ Stop";
  ui.record.disabled = false;
}

function stop() {
  if (audio.recorder.state === "started") toggleRecord();
  Tone.Transport.stop();
  audio.keys.releaseAll();
  audio.hiss.stop();
  ui.toggle.textContent = "▶ Play";
  ui.record.disabled = true;
}

function newTrack() {
  ui.seed.value = randomSeed();
  if (isPlaying()) {
    audio.keys.releaseAll();
    applySeed(ui.seed.value);
  } else {
    play();
  }
}

async function toggleRecord() {
  if (!audio) return;
  if (audio.recorder.state !== "started") {
    audio.recorder.start();
    ui.record.textContent = "■ Stop rec";
    ui.record.classList.add("on");
    ui.download.hidden = true;
  } else {
    const blob = await audio.recorder.stop();
    const url = URL.createObjectURL(blob);
    if (ui.download.href) URL.revokeObjectURL(ui.download.href);
    ui.download.href = url;
    ui.download.download = "lofi-" + state.seed + ".webm";
    ui.download.textContent = "⬇ download recording";
    ui.download.hidden = false;
    ui.record.textContent = "● Rec";
    ui.record.classList.remove("on");
  }
}

function toggleMood() {
  state.mood = state.mood === "major" ? "minor" : "major";
  state.progression = pick(mode().progressions);
  ui.mood.textContent = "mood: " + state.mood;
}

// ---------- Wiring ----------

buildUI();
ui.seed.value = decodeURIComponent(location.hash.slice(1)) || randomSeed();

ui.toggle.addEventListener("click", () => (isPlaying() ? stop() : play()));
ui.newTrack.addEventListener("click", newTrack);
ui.record.addEventListener("click", toggleRecord);
ui.mood.addEventListener("click", toggleMood);
ui.seed.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (isPlaying()) applySeed(ui.seed.value.trim() || randomSeed());
    else play();
    ui.seed.blur();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type === "text") return;
  if (e.code === "Space") {
    e.preventDefault();
    document.activeElement.blur(); // stop a focused button from also clicking
    isPlaying() ? stop() : play();
  } else if (e.key === "n") {
    newTrack();
  } else if (e.key === "r" && isPlaying()) {
    toggleRecord();
  }
});

requestAnimationFrame(drawViz);
