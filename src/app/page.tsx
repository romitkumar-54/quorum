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
  AGENT_IDS,
  CANDIDATE_UID,
  DEFAULT_CHANNEL,
  EMPTY_BRIEF,
  SILENT_UID,
  newChannelName,
  type AgentId,
  type Brief,
  type ChannelConfig,
  type ChannelMode,
  type FloorDecision,
  type TranscriptEvent,
} from '@/core/contracts'
import { InterviewSession, type SessionStep } from '@/core/session'
import { EMPTY_METRICS, type Metrics } from '@/core/metrics'
import type { Assessment } from '@/core/brief'
import { detectBehavior } from '@/core/brief/analyzer'
import { END_MESSAGES, INTERVIEW_LIMITS, type EndReason } from '@/core/interviewPolicy'
import { SimulatedTransport } from '@/transport/simulated'
import { AgoraTransport } from '@/transport/agora'
import { RtcChannel } from '@/transport/rtcChannel'
import type { Transport } from '@/transport/types'
import { buildSystemPrompt } from '@/agents/personas'
import { chooseBrain, type Brain } from '@/agents/choose'
import { CandidateEar } from '@/speech'
import { SourceRack, type SourceView } from '@/components/SourceRack'
import { BriefPanel, FloorStrip, Meters, TranscriptFeed } from '@/components/Panels'
import { Ledger, Report } from '@/components/Report'
import { Icon, QuorumMark, VoiceOrbit } from '@/components/InterviewVisuals'

const idleSources = (): Record<AgentId, SourceView> =>
  Object.fromEntries(AGENT_IDS.map((id) => [id, { state: 'idle', line: '', cutIn: false }])) as Record<
    AgentId,
    SourceView
  >

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The channel the panel joins, for one mode.
 *
 * `remote_rtc_uids` is the whole argument in one field. Coordinated hands every
 * agent a uid nobody joins as, so none of them can hear anything and none
 * self-triggers. Naive hands them the candidate, so all three hear the same
 * silence and all three answer. Both are real Agora joins.
 */
const channelFor = (mode: ChannelMode, channelName: string): ChannelConfig => ({
  channelName,
  remoteRtcUids: mode === 'naive' ? [CANDIDATE_UID] : [SILENT_UID],
  mode,
})

/** idle: nothing has happened. live: the microphone is open. closed: the report is out. */
type Phase = 'idle' | 'live' | 'closed'

/** Long enough for a judge to watch the bids land before the floor is granted. */
const BID_REVEAL_MS = 550

export default function Gallery() {
  const sessionRef = useRef<InterviewSession | null>(null)
  /** Whichever transport the current interview is running on. */
  const transportRef = useRef<Transport | null>(null)
  /** Kept aside as the fallback, and as what the idle page runs on. */
  const simulatedRef = useRef<SimulatedTransport | null>(null)
  /** Does the server hold all four Agora values? Decided once, at mount. */
  const agoraReadyRef = useRef(false)
  /**
   * This visit's channel. Fixed for the life of the page, because the candidate
   * joins it at mount and the panel joins the same one at start. Held on a ref
   * as well as in state so a StrictMode remount does not invent a second one.
   */
  const channelRef = useRef('')
  const earRef = useRef<CandidateEar | null>(null)
  /** The candidate's own seat in the RTC channel. Null until Agora is configured. */
  const rtcRef = useRef<RtcChannel | null>(null)
  /**
   * The thinking parts that still run here: the brief, and the deterministic
   * line an agent falls back to. There is nothing to probe for any more.
   */
  const brainRef = useRef<Brain>(chooseBrain())
  /** The microphone callback needs the live value, not the one captured at start(). */
  const busyRef = useRef(false)
  const generationRef = useRef(0)
  /** A mute the candidate asked for, which the panel's own muting must not undo. */
  const mutedRef = useRef(false)
  const startedAtRef = useRef(0)
  const lastActivityRef = useRef(0)
  const closingRef = useRef(false)

  const [mode, setMode] = useState<ChannelMode>('coordinated')
  const [channelName, setChannelName] = useState(DEFAULT_CHANNEL.channelName)
  const [sources, setSources] = useState(idleSources)
  const [decision, setDecision] = useState<FloorDecision | null>(null)
  const [decisions, setDecisions] = useState<FloorDecision[]>([])
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
  const [rtcJoined, setRtcJoined] = useState(false)
  const [llmLive, setLlmLive] = useState(false)
  const [ready, setReady] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [endReason, setEndReason] = useState<EndReason | null>(null)
  const [cleanupFailed, setCleanupFailed] = useState(false)

  // ── Join the channel ───────────────────────────────────────────────────────
  useEffect(() => {
    let active = true
    const channel = channelRef.current || (channelRef.current = newChannelName())
    setChannelName(channel)

    const transport = new SimulatedTransport()
    simulatedRef.current = transport
    transportRef.current = transport
    sessionRef.current = new InterviewSession({ mode: 'coordinated' })
    earRef.current = new CandidateEar()

    transport
      .join(
        DEFAULT_CHANNEL,
        AGENT_IDS.map((id) => ({
          agentId: id,
          // Deaf by default: every agent subscribes to a uid nobody joins as,
          // so none of them self-triggers and the coordinator is the only thing
          // that can start a turn. Naive mode swaps this for the candidate's
          // uid and lets all three fire at once.
          remoteRtcUids: DEFAULT_CHANNEL.remoteRtcUids,
          systemPrompt: buildSystemPrompt(id),
        })),
      )
      .then(() => { if (active) setVoiceSupported(true) })

    // If the server holds Agora credentials, say so rather than overselling --
    // and if it does, actually join the channel so the candidate is a real
    // participant and the interviewers can be heard.
    // Reuse the instance across a StrictMode remount. A fresh RtcChannel per
    // mount means a fresh join queue per mount, and the two race for uid 1000.
    const rtc = rtcRef.current ?? new RtcChannel()
    rtcRef.current = rtc
    AgoraTransport.isConfigured().then((configured) => {
      if (!active) return
      setAgoraLive(configured)
      // Every model is Agora-managed and runs inside an agent, so a configured
      // transport is a configured brain. There is no second key to check, and
      // no fifth credential -- that is the point, not an omission.
      setLlmLive(configured)
      // Noted, not acted on. The agents are created when the interview starts,
      // because three of them bill $0.10 a minute each from the moment they
      // join and opening the tab must not start the meter.
      agoraReadyRef.current = configured
      setReady(true)
    })

    // Closing the tab is the ordinary way an interview ends, and with
    // `idle_timeout: 0` an agent never exits on its own -- three of them left
    // behind bill about $18 an hour until Agora's 72-hour cap. `fetch` during
    // unload is routinely cancelled, so this goes out as a beacon. It is still
    // best-effort, which is why the server sweeps the channel on the next join.
    const goodbye = () => {
      if (agoraReadyRef.current && channelRef.current) {
        navigator.sendBeacon?.(
          '/api/agent',
          new Blob([JSON.stringify(transportRef.current instanceof AgoraTransport ? transportRef.current.leavePayload() : {})], {
            type: 'application/json',
          }),
        )
      }
      void rtcRef.current?.leave()
    }
    window.addEventListener('pagehide', goodbye)
    window.addEventListener('beforeunload', goodbye)

    return () => {
      active = false
      sessionRef.current?.cancel()
      window.removeEventListener('pagehide', goodbye)
      window.removeEventListener('beforeunload', goodbye)
      // Leave the channel on unmount. Every agent left sitting in a channel
      // bills, and a hot reload should not quietly open a second candidate.
      void rtcRef.current?.leave()
      void transportRef.current?.leave().catch(() => undefined)
    }
  }, [])

  const refresh = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    setTranscript([...session.transcript.all()])
    setBrief(session.brief.current())
    setMetrics(session.metrics())
    setDecisions([...session.coordinator.log()])
    setYieldedIds(new Set(session.yieldedEventIds()))
  }, [])

  const endInterview = useCallback(async (reason: EndReason = 'candidate') => {
    if (closingRef.current) return
    closingRef.current = true
    setCleanupFailed(false)
    const generation = ++generationRef.current
    sessionRef.current?.cancel()
    busyRef.current = true
    setBusy(true)
    setThinking(false)
    earRef.current?.stop()
    setListening(false)
    setHearing('')
    setSources(idleSources)
    setEndReason(reason)
    setPhase('closed')
    refresh()
    setAssessment(sessionRef.current?.assessment() ?? null)
    const transport = transportRef.current
    const rtc = rtcRef.current
    void rtc?.leave().catch(() => undefined)
    setRtcJoined(false)
    // Report immediately, but keep Start disabled until agent cleanup finishes.
    // Failed cleanup remains retryable and is never reported as success.
    let left = false
    for (let attempt = 0; attempt < 3 && !left; attempt++) {
      try { await transport?.leave(); left = true } catch {
        if (attempt < 2) await sleep(700)
      }
    }
    closingRef.current = false
    if (generation !== generationRef.current) return
    if (!left) {
      setCleanupFailed(true)
      setNotice('The interview has ended, but the service could not confirm that all interviewers left. Retry closing the panel.')
      return
    }
    transportRef.current = simulatedRef.current
    busyRef.current = false
    setBusy(false)
  }, [refresh])

  useEffect(() => {
    if (phase !== 'live') return
    const check = () => {
      const now = Date.now()
      if (!startedAtRef.current) return
      setElapsedSeconds(Math.floor((now - startedAtRef.current) / 1000))
      if (now - startedAtRef.current >= INTERVIEW_LIMITS.maxDurationMs) void endInterview('time_limit')
      else if (!busyRef.current && now - lastActivityRef.current >= INTERVIEW_LIMITS.inactivityMs) void endInterview('inactivity')
    }
    const timer = window.setInterval(check, 1000)
    window.addEventListener('focus', check)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', check) }
  }, [phase, endInterview])

  // ── Play one candidate turn through the panel ─────────────────────────────
  const play = useCallback(
    async (step: SessionStep) => {
      const generation = generationRef.current
      const transport = transportRef.current
      if (!transport) return

      const grant = step.decisions[0]
      if (!grant) { refresh(); return }
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
      // Only worth pausing on when the words are still ahead of us. On Agora
      // the agent has already spoken by the time the session returns, and a
      // pause here would just be dead air after the fact.
      if (!transport.generatesOwnLines) await sleep(BID_REVEAL_MS)
      if (generation !== generationRef.current) return

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
        // In naive mode on Agora the three of them are already talking over
        // each other, on their own. This is only the simulator's collision.
        if (!transport.generatesOwnLines) {
          await Promise.all(
            step.utterances.map((utterance) => transport.speak(utterance.speaker as AgentId, utterance.text)),
          )
        }
        setSources(idleSources)
        refresh()
        return
      }

      // 3 — exactly one agent takes the floor, then somebody may cut in.
      for (const [index, utterance] of step.utterances.entries()) {
        if (generation !== generationRef.current) return
        const speaker = utterance.speaker as AgentId
        const thisDecision = step.decisions[index] ?? grant
        if (index > 0) {
          setDecision(thisDecision)
          // On Agora the session already stood the previous speaker down before
          // it granted the floor. Interrupting again here would cut off the
          // agent that just took it.
          if (!transport.generatesOwnLines) await transport.interrupt()
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

        // `think` was the grant, so on Agora this line is already out of the
        // speakers. Saying it again here would say it twice.
        if (!transport.generatesOwnLines) await transport.speak(speaker, utterance.text)
        if (generation !== generationRef.current) return
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
      const generation = generationRef.current
      setBusy(true)
      lastActivityRef.current = Date.now()
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
        if (generation !== generationRef.current) return
        if (step.endReason) {
          await endInterview(step.endReason)
          return
        }
        setThinking(false)
        await play(step)
      } catch (error) {
        if (generation === generationRef.current) {
          setNotice(error instanceof Error ? error.message : 'The interviewer could not respond. You can continue or retry your answer.')
          refresh()
        }
      } finally {
        if (generation === generationRef.current) {
          setThinking(false)
          if (!mutedRef.current) earRef.current?.unmute()
          busyRef.current = false
          setBusy(false)
          lastActivityRef.current = Date.now()
        }
      }
    },
    [play, refresh, endInterview],
  )

  const startListening = useCallback(() => {
    earRef.current?.start({
      onTurn: heard => { void runTurn(heard.text) },
      onInterim: text => { setHearing(text); if (text) lastActivityRef.current = Date.now() },
      shouldRedirect: text => detectBehavior(text) !== null,
      onListening: setListening,
      onError: setNotice,
    })
    if (busyRef.current || mutedRef.current) earRef.current?.mute()
  }, [runTurn])

  // ── The interview ──────────────────────────────────────────────────────────
  /**
   * Bring the panel into being for this interview.
   *
   * With credentials this is three real Agora joins, and it is the moment the
   * meter starts. Without them the simulated transport is already joined and
   * running on the browser's own speech engine, and the header keeps saying so.
   *
   * A refused join is not a reason to have no interview: it falls back to the
   * simulator and says why on screen.
   */
  const openPanel = useCallback(
    async (forMode: ChannelMode): Promise<Transport | undefined> => {
      const simulated = simulatedRef.current ?? undefined
      if (!agoraReadyRef.current) {
        setAgoraLive(false)
        setLlmLive(false)
        transportRef.current = simulated ?? null
        return simulated
      }

      const rtc = rtcRef.current
      if (!rtc || (!rtc.joined && !await rtc.join(channelRef.current, { onError: setNotice }))) {
        throw new Error('Could not connect your microphone to the interview. Check browser permission and start again.')
      }
      setRtcJoined(true)

      const channel = channelFor(forMode, channelRef.current || DEFAULT_CHANNEL.channelName)
      const agora = new AgoraTransport()
      const status = await agora.join(
        channel,
        AGENT_IDS.map((id) => ({
          agentId: id,
          remoteRtcUids: channel.remoteRtcUids,
          systemPrompt: buildSystemPrompt(id),
        })),
      )

      if (!status.connected) {
        setNotice(status.note ?? 'Agora would not seat the panel. Running the simulated voices instead.')
        transportRef.current = simulated ?? null
        setAgoraLive(false)
        setLlmLive(false)
        return simulated
      }

      transportRef.current = agora
      setAgoraLive(true)
      setLlmLive(true)
      return agora
    },
    [],
  )

  const startInterview = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const generation = ++generationRef.current
    const ear = earRef.current
    try {

    setPhase('live')
    startedAtRef.current = Date.now()
    lastActivityRef.current = Date.now()
    setElapsedSeconds(0)
    setEndReason(null)
    setCleanupFailed(false)
    setSources(idleSources)
    setDecision(null)
    setDecisions([])
    setTranscript([])
    setBrief(EMPTY_BRIEF)
    setMetrics(EMPTY_METRICS)
    setAssessment(null)
    setYieldedIds(new Set())
    setNotice(null)
    setHearing('')
    mutedRef.current = false
    setMuted(false)

    // Three Agora agents, or the simulator. Either way the session is built on
    // whatever answered, because the transport decides whether the panel writes
    // its own lines or has them written for it.
    const transport = await openPanel(mode)
    if (generation !== generationRef.current) {
      await transport?.leave()
      return
    }

    // A fresh session: the analyst and the coordinator are constructor options,
    // so the brain cannot be swapped into one that is already running.
    const session = new InterviewSession({ mode, transport, onNotice: setNotice, onTranscript: refresh,
      waitForAudio: (agent, text) => rtcRef.current?.waitForSilence(1001 + AGENT_IDS.indexOf(agent), text) ?? Promise.resolve(),
      ...brainRef.current })
    sessionRef.current = session

    // The microphone opens with the interview and stays open. There is nothing
    // to hold down: an interview is not a walkie-talkie.
    startListening()

    busyRef.current = true
    setBusy(true)
    setThinking(true)
    ear?.mute()
      const step = await session.open()
      if (generation !== generationRef.current) return
      setThinking(false)
      await play(step)
    } catch (error) {
      if (generation === generationRef.current) {
        setNotice(error instanceof Error ? error.message : 'Could not start the interview. Please try again.')
        ear?.stop()
        void transportRef.current?.leave().catch(() => setNotice('The start failed and panel cleanup could not be confirmed. Please retry closing the panel.'))
        setPhase('idle')
      }
    } finally {
      if (generation === generationRef.current) {
        setThinking(false)
        if (!mutedRef.current) ear?.unmute()
        busyRef.current = false
        setBusy(false)
        lastActivityRef.current = Date.now()
      }
    }
  }, [mode, openPanel, play, startListening, refresh])

  /** Not push-to-talk. A way to stop transmitting, which a live interview needs. */
  const toggleMute = useCallback(() => {
    const ear = earRef.current
    if (!ear) return
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    void rtcRef.current?.setMicMuted(next).catch(() => setNotice('Could not change the microphone state.'))
    if (next) ear.mute()
    else if (!busyRef.current) {
      if (!ear.listening) startListening()
      else ear.unmute()
    }
  }, [startListening])

  const reset = useCallback(
    (nextMode: ChannelMode = mode) => {
      void transportRef.current?.interrupt().catch(() => undefined)
      void transportRef.current?.leave().catch(() => undefined)
      transportRef.current = simulatedRef.current
      earRef.current?.stop()
      setListening(false)
      setHearing('')
      sessionRef.current?.reset(nextMode)
      setMode(nextMode)
      setSources(idleSources)
      setDecision(null)
      setDecisions([])
      setTranscript([])
      setBrief(EMPTY_BRIEF)
      setMetrics(EMPTY_METRICS)
      setAssessment(null)
      setYieldedIds(new Set())
      setNotice(null)
      setEndReason(null)
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
      decisions,
      reportShown: assessment !== null,
      voiceSupported,
    }),
    [transcript, brief, decisions, assessment, voiceSupported],
  )

  return (
    <main className="shell">
      <header className="strip">
        <span className="wordmark"><QuorumMark />Quorum</span>
        <span className="session-name">{channelName}</span>
        <div className="header-status">
          <span className="session-badge" data-live={phase === 'live'}><i />{phase === 'live' ? 'Live' : phase === 'closed' ? 'Complete' : 'Ready'}</span>
          <span className="header-symbol" title={rtcJoined ? 'Connected to the voice channel' : 'Voice channel connects when the interview starts'}><Icon name="signal" /></span>
          <span className="header-symbol" title="You are speaking with AI interviewers"><Icon name="shield" /></span>
        </div>
      </header>

      <div className="interview-layout">
        <aside className="live-brief" aria-label="Live interview brief">
          <div className="sidebar-heading"><h2>Live brief</h2><span className="small-dot" /></div>
          <div className="brief-detail"><Icon name="behavioural" /><div><span>Panel</span><strong>Three perspectives</strong><small>Technical · Product · Behavioural</small></div></div>
          <div className="brief-detail"><Icon name="focus" /><div><span>Focus</span><strong>Systems & trade-offs<br />Product impact<br />Communication</strong></div></div>
          <div className="brief-detail"><Icon name="signal" /><div><span>Difficulty</span><strong>Level {brief.difficulty} <span className="detail-muted">/ 5</span></strong><div className="level-steps" aria-hidden="true">{[1, 2, 3, 4, 5].map(n => <i key={n} data-on={brief.difficulty >= n} />)}</div></div></div>
          <div className="sidebar-section">
            <h2>Session metrics</h2>
            <div className="brief-detail"><Icon name="clock" /><div><span>Elapsed</span><strong className="elapsed">{Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')} <span className="detail-muted">/ 15:00</span></strong></div></div>
            <Meters metrics={metrics} />
          </div>
          <div className="sidebar-section session-connection"><h2>Connection</h2><p>{agoraLive ? (rtcJoined ? 'Agora · in channel' : 'Agora · ready') : 'Simulated voices'}<br />{llmLive ? 'Live questions' : 'Scripted questions'}</p><details><summary>Session details</summary><span className="strip-meta">
          {channelName} · remote_rtc_uids [{channelFor(mode, channelName).remoteRtcUids.join(', ')}] ·{' '}
          {agoraLive ? (rtcJoined ? 'agora · in channel' : 'agora') : 'simulated'} ·{' '}
          {llmLive ? 'live questions' : 'scripted'}
          </span></details></div>
        </aside>

        <section className="interview-room" aria-label="Interview room">
        <span className="disclosure">
          <Icon name="shield" />
          You are speaking with AI interviewers, not people.
        </span>

      <SourceRack sources={sources}>
        <VoiceOrbit active={phase === 'live' && !muted} muted={muted} label={phase === 'closed' ? 'Interview complete' : phase === 'idle' ? 'Your place in the conversation' : thinking ? 'The panel is thinking' : busy ? 'The panel has the floor' : muted ? 'Microphone muted' : 'Your turn to speak'} />
      </SourceRack>
      <FloorStrip decision={decision} />

      <div className="controls control-dock">
        <div className="coordinator-control"><span className="control-caption">Coordinator</span>
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
        </div>

        {phase !== 'live' ? (
          <button type="button" className="btn" data-primary="true" onClick={startInterview} disabled={busy || !ready}>
            <Icon name="mic" />
            {phase === 'closed' ? 'Start another interview' : 'Start interview'}
          </button>
        ) : (
          <>
            {/* Never disabled. You must be able to stop transmitting even while
                the panel is mid-sentence. */}
            <button type="button" className="btn" data-primary="true" data-on={muted} onClick={toggleMute}>
              <Icon name={muted ? 'muted' : 'mic'} />
              {muted ? 'Unmute microphone' : 'Mute microphone'}
            </button>
            <button type="button" className="btn" data-danger="true" onClick={() => void endInterview()}>
              <Icon name="signal" />End interview
            </button>
          </>
        )}

        <button type="button" className="btn" onClick={() => reset()} disabled={busy || phase === 'live'}>
          <Icon name="reset" />Reset
        </button>
      </div>

      <div className="controls session-guidance" aria-live="polite">
        {phase === 'closed' && endReason ? END_MESSAGES[endReason] : phase === 'live'
          ? `Answer ${Math.min(brief.turn + 1, INTERVIEW_LIMITS.maxAnswers)} of up to 12 · ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')} / 15:00`
          : 'About 9 answers across three areas. Ends automatically by 12 answers or 15 minutes, or after 2 minutes without activity.'}
        {phase === 'closed' && busy && !cleanupFailed && <span> Closing the panel…</span>}
        {phase === 'closed' && cleanupFailed && <button type="button" className="btn" onClick={() => void endInterview(endReason ?? 'candidate')}>Retry closing the panel</button>}
      </div>

      {phase === 'live' && (
        <div className="controls listening-controls">
          <span className="hearing" data-muted={busy || muted} aria-live="polite">
            {thinking
              ? 'The panel is thinking…'
              : muted
                ? 'Microphone muted'
                : hearing
                  ? `“${hearing}”`
                  : busy
                    ? 'Microphone off while the panel answers'
                    : listening ? `Listening… A ${INTERVIEW_LIMITS.answerSilenceMs / 1000}-second pause sends your answer.` : 'Microphone reconnecting or unavailable — retry or type your answer.'}
          </span>
          <button type="button" className="btn" disabled={busy || muted || !hearing} onClick={() => earRef.current?.finishTurn()}>Done answering</button>
          {!listening && !busy && <button type="button" className="btn" onClick={startListening}>Retry microphone</button>}
        </div>
      )}

      {phase === 'live' && (
        <div className="controls text-controls">
          <span className="typing-label"><Icon name="arrow" />Prefer typing? <span>Use text fallback</span></span>
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
            onChange={(event) => { setAnswer(event.target.value); lastActivityRef.current = Date.now() }}
            placeholder="Type your answer here…"
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
        <div className="controls notice" role="status">
          {notice}
        </div>
      )}

        </section>
      </div>

      <section className="session-record" aria-label="Session record">
      <div className="record-heading"><div><span className="eyebrow">The conversation, captured</span><h2>Session record</h2></div><span className="record-note">Every perspective. Every piece of evidence.</span></div>
      <div className="columns">
        <TranscriptFeed events={transcript} yieldedIds={yieldedIds} />
        <BriefPanel brief={brief} />
      </div>

      {assessment && <Report assessment={assessment} />}
      <Ledger state={requirementState} />
      </section>
    </main>
  )
}
