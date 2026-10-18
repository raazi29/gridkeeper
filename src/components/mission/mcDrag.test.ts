import { beforeEach, describe, expect, it } from "vitest";
import {
  beginLaneDrag,
  beginSessionDrag,
  beginTaskDrag,
  currentLaneDrag,
  currentSessionDrag,
  currentTaskDrag,
  dragHas,
  endAllMcDrags,
  endSessionDrag,
  endTaskDrag,
  TASK_MIME,
  useMcDragKind,
} from "./mcDrag";

describe("mission control drag state", () => {
  beforeEach(endAllMcDrags);

  it("keeps the current drag readable during dragover and publishes its kind", () => {
    beginSessionDrag({ sessionId: "s1", fromGroupId: "g1" });
    expect(currentSessionDrag()).toEqual({ sessionId: "s1", fromGroupId: "g1" });
    // No requestAnimationFrame in this environment: published at once.
    expect(useMcDragKind.getState()).toEqual({ kind: "session", sessionId: "s1" });
    endSessionDrag();
    expect(currentSessionDrag()).toBeNull();
    expect(useMcDragKind.getState()).toEqual({ kind: null, sessionId: null });
  });

  it("task drags (mission board contract) and the end-all fallback", () => {
    beginTaskDrag({ line: 7, text: "write tests" });
    expect(currentTaskDrag()).toEqual({ line: 7, text: "write tests" });
    expect(useMcDragKind.getState().kind).toBe("task");
    endTaskDrag();
    expect(currentTaskDrag()).toBeNull();
    beginLaneDrag({ groupId: "g2" });
    beginTaskDrag({ line: 1, text: "x" });
    endAllMcDrags();
    expect(currentLaneDrag()).toBeNull();
    expect(currentTaskDrag()).toBeNull();
    expect(useMcDragKind.getState().kind).toBeNull();
  });

  it("dragHas reads the MIME types only", () => {
    const dt = { types: [TASK_MIME] } as unknown as DataTransfer;
    expect(dragHas({ dataTransfer: dt }, TASK_MIME)).toBe(true);
    expect(dragHas({ dataTransfer: dt }, "text/plain")).toBe(false);
    expect(dragHas({ dataTransfer: null }, TASK_MIME)).toBe(false);
  });
});
