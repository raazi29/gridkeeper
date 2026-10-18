// Mission Control drag state shared by the mission board (task rows) and the session cards (drop targets).
// MINIMAL VERSION from the mission-board branch: the cards branch owns the real module (same exports); the
// integrator keeps theirs. A task drag carries MIME "application/x-gridkeeper-task" with JSON { line, text }.

export interface TaskDrag {
  /** 0-based line of the task in mission.md (as last read). */
  line: number;
  /** The task's text as the board showed it (owner tokens removed), to detect a stale line. */
  text: string;
}

let current: TaskDrag | null = null;

export function beginTaskDrag(d: TaskDrag): void {
  current = d;
}

export function endTaskDrag(): void {
  current = null;
}

export function currentTaskDrag(): TaskDrag | null {
  return current;
}
