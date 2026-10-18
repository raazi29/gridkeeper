// A small curated list of skill repositories shown at the top of the Skills panel's Trending tab, also
// offline. "Featured" means picked by the Gridkeeper maintainers as good starting points, NOT verified or
// audited: every install still goes through the same review (SKILL.md, file list, scripts warning).
// Descriptions here are short and generic on purpose; the panel shows GitHub's own text once opened.

export interface FeaturedSkillRepo {
  /** `owner/name` on GitHub. */
  fullName: string;
  description: string;
  /** Skill folder to open first, when the repository has several. */
  skillPath?: string;
}

export const FEATURED_SKILL_REPOS: readonly FeaturedSkillRepo[] = [
  {
    fullName: "raazi29/gridkeeper",
    description: "agent-mission: coordinate a team of agents through one shared task board (.gridkeeper/mission.md).",
    skillPath: "skills/agent-mission",
  },
  { fullName: "anthropics/skills", description: "Anthropic's collection of example and document skills." },
  { fullName: "cathrynlavery/diagram-design", description: "A skill for designing clear diagrams." },
  { fullName: "mattpocock/skills", description: "Matt Pocock's collection of agent skills." },
  { fullName: "heygen-com/hyperframes", description: "HeyGen's HyperFrames skills." },
];

export function featuredEntry(fullName: string): FeaturedSkillRepo | undefined {
  const key = fullName.toLowerCase();
  return FEATURED_SKILL_REPOS.find((f) => f.fullName.toLowerCase() === key);
}
