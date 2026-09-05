# Decisions

What the team has settled on, newest first. Each entry is written to be pinned
into the Atrium room as-is.

---

## 2026-09-06 — What the first real conversation broke

Everything above was verified by driving the app. This entry is what a person
found in the first minute of actually talking to it, and none of it was visible
from a passing test.

### One interviewer ran the whole interview

Behavioural answered every turn; Technical and Product never spoke. Two causes,
and they needed each other:

- `RuleAnalyzer.classify` returns `communication` for any sentence matching
  neither the impact nor the algorithm vocabulary — which is most ordinary
  speech — and `communication` is Behavioural's competency, worth the full
  `RELEVANCE_WEIGHT` of 4. Nothing else can reach that from a baseline of 1.
- The anti-monologue cap, `MAX_CONSECUTIVE`, was only ever checked inside
  `honour`, which runs on a **model's nomination**. Retiring `LlmFloor` left
  `preferred` permanently null, so the cap stopped being reached at all.

The cap now applies to whoever actually wins the floor, not only to a nominee.
`tests/rotation.test.ts` reproduces the original failure — six ordinary answers,
one speaker — and fails without the fix.

That cap is the safety net. The cause was the classifier, and it is fixed too.

### Each interviewer has its own vocabulary now

`classify` answered three questions with two tests — impact language, or
algorithm language, or, for everything else, `communication`. Behavioural
therefore owned all ordinary speech, and since the lead competency carries the
largest single term in a bid, it owned the interview.

Three changes, in `src/core/brief/analyzer.ts`:

- **Behavioural has a real vocabulary.** Teams, managers, disagreement,
  explaining, feedback, deadlines, mistakes. It earns a turn on the same terms
  as the other two rather than by default.
- **Signals are weighed, not ordered.** A sentence goes to whichever territory
  it points at hardest, so "I refactored the database schema and the team saw
  it" is Technical's and not filed under whichever test happened to run first.
  Ties still go to Product, keeping the older reading of "faster for users".
- **A sentence may point nowhere.** `AnalysisResult.lead` is now optional, and
  "I studied computer science at university" names nobody. No relevance bonus is
  handed out, and the floor moves on fairness instead. This is the actual bug:
  biography used to be a claim on Behavioural's territory.

`InterviewSession` takes the lead from the analyst rather than reading it off
the first claim, because only the analyst knows whether the sentence pointed
anywhere at all.

Verified live against Agora — three answers, three interviewers, each asking
about its own subject:

```
candidate    I replaced the linear scan with a hash map so lookups are constant time.
  technical  "How do you handle hash collisions in your constant time lookup?"

candidate    It cut checkout time for our customers and conversion went up by 4 percent.
  product    "How did you measure that 4 percent increase in conversion, and over
              what time period?"

candidate    My manager disagreed with me so I explained the trade-off to the team.
  behavioural "You said your manager disagreed, but then you explained the
              trade-off to the team…"
```

### The microphone died and blamed the candidate

Any recogniser error that was not explicitly benign called `stop()` and reported
*"Microphone unavailable or permission denied."* Chrome raises `network` against
its own recognition service on a long session, so one blip ended listening for
the rest of the interview while the page went on saying "Listening…".

Only `not-allowed` and `service-not-allowed` are fatal now. Everything else
reopens, with a widening backoff so a failing recogniser cannot spin.

### `en-IN` was decided on 2026-09-05 and only half-applied

That decision named two places: the Agora join payload and the browser
recogniser. The route was changed; `src/speech/index.ts` was left on `en-US`,
scoring Indian English against a US model for a day.

### A spoken line is not finished when the request returns

Agora's `speak` resolves when the request is **accepted**, not when the agent
stops talking — the simulator's resolves on the last word, which is why nothing
caught it. The session therefore believed the panel was done while it was still
mid-sentence: the microphone reopened into the panel's own voice, and the next
`think` was dropped outright, because every `think` carries
`on_speaking_action: 'ignore'`. That is why the turn after the greeting fell
back to a scripted line for no visible reason. The session now waits out the
estimated speech duration.

### The interview opened cold

It began with a bare question — no greeting, and the AI disclosure lived only in
the header. `ScriptedGenerator` accepted an `opening` flag and ignored it. There
is now a fixed `OPENING_LINE`: hello, the disclosure, a warning that three
interviewers will take turns, and an easy first question. It is spoken rather
than generated so the disclosure cannot drift.

---

## 2026-09-06 — The panel is on Agora, and the LLM moved from the decision to the words

The transport swap is done. `AgoraTransport` is constructed when the server
holds all four credentials, three agents are created when the interview starts,
the floor is granted with `think`, and the transcript is read back from
`history`. Verified live, in a browser, on this date.

**What the panel says is now written inside Agora.** Nothing in this process
composes an interviewer's line any more, except as a fallback.

### The external model is gone

`LlmGenerator`, `LlmAnalyst`, `LlmFloor`, `requestCompletion`, the message
builder and `/api/interviewer` are deleted. No source file reads `LLM_API_KEY`,
and `.env.example` still lists exactly four credentials.

**The accepted consequence:** the floor *decision* is now pure code. `LlmFloor`
nominated a speaker and the `Coordinator` ruled on it; with no model on this
side there is nothing to nominate, so the coordinator decides alone. This is
still LLM + code — the split just moved. The LLM writes the words; the code
picks the mouth. Restoring a nominator needs either an external key or a fourth
agent, and both are new architecture.

`RuleAnalyzer` stays and is not a fallback: it builds the brief — claims, flags,
difficulty — which is what the coordinator ranks bids on, and none of it wants a
model. `ScriptedGenerator` stays as the line an agent gets when Agora does not
answer in time.

### The opener is spoken, never thought

The first line discloses that the panel is not human. That is a requirement, not
a flourish, so it goes out through `speak` with fixed words. A model asked to
greet a candidate might not disclose anything.

### One channel per interview

`interview-01` was a single room. Two candidates at once meant the second was
rejected for the uid the first was holding, and had they both got in they would
have heard each other. Channels are now `interview-<n>` per visit, and agents are
keyed by channel *and* role in the route — keyed by role alone, a second join
overwrote the first and one candidate's coordinator steered another's panel.

### Leaving is a money bug, and it is handled

With `idle_timeout: 0` an agent never exits on its own; three left behind bill
about $18/hour to Agora's 72-hour cap. Leaving now happens on End, on unmount,
and on tab close via `navigator.sendBeacon` — `fetch` during unload is routinely
cancelled. The server also sweeps any agent still running in a channel it is
about to claim, because the route's memory of live agents does not survive a
restart. **Verified:** three agents RUNNING, tab killed, zero left.

### Still not verified

Barge-in against live Agora audio (requirement 1) has never been tested with a
human voice, and token renewal has never been watched across the one-hour
expiry. Both are written; neither has been seen working.

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
