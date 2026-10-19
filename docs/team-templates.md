# Team templates

A team template is one portable file, `<name>.gridkeeper-team.json`, that describes an agent team: the
formation (groups, roles, agent kinds, shared worktrees), a starter prompt per role, a mission template
(goal hint, context, starter tasks owned by roles), optional brain notes and a recommended lead control mode.
Share it in a repo, a gist or a chat message; whoever imports it sees exactly what will be created before
anything starts.

Open **Launch formation → Templates** (or the palette: *Team template: import…* / *Team template: export…*).

| Code | What |
|---|---|
| `src/actions/teamTemplatePlan.ts` | Schema, sanitizer, export builder, import → formation plan, mission text. Pure, unit-tested. |
| `src/actions/teamTemplates.ts` | File IO (save dialog, file read), export from the active workspace, launch, `importBrainNotes` (stub). |
| `src/lib/teamGallery.ts` | The built-in gallery (same schema). |
| `src/components/teamTemplates/TeamTemplates.tsx` | The Templates tab: gallery, import preview, export panel. |
| `src/store/teamTemplates.ts` | Palette intent (which panel the tab opens on). |

## What a template never contains

Account or profile ids, CLI args, environment variables, absolute paths, conversation ids and arbitrary
commands. Export leaves them out; import drops them again if a hand-edited file has them.

## Schema (version 1)

```json
{
  "format": "gridkeeper-team",
  "version": 1,
  "meta": {
    "name": "Feature squad",
    "description": "A lead plans, two builders implement in their own worktrees, a reviewer checks each branch.",
    "author": "raazi29",
    "tags": ["feature", "worktrees"],
    "minVersion": "0.2.0"
  },
  "formation": {
    "groups": [
      { "name": "Plan", "layout": "grid", "slots": [{ "role": "lead", "agent": "claude" }] },
      {
        "name": "Build",
        "layout": "columns",
        "slots": [
          { "role": "builder", "agent": "claude", "worktree": "builder-1" },
          { "role": "builder", "agent": "claude", "worktree": "builder-2" }
        ]
      },
      { "name": "Review", "layout": "grid", "slots": [{ "role": "reviewer", "agent": "codex" }] }
    ]
  },
  "prompts": {
    "lead": "You are the lead. The mission is in {mission}. Write small tasks under '## Tasks' for: {teammates}.",
    "builder": "You are a builder. Read {mission} and take the first '[ ]' task tagged with your name or @builder.",
    "reviewer": "You are the reviewer. Read {mission} and review every task marked '[x]'. Don't change code."
  },
  "mission": {
    "goalHint": "The feature in one line, e.g. 'Add CSV export to the reports page'",
    "context": "Definition of done: tests cover it and both branches are reviewed.",
    "tasks": [
      { "text": "Split the work into one task per builder", "owners": ["lead"] },
      { "text": "Implement your slice with tests", "owners": ["builder"] },
      { "text": "Review each finished branch", "owners": ["reviewer"] }
    ]
  },
  "brain": [
    { "title": "One task, one branch", "kind": "convention", "tags": ["git"], "body": "Each builder commits only on its own worktree branch." }
  ],
  "leadControl": "advisor"
}
```

| Field | Rules |
|---|---|
| `format`, `version` | Required. `version` greater than the app's schema version is refused with "update Gridkeeper". |
| `meta.name` | Required, ≤ 80 chars. `description` ≤ 400. `author` is a plain handle (`[A-Za-z0-9_.-]`, ≤ 39) or dropped. `tags` ≤ 8 slugs. `minVersion` `a.b.c` (at least 0.2.0); an older app shows a warning. |
| `formation.groups` | ≤ 8 groups, ≤ 16 sessions per group, ≤ 24 in all. `layout`: `grid`, `columns` or `rows`. |
| `slots[].role` | Any role id (`lead`, `scout`, `builder`, `reviewer`, `verifier` or a custom one such as `test-writer`), normalized like everywhere else. |
| `slots[].agent` | `claude`, `codex`, `powershell` (the platform's default shell) or `preset:<catalog id>` (`gemini`, `opencode`, `aider`, …). `command:<exe>` and unknown ids are refused: that slot is skipped with a warning. |
| `slots[].name` | Optional session name (letters, digits, space, `-`, `_`; ≤ 40). Without it the planner names sessions `role` / `role-N`. |
| `slots[].worktree` | Optional key (`[a-z0-9-]`, ≤ 32). Slots sharing a key share one new worktree on a branch `<prefix><stamp>/<key>`. No key = the project folder. |
| `prompts` | Role id → starter prompt (≤ 2000 chars; `agent` = sessions without a role). Prompts for roles not in the team are dropped. Placeholders, filled at import: `{mission}` = absolute path of the project's mission file, `{teammates}` = the other panes (`@builder-1 (builder), …`), `{role}`. Sent as one line once the agent is idle, never while it asks something. |
| `mission.goalHint` | Placeholder of the goal field (≤ 200). The user types the goal when importing. |
| `mission.context` | Written under the goal of a new mission file (≤ 2000). |
| `mission.tasks` | ≤ 60. `text` ≤ 300; `owners` are role ids, session names from the formation, or `all`. Owners that match nobody are dropped. `@owner` tokens typed in the text are moved into `owners`. |
| `brain` | ≤ 20 notes: `title` ≤ 120, `kind` slug (default `convention`), `tags` ≤ 8, `body` ≤ 4000 (Markdown). |
| `leadControl` | `off` (default), `advisor` or `autopilot`. Applied to the project only if the user leaves the import toggle on (off by default for `autopilot`). |

Unknown fields at any level are dropped and listed in a warning. Every string is stripped of control
characters (no terminal escape sequences), zero-width and bidi override characters; absolute paths become
`<path>` and well-known token formats (`sk-…`, `ghp_…`, `github_pat_…`, `xox?-…`, `AKIA…`) become
`<redacted>`. Files over 256 KB are refused before parsing.

## Import

1. **Import file…** (a file picker; read in the webview, no path access) or **Paste JSON…**.
2. The file is validated and sanitized; errors stop here, warnings are shown in the preview.
3. The preview shows exactly what will happen: groups, sessions, accounts, `git worktree add` commands (the
   same plan text as Formations), every rendered starter prompt, and the mission file or the tasks that will
   be added.
4. **Review and launch…** asks once more, then: worktrees → groups → sessions → starter prompts (armed), the
   mission file, lead control, brain notes.

Mission file: written when none exists. If one exists the preview asks: **Add the template's tasks**
(tasks whose text is already on the board are skipped; the file's line endings are kept), **Replace it**, or
**Keep it as is**. Writes use the existing conflict check (`mission_write` with the last-seen modified time).

Brain notes: `importBrainNotes(projectDir, notes)` in `src/actions/teamTemplates.ts` formats each note as a
Markdown file with front matter (`title`, `kind`, `tags`, `source`) for `.gridkeeper/brain/inbox/`. Until
the Brain API is wired in (TODO in that function) the files are queued in localStorage under
`gridkeeper.brainInbox.pending.v1`, grouped by project folder.

Nothing in a template is executed. It becomes a formation plan, and the user confirms that plan.

## Export

From the **current workspace** (its layout, roles and agents; the open tasks of its mission file become
template tasks with owners turned into roles, `@builder-1` → `@builder`, done tasks left out) or from a
**saved formation**. Name, description, author handle, tags, recommended lead control and one starter
prompt per role (pre-filled with defaults; the project's mission path is turned back into `{mission}`) can
be edited. **Save file…** opens the native save dialog (Rust writes only to the path picked there, through
the one-time token used by replay exports, kind `json`); **Copy as text** puts the JSON on the clipboard.
Browser panes and sessions that run a named command are left out.

## Built-in gallery

| Template | Team | Lead control |
|---|---|---|
| Feature squad | lead, 2 builders (own worktrees), Codex reviewer | advisor |
| Bug bash | lead, 3 scouts (read-only), verifier | advisor |
| Refactor with safety net | lead, test writer + builder (one shared worktree), Codex reviewer | advisor |
| Docs sprint | lead, 2 writers (own worktrees), reviewer | off |
| Security review | lead, 3 read-only scouts, Codex reviewer (no worktrees) | off |
| Solo + reviewer pair | builder + Codex reviewer sharing one worktree | off |
