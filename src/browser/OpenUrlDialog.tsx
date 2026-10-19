// "Open URL…": address for a new browser pane (localhost:5173, :3000, example.com, C:\docs\x.html).

import { useState } from "react";
import { openBrowserPane } from "../actions/browser";
import { normalizeUrlInput, urlForPort } from "../lib/url";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { Modal } from "../components/ui/Modal";
import { useT } from "../i18n";
import { PortsList } from "./PortsList";

export function OpenUrlDialog({ groupId, onClose }: { groupId?: string; onClose: () => void }) {
  const t = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const open = (url: string | null) => {
    if (!url) {
      setError(t("browser.openUrl.invalid"));
      return;
    }
    onClose();
    openBrowserPane({ url, groupId });
  };

  return (
    <Modal
      title={t("browser.openUrl.title")}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => open(normalizeUrlInput(value))}>
            {t("common.open")}
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          open(normalizeUrlInput(value));
        }}
      >
        <Field label={t("browser.address")} htmlFor="ou-url" error={error} hint={t("browser.openUrl.hint")}>
          <Input
            id="ou-url"
            mono
            value={value}
            invalid={!!error}
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="localhost:5173"
            data-autofocus
          />
        </Field>
        <div className="section-label">{t("browser.devServers")}</div>
        <PortsList onPick={(port) => open(urlForPort(port))} compact />
      </form>
    </Modal>
  );
}
