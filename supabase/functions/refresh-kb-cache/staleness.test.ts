// Run with: node --experimental-strip-types --test supabase/functions/refresh-kb-cache/
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldRefresh } from './staleness.ts'

const base = { docId: 'doc1', cachedDocId: 'doc1', cachedAt: '2026-10-30T10:00:00Z', modifiedTime: '2026-10-29T08:00:00Z' }

test('skips a Doc that has not changed since it was last read', () => {
  assert.deepEqual(shouldRefresh(base), { refresh: false, reason: 'Doc unchanged since last read' })
})

test('refreshes a Doc modified after the last read', () => {
  assert.equal(shouldRefresh({ ...base, modifiedTime: '2026-10-30T10:00:01Z' }).refresh, true)
})

test('refreshes when the desk now points at a different Doc, or nothing was cached', () => {
  assert.equal(shouldRefresh({ ...base, cachedDocId: 'old-doc' }).refresh, true)
  assert.equal(shouldRefresh({ ...base, cachedDocId: null }).refresh, true)
})

test('refreshes when it was never read or the cached time is unusable', () => {
  assert.equal(shouldRefresh({ ...base, cachedAt: null }).refresh, true)
  assert.equal(shouldRefresh({ ...base, cachedAt: 'garbage' }).refresh, true)
})

test('refreshes (falls back to reading it) when the modified time could not be checked', () => {
  assert.equal(shouldRefresh({ ...base, modifiedTime: null }).refresh, true)
  assert.equal(shouldRefresh({ ...base, modifiedTime: undefined }).refresh, true)
  assert.equal(shouldRefresh({ ...base, modifiedTime: 'garbage' }).refresh, true)
})

test('force always refreshes', () => {
  assert.equal(shouldRefresh({ ...base, force: true }).refresh, true)
})
