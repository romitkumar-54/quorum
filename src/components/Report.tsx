/**
 * The finish: a panel that does not agree with itself.
 *
 * Averaging three interviewers into one number is what every other system does,
 * and it throws away the most useful thing in the room. A split is reported as a
 * split, with the evidence that produced each side of it.
 */

import { AGENTS } from '@/core/contracts'
import { formatTimestamp } from '@/core/transcript'
import type { Assessment } from '@/core/brief'
import { REQUIREMENTS, type RequirementState, metCount } from '@/core/requirements'

export function Report({ assessment }: { assessment: Assessment }) {
  return (
    <section className="report">
      <div className="report-head">
        <h2>Panel assessment</h2>
        <span className="column-note">every row traced to a timestamp</span>
      </div>
      <p className="report-summary">{assessment.summary}</p>

      <div className="verdicts">
        {assessment.perAgent.map((verdict) => (
          <article key={verdict.agent} className="verdict">
            <div className="verdict-name">
              {AGENTS[verdict.agent].displayName}
              <span className="verdict-competency">{verdict.competency}</span>
            </div>
            <div className="verdict-score">{verdict.score}/5</div>
            <div className="verdict-text">{verdict.verdict}</div>

            {verdict.evidence.length > 0 && (
              <div className="verdict-evidence">
                {verdict.evidence.map((e, i) => (
                  <div key={`${e.eventId}-${i}`} className="evidence">
                    <span className="evidence-time">{formatTimestamp(e.t)}</span>
                    <span>“{e.quote}”</span>
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="final" data-split={assessment.split}>
        <div className="verdict-name">Final</div>
        <div className="verdict-score">{assessment.final}/5</div>
        <div className="verdict-text">
          {assessment.split ? (
            <span className="final-flag">
              Flagged: split panel, {assessment.spread} points apart. No single-agent system produces this row.
            </span>
          ) : (
            'The panel agreed.'
          )}
        </div>
      </div>
    </section>
  )
}

/** The eleven requirements, ticking as the session produces the evidence. */
export function Ledger({ state }: { state: RequirementState }) {
  return (
    <section className="report ledger">
      <div className="report-head">
        <h2>Requirements demonstrated</h2>
        <span className="column-note">
          {metCount(state)} of {REQUIREMENTS.length} shown in this session
        </span>
      </div>

      <div className="ledger-grid">
        {REQUIREMENTS.map((req) => {
          const met = req.met(state)
          return (
            <div key={req.n} className="req" data-met={met}>
              <span className="req-mark">{met ? '✓' : '·'}</span>
              <span>
                {req.text}
                <span style={{ color: 'var(--read-faint)' }}> · lane {req.lane}</span>
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
