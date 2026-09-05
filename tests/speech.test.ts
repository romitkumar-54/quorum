import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CandidateEar, SILENCE_MS, type HeardTurn } from '@/speech'

/**
 * A stand-in for the browser's SpeechRecognition. It reproduces the two
 * behaviours that break the real thing: results arrive per-phrase rather than
 * per-turn, and the browser ends the session by itself after a short silence.
 */
class FakeRecognition {
  static startCount = 0
  static live: FakeRecognition[] = []

  continuous = false
  interimResults = false
  lang = ''
  onresult: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onend: (() => void) | null = null

  constructor() {
    FakeRecognition.live.push(this)
  }

  static current(): FakeRecognition {
    const last = FakeRecognition.live.at(-1)
    if (!last) throw new Error('no recognition was constructed')
    return last
  }

  start(): void {
    FakeRecognition.startCount++
  }

  stop(): void {
    this.onend?.()
  }

  /** One recognition result, the way Chrome delivers it. */
  say(transcript: string, isFinal: boolean, index = 0): void {
    this.onresult?.({
      resultIndex: index,
      results: { length: index + 1, [index]: { isFinal, 0: { transcript } } },
    })
  }

  /** Chrome giving up on its own — no stop() was called. */
  endsItself(): void {
    this.onend?.()
  }
}

function collect() {
  const turns: HeardTurn[] = []
  const interims: string[] = []
  return { turns, interims, onTurn: (t: HeardTurn) => turns.push(t), onInterim: (t: string) => interims.push(t) }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeRecognition.startCount = 0
  FakeRecognition.live = []
  ;(globalThis as { window?: unknown }).window = { SpeechRecognition: FakeRecognition }
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

describe('a spoken turn ends on silence, not on the browser phrase boundary', () => {
  it('emits one turn once the candidate has been quiet for the silence window', () => {
    const ear = new CandidateEar()
    const { turns, onTurn } = collect()
    ear.start({ onTurn })

    FakeRecognition.current().say('I built the ingest pipeline', true)
    expect(turns).toHaveLength(0) // a final phrase is not yet a finished turn

    vi.advanceTimersByTime(SILENCE_MS)

    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('I built the ingest pipeline')
  })

  it('merges phrases separated by less than the silence window into a single turn', () => {
    const ear = new CandidateEar()
    const { turns, onTurn } = collect()
    ear.start({ onTurn })

    const rec = FakeRecognition.current()
    rec.say('I built the ingest pipeline', true, 0)
    vi.advanceTimersByTime(300)
    rec.say('in Rust', true, 1)
    vi.advanceTimersByTime(SILENCE_MS)

    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('I built the ingest pipeline in Rust')
  })

  it('reports interim text while the phrase is still forming', () => {
    const ear = new CandidateEar()
    const { interims, onTurn, onInterim } = collect()
    ear.start({ onTurn, onInterim })

    FakeRecognition.current().say('I built the', false)

    expect(interims).toContain('I built the')
  })
})

describe('the microphone survives the browser ending recognition', () => {
  it('restarts recognition when the browser ends it while still listening', () => {
    const ear = new CandidateEar()
    const { onTurn } = collect()
    ear.start({ onTurn })
    expect(FakeRecognition.startCount).toBe(1)

    FakeRecognition.current().endsItself()

    expect(FakeRecognition.startCount).toBe(2)
  })

  it('keeps words the browser had not finalised when it ended the session', () => {
    const ear = new CandidateEar()
    const { turns, onTurn } = collect()
    ear.start({ onTurn })

    // Chrome routinely gives up mid-answer. Whatever it had not yet marked
    // final dies with that session unless we carry it across.
    FakeRecognition.current().say('I built the ingest pipeline', false)
    FakeRecognition.current().endsItself()
    FakeRecognition.current().say('in Rust', true)
    vi.advanceTimersByTime(SILENCE_MS)

    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('I built the ingest pipeline in Rust')
  })

  it('stays stopped once stop() has been called', () => {
    const ear = new CandidateEar()
    const { onTurn } = collect()
    ear.start({ onTurn })

    ear.stop()

    expect(FakeRecognition.startCount).toBe(1)
  })
})

describe('the panel does not hear itself', () => {
  it('discards everything heard while muted', () => {
    const ear = new CandidateEar()
    const { turns, onTurn } = collect()
    ear.start({ onTurn })

    ear.mute()
    FakeRecognition.current().say('That is a good point, tell me about latency', true)
    vi.advanceTimersByTime(SILENCE_MS * 2)

    expect(turns).toHaveLength(0)
  })

  it('hears the candidate again after unmuting', () => {
    const ear = new CandidateEar()
    const { turns, onTurn } = collect()
    ear.start({ onTurn })

    ear.mute()
    FakeRecognition.current().say('panel audio', true)
    ear.unmute()
    FakeRecognition.current().say('my actual answer', true)
    vi.advanceTimersByTime(SILENCE_MS)

    expect(turns).toHaveLength(1)
    expect(turns[0].text).toBe('my actual answer')
  })
})
