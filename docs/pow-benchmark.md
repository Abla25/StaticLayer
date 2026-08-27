# Proof-of-Work benchmark

The Proof-of-Work is a SHA-256 leading-zero-bits search over the canonical
payload, with the difficulty set server-side. Expected solving time roughly
doubles for each +1 bit of difficulty.

## How to reproduce

```sh
node scripts/pow-benchmark.mjs
```

The script uses the real `@staticlayer/protocol` (`mineNonce`) with a random
32-byte challenge, 3 rounds per difficulty, and reports median/min/max.

## Reference results

Measured on **Apple Silicon (darwin/arm64), Node v25.6.0** — 2026-08-27.

| Difficulty | Median | Min | Max | Notes |
| --- | --- | --- | --- | --- |
| 10 | ~98 ms | 26 ms | 323 ms | hero widget demo |
| 12 | ~147 ms | 89 ms | 176 ms | snappy on any device |
| 14 | ~171 ms | 27 ms | 1.8 s | good default for blogs |
| 16 | ~583 ms | 326 ms | 4.4 s | **default** (`POW_DIFFICULTY: 16`) |
| 18 | ~2.8 s | 1.8 s | 10.0 s | stricter (public demo uses 18) |
| ≥ 20 | minutes | — | — | impractical for interactive use |

Results vary widely with hardware and CPU load (see min/max spread). The
default of 16 keeps the median under a second on this class of hardware while
still costing a real, measurable effort per automated submission.

## Choosing a difficulty

- `POW_DIFFICULTY` is a plain var in your worker config (`wrangler.jsonc`).
- Lower = friendlier for visitors, weaker anti-bot signal.
- Higher = stronger anti-bot, worse UX on slow devices.
- Moderation remains the final gate regardless of difficulty.
