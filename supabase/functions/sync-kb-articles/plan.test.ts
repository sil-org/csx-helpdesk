// Run with: node --experimental-strip-types --test supabase/functions/sync-kb-articles/
import test from 'node:test'
import assert from 'node:assert/strict'
import { planSync } from './plan.ts'
import type { ExistingArticle, FoundDoc } from './plan.ts'

const doc = (id: string, name: string, segments: string[], modifiedTime = '2026-11-01T10:00:00Z'): FoundDoc =>
  ({ id, name, segments, modifiedTime })
const row = (o: Partial<ExistingArticle> & { drive_id: string; slug: string }): ExistingArticle =>
  ({ id: 'row-' + o.drive_id, tier: 'internal', topic: null, archived: false, drive_modified_at: '2026-11-01T10:00:00Z', ...o })

test('a new Doc is synced with a slug from its title', () => {
  const plan = planSync({ found: [doc('a', 'Re-Register Security Keys', ['internal'])], existing: [] })
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].action, 'sync')
  assert.equal(plan.items[0].slug, 're-register-security-keys')
  assert.deepEqual(plan.items[0].placement, { tier: 'internal', topic: null, archived: false })
})

test('two new Docs with the same title get different slugs, also against stored ones', () => {
  const plan = planSync({
    found: [doc('a', 'Sign-in help', ['public']), doc('b', 'Sign-in help', ['internal'])],
    existing: [row({ drive_id: 'z', slug: 'sign-in-help' })],
  })
  assert.deepEqual(plan.items.map((i) => i.slug), ['sign-in-help-2', 'sign-in-help-3'])
})

test('an unchanged Doc is not read again', () => {
  const plan = planSync({
    found: [doc('a', 'Guide', ['internal'])],
    existing: [row({ drive_id: 'a', slug: 'guide' })],
  })
  assert.equal(plan.items[0].action, 'unchanged')
})

test('a Doc edited since the last sync is read again, and keeps its slug when renamed', () => {
  const plan = planSync({
    found: [doc('a', 'Guide, new name', ['internal'], '2026-11-05T10:00:00Z')],
    existing: [row({ drive_id: 'a', slug: 'guide' })],
  })
  assert.equal(plan.items[0].action, 'sync')
  assert.equal(plan.items[0].slug, 'guide')
})

test('moving a Doc between folders re-syncs it even if its text did not change', () => {
  const found = [doc('a', 'Guide', ['agents'])]
  assert.equal(planSync({ found, existing: [row({ drive_id: 'a', slug: 'guide', tier: 'internal' })] }).items[0].action, 'sync')
  assert.equal(planSync({ found: [doc('a', 'Guide', ['internal', 'Mail'])], existing: [row({ drive_id: 'a', slug: 'guide' })] }).items[0].action, 'sync')
  assert.equal(planSync({ found: [doc('a', 'Guide', ['internal', 'Archive'])], existing: [row({ drive_id: 'a', slug: 'guide' })] }).items[0].action, 'sync')
})

test('force re-syncs everything', () => {
  const plan = planSync({ found: [doc('a', 'Guide', ['internal'])], existing: [row({ drive_id: 'a', slug: 'guide' })], force: true })
  assert.equal(plan.items[0].action, 'sync')
})

test('a stored copy with no usable date is read again', () => {
  const plan = planSync({
    found: [doc('a', 'Guide', ['internal'])],
    existing: [row({ drive_id: 'a', slug: 'guide', drive_modified_at: null })],
  })
  assert.equal(plan.items[0].action, 'sync')
})

test('Docs outside the audience folders are reported and never published', () => {
  const plan = planSync({ found: [doc('a', 'Loose doc', []), doc('b', 'Admin doc', ['google-admins'])], existing: [] })
  assert.equal(plan.items.length, 0)
  assert.deepEqual(plan.skipped.map((s) => s.id), ['a', 'b'])
})

test('an article whose Doc is gone, or was moved out of an audience folder, is removed', () => {
  const plan = planSync({
    found: [doc('a', 'Kept', ['internal']), doc('c', 'Moved out', ['Elsewhere'])],
    existing: [row({ drive_id: 'a', slug: 'kept' }), row({ drive_id: 'b', slug: 'deleted' }), row({ drive_id: 'c', slug: 'moved-out' })],
  })
  assert.deepEqual(plan.remove.sort(), ['b', 'c'])
})
