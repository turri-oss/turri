import type { JobRegistry } from "./regenerate/jobs.ts";

/**
 * Where the person sees turri's work: the terminal - regen, its keys, /pulses - unless a host that runs the conversation
 * itself describes its own (TurriHost.surface). Kept with the conversation's job registry, so what is told the model
 * deep in a tool - a pulse not found - says the host's words and not the terminal's.
 */
const surfaces = new WeakMap<JobRegistry, string>();

/** The host's surface for the conversation these jobs are: blank or undefined is the terminal. */
export function setSurface(jobs: JobRegistry, surface: string | undefined): void {
  const text = surface?.trim() ?? "";
  if (text !== "") surfaces.set(jobs, text);
  else surfaces.delete(jobs);
}

/** The host's surface, in its own words - undefined in the terminal. */
export function surfaceOf(jobs: JobRegistry | undefined): string | undefined {
  return jobs !== undefined ? surfaces.get(jobs) : undefined;
}
