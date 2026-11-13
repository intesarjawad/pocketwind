# 012: Precision modes

Status: accepted; the hash-rounded storage path passes the tier-L precision gate on Metal.

## Context

Half-precision storage reduces population memory, but unscaled shifted populations lose small
deviations. The solver already stores g_i = f_i - w_i in both precision modes. Repeating the
shift would corrupt the state.

## Decision

Support f32 and optional shader-f16 storage with f32 arithmetic. Scale shifted populations by
32768 when storing f16 and undo the scale when loading. Auto selects f16 when the adapter
advertises shader-f16, following the current numerics' Ahmed tier-L Cd comparison within 2%.
The UI labels this choice “Auto (float16 if supported)”. Explicit float32 remains available;
unsupported f16 requests fall back to float32. ADR-013's older drag rows predate this storage change.

For normal f16 values, use stochastic neighbour selection instead of native nearest rounding.
A deterministic lowbias32 hash of cell, direction and scaled f32 value supplies 13 random bits;
round the discarded 13 significand bits upward with their proportional probability. The
selected value is exactly representable in f16 before the native cast. This decorrelates
rounding without a state buffer or a change to the format, scale, loads or f32 arithmetic.
Subnormal values retain the native conversion and its existing flush-to-zero limitation.

This is hash-based rounding, not an independent random process or exact mass conservation.
A normal population's relative storage error remains below 2^-10, hence below the recorded
1e-3 quiet-flow limit. No population is altered to absorb another population's error.

## Evidence

Measured on the Apple M5, Chromium 156 and WebKit 27.2, 2026-11-11. A direct 65,536-value
conversion probe found zero differences between native f16 casts, pack2x16float and Node's
nearest-even Math.f16round. The observed mass loss is correlated binary16 quantization,
not evidence of a Metal conversion bias.

The seeded 32³ TRT/bounce-back GPU-versus-CPU test retains the recorded 2e-3 limit after 100 steps:

| Storage | Population error | Density deviation error | Velocity error |
| --- | ---: | ---: | ---: |
| Original f16, Chromium | 1.0099e-3 | 2.1958e-3 (fail) | 4.3579e-4 |
| Hash-rounded f16, Chromium | 9.0486e-4 | 1.9563e-3 | 4.0951e-4 |
| Hash-rounded f16, WebKit | 8.9646e-4 | 1.9748e-3 | 4.0663e-4 |
| f32, Chromium | 1.6025e-6 | 6.9085e-6 | 5.0968e-7 |

Mean density error from the stored populations, relative to the CPU trajectory (the blob has
open boundaries, so its raw mass is not invariant):

| Step | Original f16 | Hash-rounded f16, Chromium | f32, Chromium |
| --- | ---: | ---: | ---: |
| 0 | -5.5633e-6 | 1.2391e-8 | -5.6593e-10 |
| 1 | -9.4181e-6 | -9.7129e-9 | -5.0147e-9 |
| 10 | -1.2894e-5 | 5.7599e-8 | -2.8381e-9 |
| 50 | -1.3840e-5 | 6.1254e-7 | -7.0293e-9 |
| 100 | -1.4095e-5 | 3.2098e-7 | -9.4894e-9 |

A separate periodic uniform-flow regression removes boundary flux. The original f16 path
starts at -5.7220e-6 density deviation and settles at -1.4782e-5 by step 10; f32 stays within
6.0e-9 through step 100. The regression checks both quiet flow (u=0.004) and u=0.06 on the
same 32³ grid, plus every initial population against the 1e-3 relative storage bar.
With hash rounding, Chromium reads 1.6965e-8 at step 100 for quiet flow and 2.8203e-7
for u=0.06, both within the regression's 2e-6 mean-density limit.
GPU comparisons write checkpoint measurements as JSON test attachments.

### Tier-L gate and throughput, 2026-11-12

The full validation matrix used the wall positivity guard and hash-rounded storage path,
numerics hash `5fb0514dd818762991709b6cfca8d3f7d60b82bff214b9ab3670bd2ce3d86b3b`.
The Ahmed 25-degree L REG cases differ only in storage:

| Storage | Mean Cd | Wall ms/step | 1-minute load at completion |
| --- | ---: | ---: | ---: |
| f32 | 0.7890466948739153 | 8.232 | 51.56 |
| f16 | 0.7883635810105152 | 5.630 | 101.46 |

The relative gap is **0.08657458016591774%**, below the unchanged **2%** gate.
Both cases still fail the experimental drag reference; storage agreement does not establish
physical accuracy. Their wall timings include host contention and are not a paired GPU benchmark.

[The rounding benchmark](../../bench/precision-hash.mjs) runs three alternating-order repetitions
of f32, current f16 and the pre-hash f16 prelude from `8fbc698`, with the current common shader.
It uses an empty periodic tunnel, TRT + LES, five warmup steps and 500 measured steps.
GPU timestamps bracket the measured solver passes; 1-minute load ranged from 94.00 to 114.24.
Run it from the repository root with `node bench/precision-hash.mjs` after `npm run build`.
Raw intervals and their load averages are written to `bench/precision-hash-results.local`.

| Tier | f32 MLUPS | Hash-rounded f16 MLUPS | Pre-hash f16 MLUPS | Hash throughput loss | f16 gain over f32 |
| --- | ---: | ---: | ---: | ---: | ---: |
| S | 511.902 | 709.471 | 793.021 | 10.54% | 38.60% |
| M | 520.111 | 694.730 | 787.585 | 11.79% | 33.57% |
| L | 551.534 | 683.133 | 785.585 | 13.04% | 23.86% |

## Consequences

Request shader-f16 only when advertised. Auto can now use its memory and throughput benefit
on this measured path; explicit f16 requests retain the existing warning when unsupported.
The validation matrix keeps an explicit f32 baseline and a separate f16 row. Other adapters
still need their own accuracy and performance evidence; the Metal result is not a universal
speedup or physical-validation claim.

## Sources

- Lehmann et al. (2022), [Accuracy and performance of the lattice Boltzmann method with
  64-bit, 32-bit, and customized 16-bit number formats](https://doi.org/10.1103/PhysRevE.106.015308):
  source for shifted populations and scaled binary16 storage; the hash rounding here is a local change.
- [WGSL floating-point accuracy](https://www.w3.org/TR/WGSL/#floating-point-accuracy):
  WGSL does not require nearest-even rounding, so changing a cast to pack2x16float is not a
  portable guarantee of that rounding mode.
- [Hash Function Prospector, lowbias32](https://github.com/skeeto/hash-prospector#two-round-functions):
  source of the integer mixer constants.
- [Numerical reference](../numerics.md#limits-and-precision): storage scale and limitations.
