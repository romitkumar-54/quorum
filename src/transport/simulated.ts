/**
 * The transport that runs today.
 *
 * It is not a stub that prints to the console: it models the two Agora
 * behaviours the coordinator actually depends on, and it produces real audio
 * through the browser's speech synthesiser.
 *
 *   1. Each agent joins under its own agent ID.
 *   2. `remoteRtcUids` decides whose audio each agent subscribes to. With `'*'`
 *      every agent hears every other agent — and hears the candidate stop at
 *      the same instant — which is the condition that produces collisions.
 */

import type { AgentId, ChannelConfig } from '@/core/contracts'
import { PanelVoice } from '@/speech'
import type { AgentJoinSpec, Transport, TransportStatus } from '@/transport/types'

export class SimulatedTransport implements Transport {
  readonly name = 'Simulated RTC channel'
  readonly implementation = 'simulated' as const

  private voice = new PanelVoice()
  private joined: AgentJoinSpec[] = []
  private channelName = ''
  private connected = false

  status(): TransportStatus {
    return {
      connected: this.connected,
      implementation: 'simulated',
      channelName: this.channelName,
      joinedAgents: this.joined.map((a) => a.agentId),
      note: 'No Agora credentials present. Audio is local browser speech; channel semantics are modelled.',
    }
  }

  async join(config: ChannelConfig, agents: AgentJoinSpec[]): Promise<TransportStatus> {
    await this.voice.ready()
    this.channelName = config.channelName
    this.joined = agents
    this.connected = true
    return this.status()
  }

  /**
   * Which agents can hear `speaker`. The coordinator does not need this, but the
   * UI does: it is what makes "everyone hears everyone" visible on screen.
   */
  subscribersOf(speaker: AgentId | 'candidate'): AgentId[] {
    return this.joined
      .filter((a) => a.agentId !== speaker)
      .filter((a) => a.remoteRtcUids === '*' || a.remoteRtcUids.includes(speaker))
      .map((a) => a.agentId)
  }

  /** Which voice each interviewer was given. */
  voices(): Record<string, string> {
    return this.voice.assignments()
  }

  speak(agent: AgentId, text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.voice.supported) {
        // No synthesiser: hold the floor for roughly as long as the line would
        // take to say, so the timing of the demo still reads correctly.
        setTimeout(resolve, Math.min(6000, 400 + text.length * 45))
        return
      }
      this.voice.speak(agent, text, { onEnd: resolve })
    })
  }

  async interrupt(): Promise<void> {
    this.voice.cancel()
  }

  async leave(): Promise<void> {
    this.voice.cancel()
    this.joined = []
    this.connected = false
  }
}
