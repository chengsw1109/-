-- Browser PTT diagnostic telemetry.
-- Browser roles intentionally receive no policies; only the trusted backend
-- service role may read or write these tables.

create table if not exists public.ptt_devices (
  device_id text primary key,
  username text not null,
  device_family text not null default 'unknown',
  browser_family text not null default 'unknown',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.ptt_connection_events (
  id bigint generated always as identity primary key,
  device_id text not null references public.ptt_devices(device_id) on delete cascade,
  username text not null,
  channel_id text,
  session_id text,
  peer_id text,
  event_type text not null,
  network_mode text check (network_mode is null or network_mode in ('lan', 'wan')),
  connection_state text,
  ice_state text,
  candidate_type text,
  remote_candidate_type text,
  protocol text,
  inbound_bytes bigint,
  outbound_bytes bigint,
  packets_received bigint,
  packets_lost bigint,
  error_name text,
  error_message text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ptt_connection_events_created_at_idx
  on public.ptt_connection_events (created_at desc);
create index if not exists ptt_connection_events_device_created_idx
  on public.ptt_connection_events (device_id, created_at desc);
create index if not exists ptt_connection_events_channel_created_idx
  on public.ptt_connection_events (channel_id, created_at desc);
create index if not exists ptt_connection_events_type_created_idx
  on public.ptt_connection_events (event_type, created_at desc);

create table if not exists public.ptt_current_status (
  device_id text not null references public.ptt_devices(device_id) on delete cascade,
  status_key text not null,
  username text not null,
  channel_id text,
  session_id text,
  peer_id text,
  event_type text not null,
  network_mode text check (network_mode is null or network_mode in ('lan', 'wan')),
  connection_state text,
  ice_state text,
  candidate_type text,
  remote_candidate_type text,
  protocol text,
  inbound_bytes bigint,
  outbound_bytes bigint,
  packets_received bigint,
  packets_lost bigint,
  error_name text,
  error_message text,
  updated_at timestamptz not null default now(),
  primary key (device_id, status_key)
);

create index if not exists ptt_current_status_channel_idx
  on public.ptt_current_status (channel_id, updated_at desc);

create table if not exists public.ptt_notifications (
  id bigint generated always as identity primary key,
  channel_id text not null,
  actor text not null default 'MCP administrator',
  message text not null check (char_length(message) between 1 and 500),
  recipient_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists ptt_notifications_created_at_idx
  on public.ptt_notifications (created_at desc);

alter table public.ptt_devices enable row level security;
alter table public.ptt_connection_events enable row level security;
alter table public.ptt_current_status enable row level security;
alter table public.ptt_notifications enable row level security;

revoke all on table public.ptt_devices from anon, authenticated;
revoke all on table public.ptt_connection_events from anon, authenticated;
revoke all on table public.ptt_current_status from anon, authenticated;
revoke all on table public.ptt_notifications from anon, authenticated;

comment on table public.ptt_connection_events is
  'Sanitized Browser PTT connection telemetry; never stores audio, SDP, credentials, or candidate addresses.';
