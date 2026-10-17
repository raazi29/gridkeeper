// Shared state for pane drag & drop (dataTransfer payloads are unreadable during dragover).

export interface PaneDrag {
  groupId: string;
  index: number;
  sessionId: string;
}

let current: PaneDrag | null = null;

export function beginPaneDrag(d: PaneDrag) {
  current = d;
}

export function endPaneDrag() {
  current = null;
}

export function currentPaneDrag(): PaneDrag | null {
  return current;
}
