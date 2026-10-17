// Group grid. STUB — implemented by the terminal/layout owner.
// Lays out the group's panes (grid/columns/rows, resizable, maximize), each with a PaneHeader and TerminalView.

export interface GroupGridProps {
  groupId: string;
  /** False when this group is not on screen; the grid is display:none but terminals stay alive. */
  active: boolean;
}

export function GroupGrid(_props: GroupGridProps) {
  return null;
}
