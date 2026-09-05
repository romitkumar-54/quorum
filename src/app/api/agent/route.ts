/**
 * The Agora Conversational AI control plane.
 *
 * Agora runs the interviewers server-side: one `join` per agent, each with its
 * own `agent_rtc_uid`. The coordinator's decisions map onto Agora's own
 * primitives, which is why this track needs Agora specifically:
 *
 *   coordinator grants the floor  -> POST .../agents/{id}/think     (agent writes its own line)
 *   coordinator speaks verbatim   -> POST .../agents/{id}/speak     priority: APPEND
 *   coordinator cuts in           -> POST .../agents/{id}/speak     priority: INTERRUPT
 *   the yielding agent stops      -> POST .../agents/{id}/interrupt
 *   session ends                  -> POST .../agents/{id}/leave
 *
 * Two things here are load-bearing, and both were wrong before 2026-09-05.
 *
 * 1. `remote_rtc_uids` takes ONE uid. Agora's API reference is explicit:
 *    "Currently, only one user ID is supported." There is no wildcard on this
 *    field -- the `["*"]` wildcard is documented for `tools`, a different
 *    field entirely. So the panel cannot be made to hear itself, and the
 *    original design could not have run. See docs/DECISIONS.md.
 *
 * 2. Every model is Agora-managed. `credential_mode: "managed"` means Agora
 *    supplies the ASR, LLM and TTS credentials and bills them inside the
 *    $0.10/min agent task. No OpenAI key, no TTS key, nothing external.
 *
 * Without credentials this route reports `configured: false` and the client
 * falls back to the simulated transport. It does not pretend to have joined.
 */

import { NextResponse } from 'next/server'
import { RtcRole, RtcTokenBuilder } from 'agora-token'

const AGORA_BASE = 'https://api.agora.io/api/conversational-ai-agent/v2/projects'

/** An hour is far longer than an interview and shorter than Agora's 24h cap. */
const TOKEN_TTL_SECONDS = 3600

/**
 * RTC identities. The candidate publishes audio; the agents are 1001 upward.
 *
 * SILENT_UID is a uid nobody ever joins as. An agent subscribed to it hears
 * nothing, so its own turn detection never fires and it never speaks unless the
 * coordinator tells it to. That is the deaf-agent model in one field.
 *
 * `remote_rtc_uids` is a required field, so "hears nobody" has to be spelled as
 * "hears someone who is not there".
 */
const CANDIDATE_UID = '1000'
const SILENT_UID = '1099'

interface AgoraEnv {
  appId: string
  appCertificate: string
  customerId: string
  customerSecret: string
}

function readEnv(): AgoraEnv | null {
  const appId = process.env.AGORA_APP_ID
  const appCertificate = process.env.AGORA_APP_CERTIFICATE
  const customerId = process.env.AGORA_CUSTOMER_ID
  const customerSecret = process.env.AGORA_CUSTOMER_SECRET
  if (!appId || !appCertificate || !customerId || !customerSecret) return null
  return { appId, appCertificate, customerId, customerSecret }
}

function authHeader(env: AgoraEnv): string {
  return `Basic ${Buffer.from(`${env.customerId}:${env.customerSecret}`).toString('base64')}`
}

/**
 * One token per participant, signed here and never anywhere else.
 *
 * A token is bound to a channel AND a uid, so the agents cannot share one and
 * the candidate cannot use an agent's. This is also the thing whose absence
 * killed every agent before the certificate arrived: with a certificate on the
 * project, an empty token gets the join accepted and then the agent dies about
 * a second later with "RTC connection error".
 *
 * The certificate never leaves the server. Only the minted token does.
 */
function mintToken(env: AgoraEnv, channel: string, uid: number): string {
  const expires = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  return RtcTokenBuilder.buildTokenWithUid(
    env.appId,
    env.appCertificate,
    channel,
    uid,
    RtcRole.PUBLISHER,
    expires,
    expires,
  )
}

/** Agent instance ids returned by `join`, keyed by our own agent id. */
const liveAgents = new Map<string, string>()

export async function GET() {
  const env = readEnv()
  return NextResponse.json({
    configured: env !== null,
    // Never leak the secret; the UI only needs to know whether it exists.
    appIdPresent: Boolean(process.env.AGORA_APP_ID),
    // Every model is Agora-managed, so a configured transport is a configured brain.
    llmConfigured: env !== null,
    note: env
      ? 'Agora Conversational AI credentials present. All models Agora-managed.'
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
      case 'token':
        return NextResponse.json(candidateToken(env, body))
      case 'join':
        return NextResponse.json(await join(env, body))
      case 'think':
        return NextResponse.json(await think(env, body))
      case 'history':
        return NextResponse.json(await history(env, body))
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

// ---------------------------------------------------------------------------

/**
 * The candidate's own token, so the browser can join the channel and be heard.
 *
 * The browser gets a token and nothing else -- never the App Certificate, and
 * never the customer secret.
 */
function candidateToken(env: AgoraEnv, body: Record<string, unknown>) {
  const channel = String(body.channelName ?? 'interview-01')
  const uid = Number(CANDIDATE_UID)
  return {
    ok: true,
    appId: env.appId,
    channel,
    uid,
    token: mintToken(env, channel, uid),
    expiresInSeconds: TOKEN_TTL_SECONDS,
  }
}

/**
 * What this agent has actually said.
 *
 * In coordinated mode the words are written inside Agora, so this is the only
 * way our transcript learns them. Each entry carries a `turn_id` and a
 * `role`, and a `think` injection is marked `metadata.start_type: "api_think"`
 * -- which is how we tell a coordinator-driven turn from a self-triggered one.
 */
async function history(env: AgoraEnv, body: Record<string, unknown>) {
  const instanceId = liveAgents.get(String(body.agentId))
  if (!instanceId) return { ok: false, error: `Agent ${body.agentId} has not joined.` }

  const res = await fetch(`${AGORA_BASE}/${env.appId}/agents/${instanceId}/history`, {
    method: 'GET',
    headers: { Authorization: authHeader(env) },
  })

  const json = (await res.json()) as { contents?: unknown[] }
  return { ok: res.ok, contents: json.contents ?? [] }
}

interface JoinAgent {
  agentId: string
  systemPrompt: string
}

/**
 * One join per interviewer, each with its own identity, voice and role prompt.
 *
 * Two channel modes, and both are legal Agora configurations:
 *
 *   coordinated - every agent subscribes to SILENT_UID, hears nothing, and
 *                 never self-triggers. The coordinator picks one and sends it a
 *                 `think`. Exactly one voice per turn, by construction.
 *   naive       - every agent subscribes to the candidate, so all three detect
 *                 the same end-of-speech and all three answer. This is the
 *                 control condition, and it is a real Agora config rather than
 *                 a simulation of one.
 *
 * `idle_timeout: 0` matters in coordinated mode. Agora exits an agent once the
 * users in `remote_rtc_uids` have left, and SILENT_UID never arrives -- so any
 * non-zero timeout would quietly kill the whole panel mid-interview.
 */
async function join(env: AgoraEnv, body: Record<string, unknown>) {
  const channel = String(body.channelName ?? 'interview-01')
  const naive = body.mode === 'naive'
  const agents = (body.agents ?? []) as JoinAgent[]
  const results: { agentId: string; instanceId?: string; error?: string }[] = []

  for (const [index, agent] of agents.entries()) {
    const uid = 1001 + index

    const payload = {
      name: `quorum-${channel}-${agent.agentId}-${Date.now()}`,
      properties: {
        channel,
        // Signed for this channel and this uid, right now. Verified 2026-09-05:
        // with an empty token the join is accepted, the agent reports RUNNING,
        // and then dies about a second later with "RTC connection error".
        token: mintToken(env, channel, uid),
        agent_rtc_uid: String(uid),
        enable_string_uid: false,
        remote_rtc_uids: naive ? [CANDIDATE_UID] : [SILENT_UID],
        idle_timeout: naive ? 120 : 0,

        // Agora-managed ASR. No key. en-IN rather than en-US: the candidates
        // are Indian, and Agora lists en-IN for real-time transcription.
        //
        // Deepgram, not ARES, and that is not a preference. ARES is on Agora's
        // managed-vendor list but this account rejects it at join:
        //   "vendor 'ares' is not available for the current SKU when
        //    credential_mode is 'managed'"
        // Deepgram nova-3 was accepted on the same request. Verified 2026-09-05.
        asr: {
          credential_mode: 'managed',
          vendor: 'deepgram',
          language: 'en-IN',
          params: {
            url: 'wss://api.deepgram.com/v1/listen',
            model: 'nova-3',
            language: 'en-IN',
          },
        },

        // Agora-managed LLM. This is the agent's own brain, and the only LLM in
        // the system. In coordinated mode it fires when the coordinator sends
        // `think`; in naive mode it fires on the candidate's silence.
        llm: {
          credential_mode: 'managed',
          vendor: 'openai',
          style: 'openai',
          url: 'https://api.openai.com/v1/chat/completions',
          params: { model: 'gpt-4.1-mini' },
          system_messages: [{ role: 'system', content: agent.systemPrompt }],
          failure_message: 'Let me come back to that in a moment.',
          max_history: 32,
        },

        // Agora-managed TTS. Three roles, three voices, no key.
        tts: ttsFor(agent.agentId),

        turn_detection: {
          mode: 'default',
          config: {
            speech_threshold: 0.5,
            // The coordinator's silence threshold and this value are one knob.
            end_of_speech: { mode: 'vad', vad_config: { silence_duration_ms: 600 } },
          },
        },
      },
    }

    const res = await fetch(`${AGORA_BASE}/${env.appId}/join`, {
      method: 'POST',
      headers: { Authorization: authHeader(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const json = (await res.json()) as { agent_id?: string; message?: string; detail?: string }
    if (res.ok && json.agent_id) {
      liveAgents.set(agent.agentId, json.agent_id)
      results.push({ agentId: agent.agentId, instanceId: json.agent_id })
    } else {
      results.push({
        agentId: agent.agentId,
        error: json.detail ?? json.message ?? `HTTP ${res.status}`,
      })
    }
  }

  const failed = results.filter((r) => r.error)
  return { ok: failed.length === 0, agents: results, error: failed[0]?.error }
}

/**
 * The floor was granted -- hand this agent the candidate's answer and let its
 * own model write the reply.
 *
 * This is the seam the whole design turns on. `think` injects text into one
 * agent's pipeline as if the candidate had said it, so the words come out of
 * Agora's managed LLM -- dynamic, free, in character -- while the decision of
 * *who* was asked stays in our code, deterministic and provable. LLM and code,
 * with neither one guessing at the other's job.
 *
 * `on_speaking_action: 'ignore'` is the politeness rule in one field: if this
 * agent is somehow already talking, do not let it talk over itself.
 */
async function think(env: AgoraEnv, body: Record<string, unknown>) {
  const instanceId = liveAgents.get(String(body.agentId))
  if (!instanceId) return { ok: false, error: `Agent ${body.agentId} has not joined.` }

  const res = await fetch(`${AGORA_BASE}/${env.appId}/agents/${instanceId}/think`, {
    method: 'POST',
    headers: { Authorization: authHeader(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: String(body.text ?? ''),
      on_listening_action: 'interrupt',
      on_thinking_action: 'interrupt',
      on_speaking_action: 'ignore',
      // The candidate can always cut in. That is requirement 1, and it is free.
      interruptable: true,
    }),
  })

  return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` }
}

/**
 * Say this exact line. Used by the rehearsed demo, where the words must be
 * identical on every run, and by any scripted fallback.
 *
 * `priority: 'APPEND'` waits its turn; `'INTERRUPT'` cuts in, which is the
 * interrupt path. Agora caps the text at 512 bytes.
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

/** The yield path -- stop the agent that was told to stand down. */
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

/**
 * Leave, always. Every joined agent bills $0.10/min for as long as it sits in
 * the channel, and the free allowance is 300 minutes across the whole account.
 */
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

/**
 * Three roles, three voices. The panel must not sound like one person.
 *
 * OpenAI `tts-1` is on Agora's managed list, so these cost nothing beyond the
 * agent task. `params.url` is required even in managed mode -- omitting it is
 * rejected at join with "required field is missing" -- which is why it is here
 * despite Agora holding the credentials.
 *
 * MiniMax also validates, but Agora documents exactly one MiniMax voice id, and
 * a panel needs three. OpenAI's voice set is public and stable.
 *
 * Verified at join 2026-09-05. Agora passes `voice` through to OpenAI without
 * validating it, so the voice names are the one thing still worth hearing once.
 */
function ttsFor(agentId: string) {
  const voices: Record<string, string> = {
    technical: 'onyx',
    product: 'nova',
    behavioural: 'shimmer',
  }
  return {
    credential_mode: 'managed',
    vendor: 'openai',
    params: {
      url: 'https://api.openai.com/v1/audio/speech',
      model: 'tts-1',
      voice: voices[agentId] ?? voices.technical,
    },
  }
}
