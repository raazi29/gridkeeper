// Flight log chime: three soft rising sine notes, synthesized (no audio files). Played only for a
// promotion / medal and only when blade sounds are enabled (store/flightlog.ts decides). The context is
// created for the chime and closed when it ends, so nothing stays open while idle.

export const CHIME_NOTES: readonly { freq: number; start: number; dur: number }[] = [
  { freq: 659.25, start: 0, dur: 0.42 },
  { freq: 880, start: 0.1, dur: 0.42 },
  { freq: 1318.5, start: 0.2, dur: 0.6 },
];

export function playChime(volume: number): void {
  if (volume <= 0 || typeof AudioContext === "undefined") return;
  try {
    const c = new AudioContext();
    const master = c.createGain();
    master.gain.value = 0.12 * Math.pow(Math.min(100, volume) / 100, 1.6);
    master.connect(c.destination);
    const t0 = c.currentTime + 0.02;
    let last: OscillatorNode | null = null;
    for (const n of CHIME_NOTES) {
      const osc = c.createOscillator();
      const g = c.createGain();
      const s = t0 + n.start;
      const e = s + n.dur;
      osc.type = "sine";
      osc.frequency.setValueAtTime(n.freq, s);
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.7, s + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, e);
      osc.connect(g).connect(master);
      osc.start(s);
      osc.stop(e + 0.02);
      last = osc;
    }
    if (last) last.onended = () => void c.close().catch(() => {});
  } catch {
    /* audio unavailable */
  }
}
