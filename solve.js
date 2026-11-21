// A fast drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) returns exactly csv-reader's reading of {text, header} as
// {columns, rows, errors}. The text is read once, left to right:
//
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is
//     no record at all;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote and each CRLF or lone CR inside
//     it is read as LF; what follows its closing quote, up to the next
//     comma or line break, is appended as it stands (quote_junk, when
//     the field ends); a quote that never closes is a literal character
//     and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows
//     holds the records after it (every record when header is false),
//     each padded with "" (short_row, with fields: its field count) or
//     cut (long_row, with extra: the cut fields) to the first record's
//     width;
//   - each error is {code, line, row}, in the order met; line is the
//     1-based line its record starts on, counting every LF, CRLF and
//     lone CR inside quotes, and row is its record's index in rows
//     (null for the header).
//
// Speed: an unquoted field — the common case — is scanned for its
// terminator and sliced whole right in the record loop, with no helper
// call and no result object per field. Only the rare broken shapes
// (a stray CR, a quote that never closes, junk after a closing quote,
// doubled quotes, line breaks inside quotes) leave that inline path
// for the helpers below. A field is never built one character at a
// time.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows
  // it takes (null: the header). Kept here so the field readers below
  // can stamp the errors they meet with the record's own line and row.
  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = COMMA;
    let quoted = false;

    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        // Find the closing quote: the next quote that is not doubled.
        let scan = pos + 1;
        let close = -1;
        let doubled = false;
        for (;;) {
          const qi = text.indexOf('"', scan);
          if (qi === -1) break;
          if (text.charCodeAt(qi + 1) === 34) {
            doubled = true;
            scan = qi + 2;
            continue;
          }
          close = qi;
          break;
        }

        if (close === -1) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          const r = readUnquoted('"');
          fields.push(r.value);
          ended = r.ended;
          continue;
        }

        // The value: sliced whole when it holds no doubled quote and
        // no line break, rebuilt only when it does.
        let value;
        if (doubled) {
          value = readQuotedSlow(open + 1, close);
        } else {
          value = text.slice(open + 1, close);
          if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) {
            value = readQuotedSlow(open + 1, close);
          }
        }
        pos = close + 1;

        // What follows the closing quote: a comma, a line break, the
        // end of the text, or junk appended as it stands.
        if (pos >= n) {
          fields.push(value);
          ended = END;
          break;
        }
        const c = text.charCodeAt(pos);
        if (c === 44) {
          pos += 1;
          fields.push(value);
          ended = COMMA;
        } else if (c === 10) {
          pos += 1;
          line += 1;
          fields.push(value);
          ended = LINE_BREAK;
        } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fields.push(value);
          ended = LINE_BREAK;
        } else {
          const r = readUnquoted(value);
          if (r.added > 0) {
            errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
          fields.push(r.value);
          ended = r.ended;
        }
      } else {
        quoted = false;
        // Unquoted field, inline: scan for its terminator, slice it
        // whole. Only a stray CR before the terminator leaves this
        // path for the helper, which drops the CR and carries on.
        let p = pos;
        while (p < n) {
          const c = text.charCodeAt(p);
          if (c === 44 || c === 10 || c === 13) break;
          p += 1;
        }
        if (p >= n) {
          fields.push(text.slice(pos, p));
          pos = p;
          ended = END;
        } else {
          const c = text.charCodeAt(p);
          if (c === 44) {
            fields.push(text.slice(pos, p));
            pos = p + 1;
            ended = COMMA;
          } else if (c === 10) {
            fields.push(text.slice(pos, p));
            pos = p + 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (text.charCodeAt(p + 1) === 10) {
            fields.push(text.slice(pos, p));
            pos = p + 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            const prefix = text.slice(pos, p);
            pos = p;
            const r = readUnquoted(prefix);
            fields.push(r.value);
            ended = r.ended;
          }
        }
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };

  // Reads unquoted characters onto `prefix` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the
  // field, how it ended, and how many characters were kept onto the
  // prefix. Used only where the inline scan above cannot go on: a
  // stray CR, junk after a closing quote, or a quote that never closed.
  function readUnquoted(prefix) {
    let p = pos;
    let value = prefix;
    let added = 0;
    for (;;) {
      while (p < n) {
        const c = text.charCodeAt(p);
        if (c === 44 || c === 10 || c === 13) break;
        p += 1;
      }
      if (p >= n) {
        if (p > pos) {
          value += text.slice(pos, p);
          added += p - pos;
        }
        pos = p;
        return { value, ended: END, added };
      }
      const c = text.charCodeAt(p);
      if (c === 44) {
        if (p > pos) {
          value += text.slice(pos, p);
          added += p - pos;
        }
        pos = p + 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        if (p > pos) {
          value += text.slice(pos, p);
          added += p - pos;
        }
        pos = p + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR: a line break when followed by LF, else a dropped stray CR.
      if (text.charCodeAt(p + 1) === 10) {
        if (p > pos) {
          value += text.slice(pos, p);
          added += p - pos;
        }
        pos = p + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (p > pos) {
        value += text.slice(pos, p);
        added += p - pos;
      }
      p += 1;
      pos = p;
    }
  }

  // Builds a quoted field's value from text[start .. close): "" is one
  // quote, and each CRLF or lone CR inside it is one LF. Counts the
  // line breaks it turns into LF, as the reference does.
  function readQuotedSlow(start, close) {
    const parts = [];
    let seg = start;
    let p = start;
    while (p < close) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        // A doubled quote: one quote in the value.
        parts.push(text.slice(seg, p));
        parts.push('"');
        p += 2;
        seg = p;
      } else if (c === 13) {
        parts.push(text.slice(seg, p));
        parts.push('\n');
        line += 1;
        p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
        seg = p;
      } else if (c === 10) {
        parts.push(text.slice(seg, p));
        parts.push('\n');
        line += 1;
        p += 1;
        seg = p;
      } else {
        p += 1;
      }
    }
    if (seg < close) parts.push(text.slice(seg, close));
    return parts.join('');
  }
}
