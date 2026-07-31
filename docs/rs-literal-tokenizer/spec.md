# Shared spec — literal-aware parameter marker scan (cr-layers)

Both `mssql-cr-layer` and `pg-cr-layer` rewrite parameter markers with a **regex over the whole
statement**, so a marker-looking token inside a *string literal*, *quoted identifier* or *comment*
is treated as a real parameter. Replace the regex with a **single forward scan / state machine**.

## New file: `src/scan-markers.js` (one per repo, dialect-tuned)

```js
module.exports = function scanMarkers(statement) // -> [{index, length, name}, ...] in order
```

`index` = offset of the marker sigil in `statement`; `length` = full token length (sigil + name);
`name` = the token text WITHOUT the sigil.

Only markers found in **CODE** context are returned.

### Marker grammar (MUST match the old regex exactly, minus context)

- mssql: old regex `/(\$\w*\b)/g` — sigil `$`
- pg:    old regex `/(@\w*\b)/g`  — sigil `@`

`\w` in JS is `[A-Za-z0-9_]`. Because `\w*` is greedy and `\b` must hold at the end, the effective
grammar is: **sigil followed by ONE OR MORE `[A-Za-z0-9_]`, maximal munch.** A sigil followed by a
non-word char (or end of string) is NOT a marker. Preserve this precisely — e.g. `'%R$%'` never
matched before and must not match now; `$abc` DID match before and must still match.

### States

- `CODE` — default. Only here are markers recognised.
- `SQUOTE` — single-quoted string literal, opened by `'`. Closes on `'` **unless** the next char is
  also `'` (the SQL `''` escape → consume both, stay in SQUOTE). Unterminated → runs to EOF.
- `DQUOTE` — double-quoted identifier, opened by `"`. Closes on `"` unless doubled (`""`).
  (Valid on PG always; on MSSQL under QUOTED_IDENTIFIER ON, which is the driver default.)
- `BRACKET` — **MSSQL only** — `[` … `]`, closing `]` escaped by doubling (`]]`).
- `LINE_COMMENT` — `--` to the next `\n` (or EOF). Note `\r\n` — ending on `\n` is fine.
- `BLOCK_COMMENT` — `/*` … `*/`, **NESTING** (both T-SQL and PG nest block comments). Track depth;
  return to CODE only when depth hits 0.
- `DOLLAR_QUOTE` — **PG only** — see below.

### PG dollar-quoted strings

Opened in CODE by `$tag$` where `tag` is EMPTY or matches `[A-Za-z_][A-Za-z0-9_]*`
(a tag may NOT start with a digit — therefore `$1` can never open a dollar quote, which is what
keeps this safe next to positional markers). Closes on the identical `$tag$`.
If a `$` is not followed by a valid tag plus a closing `$`, it is NOT a dollar quote — advance one
char and stay in CODE.

### PG E-strings (backslash escapes)

`E'...'` / `e'...'` — inside these, a backslash escapes the next character (so `E'it\'s'` does NOT
end at the escaped quote). Detect by: the char immediately before the opening `'` is `e`/`E` AND the
char before THAT is not `[A-Za-z0-9_$]` (so `case'` or `type'` do not trigger it). The `''` escape
also still applies inside an E-string. Plain `'...'` on PG does NOT honour backslashes under
`standard_conforming_strings = on` (the modern default) — do not treat `\` as an escape there.

MSSQL has **no** backslash escape in string literals — `''` only. Do not add one.

## Rewrite by POSITION, never `String.prototype.replace`

The old code called `statement.replace(token, ...)` with a **string** pattern, which replaces the
FIRST occurrence anywhere — a second latent corruption source. Build the new statement from slices:

```js
let out = ''
let last = 0
markers.forEach(m => { out += statement.slice(last, m.index) + <replacement>; last = m.index + m.length })
out += statement.slice(last)
```

## Call-site changes

### mssql `src/index.js` (`query`, ~line 238 `convertParams`)

- `const markers = scanMarkers(statement)`
- `assert(markers.length <= Object.keys(params).length, 'There are more parameters in statement than in object params')`
  — keep the message byte-identical.
- For each marker: `key = m.name`; `paramsObj['p' + key] = params[Number(key) - 1]`; replacement `'@p' + key`.
- `params = paramsObj`.

### pg `src/index.js` (`query`, ~line 235 `convertParams`, object-params branch)

- `const markers = scanMarkers(statement)`
- Walk in order with `i` starting at 1; replacement `'$' + i`.
- Keep the existing assert AND its exact message: `'Parameter ' + '@' + key + ' not found in object params'`
  (the old code built it from the full token, so the message contains the sigil). Keep using
  `Object.prototype.hasOwnProperty.call(params, key)` — presence, not truthiness.
- Order: the old code did the replace BEFORE the assert; the assert still throws, so observable
  behaviour on the throw path is unchanged (the statement local is discarded).
- Result `params` = array of values in marker order (a repeated `@name` yields two positional
  params, as before).
- When there are no markers, `params` becomes `[]` — same as before.
- The `params.map(...)` normalisation that follows (`{value}` unwrap, `undefined`→`null`) is
  unchanged and still runs for both the array and object paths.

## Behaviour that MUST NOT change

- Array params on pg are passed straight through (no rewrite) — untouched.
- Object params on mssql are bound by name with no statement rewrite — untouched.
- `batch` (mssql) does no binding — untouched.
- `null`/`undefined` params → no rewrite path at all.
- Existing suites: **mssql 61 passing, pg 63 passing** must stay exactly that (plus the new tests).

## Style

- eslint flat config, `npx eslint src test` must be clean. **No semicolons**, `arrow-parens: as-needed`.
- Match surrounding code style (the repos use `var`/`function` in places, `const`/arrow in others —
  follow the file you are editing).
- Comments in English.
