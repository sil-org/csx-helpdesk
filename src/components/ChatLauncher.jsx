// "Ask SIL IT Help": the floating button from the designs. The assistant is a
// Chipp agent. Until the embed snippet is available it opens the agent in a new
// tab; set VITE_CHIPP_URL to the agent's address to turn it on. With no address
// set nothing is shown, so the help center never advertises a chat that is not
// there. Which agent signed-in requesters get, and whether the chat can sit in
// a panel on the page, are still open (see the design canvas notes).
export const CHAT_URL = import.meta.env.VITE_CHIPP_URL || ''

export default function ChatLauncher({ color = '#005CB9' }) {
  if (!CHAT_URL) return null
  return (
    <a
      href={CHAT_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed right-6 bottom-6 z-20 flex items-center gap-2 rounded-full text-white font-bold text-[15px] pl-4 pr-5 h-[52px] shadow-lg no-underline"
      style={{ background: color }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
      </svg>
      Ask SIL IT Help
    </a>
  )
}
