// Claude account profiles: list, check status, add, edit, remove (entry only).

import { APP_NAME } from "../lib/brand";
import { memo, useState } from "react";
import { notify } from "../actions/notify";
import { errorMessage, ipc } from "../lib/ipc";
import type { ClaudeProfile } from "../lib/types";
import { useApp } from "../store/appStore";
import { confirmDialog } from "../store/uiStore";
import { IconEdit, IconFolder, IconPlus, IconTrash } from "./icons";
import { Button, IconButton } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { pickFolder } from "./util/pick";
import { profileStatusText } from "./util/session";

const COLORS = ["#7b61ff", "#58a6ff", "#3fb950", "#d29922", "#f85149", "#db61a2", "#39c5cf", "#a9a9b6"];

async function refreshProfiles() {
  try {
    useApp.getState().setProfiles(await ipc.profilesList());
  } catch (e) {
    notify("error", `Could not load profiles: ${errorMessage(e)}`);
  }
}

export function ProfilesDialog({ onClose }: { onClose: () => void }) {
  const profiles = useApp((s) => s.profiles);
  const [adding, setAdding] = useState(false);

  return (
    <Modal
      title="Claude account profiles"
      onClose={onClose}
      width={640}
      headerExtra={
        !adding && (
          <Button size="sm" icon={<IconPlus size={12} />} onClick={() => setAdding(true)}>
            Add profile
          </Button>
        )
      }
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <p className="explain explain-top">
        Each profile is a separate Claude Code config folder (<span className="mono">CLAUDE_CONFIG_DIR</span>) with its own login, settings and history. Sessions using
        different profiles run side by side as different accounts. {APP_NAME} never reads or copies credentials.
      </p>
      {adding && <AddProfileForm onDone={() => setAdding(false)} />}
      <div className="profile-list">
        {profiles.length === 0 && <div className="empty-row">No profiles yet. Sessions use the default Claude Code login (~/.claude).</div>}
        {profiles.map((p) => (
          <ProfileRow key={p.id} profile={p} />
        ))}
      </div>
    </Modal>
  );
}

const ProfileRow = memo(function ProfileRow({ profile }: { profile: ClaudeProfile }) {
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState(profile.color);
  const st = profileStatusText(profile);
  const signedIn = profile.status.loggedIn || profile.status.likelyAuthenticated;

  const check = async () => {
    setChecking(true);
    try {
      const status = await ipc.profileCheck(profile.id);
      const s = useApp.getState();
      s.setProfiles(s.profiles.map((p) => (p.id === profile.id ? { ...p, status } : p)));
    } catch (e) {
      notify("error", `Check failed: ${errorMessage(e)}`);
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    try {
      const updated = await ipc.profileUpdate({ ...profile, name: name.trim() || profile.name, color });
      const s = useApp.getState();
      s.setProfiles(s.profiles.map((p) => (p.id === profile.id ? updated : p)));
      setEditing(false);
    } catch (e) {
      notify("error", `Could not save profile: ${errorMessage(e)}`);
    }
  };

  const remove = async () => {
    const inUse = useApp.getState().persisted.sessions.filter((m) => m.profileId === profile.id).length;
    const ok = await confirmDialog({
      title: `Remove profile “${profile.name}”?`,
      message:
        `Removes the entry from ${APP_NAME} only. The config folder — including its login and history — is NOT deleted.` +
        (inUse ? ` ${inUse} session definition${inUse === 1 ? " uses" : "s use"} it and will fall back to the default login on next start.` : ""),
      detail: profile.configDir ?? undefined,
      confirmLabel: "Remove entry",
      danger: true,
    });
    if (!ok) return;
    try {
      await ipc.profileDelete(profile.id);
      await refreshProfiles();
    } catch (e) {
      notify("error", `Could not remove profile: ${errorMessage(e)}`);
    }
  };

  return (
    <div className="profile-row">
      <span className="dot dot-lg" style={{ background: editing ? color : profile.color }} />
      <div className="profile-main">
        {editing ? (
          <div className="profile-edit">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Profile name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <ColorPicker value={color} onChange={setColor} />
            <Button size="sm" variant="primary" onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="profile-name-row">
            <span className="profile-name">{profile.name}</span>
            <span className={`chip tone-${st.tone}`}>{st.text}</span>
            {profile.status.authMethod && <span className="chip">{profile.status.authMethod}</span>}
            {profile.status.account && <span className="muted profile-account">{profile.status.account}</span>}
          </div>
        )}
        <div className="profile-dir mono" title={profile.configDir ?? undefined}>
          {profile.configDir ?? "Default (~/.claude)"}
        </div>
        {!signedIn && <div className="field-msg is-warn">Start a Claude Code session with this profile and run /login</div>}
        {profile.status.note && <div className="field-msg">{profile.status.note}</div>}
      </div>
      {!editing && (
        <div className="profile-actions">
          <Button size="sm" onClick={() => void check()} disabled={checking}>
            {checking ? "Checking…" : "Check status"}
          </Button>
          <IconButton size="sm" label="Edit name and colour" onClick={() => setEditing(true)}>
            <IconEdit size={13} />
          </IconButton>
          <IconButton size="sm" label="Remove profile entry" onClick={() => void remove()}>
            <IconTrash size={13} />
          </IconButton>
        </div>
      )}
    </div>
  );
});

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="Colour">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c}
          aria-label={c}
          className={`swatch${value.toLowerCase() === c ? " is-selected" : ""}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function AddProfileForm({ onDone }: { onDone: () => void }) {
  const profiles = useApp((s) => s.profiles);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [color, setColor] = useState(COLORS[profiles.length % COLORS.length]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError("Enter a name");
      return;
    }
    if (!dir.trim()) {
      setError("Choose or type a config folder");
      return;
    }
    setBusy(true);
    try {
      await ipc.profileCreate(name.trim(), dir.trim(), color);
      await refreshProfiles();
      notify("info", `Profile “${name.trim()}” added. Start a Claude Code session with it and run /login.`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="add-profile"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="section-label">New profile</div>
      <Field label="Name" htmlFor="ap-name">
        <Input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work account" data-autofocus autoFocus />
      </Field>
      <Field label="Config folder" htmlFor="ap-dir" error={error}>
        <div className="input-group">
          <Input id="ap-dir" mono value={dir} onChange={(e) => setDir(e.target.value)} placeholder={"C:\\Users\\you\\.claude-work"} />
          <Button
            icon={<IconFolder size={13} />}
            onClick={async () => {
              const d = await pickFolder("Claude config folder");
              if (d) setDir(d);
            }}
          >
            Browse…
          </Button>
        </div>
      </Field>
      <Field label="Colour">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      <p className="explain">
        If the folder does not exist, an empty one is created. Then start a Claude Code session with this profile and run <span className="mono">/login</span> — the app never copies
        credentials between profiles.
      </p>
      <div className="row-end">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? "Adding…" : "Add profile"}
        </Button>
      </div>
    </div>
  );
}
