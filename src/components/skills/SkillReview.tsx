// Detail pane of the Skills panel: one repository (pinned to a commit) and the review of one of its skills
// before install. Security is the feature: the full SKILL.md, every file with its size, a prominent warning
// for scripts / executable-looking files (each readable here), license, stars, last push and the pinned SHA.
// Gridkeeper never executes anything a skill contains.

import { useEffect, useMemo, useRef, useState } from "react";
import { openExternal } from "../../actions/browser";
import { featuredEntry } from "../../lib/featuredSkills";
import {
  SKILL_TARGETS,
  agentsReading,
  defaultTargets,
  formatBytes,
  formatStars,
  githubUrl,
  installedCopies,
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

export function RepoView({ selection, projectDir, agents }: { selection: RepoSelection; projectDir: string | null; agents: WorkspaceAgent[] }) {
  const load = useSkills((s) => s.repos[repoKey(selection.repo, selection.ref)]);
  const skillPath = useSkills((s) => s.skillPath);
  if (!load || load.status === "loading")
    return (
      <div className="skills-detail-empty">
        Reading <span className="mono">{selection.repo}</span>
        {selection.ref ? <span className="mono">#{selection.ref}</span> : null} from api.github.com…
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
            Retry
          </Button>
          <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => openExternal(githubUrl(selection.repo))}>
            Open on GitHub
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
  const pushed = relativeTime(data.pushedAt, Date.now());
  return (
    <div className="skills-repo-head">
      <div className="skills-repo-title">
        <span className="skills-repo-name">{data.repo}</span>
        {featuredEntry(data.repo) && <span className="chip chip-accent skills-chip">featured</span>}
        {data.archived && <span className="chip tone-warn skills-chip">archived</span>}
        <span className="skills-spacer" />
        <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => openExternal(data.htmlUrl || githubUrl(data.repo))}>
          GitHub
        </Button>
      </div>
      <div className="skills-row-meta">
        {data.stars !== null && <span>★ {formatStars(data.stars)}</span>}
        <span>{data.license ?? "no license detected"}</span>
        {pushed && <span>pushed {pushed}</span>}
        <span className="mono" title={data.commitSha}>
          {data.gitRef} @ {shortSha(data.commitSha)}
        </span>
        <span className="skills-source">read from api.github.com</span>
      </div>
    </div>
  );
}

function RepoOverview({ data }: { data: RepoSkills }) {
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
        <div className="skills-subhead">
          {data.skills.length} skill{data.skills.length === 1 ? "" : "s"} at {shortSha(data.commitSha)}: pick one to review
        </div>
      )}
      <div className="skills-cards" role="list">
        {data.skills.map((s) => {
          const copies = installed ? installedCopies(installed, data.repo, s.path) : [];
          return (
            <button key={s.path} type="button" role="listitem" className="skills-card" onClick={() => selectSkill(s.path)}>
              <span className="skills-row-head">
                <span className="skills-row-name">{s.name}</span>
                {copies.length > 0 && <span className="chip tone-ok skills-chip">installed</span>}
                {s.hasScripts && <span className="chip tone-warn skills-chip">scripts</span>}
                {s.blocked && <span className="chip tone-err skills-chip">can't install</span>}
              </span>
              <span className="skills-row-desc">{s.description ?? "No description in the SKILL.md frontmatter."}</span>
              <span className="skills-row-meta">
                <span className="mono">{skillPathLabel(s.path)}</span>
                <span>
                  {s.files.length} file{s.files.length === 1 ? "" : "s"} · {formatBytes(s.totalBytes)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function SkillReviewBody({ data, skill, projectDir, agents }: { data: RepoSkills; skill: SkillInfo; projectDir: string | null; agents: WorkspaceAgent[] }) {
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
          <IconChevronLeft size={12} /> All {data.skills.length} skills in {data.repo}
        </button>
      )}
      <div className="skills-review-title">
        <span className="skills-review-name">{skill.name}</span>
        {copies.length > 0 && !isUpdate && <span className="chip tone-ok skills-chip">installed in {copies.map((c) => c.target).join(", ")}</span>}
      </div>
      {skill.description && <p className="skills-desc">{skill.description}</p>}

      {isUpdate && updating && (
        <div className="skills-note is-info">
          <span>
            Update <b>{updating.name}</b> in <span className="mono">{updating.dirRel}</span> from{" "}
            <span className="mono">{shortSha(updating.provenance?.commitSha)}</span> to <span className="mono">{shortSha(data.commitSha)}</span> ({data.gitRef}).
            Review what changed below; the folder is replaced as a whole.
            {skill.installName !== updating.folder && (
              <>
                {" "}
                The skill is now named <span className="mono">{skill.installName}</span>, so it installs next to the old folder; remove the old one afterwards.
              </>
            )}
          </span>
          <button type="button" className="chip" onClick={() => selectInstalled(updating.dirRel)}>
            Cancel
          </button>
        </div>
      )}

      {skill.blocked && (
        <div className="skills-note is-error" role="alert">
          <IconWarn size={13} />
          <span>Can't install: {skill.blocked}</span>
        </div>
      )}

      {skill.hasScripts && (
        <div className="skills-scripts-warn" role="alert">
          <div className="skills-scripts-head">
            <IconWarn size={14} /> This skill contains scripts or executable files ({risky.length})
          </div>
          <p>
            Gridkeeper never runs them. Your agents may, when the skill tells them to, with the permissions you give those agents. Read
            them before installing:
          </p>
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
        <dt>Repository</dt>
        <dd>
          <button type="button" className="skills-link mono" onClick={() => openExternal(githubUrl(data.repo, data.commitSha, skill.path))}>
            {data.repo}/{skill.path}
          </button>
        </dd>
        <dt>Pinned commit</dt>
        <dd className="mono" title={data.commitSha}>
          {data.commitSha} ({data.gitRef})
        </dd>
        <dt>License</dt>
        <dd>{data.license ?? "no license detected: check the repository before using it"}</dd>
        <dt>Stars · last push</dt>
        <dd>
          {data.stars !== null ? `★ ${data.stars.toLocaleString()}` : "?"} · {relativeTime(data.pushedAt, Date.now()) || "unknown"}
        </dd>
        <dt>Installs as</dt>
        <dd className="mono">{skill.installName}</dd>
        <dt>Size</dt>
        <dd>
          {skill.files.length} file{skill.files.length === 1 ? "" : "s"} · {formatBytes(skill.totalBytes)}
        </dd>
      </dl>

      <div className="skills-subhead">SKILL.md</div>
      {md === null ? (
        <div className="skills-empty">{mdEntry?.status === "error" ? `Could not read SKILL.md: ${mdEntry.error}` : "Reading SKILL.md…"}</div>
      ) : (
        <pre className="skills-pre" tabIndex={0}>
          {frontmatter !== null && <span className="skills-pre-front">{`---\n${frontmatter}\n---\n`}</span>}
          {body}
        </pre>
      )}

      <div className="skills-subhead">Files</div>
      <div className="skills-files" role="list">
        {skill.files.map((f) => (
          <button
            key={f.path}
            type="button"
            role="listitem"
            className={`skills-file${f.executable || f.path.startsWith("scripts/") ? " is-exec" : ""}${openFile === f.path ? " is-open" : ""}`}
            onClick={() => setOpenFile(openFile === f.path ? null : f.path)}
            title="Read this file"
          >
            <span className="mono skills-file-path">{f.path}</span>
            {(f.executable || f.path.startsWith("scripts/")) && <span className="skills-warn-text">script</span>}
            <span className="skills-file-size">{formatBytes(f.size)}</span>
          </button>
        ))}
      </div>
      {openFile && <FileViewer repo={data.repo} sha={data.commitSha} path={joinPath(skill.path, openFile)} label={openFile} onClose={() => setOpenFile(null)} />}

      <div className="skills-install">
        <div className="skills-subhead">{isUpdate ? "Update in this project" : "Install into this project"}</div>
        {!projectDir ? (
          <div className="skills-note is-warn">
            <IconWarn size={13} />
            <span>This workspace has no project folder. Skills install into a project folder; open or create a workspace with one.</span>
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
                {busy ? "Installing…" : isUpdate ? `Update to ${shortSha(data.commitSha)}` : "Install"}
              </Button>
              <span className="skills-hint">
                {readers.length > 0
                  ? `${readers.length} agent${readers.length === 1 ? "" : "s"} in this workspace read${readers.length === 1 ? "s" : ""} ${targets.length === 1 ? "this folder" : "these folders"}.`
                  : "Agents started in this project read these folders."}{" "}
                The files are written to the project (visible to git); nothing is executed.
              </span>
            </div>
          </>
        )}
        {lastInstall && projectDir && (
          <div className="skills-note is-ok">
            <span>
              Installed {lastInstall.name} to {lastInstall.installed.join(" and ")}
              {lastInstall.replaced.length ? ` (replaced ${lastInstall.replaced.join(", ")})` : ""}. Running agents pick up project skills on their next
              session/reload.
            </span>
            <span className="skills-spacer" />
            {lastInstall.installed[0] && (
              <Button size="sm" variant="ghost" icon={<IconFolder size={13} />} onClick={() => void revealPath(`${projectDir.replace(/[\\/]+$/, "")}\\${lastInstall.installed[0].replace(/\//g, "\\")}`)}>
                Open folder
              </Button>
            )}
            {liveReaders.length > 0 && (
              <Button size="sm" onClick={() => messageAgents(liveReaders.map((a) => a.id))}>
                Message running agents…
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function FileViewer({ repo, sha, path, label, onClose }: { repo: string; sha: string; path: string; label: string; onClose: () => void }) {
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
          Close
        </button>
      </div>
      {(!entry || entry.status === "loading") && <div className="skills-empty">Reading from raw.githubusercontent.com…</div>}
      {entry?.status === "error" && <div className="skills-empty">{entry.error}</div>}
      {entry?.status === "ok" &&
        (entry.data.binary ? (
          <div className="skills-empty">Binary file ({formatBytes(entry.data.size)}): not shown.</div>
        ) : (
          <pre className="skills-pre" tabIndex={0}>
            {entry.data.text}
            {entry.data.truncated ? "\n… (cut at 256 KB)" : ""}
          </pre>
        ))}
    </div>
  );
}

function joinPath(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel;
}
