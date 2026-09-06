import { describe, expect, it } from 'vitest'
import { sanitizeAgoraSdp } from '@/transport/rtcSdp'

describe('Agora SDP compatibility', () => {
  it('removes Chromium private ICE options that Agora cannot parse', () => {
    const sdp = [
      'v=0',
      'a=ice-options:trickle goog-sped-v1',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      '',
    ].join('\r\n')

    expect(sanitizeAgoraSdp(sdp)).toBe([
      'v=0',
      'a=ice-options:trickle',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      '',
    ].join('\r\n'))
  })

  it('preserves standards-compliant ICE options and all other SDP', () => {
    const sdp = 'v=0\na=ice-options:trickle ice2 rtp+ecn\nm=audio 9 UDP/TLS/RTP/SAVPF 111\n'

    expect(sanitizeAgoraSdp(sdp)).toBe(sdp)
  })

  it('drops an ice-options line when it contains no valid option', () => {
    expect(sanitizeAgoraSdp('v=0\na=ice-options:goog-sped-v1\nm=audio 9\n')).toBe(
      'v=0\nm=audio 9\n',
    )
  })
})
