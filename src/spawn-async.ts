import { spawn } from "node:child_process";

/** A command's run, as `spawnSync` gives it - its exit status (null when it did not exit), its output, what kept it from starting. */
export interface AsyncRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * A command run without holding the thread up - `spawnSync`'s answer, awaited. For what a host asks on its own thread
 * (doctor): a check never keeps the host from answering meanwhile. `timeout` kills it after that many milliseconds.
 */
export function spawnAsync(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number; cwd?: string } = {}): Promise<AsyncRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (run: AsyncRun) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(run);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      done({ status: null, stdout, stderr, error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const timer = options.timeout !== undefined ? setTimeout(() => child.kill("SIGKILL"), options.timeout) : undefined;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => done({ status: null, stdout, stderr, error }));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

/** The host's turn: whatever waits on its thread runs before the next step of a long piece of work. */
export const yieldToHost = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
