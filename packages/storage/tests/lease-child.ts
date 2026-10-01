import { acquireProjectLease } from "../src/lease.ts";

// argv: <root> hold|try — "hold" keeps the lease until killed; "try" reports the outcome and exits.
const [root, mode] = process.argv.slice(2);
try {
  acquireProjectLease(root ?? "");
  console.log("acquired");
  if (mode === "hold") await new Promise(() => {});
} catch (e) {
  console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
}
