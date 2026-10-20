// "?" in Mission Control: a compact sheet of every key and gesture, grouped. Esc, ? or a click outside closes it.

import { useEffect, useRef } from "react";
import { useT, type Translator } from "../../i18n";
import { isMac } from "../../lib/platform";
import { useDeck } from "../../store/missionDeck";
import { T } from "./mcText";

/** The sheet, built at render time: key names (Ctrl, Shift, Esc…) and gestures ("click", "drag") are translated. */
function groups(t: Translator): { title: string; rows: [string, string][] }[] {
  const mod = isMac ? "⌘" : t("keys.ctrl");
  const shift = t("keys.shift");
  const alt = t("keys.alt");
  return [
    {
      title: t("mc.shortcuts.group.selectMove"),
      rows: [
        ["← ↑ ↓ →", t("mc.shortcuts.row.selectCard")],
        [`${t("keys.home")} / ${t("keys.end")}`, t("mc.shortcuts.row.firstLast")],
        [t("mc.shortcuts.key.click"), t("mc.shortcuts.row.selectOpensPanel")],
        [t("mc.shortcuts.key.modClick", { mod }), t("mc.shortcuts.row.toggleSelection")],
        [t("mc.shortcuts.key.shiftClick", { shift }), t("mc.shortcuts.row.selectRange")],
        [`${mod}+A`, t("mc.shortcuts.row.selectAll")],
        [t("mc.shortcuts.key.shiftDrag", { shift }), t("mc.shortcuts.row.boxSelect")],
        [t("mc.shortcuts.key.enterDoubleClick", { enter: t("keys.enter") }), t("mc.shortcuts.row.jump")],
        [`${alt}+← →`, t("mc.shortcuts.row.reorder")],
        [`${alt}+↑ ↓`, t("mc.shortcuts.row.moveLane")],
      ],
    },
    {
      title: t("mc.shortcuts.group.canvas"),
      rows: [
        [t("mc.shortcuts.key.modWheel", { mod }), t("mc.shortcuts.row.zoomPointer")],
        ["+ / −", t("mc.shortcuts.row.zoomInOut")],
        ["0", "100 %"],
        ["F", t("mc.shortcuts.row.fit")],
        [t("mc.shortcuts.key.wheelSpace", { space: t("keys.space") }), t("mc.shortcuts.row.pan")],
        [t("mc.shortcuts.key.middleDrag"), t("mc.shortcuts.row.pan")],
        ["H / V", t("mc.shortcuts.row.tools")],
        [`${shift}+M`, t("mc.shortcuts.row.minimap")],
      ],
    },
    {
      title: t("mc.shortcuts.group.actOnCard"),
      rows: [
        ["R", t("mc.shortcuts.row.restart")],
        ["S", t("mc.shortcuts.row.stopStart")],
        ["M", t("mc.shortcuts.row.message")],
        [t("keys.delete"), t("mc.shortcuts.row.close")],
        ["F2", t("mc.shortcuts.row.rename")],
        ["P", t("mc.shortcuts.row.pin")],
        [`${shift}+F10`, t("mc.shortcuts.row.menu")],
      ],
    },
    {
      title: t("mc.shortcuts.group.viewsFocus"),
      rows: [
        ["1 · 2 · 3 · 4", t("mc.shortcuts.row.views")],
        [`${mod}+F`, t("mc.shortcuts.row.find")],
        [".", t("mc.shortcuts.row.spotAgent")],
        [t("mc.shortcuts.key.clickLaneName"), t("mc.shortcuts.row.spotLane")],
        ["I", t("mc.shortcuts.row.panel")],
        ["?", t("mc.shortcuts.row.sheet")],
        [t("keys.escape"), t("mc.shortcuts.row.escape")],
      ],
    },
    {
      title: t("mc.shortcuts.group.boardTask"),
      rows: [
        ["↑ ↓ ← →", t("mc.shortcuts.row.taskMove")],
        [t("keys.space"), t("mc.shortcuts.row.taskNext")],
        [`${alt}+← →`, t("mc.shortcuts.row.taskGive")],
        [t("keys.enter"), t("mc.shortcuts.row.taskAgent")],
        [t("mc.shortcuts.key.drag"), t("mc.shortcuts.row.taskReassign")],
      ],
    },
  ];
}

export function ShortcutSheet() {
  const t = useT();
  const set = useDeck((s) => s.set);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.focus();
  }, []);
  const close = () => {
    set({ sheetOpen: false });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".mc")?.focus({ preventScroll: true }));
  };
  return (
    <div className="mc-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={root}
        className="mc-sheet"
        role="dialog"
        aria-label={T.sheet.title}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || e.key === "?") {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="mc-sheet-head">
          <span className="mc-micro">{T.sheet.title}</span>
          <button type="button" className="mc-btn mc-btn-icon" title={T.sheet.close} aria-label={T.sheet.close} onClick={close}>
            ✕
          </button>
        </div>
        <div className="mc-sheet-grid">
          {groups(t).map((g, gi) => (
            <section key={gi} className="mc-sheet-group">
              <h4 className="mc-micro">{g.title}</h4>
              <dl>
                {g.rows.map(([k, v], ri) => (
                  <div key={ri} className="mc-sheet-row">
                    <dt>
                      <kbd>{k}</kbd>
                    </dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
