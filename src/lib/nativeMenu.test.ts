import { describe, expect, it } from "vitest";
import { MENU_KEY_DEDUPE_MS, handleMenuCommand, shouldRunMenuCommand, type MenuRunContext } from "./nativeMenu";

const base: MenuRunContext = { known: true, suspended: false, lastKey: null, now: 10_000 };

describe("shouldRunMenuCommand", () => {
  it("runs known commands", () => {
    expect(shouldRunMenuCommand("view.palette", base)).toBe(true);
  });

  it("ignores unknown ids and paused key capture (modal open)", () => {
    expect(shouldRunMenuCommand("nope", { ...base, known: false })).toBe(false);
    expect(shouldRunMenuCommand("view.palette", { ...base, suspended: true })).toBe(false);
  });

  it("drops the menu copy of a command a key binding just ran (one key press, one action)", () => {
    const lastKey = { id: "view.settings", at: base.now - 50 };
    expect(shouldRunMenuCommand("view.settings", { ...base, lastKey })).toBe(false);
    // Another command, or the same one long enough ago, still runs.
    expect(shouldRunMenuCommand("view.palette", { ...base, lastKey })).toBe(true);
    expect(shouldRunMenuCommand("view.settings", { ...base, lastKey: { id: "view.settings", at: base.now - MENU_KEY_DEDUPE_MS } })).toBe(true);
    // A clock that went backwards never suppresses forever.
    expect(shouldRunMenuCommand("view.settings", { ...base, lastKey: { id: "view.settings", at: base.now + 5_000 } })).toBe(true);
  });
});

describe("handleMenuCommand", () => {
  it("runs only registered commands", () => {
    expect(handleMenuCommand("not.a.command")).toBe(false);
    // A real, side-effect-light command from the registry.
    expect(handleMenuCommand("attention.markAllRead")).toBe(true);
  });
});
