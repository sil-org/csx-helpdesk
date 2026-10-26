// Pure plain-text-to-HTML conversion for the outbound email's html part. No
// Deno/network APIs here so it's unit-testable with plain Node.
//
// The compose box is a plain textarea (no rich text), so the body is always
// plain text — but sending only a text part makes some email clients
// collapse single newlines (only a blank line reads as a paragraph break in
// plain text), losing the line breaks the agent actually typed.

export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const paragraphs = escaped.split(/\n{2,}/).map((p) => p.split('\n').join('<br>'))
  return paragraphs.map((p) => `<p>${p}</p>`).join('\n')
}
