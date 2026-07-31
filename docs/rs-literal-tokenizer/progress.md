# Progress (append-only)

## 2026-07-31 — Step 1: baselines on the real engines — PASS
Both engines already up on the host (mssql container `mssql` on 1433, native postgres on 5432).
- mssql-cr-layer: **61 passing**
- pg-cr-layer: **63 passing**
Trap recorded: never set `MSSQL_PORT`/`POSTGRES_PORT` for these suites — the test files do
`process.env.MSSQL_PORT || 1433`, and a *string* port makes tedious throw
`config.options.port must be of type number`. Also never pass `--bail` (both `npm test` scripts
hardcode it) when gathering counts.

## 2026-07-31 — Step 2: reachability scout — informative, changed the framing
See `decisions.md` D1/D3. Headline: the pg object-param rewrite is **unreachable in habilis today**
(habilis' `ctx.query` bypasses `PgCrLayer.prototype.query` entirely on PG; every dollar-quoted body
runs through `batch` with `params = null`). The mssql array path IS live alongside inline literals,
but no in-repo literal currently carries a `$`+word sequence. Defect is **latent, not actively
corrupting rows**.

## 2026-07-31 — Steps 3+4: mssql build, red-before/green-after — PASS
16 new tests. 12 red before the fix, 4 already green.
- 11 red with the byte-identical assert `There are more parameters in statement than in object params`
- 1 red as **silent corruption**: `expected 'Total R@p100 a vista' to equal 'Total R$100 a vista'`
Round trip through the real engine (INSERT → SELECT → byte equality) included.
Count: 61 → **77 passing**, eslint clean.

Builder found a hole in my own spec: every case I specified put the real marker *before* the
lookalike, where `String.replace` coincidentally does the right thing — so the "rewrite by position"
half would have been **proven by nothing**. Added
`should rewrite the marker by position when a lookalike comes first`.

## 2026-07-31 — Steps 3+4: pg build, red-before/green-after — PASS
16 new tests. 11 red before the fix, 5 already green (the `$` regression guards).
Count: 63 → **79 passing**, eslint clean.
Builder corrected my framing of the pg failure mode — see `decisions.md` D2. pg mostly hard-fails
(positional hole → bind error); it is silent only when object params are mixed with an explicit
positional `$n`. Docs corrected rather than left to read as if pg matched the mssql story.

## 2026-07-31 — Step 5: mssql non-vacuity break pass — PASS with one gap, now closed
9 mutations, every anchor asserted present exactly once, every restore `cmp`-verified.
8 of 9 branches pinned by *named* tests. One came back **UNPROVEN**: the `end > i + 1` word-char
guard — the test that sounded like it covered it (`'%R$%'`) has the bare `$` inside a literal, so
the scanner never reaches the `$` branch.
Gap closed: added `should not take a bare dollar sign in code as a marker`, asserting on
`scanMarkers` directly. Vacuity-checked: under the `>=` mutation it fails with
`AssertionError: expected 1 to equal +0`; restore byte-identical. Count **77 → 78 passing**.
Also confirmed the `''` doubling branch is parity-equivalent for symmetric delimiters — a property,
not a gap (`decisions.md` D5).

## 2026-07-31 — PROCESS ERROR (mine), and the hazard it exposed
I read `pg-cr-layer/src/scan-markers.js` **while the pg break-pass verifier was mid-mutation** and
briefly concluded the single-quote branch was missing. It was not — I had read mutation #1
("single-quoted literal state removed") in flight. No code was changed as a result.

The real consequence is bigger, and it is mine to fix: I launched the **jse consumer gate
concurrently with the pg break pass**, and the gate works by copying `pg-cr-layer/src` into jse's
`node_modules`. If that copy happened while a mutation was applied, the gate would have injected
**mutated** code — producing either a false failure or, far worse, a false pass on code that will
never ship.

Decision: the concurrent jse gate result is treated as **advisory only and discarded**. The gate is
re-run after the break pass has finished and both files are confirmed pristine. Serialise anything
that reads a repo another agent is mutating.

## 2026-07-31 — Step 5: pg non-vacuity break pass — PASS with one gap, now closed
11 mutations, every anchor asserted present exactly once, all 11 restores `cmp`-verified.
10 of 11 branches pinned by *named* tests. The same branch that failed on the mssql side came back
**UNPROVEN** here too: the `readMarker` word-char guard.

The pg justification is stronger than mssql's, and it is a production hazard rather than a
curiosity: postgres has real operators spelled with a bare `@` — **`@>`, `<@`, `@@`, `@-@`**. With
the guard removed, `SELECT a @> b, @id::int AS x` yields a zero-length marker named `''` ahead of
the real one, which would either throw `Parameter @ not found in object params` or silently consume
a `$n` slot and **mis-number every real marker after it**. No fixture in the suite contained a bare
`@` in code position, so nothing caught it.

Gap closed: `should not take a bare at sign operator as a marker` — a scanner-level assertion (one
marker, `name === 'id'`, `index === 15`) plus a live round trip
(`SELECT ARRAY[1,2] @> ARRAY[1] AS contains, @id::int AS id` with `{id: 7}`). Vacuity-checked: under
the mutation it fails `AssertionError: expected 2 to equal 1`; restore byte-identical.
Count **79 → 80 passing**.

Break-pass results also confirmed independently: mutation 7 (dollar-quote tag may not start with a
digit) is genuinely pinned, mutation 11 (rewrite-by-position) is genuinely pinned, and the `''`
parity property (D5) is correct — on pg the doubling branch is observable *only* in combination with
the E-string backslash rule (`E'a''\'@name'`).

## Final counts
| layer | baseline | after |
|---|---|---|
| mssql-cr-layer | 61 | **78** (17 new) |
| pg-cr-layer | 63 | **80** (17 new) |
