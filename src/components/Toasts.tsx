// Bottom-right toasts: notify() messages plus uiStore action toasts (e.g. "Open folder").

import { memo } from "react";
import { useToasts, type ToastKind } from "../actions/notify";
import { useUi } from "../store/uiStore";
import { IconClose, IconInfo, IconWarn } from "./icons";
import { useT } from "../i18n";

const KindIcon = ({ kind }: { kind: ToastKind }) =>
  kind === "info" ? <IconInfo size={14} /> : <IconWarn size={14} />;

const ToastRow = memo(function ToastRow({
  kind,
  message,
  detail,
  action,
  onDismiss,
}: {
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: { label: string; run: () => void };
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div className={`toast is-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span className="toast-icon">
        <KindIcon kind={kind} />
      </span>
      <div className="toast-text">
        <div className="toast-msg">{message}</div>
        {detail && <div className="toast-detail mono" title={detail}>{detail}</div>}
      </div>
      {action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            action.run();
            onDismiss();
          }}
        >
          {action.label}
        </button>
      )}
      <button type="button" className="icon-btn icon-btn-sm toast-close" aria-label={t("common.dismiss")} onClick={onDismiss}>
        <IconClose size={12} />
      </button>
    </div>
  );
});

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const actionToasts = useUi((s) => s.actionToasts);
  const dismissAction = useUi((s) => s.dismissActionToast);
  if (toasts.length === 0 && actionToasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastRow key={`n${t.id}`} kind={t.kind} message={t.message} onDismiss={() => dismiss(t.id)} />
      ))}
      {actionToasts.map((t) => (
        <ToastRow key={`a${t.id}`} kind={t.kind} message={t.message} detail={t.detail} action={t.action} onDismiss={() => dismissAction(t.id)} />
      ))}
    </div>
  );
}
