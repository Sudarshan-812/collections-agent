# Collections Agent

An AI agent that manages accounts-receivable collections for a back-office provider: decides who gets contacted about unpaid invoices, when, how often, and reads inbound customer replies to decide the next action. Built for the FutureStrive Founding Engineer take-home.

## Requirements

- Node.js >= 20

## Setup

```bash
npm install
```

No API keys required to run the core pipeline. See [Reply classification mode](#reply-classification-mode) below for the optional LLM-assisted path.

## Run

Single entry point, three modes:

```bash
npm run replay   # Deliverable 4: dry-run replay across full history -> out/replay_log.jsonl
npm run risk     # Deliverable 5: risk flags for currently open invoices -> out/risk_flags.json
npm start        # runs both, in order
```

Outputs land in `out/`. Nothing is ever actually sent — this is a dry run against static CSVs, by design (deliverable 4).

## Project layout

```
config/policy.json     Escalation policy: tiers, timings, reply-handling rules. Edit this, not the code.
data/                  Source data pack (customers, contacts, invoices, payments, inbound_replies/).
src/                   Agent implementation.
out/                   Generated: replay_log.jsonl, risk_flags.json.
test/                  Unit tests (npm test).
NOTES.md               Policy rationale, autonomy boundaries, AI usage (deliverable 6).
part2.md               Thought exercise (Part 2).
```

## Reply classification mode

By default, inbound replies are classified with deterministic rules (keyword/pattern matching tuned against the 20 sample replies in `data/inbound_replies/`) — this keeps the pipeline dependency-free and guaranteed to run with zero setup. If `ANTHROPIC_API_KEY` is set in the environment, the classifier instead calls Claude for the same categorization (see `src/replies.js`), which generalizes better beyond the sample set. Either path produces the same category taxonomy, defined in `config/policy.json` under `reply_handling.categories`.

## Testing

```bash
npm test
```
