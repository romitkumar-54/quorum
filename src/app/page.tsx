'use client'

/**
 * The gallery.
 *
 * One channel, three interviewers, and a coordinator deciding who speaks. The
 * mode switch is the argument: `naive` is the same channel with nothing
 * deciding, and the tally lamps go red together.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENTS,
  AGENT_IDS,
  DEFAULT_CHANNEL,
  EMPTY_BRIEF,
  type AgentId,
  type Brief,
  type ChannelMode,
  type FloorDecision,
  type TranscriptEvent,
} from '@/core/contracts'
import { InterviewSession, type SessionStep } from '@/core/session'
import { DEMO_TRANSCRIPT } from '@/core/demo'
import { EMPTY_METRICS, type Metrics } from '@/core/metrics'
import type { Assessment } from '@/core/brief'
import { SimulatedTransport } from '@/transport/simulated'
import { AgoraTransport } from '@/transport/agora'
import { CandidateEar } from '@/speech'
import { SourceRack, type SourceView } from '@/components/SourceRack'
import { BriefPanel, FloorStrip, Meters, TranscriptFeed } from '@/components/Panels'
import { Ledger, Report } from '@/components/Report'

const idleSources = (): Record<AgentId, SourceView> =>
  Object.fromEntries(AGENT_IDS.map((id) => [id, { state: 'idle', line: '', cutIn: false }])) as Record<
    AgentId,
    SourceView
  >

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Long enough for a judge to watch the bids land before the floor is granted. */
const BID_REVEAL_MS = 550

export default function Gallery() {
  const sessionRef = useRef<InterviewSession | null>(null)
  const transportRef = useRef<SimulatedTransport | null>(null)
  const earRef = useRef<CandidateEar | null>(null)

  const [mode, setMode] = useState<ChannelMode>('coordinated')
  const [sources, setSources] = useState(idleSources)
  const [decision, setDecision] = useState<FloorDecision | null>(null)
  const [transcript, setTranscript] = useState<readonly TranscriptEvent[]>([])
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF)
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS)
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [yieldedIds, setYieldedIds] = useState<ReadonlySet<string>>(new Set())

  const [demoIndex, setDemoIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const [listening, setListening] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [agoraLive, setAgoraLive] = useState(false)

  // ── Join the channel ───────────────────────────────────────────────────────
  useEffect(() => {
    const transport = new SimulatedTransport()
    transportRef.current = transport
    sessionRef.current = new InterviewSession({ mode: 'coordinated' })
    earRef.current = new CandidateEar()

    transport
      .join(
        DEFAULT_CHANNEL,
        AGENT_IDS.map((id) => ({
          agentId: id,
          // Everyone hears everyone. This is the condition that makes the
          // coordinator necessary rather than decorative.
          remoteRtcUids: '*' as const,
          systemPrompt: AGENTS[id].role,
        })),
      )
      .then(() => setVoiceSupported(true))

    // If the server holds Agora credentials, say so rather than overselling.
    AgoraTransport.isConfigured().then(setAgoraLive)
  }, [])

  const refresh = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    setTranscript([...session.transcript.all()])
    setBrief(session.brief.current())
    setMetrics(session.metrics())
    setYieldedIds(new Set(session.yieldedEventIds()))
  }, [])

  // ── Play one candidate turn through the panel ─────────────────────────────
  const play = useCallback(
    async (step: SessionStep) => {
      const transport = transportRef.current
      if (!transport) return

      const grant = step.decisions[0]
      setDecision(grant)
      refresh()

      // 1 — the bids land, before anything is decided.
      setSources((previous) => {
        const next = idleSources()
        for (const bid of grant.bids) {
          next[bid.agent] = { ...previous[bid.agent], state: bid.score >= 1 ? 'bid' : 'idle', bid, line: '', cutIn: false }
        }
        return next
      })
      await sleep(BID_REVEAL_MS)

      // 2 — nothing decides, so everybody speaks.
      if (grant.kind === 'collision' && grant.collidedWith) {
        setSources((previous) => {
          const next = { ...previous }
          for (const utterance of step.utterances) {
            next[utterance.speaker as AgentId] = {
              ...next[utterance.speaker as AgentId],
              state: 'air',
              line: utterance.text,
            }
          }
          return next
        })
        await Promise.all(
          step.utterances.map((utterance) => transport.speak(utterance.speaker as AgentId, utterance.text)),
        )
        setSources(idleSources)
        refresh()
        return
      }

      // 3 — exactly one agent takes the floor, then somebody may cut in.
      for (const [index, utterance] of step.utterances.entries()) {
        const speaker = utterance.speaker as AgentId
        const thisDecision = step.decisions[index] ?? grant
        if (index > 0) {
          setDecision(thisDecision)
          await transport.interrupt() // the previous speaker stops mid-sentence
        }

        setSources((previous) => {
          const next = { ...previous }
          for (const id of AGENT_IDS) {
            next[id] = { ...next[id], state: id === speaker ? 'air' : 'idle', cutIn: false }
          }
          next[speaker] = {
            ...next[speaker],
            state: 'air',
            line: utterance.text,
            cutIn: thisDecision.kind === 'interrupt',
          }
          return next
        })

        await transport.speak(speaker, utterance.text)
        refresh()
      }

      setSources((previous) => {
        const next = { ...previous }
        for (const id of AGENT_IDS) next[id] = { ...next[id], state: 'idle', cutIn: false }
        return next
      })
      refresh()
    },
    [refresh],
  )

  const runTurn = useCallback(
    async (text: string, at?: number) => {
      const session = sessionRef.current
      if (!session || busy || !text.trim()) return
      setBusy(true)
      setAssessment(null)
      try {
        await play(session.candidateSays(text, at))
      } finally {
        setBusy(false)
      }
    },
    [busy, play],
  )

  const nextRehearsedTurn = useCallback(async () => {
    const turn = DEMO_TRANSCRIPT[demoIndex]
    if (!turn) return
    setDemoIndex((n) => n + 1)
    await runTurn(turn.text, turn.at)
  }, [demoIndex, runTurn])

  const runWholeDemo = useCallback(async () => {
    const session = sessionRef.current
    if (!session || busy) return
    setBusy(true)
    setAssessment(null)
    try {
      for (let i = demoIndex; i < DEMO_TRANSCRIPT.length; i++) {
        const turn = DEMO_TRANSCRIPT[i]
        setDemoIndex(i + 1)
        await play(session.candidateSays(turn.text, turn.at))
        await sleep(400)
      }
      setAssessment(session.assessment())
    } finally {
      setBusy(false)
    }
  }, [busy, demoIndex, play])

  const reset = useCallback(
    (nextMode: ChannelMode = mode) => {
      transportRef.current?.interrupt()
      earRef.current?.stop()
      setListening(false)
      sessionRef.current?.reset(nextMode)
      setMode(nextMode)
      setSources(idleSources)
      setDecision(null)
      setTranscript([])
      setBrief(EMPTY_BRIEF)
      setMetrics(EMPTY_METRICS)
      setAssessment(null)
      setYieldedIds(new Set())
      setDemoIndex(0)
      setNotice(null)
    },
    [mode],
  )

  // ── Microphone ─────────────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    const ear = earRef.current
    if (!ear) return

    if (listening) {
      ear.stop()
      setListening(false)
      return
    }

    const started = ear.start(
      (heard) => {
        if (heard.final) void runTurn(heard.text)
      },
      (message) => {
        setNotice(message)
        setListening(false)
      },
    )
    setListening(started)
  }, [listening, runTurn])

  useEffect(() => () => earRef.current?.stop(), [])

  const requirementState = useMemo(
    () => ({
      transcript,
      brief,
      decisions: sessionRef.current?.coordinator.log() ?? [],
      reportShown: assessment !== null,
      voiceSupported,
    }),
    [transcript, brief, assessment, voiceSupported],
  )

  const demoDone = demoIndex >= DEMO_TRANSCRIPT.length

  return (
    <main className="shell">
      <header className="strip">
        <span className="wordmark">Quorum</span>
        <span className="strip-meta">
          {DEFAULT_CHANNEL.channelName} · remote_rtc_uids &quot;*&quot; · {agoraLive ? 'agora' : 'simulated'}
        </span>
        <span className="strip-spacer" />
        <span className="disclosure">
          <i className="disclosure-dot" aria-hidden />
          You are speaking with AI interviewers, not people.
        </span>
      </header>

      <SourceRack sources={sources} />
      <FloorStrip decision={decision} />

      <div className="controls">
        <div className="mode" role="group" aria-label="Coordinator">
          <button
            type="button"
            data-on={mode === 'coordinated'}
            onClick={() => reset('coordinated')}
            disabled={busy}
          >
            Coordinator on
          </button>
          <button
            type="button"
            data-on={mode === 'naive'}
            data-danger="true"
            onClick={() => reset('naive')}
            disabled={busy}
          >
            Coordinator off
          </button>
        </div>

        <button type="button" className="btn" data-primary="true" onClick={runWholeDemo} disabled={busy || demoDone}>
          {demoDone ? 'Rehearsal complete' : 'Run rehearsed interview'}
        </button>

        <button type="button" className="btn" onClick={nextRehearsedTurn} disabled={busy || demoDone}>
          Next turn
        </button>

        <button type="button" className="btn" onClick={toggleMic} disabled={busy}>
          {listening ? 'Stop microphone' : 'Answer by voice'}
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => setAssessment(sessionRef.current?.assessment() ?? null)}
          disabled={busy || brief.claims.length === 0}
        >
          Close and score
        </button>

        <button type="button" className="btn" onClick={() => reset()} disabled={busy}>
          Reset
        </button>
      </div>

      <div className="controls">
        <form
          className="field"
          onSubmit={(event) => {
            event.preventDefault()
            const text = answer
            setAnswer('')
            void runTurn(text)
          }}
        >
          <input
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Answer the panel in your own words"
            disabled={busy}
            aria-label="Your answer"
          />
          <button type="submit" className="btn" disabled={busy || !answer.trim()}>
            Say it
          </button>
        </form>
      </div>

      {notice && (
        <div className="controls" style={{ color: 'var(--bid)' }}>
          {notice}
        </div>
      )}

      <Meters metrics={metrics} />

      <div className="columns">
        <TranscriptFeed events={transcript} yieldedIds={yieldedIds} />
        <BriefPanel brief={brief} />
      </div>

      {assessment && <Report assessment={assessment} />}
      <Ledger state={requirementState} />
    </main>
  )
}
