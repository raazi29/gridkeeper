// Detect terminal-generated replies (pure).
//
// When a view re-attaches to an already-running process, the backend replays its output buffer.
// That buffer can contain old queries (DA1, XTVERSION, DECRQM, CPR, OSC colour queries…) that xterm
// would answer again — and the answers would arrive at the live program as if typed. While a replay is
// being parsed, onData chunks that consist solely of such replies are dropped.

const REPORT =
  "(?:" +
  [
    "\\x1b\\[\\?[\\d;]*c", // DA1 reply
    "\\x1b\\[>[\\d;]*c", // DA2 reply
    "\\x1b\\[\\d*n", // DSR status (ESC[0n)
    "\\x1b\\[\\??\\d+;\\d+(?:;\\d+)?R", // CPR / DECXCPR
    "\\x1b\\[\\??[\\d;]+\\$y", // DECRQM reply
    "\\x1b\\[\\d+(?:;\\d+)*t", // window manipulation reports
    "\\x1b\\[\\?\\d+u", // kitty keyboard flags reply
    "\\x1bP[^\\x1b]*\\x1b\\\\", // DCS replies (XTVERSION, DECRQSS, DA3)
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // OSC replies (colour queries)
  ].join("|") +
  ")";

const ONLY_REPORTS = new RegExp(`^${REPORT}+$`);

/** True when `data` consists only of terminal-generated report sequences. */
export function isTerminalReport(data: string): boolean {
  return data.length > 2 && data.charCodeAt(0) === 0x1b && ONLY_REPORTS.test(data);
}
