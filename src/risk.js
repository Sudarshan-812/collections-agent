/**
 * risk.js — for every invoice still open as of the ledger date (2026-08-26),
 * flag how likely it is to "go late" (not be fully paid by its due_date), with
 * plain-English reasons.
 *
 * Deliberately a transparent additive score, not a model. The five features are
 * config/policy.json's risk_flagging.factors:
 *
 *   customer_historical_avg_days_late   how late this customer settles, from
 *                                       payments.csv vs invoices.csv (paid history)
 *   customer_dispute_rate               dispute-type inbound replies from this customer
 *   invoice_amount_vs_customer_median   this invoice vs the customer's median invoice
 *   days_until_due                      runway left before due_date (negative = already past due)
 *   existing_open_dispute_or_hold_state frozen / held / hard-stopped / promise state
 *                                       for this invoice or another of the customer's,
 *                                       taken from the replay (src/replay.js)
 *
 * Each factor adds points; total maps to high (>=5) / medium (>=2) / low.
 * Output: out/risk_flags.json.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLedger, getLedgerAsOf, LEDGER_DATE } from './ledger.js';
import { loadPolicy } from './policy.js';
import { runReplay } from './replay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'out');
const OUT_PATH = join(OUT_DIR, 'risk_flags.json');

const DISPUTE_CATEGORIES = new Set(['dispute_amount_or_line_items', 'dispute_reference_mismatch']);

const toMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / 86400000);
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// -----------------------------------------------------------------------

export async function computeRiskFlags({ asOfDate = LEDGER_DATE } = {}) {
  const ledger = loadLedger();
  const policy = loadPolicy();
  const factorList = policy.risk_flagging?.factors ?? [];

  const asOf = getLedgerAsOf(asOfDate);
  const openInvoices = asOf.invoices.filter((i) => !i.is_fully_paid);

  // replay gives us the reply-driven hold/dispute state and the classified replies
  const { stateById, analyses } = await runReplay({ endDate: asOfDate, write: false });

  // ---- per-customer aggregates -------------------------------------
  const custIds = [...new Set(asOf.invoices.map((i) => i.customer_id))];
  const cust = new Map();
  for (const cid of custIds) {
    const invoices = asOf.invoices.filter((i) => i.customer_id === cid);
    const paid = invoices.filter((i) => i.is_fully_paid && i.last_payment_date);
    const daysLate = paid.map((i) => daysBetween(i.due_date, i.last_payment_date));
    cust.set(cid, {
      medianInvoice: median(invoices.map((i) => i.amount)),
      paidCount: paid.length,
      avgDaysLate: daysLate.length ? daysLate.reduce((a, b) => a + b, 0) / daysLate.length : null,
      latePct: daysLate.length ? daysLate.filter((d) => d > 0).length / daysLate.length : null,
      disputeReplies: 0,
      totalReplies: 0,
    });
  }

  for (const { reply, classification } of analyses) {
    const inv = ledger.invoicesById.get(reply.invoice_id);
    if (!inv) continue;
    const c = cust.get(inv.customer_id);
    if (!c) continue;
    c.totalReplies += 1;
    if (DISPUTE_CATEGORIES.has(classification.category)) c.disputeReplies += 1;
  }

  // ---- customer-level hold map: only OPEN invoices in a dispute/hold state ----
  // (a hold left on an already-paid invoice is moot; and the customer-wide legal/
  //  churn hard-stop tags every invoice, so we must not drag paid history in here)
  const openIds = new Set(openInvoices.map((i) => i.invoice_id));
  const holdByCustomer = new Map();
  for (const [invId, st] of stateById) {
    if (!openIds.has(invId)) continue;
    const kind = holdKind(st);
    if (!kind) continue;
    const cid = ledger.invoicesById.get(invId)?.customer_id;
    if (!cid) continue;
    if (!holdByCustomer.has(cid)) holdByCustomer.set(cid, []);
    holdByCustomer.get(cid).push({ invoice_id: invId, kind });
  }

  // ---- score each open invoice -----------------------------------
  const flags = openInvoices.map((inv) =>
    scoreInvoice(inv, {
      asOfDate,
      cust: cust.get(inv.customer_id),
      state: stateById.get(inv.invoice_id) || {},
      customerHolds: holdByCustomer.get(inv.customer_id) || [],
    }),
  );

  const rank = { high: 0, medium: 1, low: 2 };
  flags.sort(
    (a, b) => rank[a.risk] - rank[b.risk] || b.score - a.score || a.invoice_id.localeCompare(b.invoice_id),
  );

  return { asOfDate, factorList, flags };
}

function holdKind(st) {
  if (!st) return null;
  if (st.stopped && st.stopped !== 'payment-confirmed') return `stopped:${st.stopped}`;
  if (st.frozen) return `frozen:${st.frozen}`;
  if (st.held) return `held:${st.held}`;
  return null;
}

function scoreInvoice(inv, { asOfDate, cust, state, customerHolds }) {
  const reasons = [];
  const factorsTriggered = new Set();
  let score = 0;
  const add = (factor, pts, why) => {
    score += pts;
    factorsTriggered.add(factor);
    reasons.push(why);
  };

  const daysUntilDue = daysBetween(asOfDate, inv.due_date);
  const med = cust?.medianInvoice ?? null;
  const ratio = med ? inv.amount / med : 1;

  // 1. customer_historical_avg_days_late
  if (cust?.avgDaysLate == null) {
    reasons.push('no settled invoices for this customer yet — no payment-timing baseline');
  } else {
    const a = Math.round(cust.avgDaysLate);
    const latePctTxt = cust.latePct != null ? `${Math.round(cust.latePct * 100)}% of past invoices paid after due` : '';
    if (a >= 15) add('customer_historical_avg_days_late', 2, `customer settles ${a}d late on average (${latePctTxt})`);
    else if (a >= 5) add('customer_historical_avg_days_late', 1, `customer settles ~${a}d late on average`);
    else if (a <= 0) reasons.push(`customer settles on time on average (${a >= 0 ? '+' : ''}${a}d vs due) — protective`);
    else reasons.push(`customer settles ~${a}d late on average — minor`);
  }

  // 2. customer_dispute_rate
  if ((cust?.disputeReplies ?? 0) >= 2) {
    add('customer_dispute_rate', 2, `${cust.disputeReplies} dispute replies from this customer in the reply history`);
  } else if ((cust?.disputeReplies ?? 0) === 1) {
    add('customer_dispute_rate', 1, '1 dispute reply from this customer in the reply history');
  }

  // 3. invoice_amount_vs_customer_median
  if (med) {
    if (ratio >= 2) {
      add('invoice_amount_vs_customer_median', 2, `invoice is ${ratio.toFixed(1)}x the customer's median invoice (${money(inv.amount)} vs ${money(med)})`);
    } else if (ratio >= 1.4) {
      add('invoice_amount_vs_customer_median', 1, `invoice is ${ratio.toFixed(1)}x the customer's median invoice`);
    } else if (ratio <= 0.6) {
      reasons.push(`invoice is only ${ratio.toFixed(1)}x the customer's median — low exposure`);
    }
  }

  // 4. days_until_due
  if (daysUntilDue < 0) {
    add('days_until_due', 3, `already ${-daysUntilDue}d past due and still unpaid (${money(inv.open_amount)} outstanding) — has effectively already gone late`);
  } else if (daysUntilDue <= 5) {
    add('days_until_due', 1, `only ${daysUntilDue}d until due with ${money(inv.open_amount)} unpaid`);
  } else if (daysUntilDue >= 30) {
    reasons.push(`${daysUntilDue}d of runway before due`);
  } else {
    reasons.push(`${daysUntilDue}d until due`);
  }

  // 5. existing_open_dispute_or_hold_state
  const kind = holdKind(state);
  if (kind) {
    const detail = kind.split(':')[1];
    if (detail === 'legal-counsel-invoked') {
      add('existing_open_dispute_or_hold_state', 3, 'customer has referred this account to legal counsel — automation hard-stopped');
    } else if (detail === 'churn-threat') {
      add('existing_open_dispute_or_hold_state', 3, 'customer has threatened to move the account over collections contact');
    } else if (detail === 'bounced-contact') {
      add('existing_open_dispute_or_hold_state', 2, 'the AP contact for this invoice has bounced — we currently cannot reach them');
    } else if (kind.startsWith('frozen')) {
      add('existing_open_dispute_or_hold_state', 2, `this invoice is in a frozen escalation state from an inbound reply (${detail})`);
    } else if (kind.startsWith('held')) {
      add('existing_open_dispute_or_hold_state', 2, `this invoice is held for human review (${detail})`);
    }
  }
  if (state.suppressUntil && state.suppressUntil > asOfDate) {
    add('existing_open_dispute_or_hold_state', 1, `promise-to-pay in effect until ${state.suppressUntil}; invoice still unpaid, escalation clock paused`);
  }
  const otherHolds = customerHolds.filter((h) => h.invoice_id !== inv.invoice_id);
  const ownCustomerWideStop = kind && kind.startsWith('stopped:') && (kind.includes('legal-counsel') || kind.includes('churn'));
  if (otherHolds.length && !ownCustomerWideStop) {
    // ...otherwise it's the same customer-wide event already counted above
    const ids = otherHolds.map((h) => h.invoice_id);
    const shown = ids.slice(0, 3).join(', ') + (ids.length > 3 ? `, +${ids.length - 3} more` : '');
    add(
      'existing_open_dispute_or_hold_state',
      1,
      `${ids.length} other open invoice${ids.length > 1 ? 's' : ''} for this customer ${ids.length > 1 ? 'are' : 'is'} disputed/held (${shown})`,
    );
  }

  const risk = score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';

  return {
    invoice_id: inv.invoice_id,
    customer_id: inv.customer_id,
    risk,
    reasons,
    score,
    factors_triggered: [...factorsTriggered],
    signals: {
      days_until_due: daysUntilDue,
      open_amount: inv.open_amount,
      amount_vs_customer_median: med ? Number(ratio.toFixed(2)) : null,
      customer_avg_days_late: cust?.avgDaysLate == null ? null : Math.round(cust.avgDaysLate),
      customer_dispute_replies: cust?.disputeReplies ?? 0,
      hold_state: kind || null,
    },
  };
}

// -----------------------------------------------------------------------

async function main() {
  const { asOfDate, flags } = await computeRiskFlags();

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(flags, null, 2) + '\n');

  const by = (r) => flags.filter((f) => f.risk === r);
  console.log('=== risk.js ===');
  console.log(`open invoices as of ${asOfDate}: ${flags.length}`);
  console.log(`  high  : ${by('high').length}`);
  console.log(`  medium: ${by('medium').length}`);
  console.log(`  low   : ${by('low').length}`);
  console.log(`-> out/risk_flags.json\n`);

  for (const bucket of ['high', 'medium']) {
    console.log(`--- ${bucket.toUpperCase()} ---`);
    for (const f of by(bucket)) {
      console.log(`${f.invoice_id}  ${f.customer_id}  score ${f.score}`);
      for (const r of f.reasons) console.log(`   - ${r}`);
    }
    console.log('');
  }

  console.log('--- LOW (one-liners) ---');
  for (const f of by('low')) {
    console.log(`${f.invoice_id}  ${f.customer_id}  score ${f.score}  (${f.signals.days_until_due}d to due)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
