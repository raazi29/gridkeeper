// Mission Control extension points, so features from other branches plug in without editing Mission Control:
// - card actions: buttons in the agent panel's action row (and the selection bar when `bulk` is set), e.g.
//   "run tests" or "merge";
// - header actions: elements rendered in Mission Control's header, before "message all…" (e.g. a Brain button).
// Register at module load (or in an install function); registrations are app-wide and keyed by id.

import type { ReactNode } from "react";
import { create } from "zustand";
import type { SessionId } from "../../lib/types";

export interface McCardAction {
  id: string;
  label: string;
  title?: string;
  /** Lower first; built-in actions use 0–99. */
  order?: number;
  /** Hidden (not just disabled) when false. Default: always shown. */
  visible?: (id: SessionId) => boolean;
  disabled?: (id: SessionId) => boolean;
  run: (id: SessionId) => void | Promise<void>;
  /** Also offered in the multi-selection bar (run once per selected agent). */
  bulk?: boolean;
  danger?: boolean;
}

export interface McHeaderAction {
  id: string;
  order?: number;
  render: () => ReactNode;
}

interface Registry {
  card: McCardAction[];
  header: McHeaderAction[];
}

export const useMcExtensions = create<Registry>()(() => ({ card: [], header: [] }));

const byOrder = <T extends { order?: number }>(a: T, b: T) => (a.order ?? 100) - (b.order ?? 100);

/** Adds (or replaces, by id) a card action. Returns an unregister function. */
export function registerMcCardAction(a: McCardAction): () => void {
  useMcExtensions.setState((s) => ({ card: [...s.card.filter((x) => x.id !== a.id), a].sort(byOrder) }));
  return () => useMcExtensions.setState((s) => ({ card: s.card.filter((x) => x !== a) }));
}

/** Adds (or replaces, by id) a header action. Returns an unregister function. */
export function registerMcHeaderAction(a: McHeaderAction): () => void {
  useMcExtensions.setState((s) => ({ header: [...s.header.filter((x) => x.id !== a.id), a].sort(byOrder) }));
  return () => useMcExtensions.setState((s) => ({ header: s.header.filter((x) => x !== a) }));
}

/** A registered card action whose id says it runs tests ("run-tests", "tests.run", …), if any. */
export function findTestAction(actions: readonly McCardAction[]): McCardAction | null {
  return actions.find((a) => /(^|[.\-:])tests?([.\-:]|$)|run-?tests/i.test(a.id)) ?? null;
}
