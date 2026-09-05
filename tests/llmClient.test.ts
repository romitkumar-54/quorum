import { describe, expect, it, vi } from 'vitest'
import { requestCompletion } from '@/agents/llmClient'
import type { ChatMessage } from '@/agents/prompt'

const opts = { url: 'https://example.invalid/v1/chat/completions', apiKey: 'sk-secret', model: 'm' }
const messages: ChatMessage[] = [{ role: 'system', content: 'be brief' }]

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

describe('requesting one interviewer line', () => {
  it('returns the assistant content, trimmed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('  What does that cost you?  '))
    expect(await requestCompletion(messages, { ...opts, fetchImpl })).toBe('What does that cost you?')
  })

  it('sends the key as a bearer token and never in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('ok'))
    await requestCompletion(messages, { ...opts, fetchImpl })

    const [, init] = fetchImpl.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer sk-secret')
    expect(init.body).not.toContain('sk-secret')
  })

  it('throws when the provider returns an error status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 429 }))
    await expect(requestCompletion(messages, { ...opts, fetchImpl })).rejects.toThrow(/429/)
  })

  it('throws when the response carries no choices', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await expect(requestCompletion(messages, { ...opts, fetchImpl })).rejects.toThrow(/no completion/i)
  })
})
