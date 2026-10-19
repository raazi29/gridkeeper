// Renders the test-run dialogs (log viewer, test command settings, ask-the-agent confirmation) from
// store/testrun.ts. Mounted once in the Shell; dialogs portal above Mission Control.

import { useTestRuns } from "../../store/testrun";
import { AskAgentDialog } from "./AskAgentDialog";
import { TestCommandDialog } from "./TestCommandDialog";
import { TestLogDialog } from "./TestLogDialog";
import "../../styles/testrun.css";

export function TestRunHost() {
  const viewer = useTestRuns((s) => s.viewer);
  const cmd = useTestRuns((s) => s.commandDialog);
  const ask = useTestRuns((s) => s.ask);
  return (
    <>
      {viewer && <TestLogDialog key={viewer} runId={viewer} />}
      {cmd && <TestCommandDialog key={`${cmd.workspaceId}:${cmd.groupId ?? ""}`} req={cmd} />}
      {ask && <AskAgentDialog key={`${ask.sessionId}:${ask.kind}`} req={ask} />}
    </>
  );
}
