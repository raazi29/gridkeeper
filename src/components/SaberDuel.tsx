// Saber "duel": when two sessions of the same group both finish within 1.5 s, two blades cross for
// 600 ms just above the bell (Comms button). Full saber mode only; never under reduced motion, in the
// background or while the status bar is hidden. pointer-events:none, so it never gets in the way.
// Idle cost: one attention-store subscription; the single timer exists only while the blades show.

import { useEffect, useState } from "react";
import { useApp } from "../store/appStore";
import { useAttention, type AttnState } from "../store/attention";
import { currentSaberLevel } from "../theme/applyTheme";
import { createDuelDetector, DUEL_MS } from "../theme/saberFx";

function groupOf(id: string): string | null {
  for (const w of useApp.getState().persisted.workspaces) for (const g of w.groups) if (g.sessionIds.includes(id)) return g.id;
  return null;
}

export function SaberDuel() {
  const [duel, setDuel] = useState<{ n: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const detect = createDuelDetector();
    const prev = new Map<string, AttnState>();
    for (const [id, a] of Object.entries(useAttention.getState().sessions)) prev.set(id, a.state);
    let timer: number | undefined;
    let last = useAttention.getState().sessions;
    const unsub = useAttention.subscribe((st) => {
      if (st.sessions === last) return;
      last = st.sessions;
      for (const [id, a] of Object.entries(st.sessions)) {
        const was = prev.get(id);
        if (was === a.state) continue;
        prev.set(id, a.state);
        if (a.state !== "done") continue;
        const g = groupOf(id);
        if (!g || !detect(g, id, Date.now())) continue;
        if (currentSaberLevel() !== "full" || document.visibilityState !== "visible") continue;
        const bell = document.querySelector<HTMLElement>("[data-comms-toggle]");
        const r = bell?.getBoundingClientRect();
        if (!r || r.width === 0) continue;
        window.clearTimeout(timer);
        setDuel((d) => ({ n: (d?.n ?? 0) + 1, x: Math.round(r.left + r.width / 2 - 23), y: Math.round(r.top - 28) }));
        timer = window.setTimeout(() => setDuel(null), DUEL_MS + 50);
      }
    });
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, []);

  if (!duel) return null;
  return (
    <div key={duel.n} className="saber-duel" style={{ left: duel.x, top: duel.y }} aria-hidden="true">
      <span className="saber-duel-blade" />
      <span className="saber-duel-blade saber-duel-blade--rival" />
      <span className="saber-duel-flash" />
    </div>
  );
}
