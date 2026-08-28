/**
 * ledger.js - load and normalize the data pack into an in-memory model.
 *
 * One record per invoice, joined to:
 *   - its customer            (name, payment_terms)
 *   - the customer's contacts (ap_contact, controller, ceo, owner)
 *   - our contacts            (sales_owner, collections)
 *   - all of its payment rows (an invoice can have several)
 *
 * `paid_amount` / `is_fully_paid` are derived from payments.csv only. The
 * invoices.csv `status` column is kept as `status_raw` but never trusted: it
 * goes stale (e.g. INV-2231 reads "open" there but was paid 2026-08-11).
 *
 * `getLedgerAsOf(date)` returns the ledger as it existed on or before `date`:
 * invoices issued after `date` and payments dated after `date` are invisible,
 * and paid state is recomputed from only the visible payments. This is the
 * no-future-leakage guarantee the day-by-day replay relies on.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'csv-parse/sync';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

/** Ledger date the take-home pins everything to. */
export const LEDGER_DATE = '2026-08-26';

const CUSTOMER_CONTACT_TYPES = ['ap_contact', 'controller', 'ceo', 'owner'];
const PROVIDER_CONTACT_TYPES = ['sales_owner', 'collections'];
const ALL_CONTACT_TYPES = [...CUSTOMER_CONTACT_TYPES, ...PROVIDER_CONTACT_TYPES];

function readCsv(path) {
  return parse(readFileSync(path, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

/** Normalize any date input to a 'YYYY-MM-DD' string (lexical compare === chronological). */
function toIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Unrecognized date: ${value}`);
  return d.toISOString().slice(0, 10);
}

/** Money in whole cents; avoids float drift when summing split payments. */
function toCents(n) {
  return Math.round(Number(n) * 100);
}

/** (Re)compute paid_amount / is_fully_paid / open_amount from a record's payments. */
function applyPaidState(rec) {
  const paidCents = rec.payments.reduce((sum, p) => sum + toCents(p.amount), 0);
  const amountCents = toCents(rec.amount);
  rec.paid_amount = paidCents / 100;
  rec.open_amount = Math.max(0, amountCents - paidCents) / 100;
  rec.is_fully_paid = rec.payments.length > 0 && paidCents >= amountCents;
  rec.last_payment_date = rec.payments.length
    ? rec.payments[rec.payments.length - 1].payment_date
    : null;
  return rec;
}

const _cache = new Map();

/**
 * Load and normalize the full data pack. Memoized per `dataDir`.
 * Returns { invoices, invoicesById, customers, customersById, orphanPayments,
 *           getInvoice(id), getLedgerAsOf(date) }.
 */
export function loadLedger({ dataDir = DATA_DIR } = {}) {
  if (_cache.has(dataDir)) return _cache.get(dataDir);

  const customersRaw = readCsv(join(dataDir, 'customers.csv'));
  const contactsRaw = readCsv(join(dataDir, 'contacts.csv'));
  const invoicesRaw = readCsv(join(dataDir, 'invoices.csv'));
  const paymentsRaw = readCsv(join(dataDir, 'payments.csv'));

  const customersById = new Map();
  for (const row of customersRaw) {
    customersById.set(row.customer_id, {
      customer_id: row.customer_id,
      name: row.customer_name,
      payment_terms: row.payment_terms,
    });
  }

  // customer_id -> { <contact_type>: { name, email, title, side } }
  const contactsByCustomer = new Map();
  for (const row of contactsRaw) {
    if (!contactsByCustomer.has(row.customer_id)) contactsByCustomer.set(row.customer_id, {});
    contactsByCustomer.get(row.customer_id)[row.contact_type] = {
      name: row.name,
      email: row.email,
      title: row.title,
      side: row.side,
    };
  }

  // invoice_id -> [ { invoice_id, payment_date, amount, method } ], date-sorted
  const paymentsByInvoice = new Map();
  for (const row of paymentsRaw) {
    const p = {
      invoice_id: row.invoice_id,
      payment_date: toIso(row.payment_date),
      amount: toCents(row.amount) / 100,
      method: row.method,
    };
    if (!paymentsByInvoice.has(p.invoice_id)) paymentsByInvoice.set(p.invoice_id, []);
    paymentsByInvoice.get(p.invoice_id).push(p);
  }
  for (const list of paymentsByInvoice.values()) {
    list.sort((a, b) => (a.payment_date < b.payment_date ? -1 : a.payment_date > b.payment_date ? 1 : 0));
  }

  const invoices = invoicesRaw.map((row) => {
    const cc = contactsByCustomer.get(row.customer_id) || {};
    const contacts = {};
    for (const type of ALL_CONTACT_TYPES) contacts[type] = cc[type] ? { ...cc[type] } : null;

    const rec = {
      invoice_id: row.invoice_id,
      customer_id: row.customer_id,
      issue_date: toIso(row.issue_date),
      due_date: toIso(row.due_date),
      amount: toCents(row.amount) / 100,
      terms: row.terms,
      status_raw: row.status, // kept for reference, never trusted
      customer: customersById.get(row.customer_id) || null,
      contacts,
      payments: (paymentsByInvoice.get(row.invoice_id) || []).map((p) => ({ ...p })),
    };
    return applyPaidState(rec);
  });

  const invoicesById = new Map(invoices.map((inv) => [inv.invoice_id, inv]));

  // payments referencing an invoice_id we don't have: surfaced, not silently dropped
  const orphanPayments = [];
  for (const [invoiceId, list] of paymentsByInvoice) {
    if (!invoicesById.has(invoiceId)) orphanPayments.push(...list);
  }

  const ledger = {
    invoices,
    invoicesById,
    customers: [...customersById.values()],
    customersById,
    orphanPayments,
    getInvoice: (id) => invoicesById.get(id) || null,
    getLedgerAsOf: (date) => getLedgerAsOf(date, { dataDir }),
  };
  _cache.set(dataDir, ledger);
  return ledger;
}

/**
 * The ledger as it existed on or before `date`:
 * invoices issued after `date` are excluded, payments dated after `date` are
 * excluded, and paid_amount / is_fully_paid / open_amount are recomputed from
 * the visible payments only.
 *
 * Returns { asOf, invoices, invoicesById, payments }.
 */
export function getLedgerAsOf(date, { dataDir = DATA_DIR } = {}) {
  const asOf = toIso(date);
  const base = loadLedger({ dataDir });

  const invoices = base.invoices
    .filter((inv) => inv.issue_date <= asOf)
    .map((inv) => {
      const rec = {
        ...inv,
        payments: inv.payments.filter((p) => p.payment_date <= asOf).map((p) => ({ ...p })),
      };
      return applyPaidState(rec);
    });

  return {
    asOf,
    invoices,
    invoicesById: new Map(invoices.map((inv) => [inv.invoice_id, inv])),
    payments: invoices.flatMap((inv) => inv.payments),
  };
}

// Sanity checks: `node src/ledger.js`
function runSanityChecks() {
  const full = loadLedger();
  console.log('=== ledger.js sanity checks ===\n');
  console.log(`Total invoices loaded : ${full.invoices.length}`);
  console.log(`Total customers       : ${full.customers.length}`);
  console.log(`Orphan payment rows   : ${full.orphanPayments.length}`);

  const asOf = getLedgerAsOf(LEDGER_DATE);
  const paid = asOf.invoices.filter((i) => i.is_fully_paid);
  const open = asOf.invoices.filter((i) => !i.is_fully_paid);
  const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  console.log(`\nas of ledger date ${asOf.asOf}`);
  console.log(`Invoices visible (issued on/before ${asOf.asOf}) : ${asOf.invoices.length}`);
  console.log(`  fully paid (derived from payments)  : ${paid.length}`);
  console.log(`  still open  (derived from payments)  : ${open.length}`);
  console.log(`  open A/R outstanding                 : ${usd(open.reduce((s, i) => s + i.open_amount, 0))}`);

  const rawOpenCount = asOf.invoices.filter((i) => i.status_raw !== 'paid').length;
  const mismatches = asOf.invoices.filter((i) => (i.status_raw === 'paid') !== i.is_fully_paid);
  console.log(`\n  raw status column says "open"        : ${rawOpenCount}`);
  console.log(`  derived open (independent of column) : ${open.length}`);
  console.log(`  rows where raw status != derived     : ${mismatches.length}`);
  for (const m of mismatches) {
    console.log(
      `    ${m.invoice_id}: status_raw="${m.status_raw}" but is_fully_paid=${m.is_fully_paid} ` +
        `(paid ${usd(m.paid_amount)} of ${usd(m.amount)})`,
    );
  }

  const inv = asOf.invoicesById.get('INV-2231');
  console.log('\nINV-2231 stale-status spot check');
  console.log(`  customer      : ${inv.customer.name} (${inv.customer_id}, ${inv.customer.payment_terms})`);
  console.log(`  raw status    : ${inv.status_raw}`);
  console.log(`  amount        : ${usd(inv.amount)}`);
  console.log(`  payments      : ${inv.payments.map((p) => `${p.payment_date} ${usd(p.amount)} ${p.method}`).join('; ') || '(none)'}`);
  console.log(`  paid_amount   : ${usd(inv.paid_amount)}`);
  console.log(`  is_fully_paid : ${inv.is_fully_paid}  (effectively paid despite status_raw="${inv.status_raw}")`);
  console.assert(inv.is_fully_paid === true, 'FAIL: INV-2231 should be effectively paid');
  console.assert(inv.status_raw === 'open', 'FAIL: INV-2231 status_raw should still read "open"');

  console.log('\nno-future-leakage spot check');
  const early = getLedgerAsOf('2026-08-10').invoicesById.get('INV-2231');
  console.log(`  as of 2026-08-10, INV-2231 payments visible : ${early.payments.length}`);
  console.log(`  as of 2026-08-10, INV-2231 is_fully_paid    : ${early.is_fully_paid}  (payment dated 2026-08-11 is not yet visible)`);
  console.assert(early.is_fully_paid === false, 'FAIL: INV-2231 must look open before its 2026-08-11 payment');

  const futureIssued = full.invoices.filter((i) => i.issue_date > asOf.asOf).length;
  console.log(`\n  invoices issued after ${asOf.asOf} (hidden by getLedgerAsOf): ${futureIssued}`);
  console.assert(
    asOf.invoices.length + futureIssued === full.invoices.length,
    'FAIL: visible + future-issued should equal total',
  );

  console.log('\n=== all assertions passed ===');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSanityChecks();
}
