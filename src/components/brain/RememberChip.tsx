// Floating "remember…" chip next to a text selection inside Mission Control (board context, sign-off evidence,
// lead control, session log). Mounted only while Mission Control is open; listens to selection, focus and scroll
// events (no timers). The chip keeps the selection (mousedown is cancelled) and opens the "add memory" dialog.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { missionSelection, noteFocus, rememberText } from "./remember";

interface Spot {
  x: number;
  y: number;
  text: string;
}

export function RememberChip() {
  const t = useT();
  const [spot, setSpot] = useState<Spot | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const sel = missionSelection();
      if (!sel || (!sel.rect.width && !sel.rect.height)) {
        setSpot(null);
        return;
      }
      const x = Math.max(8, Math.min(sel.rect.right - 8, window.innerWidth - 132));
      const y = sel.rect.top > 40 ? sel.rect.top - 30 : Math.min(sel.rect.bottom + 6, window.innerHeight - 30);
      setSpot((s) => (s && s.x === x && s.y === y && s.text === sel.text ? s : { x, y, text: sel.text }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onFocus = (e: FocusEvent) => noteFocus(e.target);
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  if (!spot) return null;
  return createPortal(
    <button
      type="button"
      className="br-remember"
      style={{ left: spot.x, top: spot.y }}
      title={t("brain.remember.title")}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        rememberText(spot.text);
        setSpot(null);
      }}
    >
      <span aria-hidden="true">◆</span> {t("brain.remember.label")}
    </button>,
    document.body,
  );
}
