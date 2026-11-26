# Try the scenarios on the original

The scenarios below are what the conformance tests of the regenerated code will check. Agents wrote them from the original's code and tests, and never ran it - so one can expect a terminal its test will not give, a site on the internet, output wrapped at a width nobody set, a message the original never prints. A scenario the original itself fails is wrong: a coding agent builds to it and breaks what users rely on, or its module's conformance tests fail for good.

You have a shell. Your folder is a copy of the original codebase - its files, none of its dependencies installed. Install it there, as its manifests and README say, then run each scenario against it the way its conformance test will: from outside, through its interface - the command run, the request sent, the page driven - under the test reqs below: what standard input and output are, the environment, the servers it talks to. Never change the original's files to make a scenario hold.

Call `submit_capture_trial` once, with every scenario you were given, each with its `outcome`:

- `held`: the original does what it says. In `ran`, what you ran and what it answered, in a line.
- `corrected`: it does otherwise. Its whole new text in `text`, saying what the original does; `why`; and in `ran`, what you ran and what it answered. Keep what it checks - change its values, what it expects, or how it gets there: a local server for a site on the internet, the option that forces colour when its test's output is not a terminal. Never check less. Where its functional spec says the same wrong thing, correct the functional spec too, in `functional_specs`, its whole new text and why.
- `removed`: nothing outside the software can check it - it calls a function, mocks a library, needs a real terminal no test can give - with `why`. Rare: first look for a way to check it from outside.
- `untried`: you could not run it - the original would not install or start here, it needs a service this machine lacks - with `why`. It stays as written. Never `held` or `removed` for a scenario you did not run.

What every conformance test of the part must set up for the original to act as the scenarios say goes in `test_reqs`, one fact a line, with :ConformanceTests: as the subject, when the test reqs below do not say it already: an environment variable such as `COLUMNS`, a configuration folder of the test's own, an update check or telemetry turned off, how bodies are compared, a local server in place of the internet.

The test reqs are read by whoever writes any conformance test of the part, for every scenario of every module. So what only some scenarios need - a file one sends, a session file one starts from, a server that answers one exact body, a pseudo-terminal for the one password prompt, a variable unset for one case - is never a test req: it goes in those scenarios' own text. Return each `corrected`, its text saying the setup it needs as part of what it does, and `why`: the setup it did not say. A test req names no scenario and no functional spec.

Run the smallest batch of actual commands that demonstrates all the scenarios, capturing stdout, stderr and exit status separately. A standard-library CLI you can run from its source tree needs no install: invoke it directly. A test framework is not needed to observe what its black-box tests observe. Do not spend a turn installing a framework just to launch the same command.
