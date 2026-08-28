/**
 * replay.js — dry-run the collections agent across the full invoice history,
 * one simulated day at a time, from the earliest issue_date to the ledger date
 * (2026-08-26). Nothing is sent; every decision is written to
 * out/replay_log.jsonl.
 *
 * Each simulated day:
 *   1. Apply any inbound reply dated that day (src/replies.js) to the referenced
 *      invoice's state per its category's action in config/policy.json:
 *      freeze the escalation clock, hard-stop contact, mark paid, suppress until
 *      a promised date + grace, redirect the AP contact, etc. A reply whose
 *      invoice_id matches nothing real is logged, not dropped.
 *   2. For every invoice NOT frozen / held / hard-stopped / suppressed / already
 *      paid, run src/policy.js's per-day decision against getLedgerAsOf(day)
 *      only — no lookahead.
 *   3. Append each decision to the log with a rendered email body.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLedger, getLedgerAsOf, LEDGER_DATE } from './ledger.js';
import { loadPolicy, createInvoiceState, applyDecision, decideForInvoice } from './policy.js';
import { analyzeAll } from './replies.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'out');
const LOG_PATH = join(OUT_DIR, 'replay_log.jsonl');

// --- date helpers (ISO 'YYYY-MM-DD') --------------------------------------
const DAY_MS = 86400000;
const toMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => toIso(toMs(iso) + n * DAY_MS);
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// --- reply category -> state action -------------------------------------
const FREEZE_CATEGORIES = new Set([
  'dispute_amount_or_line_items',
  'dispute_reference_mismatch',
  'missing_invoice_or_po_request',
  'request_statement_or_documents',
]);
const HOLD_CATEGORIES = new Set(['payment_plan_proposal', 'ambiguous_or_unclear']);

// --- email templates, one per policy tone ------------------------------
const SUBJECT_LABEL = {
  friendly_heads_up: 'courtesy reminder',
  reminder: 'due today',
  firm_reminder: 'now overdue',
  escalation: 'overdue — escalation',
  urgent: 'URGENT — overdue',
  final_notice: 'FINAL NOTICE',
};

const TEMPLATES = {
  friendly_heads_up: (c) =>
`Hi ${c.first},

Quick courtesy note: invoice ${c.id} for ${c.amount} is due on ${c.due}. Nothing needed yet — just flagging it early so it doesn't slip.

Thanks,
${c.sender}
Accounts Receivable`,

  reminder: (c) =>
`Hi ${c.first},

A reminder that invoice ${c.id} for ${c.amount} is due today (${c.due}). Please arrange payment when you can, or let me know if something is holding it up.

Thanks,
${c.sender}
Accounts Receivable`,

  firm_reminder: (c) =>
`Hi ${c.first},

Invoice ${c.id} for ${c.amount} was due on ${c.due} and is now ${c.overdue} days overdue. Please arrange payment, or reply to let me know if there is an issue we can help resolve.

Thanks,
${c.sender}
Accounts Receivable`,

  escalation: (c) =>
`Hi ${c.first},

I'm escalating invoice ${c.id} for ${c.amount}, now ${c.overdue} days overdue (due ${c.due}). Reminders to ${c.apName} in accounts payable haven't resolved it. Could you help get this paid this week, or point me to the right person?

Thanks,
${c.sender}
Accounts Receivable`,

  urgent: (c) =>
`Hi ${c.first},

Invoice ${c.id} for ${c.amount} is ${c.overdue} days overdue (due ${c.due}). Reminders to accounts payable and to the controller have gone unanswered. We need either payment or a firm payment date by return.

Your account team is copied on this note.

Regards,
${c.sender}
Accounts Receivable`,

  final_notice: (c) =>
`Hi ${c.first},

This is a final notice before invoice ${c.id} for ${c.amount} (${c.overdue} days overdue, due ${c.due}) is referred for collections. Please contact us within 5 business days to arrange payment or agree a plan.

Regards,
${c.sender}
Accounts Receivable`,
};

function renderMessage(decision, view) {
  const to = view.contacts?.[decision.recipient_tier] || {};
  const ap = view.contacts?.ap_contact || {};
  const sender = view.contacts?.collections?.name || 'Accounts Receivable';
  const ctx = {
    first: (to.name || 'there').split(' ')[0],
    id: decision.invoice_id,
    amount: money(view.amount),
    due: view.due_date,
    overdue: Math.max(0, decision.day_offset),
    apName: ap.name || 'accounts payable',
    sender,
  };
  const body = (TEMPLATES[decision.tone] || TEMPLATES.reminder)(ctx);
  const subject = `Invoice ${decision.invoice_id} — ${SUBJECT_LABEL[decision.tone] || 'payment reminder'}`;
  const summary =
    `${decision.tier_id} to ${decision.recipient_tier} <${decision.recipient_email ?? 'no-email'}> — ` +
    `${decision.invoice_id} ${ctx.amount}, due ${ctx.due}` +
    (ctx.overdue > 0 ? `, ${ctx.overdue}d overdue` : '') +
    (decision.held_for_human ? ' [HELD FOR HUMAN SIGN-OFF]' : '');
  return { body, subject, summary };
}

function firstNewEmail(reply) {
  const found = reply.body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
  return found.find((e) => e.toLowerCase() !== reply.from.toLowerCase()) || null;
}

function createReplayState() {
  return {
    ...createInvoiceState(),
    frozen: null, // freeze_escalation_clock — dispute / missing doc / statement request
    held: null, // hold_for_human — payment plan / ambiguous / unverified paid-claim
    stopped: null, // hard stop — bounced / legal / churn / payment-confirmed
    suppressUntil: null, // promise_to_pay window end (promised date + grace)
    contactOverride: null, // { tier, email } from contact_change
  };
}

// -----------------------------------------------------------------------
// the replay
// -----------------------------------------------------------------------

export async function runReplay({ endDate = LEDGER_DATE, write = true } = {}) {
  const ledger = loadLedger();
  const policy = loadPolicy();
  const analyses = await analyzeAll({ ledger, policy });

  const repliesByDate = new Map();
  for (const a of analyses) {
    if (!repliesByDate.has(a.reply.date)) repliesByDate.set(a.reply.date, []);
    repliesByDate.get(a.reply.date).push(a);
  }

  const startDate = ledger.invoices.reduce(
    (min, i) => (i.issue_date < min ? i.issue_date : min),
    ledger.invoices[0].issue_date,
  );

  const stateById = new Map();
  const log = [];
  const push = (obj) => log.push(obj);

  // --- reply application (step 1) ---
  function applyReply(analysis, day) {
    const { reply, classification, check } = analysis;
    const cat = classification.category;
    const id = reply.invoice_id;
    const realInv = id ? ledger.invoicesById.get(id) : null;

    if (!realInv) {
      push({
        type: 'reply-unmatched-invoice',
        date: day,
        reply_file: reply.file,
        referenced_invoice_id: id,
        category: cat,
        note: 'reply references an invoice_id not present in invoices.csv — not applied to any invoice',
      });
      return;
    }

    const st = stateById.get(id) || createReplayState();
    stateById.set(id, st);
    let actionTaken;

    switch (cat) {
      case 'already_paid_claim':
        if (check.verified === true) {
          st.stopped = 'payment-confirmed';
          actionTaken = 'mark paid, stop all contact (payment verified in payments.csv)';
        } else {
          st.held = 'unverified-paid-claim';
          actionTaken = 'hold for human — payment claim NOT found in payments.csv';
        }
        break;

      case 'promise_to_pay': {
        const grace = policy.reply_handling.categories.promise_to_pay.grace_days ?? 3;
        const until = check.suppress_until || addDays(day, grace);
        st.suppressUntil = until;
        actionTaken = `suppress escalation until ${until} (promised ${check.promised_date ?? '?'} + ${grace}d grace)`;
        break;
      }

      case 'contact_change': {
        const email = firstNewEmail(reply);
        st.contactOverride = { tier: 'ap_contact', email: email || null };
        actionTaken = email
          ? `redirect ap_contact to ${email}, continue cadence`
          : 'contact change noted (no new address parsed), continue cadence';
        break;
      }

      case 'bounced_or_invalid_contact':
        st.stopped = 'bounced-contact';
        actionTaken = 'hard-stop contact for this invoice (address bounced); notify sales_owner';
        break;

      case 'legal_escalation':
      case 'explicit_stop_request_or_churn_threat': {
        const kind = cat === 'legal_escalation' ? 'legal-counsel-invoked' : 'churn-threat';
        let n = 0;
        for (const ci of ledger.invoices) {
          if (ci.customer_id !== realInv.customer_id) continue;
          const cst = stateById.get(ci.invoice_id) || createReplayState();
          cst.stopped = kind;
          stateById.set(ci.invoice_id, cst);
          n += 1;
        }
        actionTaken = `hard-stop ALL automation for customer ${realInv.customer_id} (${n} invoices) — ${kind}`;
        break;
      }

      case 'auto_reply_or_ack':
        actionTaken = 'no state change — automated acknowledgement, resume normal cadence';
        break;

      default:
        if (FREEZE_CATEGORIES.has(cat)) {
          st.frozen = cat;
          actionTaken = `freeze escalation clock (${cat})`;
        } else if (HOLD_CATEGORIES.has(cat)) {
          st.held = cat;
          actionTaken = `hold for human (${cat})`;
        } else {
          st.held = cat;
          actionTaken = `hold for human (unrecognised category ${cat})`;
        }
    }

    push({
      type: 'reply-applied',
      date: day,
      reply_file: reply.file,
      invoice_id: id,
      customer_id: realInv.customer_id,
      category: cat,
      classified_by: classification.matched_by,
      verified: check.verified ?? null,
      action_taken: actionTaken,
      ledger_fact: check.fact,
    });

    for (const unk of check.unknown_invoice_ids || []) {
      push({
        type: 'reply-unknown-reference',
        date: day,
        reply_file: reply.file,
        referenced_invoice_id: unk,
        note: 'mentioned in the reply body but not present in invoices.csv',
      });
    }
  }

  // --- day-by-day loop ---
  let dayCount = 0;
  for (let ms = toMs(startDate); ms <= toMs(endDate); ms += DAY_MS) {
    const day = toIso(ms);
    dayCount += 1;

    for (const a of repliesByDate.get(day) || []) applyReply(a, day);

    const asOf = getLedgerAsOf(day);
    for (const inv of asOf.invoices) {
      if (inv.is_fully_paid) continue;

      const st = stateById.get(inv.invoice_id);
      if (st) {
        if (st.stopped || st.frozen || st.held) continue;
        if (st.suppressUntil && day <= st.suppressUntil) continue;
      }
      const state = st || createReplayState();

      const view = state.contactOverride
        ? {
            ...inv,
            contacts: {
              ...inv.contacts,
              [state.contactOverride.tier]: {
                ...(inv.contacts[state.contactOverride.tier] || {}),
                email: state.contactOverride.email || inv.contacts[state.contactOverride.tier]?.email,
              },
            },
          }
        : inv;

      const decision = decideForInvoice(view, day, state, { policy });
      if (!decision) continue;

      stateById.set(inv.invoice_id, state);
      applyDecision(state, decision);

      const msg = renderMessage(decision, view);
      push({
        type: 'decision',
        date: day,
        invoice_id: decision.invoice_id,
        customer_id: inv.customer_id,
        tier_id: decision.tier_id,
        recipient_tier: decision.recipient_tier,
        recipient_email: decision.recipient_email,
        cc: decision.cc_emails,
        disposition: decision.held_for_human ? 'held-for-human' : 'auto-send',
        auto_send: decision.auto_send,
        day_offset: decision.day_offset,
        tone: decision.tone,
        subject: msg.subject,
        message_summary: msg.summary,
        message_body: msg.body,
        reason: decision.reason,
      });
    }
  }

  if (write) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(LOG_PATH, log.map((o) => JSON.stringify(o)).join('\n') + '\n');
  }

  return { log, startDate, endDate, dayCount, stateById, analyses };
}

// -----------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------

function print5(log, id) {
  const rows = log.filter((l) => l.invoice_id === id || l.referenced_invoice_id === id);
  console.log(`\n${id} — ${rows.length} log ${rows.length === 1 ? 'entry' : 'entries'}`);
  if (rows.length === 0) {
    console.log('  (nothing — agent stayed silent for this invoice across the whole replay)');
    return;
  }
  for (const r of rows) {
    if (r.type === 'decision') {
      console.log(`  ${r.date}  DECISION  ${r.tier_id} -> ${r.recipient_tier}  [${r.disposition}]`);
      console.log(`            reason: ${r.reason}`);
    } else if (r.type === 'reply-applied') {
      console.log(`  ${r.date}  REPLY     ${r.category} (${r.reply_file}) verified=${r.verified}`);
      console.log(`            action: ${r.action_taken}`);
    } else {
      console.log(`  ${r.date}  ${r.type.toUpperCase()}  ${r.reply_file || ''} ${r.note || ''}`);
    }
  }
}

export async function runReplayCli() {
  const { log, startDate, endDate, dayCount } = await runReplay();

  const decisions = log.filter((l) => l.type === 'decision');
  const autoSend = decisions.filter((l) => l.disposition === 'auto-send');
  const held = decisions.filter((l) => l.disposition === 'held-for-human');
  const repliesApplied = log.filter((l) => l.type === 'reply-applied');
  const unmatched = log.filter((l) => l.type === 'reply-unmatched-invoice');
  const unknownRefs = log.filter((l) => l.type === 'reply-unknown-reference');

  console.log('=== replay.js ===');
  console.log(`window            : ${startDate} .. ${endDate}  (${dayCount} days)`);
  console.log(`lines written     : ${log.length}   -> out/replay_log.jsonl`);
  console.log(`  decisions       : ${decisions.length}`);
  console.log(`    auto-send     : ${autoSend.length}`);
  console.log(`    held-for-human: ${held.length}`);
  console.log(`  replies applied : ${repliesApplied.length}`);
  console.log(`  unmatched reply invoice : ${unmatched.length}`);
  console.log(`  unknown refs in replies : ${unknownRefs.length}  (${unknownRefs.map((r) => r.referenced_invoice_id).join(', ') || '—'})`);

  const byTier = {};
  for (const d of decisions) byTier[d.tier_id] = (byTier[d.tier_id] || 0) + 1;
  console.log('\ndecisions by tier:');
  for (const [t, n] of Object.entries(byTier)) console.log(`  ${String(n).padStart(4)}  ${t}`);

  console.log('\n--- the 5 trickiest-reply invoices ---');
  for (const id of ['INV-2231', 'INV-2087', 'INV-2430', 'INV-2033', 'INV-2121']) print5(log, id);

  const sample = decisions.find((d) => d.tier_id === 'controller_escalation') || decisions[0];
  if (sample) {
    console.log('\n--- sample rendered email (from the log) ---');
    console.log(`${sample.date}  ${sample.invoice_id}  ${sample.subject}`);
    console.log(sample.message_body);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReplayCli();
}
