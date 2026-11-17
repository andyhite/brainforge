# Brainforge

A ground-up rebuild is in progress. No code exists yet.

- `PRODUCT.md` is the product definition. Read it before proposing or building anything, and keep its decisions log current.
- Language: TypeScript on Bun (version in `.bun-version`). Local tools such as Blender or Python model tools run as subprocesses.
- Issues live in the Kata project `brainforge` (`.kata.toml`).
- `.roundhouse.json` still names the previous check command. It fails until the first package exists; update it when that lands.
- Web UI changes: verify in Tern's browser block (`tern browser`), with a screenshot under `.evidence/<issue>/`.
