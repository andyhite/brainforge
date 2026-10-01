---
name: Brainforge
description: Animation Checking Room, a flat graphite workbench that holds the artwork still while the tools around it change.
colors:
  accent: "light-dark(#245e9a, #9ac4ed)"
  accent-text: "light-dark(#ffffff, #12273a)"
  accent-soft: "light-dark(#e0edf9, #283e51)"
  focus: "light-dark(#175b9e, #b8ddff)"
  bg: "light-dark(#f3f5f7, #191e23)"
  surface: "light-dark(#ffffff, #22282e)"
  surface-2: "light-dark(#eaf0f4, #2b333b)"
  surface-3: "light-dark(#dfe7ed, #35404a)"
  stage: "light-dark(#e0e5e9, #12171b)"
  text: "light-dark(#202b34, #edf1f4)"
  text-muted: "light-dark(#52616d, #a9b6c1)"
  border: "light-dark(#cbd4dc, #3c4751)"
  border-control: "light-dark(#7a8b99, #7c8d9b)"
  ok: "light-dark(#23633d, #8ed0a5)"
  ok-soft: "light-dark(#e6f2e9, #283c32)"
  warn: "light-dark(#87510b, #efc17c)"
  warn-soft: "light-dark(#fcf1df, #40372a)"
  danger: "light-dark(#ab292b, #ffaba6)"
  danger-soft: "light-dark(#fceceb, #442c2d)"
  checker-a: "#cbd0d4"
  checker-b: "#e8ebed"
  view-light: "#f2f2f2"
  view-dark: "#161616"
  guide-mark: "#ff4081"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.35
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 650
    lineHeight: 1.5
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-compact:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 550
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
  mono:
    fontFamily: "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  inner: "4px"
  radius: "6px"
  pill: "999px"
spacing:
  u: "4px"
  u-1-5: "6px"
  u-2: "8px"
  u-3: "12px"
  u-4: "16px"
  u-5: "20px"
  u-6: "24px"
  u-8: "32px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.radius}"
    padding: "0 12px"
    height: "34px"
  button-hover:
    backgroundColor: "{colors.surface-2}"
  button-active:
    backgroundColor: "{colors.surface-3}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    typography: "{typography.control}"
    rounded: "{rounded.radius}"
    padding: "0 12px"
    height: "34px"
  button-pressed:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
  segment:
    typography: "{typography.body-compact}"
    rounded: "{rounded.radius}"
    padding: "0 8px"
    height: "28px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.radius}"
    padding: "6px 10px"
    height: "34px"
  chip:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.radius}"
    padding: "0 12px"
    height: "34px"
  chip-pressed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
  status-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
    rounded: "{rounded.inner}"
    padding: "2px 6px"
  status-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
    rounded: "{rounded.inner}"
    padding: "2px 6px"
  status-bad:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.inner}"
    padding: "2px 6px"
  status-info:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.inner}"
    padding: "2px 6px"
  status-idle:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.inner}"
    padding: "2px 6px"
  nav-tab:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
    typography: "{typography.control}"
    padding: "0 16px"
    height: "42px"
  nav-tab-current:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  asset-navigator:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-compact}"
    padding: "12px"
    width: "264px"
  navigator-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.inner}"
    padding: "0 8px"
    height: "30px"
  stage-pane:
    backgroundColor: "{colors.stage}"
    rounded: "{rounded.radius}"
    padding: "6px"
  stage-backdrop-light:
    backgroundColor: "{colors.view-light}"
  stage-backdrop-dark:
    backgroundColor: "{colors.view-dark}"
  inspector-rail:
    width: "clamp(340px, 28vw, 440px)"
  inspector-drawer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    padding: "12px"
    width: "min(440px, 100vw)"
    height: "100dvh"
  next-band:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.text}"
    rounded: "{rounded.radius}"
    padding: "12px 16px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.radius}"
    padding: "20px"
  annotation-marker:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.pill}"
    padding: "0 6px"
    height: "24px"
---

# Design System: Brainforge

## Overview

**Creative North Star: "The Animation Checking Room"**

Brainforge is a production workbench for a solo indie 2D game developer judging generated art and animation on a macOS desktop. The system holds the artwork still while the surrounding tools change: a compact two-row header, a narrow asset navigator, a dominant viewing stage, and a contextual decision inspector. Moving between definition, production, review, and release changes the task around the asset; it never moves the asset off the stage.

The world is neutral graphite and slate with clear near-white text in dark, and an intentional cool-paper counterpart in light. Both are one token set written as CSS `light-dark()` pairs; the appearance control only flips `color-scheme`. A single restrained cool blue marks action, selection, and current location. Everything else is flat: fine 1px separators, squared-off soft 6px corners, panes rather than nested cards, and shadows only on transient layers. Density is compact and desktop-first (34px controls, 13px control text), and coarse pointers grow every control to 44px.

The artwork's own colour is never interpreted. Viewing backdrops (checkerboard, light, dark) are a per-viewer choice independent of the app theme, native-resolution views render pixelated, and measurement overlays use a single magenta that belongs to neither theme. Per-route composition lives in the surface brief (`.impeccable/surfaces/src-app-tsx.md`), not here.

**Key Characteristics:**
- Flat graphite/slate panes with 1px hairline separators; light counterpart from the same `light-dark()` tokens.
- One restrained blue for action, selection, focus, and current location.
- System sans in a compact ramp (12–24px); no display role; tabular numerals for frames, counts, and hashes.
- Artwork-led pane grammar: navigator, stage, inspector, strip.
- Theme-independent viewing backdrops and measurement guides.
- Status always carries an icon and text, never colour alone.

## Colors

A cool slate neutral family carries almost every pixel; one blue accent and three muted semantic pairs do all the signalling.

### Primary
- **Checking-Room Blue** (`accent`): primary buttons, current navigation tab, selected navigator item, pressed toggles, links, selection rings around the current candidate, note, or lineage row, and filled annotation markers. Text on it is **Accent Ink** (`accent-text`).
- **Selection Wash** (`accent-soft`): the quiet fill behind current tabs, pressed viewer toggles, the active version row, info statuses, and the workbench "Next" band.
- **Focus Blue** (`focus`): the 2px focus outline (offset 3px globally, 2px inside dense panes and summaries), kept separate from `accent` so focus stays visible on blue fills.

### Neutral
- **Workroom Ground** (`bg`): the app background behind panes and sticky ledger heads.
- **Pane Surface** (`surface`): topbar, navigation bar, asset navigator, panels, inputs, default buttons, drawer, and popovers.
- **Raised Slate** (`surface-2`): hover fills, table heads, chips, prompt and code blocks, idle status chips, selected navigator group.
- **Pressed Slate** (`surface-3`): button active state only.
- **Stage Slate** (`stage`): the review stage well behind the viewer, one step darker than the ground so artwork reads as framed.
- **Ink** (`text`) and **Muted Ink** (`text-muted`): body and secondary text; muted ink also carries table heads, crumbs, and metadata.
- **Hairline** (`border`): every pane separator, table rule, and card edge.
- **Control Edge** (`border-control`): button and input borders, dashed empty-state and non-lifecycle tag outlines. It is the only border that must reach 3:1 against `surface`.

### Semantic
- **Approved Green** (`ok` on `ok-soft`), **Attention Amber** (`warn` on `warn-soft`), **Rejected Red** (`danger` on `danger-soft`): status chips, banners, required annotation rectangles (amber), job problem edges, and danger buttons. Each pair clears 5.8:1 in both schemes.

### Viewing
- **Checker Light/Dark** (`checker-a`, `checker-b`): the transparency checkerboard in viewers, thumbnails, and family stages. Fixed values; they do not change with theme.
- **Light Backdrop** (`view-light`) and **Dark Backdrop** (`view-dark`): the viewer's Light and Dark options, fixed values independent of theme.
- **Guide Magenta** (`guide-mark`): seam outlines, nine-slice guides, and attachment dots drawn over artwork.

### Named Rules
**The Quiet Blue Rule.** `accent` means "act here" or "this one is current". It never decorates, never fills a pane, and never appears as a second accent hue.

**The Untouched Artwork Rule.** Viewing backdrops and guides never follow the app theme, and no filter, tint, or blend ever touches an output. Light, dark, or checker is the reviewer's choice per viewer.

**The Never-Colour-Alone Rule.** Every status is an icon plus words; tone colour only reinforces it.

## Typography

**Body Font:** System sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`)
**Label/Mono Font:** `ui-monospace, "SF Mono", Menlo, Consolas, monospace` for hashes, ids, paths, prompts, and recipe text

**Character:** The platform sans in a tight working ramp. Heavy-ish 650 weights carry hierarchy so sizes can stay small and the stage keeps the space.

### Hierarchy
- **Headline** (650, 24px, 1.2, -0.025em): page headers on non-workspace routes (Export, Settings, project entry). Never inside the review room.
- **Title** (650, 17px, 1.35): candidate identity in the review room, dialog titles, history sections. Workspace context titles run one step up at 18px.
- **Heading** (650, 14px): pane headings, decision heading (15px), release pane titles.
- **Body** (400, 14px, 1.5): running text; notes and explanations cap at 64–80ch.
- **Body Compact** (400, 13px): inputs, tables, inspector rail, kv facts, navigator.
- **Control** (550, 13px): buttons and navigation tabs. Pressed and current states step to 650.
- **Label** (600, 12px): form labels; status chips use 12px at 550; navigator group headings are 11px uppercase with 0.06em tracking.
- **Mono** (12px; 13px/1.6 in textareas): identities, hashes, paths, frame readouts.

### Named Rules
**The No-Display Rule.** The system has no display role. The largest type is a 24px page headline, and in the review room identity tops out at 17px so the artwork owns the viewport.

**The Tabular Identity Rule.** Frame numbers, counts, version numbers, and ledger cells use `font-variant-numeric: tabular-nums` so live updates never shift columns.

## Layout

The spacing unit is 4px (`u`); gaps and padding are multiples of it (6, 8, 12, 16, 20, 24, 32px), written as `calc(var(--u) * n)`.

**Shell.** A 52px topbar (brand, project switcher, live status, appearance, project details) and a 42px navigation bar (four destinations plus Settings at the far right) form a 94px header (`--header-h`). The document is exactly viewport-high and `main` is the only scroller; panes inside it scroll themselves with `overscroll-behavior: contain`. Ordinary routes pad 24px 28px 32px inside a 1600px max width; workspace routes (an asset, a candidate) drop padding and fill the height.

**Workspace panes.** Asset workspace: a 264px sticky asset navigator beside the task area. Task area: stage plus a 300px rail. Review room: stage plus an inspector of `clamp(340px, 28vw, 440px)`, both fitting one pane height of `max(520px, 100dvh - header - 24px)`, with the candidate or frame strip under the stage. Releases: records plus a sticky 320–400px aside. Settings: a 200px local nav. Activity: a 280–380px list beside a sticky detail.

**Responsive behavior.**
- **≤1279px:** the asset navigator collapses behind a toggle above the content (body capped at 60vh when open), the task rail and workbench home stack.
- **≤1100px (narrow desktop and 200% zoom):** the review inspector leaves the grid and becomes a native modal `<dialog>` drawer at the right edge (`min(440px, 100vw)`, full height, sticky head with Close), opened by "Decision & notes", with focus trap, Escape, and focus return. The stage takes `clamp(380px, 70dvh, 640px)`. Releases, Activity, Settings, Review queue, processing, and project entry splits stack to one column; the topbar tightens and hides the Appearance label.
- **≤900 / ≤700px:** the four-state release key goes to two columns; version records stack.
- **≤759px:** topbar wraps, navigation icons and the Settings label hide, main pads 20px 16px, compare grids and diffs go single column. The release ledger reflows to labelled blocks at ≤760px.
- **Coarse pointer:** control height becomes 44px.

### Named Rules
**The Still Artwork Rule.** When space runs out, tools move (navigator collapses, inspector becomes a drawer); the stage never shrinks to make room for chrome.

**The One Scroller Rule.** The page never scrolls behind the workspace. `main` scrolls; panes scroll internally; sticky heads stay inside their scroller.

## Elevation & Depth

Flat at rest. Depth comes from tonal steps (`bg` → `surface` → `surface-2`, with `stage` sunk below the ground) and 1px hairlines. Shadows appear only on layers that float above the workspace and dismiss.

### Shadow Vocabulary
- **Popover** (`box-shadow: 0 12px 32px rgb(0 0 0 / 0.22)`): the Project details panel under the topbar.
- **Inline popover** (`box-shadow: 0 4px 16px rgb(0 0 0 / 0.25)`): processing-warnings list opened from the output bar.
- **Drawer** (`box-shadow: -8px 0 24px rgb(0 0 0 / 0.3)`, backdrop `rgb(0 0 0 / 0.45)`): the ≤1100px inspector drawer.
- **Dialog scrim** (`rgb(0 0 0 / 0.5)`): Radix modal overlay; the dialog itself is bordered, not shadowed.
- **Selection ring** (`box-shadow: 0 0 0 2px` accent, or `inset 0 0 0 1px` accent in lists): marks the current candidate, note, lineage row, navigator item, or activity item. A ring, not elevation.

### Named Rules
**The Flat-At-Rest Rule.** Resting surfaces carry no shadow. If it does not float and dismiss, it gets a hairline instead.

## Shapes

Squared-off soft corners: 6px (`radius`) on every button, input, pane, panel, card, stage, and dialog; 4px (`inner`) for elements nested tight inside a pane (status chips, badges, navigator links); full pills (`pill`) only for annotation markers and note numbers, and circles only for drag handles and attachment dots. Borders are 1px solid hairlines; dashed 1px `border-control` marks absence or provisional states (empty states, non-lifecycle tags such as exported/reviewed, draft annotations). Segmented viewer controls join into one outline with shared dividers, rounding only the outer corners. Icons are authored 24-unit SVG strokes at 1.6 weight with round caps and joins, 18px by default and 14px inside status chips.

### Named Rules
**The Separator-Not-Card Rule.** Sections are flat bands divided by a top hairline. A panel nested in a panel loses its border, radius, and fill and becomes a separator.

## Components

### Buttons
Compact, bordered, quiet until pressed.
- **Shape:** soft corners (6px), 34px tall (44px on coarse pointers), 12px horizontal padding, 8px icon gap.
- **Default:** `surface` fill, `border-control` edge, control type. Hover moves to `surface-2` with a `text-muted` edge; active to `surface-3`. Transitions: background and border colour, 150ms ease-out; removed under reduced motion.
- **Primary:** `accent` fill and edge, `accent-text`, 650 weight; hover mixes 12% of `text` into the accent. One primary per decision area (Approve, Start export, Open the review queue).
- **Pressed toggle:** `aria-pressed` buttons take `accent-soft` with an `accent` edge and text.
- **Danger / Link:** danger is outlined `danger` text on the default fill; link buttons are underlined `accent` text with no box.
- **Disabled:** 55% opacity, not-allowed cursor.

### Segmented Groups
Viewer options (Fit/1:1, Checkerboard/Light/Dark, Frames/Atlas, tool choice) sit in segmented groups: 28px segments, 8px padding, 13px, joined with -1px overlap, outer corners only rounded, pressed segment filled per the pressed toggle.

### Chips & Status
- **Status chip:** icon plus text, 12px/550, 2px 6px padding, 4px corners, tone pairs `ok`, `warn`, `bad` (`danger`), `info` (`accent`), `idle` (`surface-2` / `text-muted`). In the topbar the fill drops to transparent.
- **Filter chip:** 34px, `surface-2`, 13px/600; pressed fills `accent` with `accent-text`. Inline span/code chips shrink to 2px 8px at 400.
- **Banner:** same tone pairs, 1px tone border, 12px 16px padding, icon left, body text in `text`.

### Inputs / Fields
- **Style:** `surface` fill, 1px `border-control`, 6px corners, 34px min height, 6px 10px padding, 13px. Textareas are mono 13px/1.6, vertical resize. Checkboxes and radios are 17px with `accent-color`. Caret is `accent`; placeholders use `text-muted` at full opacity.
- **Labels:** 12px/600 above the field, 4px gap; hints 12px `text-muted`; field errors `danger` 600, warnings `warn` 600.
- **Focus:** the global 2px `focus` outline at 3px offset.

### Navigation
- **Primary tabs:** four destinations (Workbench, Review, Releases, Activity) plus Settings pinned right, 42px bar, 13px/550 `text-muted` with an 18px icon. Hover adds `surface-2`; current adds `accent` text, `accent-soft` fill, and a 2px `accent` bottom edge.
- **Section nav:** a text-only second row (12px) under destinations with sub-views; current is `text`, 650, with a 1px underline.
- **Asset navigator:** 264px `surface` column with search and filter, assets as 30px rows, task groups headed by small uppercase group headings, depth indented 10px per level, active task `accent-soft` with a 1px inset `accent` ring and inner 4px corners. Collapses at ≤1279px.

### Stage & Viewers (signature)
The stage is a `stage`-coloured well with a 1px hairline and 6px corners whose child viewer fills it. Inside, the viewer backdrop is chosen per viewer: checkerboard (`checker-a`/`checker-b`), `view-light`, or `view-dark`. Native-resolution and family previews render with `image-rendering: pixelated`. Annotation rectangles are 2px `accent` strokes over a 12% accent wash (amber when required, dashed while drafting); markers are 24px pills in `accent` with a 2px `accent-text` ring. A frame-notes track (6px) under the clip marks frames with notes in `accent`. A concept strip of 72px tiles with 64px thumbs sits under the stage, current tile ringed in `accent`.

### Decision Inspector (signature)
A column of flat disclosure sections beside the stage: Decision (target, status, Approve/Reject/Override, reason), then collapsible reason presets, policy, history, and notes, separated by top hairlines with 34px summaries and tabular counts right-aligned. Above 1100px it is a non-modal `<dialog open>` laid in the grid; at ≤1100px the same element opens with `showModal()` as the right-edge drawer.

### Records & Ledgers
Tables collapse borders, use 12px padding, 13px cells, 12px `surface-2` heads, and a 55% `surface-2` row hover. Release ledgers keep heads sticky on `bg` and reflow to labelled blocks at ≤760px. Version records are hairline-separated rows (64px number column, 20px/700 tabular version number); the active version takes `accent-soft`, the current one a 2px inset `accent` outline.

### Dialogs
Radix modal: centred `min(880px, 94vw)`, max 90vh, `surface`, 1px hairline, 6px corners, 24px padding, 17px title, focus trapped and returned to the opener.

## Do's and Don'ts

### Do:
- **Do** take every colour from the `light-dark()` tokens; switching appearance changes only `color-scheme`.
- **Do** keep the stage at full width when space runs out: collapse the navigator at ≤1279px and move the inspector into the native drawer at ≤1100px.
- **Do** give every status an icon and words, using the five tone pairs.
- **Do** separate sections with a 1px top hairline and keep them flat; reserve 6px-cornered bordered boxes for actual objects (candidates, notes, versions, stages).
- **Do** keep controls at 34px (44px on coarse pointers) and build gaps from the 4px unit.
- **Do** render outputs on the viewer-chosen backdrop (`checker-a`/`checker-b`, `view-light`, `view-dark`) and use `image-rendering: pixelated` for native-resolution views.

### Don't:
- **Don't** tie viewing backdrops or guides to the app theme, or filter, tint, or blend an output.
- **Don't** add a second accent hue or use `accent` as decoration; it marks action, selection, and current location only.
- **Don't** put shadows on resting surfaces; only popovers, the drawer, and dialogs float.
- **Don't** nest bordered cards; an inner panel becomes a separator.
- **Don't** introduce radii other than 4px, 6px, and pills.
- **Don't** let live updates move an action under the pointer; use tabular numerals and fixed-position controls.
