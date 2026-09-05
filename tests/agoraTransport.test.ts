/**
 * `AgoraTransport` is a thin client over `/api/agent`, and the one place it
 * does real work is reading history back.
 *
 * In coordinated mode the agent's line is written inside Agora and spoken
 * straight into the channel, so this mapping is the only thing standing between
 * the transcript and an empty screen. A `think` turn also writes back the
 * answer we injected as a `user` entry — showing that as something an
 * interviewer said would be worse than showing nothing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgoraTransport } from '@/transport/agora'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Stand in for the route, and record what was asked of it. */
function route(payload: unknown) {
  const calls: Record<string, unknown>[] = []
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    if (init?.body) calls.push(JSON.parse(init.body) as Record<string, unknown>)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return calls
}

describe('reading back what an agent said', () => {
  it('keeps the assistant’s words and drops the answer we injected', async () => {
    route({
      ok: true,
      contents: [
        { turn_id: 1, role: 'user', content: 'I put Redis in front of checkout.' },
        { turn_id: 1, role: 'assistant', content: 'How do you invalidate that cache?' },
      ],
    })

    const said = await new AgoraTransport().history('technical')

    expect(said).toEqual([{ turnId: 1, text: 'How do you invalidate that cache?', startMs: undefined }])
  })

  it('drops entries with nothing in them, so a blank turn is not a blank line', async () => {
    route({
      ok: true,
      contents: [
        { turn_id: 1, role: 'assistant', content: '   ' },
        { turn_id: 2, role: 'assistant', content: 'Put a number on it.' },
      ],
    })

    const said = await new AgoraTransport().history('product')

    expect(said.map((u) => u.text)).toEqual(['Put a number on it.'])
  })

  it('carries the timestamp Agora reports, for evidence-linked feedback', async () => {
    route({
      ok: true,
      contents: [{ turn_id: 3, role: 'assistant', content: 'And then what?', speech_start_ms: 4200 }],
    })

    const said = await new AgoraTransport().history('behavioural')

    expect(said[0]).toEqual({ turnId: 3, text: 'And then what?', startMs: 4200 })
  })

  it('surfaces a failed history request rather than pretending the model is silent', async () => {
    route({ ok: false, error: 'Agent technical has not joined.' })

    await expect(new AgoraTransport().history('technical')).rejects.toThrow('has not joined')
  })
})

describe('the calls the coordinator’s decisions turn into', () => {
  it('keeps cleanup retryable if the service fails to release an agent', async () => {
    const transport = new AgoraTransport()
    route({ok: true, sessionHandle: 'signed-session'})
    await transport.join({channelName: 'interview-test', mode: 'coordinated', remoteRtcUids: ['1099']}, [{agentId: 'technical', remoteRtcUids: ['1099'], systemPrompt: 'test'}])
    route({ok: false, error: 'Could not close an interviewer'})
    await expect(transport.leave()).rejects.toThrow('Could not close')
    expect(transport.status().connected).toBe(true)
    expect(transport.leavePayload().sessionHandle).toBe('signed-session')
    route({ok: true})
    await transport.leave()
    expect(transport.status().connected).toBe(false)
  })
  it('surfaces refused speech instead of claiming it was spoken', async () => {
    route({ok: false, error: 'Agent has stopped'})
    await expect(new AgoraTransport().speak('technical', 'A question')).rejects.toThrow('Agent has stopped')
  })

  it('carries the signed session in subsequent requests and unload cleanup', async () => {
    const calls = route({ok: true, sessionHandle: 'signed-session'})
    const transport = new AgoraTransport()
    await transport.join({channelName: 'interview-test', mode: 'coordinated', remoteRtcUids: ['1099']}, [])
    await transport.think('technical', 'My answer')
    expect(calls.at(-1)).toMatchObject({sessionHandle: 'signed-session'})
    expect(transport.leavePayload()).toMatchObject({sessionHandle: 'signed-session', action: 'leave'})
  })
  it('grants the floor with think, carrying the candidate’s own words', async () => {
    const calls = route({ ok: true })

    await new AgoraTransport().think('technical', 'I used a hash map.')

    expect(calls[0]).toMatchObject({ action: 'think', agentId: 'technical', text: 'I used a hash map.' })
  })

  it('forgets its agents on leave, so a finished interview cannot be spoken to', async () => {
    route({ ok: true })
    const transport = new AgoraTransport()

    await transport.leave()

    expect(transport.status().connected).toBe(false)
    expect(transport.status().joinedAgents).toEqual([])
  })
})
