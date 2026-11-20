import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { signInWithGoogle } from '../../lib/auth'
import AppLayout from '../../components/AppLayout'
import { getReporterLinks } from '../../navLinks'
import ChatLauncher, { CHAT_URL } from '../../components/ChatLauncher'
import {
  DEFAULT_COLOR, formatDate, isStale, listArticles, listRecent, loadKbDesks, loadTopics,
  searchKb, signInHint, snippetParts,
} from '../../lib/kb'

// Help center home (spec decision 23): search, browse by topic, recently
// updated. What appears is whatever the caller's row-level access allows, so a
// signed-out visitor sees public articles and a signed-in person sees internal
// ones too. Designs: the "Requester help center" canvas, boards 1, 2 and 6.
export default function HelpCenter() {
  const { session, profile, loading: authLoading } = useAuth()
  const [params, setParams] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const topic = params.get('topic')
  const deskSlug = params.get('desk')
  const signedIn = !!session && !!profile

  const [desks, setDesks] = useState(null)
  const [topics, setTopics] = useState([])
  const [recent, setRecent] = useState([])
  const [results, setResults] = useState(null)
  const [topicArticles, setTopicArticles] = useState(null)
  const [hint, setHint] = useState(0)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState(q)

  const deskById = useMemo(() => Object.fromEntries((desks ?? []).map((d) => [d.id, d])), [desks])
  const activeDesk = (desks ?? []).find((d) => d.slug === deskSlug)
  const single = desks?.length === 1 ? desks[0] : null
  const color = single?.theme_primary || DEFAULT_COLOR
  const supportAddress = (activeDesk ?? single)?.support_address

  useEffect(() => setDraft(q), [q])

  // Load once the sign-in state is known, and again if it changes, so the
  // answers always match who is looking.
  useEffect(() => {
    if (authLoading) return
    let cancelled = false
    ;(async () => {
      try {
        const [d, t, r] = await Promise.all([loadKbDesks(), loadTopics(), listRecent()])
        if (cancelled) return
        setDesks(d); setTopics(t); setRecent(r); setError(null)
      } catch (e) {
        if (!cancelled) { setError(e.message); setDesks([]) }
      }
    })()
    return () => { cancelled = true }
  }, [authLoading, signedIn])

  useEffect(() => {
    if (authLoading || desks === null) return
    let cancelled = false
    setResults(null); setHint(0)
    if (!q) return
    ;(async () => {
      try {
        const [rows, h] = await Promise.all([
          searchKb(q, activeDesk?.id),
          signedIn ? 0 : signInHint(q),
        ])
        if (!cancelled) { setResults(rows); setHint(h) }
      } catch (e) {
        if (!cancelled) { setError(e.message); setResults([]) }
      }
    })()
    return () => { cancelled = true }
  }, [q, deskSlug, authLoading, signedIn, desks]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (authLoading || desks === null) return
    let cancelled = false
    setTopicArticles(null)
    if (!topic || q) return
    listArticles({ topic, deskId: activeDesk?.id })
      .then((rows) => { if (!cancelled) setTopicArticles(rows) })
      .catch((e) => { if (!cancelled) { setError(e.message); setTopicArticles([]) } })
    return () => { cancelled = true }
  }, [topic, q, deskSlug, authLoading, signedIn, desks]) // eslint-disable-line react-hooks/exhaustive-deps

  function submit(e) {
    e.preventDefault()
    const next = new URLSearchParams()
    if (draft.trim()) next.set('q', draft.trim())
    if (deskSlug) next.set('desk', deskSlug)
    setParams(next)
  }

  const topicGroups = useMemo(() => {
    const byName = new Map()
    for (const t of topics) {
      if (activeDesk && t.desk_id !== activeDesk.id) continue
      byName.set(t.topic, (byName.get(t.topic) ?? 0) + Number(t.article_count))
    }
    return [...byName].map(([name, count]) => ({ name, count }))
  }, [topics, activeDesk])

  const articleLink = (a) => `/help/${deskById[a.desk_id]?.slug ?? ''}/${a.slug}`
  const showDesk = (desks?.length ?? 0) > 1
  const ready = desks !== null && !authLoading

  return (
    <AppLayout desk={single} links={getReporterLinks({ signedIn })}>
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-[760px] mx-auto px-6 pt-10 pb-8 flex flex-col gap-4">
          <h1 className="font-display text-[34px] leading-tight m-0">
            {signedIn && profile?.display_name ? `How can we help, ${profile.display_name.split(' ')[0]}?` : 'How can we help?'}
          </h1>
          <form onSubmit={submit} role="search" className="flex items-center gap-3 border-2 rounded-xl bg-white px-4 h-14" style={{ borderColor: color }}>
            <Search size={20} className="text-gray-500 flex-none" aria-hidden="true" />
            <label htmlFor="kb-search" className="sr-only">Search the help center</label>
            <input
              id="kb-search"
              type="search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search articles, for example “security key”"
              className="flex-1 min-w-0 bg-transparent outline-none text-[17px] text-gray-900"
            />
            <button type="submit" className="text-sm font-bold" style={{ color }}>Search</button>
          </form>
          {showDesk && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Desk">
              <DeskChip label="All desks" active={!deskSlug} to={deskLink(null, q, topic)} color={color} />
              {desks.map((d) => <DeskChip key={d.id} label={d.name} active={deskSlug === d.slug} to={deskLink(d.slug, q, topic)} color={color} />)}
            </div>
          )}
        </div>
      </div>

      <main className="max-w-[1120px] mx-auto px-6 py-8 flex flex-wrap gap-8 items-start">
        <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-4">
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>}
          {!ready && <div className="text-sm text-gray-400">Loading&hellip;</div>}

          {ready && q && (
            <>
              <h2 className="font-display text-[24px] m-0">
                {results === null ? 'Searching…' : `${results.length} ${results.length === 1 ? 'result' : 'results'} for “${q}”`}
              </h2>
              {(results ?? []).map((r) => (
                <ArticleCard key={r.id} to={articleLink(r)} title={r.title} topic={r.topic} deskName={showDesk ? deskById[r.desk_id]?.name : null}
                  updated={r.drive_modified_at} snippet={r.snippet} />
              ))}
              {results?.length === 0 && <div className="text-gray-600">Nothing matched. Try different words, or ask us below.</div>}
              {!signedIn && hint > 0 && <SignInCard count={hint} color={color} />}
            </>
          )}

          {ready && !q && topic && (
            <>
              <div className="text-sm"><Link to={deskLink(deskSlug, '', null)} className="text-brand font-semibold no-underline">Help center</Link> › {topic}</div>
              <h2 className="font-display text-[24px] m-0">{topic}</h2>
              {topicArticles === null && <div className="text-sm text-gray-400">Loading&hellip;</div>}
              {(topicArticles ?? []).map((a) => (
                <ArticleCard key={a.id} to={articleLink(a)} title={a.title} deskName={showDesk ? deskById[a.desk_id]?.name : null} updated={a.drive_modified_at} />
              ))}
              {topicArticles?.length === 0 && <div className="text-gray-600">No articles in this topic.</div>}
            </>
          )}

          {ready && !q && !topic && (
            <>
              <h2 className="font-display text-[24px] m-0">Recently updated</h2>
              {recent.map((a) => (
                <ArticleCard key={a.id} to={articleLink(a)} title={a.title} topic={a.topic} deskName={showDesk ? deskById[a.desk_id]?.name : null} updated={a.drive_modified_at} />
              ))}
              {recent.length === 0 && !error && (
                <div className="text-gray-600">There are no articles to show yet.{!signedIn && ' Sign in to see articles for staff.'}</div>
              )}
              {!signedIn && recent.length > 0 && <SignInCard color={color} />}
            </>
          )}

          <HelpPanel color={color} supportAddress={supportAddress} q={q} />
        </div>

        <aside className="flex-[1_1_280px] min-w-0 flex flex-col gap-3" aria-label="Topics">
          <h2 className="font-display text-xl m-0">Browse by topic</h2>
          {topicGroups.map((g) => (
            <Link
              key={g.name}
              to={deskLink(deskSlug, '', g.name)}
              className={`flex justify-between gap-3 bg-white border rounded-xl px-4 py-3.5 text-[15px] font-bold text-gray-900 no-underline hover:border-gray-400 ${topic === g.name && !q ? 'border-brand' : 'border-gray-200'}`}
            >
              <span>{g.name}</span><span className="text-gray-500 font-semibold">{g.count}</span>
            </Link>
          ))}
          {ready && topicGroups.length === 0 && <div className="text-sm text-gray-500">No topics yet.</div>}
        </aside>
      </main>

      <ChatLauncher color={color} />
    </AppLayout>
  )
}

function deskLink(deskSlug, q, topic) {
  const p = new URLSearchParams()
  if (q) p.set('q', q)
  if (topic) p.set('topic', topic)
  if (deskSlug) p.set('desk', deskSlug)
  const s = p.toString()
  return s ? `/help?${s}` : '/help'
}

function DeskChip({ label, active, to, color }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'true' : undefined}
      className={`text-[13px] px-3 py-1.5 rounded-full border no-underline ${active ? 'font-bold text-white' : 'font-semibold text-gray-800 border-gray-300 bg-white hover:bg-gray-50'}`}
      style={active ? { background: color, borderColor: color } : undefined}
    >
      {label}
    </Link>
  )
}

function ArticleCard({ to, title, topic, deskName, updated, snippet }) {
  const stale = isStale(updated)
  return (
    <Link to={to} className="block bg-white border border-gray-200 rounded-xl px-5 py-4 no-underline text-gray-900 hover:border-gray-400">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {topic && <span className="font-bold tracking-wider uppercase text-gray-500">{topic}</span>}
        {deskName && <span className="font-bold rounded-full px-2 py-0.5 bg-[#F4EAF3] text-[#6B2169]">{deskName}</span>}
        {updated && <span className="text-gray-500">Updated {formatDate(updated)}</span>}
        {stale && <span className="font-bold rounded-full px-2 py-0.5 bg-[#FFF1D1] text-[#7A4F00]">May be out of date</span>}
      </div>
      <div className="text-[18px] font-bold text-brand-dark mt-1">{title}</div>
      {snippet && (
        <div className="text-[15px] text-gray-700 mt-1.5 leading-snug">
          {snippetParts(snippet).map((p, i) => p.match
            ? <mark key={i} className="bg-[#FFE9A8] rounded px-0.5">{p.text}</mark>
            : <span key={i}>{p.text}</span>)}
        </div>
      )}
    </Link>
  )
}

function SignInCard({ count, color }) {
  return (
    <div className="bg-white border border-dashed border-gray-300 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
      <div>
        <div className="text-base font-bold">{count ? `${count} more ${count === 1 ? 'result' : 'results'} for signed-in staff` : 'More articles for signed-in staff'}</div>
        <div className="text-sm text-gray-600 mt-0.5">Sign in with your SIL Google account to see them.</div>
      </div>
      <button onClick={signInWithGoogle} className="text-[15px] font-bold text-white rounded-lg px-4 py-2.5" style={{ background: color }}>
        Sign in with Google
      </button>
    </div>
  )
}

export function HelpPanel({ color, supportAddress, q, subject }) {
  if (!CHAT_URL && !supportAddress) return null
  const mail = supportAddress
    ? `mailto:${supportAddress}?subject=${encodeURIComponent(subject ?? (q ? `Help with: ${q}` : 'Help request'))}`
    : null
  return (
    <div className="bg-[#E5EEF8] rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-3.5">
      <div>
        <div className="text-[17px] font-bold text-brand-dark">Didn't find your answer?</div>
        <div className="text-[15px] text-[#26384d]">{CHAT_URL ? 'Ask SIL IT Help, or email us and a person will reply.' : 'Email us and a person will reply.'}</div>
        {supportAddress && <div className="text-sm text-[#26384d] mt-1 select-all">{supportAddress}</div>}
      </div>
      <div className="flex gap-2 flex-wrap">
        {CHAT_URL && <a href={CHAT_URL} target="_blank" rel="noopener noreferrer" className="text-white font-bold text-[15px] rounded-lg px-4 py-2.5 no-underline" style={{ background: color }}>Ask SIL IT Help</a>}
        {mail && <a href={mail} className="bg-white font-bold text-[15px] rounded-lg px-4 py-2.5 no-underline border border-[#B9C7D8] text-brand-dark">Email the help desk</a>}
      </div>
    </div>
  )
}
