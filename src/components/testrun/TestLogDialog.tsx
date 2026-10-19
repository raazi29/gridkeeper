// Read-only log of one test run: what ran where, outcome, counts, failures and the captured output
// (monospace, ANSI stripped, the newest 2 MiB). While the run is active and this dialog is open the log
// is re-read once a second (the newest 256 KiB); after it finishes, once more in full. Copy, cancel,
// run again, and — for a failed run that belongs to a live session — "ask the agent to fix…" (a
// confirmation dialog; nothing is sent from here).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage, ipc } from "../../lib/ipc";
import type { TestRunInfo } from "../../lib/types";
import { isLive, useApp } from "../../store/appStore";
import { askAgentToFix, cancelTestRun, closeTestLog, runTestsAt, sessionTarget, useTestRuns } from "../../store/testrun";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { copyText } from "../util/pick";
import { badgeTone, countsText, formatDuration, isActiveStatus, STATUS_TEXT } from "./format";
import { useTicking } from "./TestBadge";

const LIVE_TAIL_BYTES = 256 * 1024;
const POLL_MS = 1000;

export function TestLogDialog({ runId }: { runId: string }) {
  const run = useTestRuns((s) => s.runs[runId]);
  if (!run) return null;
  return <LogView run={run} />;
}

function LogView({ run }: { run: TestRunInfo }) {
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
    const t = run.sessionId ? sessionTarget(run.sessionId) : null;
    void runTestsAt(t ?? { path: run.cwd, label: run.label, sessionId: run.sessionId, workspaceId: null, groupId: null });
  };
  const failed = run.status === "failed" || run.status === "timedOut";

  return (
    <Modal
      title={`Tests · ${run.label}`}
      onClose={closeTestLog}
      width={860}
      className="tr-log-dialog"
      footer={
        <>
          <span className="tr-foot-note">Read-only. Output is kept for the newest runs only.</span>
          <Button onClick={() => void copyText(text, "Log copied")} disabled={!text}>
            Copy log
          </Button>
          {active ? (
            <Button variant="danger" onClick={() => void cancelTestRun(run.id)}>
              Cancel run
            </Button>
          ) : (
            <Button onClick={again}>Run again</Button>
          )}
          {failed && run.sessionId && (
            <Button
              variant="primary"
              disabled={!sessionLive}
              title={sessionLive ? "Opens a message you can edit; nothing is sent until you press Send" : "The session is not running"}
              onClick={() => askAgentToFix(run.id)}
            >
              Ask the agent to fix…
            </Button>
          )}
          <Button onClick={closeTestLog}>Close</Button>
        </>
      }
    >
      <div className="tr-head">
        <div className="tr-head-row">
          <span className={`tr-status is-${badgeTone(run.status)}`}>{STATUS_TEXT[run.status]}</span>
          {elapsed != null && <span className="tr-dim">{formatDuration(elapsed)}</span>}
          {run.exitCode != null && <span className="tr-dim">exit {run.exitCode}</span>}
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
          {run.uncommitted ? <span>· {run.uncommitted} uncommitted</span> : null}
          <span>· limit {formatDuration(run.timeoutSec * 1000)}</span>
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
      {dropped > 0 && <div className="tr-dim tr-dropped">… {Math.round(dropped / 1024)} KiB of earlier output not shown</div>}
      <pre
        ref={pre}
        className="tr-log mono"
        tabIndex={0}
        aria-label="Test output"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text || (active ? (run.status === "queued" ? "waiting for a free slot…" : "starting…") : "no output")}
      </pre>
    </Modal>
  );
}
