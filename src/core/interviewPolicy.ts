import { COMPETENCIES, type Brief } from '@/core/contracts'

export const INTERVIEW_LIMITS = {
  answerSilenceMs: 2000,
  targetAnswers: 9,
  maxAnswers: 12,
  minAnswersPerArea: 2,
  maxDurationMs: 15 * 60_000,
  inactivityMs: 2 * 60_000,
} as const

export type EndReason = 'coverage' | 'answer_limit' | 'time_limit' | 'inactivity' | 'candidate'

export const END_MESSAGES: Record<EndReason, string> = {
  coverage: 'The panel has enough answers across all three areas. Your interview is complete.',
  answer_limit: 'The 12-answer limit has been reached. Your review uses the answers captured so far.',
  time_limit: 'The 15-minute interview limit has been reached. Your review uses the answers captured so far.',
  inactivity: 'The interview ended after two minutes without an answer. Your review uses the answers captured so far.',
  candidate: 'You ended the interview. Your review uses the answers captured so far.',
}

export function coverage(brief: Brief): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(COMPETENCIES.map(c => [c, 0]))
  const seen = new Set<string>()
  for (const answer of brief.answers ?? []) {
    const normalized = answer.event.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    if (answer.disposition !== 'answer' || !answer.competency || seen.has(normalized)) continue
    seen.add(normalized)
    counts[answer.competency]++
  }
  return counts
}

export function completionReason(brief: Brief, elapsedMs = 0): EndReason | null {
  if (elapsedMs >= INTERVIEW_LIMITS.maxDurationMs) return 'time_limit'
  if (brief.turn >= INTERVIEW_LIMITS.maxAnswers) return 'answer_limit'
  const counts = coverage(brief)
  if (brief.turn >= INTERVIEW_LIMITS.targetAnswers && COMPETENCIES.every(c => counts[c] >= INTERVIEW_LIMITS.minAnswersPerArea)) return 'coverage'
  return null
}
