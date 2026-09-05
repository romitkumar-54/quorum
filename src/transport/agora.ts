/**
 * The real transport.
 *
 * Agora Conversational AI runs the agents server-side: your backend calls the
 * Conversational AI REST API once per interviewer, each join carrying its own
 * agent identity and its own `remote_rtc_uids` subscription list, and the agents
 * appear in the RTC channel alongside the candidate. The browser joins the same
 * channel with the Web SDK and hears them.
 *
 *   POST /api/agent  { action: 'join' }   → server calls Agora, agents join
 *   POST /api/agent  { action: 'speak' }  → server pushes a line to one agent
 *   POST /api/agent  { action: 'interrupt' } → barge-in, stops current audio
 *
 * The route exists and is called on the same code path the simulated transport
 * uses. Without `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE` in the environment it
 * reports `configured: false`, and the app falls back to the simulated
 * transport rather than pretending.
 *
 * See docs/AGORA.md for the exact request shapes and what changes on the day the
 * credentials arrive.
 */

import type { AgentId, ChannelConfig } from '@/core/contracts'
import type {
  AgentJoinSpec,
  Transport,
  TransportStatus,
  TransportUtterance,
} from '@/transport/types'

export class AgoraTransport implements Transport {
  readonly name = 'Agora Conversational AI'
  readonly implementation = 'agora' as const
  /** Each agent carries an Agora-managed model. Granting the floor is a `think`. */
  readonly generatesOwnLines = true

  private joined: AgentId[] = []
  private channelName = ''
  private connected = false
  private lastError?: string

  status(): TransportStatus {
    return {
      connected: this.connected,
      implementation: 'agora',
      channelName: this.channelName,
      joinedAgents: this.joined,
      note: this.lastError,
    }
  }

  /** Is the server holding real credentials? Decides which transport the app uses. */
  static async isConfigured(): Promise<boolean> {
    try {
      const res = await fetch('/api/agent', { method: 'GET' })
      if (!res.ok) return false
      const body = (await res.json()) as { configured?: boolean }
      return body.configured === true
    } catch {
      return false
    }
  }

  async join(config: ChannelConfig, agents: AgentJoinSpec[]): Promise<TransportStatus> {
    this.channelName = config.channelName
    const body = await this.post({
      action: 'join',
      channelName: config.channelName,
      // The route derives each agent's subscription from the mode, because the
      // uid to subscribe to is an Agora detail and belongs on the server.
      mode: config.mode,
      agents: agents.map((a) => ({
        agentId: a.agentId,
        systemPrompt: a.systemPrompt,
      })),
    })

    this.connected = body.ok === true
    this.joined = this.connected ? agents.map((a) => a.agentId) : []
    if (!this.connected) this.lastError = body.error ?? 'Agora join failed.'
    return this.status()
  }

  /**
   * Grant the floor. The agent's own Agora-managed model writes the line, so
   * what we send is the candidate's answer, not a script.
   */
  async think(agent: AgentId, text: string): Promise<void> {
    await this.post({ action: 'think', channelName: this.channelName, agentId: agent, text })
  }

  async speak(agent: AgentId, text: string): Promise<void> {
    await this.post({ action: 'speak', channelName: this.channelName, agentId: agent, text })
  }

  async interrupt(): Promise<void> {
    await this.post({ action: 'interrupt', channelName: this.channelName })
  }

  async leave(): Promise<void> {
    await this.post({ action: 'leave', channelName: this.channelName })
    this.connected = false
    this.joined = []
  }

  /**
   * Read back what this agent said.
   *
   * In coordinated mode the line is written by the agent's own Agora-managed
   * model and spoken straight into the channel, so this process never sees it.
   * `GET .../history` is the only way the transcript can learn the words.
   *
   * Only `assistant` entries are ours to show. A `think`-driven turn also
   * writes a `user` entry -- the answer we injected -- and the candidate is
   * already in the transcript from their own microphone.
   */
  async history(agent: AgentId): Promise<TransportUtterance[]> {
    const body = await this.post({
      action: 'history',
      channelName: this.channelName,
      agentId: agent,
    })
    const contents = Array.isArray(body.contents) ? body.contents : []

    return contents
      .map(
        (entry) =>
          entry as { turn_id?: number; role?: string; content?: string; speech_start_ms?: number },
      )
      .filter((entry) => entry.role === 'assistant')
      .filter((entry) => typeof entry.content === 'string' && entry.content.trim() !== '')
      .map((entry) => ({
        turnId: Number(entry.turn_id ?? 0),
        text: String(entry.content).trim(),
        startMs: entry.speech_start_ms,
      }))
  }

  /**
   * What Agora says about this agent right now.
   *
   * An agent can be accepted, report RUNNING, and be dead a second later --
   * that is the failure mode the empty-token bug produced, and it is silent.
   */
  async agentState(agent: AgentId): Promise<string | null> {
    const body = (await this.post({
      action: 'state',
      channelName: this.channelName,
      agentId: agent,
    })) as { state?: string }
    return body.state ?? null
  }

  private async post(
    payload: unknown,
  ): Promise<{ ok?: boolean; error?: string; contents?: unknown[] }> {
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return (await res.json()) as { ok?: boolean; error?: string; contents?: unknown[] }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network error'
      this.lastError = message
      return { ok: false, error: message }
    }
  }
}
