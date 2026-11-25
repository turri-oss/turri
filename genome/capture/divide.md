# Divide the features

The part was outlined area by area, each area by an agent that saw only its own files - so one behaviour can be in two features: an option parsed in one area and acted on in another, a message built in a third, a command's help beside the command. Each feature is then written by an agent of its own, side by side; a behaviour in two features is written twice, in different words, and the two copies contradict each other. Below is every feature of the part, area by area, in build order, with what it is about and where it is built. Give each behaviour to one feature. Call `submit_capture_owners` once.

- `features`: every feature that stays, by its key as listed, with `owns`: one line naming what it alone captures - its commands, options, messages and behaviour - so its writer knows its edges and leaves the rest to the others. A behaviour two features would both capture is in the `owns` of one: the feature that is about it - where a user would look for it - never one that only parses it, passes it on or prints it.
- `merged`: a feature that is a slice of another's behaviour - the options of what another feature does, the printing of what another sends - is merged `into` the features that take it, with `why`: it is not written, and its files go to them. Merge for that, never because two features are small.
- Every option, command and route of the part is in the `owns` of one feature: the interface is captured whole, so name in `owns` the options and commands each feature takes.
- A feature builds only on the features before it: give a behaviour to one that comes after what it needs.
- You see the outline, not the code: decide from what each feature is about and where it is built. Most features stay as they are, owning what they were outlined for.
