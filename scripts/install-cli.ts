/** Installs `~/.local/bin/brainforge`, a wrapper that runs this checkout's CLI with the current Bun binary. */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const dir = join(homedir(), ".local", "bin");
const target = join(dir, "brainforge");
const main = resolve(import.meta.dir, "..", "apps", "cli", "src", "main.ts");

mkdirSync(dir, { recursive: true });
writeFileSync(target, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(main)} "$@"\n`);
chmodSync(target, 0o755);
console.log(`Installed ${target} -> ${main}`);
if (!process.env.PATH?.split(delimiter).includes(dir)) console.warn(`${dir} is not on your PATH; add it to run \`brainforge\`.`);
