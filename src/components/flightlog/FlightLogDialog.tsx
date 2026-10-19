// Flight log dialog: rank and progress to the next, the streak with shields and a 12-week heat strip,
// totals and the medals (locked ones dim, with what earns them). Everything comes from the local log
// (store/flightlog.ts); nothing here starts a timer.

import { useMemo, type ReactNode } from "react";
import { dayKey, heatWeeks, MEDALS, RANKS, rankProgress, SHIELD_EVERY, MAX_SHIELDS, streakInfo, weekday, type MedalId } from "../../lib/flightlog";
import { closeFlightLog, useFlightLog } from "../../store/flightlog";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Insignia, MedalGlyph, ShieldIcon } from "./Insignia";
import "../../styles/flightlog.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHIELD_HINT = `Every ${SHIELD_EVERY} mission days in a row earn a shield (at most ${MAX_SHIELDS}). A shield covers one missed day, so a day off doesn't end the streak. A gap longer than your shields restarts the streak; the shields stay.`;

const fmt = (n: number) => n.toLocaleString();
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

function Box({ label, right, children, className }: { label: string; right?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`fl-box${className ? ` ${className}` : ""}`} aria-label={label}>
      <span className="fl-box-label">{label}</span>
      {right && <span className="fl-box-label fl-box-label-right">{right}</span>}
      {children}
    </section>
  );
}

export function FlightLogDialog() {
  const data = useFlightLog((s) => s.data);
  const readOnly = useFlightLog((s) => s.readOnly);
  const view = useMemo(() => {
    const today = dayKey(Date.now());
    return { today, st: streakInfo(data.days, today), rp: rankProgress(data.tasks), weeks: heatWeeks(data.days, today, 12) };
  }, [data]);
  const { st, rp, weeks } = view;
  const missionDays = Object.keys(data.days).length;

  return (
    <Modal title="Flight log" onClose={closeFlightLog} width={760} className="fl-modal" footer={<Button onClick={closeFlightLog}>Close</Button>}>
      <div className="fl">
        <Box label="rank" right={`${rp.index + 1} / ${RANKS.length}`}>
          <div className="fl-rank">
            <span className="fl-rank-badge">
              <Insignia index={rp.index} size={44} title={rp.rank.name} />
            </span>
            <div className="fl-rank-body">
              <div className="fl-rank-name">{rp.rank.name}</div>
              <div className="fl-dim">
                {fmt(data.tasks)} {data.tasks === 1 ? "task" : "tasks"} completed
                {rp.next ? ` · ${fmt(rp.toNext)} more to ${rp.next.name}` : " · highest rank"}
              </div>
              <div className="fl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(rp.fraction * 100)} aria-label={rp.next ? `Progress to ${rp.next.name}` : "Highest rank"}>
                <span style={{ width: `${Math.round(rp.fraction * 100)}%` }} />
              </div>
              <ol className="fl-ladder" aria-label="Ranks">
                {RANKS.map((r, i) => (
                  <li key={r.id} className={i <= rp.index ? "is-held" : undefined} title={`${r.name}: ${r.min === 0 ? "from the start" : `${fmt(r.min)} tasks`}`}>
                    <Insignia index={i} size={14} />
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </Box>

        <Box label="streak" right={st.best ? `best ${st.best}` : undefined}>
          <div className="fl-streak">
            <div className="fl-streak-main">
              <span className="fl-big">{st.current}</span>
              <span className="fl-dim">{st.current === 1 ? "mission day" : "mission days"} in a row</span>
              <span className="fl-shields" title={SHIELD_HINT} aria-label={`${st.shields} of ${MAX_SHIELDS} shields. ${SHIELD_HINT}`}>
                {Array.from({ length: MAX_SHIELDS }, (_, i) => (
                  <ShieldIcon key={i} filled={i < st.shields} />
                ))}
                <span className="fl-dim">{st.shieldsInUse ? `${st.shieldsInUse} in use` : `${st.shields} ${st.shields === 1 ? "shield" : "shields"}`}</span>
              </span>
            </div>
            <div className="fl-heat-wrap">
              <div className="fl-heat-days" aria-hidden="true">
                <span>M</span>
                <span />
                <span>W</span>
                <span />
                <span>F</span>
                <span />
                <span />
              </div>
              <div className="fl-heat" role="img" aria-label={`Last 12 weeks: ${missionDays} mission days logged in total`}>
                {weeks.map((col, w) => (
                  <div key={w} className="fl-heat-col">
                    {col.map((c) => (
                      <span
                        key={c.key}
                        className={`fl-cell l${c.level}${c.future ? " is-future" : ""}${c.key === view.today ? " is-today" : ""}`}
                        title={c.future ? undefined : `${WEEKDAYS[weekday(c.key)]} ${c.key} · ${c.count} ${c.count === 1 ? "task" : "tasks"}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <p className="fl-note">A mission day is a day with at least one mission task completed. Agents merely running don&rsquo;t count.</p>
        </Box>

        <Box label="totals">
          <dl className="fl-totals">
            <div>
              <dt>tasks completed</dt>
              <dd>{fmt(data.tasks)}</dd>
            </div>
            <div>
              <dt>missions finished</dt>
              <dd>{fmt(data.missions)}</dd>
            </div>
            <div>
              <dt>commits in missions</dt>
              <dd>{fmt(data.commits)}</dd>
            </div>
            <div>
              <dt>agents commanded</dt>
              <dd>{fmt(data.agents.length)}</dd>
            </div>
          </dl>
        </Box>

        <Box label="medals" right={`${Object.keys(data.medals).length} / ${MEDALS.length}`}>
          <ul className="fl-medals">
            {MEDALS.map((m) => {
              const at = data.medals[m.id as MedalId];
              return (
                <li key={m.id} className={`fl-medal${at ? " is-earned" : ""}`} title={at ? `${m.name}: ${m.criterion} Earned ${fmtDate(at)}.` : `Locked: ${m.criterion}`}>
                  <span className="fl-medal-disc">
                    <MedalGlyph id={m.id} size={22} />
                  </span>
                  <span className="fl-medal-name">{m.name}</span>
                  <span className="fl-medal-crit">{at ? `earned ${fmtDate(at)}` : m.criterion}</span>
                </li>
              );
            })}
          </ul>
        </Box>

        <p className="fl-note">
          Kept on this machine only (no network, no telemetry): counts and anonymous hashes, never task text, paths or terminal output. Turn it off or reset it in Settings › Interface.
          {readOnly ? " A newer Gridkeeper saved this log in a newer format; this version counts in memory and leaves it untouched." : ""}
        </p>
      </div>
    </Modal>
  );
}

