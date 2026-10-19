// Renders pending confirm() requests (promise-based, from uiStore). Stacks above any open dialog.

import { useState } from "react";
import { resolveConfirm, useUi, type UiStore } from "../store/uiStore";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

export function ConfirmDialog() {
  const req = useUi((s) => s.confirms[0]);
  if (!req) return null;
  return <ConfirmRequestView key={req.id} req={req} />;
}

/** Detail lines that all start with "• " render as a list with a hanging indent; anything else as a block. */
function bulletLines(detail: string): string[] | null {
  const lines = detail.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.length > 1 && lines.every((l) => l.startsWith("• ")) ? lines.map((l) => l.slice(2)) : null;
}

function ConfirmRequestView({ req }: { req: UiStore["confirms"][number] }) {
  const [checked, setChecked] = useState(false);
  const cancel = () => resolveConfirm(req.id, false);
  const ok = () => resolveConfirm(req.id, true, checked);
  const bullets = req.detail ? bulletLines(req.detail) : null;
  return (
    <Modal
      title={req.title}
      onClose={cancel}
      width={req.detail ? 540 : 440}
      className="confirm"
      footer={
        <>
          {/* Destructive prompts focus Cancel so a stray Enter never deletes anything. */}
          <Button onClick={cancel} data-autofocus={req.danger ? true : undefined}>
            {req.cancelLabel ?? "Cancel"}
          </Button>
          <Button variant={req.danger ? "danger" : "primary"} onClick={ok} data-autofocus={req.danger ? undefined : true}>
            {req.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {req.message && <p className="confirm-msg">{req.message}</p>}
      {bullets ? (
        <ul className="code-block confirm-list">
          {bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      ) : (
        req.detail && <pre className="code-block">{req.detail}</pre>
      )}
      {req.checkbox && (
        <label className="confirm-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.currentTarget.checked)} />
          {req.checkbox}
        </label>
      )}
    </Modal>
  );
}
