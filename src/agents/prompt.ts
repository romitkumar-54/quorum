/**
 * Turning a floor grant into a prompt.
 *
 * The important part of this file is the block that renders `justifiedBy`. The
 * coordinator has already decided why this agent is speaking; putting that
 * reason in front of the model is what keeps the words coming out of the
 * speaker matched to the reason shown on screen. Lose that and the panel is
 * three chatbots taking turns.
 */

import type { GenerationInput } from '@/agents'
import { buildSystemPrompt } from '@/agents/personas'
import { formatTimestamp } from '@/core/transcript'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** How much conversation the model sees. Enough for context, short enough to stay cheap. */
export const TRANSCRIPT_WINDOW = 6

export function buildMessages(input: GenerationInput): ChatMessage[] {
  const { brief, justifiedBy, transcript } = input

  const claims = brief.claims.length
    ? brief.claims.map((c) => `- ${c.competency}: ${c.text}`).join('\n')
    : '- nothing claimed yet'

  const recent = transcript
    .slice(-TRANSCRIPT_WINDOW)
    .map((e) => `[${formatTimestamp(e.tStart)}] ${e.speaker}: ${e.text}`)
    .join('\n')

  const lastCandidate = [...transcript].reverse().find((e) => e.speaker === 'candidate')

  const reason = justifiedBy.length
    ? justifiedBy
        .map((flag) => {
          const evidence = flag.evidence
            .map((e) => `    at ${formatTimestamp(e.t)} they said "${e.quote}"`)
            .join('\n')
          return `- ${flag.kind}\n${evidence}`
        })
        .join('\n')
    : '- nothing was flagged. Answer what they just said: take up its substance and press the weakest part of it. If it is off-topic or evasive, say so plainly and steer them back to the work.'

  return [
    { role: 'system', content: buildSystemPrompt(input.agent) },
    {
      role: 'user',
      content: [
        'SHARED BRIEF — what the panel already knows.',
        claims,
        `Difficulty: ${brief.difficulty}`,
        '',
        'RECENT CONVERSATION',
        recent,
        '',
        // Anchored on its own line. Buried in the transcript block, an off-script
        // answer got ignored and the model fell back to generic competency
        // questions about nothing the candidate had said.
        'THEY JUST SAID:',
        lastCandidate ? `"${lastCandidate.text}"` : '(nothing yet)',
        '',
        'YOU HAVE THE FLOOR BECAUSE:',
        reason,
        '',
        'Ask your one question now. Speak only the question.',
      ].join('\n'),
    },
  ]
}
