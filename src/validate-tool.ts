import { resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkPlainTargets, formatCheckResults } from "./plain/check.ts";

/** validate, for the conversation and for the skills that write specs alike - the test advisor's in the background too. */
export function checkPlainTool(cwd: string) {
  return defineTool({
    name: "validate",
    label: "Validate spec",
    description:
      "Validate one or more .plain modules without regenerating: parses each with its test plain files, resolves its " +
      "imports and required modules, and reports every syntax, concept and structure error with the line it is on, " +
      "and every test plain file outside its module's folder. A module that passes lists each functional spec with its " +
      "test plain file and its scenarios - one with no test plain file is not tested. Pass a directory to " +
      "check every .plain module in it; a test plain file or test folder is refused - name its module. Fast, free, and offline.",
    promptSnippet: "validate a .plain spec, regenerating nothing",
    promptGuidelines: [
      "Run validate after editing a .plain file, and before telling the user a spec is valid or ready. Never shell out to another renderer to check one.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "A .plain file, or a directory holding .plain files" }),
      template_dir: Type.Optional(
        Type.Array(Type.String(), { description: "Extra template directories" }),
      ),
    }),
    async execute(_id, params) {
      const results = checkPlainTargets(
        resolve(cwd, params.target),
        (params.template_dir ?? []).map((dir) => resolve(cwd, dir)),
      );
      const failed = results.filter((result) => !result.ok).length;
      const text =
        results.length === 0
          ? `No .plain files found in ${params.target}.`
          : `${formatCheckResults(results)}\n\n${failed === 0 ? "All specs valid." : `${failed} of ${results.length} failed.`}`;

      return { content: [{ type: "text" as const, text }], details: { failed, checked: results.length } };
    },
  });
}
