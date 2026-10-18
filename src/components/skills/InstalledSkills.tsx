// Installed tab of the Skills panel: skills in the project's .claude/skills and .agents/skills (read from disk,
// no network), with open folder, check for update (one request on click), update (same review as an install)
// and remove (confirmed; only that skill folder, never through a junction).

import { memo } from "react";
import { openExternal } from "../../actions/browser";
import { githubUrl, relativeTime, shortSha } from "../../lib/skills";
import type { InstalledSkill } from "../../lib/types";
import { checkUpdate, loadInstalled, removeSkill, selectInstalled, startUpdate, useSkills } from "../../store/skills";
import { IconExternal, IconFolder, IconRestart, IconTrash, IconWarn } from "../icons";
import { Button } from "../ui/Button";
import { revealPath } from "../util/pick";

export function InstalledList({ projectDir }: { projectDir: string | null }) {
  const status = useSkills((s) => (s.installed?.projectDir === projectDir ? s.installed.status : null));
  const items = useSkills((s) => (s.installed?.projectDir === projectDir ? s.installed.items : null));
  const error = useSkills((s) => (s.installed?.projectDir === projectDir ? s.installed.error : null));
  if (!projectDir)
    return (
      <div className="skills-list-wrap">
        <div className="skills-empty">This workspace has no project folder, so there are no project skills to show.</div>
      </div>
    );
  return (
    <div className="skills-list-wrap">
      <div className="skills-list" role="list">
        {status === "loading" && !items?.length && <div className="skills-empty">Reading the project's skill folders…</div>}
        {status === "error" && (
          <div className="skills-note is-error" role="alert">
            <IconWarn size={13} />
            <span>{error}</span>
          </div>
        )}
        {status === "ok" && items?.length === 0 && (
          <div className="skills-empty">
            No skills in <span className="mono">.claude/skills</span> or <span className="mono">.agents/skills</span> yet. Find one under Trending, Top or
            Search.
          </div>
        )}
        {items?.map((i) => <InstalledRow key={i.dirRel} skill={i} />)}
      </div>
      <div className="skills-list-foot">
        <span className="skills-source">from the project folder (no network)</span>
        <span className="skills-spacer" />
        <button type="button" className="chip" onClick={() => void loadInstalled(projectDir)}>
          Refresh
        </button>
      </div>
    </div>
  );
}

const InstalledRow = memo(function InstalledRow({ skill }: { skill: InstalledSkill }) {
  const selected = useSkills((s) => s.installedSel === skill.dirRel);
  const check = useSkills((s) => s.updateChecks[skill.dirRel]);
  return (
    <button
      type="button"
      role="listitem"
      className={`skills-row${selected ? " is-selected" : ""}`}
      aria-current={selected || undefined}
      onClick={() => selectInstalled(skill.dirRel)}
    >
      <span className="skills-row-head">
        <span className="skills-row-name">{skill.name}</span>
        <span className="chip skills-chip mono">{skill.target}</span>
        {check?.status === "ok" && check.data.status === "update" && <span className="chip chip-accent skills-chip">update</span>}
      </span>
      {skill.description && <span className="skills-row-desc">{skill.description}</span>}
      <span className="skills-row-meta">
        {skill.provenance ? (
          <span className="mono">
            {skill.provenance.repo} @ {shortSha(skill.provenance.commitSha)}
          </span>
        ) : (
          <span>local</span>
        )}
        {skill.hasScripts && <span className="skills-warn-text">scripts</span>}
        {skill.isLink && <span className="skills-warn-text">link</span>}
      </span>
    </button>
  );
});

export function InstalledDetail({ projectDir }: { projectDir: string }) {
  const skill = useSkills((s) => s.installed?.items.find((i) => i.dirRel === s.installedSel) ?? null);
  const check = useSkills((s) => (s.installedSel ? s.updateChecks[s.installedSel] : undefined));
  const busy = useSkills((s) => s.busy);
  if (!skill)
    return (
      <div className="skills-detail-empty">
        Skills installed in this project. Claude Code reads <span className="mono">.claude/skills</span>; Codex and other Agent Skills hosts read{" "}
        <span className="mono">.agents/skills</span>. Pick one to update or remove it.
      </div>
    );
  const p = skill.provenance;
  return (
    <div className="skills-detail-pad">
      <div className="skills-review-title">
        <span className="skills-review-name">{skill.name}</span>
        <span className="chip skills-chip mono">{skill.target}</span>
      </div>
      {skill.description && <p className="skills-desc">{skill.description}</p>}
      {skill.isLink && (
        <div className="skills-note is-warn">
          <IconWarn size={13} />
          <span>This folder is a junction or symbolic link. Gridkeeper lists it but never removes or replaces it.</span>
        </div>
      )}
      <dl className="skills-meta">
        <dt>Folder</dt>
        <dd className="mono" title={skill.dirAbs}>
          {skill.dirRel}
        </dd>
        <dt>Files</dt>
        <dd>
          {skill.isLink ? "?" : skill.fileCount}
          {skill.hasScripts ? " · contains scripts" : ""}
        </dd>
        <dt>Source</dt>
        <dd>
          {p ? (
            <button type="button" className="skills-link mono" onClick={() => openExternal(githubUrl(p.repo, p.commitSha, p.path))}>
              {p.repo}
              {p.path ? `/${p.path}` : ""} @ {shortSha(p.commitSha)}
            </button>
          ) : (
            "local (not installed by Gridkeeper)"
          )}
        </dd>
        {p && (
          <>
            <dt>Installed</dt>
            <dd>{relativeTime(p.installedAt, Date.now()) || p.installedAt}</dd>
          </>
        )}
      </dl>

      {check?.status === "ok" && (
        <div className={`skills-note ${check.data.status === "update" ? "is-info" : check.data.status === "missing" ? "is-warn" : "is-ok"}`}>
          <span>
            {check.data.status === "current" &&
              (check.data.currentSha === check.data.pinnedSha
                ? "Up to date with the default branch."
                : `Up to date: the skill folder is unchanged on the default branch (now ${shortSha(check.data.currentSha)}).`)}
            {check.data.status === "update" && `An update is available on the default branch (${shortSha(check.data.pinnedSha)} → ${shortSha(check.data.currentSha)}).`}
            {check.data.status === "missing" && "This skill folder no longer exists on the repository's default branch."}
          </span>
          <span className="skills-spacer" />
          {check.data.status === "update" && (
            <Button size="sm" variant="primary" onClick={() => startUpdate(skill)}>
              Review update
            </Button>
          )}
        </div>
      )}
      {check?.status === "error" && (
        <div className="skills-note is-error" role="alert">
          <IconWarn size={13} />
          <span>{check.error}</span>
        </div>
      )}

      <div className="skills-actions">
        <Button size="sm" icon={<IconFolder size={13} />} onClick={() => void revealPath(skill.dirAbs)}>
          Open folder
        </Button>
        {p && (
          <Button size="sm" icon={<IconRestart size={13} />} disabled={check?.status === "loading"} onClick={() => void checkUpdate(skill)}>
            {check?.status === "loading" ? "Checking api.github.com…" : "Check for update"}
          </Button>
        )}
        {p && (
          <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => openExternal(githubUrl(p.repo, p.commitSha, p.path))}>
            GitHub
          </Button>
        )}
        <span className="skills-spacer" />
        <Button size="sm" variant="danger" icon={<IconTrash size={13} />} disabled={skill.isLink || busy} onClick={() => void removeSkill(projectDir, skill)}>
          Remove
        </Button>
      </div>
    </div>
  );
}
