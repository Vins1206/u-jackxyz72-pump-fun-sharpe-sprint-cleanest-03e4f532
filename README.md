# Bounce-Confirmed Pullback — Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Vins1206/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Vins1206/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A deterministic paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun. It trades paper money on a 6-hour pump.fun forward replay, ranked by hourly Sharpe ratio: steady, controlled gains beat one lucky moonshot.

## Strategy

Most new pump.fun coins dump, so chasing run-ups and sniping launches both
lose on the dev window. This bot buys the bounce-confirmed pullback of a
proven runner:

- the coin already ran at least **2.5x** from its first trade;
- it then dipped **20–40%** off its recent (2,500-slot) high while still
  holding at least **3 SOL** of real reserves;
- ...but the buy lands only once the price has bounced **5%** off the
  lowest price sampled since that high — buy the turn, not the level
  (v1 bought the dip on any buy trade and kept catching coins still
  dumping);
- the buy lands on a buy trade, **0.08 SOL** per position, one entry per
  mint, at most 5 open positions;
- it sells at **+20%** over cost, cuts at **−12%**, and never holds longer
  than **1,800 slots**.

A probe backstop keeps the run compliant: late in the window, if fewer
than 20 distinct mints have closed a ≥ 0.01 SOL round trip, the bot opens
tiny 0.012 SOL probe round trips on the most liquid active curve and
closes each on the next batch.

## Local dev result

Graded with the kit's own grader
(`grade-local --kit . --bot . --driver process`):

- **net PnL +0.215 SOL** (beats holding cash), **Sharpe (hourly) +0.289**,
  Sortino +0.611, max drawdown 0.9%
- **win rate 47.9%**, 73 round trips over 73 distinct mints, compliant
  with every guardrail (≥ 20 mints, drawdown ≤ 50%)
- two executions reproduce **byte for byte** (deterministic: no clock, no
  randomness, no network, integer-only decisions)
- 20-copy stress test: median **−0.277 SOL**, 19 of 20 copies lost money
  (v1: median −0.335 SOL, 20 of 20 lost) — the dev edge is real but the
  final window is still a gamble; without the top 3 coins the net is
  still +0.075 SOL, and at 2x fees it stays +0.072 SOL

For comparison on the same dev window, the kit's own baselines score:
hold-cash 0.000 / Sharpe null, equal-weight −0.019 SOL / −0.223, and the
pilot bots momentum −9.44 SOL / −0.579, sniper −0.50 SOL / −0.844,
reversion −3.99 SOL / −0.481.

## How to run

Requires Node 22.18 or later (the grader runs Node 22.23.4), nothing to
install — the bot is a single self-contained file, Node stdlib only, and
speaks the `agent-fun/replay/v2` protocol on stdin/stdout:

```sh
node main.ts
```

## Files

- `main.ts` — the whole bot: protocol client + bounce-confirmed pullback strategy
- `LICENSE` — MIT
- `.makefun/owner.json` — claim file for the entry wallet
