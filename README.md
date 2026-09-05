# Quorum

**A coordinated AI interview panel.** Three AI interviewers in one Agora RTC channel, and a coordinator deciding who speaks.

Built by team **Newbiezz** for **EchoSphere: the Agora Conversational AI Hackathon** (KNOTiC × Agora), on the *Coordinated AI Interview Panel* track.

---

## The problem

Interview practice today is a chatbot asking scripted questions. Real panels are nothing like that: people interrupt, disagree, and challenge from different angles. Candidates fail on that dynamic, not on the answer.

Put three AI interviewers in one voice channel and you meet the actual engineering problem immediately. Each agent subscribes to the channel through `remote_rtc_uids`. Set it to `"*"` and every agent hears the candidate *and each other* — so all three detect the same end-of-speech and all three answer at once.

**A fixed rotation looks identical on a slide. The difference shows the moment someone talks over the panel.**

## What this is

Two things, and they are the whole build:

1. **The coordinator** — silence detection, a bid policy scored off the shared brief, one agent granted the floor, and one agent yielding mid-sentence when somebody has better grounds to speak. Every decision carries the reason it was made, and the screen shows it.
2. **The shared brief** — one object built live from the timestamped transcript: claims, vagueness and contradiction flags, a per-competency score, and the current difficulty. Every agent reads it before speaking. Six of the eleven requirements fall out of this object rather than being six separate features.

Two things follow from that, and neither is available to a single-agent system:

- **The panel disagrees with itself**, and the split lands in the final score rather than being averaged away.
- **The coordination is measured** — floor latency p50/p95, collision rate, false-interrupt rate — during the demo, on screen.

## See it in 30 seconds

```bash
npm install
npm run dev      # http://localhost:3000
```

Press **Run rehearsed interview**. Then press **Coordinator off** and run it again.

That second run is the argument. Same channel, same agents, same silence — and all three tally lamps go red together, because nothing is deciding.

| | Coordinator on | Coordinator off |
| --- | --- | --- |
| Collisions | **0** | 3 |
| Collision rate | **0%** | 100% |
| Floor latency p50 | 78 ms | — |
| Requirements demonstrated | **11 / 11** | 9 / 11 |

*Measured from the rehearsed interview on 5 Sep 2026. The requirement ledger at the bottom of the page ticks from live session state — with the coordinator off, "controlled interviewer turn-taking" un-ticks, because it is not true.*

## The rehearsed run

This is the organisers' own example scenario, and it runs end to end:

1. The candidate gives a technically correct answer and never quantifies the impact.
2. **Technical** accepts it — *"Correct, efficient. What does that cost you in memory?"*
3. **Product** cuts in over it — *"Who does that help? You said it got faster — faster for whom, and by how much?"* The coordinator granted that floor, and the reason is on screen.
4. The brief gains `unchallenged_impact`, linked to the timestamp it came from.
5. Later the candidate contradicts themselves on rollout. **Behavioural** challenges it, quoting **both** timestamps back.
6. The report: Technical 4/5, Product 2/5, Behavioural 3/5, **final 3/5, flagged as a split panel**.

## Voice

The interviewers speak, and the candidate can answer out loud — press **Answer by voice**. Today that runs on the browser's own speech engine, so the demo works with no credentials at all. Chrome is required for speech recognition; typing into the answer box works everywhere.

Agora Conversational AI is the production voice layer, behind the same interface. See [docs/AGORA.md](docs/AGORA.md) for exactly what switches on when the credentials land, and why this track needs Agora specifically.

## How it is built

| | |
| --- | --- |
| Framework | Next.js 16 · React 19 · TypeScript |
| Core engine | Framework-free TypeScript in `src/core` — no React, unit-tested |
| Voice | Web Speech API today · Agora Conversational AI in production |
| Tests | Vitest — 27 tests, including the "one agent on the floor" invariant |

The interfaces were frozen before any logic was written, so four people can build in parallel without waiting on each other. Directory ownership *is* the lane split — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```bash
npm test          # 27 tests
npm run build     # production build
```

## The team

| Lane | Owner | Scope |
| --- | --- | --- |
| A · Realtime | Arihant Kumar | Agora channel, three agent IDs, barge-in, timestamped transcript capture |
| B · Coordinator | Gourav Tiwari | Who speaks next, collisions, interrupt policy, yield |
| C · Brief & analysis | Sahil Singh Kushwah | Claims, flags, difficulty controller, final assessment |
| D · Surface | Romit | Candidate UI, live panel view, AI disclosure, recruiter report |

## Disclosure

Every candidate sees a banner stating the panel is AI, on screen for the whole session. It is a requirement, and it is also the right thing to do.

## Documents

- [Architecture](docs/ARCHITECTURE.md) — the three frozen contracts and how a turn flows through them
- [How we use Agora](docs/AGORA.md) — the REST calls, and why a panel is not a call
- [What we measure](docs/METRICS.md) — the four numbers and how they are computed
