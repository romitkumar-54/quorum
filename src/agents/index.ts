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
  transcript: readonly TranscriptEvent[]
}

export interface QuestionGenerator {
  next(input: GenerationInput): string
}

/**
 * Deterministic lines, driven entirely by the brief. No API key, no latency,
 * and every sentence is traceable to a flag or to the current difficulty.
 */
export class ScriptedGenerator implements QuestionGenerator {
  next({ agent, brief, justifiedBy }: GenerationInput): string {
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
