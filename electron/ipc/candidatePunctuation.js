import { enDashIsRange } from './dashRanges.js';
/** The candidate-copy gate and host-owned pre-check share these exact predicates. */
export function forbiddenPunctuationKinds(text) {
  const value = String(text || ''); const kinds = [];
  if (value.includes(String.fromCharCode(0x2014))) kinds.push('em-dash');
  if (value.includes(';')) kinds.push('semicolon');
  if (/\s-\s/u.test(value)) kinds.push('spaced-hyphen');
  const dash = String.fromCharCode(0x2013);
  for (let index = value.indexOf(dash); index !== -1; index = value.indexOf(dash, index + 1)) {
    if (!enDashIsRange(value, index)) { kinds.push('en-dash'); break; }
  }
  return kinds;
}
