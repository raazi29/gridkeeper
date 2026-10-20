// Skills panel ("Skills: discover & add…"): find Agent Skills on GitHub (Trending / Top / Search / Paste a
// repo), review one (SKILL.md, files, scripts warning, license, pinned commit) and install it into the active
// workspace's project folder for every agent at once; manage installed skills.
// All network goes through Rust (ipc.skills*: curl.exe, api.github.com / raw.githubusercontent.com) and only
// on a user action; the frontend never fetches GitHub itself (CSP connect-src is IPC only).

import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT, type MessageKey } from "../../i18n";
import { isTerminalMeta } from "../../lib/browserPanes";
import type { AgentKind } from "../../lib/types";
import { isLive, selectActiveWorkspace, useApp } from "../../store/appStore";
import { closeSkills, loadInstalled, setSkillsTab, useSkills, type SkillsTab, type WorkspaceAgent } from "../../store/skills";
import { ErrorBoundary } from "../ErrorBoundary";
import { Modal } from "../ui/Modal";
import { DiscoverList, PasteRepo } from "./DiscoverList";
import { InstalledDetail, InstalledList } from "./InstalledSkills";
import { RepoView } from "./SkillReview";
import "../../styles/skills.css";

/** Mounted once by Shell; renders the panel while open. */
export function SkillsLayer() {
  const t = useT();
  const open = useSkills((s) => s.open);
  return (
    <ErrorBoundary key={open ? "open" : "closed"} scope={t("skills.title")}>
      {open && <SkillsPanel />}
    </ErrorBoundary>
  );
}

const TABS: { id: SkillsTab; label: MessageKey }[] = [
  { id: "trending", label: "skills.tab.trending" },
  { id: "top", label: "skills.tab.top" },
  { id: "search", label: "skills.tab.search" },
  { id: "paste", label: "skills.tab.paste" },
  { id: "installed", label: "skills.tab.installed" },
];

/** Terminal sessions of the active workspace (agent kind, running or not). */
function useWorkspaceAgents(): WorkspaceAgent[] {
  const rows = useApp(
    useShallow((s) => {
      const ws = selectActiveWorkspace(s);
      if (!ws) return [] as string[];
      const ids = new Set(ws.groups.flatMap((g) => g.sessionIds));
      return s.persisted.sessions
        .filter((m) => ids.has(m.id) && isTerminalMeta(m))
        .map((m) => `${m.id}\u0000${m.agent}\u0000${isLive(s.runtime[m.id]) ? 1 : 0}`);
    }),
  );
  return useMemo(
    () =>
      rows.map((row) => {
        const [id, agent, live] = row.split("\u0000");
        return { id, agent: agent as AgentKind, live: live === "1" };
      }),
    [rows],
  );
}

function SkillsPanel() {
  const t = useT();
  const tab = useSkills((s) => s.tab);
  const projectDir = useApp((s) => selectActiveWorkspace(s)?.projectDir ?? null);
  const installedCount = useSkills((s) => (s.installed && s.installed.projectDir === projectDir ? s.installed.items.length : null));
  const agents = useWorkspaceAgents();

  // The project's installed skills (local files, no network): for the Installed tab and "installed" badges.
  useEffect(() => {
    if (projectDir) void loadInstalled(projectDir);
  }, [projectDir]);

  return (
    <Modal
      title={
        <span className="skills-title">
          <IconSkills size={15} /> {t("skills.title")}
          <span className="skills-title-sub">{t("skills.subtitle")}</span>
        </span>
      }
      ariaLabel={t("skills.title")}
      onClose={closeSkills}
      width={1100}
      className="skills-modal"
    >
      <div className="skills-tabs" role="tablist" aria-label={t("skills.title")}>
        {TABS.map((tb) => (
          <button
            key={tb.id}
            type="button"
            role="tab"
            aria-selected={tab === tb.id}
            className={`skills-tab${tab === tb.id ? " is-selected" : ""}`}
            onClick={() => setSkillsTab(tb.id)}
          >
            {t(tb.label)}
            {tb.id === "installed" && installedCount !== null && <span className="skills-tab-count">{installedCount}</span>}
          </button>
        ))}
        <span className="skills-spacer" />
        <span className="skills-source" title={t("skills.sourceTitle")}>
          {t("skills.source")}
        </span>
      </div>
      <div className="skills-cols">
        <div className="skills-left">
          {(tab === "trending" || tab === "top" || tab === "search") && <DiscoverList key={tab} tab={tab} />}
          {tab === "paste" && <PasteRepo />}
          {tab === "installed" && <InstalledList projectDir={projectDir} />}
        </div>
        <div className="skills-right">
          <DetailPane tab={tab} projectDir={projectDir} agents={agents} />
        </div>
      </div>
    </Modal>
  );
}

function DetailPane({ tab, projectDir, agents }: { tab: SkillsTab; projectDir: string | null; agents: WorkspaceAgent[] }) {
  const selection = useSkills((s) => s.selection);
  const updating = useSkills((s) => s.updating !== null);
  if (tab === "installed") {
    if (updating && selection) return <RepoView selection={selection} projectDir={projectDir} agents={agents} />;
    return projectDir ? <InstalledDetail projectDir={projectDir} /> : <Intro />;
  }
  if (selection) return <RepoView selection={selection} projectDir={projectDir} agents={agents} />;
  return <Intro />;
}

function Intro() {
  const t = useT();
  return (
    <div className="skills-detail-empty">
      <p>{t.rich("skills.intro", { b: (c) => <b>{c}</b>, mono: (c) => <span className="mono">{c}</span> })}</p>
      <p>{t("skills.introPick")}</p>
    </div>
  );
}

function IconSkills({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 2.5h7l3 3v8H3z" />
      <path d="M10 2.5v3h3" />
      <path d="M8 7.2l.8 1.6 1.7.25-1.25 1.2.3 1.7L8 11.15 6.45 11.95l.3-1.7L5.5 9.05l1.7-.25z" />
    </svg>
  );
}
