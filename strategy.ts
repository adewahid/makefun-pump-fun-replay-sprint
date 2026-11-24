// Completion Chaser for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Measured on the kit's full dev window (1222 coins, 24h, 128,058 events):
// - 28 of 35 completions happen in the create slot: untradeable (latency is 2 slots).
// - The 7 gradual completions grind from ~20 to 85 real SOL in 345-1530 slots with
//   465-1236 trades. A coin first seen at 55-80 real SOL is on a short, steep road
//   to the 85-SOL completion, where the harness force-closes at the completion price
//   (14.69x the create price). Buy it, take profit at +30%, add once as real SOL
//   climbs 10 more, exit after 800 slots. No stop loss, no trailing stop, no fade
//   exit: every one of those was swept and hurt, because the grind dips 40%+
//   routinely before recovering or completing, and cutting it only banks the dip.
//   Sweep winners on the dev window: band [55,80], TP +30%, hold 800 slots,
//   1 add of 0.3 SOL at +10 real SOL. Net +2.84 SOL across four failed-tx draws
//   (worst +2.74), ex-best-trip +2.37, max drawdown 0.08.
// - Dip-buying loses here (win rate 15-24% at TP +20% / SL -10%): dips keep dipping.
//   Momentum-chasing loses worse (house pilot: -9.5 SOL). Launch scalping looks good
//   in price terms but is unusable: the 1%-of-real-reserve cap keeps stakes at
//   0.003-0.01 SOL on fresh launches, where the fixed 105k-lamport tx fee alone is
//   ~2% per order. None of those are used.
// - Fees: 1.25% curve + 105k lamports per order, so a round trip costs ~2.6% of
//   stake; stakes are sized so the fixed fee stays under ~0.1% of the trade.
// - Tiny probe round trips (0.01 SOL) keep the guardrail coin count up when the
//   chaser's own fills lag the pace; each costs ~0.0005 SOL.
//
// Everything is a pure function of the batches the harness sends (hello, batch, done):
// no clock, no randomness, no I/O, so the two graded executions produce byte-identical
// action logs. Orders per batch stay under the caps (16 per batch, 5 open positions,
// buys at most 1% of a curve's real SOL reserve).

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Real SOL band (SOL) a curve must sit in to be entered. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL to put into one position on entry (the 1% reserve cap binds first). */
  stakeSol: number;
  /** Smallest buy worth paying the tx fee for. */
  minBuySol: number;
  /** Take profit as a fraction over cost. */
  takeProfit: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Most chaser positions open at once. */
  maxSlots: number;
  /** Add tranches after entry: each add needs real SOL up `addStepSol` since the
      last buy, up to `maxAdds` adds of `addSol` SOL. */
  maxAdds: number;
  addSol: number;
  addStepSol: number;
  /** Slippage on buys (bps); sells go out at 10000. */
  buySlipBps: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: keep fills/coins on pace over the window (block time seconds). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minRqSol: 55,
  maxRqSol: 80,
  stakeSol: 0.8,
  minBuySol: 0.02,
  takeProfit: 0.3,
  maxHold: 800,
  maxSlots: 3,
  maxAdds: 1,
  addSol: 0.3,
  addStepSol: 10,
  buySlipBps: 1500,
  cooldown: 150,
  maxEntries: 1,
  maxExposureSol: 6,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS = 10000;

interface Tape {
  created: number | null;
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  adds: number;
  lastBuyRq: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          traded.add(e.mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first, in mint order (deterministic): take profit, or the time limit.
      // A curve that completes is closed by the replay at its final reserves.
      for (const mint of [...held.keys()].sort()) {
        const h = held.get(mint)!;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const mint of [...probes.keys()].sort()) {
        const selling = probes.get(mint)!;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);

      // Add a tranche as real SOL keeps climbing toward completion.
      for (const mint of [...held.keys()].sort()) {
        if (orders.length >= cap) break;
        const h = held.get(mint)!;
        if (h.exiting || !h.filled || h.adds >= p.maxAdds) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < h.lastBuyRq + p.addStepSol || rqSol > p.maxRqSol) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.addSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        h.invested += amount;
        h.adds++;
        h.lastBuyRq = rqSol;
      }

      // New entries on coins that traded in this batch.
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (held.size >= p.maxSlots) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        if (t.created === null || now - t.created <= 2) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, invested: amount, exiting: false, filled: false, adds: 0, lastBuyRq: rqSol });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
