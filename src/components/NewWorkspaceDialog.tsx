// New workspace: name + project folder.

import { useState } from "react";
import { switchWorkspace } from "../actions/commands";
import { ipc } from "../lib/ipc";
import { useApp } from "../store/appStore";
import { IconFolder } from "./icons";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { pickFolder } from "./util/pick";
import { basename } from "./util/text";

export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const browse = async () => {
    const d = await pickFolder("Choose project folder", dir || null);
    if (d) {
      setDir(d);
      setError(null);
    }
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const folder = dir.trim();
    let normalized: string | null = folder || null;
    if (folder) {
      setBusy(true);
      try {
        const info = await ipc.pathInfo(folder);
        if (!info.exists || !info.isDir) {
          setError("Folder not found");
          setBusy(false);
          return;
        }
        normalized = info.normalized ?? folder;
      } catch {
        // Backend unavailable: accept the path as typed.
      }
      setBusy(false);
    }
    const finalName = name.trim() || (normalized ? basename(normalized) : "") || "Workspace";
    const id = useApp.getState().createWorkspace(finalName, normalized);
    switchWorkspace(id);
    onClose();
  };

  return (
    <Modal
      title="New workspace"
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            Create workspace
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <Field label="Name" htmlFor="nw-name" hint="Defaults to the folder name">
          <Input id="nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={dir ? basename(dir) : "e.g. api-server"} data-autofocus />
        </Field>
        <Field label="Project folder" htmlFor="nw-dir" error={error} hint="New sessions start here. Optional.">
          <div className="input-group">
            <Input
              id="nw-dir"
              mono
              value={dir}
              invalid={!!error}
              onChange={(e) => {
                setDir(e.target.value);
                setError(null);
              }}
              placeholder={"D:\\code\\project"}
            />
            <Button icon={<IconFolder size={13} />} onClick={() => void browse()}>
              Browse…
            </Button>
          </div>
        </Field>
      </form>
    </Modal>
  );
}
