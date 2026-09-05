/**
 * The interviewers' voices.
 *
 * `QuestionGenerator` is the seam an LLM drops into. `ScriptedGenerator` is
 * today's implementation: it builds each line from the flag the coordinator
 * granted the floor for, so what an agent says always matches why it was
 * allowed to speak. That property is what makes the demo legible — the reason
 * on screen and the words out of the speaker are the same reason.
 */

import { type AgentId, type Brief, type Flag, type FloorDecision, type TranscriptEvent } from '@/core/contracts'
import { formatTimestamp } from '@/core/transcript'

export interface GenerationInput {
  agent: AgentId
  brief: Brief
  decision: FloorDecision
  /** The flags this agent was granted the floor to challenge. */
  justifiedBy: Flag[]
  /** True for the very first line, where there is nothing to react to yet. */
  opening?: boolean
  transcript: readonly TranscriptEvent[]
}

export interface QuestionGenerator {
  next(input: GenerationInput): Promise<string>
}

/**
 * The first thing the candidate hears.
 *
 * Four jobs in four sentences: say hello, disclose that the panel is AI —
 * requirement 11, and far too important to leave to a model's discretion —
 * warn that three interviewers will take turns so the first handover is not a
 * surprise, and open with something anybody can start talking about.
 *
 * It is a constant because it is spoken rather than generated. A panel that
 * opened with a cold, specific question felt like an interrogation, and one
 * that lets a model write its own greeting may not disclose anything at all.
 *
 * Agora's `speak` caps text at 512 bytes; this sits comfortably inside that.
 */
export const OPENING_LINE = [
  'Hello, and thanks for making the time today.',
  'You are speaking with an AI panel rather than with people —',
  'there are three of us, and we will take it in turns.',
  'We will cover three areas in about nine answers, with a limit of twelve answers or fifteen minutes.',
  'Whenever you are ready, tell us a little about yourself',
  'and a piece of work you are proud of.',
].join(' ')

/**
 * Deterministic lines, driven entirely by the brief. No API key, no latency,
 * and every sentence is traceable to a flag or to the current difficulty.
 */
export class ScriptedGenerator implements QuestionGenerator {
  async next({ agent, brief, justifiedBy, opening, transcript }: GenerationInput): Promise<string> {
    // The first thing anyone hears. It has to greet, it has to disclose that
    // the panel is not human, and it has to open with something answerable --
    // walking into a cold specific question is what made this feel abrupt.
    //
    // Fixed words, deliberately. This line is spoken rather than generated
    // precisely so the disclosure cannot drift.
    if (opening) return OPENING_LINE

    const flag = justifiedBy[0]
    const asked = new Set(transcript.filter(e => e.speaker !== 'candidate').map(e => e.text))
    if (flag?.kind === 'off_topic' || flag?.kind === 'evasion') {
      const previous = [...transcript].reverse().find(e => e.speaker !== 'candidate')?.text
      const pending = previous?.match(/[^.!?]*\?/)?.[0]?.trim()
      return `${flag.kind === 'off_topic' ? 'That takes us away from the interview.' : 'Let us return to the question.'} ${pending ?? 'What was your own contribution to the work you mentioned?'}`
    }

    if (flag?.kind === 'unchallenged_impact') {
      const line = 'What measured change did the people using your work experience?'
      if (!asked.has(line)) return line
    }

    if (flag?.kind === 'contradiction') {
      const [earlier, later] = flag.evidence
      if (earlier && later) return `At ${formatTimestamp(earlier.t)} you said "${stripPeriod(earlier.quote).slice(0, 100)}", and at ${formatTimestamp(later.t)} "${stripPeriod(later.quote).slice(0, 100)}". Were these the same project and stage?`
    }

    if (flag?.kind === 'vague') {
      const line = 'What concrete example or before-and-after result supports that claim?'
      if (!asked.has(line)) return line
    }

    return followUp(agent, brief, asked)
  }
}

/** No flag to press — ask the next question at the current difficulty. */
function followUp(agent: AgentId, brief: Brief, asked: Set<string>): string {
  const ladder = LADDER[agent]
  const start = Math.min(brief.difficulty, 5) - 1
  const candidates = [...ladder.slice(start), ...ladder.slice(0, start)]
  return candidates.find(line => !asked.has(line)) ?? `For answer ${brief.turn + 1}, what different example from your work would you like this interviewer to examine?`
}

/** Requirement 7 — the question gets harder as the candidate earns it. */
const LADDER: Record<AgentId, string[]> = {
  technical: [
    'Walk me through what your code actually does, step by step.',
    'What data structure did you reach for, and why that one?',
    'What is the complexity, and where does it degrade?',
    'How would you keep that correct under concurrent writes?',
    'Design it again for ten million keys and a cold cache.',
    'What failure case did you test before releasing that approach?',
    'Which alternative did you reject, and what constraint ruled it out?',
    'How would you detect a regression in production?',
    'Where would you start investigating a sudden slowdown?',
    'What would make you change the architecture you chose?',
    'How would you recover if a dependency became unavailable?',
    'What did your first implementation get wrong?',
  ],
  product: [
    'Who was this for?',
    'What problem were the users actually having?',
    'How did you know it worked once it shipped?',
    'What would you have cut to ship it a week earlier?',
    'If this halved engagement, how would you have found out first?',
    'What was the baseline before your change?',
    'What evidence would show that your change did not cause the improvement?',
    'Which group of users did your decision leave out?',
    'What did you learn from a customer who did not use the feature?',
    'Which cost did you accept to get that outcome?',
    'What result would make you reverse your product decision?',
    'What would you measure in the next experiment?',
  ],
  behavioural: [
    'Tell me who else was involved.',
    'What part of that was yours specifically?',
    'What did you disagree with the team about?',
    'Tell me about the call you got wrong on that project.',
    'Someone senior overrules you on this design. What do you do?',
    'What did you say when someone disagreed with your approach?',
    'What feedback made you change how you worked?',
    'How did you explain a setback to the people depending on you?',
    'What did you do personally to resolve the disagreement?',
    'What would you do differently if that situation happened again?',
    'How did you check that the other person understood your decision?',
    'What did you learn from handing this work over to someone else?',
  ],
}

function stripPeriod(s: string): string {
  return s.replace(/[.!?]+$/, '')
}
