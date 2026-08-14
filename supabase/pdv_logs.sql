-- Log de eventos do sistema (login, queda/volta de internet, erros) — PDV Santa Rita
--
-- Não existe ferramenta de migrations neste projeto (é um app estático sem
-- backend/build). Este script é pra colar e rodar UMA VEZ no SQL Editor do
-- Supabase, antes de usar a tela "Logs do Sistema" (Master).
--
-- Diferente de `pdv_state` (uma linha só por barraca, sobrescrita a cada
-- ação), aqui cada evento é uma LINHA NOVA (insert, nunca update/delete pelo
-- app) — não tem como um dispositivo "apagar" o log de outro por engano,
-- mesmo sem internet um tempo, porque não existe sobrescrita nenhuma aqui.
--
-- Mesmo modelo de confiança que o resto do app (pdv_state, pdv_perfis): quem
-- tem a chave pública do projeto consegue ler/escrever, RLS não é habilitado.
drop table if exists public.pdv_logs;

create table public.pdv_logs (
  id bigserial primary key,
  criado_em timestamptz not null default now(),
  barraca_id text,
  usuario_id uuid,
  usuario_nome text,
  -- 'login' | 'offline' | 'online' | 'erro'
  tipo text not null,
  tela text,
  detalhe text,
  -- identifica o dispositivo/aba (PDV_CLIENT_ID) que gerou o evento — útil
  -- pra separar "tablet do balcão" de "tablet do pedido" num mesmo relatório.
  client_id text
);

create index pdv_logs_barraca_criado_em_idx on public.pdv_logs (barraca_id, criado_em desc);
create index pdv_logs_tipo_idx on public.pdv_logs (tipo);
