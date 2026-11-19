// Run with: node --experimental-strip-types --test supabase/functions/sync-kb-articles/
// Runs the whole sync against a fake Drive and a fake database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { syncDesk, TIME_BUDGET_MS } from './sync.ts'

const FOLDER = 'application/vnd.google-apps.folder'
const DOC = 'application/vnd.google-apps.document'
const DESK = 'desk-1'

// ── A fake Drive: folders by id, Docs by id ──────────────────────────────

interface Node { id: string; name: string; mimeType: string; modifiedTime: string }
function fakeDrive(tree: Record<string, Node[]>, docs: Record<string, string>) {
  const calls = { lists: 0, exports: [] as string[] }
  const failures = { list: new Set<string>(), exportDoc: new Set<string>() }
  const fetchFn = async (url: string) => {
    const u = new URL(url)
    if (u.pathname.endsWith('/export')) {
      const id = u.pathname.split('/').at(-2)!
      calls.exports.push(id)
      if (failures.exportDoc.has(id)) return new Response('boom', { status: 500 })
      return new Response(docs[id], { status: 200 })
    }
    calls.lists++
    const folder = /'([^']+)' in parents/.exec(u.searchParams.get('q')!)![1]
    if (failures.list.has(folder)) return new Response('forbidden', { status: 403 })
    return new Response(JSON.stringify({ files: tree[folder] ?? [] }), { status: 200 })
  }
  return { fetch: fetchFn as unknown as typeof fetch, tree, docs, calls, failures }
}

// ── A fake database: just the calls sync.ts makes ────────────────────────

function fakeDb() {
  const tables: Record<string, Record<string, unknown>[]> = { kb_articles: [], kb_article_images: [] }
  const files = new Map<string, Uint8Array>()
  const failUpload = new Set<string>()
  function query(name: string, op: 'select' | 'delete') {
    const filters: ((r: Record<string, unknown>) => boolean)[] = []
    const q = {
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return q },
      then(resolve: (v: unknown) => void) {
        const hit = tables[name].filter((r) => filters.every((f) => f(r)))
        if (op === 'select') return resolve({ data: hit.map((r) => ({ ...r })), error: null })
        tables[name] = tables[name].filter((r) => !hit.includes(r))
        resolve({ data: null, error: null })
      },
    }
    return q
  }
  const db = {
    from: (name: string) => ({
      select: () => query(name, 'select'),
      delete: () => query(name, 'delete'),
      upsert: async (input: Record<string, unknown> | Record<string, unknown>[], opts: { onConflict: string }) => {
        const keys = opts.onConflict.split(',')
        for (const row of Array.isArray(input) ? input : [input]) {
          if (name === 'kb_articles' && tables[name].some((r) => r.desk_id === row.desk_id && r.slug === row.slug && r.drive_id !== row.drive_id)) {
            return { error: new Error('duplicate key value violates unique constraint (desk_id, slug)') }
          }
          const at = tables[name].findIndex((r) => keys.every((k) => r[k] === row[k]))
          if (at >= 0) tables[name][at] = { ...tables[name][at], ...row }
          else tables[name].push({ ...row })
        }
        return { error: null }
      },
    }),
    storage: {
      from: (_bucket: string) => ({
        upload: async (path: string, data: Uint8Array) => {
          if (failUpload.has(path)) return { error: new Error('upload failed') }
          files.set(path, data)
          return { error: null }
        },
        remove: async (paths: string[]) => { for (const p of paths) files.delete(p); return { error: null } },
      }),
    },
  }
  return { db, tables, files, failUpload }
}

// ── A small knowledge base ───────────────────────────────────────────────

const T0 = '2026-11-01T10:00:00Z'
const T1 = '2026-11-10T10:00:00Z'
const node = (id: string, name: string, mimeType: string, modifiedTime = T0): Node => ({ id, name, mimeType, modifiedTime })

function kb() {
  return fakeDrive(
    {
      root: [node('f-public', 'public', FOLDER), node('f-internal', 'Internal', FOLDER), node('f-agents', 'agents', FOLDER),
        node('f-drafts', 'Drafts', FOLDER), node('d-loose', 'Loose doc', DOC)],
      'f-public': [node('d-signin', 'Sign-In Help', DOC)],
      'f-internal': [node('f-topic', 'Sign-in and security', FOLDER), node('d-phish', 'Protecting SIL from Phishing', DOC)],
      'f-topic': [node('d-keys', 'Re-Register Security Keys', DOC)],
      'f-agents': [node('d-run', 'Runbook', DOC)],
      'f-drafts': [node('d-wip', 'Work in progress', DOC)],
    },
    {
      'd-signin': '# Sign-In Help\nUse the reset link.',
      'd-keys': '# Keys\nRe-add the key. ![][image1] and ![][image2]\n\n## Contacts [no-quote]\nCall Sam.\n\n## Next\nDone.\n\n[image1]: <data:image/png;base64,AAEC>\n[image2]: <data:image/jpeg;base64,AwQF>\n',
      'd-phish': '**DRAFT**\nSubject: alert',
      'd-run': '# Runbook\nAgents only.',
      'd-loose': '# Loose\nNot in a folder.',
      'd-wip': '# WIP',
    },
  )
}

const run = (drive: ReturnType<typeof kb>, d: ReturnType<typeof fakeDb>, opts: { force?: boolean; now?: () => number } = {}) =>
  syncDesk({ db: d.db, fetch: drive.fetch, now: opts.now ?? (() => 1_000) }, 'tok', 'sa@example.org', DESK, 'root', !!opts.force, 0)

const article = (d: ReturnType<typeof fakeDb>, driveId: string) => d.tables.kb_articles.find((r) => r.drive_id === driveId) as Record<string, any>

test('first run publishes by folder, skips what is not in an audience folder, and leaves Drafts out', async () => {
  const drive = kb(), d = fakeDb()
  const report = await run(drive, d)
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.skipped, [{ name: 'Loose doc', reason: 'not inside a public, internal or agents folder' }])
  assert.equal(d.tables.kb_articles.length, 4)
  assert.deepEqual(
    d.tables.kb_articles.map((r) => [r.title, r.tier, r.topic, r.slug, r.is_draft]).sort(),
    [
      ['Protecting SIL from Phishing', 'internal', null, 'protecting-sil-from-phishing', true],
      ['Re-Register Security Keys', 'internal', 'Sign-in and security', 're-register-security-keys', false],
      ['Runbook', 'agents', null, 'runbook', false],
      ['Sign-In Help', 'public', null, 'sign-in-help', false],
    ],
  )
  assert.equal(drive.calls.exports.includes('d-wip'), false)
  assert.equal(drive.calls.exports.includes('d-loose'), false)
})

test('images are stored and the text points at them; [no-quote] stays out of the shareable copy', async () => {
  const drive = kb(), d = fakeDb()
  await run(drive, d)
  const keys = article(d, 'd-keys')
  const p1 = `${DESK}/${keys.id}/1.png`, p2 = `${DESK}/${keys.id}/2.jpg`
  assert.deepEqual([...d.files.keys()].sort(), [p1, p2])
  assert.ok(keys.body.includes(`![](kb-image:${p1})`) && keys.body.includes(`![](kb-image:${p2})`))
  assert.ok(!keys.body.includes('data:image'))
  assert.ok(keys.body.includes('Call Sam.') && !keys.body_shareable.includes('Call Sam.'))
  assert.ok(keys.body_shareable.includes('## Next'))
  assert.deepEqual(d.tables.kb_article_images.map((r) => r.storage_path).sort(), [p1, p2])
  assert.equal(keys.drive_modified_at, T0)
})

test('a second run with nothing changed reads no Docs', async () => {
  const drive = kb(), d = fakeDb()
  await run(drive, d)
  drive.calls.exports.length = 0
  const report = await run(drive, d)
  assert.deepEqual(report.synced, [])
  assert.equal(report.unchanged, 4)
  assert.deepEqual(drive.calls.exports, [])
})

test('an edited Doc is read again, keeps its slug, and drops images it no longer has', async () => {
  const drive = kb(), d = fakeDb()
  await run(drive, d)
  const id = article(d, 'd-keys').id
  drive.tree['f-topic'] = [node('d-keys', 'Security Keys, renamed', DOC, T1)]
  drive.docs['d-keys'] = '# Keys\nOne picture now ![][image1]\n\n[image1]: <data:image/png;base64,AAEC>\n'
  drive.calls.exports.length = 0
  const report = await run(drive, d)
  assert.deepEqual(report.synced, ['Security Keys, renamed'])
  assert.deepEqual(drive.calls.exports, ['d-keys'])
  const keys = article(d, 'd-keys')
  assert.equal(keys.id, id)
  assert.equal(keys.slug, 're-register-security-keys')
  assert.equal(keys.title, 'Security Keys, renamed')
  assert.deepEqual([...d.files.keys()], [`${DESK}/${id}/1.png`])
  assert.deepEqual(d.tables.kb_article_images.map((r) => r.storage_path), [`${DESK}/${id}/1.png`])
})

test('moving a Doc to another audience folder changes who can read it', async () => {
  const drive = kb(), d = fakeDb()
  await run(drive, d)
  drive.tree['f-public'] = []
  drive.tree['f-agents'] = [node('d-run', 'Runbook', DOC), node('d-signin', 'Sign-In Help', DOC)]
  await run(drive, d)
  assert.equal(article(d, 'd-signin').tier, 'agents')
})

test('a Doc deleted in Drive, or moved out of the audience folders, is unpublished with its images', async () => {
  const drive = kb(), d = fakeDb()
  await run(drive, d)
  drive.tree['f-topic'] = []
  const report = await run(drive, d)
  assert.equal(report.removed, 1)
  assert.equal(article(d, 'd-keys'), undefined)
  assert.equal(d.files.size, 0)
  assert.equal(d.tables.kb_article_images.length, 0)
  assert.equal(d.tables.kb_articles.length, 3)
})

test('if a folder cannot be listed nothing is removed or changed', async () => {
  const drive = kb(), d = fakeDb()
  await run(drive, d)
  drive.failures.list.add('f-topic')
  const report = await run(drive, d)
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0].error, /403.*sa@example\.org/s)
  assert.equal(d.tables.kb_articles.length, 4)
  assert.equal(report.removed, 0)
})

test('one Doc failing to export does not stop the others', async () => {
  const drive = kb(), d = fakeDb()
  drive.failures.exportDoc.add('d-signin')
  const report = await run(drive, d)
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].doc, 'Sign-In Help')
  assert.equal(d.tables.kb_articles.length, 3)
})

test('an image that cannot be stored shows as missing text and the article is still saved', async () => {
  const drive = kb(), d = fakeDb()
  await run(drive, d)
  const id = article(d, 'd-keys').id
  d.failUpload.add(`${DESK}/${id}/2.jpg`)
  const report = await run(drive, d, { force: true })
  assert.deepEqual(report.errors, [])
  const keys = article(d, 'd-keys')
  assert.ok(keys.body.includes(`![](kb-image:${DESK}/${id}/1.png)`))
  assert.ok(keys.body.includes('*(image not available)*'))
  assert.deepEqual(d.tables.kb_article_images.map((r) => r.storage_path), [`${DESK}/${id}/1.png`])
})

test('force re-reads every Doc', async () => {
  const drive = kb(), d = fakeDb()
  await run(drive, d)
  drive.calls.exports.length = 0
  const report = await run(drive, d, { force: true })
  assert.equal(report.synced.length, 4)
  assert.equal(drive.calls.exports.length, 4)
})

test('a run that is out of time stops cleanly and the next run finishes', async () => {
  const drive = kb(), d = fakeDb()
  let clock = 0
  const report = await run(drive, d, { now: () => (clock += TIME_BUDGET_MS / 2 + 1) })
  assert.equal(report.partial, true)
  assert.ok(d.tables.kb_articles.length < 4)
  const next = await run(drive, d)
  assert.equal(next.partial, false)
  assert.equal(d.tables.kb_articles.length, 4)
})
