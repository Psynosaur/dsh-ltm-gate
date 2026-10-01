# Changelog

## 2026-09-29 — Budgeted recall gate (unreleased; package.json still 0.1.0)

### Added

- `prompt: "slim"` — the short WORKING RULES render always, the SESSION START bootstrap only while the gate is
  closed (`full` keeps the old always-on layout, `gate` the old hide-when-satisfied one, `off` disables).
- `recallArgs` — args merged into the mandatory bootstrap recall
  (default `{limit:5, scope:"project", detail:"digest", snippet_chars:200, include_summaries:true}`), rendered
  as JSON in the deny message, the per-step reminder and the bootstrap block.
- `compactMaxChars` (default 4000) — the verbatim compaction recap stored as `memory_type="summary"` is clipped
  with a pointer to the transcript, and tagged `session:<id>`.
- `projectRecall` (default true) / `maxRecallChars` (default 8000) — post-execute projection drops preferences
  that cannot apply here (not project-tagged, not broad-tagged, not importance ≥ 9 within 30 days) and holds the
  payload to a character budget, keeping the JSON valid and recording what it dropped under `projected`.
- `storeGate` (`off`|`remind`|`block`, default `remind`) + `writeTools` (default `["write","edit"]`) — a
  file-changing turn with nothing stored produces a reminder (or, in `block`, denies non-memory tools until a
  store lands).
- Quality-aware gate: a successful recall only opens the gate when its arguments name the current project or ask
  for a shaped slice.
- Smoke coverage for the new behaviour (S5 projection, S5 gate quality, S6 store gate) — 58 assertions, all passing.

### Changed

- Rules text rewritten for budgeted, pull-based recall: cheap digest first, expand only what you need, never
  print a raw recall payload, `file_paths` required for code facts, search before storing.
- `cordis.patch.yml` ships `prompt: slim`, `recallArgs` (with `include_summaries`) and `compactMaxChars`.

### Files

- `lib/index.js` — config surface, prompt modes, `recallArgsFor`, projection, quality gate, store gate, clipped
  compaction storage.
- `cordis.patch.yml` — the shipped config above.
- `_smoke.mjs` — S5/S6 tests and updated assertions for the new contract (58 passing).
- `README.md` — config table documents every new key and the quality-aware gate rule.
