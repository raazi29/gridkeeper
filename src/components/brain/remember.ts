// "Remember…": a memory draft from what the user is looking at in Mission Control — the current text selection,
// else a selection made there in the last 30 s (opening the palette moves the selection into its input), else the
// board task row focused in the last 2 minutes (with its `- note:` lines). Used by the floating chip and by the
// palette's "Brain: add memory…". Nothing is written until the user saves the dialog.

import { draftFromText, taskNotes } from "../../lib/brain";
import { selectActiveWorkspace, useApp } from "../../store/appStore";
import { openCompose } from "../../store/brain";
import { useMission } from "../../store/mission";
import { useMissionDocs } from "../../store/missionDoc";

const SELECTION_TTL_MS = 30_000;
const TASK_TTL_MS = 120_000;

let lastSelection: { text: string; at: number } | null = null;
let lastTask: { dir: string; line: number; text: string; at: number } | null = null;

/** Mission Control element that holds `node` (null when outside, or inside an editable field). */
function inMissionControl(node: Node | null): Element | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!el || el.closest("input, textarea, [contenteditable='true']")) return null;
  return el.closest(".mc");
}

/** The current non-empty selection inside Mission Control, with its rectangle. */
export function missionSelection(): { text: string; rect: DOMRect } | null {
  const sel = typeof document === "undefined" ? null : document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (text.length < 3) return null;
  const range = sel.getRangeAt(0);
  if (!inMissionControl(range.commonAncestorContainer)) return null;
  lastSelection = { text, at: Date.now() };
  return { text, rect: range.getBoundingClientRect() };
}

/** Remember the board task row that took focus (called from a focusin listener while Mission Control is open). */
export function noteFocus(target: EventTarget | null): void {
  const el = target instanceof Element ? target : null;
  const row = el?.closest<HTMLElement>("li.mb-task[data-line]");
  if (!row || !inMissionControl(row)) return;
  const dir = selectActiveWorkspace(useApp.getState())?.projectDir;
  const line = Number(row.dataset.line);
  const text = row.querySelector(".mb-text")?.textContent?.trim() ?? "";
  if (dir && Number.isInteger(line) && text) lastTask = { dir, line, text, at: Date.now() };
}

/** Draft text from the selection / recent task row (see the header). Empty when there is nothing. */
export function contextText(now = Date.now()): string {
  const sel = missionSelection();
  if (sel) return sel.text;
  if (!useMission.getState().open) return "";
  if (lastSelection && now - lastSelection.at < SELECTION_TTL_MS) return lastSelection.text;
  if (lastTask && now - lastTask.at < TASK_TTL_MS) {
    const file = useMissionDocs.getState().byDir[lastTask.dir]?.file;
    const notes = file?.exists ? taskNotes(file.text, lastTask.line) : [];
    return [lastTask.text, ...notes].join("\n");
  }
  return "";
}

/** Open the "add memory" dialog prefilled from `text` (or the Mission Control context). */
export function rememberText(text: string = contextText()): void {
  const draft = text.trim() ? draftFromText(text) : { title: "", kind: "fact" as const, body: "" };
  openCompose({ ...draft, source: text.trim() ? "Mission Control" : "user", target: "notes" });
  lastSelection = null;
}
