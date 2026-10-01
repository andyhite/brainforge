import type { HandlerMap } from "../runtime.ts";
import { catalogHandlers } from "./catalog.ts";
import { branchHandlers } from "./branches.ts";
import { cleanupHandlers } from "./cleanup.ts";
import { completenessHandlers, impactHandlers } from "./completeness.ts";
import { exportHandlers } from "./export.ts";
import { historyHandlers } from "./history.ts";
import { decisionHandlers } from "./decisions.ts";
import { familyHandlers } from "./families.ts";
import { generationHandlers } from "./generation.ts";
import { pipelineHandlers } from "./pipeline.ts";
import { lifecycleHandlers } from "./project.ts";
import { preferenceHandlers } from "./preferences.ts";
import { processingHandlers } from "./processing.ts";
import { productionHandlers } from "./production.ts";
import { reviewHandlers } from "./review.ts";
import { specDocHandlers } from "./spec-docs.ts";
import { specHandlers } from "./specs.ts";

/** Handlers for project lifecycle, authored files, settings, policy, references, workflows and assets. */
export const projectHandlers: HandlerMap = { ...lifecycleHandlers, ...specHandlers, ...specDocHandlers, ...catalogHandlers, ...reviewHandlers, ...pipelineHandlers, ...branchHandlers, ...decisionHandlers, ...generationHandlers, ...cleanupHandlers, ...processingHandlers, ...historyHandlers, ...preferenceHandlers, ...productionHandlers, ...exportHandlers, ...familyHandlers, ...completenessHandlers, ...impactHandlers };
