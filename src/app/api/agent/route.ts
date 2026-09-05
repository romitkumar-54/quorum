/**
 * The Agora Conversational AI control plane.
 *
 * Agora runs the interviewers server-side: one `join` per agent, each with its
 * own `agent_rtc_uid` and its own `remote_rtc_uids` subscription list. The
 * coordinator's decisions map straight onto Agora's own primitives, which is
 * the reason this track needs Agora specifically:
 *
 *   coordinator grants the floor   → POST …/agents/{id}/speak  priority: APPEND
 *   coordinator interrupts         → POST …/agents/{id}/speak  priority: INTERRUPT
 *   the yielding agent stops       → POST …/agents/{id}/interrupt
 *   session ends                   → POST …/agents/{id}/leave
 *
 * Without credentials this route reports `configured: false` and the client
 * falls back to the simulated transport. It does not pretend to have joined.
 */

import { NextResponse } from 'next/server'

const AGORA_BASE = 'https://api.agora.io/api/conversational-ai-agent/v2/projects'

interface AgoraEnv {
  appId: string
  customerId: string
  customerSecret: string
}

function readEnv(): AgoraEnv | null {
  const appId = process.env.AGORA_APP_ID
  const customerId = process.env.AGORA_CUSTOMER_ID
  const customerSecret = process.env.AGORA_CUSTOMER_SECRET
  if (!appId || !customerId || !customerSecret) return null
  return { appId, customerId, customerSecret }
}

function authHeader(env: AgoraEnv): string {
  return `Basic ${Buffer.from(`${env.customerId}:${env.customerSecret}`).toString('base64')}`
}

/** Agent instance ids returned by `join`, keyed by our own agent id. */
const liveAgents = new Map<string, string>()

export async function GET() {
  const env = readEnv()
  return NextResponse.json({
    configured: env !== null,
    // Never leak the secret; the UI only needs to know whether it exists.
    appIdPresent: Boolean(process.env.AGORA_APP_ID),
    llmConfigured: Boolean(process.env.LLM_API_KEY),
    note: env
      ? 'Agora Conversational AI credentials present.'
      : 'Set AGORA_APP_ID, AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET to switch the voice layer to Agora.',
  })
}

export async function POST(request: Request) {
  const env = readEnv()
  const body = (await request.json()) as Record<string, unknown>
  const action = body.action as string

  if (!env) {
    return NextResponse.json(
      { ok: false, error: 'Agora credentials not configured. Running on the simulated transport.' },
      { status: 200 },
    )
  }

  try {
    switch (action) {
      case 'join':
        return NextResponse.json(await join(env, body))
      case 'speak':
        return NextResponse.json(await speak(env, body))
      case 'interrupt':
        return NextResponse.json(await interrupt(env, body))
      case 'leave':
        return NextResponse.json(await leave(env))
      default:
        return NextResponse.json({ ok: false, error: `Unknown action "${action}".` }, { status: 400 })
    }
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Agora request failed.' },
      { status: 200 },
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────

interface JoinAgent {
  agentId: string
  remote_rtc_uids: '*' | string[]
  system_prompt: string
}

/**
 * One join per interviewer. Each gets a distinct `agent_rtc_uid`, a distinct
 * TTS voice, and a system prompt that is its role.
 *
 * `remote_rtc_uids` is the field this entire project turns on. Passing every
 * participant means each agent hears the other two as well as the candidate —
 * so all three detect the same end-of-speech and all three answer. The
 * coordinator is what makes that safe.
 */
async function join(env: AgoraEnv, body: Record<string, unknown>) {
  const channel = String(body.channelName ?? 'interview-01')
  const agents = (body.agents ?? []) as JoinAgent[]
  const results: { agentId: string; instanceId?: string; error?: string }[] = []

  for (const [index, agent] of agents.entries()) {
    const payload = {
      name: `quorum-${channel}-${agent.agentId}`,
      properties: {
        channel,
        token: process.env.AGORA_RTC_TOKEN ?? '',
        agent_rtc_uid: String(1001 + index),
        remote_rtc_uids: agent.remote_rtc_uids === '*' ? ['*'] : agent.remote_rtc_uids,
        idle_timeout: 120,
        // End-of-speech detection is what opens the floor. The coordinator's
        // silence threshold and this value are the same knob.
        turn_detection: {
          mode: 'default',
          config: {
            speech_threshold: 0.5,
            end_of_speech: { mode: 'vad', vad_config: { silence_duration_ms: 600 } },
          },
        },
        llm: {
          url: process.env.LLM_URL ?? 'https://api.openai.com/v1/chat/completions',
          api_key: process.env.LLM_API_KEY ?? '',
          system_messages: [{ role: 'system', content: agent.system_prompt }],
          max_history: 32,
          params: { model: process.env.LLM_MODEL ?? 'gpt-4o-mini' },
        },
        asr: { language: 'en-US' },
        tts: ttsFor(agent.agentId),
      },
    }

    const res = await fetch(`${AGORA_BASE}/${env.appId}/join`, {
      method: 'POST',
      headers: { Authorization: authHeader(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const json = (await res.json()) as { agent_id?: string; message?: string }
    if (res.ok && json.agent_id) {
      liveAgents.set(agent.agentId, json.agent_id)
      results.push({ agentId: agent.agentId, instanceId: json.agent_id })
    } else {
      results.push({ agentId: agent.agentId, error: json.message ?? `HTTP ${res.status}` })
    }
  }

  const failed = results.filter((r) => r.error)
  return { ok: failed.length === 0, agents: results, error: failed[0]?.error }
}

/**
 * The coordinator granted this agent the floor.
 *
 * `priority: 'APPEND'` waits its turn; `'INTERRUPT'` cuts in, which is exactly
 * the interrupt path. `interruptable: true` keeps the candidate able to barge in
 * over the panel at any time.
 */
async function speak(env: AgoraEnv, body: Record<string, unknown>) {
  const instanceId = liveAgents.get(String(body.agentId))
  if (!instanceId) return { ok: false, error: `Agent ${body.agentId} has not joined.` }

  const res = await fetch(`${AGORA_BASE}/${env.appId}/agents/${instanceId}/speak`, {
    method: 'POST',
    headers: { Authorization: authHeader(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: String(body.text ?? '').slice(0, 512),
      priority: body.priority === 'INTERRUPT' ? 'INTERRUPT' : 'APPEND',
      interruptable: true,
    }),
  })

  return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` }
}

/** The yield path — stop the agent that was told to stand down. */
async function interrupt(env: AgoraEnv, body: Record<string, unknown>) {
  const target = body.agentId ? [String(body.agentId)] : [...liveAgents.keys()]
  for (const id of target) {
    const instanceId = liveAgents.get(id)
    if (!instanceId) continue
    await fetch(`${AGORA_BASE}/${env.appId}/agents/${instanceId}/interrupt`, {
      method: 'POST',
      headers: { Authorization: authHeader(env), 'Content-Type': 'application/json' },
      body: '{}',
    })
  }
  return { ok: true }
}

async function leave(env: AgoraEnv) {
  for (const instanceId of liveAgents.values()) {
    await fetch(`${AGORA_BASE}/${env.appId}/agents/${instanceId}/leave`, {
      method: 'POST',
      headers: { Authorization: authHeader(env) },
    })
  }
  liveAgents.clear()
  return { ok: true }
}

/** Three roles, three voices. The panel must not sound like one person. */
function ttsFor(agentId: string) {
  const voices: Record<string, string> = {
    technical: 'en-US-AndrewMultilingualNeural',
    product: 'en-US-AvaMultilingualNeural',
    behavioural: 'en-GB-SoniaNeural',
  }
  return {
    vendor: 'microsoft',
    params: {
      key: process.env.TTS_KEY ?? '',
      region: process.env.TTS_REGION ?? 'eastus',
      voice_name: voices[agentId] ?? voices.technical,
    },
  }
}
