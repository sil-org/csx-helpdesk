import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { signServiceAccountJwt } from './gmail.ts'

test('service-account JWT has the right claims and a valid RS256 signature', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const jwt = await signServiceAccountJwt(
    { client_email: 'sa@proj.iam.gserviceaccount.com', private_key: pem },
    'helpdesk-ingest@sil.org',
    'https://www.googleapis.com/auth/gmail.modify',
    1_700_000_000
  )
  const [header, claims, sig] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
    iss: 'sa@proj.iam.gserviceaccount.com',
    sub: 'helpdesk-ingest@sil.org',
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  })
  const v = createVerify('RSA-SHA256')
  v.update(`${header}.${claims}`)
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')))
})
