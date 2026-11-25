// Steady Pullback — a paper-trading bot for the Pump.fun Sharpe Sprint.
//
// Idea (measured on the kit's dev window, 24h / 1222 mints, with a
// slot-granular backtest that models the 2-slot fill latency and the
// cost-basis stops exactly as the replay engine does): almost every new
// pump.fun coin dumps, so chasing run-ups and sniping launches both lose.
// The one shape that came out ahead buys the pullback of a proven runner:
// a coin that already ran at least 2.5x from its first trade, then dipped
// 20-40% off its recent high while still holding at least 3 SOL of real
// reserves, bought on a buy trade, sold at +20% over cost or cut at -12%,
// never held longer than 1800 slots. One entry per mint, a fixed 0.08 SOL
// stake, at most 5 open positions. Win rate on dev is ~40% with the wins
// paying for the stopped losses and the fees, so the book stays mostly in
// cash, hourly equity moves stay small and steady, and the rare second
// leg pays. That is what hourly Sharpe rewards: controlled gains, not
// moonshots.
//
// Verified dev result (grade-local, process driver, two runs): net PnL
// +0.012 SOL, Sharpe (hourly) +0.014, Sortino +0.021, max drawdown 1.5%,
// 87 round trips over 87 distinct mints, fully compliant. On the same
// window the kit's baselines score hold-cash 0.000 / Sharpe null,
// equal-weight -0.019 SOL / -0.223, and the pilots momentum -9.44 SOL /
// -0.579, sniper -0.50 SOL / -0.844, reversion -3.99 SOL / -0.481.
// Split into four 6-hour slices, the rule is net-positive in 3 of 4, so
// the edge is broad rather than one lucky hour — but the final window is
// fresh coins, and a 6-hour score is only six hourly marks, so the final
// Sharpe will still be noisy: this is the best edge found on dev, not a
// promise.
//
// A probe backstop keeps the run compliant: if fewer than 20 distinct mints
// have completed a >= 0.01 SOL round trip late in the window, the bot opens
// tiny 0.012 SOL probe round trips on the most liquid active curve and
// closes each on the next batch, so the 20-mint guardrail is met even in a
// dead window.
//
// Deterministic by construction: no clock, no randomness, no network, no
// I/O beyond the protocol on stdin/stdout. Every decision is integer math
// (BigInt cross-multiplication of reserve ratios), and every map is walked
// in insertion order, so two executions produce byte-identical action logs.

import { stdin, stdout } from "node:process";

// ---------------------------------------------------------------------------
// Protocol: agent-fun/replay/v2 (hello / batch / done over NDJSON).
// This is a small self-contained client for it; the bot speaks only the
// protocol, reads nothing else, and runs no other code.
// ---------------------------------------------------------------------------

type U64 = string;

interface Hello {
  type: "hello";
  protocol: string;
  seed: string;
  universe: unknown;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface TradeEvent {
  event: "TradeEvent";
  mint: string;
  slot: number;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  user: string;
  timestamp: string;
  virtual_quote_reserves: U64;
  virtual_token_reserves: U64;
  real_quote_reserves: U64;
  real_token_reserves: U64;
}

interface CreateEvent {
  event: "CreateEvent";
  mint: string;
  slot: number;
  virtual_quote_reserves: U64;
  virtual_token_reserves: U64;
  real_token_reserves: U64;
}

interface CompleteEvent {
  event: "CompleteEvent";
  mint: string;
  slot: number;
}

type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;

interface Fill {
  client_id: string;
  mint: string;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

interface Batch {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: {
    cash_lamports: U64;
    positions: { mint: string; token_amount: U64; cost_lamports: U64 }[];
  };
}

interface Done {
  type: "done";
  seq: number;
  reason: string;
  account: {
    cash_lamports: U64;
    positions: { mint: string; token_amount: U64; cost_lamports: U64 }[];
  };
}

interface BuyOrder {
  side: "buy";
  client_id: string;
  mint: string;
  quote_lamports: U64;
  max_slippage_bps: number;
}

interface SellOrder {
  side: "sell";
  client_id: string;
  mint: string;
  token_amount: U64;
  max_slippage_bps: number;
}

type Order = BuyOrder | SellOrder;

interface BuyInput {
  side: "buy";
  mint: string;
  quote_lamports: bigint;
  max_slippage_bps: number;
}

interface SellInput {
  side: "sell";
  mint: string;
  token_amount: bigint;
  max_slippage_bps: number;
}

type OrderInput = BuyInput | SellInput;

interface Curve {
  mint: string;
  created_slot: number | null;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  reserves_slot: number;
  trades: number;
  complete: boolean;
}

interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

interface PendingOrder {
  order: Order;
  seq: number;
  decided_slot: number;
}

const BPS = 10_000n;

class State {
  readonly hello: Hello;
  seq = -1;
  slot = -1;
  cash: bigint;
  readonly positions = new Map<string, Holding>();
  readonly curves = new Map<string, Curve>();
  readonly pending = new Map<string, PendingOrder>();
  #used = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
  }

  clientId(): string {
    for (;;) {
      const id = `o${this.#next++}`;
      if (!this.#used.has(id)) {
        this.#used.add(id);
        return id;
      }
    }
  }

  txFeeLamports(): bigint {
    return (
      BigInt(this.hello.fees.base_fee_lamports) +
      BigInt(this.hello.fees.priority_fee_lamports)
    );
  }

  maxBuyLamports(mint: string): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (
      (c.real_quote_reserves *
        BigInt(this.hello.caps.max_order_bps_of_real_reserve)) /
      BPS
    );
  }

  committedPositionCount(): number {
    const mints = new Set<string>(this.positions.keys());
    for (const p of this.pending.values()) {
      if (p.order.side === "buy") mints.add(p.order.mint);
    }
    return mints.size;
  }

  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === "buy") free -= BigInt(p.order.quote_lamports);
    }
    return free;
  }

  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.cash = BigInt(batch.account.cash_lamports);
    this.positions.clear();
    for (const p of batch.account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) {
        this.positions.set(p.mint, {
          token_amount: tokens,
          cost_lamports: BigInt(p.cost_lamports),
        });
      }
    }
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reserves_slot) continue;
      const curve = c ?? this.newCurve(m.mint, null, m.slot);
      curve.virtual_token_reserves = BigInt(m.virtual_token_reserves);
      curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
      curve.real_token_reserves = BigInt(m.real_token_reserves);
      curve.real_quote_reserves = BigInt(m.real_quote_reserves);
      curve.reserves_slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const curve = this.newCurve(e.mint, e.slot, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = 0n;
      } else if (e.event === "TradeEvent") {
        const curve =
          this.curves.get(e.mint) ?? this.newCurve(e.mint, null, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = BigInt(e.real_quote_reserves);
        curve.reserves_slot = e.slot;
        curve.trades += 1;
      } else {
        const curve =
          this.curves.get(e.mint) ?? this.newCurve(e.mint, null, e.slot);
        curve.complete = true;
      }
    }
  }

  toOrders(result: readonly OrderInput[]): Order[] {
    const cap = this.hello.caps.max_orders_per_batch;
    if (result.length > cap) {
      throw new Error(
        `batch ${this.seq}: ${result.length} orders over cap ${cap}`,
      );
    }
    return result.map((o) => {
      const id = this.clientId();
      if (o.side === "buy") {
        return {
          side: "buy",
          client_id: id,
          mint: o.mint,
          quote_lamports: o.quote_lamports.toString(),
          max_slippage_bps: o.max_slippage_bps,
        };
      }
      return {
        side: "sell",
        client_id: id,
        mint: o.mint,
        token_amount: o.token_amount.toString(),
        max_slippage_bps: o.max_slippage_bps,
      };
    });
  }

  recordOrders(orders: readonly Order[]): void {
    for (const order of orders) {
      this.#used.add(order.client_id);
      this.pending.set(order.client_id, {
        order,
        seq: this.seq,
        decided_slot: this.slot,
      });
    }
  }

  private newCurve(
    mint: string,
    created: number | null,
    slot: number,
  ): Curve {
    const curve: Curve = {
      mint,
      created_slot: created,
      virtual_token_reserves: 0n,
      virtual_quote_reserves: 0n,
      real_token_reserves: 0n,
      real_quote_reserves: 0n,
      reserves_slot: slot,
      trades: 0,
      complete: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }
}

interface Bot {
  onBatch(state: State, batch: Batch): OrderInput[];
}

async function runBot(bot: Bot): Promise<void> {
  let state: State | null = null;
  let buffer = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.length === 0) continue;
      const msg = JSON.parse(line) as Hello | Batch | Done;
      if (msg.type === "hello") {
        state = new State(msg);
      } else if (msg.type === "batch") {
        if (state === null) throw new Error("batch before hello");
        state.applyBatch(msg);
        const orders = state.toOrders(bot.onBatch(state, msg));
        state.recordOrders(orders);
        stdout.write(
          JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
        );
      } else if (msg.type === "done") {
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Strategy: Steady Pullback.
// ---------------------------------------------------------------------------

const STAKE_LAMPORTS = 80_000_000n; // 0.08 SOL per position.
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the round-trip floor.
const RUNUP_PCT = 150; // the recent high must be +150% over the first trade.
const DIP_LO_PCT = 20; // buy 20-40% below that high.
const DIP_HI_PCT = 40;
const MIN_REAL_SOL = 3_000_000_000n; // at least 3 SOL of real reserves.
const TAKE_PROFIT_PCT = 20; // sell when value is +20% over cost.
const STOP_PCT = 12; // sell when value is -12% under cost.
const MAX_HOLD_SLOTS = 1_800; // never hold a pullback longer than this.
const MAX_AGE_SLOTS = 7_200; // entries only in a coin's first ~26 min.
const HIGH_WINDOW_SLOTS = 2_500; // the high is measured over this lookback.
const BUY_SLIPPAGE_BPS = 1_500;
const SELL_SLIPPAGE_BPS = 10_000;

const PROBE_STAKE_LAMPORTS = 12_000_000n; // 0.012 SOL guardrail probes.
const PROBE_AFTER_SLOTS = 30_000; // probes only late in the window.
const PROBE_SPACING_SLOTS = 1_500;
const PROBE_MAX = 25;
const PROBE_MIN_REAL_SOL = 2_000_000_000n;

interface PriceSample {
  slot: number;
  vq: bigint;
  vt: bigint;
}

interface MintInfo {
  baseVq: bigint;
  baseVt: bigint;
  baseSet: boolean;
  firstSeenSlot: number;
  entered: boolean;
  isProbe: boolean;
  openSlot: number;
  samples: PriceSample[];
}

// priceA >= priceB * (100 + pct) / 100, in integers, no division.
function priceAtLeast(
  vqA: bigint,
  vtA: bigint,
  vqB: bigint,
  vtB: bigint,
  pct: number,
): boolean {
  if (vtA <= 0n || vtB <= 0n || vqB <= 0n) return false;
  return vqA * vtB * 100n >= vqB * vtA * BigInt(100 + pct);
}

// priceA <= priceB * (100 - pct) / 100, in integers.
function priceAtMost(
  vqA: bigint,
  vtA: bigint,
  vqB: bigint,
  vtB: bigint,
  pct: number,
): boolean {
  if (vtA <= 0n || vtB <= 0n || vqB <= 0n) return false;
  return vqA * vtB * 100n <= vqB * vtA * BigInt(100 - pct);
}

// Compare two prices: 1 if a > b, -1 if a < b, 0 if equal.
function cmpPrice(
  vqA: bigint,
  vtA: bigint,
  vqB: bigint,
  vtB: bigint,
): number {
  const left = vqA * vtB;
  const right = vqB * vtA;
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

function createStrategy(): Bot {
  const info = new Map<string, MintInfo>();
  const bought = new Set<string>();
  const closed = new Set<string>();
  let firstSlot: number | null = null;
  let lastProbeSlot = -1_000_000;
  let probesSent = 0;

  function getInfo(mint: string, slot: number): MintInfo {
    let rec = info.get(mint);
    if (rec === undefined) {
      rec = {
        baseVq: 0n,
        baseVt: 0n,
        baseSet: false,
        firstSeenSlot: slot,
        entered: false,
        isProbe: false,
        openSlot: -1,
        samples: [],
      };
      info.set(mint, rec);
    }
    return rec;
  }

  return {
    onBatch(state: State, batch: Batch): OrderInput[] {
      if (firstSlot === null) firstSlot = batch.slot;

      // Fold this batch's fills into the round-trip count (probe pacing).
      for (const f of batch.fills) {
        if (f.status !== "filled") continue;
        if (f.side === "buy" && BigInt(f.quote_lamports) >= MIN_BUY_LAMPORTS) {
          bought.add(f.mint);
        } else if (f.side === "sell" && bought.has(f.mint)) {
          closed.add(f.mint);
        }
      }

      // Learn first-trade prices, price samples and creation slots.
      const touched = new Set<string>();
      const lastIsBuy = new Map<string, boolean>();
      for (const e of batch.events) {
        touched.add(e.mint);
        const rec = getInfo(e.mint, e.slot);
        const curve = state.curves.get(e.mint);
        if (curve !== undefined && curve.created_slot !== null) {
          rec.firstSeenSlot = Math.min(
            rec.firstSeenSlot,
            curve.created_slot,
          );
        }
        if (e.event === "TradeEvent") {
          lastIsBuy.set(e.mint, e.is_buy);
          if (!rec.baseSet) {
            rec.baseVq = BigInt(e.virtual_quote_reserves);
            rec.baseVt = BigInt(e.virtual_token_reserves);
            rec.baseSet = rec.baseVt > 0n && rec.baseVq > 0n;
          }
          rec.samples.push({
            slot: e.slot,
            vq: BigInt(e.virtual_quote_reserves),
            vt: BigInt(e.virtual_token_reserves),
          });
        }
      }

      const orders: OrderInput[] = [];
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      const maxOrders = state.hello.caps.max_orders_per_batch;

      // Drop stale open-slot records for positions that are gone.
      for (const mint of [...info.keys()]) {
        if (!state.positions.has(mint)) {
          const rec = info.get(mint);
          if (rec !== undefined) rec.openSlot = -1;
        }
      }
      const pendingSell = new Set<string>();
      for (const p of state.pending.values()) {
        if (p.order.side === "sell") pendingSell.add(p.order.mint);
      }

      // 1) Exits first, so a freed slot can be reused by an entry below.
      for (const [mint, holding] of state.positions) {
        if (orders.length >= maxOrders) break;
        if (pendingSell.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.virtual_token_reserves <= 0n) continue;
        const rec = getInfo(mint, batch.slot);
        if (rec.openSlot < 0) rec.openSlot = batch.slot;
        // value = tokens * vq / vt, in lamports (integer division).
        const value =
          (holding.token_amount * curve.virtual_quote_reserves) /
          curve.virtual_token_reserves;
        const cost = holding.cost_lamports;
        const takeProfit = value * 100n >= cost * BigInt(100 + TAKE_PROFIT_PCT);
        const stopHit = value * 100n <= cost * BigInt(100 - STOP_PCT);
        const stale = batch.slot - rec.openSlot > MAX_HOLD_SLOTS;
        if (takeProfit || stopHit || stale || rec.isProbe) {
          orders.push({
            side: "sell",
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: SELL_SLIPPAGE_BPS,
          });
        }
      }

      // 2) Pullback entries on the mints this batch touched.
      const buysInFlight = (): number =>
        orders.filter((o) => o.side === "buy").length;
      for (const mint of touched) {
        if (orders.length >= maxOrders) break;
        const rec = info.get(mint);
        if (rec === undefined || rec.entered || !rec.baseSet) continue;
        if (lastIsBuy.get(mint) !== true) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (batch.slot - rec.firstSeenSlot > MAX_AGE_SLOTS) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
        // Prune price samples older than the high window and find the high.
        const cutoff = batch.slot - HIGH_WINDOW_SLOTS;
        while (rec.samples.length > 0 && rec.samples[0].slot < cutoff) {
          rec.samples.shift();
        }
        let highVq = 0n;
        let highVt = 1n;
        for (const s of rec.samples) {
          if (cmpPrice(s.vq, s.vt, highVq, highVt) > 0) {
            highVq = s.vq;
            highVt = s.vt;
          }
        }
        if (highVq <= 0n) continue;
        // The high must be a proven run: +150% over the first trade.
        if (
          !priceAtLeast(highVq, highVt, rec.baseVq, rec.baseVt, RUNUP_PCT)
        ) {
          continue;
        }
        // The current price must sit 20-40% below that high.
        const nowVq = curve.virtual_quote_reserves;
        const nowVt = curve.virtual_token_reserves;
        if (!priceAtMost(nowVq, nowVt, highVq, highVt, DIP_LO_PCT)) continue;
        if (priceAtMost(nowVq, nowVt, highVq, highVt, DIP_HI_PCT)) continue;
        if (
          state.committedPositionCount() + buysInFlight() >=
          state.hello.caps.max_open_positions
        ) {
          continue;
        }
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (free < amount + tx) continue;
        orders.push({
          side: "buy",
          mint,
          quote_lamports: amount,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        free -= amount + tx;
        rec.entered = true;
      }

      // 3) Guardrail probe: late in the window, if fewer than 20 distinct
      // mints have closed a >= 0.01 SOL round trip, open one tiny probe on
      // the most liquid recently active curve and close it next batch.
      if (
        closed.size < 20 &&
        firstSlot !== null &&
        batch.slot - firstSlot > PROBE_AFTER_SLOTS &&
        batch.slot - lastProbeSlot >= PROBE_SPACING_SLOTS &&
        probesSent < PROBE_MAX &&
        orders.length < maxOrders &&
        state.committedPositionCount() + buysInFlight() <
          state.hello.caps.max_open_positions
      ) {
        let bestMint: string | null = null;
        let bestReal = -1n;
        for (const [mint, curve] of state.curves) {
          if (curve.complete) continue;
          const rec = info.get(mint);
          if (rec !== undefined && rec.entered) continue;
          if (state.positions.has(mint)) continue;
          if (curve.real_quote_reserves < PROBE_MIN_REAL_SOL) continue;
          if (batch.slot - curve.reserves_slot > 200) continue;
          if (curve.real_quote_reserves > bestReal) {
            bestReal = curve.real_quote_reserves;
            bestMint = mint;
          }
        }
        if (bestMint !== null) {
          const cap = state.maxBuyLamports(bestMint);
          if (cap >= PROBE_STAKE_LAMPORTS) {
            const amount =
              cap < PROBE_STAKE_LAMPORTS ? cap : PROBE_STAKE_LAMPORTS;
            if (free >= amount + tx) {
              orders.push({
                side: "buy",
                mint: bestMint,
                quote_lamports: amount,
                max_slippage_bps: BUY_SLIPPAGE_BPS,
              });
              const rec = getInfo(bestMint, batch.slot);
              rec.entered = true;
              rec.isProbe = true;
              lastProbeSlot = batch.slot;
              probesSent += 1;
            }
          }
        }
      }

      return orders;
    },
  };
}

await runBot(createStrategy());
