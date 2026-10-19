// New workspace: name + project folder.

import { useState } from "react";
import { switchWorkspace } from "../actions/commands";
import { useT } from "../i18n";
import { ipc } from "../lib/ipc";
import { folderPlaceholder } from "../lib/platform";
import { useApp } from "../store/appStore";
import { IconFolder } from "./icons";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { pickFolder } from "./util/pick";
import { basename } from "./util/text";

export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const browse = async () => {
    const d = await pickFolder(t("newWorkspace.chooseFolder"), dir || null);
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
          setError(t("newWorkspace.folderNotFound"));
          setBusy(false);
          return;
        }
        normalized = info.normalized ?? folder;
      } catch {
        // Backend unavailable: accept the path as typed.
      }
      setBusy(false);
    }
    const finalName = name.trim() || (normalized ? basename(normalized) : "") || t("command.defaultWorkspaceName");
    const id = useApp.getState().createWorkspace(finalName, normalized);
    switchWorkspace(id);
    onClose();
  };

  return (
    <Modal
      title={t("newWorkspace.title")}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {t("newWorkspace.create")}
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
        <Field label={t("newWorkspace.name")} htmlFor="nw-name" hint={t("newWorkspace.nameHint")}>
          <Input id="nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={dir ? basename(dir) : t("newWorkspace.namePlaceholder")} data-autofocus />
        </Field>
        <Field label={t("newWorkspace.projectFolder")} htmlFor="nw-dir" error={error} hint={t("newWorkspace.projectFolderHint")}>
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
              placeholder={folderPlaceholder()}
            />
            <Button icon={<IconFolder size={13} />} onClick={() => void browse()}>
              {t("common.browse")}
            </Button>
          </div>
        </Field>
      </form>
    </Modal>
  );
}
