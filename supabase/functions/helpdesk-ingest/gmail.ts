// Gmail access for helpdesk-ingest: token acquisition (service account with
// domain-wide delegation, or a stored OAuth refresh token for mailboxes
// outside the sil.org Workspace, like the BTC pilot) and a thin API wrapper.
// Uses only fetch and WebCrypto, so it also runs under Node for tests.

import { decodeBase64UrlBytes } from './parse.ts'
import type { Payload } from './parse.ts'

// Least privilege for ingestion: read + label/archive. Sending replies will
// need gmail.send too (a later phase); the delegation grant should then add it.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface MailboxAuth {
  mailbox: string
  auth_type: 'service_account' | 'oauth'
  secret_prefix: string | null
}

export type Env = (name: string) => string | undefined

export async function getAccessToken(m: MailboxAuth, env: Env): Promise<string> {
  if (m.auth_type === 'service_account') {
    const raw = env('HELPDESK_GOOGLE_SA_JSON')
    if (!raw) throw new Error('HELPDESK_GOOGLE_SA_JSON secret is not set')
    const key = JSON.parse(raw) as { client_email: string; private_key: string; token_uri?: string }
    const assertion = await signServiceAccountJwt(key, m.mailbox, GMAIL_SCOPE)
    return await exchangeToken(new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }), key.token_uri ?? TOKEN_URL)
  }

  const prefix = m.secret_prefix
  const clientId = env(`${prefix}_CLIENT_ID`)
  const clientSecret = env(`${prefix}_CLIENT_SECRET`)
  const refreshToken = env(`${prefix}_REFRESH_TOKEN`)
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`${prefix}_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN secrets are not all set`)
  }
  return await exchangeToken(new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }), TOKEN_URL)
}

async function exchangeToken(body: URLSearchParams, url: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Google token request failed (${res.status}): ${await res.text()}`)
  const data = await res.json()
  return data.access_token as string
}

function b64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return bytes.buffer
}

// RS256 JWT for service-account delegation: `sub` is the mailbox to act as.
export async function signServiceAccountJwt(
  key: { client_email: string; private_key: string; token_uri?: string },
  subject: string,
  scope: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    sub: subject,
    scope,
    aud: key.token_uri ?? TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }))
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(`${header}.${claims}`))
  return `${header}.${claims}.${b64url(sig)}`
}

export interface GmailMessage {
  id: string
  threadId: string
  snippet?: string
  payload: Payload & { headers: { name: string; value: string }[] }
}

export class Gmail {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let lastError = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      })
      if (res.ok) return res
      lastError = `${res.status}: ${await res.text()}`
      if (res.status !== 429 && res.status < 500) break
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
    throw new Error(`Gmail API error on ${path} (${lastError})`)
  }

  async listMessageIds(query: string, max: number): Promise<string[]> {
    const res = await this.request(`/messages?q=${encodeURIComponent(query)}&maxResults=${max}`)
    const data = await res.json()
    return (data.messages ?? []).map((m: { id: string }) => m.id)
  }

  async getMessage(id: string): Promise<GmailMessage> {
    const res = await this.request(`/messages/${id}?format=full`)
    return await res.json()
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const res = await this.request(`/messages/${messageId}/attachments/${attachmentId}`)
    const data = await res.json()
    return decodeBase64UrlBytes(data.data ?? '')
  }

  // Returns the label's id, creating it if it doesn't exist yet.
  async ensureLabel(name: string): Promise<string> {
    const res = await this.request('/labels')
    const { labels } = await res.json()
    const found = (labels ?? []).find((l: { name: string; id: string }) => l.name === name)
    if (found) return found.id
    const created = await this.request('/labels', {
      method: 'POST',
      body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    })
    return (await created.json()).id
  }

  // Looks up an existing label without creating it (null if missing).
  async findLabel(name: string): Promise<string | null> {
    const res = await this.request('/labels')
    const { labels } = await res.json()
    return (labels ?? []).find((l: { name: string; id: string }) => l.name === name)?.id ?? null
  }

  async modifyLabels(messageId: string, add: string[], remove: string[]): Promise<void> {
    await this.request(`/messages/${messageId}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
    })
  }
}
