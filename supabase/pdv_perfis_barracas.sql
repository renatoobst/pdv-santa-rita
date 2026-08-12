alter table public.pdv_perfis add column if not exists barracas_permitidas jsonb not null default '[]'::jsonb;
