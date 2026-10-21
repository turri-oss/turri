# Theming

Two brand themes ship in `.pi/themes/`, built from the brand tokens. `turri` starts in `turri-dark`, the dark one; `--use-theme` picks another for that run:

```bash
turri                                       # turri-dark
turri --use-theme turri-light/turri-dark    # follows terminal appearance
turri --use-theme dark                      # pi's own
```

The second form follows your terminal's light/dark appearance. The default is for `turri` only: pi's settings are left alone, so a plain `pi` keeps its theme. With the themes copied to `~/.pi/agent/themes/` (`cp .pi/themes/*.json ~/.pi/agent/themes/`), `{"theme": "turri-dark"}` in `~/.pi/agent/settings.json` gives a plain `pi` the same one.

Bad input fails quietly - an unknown `--use-theme` name and a malformed theme file both run without complaint - so if the colours do not change, suspect a typo rather than the mechanism.

## The palette

Both themes, the command line's colours, the spec diff's, the banner's jellyfish and the docs' diagram are drawn from turri's design system and nothing else: dark, quiet surfaces, one pink thing to press, neon for anything you can follow. These are all the colours turri has - none is mixed, tinted or added, but for the jellyfish's tentacles, every other pixel of which the design draws half seen.

| name | value | in `turri-dark` |
|---|---|---|
| abyss | `#0a0f1a` | the page - the HTML export's background, and the surface the contrast below is measured on |
| tile | `#0d1420` | the HTML export's cards |
| hēi sè | `#142030` | boxes, the HTML export's callouts |
| blue whale | `#1e3442` | a highlighted line: `selectedBg`; an added line's fill in a spec diff |
| lines | `#22344a` | rules, dividers, frames: `borderMuted`, `mdHr` |
| path | `#3e5a6b` | the editor's border, what is dim: `dim`, line numbers |
| grauzone | `#85a3b2` | body text, and what can be skimmed: `text`, `muted` |
| white | `#f4f7f9` | headings, tool titles, what you typed |
| siesta tan | `#e9d8c8` | strings in code, [\*\*\*plain](https://plainlang.org/docs/)'s text in quotes or backticks |
| eggplant | `#732553` | a removed line's fill in a spec diff, the jellyfish's rim |
| neon | `#5ce1e6` | links, focus, the selection, section labels, \*\*\*plain's concepts in a spec diff: `accent`, `mdLink`, regen's `◆` |
| neon hover | `#8eebee` | inline code - siesta tan beside white text was too close to tell apart, and tiring to read - types in code, an added line's fill in a light theme's spec diff: `mdCode` |
| pink | `#ff5c8d` | the wordmark, the jellyfish's bell, and what is done - its `✓`, the spec map's `◇` and `◆`: `success` |
| pink hover | `#ff7fa6` | the glint on the jellyfish's bell, \*\*\*plain's section headers, a removed line's `-`, keywords in code |
| orchid | `#a9479a` | the jellyfish's bell, between its pink and its indigo - nowhere else |
| indigo | `#5b57d9` | the jellyfish's bell, at its rim - nowhere else |
| orange | `#ff7a3d` | the jellyfish's gut, the `$` of bash mode, and everything that asks for you - what failed (`✗`), what works with limits, what needs you (the spec map's `!`): `error`, `warning` |

The design system keeps pink for the one thing to press and orange for the `$` prompt alone. A terminal has no buttons, but it needs status colours, so pink carries what is done and orange everything that asks for you - what failed, what works with limits, what waits on you - the mark (`✗`, `!`, `■`) telling them apart. The palette has no red.

## Why there are two

Half the palette is unusable on the other background. Contrast against abyss and white:

| colour | on `#0a0f1a` | on `#ffffff` |
|---|---|---|
| white | 17.81 | 1.08 |
| neon | 12.20 | 1.57 |
| grauzone | 7.19 | 2.67 |
| pink | 6.54 | 2.93 |
| orange | 7.39 | 2.59 |
| path | **2.63** | 7.29 |
| blue whale | 1.48 | 12.92 |
| eggplant | 1.93 | 9.91 |

So `turri-light` is drawn from the design system's deep colours: abyss for text, eggplant for the accent, headings, what is done and the wordmark, blue whale for links and regen's `◆`, path for what is muted. Its pale colours become backgrounds - siesta tan for a selection, neon for a search hit, white for your messages. Orange stays the error and the warning at 2.59:1 - the palette has nothing warm that reads on white. The wordmark and regen's `◆` are painted outside the theme's slots (`brandPink` and `brandNeon` in `src/regenerate/plain-palette.ts`). **Path is never text that matters in the dark theme** - at 2.63:1 it is for rules and what is meant to recede.

## Backgrounds

The dark theme paints no panels: the backgrounds of your messages, turri's messages and the tool rows are `""`, the terminal's own background, so the transcript reads as one surface whatever the terminal's colour is - abyss or not, no block shows up as a box. Two are deliberately painted, because they have to be visible to work:

| token | value | why |
|---|---|---|
| `selectedBg` | `#1e3442` | a selection you cannot see is not a selection |
| `searchMatchBg` | `#5ce1e6` | search hits, with abyss text on top |

With tool rows carrying no background, their state is signalled by the title and the diff colours.

**The window's background is your terminal's setting**, and the transcript is drawn on it. For the brand look, set it to abyss, `#0a0f1a`, in your terminal profile.

## Spec diffs

A spec diff in the panels is not painted with the theme's colours for code: those are made for code, and the turri themes' backgrounds are all the surface colour, so a diff drawn with them would have no fills and hardly any highlighting. It has a palette of its own (`src/regenerate/plain-palette.ts`), one for a dark theme and one for a light, picked by the theme's appearance: a hue for each piece of \*\*\*plain - a section's header, a concept, a link, text in quotes or backticks, a front matter key, a module, a comment - at least 7:1 on the surface, and a fill behind each added and removed line: on a dark theme blue whale and eggplant, on a light one neon hover and siesta tan. Every colour reads at least 4.8:1 on blue whale and 5:1 on the light fills; eggplant, the design system's only warm dark fill, takes the pinks and grauzone down to 3.7:1.

## The font

The design system's fonts cannot be applied. pi draws into a terminal, so the typeface is your terminal emulator's setting. Its monospaced face is Geist Mono - set it in iTerm2 / Ghostty / Alacritty for the brand look; Neue Montreal, for headings, is proportional, and a terminal needs a monospaced face.
