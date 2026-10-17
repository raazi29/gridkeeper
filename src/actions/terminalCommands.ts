// Per-pane terminal tools: find bar and font zoom. Spread into COMMANDS (commands.ts); `target` is
// commands.ts's focused-session resolver (with its "no session focused" toast), passed in to avoid an
// import cycle.

import type { SessionId } from "../lib/types";
import { useFind } from "../store/findStore";
import { zoomTerminal } from "../terminal/registry";
import type { Command } from "./commands";

export function terminalCommands(target: () => SessionId | null): Command[] {
  const zoom = (dir: 1 | -1 | 0) => {
    const id = target();
    if (id) zoomTerminal(id, dir);
  };
  return [
    {
      id: "terminal.find",
      title: "Find in terminal…",
      category: "Session",
      run: () => {
        const id = target();
        if (id) useFind.getState().open(id);
      },
    },
    { id: "terminal.zoomIn", title: "Zoom in (focused pane)", category: "Session", run: () => zoom(1) },
    { id: "terminal.zoomOut", title: "Zoom out (focused pane)", category: "Session", run: () => zoom(-1) },
    { id: "terminal.zoomReset", title: "Reset zoom (focused pane)", category: "Session", run: () => zoom(0) },
  ];
}
