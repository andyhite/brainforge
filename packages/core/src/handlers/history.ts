import { discoverAuthored } from "../authored.ts";
import { historyExamples } from "../history/examples.ts";
import { judgmentSummary } from "../history/judgments.ts";
import type { HandlerMap } from "../runtime.ts";

export const historyHandlers: HandlerMap = {
  "history.examples": async ({ input, project: open }) => {
    return { data: await historyExamples(open, await discoverAuthored(open.root), input) };
  },

  "history.judgments": async ({ input, project: open }) => {
    return { data: { summary: judgmentSummary(open, await discoverAuthored(open.root), input) } };
  },
};
