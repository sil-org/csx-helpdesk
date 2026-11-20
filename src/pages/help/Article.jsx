import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { signInWithGoogle } from '../../lib/auth'
import AppLayout from '../../components/AppLayout'
import { getReporterLinks } from '../../navLinks'
import KbMarkdown from '../../components/KbMarkdown'
import ChatLauncher from '../../components/ChatLauncher'
import { HelpPanel } from './HelpCenter'
import {
  DEFAULT_COLOR, formatDate, imagePathsIn, isStale, listArticles, loadArticle, loadKbDesks,
  outline, signedImageUrls, stripLeadingTitle,
} from '../../lib/kb'

// One article (design board 3). The text comes from the desk's Drive Doc via
// the sync; images are in a private bucket, so each needs a signed link.
export default function Article() {
  const { deskSlug, articleSlug } = useParams()
  const { session, profile, loading: authLoading } = useAuth()
  const signedIn = !!session && !!profile

  const [desk, setDesk] = useState(null)
  const [article, setArticle] = useState(undefined) // undefined = loading, null = not found
  const [siblings, setSiblings] = useState([])
  const [imageUrls, setImageUrls] = useState({})
  const [error, setError] = useState(null)

  useEffect(() => {
    if (authLoading) return
    let cancelled = false
    setArticle(undefined); setImageUrls({}); setError(null); setSiblings([])
    ;(async () => {
      try {
        const desks = await loadKbDesks()
        const d = desks.find((x) => x.slug === deskSlug) ?? null
        const a = d ? await loadArticle(d.id, articleSlug) : null
        if (cancelled) return
        setDesk(d); setArticle(a)
        if (!a) return
        const [urls, others] = await Promise.all([
          signedImageUrls(imagePathsIn(a.body)).catch(() => ({})),
          a.topic ? listArticles({ topic: a.topic, deskId: d.id }) : Promise.resolve([]),
        ])
        if (cancelled) return
        setImageUrls(urls); setSiblings(others)
      } catch (e) {
        if (!cancelled) { setError(e.message); setArticle(null) }
      }
    })()
    return () => { cancelled = true }
  }, [deskSlug, articleSlug, authLoading, signedIn])

  const color = desk?.theme_primary || DEFAULT_COLOR
  const body = useMemo(() => (article ? stripLeadingTitle(article.body, article.title) : ''), [article])
  const toc = useMemo(() => outline(body), [body])
  const unpublished = article && (article.is_draft || article.archived)

  return (
    <AppLayout desk={desk} links={getReporterLinks({ signedIn })}>
      <div className="max-w-[1180px] mx-auto px-6 pt-7 pb-24 flex flex-wrap gap-9 items-start">
        {article && siblings.length > 1 && (
          <nav className="flex-[0_1_230px] min-w-[200px] flex flex-col gap-1" aria-label={article.topic}>
            <div className="text-xs font-bold tracking-wider uppercase text-gray-500 px-3 pb-1.5">{article.topic}</div>
            {siblings.map((s) => (
              <Link
                key={s.id}
                to={`/help/${deskSlug}/${s.slug}`}
                aria-current={s.id === article.id ? 'page' : undefined}
                className={`px-3 py-2 rounded-lg text-[15px] no-underline ${s.id === article.id ? 'font-bold bg-[#E5EEF8] text-brand-dark' : 'font-semibold text-gray-800 hover:bg-gray-100'}`}
              >
                {s.title}
              </Link>
            ))}
          </nav>
        )}

        <article className="flex-[999_1_520px] min-w-0 max-w-[720px] flex flex-col gap-5">
          {article === undefined && <div className="text-sm text-gray-400">Loading&hellip;</div>}
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>}

          {article === null && !error && <NotFound signedIn={signedIn} color={color} />}

          {article && (
            <>
              <div className="text-sm text-gray-600">
                <Link to="/help" className="text-brand font-semibold no-underline">Help center</Link>
                {article.topic && <> › <Link to={`/help?topic=${encodeURIComponent(article.topic)}`} className="text-brand font-semibold no-underline">{article.topic}</Link></>}
              </div>
              <div className="flex flex-col gap-2.5">
                <h1 className="font-display text-[34px] leading-tight m-0 text-balance">{article.title}</h1>
                <div className="flex flex-wrap items-center gap-3 text-[13px] text-gray-500">
                  {article.drive_modified_at && <span>Updated {formatDate(article.drive_modified_at)}</span>}
                  {isStale(article.drive_modified_at) && <span className="font-bold rounded-full px-2 py-0.5 bg-[#FFF1D1] text-[#7A4F00]">May be out of date</span>}
                  {article.tier === 'agents' && <span className="font-bold rounded-full px-2 py-0.5 bg-gray-200 text-gray-800">Agents only</span>}
                </div>
              </div>

              {unpublished && (
                <div className="text-sm bg-[#FFF4DC] text-[#4d3500] rounded-lg px-4 py-3">
                  {article.is_draft ? 'This is a draft.' : 'This article is archived.'} Only agents can see it; requesters cannot.
                </div>
              )}

              <div className="bg-white border border-gray-200 rounded-xl px-8 py-6">
                <KbMarkdown body={body} imageUrls={imageUrls} />
              </div>

              <HelpPanel color={color} supportAddress={desk?.support_address} subject={`Help with: ${article.title}`} />
            </>
          )}
        </article>

        {toc.length > 1 && (
          <nav className="flex-[0_1_220px] min-w-[180px] flex flex-col gap-2" aria-label="On this page">
            <div className="text-xs font-bold tracking-wider uppercase text-gray-500">On this page</div>
            {toc.map((h) => (
              <a key={h.id + h.text} href={`#${h.id}`} className={`text-sm font-semibold text-gray-700 no-underline border-l-2 border-gray-200 hover:border-gray-500 ${h.level === 3 ? 'pl-5' : 'pl-3'}`}>
                {h.text}
              </a>
            ))}
          </nav>
        )}
      </div>

      <ChatLauncher color={color} />
    </AppLayout>
  )
}

function NotFound({ signedIn, color }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6 flex flex-col gap-3">
      <h1 className="font-display text-2xl m-0">We couldn't find that article</h1>
      <p className="m-0 text-gray-700">It may have been moved or removed{signedIn ? '' : ', or it may be for signed-in staff'}.</p>
      <div className="flex gap-3 flex-wrap">
        <Link to="/help" className="font-bold text-brand no-underline">Search the help center</Link>
        {!signedIn && (
          <button onClick={signInWithGoogle} className="text-sm font-bold text-white rounded-lg px-4 py-2" style={{ background: color }}>
            Sign in with Google
          </button>
        )}
      </div>
    </div>
  )
}
