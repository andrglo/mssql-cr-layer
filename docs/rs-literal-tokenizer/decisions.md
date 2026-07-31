# Decisions

## D1 — Include PG dollar-quote + E-string states even though they are unreachable today

The brief asked to *check whether the layer can encounter dollar-quoted strings before adding
machinery for it*. It was checked (read-only sweep of habilis, json-schema-entity, sql-view).

**Finding: it cannot, today.**

- Every dollar-quoted body in habilis (`DO $$ … END $$;`, PL/pgSQL functions) lives in `.psql`
  migration scripts and runs through `runScript` → `db.batch(script, {transaction})`
  (`app/lib/db/adapters/pg/index.js:85-97`). `PgCrLayer.batch` is `query(script, null, options)`,
  so `params` is `null` and the rewrite branch (`if (params && params !== null)`) is never entered.
- No call site anywhere in habilis, json-schema-entity or sql-view passes a **plain object** as
  `params` to pg-cr-layer. json-schema-entity's adapters and sql-view always build **array** params
  with pre-baked `$1,$2…`.
- Stronger still: habilis' app-level `ctx.query` bypasses `PgCrLayer.prototype.query` altogether on
  PG — `get-query-runner.js:11-15` takes a raw pool client and calls `client.query(...)` directly so
  it can bind `SET search_path`.
- No `E'…'` escape-strings were found in habilis SQL text at all.

**Decision: implement the dollar-quote and E-string states anyway.** Recorded default, proceeding
unattended. Reasons:

1. pg-cr-layer is a **published public package**; habilis is not its only consumer, and "our current
   callers happen not to do it" is exactly the reasoning that leaves a trap armed.
2. `batch` is a plain alias of `query`. The distance between today's safe `batch(script, null)` and
   a corrupting `batch(script, {tenant})` is one future caller adding one parameter — and the
   failure would again be silent.
3. The cost is ~15 lines inside a state machine that has to exist regardless, and each state is
   independently tested and non-vacuity-checked.
4. A dollar-quote tag may not begin with a digit, so `$1` can never be mistaken for a dollar-quote
   opener. The feature cannot destabilise positional-marker handling.

## D2 — The `@`/`$` asymmetry is real and is reflected in the tests

On PG the corrupting sigil is `@`, not `$`. With Array params the statement reaches the driver
untouched and postgres' own parser correctly ignores `$100` inside a literal. So the pg `R$100`
tests are **regression guards**, and the genuine pg corruption test uses `@<key>` inside a literal
(e.g. an email address next to a same-named parameter).

**Correction, after measurement.** An earlier draft of this workstream's notes asserted the pg
failure was *silent* because pg has no marker-count assert. Measurement against the pre-fix code
showed that is wrong in the common case, and the docs were corrected:

- pure object params → **LOUD**. The rewritten `$n` lands inside a string literal, where postgres
  never substitutes, so it becomes a positional hole and the server rejects the bind
  (`bind message supplies 2 parameters, but prepared statement "" requires 1`).
- object params **mixed with an explicit positional `$n`** → **SILENT**. The pre-existing `$n` fills
  the hole and the corrupted literal is returned/stored:
  `query("SELECT $1::text AS a, 'vendas@name.com.br' AS b", {name: 'Cadeira'})`
  → `b = 'vendas$1.com.br'`, no error.

So mssql is the layer where the headline silent-corruption story holds; pg mostly hard-fails. Both
are worth fixing, and review should be told which is which.

## D5 — The `''` doubling branch is parity-equivalent for symmetric delimiters

Breaking the doubled-delimiter escape inside `skipQuoted` turns red only the **bracket** test, never
the doubled-quote *literal* test. This is not a test gap — it is a provable property, confirmed by
direct probe on both layers:

Without the doubling branch, `''` is parsed as *close then immediately reopen*. Because the two
quotes are adjacent there are no characters between them, so the two adjacent literals tile exactly
the same span as the single merged literal, and every character's inside/outside status is
identical. A symmetric delimiter can therefore never expose the difference. Only the **asymmetric**
`[` … `]]` … `]` pair can, because the reopen character is not the open character.

Consequence recorded for whoever touches this next: **a plain `'it''s R$5'` test can never pin that
branch.** On mssql it is pinned through the `]]` bracket case; on pg (which has no bracket state) it
is pinned by combining the doubled quote with the E-string backslash rule. If `skipQuoted` is ever
split into per-delimiter functions, the literal side instantly becomes unproven.

## D6 — Pre-existing marker-shaped hazards left alone (out of scope)

Unchanged by this work, inherited verbatim from the old `/(\$\w*\b)/g` grammar, and deliberately not
touched because this change is meant to review as one thing:

- a T-SQL **money literal** in code context, `SELECT $100.50`, is still read as marker `100`;
- a T-SQL identifier containing `$` in code context, e.g. `a$b`, is still read as marker `b`.

Both are real mangling paths with no test. They are marker-*grammar* questions, not
marker-*context* questions, and changing the grammar would alter behaviour for statements that have
always been handled this way. Flagged for a possible follow-up; see `questions.md` Q4.

## D3 — Reachability in habilis today: latent, not actively corrupting

The mssql array→`@p` path IS live and heavily used alongside inline quoted literals — real examples
in `app/modules/uniflex/src/containers/OrcamentoAddItem.server.js` (`LOAD_REFS_SQL`,
`LOAD_CORES_SQL`) and `PosicaoEstoque.server.js`, all mixing `'N'` / `escape '\'` literals with
`$1..$n` placeholders. **None of those literals currently contains a `$`+word-char sequence**, and
no hardcoded `'R$<digit>'` literal was found inside any SQL template passed to `ctx.query`. All the
`R$` currency formatting found in habilis lives in report/narrative strings, never in SQL text.

So the defect is **latent in habilis rather than actively corrupting rows today**: the mechanism is
live and one `'R$50'` literal away from firing. This is worth stating plainly in review — it is the
difference between "we must ship a data repair" and "we must close the hole before it opens". No
data-repair workstream is implied by this finding.

## D4 — Rewrite by position, not `String.replace`

Folded into the same change rather than split out: the old code passed a **string** to
`String.prototype.replace`, which replaces the first occurrence in the whole statement rather than
the occurrence that matched. Slicing by index removes that second corruption source for free and
would otherwise remain a live bug even after the scan became literal-aware.
