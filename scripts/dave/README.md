# libdave pipeline

Discord voice calls use DAVE end-to-end encryption, implemented by libdave (MLS plus frame
encryption). The Discord web client loads a private build of libdave as an emscripten module plus a
wasm file. These scripts take that build out of Discord's public web assets, turn it into a
standalone ES module, test it, and keep the last good copy where the hub can serve it to the PWA.

**The output contains Discord's code. Never commit it, and never copy it into this repository.**
Everything in this directory is our own code; it only stores names, hashes and anchor strings.

## What it fetches

It makes anonymous GET requests only (no login, cookies or token):
- `https://discord.com/app`, for the build number and the list of initial scripts;
- `https://discord.com/assets/<name>`, for those scripts, the DAVE lazy chunks and the `.wasm`.

Assets are cached by file name. Names contain a content hash, so each file is downloaded once.
Downloaded code is never executed by the extractor. The smoke test runs only the extracted libdave
module and wasm.

## Files

| file | purpose |
|---|---|
| `extract.ts` | find the glue and wasm by stable anchors (the `DaveModuleFactory` export, emscripten strings, the wasm URL module chain), never by module ids or file names; write `libdave.mjs`, `libdave.wasm` and `manifest.json` |
| `smoke.ts` | load `libdave.mjs` via `loadDave()` and drive a full DAVE flow locally, with the test playing the voice server's MLS external sender; write `smoke.json` |
| `fingerprint.ts` | record what our own voice implementation copies by observation: voice gateway opcodes and keys, SDP rules, and the in-page bridge anchors (store names, Flux actions, the dispatcher interceptor) |
| `update.ts` | the one command to run: fetch, extract, fingerprint, smoke test in a clean subprocess, then promote |
| `browser-check.ts` | load a promoted module in headless Chromium from a `data:` URL module worker, cross-origin |

## Running

```sh
bun scripts/dave/update.ts --root ~/.local/share/dither-chat/dave          # what the hub or a timer runs
bun scripts/dave/extract.ts --fetch --cache /tmp/dave-cache --out /tmp/dave # extraction only
bun scripts/dave/extract.ts --assets DIR --out /tmp/dave                    # from downloaded assets
bun scripts/dave/smoke.ts /tmp/dave
bun scripts/dave/browser-check.ts /tmp/dave
bun scripts/dave/fingerprint.ts --assets DIR [--previous fingerprint.json]
```

## Layout under `--root`

- `cache/`: downloaded assets. Files not used for 30 days are pruned.
- `<id>/`: one promoted copy, holding `libdave.mjs`, `libdave.wasm`, `manifest.json` and
  `smoke.json`. `<id>` is the first 16 hex characters of the wasm's sha256. `update.ts` keeps the
  current, the previous and the newest others, up to `--keep` (default 3).
- `current.json`: replaced atomically, and only after a smoke test passes. Fields:
  - `dir`, `build`, `versionHash`, `wasmSha256`, `moduleSha256`, `maxProtocolVersion`;
  - `promotedAt`, `checkedAt`, `lastCheckedBuild`, `previousDir`;
  - `fingerprint` (`additive`, `breaking` and `missing` since the previous run) and `warnings`.
- `fingerprint.json`: the last run's fingerprint, used for the next diff.
- `last-failure.json` and `last-failed/`: written when a run fails. `current.json` is then left untouched.

When the wasm and module are unchanged, a run only refreshes `checkedAt`, the fingerprint report
and the warnings. Breaking fingerprint changes are printed to stderr and listed in `warnings`.
They do not block promoting libdave; they mean the notes our voice code was written from need
re-checking.

## Using the module

`libdave.mjs` has no static imports. It loads the wasm from `new URL('./libdave.wasm', import.meta.url)`
with `credentials: 'omit'`, so it works from a cross-origin or opaque-origin worker when the server
sends `Access-Control-Allow-Origin: *`.

```js
const { loadDave } = await import(`${hub}/dave/${id}/libdave.mjs`);
const dave = await loadDave(); // log severity set to warnings
```

## Exit codes

| code | `update.ts` | `extract.ts` | `smoke.ts` / `browser-check.ts` |
|---|---|---|---|
| 0 | promoted or unchanged | ok | all steps passed |
| 1 | failure (network, smoke test, I/O) | error | a step failed |
| 2 | an extraction anchor was not found (Discord changed the bundle) | anchor not found | – |
| 3 | another run holds `--root/.lock` | – | – |
