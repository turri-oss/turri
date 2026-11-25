# Make the module readable

Below is a module's ***plain as a capture wrote it - feature by feature, by agents that each saw only their own feature - each functional spec with its scenarios. You read the ***plain alone, never the code: what you judge is whether a person can review it. Rewrite a functional spec only where it reads as code rather than as what the software does:

- a function, class, file, variable or internal data shape named, where the behaviour is what matters
- a default stated - that invalid input is rejected, that data is saved, that errors are reported - with nothing particular about it, or anything the stack below says already - never an option's default, choices or value, which are the interface
- a restatement of a functional spec before it, or of a concept's definition
- a case where the rule is stated - an example, what one wrong input or a missing record answers - that a scenario of it pins, or that the stack settles: the scenario and the stack keep it
- rationale, narration, history, hedges and adjectives no test can check
- one fact spread over several sentences, or several facts in one long sentence

A functional spec that says nothing the stack and the specs before it do not say already is cut down to what is left, or, when nothing is, to its first line. Keep every fact that is its own: every interface detail - a command, an option and each of its names, its choices and default, a method, path, field, status code, message, exit code, environment variable, format - however obvious it reads, every boundary, and every error the stack does not settle and no scenario pins. Scenarios are not yours to change. Keep its concepts, or use others its module has. A functional spec that reads well is left as it is: most are. Call `submit_capture_edits` once, with the new text of each functional spec you rewrote, by its func-id - none at all when none needs it.
