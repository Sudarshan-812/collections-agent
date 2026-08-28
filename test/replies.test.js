import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseReplyFile,
  classifyDeterministic,
  classifyReply,
  analyzeReply,
} from '../src/replies.js';

const REPLIES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'inbound_replies');

// categories worked out in Prompt 3, one per file
const EXPECTED = {
  '01_reply.txt': 'auto_reply_or_ack',
  '02_reply.txt': 'already_paid_claim',
  '03_reply.txt': 'already_paid_claim',
  '04_reply.txt': 'dispute_amount_or_line_items',
  '05_reply.txt': 'promise_to_pay',
  '06_reply.txt': 'contact_change',
  '07_reply.txt': 'explicit_stop_request_or_churn_threat',
  '08_reply.txt': 'ambiguous_or_unclear',
  '09_reply.txt': 'bounced_or_invalid_contact',
  '10_reply.txt': 'auto_reply_or_ack',
  '11_reply.txt': 'legal_escalation',
  '12_reply.txt': 'dispute_reference_mismatch',
  '13_reply.txt': 'missing_invoice_or_po_request',
  '14_reply.txt': 'payment_plan_proposal',
  '15_reply.txt': 'promise_to_pay',
  '16_reply.txt': 'request_statement_or_documents',
  '17_reply.txt': 'missing_invoice_or_po_request',
  '18_reply.txt': 'ambiguous_or_unclear',
  '19_reply.txt': 'already_paid_claim',
  '20_reply.txt': 'dispute_reference_mismatch',
};

const files = readdirSync(REPLIES_DIR).filter((f) => f.endsWith('.txt')).sort();

describe('deterministic reply classification', () => {
  it('there is exactly one expectation per inbound reply file', () => {
    expect(files.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(files)('%s -> expected category', (file) => {
    const reply = parseReplyFile(join(REPLIES_DIR, file));
    const { category } = classifyDeterministic(reply);
    expect(category).toBe(EXPECTED[file]);
  });

  it.each(files)('%s: async classifyReply matches deterministic (no API key)', async (file) => {
    const reply = parseReplyFile(join(REPLIES_DIR, file));
    const viaAsync = await classifyReply(reply);
    expect(viaAsync.category).toBe(EXPECTED[file]);
  });
});

describe('reply parsing', () => {
  it('pulls the invoice_id from the Subject line', () => {
    const r = parseReplyFile(join(REPLIES_DIR, '02_reply.txt'));
    expect(r.invoice_id).toBe('INV-2231');
    expect(r.from).toBe('grace.oduya@northbrook.com');
    expect(r.date).toBe('2026-08-19');
  });

  it('collects every INV-id mentioned, even ones not in our data', () => {
    const r = parseReplyFile(join(REPLIES_DIR, '12_reply.txt'));
    expect(r.invoice_id).toBe('INV-2033');
    expect(r.invoice_ids).toContain('INV-9911');
  });
});

describe('ledger cross-check on the "already paid" claims', () => {
  it('INV-2231 (02): claim verified against payments.csv', async () => {
    const { check } = await analyzeReply(join(REPLIES_DIR, '02_reply.txt'));
    expect(check.verified).toBe(true);
    expect(check.action).toBe('mark_paid_no_further_contact');
  });

  it('INV-2087 (03): "already settled" but no payment on record -> unverified', async () => {
    const { check } = await analyzeReply(join(REPLIES_DIR, '03_reply.txt'));
    expect(check.verified).toBe(false);
    expect(check.action).toBe('hold_for_human');
  });

  it('INV-2430 (19): remittance advice, no matching payment -> unverified, unknown ref flagged', async () => {
    const { check } = await analyzeReply(join(REPLIES_DIR, '19_reply.txt'));
    expect(check.verified).toBe(false);
    expect(check.unknown_invoice_ids).toContain('INV-9999');
  });
});
