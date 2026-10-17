// Tiny WebAudio synth for alert sounds: no audio files, no samples — every sound is a few oscillator
// notes with short envelopes (plus the saber ignite / retract: a filtered oscillator sweep). Note sequences come from a pure function (unit-tested); playback is
// best-effort and the AudioContext is suspended shortly after each sound so it costs nothing when idle.

import type { SoundSet } from "../lib/types";

export type SoundEvent = "needsInput" | "done" | "error" | "bell";

export interface Note {
  /** Hz at the start of the note. */
  freq: number;
  /** Optional glide target (Hz) reached at the end of the note. */
  glideTo?: number;
  /** Offset from the start of the sound, seconds. */
  start: number;
  /** Seconds. */
  dur: number;
  type: OscillatorType;
  /** Relative loudness 0–1 (the master volume scales everything). */
  gain: number;
}

export const SOUND_SETS: { id: SoundSet; name: string; hint: string }[] = [
  { id: "comm", name: "Comm beep", hint: "Two-tone chirp, like an incoming transmission" },
  { id: "console", name: "Console", hint: "One soft blip" },
  { id: "droid", name: "Droid chatter", hint: "A short, quiet burst of beeps and boops — different every time" },
  { id: "none", name: "None", hint: "Silent" },
];

/** Note sequence for a sound set + event. `rand` is injectable for tests. */
export function soundNotes(set: SoundSet, ev: SoundEvent, rand: () => number = Math.random): Note[] {
  switch (set) {
    case "comm": {
      // Two-tone chirp; the interval tells the events apart (rising = needs you, falling = error).
      const pairs: Record<SoundEvent, [number, number]> = {
        needsInput: [1046.5, 1568],
        bell: [987.8, 1318.5],
        done: [784, 1174.7],
        error: [659.3, 440],
      };
      const [a, b] = pairs[ev];
      return [
        { freq: a, start: 0, dur: 0.075, type: "sine", gain: 1 },
        { freq: b, start: 0.09, dur: 0.11, type: "sine", gain: 0.9 },
      ];
    }
    case "console": {
      const f: Record<SoundEvent, number> = { needsInput: 880, bell: 784, done: 659.3, error: 293.7 };
      return [{ freq: f[ev], glideTo: f[ev] * 0.84, start: 0, dur: 0.11, type: "triangle", gain: 0.9 }];
    }
    case "droid": {
      // 3–5 short chirps with random pitch and glides; error sits lower, needs-input ends on a rising "question".
      const count = 3 + Math.floor(rand() * 3);
      const lo = ev === "error" ? 380 : 700;
      const hi = ev === "error" ? 1100 : 2300;
      const notes: Note[] = [];
      let t = 0;
      for (let i = 0; i < count; i++) {
        const dur = 0.035 + rand() * 0.035;
        const freq = lo + rand() * (hi - lo);
        const last = i === count - 1;
        const glideTo = last && ev === "needsInput" ? Math.min(hi * 1.25, freq * 1.5) : rand() < 0.5 ? freq * (0.7 + rand() * 0.6) : undefined;
        notes.push({ freq, glideTo, start: t, dur, type: rand() < 0.5 ? "square" : "triangle", gain: 0.35 });
        t += dur + 0.012 + rand() * 0.02;
      }
      return notes;
    }
    default:
      return [];
  }
}

/** Total length of a sequence, seconds. */
export function soundLength(notes: Note[]): number {
  return notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
}

// ---- saber blade ---------------------------------------------------------------------------

export type SaberCue = "ignite" | "retract";

/** One blade sound: detuned sawtooth pair + a sine an octave up, swept in pitch through a swept lowpass. */
export interface SaberVoice {
  /** Seconds. */
  dur: number;
  attack: number;
  /** Pitch sweep, Hz. */
  f0: number;
  f1: number;
  /** Lowpass cutoff sweep, Hz. */
  cutoff0: number;
  cutoff1: number;
  q: number;
  /** ± detune of the two saws, cents. */
  detune: number;
  /** Relative loudness 0–1. */
  gain: number;
}

/** Ignite: a quick rising sweep that opens up (~250 ms). Retract: softer, falling and closing (~170 ms). */
export function saberVoice(cue: SaberCue): SaberVoice {
  return cue === "ignite"
    ? { dur: 0.25, attack: 0.012, f0: 72, f1: 148, cutoff0: 260, cutoff1: 2400, q: 6, detune: 9, gain: 0.9 }
    : { dur: 0.17, attack: 0.006, f0: 150, f1: 64, cutoff0: 1700, cutoff1: 220, q: 3, detune: 7, gain: 0.55 };
}

let ctx: AudioContext | null = null;
let suspendTimer: ReturnType<typeof setTimeout> | undefined;

/** The shared context plus a master gain at `volume` (0–100); the caller schedules its nodes into it. */
function openOutput(volume: number): { c: AudioContext; master: GainNode } {
  ctx ??= new AudioContext();
  // Created outside a user gesture it may start suspended; we also suspend it between sounds.
  if (ctx.state === "suspended") void ctx.resume();
  const master = ctx.createGain();
  // Perceptual curve; the ceiling is deliberately low — these are background cues.
  master.gain.value = 0.16 * Math.pow(Math.min(100, volume) / 100, 1.6);
  master.connect(ctx.destination);
  return { c: ctx, master };
}

/** Suspend the device shortly after the last scheduled sound ends (costs nothing while idle). */
function suspendAfter(seconds: number) {
  clearTimeout(suspendTimer);
  suspendTimer = setTimeout(() => void ctx?.suspend().catch(() => {}), (seconds + 0.6) * 1000);
}

/** Play a blade ignite / retract (no-op at volume 0 / no WebAudio). `volume` 0–100. */
export function playSaber(cue: SaberCue, volume: number): void {
  if (volume <= 0) return;
  const v = saberVoice(cue);
  try {
    const { c, master } = openOutput(volume);
    const t0 = c.currentTime + 0.008;
    const end = t0 + v.dur;
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = v.q;
    filter.frequency.setValueAtTime(v.cutoff0, t0);
    filter.frequency.exponentialRampToValueAtTime(v.cutoff1, end);
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(v.gain, t0 + v.attack);
    env.gain.setValueAtTime(v.gain, t0 + v.dur * 0.45);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    filter.connect(env).connect(master);
    const voices: [OscillatorType, number, number, number][] = [
      // type, pitch ratio, detune (cents), level — saws are loud, so they sit low in the mix
      ["sawtooth", 1, v.detune, 0.3],
      ["sawtooth", 1, -v.detune, 0.3],
      ["sine", 2, 0, 0.55],
    ];
    let last: OscillatorNode | null = null;
    for (const [type, ratio, detune, level] of voices) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(v.f0 * ratio, t0);
      osc.frequency.exponentialRampToValueAtTime(v.f1 * ratio, end);
      g.gain.value = level;
      osc.connect(g).connect(filter);
      osc.start(t0);
      osc.stop(end + 0.02);
      last = osc;
    }
    if (last) last.onended = () => master.disconnect();
    suspendAfter(v.dur);
  } catch {
    /* audio unavailable */
  }
}

/** Play a sound (no-op for "none" / volume 0 / no WebAudio). `volume` 0–100. */
export function playSound(set: SoundSet, ev: SoundEvent, volume: number): void {
  if (set === "none" || volume <= 0) return;
  const notes = soundNotes(set, ev);
  if (notes.length === 0) return;
  try {
    const { c: ctx, master } = openOutput(volume);
    const t0 = ctx.currentTime + 0.012;
    let lastOsc: OscillatorNode | null = null;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const s = t0 + n.start;
      const e = s + n.dur;
      osc.type = n.type;
      osc.frequency.setValueAtTime(n.freq, s);
      if (n.glideTo) osc.frequency.exponentialRampToValueAtTime(n.glideTo, e);
      // Square waves are much louder than sines at the same amplitude.
      const peak = n.gain * (n.type === "square" ? 0.35 : 1);
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(peak, s + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, e);
      osc.connect(g).connect(master);
      osc.start(s);
      osc.stop(e + 0.02);
      lastOsc = osc;
    }
    if (lastOsc) lastOsc.onended = () => master.disconnect();
    suspendAfter(soundLength(notes));
  } catch {
    /* audio unavailable */
  }
}

/** Release the audio device (app teardown). */
export function disposeAudio(): void {
  clearTimeout(suspendTimer);
  suspendTimer = undefined;
  const c = ctx;
  ctx = null;
  void c?.close().catch(() => {});
}
