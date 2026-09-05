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
   * Whose audio this agent subscribes to — exactly one uid, which is all Agora
   * allows. The candidate's uid makes the agent fire on its own; SILENT_UID
   * makes it deaf, so it speaks only when the coordinator sends it a `think`.
   */
  remoteRtcUids: string[]
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

/**
 * One line an agent said, as the transport reports it back.
 *
 * Mirrors the fields Agora's `history` returns and nothing more, so this stays
 * a report of what happened rather than a second transcript format.
 */
export interface TransportUtterance {
  /** Agora's own turn counter for this agent. */
  turnId: number
  text: string
  /** ms, on the transport's clock rather than the session's. */
  startMs?: number
}

export interface Transport {
  readonly name: string
  readonly implementation: 'simulated' | 'agora'
  /**
   * Whether the agents write their own lines.
   *
   * True on Agora: each agent carries an Agora-managed model, so granting the
   * floor means handing it the candidate's answer and letting it reply. The
   * words never pass through our process, and the transcript comes back over
   * the channel.
   *
   * False in simulation: there is no model, so the caller composes the line
   * first and the transport only voices it.
   */
  readonly generatesOwnLines: boolean
  status(): TransportStatus
  join(config: ChannelConfig, agents: AgentJoinSpec[]): Promise<TransportStatus>
  /**
   * Grant the floor: hand one agent the candidate's answer and let its own model
   * write the reply. This is the dynamic path — the words are Agora's managed
   * LLM, the choice of who was asked is ours.
   *
   * Resolves when the agent has finished speaking.
   */
  think(agent: AgentId, text: string): Promise<void>
  /** Put an exact line on the channel. The scripted path. Resolves when done. */
  speak(agent: AgentId, text: string): Promise<void>
  /** Stop whoever is speaking, immediately. This is barge-in, and the yield path. */
  interrupt(): Promise<void>
  /**
   * What this agent has actually said, oldest first.
   *
   * Only meaningful when `generatesOwnLines` is true: there the words are
   * written inside the transport and never pass through this process, so the
   * transcript has to read them back rather than remember them. Absent on the
   * simulator, which already knows every line it was handed.
   */
  history?(agent: AgentId): Promise<TransportUtterance[]>
  /**
   * How this agent is doing, in the transport's own words, or null if the
   * transport has no notion of an agent failing. An agent that has died stops
   * being worth waiting for.
   */
  agentState?(agent: AgentId): Promise<string | null>
  leave(): Promise<void>
}
