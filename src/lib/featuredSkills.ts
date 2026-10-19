// A small curated list of skill repositories shown at the top of the Skills panel's Trending tab, also
// offline. "Featured" means picked by the Gridkeeper maintainers as good starting points, NOT verified or
// audited: every install still goes through the same review (SKILL.md, file list, scripts warning).
// Descriptions here are short and generic on purpose; the panel shows GitHub's own text once opened.
// They follow the UI language (getters over `skills.featured.*`, read at render time).

import { t } from "../i18n";

export interface FeaturedSkillRepo {
  /** `owner/name` on GitHub. */
  fullName: string;
  readonly description: string;
  /** Skill folder to open first, when the repository has several. */
  skillPath?: string;
}

export const FEATURED_SKILL_REPOS: readonly FeaturedSkillRepo[] = [
  {
    fullName: "raazi29/gridkeeper",
    get description() {
      return t("skills.featured.gridkeeper");
    },
    skillPath: "skills/agent-mission",
  },
  {
    fullName: "anthropics/skills",
    get description() {
      return t("skills.featured.anthropics");
    },
  },
  {
    fullName: "cathrynlavery/diagram-design",
    get description() {
      return t("skills.featured.diagramDesign");
    },
  },
  {
    fullName: "mattpocock/skills",
    get description() {
      return t("skills.featured.mattpocock");
    },
  },
  {
    fullName: "heygen-com/hyperframes",
    get description() {
      return t("skills.featured.hyperframes");
    },
  },
];

export function featuredEntry(fullName: string): FeaturedSkillRepo | undefined {
  const key = fullName.toLowerCase();
  return FEATURED_SKILL_REPOS.find((f) => f.fullName.toLowerCase() === key);
}
