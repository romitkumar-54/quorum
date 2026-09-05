/**
 * The reading surfaces: what was said, what the panel concluded from it, and
 * what that cost in latency and collisions.
 */

import { AGENTS, type Brief, type FloorDecision, type TranscriptEvent } from '@/core/contracts'
import { formatTimestamp } from '@/core/transcript'
import type { Metrics } from '@/core/metrics'

// ─────────────────────────────────────────────────────────────────────────────

/** The reason the current speaker was allowed to speak. Always on screen. */
export function FloorStrip({ decision }: { decision: FloorDecision | null }) {
  if (!decision) {
    return (
      <div className="floor">
        <span className="floor-label">Floor</span>
        <span className="floor-reason" style={{ color: 'var(--read-faint)' }}>
          Idle. The candidate has the floor.
        </span>
      </div>
    )
  }

  return (
    <div className="floor" data-kind={decision.kind}>
      <span className="floor-label">
        {decision.kind === 'collision' ? 'Collision' : decision.kind === 'interrupt' ? 'Interrupt' : 'Floor'}
      </span>
      <span className="floor-reason">{decision.reason}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export function TranscriptFeed({
  events,
  yieldedIds,
}: {
  events: readonly TranscriptEvent[]
  /** Utterances that were cut off, straight from the coordinator's log. */
  yieldedIds: ReadonlySet<string>
}) {
  return (
    <section className="column">
      <div className="column-head">
        <h2 className="column-title">Transcript</h2>
        <span className="column-note">timestamped at capture</span>
      </div>

      {events.length === 0 ? (
        <p className="empty">Nothing said yet. Run the rehearsed interview, or answer in your own words.</p>
      ) : (
        events.map((event) => (
          <article key={event.id} className="turn" data-speaker={event.speaker}>
            <span className="turn-time">{formatTimestamp(event.tStart)}</span>
            <div>
              <div className="turn-who">
                {event.speaker === 'candidate' ? 'Candidate' : AGENTS[event.speaker].displayName}
                {yieldedIds.has(event.id) && <span className="turn-badge">yielded</span>}
              </div>
              <p className="turn-text">{event.text}</p>
            </div>
          </article>
        ))
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export function BriefPanel({ brief }: { brief: Brief }) {
  return (
    <section className="column">
      <div className="column-head">
        <h2 className="column-title">Shared brief</h2>
        <span className="column-note">read by all three before they speak</span>
      </div>

      <div className="brief-stats">
        <div className="stat">
          <div className="stat-label">Claims</div>
          <div className="stat-value">{brief.claims.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Open flags</div>
          <div className="stat-value">{brief.flags.filter((f) => !f.addressed).length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Difficulty</div>
          <div className="stat-value">
            {brief.difficulty}
            <span className="difficulty" aria-hidden>
              {[1, 2, 3, 4, 5].map((n) => (
                <i key={n} data-on={n <= brief.difficulty} />
              ))}
            </span>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Turns</div>
          <div className="stat-value">{brief.turn}</div>
        </div>
      </div>

      {brief.flags.length === 0 ? (
        <p className="empty">No claims challenged yet.</p>
      ) : (
        brief.flags.map((flag) => (
          <article key={flag.id} className="flag" data-addressed={flag.addressed}>
            <header className="flag-head">
              <span className="flag-kind">{flag.kind.replace(/_/g, ' ')}</span>
              <span className="flag-status">{flag.addressed ? 'challenged' : 'open'}</span>
            </header>
            <p className="flag-note">{flag.note}</p>
            {flag.evidence.map((e, i) => (
              <div key={`${e.eventId}-${i}`} className="evidence">
                <span className="evidence-time">{formatTimestamp(e.t)}</span>
                <span>“{e.quote}”</span>
              </div>
            ))}
          </article>
        ))
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

/** Voice quality as numbers. No hackathon voice demo is ever measured. */
export function Meters({ metrics }: { metrics: Metrics }) {
  return (
    <div className="meters">
      <div className="meter">
        <div className="meter-label">Turns run</div>
        <div className="meter-value">{metrics.turns}</div>
      </div>
      <div className="meter" data-alarm={metrics.collisions > 0}>
        <div className="meter-label">Collisions</div>
        <div className="meter-value">{metrics.collisions}</div>
      </div>
      <div className="meter" data-alarm={metrics.collisionRate > 0}>
        <div className="meter-label">Collision rate</div>
        <div className="meter-value">
          {metrics.turns === 0 ? '—' : `${Math.round(metrics.collisionRate * 100)}`}
          {metrics.turns > 0 && <span className="meter-unit">%</span>}
        </div>
      </div>
      <div className="meter">
        <div className="meter-label">Floor latency p50</div>
        <div className="meter-value">
          {metrics.latencySamples === 0 ? '—' : metrics.latencyP50}
          {metrics.latencySamples > 0 && <span className="meter-unit">ms</span>}
        </div>
      </div>
      <div className="meter">
        <div className="meter-label">False interrupts</div>
        <div className="meter-value">
          {metrics.interrupts === 0 ? '—' : `${Math.round(metrics.falseInterruptRate * 100)}`}
          {metrics.interrupts > 0 && <span className="meter-unit">%</span>}
        </div>
      </div>
    </div>
  )
}
