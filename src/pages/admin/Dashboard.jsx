import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import AppLayout from '../../components/AppLayout'
import { useAuth } from '../../context/AuthContext'
import { useHelpdesk } from '../../context/HelpdeskContext'
import { getLinks } from '../../navLinks'
import { hd, profilesByIds, findProfileByEmail } from '../../lib/helpdesk'

// Admin desks (spec section 3 / 13 build-order step 4). Super admins see
// every desk; desk admins see only the ones where agent_desks.role = 'admin'.
export default function AdminDashboard() {
  const { profile } = useAuth()
  const { agentDesks, allDesks, isSuperAdmin, loading } = useHelpdesk()
  const [params] = useSearchParams()
  const [selId, setSelId] = useState(null)
  const [people, setPeople] = useState([])
  const [peopleProfiles, setPeopleProfiles] = useState({})
  const [addEmail, setAddEmail] = useState('')
  const [error, setError] = useState(null)
  const [savingField, setSavingField] = useState(null)
  const [settings, setSettings] = useState(null)
  const [creatingDesk, setCreatingDesk] = useState(false)
  const [newDeskName, setNewDeskName] = useState('')
  const [newDeskSlug, setNewDeskSlug] = useState('')
  const [newDeskAddress, setNewDeskAddress] = useState('')
  const [creating, setCreating] = useState(false)
  const [addresses, setAddresses] = useState([])
  const [newAddress, setNewAddress] = useState('')
  const [kb, setKb] = useState(null) // { refreshedAt, sharing: [{id, name}], usedIds: Set }

  const desks = isSuperAdmin ? allDesks : agentDesks.filter((d) => d.role === 'admin')
  // Arriving via the sidebar's "Admin" link from a desk's Queue/Ticket page
  // carries that desk's slug (?desk=) so Admin opens on the same desk
  // instead of always defaulting to the first one alphabetically.
  const sel = desks.find((d) => d.id === selId)
    ?? desks.find((d) => d.slug === params.get('desk'))
    ?? desks[0] ?? null

  async function loadPeople(deskId) {
    const { data, error } = await hd.from('agent_desks').select('profile_id, role').eq('desk_id', deskId)
    if (error) { setError(error.message); return }
    setPeople(data ?? [])
    setPeopleProfiles(await profilesByIds((data ?? []).map((p) => p.profile_id)))
  }

  async function loadSettings(deskId) {
    const { data, error } = await hd.from('desk_settings').select('tone_notes, signature, kb_doc_id, kb_shared').eq('desk_id', deskId).maybeSingle()
    if (error) { setError(error.message); return }
    setSettings(data ?? { tone_notes: null, signature: null, kb_doc_id: null, kb_shared: false })
  }

  // Which other desks are sharing a KB, which of them this desk uses, and
  // when this desk's own KB Doc was last read.
  async function loadKb(deskId) {
    const [cache, ids, used] = await Promise.all([
      hd.from('desk_kb_cache').select('refreshed_at').eq('desk_id', deskId).maybeSingle(),
      hd.rpc('shared_kb_desk_ids'),
      hd.from('desk_kb_sources').select('source_desk_id').eq('desk_id', deskId),
    ])
    const failed = cache.error || ids.error || used.error
    if (failed) { setError(failed.message); return }
    const otherIds = (ids.data ?? []).filter((id) => id !== deskId)
    let sharing = []
    if (otherIds.length) {
      const { data: names, error } = await hd.from('desks').select('id, name').in('id', otherIds).order('name')
      if (error) { setError(error.message); return }
      sharing = names ?? []
    }
    setKb({
      refreshedAt: cache.data?.refreshed_at ?? null,
      sharing,
      usedIds: new Set((used.data ?? []).map((r) => r.source_desk_id)),
    })
  }

  async function setUsesSource(sourceDeskId, uses) {
    setError(null)
    const { error } = uses
      ? await hd.from('desk_kb_sources').insert({ desk_id: sel.id, source_desk_id: sourceDeskId })
      : await hd.from('desk_kb_sources').delete().eq('desk_id', sel.id).eq('source_desk_id', sourceDeskId)
    if (error) setError(error.message); else loadKb(sel.id)
  }

  // Accepts a Doc link or a bare Doc ID. Only a super admin can save this
  // (the database enforces it): the app's service account can read any Doc
  // it has been given, so the ID is what decides whose KB a desk reads.
  async function saveKbDoc(value) {
    const v = value.trim()
    const id = v ? (v.match(/\/document\/d\/([\w-]+)/)?.[1] ?? v) : null
    if (id === (settings.kb_doc_id ?? null)) return
    await updateSettings({ kb_doc_id: id })
    loadKb(sel.id)
  }

  async function loadAddresses(deskId) {
    const { data, error } = await hd.from('desk_addresses')
      .select('address, status, live_replies, is_default_reply').eq('desk_id', deskId).order('created_at')
    if (error) { setError(error.message); return }
    setAddresses(data ?? [])
  }

  async function setLiveReplies(address, live_replies) {
    setError(null)
    const { error } = await hd.from('desk_addresses').update({ live_replies }).eq('address', address)
    if (error) setError(error.message); else loadAddresses(sel.id)
  }

  async function setDefaultReply(address) {
    setError(null)
    // Only one default per desk (desk_addresses_one_default_idx) — clear the
    // old one first so the unique index doesn't reject the new one.
    await hd.from('desk_addresses').update({ is_default_reply: false }).eq('desk_id', sel.id).eq('is_default_reply', true)
    const { error } = await hd.from('desk_addresses').update({ is_default_reply: true }).eq('address', address)
    if (error) setError(error.message); else loadAddresses(sel.id)
  }

  useEffect(() => {
    if (sel) { loadPeople(sel.id); loadSettings(sel.id); loadAddresses(sel.id); loadKb(sel.id) }
  }, [sel?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Every desk address is globally unique (desk_addresses.address is the
  // primary key — an address can only ever ingest into one desk), so this
  // is the one error worth a friendlier message than the raw Postgres one.
  function friendlyAddressError(err) {
    return err.code === '23505' ? 'That address is already assigned to another desk.' : err.message
  }

  async function addAddress() {
    const address = newAddress.trim().toLowerCase()
    if (!address) return
    setError(null)
    const { error } = await hd.from('desk_addresses').insert({ address, desk_id: sel.id })
    if (error) setError(friendlyAddressError(error)); else { setNewAddress(''); loadAddresses(sel.id) }
  }

  async function removeAddress(address) {
    setError(null)
    const { error } = await hd.from('desk_addresses').delete().eq('address', address)
    if (error) setError(error.message); else loadAddresses(sel.id)
  }

  async function updateSettings(fields) {
    setSavingField(Object.keys(fields)[0])
    const { error } = await hd.from('desk_settings').update(fields).eq('desk_id', sel.id)
    setSavingField(null)
    if (error) setError(error.message); else setSettings((s) => ({ ...s, ...fields }))
  }

  async function updateDesk(fields) {
    setSavingField(Object.keys(fields)[0])
    const { error } = await hd.from('desks').update(fields).eq('id', sel.id)
    setSavingField(null)
    if (error) setError(error.message)
    // allDesks/agentDesks refresh on next HelpdeskProvider reload (profile change);
    // for an immediate reflect we just re-set local desks list isn't tracked here,
    // so a manual page refresh picks it up — acceptable for an admin-only screen.
  }

  function slugify(name) {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  }

  async function createDesk() {
    const name = newDeskName.trim()
    const slug = (newDeskSlug.trim() || slugify(name))
    const address = newDeskAddress.trim().toLowerCase()
    if (!name || !slug) { setError('Name is required.'); return }
    setCreating(true)
    setError(null)

    const { data: desk, error: deskErr } = await hd.from('desks').insert({ slug, name }).select().single()
    if (deskErr) { setCreating(false); setError(deskErr.message); return }

    const { error: settingsErr } = await hd.from('desk_settings').insert({ desk_id: desk.id })
    if (settingsErr) { setCreating(false); setError(settingsErr.message); return }

    if (address) {
      const { error: addrErr } = await hd.from('desk_addresses').insert({ address, desk_id: desk.id })
      if (addrErr) { setCreating(false); setError(friendlyAddressError(addrErr)); return }
    }

    // Make the creator the desk's first admin — set_desk_role requires being
    // a desk admin already, which a super admin always counts as, even on a
    // desk with no agent_desks rows yet (is_desk_admin's super-admin branch).
    const { error: roleErr } = await hd.rpc('set_desk_role', { p_desk_id: desk.id, p_profile_id: profile.id, p_role: 'admin' })
    setCreating(false)
    if (roleErr) { setError(roleErr.message); return }

    // allDesks is loaded once per sign-in by HelpdeskContext; a full reload
    // is the simplest way to pick up the new desk (same tradeoff as above).
    window.location.reload()
  }

  async function setRole(targetProfileId, role) {
    setError(null)
    const { error } = await hd.rpc('set_desk_role', { p_desk_id: sel.id, p_profile_id: targetProfileId, p_role: role })
    if (error) setError(error.message); else loadPeople(sel.id)
  }

  async function addPerson() {
    setError(null)
    const found = await findProfileByEmail(addEmail.trim())
    if (!found) { setError(`No SIL profile found for ${addEmail}. They need to sign in at least once first.`); return }
    await setRole(found.id, 'agent')
    setAddEmail('')
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading&hellip;</div>

  if (!desks.length && !isSuperAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm px-4 text-center">
        You're not a desk admin or super admin on any desk.
      </div>
    )
  }

  return (
    <AppLayout desk={sel ?? agentDesks[0]} links={getLinks({ desk: sel ?? agentDesks[0], isDeskAdmin: true, isSuperAdmin })}>
      <div className="flex flex-wrap items-center gap-4 px-6 py-3 bg-white border-b border-gray-200">
        <div className="text-[17px] font-bold">Administration</div>
        <div className="flex-1" />
        <div className="text-sm text-gray-500">{profile?.display_name} &middot; <b className="text-gray-900">{isSuperAdmin ? 'Super admin' : 'Desk admin'}</b></div>
      </div>

      <div className="flex flex-wrap gap-6 p-6 items-start">
        <div className="flex-none w-[300px] flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <h1 className="font-display text-[22px] m-0">Desks</h1>
            {isSuperAdmin && (
              <button onClick={() => setCreatingDesk((o) => !o)} className="min-h-[36px] px-3 bg-brand text-white rounded-lg text-sm font-semibold">
                {creatingDesk ? 'Cancel' : 'New desk'}
              </button>
            )}
          </div>

          {creatingDesk && (
            <div className="bg-white border border-gray-300 rounded-xl p-3.5 flex flex-col gap-2.5">
              <div>
                <Label>Name</Label>
                <input
                  value={newDeskName}
                  onChange={(e) => setNewDeskName(e.target.value)}
                  placeholder="Dallas Help Desk"
                  className="min-h-[40px] w-full px-2.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <Label>Slug</Label>
                <input
                  value={newDeskSlug}
                  onChange={(e) => setNewDeskSlug(e.target.value)}
                  placeholder={slugify(newDeskName) || 'dallas'}
                  className="min-h-[40px] w-full px-2.5 border border-gray-300 rounded-lg text-sm"
                />
                <div className="text-xs text-gray-500 mt-1">Used in the URL (/d/&lt;slug&gt;). Defaults from the name if left blank.</div>
              </div>
              <div>
                <Label>Incoming address (optional)</Label>
                <input
                  value={newDeskAddress}
                  onChange={(e) => setNewDeskAddress(e.target.value)}
                  placeholder="dallas-help@sil.org"
                  className="min-h-[40px] w-full px-2.5 border border-gray-300 rounded-lg text-sm"
                />
                <div className="text-xs text-gray-500 mt-1">Can add or change addresses later; also still needs adding to that address's Google Group (SETUP.md step 9c).</div>
              </div>
              <button
                onClick={createDesk}
                disabled={creating || !newDeskName.trim()}
                className="min-h-[40px] px-3 bg-brand text-white rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create desk'}
              </button>
            </div>
          )}

          {desks.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelId(d.id)}
              className={`flex items-center gap-3 w-full min-h-[44px] px-3 py-2.5 border rounded-xl bg-white text-left text-sm ${sel?.id === d.id ? 'border-gray-900 ring-1 ring-gray-900' : 'border-gray-300 hover:border-brand'}`}
            >
              <span className="w-9 h-9 rounded-lg flex-none flex items-center justify-center text-white font-bold text-sm" style={{ background: d.theme_primary || '#005CB9' }}>
                {d.name[0]}
              </span>
              <span className="min-w-0">
                <b className="block truncate">{d.name}</b>
                <span className="text-xs text-gray-500">{d.accepts_transfers ? 'accepts transfers' : 'no transfers'}</span>
              </span>
            </button>
          ))}
          <div className="text-xs text-gray-500 leading-relaxed">
            {isSuperAdmin ? 'Only super admins can create or delete desks (via the SQL editor for now).' : 'Desk admins only see their own desk here.'}
          </div>
        </div>

        {sel && (
          <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3.5">
              <span className="w-12 h-12 rounded-[10px] flex items-center justify-center text-white font-bold text-lg" style={{ background: sel.theme_primary || '#005CB9' }}>
                {sel.name[0]}
              </span>
              <h2 className="font-display text-2xl m-0">{sel.name}</h2>
            </div>

            {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>}

            <Card>
              <div className="text-base font-bold">Branding &amp; settings</div>
              <div className="flex flex-wrap gap-5">
                <div className="flex-1 min-w-[220px]">
                  <Label>Logo URL</Label>
                  <input
                    defaultValue={sel.logo_url ?? ''}
                    onBlur={(e) => updateDesk({ logo_url: e.target.value || null })}
                    placeholder="https://..."
                    className="min-h-[40px] w-full px-2.5 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
                <div className="flex-1 min-w-[220px]">
                  <Label>Primary color</Label>
                  <div className="flex items-center gap-2.5">
                    <span className="w-9 h-9 rounded-lg border border-gray-300" style={{ background: sel.theme_primary || '#005CB9' }} />
                    <input
                      defaultValue={sel.theme_primary ?? ''}
                      onBlur={(e) => updateDesk({ theme_primary: e.target.value || null })}
                      placeholder="#005CB9 (default SIL Blue)"
                      className="min-h-[40px] w-44 px-2.5 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                </div>
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={sel.accepts_transfers} onChange={(e) => updateDesk({ accepts_transfers: e.target.checked })} className="w-5 h-5" />
                <span className="text-sm">
                  <b>Accept transfers from other desks</b>
                  <div className="text-xs text-gray-500">{sel.accepts_transfers ? 'Agents on other desks can send tickets here.' : 'This desk is hidden from every Transfer menu.'}</div>
                </span>
              </label>
              {savingField && <div className="text-xs text-gray-400">Saving&hellip;</div>}
            </Card>

            <Card>
              <div className="text-base font-bold">Addresses</div>
              <div className="text-xs text-gray-500 -mt-2">
                Mail to any of these ingests into this desk. Each address can only belong to one desk. A new
                address still needs adding to that address's Google Group (SETUP.md step 9c) before mail reaches it.
                "Live replies" controls actual sending (shadow mode until it's on — see spec decision 18); "Default"
                picks which address replies come from when a ticket's own source address isn't registered.
              </div>
              {addresses.map((a) => (
                <div key={a.address} className="flex flex-col gap-1.5 py-2 border-t border-gray-100 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      {a.address}
                      <span className={`ml-2 text-xs font-semibold px-1.5 py-0.5 rounded-full ${a.status === 'receiving' ? 'bg-[#EDF5EA] text-[#38751C]' : 'bg-gray-100 text-gray-500'}`}>
                        {a.status === 'receiving' ? 'receiving' : 'pending'}
                      </span>
                      {a.is_default_reply && (
                        <span className="ml-2 text-xs font-semibold px-1.5 py-0.5 rounded-full bg-[#E5EEF8] text-gray-700">default</span>
                      )}
                    </span>
                    <button onClick={() => removeAddress(a.address)} className="text-xs text-gray-500 hover:text-red-700">Remove</button>
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                      <input type="checkbox" checked={a.live_replies} onChange={(e) => setLiveReplies(a.address, e.target.checked)} className="w-4 h-4" />
                      Live replies
                    </label>
                    {!a.is_default_reply && (
                      <button onClick={() => setDefaultReply(a.address)} className="text-xs text-brand hover:text-brand-dark">Make default</button>
                    )}
                  </div>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  placeholder="helpdesk+fch@sil.org"
                  className="min-h-[40px] flex-1 px-2.5 border border-gray-300 rounded-lg text-sm"
                />
                <button onClick={addAddress} className="min-h-[40px] px-3 border border-gray-300 rounded-lg text-sm">Add</button>
              </div>
            </Card>

            {settings && (
              <Card>
                <div className="text-base font-bold">AI draft defaults</div>
                <div className="text-xs text-gray-500 -mt-2">
                  Every AI-drafted reply for this desk starts from these. An agent can still edit anything before sending.
                </div>
                <div>
                  <Label>House style &amp; facts</Label>
                  <textarea
                    defaultValue={settings.tone_notes ?? ''}
                    onBlur={(e) => updateSettings({ tone_notes: e.target.value || null })}
                    placeholder="e.g. warm but brisk, contraction-heavy; this team administers SIL's Claude/Anthropic account directly, so don't defer to an unnamed third party on those tickets; License Manager has no bulk enrollment..."
                    className="min-h-[110px] w-full px-2.5 py-2 border border-gray-300 rounded-lg text-sm resize-y"
                  />
                </div>
                <div>
                  <Label>Sign-off</Label>
                  <textarea
                    defaultValue={settings.signature ?? ''}
                    onBlur={(e) => updateSettings({ signature: e.target.value || null })}
                    placeholder="Kind regards, SIL Global Help Desk"
                    className="min-h-[60px] w-full px-2.5 py-2 border border-gray-300 rounded-lg text-sm resize-y"
                  />
                </div>
              </Card>
            )}

            {settings && kb && (
              <Card>
                <div className="text-base font-bold">Knowledge base</div>
                <div className="text-xs text-gray-500 -mt-2">
                  This desk&apos;s own Google Doc. AI drafts read it, and the nightly review will suggest improvements to it as comments for you to apply by hand.
                </div>
                <div>
                  <Label>Google Doc</Label>
                  <input
                    key={sel.id}
                    defaultValue={settings.kb_doc_id ?? ''}
                    disabled={!isSuperAdmin}
                    onBlur={(e) => saveKbDoc(e.target.value)}
                    placeholder="Paste the Doc link"
                    className="min-h-[40px] w-full px-2.5 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50 disabled:text-gray-500"
                  />
                  <div className="text-xs text-gray-500 mt-1.5">
                    {isSuperAdmin
                      ? 'Share the Doc with the help desk service account first (comment access is enough).'
                      : 'A super admin sets this, so one desk cannot point at another desk\u2019s Doc.'}
                    {settings.kb_doc_id && (kb.refreshedAt
                      ? ` Last read ${new Date(kb.refreshedAt).toLocaleString()}.`
                      : ' Not read yet; it is read once a day.')}
                  </div>
                </div>
                <div>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={settings.kb_shared}
                      onChange={(e) => updateSettings({ kb_shared: e.target.checked }).then(() => loadKb(sel.id))}
                      className="w-4 h-4 mt-0.5"
                    />
                    <span>
                      <span className="font-semibold">Share this knowledge base with other desks</span>
                      <span className="block text-xs text-gray-500">
                        Desks that choose to use it will have their AI drafts quote it to their own requesters, so treat it as published. Put [no-quote] in a heading to keep that section (and everything under it) out of other desks\u2019 drafts.
                      </span>
                    </span>
                  </label>
                </div>
                <div>
                  <Label>Use another desk&apos;s knowledge base</Label>
                  {kb.sharing.length === 0 ? (
                    <div className="text-sm text-gray-500">No other desk is sharing a knowledge base yet.</div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {kb.sharing.map((d) => (
                        <label key={d.id} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={kb.usedIds.has(d.id)} onChange={(e) => setUsesSource(d.id, e.target.checked)} className="w-4 h-4" />
                          {d.name}
                        </label>
                      ))}
                      <div className="text-xs text-gray-500">This desk&apos;s own knowledge base always wins when they disagree.</div>
                    </div>
                  )}
                </div>
              </Card>
            )}

            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="text-base font-bold">People on this desk</div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  placeholder="name@sil.org"
                  className="min-h-[40px] flex-1 px-2.5 border border-gray-300 rounded-lg text-sm"
                />
                <button onClick={addPerson} className="min-h-[40px] px-3.5 bg-brand text-white rounded-lg text-sm font-semibold">Add person</button>
              </div>
              <div className="flex flex-col">
                {people.map((p) => {
                  const prof = peopleProfiles[p.profile_id]
                  return (
                    <div key={p.profile_id} className="flex items-center gap-3 py-2.5 border-t border-gray-200">
                      <div className="flex-1 min-w-0">
                        <b className="text-sm block truncate">{prof?.display_name ?? p.profile_id}</b>
                        <div className="text-xs text-gray-500">{prof?.primary_email}</div>
                      </div>
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${p.role === 'admin' ? 'bg-gray-900 text-white' : 'bg-[#E5EEF8] text-gray-700'}`}>
                        {p.role === 'admin' ? 'Desk admin' : 'Agent'}
                      </span>
                      <button
                        onClick={() => setRole(p.profile_id, p.role === 'admin' ? 'agent' : 'admin')}
                        className="min-h-[36px] px-3 border border-gray-300 rounded-lg text-sm"
                      >
                        {p.role === 'admin' ? 'Make agent' : 'Make desk admin'}
                      </button>
                      <button
                        onClick={() => setRole(p.profile_id, 'none')}
                        className="min-h-[36px] px-3 border border-gray-300 rounded-lg text-sm text-gray-500 hover:border-red-400 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="text-xs text-gray-500 leading-relaxed">
                Desk admins can promote agents on their own desk. A desk always keeps at least one admin (enforced by <code>set_desk_role</code>).
              </div>
            </Card>
          </div>
        )}
      </div>
    </AppLayout>
  )
}

function Card({ children }) {
  return <div className="bg-white border border-gray-200 rounded-xl p-5 flex flex-col gap-3.5">{children}</div>
}

function Label({ children }) {
  return <div className="text-xs font-semibold tracking-wider uppercase text-gray-500 mb-1.5">{children}</div>
}
