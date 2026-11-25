# Split an area

Your area of the codebase is too large for one agent to outline: split it into smaller areas, each a cohesive part of what the software does - authentication, billing, the editor, the admin screens - so each can be captured on its own. Call `submit_capture_areas` once.

- Each area gets a short kebab-case `name` from what it does, a line `about` what it does, and its `paths`: folders or files of your area, relative to the codebase.
- Divide by what the software does, not by technical layer, where the code allows it: an area's routes, its data and its screens together. Where the code is layered - a `models/` folder for everything - follow the folders, and name an area by what it does.
- Every file of your area belongs to one area, or is in `left_out` with why: vendored, generated, tooling. A path in one area is in no other.
- At least two areas, each smaller than yours. Fewer, larger areas are better than many small ones: an area is worth an agent when it holds a few thousand lines.
- List them in build order: the foundations first - the data model, shared services - then what is built on them. The harness also orders them by what imports what.
