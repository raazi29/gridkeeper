// Command palette: fuzzy search over commands, sessions (all workspaces) and workspaces.

import { useEffect, useMemo, useRef, useState } from "react";
import { COMMANDS, categoryLabel, focusSession, runCommand, switchWorkspace } from "../actions/commands";
import { useT, type MessageKey, type Translator } from "../i18n";
import { useApp } from "../store/appStore";
import { useUi, type PaletteMode } from "../store/uiStore";
import { useShortcutMap } from "./hooks";
import { IconSearch, IconTerminal } from "./icons";
import { displayCombo } from "../keybindings/combo";
import { Modal } from "./ui/Modal";
import { AGENT_LABEL, stateLabel, type Tone } from "./util/session";
import { basename, fuzzyFilter } from "./util/text";

interface Item {
  key: string;
  kind: "command" | "session" | "workspace";
  title: string;
  /** Extra text that participates in matching. */
  search: string;
  meta?: string;
  shortcut?: string;
  tone?: Tone;
  run: () => void;
}

const MAX = 120;

export function CommandPalette() {
  const open = useUi((s) => s.palette.open);
  const mode = useUi((s) => s.palette.mode);
  if (!open) return null;
  return <PaletteInner mode={mode} />;
}

function buildItems(mode: PaletteMode, shortcuts: Record<string, string>, t: Translator): Item[] {
  const s = useApp.getState();
  const items: Item[] = [];
  if (mode === "all") {
    for (const c of COMMANDS) {
      if (c.hidden) continue;
      const title = c.title;
      const category = categoryLabel(c.category);
      items.push({
        key: `c:${c.id}`,
        kind: "command",
        title,
        // The stable id also matches, so English command names keep working in any UI language.
        search: `${category} ${title} ${c.id}`,
        meta: category,
        shortcut: shortcuts[c.id] ? displayCombo(shortcuts[c.id]) : undefined,
        run: () => runCommand(c.id),
      });
    }
  }
  if (mode === "all" || mode === "sessions") {
    for (const w of s.persisted.workspaces)
      for (const g of w.groups)
        for (const id of g.sessionIds) {
          const m = s.persisted.sessions.find((x) => x.id === id);
          if (!m) continue;
          const st = stateLabel(s.runtime[id]?.state);
          items.push({
            key: `s:${id}`,
            kind: "session",
            title: mode === "all" ? t("palette.goToSession", { name: m.name }) : m.name,
            search: `${m.name} ${w.name} ${g.name} ${AGENT_LABEL[m.agent]}`,
            meta: `${w.name} / ${g.name} · ${AGENT_LABEL[m.agent]}`,
            tone: st.tone,
            run: () => focusSession(id),
          });
        }
  }
  if (mode === "all" || mode === "workspaces") {
    const active = s.persisted.activeWorkspaceId;
    for (const w of s.persisted.workspaces) {
      const n = w.groups.reduce((a, g) => a + g.sessionIds.length, 0);
      items.push({
        key: `w:${w.id}`,
        kind: "workspace",
        title: mode === "all" ? t("palette.switchToWorkspace", { name: w.name }) : w.name,
        search: `${w.name} ${basename(w.projectDir)}`,
        meta: [w.projectDir ? basename(w.projectDir) : null, t("palette.sessionCount", { count: n }), w.id === active ? t("palette.current") : null].filter(Boolean).join(" · "),
        run: () => switchWorkspace(w.id),
      });
    }
  }
  return items;
}

const PLACEHOLDER: Record<PaletteMode, MessageKey> = {
  all: "palette.placeholderAll",
  sessions: "palette.placeholderSessions",
  workspaces: "palette.placeholderWorkspaces",
};

function PaletteInner({ mode }: { mode: PaletteMode }) {
  const t = useT();
  const shortcuts = useShortcutMap();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Snapshot on open: the palette is short-lived; avoids subscribing to the runtime map.
  const all = useMemo(() => buildItems(mode, shortcuts, t), [mode, shortcuts, t]);
  const results = useMemo(() => fuzzyFilter(all, query, (i) => i.search).slice(0, MAX), [all, query]);
  const close = () => useUi.getState().closePalette();

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    close();
    // Let the palette's focus restore happen first, then act (actions may move focus).
    requestAnimationFrame(() => item.run());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setSel((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey && !e.shiftKey)) {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setSel((i) => Math.min(results.length - 1, i + 8));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 8));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[sel]);
    }
  };

  return (
    <Modal title={t("palette.title")} bare placement="top" width={560} onClose={close} className="palette" ariaLabel={t("palette.title")}>
      <div className="palette-input-row">
        <IconSearch size={14} />
        <input
          className="palette-input"
          value={query}
          placeholder={t(PLACEHOLDER[mode])}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[sel] ? `pal-${sel}` : undefined}
        />
      </div>
      <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
        {results.length === 0 && <div className="palette-empty">{t("palette.noMatches")}</div>}
        {results.map((it, i) => (
          <div
            key={it.key}
            id={`pal-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === sel}
            className={`palette-item${i === sel ? " is-selected" : ""}`}
            onMouseMove={() => i !== sel && setSel(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(it)}
          >
            <span className="palette-kind">{it.kind === "session" ? <span className={`dot is-${it.tone ?? "muted"}`} /> : it.kind === "workspace" ? <IconTerminal size={13} /> : null}</span>
            <span className="palette-title">{it.title}</span>
            {it.meta && <span className="palette-meta">{it.meta}</span>}
            {it.shortcut && <kbd className="kbd">{it.shortcut}</kbd>}
          </div>
        ))}
      </div>
    </Modal>
  );
}
