import type { CSSProperties } from 'react'

type IconName = 'mic' | 'muted' | 'shield' | 'signal' | 'reset' | 'technical' | 'product' | 'behavioural' | 'clock' | 'focus' | 'arrow' | 'spark'

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    muted: <><path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v5M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8" /></>,
    shield: <><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z" /><path d="m8 12 3 3 5-6" /></>,
    signal: <path d="M4 20v-5M9 20V9M14 20V5M19 20V2" />,
    reset: <><path d="M3 9a9 9 0 1 1 1 9M3 3v6h6" /></>,
    technical: <><path d="m12 2 10 5v10l-10 5-10-5V7ZM2 7l10 5 10-5M12 12v10" /></>,
    product: <><path d="M10 3a9 9 0 1 0 11 11H10Z" /><path d="M14 2v8h8a9 9 0 0 0-8-8Z" /></>,
    behavioural: <><circle cx="12" cy="7" r="3" /><path d="M6 22v-3a6 6 0 0 1 12 0v3M5 4a3 3 0 0 0 0 6M19 4a3 3 0 0 1 0 6M2 18v-2a4 4 0 0 1 4-4M22 18v-2a4 4 0 0 0-4-4" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 3" /></>,
    focus: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><path d="m12 12 9-9M16 3h5v5" /></>,
    arrow: <path d="m5 9 7 7 7-7" />,
    spark: <><path d="m12 3 2 6 6 3-6 2-2 7-2-7-7-2 7-3Z" /><path d="M20 2v4M18 4h4" /></>,
  }
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

export function QuorumMark() {
  return <svg className="quorum-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    {Array.from({ length: 6 }, (_, i) => <ellipse key={i} cx="24" cy="24" rx="15" ry="20" stroke="currentColor" strokeWidth=".7" transform={`rotate(${i * 30} 24 24)`} />)}
  </svg>
}

/** A state animation, not an audio level meter. Only moves while the room is active. */
export function VoiceOrbit({ active, muted, label }: { active: boolean; muted: boolean; label: string }) {
  return <div className="voice-orbit" data-active={active} data-muted={muted}>
    <svg className="orbit-lines" viewBox="0 0 500 500" fill="none" aria-hidden="true">
      {[210, 237].map(r => <circle key={r} cx="250" cy="250" r={r} stroke="currentColor" strokeDasharray="1 7" opacity=".16" />)}
      {Array.from({ length: 22 }, (_, ring) => {
        const points = Array.from({ length: 241 }, (_, i) => {
          const a = i / 240 * Math.PI * 2
          const r = 151 + ring * 1.55 + Math.sin(a * 7 + ring * .16) * (7 + ring * .25) + Math.cos(a * 3 - ring * .12) * 9
          return `${i === 0 ? 'M' : 'L'}${(250 + Math.cos(a) * r).toFixed(2)},${(250 + Math.sin(a) * r).toFixed(2)}`
        }).join(' ')
        return <path key={ring} d={`${points}Z`} stroke={ring % 6 === 0 ? '#c8b477' : 'currentColor'} strokeWidth=".65" opacity={.18 + ring % 5 * .065} />
      })}
    </svg>
    <div className="orbit-core"><Icon name={muted ? 'muted' : 'mic'} /></div>
    <span className="orbit-caption">{label}</span>
  </div>
}

export function VoiceBars() {
  return <div className="voice-bars" aria-hidden="true">{Array.from({ length: 29 }, (_, i) => <i key={i} style={{ height: `${4 + ((i * 7 + 3) % 17)}px`, '--bar-delay': `${i * -.09}s` } as CSSProperties} />)}</div>
}
