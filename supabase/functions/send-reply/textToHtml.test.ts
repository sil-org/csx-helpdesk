// Run with: node --experimental-strip-types --test supabase/functions/send-reply/
import test from 'node:test'
import assert from 'node:assert/strict'
import { textToHtml } from './textToHtml.ts'

test('textToHtml turns a blank-line gap into separate paragraphs and single newlines into <br>', () => {
  const html = textToHtml('Hi Pat,\nThanks for reaching out.\n\nLet us know if that helps.')
  assert.equal(html, '<p>Hi Pat,<br>Thanks for reaching out.</p>\n<p>Let us know if that helps.</p>')
})

test('textToHtml escapes HTML-significant characters', () => {
  assert.equal(textToHtml('Use < and > and &'), '<p>Use &lt; and &gt; and &amp;</p>')
})
