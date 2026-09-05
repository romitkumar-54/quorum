# Decisions

What the team has settled on, newest first. Each entry is written to be pinned
into the Atrium room as-is.

---

## 2026-09-05 — The coordinator owns the brain; Agora agents are voices

Agora Conversational AI's `turn_detection` supports only `agora_vad`,
`server_vad` and `semantic_vad`. **All three are voice-activity based, and none
of them lets an agent stay silent until instructed.** So three agents with their
own LLMs all answer the moment the candidate stops talking — which is precisely
the collision Quorum exists to prevent.

We therefore keep the brain on our side. Agents join with `remote_rtc_uids: []`
so they never hear the candidate and never self-trigger. Agora ASR transcribes,
our coordinator grants the floor, one LLM call writes that agent's line, and it
is pushed to that agent alone via `speak`.

Agora stays core: RTC, ASR, agent instances, TTS voices, `speak`/`interrupt`.

**Rejected:** letting each agent run its own LLM. Free personalities, but the
coordinator degrades to cutting two interviewers off mid-word every turn, and
the project's central claim collapses.

**Deferred, not rejected:** Agora's Go and Python SDKs expose a `Think` method
that injects instructions into a running agent. If it turns out to be reachable
over REST, agents could keep their own LLMs with the coordinator triggering only
the winner. Could not be confirmed from public docs. The generator stays behind
an interface so this can replace it without touching the coordinator.

## 2026-09-05 — Work is phased, and only Phase 1 is unblocked

| Phase | Scope | Blocked on |
| --- | --- | --- |
| 1 | Async generator seam, personas, prompt assembly, LLM generator, fallback | nothing |
| 2 | Browser RTC join, transport swap, join-payload fixes | Agora credentials |
| 3 | Candidate transcripts from Agora's message channel; retire `CandidateEar` | Agora credentials |

Plan for Phase 1: `docs/superpowers/plans/2026-09-05-coordinator-brain.md`.
Design: `docs/superpowers/specs/2026-09-05-coordinator-brain-design.md`.
Phases 2 and 3 get their own plans once credentials exist — writing exact steps
against an API nobody can call would be fiction.

## 2026-09-05 — The rehearsed demo always runs on ScriptedGenerator

One path has to be identical every time it runs. The rehearsed interview forces
the deterministic generator regardless of whether a key is present, and every
LLM failure or timeout falls back to it silently. A duller question beats a
visible error mid-interview.

## 2026-09-05 — ASR language is `en-IN`, not `en-US`

Hardcoded `en-US` in two places: the browser recogniser
(`src/speech/index.ts`) and the Agora join payload
(`src/app/api/agent/route.ts`). Agora's ARES ASR supports `en-IN` explicitly,
alongside `hi-IN`, `ta-IN`, `te-IN`, `kn-IN`, `gu-IN` and `bn-IN`. Moving to
Agora without changing this would carry the same mistake to a new vendor.

## 2026-09-05 — A spoken turn ends on silence, not on Chrome's phrase boundary

Chrome marks a result `isFinal` at every phrase boundary, so one answer arrived
as three or four separate turns. Turns now end after 1.2s of silence
(`SILENCE_MS`, `src/speech/index.ts`). The microphone is also deafened while the
panel speaks, or the interviewers get transcribed as the candidate's next answer.

## Open blockers

- **Agora credentials do not exist.** `AGORA_APP_ID`, `AGORA_CUSTOMER_ID`,
  `AGORA_CUSTOMER_SECRET`. Contest rules require Agora Conversational AI as a
  core component, so this gates the submission, not just Phases 2 and 3.
- **`LLM_API_KEY` does not exist.** Phase 1 is buildable and testable without
  it, but no dynamic question can be heard until one is set.
- **The product name is unconfirmed.** "Quorum" was a proposal, never ratified.
  The strategy deck still lists naming as an open gap.
