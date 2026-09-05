/**
 * The interviewers' brain, kept server-side.
 *
 * The browser posts assembled messages and gets one line back. `LLM_API_KEY` is
 * read here and nowhere else, so it never reaches a client component and never
 * appears in a bundle.
 *
 * Errors return 200 with an `error` field rather than a failure status: the
 * client falls back to the scripted panel either way, and a 500 in the console
 * during a live interview reads worse than it is.
 */

import { NextResponse } from 'next/server'
import { requestCompletion } from '@/agents/llmClient'
import type { ChatMessage } from '@/agents/prompt'

const url = () => process.env.LLM_URL ?? 'https://api.openai.com/v1/chat/completions'
const model = () => process.env.LLM_MODEL ?? 'gpt-4o-mini'

export async function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.LLM_API_KEY),
    model: model(),
    note: process.env.LLM_API_KEY
      ? 'Questions are written per candidate.'
      : 'No LLM_API_KEY. The deterministic panel is driving every question.',
  })
}

export async function POST(request: Request) {
  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'No LLM_API_KEY. Running on the scripted panel.' })
  }

  try {
    const { messages } = (await request.json()) as { messages: ChatMessage[] }
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'No messages in the request.' })
    }

    const text = await requestCompletion(messages, { url: url(), apiKey, model: model() })
    return NextResponse.json({ text })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'LLM request failed.',
    })
  }
}
