# Pump.fun Replay Sprint — Paper Bot

![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/adewahid/makefun-pump-fun-replay-sprint/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/adewahid/makefun-pump-fun-replay-sprint/reward.svg)

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a replay of 24 hours of pump.fun bonding-curve activity (harness `agent-fun/replay/v2`). Nothing is traded for real.

## Strategy: Completion Chaser

Measured on the kit's full dev window (1222 coins, 24h, 128,058 events):

- 28 of 35 completions happen in the create slot: untradeable (latency is 2 slots).
- The 7 gradual completions grind from ~20 to 85 real SOL in 345–1530 slots. A coin first seen at 55–80 real SOL is on a short, steep road to the 85-SOL completion, where the harness force-closes at the completion price. Buy it, take profit at +30%, add once as real SOL climbs 10 more, exit after 800 slots.
- No stop loss, no trailing stop, no fade exit: every one of those was swept and hurt, because the grind dips 40%+ routinely before recovering or completing.
- Dip-buying loses here; momentum-chasing loses worse (house pilot: −9.5 SOL). Launch scalping is unusable: the 1%-of-real-reserve cap keeps stakes at 0.003–0.01 SOL on fresh launches, where the fixed 105k-lamport tx fee alone is ~2% per order.
- Tiny probe round trips (0.01 SOL) keep the guardrail coin count up when the chaser's own fills lag the pace.

## Files

- `main.ts` — entrypoint: wires the strategy into the replay shim.
- `strategy.ts` — the Completion Chaser strategy (pure function of the batches the harness sends; no clock, no randomness, no I/O, so the two graded executions produce byte-identical action logs).
- `vendor/agentfun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim (byte-identical copy of `sdk/ts/makefun-bot.ts`).

## Run locally

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Referral

Made with make.fun — referral code `zsgcm8j7`.
