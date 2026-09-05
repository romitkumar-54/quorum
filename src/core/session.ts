/**
 * THE LOOP
 *
 * One place where all four lanes meet, so the UI and the tests drive exactly the
 * same code path:
 *
 *   candidate speaks
 *     → lane A timestamps it
 *     → lane C folds it into the brief, raising claims and flags
 *     → lane B opens the floor and grants it to exactly one agent
 *     → that agent speaks, for the reason it was granted the floor
 *     → lane B re-checks mid-turn: does somebody else have grounds to cut in?
 */

import {
  type AgentId,
  type Brief,
  type ChannelMode,
  type Competency,
  type Flag,
  type FloorDecision,
  type TranscriptEvent,
} from '@/core/contracts'
import { BriefBuilder } from '@/core/brief'
import type { Analyzer } from '@/core/brief/analyzer'
import { Coordinator, DEFAULT_CONFIG, type CoordinatorConfig } from '@/core/coordinator'
import { computeMetrics, type Metrics } from '@/core/metrics'
import { SessionClock, TranscriptLog, estimateDuration } from '@/core/transcript'
import { ScriptedGenerator, type QuestionGenerator } from '@/agents'
import type { FloorPicker } from '@/agents/floor'
import type { Transport, TransportUtterance } from '@/transport/types'
import type { Assessment } from '@/core/brief'

export interface SessionStep {
  /** Absent on the opening turn, where the panel speaks before the candidate does. */
  candidateEvent?: TranscriptEvent
  brief: Brief
  /** In order: the grant, then an interrupt if one was justified. */
  decisions: FloorDecision[]
  /** What the agents actually said, in order. */
  utterances: TranscriptEvent[]
}

export interface SessionOptions {
  mode?: ChannelMode
  analyzer?: Analyzer
  generator?: QuestionGenerator
  /** Names who should take the floor. A preference — the coordinator still decides. */
  floor?: FloorPicker
  config?: CoordinatorConfig
  /**
   * How long the coordinator takes to decide once silence is detected, in ms.
   * Real in the browser; fixed in tests so latency assertions are deterministic.
   */
  decisionLatency?: () => number
  /** How long an agent speaks before the coordinator re-checks for interrupts. */
  holdBeforeRecheck?: () => number
  /**
   * How long a line of that text takes to say aloud, in ms.
   *
   * Real in the browser, where the session has to wait out an agent's speech;
   * zero in tests, which have no audio to wait for.
   */
  speechDuration?: (text: string) => number
  /**
   * Where the panel's voice comes out.
   *
   * The session only cares about one property of it: whether the agents write
   * their own lines. On Agora they do, and the grant becomes a `think` rather
   * than a composed line. Left undefined -- as every test does -- the session
   * composes as it always has.
   */
  transport?: Transport
  /** How long to wait for an Agora agent to write and say its line, in ms. */
  lineTimeoutMs?: number
  /** How often to ask the transport whether the line has landed yet, in ms. */
  linePollMs?: number
  /** How long an agent may be slow before we start asking whether it is alive. */
  healthCheckAfterMs?: number
  /**
   * Somewhere to put a problem the candidate should see.
   *
   * An interviewer that dies mid-turn is not an exception to throw -- the
   * interview carries on without it -- but going quiet with no explanation is
   * the worst version of that. This is how it reaches the notice bar.
   */
  onNotice?: (message: string) => void
  onTranscript?: () => void
  waitForAudio?: (agent: AgentId, text: string) => Promise<void>
}

/** Comfortably above MIN_HOLD_MS, so a justified interrupt is not a false one. */
const DEFAULT_HOLD_MS = 1600

/**
 * How long to wait for an Agora agent to write and say its line before giving
 * up on it. A managed model plus text-to-speech is a few seconds; twenty is a
 * failure, not a slow day.
 */
const DEFAULT_LINE_TIMEOUT_MS = 20_000

/** How often to ask whether the line has landed. */
const DEFAULT_LINE_POLL_MS = 700

/** How long an agent gets to be slow before we start asking whether it is alive. */
const HEALTH_CHECK_AFTER_MS = 3_000

export class InterviewSession {
  readonly transcript: TranscriptLog
  readonly brief: BriefBuilder
  readonly coordinator: Coordinator

  private clock = new SessionClock()
  private generator: QuestionGenerator
  private floor?: FloorPicker
  private decisionLatency: () => number
  private holdBeforeRecheck: () => number
  private speechDuration: (text: string) => number
  private transport?: Transport
  private lineTimeoutMs: number
  private linePollMs: number
  private healthCheckAfterMs: number
  private onNotice?: (message: string) => void
  /** Utterances that were cut off rather than finished. */
  private yielded = new Set<string>()
  /**
   * How many of each agent's own lines the transcript has already shown.
   *
   * Naive mode only. There the agents hear the candidate directly and their
   * models fire without being asked, so there is no moment to take a clean
   * baseline -- they may already be talking by the time this process notices
   * the turn ended. The count is carried across turns instead.
   */
  private consumed = new Map<AgentId, number>()
  private cancelled = false

  cancel(): void { this.cancelled = true }

  private assertActive(): void {
    if (this.cancelled) throw new Error('Interview ended.')
  }

  constructor(private options: SessionOptions = {}) {
    this.transcript = new TranscriptLog(this.clock)
    this.brief = new BriefBuilder(options.analyzer)
    this.coordinator = new Coordinator(options.mode ?? 'coordinated', options.config ?? DEFAULT_CONFIG)
    this.generator = options.generator ?? new ScriptedGenerator()
    this.floor = options.floor
    // 40–90 ms of deliberation by default: fast enough to feel instant, honest
    // enough that the reported p50 is a real number.
    this.decisionLatency = options.decisionLatency ?? (() => 40 + Math.random() * 50)
    this.holdBeforeRecheck = options.holdBeforeRecheck ?? (() => DEFAULT_HOLD_MS)
    this.speechDuration = options.speechDuration ?? estimateDuration
    this.transport = options.transport
    this.lineTimeoutMs = options.lineTimeoutMs ?? DEFAULT_LINE_TIMEOUT_MS
    this.linePollMs = options.linePollMs ?? DEFAULT_LINE_POLL_MS
    this.healthCheckAfterMs = options.healthCheckAfterMs ?? HEALTH_CHECK_AFTER_MS
    this.onNotice = options.onNotice
  }

  get mode(): ChannelMode {
    return this.coordinator.mode
  }

  /**
   * Drive one candidate turn all the way through the panel.
   * `at` fixes the utterance start time; otherwise the session clock is used.
   */

  /**
   * The panel opens the interview.
   *
   * Somebody has to speak first, and it cannot be the candidate: they are
   * waiting to be asked. The opener greets them, discloses that the panel is
   * not human, and asks the first question. The floor is released immediately
   * afterwards so the candidate can answer into an empty channel.
   */
  async open(opener: AgentId = 'behavioural'): Promise<SessionStep> {
    const tNow = this.decisionLatency()
    const grant = this.coordinator.openFloor(
      { brief: this.brief.current(), leadCompetency: undefined, tSilenceDetected: 0, tNow },
      opener,
      'Opening the interview.',
    )

    const speaker = grant.grantedTo ?? opener
    const text = await this.compose(speaker, grant, [], false, true)

    // The opener is the one line that has to be identical on every run: it
    // discloses that the panel is not human. So it is spoken, never thought --
    // a model asked to greet the candidate might not disclose anything.
    //
    // Where the agents write their own lines the session drives the transport
    // directly, because only it knows which lines were already said by the
    // agent itself. Everywhere else the caller does the speaking.
    if (this.transport?.generatesOwnLines) await this.sayAndWait(this.transport, speaker, text)

    const utterance = this.append(speaker, text, tNow)
    this.coordinator.release()

    return { brief: this.brief.current(), decisions: [grant], utterances: [utterance] }
  }

  async candidateSays(text: string, at?: number): Promise<SessionStep> {
    this.assertActive()
    const candidateEvent = this.transcript.append({ speaker: 'candidate', text, tStart: at })
    this.options.onTranscript?.()
    const { brief, lead } = await this.brief.ingest(candidateEvent)
    this.assertActive()

    // The analyst names the lead, rather than this reading it off the first
    // claim. The difference is that the analyst is allowed to name nobody: a
    // sentence that pointed at no interviewer's territory hands out no
    // relevance bonus, and the floor goes on fairness instead.
    const leadCompetency: Competency | undefined = lead
    const tSilenceDetected = candidateEvent.tEnd
    const decisions: FloorDecision[] = []
    const utterances: TranscriptEvent[] = []

    // The model nominates; the coordinator decides whether that is allowed.
    const nomination = this.floor
      ? await this.floor.pick({
          brief,
          transcript: this.transcript.all(),
          recentSpeakers: this.recentSpeakers(),
        })
      : null

    const grant = this.coordinator.openFloor(
      {
        brief,
        leadCompetency,
        tSilenceDetected,
        tNow: tSilenceDetected + this.decisionLatency(),
      },
      nomination?.agent ?? null,
      nomination?.reason,
    )
    decisions.push(grant)

    // ── Naive mode: everyone who bid is now talking over everyone else ────────
    if (grant.kind === 'collision' && grant.collidedWith) {
      // Nothing lands when three people speak at once, so the flags they were
      // each reacting to stay open — and the panel collides again next turn.
      //
      // The lines are written in parallel because three sequential model calls
      // would put the panel a full turn behind. They are recorded afterwards,
      // in bid order, so the transcript never depends on who answered first.
      const lines = await Promise.all(
        grant.collidedWith.map((agent) => this.collisionLine(agent, grant)),
      )
      for (const [index, agent] of grant.collidedWith.entries()) {
        utterances.push(this.append(agent, lines[index], grant.tDecision))
      }
      return { candidateEvent, brief: this.brief.current(), decisions, utterances }
    }

    if (!grant.grantedTo) {
      return { candidateEvent, brief: this.brief.current(), decisions, utterances }
    }

    const holder = await this.take(grant.grantedTo, grant, grant.tDecision, this.coordinator.justification(), text)
    utterances.push(holder)

    // ── Mid-turn: has somebody else got grounds to cut in? ───────────────────
    const tRecheck = grant.tDecision + this.holdBeforeRecheck()
    const interrupt = this.coordinator.considerInterrupt({
      brief: this.brief.current(),
      leadCompetency,
      tSilenceDetected,
      tNow: tRecheck,
    })

    if (interrupt?.grantedTo) {
      // The holder was cut off mid-sentence. Its utterance ends where the
      // interrupt landed, which is what the transcript should show.
      holder.tEnd = tRecheck
      this.yielded.add(holder.id)
      decisions.push(interrupt)
      utterances.push(
        await this.take(
          interrupt.grantedTo,
          interrupt,
          tRecheck,
          this.coordinator.justification(),
          text,
          true,
        ),
      )
    }

    this.coordinator.release()
    return { candidateEvent, brief: this.brief.current(), decisions, utterances }
  }

  metrics(): Metrics {
    return computeMetrics(this.coordinator.log())
  }

  /** Who has held the floor recently, oldest first. Context for the coordinator. */
  private recentSpeakers(): AgentId[] {
    return this.transcript
      .all()
      .filter((e) => e.speaker !== 'candidate')
      .slice(-4)
      .map((e) => e.speaker as AgentId)
  }

  /** Ids of utterances that ended because somebody cut in. */
  yieldedEventIds(): ReadonlySet<string> {
    return this.yielded
  }

  assessment(): Assessment {
    return this.brief.assessment()
  }

  setMode(mode: ChannelMode): void {
    this.coordinator.mode = mode
  }

  /**
   * Swap the brain. Used once at startup when the key probe answers, and by the
   * rehearsed demo to force the deterministic panel for its duration.
   */
  setGenerator(generator: QuestionGenerator): void {
    this.generator = generator
  }

  reset(mode: ChannelMode = this.coordinator.mode): void {
    this.transcript.clear()
    this.brief.reset()
    this.coordinator.reset(mode)
    this.yielded.clear()
    this.consumed.clear()
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * An agent takes the floor. The flags it was granted the floor for are marked
   * addressed first, so no two agents challenge the same thing — unless nothing
   * was actually heard, which is what `addressFlags: false` is for.
   */
  private async compose(
    agent: AgentId,
    decision: FloorDecision,
    flagIds: string[],
    addressFlags = true,
    opening = false,
  ): Promise<string> {
    const justifiedBy = this.flagsById(flagIds)
    if (addressFlags) this.brief.markAddressed(justifiedBy.map((f) => f.id))

    return this.generator.next({
      agent,
      brief: this.brief.current(),
      decision,
      justifiedBy,
      transcript: this.transcript.all(),
      opening,
    })
  }

  /**
   * The floor was granted. There are two ways the line then exists.
   *
   * On Agora each agent carries its own managed model, so granting the floor is
   * a `think`: we hand that one agent the candidate's answer and it writes the
   * reply and says it itself. The words never pass through this process, so the
   * transcript reads them back out of the transport afterwards.
   *
   * Everywhere else there is no model behind the transport, so the line is
   * composed here and the transport only voices it. `generatesOwnLines` is the
   * flag that picks between the two, and it exists for exactly this branch.
   */
  private async take(
    agent: AgentId,
    decision: FloorDecision,
    at: number,
    flagIds: string[],
    candidateText: string,
    cuttingIn = false,
  ): Promise<TranscriptEvent> {
    const transport = this.transport
    if (!transport?.generatesOwnLines) {
      return this.speak(agent, decision, at, flagIds)
    }

    // Marking the flags addressed belongs to the composer in the other branch.
    // It still has to happen here, or two agents challenge the same thing.
    const justifiedBy = this.flagsById(flagIds)
    this.brief.markAddressed(justifiedBy.map((f) => f.id))

    // Whoever was holding the floor stops mid-sentence before the next one
    // starts. This is the yield half of the interrupt.
    if (cuttingIn) await transport.interrupt()

    this.assertActive()
    const before = (await transport.history?.(agent)) ?? []
    this.assertActive()
    await transport.think(agent, candidateText)
    const line = await this.awaitLine(transport, agent, before)

    this.assertActive()
    if (line) {
      const event = this.append(agent, line.text, at)
      await this.options.waitForAudio?.(agent, line.text)
      this.assertActive()
      return event
    }

    // Nothing came back in time. Fall back to the deterministic line and say it
    // through the transport, so the transcript still shows what the channel
    // heard rather than a sentence nobody said. Per the 2026-09-05 decision: a
    // duller question beats a visible error mid-interview.
    const fallback = await this.compose(agent, decision, flagIds, false)
    this.assertActive()
    await transport.interrupt()
    await this.sayAndWait(transport, agent, fallback)
    return this.append(agent, fallback, at)
  }

  /**
   * One voice in a collision.
   *
   * On Agora this is a real one: in naive mode every agent subscribes to the
   * candidate, so all three heard the same silence and all three models fired
   * on their own. Nothing here started them and nothing here could have
   * stopped them -- that is the whole point of the control condition -- so all
   * this can do is read back what each of them said.
   */
  private async collisionLine(agent: AgentId, grant: FloorDecision): Promise<string> {
    const backing = grant.bids.find((b) => b.agent === agent)?.backedBy ?? []
    const transport = this.transport

    if (transport?.generatesOwnLines) {
      const said = await this.selfTriggeredLine(transport, agent)
      if (said) return said
    }

    return this.compose(agent, grant, backing, false)
  }

  /**
   * What an agent said when nothing here asked it to.
   *
   * Unlike the granted path there is no `think` to bracket, so the watermark of
   * lines already shown is what tells a new sentence from last turn's.
   */
  private async selfTriggeredLine(transport: Transport, agent: AgentId): Promise<string | null> {
    if (!transport.history) return null
    const known = this.consumed.get(agent) ?? 0

    const deadline = Date.now() + this.lineTimeoutMs
    while (Date.now() < deadline) {
      const said = await transport.history(agent)
      if (said.length > known) {
        this.consumed.set(agent, said.length)
        return said[said.length - 1].text
      }
      await new Promise((resolve) => setTimeout(resolve, this.linePollMs))
    }
    return null
  }

  /**
   * Say an exact line, and wait for it to actually have been said.
   *
   * Agora's `speak` resolves as soon as the request is accepted, not when the
   * agent stops talking — unlike the simulator, whose `speak` resolves on the
   * last word. Without this wait the session believes the panel is finished
   * while it is still mid-sentence, and two things go wrong at once: the
   * microphone reopens into the panel's own voice, and a `think` sent during
   * that window is dropped on the floor, because every `think` carries
   * `on_speaking_action: 'ignore'`. That is what made the turn after a long
   * greeting fall back to a scripted line for no visible reason.
   *
   * The estimate is the same one the transcript uses for an utterance's span,
   * so the clock and the audio agree.
   */
  private async sayAndWait(transport: Transport, agent: AgentId, text: string): Promise<void> {
    this.assertActive()
    await transport.speak(agent, text)
    if (this.options.waitForAudio) await this.options.waitForAudio(agent, text)
    else await new Promise((resolve) => setTimeout(resolve, this.speechDuration(text)))
    this.assertActive()
  }

  /**
   * Wait for the agent to finish saying whatever it decided to say.
   *
   * `think` returns as soon as Agora accepts it; the model still has to write
   * the line and the voice still has to say it. A new `assistant` entry in that
   * agent's history is the signal that both are done -- which makes this poll
   * also the thing that stops the candidate's next answer landing mid-sentence.
   */
  private async awaitLine(
    transport: Transport,
    agent: AgentId,
    known: TransportUtterance[],
  ): Promise<TransportUtterance | null> {
    if (!transport.history) return null

    const started = Date.now()
    const deadline = started + this.lineTimeoutMs

    while (Date.now() < deadline) {
      this.assertActive()
      await new Promise((resolve) => setTimeout(resolve, this.linePollMs))
      const said = await transport.history(agent)
      const fresh = said.filter(line => !known.some(old => old.turnId === line.turnId && old.text === line.text))
      if (fresh.length) {
        // History may be a rolling window or contain multiple chunks per turn.
        // Wait one poll for a revision, then retain every fresh chunk.
        await new Promise((resolve) => setTimeout(resolve, this.linePollMs))
        const latest = await transport.history(agent)
        const completed = latest.filter(line => !known.some(old => old.turnId === line.turnId && old.text === line.text))
        const lines = completed.length ? completed : fresh
        return { ...lines[0], text: [...new Set(lines.map(line => line.text))].join(' ') }
      }

      // A healthy agent takes a few seconds to think and speak, so asking after
      // every poll would double the traffic for nothing. Past that, an agent
      // that has died is worth catching early: waiting out the full timeout on
      // a corpse is silence the candidate has to sit through.
      if (Date.now() - started >= this.healthCheckAfterMs) {
        const state = await transport.agentState?.(agent)
        if (state && /fail|stop|exit|error/i.test(state)) {
          this.onNotice?.(`The ${agent} interviewer dropped out of the channel (${state}). The panel is covering.`)
          return null
        }
      }
    }

    this.onNotice?.(`The ${agent} interviewer did not answer in time. The panel is covering.`)
    return null
  }

  /** Record a line. Synchronous, so transcript order never follows resolution order. */
  private append(agent: AgentId, text: string, at: number): TranscriptEvent {
    this.assertActive()
    const event = this.transcript.append({
      speaker: agent,
      text,
      tStart: at,
      tEnd: at + estimateDuration(text),
    })
    this.options.onTranscript?.()
    return event
  }

  private async speak(
    agent: AgentId,
    decision: FloorDecision,
    at: number,
    flagIds: string[],
    addressFlags = true,
  ): Promise<TranscriptEvent> {
    return this.append(agent, await this.compose(agent, decision, flagIds, addressFlags), at)
  }

  /**
   * Resolve flag ids, preserving the order the coordinator ranked them in —
   * most urgent first — so the agent speaks to the flag it actually won on.
   */
  private flagsById(ids: string[]): Flag[] {
    if (ids.length === 0) return []
    const byId = new Map(this.brief.current().flags.map((f) => [f.id, f]))
    return ids.map((id) => byId.get(id)).filter((f): f is Flag => f !== undefined)
  }
}
