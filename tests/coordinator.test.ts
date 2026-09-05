import { describe, expect, it } from 'vitest'
import { InterviewSession } from '@/core/session'
import { DEMO_TRANSCRIPT } from '@/core/demo'
import type { FloorDecision } from '@/core/contracts'

/** Deterministic timings so latency assertions mean something. */
const fixed = { decisionLatency: () => 50, holdBeforeRecheck: () => 1600 }

function runDemo(mode: 'naive' | 'coordinated') {
  const session = new InterviewSession({ mode, ...fixed })
  const steps = DEMO_TRANSCRIPT.map((t) => session.candidateSays(t.text, t.at))
  return { session, steps, decisions: session.coordinator.log() }
}

describe('the invariant: at most one agent holds the floor', () => {
  it('never grants the floor to more than one agent in coordinated mode', () => {
    const { decisions } = runDemo('coordinated')
    expect(decisions.length).toBeGreaterThan(0)
    for (const d of decisions) {
      expect(d.kind).not.toBe('collision')
      expect(d.collidedWith).toBeUndefined()
    }
  })

  it('holds across randomised sessions', () => {
    // Utterances chosen to fire every rule: specific, vague, impact,
    // and both sides of two contradiction topics.
    const pool = [
      'I used a hash map so lookups are O(1).',
      'It made things a lot faster for users.',
      'We shipped it to everyone on day one.',
      'We rolled it out to 5% first, to be safe.',
      'I built the whole thing on my own.',
      'The team designed it together over a week.',
      'We had unit tests covering the parser.',
      'Honestly we skipped the tests to make the date.',
      'It cut p95 latency from 400ms to 90ms.',
      'Things felt much smoother afterwards.',
    ]

    for (let seed = 0; seed < 60; seed++) {
      const session = new InterviewSession({ mode: 'coordinated', ...fixed })
      let t = 0
      // Deterministic pseudo-random walk, so a failure is reproducible.
      let x = seed * 7919 + 13
      const turns = 4 + (seed % 5)
      for (let i = 0; i < turns; i++) {
        x = (x * 1103515245 + 12345) % 2147483647
        t += 5_000 + (x % 20_000)
        session.candidateSays(pool[Math.abs(x) % pool.length], t)
      }

      for (const d of session.coordinator.log()) {
        expect(d.kind, `seed ${seed}`).not.toBe('collision')
        if (d.kind === 'grant' || d.kind === 'interrupt') {
          expect(d.grantedTo, `seed ${seed}`).toBeTruthy()
        }
      }
      // The floor is always handed back at the end of a turn.
      expect(session.coordinator.holder(), `seed ${seed}`).toBeNull()
    }
  })
})

describe('naive mode reproduces the problem', () => {
  it('collides when every agent hears the same silence', () => {
    const { decisions } = runDemo('naive')
    const collisions = decisions.filter((d) => d.kind === 'collision')
    expect(collisions.length).toBeGreaterThan(0)
    expect(collisions[0].collidedWith!.length).toBeGreaterThan(1)
  })

  it('reports a non-zero collision rate, where coordinated reports zero', () => {
    expect(runDemo('naive').session.metrics().collisionRate).toBeGreaterThan(0)
    expect(runDemo('coordinated').session.metrics().collisionRate).toBe(0)
  })
})

describe('the demo beat', () => {
  const { steps, decisions } = runDemo('coordinated')

  it('grants turn one to Technical, on the technical claim', () => {
    expect(decisions[0].kind).toBe('grant')
    expect(decisions[0].grantedTo).toBe('technical')
  })

  it('has Technical accept the answer rather than press it', () => {
    // Technical owns algorithms. The hand-wavy sentence was about impact, so it
    // is not Technical's to challenge — it is satisfied, and says so.
    const technical = steps[0].utterances.find((u) => u.speaker === 'technical')
    expect(technical?.text).toMatch(/correct, efficient/i)
  })

  it('lets Product cut in over Technical for the unquantified impact', () => {
    const interrupt = decisions.find((d: FloorDecision) => d.kind === 'interrupt')
    expect(interrupt).toBeDefined()
    expect(interrupt!.grantedTo).toBe('product')
    expect(interrupt!.yieldedBy).toBe('technical')
    expect(interrupt!.reason).toMatch(/impact claimed but never quantified/i)
  })

  it('says the line it was granted the floor to say', () => {
    const product = steps[0].utterances.find((u) => u.speaker === 'product')
    expect(product?.text).toMatch(/who does that help/i)
  })

  it('truncates the interrupted agent mid-sentence', () => {
    const technical = steps[0].utterances.find((u) => u.speaker === 'technical')!
    // It yielded at the recheck, earlier than it would have finished speaking.
    expect(technical.tEnd).toBe(steps[0].decisions[0].tDecision + 1600)
  })

  it('challenges the contradiction with both timestamps', () => {
    const behavioural = steps[2].utterances.find((u) => u.speaker === 'behavioural')
    expect(behavioural?.text).toMatch(/02:14/)
    expect(behavioural?.text).toMatch(/04:07/)
  })
})
