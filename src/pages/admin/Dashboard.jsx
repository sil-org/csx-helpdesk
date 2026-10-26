import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useHelpdesk } from '../../context/HelpdeskContext'
import { hd, profilesByIds, findProfileByEmail } from '../../lib/helpdesk'

// Admin desks (spec section 3 / 13 build-order step 4). Super admins see
// every desk; desk admins see only the ones where agent_desks.role = 'admin'.
export default function AdminDashboard() {
  const { profile } = useAuth()
  const { agentDesks, allDesks, isSuperAdmin, loading } = useHelpdesk()
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

  const desks = isSuperAdmin ? allDesks : agentDesks.filter((d) => d.role === 'admin')
  const sel = desks.find((d) => d.id === selId) ?? desks[0] ?? null

  async function loadPeople(deskId) {
    const { data, error } = await hd.from('agent_desks').select('profile_id, role').eq('desk_id', deskId)
    if (error) { setError(error.message); return }
    setPeople(data ?? [])
    setPeopleProfiles(await profilesByIds((data ?? []).map((p) => p.profile_id)))
  }

  async function loadSettings(deskId) {
    const { data, error } = await hd.from('desk_settings').select('tone_notes, signature').eq('desk_id', deskId).maybeSingle()
    if (error) { setError(error.message); return }
    setSettings(data ?? { tone_notes: null, signature: null })
  }

  async function loadAddresses(deskId) {
    const { data, error } = await hd.from('desk_addresses').select('address, status').eq('desk_id', deskId).order('created_at')
    if (error) { setError(error.message); return }
    setAddresses(data ?? [])
  }

  useEffect(() => {
    if (sel) { loadPeople(sel.id); loadSettings(sel.id); loadAddresses(sel.id) }
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
    <div className="min-h-screen flex flex-col bg-gray-50">
      <div className="flex flex-wrap items-center gap-4 px-6 py-3 bg-white border-b border-gray-200">
        <div className="text-[17px] font-bold">SIL Help Desk &middot; Administration</div>
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
              </div>
              {addresses.map((a) => (
                <div key={a.address} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {a.address}
                    <span className={`ml-2 text-xs font-semibold px-1.5 py-0.5 rounded-full ${a.status === 'receiving' ? 'bg-[#EDF5EA] text-[#38751C]' : 'bg-gray-100 text-gray-500'}`}>
                      {a.status === 'receiving' ? 'receiving' : 'pending'}
                    </span>
                  </span>
                  <button onClick={() => removeAddress(a.address)} className="text-xs text-gray-500 hover:text-red-700">Remove</button>
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
    </div>
  )
}

function Card({ children }) {
  return <div className="bg-white border border-gray-200 rounded-xl p-5 flex flex-col gap-3.5">{children}</div>
}

function Label({ children }) {
  return <div className="text-xs font-semibold tracking-wider uppercase text-gray-500 mb-1.5">{children}</div>
}
