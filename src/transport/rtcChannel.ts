/**
 * The candidate's side of the channel.
 *
 * Everything else in `src/transport` is the *control plane* -- our server
 * telling Agora to create, steer and stop agents. This is the *media plane*:
 * the browser joining the same RTC channel as a participant, publishing a
 * microphone, and hearing the interviewers.
 *
 *   server  --REST-->  Agora  --creates-->  3 agents in channel "interview-01"
 *   browser --RTC--->  Agora  --joins---->  same channel, uid 1000
 *
 * The two planes never talk to each other. They meet in the channel, which is
 * the whole reason a channel exists.
 *
 * The SDK is imported dynamically because it reaches for `window` at module
 * scope and this app renders on the server first.
 */

import type {
  IAgoraRTCClient,
  IAgoraRTCRemoteUser,
  IMicrophoneAudioTrack,
} from 'agora-rtc-sdk-ng'

/** The candidate's RTC identity. Agents are 1001 upward. */
export const CANDIDATE_RTC_UID = 1000

export interface RtcChannelHandlers {
  /** An interviewer started or stopped publishing audio. Drives the tally lamps. */
  onAgentAudio?: (uid: number, speaking: boolean) => void
  /** Connection state, so the UI can stop claiming to be live when it is not. */
  onConnection?: (state: string) => void
  onError?: (message: string) => void
}

interface TokenGrant {
  ok: boolean
  appId: string
  channel: string
  uid: number
  token: string
  error?: string
}

/**
 * Joining is a two-step handshake and both halves matter:
 *
 *   1. ask our own server for a token -- it holds the App Certificate and we
 *      never do
 *   2. hand that token to Agora
 *
 * A token is bound to one channel and one uid, so the candidate's token cannot
 * be used to impersonate an interviewer.
 */
export class RtcChannel {
  private client: IAgoraRTCClient | null = null
  private mic: IMicrophoneAudioTrack | null = null
  private handlers: RtcChannelHandlers = {}
  private joinedChannel = ''
  private speaking = new Set<number>()

  /**
   * Joins and leaves run one at a time, in order.
   *
   * React StrictMode mounts an effect, tears it down and mounts it again. Left
   * unserialised, the second join starts while the first is still holding uid
   * 1000 and Agora rejects it with `UID_CONFLICT`. The same thing happens for
   * real if someone opens the interview in two tabs.
   *
   * A channel has exactly one candidate, so the uid is fixed and the queue --
   * not a random uid -- is the right fix.
   */
  private queue: Promise<unknown> = Promise.resolve()
  private claimed = false

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  get joined(): boolean {
    return this.client !== null && this.joinedChannel !== ''
  }

  get channelName(): string {
    return this.joinedChannel
  }

  /** Publication persists between sentences. Inspect actual audio energy. */
  async waitForSilence(uid: number, text: string): Promise<void> {
    const started = Date.now()
    let lastAudio = started
    let heardAudio = false
    const estimated = Math.max(2000, text.trim().split(/\s+/).length * 400)
    while (this.joined && Date.now() - started < Math.min(60_000, estimated + 15_000)) {
      const track = this.client?.remoteUsers.find(user => Number(user.uid) === uid)?.audioTrack
      if ((track?.getVolumeLevel() ?? 0) > 0.02) {
        lastAudio = Date.now()
        heardAudio = true
      }
      if (heardAudio && Date.now() - lastAudio > 1200) return
      if (!heardAudio && Date.now() - started > estimated + 1500) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /** Which interviewer uids are publishing audio right now. */
  get speakingUids(): number[] {
    return [...this.speaking]
  }

  join(channelName: string, handlers: RtcChannelHandlers = {}): Promise<boolean> {
    this.handlers = handlers
    // One candidate per channel. A second call is the StrictMode remount, not
    // a second person.
    if (this.claimed) return Promise.resolve(this.joined)
    this.claimed = true
    return this.enqueue(() => this.doJoin(channelName))
  }

  private async doJoin(channelName: string): Promise<boolean> {

    let grant: TokenGrant
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'token', channelName }),
        signal: AbortSignal.timeout(10_000),
      })
      grant = (await res.json()) as TokenGrant
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'could not reach the token route')
      this.claimed = false
      return false
    }

    if (!grant.ok || !grant.token) {
      // No credentials on the server. The app stays on the simulated path, and
      // the header keeps saying so rather than pretending.
      this.fail(grant.error ?? 'the server is not holding Agora credentials')
      this.claimed = false
      return false
    }

    try {
      const AgoraRTC = (await import('agora-rtc-sdk-ng')).default
      // Voice only. A video codec still has to be named; nothing publishes video.
      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' })
      this.client = client

      client.on('user-published', async (user, mediaType) => {
        if (mediaType !== 'audio') return
        try {
          await client.subscribe(user, mediaType)
        // An interviewer's voice. Play it: this is the panel being heard.
        user.audioTrack?.play()
        this.markSpeaking(user, true)
        } catch {
          this.fail('Could not play interviewer audio. Check your connection and restart the interview.')
        }
      })

      client.on('user-unpublished', (user, mediaType) => {
        if (mediaType !== 'audio') return
        this.markSpeaking(user, false)
      })

      client.on('user-left', (user) => this.markSpeaking(user, false))

      client.on('connection-state-change', (state) => {
        this.handlers.onConnection?.(state)
      })

      // A token is good for an hour and nothing renews it on its own, so a
      // long interview would simply drop. Agora gives 30 seconds' warning.
      client.on('token-privilege-will-expire', async () => {
        try {
          const res = await fetch('/api/agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'token', channelName: grant.channel }),
          })
          const next = (await res.json()) as TokenGrant
          if (next.ok && next.token) await client.renewToken(next.token)
          else this.fail('could not renew the channel token')
        } catch {
          this.fail('could not renew the channel token')
        }
      })

      await client.join(grant.appId, grant.channel, grant.token, grant.uid)

      // Publish the microphone. In coordinated mode the agents are deaf and
      // will not hear it -- transcription is the browser's job -- but the
      // candidate has to be a real participant for naive mode to collide
      // honestly, and for anyone reviewing the channel to see a real call.
      this.mic = await AgoraRTC.createMicrophoneAudioTrack()
      await client.publish([this.mic])

      this.joinedChannel = grant.channel
      return true
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'RTC join failed')
      // Already inside the queue -- unwind directly, or this deadlocks on itself.
      this.claimed = false
      await this.doLeave()
      return false
    }
  }

  /** Deafen the channel's view of the candidate while the panel speaks. */
  async setMicMuted(muted: boolean): Promise<void> {
    await this.mic?.setMuted(muted)
  }

  leave(): Promise<void> {
    this.claimed = false
    return this.enqueue(() => this.doLeave())
  }

  private async doLeave(): Promise<void> {
    try {
      if (this.mic) {
        this.mic.stop()
        this.mic.close()
        this.mic = null
      }
      await this.client?.leave()
    } catch {
      // Leaving twice, or leaving a client that never joined, is not an error
      // worth surfacing to a candidate mid-interview.
    } finally {
      this.client?.removeAllListeners()
      this.client = null
      this.joinedChannel = ''
      this.speaking.clear()
    }
  }

  private markSpeaking(user: IAgoraRTCRemoteUser, speaking: boolean): void {
    const uid = Number(user.uid)
    if (speaking) this.speaking.add(uid)
    else this.speaking.delete(uid)
    this.handlers.onAgentAudio?.(uid, speaking)
  }

  private fail(message: string): void {
    this.handlers.onError?.(message)
  }
}
