// FLIP transitions for the graph canvas: when cards move between lanes or reorder, lanes reorder or fold, and
// pins change, every moved card / box glides from where it was to where it is now (transform only, Web
// Animations, ~320 ms); a card that appears fades in. The "first" positions are read in
// getSnapshotBeforeUpdate (before React touches the DOM), the "last" ones after, both as layout positions
// (layoutRect: zoom and running animations do not matter). Nothing runs unless `flipKey` changes.

import { Component, type ReactNode, type RefObject } from "react";
import { layoutRect } from "./layout";
import type { Rect } from "./viewport";

const SELECTOR = "[data-card], [data-node^='lane:'], [data-node='lead'], [data-node='signoff'], .mc-newlane";
const DURATION = 320;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

function keyOf(el: HTMLElement): string | null {
  if (el.dataset.card) return `c:${el.dataset.card}`;
  if (el.dataset.node) return `n:${el.dataset.node}`;
  if (el.classList.contains("mc-newlane")) return "newlane";
  return null;
}

function measure(root: HTMLElement): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
    const k = keyOf(el);
    const r = k ? layoutRect(el, root) : null;
    if (k && r) out.set(k, r);
  }
  return out;
}

interface Props {
  root: RefObject<HTMLElement | null>;
  flipKey: string;
  enabled: boolean;
  children?: ReactNode;
}

export class FlipLayer extends Component<Props> {
  private timer: ReturnType<typeof setTimeout> | undefined;

  getSnapshotBeforeUpdate(prev: Props): Map<string, Rect> | null {
    if (!this.props.enabled || prev.flipKey === this.props.flipKey) return null;
    const root = this.props.root.current;
    return root ? measure(root) : null;
  }

  componentDidUpdate(_prev: Props, _state: unknown, before: Map<string, Rect> | null): void {
    const root = this.props.root.current;
    if (!before || !root || typeof root.animate !== "function") return;
    let moved = 0;
    for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
      const k = keyOf(el);
      if (!k) continue;
      const a = before.get(k);
      const b = layoutRect(el, root);
      if (!b) continue;
      if (!a) {
        if (k.startsWith("c:")) el.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: DURATION, easing: EASE });
        continue;
      }
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      moved++;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: DURATION, easing: EASE });
    }
    if (!moved) return;
    // Connectors are measured at the final layout: fade them while the boxes glide.
    root.classList.add("is-flipping");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => root.classList.remove("is-flipping"), DURATION);
  }

  componentWillUnmount(): void {
    clearTimeout(this.timer);
  }

  render(): ReactNode {
    return this.props.children ?? null;
  }
}
