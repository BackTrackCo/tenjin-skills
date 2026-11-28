// What a post's own text holds, found by code and never guessed: links, published email addresses and handles.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const trim = (u) => u.replace(/[.,;:!?]+$/, '');

export const linksIn = (text) => [...new Set(((String(text || '').match(URL_RE)) || []).map(trim))];
export const emailsIn = (text) => [...new Set(((String(text || '').match(EMAIL_RE)) || []).map((e) => e.toLowerCase().replace(/[.,;:!?]+$/, '')))];
export const domainOfEmail = (a) => (String(a).toLowerCase().split('@')[1] || '').trim();
// An address "obfuscated" in a post ("name at host dot com") is not published for this skill's purposes: only an exact address counts.

// An email the poster published: kept only when it appears word for word in the post text.
export function publishedEmail(text) {
  const list = emailsIn(text);
  return list.length ? list[0] : null;
}

export function postFacts(post) {
  const text = String(post.text || '');
  return { links: [...new Set([...(post.links || []), ...linksIn(text)])], emails: emailsIn(text), emailFromPost: publishedEmail(text) };
}

// A post that addresses an AI agent, or tells a reader to ignore its instructions, is data left alone (injection_suspected).
const INJECTION = [
  /\b(ignore|disregard|forget)\b[^.!?\n]{0,40}\b(previous|prior|above|earlier|all|your|these)\b[^.!?\n]{0,30}\b(instructions?|rules?|prompts?|messages?)\b/i,
  /\b(if you are|attention|hey|hello|dear|note to|message for|calling)\s+(an?\s+|the\s+)?(ai|llm|a\.i\.|language model|assistant|agent|claude|chatgpt|gpt|copilot|bot)\b/i,
  /\bas an? (ai|llm|language model|assistant)\b[^.!?\n]{0,60}\b(you must|you should|do not|never|always)\b/i,
  /\b(system prompt|new instructions?|override)\b[^.!?\n]{0,40}\b(you|agent|assistant|model)\b/i,
  /\byou (must|should|are required to)\b[^.!?\n]{0,40}\b(send|email|reply to|forward|reveal|share)\b[^.!?\n]{0,60}\b(this|api key|password|token|secret|wallet)\b/i,
];
export const injectionSuspected = (text) => INJECTION.some((re) => re.test(String(text || '')));

// The post's own link to a page worth reading is shown to the person, never fetched: links are data.
export const strip = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
