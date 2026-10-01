#!/usr/bin/env bun
import { run } from "./cli.ts";

const exitCode = await run(process.argv.slice(2), process.env, {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  readStdin: () => Bun.stdin.text(),
});
process.exitCode = exitCode;
