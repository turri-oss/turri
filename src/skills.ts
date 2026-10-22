/**
 * Where skills are found: turri's own, in `genome/skills/` of this package, and the project's - `.turri/skills/` and
 * `.agents/skills/` in the project's folder, a folder a skill with its SKILL.md, in the format of turri's own. A
 * project's skill is run the same way: its steps, its gates and judges, the tools its frontmatter names.
 *
 * A name is one skill: turri's own come first, then `.turri/skills/`, then `.agents/skills/`, and a skill whose name is
 * taken already is left out and said to be - a project's `brood` never quietly stands in for turri's.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { loadSkill, type Skill } from "./skill.ts";

/** A project's skill folders, in the order they are read, relative to the project. */
export const PROJECT_SKILL_DIRS = [join(".turri", "skills"), join(".agents", "skills")];

export interface FoundSkill extends Skill {
  /** turri's own, or the project's - then where in it, relative to the project: ".agents/skills/release-notes". */
  origin: "turri" | { project: string };
}

export interface SkillCatalogue {
  skills: FoundSkill[];
  /** Skills that did not parse, by where they are: a name for turri's own, the folder for a project's. */
  pending: string[];
  /** A project's skills left out because the name is taken, and by what. */
  shadowed: string[];
}

function folders(root: string, includeFixtures: boolean): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (!entry.name.startsWith("_") || includeFixtures))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every skill turri can run in `projectDir`: its own from `packageRoot`, then the project's. */
export function discoverSkills(packageRoot: string, projectDir: string | undefined): SkillCatalogue {
  const catalogue: SkillCatalogue = { skills: [], pending: [], shadowed: [] };
  const builtIn = join(packageRoot, "genome", "skills");
  for (const name of folders(builtIn, process.env.TURRI_INCLUDE_FIXTURES === "1")) {
    try {
      catalogue.skills.push({ ...loadSkill(join(builtIn, name)), origin: "turri" });
    } catch {
      catalogue.pending.push(name);
    }
  }
  if (projectDir === undefined) return catalogue;

  for (const dir of PROJECT_SKILL_DIRS) {
    const root = join(projectDir, dir);
    for (const name of folders(root, true)) {
      const where = relative(projectDir, join(root, name));
      let skill: Skill;
      try {
        skill = loadSkill(join(root, name));
      } catch {
        catalogue.pending.push(where);
        continue;
      }
      const taken = catalogue.skills.find((other) => other.name === skill.name);
      if (taken !== undefined) {
        catalogue.shadowed.push(`${where} (${skill.name} is ${taken.origin === "turri" ? "turri's own" : `${taken.origin.project}`})`);
        continue;
      }
      catalogue.skills.push({ ...skill, origin: { project: where } });
    }
  }
  return catalogue;
}

/** A skill's line in cultivate's list: a project's says so, and where it is. */
export function catalogueLine(skill: FoundSkill): string {
  const whose = skill.origin === "turri" ? "" : ` (this project's, ${skill.origin.project})`;
  // One the person starts themselves - typed, or picked among the options the model offers: never run unasked.
  const byCommand = skill.commandOnly ? ` Started only by the person, with /${skill.name} or by picking it when you offer it with ask_user: never run it unasked.` : "";
  return `- ${skill.name}${whose}: ${skill.description}${byCommand}`;
}

/** What is said under the list about the skills it leaves out. */
export function leftOutNote(catalogue: SkillCatalogue): string {
  return [
    ...(catalogue.pending.length > 0 ? [`Failed to load and therefore not runnable: ${catalogue.pending.join(", ")}.`] : []),
    ...(catalogue.shadowed.length > 0 ? [`Left out, their names taken: ${catalogue.shadowed.join(", ")}.`] : []),
  ]
    .map((line) => `\n\n${line}`)
    .join("");
}

/**
 * Which skills cultivate may start now. A skill marked command-only (`/brood`) waits for the person to type its command:
 * the command lets it start once, and the run starting uses that up - the model cannot start it again later on its own.
 */
export function createCommandGate(): {
  /** The person typed the skill's command. */
  typed(name: string): void;
  /** Whether cultivate may start it now. */
  mayStart(skill: Pick<FoundSkill, "name" | "commandOnly">): boolean;
  /** Its run started: the command is used up. */
  started(name: string): void;
} {
  const typed = new Set<string>();
  return {
    typed: (name) => void typed.add(name),
    mayStart: (skill) => !skill.commandOnly || typed.has(skill.name),
    started: (name) => void typed.delete(name),
  };
}

/** What cultivate says of a command-only skill the person did not start. */
export function startedByCommandOnly(name: string): string {
  return `Not started: ${name} is started only by the person, with /${name} or by picking an option starting /${name} that you offer them with ask_user. For a new project, ask them as <new-project> says; otherwise do what they asked yourself, in the conversation.`;
}

/**
 * What the model is told when the person picked a skill: start it now, with what they asked for - word for word, as the
 * message that set off the question - so they never type its command after picking it.
 */
export function startPicked(name: string, request: string): string {
  const asked = request.trim();
  return (
    `They picked ${name}, and it may start now: call cultivate with skill "${name}" at once, before anything else, and never ask them to type /${name}. ` +
    `Pass as its context everything they have told you${asked !== "" ? `, starting with what they asked for, word for word: ${JSON.stringify(asked)}` : ""}.`
  );
}

/**
 * The command-only skill an answer picks: an option offered to the person that starts with its command - `/brood - an
 * interview` - is the person starting it, as if they typed it.
 */
export function chosenCommand(answer: string, skills: ReadonlyArray<Pick<FoundSkill, "name" | "commandOnly">>): string | undefined {
  const typed = /^\s*\/([\w-]+)/.exec(answer)?.[1];
  return skills.find((skill) => skill.commandOnly && skill.name === typed)?.name;
}
