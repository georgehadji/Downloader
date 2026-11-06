import {sign, type KeyObject} from 'node:crypto'

/** Test helper: an OpenPGP v4 detached signature of `data`, shaped like the ones yt-dlp publishes. */
export function signDetached(data: Buffer, privateKey: KeyObject, fingerprint: string, hashAlgorithm: 8 | 10 = 10): Buffer {
  const created = Buffer.alloc(4)
  created.writeUInt32BE(1_700_000_000)
  const hashed = Buffer.concat([Buffer.from([5, 2]), created, Buffer.from([22, 33, 4]), Buffer.from(fingerprint, 'hex')])
  const head = Buffer.concat([Buffer.from([4, 0, 1, hashAlgorithm, 0, hashed.length]), hashed])
  const trailer = Buffer.alloc(6)
  trailer.set([4, 0xff])
  trailer.writeUInt32BE(head.length, 2)
  let raw = sign(hashAlgorithm === 8 ? 'sha256' : 'sha512', Buffer.concat([data, head, trailer]), privateKey)
  while (raw[0] === 0) raw = raw.subarray(1) // an MPI has no leading zero bytes
  const bits = (raw.length - 1) * 8 + (32 - Math.clz32(raw[0]!))
  const body = Buffer.concat([head, Buffer.from([0, 0, 0, 0, bits >> 8, bits & 0xff]), raw]) // no unhashed area, left-16 unchecked
  return Buffer.concat([Buffer.from([0x89, body.length >> 8, body.length & 0xff]), body])
}
