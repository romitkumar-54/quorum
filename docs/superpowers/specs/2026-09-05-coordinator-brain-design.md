# Coordinator-Owned Brain — Design

**Date:** 2026-09-05
**Status:** Approved (approach B, 2026-09-05)

## Problem

The interviewers say hardcoded lines. `ScriptedGenerator` (`src/agents/index.ts:31`)
picks from a fixed ladder and a handful of flag templates. Every candidate hears
the same interview.

The panel must instead answer *what the candidate actually said*, in three
distinct voices, without losing the property the project exists to demonstrate:
exactly one interviewer holds the floor, and the words it says match the reason
it was granted the floor.

## The constraint that decides the architecture

Agora Conversational AI's `turn_detection` supports `agora_vad`, `server_vad`
and `semantic_vad`. All three are voice-activity based. **There is no mode in
which an agent stays silent until instructed.**

So an Agora agent configured with an LLM answers on its own, every time the
candidate stops speaking. Three such agents in one channel all answer at once —
which is exactly the failure the coordinator exists to prevent. Autonomy and
coordination are in direct conflict, and only one of them can win.

## Decision

**The coordinator owns the brain. Agora agents are voices.**

- Agents join with `remote_rtc_uids: []`. They never hear the candidate, so they
  never self-trigger.
- Agora ASR transcribes the candidate; the transcript reaches the app over the
  message channel.
- The coordinator ingests it, updates the shared brief, and grants the floor.
- **One** LLM call produces that agent's line, carrying its persona, the shared
  brief, and the flags it won the floor for.
- The line is pushed to that agent alone via `POST /agents/{id}/speak`.

Agora remains core: RTC transport, ASR, agent instances, TTS voices, and the
`speak`/`interrupt` priority system.

### Rejected alternatives

**Autonomous agents.** Each agent gets its own `llm.system_messages` and replies
independently. Personalities for free, no generator code. Rejected: all three
answer simultaneously and the coordinator degrades to cutting two of them off
mid-word, audibly, every turn. The project's central claim collapses.

**Agent-side LLM with a coordinator trigger.** Agora's Go and Python SDKs expose
a `Think` method that injects instructions into a running agent. If that were
reachable over REST, agents could keep their own LLMs and the coordinator would
trigger only the winner. Deferred, not rejected: its presence in the REST surface
could not be confirmed from public documentation. The design below keeps the
generator behind an interface so this can replace it without touching the
coordinator.

## Architecture

### The async seam

`QuestionGenerator.next()` returns `string` today. An LLM call cannot be
synchronous, so it becomes `Promise<string>`, and `InterviewSession.candidateSays()`
becomes `async`. This ripples to `src/app/page.tsx` and `tests/coordinator.test.ts`.

This is the largest single change in the work, and it is mechanical rather than
subtle. `ScriptedGenerator` becomes `async` and returns immediately, so timing,
determinism and every existing assertion are preserved.

In collision mode up to three lines are generated for one turn. They are
generated with `Promise.all`, never in sequence.

### Personas

`AgentProfile.role` (`src/core/contracts.ts:232`) is a one-line label, not a
personality. Personas live in a new `src/agents/personas.ts` so that
`contracts.ts` stays a types-and-registry file.

Each persona states who the interviewer is, what it owns, how it *speaks*, and
the hard constraints: one question, at most two sentences, no preamble, no
breaking character.

### Prompt assembly

`src/agents/prompt.ts` turns a `GenerationInput` into chat messages. It carries:

1. the persona system prompt
2. the shared brief — claims, open flags, difficulty
3. the last few transcript turns
4. **`justifiedBy` — the flags this agent won the floor for**

Item 4 is the one that matters. It is what preserves the existing property that
the line on the speaker matches the reason on screen. It is separately tested.

### The call

`src/agents/llmClient.ts` holds the request logic and takes `fetch` as a
parameter, so it is testable without a network. `src/app/api/interviewer/route.ts`
is a thin wrapper that keeps the API key server-side — the browser never sees it.
The request shape is OpenAI-compatible, so OpenAI, Groq, Together and others all
work through `LLM_URL` / `LLM_API_KEY` / `LLM_MODEL`, which `.env.example`
already documents.

### Fallback

`LlmGenerator` takes `{ fallback: new ScriptedGenerator(), timeoutMs: 4000 }`.
Any error or timeout yields the scripted line instead. Two consequences:

- A dead key or a slow model on stage degrades to the deterministic panel rather
  than to silence.
- **The rehearsed demo always uses `ScriptedGenerator` directly.** One path must
  be identical every time it runs.

## Consequences

**Latency becomes real.** An LLM call sits between the candidate finishing and
the panel replying — 1–3s on top of the modelled `decisionLatency`. The "Floor
latency p50" meter will show real numbers instead of 78ms. This is honest, and
it is a change in what the demo looks like.

**Cost.** Three concurrent Agora agents each carry LLM and TTS spend, and burn
Agora minutes three times as fast as one.

**Two credentials are still missing.** Neither `LLM_API_KEY` nor the Agora
credentials exist. Phase 1 is fully buildable and testable without either,
because the fallback path is what the tests exercise.

## Phasing

| Phase | Scope | Blocked on |
| --- | --- | --- |
| 1 | Async seam, personas, prompt assembly, LLM generator, fallback, wiring | nothing |
| 2 | `agora-rtc-sdk-ng` browser join, transport swap, join-payload fixes | Agora credentials |
| 3 | Candidate transcripts from the Agora message channel; retire `CandidateEar` | Agora credentials |

Phase 2 also fixes two existing defects: `turn_detection.mode` is `'default'`
(`src/app/api/agent/route.ts:123`), which is not a documented value, and
`asr.language` is hardcoded `'en-US'` where `en-IN` is supported and more
accurate for the team's speakers.

Phases 2 and 3 get their own plans once credentials exist. Writing exact steps
for an API that cannot be called would be fiction.
