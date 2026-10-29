-- One-off for a project that already has schema_helpdesk.sql applied:
-- reporter comments from the app (add_reporter_comment) and assignee notices
-- (assignee_notified_at). Both are already in schema_helpdesk.sql for fresh
-- setups. Safe to run more than once.

alter table helpdesk.ticket_messages add column if not exists assignee_notified_at timestamptz;

-- A reporter's comment from the web app (My tickets). Same effect as an
-- emailed reply (ingest_inbound): an inbound public message, the requester
-- reply clock, and a reopen if the ticket was waiting/paused/resolved/closed.
-- A function rather than an insert policy so a reporter can never choose
-- direction, internal, or author — only the body.
create or replace function helpdesk.add_reporter_comment(p_ticket_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_body text := trim(coalesce(p_body, ''));
  v_old_status helpdesk.ticket_status;
  v_email text;
  v_message uuid;
begin
  if not helpdesk.is_ticket_reporter(p_ticket_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_body = '' then
    raise exception 'comment is empty' using errcode = '22023';
  end if;
  if length(v_body) > 10000 then
    raise exception 'comment is too long (10,000 characters max)' using errcode = '22023';
  end if;

  select t.status, r.email into v_old_status, v_email
  from helpdesk.tickets t join helpdesk.requesters r on r.id = t.requester_id
  where t.id = p_ticket_id;

  insert into helpdesk.ticket_messages (ticket_id, direction, author_email, profile_id, body)
  values (p_ticket_id, 'inbound', v_email, public.current_profile_id(), v_body)
  returning id into v_message;

  update helpdesk.tickets set last_requester_reply_at = now() where id = p_ticket_id;
  if v_old_status in ('waiting', 'paused', 'resolved', 'closed') then
    update helpdesk.tickets set status = 'open' where id = p_ticket_id;
    insert into helpdesk.ticket_events (ticket_id, event_type, from_value, to_value, note)
    values (p_ticket_id, 'reopened', v_old_status::text, 'open', 'reopened by reporter comment in the app');
  end if;
  return v_message;
end;
$$;

revoke all on function helpdesk.add_reporter_comment(uuid, text) from public;
grant execute on function helpdesk.add_reporter_comment(uuid, text) to authenticated;
