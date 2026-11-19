-- Knowledge base article images: a private bucket whose files follow the
-- article's own visibility.
--
-- Run this whole script once in the Supabase SQL editor, on a project that
-- already has migration_kb_articles.sql. It is complete and safe to run again.
-- Fresh setups do not need this file: schema_helpdesk.sql already includes it.
--
-- Drive's export embeds every image in the Doc's text as base64. The sync takes
-- them out, stores each file in the private `helpdesk-kb` bucket, and writes a
-- row in kb_article_images. A person can read an image exactly when they can
-- read its article: both the table and the storage policies below ask "is the
-- article visible to me?", so one rule (kb_articles_select*) decides everything.
-- The page asks storage for a short-lived signed link per image.

insert into storage.buckets (id, name, public)
values ('helpdesk-kb', 'helpdesk-kb', false)
on conflict (id) do nothing;

create table if not exists helpdesk.kb_article_images (
  storage_path text primary key,
  article_id uuid not null references helpdesk.kb_articles(id) on delete cascade,
  -- The reference the sync replaced in the article text (image1, ...).
  ref text not null,
  mime text not null,
  created_at timestamptz not null default now()
);
create index if not exists kb_article_images_article_idx on helpdesk.kb_article_images(article_id);

alter table helpdesk.kb_article_images enable row level security;

-- The subquery runs under the caller's own row-level rules, so an image row is
-- visible only if its article is.
drop policy if exists kb_article_images_select on helpdesk.kb_article_images;
create policy kb_article_images_select on helpdesk.kb_article_images for select to authenticated, anon
  using (exists (select 1 from helpdesk.kb_articles a where a.id = article_id));

grant select on helpdesk.kb_article_images to anon, authenticated;
grant all on helpdesk.kb_article_images to service_role;

drop policy if exists kb_images_storage_select on storage.objects;
create policy kb_images_storage_select on storage.objects for select to authenticated, anon
  using (
    bucket_id = 'helpdesk-kb'
    and exists (select 1 from helpdesk.kb_article_images i where i.storage_path = storage.objects.name)
  );
