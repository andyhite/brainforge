---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/components/Layout.tsx","src/styles.css","src/features"]
---

# Brainforge web workbench

Mode: Operate. Scope: every apps/web route. Audience: a solo indie 2D game developer on a macOS desktop, getting good assets into their game, not operating Brainforge's machinery. Approved 2026-10-01 after the user's feedback on the previous redesign (confusing IA, amateur visuals, cluttered screens, unclear next action), which this replaces.

Structure (approved): three tabs, Home · Review · Releases; activity status and settings in the top bar; ⌘K jumps to any asset or deliverable. Home answers "what next, how close is the game". The asset sheet answers "what does this asset still need" (Sheet · Definition · Versions). One room per deliverable answers "is this candidate right" and hosts generation for empty cells; the Review tab is that room in queue mode. Releases keeps promote, activate and export separate. Activity holds jobs, decision history and preferences. Product gates, budgets, exact-output approvals, branch context and draft persistence stay binding.

## Direction contract

**THESIS:** Sprite Sheet: the project is a sprite sheet you fill in; every deliverable is a cell whose art shows done, waiting, empty or blocked. Refuses the tracker default: asset/step sidebar trees, status-pill tables, one step per page.

**OWN-WORLD:** Graphite and paper neutrals in both themes; ink (near-white on dark, near-black on light) is the only filled control colour and marks only the next action. Chroma belongs to the artwork; amber for notes and blockers, green check for approved, red for failure. Cells sit on a transparency checker; empty cells dashed; blocked cells hold a lock; count badges; marching-ants selection; a cell-per-deliverable mini-sheet glyph for progress. System type, compact; mono only for frames and counts. Hairline insets, 7px corners, no nested cards.

**STORY:** You see what needs you, judge the art at true pixels, approve exact outputs, and move versions into the game through separate promote, activate and export steps.

**FIRST VIEWPORT:** Home: project title with mini-sheet progress line; ranked "Up next" list whose lead item carries art thumbs and the screen's only filled button; asset art grid below. Asset sheet: title, branch menu and tabs left, "Next for <asset>" card right; locked concept sticky at left, grouped cell grid right. Room: stage left with toolbar overlay, transport and candidate strip; 372px inspector right: what was asked, decision, notes; Details, Processing and History behind tabs.

**FORM:** Sprite Sheet, position 5 of 7 on the ordered list; seed key f4b57796. Raises kept from declined challengers: nothing is labelled twice; state reads by form before colour; nothing disappears, it cancels (rejected candidates stay, struck); only the next action in full ink; rank by apparatus, not size; cells tile at full density, whitespace separates groups only.

**SIGNATURE:** Selection follows you: Back from a room lands on the same cell with the marquee on it; queue next/previous keeps branch and output context; live updates never move the control under the pointer. Motion is state-only, at most 160ms; the marquee holds still under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
