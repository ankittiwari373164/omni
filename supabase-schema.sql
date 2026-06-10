-- ============================================================
-- Flow Studio — Supabase schema
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query)
-- ============================================================

-- ---------- CLIENTS ----------
create table if not exists clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  business_details text,                 -- free-text brief used by Groq for prompts
  cookies         jsonb,                 -- exported Google Flow cookies (array)
  frame_path      text,                  -- stored filename of the frame PNG overlay
  outro_path      text,                  -- stored filename of the outro video clip
  -- delivery config
  upload_to_drive   boolean default true,
  drive_folder_id   text,                -- target Google Drive folder id (optional)
  upload_to_youtube boolean default false,
  youtube_tokens    jsonb,               -- OAuth tokens { access_token, refresh_token, ... }
  yt_default_tags   text,                -- comma separated default tags
  created_at      timestamptz default now()
);

-- ---------- CONTENT CALENDAR ----------
create table if not exists calendar_items (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  scheduled_date date,
  topic         text not null,           -- short idea/title for the day
  hook          text,                    -- optional one-line hook/angle
  prompt        text,                    -- generated Flow prompt (10s, Omni)
  status        text default 'planned',  -- planned | prompt_ready | generating | done
  created_at    timestamptz default now()
);

-- ---------- VIDEOS ----------
create table if not exists videos (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id) on delete cascade,
  calendar_item_id uuid references calendar_items(id) on delete set null,
  prompt           text,
  raw_file         text,                 -- generated (pre-composite) filename
  final_file       text,                 -- framed + outro composited filename
  -- publishing
  title            text,
  description      text,
  hashtags         text,
  tags             text,
  drive_url        text,
  youtube_url      text,
  status           text default 'pending', -- pending|generating|composited|uploaded|error
  error            text,
  created_at       timestamptz default now()
);

create index if not exists idx_calendar_client on calendar_items(client_id);
create index if not exists idx_videos_client  on videos(client_id);

-- NOTE: This app uses the Supabase SERVICE ROLE key on the server only,
-- so Row Level Security is not required. If you expose the anon key to a
-- browser, enable RLS and add policies. Keep the service role key secret.
