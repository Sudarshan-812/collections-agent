/**
 * replies.js - classify inbound customer replies, then cross-check the claim
 * against the real ledger before deciding an outcome.
 *
 * Default path: deterministic regex/keyword rules tuned against the 20 files in
 * data/inbound_replies/. No network calls.
 *
 * Optional path: if process.env.ANTHROPIC_API_KEY is set, classification is
 * delegated to the Anthropic Messages API with the same category list and the
 * same return shape. If that call fails for any reason it falls back to the
 * deterministic rules, so the pipeline always runs.
 *
 * Either way, every classification is reconciled against src/ledger.js: a
 * "claims paid" reply is only treated as paid if payments.csv actually backs
 * it up; a reply that references an invoice we don't have is flagged.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { loadLedger } from './ledger.js';
import { loadPolicy } from './policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPLIES_DIR = join(HERE, '..', 'data', 'inbound_replies');

/** Parse one `NN_reply.txt` into { file, from, date, subject, body, invoice_id, invoice_ids }. */
export function parseReplyFile(path) {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/);
  const header = {};
  let i = 0;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      i++;
      break;
    }
    const m = lines[i].match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!m) break;
    header[m[1].toLowerCase()] = m[2].trim();
  }
  const body = lines.slice(i).join('\n').trim();
  const subject = header.subject || '';
  const allIds = [...new Set((`${subject}\n${body}`.match(/INV-\d+/gi) || []).map((s) => s.toUpperCase()))];
  const subjectIds = (subject.match(/INV-\d+/gi) || []).map((s) => s.toUpperCase());

  return {
    file: basename(path),
    from: header.from || '',
    date: header.date || '',
    subject,
    body,
    invoice_id: subjectIds[0] || allIds[0] || null, // the one the reminder was about
    invoice_ids: allIds, // every INV-id mentioned anywhere
  };
}

// Deterministic classifier: ordered rules, first match wins. Hard-stops
// (bounce / legal / churn) are checked before softer categories.
const RULES = [
  {
    category: 'bounced_or_invalid_contact',
    why: 'bounce sender / SMTP 550 / "undeliverable"',
    pattern:
      /mailer-daemon|postmaster@|mail delivery (subsystem|system)|undeliverable|delivery (to [^.]*)?failed|failed permanently|550[ -]?5\.\d|account [^.]*does not exist|recipient[^.]*rejected|address[^.]*not found/i,
  },
  {
    category: 'legal_escalation',
    why: 'invokes legal counsel / litigation',
    pattern: /legal counsel|our (solicitor|lawyer|attorney)|refer[a-z]*[^.]*legal|litigation|via our legal/i,
  },
  {
    category: 'explicit_stop_request_or_churn_threat',
    why: 'threatens to leave / demands contact stop',
    pattern:
      /take (the|our|my) (whole )?(account|business) elsewhere|(account|business) elsewhere|move (our|my) (account|business)|switch (to another|providers?)|cancel (the|our) (account|contract)|stop (contacting|emailing|chasing) me|do not (contact|email|chase) me again/i,
  },
  {
    category: 'auto_reply_or_ack',
    why: 'out-of-office / ticket-received auto-acknowledgement',
    pattern:
      /no-?reply@|do-?not-?reply@|noreply@|autoresponder|mailer@|automatic reply|auto[- ]?reply|out of (the )?office|on annual leave|this is an automated (response|message)|your message has been received|ticket (has been )?created|\[ticket ?#?\d+\]|received[^.]*portal/i,
  },
  {
    category: 'already_paid_claim',
    why: 'claims invoice already paid / sends remittance advice',
    pattern:
      /remittance advice|\bremitted\b|\bwas paid\b|\bhas been paid\b|\balready (paid|settled)\b|\bpaid (this|it|the invoice|on|in full)\b|payment (was )?(made|sent|released|processed|remitted)|settled (this|it)[^.]*already|nothing outstanding|paid in full/i,
  },
  {
    category: 'payment_plan_proposal',
    why: 'proposes a multi-period or split payment arrangement',
    pattern:
      /payment plan|instal?ments?|spread (the |this )?(payment|balance|cost)|pay[^.]*over (the )?(next )?(two|three|four|five|six|\d+) (weeks|months)|across the next (two|three|four|\d+) months|(\d{1,3}%|half)[^.]*(and|then)[^.]*(balance|remainder|rest|remaining)|(balance|remainder|rest)[^.]*on the \d/i,
  },
  {
    category: 'promise_to_pay',
    why: 'commits to pay by a specific near-term date',
    pattern:
      /(will|we'?ll|we can|can|going to|intend to) (pay|send|remit|clear|settle|transfer|make payment)[^.]*(today|tomorrow|friday|monday|tuesday|wednesday|thursday|next week|this week|month[- ]end|end of[^.]*(week|month)|\d{1,2}(st|nd|rd|th)|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))|scheduled[^.]*payment run|in (our|the)[^.]*payment run|payment run on|balance on the \d|by (the )?end of (the )?(week|month)/i,
  },
  {
    category: 'contact_change',
    why: 'names a different address for future correspondence',
    pattern:
      /(has |have )?left the (business|company)|no longer (with|at|works)|i have left|send (all )?(future )?(invoices|correspondence|statements)[^.]*to [^\s]+@|use [^\s]+@[^\s]+[^.]*(going forward|from now)|update your records|new (email|contact|ap) (address|contact|email)/i,
  },
  {
    category: 'missing_invoice_or_po_request',
    why: 'invoice not received / asks for resend or a PO to be added',
    pattern:
      /never received (this|the|your) invoice|did ?n'?t receive[^.]*invoice|have ?n'?t received[^.]*invoice|don'?t have[^.]*invoice|visibility of the (original )?invoice|resend (it|this|the invoice)|re-?send[^.]*invoice|forward (it|me the|the) (invoice|original)|forward it\b|copy of the invoice|without (a|the) po\b|need (a|the) po\b|with the po number on it|can'?t process[^.]*without (a )?po/i,
  },
  {
    category: 'dispute_reference_mismatch',
    why: 'invoice / PO reference does not match customer records',
    pattern:
      /doesn'?t match anything|does not match anything|match (anything )?in (our|your) system|which invoice is this|do ?n'?t recognise (this )?(invoice|reference)|only open item|[^.]*not[^.]*in our system|wrong (invoice|po|reference)( number)?|po number[^.]*wrong|should be po-|po mismatch|auto-?rejects? on po|reissu/i,
  },
  {
    category: 'dispute_amount_or_line_items',
    why: 'disputes billed amount / hours / rate / line items',
    pattern:
      /can'?t approve|can ?not approve|do ?n'?t accept the amount|do not accept the amounts?|amounts? claimed|hours billed|hours[^.]*(do ?n'?t|don'?t) match|rate on line|line items?|the rate[^.]*(old|wrong)|overcharg|dispute the (amount|charge|invoice)|holding payment until|query (the )?(amount|charge)/i,
  },
  {
    category: 'request_statement_or_documents',
    why: 'asks for a statement of account / reconciliation pack',
    pattern:
      /statement of account|full statement|send (us |me )?(a )?statement|reconcile|reconciliation|last (twelve|12) months|aged? (debt|receivables?) report/i,
  },
];

/** Deterministic classification: always available, no network. */
export function classifyDeterministic(reply) {
  const haystack = `${reply.from}\n${reply.subject}\n${reply.body}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) {
      return { category: rule.category, matched_by: rule.why, source: 'deterministic' };
    }
  }
  return {
    category: 'ambiguous_or_unclear',
    matched_by: 'no rule matched, default to ambiguous, hold for a human',
    source: 'deterministic',
  };
}

// Optional Anthropic path: same input, same output shape.
async function classifyWithAnthropic(reply, categories) {
  const list = Object.keys(categories);
  const system =
    `You classify one inbound accounts-receivable email reply into exactly one category.\n` +
    `Valid categories: ${list.join(', ')}.\n` +
    `Reply ONLY with minified JSON: {"category":"<one valid category>","reason":"<= 12 words"}.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: 200,
      system,
      messages: [
        { role: 'user', content: `From: ${reply.from}\nSubject: ${reply.subject}\n\n${reply.body}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  const parsed = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  if (!list.includes(parsed.category)) {
    throw new Error(`Anthropic returned unknown category: ${parsed.category}`);
  }
  return { category: parsed.category, matched_by: `anthropic: ${parsed.reason || ''}`.trim(), source: 'anthropic' };
}

/** Classify a reply. Uses Anthropic iff ANTHROPIC_API_KEY is set, else deterministic; always falls back. */
export async function classifyReply(reply, { policy } = {}) {
  const pol = policy || loadPolicy();
  const categories = pol.reply_handling.categories;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await classifyWithAnthropic(reply, categories);
    } catch (err) {
      const fb = classifyDeterministic(reply);
      fb.matched_by += ` [anthropic path failed: ${err.message}]`;
      return fb;
    }
  }
  return classifyDeterministic(reply);
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6,
  aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function isoOf(year, monthIdx, day) {
  return new Date(Date.UTC(year, monthIdx, day)).toISOString().slice(0, 10);
}

/**
 * Every resolvable date mentioned in `text`, as ISO strings, ascending.
 * Handles: 2026-08-11, "11 August" / "August 11", "the 30th" (ref month,
 * rolled forward if already past), weekday names (next such day on/after ref).
 * `refDate` (the reply's own Date header) anchors relative expressions.
 */
function extractDates(rawText, refDate) {
  const text = String(rawText).replace(/\s+/g, ' '); // fold line wraps: "on the\n30th" -> "on the 30th"
  const ref = refDate && /^\d{4}-\d{2}-\d{2}$/.test(refDate) ? refDate : null;
  const refYear = Number((ref || `${new Date().getFullYear()}`).slice(0, 4));
  const refMs = ref ? Date.UTC(+ref.slice(0, 4), +ref.slice(5, 7) - 1, +ref.slice(8, 10)) : null;
  const found = new Set();

  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.add(`${m[1]}-${m[2]}-${m[3]}`);

  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/gi)) {
    found.add(isoOf(refYear, MONTHS[m[2].toLowerCase()], Number(m[1])));
  }
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) {
    found.add(isoOf(refYear, MONTHS[m[1].toLowerCase()], Number(m[2])));
  }

  if (refMs != null) {
    // "the 30th" / "on the 3rd" with no month -> that day-of-month, ref month or next
    for (const m of text.matchAll(/\b(?:on |by )?the (\d{1,2})(?:st|nd|rd|th)\b/gi)) {
      const dom = Number(m[1]);
      const rd = new Date(refMs);
      let cand = Date.UTC(rd.getUTCFullYear(), rd.getUTCMonth(), dom);
      if (cand < refMs) cand = Date.UTC(rd.getUTCFullYear(), rd.getUTCMonth() + 1, dom);
      found.add(new Date(cand).toISOString().slice(0, 10));
    }
    // weekday names -> next occurrence on/after ref
    for (const m of text.matchAll(/\b(?:this |next |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
      const target = WEEKDAYS[m[1].toLowerCase()];
      const rd = new Date(refMs);
      let delta = (target - rd.getUTCDay() + 7) % 7;
      if (delta === 0) delta = 7; // "this Friday" said on a Friday means the coming one
      found.add(new Date(refMs + delta * 86400000).toISOString().slice(0, 10));
    }
  }

  return [...found].sort();
}

/** Single best date from free text: the latest resolvable one (when full payment is promised). */
function parseClaimedDate(text, refDate) {
  const all = extractDates(text, refDate);
  return all.length ? all[all.length - 1] : null;
}

function daysBetween(a, b) {
  const p = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  return Math.round(p(b) - p(a));
}

function addDays(iso, n) {
  const ms = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function money(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Reconcile a classification against the real ledger and decide the outcome.
 * Returns { invoice_id, invoice_exists, unknown_invoice_ids, verified, action,
 *           fact, outcome, ...promise extras }.
 */
export function crossCheckLedger(reply, category, ledger, policy) {
  const cats = policy.reply_handling.categories;
  const primaryId = reply.invoice_id;
  const inv = primaryId ? ledger.invoicesById.get(primaryId) : null;
  const unknownMentioned = reply.invoice_ids.filter((id) => !ledger.invoicesById.has(id));
  const extra = unknownMentioned.length
    ? ` Reply also references ${unknownMentioned.join(', ')}, not in our ledger.`
    : '';

  const out = {
    invoice_id: primaryId,
    invoice_exists: Boolean(inv),
    unknown_invoice_ids: unknownMentioned,
    verified: null,
    action: '',
    fact: '',
    outcome: '',
  };

  if (!inv) {
    out.verified = false;
    out.action = category === 'already_paid_claim' ? 'hold_for_human' : 'route_to_collections';
    out.fact =
      `${primaryId ?? '(no invoice id in reply)'} not found in our ledger. ` +
      `Nothing to mark paid or escalate; handle as a reference problem.` + extra;
    out.outcome =
      category === 'already_paid_claim'
        ? 'hold_for_human (claim points at an unknown invoice)'
        : 'route_to_collections (unknown invoice reference)';
    return out;
  }

  const late = daysBetween(inv.due_date, reply.date || inv.due_date);
  const lateStr = late > 0 ? `${late} days late as of the reply` : `not yet due (due ${inv.due_date})`;
  const refDate = reply.date || inv.due_date;

  if (category === 'already_paid_claim') {
    const claimed = parseClaimedDate(`${reply.subject}\n${reply.body}`, refDate);
    if (inv.is_fully_paid) {
      const p = inv.payments[inv.payments.length - 1];
      out.verified = true;
      out.action = cats.already_paid_claim.if_verified_true; // mark_paid_no_further_contact
      out.outcome = cats.already_paid_claim.if_verified_true;
      out.fact =
        `claims paid${claimed ? ` ${claimed}` : ''}, checked payments.csv: TRUE, ` +
        `${inv.payments.length} payment(s) totalling ${money(inv.paid_amount)} ` +
        `(latest ${p.payment_date} by ${p.method}); invoice IS fully paid.` + extra;
    } else {
      out.verified = false;
      out.action = cats.already_paid_claim.if_unverified; // hold_for_human
      out.outcome = cats.already_paid_claim.if_unverified;
      out.fact =
        `claims paid/settled${claimed ? ` ~${claimed}` : ''}, checked payments.csv: ` +
        `no matching payment found; invoice NOT paid (${money(inv.paid_amount)} of ${money(inv.amount)}), ` +
        `${lateStr}. Unverified.` + extra;
    }
    return out;
  }

  if (category === 'promise_to_pay') {
    const promised = parseClaimedDate(`${reply.subject}\n${reply.body}`, refDate);
    const grace = cats.promise_to_pay.grace_days ?? 3;
    out.verified = false;
    out.action = cats.promise_to_pay.action;
    out.promised_date = promised;
    out.suppress_until = promised ? addDays(promised, grace) : null;
    out.outcome = `${cats.promise_to_pay.action}, until ${out.suppress_until ?? 'promised date + grace'} (promised ${promised ?? '?'} + ${grace}d)`;
    out.fact =
      `promises payment${promised ? ` by ${promised}` : ''}, checked payments.csv: not yet paid ` +
      `(${money(inv.paid_amount)} of ${money(inv.amount)}), ${lateStr}. Invoice is real and open, promise is actionable.` +
      extra;
    return out;
  }

  // every other category: the deciding fact is just the true ledger state
  out.verified = inv.is_fully_paid;
  const cfg = cats[category] || {};
  out.action = cfg.action || 'see policy.json';
  out.outcome = (cfg.action || 'see policy.json') + (cfg.notify ? ` (notify ${cfg.notify})` : '');
  out.fact =
    `checked ledger: ${primaryId} is real (${inv.customer?.name ?? inv.customer_id}), ` +
    (inv.is_fully_paid
      ? `already fully paid (${money(inv.paid_amount)}), reply may be moot.`
      : `unpaid, ${money(inv.amount)} outstanding, ${lateStr}.`) +
    extra;
  return out;
}

export async function analyzeReply(path, { ledger, policy } = {}) {
  const led = ledger || loadLedger();
  const pol = policy || loadPolicy();
  const reply = parseReplyFile(path);
  const classification = await classifyReply(reply, { policy: pol });
  const check = crossCheckLedger(reply, classification.category, led, pol);
  return { reply, classification, check };
}

export async function analyzeAll({ dir = REPLIES_DIR, ledger, policy } = {}) {
  const led = ledger || loadLedger();
  const pol = policy || loadPolicy();
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  const results = [];
  for (const f of files) {
    results.push(await analyzeReply(join(dir, f), { ledger: led, policy: pol }));
  }
  return results;
}

// CLI: `node src/replies.js`
async function main() {
  const results = await analyzeAll();
  const usingApi = Boolean(process.env.ANTHROPIC_API_KEY);
  console.log(`=== replies.js: ${results.length} inbound replies ===`);
  console.log(`classifier: ${usingApi ? 'Anthropic API (ANTHROPIC_API_KEY set)' : 'deterministic rules'}\n`);

  const counts = {};
  for (const { reply, classification, check } of results) {
    counts[classification.category] = (counts[classification.category] || 0) + 1;
    const existsTag = check.invoice_exists ? 'in ledger' : 'NOT in ledger';
    console.log(reply.file);
    console.log(`  invoice     : ${reply.invoice_id ?? '(none)'}  (${existsTag})` +
      (reply.invoice_ids.length > 1 ? `   also mentions: ${reply.invoice_ids.filter((x) => x !== reply.invoice_id).join(', ')}` : ''));
    console.log(`  from        : ${reply.from}   ${reply.date}`);
    console.log(`  category    : ${classification.category}   [${classification.matched_by}]`);
    console.log(`  ledger fact : ${check.fact}`);
    console.log(`  outcome     : ${check.outcome}`);
    console.log('');
  }

  console.log('category tally');
  for (const [cat, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(2)}  ${cat}`);
  }

  const paidClaims = results.filter((r) => r.classification.category === 'already_paid_claim');
  console.log('\n"already paid" claims, verified against payments.csv');
  for (const r of paidClaims) {
    console.log(`  ${r.reply.file}  ${r.check.invoice_id}: verified=${r.check.verified}  -> ${r.check.outcome}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
