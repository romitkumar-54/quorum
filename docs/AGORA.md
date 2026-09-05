# How Quorum uses Agora Conversational AI

*A required submission artifact, and the honest answer to "could you have built this on something else".*

## Why a panel is not a call

Every other track in this hackathon is shaped like a one-to-one call, and is buildable on Vapi, Retell or ElevenLabs. Ours is not.

A panel is **three AI agents inside one RTC channel**, each joining with its own agent identity and each controlling whose audio it subscribes to. That is native to Agora Conversational AI and awkward-to-impossible elsewhere, because the competing products model a conversation as one assistant and one user.

It is also where the real engineering problem comes from. `remote_rtc_uids` decides what each agent hears. Set it so the agents hear the whole channel and they hear the candidate stop at the same instant — so all three answer, over each other. Silence detection, a bid and priority policy, and one agent yielding mid-sentence are what turn three voices into a panel.

**The floor-control problem is created by Agora's own primitives, and solved with them.**

## The mapping

Our coordinator does not sit awkwardly on top of Agora. Its four decisions are four Agora calls:

| Coordinator decision | Agora Conversational AI call |
| --- | --- |
| Agent joins the panel | `POST /v2/projects/{appid}/join` — once per interviewer |
| Floor granted | `POST /v2/projects/{appid}/agents/{agentId}/speak` · `priority: APPEND` |
| Interrupt — cut in | `POST …/agents/{agentId}/speak` · `priority: INTERRUPT` |
| Yield — stand down | `POST …/agents/{agentId}/interrupt` |
| Session ends | `POST …/agents/{agentId}/leave` |

`priority: INTERRUPT` versus `APPEND` **is** floor control at the API level. The coordinator decides which of the two a given agent gets, and that decision is the project.

Implemented in `src/app/api/agent/route.ts`.

## One join per interviewer

Each interviewer is a separate agent instance, with its own RTC identity, its own voice and its own role prompt:

```jsonc
{
  "name": "quorum-interview-01-product",
  "properties": {
    "channel": "interview-01",
    "agent_rtc_uid": "1002",          // distinct per interviewer

    // The field this entire project turns on. Every participant means each
    // agent hears the other two as well as the candidate — so all three
    // detect the same end-of-speech. The coordinator is what makes that safe.
    "remote_rtc_uids": ["*"],

    "turn_detection": {
      "mode": "default",
      "config": {
        "speech_threshold": 0.5,
        // End-of-speech detection is what opens the floor. This value and the
        // coordinator's silence threshold are the same knob.
        "end_of_speech": { "mode": "vad", "vad_config": { "silence_duration_ms": 600 } }
      }
    },

    "llm": {
      "system_messages": [{ "role": "system", "content": "<the interviewer's role>" }],
      "max_history": 32
    },

    // Three roles, three voices. The panel must not sound like one person.
    "tts": {
      "vendor": "microsoft",
      "params": { "voice_name": "en-US-AvaMultilingualNeural" }
    },
    "asr": { "language": "en-US" }
  }
}
```

Voices assigned per role: Technical `en-US-AndrewMultilingualNeural`, Product `en-US-AvaMultilingualNeural`, Behavioural `en-GB-SoniaNeural`.

## Barge-in

Agora handles interruption of an agent by the candidate natively — that is requirement 1, and it costs us nothing. What Agora does *not* decide is which of three agents should be the one talking. That is ours.

Both directions are needed for the demo to survive a judge talking over it:

- **Candidate interrupts an agent** — Agora's turn detection, `interruptable: true` on every `speak`.
- **Agent interrupts an agent** — our coordinator, via `priority: INTERRUPT` plus an `interrupt` call on the agent standing down.

## Running it

The app runs today with **no credentials**, on the browser's speech engine, so the demo never depends on a network. `GET /api/agent` reports `configured: false` and the UI says `simulated` in the header rather than overselling.

To switch the voice layer to Agora, set these and restart:

```bash
AGORA_APP_ID=            # console.agora.io → your project
AGORA_CUSTOMER_ID=       # RESTful API customer ID
AGORA_CUSTOMER_SECRET=   # RESTful API customer secret
AGORA_RTC_TOKEN=         # channel token, or leave blank in testing mode

LLM_API_KEY=             # one LLM per interviewer role
LLM_MODEL=gpt-4o-mini
TTS_KEY=                 # Microsoft TTS, for three distinct voices
TTS_REGION=eastus
```

The header switches to `agora`, and `AgoraTransport` takes the audio path. Nothing above the `Transport` interface changes — not the coordinator, not the brief, not the UI. That is why the interface was written on day one.

## What is real today, stated plainly

| | Status |
| --- | --- |
| Coordinator, brief, analysis, metrics, report | **Real.** Framework-free TypeScript, 27 tests. |
| Channel semantics — agent IDs, `remote_rtc_uids` subscription | **Modelled** faithfully in `SimulatedTransport`. |
| Voice in and out | **Real**, on the browser's speech engine. |
| Agora as the audio transport | **Wired, inert** until credentials are set. |

One caveat we would rather state than have found: with the browser synthesiser, colliding agents queue instead of overlapping, because it is a single audio channel. The collision is still counted and still shown — three lamps go red at once — but the *sound* of three people talking over each other needs Agora, where each agent has its own track. It is one more thing a panel gets that a call does not.
