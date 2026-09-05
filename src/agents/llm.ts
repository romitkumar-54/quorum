/**
 * The interviewers' lines, written by a model.
 *
 * It calls the app's own route rather than the provider directly, so the API
 * key never reaches the browser. Every failure path ends at
 * `ScriptedGenerator`: a dead key or a stalled model on stage degrades to the
 * deterministic panel rather than to silence, and the demo keeps running.
 */

import type { GenerationInput, QuestionGenerator } from '@/agents'
import { buildMessages } from '@/agents/prompt'

export interface LlmGeneratorOptions {
  fallback: QuestionGenerator
  timeoutMs?: number
  endpoint?: string
  fetchImpl?: typeof fetch
}

export class LlmGenerator implements QuestionGenerator {
  private readonly fallback: QuestionGenerator
  private readonly timeoutMs: number
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch

  constructor({
    fallback,
    timeoutMs = 4000,
    endpoint = '/api/interviewer',
    fetchImpl = fetch,
  }: LlmGeneratorOptions) {
    this.fallback = fallback
    this.timeoutMs = timeoutMs
    this.endpoint = endpoint
    this.fetchImpl = fetchImpl
  }

  async next(input: GenerationInput): Promise<string> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    // The budget is enforced here rather than left to the request. Aborting
    // asks the transport to stop; racing guarantees the panel moves on even if
    // it doesn't listen.
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('interviewer line timed out'))
      }, this.timeoutMs)
    })

    try {
      return await Promise.race([this.request(input, controller.signal), budget])
    } catch {
      // Deliberately silent. A visible error mid-interview is worse than a
      // slightly duller question, and the scripted line is always in character.
      return this.fallback.next(input)
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(input: GenerationInput, signal: AbortSignal): Promise<string> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: buildMessages(input) }),
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const body = (await res.json()) as { text?: string }
    const text = body.text?.trim()
    if (!text) throw new Error('the route returned no line')
    return text
  }
}
