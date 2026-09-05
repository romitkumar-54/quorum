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
import { EMPTY_METRICS, type Metrics } from '@/core/metrics'
import type { Assessment } from '@/core/brief'
import { SimulatedTransport } from '@/transport/simulated'
import { AgoraTransport } from '@/transport/agora'
import { ScriptedGenerator } from '@/agents'
import { chooseBrain, type Brain } from '@/agents/choose'
import { RuleAnalyzer } from '@/core/brief/analyzer'
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

/** idle: nothing has happened. live: the microphone is open. closed: the report is out. */
type Phase = 'idle' | 'live' | 'closed'

/** Long enough for a judge to watch the bids land before the floor is granted. */
const BID_REVEAL_MS = 550

export default function Gallery() {
  const sessionRef = useRef<InterviewSession | null>(null)
  const transportRef = useRef<SimulatedTransport | null>(null)
  const earRef = useRef<CandidateEar | null>(null)
  /** The thinking parts, chosen once the key probe answers. */
  const brainRef = useRef<Brain>({ analyzer: new RuleAnalyzer(), generator: new ScriptedGenerator() })
  /** The microphone callback needs the live value, not the one captured at start(). */
  const busyRef = useRef(false)
  /** A mute the candidate asked for, which the panel's own muting must not undo. */
  const mutedRef = useRef(false)

  const [mode, setMode] = useState<ChannelMode>('coordinated')
  const [sources, setSources] = useState(idleSources)
  const [decision, setDecision] = useState<FloorDecision | null>(null)
  const [transcript, setTranscript] = useState<readonly TranscriptEvent[]>([])
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF)
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS)
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [yieldedIds, setYieldedIds] = useState<ReadonlySet<string>>(new Set())

  const [phase, setPhase] = useState<Phase>('idle')
  const [thinking, setThinking] = useState(false)
  const [muted, setMuted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const [listening, setListening] = useState(false)
  const [hearing, setHearing] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [agoraLive, setAgoraLive] = useState(false)
  const [llmLive, setLlmLive] = useState(false)

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

    // Same for the model: with no key the panel runs on the scripted ladder,
    // and the header says so rather than implying questions are being written.
    fetch('/api/interviewer')
      .then((res) => res.json())
      .then((body: { configured?: boolean }) => {
        const configured = body.configured === true
        setLlmLive(configured)
        brainRef.current = chooseBrain(configured)
      })
      .catch(() => setLlmLive(false))
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
      if (!session || busyRef.current || !text.trim()) return
      busyRef.current = true
      setBusy(true)
      setAssessment(null)
      setHearing('')
      // The panel is about to speak through the same speakers the microphone is
      // listening to. Deafen it, or the interviewers come back as the
      // candidate's next answer.
      earRef.current?.mute()
      setThinking(true)
      try {
        // Three model calls happen in here before anyone speaks. That gap is
        // what `thinking` exists to explain.
        const step = await session.candidateSays(text, at)
        setThinking(false)
        await play(step)
      } finally {
        setThinking(false)
        if (!mutedRef.current) earRef.current?.unmute()
        busyRef.current = false
        setBusy(false)
      }
    },
    [play],
  )

  // ── The interview ──────────────────────────────────────────────────────────
  const startInterview = useCallback(async () => {
    if (busyRef.current) return

    // A fresh session: the analyst and the coordinator are constructor options,
    // so the brain cannot be swapped into one that is already running.
    const session = new InterviewSession({ mode, ...brainRef.current })
    sessionRef.current = session

    setPhase('live')
    setSources(idleSources)
    setDecision(null)
    setTranscript([])
    setBrief(EMPTY_BRIEF)
    setMetrics(EMPTY_METRICS)
    setAssessment(null)
    setYieldedIds(new Set())
    setNotice(null)
    setHearing('')
    mutedRef.current = false
    setMuted(false)

    // The microphone opens with the interview and stays open. There is nothing
    // to hold down: an interview is not a walkie-talkie.
    const ear = earRef.current
    if (ear && !ear.listening) {
      const started = ear.start({
        onTurn: (heard) => void runTurn(heard.text),
        onInterim: setHearing,
        onError: (message) => {
          setNotice(message)
          setListening(false)
          setHearing('')
        },
      })
      setListening(started)
    }

    busyRef.current = true
    setBusy(true)
    setThinking(true)
    ear?.mute()
    try {
      const step = await session.open()
      setThinking(false)
      await play(step)
    } finally {
      setThinking(false)
      if (!mutedRef.current) ear?.unmute()
      busyRef.current = false
      setBusy(false)
    }
  }, [mode, play, runTurn])

  const endInterview = useCallback(() => {
    earRef.current?.stop()
    transportRef.current?.interrupt()
    setListening(false)
    setHearing('')
    setPhase('closed')
    setAssessment(sessionRef.current?.assessment() ?? null)
  }, [])

  /** Not push-to-talk. A way to stop transmitting, which a live interview needs. */
  const toggleMute = useCallback(() => {
    const ear = earRef.current
    if (!ear) return
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    if (next) ear.mute()
    else if (!busyRef.current) ear.unmute()
  }, [])

  const reset = useCallback(
    (nextMode: ChannelMode = mode) => {
      transportRef.current?.interrupt()
      earRef.current?.stop()
      setListening(false)
      setHearing('')
      sessionRef.current?.reset(nextMode)
      setMode(nextMode)
      setSources(idleSources)
      setDecision(null)
      setTranscript([])
      setBrief(EMPTY_BRIEF)
      setMetrics(EMPTY_METRICS)
      setAssessment(null)
      setYieldedIds(new Set())
      setNotice(null)
      setPhase('idle')
      mutedRef.current = false
      setMuted(false)
    },
    [mode],
  )

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

  return (
    <main className="shell">
      <header className="strip">
        <span className="wordmark">Quorum</span>
        <span className="strip-meta">
          {DEFAULT_CHANNEL.channelName} · remote_rtc_uids &quot;*&quot; · {agoraLive ? 'agora' : 'simulated'} ·{' '}
          {llmLive ? 'live questions' : 'scripted'}
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
            disabled={busy || phase === 'live'}
          >
            Coordinator on
          </button>
          <button
            type="button"
            data-on={mode === 'naive'}
            data-danger="true"
            onClick={() => reset('naive')}
            disabled={busy || phase === 'live'}
          >
            Coordinator off
          </button>
        </div>

        {phase !== 'live' ? (
          <button type="button" className="btn" data-primary="true" onClick={startInterview} disabled={busy}>
            {phase === 'closed' ? 'Start another interview' : 'Start interview'}
          </button>
        ) : (
          <>
            <button type="button" className="btn" data-danger="true" onClick={endInterview}>
              End interview
            </button>
            {/* Never disabled. You must be able to stop transmitting even while
                the panel is mid-sentence. */}
            <button type="button" className="btn" data-on={muted} onClick={toggleMute}>
              {muted ? 'Unmute microphone' : 'Mute microphone'}
            </button>
          </>
        )}

        <button type="button" className="btn" onClick={() => reset()} disabled={busy || phase === 'live'}>
          Reset
        </button>
      </div>

      {phase === 'live' && (
        <div className="controls">
          <span className="hearing" data-muted={busy || muted} aria-live="polite">
            {thinking
              ? 'The panel is thinking…'
              : muted
                ? 'Microphone muted'
                : hearing
                  ? `“${hearing}”`
                  : busy
                    ? 'Microphone off while the panel answers'
                    : 'Listening…'}
          </span>
        </div>
      )}

      {phase === 'live' && (
        <div className="controls">
          <form
            className="field"
            data-fallback="true"
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
            placeholder="…or type instead, if the microphone will not cooperate"
            disabled={busy}
            aria-label="Your answer"
          />
          <button type="submit" className="btn" disabled={busy || !answer.trim()}>
            Send
          </button>
          </form>
        </div>
      )}

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
