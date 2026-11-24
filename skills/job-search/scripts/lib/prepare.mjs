import { applyOp, loadState, updateState } from './store.mjs';
import { buildSheet, checkSheet, parseGreenhouseQuestions } from './sheet.mjs';
import { loadAnswers } from './answers.mjs';
import { guardedFetch } from './net.mjs';
import { park, unpark } from './work.mjs';
import { parseWritingResult } from './writing.mjs';

// The sheet check, shared by `J sheet check` and the prepare step: a passing sheet moves a prepared job to apply_ready; a
// failing one parks the job with the reason and the names of what is missing.
export function checkJobSheet(job, live = null) {
  const r = checkSheet(job.sheet, live);
  job.sheet.passed = r.ok;
  if (r.ok) {
    unpark(job);
    if (job.status === 'prepared') job.status = 'apply_ready';
  } else {
    const facts = job.sheet.unanswered.filter((u) => u.factKey).map((u) => u.factKey);
    job.missingFacts = [...new Set(facts)];
    park(job, [job.sheet.eeoMissing ? 'eeo_missing' : facts.length && facts.length === job.sheet.unanswered.length ? 'needs_facts' : job.sheet.unanswered.length ? 'unknown_field' : job.sheet.forbidden.length ? 'forbidden_field' : 'form_changed']);
  }
  return r;
}

// Required free-text questions that no fact, earlier answer or draft covers: the only work a writer is for. A fact the
// profile lacks is a question to the person; a draft that failed its checks stops the job.
export const writableFields = (sheet) => (sheet.unanswered || []).filter((u) => !u.factKey && !/^draft failed/.test(u.why));

const questionsUrl = (job) => {
  const ep = job.employerPosting;
  return ep && ep.system === 'greenhouse' && ep.token && ep.jobId ? `https://boards-api.greenhouse.io/v1/boards/${ep.token}/jobs/${ep.jobId}?questions=true` : null;
};

// Prepare in code. A shortlisted job's sheet is built from its questions (Greenhouse publishes them; Lever and Ashby need the
// browser first, which stays a model step). A sheet with no new writing is checked and goes straight to apply_ready, with no
// model. A sheet that needs writing waits for the round's one writer call.
export async function prepareInCode({ fetch, profile }) {
  const fetched = {};
  for (const j of Object.values(loadState().jobs)) {
    if (j.status !== 'shortlisted' || j.questions || j.questionsTried || !fetch) continue;
    const url = questionsUrl(j);
    if (!url) continue;
    try {
      const res = await guardedFetch(url, {}, fetch);
      if (res.ok) fetched[j.key] = parseGreenhouseQuestions(await res.json());
    } catch {}
  }
  return updateState((s) => {
    const out = { ready: [], needsWriting: [], waiting: [] };
    const answers = loadAnswers().entries;
    for (const j of Object.values(s.jobs)) {
      if (j.status !== 'shortlisted') continue;
      if (!j.questions && fetched[j.key]) j.questions = fetched[j.key];
      if (!j.questions) {
        if (fetch && questionsUrl(j) && !j.questionsTried) j.questionsTried = true; // a failed fetch: the model step takes it
        out.waiting.push(j.key);
        continue;
      }
      if (j.needsWriting && !Object.keys(j.drafts || {}).length) continue; // waits for the round's writer call
      const sheet = buildSheet({ job: j, questions: j.questions, profile, answers, drafts: j.drafts || {} });
      j.sheet = { ...sheet, passed: false };
      if (writableFields(sheet).length) {
        j.needsWriting = true;
        out.needsWriting.push(j.key);
        continue;
      }
      j.needsWriting = false;
      applyOp(s, { op: 'transition', key: j.key, to: 'prepared' });
      checkJobSheet(j);
      out.ready.push(j.key);
    }
    return out;
  });
}

// The round's writer result for the sheets: each job's drafts are checked, the sheet is rebuilt and checked, and a passing
// sheet moves on. A failed answer stops that job and goes in the report.
export function applyRoundDrafts(state, answers, profile) {
  const res = { written: 0, stopped: 0 };
  const known = loadAnswers().entries;
  for (const [key, obj] of Object.entries(answers || {})) {
    const j = state.jobs[key];
    if (!j || j.status !== 'shortlisted' || !j.questions) continue;
    const want = new Set(writableFields(j.sheet || { unanswered: [] }).map((u) => u.label));
    const r = parseWritingResult(JSON.stringify(obj || {}), j.questions.filter((q) => want.has(q.label)), profile);
    j.drafts = { ...(j.drafts || {}), ...r.drafts };
    if (!r.ok) {
      j.status = 'stopped';
      j.needsWriting = false;
      state.held.push({ reason: 'stopped', detail: `${j.company}: writing failed` });
      res.stopped++;
      continue;
    }
    j.needsWriting = false;
    const sheet = buildSheet({ job: j, questions: j.questions, profile, answers: known, drafts: j.drafts });
    j.sheet = { ...sheet, passed: false };
    applyOp(state, { op: 'transition', key, to: 'prepared' });
    checkJobSheet(j);
    res.written++;
  }
  return res;
}
