/** Shared by the godot-verify scripts: Godot binary lookup (exits 0 with SKIP when missing), PASS/FAIL reporting, headless runner. */
import { access } from "node:fs/promises";

export const GODOT = process.env.GODOT_BIN ?? "/Applications/Godot.app/Contents/MacOS/Godot";
export const keep = process.argv.includes("--keep");
export const RES = "res://assets/brainforge";

if (!(await access(GODOT).then(() => true, () => false))) {
  console.log(`SKIP: Godot not found at ${GODOT} (set GODOT_BIN); resource-open verification was not run.`);
  process.exit(0);
}

export let failures = 0;

export const check = (ok: boolean, what: string, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};

export async function godot(project: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([GODOT, "--headless", "--path", project, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 120_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  return `${out}${err}`;
}

// Headless --script runs print engine shutdown leak diagnostics for any scene/texture a script touched; those are not resource errors.
const SHUTDOWN_NOISE = /leaked at exit|still in use at exit/;
export const errorLines = (text: string): string[] => text.split("\n").filter((l) => /(^|\s)(ERROR|SCRIPT ERROR|Parse Error|BF_ERROR)/.test(l) && !SHUTDOWN_NOISE.test(l));
