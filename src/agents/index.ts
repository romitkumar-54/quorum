/**
 * The interviewers' voices.
 *
 * `QuestionGenerator` is the seam an LLM drops into. `ScriptedGenerator` is
 * today's implementation: it builds each line from the flag the coordinator
 * granted the floor for, so what an agent says always matches why it was
 * allowed to speak. That property is what makes the demo legible — the reason
 * on screen and the words out of the speaker are the same reason.
 */

import { AGENTS, type AgentId, type Brief, type Flag, type FloorDecision, type TranscriptEvent } from '@/core/contracts'
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
  'Whenever you are ready, tell us a little about yourself',
  'and a piece of work you are proud of.',
].join(' ')

/**
 * Deterministic lines, driven entirely by the brief. No API key, no latency,
 * and every sentence is traceable to a flag or to the current difficulty.
 */
export class ScriptedGenerator implements QuestionGenerator {
  async next({ agent, brief, justifiedBy, opening }: GenerationInput): Promise<string> {
    // The first thing anyone hears. It has to greet, it has to disclose that
    // the panel is not human, and it has to open with something answerable --
    // walking into a cold specific question is what made this feel abrupt.
    //
    // Fixed words, deliberately. This line is spoken rather than generated
    // precisely so the disclosure cannot drift.
    if (opening) return OPENING_LINE

    const flag = justifiedBy[0]

    if (flag?.kind === 'unchallenged_impact') {
      return 'Who does that help? You said it got faster — faster for whom, and by how much?'
    }

    if (flag?.kind === 'contradiction') {
      const [earlier, later] = flag.evidence
      return `Hold on. At ${formatTimestamp(earlier.t)} you said "${stripPeriod(earlier.quote)}". At ${formatTimestamp(later.t)} it became "${stripPeriod(later.quote)}". Which was it?`
    }

    if (flag?.kind === 'vague') {
      return 'Put a number on that. What did it go from, and what did it go to?'
    }

    return followUp(agent, brief)
  }
}

/** No flag to press — ask the next question at the current difficulty. */
function followUp(agent: AgentId, brief: Brief): string {
  const lastClaim = [...brief.claims].reverse().find((c) => c.competency === AGENTS[agent].owns)

  if (agent === 'technical') {
    // The "correct, efficient" beat: acknowledge a solid answer, then push.
    if (lastClaim?.specific) {
      return brief.difficulty >= 4
        ? 'Correct, efficient. Now what breaks at ten million keys and a cold cache?'
        : 'Correct, efficient. What does that cost you in memory?'
    }
    return LADDER.technical[Math.min(brief.difficulty, 5) - 1]
  }

  if (agent === 'product') {
    return LADDER.product[Math.min(brief.difficulty, 5) - 1]
  }

  return LADDER.behavioural[Math.min(brief.difficulty, 5) - 1]
}

/** Requirement 7 — the question gets harder as the candidate earns it. */
const LADDER: Record<AgentId, string[]> = {
  technical: [
    'Walk me through what your code actually does, step by step.',
    'What data structure did you reach for, and why that one?',
    'What is the complexity, and where does it degrade?',
    'How would you keep that correct under concurrent writes?',
    'Design it again for ten million keys and a cold cache.',
  ],
  product: [
    'Who was this for?',
    'What problem were the users actually having?',
    'How did you know it worked once it shipped?',
    'What would you have cut to ship it a week earlier?',
    'If this halved engagement, how would you have found out first?',
  ],
  behavioural: [
    'Tell me who else was involved.',
    'What part of that was yours specifically?',
    'What did you disagree with the team about?',
    'Tell me about the call you got wrong on that project.',
    'Someone senior overrules you on this design. What do you do?',
  ],
}

function stripPeriod(s: string): string {
  return s.replace(/[.!?]+$/, '')
}
