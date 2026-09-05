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

export interface HeardUtterance {
  text: string
  final: boolean
  /** ms since the recogniser started */
  tStart: number
  tEnd: number
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

/**
 * Candidate speech-to-text. Timestamps are taken the moment a phrase starts
 * being recognised — captured here, at the edge, before anything reads them.
 */
export class CandidateEar {
  private recognition: SpeechRecognitionLike | null = null
  private origin = 0
  private phraseStart: number | null = null

  get supported(): boolean {
    return recognitionCtor() !== null
  }

  start(onHeard: (u: HeardUtterance) => void, onError?: (message: string) => void): boolean {
    const Ctor = recognitionCtor()
    if (!Ctor) {
      onError?.('This browser has no speech recognition. Use Chrome, or type the answer instead.')
      return false
    }

    const recognition = new Ctor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    this.origin = performance.now()

    recognition.onresult = (event) => {
      let text = ''
      let final = false
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript
        if (event.results[i].isFinal) final = true
      }
      if (!text.trim()) return

      const now = performance.now() - this.origin
      this.phraseStart ??= now
      onHeard({ text: text.trim(), final, tStart: this.phraseStart, tEnd: now })
      if (final) this.phraseStart = null
    }

    recognition.onerror = () => onError?.('Microphone unavailable or permission denied.')

    this.recognition = recognition
    recognition.start()
    return true
  }

  stop(): void {
    this.recognition?.stop()
    this.recognition = null
    this.phraseStart = null
  }
}
