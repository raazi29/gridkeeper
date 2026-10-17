// "Open URL…": address for a new browser pane (localhost:5173, :3000, example.com, C:\docs\x.html).

import { useState } from "react";
import { openBrowserPane } from "../actions/browser";
import { normalizeUrlInput, urlForPort } from "../lib/url";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { Modal } from "../components/ui/Modal";
import { PortsList } from "./PortsList";

export function OpenUrlDialog({ groupId, onClose }: { groupId?: string; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const open = (url: string | null) => {
    if (!url) {
      setError("Enter an http, https or file address — e.g. localhost:5173 or example.com");
      return;
    }
    onClose();
    openBrowserPane({ url, groupId });
  };

  return (
    <Modal
      title="Open URL in a browser pane"
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => open(normalizeUrlInput(value))}>
            Open
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
        <Field label="Address" htmlFor="ou-url" error={error} hint="localhost:5173, :3000, https://…, or a local .html file path">
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
        <div className="section-label">Dev servers started by your sessions</div>
        <PortsList onPick={(port) => open(urlForPort(port))} compact />
      </form>
    </Modal>
  );
}
