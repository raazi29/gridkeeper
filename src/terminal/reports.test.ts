import { describe, expect, it } from "vitest";
import { isTerminalReport } from "./reports";

describe("isTerminalReport", () => {
  it("recognizes common replies", () => {
    for (const r of [
      "\x1b[?1;2c",
      "\x1b[>0;276;0c",
      "\x1b[0n",
      "\x1b[12;40R",
      "\x1b[?12;40;1R",
      "\x1b[?2026;2$y",
      "\x1bP>|xterm.js(6.0.0)\x1b\\",
      "\x1b]11;rgb:0b0b/0b0b/0e0e\x1b\\",
      "\x1b]10;rgb:d9d9/d9d9/e3e3\x07",
      "\x1b[8;24;80t",
      "\x1b[?1;2c\x1b[12;1R",
    ])
      expect(isTerminalReport(r), JSON.stringify(r)).toBe(true);
  });

  it("does not match user keystrokes or text", () => {
    for (const k of [
      "a",
      "\r",
      "\x03",
      "\x1b",
      "\x1b[A",
      "\x1b[1;5C",
      "\x1b[15~",
      "\x1bOP",
      "\x1b[200~hello\x1b[201~",
      "ls\r",
      "\x1b[<0;10;5M", // SGR mouse report (user action) must pass
    ])
      expect(isTerminalReport(k), JSON.stringify(k)).toBe(false);
  });
});
