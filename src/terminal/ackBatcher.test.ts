import { describe, expect, it } from "vitest";
import { AckBatcher } from "./ackBatcher";

function fakeTimers() {
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    get count() {
      return timers.size;
    },
  };
}

describe("AckBatcher", () => {
  it("flushes immediately at the threshold", () => {
    const sent: number[] = [];
    const t = fakeTimers();
    const b = new AckBatcher((n) => sent.push(n), { threshold: 100, delayMs: 30, ...t });
    b.add(60);
    expect(sent).toEqual([]);
    b.add(50);
    expect(sent).toEqual([110]);
    expect(b.pendingBytes).toBe(0);
    expect(t.count).toBe(0);
  });

  it("flushes the remainder after the trailing delay since the LAST parse", () => {
    const sent: number[] = [];
    const t = fakeTimers();
    const b = new AckBatcher((n) => sent.push(n), { threshold: 1000, delayMs: 30, ...t });
    b.add(10);
    t.advance(20);
    b.add(10); // restarts the trailing timer
    t.advance(20);
    expect(sent).toEqual([]);
    t.advance(10);
    expect(sent).toEqual([20]);
  });

  it("never sends zero and ignores non-positive adds", () => {
    const sent: number[] = [];
    const t = fakeTimers();
    const b = new AckBatcher((n) => sent.push(n), { ...t });
    b.add(0);
    b.add(-5);
    b.flush();
    t.advance(1000);
    expect(sent).toEqual([]);
  });

  it("drops pending acks on dispose and ignores later adds", () => {
    const sent: number[] = [];
    const t = fakeTimers();
    const b = new AckBatcher((n) => sent.push(n), { threshold: 1000, delayMs: 30, ...t });
    b.add(500);
    b.dispose();
    t.advance(100);
    b.add(5000);
    b.flush();
    expect(sent).toEqual([]);
    expect(t.count).toBe(0);
  });

  it("conserves the total byte count across many small parses", () => {
    let total = 0;
    const t = fakeTimers();
    const b = new AckBatcher((n) => (total += n), { threshold: 64 * 1024, delayMs: 30, ...t });
    let expected = 0;
    for (let i = 0; i < 5000; i++) {
      const n = (i * 7919) % 4096;
      expected += Math.max(0, n);
      b.add(n);
      if (i % 100 === 0) t.advance(5);
    }
    t.advance(100);
    expect(total).toBe(expected);
  });
});
