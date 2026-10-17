import { describe, expect, it } from "vitest";
import { SOUND_SETS, playSound, soundLength, soundNotes, type SoundEvent } from "./sounds";

const EVENTS: SoundEvent[] = ["needsInput", "done", "error", "bell"];

/** Deterministic PRNG for the droid set. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("sound synth", () => {
  it("every set except none produces short, audible-range notes", () => {
    for (const set of SOUND_SETS.map((s) => s.id).filter((s) => s !== "none")) {
      for (const e of EVENTS) {
        const notes = soundNotes(set, e, seeded(7));
        expect(notes.length, `${set}/${e}`).toBeGreaterThan(0);
        expect(soundLength(notes), `${set}/${e}`).toBeLessThan(0.45);
        for (const n of notes) {
          expect(n.freq).toBeGreaterThan(200);
          expect(n.freq).toBeLessThan(4000);
          expect(n.gain).toBeGreaterThan(0);
          expect(n.gain).toBeLessThanOrEqual(1);
          expect(n.dur).toBeGreaterThan(0);
        }
      }
    }
  });
  it("none is silent", () => {
    expect(soundNotes("none", "done")).toEqual([]);
  });
  it("comm chirp rises for needs-input and falls for errors", () => {
    const up = soundNotes("comm", "needsInput");
    const down = soundNotes("comm", "error");
    expect(up[1].freq).toBeGreaterThan(up[0].freq);
    expect(down[1].freq).toBeLessThan(down[0].freq);
  });
  it("droid chatter is 3-5 quiet chirps and varies", () => {
    const a = soundNotes("droid", "done", seeded(1));
    const b = soundNotes("droid", "done", seeded(99));
    for (const n of [a, b]) {
      expect(n.length).toBeGreaterThanOrEqual(3);
      expect(n.length).toBeLessThanOrEqual(5);
      expect(n.every((x) => x.gain <= 0.4)).toBe(true);
    }
    expect(a.map((n) => n.freq)).not.toEqual(b.map((n) => n.freq));
    const q = soundNotes("droid", "needsInput", seeded(3));
    const last = q[q.length - 1];
    expect(last.glideTo).toBeGreaterThan(last.freq);
  });
  it("playSound is a safe no-op without WebAudio", () => {
    expect(() => playSound("comm", "done", 50)).not.toThrow();
    expect(() => playSound("none", "done", 50)).not.toThrow();
  });
});
