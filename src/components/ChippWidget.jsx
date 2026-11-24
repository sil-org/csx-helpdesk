import { useEffect } from 'react'

const SCRIPT_SRC = 'https://sil-logins-help.on.chipp.ai/w/chat/chipp-widget.js'
const APP_ID = 'sil-logins-help'

// The Chipp "sil-logins-help" chat widget: a live assistant for people who
// can't sign in. Only rendered on pages a signed-out visitor can reach (Home,
// and the Help Center when nobody is signed in) — the widget injects its own
// floating launcher, so nothing else renders here.
export default function ChippWidget() {
  useEffect(() => {
    if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.dataset.appId = APP_ID
    script.async = true
    document.body.appendChild(script)
  }, [])
  return null
}
