# Ylide design language

## Idea

Ylide stands for "Your Local IDE", and the name is the core promise: the IDE
and its models run on your own machine. The visual language is inspired by the
braided world lines of anyons, the quasiparticles of topological quantum
computing, and that picture still fits: agents are shown as world lines that
*braid* around each other at every hand-off. Real quantum computers hang in a
cryostat: a gold "chandelier" in extreme cold. Ylide's look comes from that
world instead of generic "AI neon":

* **Cold depth** for surfaces: deep cryostat blue, never a neutral near-black.
* **Qubit cyan** as the one signal colour: focus, primary actions, AI activity.
* **Brass** (the chandelier) used sparingly for what is physical and local:
  hardware, memory, model files, the "runs on this machine" promise.
* **The braid** as the single memorable motif: the logo, the "thinking"
  indicator, and the agent overview, where each agent is a world line over time
  and every hand-off (Coder → Reviewer → Coder) is drawn as a crossing.

**Logo.** Two world lines braid into a Y: one runs on top the whole way, the
other passes under it at the crossing and slips under it again into the stem.
The mark is one colour; only the gap shows which line passes under, the way
knots are drawn in technical diagrams. No glow, gradient or metal effect: it
should read as drawn, not rendered. The app icon is the light mark
(`#E6ECF5`) on a flat `bg-app` tile (`apps/desktop/src-tauri/icons/ylide.svg`,
the source of every icon size); everywhere else the mark stands alone in the
text colour (`docs/brand/ylide-mark.svg`, `LogoMark` in the UI). Cyan stays
the accent of the interface, not of the logo.

Everything else stays quiet and precise, like laboratory instruments: hairline
borders instead of shadows, tabular numbers, measured values with units.

## Palette

| Token | Dark | Light | Use |
|---|---|---|---|
| `bg-sunken` | `#0C111B` | `#FFFFFF` | editor canvas, terminal |
| `bg-app` | `#111726` | `#F5F7FA` | window chrome, sidebars |
| `bg-raised` | `#18202F` | `#FFFFFF` | panels, inputs, popovers |
| `border` | `#273246` | `#D6DCE5` | hairlines (1px) |
| `text-1/2/3` | `#E7ECF4` / `#9AA6BB` / `#808CA6` | `#121826` / `#4A5468` / `#667085` | primary, secondary, tertiary |
| `accent` (qubit) | `#22D3EE` | `#0E7490` | focus, primary buttons, AI activity |
| `metal` (brass) | `#C9A66B` | `#7E5F24` | hardware, memory, local badges |
| `success` | `#3DD68C` | `#0F7A45` | |
| `warning` | `#F2A93B` | `#945600` | |
| `danger` | `#F47067` | `#B83227` | |

Contrast: every text and status token meets WCAG AA (4.5:1) on every surface
it is used on. The check is the unit test `src/design/contrast.test.ts`; for
example, accent on `bg-app` is 9.9:1 in dark and 5.0:1 in light.

## Typography

* **UI: Instrument Sans** (variable, OFL). A compact grotesk with a technical
  edge. The width axis is used for dense chrome (95) and for the onboarding
  display size (100, tight tracking).
* **Code: JetBrains Mono** (variable, OFL). It stays readable during long
  sessions and is clearly distinct from the UI face.
* Scale (px): 11 · 12 · **13 (UI base)** · 14 (chat) · 16 · 20 · 28 · 44 (onboarding display).
* Numbers in metrics use tabular figures. Sentence case everywhere. No
  all-caps labels.

## Space, shape, depth

* 4 px grid (`space-1` = 4 px … `space-10` = 64 px).
* Radii follow hierarchy, not one value for everything: 3 px chips, 5 px
  controls, 8 px panels, 12 px dialogs and onboarding sheets.
* Depth is shown with surface tone and a 1 px border. Shadows appear only on
  floating layers (menus, dialogs).

## Motion

* There is one orchestrated moment: the hardware scan in onboarding. Components
  are measured one after another and the values count up to their real numbers.
* Everything else is motion that answers an action: panels open (200 ms),
  diffs expand, approvals slide in where they are needed.
* The braid indicator moves only while a model is actually generating.
* `prefers-reduced-motion` disables all non-essential animation.

## Voice

Plain verbs, sentence case, no filler. A button says what happens ("Download
model", "Accept changes"). Errors say what happened and what to do next. Every
string exists in German and English (`src/i18n`).

## Files

* `apps/desktop/src/design/tokens.ts`: primitives (colours, spacing, radii,
  type, motion).
* `apps/desktop/src/design/themes.ts`: semantic themes (dark, light) and the
  Monaco editor theme derived from them. A new theme is one more entry.
* `apps/desktop/src/styles/base.css`: global styles that only reference tokens.
