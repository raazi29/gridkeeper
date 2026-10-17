// Mission Control session mini card: name, agent glyph, role, account, worktree branch, state lamp +
// label, uptime, real output-rate sparkline and CPU/RAM (from the shared diagnostics poll, when on).

import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { SessionId } from "../../lib/types";
import { AgentGlyph } from "../../layout/icons";
import { useApp } from "../../store/appStore";
import { useAttention } from "../../store/attention";
import { formatRate, latestRate, useRates } from "../../store/rates";
import { useUi } from "../../store/uiStore";
import { formatUptime } from "../util/fleet";
import { basename, formatCpu, formatMb, taskManagerCpu } from "../util/text";
import { LAMP_TEXT, sessionStatus } from "./derive";
import { RoleTag, roleStyle } from "./RoleTag";
import { Sparkline } from "./Sparkline";

export const SessionCard = memo(function SessionCard({
  id,
  selected,
  onSelect,
  onJump,
  now,
}: {
  id: SessionId;
  selected: boolean;
  onSelect: (id: SessionId) => void;
  onJump: (id: SessionId) => void;
  /** Coarse clock (re-render tick for uptime). */
  now: number;
}) {
  const meta = useApp(
    useShallow((s) => {
      const m = s.persisted.sessions.find((x) => x.id === id);
      return m
        ? { name: m.name, agent: m.agent, role: m.role ?? null, profileId: m.profileId, branch: m.worktree ? (m.worktree.branch ?? basename(m.worktree.path)) : null, cwd: m.cwd }
        : null;
    }),
  );
  const profile = useApp(
    useShallow((s) => {
      const p = meta?.agent === "claude" ? s.profiles.find((x) => x.id === meta.profileId) : undefined;
      return p ? { name: p.name, color: p.color } : null;
    }),
  );
  const rt = useApp((s) => s.runtime[id]);
  const a = useAttention((s) => s.sessions[id]);
  const rate = useRates((s) => latestRate(s.hist[id]));
  const stats = useUi((s) => s.diag?.sessions.find((x) => x.id === id)?.stats);
  const cores = useUi((s) => s.diag?.logicalCores ?? 1);
  if (!meta) return null;

  const st = sessionStatus(rt, a);
  const uptime = formatUptime(rt?.startedAt, st.live ? null : rt?.endedAt, now);
  const exitCode = rt?.state.state === "exited" ? rt.state.code : null;
  const label = st.lamp === "exited" && exitCode !== null ? `exit ${exitCode}` : LAMP_TEXT[st.lamp];
  const cls = [
    "mc-card",
    st.live ? "is-live" : "",
    st.needs ? "is-needs" : "",
    st.lamp === "error" ? "is-error" : "",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const title = [meta.name, a?.lastMessage, meta.branch ? `worktree ${meta.branch}` : meta.cwd].filter(Boolean).join("\n");

  return (
    <div
      data-card={id}
      role="button"
      tabIndex={selected ? 0 : -1}
      aria-label={`${meta.name}: ${label}`}
      title={title}
      className={cls}
      style={roleStyle(meta.role)}
      onClick={() => onJump(id)}
      onFocus={() => onSelect(id)}
    >
      <div className="mc-card-row">
        <span className={`attn-lamp attn-lamp--${st.lamp}`} />
        <span className="mc-card-glyph">
          <AgentGlyph agent={meta.agent} size={11} />
        </span>
        <span className="mc-card-name">{meta.name}</span>
        <RoleTag role={meta.role} />
      </div>
      <div className="mc-card-row mc-card-meta">
        <span className={`is-${st.lamp}`}>{label}</span>
        {uptime && <span>· {uptime}</span>}
        {profile && (
          <span className="mc-account" title={`Claude profile: ${profile.name}`}>
            · <span className="mc-account-dot" style={{ background: profile.color }} />
            {profile.name}
          </span>
        )}
        {meta.agent === "claude" && !profile && <span className="mc-account">· default</span>}
        {meta.branch && <span title={`Worktree branch ${meta.branch}`}>· ⎇ {meta.branch}</span>}
      </div>
      <div className="mc-card-row">
        <Sparkline id={id} />
        <span className="mc-out" title="Terminal output rate (bytes of PTY output, not tokens)">
          out {st.live ? formatRate(rate) : "—"}
        </span>
      </div>
      {st.live && stats && (
        <div className="mc-card-row mc-res" title="CPU (share of all cores) · RAM of the process tree">
          cpu {formatCpu(taskManagerCpu(stats.cpuPercent, cores))} · ram {formatMb(stats.memoryBytes)}
        </div>
      )}
    </div>
  );
});
