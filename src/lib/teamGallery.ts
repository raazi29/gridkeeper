// Built-in team templates (the "Templates" tab gallery). Plain data in the same schema as an exported
// `.gridkeeper-team.json` file (docs/team-templates.md); every entry must pass sanitizeTeamTemplate unchanged
// (unit-tested). Prompts use {mission}, {teammates} and {role}; keep them short and concrete.
//
// The templates themselves stay English (they are written to files and typed into agents); only the name and
// description shown in the gallery are translated, at render time, through GALLERY_TEXT.

import { TEAM_FORMAT, TEAM_MIN_APP_VERSION, TEAM_SCHEMA_VERSION, type TeamTemplate } from "../actions/teamTemplatePlan";
import type { MessageKey } from "../i18n";

const base = { format: TEAM_FORMAT, version: TEAM_SCHEMA_VERSION } as const;
const meta = (name: string, description: string, tags: string[]) => ({ name, description, author: null, tags, minVersion: TEAM_MIN_APP_VERSION });

const LEAD_PLAN =
  "You are the lead. The mission is in {mission}. Explore the code enough to plan, then write small tasks under '## Tasks' as '- [ ] task @owner' for: {teammates}. Keep each task to one sitting. Review finished work before you mark it done. Don't write the code yourself.";

export const TEAM_GALLERY: readonly TeamTemplate[] = [
  {
    ...base,
    meta: meta("Feature squad", "A lead plans, two builders implement in their own worktrees, a reviewer checks each branch.", ["feature", "worktrees"]),
    formation: {
      groups: [
        { name: "Plan", layout: "grid", slots: [{ role: "lead", agent: "claude" }] },
        {
          name: "Build",
          layout: "columns",
          slots: [
            { role: "builder", agent: "claude", worktree: "builder-1" },
            { role: "builder", agent: "claude", worktree: "builder-2" },
          ],
        },
        { name: "Review", layout: "grid", slots: [{ role: "reviewer", agent: "codex" }] },
      ],
    },
    prompts: {
      lead: `${LEAD_PLAN} Give the two builders work in different files so their branches merge cleanly.`,
      builder:
        "You are a builder. Read {mission} and take the first '[ ]' task tagged with your name or @builder: mark it '[~]', implement it with tests in your worktree, run the test suite, commit on your branch, then mark it '[x]'. If you are blocked, mark it '[!] reason' and take the next one.",
      reviewer:
        "You are the reviewer. Read {mission}. For each task marked '[x]', read the author's branch diff against the base branch and run the tests there. Add problems as '- [ ] fix: … @author' lines; write 'LGTM' under tasks that pass. Don't change code.",
    },
    mission: {
      goalHint: "The feature in one line, e.g. 'Add CSV export to the reports page'",
      context: "Definition of done: the feature works end to end, tests cover it, both branches are reviewed and merge cleanly.",
      tasks: [
        { text: "Read the code around the feature and write the plan into the context above", owners: ["lead"] },
        { text: "Split the work into one task per builder, each touching different files", owners: ["lead"] },
        { text: "Implement your slice with tests and commit it on your branch", owners: ["builder"] },
        { text: "Review each finished branch: diff, tests, edge cases", owners: ["reviewer"] },
        { text: "Check that the branches merge together and the full test suite passes", owners: ["lead"] },
      ],
    },
    brain: [
      { title: "One task, one branch", kind: "convention", tags: ["git"], body: "Each builder commits only on its own worktree branch. Rebase on the base branch before asking for review; never push to the base branch directly." },
    ],
    leadControl: "advisor",
  },
  {
    ...base,
    meta: meta("Bug bash", "Three scouts hunt for bugs in separate areas, the lead triages, a verifier confirms every report.", ["bugs", "qa", "read-only"]),
    formation: {
      groups: [
        { name: "Lead", layout: "grid", slots: [{ role: "lead", agent: "claude" }] },
        {
          name: "Scouts",
          layout: "columns",
          slots: [
            { role: "scout", agent: "claude" },
            { role: "scout", agent: "claude" },
            { role: "scout", agent: "codex" },
          ],
        },
        { name: "Verify", layout: "grid", slots: [{ role: "verifier", agent: "claude" }] },
      ],
    },
    prompts: {
      lead: "You are the lead of a bug bash. The mission is in {mission}. Split the product into three areas and give each scout one area as a task (teammates: {teammates}). As reports come in, merge duplicates, rank them by severity and add a verify task for each one. Don't fix bugs yourself.",
      scout:
        "You are a scout in a bug bash. Read {mission} and take the task tagged with your name or @scout. Look for bugs in that area by reading code and running the app or tests. For each bug add a line '- [ ] bug: <one-line summary> (repro: <steps>) @verifier'. Don't change code.",
      verifier:
        "You are the verifier. Read {mission}. For each 'bug:' task tagged @verifier, follow the repro steps. If it reproduces, mark it '[x]' and add a note with the exact command or input; if not, mark it '[!] cannot reproduce' with what you tried. Don't change code.",
    },
    mission: {
      goalHint: "What to test, e.g. 'Find bugs in the checkout flow before the 2.3 release'",
      context: "Every bug report needs a one-line summary and repro steps. Severity: crash > data loss > wrong result > cosmetic.",
      tasks: [
        { text: "Split the product into three areas, one task per scout", owners: ["lead"] },
        { text: "Hunt for bugs in your area and file each one with repro steps", owners: ["scout"] },
        { text: "Reproduce every bug report and record the result", owners: ["verifier"] },
        { text: "Rank the confirmed bugs by severity and write the summary into the context", owners: ["lead"] },
      ],
    },
    brain: [],
    leadControl: "advisor",
  },
  {
    ...base,
    meta: meta("Refactor with safety net", "A test writer pins current behaviour first, a builder refactors on the same branch, a reviewer checks nothing changed.", ["refactor", "tests"]),
    formation: {
      groups: [
        { name: "Lead", layout: "grid", slots: [{ role: "lead", agent: "claude" }] },
        {
          name: "Refactor",
          layout: "columns",
          slots: [
            { role: "test-writer", agent: "claude", worktree: "refactor" },
            { role: "builder", agent: "claude", worktree: "refactor" },
          ],
        },
        { name: "Review", layout: "grid", slots: [{ role: "reviewer", agent: "codex" }] },
      ],
    },
    prompts: {
      lead: `${LEAD_PLAN} Order the work so tests that pin current behaviour land before each refactor step.`,
      "test-writer":
        "You are the test writer. Read {mission} and take tasks tagged @test-writer. Write tests that pin the current behaviour of the code being refactored (inputs, outputs, error cases) without changing that code. Commit them, then mark the task '[x]' so the builder can start.",
      builder:
        "You are the builder. Read {mission}. Start a refactor task only after its test task is '[x]'. Change structure, not behaviour: the pinned tests must pass unchanged after every commit. Commit in small steps and mark the task '[x]' when done.",
      reviewer:
        "You are the reviewer. Read {mission}. For each finished refactor task, read the branch diff and run the tests. Flag any behaviour change or edited pinned test as '- [ ] fix: … @builder'. Don't change code.",
    },
    mission: {
      goalHint: "What to refactor, e.g. 'Split the 2,000-line OrderService into smaller modules'",
      context: "Rule: behaviour stays the same. Pinned tests are written first and are not edited during the refactor.",
      tasks: [
        { text: "List the refactor steps and the behaviour each one must keep", owners: ["lead"] },
        { text: "Write tests that pin the current behaviour of the code in step 1", owners: ["test-writer"] },
        { text: "Refactor step 1 with the pinned tests passing after every commit", owners: ["builder"] },
        { text: "Review the refactor: no behaviour change, no edited pinned tests", owners: ["reviewer"] },
      ],
    },
    brain: [
      { title: "Pinned tests are read-only", kind: "convention", tags: ["tests", "refactor"], body: "Tests written to pin behaviour before a refactor are not edited by the builder. If one must change, the reviewer has to agree first." },
    ],
    leadControl: "advisor",
  },
  {
    ...base,
    meta: meta("Docs sprint", "Two writers update the docs in their own worktrees, a reviewer checks every claim against the code.", ["docs"]),
    formation: {
      groups: [
        { name: "Lead", layout: "grid", slots: [{ role: "lead", agent: "claude" }] },
        {
          name: "Write",
          layout: "columns",
          slots: [
            { role: "writer", agent: "claude", worktree: "docs-1" },
            { role: "writer", agent: "claude", worktree: "docs-2" },
          ],
        },
        { name: "Review", layout: "grid", slots: [{ role: "reviewer", agent: "claude" }] },
      ],
    },
    prompts: {
      lead: "You are the lead of a docs sprint. The mission is in {mission}. List the pages that are missing or out of date and give each writer whole pages as tasks (teammates: {teammates}). Don't write pages yourself.",
      writer:
        "You are a writer. Read {mission} and take the first '[ ]' task tagged with your name or @writer: mark it '[~]', read the code the page describes, then write or update the page in plain language with working examples. Commit on your branch and mark it '[x]'.",
      reviewer:
        "You are the reviewer. Read {mission}. For each finished page, check every command, option and example against the code and run the examples where you can. Add errors as '- [ ] fix: … @author' lines. Don't edit the pages yourself.",
    },
    mission: {
      goalHint: "Which docs, e.g. 'Bring the CLI reference up to date with v3'",
      context: "Every example must run as written. Prefer short pages with one example each over long reference dumps.",
      tasks: [
        { text: "List missing and outdated pages, one task per page", owners: ["lead"] },
        { text: "Write or update your pages with examples that run", owners: ["writer"] },
        { text: "Check each finished page against the code and run its examples", owners: ["reviewer"] },
      ],
    },
    brain: [
      { title: "Docs style", kind: "convention", tags: ["docs", "style"], body: "Plain language, second person, present tense. One idea per paragraph. Code blocks name their language. No marketing words." },
    ],
    leadControl: "off",
  },
  {
    ...base,
    meta: meta("Security review", "Read-only scouts audit separate areas of the code, a reviewer confirms each finding. Nobody changes code.", ["security", "read-only", "audit"]),
    formation: {
      groups: [
        { name: "Lead", layout: "grid", slots: [{ role: "lead", agent: "claude" }] },
        {
          name: "Scouts",
          layout: "columns",
          slots: [
            { role: "scout", agent: "claude" },
            { role: "scout", agent: "claude" },
            { role: "scout", agent: "codex" },
          ],
        },
        { name: "Review", layout: "grid", slots: [{ role: "reviewer", agent: "codex" }] },
      ],
    },
    prompts: {
      lead: "You are the lead of a security review. The mission is in {mission}. Map the attack surface (inputs, auth, secrets, file and network access, dependencies) and give each scout one area as a task (teammates: {teammates}). Collect confirmed findings into a summary in the context. Nobody changes code in this review.",
      scout:
        "You are a security scout. Read {mission} and take the task tagged with your name or @scout. Audit that area by reading code only: injection, auth and access checks, secret handling, path traversal, unsafe deserialization, outdated dependencies. Add each finding as '- [ ] finding: <file:line> <issue> (severity) @reviewer'. Don't change code or run anything that writes.",
      reviewer:
        "You are the reviewer. Read {mission}. For each 'finding:' task tagged @reviewer, check the code it points to. Mark real issues '[x]' with a one-line note on impact and fix direction; mark false positives '[!] not an issue: reason'. Don't change code.",
    },
    mission: {
      goalHint: "Scope, e.g. 'Audit the public API and auth flow of the billing service'",
      context: "Read-only review: no code changes, no commands that write, no network calls to production. Findings name a file and line.",
      tasks: [
        { text: "Map the attack surface and give each scout one area", owners: ["lead"] },
        { text: "Audit your area and file findings with file, line and severity", owners: ["scout"] },
        { text: "Confirm or reject each finding", owners: ["reviewer"] },
        { text: "Write the summary of confirmed findings, highest severity first", owners: ["lead"] },
      ],
    },
    brain: [
      { title: "Security review is read-only", kind: "convention", tags: ["security"], body: "During a security review nobody edits code or runs commands that write files, change state or call production services. Findings go on the board." },
    ],
    leadControl: "off",
  },
  {
    ...base,
    meta: meta("Solo + reviewer pair", "One builder does the work in its own worktree, a reviewer in the same worktree checks each step.", ["pair", "small"]),
    formation: {
      groups: [
        {
          name: "Pair",
          layout: "columns",
          slots: [
            { role: "builder", agent: "claude", worktree: "pair" },
            { role: "reviewer", agent: "codex", worktree: "pair" },
          ],
        },
      ],
    },
    prompts: {
      builder:
        "You are the builder. Read {mission}. If it has no tasks yet, split the goal into small tasks under '## Tasks' tagged @builder. Then work through them: mark '[~]', implement with tests, commit, mark '[x]'. Fix anything the reviewer files for you before starting the next task.",
      reviewer:
        "You are the reviewer, working in the same folder as the builder. Read {mission}. After each task the builder marks '[x]', review the latest commit (git show HEAD) and run the tests. File problems as '- [ ] fix: … @builder'; write 'LGTM' under tasks that pass. Don't change code.",
    },
    mission: {
      goalHint: "The change in one line, e.g. 'Add retry with backoff to the webhook sender'",
      context: "",
      tasks: [
        { text: "Split the goal into small tasks", owners: ["builder"] },
        { text: "Review each finished task: latest commit and tests", owners: ["reviewer"] },
      ],
    },
    brain: [],
    leadControl: "off",
  },
];

/** Stable key of a gallery entry. */
export const galleryKey = (t: TeamTemplate) => `gallery:${t.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** UI name and description of each built-in entry, by galleryKey (translate at render time; English = meta). */
export const GALLERY_TEXT: Readonly<Record<string, { name: MessageKey; description: MessageKey }>> = {
  "gallery:feature-squad": { name: "teams.gallery.featureSquad.name", description: "teams.gallery.featureSquad.description" },
  "gallery:bug-bash": { name: "teams.gallery.bugBash.name", description: "teams.gallery.bugBash.description" },
  "gallery:refactor-with-safety-net": { name: "teams.gallery.refactor.name", description: "teams.gallery.refactor.description" },
  "gallery:docs-sprint": { name: "teams.gallery.docsSprint.name", description: "teams.gallery.docsSprint.description" },
  "gallery:security-review": { name: "teams.gallery.securityReview.name", description: "teams.gallery.securityReview.description" },
  "gallery:solo-reviewer-pair": { name: "teams.gallery.soloPair.name", description: "teams.gallery.soloPair.description" },
};
