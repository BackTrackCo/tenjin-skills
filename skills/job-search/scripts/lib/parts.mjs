// A field made of several controls (a month and a year dropdown, or a day, a month and a year) is one field with "type": "date" and
// "parts": [{"name", "options"}], each part with its own real option labels, word for word. Code matches a typed answer to each part
// and never guesses: a part it cannot match is left for the form's own mapping.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const flat = (s) => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// A summary of a list in place of option labels: "Month: January..December", "Year: 2027..1908".
const RANGE = /[^.\s]\s*\.{2,3}\s*[^.\s]/;
export const isSummaryOption = (o) => RANGE.test(String(o));

// The problems of a list of fields (the questions of a form, or the live read): one line each, naming the field.
export function partsProblems(fields) {
  const problems = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f !== 'object') continue;
    const label = String(f.label || '');
    const summary = (list) => (Array.isArray(list) ? list : []).find(isSummaryOption);
    const own = summary(f.options);
    if (own !== undefined) problems.push(`field "${label}" has an option that summarizes a list ("${own}"): read the form again and give a field made of several controls as "type":"date" with "parts":[{"name","options"}], each part with its real option labels`);
    if (f.parts !== undefined) {
      if (!Array.isArray(f.parts) || !f.parts.length || f.parts.some((p) => !p || typeof p.name !== 'string' || !p.name.trim() || (p.options !== undefined && !Array.isArray(p.options)))) problems.push(`field "${label}" has parts that are not [{"name","options"}]: read it again with one named part for each control`);
      else for (const p of f.parts) { const bad = summary(p.options); if (bad !== undefined) problems.push(`field "${label}", part "${p.name}", has an option that summarizes a list ("${bad}"): read it again with each part's real option labels`); }
    }
  }
  return problems;
}

export const hasParts = (f) => Boolean(f && (f.type === 'date' || (Array.isArray(f.parts) && f.parts.length)));
const kindOf = (name) => (/month/i.test(name) ? 'month' : /year/i.test(name) ? 'year' : /day/i.test(name) ? 'day' : 'other');
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
// "a month and a year": the parts by name, for the plain question.
export function partsPhrase(parts) {
  const names = (parts || []).map((p) => String(p.name).trim().toLowerCase()).filter(Boolean);
  if (!names.length) return 'a date';
  const withArticle = names.map((n) => `${article(n)} ${n}`);
  return withArticle.length === 1 ? withArticle[0] : `${withArticle.slice(0, -1).join(', ')} and ${withArticle[withArticle.length - 1]}`;
}

// The typed answer, part by part: [{name, value}] with each value as the form spells it, or null when any part cannot be matched.
export function matchParts(parts, text) {
  if (!Array.isArray(parts) || !parts.length) return null;
  const tokens = String(text).normalize('NFKC').split(/[\s,\/.\-]+/).filter(Boolean);
  const years = tokens.filter((t) => /^\d{4}$/.test(t));
  const named = tokens.map((t) => t.toLowerCase()).map((t) => MONTHS.findIndex((m) => m === t || (t.length >= 3 && m.startsWith(t)))).filter((i) => i >= 0);
  const numbers = tokens.filter((t) => /^\d{1,2}$/.test(t)).map(Number);
  const out = [];
  let used = 0;
  for (const p of parts) {
    const kind = kindOf(p.name);
    const opts = Array.isArray(p.options) ? p.options.filter(Boolean).map(String) : [];
    let want;
    if (kind === 'year') want = years.length ? { text: years[0], num: Number(years[0]) } : null;
    else if (kind === 'month') {
      if (named.length) want = { text: MONTHS[named[0]], num: named[0] + 1 };
      else if (used < numbers.length && numbers[used] >= 1 && numbers[used] <= 12) { want = { num: numbers[used], text: String(numbers[used]) }; used += 1; } else want = null;
    } else if (kind === 'day') {
      if (used < numbers.length && numbers[used] >= 1 && numbers[used] <= 31) { want = { num: numbers[used], text: String(numbers[used]) }; used += 1; } else want = null;
    } else want = tokens.length ? { text: String(text).trim(), num: null } : null;
    if (!want) return null;
    let value;
    if (!opts.length) value = kind === 'month' ? (want.text.length > 2 ? want.text[0].toUpperCase() + want.text.slice(1) : want.text) : want.text;
    else if (kind === 'month') value = opts.find((o) => flat(o) === MONTHS[want.num - 1]) || opts.find((o) => flat(o).length >= 3 && MONTHS[want.num - 1].startsWith(flat(o).replace(/\.$/, ''))) || opts.find((o) => /^\d{1,2}$/.test(o.trim()) && Number(o) === want.num);
    else if (kind === 'year' || kind === 'day') value = opts.find((o) => /^\d+$/.test(o.trim()) && Number(o) === want.num);
    else value = opts.find((o) => flat(o) === flat(want.text));
    if (!value) return null;
    out.push({ name: p.name, value });
  }
  return out;
}
