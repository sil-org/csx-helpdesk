# Unified Help Desk & Ticketing Platform — Project Brief for Build

**Status:** Pre-build. Strategic questions below are still being resolved with stakeholders — treat this as a strong architecture direction, not a locked spec. Confirm with Kate before assuming any open item is settled.

---

## 1. Context

SIL runs help desk support across multiple departments (Dallas, Africa, Global IT, others TBD) on different tools:
- **Dallas:** ServiceNow
- **Global IT:** mix of Freshdesk and YouTrack
- **Other departments:** current system unconfirmed

Volume is ~800 tickets/year total across all departments — low enough that per-seat licensing (Freshdesk) and complex platforms (YouTrack) are a poor fit. This has reportedly been attempted before as a "combine the helpdesks" effort; **it's not yet confirmed whether prior attempts failed for tooling reasons or organizational/ownership reasons.** That answer may change scope — flag if it surfaces mid-build.

## 2. Tech Stack (extending existing BTC Abstracts architecture)

- **Frontend:** React
- **Backend:** Node
- **Database:** Supabase (Postgres), including `pgvector` extension for embeddings/similarity search
- **Auth:** Supabase Auth
  - SIL staff: Google OAuth restricted to SIL domain(s)
  - Non-SIL requesters (optional): magic link auth
- **Email:** Gmail API against a single licensed mailbox with multiple department aliases (e.g. `help-dallas@sil.org`, `help-africa@sil.org`), NOT domain-wide delegation — use per-mailbox OAuth (3-legged, one-time consent) to avoid the blast radius of DWD. Do not use `Google_admin@sil.org` as the mailbox.
- **Embeddings:** Voyage AI (Anthropic's recommended pairing) or equivalent, stored via `pgvector`
- **AI drafting:** Claude API, context-injected from corpus retrieval

## 3. Data Model (conceptual — refine in implementation)

**Core entities:**
- `desks` — one row per department (Dallas, Africa, Global, etc.), holds per-desk settings
- `tickets` — `current_desk_id`, `status`, `requester_id`, `sender_email`, `created_at`, `paused_until`, etc.
- `ticket_messages` — threaded messages (inbound/outbound), flagged `internal` (staff-only) vs. requester-facing
- `ticket_events` — audit log: reassignments, status changes, merges, pauses (who/what/when/why)
- `requesters` — actual problem-owner, distinct from `sender_email` on the raw inbound message
- `corpus_documents` — resolved tickets + documentation, each with `embedding`, `source_type` (`resolved_ticket` | `documentation`), `source_desk`, `source_system` (for migrated content)
- `desk_settings` — business hours (per-desk, e.g. 9–5 local time), follow-up nudge day threshold (X), auto-close day threshold (Y)

## 4. Statuses

`Open`, `Waiting` (on requester only — no "waiting on other desk" state), `Solved`, `Closed`, `Paused`

- **Reassignment** to another desk = full ownership handoff. No shared/blocked state between desks.
- **Pause until date Z** — freezes the SLA/response clock entirely; ticket auto-resumes to `Open` on date Z (not a "just resumed" flag — goes straight into the normal active queue).

## 5. Key Behavioral Rules

**Requester vs. sender:**
- Every ticket tracks `sender_email` (who the email literally came from) separately from `requester` (who has the actual problem).
- Detect likely forwards (parse for `---------- Forwarded message ---------`-style headers) and **suggest** a requester correction to the agent — do not auto-commit. Agent confirms or edits manually.
- The forwarding agent does **not** automatically become a ticket watcher.

**Duplicate/related tickets:**
- Related-but-distinct tickets: linked, not merged.
- Same requester + same issue: system suggests a merge; merging is a manual, agent-confirmed action — never automatic.

**Internal notes:**
- Staff-only notes field, never emailed to the requester, and explicitly **excluded from the RAG corpus** used for requester-facing autodraft generation.

**Follow-up / auto-close:**
- After X days of requester silence following an agent reply → automatic "still need help?" nudge. X is per-desk configurable.
- After a further Y days of continued silence → auto-close. Y is per-desk configurable.

**SLA/business hours:**
- Each desk sets its own business hours (default assumption: 9–5 desk-local time).
- Response-time/SLA clocks run only during those hours, not a flat 24-hour clock.

## 6. AI-Assisted Response (RAG)

- **Shared corpus across all desks** — every desk's resolved tickets + documentation feed one searchable pool (tagged by source desk for provenance), so any desk benefits from every other desk's history.
- **Retrieval:** embed incoming ticket text, similarity-search `pgvector` for top matches, inject into Claude API context for drafting.
- **Confidence tiers — START CONSERVATIVE, ramp up later:**
  - **v1 launch:** all AI output is a **draft only** — agent reviews/edits/sends. Nothing auto-sends.
  - **Later phase (not v1):** high-confidence matches may auto-send directly to the requester with a confirmation ask ("this solved it" / "I still need help" links, backed by signed tokens). No click = ticket stays open in an `Auto-Answered`-type state, not silently closed. This tier is explicitly deferred — do not build the auto-send path into v1 scope.
- **Language detection:** tag tickets with detected language for routing/visibility and to improve corpus matching (does not require full translation infra for v1).
- **Outbound translation:** optional, DeepL-API-powered, one-click translate on an approved draft before sending — v1-plus, not core.

## 7. AWS-Generated Tickets

- These always trigger an existing boilerplate automated action on arrival (already defined outside this system) — log that action on the ticket.
- If the automated action doesn't resolve the issue, escalate into the normal human queue, with the automation's action history attached as context for the agent.

## 8. Migration (per-system — do NOT assume one common source)

- **Do not migrate open/in-progress tickets.** Each department finishes out open tickets in its *current* system; new tickets start fresh in the new platform from that department's go-live date.
- **Do migrate historical closed/resolved tickets into the corpus only** (not as live tickets), per source system:
  - Dallas: ServiceNow export (API/CSV — confirm ServiceNow export mechanism and any admin access needed)
  - Global IT: YouTrack REST API export; also check Freshdesk if still relevant
  - Other departments: system TBD — do not assume ServiceNow or YouTrack applies universally
- Documentation (wherever hosted per department — wiki, Drive, help site) also feeds the corpus, tagged `source_type: documentation`.

## 9. Explicit Non-Goals for v1

- No live migration of open tickets from any legacy system
- No auto-send AI responses (draft-only for v1 — see Section 6)
- No full outbound translation pipeline (detection only, translation is a stretch goal)
- No public self-service portal beyond email + optional magic link status check

## 10. Open Strategic Questions (do not treat as resolved)

These came from stakeholder feedback and materially affect scope/pitch — confirm with Kate before assuming direction:

1. **Why this, why now?** Purpose/ROI (time savings, cost savings, cross-department escalation, something no prior tool hit) is not yet nailed down — placeholder goals in earlier drafts were "generic combined-helpdesk" goals, not a differentiated pitch.
2. **Root cause of prior combined-helpdesk attempts not sticking** — was it tooling limitations (fixable by custom build) or organizational/ownership resistance (not fixable by better software alone)? This determines whether this project's premise is even sound.
3. **What's the concrete advantage of pooling resources** vs. each department improving their own current tool independently? (Partial answer drafted: shared engineering effort, compounding RAG corpus value, no duplicated licensing — but needs stakeholder buy-in, not just architecture logic.)

**Recommendation for whoever picks this up in Claude Code:** the architecture and data model above are solid regardless of how the strategic questions resolve — build order can start with core ticketing (Section 4-5) and RAG (Section 6) since those are useful even if scope narrows later. Hold off on deep AWS-ticket integration (Section 7) and multi-system migration tooling (Section 8) until desk participation is confirmed, since those are the most department-specific and highest cost to build speculatively.
