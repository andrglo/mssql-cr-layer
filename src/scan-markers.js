/**
 * Find the parameter markers of a T-SQL statement that are in code context.
 *
 * A regex over the whole statement cannot tell a marker from a marker
 * lookalike sitting inside a string literal, a quoted identifier or a
 * comment - 'Total R$100 a vista' reads as the marker $100 - so the
 * statement is walked once, tracking the context, and only the markers
 * found in code are reported.
 *
 * The marker grammar reproduces the old /(\$\w*\b)/g exactly: the sigil
 * followed by one or more word characters, maximal munch. A sigil not
 * followed by a word character is not a marker, so '%R$%' stays inert.
 *
 * There is no dollar quoting in T-SQL and no backslash escape in its
 * string literals - a quote is escaped by doubling it, and so is the
 * closing bracket of a bracketed identifier.
 *
 * @param statement {string}
 * @returns {Array} [{index, length, name}, ...] in the order they appear,
 * index being the offset of the sigil and name the token without it
 */
module.exports = function scanMarkers(statement) {
  const markers = []
  const length = statement.length
  let i = 0
  while (i < length) {
    const char = statement[i]
    if (char === '\'') {
      i = skipQuoted(statement, i, '\'')
    } else if (char === '"') {
      i = skipQuoted(statement, i, '"')
    } else if (char === '[') {
      i = skipQuoted(statement, i, ']')
    } else if (char === '-' && statement[i + 1] === '-') {
      const end = statement.indexOf('\n', i + 2)
      i = end === -1 ? length : end + 1
    } else if (char === '/' && statement[i + 1] === '*') {
      i = skipBlockComment(statement, i)
    } else if (char === '$') {
      let end = i + 1
      while (end < length && isWordChar(statement[end])) {
        end++
      }
      if (end > i + 1) {
        markers.push({
          index: i,
          length: end - i,
          name: statement.slice(i + 1, end)
        })
      }
      i = end
    } else {
      i++
    }
  }
  return markers
}

function isWordChar(char) {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_'
  )
}

/**
 * Skip the quoted run opened at start, whose closing delimiter is close and
 * is escaped by doubling it. Unterminated runs to the end of the statement
 * @returns the offset of the first character after the run
 */
function skipQuoted(statement, start, close) {
  let i = start + 1
  while (i < statement.length) {
    if (statement[i] === close) {
      if (statement[i + 1] === close) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return statement.length
}

/**
 * Skip the block comment opened at start. T-SQL nests block comments, so the
 * depth is tracked and the comment ends only when it gets back to zero
 * @returns the offset of the first character after the comment
 */
function skipBlockComment(statement, start) {
  let depth = 1
  let i = start + 2
  while (i < statement.length) {
    if (statement[i] === '/' && statement[i + 1] === '*') {
      depth++
      i += 2
    } else if (statement[i] === '*' && statement[i + 1] === '/') {
      depth--
      i += 2
      if (depth === 0) {
        return i
      }
    } else {
      i++
    }
  }
  return statement.length
}
