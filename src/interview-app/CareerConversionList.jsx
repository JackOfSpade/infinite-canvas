import React from 'react';

const METHOD_LABEL = { machine_extracted: 'machine-extracted text, check it', passthrough: 'text file used as is', ai: 'copied out by Claude', decoded: 'decoded locally', document: 'read from the document', 'pdf-text-layer': 'machine-extracted text layer' };

/** Per-file outcome of converting the dropped career files to text. */
export function CareerConversionList({ rows, onOpen }) {
  if (!Array.isArray(rows) || !rows.length) return null;
  return (
    <ul className="space-y-1 text-xs" aria-label="Career file conversion">
      {rows.map((row, index) => (
        <li key={`${row.name}:${index}`} className={row.ok ? 'text-emerald-200' : 'text-amber-100'}>
          <span className="font-medium">{row.name}</span>{' · '}
          {row.ok ? `converted to text${METHOD_LABEL[row.method] ? ` (${METHOD_LABEL[row.method]})` : row.method ? ` (${row.method})` : ''}` : `not converted: ${row.reason}`}
          {row.ok && row.token && <>{' '}<button type="button" className="underline" onClick={() => onOpen?.(row.token)} aria-label={`Open converted text for ${row.name}`}>Open text</button></>}
          {row.ok && row.note && <span className="block opacity-80">{row.note}</span>}
        </li>
      ))}
    </ul>
  );
}
