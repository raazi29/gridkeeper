// Group grid: lays out the group's panes (grid / columns / rows) with resizable splits and maximize.
// Nested react-resizable-panels: a vertical Group of rows, each row a horizontal Group of panes.
// Sizes persist per layout signature (preset + pane count) in group.layout.sizes.

import { memo, useCallback, useMemo, type ReactNode } from "react";
import { Group as PanelGroup, Panel, Separator, type Layout as PanelLayout, type LayoutChangedMeta } from "react-resizable-panels";
import type { Group, LayoutPreset, SessionId } from "../lib/types";
import { useApp, type AppStore } from "../store/appStore";
import { Pane } from "./Pane";
import { chunkRows, equalSizes, layoutSignature, rowKey, rowsKey, validSizes } from "./gridGeometry";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { QuickLaunchPanel } from "../components/QuickLaunch";
import { openAppMenu } from "../components/ContextMenuHost";
import { buildBackgroundMenu } from "../components/menus/containerMenus";
import "./layout.css";

export interface GroupGridProps {
  groupId: string;
  /** False when this group is not on screen; the grid is display:none but terminals stay alive. */
  active: boolean;
}

const selectGroup =
  (groupId: string) =>
  (s: AppStore): Group | undefined => {
    for (const w of s.persisted.workspaces) for (const g of w.groups) if (g.id === groupId) return g;
    return undefined;
  };

// ---- debounced size persistence -------------------------------------------------------------

const pendingSizes = new Map<string, Record<string, number[]>>();
const pendingTimers = new Map<string, number>();

function queueSizeSave(groupId: string, key: string, sizes: number[]) {
  const p = pendingSizes.get(groupId) ?? {};
  p[key] = sizes.map((x) => Math.round(x * 100) / 100);
  pendingSizes.set(groupId, p);
  const t = pendingTimers.get(groupId);
  if (t !== undefined) window.clearTimeout(t);
  pendingTimers.set(
    groupId,
    window.setTimeout(() => {
      pendingTimers.delete(groupId);
      const patch = pendingSizes.get(groupId);
      pendingSizes.delete(groupId);
      const g = selectGroup(groupId)(useApp.getState());
      if (!g || !patch) return;
      useApp.getState().updateLayout(groupId, { sizes: { ...g.layout.sizes, ...patch } });
    }, 300),
  );
}

function toPanelLayout(ids: string[], sizes: number[]): PanelLayout {
  const out: PanelLayout = {};
  ids.forEach((id, i) => (out[id] = sizes[i]));
  return out;
}

function useSizePersistence(groupId: string, key: string, panelIds: string[]) {
  return useCallback(
    (layout: PanelLayout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      const req = meta.requestedLayout ?? layout;
      const arr = panelIds.map((id) => req[id]);
      if (arr.every((x) => Number.isFinite(x))) queueSizeSave(groupId, key, arr);
    },
    // panelIds is derived from a count; join to keep the callback stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groupId, key, panelIds.join(",")],
  );
}

// ---- rows -----------------------------------------------------------------------------------

interface RowProps {
  groupId: string;
  sig: string;
  row: number;
  ids: SessionId[];
  offset: number;
  count: number;
  visible: boolean;
  savedSizes: number[] | undefined;
}

const PaneRow = memo(function PaneRow({ groupId, sig, row, ids, offset, count, visible, savedSizes }: RowProps) {
  const key = rowKey(sig, row);
  const panelIds = useMemo(() => ids.map((_, j) => `p${j}`), [ids.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const onLayoutChanged = useSizePersistence(groupId, key, panelIds);
  // defaultLayout is read on mount only; the Group is keyed by signature so shape changes remount it.
  const defaultLayout = useMemo(
    () => toPanelLayout(panelIds, validSizes(savedSizes, ids.length) ?? equalSizes(ids.length)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return (
    <PanelGroup
      key={key}
      id={`${groupId}:${key}`}
      orientation="horizontal"
      className="grid-row"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      {ids.map((id, j) => (
        <PaneSlot key={`p${j}`} panelId={`p${j}`} first={j === 0} minSize={140}>
          <ErrorBoundary scope="This pane" compact>
            <Pane key={id} sessionId={id} groupId={groupId} index={offset + j} count={count} visible={visible} maximized={false} />
          </ErrorBoundary>
        </PaneSlot>
      ))}
    </PanelGroup>
  );
});

function PaneSlot({
  panelId,
  first,
  minSize,
  children,
}: {
  panelId: string;
  first: boolean;
  minSize: number;
  children: ReactNode;
}) {
  return (
    <>
      {!first && <Separator className="grid-sep" />}
      <Panel id={panelId} minSize={minSize} className="grid-cell" style={{ overflow: "hidden" }}>
        {children}
      </Panel>
    </>
  );
}

// ---- grid -----------------------------------------------------------------------------------

function Grid({
  groupId,
  ids,
  preset,
  sizes,
  visible,
}: {
  groupId: string;
  ids: SessionId[];
  preset: LayoutPreset;
  sizes: Record<string, number[]>;
  visible: boolean;
}) {
  const sig = layoutSignature(preset, ids.length);
  const rows = useMemo(() => chunkRows(ids, preset), [ids, preset]);
  const outerKey = rowsKey(sig);
  const rowPanelIds = useMemo(() => rows.map((_, i) => `r${i}`), [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const onLayoutChanged = useSizePersistence(groupId, outerKey, rowPanelIds);
  const defaultLayout = useMemo(
    () => toPanelLayout(rowPanelIds, validSizes(sizes[outerKey], rows.length) ?? equalSizes(rows.length)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outerKey],
  );

  let offset = 0;
  return (
    <PanelGroup
      key={outerKey}
      id={`${groupId}:${outerKey}`}
      orientation="vertical"
      className="grid-rows"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      {rows.map((rowIds, i) => {
        const start = offset;
        offset += rowIds.length;
        return (
          <PaneSlot key={`r${i}`} panelId={`r${i}`} first={i === 0} minSize={90}>
            <PaneRow
              groupId={groupId}
              sig={sig}
              row={i}
              ids={rowIds}
              offset={start}
              count={ids.length}
              visible={visible}
              savedSizes={sizes[rowKey(sig, i)]}
            />
          </PaneSlot>
        );
      })}
    </PanelGroup>
  );
}

function EmptyState() {
  return (
    <div className="grid-empty">
      <div className="grid-empty-title">No sessions in this group</div>
      <div className="grid-empty-hint">Start one — it opens in this workspace's project folder</div>
      <QuickLaunchPanel />
    </div>
  );
}

export const GroupGrid = memo(function GroupGrid({ groupId, active }: GroupGridProps) {
  const group = useApp(selectGroup(groupId));
  if (!group) return null;
  const { sessionIds, layout } = group;
  const maximized = layout.maximized && sessionIds.includes(layout.maximized) ? layout.maximized : null;
  const maxIndex = maximized ? sessionIds.indexOf(maximized) : -1;

  return (
    <div
      className="group-grid"
      style={active ? undefined : { display: "none" }}
      data-group-id={groupId}
      onContextMenu={(e) => {
        // Background / empty-group menu; panes (header, terminal, overlays) handle their own right-clicks.
        if ((e.target as HTMLElement).closest(".pane, input, textarea, button")) return;
        e.preventDefault();
        openAppMenu(e.clientX, e.clientY, buildBackgroundMenu(groupId));
      }}
    >
      {sessionIds.length === 0 ? (
        <EmptyState />
      ) : maximized ? (
        <div className="grid-maximized">
          <Pane
            key={maximized}
            sessionId={maximized}
            groupId={groupId}
            index={maxIndex}
            count={sessionIds.length}
            visible={active}
            maximized
          />
        </div>
      ) : (
        <Grid groupId={groupId} ids={sessionIds} preset={layout.preset} sizes={layout.sizes} visible={active} />
      )}
    </div>
  );
});
