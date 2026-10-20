-- M'LANG customer and order storage. Run once in Supabase SQL Editor.
create table if not exists public.store_users (
  id uuid primary key,
  name text not null,
  email text not null unique,
  salt text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.store_orders (
  id text primary key,
  customer_email text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists store_orders_customer_email_idx
  on public.store_orders (customer_email, created_at desc);

alter table public.store_users enable row level security;
alter table public.store_orders enable row level security;

revoke all on table public.store_users from anon, authenticated;
revoke all on table public.store_orders from anon, authenticated;
grant select, insert, update, delete on table public.store_users to service_role;
grant select, insert, update, delete on table public.store_orders to service_role;
