import { PROFILES, familyTemplate } from "../families/index.ts";
import type { HandlerMap } from "../runtime.ts";

export const familyHandlers: HandlerMap = {
  "family.list": async () => ({ data: { families: PROFILES } }),

  "family.template": async ({ input }) => {
    const t = familyTemplate(input.family, input.id, input.name, input.description);
    return { data: t, nextActions: [{ label: "Write the starter file", operation: "spec.write", input: { path: t.path, text: t.text, expectedHash: null } }] };
  },
};
