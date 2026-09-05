# Architecture

## The idea in one paragraph

Four people building a real-time system will be slower than one, because they spend the time waiting on each other. The fix is not standups — it is fixing the data shapes before anyone writes code, so each lane can run against a fake of the others. Three shapes were frozen on day one. They live in `src/core/contracts.ts`, nothing else may redefine them, and every lane boundary in the repo is one of them.

## The three contracts

```
                    ┌──────────────────────────────┐
   candidate ──────▶│ LANE A · transcript capture  │
   speaks           │ timestamps from event one    │
                    └──────────────┬───────────────┘
                                   │ TranscriptEvent
                                   ▼
                    ┌──────────────────────────────┐
                    │ LANE C · the shared brief    │
                    │ claims · flags · difficulty  │
                    └──────────────┬───────────────┘
                                   │ Brief
                                   ▼
                    ┌──────────────────────────────┐
                    │ LANE B · the coordinator     │
                    │ bids ▸ one winner ▸ reason   │
                    └──────────────┬───────────────┘
                                   │ FloorDecision
                                   ▼
                    ┌──────────────────────────────┐
                    │ LANE D · the surface         │
                    │ who is on air, and why       │
                    └──────────────────────────────┘
```

### 1 · `TranscriptEvent` — lane A emits, lane C consumes

Every utterance, with start and end timestamps, captured at the edge before anything reads it. Evidence-linked feedback is cheap when the timestamps are already there and expensive to retrofit when they are not, so this is the one thing built first.

### 2 · `Brief` — lane C owns, lanes B and D read

Claims, flags, difficulty and per-competency scores. Each flag carries the `Evidence` that raised it — the event id, the timestamp and the quote — so every judgement in the final report traces back to a moment in the conversation.

Each flag also carries a `competency`. That one field is what makes the panel behave like a panel: an interviewer only challenges flags in its own area, so a hand-wavy claim about customer impact belongs to Product, not to the engineer who was perfectly satisfied by the algorithm.

### 3 · `FloorDecision` — lane B emits, lanes A and D consume

Who got the floor, who bid, what each of them scored, why the winner won, and how long the decision took. The UI renders the `reason` string verbatim — what the screen says and what the coordinator decided cannot drift apart, because they are the same string.

## Repository layout

Directory ownership is the lane contract. If you are in your own directory you cannot break anyone else.

```
src/
  core/                  framework-free TypeScript · no React · unit-tested
    contracts.ts         the three shapes — frozen
    transcript/          lane A — session clock, capture, timestamps
    coordinator/         lane B — silence, bids, grants, interrupt, yield
    brief/               lane C — analyzer rules, brief builder, assessment
    metrics/             latency percentiles, collision + false-interrupt rates
    session.ts           the loop that joins all four lanes
    demo.ts              the rehearsed scenario
    requirements.ts      the eleven requirements, each with a live predicate
  transport/             lane A — the Agora seam
    types.ts             the Transport interface
    simulated.ts         today: models agent IDs and remote_rtc_uids
    agora.ts             production: calls the control plane
  speech/                Web Speech: three distinct voices, candidate STT
  agents/                per-role question generation
  app/                   lane D — the gallery, plus /api/agent
  components/            lane D — rack, panels, report, ledger
tests/                   vitest
```

## One turn, end to end

```
candidate stops speaking
   │
   ├─ TranscriptLog.append()            → TranscriptEvent, timestamped
   ├─ BriefBuilder.ingest()             → claims, flags, difficulty
   │     └─ splits the utterance into sentences, so one breath can carry
   │        both a solid technical claim and a hand-wavy impact claim
   │
   ├─ Coordinator.openFloor()           → every agent bids off the brief
   │     score = baseline + relevance + flag urgency + fairness + priority
   │     └─ coordinated: exactly one winner
   │        naive:       everyone who bid speaks — a collision
   │
   ├─ the granted agent speaks, to the flag it won on
   │
   └─ Coordinator.considerInterrupt()   → mid-turn re-check
         a flag the holder does not own, urgent enough, belonging to
         somebody else → that agent cuts in, the holder yields mid-sentence
```

## The invariant

**At most one agent holds the floor at any instant.**

Enforced in `Coordinator`, and asserted in `tests/coordinator.test.ts` across 60 randomised sessions built from utterances that fire every rule. Naive mode is asserted to produce collisions; coordinated mode is asserted to produce none.

That test is the project. Everything else is a feature.

## Seams for what comes next

Three interfaces exist so that today's zero-credential build and the production build are the same code path:

| Interface | Today | Production |
| --- | --- | --- |
| `Transport` | `SimulatedTransport` — browser speech, modelled channel semantics | `AgoraTransport` — Agora Conversational AI |
| `Analyzer` | `RuleAnalyzer` — deterministic, no API key, fast enough for the live loop | An LLM-backed analyzer, same interface |
| `QuestionGenerator` | `ScriptedGenerator` — lines built from the flag that won the floor | One LLM per interviewer role |

Nothing above these interfaces changes when they are swapped. The coordinator does not know or care which side of the seam it is on.
