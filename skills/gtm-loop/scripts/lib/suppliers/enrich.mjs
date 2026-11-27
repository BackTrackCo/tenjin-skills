import { str } from './posts-shared.mjs';

// The work email of a person (found from a name and a company domain) and the check of an address. Both are built from their
// catalog entries, not from a recorded paid answer. The lookup charges on a miss, so code asks for it only when the person picks
// Email for a lead found by a post, or after review for a lead found by fit. Only an address the check calls `valid` is ever sent.
const bare = (v) => str(v).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const enrichment = {
  ANY_HOST: true,
  KIND: 'person_enrichment',
  RECORDED: false,
  NO_CACHE: true,
  mapper: ({ name, domain }) => {
    const n = str(name);
    const d = bare(domain);
    if (!n || !d.includes('.')) throw new Error('the lookup needs a name and a company domain');
    const parts = n.split(/\s+/);
    return { first_name: parts[0], last_name: parts.slice(1).join(' '), name: n, domain: d };
  },
  adapter: (res) => {
    const r = (res && (res.person || res.data || res.result || res)) || {};
    const email = str(r.email || r.work_email || (Array.isArray(r.emails) && r.emails[0] && (r.emails[0].email || r.emails[0])));
    if (!email) return { email: null, status: null };
    if (!EMAIL.test(email)) throw new Error('the lookup answered something that is not an address');
    return { email: email.toLowerCase(), status: str(r.email_status || r.status || r.verification_status) || null };
  },
};

export const check = {
  ANY_HOST: true,
  KIND: 'email_check',
  RECORDED: false,
  NO_CACHE: true,
  mapper: ({ email }) => {
    if (!EMAIL.test(str(email))) throw new Error('not an email address');
    return { email: str(email).toLowerCase() };
  },
  adapter: (res) => {
    const r = (res && (res.data || res.result || res)) || {};
    const status = str(r.status || r.result || r.verdict).toLowerCase();
    if (!status) throw new Error('the check has no status');
    // Only "valid" and "deliverable" count. Accept-all, risky, unknown, disposable and webmail are not sent to.
    return { status: status === 'valid' || status === 'deliverable' ? 'valid' : status };
  },
};
