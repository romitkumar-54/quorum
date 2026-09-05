/**
 * LANE A — The Agora seam
 *
 * Everything above this interface (coordinator, brief, UI) is written against
 * `Transport` and never against Agora directly. Two implementations exist:
 *
 *   SimulatedTransport — runs today, no credentials. Models the Agora semantics
 *                        that actually matter to the coordinator: each agent
 *                        joins under its own agent ID, and `remoteRtcUids`
 *                        decides whose audio it hears.
 *   AgoraTransport     — the real thing. Wired, and inert until an App ID and
 *                        certificate are present.
 *
 * Swapping between them is a config change, not a rewrite. That is the whole
 * point of putting the interface here on day one.
 */

import type { AgentId, ChannelConfig } from '@/core/contracts'

/**
 * How one interviewer joins the channel. This mirrors the shape of Agora
 * Conversational AI's join call: an agent identity, a subscription list, and
 * the prompt that gives the agent its role.
 */
export interface AgentJoinSpec {
  agentId: AgentId
  /**
   * Whose audio this agent subscribes to. `'*'` means everyone — including the
   * other two agents, which is precisely why all three fire on one silence.
   */
  remoteRtcUids: '*' | string[]
  systemPrompt: string
}

export interface TransportStatus {
  connected: boolean
  /** Which implementation is live, shown in the UI so nothing is oversold. */
  implementation: 'simulated' | 'agora'
  channelName: string
  joinedAgents: AgentId[]
  /** Present when the transport is running without real credentials. */
  note?: string
}

export interface Transport {
  readonly name: string
  readonly implementation: 'simulated' | 'agora'
  status(): TransportStatus
  join(config: ChannelConfig, agents: AgentJoinSpec[]): Promise<TransportStatus>
  /** Put an agent's audio on the channel. Resolves when it finishes speaking. */
  speak(agent: AgentId, text: string): Promise<void>
  /** Stop whoever is speaking, immediately. This is barge-in, and the yield path. */
  interrupt(): Promise<void>
  leave(): Promise<void>
}
