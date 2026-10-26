import { STATUS_STYLE, STATUS_LABEL } from '../lib/helpdesk'

export default function StatusPill({ status, label }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.new
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.fg }}
    >
      <i className="w-2 h-2 rounded-full inline-block" style={{ background: s.dot }} />
      {label ?? STATUS_LABEL[status] ?? status}
    </span>
  )
}
