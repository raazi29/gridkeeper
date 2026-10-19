// Installed tab of the Skills panel: skills in the project's .claude/skills and .agents/skills (read from disk,
// no network), with open folder, check for update (one request on click), update (same review as an install)
// and remove (confirmed; only that skill folder, never through a junction).

import { memo } from "react";
import { openExternal } from "../../actions/browser";
import { useT } from "../../i18n";
import { githubUrl, relativeTime, shortSha } from "../../lib/skills";
import type { InstalledSkill } from "../../lib/types";
import { checkUpdate, loadInstalled, removeSkill, selectInstalled, startUpdate, useSkills } from "../../store/skills";
import { IconExternal, IconFolder, IconRestart, IconTrash, IconWarn } from "../icons";
import { Button } from "../ui/Button";
import { revealPath } from "../util/pick";

export function InstalledList({ projectDir }: { projectDir: string | null }) {
  const t = useT();
  const status = useSkills((s) => (s.installed?.projectDir === projectDir ? s.installed.status : null));
  const items = useSkills((s) => (s.installed?.projectDir === projectDir ? s.installed.items : null));
  const error = useSkills((s) => (s.installed?.projectDir === projectDir ? s.installed.error : null));
  if (!projectDir)
    return (
      <div className="skills-list-wrap">
        <div className="skills-empty">{t("skills.installed.noProject")}</div>
      </div>
    );
  return (
    <div className="skills-list-wrap">
      <div className="skills-list" role="list">
        {status === "loading" && !items?.length && <div className="skills-empty">{t("skills.installed.reading")}</div>}
        {status === "error" && (
          <div className="skills-note is-error" role="alert">
            <IconWarn size={13} />
            <span>{error}</span>
          </div>
        )}
        {status === "ok" && items?.length === 0 && (
          <div className="skills-empty">{t.rich("skills.installed.empty", { mono: (c) => <span className="mono">{c}</span> })}</div>
        )}
        {items?.map((i) => <InstalledRow key={i.dirRel} skill={i} />)}
      </div>
      <div className="skills-list-foot">
        <span className="skills-source">{t("skills.installed.footSource")}</span>
        <span className="skills-spacer" />
        <button type="button" className="chip" onClick={() => void loadInstalled(projectDir)}>
          {t("common.refresh")}
        </button>
      </div>
    </div>
  );
}

const InstalledRow = memo(function InstalledRow({ skill }: { skill: InstalledSkill }) {
  const t = useT();
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
        {check?.status === "ok" && check.data.status === "update" && <span className="chip chip-accent skills-chip">{t("skills.installed.updateChip")}</span>}
      </span>
      {skill.description && <span className="skills-row-desc">{skill.description}</span>}
      <span className="skills-row-meta">
        {skill.provenance ? (
          <span className="mono">
            {skill.provenance.repo} @ {shortSha(skill.provenance.commitSha)}
          </span>
        ) : (
          <span>{t("skills.installed.local")}</span>
        )}
        {skill.hasScripts && <span className="skills-warn-text">{t("skills.chipScripts")}</span>}
        {skill.isLink && <span className="skills-warn-text">{t("skills.installed.link")}</span>}
      </span>
    </button>
  );
});

export function InstalledDetail({ projectDir }: { projectDir: string }) {
  const t = useT();
  const skill = useSkills((s) => s.installed?.items.find((i) => i.dirRel === s.installedSel) ?? null);
  const check = useSkills((s) => (s.installedSel ? s.updateChecks[s.installedSel] : undefined));
  const busy = useSkills((s) => s.busy);
  if (!skill)
    return (
      <div className="skills-detail-empty">{t.rich("skills.installed.intro", { mono: (c) => <span className="mono">{c}</span> })}</div>
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
          <span>{t("skills.installed.isLink")}</span>
        </div>
      )}
      <dl className="skills-meta">
        <dt>{t("skills.installed.dtFolder")}</dt>
        <dd className="mono" title={skill.dirAbs}>
          {skill.dirRel}
        </dd>
        <dt>{t("skills.installed.dtFiles")}</dt>
        <dd>{skill.hasScripts ? t("skills.installed.filesScripts", { count: skill.isLink ? "?" : skill.fileCount }) : skill.isLink ? "?" : skill.fileCount}</dd>
        <dt>{t("skills.installed.dtSource")}</dt>
        <dd>
          {p ? (
            <button type="button" className="skills-link mono" onClick={() => openExternal(githubUrl(p.repo, p.commitSha, p.path))}>
              {p.repo}
              {p.path ? `/${p.path}` : ""} @ {shortSha(p.commitSha)}
            </button>
          ) : (
            t("skills.installed.sourceLocal")
          )}
        </dd>
        {p && (
          <>
            <dt>{t("skills.installed.dtInstalled")}</dt>
            <dd>{relativeTime(p.installedAt, Date.now()) || p.installedAt}</dd>
          </>
        )}
      </dl>

      {check?.status === "ok" && (
        <div className={`skills-note ${check.data.status === "update" ? "is-info" : check.data.status === "missing" ? "is-warn" : "is-ok"}`}>
          <span>
            {check.data.status === "current" &&
              (check.data.currentSha === check.data.pinnedSha
                ? t("skills.installed.upToDate")
                : t("skills.installed.upToDateUnchanged", { sha: shortSha(check.data.currentSha) }))}
            {check.data.status === "update" && t("skills.installed.updateAvailable", { from: shortSha(check.data.pinnedSha), to: shortSha(check.data.currentSha) })}
            {check.data.status === "missing" && t("skills.installed.missing")}
          </span>
          <span className="skills-spacer" />
          {check.data.status === "update" && (
            <Button size="sm" variant="primary" onClick={() => startUpdate(skill)}>
              {t("skills.installed.reviewUpdate")}
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
          {t("skills.openFolder")}
        </Button>
        {p && (
          <Button size="sm" icon={<IconRestart size={13} />} disabled={check?.status === "loading"} onClick={() => void checkUpdate(skill)}>
            {check?.status === "loading" ? t("skills.installed.checking") : t("skills.installed.checkUpdate")}
          </Button>
        )}
        {p && (
          <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => openExternal(githubUrl(p.repo, p.commitSha, p.path))}>
            GitHub
          </Button>
        )}
        <span className="skills-spacer" />
        <Button size="sm" variant="danger" icon={<IconTrash size={13} />} disabled={skill.isLink || busy} onClick={() => void removeSkill(projectDir, skill)}>
          {t("common.remove")}
        </Button>
      </div>
    </div>
  );
}
