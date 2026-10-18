// Assign a mission task (a line of <projectDir>/.gridkeeper/mission.md) to a session: called when a task
// dragged from the mission board is dropped on a Mission Control session card.
// STUB: the mission board owns this file and replaces the body.

export async function assignTaskToSession(sessionId: string, line: number): Promise<void> {
  void sessionId;
  void line;
  throw new Error("not implemented");
}
