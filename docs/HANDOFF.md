# Handoff — finishing the Agora integration

**Written 2026-09-06, at commit `0e0b6a9`.**

You are picking up a project that already has a settled architecture and a
settled set of decisions. **Your job is the work queue below and nothing else.**

Read this whole file, then `docs/DECISIONS.md`, then `docs/AGORA.md`, before
touching any code.

---

## Rules for this handoff

1. **Do not introduce new architecture.** No new abstractions, no new services,
   no swapping libraries, no "while I was in there" refactors.
2. **Do not relitigate the decisions** in `docs/DECISIONS.md`. They were paid
   for with live API calls. If you think one is wrong, write down why and stop —
   do not act on it.
3. **Do the queue in order.** Each item lists its files and how to know it is
   done. Item 1 unblocks everything else.
4. **Verify before claiming.** Typecheck, run the tests, and for anything
   user-visible open it in a browser and look at it. Two real bugs in this repo
   were invisible to the typechecker and obvious on screen.
5. **Every change keeps `npm test` at 84+ passing and `npx tsc --noEmit` clean**
   (one pre-existing `LayoutProps` error is expected — Next generates that type
   at build time).

---

## The architecture, in one paragraph

Agora Conversational AI gives us a **complete** agent — it hears, transcribes,
thinks, speaks, and can be interrupted. It has no concept of a second agent.
Quorum runs three in one channel, all **deaf** (`remote_rtc_uids: ["1099"]`, a
uid nobody joins as), so none of them self-triggers. Our coordinator decides who
speaks and grants the floor with `POST .../think`, which injects the candidate's
answer into exactly one agent; that agent's Agora-managed model writes the reply
and says it. **Dynamic words from Agora, deterministic choice from our code.**
Every model is Agora-managed — there is no external LLM key in this project.

Two planes that meet only in the channel:

```
  server  --REST-->  Agora  --creates-->  agents 1001/1002/1003   (control plane)
  browser --RTC--->  Agora  --joins---->  candidate uid 1000      (media plane)
```

---

## State of play

### Done and verified against the live API

| Thing | Status |
| --- | --- |
| `POST /join` with managed ASR + LLM + TTS | ✅ returns 200, agent reaches and holds `RUNNING` |
| Deaf agent (`remote_rtc_uids: ["1099"]`) | ✅ accepted, stays alive |
| `POST .../think` → agent's model writes and speaks a line | ✅ verified, twice, with real output |
| `GET .../history` returns what was said | ✅ verified |
| `POST .../interrupt`, `POST .../leave` | ✅ both 200 |
| Per-join token minting (`agora-token`) | ✅ working |
| Browser joins channel as uid 1000, publishes mic | ✅ header reads `agora · in channel` |
| Coordinator, brief, analyst, metrics, report | ✅ 84 tests |

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

### Not done — this is your queue

**`AgoraTransport` is never instantiated.** `src/app/page.tsx:88` constructs a
`SimulatedTransport` unconditionally. `AgoraTransport.isConfigured()` is called,
but only to set a header flag. So today:

- the candidate really is in a real Agora channel
- **no agents are ever created by the app** — nothing calls `/api/agent` with
  `action: 'join'` except the smoke scripts
- every interviewer voice you hear is the browser's speech synthesiser
- the transcript shows text our `ScriptedGenerator` wrote, not what any agent
  said

The panel is audible and the transcript is honest **separately**. They are not
yet the same words. Closing that is the whole queue.

---

## Facts that are already paid for — do not rediscover these

| Fact | Consequence |
| --- | --- |
| `remote_rtc_uids` accepts **one** uid. "Currently, only one user ID is supported." | There is no `["*"]` on this field. The `["*"]` wildcard in Agora's docs is for `tools`. Agents can never hear each other. |
| `vendor: "ares"` is **rejected** on this account | *"not available for the current SKU when credential_mode is 'managed'"*. Use `deepgram` / `nova-3`. It accepts `en-IN`. |
| `params.url` is **required** even in managed mode | Omitting it fails with *"required field is missing"*. Undocumented. Applies to `asr` and `tts`. |
| `idle_timeout: 0` is required in coordinated mode | Agora exits an agent once the users in `remote_rtc_uids` leave, and uid 1099 never arrives. Any other value kills the panel mid-interview. |
| Empty `token` + App Certificate enabled | Join returns **200 / RUNNING**, then the agent dies ~1s later: *"agent exits with reason: RTC connection error"*. The join succeeding is what makes this expensive to diagnose. Tokens are minted per join now — do not reintroduce `AGORA_RTC_TOKEN`. |
| A `think`-driven turn is tagged in history | `metadata.start_type: "api_think"` on the `user` role entry. This is how you tell a coordinator-driven turn from a self-triggered one. |
| React StrictMode double-mounts the effect | `RtcChannel` join/leave are serialised through one queue **and** the instance is kept on the ref across remounts. Both halves are needed; serialising alone still raced. Do not "simplify" this. |
| `speak` caps text at 512 bytes | Already sliced in the route. |

### Cost discipline

Conversational AI bills **$0.10/min per agent**, and the account's free
allowance is **300 minutes total, one-time** — not monthly. Three agents for ten
minutes is $3.00, not $1.00.

- **Always `leave`.** An agent with `idle_timeout: 0` never exits on its own.
- Do not leave agents running between test runs.
- Roughly 3 minutes have been spent so far.

---

## File map

```
src/app/api/agent/route.ts      Agora control plane. Actions:
                                token | join | think | speak | interrupt |
                                history | leave. Mints tokens. Managed mode.

src/transport/types.ts          Transport interface: join, think, speak,
                                interrupt, leave, generatesOwnLines
src/transport/agora.ts          AgoraTransport — real. NEVER INSTANTIATED YET.
                                generatesOwnLines = true
src/transport/simulated.ts      SimulatedTransport — browser speech synth.
                                generatesOwnLines = false
src/transport/rtcChannel.ts     Media plane. Candidate joins as uid 1000.

src/core/contracts.ts           CANDIDATE_UID '1000', SILENT_UID '1099',
                                DEFAULT_CHANNEL, ChannelMode
src/core/session.ts             InterviewSession. compose() → generator,
                                append() → transcript
src/core/coordinator/index.ts   Floor policy. Naive vs coordinated.

src/agents/choose.ts            chooseBrain(configured)
src/agents/llm.ts               LlmGenerator      ─┐
src/agents/llmClient.ts         requestCompletion  ├─ EXTERNAL LLM PATH,
src/agents/floor.ts             LlmFloor           │  to be retired (item 4)
src/app/api/interviewer/route.ts  needs LLM_API_KEY┘

src/app/page.tsx                Wires everything. Line 88 is the gap.
```

---

## The work queue

### 1. Use `AgoraTransport` when Agora is configured

**Why first:** nothing else can be observed until agents actually exist.

- `src/app/page.tsx` — when `AgoraTransport.isConfigured()` resolves true,
  construct `AgoraTransport` instead of `SimulatedTransport` and use it for the
  panel. Keep `SimulatedTransport` as the fallback when it resolves false; the
  header must keep saying `simulated` in that case.
- The join must pass `mode` so the route picks the right subscription — the
  route already reads `body.mode` and chooses `[CANDIDATE_UID]` for `naive` or
  `[SILENT_UID]` otherwise.
- `AgentJoinSpec.systemPrompt` becomes the agent's `system_messages`. It is the
  interviewer's persona — use what `src/agents/personas.ts` already defines
  rather than writing new prompts.
- Call `leave` when the session ends and on unmount. Agents cost money.

**Done when:** starting an interview creates three agents (check the browser
network tab or `GET /api/agent`), and the header still reads `simulated` with
credentials removed.

### 2. Grant the floor with `think`, not local text

- `src/core/session.ts` — when the transport reports `generatesOwnLines === true`,
  the coordinator's grant must call `transport.think(agent, candidateAnswer)`
  instead of composing a line locally and calling `speak`.
- When `generatesOwnLines === false` (simulated), behaviour must not change:
  compose first, then `speak`. That flag exists for exactly this branch — use
  it, do not add another.
- The rehearsed demo still forces `ScriptedGenerator` and `speak`, per the
  2026-09-05 decision. Do not change that.

**Done when:** in Agora mode the words the panel says were written by Agora, and
in simulated mode nothing about the existing behaviour changed.

### 3. Read the transcript back from `history`

- In coordinated mode the words are written inside Agora and never pass through
  our process, so the transcript must come from `GET .../history`
  (`action: 'history'`, already implemented in the route).
- Append the `assistant` entries to the transcript for the agent that was
  granted the floor. Entries carry `turn_id`, `role`, `content` and
  `speech_start_ms`.
- Keep `CandidateEar` for the candidate's own speech. Retiring it was listed as
  Phase 3 in `DECISIONS.md` but is **not** in this queue — leave it alone.

**Done when:** the on-screen transcript shows the same sentence the panel
actually said, not a scripted stand-in.

### 4. Prove naive mode on real Agora

- The A/B ("Coordinator off") must run as a real Agora config, not a simulation:
  all three agents join with `remote_rtc_uids: [CANDIDATE_UID]` and
  `idle_timeout: 120`, so all three hear the same silence and answer at once.
- The route already does this when `mode === 'naive'`. It has **never been run
  live.** Run it, and record what actually happens.
- Expect real overlapping audio here — that is the point, and it is the one
  thing the browser synthesiser could not show.

**Done when:** a live naive run produces a real collision, and the metrics panel
counts it.

### 5. Retire the external LLM path

Do this **last**, once 1–3 are working, so there is always something to fall
back to while the rest is in flight.

- `LlmGenerator`, `requestCompletion`, `LlmFloor` and
  `src/app/api/interviewer/route.ts` all call an external OpenAI-compatible
  endpoint with `LLM_API_KEY`. The project no longer uses an external model.
- `chooseBrain(configured)` should stop routing to them.
- Keep `RuleAnalyzer` and `ScriptedGenerator`. They are the deterministic
  fallback and the rehearsed demo depends on them.
- Delete the tests only for code you actually delete.

**Done when:** no source file reads `LLM_API_KEY`, and `.env.example` still has
no fifth credential.

---

## Verifying

```bash
npm install
npx tsc --noEmit          # only the LayoutProps error is expected
npm test                  # 84+ passing
npm run dev               # http://localhost:3000
```

`.env.local` holds the four Agora values and is gitignored. There is no
`LLM_API_KEY` and no `TTS_KEY`, by design — see `.env.example`.

Open the page and read the header. It is the fastest honest status line:

```
interview-01 · remote_rtc_uids [1099] · agora · in channel · scripted
```

`simulated` means no credentials. `agora` means the server has them. `in
channel` means the browser really joined.

### Known, and not yours

`npx eslint src` reports **5 pre-existing errors** in `src/app/page.tsx`
(`react-hooks/refs`, reading refs during render). They predate this work —
confirmed by stashing. Leave them unless an item above makes you touch that
code anyway.
