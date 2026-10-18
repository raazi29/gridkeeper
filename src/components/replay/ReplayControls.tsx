// Mission Control header: the "● rec" indicator (start / stop a mission replay recording) and the
// "replay…" button that opens the Replay dialog. Re-renders only when this project's recording
// status changes (once per flushed batch at most).

import { formatClock } from "../../replay/timeline";
import { startRecording, stopRecording } from "../../replay/recorder";
import { dirKey } from "../../store/missionDoc";
import { openReplay, useReplay } from "../../store/replay";
import "./replay.css";

export function ReplayHeaderControls({ projectDir }: { projectDir: string | null }) {
  const key = projectDir ? dirKey(projectDir) : null;
  const rec = useReplay((s) => (key ? s.recording[key] : undefined));
  const on = !!rec;
  const title = !projectDir
    ? "This workspace has no project folder, so there is no mission to record"
    : on
      ? `Recording a mission replay since ${formatClock(rec.startedAt)} (${rec.events} events). Click to stop.`
      : "Record a mission replay: goal, tasks, agent states, branch stats and short messages. Never terminal output, files, paths or e-mails.";
  return (
    <>
      <button
        type="button"
        className={`mc-btn rp-rec${on ? " is-on" : ""}`}
        disabled={!projectDir}
        aria-pressed={on}
        title={title}
        onClick={() => {
          if (!projectDir) return;
          if (on) stopRecording(projectDir);
          else void startRecording(projectDir, { manual: true });
        }}
      >
        <span className="rp-rec-dot" aria-hidden="true" />
        rec
      </button>
      <button type="button" className="mc-btn" title="Turn a recorded mission into a shareable timelapse video or GIF" onClick={() => openReplay(projectDir)}>
        replay…
      </button>
    </>
  );
}
