// Read-only log of one test run: what ran where, outcome, counts, failures and the captured output
// (monospace, ANSI stripped, the newest 2 MiB). While the run is active and this dialog is open the log
// is re-read once a second (the newest 256 KiB); after it finishes, once more in full. Copy, cancel,
// run again, and — for a failed run that belongs to a live session — "ask the agent to fix…" (a
// confirmation dialog; nothing is sent from here).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { errorMessage, ipc } from "../../lib/ipc";
import type { TestRunInfo } from "../../lib/types";
import { isLive, useApp } from "../../store/appStore";
import { askAgentToFix, cancelTestRun, closeTestLog, runTestsAt, sessionTarget, useTestRuns } from "../../store/testrun";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { copyText } from "../util/pick";
import { badgeTone, countsText, formatDuration, isActiveStatus, statusText } from "./format";
import { useTicking } from "./TestBadge";

const LIVE_TAIL_BYTES = 256 * 1024;
const POLL_MS = 1000;

export function TestLogDialog({ runId }: { runId: string }) {
  const run = useTestRuns((s) => s.runs[runId]);
  if (!run) return null;
  return <LogView run={run} />;
}

function LogView({ run }: { run: TestRunInfo }) {
  const t = useT();
  const [text, setText] = useState("");
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const active = isActiveStatus(run.status);
  const now = useTicking(active);
  const sessionLive = useApp((s) => (run.sessionId ? isLive(s.runtime[run.sessionId]) : false));

  // Live tail while active (only while this dialog is open), the full log once finished.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const log = await ipc.testRunLog(run.id, active ? LIVE_TAIL_BYTES : null);
        if (!alive) return;
        setText(log.text);
        setDropped(log.droppedBytes);
        setError(null);
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
      if (alive && active) timer = window.setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [run.id, active]);

  // Follow the end of the output unless the user scrolled up.
  useLayoutEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const elapsed = run.startedMs != null ? (run.durationMs ?? Math.max(0, now - run.startedMs)) : null;
  const again = () => {
    const target = run.sessionId ? sessionTarget(run.sessionId) : null;
    void runTestsAt(target ?? { path: run.cwd, label: run.label, sessionId: run.sessionId, workspaceId: null, groupId: null });
  };
  const failed = run.status === "failed" || run.status === "timedOut";

  return (
    <Modal
      title={t("testrun.log.title", { label: run.label })}
      onClose={closeTestLog}
      width={860}
      className="tr-log-dialog"
      footer={
        <>
          <span className="tr-foot-note">{t("testrun.log.note")}</span>
          <Button onClick={() => void copyText(text, t("testrun.log.copied"))} disabled={!text}>
            {t("testrun.log.copy")}
          </Button>
          {active ? (
            <Button variant="danger" onClick={() => void cancelTestRun(run.id)}>
              {t("testrun.log.cancel")}
            </Button>
          ) : (
            <Button onClick={again}>{t("testrun.log.again")}</Button>
          )}
          {failed && run.sessionId && (
            <Button
              variant="primary"
              disabled={!sessionLive}
              title={sessionLive ? t("testrun.log.askTitle") : t("testrun.log.sessionStopped")}
              onClick={() => askAgentToFix(run.id)}
            >
              {t("testrun.log.ask")}
            </Button>
          )}
          <Button onClick={closeTestLog}>{t("common.close")}</Button>
        </>
      }
    >
      <div className="tr-head">
        <div className="tr-head-row">
          <span className={`tr-status is-${badgeTone(run.status)}`}>{statusText(run.status)}</span>
          {elapsed != null && <span className="tr-dim">{formatDuration(elapsed)}</span>}
          {run.exitCode != null && <span className="tr-dim">{t("testrun.exitCode", { code: run.exitCode })}</span>}
          {run.counts && <span>{countsText(run.counts)}</span>}
          {run.counts && <span className="tr-dim">({run.counts.runner})</span>}
        </div>
        <div className="tr-head-row mono">
          <span className="tr-dim">$</span>
          <span className="tr-cmd">{run.command}</span>
        </div>
        <div className="tr-head-row tr-dim mono" title={run.cwd}>
          <span className="tr-ellipsis">{run.cwd}</span>
          {run.headSha && <span>· {run.headSha.slice(0, 10)}</span>}
          {run.uncommitted ? <span>· {t("testrun.log.uncommitted", { count: run.uncommitted })}</span> : null}
          <span>· {t("testrun.log.limit", { duration: formatDuration(run.timeoutSec * 1000) })}</span>
        </div>
        {run.error && <div className="callout is-error">{run.error}</div>}
        {run.failures.length > 0 && (
          <ul className="tr-failures mono">
            {run.failures.map((f) => (
              <li key={f}>✗ {f}</li>
            ))}
          </ul>
        )}
      </div>
      {error && <div className="callout is-error">{error}</div>}
      {dropped > 0 && <div className="tr-dim tr-dropped">{t("testrun.log.dropped", { kb: Math.round(dropped / 1024) })}</div>}
      <pre
        ref={pre}
        className="tr-log mono"
        tabIndex={0}
        aria-label={t("testrun.log.outputAria")}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text || (active ? (run.status === "queued" ? t("testrun.log.waiting") : t("testrun.log.starting")) : t("testrun.log.noOutput"))}
      </pre>
    </Modal>
  );
}
