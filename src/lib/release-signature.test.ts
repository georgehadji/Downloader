import assert from 'node:assert/strict'
import {generateKeyPairSync} from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'
import {fingerprintOf, TRUSTED_KEYS, verifyDetachedSignature, YT_DLP_KEY} from './release-signature.js'
import {signDetached} from './sign-for-test.js'

// a real pair from yt-dlp release 2026.10.26
const sums = fs.readFileSync(new URL('./fixtures/SHA2-256SUMS', import.meta.url))
const sig = fs.readFileSync(new URL('./fixtures/SHA2-256SUMS.sig', import.meta.url))

const flip = (buffer: Buffer, at: number) => {
  const copy = Buffer.from(buffer)
  copy[at] = copy[at]! ^ 1
  return copy
}

test('the trusted key constant is yt-dlp\'s signing key', () => {
  assert.equal(fingerprintOf(YT_DLP_KEY), 'ac0cbbe6848d6a873464af4e57cf65933b5a7581')
  assert.equal(TRUSTED_KEYS[0]!.fingerprint, 'ac0cbbe6848d6a873464af4e57cf65933b5a7581')
})

test('the real release signature verifies', () => {
  assert.equal(verifyDetachedSignature(sums, sig, TRUSTED_KEYS), true)
})

test('a changed SUMS file, signature byte or signer does not verify', () => {
  assert.equal(verifyDetachedSignature(flip(sums, 10), sig, TRUSTED_KEYS), false)
  assert.equal(verifyDetachedSignature(sums, flip(sig, sig.length - 5), TRUSTED_KEYS), false) // inside the RSA value
  assert.equal(verifyDetachedSignature(sums, flip(sig, 20), TRUSTED_KEYS), false) // inside the hashed issuer fingerprint
  assert.equal(verifyDetachedSignature(sums, flip(sig, 8), TRUSTED_KEYS), false) // inside the hashed creation time
  assert.equal(verifyDetachedSignature(sums, sig, []), false) // signer not trusted
})

test('empty, short and truncated input returns false instead of throwing', () => {
  for (const bad of [Buffer.alloc(0), Buffer.from([0x89]), Buffer.from([0x89, 0x02, 0x33]), sig.subarray(0, 100), sig.subarray(0, sig.length - 1)]) {
    assert.equal(verifyDetachedSignature(sums, bad, TRUSTED_KEYS), false)
  }
})

test('a signature made by a generated key verifies with SHA-256 and SHA-512 and fails for another key', () => {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048})
  const fingerprint = 'ab'.repeat(20)
  const trusted = [{fingerprint, key: publicKey}]
  const data = Buffer.from('hello')
  for (const hash of [8, 10] as const) {
    assert.equal(verifyDetachedSignature(data, signDetached(data, privateKey, fingerprint, hash), trusted), true)
  }
  const other = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey
  assert.equal(verifyDetachedSignature(data, signDetached(data, other, fingerprint), trusted), false)
  assert.equal(verifyDetachedSignature(data, signDetached(data, privateKey, 'cd'.repeat(20)), trusted), false) // names another signer
})
