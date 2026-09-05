# How Quorum uses Agora Conversational AI

*A required submission artifact, and the honest answer to "could you have built
this on something else".*

Everything on this page has been run against the live API. Where Agora's
behaviour differs from Agora's documentation, the behaviour is what is written
here.

## Why a panel is not a call

Every other track in this hackathon is shaped like a one-to-one call, and is
buildable on Vapi, Retell or ElevenLabs. Ours is not.

Agora Conversational AI gives you a **complete** agent: it hears the user,
transcribes, thinks, speaks, detects end-of-speech, and can be interrupted. If
Quorum needed one interviewer, there would be no project — there would be one
`join` call.

Quorum needs three, in one channel, and that is where the API stops helping.
**An agent instance has no concept of another agent instance.** There is no
field that coordinates two of them. Three complete agents in one channel is
three people talking at once, forever, and Agora will do exactly that.

**The floor-control problem is created by Agora's own primitives, and solved
with them.**

## Every model is Agora's

`credential_mode: "managed"` on all three blocks. There is no OpenAI key in this
project, no TTS key, and no fifth credential in `.env.example`.

| Stage | Vendor | Model |
| --- | --- | --- |
| ASR | Deepgram (managed) | `nova-3`, `en-IN` |
| LLM | OpenAI (managed) | `gpt-4.1-mini` |
| TTS | OpenAI (managed) | `tts-1` — `onyx` / `nova` / `shimmer` |

Two corrections the live API forced, both worth knowing if you build on this:

- **`ares` is rejected on our account.** It is on Agora's published managed
  vendor list. The join fails with *"vendor 'ares' is not available for the
  current SKU when credential_mode is 'managed'"*. Deepgram `nova-3` accepted
  `en-IN` on the same request.
- **`params.url` is required even in managed mode.** Agora holds the key but
  still wants the vendor endpoint. Omitting it fails with *"required field is
  missing"*. This is not in the managed-mode documentation.

## The field this project turns on

```
remote_rtc_uids  —  "Currently, only one user ID is supported."
```

One uid. There is no wildcard on this field. (`["*"]` **is** documented for
Agora Conversational AI — but for `tools`, which is a different field. We
designed against that misreading for a day, and it could never have run.)

So the panel *cannot* be made to hear itself, and that constraint produced the
architecture rather than blocking it:

| Mode | `remote_rtc_uids` | What happens |
| --- | --- | --- |
| `naive` | `["1000"]` — the candidate | All three hear the same silence, all three models fire, all three speak. Nothing decides. |
| `coordinated` | `["1099"]` — a uid nobody joins as | Every agent is deaf. None self-triggers. The coordinator grants the floor to exactly one. |

Both are real Agora configurations. The A/B in the demo is not a simulation of
a collision — it is a collision.

`idle_timeout: 0` is required in coordinated mode. Agora exits an agent once the
users in `remote_rtc_uids` have left, and uid 1099 never arrives, so any
non-zero timeout kills the whole panel mid-interview.

## The mapping

The coordinator does not sit awkwardly on top of Agora. Its decisions are Agora
calls:

| Coordinator decision | Agora Conversational AI call |
| --- | --- |
| Agent joins the panel | `POST /v2/projects/{appid}/join` — once per interviewer |
| **Floor granted** | `POST …/agents/{agentId}/think` — the agent's own model answers |
| Say this exact line | `POST …/agents/{agentId}/speak` · `priority: APPEND` |
| Cut in | `POST …/agents/{agentId}/speak` · `priority: INTERRUPT` |
| Yield — stand down | `POST …/agents/{agentId}/interrupt` |
| What was said | `GET …/agents/{agentId}/history` |
| Session ends | `POST …/agents/{agentId}/leave` |

Implemented in `src/app/api/agent/route.ts`.

### `think` is the seam

`think` injects text into one agent's pipeline as if the candidate had said it.
The agent's Agora-managed model writes the reply and speaks it.

That single call is what lets the words be **dynamic** — written by a model, in
character, never scripted — while the decision of *who was asked* stays in our
code, where the invariant "exactly one interviewer speaks" can be proved rather
than hoped for.

```
on_listening_action: "interrupt"   pick up the new turn immediately
on_thinking_action:  "interrupt"   abandon a stale thought
on_speaking_action:  "ignore"      never let an agent talk over itself
interruptable: true                the candidate can always cut in
```

A coordinator-driven turn is identifiable in `history` by
`metadata.start_type: "api_think"`.

## Tokens

Minted per join, signed for one channel and one uid, using the App Certificate.
The certificate never leaves the server; only the token does. The browser gets a
candidate token for uid 1000 from the same route.

This is worth stating plainly because the failure mode is silent:

```
token: ""   with an App Certificate enabled

  POST /join            -> HTTP 200,  status: RUNNING
  GET  /agents/{id}     -> [0.7s]     RUNNING
                          [3.1s]      FAILED
                          "agent exits with reason: RTC connection error"
```

The join *succeeds*. The agent dies a second later. Nothing in the join response
suggests anything is wrong.

## Barge-in

Both directions are needed for the demo to survive a judge talking over it:

- **Candidate interrupts an agent** — Agora's turn detection, `interruptable:
  true` on every `think` and `speak`. Requirement 1, and it costs us nothing.
- **Agent interrupts an agent** — our coordinator, via `priority: INTERRUPT`
  plus an `interrupt` call on the agent standing down.

## What is real today, stated plainly

| | Status |
| --- | --- |
| Three agents in one Agora channel, coordinated | **Real.** Runs. Output below. |
| Managed ASR + LLM + TTS, no external keys | **Real.** Verified at join. |
| `think` / `speak` / `interrupt` / `history` / `leave` | **Real.** All return 200 against the live API. |
| Per-join token minting | **Real.** |
| Coordinator, brief, analysis, metrics, report | **Real.** Framework-free TypeScript, 84 tests. |
| Browser joins the RTC channel and you hear it | **Not yet.** The route mints the candidate token; the Web SDK join is the next piece. |

One run of the panel, through the app's own API, unedited:

```
POST join  -- three interviewers, coordinated mode (all deaf)
  technical    A44CJ73JF72TL66MP83ER94PJ46TP67M
  product      A44CF67RR29WH45NT53TM54HW57AD72M
  behavioural  A44CT42MT79EK37NW32MM54DN77MT59N

candidate: "I built a caching layer with Redis for our checkout service,
            and it cut p99 latency a lot."

coordinator grants the floor to: technical
  technical    "How do you handle cache invalidation to ensure data
                consistency during checkout?"
  product      (silent)
  behavioural  (silent)

second turn -- coordinator moves the floor to: product
  product      "How did reducing the checkout time by 400 milliseconds
                impact user conversion or satisfaction?"
  behavioural  (silent)
```

Two turns, two speakers, one voice each time, and both questions written by
Agora's managed model rather than by us.

## Running it

```bash
npm install
cp .env.example .env.local     # then fill in the four Agora values
npm run dev                    # http://localhost:3000
```

With no credentials the app falls back to the browser's speech engine and the
header reads `simulated`, rather than pretending to have joined.
