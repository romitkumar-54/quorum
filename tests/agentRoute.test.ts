import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signAgents } from '@/core/agentHandle'

const tokenBuilder = vi.hoisted(() => vi.fn(() => 'test-token'))
vi.mock('agora-token', () => ({ RtcRole: { PUBLISHER: 1 }, RtcTokenBuilder: { buildTokenWithUid: tokenBuilder } }))

const certificate = 'b'.repeat(32)
const channel = 'interview-regression'
const owned = [{agentId: 'technical', instanceId: 'remote-instance'}]
const request = (body: unknown) => new Request('http://localhost/api/agent', {method: 'POST', body: JSON.stringify(body)})

beforeEach(() => {
  vi.stubEnv('AGORA_APP_ID', 'a'.repeat(32))
  vi.stubEnv('AGORA_APP_CERTIFICATE', certificate)
  vi.stubEnv('AGORA_CUSTOMER_ID', 'c'.repeat(32))
  vi.stubEnv('AGORA_CUSTOMER_SECRET', 'd'.repeat(32))
  tokenBuilder.mockClear()
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('deployed route regressions, exercised locally', () => {
  it('seats the managed panel using Agora’s supported VAD range', async () => {
    const payloads: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/join')) {
        payloads.push(JSON.parse(String(init?.body)))
        return Response.json({agent_id: `remote-${payloads.length}`})
      }
      return Response.json({list: []})
    })
    vi.stubGlobal('fetch', fetchMock)
    const {POST} = await import('@/app/api/agent/route')
    const response = await POST(request({action: 'join', channelName: channel, mode: 'coordinated', agents: ['technical', 'product', 'behavioural'].map(agentId => ({agentId, systemPrompt: 'Interview the candidate.'}))}))
    expect(await response.json()).toMatchObject({ok: true})
    expect(payloads).toHaveLength(3)
    for (const payload of payloads) expect(payload).toMatchObject({properties: {
      remote_rtc_uids: ['1099'],
      turn_detection: {config: {end_of_speech: {vad_config: {silence_duration_ms: 2000}}}},
      llm: {credential_mode: 'managed', params: {model: 'gpt-4.1-mini'}},
    }})
  })
  it('uses relative token expiry of one hour, not a Unix timestamp', async () => {
    const {POST} = await import('@/app/api/agent/route')
    await POST(request({action: 'token', channelName: channel}))
    expect(tokenBuilder.mock.calls[0].slice(-2)).toEqual([3600, 3600])
  })
  it('can retrieve history on a new server worker using the signed session', async () => {
    const sessionHandle = signAgents(certificate, channel, owned)
    vi.resetModules()
    const fetchMock = vi.fn(async (_url: string) => Response.json({contents: [{role: 'assistant', turn_id: 7, content: 'What was the trade-off?'}]}))
    vi.stubGlobal('fetch', fetchMock)
    const {POST} = await import('@/app/api/agent/route')
    const res = await POST(request({action: 'history', channelName: channel, agentId: 'technical', sessionHandle}))
    expect(await res.json()).toMatchObject({ok: true, contents: [{content: 'What was the trade-off?'}]})
    expect(fetchMock.mock.calls[0][0]).toContain('/agents/remote-instance/history')
  })
  it('does not send an upstream request for a forged session', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const {POST} = await import('@/app/api/agent/route')
    const res = await POST(request({action: 'think', channelName: channel, agentId: 'technical', sessionHandle: 'forged'}))
    expect(await res.json()).toMatchObject({ok: false})
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('returns a controlled error on malformed JSON', async () => {
    const {POST} = await import('@/app/api/agent/route')
    const res = await POST(new Request('http://localhost/api/agent', {method: 'POST', body: '{'}))
    expect(res.status).toBe(400)
  })
  it('closes every owned agent even if one leave request fails', async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes('bad') ? new Response('', {status: 500}) : Response.json({}))
    vi.stubGlobal('fetch', fetchMock)
    const {POST} = await import('@/app/api/agent/route')
    const sessionHandle = signAgents(certificate, channel, [...owned, {agentId: 'product', instanceId: 'bad'}])
    const res = await POST(request({action: 'leave', channelName: channel, sessionHandle}))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await res.json()).toMatchObject({ok: false})
  })
})
