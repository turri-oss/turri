/**
 * Starting a project from the conversation: the person says what they want built - "create a small server in Java
 * Spring Boot" - and the chat offers the three ways to start it: brood's interview, spawn's quick start, or writing the
 * ***plain itself, here, with no skill. An option picked that starts with a skill's command starts that skill, as if
 * typed (`chosenCommand` in skills.ts).
 */
export const NEW_PROJECT = [
  "<new-project>",
  "When the person asks for new software / project ",
  "and there is no ***plain module for it yet, or they ask for a new project, ask them first how to start it, with",
  "ask_user: one question, these three options, word for word, so they know the skills are there:",
  `- "${"/brood - an interview: the stack, the testing and every feature settled with you, each answer regenerated"}"`,
  `- "${"/spawn - something running in minutes: the quick start, asking the stack in one question unless your message names it"}"`,
  `- "${"Just do it - no skill: I write it here and start regenerating"}"`,
  "Picked /brood or /spawn: the answer starts it - call cultivate for it at once, with what they said as its context,",
  "never asking them to type its command. Do not ask when their",
  "message says already - they typed the command, or said to just build it, with no skill, without questions: then",
  "start it yourself. Started yourself, how soon the first pulse starts, and something they can try, come first:",
  "1. The stack: the one they named; otherwise one of the standard library's that this machine can build - common,",
  "   simple - said in a line. A stack named in a language the machine lacks is written all the same: tell them what to",
  "   install, and that turri doctor checks it. Read the stack's template, its language's and its kind's common first.",
  "2. One module - a .plain file in the project's root, named after what it is (server.plain) - importing the stack and",
  "   writing only what the module needs beyond it. Two side by side, each on its stack, only when it needs two stacks.",
  "3. config.turri.yaml: module: the new file, and conformance-tests: false unless they asked for conformance tests.",
  "   What a config there already settles - a stack, a script, conformance - is kept, not chosen again.",
  "4. The unit testing script: keep one turri already finds; otherwise run cultivate with implement-unit-testing-script",
  "   for the stack's language. Conformance tests asked for: their ***test reqs*** - the stack's conformance template -",
  "   and cultivate with implement-conformance-testing-script.",
  "5. The first functional spec: the smallest thing that runs and shows something - the server answers GET / with the",
  "   app's name, the CLI prints its usage. validate, fix what it finds, and regenerate at once.",
  "6. While it regenerates: the main thing they described, on its happy path, and at most one more - each a functional",
  "   spec, with its concepts - then validate and regenerate again. Only what they described: they named only the kind of",
  "   software, write none, and invite them to say what it does. No validation or edge cases yet.",
  "Then hand over in a few lines: what you chose, what is regenerating, and the next slices you would write - they say",
  "go on, or what to change, and every change after is ***plain you write and regenerate.",
  "</new-project>",
].join("\n");
