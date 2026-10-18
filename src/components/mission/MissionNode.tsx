// Mission node: the shared mission board at the top of Mission Control, rendered live from
// `<projectDir>/.gridkeeper/mission.md` (format: lib/missionDoc.ts). Goal, progress, tasks grouped
// doing → todo → blocked → done with clickable state boxes and owner chips, plus "edit file…" (raw editor
// with a conflict check), "open folder" and "brief team…" (one confirmed line per agent). Without a project
// folder it explains why; without a mission file it offers a small "set a mission" form.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { gatherBrief, sendBrief, type BriefRecipient, type BriefSkip } from "../../actions/missionBrief";
import { notify } from "../../actions/notify";
import {
  newMissionText,
  nextState,
  ownersFor,
  progress,
  STATE_ORDER,
  type MissionDoc,
  type Task,
  type TaskState,
  type TeamMember,
} from "../../lib/missionDoc";
import type { MissionFile, SessionId } from "../../lib/types";
import { useApp } from "../../store/appStore";
import { reloadMission, updateTaskState, useMissionDocs, writeMission, type MissionEntry } from "../../store/missionDoc";
import { confirmDialog } from "../../store/uiStore";
import { Button } from "../ui/Button";
import type { MenuItem } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import { pickFolder, revealPath } from "../util/pick";
import { RoleTag, roleStyle } from "./RoleTag";
import "../../styles/missionBoard.css";

type MenuEvent = { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void };

export const BOX_TEXT: Record<TaskState, string> = { todo: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]" };
const STATE_TEXT: Record<TaskState, string> = { todo: "todo", doing: "doing", done: "done", blocked: "blocked" };

export interface MissionNodeProps {
  workspaceId: string | null;
  projectDir: string | null;
  mission: MissionEntry;
  /** Process sessions of the workspace (name + role), for owner chips and briefs. */
  team: TeamMember[];
  onSelectSession: (id: SessionId) => void;
  openMenu: (e: MenuEvent, items: MenuItem[]) => void;
}

export function MissionNode({ workspaceId, projectDir, mission, team, onSelectSession, openMenu }: MissionNodeProps) {
  const [dialog, setDialog] = useState<"edit" | "brief" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // A closed dialog would hand focus back to the terminal under the overlay: keep it in Mission Control.
  const hadDialog = useRef(false);
  useLayoutEffect(() => {
    if (dialog) hadDialog.current = true;
    else if (hadDialog.current) {
      hadDialog.current = false;
      root.current?.focus({ preventScroll: true });
    }
  }, [dialog]);

  if (!projectDir)
    return (
      <div data-node="mission" className="mc-node mb-node is-placeholder" ref={root} tabIndex={-1}>
        <span className="mc-node-label">mission</span>
        <div>
          A mission needs a project folder: the shared task board lives in <span className="mc-strong">&lt;folder&gt;\.gridkeeper\mission.md</span>, where every
          agent can read and edit it.
        </div>
        {workspaceId && (
          <div className="mc-empty-actions">
            <button
              type="button"
              className="mc-btn is-primary"
              onClick={async () => {
                const dir = await pickFolder("Choose project folder", null);
                if (dir) useApp.getState().updateWorkspace(workspaceId, { projectDir: dir });
              }}
            >
              choose project folder…
            </button>
          </div>
        )}
      </div>
    );

  const { file, doc } = mission;
  const label = <span className="mc-node-label">mission · shared task board</span>;

  if (!file)
    return (
      <div data-node="mission" className="mc-node mb-node is-placeholder" ref={root} tabIndex={-1}>
        {label}
        {mission.error ? (
          <>
            <div className="mb-error">could not read the mission file: {mission.error}</div>
            <div className="mc-empty-actions">
              <button type="button" className="mc-btn" onClick={() => void reloadMission(projectDir)}>
                retry
              </button>
            </div>
          </>
        ) : (
          <div className="mc-empty">reading mission file…</div>
        )}
      </div>
    );

  if (!file.exists || !doc)
    return (
      <div data-node="mission" className="mc-node mb-node" ref={root} tabIndex={-1}>
        {label}
        <SetMission projectDir={projectDir} path={file.path} />
      </div>
    );

  return (
    <div data-node="mission" className="mc-node mb-node is-solid" ref={root} tabIndex={-1}>
      {label}
      <Board
        projectDir={projectDir}
        file={file}
        doc={doc}
        team={team}
        error={mission.error}
        onSelectSession={onSelectSession}
        openMenu={openMenu}
        onEdit={() => setDialog("edit")}
        onBrief={() => setDialog("brief")}
      />
      {dialog === "edit" && <EditMissionDialog projectDir={projectDir} file={file} onClose={() => setDialog(null)} />}
      {dialog === "brief" && <BriefDialog missionPath={file.path} team={team} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ---- board -------------------------------------------------------------------------------------

function Board({
  projectDir,
  file,
  doc,
  team,
  error,
  onSelectSession,
  openMenu,
  onEdit,
  onBrief,
}: {
  projectDir: string;
  file: MissionFile;
  doc: MissionDoc;
  team: TeamMember[];
  error: string | null;
  onSelectSession: (id: SessionId) => void;
  openMenu: (e: MenuEvent, items: MenuItem[]) => void;
  onEdit: () => void;
  onBrief: () => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const [writing, setWriting] = useState(false);
  const p = progress(doc.tasks);
  const unassigned = doc.tasks.filter((t) => t.state !== "done" && ownersFor(t, team).length === 0).length;
  const byState = useMemo(() => {
    const m: Record<TaskState, Task[]> = { doing: [], todo: [], blocked: [], done: [] };
    for (const t of doc.tasks) m[t.state].push(t);
    return m;
  }, [doc.tasks]);

  const setState = async (t: Task, state: TaskState) => {
    if (writing || state === t.state) return;
    setWriting(true);
    try {
      await updateTaskState(projectDir, t.line, state);
    } finally {
      setWriting(false);
    }
  };
  const stateMenu = (t: Task): MenuItem[] =>
    (["todo", "doing", "done", "blocked"] as const).map((s) => ({
      label: `${BOX_TEXT[s]} ${STATE_TEXT[s]}`,
      checked: t.state === s,
      disabled: writing,
      onSelect: () => void setState(t, s),
    }));

  return (
    <>
      <span className="mc-node-label mc-node-label-right">{p.total ? `${p.done}/${p.total} done` : "no tasks yet"}</span>
      <div className="mb-goal">
        <span className="mb-goal-label mc-micro">goal</span>
        <span className="mc-strong mb-goal-text" title={doc.goal ?? undefined}>
          {doc.goal ?? <span className="mb-muted">no goal — add a “# Mission: …” heading</span>}
        </span>
      </div>
      {doc.context && (
        <div className="mb-context" title={doc.context}>
          {doc.context}
        </div>
      )}
      <div className="mc-lane-head mc-micro mb-progress">
        <span className="mc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label={`${p.done} of ${p.total} tasks done`}>
          <span style={{ width: `${Math.round(p.fraction * 100)}%` } as CSSProperties} />
        </span>
        <span>
          {p.done}/{p.total} done
        </span>
        <span className="mc-lane-stats">
          {p.doing > 0 && <span className="is-working">{p.doing} doing</span>}
          {p.blocked > 0 && <span className="is-err">{p.blocked} blocked</span>}
          {unassigned > 0 && <span className="is-needs">{unassigned} unassigned</span>}
        </span>
      </div>

      {p.total === 0 ? (
        <div className="mc-empty">no tasks yet — brief the team so the lead splits the mission into “- [ ] task @owner” lines, or edit the file</div>
      ) : (
        <div className="mb-groups">
          {STATE_ORDER.map((s) => {
            const list = byState[s];
            if (list.length === 0) return null;
            if (s === "done" && !showDone)
              return (
                <button key={s} type="button" className="mb-done-toggle mc-micro" aria-expanded={false} onClick={() => setShowDone(true)}>
                  ▸ {list.length} done
                </button>
              );
            return (
              <div key={s} className={`mb-group is-${s}`}>
                {s === "done" ? (
                  <button type="button" className="mb-done-toggle mc-micro" aria-expanded onClick={() => setShowDone(false)}>
                    ▾ {list.length} done
                  </button>
                ) : (
                  <div className="mb-group-head mc-micro">
                    {STATE_TEXT[s]} · {list.length}
                  </div>
                )}
                <ul className="mb-tasks">
                  {list.map((t) => (
                    <TaskRow
                      key={t.line}
                      task={t}
                      team={team}
                      disabled={writing}
                      onCycle={() => void setState(t, nextState(t.state))}
                      onMenu={(e) => openMenu(e, stateMenu(t))}
                      onSelectSession={onSelectSession}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="mb-error">last re-read failed: {error}</div>}
      <div className="mc-node-actions mb-actions">
        <span className="mc-path mb-path" title={file.path}>
          {file.path}
        </span>
        <button type="button" className="mc-btn" title="Edit the raw Markdown file (saved with a conflict check)" onClick={onEdit}>
          edit file…
        </button>
        <button type="button" className="mc-btn" title="Show mission.md in Explorer" onClick={() => void revealPath(file.path)}>
          open folder
        </button>
        <button
          type="button"
          className="mc-btn is-primary"
          title="Send each running agent one line about the mission file, based on its role (shows every line first; nothing is sent until you press Send)"
          onClick={onBrief}
        >
          brief team…
        </button>
      </div>
    </>
  );
}

function TaskRow({
  task,
  team,
  disabled,
  onCycle,
  onMenu,
  onSelectSession,
}: {
  task: Task;
  team: TeamMember[];
  disabled: boolean;
  onCycle: () => void;
  onMenu: (e: MenuEvent) => void;
  onSelectSession: (id: SessionId) => void;
}) {
  const next = nextState(task.state);
  return (
    <li className={`mb-task is-${task.state}`} onContextMenu={onMenu}>
      <button
        type="button"
        className="mb-box"
        disabled={disabled}
        title={`${STATE_TEXT[task.state]} — click: ${STATE_TEXT[next]} · right-click: set any state (blocked…)`}
        aria-label={`${task.text}: ${STATE_TEXT[task.state]}. Mark ${STATE_TEXT[next]}`}
        onClick={onCycle}
      >
        {BOX_TEXT[task.state]}
      </button>
      <span className="mb-text" title={task.text}>
        {task.text || <span className="mb-muted">(empty)</span>}
      </span>
      <span className="mb-owners">
        {task.owners.length === 0 && task.state !== "done" && (
          <span className="mb-flag" title="No @owner on this task">
            unassigned
          </span>
        )}
        {task.owners.map((o) => (
          <OwnerChip key={o} owner={o} team={team} onSelectSession={onSelectSession} />
        ))}
      </span>
    </li>
  );
}

function OwnerChip({ owner, team, onSelectSession }: { owner: string; team: TeamMember[]; onSelectSession: (id: SessionId) => void }) {
  const ids = ownersFor({ owners: [owner] }, team);
  const first = team.find((m) => m.id === ids[0]);
  if (!first)
    return (
      <span className="mb-owner is-unknown" title={`No session in this workspace is named or has the role “${owner}”`}>
        @{owner}
      </span>
    );
  const names = team.filter((m) => ids.includes(m.id)).map((m) => m.name);
  return (
    <button
      type="button"
      className="mb-owner"
      style={roleStyle(first.role)}
      title={`${names.join(", ")} — click to select${ids.length > 1 ? " the first" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelectSession(first.id);
      }}
    >
      @{owner}
      {ids.length > 1 && <span className="mb-owner-n">×{ids.length}</span>}
    </button>
  );
}

// ---- no mission file yet -------------------------------------------------------------------------

function SetMission({ projectDir, path }: { projectDir: string; path: string }) {
  const [goal, setGoal] = useState("");
  const [tasks, setTasks] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      const r = await writeMission(projectDir, newMissionText(goal, "", tasks.split(/\r?\n/)), null);
      if (r.ok) notify("info", "Mission set — brief the team so every agent knows where it is");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mb-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="mc-empty">
        no mission yet — set one and every agent can read and update it in <span title={path}>.gridkeeper\mission.md</span>
      </div>
      <label className="mb-field">
        <span className="mc-micro">goal</span>
        <input className="mb-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Add OAuth login" spellCheck={false} aria-label="Mission goal" />
      </label>
      <label className="mb-field">
        <span className="mc-micro">tasks (optional, one per line, “@owner” to assign)</span>
        <textarea
          className="mb-input mb-textarea"
          value={tasks}
          onChange={(e) => setTasks(e.target.value)}
          placeholder={"Design the token storage @lead\nImplement /auth/callback @builder-1"}
          spellCheck={false}
          rows={3}
          aria-label="Mission tasks, one per line"
        />
      </label>
      <div className="mc-empty-actions mb-form-actions">
        <button type="submit" className="mc-btn is-primary" disabled={!goal.trim() || busy}>
          {busy ? "creating…" : "create mission"}
        </button>
      </div>
    </form>
  );
}

// ---- raw editor ----------------------------------------------------------------------------------

function EditMissionDialog({ projectDir, file, onClose }: { projectDir: string; file: MissionFile; onClose: () => void }) {
  const [text, setText] = useState(file.text);
  // What the edit is based on: the text + modification time last loaded from disk.
  const [baseText, setBaseText] = useState(file.text);
  const [base, setBase] = useState(file.modifiedMs);
  const [busy, setBusy] = useState(false);
  const latest = useMissionDocs((s) => s.byDir[projectDir]?.file ?? null);
  const dirty = text !== baseText;
  const changedOnDisk = !!latest && latest.modifiedMs !== base;

  const loadLatest = () => {
    const f = useMissionDocs.getState().byDir[projectDir]?.file;
    if (!f) return;
    setText(f.text);
    setBaseText(f.text);
    setBase(f.modifiedMs);
  };
  // Untouched editor: follow the file as agents change it. With edits: warn instead (see below).
  useEffect(() => {
    if (changedOnDisk && !dirty) loadLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest]);
  const requestClose = async () => {
    if (dirty && !(await confirmDialog({ title: "Discard your edits?", message: "The mission file stays as it is on disk.", confirmLabel: "Discard", danger: true }))) return;
    onClose();
  };
  const save = async (overwrite = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const expected = overwrite ? (useMissionDocs.getState().byDir[projectDir]?.file?.modifiedMs ?? null) : base;
      const r = await writeMission(projectDir, text, expected);
      if (r.ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Mission file"
      onClose={() => void requestClose()}
      width={780}
      footer={
        <>
          <span className="mb-editor-path mono" title={file.path}>
            {file.path}
          </span>
          <Button onClick={() => void requestClose()}>Cancel</Button>
          {changedOnDisk ? (
            <Button variant="danger" onClick={() => void save(true)} disabled={busy} title="Replace the newer file on disk with your text">
              Overwrite
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save"}
            </Button>
          )}
        </>
      }
    >
      {changedOnDisk && (
        <div className="mb-editor-warn" role="status">
          The file changed on disk while you were editing (an agent may have updated it).{" "}
          <button type="button" className="link-btn" onClick={loadLatest}>
            Load the latest version
          </button>{" "}
          (discards your edits) or Overwrite it.
        </div>
      )}
      <textarea
        className="mb-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="Mission file (Markdown)"
        data-autofocus
        onKeyDown={(e) => {
          if (e.key === "s" && (e.ctrlKey || e.metaKey) && !changedOnDisk) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="mb-editor-hint muted">
        Tasks: <code>- [ ] task @owner</code> · boxes <code>[ ]</code> todo, <code>[~]</code> doing, <code>[x]</code> done, <code>[!]</code> blocked · owners are
        session names or roles (<code>@builder</code> = every builder).
      </div>
    </Modal>
  );
}

// ---- brief team ----------------------------------------------------------------------------------

interface Draft extends BriefRecipient {
  on: boolean;
}

function BriefDialog({ missionPath, team, onClose }: { missionPath: string; team: TeamMember[]; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [skipped, setSkipped] = useState<BriefSkip[]>([]);
  const [busy, setBusy] = useState(false);
  const ids = useMemo(() => team.map((m) => m.id), [team]);

  useEffect(() => {
    let cancelled = false;
    void gatherBrief(ids, missionPath).then((r) => {
      if (cancelled) return;
      setDrafts(r.recipients.map((x) => ({ ...x, on: true })));
      setSkipped(r.skipped);
    });
    return () => {
      cancelled = true;
    };
    // Snapshot once per open: the team changing underneath must not wipe the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosen = (drafts ?? []).filter((d) => d.on && d.text.trim());
  const edit = (id: SessionId, p: Partial<Draft>) => setDrafts((ds) => ds && ds.map((d) => (d.id === id ? { ...d, ...p } : d)));
  const send = async () => {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    try {
      const r = await sendBrief(chosen);
      const bits = [`${r.sent.length} sent`];
      if (r.skipped.length) bits.push(`skipped (now asking something): ${r.skipped.join(", ")}`);
      if (r.failed.length) bits.push(`failed: ${r.failed.join(", ")}`);
      notify(r.failed.length ? "error" : r.skipped.length ? "warn" : "info", `Mission brief — ${bits.join(" · ")}`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Brief the team"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void send()} disabled={busy || chosen.length === 0}>
            {busy ? "Sending…" : `Send to ${chosen.length} session${chosen.length === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <p className="confirm-msg">
        Each line below is typed into that agent and submitted with Enter. Agents that are asking you something are skipped, because an Enter there would answer
        it. Edit any line first; nothing is sent until you press Send.
      </p>
      {drafts === null ? (
        <div className="muted">Checking the running sessions…</div>
      ) : (
        <div className="mb-brief">
          {drafts.length === 0 && <div className="muted">No running agent can be briefed right now.</div>}
          {drafts.map((d) => (
            <div key={d.id} className={`mb-brief-row${d.on ? "" : " is-off"}`}>
              <label className="mb-brief-who">
                <input type="checkbox" checked={d.on} onChange={(e) => edit(d.id, { on: e.currentTarget.checked })} aria-label={`Send to ${d.name}`} />
                <span className="mb-brief-name">{d.name}</span>
                <RoleTag role={d.role} />
              </label>
              <textarea
                className="fm-textarea mb-brief-text"
                value={d.text}
                disabled={!d.on}
                onChange={(e) => edit(d.id, { text: e.target.value })}
                spellCheck={false}
                aria-label={`Brief for ${d.name}`}
              />
            </div>
          ))}
          {skipped.length > 0 && (
            <div className="mb-brief-skipped">
              <div className="mc-micro">skipped</div>
              {skipped.map((s) => (
                <div key={s.id}>
                  {s.name} — <span className="muted">{s.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
