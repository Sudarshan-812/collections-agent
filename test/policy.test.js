import { describe, it, expect } from 'vitest';
import {
  loadPolicy,
  createInvoiceState,
  applyDecision,
  decideForInvoice,
} from '../src/policy.js';

const policy = loadPolicy();

// minimal invoice fixture — decideForInvoice only touches these fields
function makeInvoice({ due_date, is_fully_paid = false } = {}) {
  const contact = (who) => ({ name: `${who} person`, email: `${who}@example.com`, title: who });
  return {
    invoice_id: 'INV-TEST',
    due_date,
    is_fully_paid,
    contacts: {
      ap_contact: contact('ap'),
      controller: contact('controller'),
      ceo: contact('ceo'),
      owner: contact('owner'),
      sales_owner: contact('sales'),
      collections: contact('collections'),
    },
  };
}

const DUE = '2026-06-01';

// ISO string for a day `days` relative to DUE (negative = before due)
function dueOffset(days) {
  const ms = Date.UTC(2026, 5, 1) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

describe('tier thresholds fire on the exact day_offset, not the day before', () => {
  const cases = [
    { tier: 'pre_due_notice', offset: -5 },
    { tier: 'due_today', offset: 0 },
    { tier: 'first_followup', offset: 7 },
    { tier: 'controller_escalation', offset: 14 },
    { tier: 'ceo_escalation', offset: 30 },
    { tier: 'owner_escalation', offset: 45 },
  ];

  for (const { tier, offset } of cases) {
    it(`${tier}: not at day${offset - 1}, yes at day${offset}`, () => {
      const inv = makeInvoice({ due_date: DUE });

      const before = decideForInvoice(inv, dueOffset(offset - 1), createInvoiceState(), { policy });
      // the day before, the highest crossed tier is whatever precedes this one
      expect(before?.tier_id).not.toBe(tier);

      const on = decideForInvoice(inv, dueOffset(offset), createInvoiceState(), { policy });
      expect(on?.tier_id).toBe(tier);
      expect(on?.date).toBe(dueOffset(offset));
      expect(on?.invoice_id).toBe('INV-TEST');
    });
  }

  it('nothing fires before the earliest tier (day -6)', () => {
    const inv = makeInvoice({ due_date: DUE });
    expect(decideForInvoice(inv, dueOffset(-6), createInvoiceState(), { policy })).toBeNull();
  });
});

describe('always_hold_for_human', () => {
  it('ceo_escalation is held for human: auto_send false, held_for_human true', () => {
    const inv = makeInvoice({ due_date: DUE });
    const d = decideForInvoice(inv, dueOffset(30), createInvoiceState(), { policy });
    expect(d.tier_id).toBe('ceo_escalation');
    expect(d.held_for_human).toBe(true);
    expect(d.auto_send).toBe(false);
  });

  it('owner_escalation is held for human', () => {
    const inv = makeInvoice({ due_date: DUE });
    const d = decideForInvoice(inv, dueOffset(45), createInvoiceState(), { policy });
    expect(d.tier_id).toBe('owner_escalation');
    expect(d.held_for_human).toBe(true);
    expect(d.auto_send).toBe(false);
  });

  it('controller_escalation is NOT held: auto_send true', () => {
    const inv = makeInvoice({ due_date: DUE });
    const d = decideForInvoice(inv, dueOffset(14), createInvoiceState(), { policy });
    expect(d.tier_id).toBe('controller_escalation');
    expect(d.held_for_human).toBe(false);
    expect(d.auto_send).toBe(true);
  });

  it('the held tiers match config exactly', () => {
    expect(policy.always_hold_for_human).toEqual(['ceo_escalation', 'owner_escalation']);
  });
});

describe('cadence: min_days_between_contacts', () => {
  const gap = policy.cadence.min_days_between_contacts;

  it('suppresses a newly-crossed tier within the cadence window, allows it after', () => {
    const inv = makeInvoice({ due_date: DUE });
    const state = createInvoiceState();

    // agent "starts late": first contact at day +12 -> first_followup
    const first = decideForInvoice(inv, dueOffset(12), state, { policy });
    expect(first.tier_id).toBe('first_followup');
    applyDecision(state, first);

    // controller threshold (day +14) is crossed only 2 days later -> blocked by cadence
    const tooSoon = decideForInvoice(inv, dueOffset(14), state, { policy });
    expect(tooSoon).toBeNull();

    // still blocked at gap - 1 days after the last contact
    const stillTooSoon = decideForInvoice(inv, dueOffset(12 + gap - 1), state, { policy });
    expect(stillTooSoon).toBeNull();

    // exactly `gap` days after the last contact -> controller fires
    const now = decideForInvoice(inv, dueOffset(12 + gap), state, { policy });
    expect(now.tier_id).toBe('controller_escalation');
  });

  it('does not re-fire a tier that already fired', () => {
    const inv = makeInvoice({ due_date: DUE });
    const state = createInvoiceState();

    const d1 = decideForInvoice(inv, dueOffset(7), state, { policy });
    expect(d1.tier_id).toBe('first_followup');
    applyDecision(state, d1);

    // well past the cadence gap, but still inside the first_followup band (before day +14)
    const d2 = decideForInvoice(inv, dueOffset(13), state, { policy });
    expect(d2).toBeNull();
  });
});

describe('paid invoices are never contacted', () => {
  it('returns null even deep into the escalation ladder', () => {
    const inv = makeInvoice({ due_date: DUE, is_fully_paid: true });
    expect(decideForInvoice(inv, dueOffset(45), createInvoiceState(), { policy })).toBeNull();
  });
});

describe('decision shape', () => {
  it('carries the fields the replay log needs', () => {
    const inv = makeInvoice({ due_date: DUE });
    const d = decideForInvoice(inv, dueOffset(14), createInvoiceState(), { policy });
    expect(d).toMatchObject({
      invoice_id: 'INV-TEST',
      date: dueOffset(14),
      tier_id: 'controller_escalation',
      recipient_tier: 'controller',
      recipient_email: 'controller@example.com',
      auto_send: true,
    });
    expect(typeof d.reason).toBe('string');
    expect(d.reason).toContain('day+14');
  });
});
