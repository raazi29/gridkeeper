// <TerminalView>: a container the registry mounts the session's persistent terminal element into.
// It subscribes to nothing in the store, so terminal output never causes React renders.

import { memo, useEffect, useLayoutEffect, useRef } from "react";
import type { SessionId } from "../lib/types";
import { mountTerminal, setTerminalVisible, unmountTerminal } from "./registry";

export interface TerminalViewProps {
  sessionId: SessionId;
  /** False when the pane is not on screen (inactive group, behind a maximized pane…): releases WebGL. */
  visible: boolean;
}

export const TerminalView = memo(function TerminalView({ sessionId, visible }: TerminalViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    mountTerminal(sessionId, el);
    setTerminalVisible(sessionId, visibleRef.current, el);
    return () => {
      setTerminalVisible(sessionId, false, el);
      unmountTerminal(sessionId, el);
    };
  }, [sessionId]);

  useEffect(() => {
    if (ref.current) setTerminalVisible(sessionId, visible, ref.current);
  }, [sessionId, visible]);

  return <div ref={ref} className="terminal-view" data-terminal-container={sessionId} />;
});
