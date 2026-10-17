// Contains render errors so one broken component never blanks the whole window.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { ipc } from "../lib/ipc";

interface Props {
  /** Shown in the fallback, e.g. "This pane" or "The app". */
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
        <div className="crash-title">{this.props.scope} hit an error</div>
        <div className="crash-msg mono">{this.state.error.message}</div>
        <div className="crash-note">Sessions keep running in the background.</div>
        <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
