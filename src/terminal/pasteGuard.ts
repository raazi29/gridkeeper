// Paste guard decision (pure; unit-tested). Large pastes into a program that has not enabled bracketed
// paste arrive as if typed: every newline is Enter, so a shell would run each line as a command.

import { t } from "../i18n";

/** Byte threshold (UTF-8). */
export const PASTE_MAX_BYTES = 64 * 1024;
/** Line threshold: more than this many lines asks first. */
export const PASTE_MAX_LINES = 20;

/** Number of lines the paste spans; a single trailing line break does not start a new line. */
export function countLines(text: string): number {
  if (!text) return 0;
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  const trailing = /(\r\n|\r|\n)$/.test(text) ? 1 : 0;
  return breaks - trailing + 1;
}

export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4; // surrogate pair
      i++;
    } else n += 3;
  }
  return n;
}

export interface PasteCheck {
  confirm: boolean;
  lines: number;
  bytes: number;
}

export function checkPaste(text: string, opts: { bracketed: boolean; enabled: boolean }): PasteCheck {
  const lines = countLines(text);
  const bytes = utf8Length(text);
  const big = bytes > PASTE_MAX_BYTES || lines > PASTE_MAX_LINES;
  return { confirm: opts.enabled && !opts.bracketed && big, lines, bytes };
}

export function pasteTitle(check: PasteCheck, sessionName: string): string {
  return check.lines > PASTE_MAX_LINES || check.bytes <= PASTE_MAX_BYTES
    ? t("terminal.pasteTitleLines", { lines: check.lines, name: sessionName })
    : t("terminal.pasteTitleKib", { kib: Math.round(check.bytes / 1024), name: sessionName });
}
