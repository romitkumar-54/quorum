/**
 * One chat completion, in the OpenAI-compatible shape.
 *
 * `fetch` is a parameter so this is testable without a network, and so the
 * route can pass its own. Nothing here reads `process.env`: the caller owns
 * configuration, which is what keeps the API key confined to the route.
 */

import type { ChatMessage } from '@/agents/prompt'

export interface CompletionOptions {
  url: string
  apiKey: string
  model: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

interface CompletionResponse {
  choices?: { message?: { content?: string } }[]
}

export async function requestCompletion(
  messages: ChatMessage[],
  { url, apiKey, model, timeoutMs = 8000, fetchImpl = fetch }: CompletionOptions,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // Short and warm: an interviewer's question, not an essay.
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 120 }),
      signal: controller.signal,
    })

    if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`)

    const body = (await res.json()) as CompletionResponse
    const text = body.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('LLM returned no completion')
    return text
  } finally {
    clearTimeout(timer)
  }
}
