#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type McpOptions } from "./server.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { project: { type: "string" }, cwd: { type: "string" } },
});

const options: McpOptions = { cwd: values.cwd !== undefined ? resolve(values.cwd) : process.cwd() };
if (values.project !== undefined) options.project = resolve(values.project);
const serverUrl = process.env.BF_SERVER_URL?.trim();
if (serverUrl) options.serverUrl = serverUrl;

await createServer(options).connect(new StdioServerTransport());
