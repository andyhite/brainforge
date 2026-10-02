---
name: Brainforge
description: Sprite Sheet, a graphite-and-paper workbench where the project is a sheet of cells you fill in and the artwork is the only colour on screen.
colors:
  bg: "light-dark(#f4f4f5, #111113)"
  surface: "light-dark(#ffffff, #18181b)"
  surface-2: "light-dark(#ececef, #222226)"
  surface-3: "light-dark(#e2e2e6, #2b2b30)"
  field: "light-dark(#ffffff, #0e0e10)"
  seg-on: "light-dark(#ffffff, #3a3a41)"
  border: "light-dark(rgb(0 0 0 / 0.09), rgb(255 255 255 / 0.075))"
  border-strong: "light-dark(rgb(0 0 0 / 0.2), rgb(255 255 255 / 0.18))"
  border-control: "light-dark(rgb(0 0 0 / 0.2), rgb(255 255 255 / 0.18))"
  text: "light-dark(#161618, #f1f1f2)"
  text-muted: "light-dark(#585861, #a3a3ac)"
  text-faint: "light-dark(#6f6f78, #85858e)"
  accent: "light-dark(#161618, #f1f1f2)"
  accent-text: "light-dark(#ffffff, #111113)"
  accent-soft: "light-dark(rgb(22 22 24 / 0.07), rgb(241 241 242 / 0.09))"
  focus: "light-dark(#161618, #f1f1f2)"
  ok: "light-dark(#18763f, #63d297)"
  ok-soft: "light-dark(#e3f3e9, rgb(99 210 151 / 0.12))"
  warn: "light-dark(#94560a, #f1b55e)"
  warn-soft: "light-dark(#fbf0dc, rgb(241 181 94 / 0.11))"
  danger: "light-dark(#b8342b, #ff8077)"
  danger-soft: "light-dark(#fbe9e7, rgb(255 128 119 / 0.11))"
  note: "#f1b55e"
  note-text: "#1b1203"
  guide: "#ff4081"
  checker-a: "light-dark(#e7e7ea, #1e1e22)"
  checker-b: "light-dark(#f5f5f7, #18181b)"
  stage-a: "light-dark(#d6d6da, #26262b)"
  stage-b: "light-dark(#ececee, #1c1c20)"
  backdrop-light: "#ececee"
  backdrop-dark: "#141416"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 660
    lineHeight: 1.15
    letterSpacing: "-0.022em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.012em"
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 640
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 620
    lineHeight: 1.35
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-compact:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 560
    lineHeight: 1.2
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.5
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  badge:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 640
    lineHeight: 1
  mono:
    fontFamily: "ui-monospace, \"SF Mono\", Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "\"tnum\""
  mono-count:
    fontFamily: "ui-monospace, \"SF Mono\", Menlo, monospace"
    fontSize: "11px"
    fontWeight: 550
    lineHeight: 1
    fontFeature: "\"tnum\""
rounded:
  hair: "2px"
  frame: "3px"
  key: "4px"
  cell: "5px"
  sm: "6px"
  md: "7px"
  lg: "8px"
  xl: "10px"
  panel: "12px"
  dialog: "14px"
  chip: "13px"
  badge: "11px"
  round: "50%"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  cell-x: "14px"
  lg: "16px"
  cell-y: "18px"
  inspector: "22px"
  page-top: "26px"
  page-x: "32px"
  section: "36px"
components:
  button:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
  button-hover:
    backgroundColor: "{colors.surface-3}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    height: "30px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
  button-sm:
    rounded: "{rounded.sm}"
    padding: "0 9px"
    height: "26px"
  button-lg:
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    height: "32px"
  seg:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.lg}"
    padding: "2px"
  seg-pressed:
    backgroundColor: "{colors.seg-on}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 9px"
    height: "26px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.chip}"
    padding: "0 10px"
    height: "26px"
  chip-pressed:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text}"
  stamp:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.badge}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "22px"
  count:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    typography: "{typography.mono-count}"
    padding: "0 5px"
    height: "18px"
  count-quiet:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text}"
  glyph-tile:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.lg}"
    size: "34px"
  art-cell:
    backgroundColor: "{colors.checker-b}"
    rounded: "{rounded.cell}"
  mini-cell:
    backgroundColor: "{colors.text}"
    rounded: "{rounded.hair}"
    size: "9px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "18px 20px"
  rows:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  nextcard:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "14px 16px"
    width: "400px"
  banner:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "12px 14px"
  banner-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
  banner-bad:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
  menu:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "6px"
  menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    height: "32px"
  dialog:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.dialog}"
    padding: "22px 24px 24px"
    width: "min(720px, 94vw)"
  topbar:
    backgroundColor: "{colors.surface}"
    padding: "0 12px 0 10px"
    height: "48px"
  tab:
    textColor: "{colors.text-muted}"
    padding: "0 11px"
  tab-current:
    textColor: "{colors.text}"
  inspector:
    backgroundColor: "{colors.surface}"
    padding: "18px 20px"
    width: "372px"
  decision:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.panel}"
    padding: "16px"
  take:
    rounded: "{rounded.md}"
    size: "64px"
  transport:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "8px 10px"
---

# Design System: Brainforge

## Overview

**Creative North Star: "The Sprite Sheet"**

The project is a sprite sheet you fill in. Every deliverable is a cell, and the cell's own art says whether it is done, waiting for you, empty or blocked. The chrome is graphite and paper in both themes so that the only saturated colour on screen is the artwork itself. Status is told by the *form* of a cell or mark (filled, ringed, dashed, locked, struck) before colour confirms it. One control per screen is filled with ink, and that control is the next thing to do.

Density is compact and desktop-first: 14px system type, 30px controls, cells tiled at full density with whitespace only between groups. Surfaces are flat panels edged by a hairline inset ring; there are no nested cards. Depth exists only for things that float (menus, dialogs, the frosted toolbar over the stage). Motion is limited to state changes, and the marching-ants marquee marks the cell you are on.

The world rejects the tracker default: asset/step sidebar trees, status-pill tables and one-step-per-page flows. Rank comes from apparatus (art thumbs, the ink button, a bigger row), not from louder type.

**Key Characteristics:**
- Graphite and paper neutrals; colour belongs to the artwork.
- Ink fill appears on one control per screen: the next action.
- State reads by form first: filled, ringed, dashed, locked, struck.
- Art sits on a transparency checker and is never cropped. Small sources scale with hard pixels.
- Hairline inset rings, flat panels, no nested cards.
- Motion only on state changes, at most 160ms. Live loops stop under reduced motion.

## Colors

The palette is near-neutral graphite with a faint cool cast in both themes, plus three status hues and two fixed over-art marks. Every theme-aware colour is a `light-dark()` pair resolved by `color-scheme`. The theme menu sets `data-theme="light|dark"` on the root, and "Match the system" leaves `color-scheme: light dark`.

### Primary
- **Ink** (`accent`, same value as `text`): the one filled control colour. It is the next-action button (`.primary`), the current-tab underline, count badges, note numbers and markers drawn on art, the selection highlight, and the default tag on an asset card. On dark it is near-white and on light near-black. `accent-text` is the label colour set on ink.
- **Ink Wash** (`accent-soft`): a 7–9% ink tint for the current or hovered row in Releases, the selected version on Versions and a selected family card. It is never used as a fill on a control.

### Secondary
- **Approved Green** (`ok`, `ok-soft`): the check mark on approved cells and "In the game" stamps, and the success notice in the room. The icon carries the colour and the text stays neutral.
- **Amber** (`warn`, `warn-soft`): notes that block approval, blocked cells, "out of date", the jobs-attention dot and warning banners. Amber text is used only on warn states.
- **Failure Red** (`danger`, `danger-soft`): failed jobs, failed cells, field errors and destructive buttons.

### Tertiary
- **Note Amber** (`note`, `note-text`): fixed in both themes because it is drawn over artwork. It is used for required-note markers, the loop range on the timeline, favourites in the candidate strip and attachment points outside the canvas.
- **Guide Pink** (`guide`): fixed in both themes. It draws the pivot, the baseline and attachment dots over art, and appears nowhere in chrome.

### Neutral
- **Paper / Graphite ground** (`bg`): the page behind everything, and the decision box inside the inspector.
- **Sheet** (`surface`): the top bar, panels, rows, inspector, menus and dialogs.
- **Raised tints** (`surface-2`, `surface-3`): default button fill and hover, glyph tiles, quiet chips and pressed chips. These tints are the only way a control shows hover.
- **Field** (`field`): input wells, slightly darker than the sheet on dark and pure white on light.
- **Pressed segment** (`seg-on`): the pressed segment, which is the one place a neutral lifts.
- **Hairlines** (`border`, `border-strong`; `border-control` is an alias of `border-strong`): inset rings, separators, empty-cell dashes and keycaps.
- **Text ramp** (`text`, `text-muted`, `text-faint`): primary text, secondary prose and labels, and meta, counts and placeholders.
- **Checkers** (`checker-a`/`checker-b` at 14px, `stage-a`/`stage-b` at 20px): the transparency grounds for cells and the review stage.
- **Judging backdrops** (`backdrop-light`, `backdrop-dark`): the Light and Dark stage backgrounds. They are deliberately independent of the theme so alpha can be judged on both.

### Named Rules
**The One Ink Rule.** Only the next action is filled with ink. Every other button is a neutral tint, a ghost or a link. If a screen has two ink buttons, one of them is wrong.

**The Chroma Belongs to the Art Rule.** Chrome carries no hue except the three status colours and the two over-art marks. A colour that does not mean approved, warning, failure, note or guide does not belong in chrome.

**The Fixed Backdrop Rule.** Marks drawn on artwork (`note`, `guide`) and the Light/Dark judging backdrops keep one value in both themes, because the art does not change with the theme.

## Typography

**Display Font:** none. There is no display tier.
**Body Font:** System UI (`-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`)
**Label/Mono Font:** System mono (`ui-monospace, "SF Mono", Menlo, monospace`) with tabular numerals

**Character:** Compact macOS-native type. Weight steps (400 / 560 / 600–660) carry hierarchy more than size does, and tight negative tracking applies only from 16px up.

### Hierarchy
- **Headline** (660, 24px, 1.15, -0.022em): page and asset titles (h1). This is the largest type in the product.
- **Title** (650, 17px, 1.3, -0.012em): dialog titles and empty-state headings.
- **Section** (640, 16px, 1.3, -0.01em): section heads (Up next, Assets, Export), the room-head deliverable name, and the lead Up next row.
- **Heading** (620, 13px, 1.35): sub-heads. Inside the inspector they are set in `text-faint` ("What was asked").
- **Body** (400, 14px, 1.5): running text and notes. Ledes cap at 70ch and empty-state bodies at 62ch.
- **Body Compact** (400, 13px, 1.5): rows, tables, menus, banners and inputs.
- **Control** (560, 13px, 1.2): buttons and tabs. The ink button steps to 600, and `sm` controls drop to 12.5px.
- **Label** (600, 12.5px): form labels and legends. `.secondary` meta uses 12.5px at 400 in `text-muted`.
- **Caption** (400, 12px): hints, timestamps and the sub-lines of rows.
- **Badge** (640, 11.5px): stamps, tags and inline chips.
- **Mono** (12px, tabular): frame readouts, cell sizes (`256 × 256`), group counts (`2 of 4 approved`), paths, IDs, hashes and the YAML editor (12.5px / 1.6).
- **Mono Count** (550–650, 11px): numbers inside count badges, chip counts and frame indices on strips.

### Named Rules
**The Weight Not Size Rule.** Rank inside a screen comes from weight and apparatus. Nothing outside the h1 exceeds 17px.

**The Mono Is for Measures Rule.** Mono marks things you count or copy: frames, sizes, counts, paths and IDs. Prose and labels are never set in mono.

## Layout

**Shell.** The shell is a 48px top bar over a scrolling main area. Ordinary pages are one column at max 1520px (920px for narrow pages such as New asset), padded 26px 32px 64px. Rooms fill the viewport under the top bar and manage their own scroll.

**Rhythm.** The base unit is 4px. Group gaps run 8–14px, sections are separated by 36px, and the page header sits 24px above content. Cells tile at 18px vertical and 14px horizontal: dense inside a group, with whitespace only between groups.

**Screen map (IA).**
- **Top bar**: project menu (sheet mark, name, chevron), then tabs **Home · Review (count) · Releases**. At the end: jobs-attention status (dot + text, linking to Activity), live-connection status (shown only when unhealthy), Jump (⌘K palette), theme menu and Settings.
- **Home** (`/`): title with a mini-sheet progress line, then **Up next** ranked rows (the lead row has art thumbs and the screen's one ink button), then the **Assets** art grid with filter chips (All / Needs you / In progress / In the game).
- **Asset** (`/assets/:id`): crumbs, title, meta, branch button, mini-sheet line and subtabs **Sheet · Definition · Versions** on the left; the **Next for <asset>** card on the right. On Sheet, the locked concept and references stay sticky in a 296px column, with grouped deliverable cells on the right.
- **Room** (`/assets/:id/steps/:step`): room head (Back to the asset, location crumb, deliverable name, Compare or queue nav). The stage column has an overlay toolbar, a transport and a candidate strip. The 372px inspector holds What was asked, Decision and Notes, with Details · Processing · History tabs pinned at its foot. Empty cells host generation on the stage. **Review** (`/review`) is the same room in queue mode with J/K next and previous.
- **Releases** (`/releases`): Export panel and past exports, then asset rows with one action each. **Versions** (asset subtab) shows the four-step key, version rows and the promote aside.
- **Activity** (`/activity`): Needs attention / Running / Recent job rows with a 400px sticky detail at ≥1100px, plus Decisions and Preferences.
- **Settings** (`/settings`, subtabs Project · Connection · Direction · Agent): flat sections on hairlines, max 880px.
- **New asset** (`/assets/new`) and **Open project** (`/projects/open`): narrow single-column pages.

**Responsive (as shipped).**
- **≤1240px**: room inspector narrows to 316px.
- **≤1100px**: Jump collapses to its icon; page padding drops to 22px; the asset head stacks so the Next card goes full width under the title; the sheet side column narrows to 200–240px; release, processing and definition splits go single-column. Activity shows its side detail only at ≥1100px.
- **≤1024px**: Up next rows narrow their art column to 96px, with 28px thumbs.
- **≤900px**: the sheet becomes one column, with concept and references as a row of 120–150px cells so deliverables still start in the first viewport. The room inspector stacks under a 420–700px stage, with its tabs sticky at the bottom. The release key moves to two columns.
- **≤800px**: sheet cells shrink to a 120px minimum; animation strips go one per row; the Next card line wraps.
- **≤760px**: the top bar tightens (6px padding, project name capped at 34vw, activity label hidden); page padding becomes 18px 16px. In Up next rows the action drops under the text. The room head wraps, the transport puts the frame stepper on its own row, decision buttons stack, and job and release rows reflow.
- **≤700px**: version rows stack.
- **Coarse pointer**: `--control-h` becomes 40px.

### Named Rules
**The Full Density Rule.** Cells tile edge to edge at the grid gap, and whitespace separates groups, never cells.

**The Selection Follows You Rule.** Going Back from a room lands on the same cell with the marquee on it. Queue next and previous keep branch and output context. Live updates never move the control under the pointer.

## Elevation & Depth

The system is flat and tonal. Panels, rows, cells, banners and fields are edged with an inset hairline ring (`box-shadow: inset 0 0 0 1px var(--border)`) instead of a border, so the ring never changes layout. Real `border` is kept for dashed empty states and 1px separators. Depth appears only on things that float above the page or above the art.

### Shadow Vocabulary
- **Hairline ring** (`inset 0 0 0 1px var(--border)`; `--border-strong` for fields and stamps): every resting surface edge.
- **Pop** (`--shadow-pop: 0 18px 48px -12px rgb(0 0 0 / 0.45), 0 2px 6px rgb(0 0 0 / 0.18)`): menus, dialogs and the command palette, always paired with the hairline ring.
- **Segment lift** (`0 1px 2px rgb(0 0 0 / 0.22)`): the pressed segment only.
- **Over-art float** (`inset 0 0 0 1px var(--border), 0 4px 14px -6px rgb(0 0 0 / 0.4)` on `color-mix(surface 86%)` with `backdrop-filter: blur(10px)`): stage toolbar, stage extras and the compare bar, so controls stay legible over any artwork.
- **Marker lift** (`0 0 0 2px var(--accent-text), 0 4px 10px rgb(0 0 0 / 0.35)`): note markers pinned on art.
- **Scrim** (`rgb(0 0 0 / 0.5)` with `blur(2px)`): the dialog overlay.

### Named Rules
**The Ring Not Border Rule.** Resting surfaces get an inset 1px ring. A solid border means a separator, and a dashed border means "nothing here yet".

**The Only Floats Lift Rule.** Shadows belong to menus, dialogs and controls over art. A panel on the page never lifts.

## Shapes

Corners are soft, small, and scale with the size of the object. Mini-sheet cells use 2px; strip frames 3px; keycaps 4px; sheet cells 5px; art, stamps and small buttons 6px; controls 7px (`--radius`); segment tracks, glyph tiles and asset-card art 8px; banners, menus, stages and the transport 10px; panels, rows, the Next card and the decision box 12px (`--radius-lg`); dialogs 14px. Chips, tags and counts are pills with radius equal to half their height (13/11/9px). Dots, the play button and note pins are round.

The brand mark is the sheet glyph: a 2×2 grid of cells drawn outlined, filled, filled and dashed. It encodes the state vocabulary in four squares.

**State by form** (the vocabulary every surface reuses):
- **Filled**: done or approved. A solid mini-sheet cell, or a cell showing its art with a green check underneath.
- **Ringed**: waiting for you. A 1.5px ink ring on the mini cell or state mark, or a 2px ink ring around the current candidate.
- **Dashed**: empty or to make. A 1px dashed `border-strong` cell or strip frame, and a 1.5px dashed generation cell. Quiet empty cells use `border`.
- **Locked**: blocked by a dependency, shown as a lock glyph in a dashed cell (amber when blocked by a decision). A final fact gets a **stamp**: outlined, never filled ("Locked · Candidate 8", "Current", "v2").
- **Struck**: rejected or cancelled. The take stays in the strip, greyscaled at 38% with a 1.5px diagonal strike. Nothing disappears.
- **Marquee**: the cell you are on. Marching ants (8px dashes, 1.5px, `text`) drawn over the cell edge.

### Named Rules
**The Form Before Colour Rule.** Each state must remain readable in greyscale. Colour confirms a state, it never carries it alone. Status is always an icon plus text.

**The Nothing Disappears Rule.** Rejected work is struck, not removed, and history is kept.

## Components

### Buttons
Quiet tints with one ink exception.
- **Shape:** 7px controls at 30px tall (40px on coarse pointers), padding 0 12px, 13px at weight 560, with a 7px gap for icons.
- **Default:** `surface-2` fill with a hairline ring. Hover goes to `surface-3`, and active adds an inset `border-strong` ring.
- **Primary (ink):** `accent` fill, `accent-text` label, weight 600, no ring. Hover mixes 86% ink into `bg`. One per screen, on the next action ("Start reviewing →", "Approve", "Lock this concept…").
- **Ghost:** transparent and `text-muted`; hover gives a `surface-2` tint. Used for Cancel, the room's Back, and the More tabs.
- **Danger:** transparent, `danger` text and a 35% danger ring; hover fills with `danger-soft`. Danger primary fills with `danger`.
- **Link:** underlined text with a `border-strong` underline at a 3px offset.
- **Sizes:** `sm` is 26px, 0 9px, 12.5px, 6px corners. `lg` is 36px, 0 16px, 13.5px, 8px corners. Icon buttons are square at control height.
- **Disabled:** 45% opacity with a not-allowed cursor.

### Segmented controls
- **Track:** `surface-2` with a hairline ring, 2px inner padding, 8px corners.
- **Segments:** 26px, 0 9px, 12.5px at 540, `text-muted`. The pressed segment fills with `seg-on`, uses `text`, and gets the segment lift. Used for the room toolbar (output, backdrop, zoom), viewer tools and compare modes.

### Chips, stamps, counts, glyph tiles
- **Filter chip:** 26px pill, transparent and `text-muted`. Hover tints `surface-2`, pressed uses `surface-3` with `text`, and the count sits in Mono Count `text-faint`.
- **Fact chip:** 22px pill on `surface-2`, 11.5px. In mono it holds code-like facts.
- **Stamp:** 22px outlined (`border-strong` ring), 6px corners, 11.5px at 640, with an optional 13px icon. Used for final facts.
- **Count:** an 18px ink pill in Mono Count, on the Review tab, on cells waiting for you and on the Needs attention section. The quiet count uses `surface-3`.
- **Glyph tile:** a 34px (44px in job rows) `surface-2` tile with a muted icon, standing in for art when a row is about a job or a file. Variants tint to `warn-soft`, `danger-soft` or `ok-soft`.
- **Mini-sheet:** one 9px cell per required deliverable (12px when large) with a 2px gap: filled `text` = done, 1.5px ink ring = waiting, amber ring on `warn-soft` = blocked, red ring on `danger-soft` = failed, `border-strong` hairline = to do. It sits beside every progress line.

### Art cells and strips (signature)
- **Art cell:** a 14px transparency checker with a hairline ring and 6px corners (5px in the sheet, 8px on asset cards). The image is `object-fit: contain` with about 7% padding, never cropped. Sources of 128px or less render `image-rendering: pixelated` and get more padding on asset cards (34px). The room canvas also switches to pixelated above 1×.
- **Sheet cell:** square art (2:1 when wide), with the name (13px at 580, optional in `text-faint`) and a state line (12px, icon plus text; `you` in `text` 600). A count badge sits top-right, and a round amber note pin bottom-right (`warn` on `bg`). Two waiting candidates show as an offset pair, the back one at 55%.
- **Strip:** four checker frames in a ringed tray (2px gap, 3px frame corners) with mono frame indices. An empty strip shows four dashed frames, the first holding the glyph.
- **Concept card:** sticky at the sheet's side, with an 8px-corner square of art and the Locked stamp beside the name.
- **Asset card:** 4:3 art with 8px corners. A pill tag sits on the art's top edge: ink by default, warn-tinted or danger-tinted (with blur) for problems. A failed-jobs tag is amber when every failure can be collected again and red otherwise, matching its Up next row. The hover ring steps to `border-strong`. Name 14px at 620, family in `text-faint`, then a state line with the mini-sheet.

### Rows and the Next card
- **Rows:** one `surface` with a 12px ring and 1px `border` separators, so rows are never cards inside a card. Up next rows use a 148px art column, 14px 18px padding and 20px gaps. The lead row gets 20px block padding, 54px thumbs and a 16px title. Other rows use 34px thumbs or a glyph tile, and each row has one action on the right.
- **Next card:** a 400px panel in the asset head with one line (14px at 600 plus the ink action) and a 12.5px muted reason beneath.
- **Panel:** `surface`, 12px corners, 18px 20px padding. A panel inside a panel becomes a hairline-topped band, not a second card.

### Room: stage, transport, candidate strip, inspector
- **Stage:** 10px corners on `stage-b` with a 20px checker, or the fixed Light/Dark backdrop. The over-art toolbar floats 10px inside the edges. Notes draw in ink (rectangles 2px, 3.5px when selected, dashed while drafting) or in `note` when required, with 24px numbered markers. Cell size is shown in mono above a dashed 4/3 guide.
- **Transport:** a ringed `surface` bar with 10px corners: play, mono readout (`Frame 01 / 32`), stepper, and a tick timeline (surface-3 ticks, 55% ink when on, `note` loop range, ink 2px playhead), plus loop, speed and fps.
- **Candidate strip:** 64px takes with 7px corners. Current = 2px ink ring. Add and running = dashed. Rejected = struck. Favourite = `note` star, top-left.
- **Inspector:** a 372px `surface` column with a hairline left edge and a 22px-gap scroll. The **Decision box** is a `bg` well with 12px corners and 16px padding: the state mark (ringed idle or a status icon) and status, a target line, a two-up action grid (ink Approve or Lock beside Reject…), the ghost Ask for a revision, and a faint 12px hint. **Notes** are numbered ink circles (amber `note` when required), separated by hairlines. Keyboard hints use keycaps. Details · Processing · History are ghost tabs on a hairline at the foot.

### Top bar and navigation
- **Top bar:** 48px `surface` with a bottom hairline and 20px gaps. The project menu shows the 20px sheet mark and a 14px/640 name.
- **Tabs:** 13px at 560 in `text-muted`. The current tab uses `text` with a 2px ink underline, inset 11px and sitting on the bar's hairline.
- **Subtabs:** 28px with 7px corners, `text-muted`. Hover is `surface-2` and current is `surface-3` (Sheet · Definition · Versions; settings sections).
- **Jump:** a 168px `surface-2` field-button with a ⌘K keycap. The palette is a 620px dialog at 14vh with a 48px search and 34px glyph rows.
- **Activity status:** a 7px dot (amber for attention, an ink pulse while running) with 12.5px text.

### Inputs / Fields
- **Style:** `field` well with a `border-strong` inset ring, 7px corners, 32px tall, 6px 10px padding, 13px. Selects carry a 16px chevron.
- **Hover / Focus:** hover raises the ring to 32% `text`, and focus sets a 1.5px `text` inset ring with no outline. Checkboxes, radios and ranges take `accent-color: ink`.
- **Labels and errors:** labels are 12.5px at 600 with a 5px gap, hints 12px faint, and errors 12.5px at 600 in `danger`.

### Menus, dialogs, banners
- **Menu:** `surface` with 10px corners and 6px padding, min 220px, hairline plus pop. Items are 32px with 6px corners and 13px text, tinted `surface-2` on hover. Group labels are 11.5px faint, separators hairlines, and checked items 620.
- **Dialog:** `surface` with 14px corners, `min(720px, 94vw)` (wide variant 1040px), 22px 24px 24px padding, a 17px title, a 13px muted description, and right-aligned actions with the ink button last.
- **Banner:** an 18px icon column beside the body, 10px corners and 12px 14px padding, on `surface` with a hairline. Warn and bad tint to `*-soft` with a 28% hue ring and a coloured title. Ok and info colour only the icon.
- **Empty state:** a 1px dashed `border-strong` region with 12px corners and 36px 32px padding. The body caps at 62ch and the action sits under it.

### Motion
- State transitions only: background, colour and shadow at 120ms; menus pop in 120ms, the overlay fades in 140ms, and dialogs pop in 160ms on `cubic-bezier(0.2, 0.7, 0.2, 1)` (rising 4px from 98% scale). A disclosure chevron rotates in 120ms.
- Continuous loops exist only for live state: the marquee (0.8s linear), the running-job dot (1.6s pulse) and a running take (1.4s pulse).
- `prefers-reduced-motion: reduce` removes all animation and transition, so the marquee holds still.

## Do's and Don'ts

### Do:
- **Do** fill exactly one control per screen with ink (`accent`), and make it the next action.
- **Do** show state by form first (filled, ringed, dashed, locked, struck, marquee), then confirm with `ok`, `warn` or `danger`, and always put an icon beside the text.
- **Do** put every output on a checker, contained and never cropped, with `image-rendering: pixelated` for sources of 128px or less.
- **Do** edge resting surfaces with `inset 0 0 0 1px var(--border)` and separate rows with 1px hairlines inside one surface.
- **Do** use mono for frames, sizes, counts, paths and IDs, with tabular numerals.
- **Do** keep transitions at or under 160ms and let `prefers-reduced-motion` stop every loop.
- **Do** keep `note`, `guide` and the Light/Dark backdrops theme-independent.

### Don't:
- **Don't** fill a second control with ink. Ink markers (counts, note numbers, tags) are allowed because they are not controls; secondary actions use the neutral tint, ghost or link.
- **Don't** add hue to chrome beyond the three status colours and the two over-art marks.
- **Don't** nest a card inside a card. Inner groups become a tinted inset (`surface-2`) or a hairline-topped band.
- **Don't** remove rejected or superseded work. Strike it and keep it.
- **Don't** use asset/step sidebar trees, status-pill tables or one step per page.
- **Don't** mark a current row with a coloured side stripe. Use the ink wash or a ring.
- **Don't** set type above 17px outside the page headline, and don't use a display face.
