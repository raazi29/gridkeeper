// Mission Control header chip: "6-day streak · Wing Commander" with the rank insignia; opens the Flight
// log. Re-renders only when the log changes (a completion, a commit, a setting). Hidden when the flight
// log is off.

import { useMemo } from "react";
import { useT } from "../../i18n";
import { chipText, dayKey, rankProgress, streakInfo } from "../../lib/flightlog";
import { openFlightLog, useFlightLog } from "../../store/flightlog";
import { Insignia } from "./Insignia";
import "../../styles/flightlog.css";

export function FlightLogChip() {
  const t = useT();
  const data = useFlightLog((s) => s.data);
  const view = useMemo(() => {
    const st = streakInfo(data.days, dayKey(Date.now()));
    const rp = rankProgress(data.tasks);
    const title = rp.next
      ? t("flightLog.chipTitleNext", { tasks: data.tasks, toNext: rp.toNext, next: rp.next.name, shields: st.shields })
      : t("flightLog.chipTitleTop", { tasks: data.tasks, shields: st.shields });
    return { text: chipText(st.current, rp.rank), index: rp.index, title };
  }, [data, t]);
  if (!data.enabled) return null;
  return (
    <button type="button" className="mc-btn fl-chip" title={view.title} aria-label={t("flightLog.chipAria", { text: view.text })} onClick={openFlightLog}>
      <Insignia index={view.index} size={13} />
      <span className="fl-chip-text">{view.text}</span>
    </button>
  );
}
