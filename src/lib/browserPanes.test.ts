import { describe, expect, it } from "vitest";
import { autoStartable, browserPaneForPort, isBrowserMeta, paneKind, portChipLabel, processSessionIds } from "./browserPanes";
import type { SessionMeta } from "./types";

type M = Pick<SessionMeta, "kind" | "url" | "autoStart"> & { id: string };
const metas: M[] = [
  { id: "t1", kind: undefined, url: null, autoStart: true }, // older state: no kind
  { id: "t2", kind: "terminal", url: null, autoStart: false },
  { id: "b1", kind: "browser", url: "http://localhost:5173/", autoStart: true },
  { id: "b2", kind: "browser", url: "https://example.com:5173/", autoStart: false },
  { id: "b3", kind: "browser", url: null, autoStart: false },
];
const byId = new Map(metas.map((m) => [m.id, m]));

describe("pane kinds", () => {
  it("defaults to terminal", () => {
    expect(paneKind(metas[0])).toBe("terminal");
    expect(isBrowserMeta(metas[2])).toBe(true);
    expect(isBrowserMeta(undefined)).toBe(false);
  });
  it("process lists exclude browser panes and unknown ids", () => {
    expect(processSessionIds(["t1", "b1", "t2", "gone", "b3"], byId)).toEqual(["t1", "t2"]);
  });
  it("auto-start never includes browser panes", () => {
    expect(autoStartable(metas).map((m) => m.id)).toEqual(["t1"]);
  });
});

describe("ports -> panes", () => {
  it("finds the browser pane already on a local port", () => {
    expect(browserPaneForPort(5173, ["t1", "b2", "b1"], byId)).toBe("b1");
    expect(browserPaneForPort(3000, ["t1", "b1"], byId)).toBeNull();
    // Same port number on a remote host is not a match.
    expect(browserPaneForPort(5173, ["b2"], byId)).toBeNull();
  });
  it("labels the port chip", () => {
    expect(portChipLabel(undefined)).toBeNull();
    expect(portChipLabel([])).toBeNull();
    expect(portChipLabel([{ port: 5173, pid: 1, addresses: ["::1"] }])).toBe(":5173");
    expect(
      portChipLabel([
        { port: 3000, pid: 1, addresses: [] },
        { port: 5173, pid: 1, addresses: [] },
        { port: 9229, pid: 2, addresses: [] },
      ]),
    ).toBe(":3000 +2");
  });
});
