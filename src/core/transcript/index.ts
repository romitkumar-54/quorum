/**
 * LANE A — Transcript capture
 *
 * Every utterance lands here with start and end timestamps, captured from the
 * very first event and before anything reads them. This is deliberate: the
 * evidence-linked feedback requirement is cheap if the timestamps are already
 * present and expensive to retrofit if they are not.
 */

import type { Speaker, TranscriptEvent } from '@/core/contracts'

/** Monotonic ms since the session started. Injectable so tests are deterministic. */
export class SessionClock {
  private origin: number

  constructor(private now: () => number = () => Date.now()) {
    this.origin = this.now()
  }

  /** ms since session start */
  elapsed(): number {
    return this.now() - this.origin
  }

  reset(): void {
    this.origin = this.now()
  }
}

let seq = 0
const nextId = (prefix: string) => `${prefix}-${(++seq).toString(36)}`

/** Reset id counters. Tests only. */
export function __resetIds(): void {
  seq = 0
}

export class TranscriptLog {
  private events: TranscriptEvent[] = []

  constructor(private clock: SessionClock = new SessionClock()) {}

  /**
   * Record an utterance. `tStart` defaults to the current session time, so a
   * caller that forgets to pass timestamps still gets them.
   */
  append(input: {
    speaker: Speaker
    text: string
    tStart?: number
    tEnd?: number
    final?: boolean
  }): TranscriptEvent {
    const tStart = input.tStart ?? this.clock.elapsed()
    const event: TranscriptEvent = {
      id: nextId('ev'),
      speaker: input.speaker,
      text: input.text.trim(),
      tStart,
      tEnd: input.tEnd ?? tStart + estimateDuration(input.text),
      final: input.final ?? true,
    }
    this.events.push(event)
    return event
  }

  all(): readonly TranscriptEvent[] {
    return this.events
  }

  byId(id: string): TranscriptEvent | undefined {
    return this.events.find((e) => e.id === id)
  }

  bySpeaker(speaker: Speaker): TranscriptEvent[] {
    return this.events.filter((e) => e.speaker === speaker)
  }

  last(): TranscriptEvent | undefined {
    return this.events[this.events.length - 1]
  }

  clear(): void {
    this.events = []
    this.clock.reset()
  }
}

/** Rough spoken duration, used when a transport does not report an end time. */
export function estimateDuration(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  // ~150 wpm conversational speech, floored so very short utterances still span time
  return Math.max(700, Math.round((words / 150) * 60_000))
}

/** `04:07` — the format the report and the UI both use. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
