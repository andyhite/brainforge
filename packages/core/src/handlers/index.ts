import type { HandlerMap } from "../runtime.ts";
import { catalogHandlers } from "./catalog.ts";
import { generationHandlers } from "./generation.ts";
import { lifecycleHandlers } from "./project.ts";
import { reviewHandlers } from "./review.ts";
import { specDocHandlers } from "./spec-docs.ts";
import { specHandlers } from "./specs.ts";

/** Handlers for project lifecycle, authored files, settings, policy, references, workflows and assets. */
export const projectHandlers: HandlerMap = { ...lifecycleHandlers, ...specHandlers, ...specDocHandlers, ...catalogHandlers, ...reviewHandlers, ...generationHandlers };
