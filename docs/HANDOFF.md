# Handoff — everything left to a working Quorum

**Written 2026-09-06, at commit `8212c6a`.**

The goal is an end-to-end working site: a candidate opens a URL, talks, three
Agora interviewers question them one at a time, and a structured assessment
comes out. This file is the complete remaining technical work to get there.

The architecture and the decisions are already settled. **Your job is the queue
below, in order, and nothing else.**

Read this file, then `docs/DECISIONS.md`, then `docs/AGORA.md`, before touching
any code.

---

## Rules for this handoff

1. **Do not introduce new architecture.** No new abstractions, no new services,
   no swapping libraries, no "while I was in there" refactors.
2. **Do not relitigate the decisions** in `docs/DECISIONS.md`. They were paid for
   with live API calls. If you believe one is wrong, write down why and stop —
   do not act on it.
3. **Do the queue in order.** Phase 1 unblocks everything. Each item lists its
   files and how to know it is done.
4. **Verify before claiming.** Typecheck, run the tests, and for anything
   user-visible open a browser and look at it. Two real bugs here were invisible
   to the typechecker and obvious on screen.
5. **Every change keeps `npm test` at 84+ passing and `npx tsc --noEmit` clean.**
   One pre-existing `LayoutProps` error is expected — Next generates that type
   at build time.

---

## The architecture, in one paragraph

Agora Conversational AI gives us a **complete** agent — it hears, transcribes,
thinks, speaks, and can be interrupted. It has no concept of a second agent.
Quorum runs three in one channel, all **deaf** (`remote_rtc_uids: ["1099"]`, a
uid nobody joins as), so none self-triggers. Our coordinator decides who speaks
and grants the floor with `POST .../think`, which injects the candidate's answer
into exactly one agent; that agent's Agora-managed model writes the reply and
says it. **Dynamic words from Agora, deterministic choice from our code.** Every
model is Agora-managed — there is no external LLM key in this project.

Two planes that meet only in the channel:

```
  server  --REST-->  Agora  --creates-->  agents 1001/1002/1003   (control plane)
  browser --RTC--->  Agora  --joins---->  candidate uid 1000      (media plane)
```

---

## State of play

### Verified against the live API — do not redo

| Thing | Status |
| --- | --- |
| `POST /join`, managed ASR + LLM + TTS | ✅ 200, agent reaches and holds `RUNNING` |
| Deaf agent (`remote_rtc_uids: ["1099"]`) | ✅ accepted, stays alive |
| `POST .../think` → agent's model writes and speaks | ✅ verified twice, real output |
| `GET .../history` returns what was said | ✅ verified |
| `POST .../interrupt`, `POST .../leave` | ✅ both 200 |
| Per-join token minting (`agora-token`) | ✅ working |
| Browser joins as uid 1000, publishes mic | ✅ header reads `agora · in channel` |
| Coordinator, brief, analyst, metrics, report | ✅ 84 tests |
| All 11 requirements implemented + self-testing | ✅ `src/core/requirements.ts`, ledger ticks live |

One real run, three agents, through the app's own route:

```
floor → technical
  technical    "How do you handle cache invalidation to ensure data
                consistency during checkout?"
  product      (silent)
  behavioural  (silent)

floor → product
  product      "How did reducing the checkout time by 400 milliseconds
                impact user conversion or satisfaction?"
  behavioural  (silent)
```

### The central gap

**`AgoraTransport` is never instantiated.** `src/app/page.tsx:88` constructs a
`SimulatedTransport` unconditionally. `AgoraTransport.isConfigured()` is called,
but only to set a header flag. So today:

- the candidate really is in a real Agora channel
- **no agents are ever created by the app** — nothing calls `/api/agent` with
  `action: 'join'` outside the smoke scripts
- every interviewer voice you hear is the browser's speech synthesiser
- the transcript shows text `ScriptedGenerator` wrote, not what an agent said

The panel is audible and the transcript is honest **separately**. They are not
yet the same words.

---

## Facts already paid for — do not rediscover these

| Fact | Consequence |
| --- | --- |
| `remote_rtc_uids` accepts **one** uid | No `["*"]` on this field — that wildcard is for `tools`. Agents can never hear each other. |
| `vendor: "ares"` is **rejected** on this account | *"not available for the current SKU when credential_mode is 'managed'"*. Use `deepgram` / `nova-3`, which accepts `en-IN`. |
| `params.url` is **required** even in managed mode | Omitting it fails *"required field is missing"*. Applies to `asr` and `tts`. Undocumented. |
| `idle_timeout: 0` is required in coordinated mode | Agora exits an agent once the users in `remote_rtc_uids` leave, and uid 1099 never arrives. Any other value kills the panel mid-interview. **See Phase 2 item 3 — this also means agents never die on their own.** |
| Empty `token` + App Certificate enabled | Join returns **200 / RUNNING**, then the agent dies ~1s later: *"agent exits with reason: RTC connection error"*. The join succeeding is what makes this expensive to diagnose. Tokens are minted per join — do not reintroduce `AGORA_RTC_TOKEN`. |
| A `think`-driven turn is tagged in history | `metadata.start_type: "api_think"` on the `user` entry. This distinguishes a coordinator-driven turn from a self-triggered one. |
| React StrictMode double-mounts the effect | `RtcChannel` join/leave are serialised through one queue **and** the instance is kept on the ref across remounts. Both halves are needed; serialising alone still raced. Do not "simplify" this. |
| `speak` caps text at 512 bytes | Already sliced in the route. |
| Token TTL is 1 hour | `TOKEN_TTL_SECONDS` in the agent route. Agora's hard cap is 24h. See Phase 2 item 4. |

### Cost discipline — read this before running anything

Conversational AI bills **$0.10/min per agent**. The account's free allowance is
**300 minutes total, one-time** — not monthly. Three agents for ten minutes is
$3.00, not $1.00. About 3 minutes have been spent.

- **Always `leave`.** With `idle_timeout: 0` an agent never exits on its own.
- Never leave agents running between test runs.
- If a run fails, check `GET /v2/projects/{appid}/agents?channel=…` for orphans.

---

## File map

```
src/app/api/agent/route.ts      Agora control plane. Actions:
                                token | join | think | speak | interrupt |
                                history | leave. Mints tokens. Managed mode.
src/app/api/interviewer/route.ts  EXTERNAL LLM route — retired in Phase 1.5

src/transport/types.ts          Transport interface: join, think, speak,
                                interrupt, leave, generatesOwnLines
src/transport/agora.ts          AgoraTransport — real. NEVER INSTANTIATED YET.
src/transport/simulated.ts      SimulatedTransport — browser speech synth
src/transport/rtcChannel.ts     Media plane. Candidate joins as uid 1000.

src/core/contracts.ts           CANDIDATE_UID '1000', SILENT_UID '1099',
                                DEFAULT_CHANNEL, ChannelMode
src/core/session.ts             InterviewSession. compose() → generator
src/core/coordinator/index.ts   Floor policy. naive vs coordinated
src/core/requirements.ts        The 11 requirements + live ledger
src/speech/index.ts             PanelVoice (synth) + CandidateEar (Chrome ASR)

src/agents/personas.ts          The three interviewer personas
src/agents/choose.ts            chooseBrain(configured)
src/agents/llm.ts               LlmGenerator      ─┐
src/agents/llmClient.ts         requestCompletion  ├─ EXTERNAL, retired 1.5
src/agents/floor.ts             LlmFloor           ┘

src/app/page.tsx                Wires everything. Line 88 is the gap.
```

---

# PHASE 1 — Make the Agora path real

*Without this nothing else matters. Everything here is required.*

### 1.1 Use `AgoraTransport` when Agora is configured

- `src/app/page.tsx` — when `AgoraTransport.isConfigured()` resolves true,
  construct `AgoraTransport` and use it for the panel. Keep `SimulatedTransport`
  as the fallback when false; the header must still read `simulated` then.
- Pass `mode` on join. The route already reads `body.mode` and picks
  `[CANDIDATE_UID]` for `naive` or `[SILENT_UID]` otherwise.
- `AgentJoinSpec.systemPrompt` becomes the agent's `system_messages`. Use what
  `src/agents/personas.ts` already defines — do not write new prompts.
- Call `leave` when the session ends and on unmount.

**Done when:** starting an interview creates three agents, and removing the
credentials still gives a working simulated run.

### 1.2 Grant the floor with `think`, not local text

- `src/core/session.ts` — when `transport.generatesOwnLines === true`, the grant
  calls `transport.think(agent, candidateAnswer)` instead of composing locally
  and calling `speak`.
- When `false` (simulated), behaviour must not change: compose, then `speak`.
  That flag exists for exactly this branch — use it, do not add another.
- The rehearsed demo still forces `ScriptedGenerator` and `speak`, per the
  2026-09-05 decision. Do not change that.

**Done when:** in Agora mode the words the panel says were written by Agora.

### 1.3 Read the transcript back from `history`

- In coordinated mode the words are written inside Agora and never pass through
  our process, so the transcript must come from `GET .../history`
  (`action: 'history'`, already in the route).
- Append the `assistant` entries for the agent that was granted the floor.
  Entries carry `turn_id`, `role`, `content`, `speech_start_ms`.
- Keep `CandidateEar` for the candidate's own speech.

**Done when:** the on-screen transcript shows the sentence the panel actually
said.

### 1.4 Prove naive mode on real Agora

- The "Coordinator off" A/B must be a real Agora config: all three agents join
  with `remote_rtc_uids: [CANDIDATE_UID]` and `idle_timeout: 120`, so all three
  hear the same silence and answer at once.
- The route already does this when `mode === 'naive'`. **It has never been run
  live.** Run it and record what happens.
- Expect genuinely overlapping audio — that is the point, and the one thing the
  browser synthesiser could not show.

**Done when:** a live naive run produces a real collision and the metrics panel
counts it.

### 1.5 Retire the external LLM path

Do this **last in Phase 1**, so there is always a fallback while the rest is in
flight.

- `LlmGenerator`, `requestCompletion`, `LlmFloor` and
  `src/app/api/interviewer/route.ts` call an external OpenAI-compatible endpoint
  with `LLM_API_KEY`. The project no longer uses an external model.
- `chooseBrain(configured)` stops routing to them.
- Keep `RuleAnalyzer` and `ScriptedGenerator` — the deterministic fallback and
  the rehearsed demo depend on them.
- Delete tests only for code you actually delete.

⚠️ **Known consequence, already accepted by the team:** retiring `LlmFloor`
means the floor *decision* becomes pure code. The LLM moves from the decision to
the words. Still LLM + code, but the split changed. Do not try to restore an LLM
nominator — that needs either an external key or a fourth agent, and both are
new architecture.

**Done when:** no source file reads `LLM_API_KEY`, and `.env.example` still has
no fifth credential.

---

# PHASE 2 — Make it survive a real user

*Phase 1 gives a working demo on one machine. These are the gaps between that
and a site people can actually open. All required.*

### 2.1 One channel per interview

`DEFAULT_CHANNEL.channelName` is hardcoded `'interview-01'` and the candidate is
always uid 1000. **Two people using the site at once land in the same channel
and the second gets `UID_CONFLICT`.** They would also hear each other's
interview.

- Generate a channel name per session (the existing `interview-<n>` shape is
  fine — do not invent a new scheme).
- Thread it through `RtcChannel.join`, the agent join, and the header.
- The candidate uid can stay 1000 *within* a channel; uniqueness only has to
  hold per channel.

**Done when:** two browsers open the site simultaneously and get separate
interviews.

### 2.2 Clean up agents when the candidate leaves

**This is a money bug, not a polish item.** With `idle_timeout: 0` an agent
never exits on its own. If the candidate closes the tab, three agents keep
running and keep billing — up to Agora's 72-hour session cap. That is roughly
$18/hour.

- Call `leave` on tab close (`beforeunload` / `pagehide`) as well as unmount.
- A client-side call is best-effort. Also add a server-side sweep: on a new
  join, `GET /v2/projects/{appid}/agents?channel=…&state=1,2` and `leave` any
  agent still running in a channel this session is reclaiming.
- The route already keeps `liveAgents`; note it is process-memory and does not
  survive a server restart, which is exactly why the sweep is needed.

**Done when:** killing a browser tab mid-interview leaves no `RUNNING` agents.

### 2.3 Handle an agent dying mid-interview

We have already seen `FAILED — "RTC connection error"` in the wild. Nothing in
the app notices.

- Poll `GET /v2/projects/{appid}/agents/{agentId}` (already proven; note the
  path is `/agents/{id}`, **not** `/agents/{id}/query`) for the granted agent,
  or use the webhook Agora documents.
- On `FAILED`, surface it in the existing notice bar and fall back to the
  scripted panel rather than going silent.

**Done when:** an agent failure shows on screen instead of a dead interview.

### 2.4 Renew the token before it expires

`TOKEN_TTL_SECONDS` is 3600. Nothing renews.

- The Web SDK fires `token-privilege-will-expire` 30s before expiry. Handle it
  in `RtcChannel`: re-fetch from `action: 'token'` and call `client.renewToken`.
- Agents get a fresh token per join, so they are fine for a single interview.

**Done when:** a session open longer than an hour does not drop.

### 2.5 Verify barge-in live

Requirement 1 is *"Real-time and interruptible voice interviews"*. It is
implemented (`interruptable: true` on every `think` and `speak`) and has **never
been tested against live Agora audio**.

- Talk over an agent mid-sentence. Confirm it stops.
- Confirm the coordinator's own interrupt path (`priority: INTERRUPT` plus
  `interrupt` on the yielding agent) works between two live agents.

**Done when:** you have interrupted a real agent with your own voice.

---

# PHASE 3 — Deploy it

*"An end-to-end working website" means a URL, not `npm run dev`.*

### 3.1 Ship it somewhere

- Next 16 app, no custom server. Vercel is the path of least resistance and
  there is no config in the repo yet.
- Set `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_CUSTOMER_ID`,
  `AGORA_CUSTOMER_SECRET` as server-side env vars. **None of them are
  `NEXT_PUBLIC_`.** The certificate must never reach the browser — the whole
  token design depends on that.
- `npm run build` must pass. It has not been run in this work; only `tsc` and
  the tests have.

**Done when:** a stranger can open the URL and be interviewed.

### 3.2 Microphone permission on a real domain

The mic requires a secure context. `localhost` is exempt, a deployed domain is
not — it must be HTTPS (Vercel gives this). Confirm the permission prompt
appears and the flow survives a denial without crashing.

**Done when:** first-visit mic prompt works, and denying it shows a message
instead of a broken page.

---

# What is NOT in this queue

Deliberately out of scope. Do not start these.

- **Retiring `CandidateEar`** for Agora's own ASR of the candidate. Listed as
  Phase 3 in `DECISIONS.md`. Chrome's recogniser works today and the agents are
  deaf by design, so Agora never hears the candidate. Changing this touches the
  deaf-agent decision — team call, not yours.
- **Restoring an LLM floor nominator.** See the warning in 1.5.
- **The 5 pre-existing lint errors** in `src/app/page.tsx` (`react-hooks/refs`).
  Confirmed by stashing that they predate this work. Leave them unless an item
  above makes you touch that code anyway.
- Anything about the deck, the pitch, or the submission form.

---

## Verifying

```bash
npm install
npx tsc --noEmit          # only the LayoutProps error is expected
npm test                  # 84+ passing
npm run build             # NOT yet run — Phase 3 needs it
npm run dev               # http://localhost:3000
```

`.env.local` holds the four Agora values and is gitignored. There is no
`LLM_API_KEY` and no `TTS_KEY`, by design.

The page header is the fastest honest status line:

```
interview-01 · remote_rtc_uids [1099] · agora · in channel · scripted
```

`simulated` = no credentials. `agora` = the server has them. `in channel` = the
browser really joined. If it says `simulated` when you expect `agora`, one of
the four env vars is missing — the route requires all four.
