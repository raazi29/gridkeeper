// Flight log dialog: rank and progress to the next, the streak with shields and a 12-week heat strip,
// totals and the medals (locked ones dim, with what earns them). Everything comes from the local log
// (store/flightlog.ts); nothing here starts a timer.

import { useMemo, type ReactNode } from "react";
import { formatDate, formatNumber, t as translate, useT } from "../../i18n";
import { dayKey, heatWeeks, MEDALS, RANKS, rankProgress, SHIELD_EVERY, MAX_SHIELDS, streakInfo, weekday, type MedalId } from "../../lib/flightlog";
import { closeFlightLog, useFlightLog } from "../../store/flightlog";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Insignia, MedalGlyph, ShieldIcon } from "./Insignia";
import "../../styles/flightlog.css";

/** Weekday name for 0 = Monday … 6 = Sunday in the UI language (2024-01-01 was a Monday). */
const weekdayName = (i: number, style: "short" | "narrow") => formatDate(Date.UTC(2024, 0, 1 + i), { weekday: style, timeZone: "UTC" });
const shieldHint = () => translate("flightLog.shieldHint", { every: SHIELD_EVERY, max: MAX_SHIELDS });

const fmt = (n: number) => formatNumber(n);
const fmtDate = (ms: number) => formatDate(ms, { year: "numeric", month: "short", day: "numeric" });

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
  const t = useT();
  const data = useFlightLog((s) => s.data);
  const readOnly = useFlightLog((s) => s.readOnly);
  const view = useMemo(() => {
    const today = dayKey(Date.now());
    return { today, st: streakInfo(data.days, today), rp: rankProgress(data.tasks), weeks: heatWeeks(data.days, today, 12) };
  }, [data]);
  const { st, rp, weeks } = view;
  const missionDays = Object.keys(data.days).length;
  const SHIELD_HINT = shieldHint();

  return (
    <Modal title={t("flightLog.title")} onClose={closeFlightLog} width={760} className="fl-modal" footer={<Button onClick={closeFlightLog}>{t("common.close")}</Button>}>
      <div className="fl">
        <Box label={t("flightLog.box.rank")} right={`${rp.index + 1} / ${RANKS.length}`}>
          <div className="fl-rank">
            <span className="fl-rank-badge">
              <Insignia index={rp.index} size={44} title={rp.rank.name} />
            </span>
            <div className="fl-rank-body">
              <div className="fl-rank-name">{rp.rank.name}</div>
              <div className="fl-dim">
                {rp.next ? t("flightLog.tasksToNext", { tasks: data.tasks, toNext: rp.toNext, next: rp.next.name }) : t("flightLog.tasksTop", { tasks: data.tasks })}
              </div>
              <div
                className="fl-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(rp.fraction * 100)}
                aria-label={rp.next ? t("flightLog.progressTo", { rank: rp.next.name }) : t("flightLog.highestRank")}
              >
                <span style={{ width: `${Math.round(rp.fraction * 100)}%` }} />
              </div>
              <ol className="fl-ladder" aria-label={t("flightLog.ranks")}>
                {RANKS.map((r, i) => (
                  <li key={r.id} className={i <= rp.index ? "is-held" : undefined} title={r.min === 0 ? t("flightLog.rankFromStart", { rank: r.name }) : t("flightLog.rankAt", { rank: r.name, min: r.min })}>
                    <Insignia index={i} size={14} />
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </Box>

        <Box label={t("flightLog.box.streak")} right={st.best ? t("flightLog.best", { count: st.best }) : undefined}>
          <div className="fl-streak">
            <div className="fl-streak-main">
              <span className="fl-big">{st.current}</span>
              <span className="fl-dim">{t("flightLog.daysInARow", { count: st.current })}</span>
              <span className="fl-shields" title={SHIELD_HINT} aria-label={t("flightLog.shieldsAria", { count: st.shields, max: MAX_SHIELDS, hint: SHIELD_HINT })}>
                {Array.from({ length: MAX_SHIELDS }, (_, i) => (
                  <ShieldIcon key={i} filled={i < st.shields} />
                ))}
                <span className="fl-dim">{st.shieldsInUse ? t("flightLog.shieldsInUse", { count: st.shieldsInUse }) : t("flightLog.shields", { count: st.shields })}</span>
              </span>
            </div>
            <div className="fl-heat-wrap">
              <div className="fl-heat-days" aria-hidden="true">
                <span>{weekdayName(0, "narrow")}</span>
                <span />
                <span>{weekdayName(2, "narrow")}</span>
                <span />
                <span>{weekdayName(4, "narrow")}</span>
                <span />
                <span />
              </div>
              <div className="fl-heat" role="img" aria-label={t("flightLog.heatAria", { count: missionDays })}>
                {weeks.map((col, w) => (
                  <div key={w} className="fl-heat-col">
                    {col.map((c) => (
                      <span
                        key={c.key}
                        className={`fl-cell l${c.level}${c.future ? " is-future" : ""}${c.key === view.today ? " is-today" : ""}`}
                        title={c.future ? undefined : t("flightLog.cellTitle", { weekday: weekdayName(weekday(c.key), "short"), date: c.key, count: c.count })}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <p className="fl-note">{t("flightLog.missionDayNote")}</p>
        </Box>

        <Box label={t("flightLog.box.totals")}>
          <dl className="fl-totals">
            <div>
              <dt>{t("flightLog.total.tasks")}</dt>
              <dd>{fmt(data.tasks)}</dd>
            </div>
            <div>
              <dt>{t("flightLog.total.missions")}</dt>
              <dd>{fmt(data.missions)}</dd>
            </div>
            <div>
              <dt>{t("flightLog.total.commits")}</dt>
              <dd>{fmt(data.commits)}</dd>
            </div>
            <div>
              <dt>{t("flightLog.total.agents")}</dt>
              <dd>{fmt(data.agents.length)}</dd>
            </div>
          </dl>
        </Box>

        <Box label={t("flightLog.box.medals")} right={`${Object.keys(data.medals).length} / ${MEDALS.length}`}>
          <ul className="fl-medals">
            {MEDALS.map((m) => {
              const at = data.medals[m.id as MedalId];
              return (
                <li
                  key={m.id}
                  className={`fl-medal${at ? " is-earned" : ""}`}
                  title={at ? t("flightLog.medalEarnedTitle", { name: m.name, criterion: m.criterion, date: fmtDate(at) }) : t("flightLog.medalLocked", { criterion: m.criterion })}
                >
                  <span className="fl-medal-disc">
                    <MedalGlyph id={m.id} size={22} />
                  </span>
                  <span className="fl-medal-name">{m.name}</span>
                  <span className="fl-medal-crit">{at ? t("flightLog.medalEarnedOn", { date: fmtDate(at) }) : m.criterion}</span>
                </li>
              );
            })}
          </ul>
        </Box>

        <p className="fl-note">
          {t("flightLog.privacyNote")}
          {readOnly ? ` ${t("flightLog.readOnlyNote")}` : ""}
        </p>
      </div>
    </Modal>
  );
}

