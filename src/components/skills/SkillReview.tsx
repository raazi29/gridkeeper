// Detail pane of the Skills panel: one repository (pinned to a commit) and the review of one of its skills
// before install. Security is the feature: the full SKILL.md, every file with its size, a prominent warning
// for scripts / executable-looking files (each readable here), license, stars, last push and the pinned SHA.
// Gridkeeper never executes anything a skill contains.

import { useEffect, useMemo, useRef, useState } from "react";
import { openExternal } from "../../actions/browser";
import { formatNumber, useT } from "../../i18n";
import { featuredEntry } from "../../lib/featuredSkills";
import {
  SKILL_TARGETS,
  agentsReading,
  defaultTargets,
  formatBytes,
  formatStars,
  githubUrl,
  installedCopies,
  joinAnd,
  relativeTime,
  repoKey,
  riskyFiles,
  shortSha,
  skillPathLabel,
  splitFrontmatter,
} from "../../lib/skills";
import type { RepoSkills, SkillInfo, SkillTarget } from "../../lib/types";
import {
  fileKey,
  inspectRepo,
  installKey,
  installSkill,
  loadFile,
  messageAgents,
  selectInstalled,
  selectSkill,
  useSkills,
  type RepoSelection,
  type WorkspaceAgent,
} from "../../store/skills";
import { IconChevronLeft, IconExternal, IconFolder, IconWarn } from "../icons";
import { Button } from "../ui/Button";
import { revealPath } from "../util/pick";

const mono = (c: React.ReactNode) => <span className="mono">{c}</span>;

export function RepoView({ selection, projectDir, agents }: { selection: RepoSelection; projectDir: string | null; agents: WorkspaceAgent[] }) {
  const t = useT();
  const load = useSkills((s) => s.repos[repoKey(selection.repo, selection.ref)]);
  const skillPath = useSkills((s) => s.skillPath);
  if (!load || load.status === "loading")
    return (
      <div className="skills-detail-empty">
        {selection.ref
          ? t.rich("skills.review.readingRef", { repo: selection.repo, ref: selection.ref, mono })
          : t.rich("skills.review.reading", { repo: selection.repo, mono })}
      </div>
    );
  if (load.status === "error")
    return (
      <div className="skills-detail-pad">
        <div className="skills-note is-error" role="alert">
          <IconWarn size={13} />
          <span>{load.error}</span>
        </div>
        <div className="skills-actions">
          <Button size="sm" onClick={() => void inspectRepo(selection.repo, selection.ref, true)}>
            {t("common.retry")}
          </Button>
          <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => openExternal(githubUrl(selection.repo))}>
            {t("skills.review.openOnGithub")}
          </Button>
        </div>
      </div>
    );
  const data = load.data;
  const skill = skillPath !== null ? data.skills.find((s) => s.path === skillPath) : undefined;
  return (
    <div className="skills-detail-pad">
      <RepoHeader data={data} />
      {skill ? <SkillReviewBody key={`${data.repo}@${data.commitSha}:${skill.path}`} data={data} skill={skill} projectDir={projectDir} agents={agents} /> : <RepoOverview data={data} />}
    </div>
  );
}

function RepoHeader({ data }: { data: RepoSkills }) {
  const t = useT();
  const pushed = relativeTime(data.pushedAt, Date.now());
  return (
    <div className="skills-repo-head">
      <div className="skills-repo-title">
        <span className="skills-repo-name">{data.repo}</span>
        {featuredEntry(data.repo) && <span className="chip chip-accent skills-chip">{t("skills.featuredChip")}</span>}
        {data.archived && <span className="chip tone-warn skills-chip">{t("skills.archived")}</span>}
        <span className="skills-spacer" />
        <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => openExternal(data.htmlUrl || githubUrl(data.repo))}>
          GitHub
        </Button>
      </div>
      <div className="skills-row-meta">
        {data.stars !== null && <span>★ {formatStars(data.stars)}</span>}
        <span>{data.license ?? t("skills.review.noLicense")}</span>
        {pushed && <span>{t("skills.pushed", { when: pushed })}</span>}
        <span className="mono" title={data.commitSha}>
          {data.gitRef} @ {shortSha(data.commitSha)}
        </span>
        <span className="skills-source">{t("skills.review.readFrom")}</span>
      </div>
    </div>
  );
}

function RepoOverview({ data }: { data: RepoSkills }) {
  const t = useT();
  const installed = useSkills((s) => s.installed?.items);
  return (
    <>
      {data.description && <p className="skills-desc">{data.description}</p>}
      {data.warnings.map((w) => (
        <div key={w} className="skills-note is-warn">
          <IconWarn size={13} />
          <span>{w}</span>
        </div>
      ))}
      {data.skills.length > 0 && (
        <div className="skills-subhead">{t("skills.review.skillsAt", { count: data.skills.length, sha: shortSha(data.commitSha) })}</div>
      )}
      <div className="skills-cards" role="list">
        {data.skills.map((s) => {
          const copies = installed ? installedCopies(installed, data.repo, s.path) : [];
          return (
            <button key={s.path} type="button" role="listitem" className="skills-card" onClick={() => selectSkill(s.path)}>
              <span className="skills-row-head">
                <span className="skills-row-name">{s.name}</span>
                {copies.length > 0 && <span className="chip tone-ok skills-chip">{t("skills.chipInstalled")}</span>}
                {s.hasScripts && <span className="chip tone-warn skills-chip">{t("skills.chipScripts")}</span>}
                {s.blocked && <span className="chip tone-err skills-chip">{t("skills.chipBlocked")}</span>}
              </span>
              <span className="skills-row-desc">{s.description ?? t("skills.review.noDescription")}</span>
              <span className="skills-row-meta">
                <span className="mono">{skillPathLabel(s.path)}</span>
                <span>{t("skills.review.files", { count: s.files.length, size: formatBytes(s.totalBytes) })}</span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function SkillReviewBody({ data, skill, projectDir, agents }: { data: RepoSkills; skill: SkillInfo; projectDir: string | null; agents: WorkspaceAgent[] }) {
  const t = useT();
  const updating = useSkills((s) => s.updating);
  const installed = useSkills((s) => s.installed?.items);
  const busy = useSkills((s) => s.busy);
  const lastInstall = useSkills((s) => (s.lastInstall?.key === installKey(data.repo, data.commitSha, skill.path) ? s.lastInstall.result : null));
  const mdEntry = useSkills((s) => (skill.skillMd === null ? s.files[fileKey(data.repo, data.commitSha, joinPath(skill.path, "SKILL.md"))] : undefined));
  const [openFile, setOpenFile] = useState<string | null>(null);
  const isUpdate = !!updating && updating.provenance?.repo.toLowerCase() === data.repo.toLowerCase() && updating.provenance.path === skill.path;
  const agentKinds = useMemo(() => agents.map((a) => a.agent), [agents]);
  const [targets, setTargets] = useState<SkillTarget[]>(() => (isUpdate && updating ? [updating.target] : defaultTargets(agentKinds)));
  const copies = installed ? installedCopies(installed, data.repo, skill.path) : [];
  const risky = riskyFiles(skill.files);

  // SKILL.md not fetched with the repository (many skills): reading it is part of opening the review.
  useEffect(() => {
    if (skill.skillMd === null) void loadFile(data.repo, data.commitSha, joinPath(skill.path, "SKILL.md"));
  }, [data.repo, data.commitSha, skill.path, skill.skillMd]);

  const md = skill.skillMd ?? (mdEntry?.status === "ok" ? mdEntry.data.text : null);
  const { frontmatter, body } = splitFrontmatter(md ?? "");
  const readers = agentsReading(targets, agents);
  const liveReaders = (lastInstall ? agentsReading(SKILL_TARGETS.map((t) => t.id).filter((t) => lastInstall.installed.some((d) => d.startsWith(`${t}/`))), agents) : []).filter((a) => a.live);
  const canInstall = !!projectDir && !skill.blocked && targets.length > 0 && !busy;

  const toggleTarget = (t: SkillTarget) => setTargets((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : SKILL_TARGETS.map((x) => x.id).filter((x) => x === t || cur.includes(x))));

  return (
    <>
      {data.skills.length > 1 && (
        <button type="button" className="skills-back" onClick={() => selectSkill(null)}>
          <IconChevronLeft size={12} /> {t("skills.review.allSkills", { count: data.skills.length, repo: data.repo })}
        </button>
      )}
      <div className="skills-review-title">
        <span className="skills-review-name">{skill.name}</span>
        {copies.length > 0 && !isUpdate && <span className="chip tone-ok skills-chip">{t("skills.review.installedIn", { targets: copies.map((c) => c.target).join(", ") })}</span>}
      </div>
      {skill.description && <p className="skills-desc">{skill.description}</p>}

      {isUpdate && updating && (
        <div className="skills-note is-info">
          <span>
            {t.rich("skills.review.updateNote", {
              name: updating.name,
              dir: updating.dirRel,
              from: shortSha(updating.provenance?.commitSha),
              to: shortSha(data.commitSha),
              ref: data.gitRef,
              b: (c) => <b>{c}</b>,
              mono,
            })}
            {skill.installName !== updating.folder && (
              <>
                {" "}
                {t.rich("skills.review.updateRenamed", { name: skill.installName, mono })}
              </>
            )}
          </span>
          <button type="button" className="chip" onClick={() => selectInstalled(updating.dirRel)}>
            {t("common.cancel")}
          </button>
        </div>
      )}

      {skill.blocked && (
        <div className="skills-note is-error" role="alert">
          <IconWarn size={13} />
          <span>{t("skills.review.blocked", { reason: skill.blocked })}</span>
        </div>
      )}

      {skill.hasScripts && (
        <div className="skills-scripts-warn" role="alert">
          <div className="skills-scripts-head">
            <IconWarn size={14} /> {t("skills.review.scriptsHead", { count: risky.length })}
          </div>
          <p>{t("skills.review.scriptsBody")}</p>
          <div className="skills-chips">
            {risky.map((f) => (
              <button key={f.path} type="button" className={`chip tone-warn mono${openFile === f.path ? " is-on" : ""}`} onClick={() => setOpenFile(openFile === f.path ? null : f.path)}>
                {f.path}
              </button>
            ))}
          </div>
        </div>
      )}

      <dl className="skills-meta">
        <dt>{t("skills.review.dtRepository")}</dt>
        <dd>
          <button type="button" className="skills-link mono" onClick={() => openExternal(githubUrl(data.repo, data.commitSha, skill.path))}>
            {data.repo}/{skill.path}
          </button>
        </dd>
        <dt>{t("skills.review.dtPinned")}</dt>
        <dd className="mono" title={data.commitSha}>
          {data.commitSha} ({data.gitRef})
        </dd>
        <dt>{t("skills.review.dtLicense")}</dt>
        <dd>{data.license ?? t("skills.review.noLicenseCheck")}</dd>
        <dt>{t("skills.review.dtStarsPush")}</dt>
        <dd>
          {data.stars !== null ? `★ ${formatNumber(data.stars)}` : "?"} · {relativeTime(data.pushedAt, Date.now()) || t("skills.review.unknown")}
        </dd>
        <dt>{t("skills.review.dtInstallsAs")}</dt>
        <dd className="mono">{skill.installName}</dd>
        <dt>{t("skills.review.dtSize")}</dt>
        <dd>{t("skills.review.files", { count: skill.files.length, size: formatBytes(skill.totalBytes) })}</dd>
      </dl>

      <div className="skills-subhead">SKILL.md</div>
      {md === null ? (
        <div className="skills-empty">{mdEntry?.status === "error" ? t("skills.review.mdError", { error: mdEntry.error }) : t("skills.review.mdReading")}</div>
      ) : (
        <pre className="skills-pre" tabIndex={0}>
          {frontmatter !== null && <span className="skills-pre-front">{`---\n${frontmatter}\n---\n`}</span>}
          {body}
        </pre>
      )}

      <div className="skills-subhead">{t("skills.review.filesHead")}</div>
      <div className="skills-files" role="list">
        {skill.files.map((f) => (
          <button
            key={f.path}
            type="button"
            role="listitem"
            className={`skills-file${f.executable || f.path.startsWith("scripts/") ? " is-exec" : ""}${openFile === f.path ? " is-open" : ""}`}
            onClick={() => setOpenFile(openFile === f.path ? null : f.path)}
            title={t("skills.review.readFile")}
          >
            <span className="mono skills-file-path">{f.path}</span>
            {(f.executable || f.path.startsWith("scripts/")) && <span className="skills-warn-text">{t("skills.review.scriptChip")}</span>}
            <span className="skills-file-size">{formatBytes(f.size)}</span>
          </button>
        ))}
      </div>
      {openFile && <FileViewer repo={data.repo} sha={data.commitSha} path={joinPath(skill.path, openFile)} label={openFile} onClose={() => setOpenFile(null)} />}

      <div className="skills-install">
        <div className="skills-subhead">{isUpdate ? t("skills.review.updateHead") : t("skills.review.installHead")}</div>
        {!projectDir ? (
          <div className="skills-note is-warn">
            <IconWarn size={13} />
            <span>{t("skills.review.noProject")}</span>
          </div>
        ) : (
          <>
            <div className="skills-project mono" title={projectDir}>
              {projectDir}
            </div>
            <div className="skills-targets">
              {SKILL_TARGETS.map((t) => (
                <label key={t.id} className="check">
                  <input type="checkbox" checked={targets.includes(t.id)} disabled={isUpdate} onChange={() => toggleTarget(t.id)} />
                  <span className="mono">
                    {t.id}/{skill.installName}
                  </span>
                  <span className="muted">{t.hosts}</span>
                </label>
              ))}
            </div>
            <div className="skills-actions">
              <Button
                variant="primary"
                disabled={!canInstall}
                onClick={() => {
                  if (!projectDir) return;
                  void installSkill({ projectDir, repo: data.repo, commitSha: data.commitSha, skill, targets, isUpdate, agents });
                }}
              >
                {busy ? t("skills.review.installing") : isUpdate ? t("skills.review.updateTo", { sha: shortSha(data.commitSha) }) : t("skills.review.install")}
              </Button>
              <span className="skills-hint">
                {readers.length > 0
                  ? t("skills.review.hintAgents", { count: readers.length, folders: targets.length === 1 ? "one" : "other" })
                  : t("skills.review.hintNoAgents")}{" "}
                {t("skills.review.hintFiles")}
              </span>
            </div>
          </>
        )}
        {lastInstall && projectDir && (
          <div className="skills-note is-ok">
            <span>
              {lastInstall.replaced.length
                ? t("skills.review.installedNoteReplaced", { name: lastInstall.name, targets: joinAnd(lastInstall.installed), replaced: lastInstall.replaced.join(", ") })
                : t("skills.review.installedNote", { name: lastInstall.name, targets: joinAnd(lastInstall.installed) })}
            </span>
            <span className="skills-spacer" />
            {lastInstall.installed[0] && (
              <Button size="sm" variant="ghost" icon={<IconFolder size={13} />} onClick={() => void revealPath(`${projectDir.replace(/[\\/]+$/, "")}\\${lastInstall.installed[0].replace(/\//g, "\\")}`)}>
                {t("skills.openFolder")}
              </Button>
            )}
            {liveReaders.length > 0 && (
              <Button size="sm" onClick={() => messageAgents(liveReaders.map((a) => a.id))}>
                {t("skills.review.messageRunning")}
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function FileViewer({ repo, sha, path, label, onClose }: { repo: string; sha: string; path: string; label: string; onClose: () => void }) {
  const t = useT();
  const entry = useSkills((s) => s.files[fileKey(repo, sha, path)]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void loadFile(repo, sha, path);
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [repo, sha, path]);
  return (
    <div className="skills-viewer" ref={ref}>
      <div className="skills-viewer-head">
        <span className="mono">{label}</span>
        {entry?.status === "ok" && <span className="muted">{formatBytes(entry.data.size)}</span>}
        <span className="skills-spacer" />
        <button type="button" className="chip" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
      {(!entry || entry.status === "loading") && <div className="skills-empty">{t("skills.review.readingRaw")}</div>}
      {entry?.status === "error" && <div className="skills-empty">{entry.error}</div>}
      {entry?.status === "ok" &&
        (entry.data.binary ? (
          <div className="skills-empty">{t("skills.review.binary", { size: formatBytes(entry.data.size) })}</div>
        ) : (
          <pre className="skills-pre" tabIndex={0}>
            {entry.data.text}
            {entry.data.truncated ? `\n${t("skills.review.truncated")}` : ""}
          </pre>
        ))}
    </div>
  );
}

function joinPath(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel;
}
