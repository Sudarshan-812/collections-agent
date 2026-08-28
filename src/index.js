#!/usr/bin/env node
/**
 * index.js — the single CLI entry point.
 *
 *   node src/index.js replay   dry-run the agent over full history -> out/replay_log.jsonl
 *   node src/index.js risk     risk-flag every currently-open invoice -> out/risk_flags.json
 *   node src/index.js run      both, in order
 *
 * Nothing beyond `npm install` is required. Matches package.json's scripts
 * (start = run, replay, risk).
 */

import { runReplayCli } from './replay.js';
import { runRiskCli } from './risk.js';

const COMMANDS = {
  replay: runReplayCli,
  risk: runRiskCli,
  run: async () => {
    await runReplayCli();
    console.log('\n' + '─'.repeat(60) + '\n');
    await runRiskCli();
  },
};

const cmd = process.argv[2];
const fn = COMMANDS[cmd];

if (!fn) {
  console.error(`usage: node src/index.js <${Object.keys(COMMANDS).join('|')}>`);
  process.exit(1);
}

fn().catch((err) => {
  console.error(err);
  process.exit(1);
});
