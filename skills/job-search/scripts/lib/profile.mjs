// The shape of profile.json, checked when it is set, so a bad shape never reaches the sweep.
const isStr = (v) => typeof v === 'string';
const strList = (v) => Array.isArray(v) && v.every(isStr);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function validateProfile(p) {
  const bad = [];
  const need = (ok, msg) => ok || bad.push(msg);
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['the profile must be a JSON object'];
  const has = (k) => p[k] !== undefined;
  if (has('places')) need(strList(p.places), 'places must be a list of strings, for example ["San Francisco"]');
  for (const k of ['remote', 'includeOld', 'updates', 'hn']) if (has(k)) need(typeof p[k] === 'boolean', `${k} must be true or false`);
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
  if (has('eeo')) need(p.eeo === 'decline_all' || (p.eeo && typeof p.eeo === 'object' && p.eeo.answers && typeof p.eeo.answers === 'object'), 'eeo must be "decline_all" or {"answers": {"<question>": "<answer>"}}');
  if (has('careerOps')) need(p.careerOps && typeof p.careerOps === 'object' && isStr(p.careerOps.dir) && (p.careerOps.pipeline === undefined || typeof p.careerOps.pipeline === 'boolean'), 'careerOps must be {"dir": "<folder>", "pipeline": true|false}');
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
