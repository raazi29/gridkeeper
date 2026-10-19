// Test command settings: the workspace's command (empty = auto-detect per folder, with a preview of what
// is detected and where it came from), an optional override for one lane, and the limits that apply
// to every run (concurrent runs, time limit).

import { useEffect, useState } from "react";
import { evidencePath } from "../../actions/handoff";
import { errorMessage, ipc } from "../../lib/ipc";
import { DEFAULT_TEST_RUN_SETTINGS, type TestDetection } from "../../lib/types";
import { useApp } from "../../store/appStore";
import { closeTestCommandDialog, saveTestCommands, type CommandDialogState } from "../../store/testrun";
import { Button } from "../ui/Button";
import { Field, NumberInput } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { commandProblem } from "./format";

/** Folder whose files the preview reads: the requested one, else the project folder, else the first session's. */
function detectDirOf(d: CommandDialogState): string | null {
  if (d.detectDir) return d.detectDir;
  const s = useApp.getState();
  const ws = s.persisted.workspaces.find((w) => w.id === d.workspaceId);
  if (!ws) return null;
  if (ws.projectDir) return ws.projectDir;
  const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
  const groups = d.groupId ? ws.groups.filter((g) => g.id === d.groupId) : ws.groups;
  for (const g of groups)
    for (const id of g.sessionIds) {
      const p = evidencePath(metas.get(id));
      if (p) return p;
    }
  return null;
}

export function TestCommandDialog({ req }: { req: CommandDialogState }) {
  const ws = useApp((s) => s.persisted.workspaces.find((w) => w.id === req.workspaceId));
  const group = ws?.groups.find((g) => g.id === req.groupId);
  const limits = useApp((s) => s.persisted.settings.testRuns ?? DEFAULT_TEST_RUN_SETTINGS);
  const [wsCmd, setWsCmd] = useState(ws?.testCommand ?? "");
  const [laneCmd, setLaneCmd] = useState(group?.testCommand ?? "");
  const [maxConcurrent, setMaxConcurrent] = useState(limits.maxConcurrent);
  const [timeoutMin, setTimeoutMin] = useState(limits.timeoutMin);
  const [dir] = useState(() => detectDirOf(req));
  const [det, setDet] = useState<TestDetection | null>(null);
  const [detError, setDetError] = useState<string | null>(null);

  useEffect(() => {
    if (!dir) return;
    let alive = true;
    ipc
      .testDetect(dir)
      .then((d) => alive && setDet(d))
      .catch((e) => alive && setDetError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [dir]);

  if (!ws) return null;
  const wsProblem = commandProblem(wsCmd);
  const laneProblem = group ? commandProblem(laneCmd) : null;
  const effective = (group && laneCmd.trim()) || wsCmd.trim() || det?.command || null;
  const save = () => {
    if (wsProblem || laneProblem) return;
    saveTestCommands(ws.id, wsCmd, group ? group.id : null, laneCmd);
    useApp.getState().updateSettings({ testRuns: { maxConcurrent, timeoutMin } });
    const then = req.then;
    closeTestCommandDialog();
    if (then && effective) then();
  };
  const pick = (cmd: string) => (group ? setLaneCmd(cmd) : setWsCmd(cmd));

  return (
    <Modal
      title={group ? `Test command · ${ws.name} › ${group.name}` : `Test command · ${ws.name}`}
      onClose={closeTestCommandDialog}
      width={640}
      className="tr-cmd-dialog"
      footer={
        <>
          <Button onClick={closeTestCommandDialog}>Cancel</Button>
          <Button variant="primary" disabled={!!wsProblem || !!laneProblem || (!!req.then && !effective)} onClick={save}>
            {req.then ? "Save and run" : "Save"}
          </Button>
        </>
      }
    >
      <div className="form">
        {req.reason && <div className="callout tr-callout-warn">{req.reason}</div>}
        <div className="tr-detect">
          <div className="tr-detect-head">
            Detected in <span className="mono tr-ellipsis" title={dir ?? undefined}>{dir ?? "(no folder)"}</span>
          </div>
          {detError ? (
            <div className="tr-dim">{detError}</div>
          ) : !dir ? (
            <div className="tr-dim">The workspace has no project folder or session folder to look in.</div>
          ) : !det ? (
            <div className="tr-dim">reading…</div>
          ) : det.candidates.length === 0 ? (
            <div className="tr-dim">Nothing found (package.json "test" script, Cargo.toml, pytest config, go.mod, Makefile test target).</div>
          ) : (
            <ul className="tr-candidates">
              {det.candidates.map((c, i) => (
                <li key={c.command}>
                  <button type="button" className="tr-candidate" title={`Use “${c.command}”`} onClick={() => pick(c.command)}>
                    <span className="mono">{c.command}</span>
                  </button>
                  <span className="tr-dim">{c.source}</span>
                  {i === 0 && <span className="tr-tag">auto</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Field label="Workspace command" hint="Empty: auto-detect in each folder that is tested." error={wsProblem}>
          <input className="input mono" value={wsCmd} placeholder={det?.command ?? "auto-detect"} spellCheck={false} data-autofocus={group ? undefined : true} onChange={(e) => setWsCmd(e.target.value)} />
        </Field>
        {group && (
          <Field label={`Lane override (${group.name})`} hint="Empty: the workspace command." error={laneProblem}>
            <input className="input mono" value={laneCmd} placeholder={wsCmd.trim() || det?.command || "workspace command"} spellCheck={false} data-autofocus onChange={(e) => setLaneCmd(e.target.value)} />
          </Field>
        )}
        <div className="tr-effective">
          Runs: <span className="mono">{effective ?? "nothing (no command)"}</span>
          <span className="tr-dim"> · in the session's worktree (or its folder), CI=true, below-normal priority</span>
        </div>
        <div className="tr-limits">
          <Field label="At most" inline hint="runs at once, all workspaces (the rest wait)">
            <NumberInput value={maxConcurrent} min={1} max={8} onCommit={setMaxConcurrent} width={64} />
          </Field>
          <Field label="Time limit" inline hint="minutes per run, then the run and everything it started are stopped">
            <NumberInput value={timeoutMin} min={1} max={240} onCommit={setTimeoutMin} width={72} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
