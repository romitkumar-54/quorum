/** Opt-in integration test: creates three billable agents and always leaves. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_IDS, type AgentId } from '@/core/contracts'
import { buildSystemPrompt } from '@/agents/personas'
import { InterviewSession } from '@/core/session'
import { AgoraTransport } from '@/transport/agora'

afterEach(() => vi.unstubAllGlobals())

describe.skipIf(process.env.QUORUM_LIVE_TEST !== '1')('live Agora interview', () => {
  it('generates contextual questions across agents and redirects a detour', async () => {
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => nativeFetch(typeof url === 'string' && url.startsWith('/') ? `http://127.0.0.1:3000${url}` : url, init))
    const transport = new AgoraTransport()
    const channel = `interview-regression-${Date.now()}`
    let cleanup = false
    try {
      const status = await transport.join({channelName: channel, mode: 'coordinated', remoteRtcUids: ['1099']}, AGENT_IDS.map(agentId => ({agentId, remoteRtcUids: ['1099'], systemPrompt: buildSystemPrompt(agentId)})))
      expect(status.connected, status.note).toBe(true)
      let turn = 0
      const order: AgentId[] = ['technical', 'product', 'technical', 'behavioural']
      const notices: string[] = []
      const session = new InterviewSession({transport, speechDuration: () => 0, lineTimeoutMs: 30_000, linePollMs: 600,
        onNotice: message => notices.push(message), floor: {async pick() {return {agent: order[turn++], reason: 'Explore the latest answer within your own competency.'}}}})
      const answers = [
        'I built a Redis cache for our checkout service. Reads used a 30-second expiry, and price changes explicitly invalidated affected keys. We measured p95 latency falling from 400ms to 90ms.',
        'We checked cache consistency with integration tests covering a price change during an in-flight read. The customer experiment showed checkout completion rising from 60 percent to 65 percent, compared with a control group that stayed at 60 percent.',
        'The completion rate came from randomly assigned checkout sessions. We kept pricing and marketing identical across groups. For the cache, our remaining concern was simultaneous invalidation and writes.',
        'Tell me a joke about pizza.',
      ]
      const questions: string[] = []
      for (const answer of answers) {
        const step = await session.candidateSays(answer)
        expect(step.utterances).toHaveLength(1)
        const text = step.utterances[0].text
        questions.push(text)
        console.log(JSON.stringify({speaker: step.utterances[0].speaker, question: text}))
        // No media participant in this control-plane test: allow speech to finish.
        await new Promise(resolve => setTimeout(resolve, Math.min(12_000, text.split(/\s+/).length * 350 + 1000)))
      }
      expect(notices).toEqual([])
      expect(new Set(questions.slice(0, 3)).size).toBe(3)
      expect(questions[3]).toContain('away from the interview')
      expect(session.brief.current().flags.some(f => f.kind === 'off_topic' && f.addressed)).toBe(true)
    } finally {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await transport.leave(); cleanup = true; break } catch { /* retry cleanup */ }
      }
      console.log(JSON.stringify({channel, cleanupConfirmed: cleanup}))
      expect(cleanup).toBe(true)
    }
  }, 180_000)
})
