/**
 * VOICE — with no credentials
 *
 * The browser ships a speech synthesiser and a recogniser. That gives us three
 * genuinely distinct interviewer voices and real candidate speech-to-text with
 * no API key, which is what makes the panel demonstrable today.
 *
 * When Agora credentials land, `AgoraTransport` takes over the audio path and
 * this module stays as the local-preview fallback. The interfaces above it do
 * not change.
 */

import { AGENTS, type AgentId } from '@/core/contracts'

const isBrowser = () => typeof window !== 'undefined'

// ─────────────────────────────────────────────────────────────────────────────
// Output — three distinct voices
// ─────────────────────────────────────────────────────────────────────────────

export class PanelVoice {
  private assigned = new Map<AgentId, SpeechSynthesisVoice | null>()
  private utterances = new Map<AgentId, SpeechSynthesisUtterance>()

  get supported(): boolean {
    return isBrowser() && 'speechSynthesis' in window
  }

  /**
   * Voice lists load asynchronously in most browsers, and in some they only
   * populate after the `voiceschanged` event. Resolve either way.
   */
  async ready(): Promise<void> {
    if (!this.supported) return
    const existing = window.speechSynthesis.getVoices()
    if (existing.length > 0) return this.assign(existing)

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1500)
      window.speechSynthesis.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(timeout)
          resolve()
        },
        { once: true },
      )
    })
    this.assign(window.speechSynthesis.getVoices())
  }

  /**
   * Give each interviewer its own voice. Preferred names first; failing that,
   * any three distinct English voices, so the panel never sounds like one person.
   */
  private assign(voices: SpeechSynthesisVoice[]): void {
    const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'))
    const pool = english.length >= 3 ? english : voices
    const taken = new Set<string>()

    for (const id of Object.keys(AGENTS) as AgentId[]) {
      const preferred = AGENTS[id].voice.prefer
      let match =
        pool.find((v) => !taken.has(v.name) && preferred.some((p) => v.name.toLowerCase().includes(p.toLowerCase()))) ??
        pool.find((v) => !taken.has(v.name))
      if (!match) match = pool[0] ?? null
      if (match) taken.add(match.name)
      this.assigned.set(id, match ?? null)
    }
  }

  /** Which voice each interviewer ended up with — shown in the UI. */
  assignments(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [id, voice] of this.assigned) out[id] = voice?.name ?? 'default'
    return out
  }

  speak(agent: AgentId, text: string, handlers: { onStart?: () => void; onEnd?: () => void } = {}): void {
    if (!this.supported) {
      handlers.onStart?.()
      handlers.onEnd?.()
      return
    }

    const utterance = new SpeechSynthesisUtterance(text)
    const profile = AGENTS[agent]
    const voice = this.assigned.get(agent)
    if (voice) utterance.voice = voice
    // Pitch and rate differ per role even when the browser only has one voice.
    utterance.pitch = profile.voice.pitch
    utterance.rate = profile.voice.rate
    utterance.onstart = () => handlers.onStart?.()
    utterance.onend = () => handlers.onEnd?.()
    utterance.onerror = () => handlers.onEnd?.()

    this.utterances.set(agent, utterance)
    window.speechSynthesis.speak(utterance)
  }

  /** Cut an agent off mid-sentence. This is the yield path, audibly. */
  cancel(): void {
    if (!this.supported) return
    window.speechSynthesis.cancel()
    this.utterances.clear()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input — the candidate's microphone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long the candidate must be quiet before the turn is over.
 *
 * Chrome marks a result `isFinal` at every phrase boundary, which is far too
 * eager — one answer arrives as three or four finals, and treating each as a
 * turn puts the panel on the floor mid-sentence. Silence ends a turn here, not
 * the phrase boundary. Tune this in rehearsal: too low and a thinking pause
 * cuts the candidate off.
 */
export const SILENCE_MS = 4000

/** How long to wait before retrying a restart the browser refused. */
const RESTART_RETRY_MS = 250

/**
 * Recogniser errors that are routine rather than fatal. Chrome fires `no-speech`
 * whenever the candidate simply pauses, and `aborted` on every restart; neither
 * is worth a notice, and neither should take the microphone down.
 */
const BENIGN_ERRORS = new Set(['no-speech', 'aborted', 'audio-capture-timeout'])

/**
 * The only errors that actually mean the microphone is gone.
 *
 * Everything else -- `network` above all, which Chrome raises against its own
 * recognition service on a long session -- is a blip, and `onend` reopens after
 * it. This set used to be "anything not benign", so a single network hiccup
 * took the microphone down for the rest of the interview and told the candidate
 * their permissions were wrong. The page went on saying "Listening…".
 */
const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed'])

/** Backoff between reopen attempts, so a failing recogniser cannot spin. */
const RESTART_BACKOFF_MS = 400
const RESTART_BACKOFF_CAP_MS = 4000

export interface HeardTurn {
  text: string
  /** ms since the recogniser started */
  tStart: number
  tEnd: number
}

export interface EarHandlers {
  /** A finished turn, ready for the coordinator. */
  onTurn: (turn: HeardTurn) => void
  /** Live partial text, so the candidate can see they are being heard. */
  onInterim?: (text: string) => void
  onError?: (message: string) => void
  onListening?: (listening: boolean) => void
}

type RecognitionCtor = new () => SpeechRecognitionLike

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null
  onerror: ((event: Event) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

interface SpeechRecognitionResultEventLike {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

function recognitionCtor(): RecognitionCtor | null {
  if (!isBrowser()) return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Candidate speech-to-text.
 *
 * Three things make this survive an actual interview rather than a single
 * sentence: it reopens the recogniser when the browser closes it, it ends a
 * turn on silence rather than on Chrome's phrase boundaries, and it can be
 * deafened while the panel speaks so the interviewers are never transcribed as
 * the candidate.
 *
 * Timestamps are taken here, at the edge, the moment a phrase starts being
 * recognised — the coordinator reads `tEnd` as the instant silence fell.
 */
export class CandidateEar {
  private recognition: SpeechRecognitionLike | null = null
  private handlers: EarHandlers | null = null
  private origin = 0

  /** Whether we intend to listen — deliberately distinct from whether the browser is. */
  private intent = false
  private deaf = false

  private silence: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null

  private finalText = ''
  private interimText = ''
  /** Highest result index already folded into `finalText`, per recogniser session. */
  private lastFinalIndex = -1
  private turnStart: number | null = null
  private lastHeardAt = 0
  /** Consecutive recogniser failures, used to back off the reopen loop. */
  private failures = 0

  get supported(): boolean {
    return recognitionCtor() !== null
  }

  get listening(): boolean {
    return this.intent
  }

  get muted(): boolean {
    return this.deaf
  }

  start(handlers: EarHandlers): boolean {
    this.stop()
    const Ctor = recognitionCtor()
    if (!Ctor) {
      handlers.onError?.('This browser has no speech recognition. Use Chrome, or type the answer instead.')
      return false
    }

    this.handlers = handlers
    this.intent = true
    this.deaf = false
    this.failures = 0
    this.origin = now()
    this.resetTurn()
    this.open(Ctor)
    return true
  }

  stop(): void {
    // Intent is cleared first: `onend` fires synchronously inside `stop()` in
    // some browsers, and it must not resurrect a recogniser we just closed.
    this.intent = false
    this.clearTimers()
    this.resetTurn()
    const recognition = this.recognition
    this.recognition = null
    this.handlers?.onListening?.(false)
    this.handlers = null
    if (recognition) {
      recognition.onend = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onstart = null
      try { recognition.stop() } catch { /* already ended */ }
    }
  }

  /**
   * Deafen the microphone while the panel speaks.
   *
   * The recogniser keeps running — tearing it down per utterance is slow and
   * swallows the candidate's first word — but everything it hears is dropped,
   * so the interviewers' own synthesised audio never comes back as an answer.
   */
  mute(): void {
    this.deaf = true
    this.clearSilence()
    this.resetTurn()
  }

  unmute(): void {
    this.deaf = false
    this.resetTurn()
    // A fresh recogniser removes stale result indices and late panel audio,
    // and recovers browsers that silently stopped during a long question.
    if (this.intent) this.restart()
  }

  /** Submit the assembled answer explicitly, without waiting for silence. */
  finishTurn(): void {
    this.clearSilence()
    if (this.intent && !this.deaf) this.endTurn()
  }

  private restart(): void {
    const previous = this.recognition
    this.recognition = null
    if (previous) {
      previous.onresult = previous.onerror = previous.onend = previous.onstart = null
      try { previous.stop() } catch { /* already ended */ }
    }
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    this.reopen()
  }

  // ── The recogniser session ────────────────────────────────────────────────

  private open(Ctor: RecognitionCtor): void {
    const recognition = new Ctor()
    recognition.continuous = true
    recognition.interimResults = true
    // en-IN, per the 2026-09-05 decision. The candidates are Indian, and the
        // Agora join payload was moved to en-IN at the time; this half of the
        // decision was never carried out, so the browser recogniser went on
        // scoring Indian English against a US model.
    recognition.lang = 'en-IN'
    recognition.onstart = () => {
      if (this.recognition === recognition && this.intent) this.handlers?.onListening?.(true)
    }
    recognition.onresult = (event) => {
      if (this.recognition === recognition && this.intent) this.consume(event)
    }
    recognition.onerror = (event) => {
      if (this.recognition === recognition && this.intent) this.onRecognitionError(event)
    }
    recognition.onend = () => {
      if (this.recognition !== recognition || !this.intent) return
      this.handlers?.onListening?.(false)
      this.recognition = null
      this.reopen()
    }

    this.recognition = recognition
    this.lastFinalIndex = -1

    try {
      recognition.start()
    } catch {
      // The previous session had not finished releasing the device. Try again.
      this.failures += 1
      this.handlers?.onListening?.(false)
      this.retry = setTimeout(() => this.restart(), RESTART_RETRY_MS + Math.min(this.failures * RESTART_BACKOFF_MS, RESTART_BACKOFF_CAP_MS))
    }
  }

  /**
   * Chrome ends recognition by itself after a few seconds of quiet, even with
   * `continuous = true`. Without this the microphone dies silently after the
   * candidate's first pause while the button still reads "Stop microphone".
   */
  private reopen(): void {
    if (!this.intent) return
    const Ctor = recognitionCtor()
    if (!Ctor) return
    // Anything still unfinalised dies with the session it belonged to. Keep it:
    // mid-answer, that text is the front half of the candidate's sentence.
    this.commitInterim()

    // A healthy session reopens immediately. One that keeps failing gets a
    // widening pause, so a recogniser refusing to start cannot spin the tab.
    const delay = Math.min(this.failures * RESTART_BACKOFF_MS, RESTART_BACKOFF_CAP_MS)
    if (delay === 0) {
      this.open(Ctor)
      return
    }

    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.intent) this.open(Ctor)
    }, delay)
  }

  /** Promote pending interim text to final. It will never be finalised now. */
  private commitInterim(): void {
    if (!this.interimText) return
    this.finalText = this.finalText ? `${this.finalText} ${this.interimText}` : this.interimText
    this.interimText = ''
  }

  private onRecognitionError(event: Event): void {
    const code = (event as Event & { error?: string }).error

    if (code && FATAL_ERRORS.has(code)) {
      this.handlers?.onError?.('The microphone is blocked. Allow it in the browser, then start again.')
      this.stop()
      return
    }

    if (code && BENIGN_ERRORS.has(code)) return // `onend` will reopen the session

    // Recoverable: count it so the reopen backs off, and say what happened
    // rather than going quiet while the page still claims to be listening.
    this.failures += 1
    this.handlers?.onListening?.(false)
    this.handlers?.onError?.(`The microphone dropped out (${code ?? 'unknown'}). Reconnecting…`)
    // Some browsers emit an error without onend. Do not depend on it.
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = setTimeout(() => this.restart(), RESTART_BACKOFF_CAP_MS)
  }

  // ── Turn assembly ─────────────────────────────────────────────────────────

  private consume(event: SpeechRecognitionResultEventLike): void {
    if (this.deaf || !this.intent) return

    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const text = result[0].transcript.trim()
      if (!text) continue

      if (result.isFinal) {
        // A final result is folded in once. The recogniser can re-deliver the
        // tail of a phrase as it revises it, and `lastFinalIndex` is what keeps
        // the candidate from saying everything twice.
        if (i > this.lastFinalIndex) {
          this.finalText = this.finalText ? `${this.finalText} ${text}` : text
          this.lastFinalIndex = i
        }
      } else {
        interim = interim ? `${interim} ${text}` : text
      }
    }

    if (!this.finalText && !interim) return

    // Words are arriving, so whatever went wrong before is over.
    this.failures = 0
    this.handlers?.onListening?.(true)

    this.interimText = interim
    const at = now() - this.origin
    this.turnStart ??= at
    this.lastHeardAt = at

    this.handlers?.onInterim?.([this.finalText, interim].filter(Boolean).join(' '))
    this.armSilence()
  }

  private armSilence(): void {
    this.clearSilence()
    this.silence = setTimeout(() => this.endTurn(), SILENCE_MS)
  }

  private endTurn(): void {
    this.silence = null
    const text = [this.finalText, this.interimText].filter(Boolean).join(' ').trim()
    const tStart = this.turnStart ?? 0
    const tEnd = this.lastHeardAt
    this.resetTurn()
    if (!text) return
    this.handlers?.onTurn({ text, tStart, tEnd })
  }

  private resetTurn(): void {
    this.finalText = ''
    this.interimText = ''
    this.turnStart = null
    this.lastHeardAt = 0
  }

  private clearSilence(): void {
    if (this.silence !== null) clearTimeout(this.silence)
    this.silence = null
  }

  private clearTimers(): void {
    this.clearSilence()
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
  }
}
