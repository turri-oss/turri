# Outline an area's features

Your area of the codebase becomes one module of ***plain. Outline it into features - each a thing a user or a client can do, or a part of what they see - which agents then capture side by side, one feature each. Call `submit_capture_features` once.

- A feature gets a short kebab-case `name`, a `title` of a few words, a line `about` what it lets someone do, and its `paths`: the folders and files where it is built, relative to the codebase - where its agent starts looking.
- A feature is about what a user sees: `sign-up`, `password-reset`, `invoice-export` - never a layer or a file (`models`, `utils`).
- Size: a feature is captured in up to eight functional specs, each about two hundred lines of code. A larger one is two features.
- List them in build order: each feature only builds on those before it - the first is the simplest thing the area does that can be seen working, and what everything else needs (the data it keeps) comes early. In a codebase that starts here, the first feature also brings up the project - its entry point, its first screen or endpoint.
- What the stack below already settles is not a feature: settings, logging, request ids, error bodies, middleware, how the app starts. Put such a file in `left_out` with why - settled by the stack - unless the original does something there that a user or a client would notice is different from what the stack says; then that difference alone is a feature.
- Every route, command, option, screen, environment variable and table of your area belongs to a feature, or the file it is in is in `left_out` with why: the interface is captured whole, so no option is too small to be a feature's. Shared helpers belong to no feature: what they do shows in the features that use them.
- The area's tests are where its features show: a test file belongs with the feature it tests.
