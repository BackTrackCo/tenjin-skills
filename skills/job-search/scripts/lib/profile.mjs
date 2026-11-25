// The shape of profile.json, checked when it is set, so a bad shape never reaches the sweep.
const isStr = (v) => typeof v === 'string';
const strList = (v) => Array.isArray(v) && v.every(isStr);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

// The voluntary demographic answers (gender, race or ethnicity, veteran status, disability) are the person's own text, never a
// choice: `eeoText`.
export const eeoTextOf = (p) => (p && typeof p === 'object' && typeof p.eeoText === 'string' && p.eeoText.trim() ? p.eeoText.trim() : null);

// A field from an older version of the skill. Until v0 ships there are no converters or shims: a profile that holds one is refused
// with an error that names the field, and the person (or the model) removes it. `J profile set '{"<field>": null}'` removes it.
const OLD_FIELDS = {
  eeo: 'the voluntary demographic answers are the person\'s own text now (eeoText); set it with J eeo set',
  careerOps: 'that compatibility feature no longer exists',
};
export function oldFields(p) {
  return p && typeof p === 'object' ? Object.keys(OLD_FIELDS).filter((k) => p[k] !== undefined).map((k) => ({ field: k, why: OLD_FIELDS[k] })) : [];
}
export const oldFieldError = (list) => `profile.json has ${list.length > 1 ? 'old fields' : 'an old field'} the skill no longer reads: ${list.map((o) => `${o.field} (${o.why})`).join('; ')}. Remove ${list.length > 1 ? 'them' : 'it'} with J profile set '${JSON.stringify(Object.fromEntries(list.map((o) => [o.field, null])))}'.`;

export function validateProfile(p) {
  const bad = [];
  const need = (ok, msg) => ok || bad.push(msg);
  for (const o of oldFields(p)) bad.push(`${o.field} is an old field: ${o.why}`);
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['the profile must be a JSON object'];
  const has = (k) => p[k] !== undefined;
  if (has('places')) need(strList(p.places), 'places must be a list of strings, for example ["San Francisco"]');
  for (const k of ['remote', 'includeOld', 'updates', 'hn', 'yc']) if (has(k)) need(typeof p[k] === 'boolean', `${k} must be true or false`);
  if (has('frequency')) need(['daily', 'twice_daily', 'weekly'].includes(p.frequency), 'frequency must be daily, twice_daily or weekly');
  if (has('applyMode')) need(['attended', 'auto_no_new', 'auto_write', 'fill_only', 'open_only'].includes(p.applyMode), 'applyMode must be attended, auto_no_new, auto_write, fill_only or open_only');
  if (has('apply')) need(p.apply && typeof p.apply === 'object' && ['employer', 'linkedin', 'ask'].includes(p.apply.where) && p.apply.source === 'person', 'apply must be {"where": "employer"|"linkedin"|"ask", "source": "person"}');
  if (has('windowDays')) need(num(p.windowDays) && p.windowDays > 0, 'windowDays must be a positive number');
  if (has('sweepHour')) need(Number.isInteger(p.sweepHour) && p.sweepHour >= 0 && p.sweepHour <= 23, 'sweepHour must be a whole number from 0 to 23');
  for (const k of ['resumePath', 'resumeUploadPath', 'resumeText']) if (has(k)) need(isStr(p[k]), `${k} must be text`);
  if (has('watch')) {
    need(Array.isArray(p.watch) && p.watch.every((w) => w && typeof w === 'object' && ((isStr(w.url) && w.url) || (isStr(w.ats) && isStr(w.token)))), 'watch must be a list of {"url": "<careers link>"} (or {"ats", "token"})');
  }
  if (has('search')) {
    const s = p.search;
    need(s && typeof s === 'object' && isStr(s.role) && s.role.trim() !== '', 'search needs a role (text), for example {"role": "software engineer", "place": "Berlin"}');
    if (s && typeof s === 'object') {
      if (s.place !== undefined) need(isStr(s.place), 'search.place must be text');
      if (s.remote !== undefined) need(typeof s.remote === 'boolean', 'search.remote must be true or false');
      if (s.roleWords !== undefined) need(strList(s.roleWords), 'search.roleWords must be a list of strings');
      if (s.sources !== undefined) need(s.sources && typeof s.sources === 'object' && Object.values(s.sources).every(isStr), 'search.sources must say where each value came from (resume or person)');
      if (s.variants !== undefined) need(strList(s.variants), 'search.variants must be a list of strings (role-word variants: a synonym or a level)');
    }
  }
  if (has('facts')) need(p.facts && typeof p.facts === 'object' && !Array.isArray(p.facts) && Object.values(p.facts).every((v) => ['string', 'number', 'boolean'].includes(typeof v)), 'facts must be an object of text, number or true/false values');
  if (has('eeoSkipped')) need(strList(p.eeoSkipped), 'eeoSkipped must be a list of field labels the person skipped');
  if (has('eeoText')) need(isStr(p.eeoText), 'eeoText must be the person\'s own text');
  if (has('unattended')) {
    const u = p.unattended;
    if (!u || typeof u !== 'object') bad.push('unattended must be an object');
    else {
      for (const k of ['roles', 'places', 'excludeCompanies', 'excludeLevels', 'hosts']) if (u[k] !== undefined) need(strList(u[k]), `unattended.${k} must be a list of strings`);
      for (const k of ['minPay', 'minScore']) if (u[k] !== undefined) need(num(u[k]), `unattended.${k} must be a number`);
      if (u.remote !== undefined) need(typeof u.remote === 'boolean', 'unattended.remote must be true or false');
    }
  }
  return bad;
}
