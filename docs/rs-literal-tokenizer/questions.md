# Questions (non-blocking — each proceeded on a recorded default)

## Q1 — Should the mssql marker-count assert compare occurrences or distinct names?

`MssqlCrLayer.prototype.query` asserts
`markers.length <= Object.keys(params).length`. It counts marker **occurrences**, so a statement
that legitimately reuses a parameter — `SELECT $1 AS a, $1 AS b` with `['same']` — is 2 markers
against 1 param and throws `There are more parameters in statement than in object params`.

That is **pre-existing behaviour**: the old regex also counted occurrences, so the old code threw on
the same statement. This change does not alter it.

**Default taken: leave the assert exactly as it was.** Changing it to count distinct marker names
would be a genuine behaviour change (it would start accepting statements that have always been
rejected) and belongs in its own commit, not smuggled into a correctness fix that is meant to be
reviewable as such. The test that exercises repeated binding passes a surplus param
(`['same', 'unused']`) and carries a comment explaining why.

If Andre wants parameter reuse to actually work on the mssql layer, that is a small follow-up.

## Q2 — Unterminated literal / bracket / comment now swallows the rest of the statement

If a statement contains an unclosed `'`, `[` or `/*`, the scan treats everything to EOF as
non-code and finds no further markers. The old regex would have kept matching markers past it.

**Default taken: accept the new behaviour.** Such a statement is malformed and the engine would
reject it anyway; binding parameters into the tail of a broken statement is not a behaviour worth
preserving. Failing closed (no marker) is the safer direction than failing open.

## Q4 — Marker *grammar* hazards left untouched: money literals and `$` in identifiers

In **code** context the scan still reports a marker for:

- `SELECT $100.50` → marker `100` (T-SQL money literal)
- an identifier such as `a$b` → marker `b`

Both are pre-existing, inherited unchanged from the old `/(\$\w*\b)/g` regex — this change only made
the scan context-aware, it did not touch the token grammar.

**Default taken: leave both alone.** They are grammar questions, not context questions; fixing them
changes behaviour for statements that have always been handled this way, and folding that into a
correctness fix Andre explicitly asked to keep reviewable as one thing would be wrong. Recorded in
`decisions.md` D6 so it is not lost.

Worth a follow-up decision: a money literal silently becoming a parameter is the same class of
silent corruption this workstream exists to remove — it is just narrower (needs `$` + digits in code
position, which mostly means someone wrote a T-SQL money constant).

## Q3 — PG dollar-quote / E-string machinery added despite being unreachable today

See `decisions.md` D1. Proceeded on the recorded default of including it. Flagging here only so the
reviewer knows it was a deliberate, evidenced call and not an unchecked assumption.
