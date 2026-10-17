-- Conversation history, so chats follow the account instead of the browser.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- It is idempotent: safe to re-run.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the schema looks like this
--
-- `owner_key` mirrors `Principal.owner_key` in backend/auth.py exactly — the
-- namespaced `user:<uuid>` or `anon:<token>` string that already scopes
-- documents in Qdrant. Reusing it means there is one definition of "whose data
-- is this" in the whole system rather than two that can drift apart.
--
-- The primary key is (owner_key, id), not id. Conversation ids are generated in
-- the browser, so two users can independently mint the same one; scoping the key
-- by owner makes a collision impossible and makes every query owner-scoped by
-- construction rather than by remembering a WHERE clause.
--
-- Messages live in a single jsonb column rather than a child table. A
-- conversation is always read and written whole — there is no query that wants
-- one message — so a join would buy nothing and cost a write amplification on
-- every turn.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.conversations (
  owner_key   text        not null,
  id          text        not null,
  title       text        not null default 'New chat',
  messages    jsonb       not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (owner_key, id)
);

-- The only read pattern: "this owner's conversations, newest first".
create index if not exists conversations_owner_updated_idx
  on public.conversations (owner_key, updated_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Access control
--
-- RLS is enabled with NO policies, which denies every request made with the
-- anon or authenticated keys — including one made with a leaked anon key from
-- the browser. The service role bypasses RLS by design, and it is the only
-- credential the backend uses for this table.
--
-- That is deliberate: ownership is decided in backend/auth.py from a verified
-- JWT or a server-issued cookie, never from anything the client can set. Adding
-- a permissive policy here would create a second, weaker path to the same rows.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.conversations enable row level security;

-- Keep `updated_at` honest even if a row is ever touched outside the API.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists conversations_touch_updated_at on public.conversations;
create trigger conversations_touch_updated_at
  before update on public.conversations
  for each row execute function public.touch_updated_at();
