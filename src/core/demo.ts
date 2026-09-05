/**
 * THE REHEARSED RUN
 *
 * The organisers' own example scenario, as candidate turns:
 *
 *   "A candidate provides a technically correct solution but does not explain
 *    its impact on customers. The technical interviewer may accept the
 *    implementation, while the product interviewer should challenge the
 *    candidate to explain the business implications."
 *
 * Turn 1 carries both halves of that sentence — a solid technical claim and an
 * impact claim with no number behind it. Technical takes the floor for the
 * first; Product cuts in over it for the second. Turns 2 and 3 are the same
 * rollout story told two different ways, which is the contradiction.
 *
 * Timestamps match the transcript in the strategy deck.
 */

export interface DemoTurn {
  /** ms from session start */
  at: number
  text: string
  /** What this turn is here to prove, shown in the demo runner. */
  beat: string
}

export const DEMO_TRANSCRIPT: DemoTurn[] = [
  {
    at: 41_000,
    text: 'I used a hash map, so lookups are O(1) instead of scanning the list. It made things a lot faster for users.',
    beat: 'Technically correct, impact unquantified. Technical accepts — Product cuts in.',
  },
  {
    at: 134_000,
    text: 'We shipped it to everyone on day one.',
    beat: 'A rollout claim, recorded in the brief.',
  },
  {
    at: 247_000,
    text: 'We rolled it out to 5% first, to be safe.',
    beat: 'Contradicts turn 2. Behavioural challenges it, with both timestamps.',
  },
]
