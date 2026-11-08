/**
 * CSV and TSV for the table viewer: quoted fields, doubled quotes and line breaks inside quotes as RFC 4180 has them;
 * the delimiter from the type or name, else whichever of comma, semicolon, tab and bar the first line uses most.
 */
export function delimiter(text: string, hint: { mime?: string | null; name?: string | null }): string {
  if (/tab-separated/.test(hint.mime ?? '') || /\.(tsv|tab)$/i.test(hint.name ?? '')) return '\t';
  const first = text.slice(0, 4096).split('\n')[0].replace(/"[^"]*"/g, '');
  let best = ',';
  let most = 0;
  for (const d of [',', ';', '\t', '|']) {
    const n = first.split(d).length - 1;
    if (n > most) (best = d), (most = n);
  }
  return best;
}

/** Rows of fields. A field cut off by the end of the text keeps what it has. */
export function parseCsv(text: string, d: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n && rows.length < maxRows) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === d) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
    i++;
  }
  if ((field !== '' || row.length) && rows.length < maxRows) rows.push([...row, field]);
  return rows;
}
