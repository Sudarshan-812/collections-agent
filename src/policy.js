/**
 * policy.js — single-invoice, single-day escalation decision.
 *
 * Given one invoice (a record from src/ledger.js) and "today", read
 * config/policy.json's `tiers` and decide whether to contact someone today,
 * and if so, whom and how.
 *
 * Rules:
 *   - a fully paid invoice (ledger's derived is_fully_paid, NOT status_raw)
 *     is never contacted
 *   - day_offset = today - due_date (negative = before due)
 *   - pick the highest tier whose day_offset threshold has been crossed
 *   - never contact the same invoice twice within
 *     cadence.min_days_between_contacts days
 *   - never re-fire a tier that was already fired for this invoice
 *   - tiers in always_hold_for_human come back as held-for-human
 *     (auto_send:false) regardless of their own auto_send flag
 *
 * This is deliberately stateful: the caller threads a per-invoice `state`
 * object through the day-by-day simulation and calls `applyDecision` for
 * every decision it acts on, so cadence and per-tier de-dup work. It does
 * NOT recompute history from scratch each day.
 *
 * Reply handling and the replay loop are built elsewhere.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = join(HERE, '..', 'config', 'policy.json');

let _policyCache = new Map();

/** Load + memoize config/policy.json. */
export function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  if (!_policyCache.has(policyPath)) {
    _policyCache.set(policyPath, JSON.parse(readFileSync(policyPath, 'utf8')));
  }
  return _policyCache.get(policyPath);
}

// ---------------------------------------------------------------------------
// date helper — inputs are 'YYYY-MM-DD'
// ---------------------------------------------------------------------------

function toUtcDays(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** Whole calendar days from `a` to `b` (b - a). */
function diffDays(a, b) {
  return Math.round(toUtcDays(b) - toUtcDays(a));
}

/** "+14" / "-5" / "+0" */
function fmtOffset(n) {
  return (n >= 0 ? '+' : '') + n;
}

// ---------------------------------------------------------------------------
// per-invoice state
// ---------------------------------------------------------------------------

/** Fresh contact-tracking state for one invoice. */
export function createInvoiceState() {
  return {
    lastContactDate: null, // 'YYYY-MM-DD' of the most recent contact
    lastTierId: null, // id of the most recently fired tier
    contactCount: 0,
    firedTierIds: [], // every tier fired so far, in order
  };
}

/**
 * Record that `decision` was acted on (auto-sent or handed to a human).
 * Call this for EVERY non-null decision so cadence + de-dup stay correct.
 */
export function applyDecision(state, decision) {
  if (!decision) return state;
  state.lastContactDate = decision.date;
  state.lastTierId = decision.tier_id;
  state.contactCount += 1;
  state.firedTierIds.push(decision.tier_id);
  return state;
}

// ---------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------

const ACTION_PHRASE = {
  pre_due_notice: 'pre-due courtesy notice to AP contact',
  due_today: 'due-today reminder to AP contact',
  first_followup: 'first follow-up to AP contact',
  controller_escalation: 'escalating to controller',
  ceo_escalation: 'escalating to CEO',
  owner_escalation: 'final notice to owner',
};

/**
 * Decide the escalation action for `invoice` on `today` ('YYYY-MM-DD').
 *
 * @param {object} invoice  a record from src/ledger.js (needs invoice_id,
 *                           due_date, is_fully_paid, contacts)
 * @param {string} today     'YYYY-MM-DD'
 * @param {object} [state]    per-invoice state from createInvoiceState()
 * @param {object} [opts]
 * @param {object} [opts.policy]  parsed policy.json (defaults to config/policy.json)
 * @returns {object|null} decision, or null if nothing fires today:
 *   { invoice_id, date, tier_id, recipient_tier, recipient_email,
 *     auto_send, reason,
 *     // extras handy for the replay layer:
 *     held_for_human, tone, cc_tiers, cc_emails, day_offset }
 */
export function decideForInvoice(invoice, today, state = createInvoiceState(), opts = {}) {
  const policy = opts.policy ?? loadPolicy();
  const tiers = policy.tiers ?? [];
  const holdList = policy.always_hold_for_human ?? [];
  const minGap = policy.cadence?.min_days_between_contacts ?? 0;

  // 1. paid invoices are done — derived, never the raw status column
  if (invoice.is_fully_paid) return null;

  // 2. day offset relative to due date
  const dayOffset = diffDays(invoice.due_date, today);

  // 3. highest tier whose threshold has been crossed
  const crossed = tiers.filter((t) => t.day_offset <= dayOffset);
  if (crossed.length === 0) return null;
  const tier = crossed.reduce((hi, t) => (t.day_offset > hi.day_offset ? t : hi));
  const tierIndex = tiers.indexOf(tier);

  // 4. already handled this tier (or a higher one)? nothing new to do
  const lastIndex = state.lastTierId
    ? tiers.findIndex((t) => t.id === state.lastTierId)
    : -1;
  if (tierIndex <= lastIndex) return null;

  // 5. cadence — don't contact again within min_days_between_contacts
  if (state.lastContactDate != null) {
    const sinceLast = diffDays(state.lastContactDate, today);
    if (sinceLast < minGap) return null;
  }

  // ---- an action fires ----
  const heldForHuman = holdList.includes(tier.id);
  const contact = invoice.contacts?.[tier.recipient] ?? null;
  const ccTiers = tier.cc ?? [];
  const ccEmails = ccTiers
    .map((r) => invoice.contacts?.[r]?.email)
    .filter(Boolean);

  // plain-English reason
  const parts = [`day${fmtOffset(dayOffset)}`];
  if (state.lastTierId && state.lastContactDate) {
    const lastOffset = diffDays(invoice.due_date, state.lastContactDate);
    parts.push(`no contact since day${fmtOffset(lastOffset)} ${state.lastTierId}`);
  } else {
    parts.push('no prior contact on this invoice');
  }
  parts.push(ACTION_PHRASE[tier.id] ?? `contacting ${tier.recipient}`);
  if (heldForHuman) parts.push('held for human sign-off');
  if (!contact?.email) parts.push(`(no email on file for ${tier.recipient})`);

  return {
    invoice_id: invoice.invoice_id,
    date: today,
    tier_id: tier.id,
    recipient_tier: tier.recipient,
    recipient_email: contact?.email ?? null,
    auto_send: heldForHuman ? false : Boolean(tier.auto_send) && Boolean(contact?.email),
    reason: parts.join(', '),

    held_for_human: heldForHuman,
    tone: tier.tone,
    cc_tiers: ccTiers,
    cc_emails: ccEmails,
    day_offset: dayOffset,
  };
}

// ---------------------------------------------------------------------------
// demo (run: `node src/policy.js`)
// ---------------------------------------------------------------------------

async function runDemo() {
  const { getLedgerAsOf, LEDGER_DATE } = await import('./ledger.js');
  const policy = loadPolicy();

  const line = (d) =>
    d
      ? `  ${d.date}  ${d.tier_id.padEnd(21)} -> ${d.recipient_tier.padEnd(10)} ` +
        `${d.auto_send ? 'AUTO-SEND ' : d.held_for_human ? 'HOLD-HUMAN' : 'no-send   '}  ${d.reason}`
      : null;

  console.log('=== policy.js demo ===\n');
  console.log(`cadence.min_days_between_contacts = ${policy.cadence.min_days_between_contacts}`);
  console.log(`tiers: ${policy.tiers.map((t) => `${t.id}@${fmtOffset(t.day_offset)}`).join(', ')}\n`);

  // --- paid invoice is never contacted ---
  const paid = getLedgerAsOf(LEDGER_DATE).invoicesById.get('INV-2231');
  const paidDecision = decideForInvoice(paid, LEDGER_DATE, createInvoiceState(), { policy });
  console.log(
    `INV-2231 (is_fully_paid=${paid.is_fully_paid}) on ${LEDGER_DATE} -> ` +
      `${paidDecision === null ? 'null (correct: paid invoices are never contacted)' : JSON.stringify(paidDecision)}`,
  );

  // --- an actually-overdue open invoice, walked day by day ---
  const target = 'INV-2087'; // C-02, due 2026-08-01, no payment on record
  const anyDay = getLedgerAsOf(LEDGER_DATE).invoicesById.get(target);
  console.log(`\n${target}  due ${anyDay.due_date}  amount $${anyDay.amount}  (open)`);
  console.log('walking day -8 .. day +34 relative to due date:\n');

  const state = createInvoiceState();
  const start = new Date(`${anyDay.due_date}T00:00:00Z`);
  const emitted = [];
  for (let k = -8; k <= 34; k++) {
    const day = new Date(start.getTime() + k * 86400000).toISOString().slice(0, 10);
    const invAsOf = getLedgerAsOf(day).invoicesById.get(target) ?? anyDay;
    const decision = decideForInvoice(invAsOf, day, state, { policy });
    if (decision) {
      emitted.push(decision);
      applyDecision(state, decision);
      console.log(line(decision));
    }
  }
  console.log(
    `\n${emitted.length} contacts over 43 days ` +
      `(${emitted.filter((d) => d.auto_send).length} auto-send, ` +
      `${emitted.filter((d) => d.held_for_human).length} held-for-human); ` +
      `gaps respect the ${policy.cadence.min_days_between_contacts}-day cadence.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDemo();
}
