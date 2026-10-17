// Last output line per session for Mission Control cards. Fetched with `session_output_tail` (the backend
// strips ANSI) only for cards on screen (IntersectionObserver), at most every 2 s, only while Mission
// Control is mounted. Exited sessions are fetched once. Per-card subscriptions: only changed cards re-render.

import { useEffect, type RefObject } from "react";
import { create } from "zustand";
import { ipc } from "../../lib/ipc";
import type { SessionId } from "../../lib/types";
import { isLive, useApp } from "../../store/appStore";
import { tailLines } from "../util/fleet";

const TAIL_BYTES = 4 * 1024;
export const TAIL_REFRESH_MS = 2000;

export const useMissionTails = create<{ tails: Record<SessionId, string> }>()(() => ({ tails: {} }));

/** Last non-empty line of a tail text (trimmed to `width`), "" when none. Pure. */
export function lastLine(text: string, width = 200): string {
  return tailLines(text, 1, width)[0] ?? "";
}

/**
 * Poll tails for the `[data-card]` elements under `root` that are visible inside `scrollSelector`.
 * Cards that mount later are picked up on the next tick.
 */
export function useOutputTails(root: RefObject<HTMLElement | null>, scrollSelector = ".mc-scroll"): void {
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const onScreen = new Set<SessionId>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.card;
          if (!id) continue;
          if (e.isIntersecting) onScreen.add(id);
          else onScreen.delete(id);
        }
      },
      { root: host.querySelector(scrollSelector) },
    );
    const observeAll = () => {
      for (const el of host.querySelectorAll<HTMLElement>("[data-card]")) io.observe(el);
    };
    observeAll();
    let stopped = false;
    let timer: number | undefined;
    const fetched = new Set<SessionId>();
    const tick = async () => {
      observeAll();
      const rt = useApp.getState().runtime;
      for (const id of [...onScreen]) {
        if (stopped) return;
        if (!rt[id] || (!isLive(rt[id]) && fetched.has(id))) continue;
        try {
          const line = lastLine(await ipc.sessionOutputTail(id, TAIL_BYTES));
          fetched.add(id);
          if (useMissionTails.getState().tails[id] !== line) useMissionTails.setState((s) => ({ tails: { ...s.tails, [id]: line } }));
        } catch {
          fetched.add(id); // removed / never started
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), TAIL_REFRESH_MS);
    };
    timer = window.setTimeout(() => void tick(), 60);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      io.disconnect();
    };
  }, [root, scrollSelector]);
}
