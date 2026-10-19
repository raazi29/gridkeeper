// Mission Control header chip: "6-day streak · Wing Commander" with the rank insignia; opens the Flight
// log. Re-renders only when the log changes (a completion, a commit, a setting). Hidden when the flight
// log is off.

import { useMemo } from "react";
import { chipText, dayKey, rankProgress, streakInfo } from "../../lib/flightlog";
import { openFlightLog, useFlightLog } from "../../store/flightlog";
import { Insignia } from "./Insignia";
import "../../styles/flightlog.css";

export function FlightLogChip() {
  const data = useFlightLog((s) => s.data);
  const view = useMemo(() => {
    const st = streakInfo(data.days, dayKey(Date.now()));
    const rp = rankProgress(data.tasks);
    const shields = st.shields === 1 ? "1 shield" : `${st.shields} shields`;
    const next = rp.next ? ` · ${rp.toNext} to ${rp.next.name}` : "";
    return { text: chipText(st.current, rp.rank), index: rp.index, title: `Flight log: ${data.tasks} tasks completed${next} · ${shields}. Click for ranks, streak and medals.` };
  }, [data]);
  if (!data.enabled) return null;
  return (
    <button type="button" className="mc-btn fl-chip" title={view.title} onClick={openFlightLog}>
      <Insignia index={view.index} size={13} />
      {view.text}
    </button>
  );
}
