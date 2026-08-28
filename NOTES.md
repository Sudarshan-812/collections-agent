# Notes

## Why the policy is shaped this way

The contact ladder (AP contact → controller → CEO → owner) mirrors who actually has authority to release payment at a customer: the AP contact can act on a routine invoice, but by the time something is 30+ days ignored, the AP contact isn't the blocker anymore and the routine channel has already failed. CEO and owner tiers are hard-coded to `always_hold_for_human` regardless of the config's own `auto_send` flag, because those are relationship-risk actions that are effectively unrecoverable if sent wrong - no config edit should be able to make that autonomous by accident. Disputes, missing-document requests, and statement requests freeze the escalation clock instead of continuing to count days late, because it isn't accurate (or fair) to treat "we're waiting on you to resend the PO" as customer lateness - escalating through that would just be punishing the customer for our own process gap.

## What the agent may do without a human

- Send the pre-due notice, due-today reminder, first follow-up, and controller escalation automatically, on cadence, as long as nothing has redirected, frozen, or stopped that invoice.
- Classify inbound replies and act on the unambiguous ones: verify an "already paid" claim against `payments.csv` and close it out if it checks out; freeze the clock on a genuine dispute or document request; suppress reminders during a single-date promise-to-pay window; redirect to a new contact on a clean handoff.
- Flag risk on open invoices and explain why, for a human to triage.

## What the agent may not do

- Never auto-send to the CEO or owner tier - always held for sign-off, no matter what the config says.
- Never mark an invoice paid, or stop chasing it, on the customer's word alone - every "already paid" or remittance claim is checked against `payments.csv` first; unverified ones are held for a human, not trusted or dismissed.
- Never resume automated contact once legal counsel is invoked, a churn threat is made, or an address bounces - those are hard stops until a human clears them (legal/churn stop every open invoice for that customer, not just the one referenced).
- Never guess on an ambiguous reply, a multi-date/partial payment proposal, or a category it doesn't recognize - all three default to hold-for-human rather than picking an action.

## Where I drew the line

The hardest call was reply 05: "we can send 50% this Friday and the balance on the 30th." That's not a clean single-date promise - it's a renegotiation of the payment itself, on a small balance where the temptation is to just auto-suppress and move on. I decided any reply proposing more than one payment or date is a real negotiation and routes to hold-for-human (`payment_plan_proposal`), even though that costs some automation coverage, because silently agreeing to a payment split without anyone at the company seeing it first is exactly the kind of thing that should require a human signature.

## What must be true before this emails a real customer

- A human at the company has read and approved the actual message copy per tier, including tone and any implied legal language in the "final notice" wording.
- The reply classifier has been evaluated against a labeled set much larger than these 20 examples, with a measured error rate someone has signed off on - 20 examples is enough to build the taxonomy, not enough to trust in production.
- There's a kill switch and a send-rate limit in front of the auto-send path, plus monitoring on it.
- The bounce/legal/churn hard-stops are wired to a real mailbox and a real webhook, not a simulated classifier reading static files - a missed bounce here means an angry legal contact keeps getting emailed.

## AI usage

Used Claude Code to scaffold the project and implement the ledger, policy engine, reply classifier, replay simulation, risk flagging, and test suite, working prompt-by-prompt against an escalation policy and reply taxonomy I specified up front in `config/policy.json`. I verified its output at each stage against the raw CSVs myself rather than trusting the tool's own summaries - including an independent recount of the ledger totals and a manual read of all 20 replies against what the classifier produced.

## One place I overrode it

The first implementation classified the split-payment reply (05) as `promise_to_pay`, which auto-suppresses escalation with no human review. I judged that a multi-date, partial-payment proposal is a real negotiation, not a routine promise, and had it reclassified as `payment_plan_proposal` so it's held for a human instead - a materially safer outcome on real money, not a cosmetic change.
