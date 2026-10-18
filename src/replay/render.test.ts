import { describe, expect, it } from "vitest";
import { THEMES } from "../theme/themes";
import type { ReplayEvent } from "./events";
import { alpha, paletteColors, paletteFromTheme, roleColor } from "./palette";
import { ASPECTS, makeScene, paintFrame, type Aspect } from "./render";

/** A 2D context stand-in: accepts every call, measures text roughly, records what was written. */
function stubContext() {
  const texts: string[] = [];
  let font = "10px x";
  const state: Record<string, unknown> = {};
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = {
    fillText: (s: string) => void texts.push(s),
    measureText: (s: string) => ({ width: s.length * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "10") * 0.56) }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === "font") return font;
      if (k in state) return state[k];
      if (k === "letterSpacing") return "0px";
      return () => {};
    },
    set(_t, k: string, v) {
      if (k === "font") font = String(v);
      else state[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}

const T0 = Date.UTC(2026, 9, 18, 8, 42);

function events(agents: number, tasks: number): ReplayEvent[] {
  const team = Array.from({ length: agents }, (_, i) => ({ slug: `agent-${i}`, name: `agent-${i}`, role: ["lead", "builder", "reviewer", "verifier", "scout", "custom-role"][i % 6], agent: "claude", live: true }));
  const list = Array.from({ length: tasks }, (_, i) => ({ text: `Task number ${i} with a fairly long description that must be ellipsized`, s: "todo" as const, o: [`agent-${i % agents}`] }));
  const ev: ReplayEvent[] = [{ t: T0, k: "start", v: 1, goal: "Ship OAuth login with PKCE and refresh-token rotation for the desktop app", team, tasks: list }];
  for (let i = 0; i < agents; i++) ev.push({ t: T0 + 500, k: "branch", slug: `agent-${i}`, w: `w${i}`, ahead: 0, files: 0, ins: 0, del: 0 });
  let t = T0 + 1000;
  for (let i = 0; i < tasks; i++) {
    t += 60_000;
    ev.push({ t, k: "attn", slug: `agent-${i % agents}`, s: "working" });
    ev.push({ t: t + 1, k: "task", text: list[i].text, s: "doing", o: list[i].o });
    ev.push({ t: t + 30_000, k: "msg", from: "agent-0", to: [`agent-${i % agents}`], text: `please also cover case ${i}` });
    ev.push({ t: t + 50_000, k: "branch", slug: `agent-${i % agents}`, w: `w${i % agents}`, ahead: i + 1, files: 2 * i + 1, ins: 40 * i, del: 3 * i });
    ev.push({ t: t + 55_000, k: "task", text: list[i].text, s: i % 7 === 6 ? "blocked" : "done", o: list[i].o });
    ev.push({ t: t + 56_000, k: "attn", slug: `agent-${i % agents}`, s: i % 5 === 4 ? "needs" : "done" });
  }
  ev.push({ t: t + 90 * 60_000, k: "leave", slug: "agent-1", why: "stopped" });
  ev.push({ t: t + 90 * 60_000 + 1, k: "end" });
  return ev;
}

describe("paintFrame (smoke, stub context)", () => {
  const palette = paletteFromTheme(THEMES[0]);

  for (const aspect of Object.keys(ASPECTS) as Aspect[]) {
    for (const [agents, tasks] of [
      [1, 0],
      [3, 5],
      [8, 40],
      [20, 3],
    ]) {
      it(`${aspect} · ${agents} agents · ${tasks} tasks`, () => {
        const scene = makeScene(events(agents, tasks), 30);
        const { w, h } = ASPECTS[aspect];
        for (const flat of [false, true]) {
          const { ctx, texts } = stubContext();
          for (let ms = 0; ms <= scene.plan.totalMs; ms += 733) paintFrame(ctx, scene, ms, { width: w, height: h, palette, watermark: true, flat });
          paintFrame(ctx, scene, scene.plan.totalMs, { width: w, height: h, palette, watermark: true, flat });
          expect(texts.some((s) => s.includes("GRIDKEEPER"))).toBe(true);
          expect(texts.some((s) => s.startsWith("Made with Gridkeeper"))).toBe(true);
          expect(texts.some((s) => s === "TASKS DONE")).toBe(true);
          for (const s of texts) expect(typeof s).toBe("string");
        }
      });
    }
  }

  it("draws at preview scale and without a watermark", () => {
    const scene = makeScene(events(4, 6), 15);
    const { ctx, texts } = stubContext();
    for (let ms = 0; ms <= scene.plan.totalMs; ms += 500) paintFrame(ctx, scene, ms, { width: 480, height: 270, palette, watermark: false });
    expect(texts.some((s) => s.startsWith("Made with Gridkeeper"))).toBe(false);
  });

  it("handles an empty recording", () => {
    const scene = makeScene([], 15);
    const { ctx } = stubContext();
    for (let ms = 0; ms <= 15_000; ms += 1000) paintFrame(ctx, scene, ms, { width: 1920, height: 1080, palette, watermark: true });
  });
});

describe("palette", () => {
  it("resolves every theme to opaque hex colours with role colours", () => {
    for (const t of THEMES) {
      const p = paletteFromTheme(t);
      for (const c of paletteColors(p)) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(roleColor(p, "builder")).toBe(p.roles.builder);
      expect(roleColor(p, "Some Custom")).toBe(p.roleCustom);
      expect(roleColor(p, null)).toBe(p.roleCustom);
    }
    expect(alpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.500)");
  });
});
