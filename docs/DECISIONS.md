# Decisions

What the team has settled on, newest first. Each entry is written to be pinned
into the Atrium room as-is.

---

## 2026-09-06 — The design is no longer a plan. It ran.

Everything below this entry was reasoned from documentation. This one was
measured against the live API, and three of the assumptions were wrong.

**The panel works end to end.** Three interviewers joined one channel, all deaf.
The coordinator granted the floor to one, that agent's Agora-managed model wrote
the line and spoke it, and the other two stayed silent. Then the floor moved and
the same thing happened for the second agent. Nobody collided.

```
coordinator grants floor -> technical
  technical    "How do you handle cache invalidation to ensure data
                consistency during checkout?"
  product      (silent)
  behavioural  (silent)

coordinator moves floor  -> product
  product      "How did reducing the checkout time by 400 milliseconds
                impact user conversion or satisfaction?"
  behavioural  (silent)
```

Both questions came out of Agora's managed `gpt-4.1-mini`. No external model is
involved anywhere in this project.

### What the live API corrected

| Assumption | Reality |
| --- | --- |
| `remote_rtc_uids: ["*"]` lets agents hear each other | No such wildcard on this field. One uid only. The `["*"]` in the docs is for `tools`. |
| A deaf agent might not be allowed | Accepted. `["1099"]`, a uid nobody joins as, works and the agent stays RUNNING. |
| ARES for ASR, since it supports `en-IN` | Rejected: *"vendor 'ares' is not available for the current SKU when credential_mode is 'managed'"*. Deepgram `nova-3` takes `en-IN` and was accepted. |
| Managed mode means no vendor URL needed | `params.url` is still required. Omitting it fails with *"required field is missing"*. Undocumented. |
| `think` might not be reachable over REST | It is. `POST /v2/projects/{appid}/agents/{agentId}/think`. This resolves the item deferred on 2026-09-05. |

### The failure that cost the most

With an App Certificate enabled and `token: ""`, Agora **accepts** the join,
returns `status: RUNNING`, and then kills the agent about a second later:

```
[0.7s] RUNNING
[3.1s] FAILED  -- "agent exits with reason: RTC connection error"
```

The join succeeding is what makes this expensive to diagnose. Tokens are now
minted per join in `src/app/api/agent/route.ts`, signed for one channel and one
uid, and `AGORA_RTC_TOKEN` is gone from the environment.

### The shape that resulted

`think` is the seam the project turns on. It injects text into one agent's
pipeline as if the candidate had said it, so the words come from Agora's model
while the choice of who was asked stays in our code. Dynamic and deterministic,
with neither half guessing at the other's job.

`GET /agents/{id}/history` is how the transcript learns what was said, since in
coordinated mode the words are written inside Agora and never pass through this
process. A coordinator-driven turn is identifiable there by
`metadata.start_type: "api_think"`.

**Still open:** the browser does not yet join the RTC channel, so nothing is
audible in the UI. The route mints a candidate token (`action: 'token'`, uid
1000) and the Web SDK join is the next piece.

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
