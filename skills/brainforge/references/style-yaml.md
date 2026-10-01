# `brainforge/styles/<style-id>.yaml`

Human-readable companion to `spec_schema {kind:"style"}`; `spec_schema` wins on conflict.

Schema `brainforge.style.v2`. `.strict()`. The `id` MUST equal the file name without `.yaml`. A style is referenced from project or asset `styleIds`. Styles are ordered named visual constraints; two styles disagreeing on a concrete value are reported as conflicts, not merged.

|Field|Req|Type / default|
|---|---|---|
|`schema`|yes|literal `brainforge.style.v2`|
|`id`|yes|kebab-case, equals file name|
|`description`|no|string, `""`. Documentation only: NEVER sent to the model|
|`palette`|no|string[] (ordered, one per entry), `[]`. EVERY entry is SENT to the model: one visual phrase each (colour, line, rendering), positive wording only. Entries are joined with ", "; if any entry contains a comma the entries are joined with "; " instead, so a comma inside an entry stays inside one phrase|
|`references`|no|string[] imported reference ids, `[]`|
|`preferences`|no|string[] confirmed preference ids, `[]`; humans confirm, agents do not invent|

Keep URLs, secrets and absolute paths out anyway. Palette entries follow SKILL.md "Writing prompt-bearing YAML": no negations ("no surface texture"), no labels or doc references.

## Minimal valid

```yaml style
schema: brainforge.style.v2
id: flat-pixel
```

## Real example (cranium)

```yaml style
schema: brainforge.style.v2
id: cranium
description: >-
  Documentation only, not sent to the model. Shared visual language for Cranium characters
  and places, from docs/03-art-direction.md section 2. Entries are ordered by importance.
palette:
  - dark warm brown-black contours, heavier on the outer silhouette and thinner on interior fold lines
  - broad flat colour areas with limited cel shading and one broad shadow tone per colour area
  - a small set of large deliberate brain folds in coral pink
  - clean readable silhouette with clear hands and feet and smooth clean fills
  - single flat plain light-grey backdrop
references: []
preferences: []
```

## Common mistakes

|Mistake|Message|
|---|---|
|`palette: red` (string)|`palette: Invalid input: expected array, received string`|
|`id` differs from file name|`id "x" must equal the file name "y"`|
|non-kebab file name|`"My_Style" is not a lowercase kebab-case id`|
|unknown key|`Unrecognized key "colors"`|
|wrong `schema` literal|`schema: Invalid input: expected "brainforge.style.v2"`|
