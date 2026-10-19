// Mission Control header: the "● rec" indicator (start / stop a mission replay recording) and the
// "replay…" button that opens the Replay dialog. Re-renders only when this project's recording
// status changes (once per flushed batch at most).

import { useT } from "../../i18n";
import { formatClock } from "../../replay/timeline";
import { startRecording, stopRecording } from "../../replay/recorder";
import { dirKey } from "../../store/missionDoc";
import { openReplay, useReplay } from "../../store/replay";
import "./replay.css";

export function ReplayHeaderControls({ projectDir }: { projectDir: string | null }) {
  const t = useT();
  const key = projectDir ? dirKey(projectDir) : null;
  const rec = useReplay((s) => (key ? s.recording[key] : undefined));
  const on = !!rec;
  const title = !projectDir
    ? t("replay.recNoProject")
    : on
      ? t("replay.recOn", { time: formatClock(rec.startedAt), count: rec.events })
      : t("replay.recOff");
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
        {t("replay.recButton")}
      </button>
      <button type="button" className="mc-btn rp-replay" title={t("replay.replayTitle")} onClick={() => openReplay(projectDir)}>
        {t("replay.replayButton")}
      </button>
    </>
  );
}
