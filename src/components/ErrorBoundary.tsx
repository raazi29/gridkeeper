// Contains render errors so one broken component never blanks the whole window.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { ipc } from "../lib/ipc";
import { t } from "../i18n";

interface Props {
  /** Shown in the fallback, already translated: t("errors.scopePane"), t("errors.scopeApp") … */
  scope: string;
  children: ReactNode;
  compact?: boolean;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void ipc.log("error", `[ui] ${this.props.scope} crashed: ${error.message}\n${info.componentStack ?? ""}`.slice(0, 4000));
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.compact ? "crash crash--compact" : "crash"} role="alert">
        <div className="crash-title">{t("errors.crashTitle", { scope: this.props.scope })}</div>
        <div className="crash-msg mono">{this.state.error.message}</div>
        <div className="crash-note">{t("errors.crashNote")}</div>
        <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
          {t("errors.tryAgain")}
        </button>
      </div>
    );
  }
}
