# mend — one patch tool for every AI edit format, 100/100 practice checks

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sage-otter-44/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sage-otter-44/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats,
and `mend` reads all four to one written specification (`SPEC.md` in the kit): a unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
It finds the lines an edit names even when the model drifted their whitespace or indentation, and it
changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file; when absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`; `auto` (the default)
  detects it.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22 and its standard library alone — no installs, no network, no dependencies.

## What it does, format by format

- **Unified diffs** — sections from `diff --git` or bare `---`/`+++` pairs; creates, deletes and renames
  (reported as `R old -> new`); hunks apply in order with a running offset, each taking the occurrence
  nearest its (usually wrong) line number; empty hunks insert; `\ No newline at end of file` is honoured.
- **SEARCH/REPLACE** — blocks with a path line (fenced, with prose around them); empty old text creates
  the file; otherwise the old text must occur exactly once or the block fails `ambiguous`.
- **V4A** — `*** Add/Delete/Update File` sections, `*** Move to:`, `@@` anchors and `*** End of File`
  chunks applied in order behind a moving cursor.
- **JSON** — one JSON array of edit objects, or JSON Lines; `create` (byte for byte), `str_replace`
  (exact, once, CRLF-aware) and `insert` (by line number).

## Matching: three tiers, deterministic

An edit's old lines are found at the first tier where they occur at least once: tier 0 exact, tier 1
trailing whitespace ignored, tier 2 leading and trailing whitespace ignored. At tier 2 the new lines
are re-indented to the file's own indentation. Context lines are always written as the file's own
matched lines, never the patch's. The same check gives the same exit code, stdout and files every run.

## Safety and atomicity

- Every path an edit names is checked for safety before anything else about it (`unsafe` for absolute,
  backslash, empty, `.` or `..` segments).
- A failed edit changes nothing, and the edits after it still run, so every failure is reported
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`); when any edit failed, no file is written.
- Exit 0 lists every changed path (`A`/`D`/`M`/`R`, byte order) and `ok: <n> files`; exit 1 lists
  every failure and `failed: <k> of <n> edits`; exit 2 is a usage, no-patch, format or parse error.

## Files

- `main.ts` — the whole tool. `SPEC.md` is the contract; the 100 public practice checks pass
  (`node check.ts ../program/generator/practice.json` → `100 of 100 passed: practice score 1000`),
  plus 53 own edge checks (whitespace/indentation drift, wrong line numbers, all-or-nothing,
  `--check`, `--strict`, usage errors, CRLF, unsafe paths, ambiguous/missing/exists, moves, EOF chunks).
- `runner.ts` — the kit's trial runner, kept as it is; `main.ts` hands a trial over to it when
  `MAKEFUN_ENV_URL` is set.
- `LICENSE` — MIT (`SPDX-License-Identifier: MIT`).
