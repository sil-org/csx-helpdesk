import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatFrom, senderName } from './sender.ts'

test('appends Helpdesk to a plain desk name', () => {
  assert.equal(senderName('Dallas'), 'Dallas Helpdesk')
})

test('does not double up when the name already ends in Help Desk', () => {
  assert.equal(senderName('Global IT Help Desk'), 'Global IT Help Desk')
  assert.equal(senderName('Dallas helpdesk'), 'Dallas helpdesk')
})

test('drops a trailing parenthetical like (pilot)', () => {
  assert.equal(senderName('Global IT Help Desk (pilot)'), 'Global IT Help Desk')
  assert.equal(senderName('Dallas (pilot)'), 'Dallas Helpdesk')
})

test('falls back when the name is empty', () => {
  assert.equal(senderName('  '), 'Helpdesk')
})

test('formats From with the address from config, whether bare or named', () => {
  assert.equal(formatFrom('Dallas', undefined), '"Dallas Helpdesk" <helpdesk@em.sil.org>')
  assert.equal(formatFrom('Dallas', 'SIL Helpdesk <hd@em.sil.org>'), '"Dallas Helpdesk" <hd@em.sil.org>')
  assert.equal(formatFrom('Dallas', 'hd@em.sil.org'), '"Dallas Helpdesk" <hd@em.sil.org>')
})

test('strips quotes and backslashes from the name', () => {
  assert.equal(formatFrom('Da"llas\\', undefined), '"Dallas Helpdesk" <helpdesk@em.sil.org>')
})
