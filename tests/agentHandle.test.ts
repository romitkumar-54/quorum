import { describe, it, expect, vi, afterEach } from 'vitest'
import { signAgents, verifyAgents } from '@/core/agentHandle'

afterEach(() => vi.useRealTimers())
describe('stateless interview ownership', () => {
  const agents = [{agentId: 'technical', instanceId: 'instance-1'}]
  it('recovers agents from a signed request with no process memory', () => {
    expect(verifyAgents('secret', 'interview-123', signAgents('secret', 'interview-123', agents))).toEqual(agents)
  })
  it('rejects a different channel, a different key, a modified handle and an expired handle', () => {
    const handle = signAgents('secret', 'interview-123', agents)
    expect(() => verifyAgents('secret', 'interview-other', handle)).toThrow()
    expect(() => verifyAgents('wrong', 'interview-123', handle)).toThrow()
    expect(() => verifyAgents('secret', 'interview-123', `x${handle}`)).toThrow()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 25 * 3600_000)
    expect(() => verifyAgents('secret', 'interview-123', handle)).toThrow(/expired/)
  })
})
