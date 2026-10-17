// Starter prompts for formation sessions: send ONE line to a new agent once it has produced its first
// output and gone quiet — never while it is asking for something. A folder-trust / permission / login
// prompt (common on the first launch in a brand-new worktree) is detected from the attention state
// ("waiting") and from the last lines of output; the prompt is then HELD and the user gets a "Send now"
// button, because sending "\r" there would accept the agent's default answer. Nothing is auto-approved.

import { errorMessage, ipc } from "../lib/ipc";
import type { SessionId } from "../lib/types";
import { isLive, useApp } from "../store/appStore";
import { recordActivity, sessionLabelOf } from "../store/activity";
import { useAttention } from "../store/attention";
import { actionToast } from "../store/uiStore";
import { tailLines } from "../components/util/fleet";

/** Delay after the process is running before the first check when no quiet transition was seen. */
export const QUIET_FALLBACK_MS = 6000;
/** Give up after this long without a safe moment. */
export const GIVE_UP_MS = 10 * 60 * 1000;
const ENTER_DELAY_MS = 80;

const PROMPT_SHAPED =
  /(\(y\/n\)|\[y\/n\]|\by\/n\b|\byes\/no\b|do you trust|trust (the|this) (files|folder|directory)|do you want to|\ballow\b.*\?|\bapprove\b.*\?|\bpermission\b.*\?|press enter to (continue|confirm)|❯\s*1\.\s*yes|^\s*1\.\s*yes\b|sign in|log in to|\/login)/im;

/** True when the visible tail of an agent's output looks like it is asking the user something. Pure. */
export function looksLikeQuestion(tail: string): boolean {
  return PROMPT_SHAPED.test(tailLines(tail, 14, 400).join("\n"));
}

async function send(id: SessionId, text: string) {
  const line = text.replace(/[\r\n]+/g, " ");
  await ipc.sessionWrite(id, line);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  await ipc.sessionWrite(id, "\r");
}

function log(id: SessionId, level: "info" | "needs" | "error", message: string, result: string) {
  const l = sessionLabelOf(id);
  recordActivity({ sessionId: id, sessionName: l.name, role: l.role, agent: l.agent, kind: "formation", level, message, result });
}

const armed = new Map<SessionId, () => void>();

/** Arm a one-shot starter prompt for a session. Returns a cancel function. */
export function armStarterPrompt(id: SessionId, text: string): () => void {
  armed.get(id)?.();
  let done = false;
  let runningSeen = false;
  let sawWorking = false;
  let checking = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let heldToastShown = false;

  const cleanup = () => {
    done = true;
    unsubApp();
    unsubAttn();
    clearTimeout(fallback);
    clearTimeout(giveUp);
    if (armed.get(id) === cancel) armed.delete(id);
  };
  const cancel = () => cleanup();

  const doSend = async (byUser: boolean) => {
    if (done) return;
    cleanup();
    try {
      await send(id, text);
      log(id, "info", byUser ? "starter prompt sent (by you)" : "starter prompt sent", "sent");
    } catch (e) {
      log(id, "error", `starter prompt failed: ${errorMessage(e)}`, "failed");
    }
  };

  const trySend = async () => {
    if (done || checking) return;
    const a = useAttention.getState().sessions[id];
    if (a?.state === "working") return; // wait for the quiet transition
    checking = true;
    try {
      let tail = "";
      try {
        tail = await ipc.sessionOutputTail(id, 4096);
      } catch {
        /* no buffer yet */
      }
      if (done) return;
      if (!tail.trim()) {
        // No output yet: look again shortly (bounded by GIVE_UP_MS).
        clearTimeout(fallback);
        fallback = setTimeout(() => void trySend(), 3000);
        return;
      }
      const waiting = useAttention.getState().sessions[id]?.state === "waiting";
      if (waiting || looksLikeQuestion(tail)) {
        if (!heldToastShown) {
          heldToastShown = true;
          const name = sessionLabelOf(id).name;
          log(id, "needs", "starter prompt held: the agent is asking you something", "held");
          actionToast(
            {
              kind: "warn",
              message: `${name}: starter prompt held`,
              detail: "The agent is asking for confirmation. Answer it in the pane; the prompt is sent at the next quiet moment.",
              action: { label: "Send now", run: () => void doSend(true) },
            },
            60000,
          );
        }
        return; // stay armed: retried on the next quiet transition
      }
      await doSend(false);
    } finally {
      checking = false;
    }
  };

  const onApp = (s: ReturnType<typeof useApp.getState>) => {
    if (done) return;
    const rt = s.runtime[id];
    if (!s.persisted.sessions.some((m) => m.id === id) || (rt && !isLive(rt))) {
      if (rt && (rt.state.state === "exited" || rt.state.state === "failed")) log(id, "info", "starter prompt dropped: session ended", "dropped");
      cleanup();
      return;
    }
    if (!runningSeen && rt?.state.state === "running") {
      runningSeen = true;
      fallback = setTimeout(() => void trySend(), QUIET_FALLBACK_MS);
    }
  };
  const unsubApp = useApp.subscribe(onApp);

  const unsubAttn = useAttention.subscribe((s) => {
    if (done) return;
    const st = s.sessions[id]?.state;
    if (st === "working") sawWorking = true;
    else if (sawWorking && st) {
      sawWorking = false;
      void trySend();
    }
  });

  const giveUp = setTimeout(() => {
    if (done) return;
    log(id, "error", "starter prompt not sent: no safe moment within 10 minutes", "gave up");
    cleanup();
  }, GIVE_UP_MS);

  armed.set(id, cancel);
  onApp(useApp.getState()); // already running?
  return cancel;
}

/** Cancel every armed prompt (app teardown). */
export function cancelAllStarterPrompts() {
  for (const c of [...armed.values()]) c();
}
