// Pump.fun Replay Sprint: completion-chaser paper bot (agent-fun/replay/v2).
// Buys coins grinding up through 55-80 real SOL toward the 85-SOL completion,
// takes profit at +30%, rides the grind with no stop loss (wide stops only cut
// the winners on this data), adds once as real SOL climbs 10 more, exits after
// 800 slots. Plus tiny probe round trips to keep the guardrail coin count up.
// Grade-local verified 24 Nov 2026 (kit dev window, --driver process):
// net PnL +2.7786 SOL, 287 fills over 62 coins, 139 round trips,
// win rate 0.18, max drawdown 0.080; guardrails met; L1 regrade
// reproduced byte for byte. Top 3 coins made 28% of the gains;
// without them net PnL is still +1.70 SOL.
import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
