// Pure assembly of the knowledge-base text a draft is given. No Deno or
// network APIs in here so it can be unit-tested with plain Node (see kb.test.ts).

export interface KbSource {
  deskName: string
  // Already restricted to requester-visible sections by refresh-kb-cache.
  content: string
}

// `own` is the desk's own KB (the whole Doc, [staff-only] sections included).
// `sources` are other desks' shared KBs, in precedence order (first wins).
// Returns null when there is nothing to give the model.
export function assembleKb(opts: { own: string | null; sources: KbSource[] }): string | null {
  const parts: string[] = []
  if (opts.own?.trim()) {
    parts.push(
      `THIS DESK'S OWN KNOWLEDGE BASE (sections whose heading is marked [staff-only] are for agents: let them inform the reply, but never quote or reveal them to the requester):\n${opts.own.trim()}`,
    )
  }
  for (const s of opts.sources) {
    if (!s.content.trim()) continue
    parts.push(
      `SHARED BY THE ${s.deskName.toUpperCase()} DESK (another desk's knowledge base; if it disagrees with this desk's own knowledge base or with an earlier shared one, follow the earlier one; when you rely on it, say which desk it came from in cited_kb_section):\n${s.content.trim()}`,
    )
  }
  return parts.length ? parts.join('\n\n=====\n\n') : null
}
