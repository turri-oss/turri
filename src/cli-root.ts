import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTurriRoot } from "@turri-dev/core/startup";

// Loaded in the command process, the pi child and a standalone pi extension alike.
export const CLI_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
setTurriRoot(CLI_ROOT);
