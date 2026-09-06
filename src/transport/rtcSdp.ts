/**
 * Compatibility for browser SDP consumed by Agora's strict ICE parser.
 *
 * Chromium may advertise private ICE options such as `goog-sped-v1`. ICE
 * option tags are limited to ALPHA, DIGIT, "+", and "/" by RFC 6336, and
 * Agora RTC 4.24.8 correctly rejects the hyphens while parsing its initial
 * offer. Unfortunately that rejection aborts `client.join()` before Agora can
 * ignore the unknown option.
 *
 * Strip only invalid option tags from `a=ice-options` lines. Standard options
 * such as `trickle`, `ice2`, and `rtp+ecn` are left untouched, and every other
 * SDP line is returned byte-for-byte.
 */

const VALID_ICE_OPTION = /^[A-Za-z0-9+/]+$/

export function sanitizeAgoraSdp(sdp: string): string {
  return sdp.replace(/^a=ice-options:([^\r\n]*)(\r?\n|$)/gm, (line, value: string, ending: string) => {
    const options = value.trim().split(/\s+/).filter(Boolean)
    const supported = options.filter(option => VALID_ICE_OPTION.test(option))

    if (supported.length === options.length) return line
    return supported.length > 0 ? `a=ice-options:${supported.join(' ')}${ending}` : ''
  })
}

type CreateOffer = RTCPeerConnection['createOffer']
type PromiseCreateOffer = (
  this: RTCPeerConnection,
  options?: RTCOfferOptions,
) => Promise<RTCSessionDescriptionInit>

/**
 * Agora reads and parses the object returned directly by `createOffer`, so the
 * SDP has to be made compatible at that boundary. Keep the shim installed for
 * the lifetime of the RTC client because reconnects can create fresh offers.
 */
export function installAgoraSdpCompatibility(): () => void {
  const prototype = globalThis.RTCPeerConnection?.prototype
  if (!prototype) return () => undefined

  const nativeCreateOffer = prototype.createOffer
  const nativePromiseCreateOffer = nativeCreateOffer as unknown as PromiseCreateOffer
  const compatibleCreateOffer: PromiseCreateOffer = async function (this: RTCPeerConnection, options) {
    const offer = await nativePromiseCreateOffer.call(this, options)
    if (!offer.sdp) return offer

    const sdp = sanitizeAgoraSdp(offer.sdp)
    return sdp === offer.sdp ? offer : { type: offer.type, sdp }
  }

  prototype.createOffer = compatibleCreateOffer as CreateOffer

  return () => {
    // Do not overwrite a newer shim installed by another RTC consumer.
    if (prototype.createOffer === compatibleCreateOffer as CreateOffer) prototype.createOffer = nativeCreateOffer
  }
}
