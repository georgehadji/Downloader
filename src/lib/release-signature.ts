import {createHash, createPublicKey, verify, type KeyObject} from 'node:crypto'

export type TrustedKey = {
  /** v4 OpenPGP fingerprint, 40 lowercase hex characters. */
  fingerprint: string
  key: KeyObject
}

/** The key's creation time is part of its fingerprint, so it is kept next to the numbers. */
export type KeyMaterial = {created: number; n: string; e: string}

/** v4 fingerprint: SHA-1 over the RSA public-key packet. Lets a test catch a mangled constant. */
export function fingerprintOf({created, n, e}: KeyMaterial): string {
  const mpi = (b64url: string) => {
    const bytes = Buffer.from(b64url, 'base64url')
    const bits = (bytes.length - 1) * 8 + (32 - Math.clz32(bytes[0]!))
    return Buffer.concat([Buffer.from([bits >> 8, bits & 0xff]), bytes])
  }
  const time = Buffer.alloc(4)
  time.writeUInt32BE(created)
  const body = Buffer.concat([Buffer.from([4]), time, Buffer.from([1]), mpi(n), mpi(e)])
  return createHash('sha1').update(Buffer.from([0x99, body.length >> 8, body.length & 0xff])).update(body).digest('hex')
}

// yt-dlp's release signing key (https://github.com/yt-dlp/yt-dlp/blob/master/public.key)
export const YT_DLP_KEY: KeyMaterial = {
  created: 1677455406,
  n: '9Kxfc4xjwLdLYZbeQtXm83HAFV-zW9b_nqkI5PlhGXUxE1QoN1gDOZ4AK5R3Zv32as1IDvqQGKwetBinoO331A3_ktFxShGXXkS2HgGqqioUom1WpQ47zgTs7bt1utOxyxE0AKgO8Ez7iLdlqpqS-tDSHMq9uy8apoHTd5jb2doizvmz9Jykfwvj4BPR-MrcsA2tdszMej5mQp1Tjjrul2RBZnVMcXUPXxQ6nfS3ASmNiwznEmKNbGmNGFomVh7c1aGbtZDs450uRY6v8gRySyJgx-6TcR5u7Pz52rq6ZkBbQxa7pLftpYQ56SlJhq_yP9yB6h_1_vZz6EuLoqkOR6W5QfASvuFn6WohIO-S577jj32SDymMl2v9AO0KIzMIDqw_PKM0_lQpCpJCfoo12e4BzY5nAWlHSiu3wyBDmCOty8nOkFpBkE4oBX30lF1hwwjvWlzYT93o6hVoBjLQlLK25HCZFrlmO6uQEcv9OR20jNyuA1PXqrZ8ZoldVkPJ17iPSYCUEb4eT05J8uS7cas3Jqr1jvU4xwW67NeATxDvX3F8Si_whQW81w0r7wIAK3aqpTKJ3EP8onE5Xy-qsyfBChYqlteEDE3QJ-krrmU6HVwk4iJ8KE-1o47hTyinb3x9Rj-G56nc058y8QkgyBLX8nz7CF_vRiOyZJP82Y0',
  e: 'AQAB',
}

// An array so a new Yoinks release can trust the next key before yt-dlp switches to it.
// Tests push a generated key here; code in this process could already do anything, so that is no new risk.
export const TRUSTED_KEYS: TrustedKey[] = [
  {fingerprint: fingerprintOf(YT_DLP_KEY), key: createPublicKey({key: {kty: 'RSA', n: YT_DLP_KEY.n, e: YT_DLP_KEY.e}, format: 'jwk'})},
]

const HASHES: Record<number, string> = {8: 'sha256', 10: 'sha512'}
const FINGERPRINT_SUBPACKET = 33

/**
 * Check an OpenPGP v4 detached signature (RFC 4880 §5.2) made by one of `keys` over `data`.
 * Only what yt-dlp's releases use is accepted: RSA, SHA-256 or SHA-512, a binary-document signature,
 * and the signer named in the *hashed* issuer-fingerprint subpacket. Never throws on bad input.
 */
export function verifyDetachedSignature(data: Buffer, sig: Buffer, keys: TrustedKey[]): boolean {
  try {
    return check(data, sig, keys)
  } catch {
    return false // out-of-bounds read or a key that rejects the signature
  }
}

function check(data: Buffer, sig: Buffer, keys: TrustedKey[]): boolean {
  const packet = readPacket(sig)
  if (!packet) return false
  const [version, type, algorithm, hashAlgorithm] = packet
  const hash = HASHES[hashAlgorithm!]
  if (version !== 4 || type !== 0x00 || algorithm !== 1 || !hash) return false

  const hashedEnd = 6 + packet.readUInt16BE(4)
  const issuer = findIssuer(packet.subarray(6, hashedEnd))
  const trusted = keys.find(k => k.fingerprint === issuer)
  if (!trusted) return false

  const unhashedEnd = hashedEnd + 2 + packet.readUInt16BE(hashedEnd)
  const bits = packet.readUInt16BE(unhashedEnd + 2)
  const mpi = packet.subarray(unhashedEnd + 4)
  if (mpi.length !== (bits + 7) >> 3) return false

  const trailer = Buffer.alloc(6)
  trailer.writeUInt8(4, 0)
  trailer.writeUInt8(0xff, 1)
  trailer.writeUInt32BE(hashedEnd, 2)
  const message = Buffer.concat([data, packet.subarray(0, hashedEnd), trailer])

  // an MPI drops leading zero bytes; crypto.verify wants exactly the modulus length
  const size = trusted.key.asymmetricKeyDetails?.modulusLength! / 8
  if (mpi.length > size) return false
  const signature = Buffer.concat([Buffer.alloc(size - mpi.length), mpi])
  return verify(hash, message, trusted.key, signature)
}

/** The body of the one signature packet in `sig`, or undefined for anything else. */
function readPacket(sig: Buffer): Buffer | undefined {
  const tag = sig[0]!
  if ((tag & 0x80) === 0) return undefined
  let at = 1
  let length: number
  if (tag & 0x40) {
    if ((tag & 0x3f) !== 2) return undefined
    const first = sig[at++]!
    if (first < 192) length = first
    else if (first < 224) length = ((first - 192) << 8) + sig[at++]! + 192
    else if (first === 255) {
      length = sig.readUInt32BE(at)
      at += 4
    } else return undefined // partial lengths
  } else {
    if (((tag >> 2) & 0x0f) !== 2) return undefined
    const lengthType = tag & 3
    if (lengthType === 3) return undefined // indefinite length
    length = sig.readUIntBE(at, 1 << lengthType)
    at += 1 << lengthType
  }
  return at + length === sig.length ? sig.subarray(at) : undefined
}

/** The signer's fingerprint from a subpacket area, as lowercase hex. */
function findIssuer(area: Buffer): string | undefined {
  let at = 0
  while (at < area.length) {
    let length = area[at++]!
    if (length >= 255) {
      length = area.readUInt32BE(at)
      at += 4
    } else if (length >= 192) length = ((length - 192) << 8) + area[at++]! + 192
    const end = at + length
    if (end > area.length || length === 0) return undefined
    if ((area[at]! & 0x7f) === FINGERPRINT_SUBPACKET && area[at + 1] === 4 && length === 22) {
      return area.subarray(at + 2, end).toString('hex')
    }
    at = end
  }
  return undefined
}
