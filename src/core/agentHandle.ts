import { createHmac, timingSafeEqual } from 'node:crypto'

interface AgentHandle {
  channel: string
  agents: { agentId: string; instanceId: string }[]
  expires: number
}

/** Signed channel ownership travels with requests across serverless workers. */
export function signAgents(secret: string, channel: string, agents: AgentHandle['agents']): string {
  const payload = Buffer.from(JSON.stringify({ channel, agents, expires: Date.now() + 24 * 3600_000 })).toString('base64url')
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
}

export function verifyAgents(secret: string, channel: string, handle: unknown): AgentHandle['agents'] {
  if (typeof handle !== 'string' || handle.length > 8192) throw new Error('Interview session missing. Please start a new interview.')
  const parts = handle.split('.')
  if (parts.length !== 2) throw new Error('Invalid interview session.')
  const expected = createHmac('sha256', secret).update(parts[0]).digest()
  const actual = Buffer.from(parts[1], 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid interview session.')
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as AgentHandle
  if (payload.channel !== channel || payload.expires < Date.now()) throw new Error('Interview session expired or belongs to another channel.')
  return payload.agents
}
