// Fast CSV reader: an exact drop-in for csv-reader 1.0.0.
//
// Same answers as the reference for every input {text, header}:
//   {columns, rows, errors}
// Written from the published reading policy, as an original single-pass
// parser. Fields are taken as string slices wherever the text allows it,
// so the common case never touches the text one character at a time.
//
// Policy (what the reader does, left to right):
// - a U+FEFF at the very start is dropped;
// - a record ends at LF or CRLF; a line left with no characters is no record;
// - outside quotes a CR not followed by LF is dropped (error stray_cr);
// - a field opening with a quote runs to the next quote that is not doubled,
//   "" inside it is one quote, each CRLF or lone CR inside it reads as LF;
//   what follows the closing quote up to the next comma or line break is
//   appended as it stands (error quote_junk when the field ends, if anything
//   was kept); a quote that never closes is a literal character and the text
//   after it is read again as unquoted (error unterminated_quote);
// - a quote inside an unquoted field is a literal character;
// - fields stay strings, never trimmed or converted;
// - columns is the first record when header is true, else null; rows holds
//   the records after it, each padded with "" (short_row, with fields: its
//   count) or cut (long_row, with extra: the cut fields) to the first
//   record's width;
// - each error is {code, line, row} in the order met; line is the 1-based
//   line its record starts on, counting every LF, CRLF and lone CR inside
//   quotes, and row is the record's index in rows, null for the header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters
  // the unquoted reader kept onto its starting value.
  let fVal = '';
  let fEnd = END;
  let fAdded = 0;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, appending onto `init`.
  // A CR not followed by LF is dropped (stray_cr). Sets fVal/fEnd/fAdded.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    let segStart = pos;
    for (;;) {
      if (pos >= n) {
        if (segStart < n) {
          const seg = text.slice(segStart);
          const cr = seg.indexOf('\r');
          if (cr === -1) {
            value += seg;
            added += seg.length;
          } else {
            const fixed = dropStrayCr(seg);
            value += fixed;
            added += fixed.length;
          }
        }
        pos = n;
        fVal = value;
        fAdded = added;
        fEnd = END;
        return;
      }
      const iComma = text.indexOf(',', pos);
      const iLF = text.indexOf('\n', pos);
      let end = -1;
      let isComma = false;
      let atEnd = false;
      if (iComma === -1) {
        end = iLF;
      } else if (iLF === -1) {
        end = iComma;
        isComma = true;
      } else if (iComma < iLF) {
        end = iComma;
        isComma = true;
      } else {
        end = iLF;
      }
      if (end === -1) {
        end = n;
        atEnd = true;
      }
      // The segment [segStart, end) belongs to this field, except a CR just
      // before a LF: that CR is the CRLF that ends the record, not field text.
      let segEnd = end;
      if (!isComma && !atEnd && segEnd > segStart && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
      if (segEnd > segStart) {
        const seg = text.slice(segStart, segEnd);
        const cr = seg.indexOf('\r');
        if (cr === -1) {
          value += seg;
          added += seg.length;
        } else {
          const fixed = dropStrayCr(seg);
          value += fixed;
          added += fixed.length;
        }
      }
      if (atEnd) {
        pos = n;
        fVal = value;
        fAdded = added;
        fEnd = END;
        return;
      }
      if (isComma) {
        pos = end + 1;
        fVal = value;
        fAdded = added;
        fEnd = COMMA;
        return;
      }
      pos = end + 1;
      line += 1;
      fVal = value;
      fAdded = added;
      fEnd = LINE_BREAK;
      return;
    }
  }

  // `seg` with every CR dropped, one stray_cr error per CR dropped.
  // Every CR in such a segment is stray: the segment ends at a comma, at
  // the end of the text, or just before the CR of a CRLF.
  function dropStrayCr(seg) {
    let out = '';
    let idx = 0;
    let count = 0;
    for (;;) {
      const cr = seg.indexOf('\r', idx);
      if (cr === -1) {
        out += seg.slice(idx);
        break;
      }
      out += seg.slice(idx, cr);
      count += 1;
      idx = cr + 1;
    }
    for (let k = 0; k < count; k++) pushError('stray_cr');
    return out;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal/fEnd.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    let segStart = pos;
    let lineDelta = 0;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        readUnquoted('"');
        return;
      }
      if (q > segStart) {
        const seg = text.slice(segStart, q);
        if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
          value += seg;
        } else {
          // CRLF and lone CR inside quotes are each one LF, and each
          // counts one line.
          let conv = '';
          let i = 0;
          let count = 0;
          while (i < seg.length) {
            const ch = seg.charCodeAt(i);
            if (ch === 13) {
              conv += '\n';
              count += 1;
              i += seg.charCodeAt(i + 1) === 10 ? 2 : 1;
            } else if (ch === 10) {
              conv += '\n';
              count += 1;
              i += 1;
            } else {
              let j = i + 1;
              while (j < seg.length) {
                const c2 = seg.charCodeAt(j);
                if (c2 === 13 || c2 === 10) break;
                j += 1;
              }
              conv += seg.slice(i, j);
              i = j;
            }
          }
          value += conv;
          lineDelta += count;
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one literal quote.
        value += '"';
        pos = q + 2;
        segStart = pos;
        continue;
      }
      // Closed.
      pos = q + 1;
      line += lineDelta;
      if (pos >= n) {
        fVal = value;
        fAdded = 0;
        fEnd = END;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fVal = value;
        fAdded = 0;
        fEnd = COMMA;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fVal = value;
        fAdded = 0;
        fEnd = LINE_BREAK;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fVal = value;
        fAdded = 0;
        fEnd = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      readUnquoted(value);
      if (fAdded > 0) pushError('quote_junk');
      return;
    }
  }

  for (;;) {
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
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        readQuoted();
        lastQuoted = true;
      } else {
        readUnquoted('');
        lastQuoted = false;
      }
      fields.push(fVal);
    } while (fEnd === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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
}
