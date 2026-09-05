# What we measure

No hackathon voice demo is ever measured. Everyone says "it feels responsive" and moves on. These four numbers are computed from the coordinator's own decision log during a real run and shown on screen while the demo is happening — so "our panel coordinates" is a claim a judge can check rather than take.

Implemented in `src/core/metrics/index.ts`.

## The four numbers

### Floor latency — p50 / p95

Milliseconds from *the candidate stopped speaking* to *an agent has the floor*. This is the number a listener actually experiences as the panel being quick or slow.

Nearest-rank percentile over every decision that put somebody on the floor. Nearest-rank rather than interpolated because n is small in a single interview and interpolation would invent precision we do not have.

### Collision rate

Turns where two or more agents spoke at once, over turns run.

This is the metric the whole project exists to drive to zero, and the only one that can be demonstrated *going wrong on demand*: turn the coordinator off and it goes to 100%.

### False-interrupt rate

Interrupts that cut the previous speaker off before they had a chance to finish a thought, over all interrupts.

An interrupt landing within **1200 ms** of the previous agent taking the floor counts as false. Cutting somebody off is only defensible if they got to make their point first, and a system that interrupts constantly is worse than one that never does — so we hold ourselves to a number that can go against us.

### Turns run

Denominator for the two rates, and a sanity check that the run was long enough for the others to mean anything.

## Measured run

Rehearsed three-turn interview, 5 September 2026, Chrome on Windows.

| | Coordinator on | Coordinator off |
| --- | --- | --- |
| Turns run | 3 | 3 |
| Collisions | **0** | 3 |
| Collision rate | **0%** | 100% |
| Floor latency p50 | 78 ms | 75 ms |
| False interrupts | 0 (0%) | — |
| Requirements demonstrated | 11 / 11 | 9 / 11 |

Latency is comparable in both modes, which is the honest result and the useful one: **the coordinator is not the cost.** Deciding who speaks takes tens of milliseconds. What changes between the two columns is only whether the answer is right.

With the coordinator off, "controlled interviewer turn-taking" un-ticks in the requirement ledger, because it is not true. The ledger reads live session state rather than a checklist we wrote.

## What these numbers are not

- **Not end-to-end audio latency.** They measure the coordinator's decision, not network or TTS time. With Agora carrying the audio, total time-to-speech is the sum of this and the Conversational AI pipeline; this is the part we wrote and the part we can defend.
- **Not a benchmark against other systems.** There is nothing to compare against, because single-agent systems cannot collide.
- **Not turn-appropriateness.** Whether the *right* interviewer took the floor is a human judgement. Our proxy is that every grant carries a reason traceable to a flag in the brief — visible on screen for a judge to disagree with in real time.
