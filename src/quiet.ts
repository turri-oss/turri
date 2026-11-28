/**
 * Warnings that say nothing a person can act on, dropped wherever they are printed. Google's SDK says this once per
 * client, so once per agent, when both keys are set - pi offers the google provider on GEMINI_API_KEY, and a machine
 * set up for other tools often has GOOGLE_API_KEY too.
 */
const NOISE = [/^Both GOOGLE_API_KEY and GEMINI_API_KEY are set\. Using GOOGLE_API_KEY\.$/];

function isNoise(args: unknown[]): boolean {
  return args.length === 1 && typeof args[0] === "string" && NOISE.some((pattern) => pattern.test(args[0] as string));
}

let noiseDropped = false;

/**
 * Drop the NOISE warnings for good, from here on. Only the console's methods: process.stdout.write is how pi draws the
 * screen. The core keeps them out of what it captures of its agents' output itself. Safe to call more than once.
 */
export function dropNoise(): void {
  if (noiseDropped) return;
  noiseDropped = true;
  for (const method of ["warn", "error", "log", "info", "debug"] as const) {
    const print = console[method];
    console[method] = (...args: unknown[]) => {
      if (!isNoise(args)) print.apply(console, args);
    };
  }
}
