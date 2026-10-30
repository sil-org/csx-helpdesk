// Run with: node --experimental-strip-types --test supabase/functions/_shared/
import test from 'node:test'
import assert from 'node:assert/strict'
import { senderTrust, weakestTrust, dmarcPassesFor } from './senderTrust.ts'

const PASS = 'mx.google.com; dkim=pass header.i=@sil.org; spf=pass smtp.mailfrom=pat@sil.org; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=sil.org'

test('a sil.org sender with an aligned DMARC pass is verified', () => {
  assert.equal(senderTrust({ fromEmail: 'Pat@SIL.org', originalAuthResults: PASS }), 'sil_verified')
})

test('a sil.org sender with no authentication result is unverified, not trusted', () => {
  assert.equal(senderTrust({ fromEmail: 'pat@sil.org', originalAuthResults: null }), 'sil_unverified')
  assert.equal(senderTrust({ fromEmail: 'pat@sil.org' }), 'sil_unverified')
})

test('a sil.org sender whose DMARC failed is unverified', () => {
  assert.equal(senderTrust({ fromEmail: 'pat@sil.org', originalAuthResults: 'mx.google.com; spf=fail; dmarc=fail header.from=sil.org' }), 'sil_unverified')
})

test('SPF and DKIM passing is not enough without DMARC (the attacker can pass them for their own domain)', () => {
  assert.equal(senderTrust({ fromEmail: 'pat@sil.org', originalAuthResults: 'mx.google.com; dkim=pass header.i=@evil.test; spf=pass smtp.mailfrom=x@evil.test' }), 'sil_unverified')
})

test('a DMARC pass for a different header.from domain does not verify the sender', () => {
  assert.equal(senderTrust({ fromEmail: 'pat@sil.org', originalAuthResults: 'mx.google.com; dmarc=pass header.from=evil.test' }), 'sil_unverified')
})

test('any non-pass DMARC segment wins over a pass', () => {
  assert.equal(dmarcPassesFor('a; dmarc=pass header.from=sil.org; b; dmarc=fail header.from=sil.org', 'sil.org'), false)
})

test('other domains are external, even with a DMARC pass, and look-alike domains are not SIL', () => {
  assert.equal(senderTrust({ fromEmail: 'x@gmail.com', originalAuthResults: 'dmarc=pass header.from=gmail.com' }), 'external')
  assert.equal(senderTrust({ fromEmail: 'x@sil.org.evil.test' }), 'external')
  assert.equal(senderTrust({ fromEmail: 'x@notsil.org' }), 'external')
})

test('subdomains of sil.org count as SIL; a missing sender is external', () => {
  assert.equal(senderTrust({ fromEmail: 'x@mail.sil.org', originalAuthResults: 'dmarc=pass header.from=mail.sil.org' }), 'sil_verified')
  assert.equal(senderTrust({ fromEmail: null }), 'external')
  assert.equal(senderTrust({ fromEmail: '' }), 'external')
})

test('weakestTrust takes the least trusted sender; an empty thread is external', () => {
  assert.equal(weakestTrust(['sil_verified', 'sil_verified']), 'sil_verified')
  assert.equal(weakestTrust(['sil_verified', 'sil_unverified']), 'sil_unverified')
  assert.equal(weakestTrust(['sil_verified', 'external', 'sil_unverified']), 'external')
  assert.equal(weakestTrust([]), 'external')
})
