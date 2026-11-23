import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { headingId } from '../lib/kbText'

// Renders an article's markdown. react-markdown does not render raw HTML, so
// article text cannot inject markup or scripts. The only extra link scheme
// allowed is kb-image:, which the sync writes for images in the private bucket;
// `imageUrls` maps each stored path to a short-lived signed link.

function urlTransform(url, key, node) {
  if (key === 'src' && node.tagName === 'img' && url.startsWith('kb-image:')) return url
  return defaultUrlTransform(url)
}

function textOf(children) {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(textOf).join('')
  return children?.props?.children ? textOf(children.props.children) : ''
}

export default function KbMarkdown({ body, imageUrls = {} }) {
  const components = {
    // Four distinct levels, per the SIL branding doc's heading styles: H1
    // (Playfair, SIL Light Blue), H2 (Source Sans, all-caps, SIL Orange, a
    // section label rather than a big headline), H3 (Playfair italic bold,
    // SIL Darker Blue), H4 (Source Sans italic semibold, black).
    h1: ({ children }) => <h1 id={headingId(textOf(children))} className="font-display text-[28px] leading-tight font-semibold text-sil-light-blue mt-8 mb-3 scroll-mt-6">{children}</h1>,
    h2: ({ children }) => <h2 id={headingId(textOf(children))} className="font-sans text-sm font-bold uppercase tracking-wider text-sil-orange border-b border-gray-200 pb-1.5 mt-8 mb-3 scroll-mt-6">{children}</h2>,
    h3: ({ children }) => <h3 id={headingId(textOf(children))} className="font-display italic text-lg font-bold text-brand-dark mt-6 mb-2 scroll-mt-6">{children}</h3>,
    h4: ({ children }) => <h4 className="font-sans italic text-base font-semibold text-gray-900 mt-5 mb-2">{children}</h4>,
    p: ({ children }) => <p className="my-3 leading-relaxed">{children}</p>,
    ul: ({ children }) => <ul className="list-disc pl-6 my-3 flex flex-col gap-1.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-6 my-3 flex flex-col gap-1.5">{children}</ol>,
    blockquote: ({ children }) => <blockquote className="border-l-4 border-gray-200 pl-4 my-4 text-gray-700">{children}</blockquote>,
    hr: () => <hr className="my-6 border-gray-200" />,
    a: ({ href, children }) => {
      // Google Docs bookmarks and language switchers export as links with no
      // target; show their text instead of a link that does nothing.
      if (!href) return <span>{children}</span>
      const external = /^https?:/i.test(href ?? '')
      return (
        <a href={href} className="text-brand underline" {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
          {children}
        </a>
      )
    },
    img: ({ src, alt }) => {
      if (src?.startsWith('kb-image:')) {
        const url = imageUrls[src.slice('kb-image:'.length)]
        return url
          ? <img src={url} alt={alt ?? ''} loading="lazy" className="max-w-full h-auto rounded-lg border border-gray-200 my-3" />
          : <span className="inline-block text-sm text-gray-500 border border-dashed border-gray-300 rounded px-2 py-1 my-2">(image loading)</span>
      }
      return <img src={src} alt={alt ?? ''} loading="lazy" className="max-w-full h-auto my-3" />
    },
    table: ({ children }) => <div className="overflow-x-auto my-4"><table className="border-collapse text-[15px]">{children}</table></div>,
    th: ({ children }) => <th className="border border-gray-200 bg-gray-50 px-3 py-2 text-left font-semibold align-top">{children}</th>,
    td: ({ children }) => <td className="border border-gray-200 px-3 py-2 align-top">{children}</td>,
    pre: ({ children }) => <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 my-4 overflow-x-auto text-sm">{children}</pre>,
    code: ({ className, children }) => className
      ? <code className={className}>{children}</code>
      : <code className="bg-gray-100 text-gray-900 rounded px-1.5 py-0.5 text-[0.9em]">{children}</code>,
  }

  return (
    <div className="text-[17px] text-gray-800 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  )
}
