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
  maxTokens?: number
  /** Provider-specific. Sent only when set, because not every provider accepts it. */
  reasoningEffort?: string
  fetchImpl?: typeof fetch
}

/**
 * Generous for a two-sentence question, and deliberately so.
 *
 * Reasoning models bill their hidden thinking against this budget: gpt-oss-20b
 * spent 118 of a 120-token cap on reasoning and returned an empty string, which
 * the generator would have quietly turned into a scripted line while the header
 * claimed the model was driving. The budget has to cover the thinking too.
 */
const DEFAULT_MAX_TOKENS = 600

interface CompletionResponse {
  choices?: { message?: { content?: string } }[]
}

export async function requestCompletion(
  messages: ChatMessage[],
  {
    url,
    apiKey,
    model,
    timeoutMs = 8000,
    maxTokens = DEFAULT_MAX_TOKENS,
    reasoningEffort,
    fetchImpl = fetch,
  }: CompletionOptions,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
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
