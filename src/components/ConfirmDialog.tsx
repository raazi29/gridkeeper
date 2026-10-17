// Renders pending confirm() requests (promise-based, from uiStore). Stacks above any open dialog.

import { resolveConfirm, useUi } from "../store/uiStore";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

export function ConfirmDialog() {
  const req = useUi((s) => s.confirms[0]);
  if (!req) return null;
  const cancel = () => resolveConfirm(req.id, false);
  const ok = () => resolveConfirm(req.id, true);
  return (
    <Modal
      key={req.id}
      title={req.title}
      onClose={cancel}
      width={440}
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
      {req.detail && <pre className="code-block">{req.detail}</pre>}
    </Modal>
  );
}
