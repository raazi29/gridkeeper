---
name: agent-mission
description: Coordinate a team of coding agents (Claude Code, Codex, Gemini CLI, any CLI agent, several at once) through one shared Markdown task board at .gridkeeper/mission.md. Use when the user wants to start a mission, split work across agents or worktrees, act as lead/orchestrator, pick up or report tasks as a builder, review a teammate's branch, or asks "what is the team doing". Works in any terminal; Gridkeeper renders the board live.
---

# Agent Mission: one file, many agents

Several agents working on one project need a shared plan they can all read and update without a server.
The plan is a plain Markdown file: `<project root>/.gridkeeper/mission.md`. Every agent CLI can read and
edit a file, humans can read it anywhere, and Gridkeeper (https://github.com/raazi29/gridkeeper) shows it
live in Mission Control with owners, progress and sign-off.

## The file format

```markdown
# Mission: Add OAuth login

Context for the team: constraints, links, decisions. Free text.

## Tasks
- [ ] Design the token storage @lead
- [~] Implement /auth/callback @builder-1
- [x] Add the login button @builder-2
- [!] Blocked: needs the client secret @builder-2
- [ ] Review both branches @verifier
```

| Box | Meaning |
|---|---|
| `[ ]` | todo |
| `[~]` | doing (also accepted: `[-]`, `[/]`) |
| `[x]` | done |
| `[!]` | blocked, put the reason right after the box |

- **Owners** are `@slug` tokens: a teammate's name in lowercase with spaces as `-` (`Builder 1` → `@builder-1`),
  or a role (`@builder` means every builder). A task can have several owners. No owner = unassigned.
- One task per line. Keep a task small enough for one agent to finish in one sitting.
- Anything else in the file (notes, headings, links) is kept as is.

## Where the file lives

Always the **main project folder**, never a worktree copy. If you work in a git worktree, the board is still
`<main checkout>/.gridkeeper/mission.md`; use the absolute path you were given. Find the main checkout with
`git worktree list` (the first entry). Create `.gridkeeper/` with a `.gitignore` containing `*` so the board
never shows up in `git status`.

## Rules for editing a shared file (several agents write it)

1. **Re-read the file right before every edit.** Another agent may have changed it a second ago.
2. **Change only the lines you own**: your task's box, or tasks you are adding. Make a one-line replacement,
   never rewrite or reformat the whole file.
3. **Never** delete or reword someone else's task. Leave a note under it instead (`  - note: …`).
4. If your edit fails because the line changed, re-read and try again.

## Talking to teammates: `team.md` and `outbox/`

Two more files in `.gridkeeper/` let a lead supervise the team (any agent may use them):

- **`team.md`** is the team's live status: each member's `@slug`, role, state (working, needs-you, done, error,
  idle), current task, branch and diff stats, and sometimes their recent output. A tool such as Gridkeeper
  writes it; **never edit it**, just read it before you decide anything.
- **`outbox/`** carries instructions. To message a teammate, **create a new file** there (one file per message,
  any unique name such as `0007-builder-1.md`):

  ```
  to: builder-1
  from: lead
  action: message
  ---
  Also add a unit test for the callback route, then mark the task done.
  ```

  `to` is a slug, a role (`builder` = every builder), a comma-separated list, or `all`. `action` is `message`
  (default), `review`, `stop` or `restart`. The text after `---` is typed into the teammate's terminal as one
  line. Never edit or delete existing outbox files; the tool moves them to `outbox/sent/` or
  `outbox/dismissed/` after handling them.

**The user decides what happens to your messages.** Depending on their setting, a message may be delivered
right away, wait for their approval, or be ignored. `stop` and `restart` always need the user. So write
messages that make sense on their own, and never assume one was delivered until `team.md` or the teammate's
progress shows it.

Without a tool watching `outbox/`, nothing is delivered: then put instructions on the board as tasks instead.

## If you are the lead

1. Read the goal and context. Explore the codebase enough to plan.
2. Write tasks under `## Tasks`, each with an owner from the team list you were given (or roles if you have
   no list). Order them so work that unblocks others comes first. Add a final review task for a reviewer
   or verifier.
3. Supervise: read `team.md`, unblock people who are stuck, and send short, specific instructions through
   `outbox/`. Don't flood teammates; one clear message beats five.
4. **Review like an advisor.** When someone finishes (or you are asked to review), read their branch
   (`git -C "<worktree>" diff <base>...HEAD`), run the tests, then either message them concrete fixes or mark
   the work done on the board. Approve only what you actually checked.
5. Keep the board true: add tasks you discover, reassign blocked ones, and write decisions into the context.
6. Do not do the builders' work. Coordinate, unblock, review and answer questions.

## If you are a builder (or any worker)

1. Find tasks tagged with your slug or your role. Take the first `[ ]` one.
2. Mark it `[~]` **before** you start, so nobody else picks it up.
3. Do the work in your own folder or worktree. Commit on your branch with a clear message.
4. Mark it `[x]` when it is done and verified (tests pass, it builds). If you can't continue, mark `[!]` and
   write the reason after the box, then move on to your next task.
5. When none are left, say so in your terminal; don't invent work outside the board.
6. Follow instructions that arrive from the lead. To ask the lead something, create an `outbox/` file with
   `to: lead`.

## If you are a reviewer or verifier

1. Take review tasks tagged for you. For a teammate's branch: `git -C "<their worktree>" log --oneline <base>..HEAD`
   and `git -C "<their worktree>" diff <base>...HEAD`.
2. Run the tests. Report concrete problems as new `[ ]` tasks owned by the author, or mark the review `[x]`
   with `LGTM` in a note.

## Starting a mission from scratch

If the user gives you a goal and no board exists, create it:

```markdown
# Mission: <the goal in one line>

<context the user gave, constraints, definition of done>

## Tasks
```

Then act as lead (above), unless the user said otherwise.

## Answering "what is the team doing?"

Read the board and summarize: done/total, what is in progress and by whom, what is blocked and why, what is
unassigned. Quote task lines rather than paraphrasing them.
