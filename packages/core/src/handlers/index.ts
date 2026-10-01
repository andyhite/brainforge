import type { HandlerMap } from "../runtime.ts";
import { catalogHandlers } from "./catalog.ts";
import { lifecycleHandlers } from "./project.ts";
import { specHandlers } from "./specs.ts";

/** Handlers for project lifecycle, authored files, settings, policy, references, workflows and assets. */
export const projectHandlers: HandlerMap = { ...lifecycleHandlers, ...specHandlers, ...catalogHandlers };
