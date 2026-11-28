import { RouterClient, runRound } from './router.mjs';
import { loadState, updateState } from './store.mjs';
import { fillNeed, recordHeld, clearHeld } from './routed.mjs';
import { addEmail } from './dedupe.mjs';
import { addressFor } from './email.mjs';
import { domainOfEmail } from './postinfo.mjs';
import { graph } from './graph.mjs';
import { centsOf } from './prices.mjs';

// The work email lookup charges on a miss, so it runs only when the person picks Email for a lead found by a post, and after
// review for a lead found by fit. A published address needs no lookup. Two needs, one after the other: the address, then the check.
// A found free-mail address is dropped at once and never stored as usable.
const iso = (now) => new Date(now).toISOString();
const spend = (state, need, r, now) => state.spend.push({ at: iso(now), kind: need.kind, cents: centsOf(r.cost), cost: r.cost, leads: 0 });

export function lookupNeeds(state, lead) {
  const p = state.people[lead.personKey];
  const a = addressFor(state, lead);
  if (a.addr) return { done: true, reason: a.source === 'post' ? 'published' : 'found' };
  const found = p.emails.find((e) => e.source === 'lookup' && !graph().freeMail.includes(domainOfEmail(e.addr)));
  if (found && a.problem === 'not_checked') return { check: found.addr };
  if (a.problem && !['no_address'].includes(a.problem)) return { done: true, reason: a.problem, problem: a.problem };
  if (p.lookupDone) return { done: true, reason: 'looked_up', problem: p.lookupDone === 'miss' ? 'no_address' : p.lookupDone };
  const name = p.name || lead.author;
  if (!name || !p.domain) return { done: true, reason: 'missing', problem: p.domain ? 'no_name' : 'no_company_domain' };
  return { enrich: fillNeed('person_enrichment', { name, domain: p.domain }) };
}

export async function resolveAddress({ leadKey, client = new RouterClient(), now = Date.now(), save }) {
  const lead = loadState().leads[leadKey];
  if (!lead) throw new Error(`unknown lead: ${leadKey}`);
  let plan = lookupNeeds(loadState(), lead);
  const out = { lookups: 0 };
  if (plan.enrich) {
    const need = plan.enrich;
    const [r] = await runRound([need], { client, save });
    out.lookups++;
    updateState((s) => {
      const p = s.people[lead.personKey];
      if (!r.ok) { recordHeld(s, need, r); out.held = { status: r.status, reason: r.reason }; return; }
      clearHeld(s, need);
      spend(s, need, r, now);
      if (!r.ingest.email) { p.lookupDone = 'miss'; return; }
      if (graph().freeMail.includes(domainOfEmail(r.ingest.email))) { p.lookupDone = 'free_mail_dropped'; return; }
      addEmail(p, r.ingest.email, 'lookup', null);
      p.lookupDone = 'found';
    });
    plan = lookupNeeds(loadState(), loadState().leads[leadKey]);
  }
  if (plan.check) {
    const need = fillNeed('email_check', { email: plan.check });
    const [r] = await runRound([need], { client, save });
    out.lookups++;
    updateState((s) => {
      const p = s.people[lead.personKey];
      if (!r.ok) { recordHeld(s, need, r); out.held = { status: r.status, reason: r.reason }; return; }
      clearHeld(s, need);
      spend(s, need, r, now);
      addEmail(p, plan.check, 'lookup', r.ingest.status);
    });
  }
  const st = loadState();
  const a = addressFor(st, st.leads[leadKey]);
  const final = lookupNeeds(st, st.leads[leadKey]);
  return { ...out, address: a.addr || null, source: a.source || null, problem: a.addr ? null : (final.problem || a.problem || null) };
}
