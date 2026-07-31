# Literal-aware parameter scan — plan

Workstream: fix silent data corruption in the cr-layer parameter rewriters.
Branch (both repos): `security/wrap-escape`. Ships together with the already-committed
wrap/escape work (mssql 3.0.8 → 3.0.9, pg 2.0.30 → 2.0.31).

This is a **correctness** fix, not a security fix. It was found during a security sweep, and Andre
asked for it as its own change precisely so it reviews as correctness.

## The defect

Both layers locate parameter markers with a regex over the **whole statement**:

| layer | rewrite | regex | when |
|---|---|---|---|
| mssql | `$1,$2…` → `@p1,@p2…` | `/(\$\w*\b)/g` | `params` is an Array |
| pg | `@name` → `$1,$2…` | `/(@\w*\b)/g` | `params` is a plain object |

The regex has no idea what a string literal is. A Brazilian financial product writes `R$` in
descriptions, memos and product names all the time, so `'Total R$100 a vista'` contains what the
regex reads as parameter `$100`. Two things then go wrong, and a third is latent:

1. **mssql, silent corruption** — when the fake marker count does not exceed the param count,
   nothing throws and the literal is rewritten to `'Total R@p100 a vista'`. Those are the bytes
   that reach the database.
2. **mssql, loud misfire** — in the *more common* shape (caller passes exactly one param per real
   marker) the fake marker inflates the count and the `assert` throws
   `There are more parameters in statement than in object params` on perfectly valid SQL. Wrong
   error, wrong place, and it rejects a legitimate statement.
3. **pg, silent corruption** — pg has **no count assert**. A literal containing `@<key>` where
   `<key>` is a real key in the params object is silently rewritten to `$n` and the parameter value
   is substituted *into the literal*. Very reachable with email addresses
   (`'vendas@nome.com.br'` with a `nome` param).
4. **pg, loud misfire** — `@<not-a-key>` in a literal throws
   `Parameter @foo not found in object params` on valid SQL.
5. **latent, both** — the rewrite used `statement.replace(token, …)` with a **string** pattern,
   which replaces the *first* occurrence anywhere in the statement, not the occurrence that was
   matched. A second, independent corruption source.

Note the asymmetry: on pg the corrupting sigil is `@`, not `$`. With Array params pg passes the
statement to the driver untouched and postgres' own parser correctly ignores `$100` inside a
literal. The `$` side on pg is therefore a regression guard, not a bug.

## Approach

A single forward scan / small state machine per layer (`src/scan-markers.js`), returning only the
markers found in CODE context. Regexes are what produced this bug, so no regex patching. The
rewrite is done by position from slices, which also kills defect (5).

States: CODE, single-quoted literal (`''` escape), double-quoted identifier (`""`), MSSQL bracket
identifier (`]]` escape), line comment, nesting block comment. PG additionally: dollar-quoted
strings (`$$…$$`, `$tag$…$tag$`) and E-strings (backslash escapes). A dollar-quote tag may not
start with a digit, which is what makes dollar-quote detection safe next to positional `$n`.

Full spec as handed to the builders: `docs/rs-literal-tokenizer/spec.md`.

## Steps and verify gates

| # | step | verify gate |
|---|---|---|
| 1 | Baselines on the real engines | mssql 61 passing, pg 63 passing — **DONE** |
| 2 | Failing tests first, both layers, real payload | named tests red, messages captured |
| 3 | Implement scanner + rewire `convertParams` | new tests green |
| 4 | Round-trip through the real engines | insert → select → byte equality |
| 5 | Non-vacuity: break every state-machine branch | each break turns a *named* test red; every mutation asserts its anchor was found |
| 6 | Existing suites unchanged | 61 + new (mssql), 63 + new (pg) |
| 7 | Consumer gate: json-schema-entity against the modified layers | identical to its baseline, or explained |
| 8 | Patch bump, merge to master, push | CircleCI publishes from master |

## Release mechanics

Both repos publish from `.circleci/config.yml`: the `publish` job runs on `master` only, after
`test`, and publishes when `package.json` version differs from the published version. Same flow as
json-schema-entity. So: push master and let CI publish — do **not** run `npm publish` locally (the
npm token on this machine is expired anyway).
