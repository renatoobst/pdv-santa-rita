-- Login e permissões por usuário — PDV Santa Rita
--
-- Não existe ferramenta de migrations neste projeto (é um app estático sem
-- backend/build). Este script é pra colar e rodar UMA VEZ no SQL Editor do
-- Supabase, antes de usar a tela de login do app.
--
-- Login simples, sem Supabase Auth: o próprio app confere usuário/senha
-- contra esta tabela (senha guardada como hash SHA-256, nunca em texto puro
-- — mas sem sessão/JWT de verdade, é o mesmo modelo de confiança que o
-- resto do app já usa em `pdv_state`: quem tem a chave pública do projeto
-- consegue ler/escrever aqui, então RLS não é habilitado, igual às outras
-- tabelas. A proteção real é dentro do app (quem está logado como quê),
-- não criptografia de ponta a ponta.
--
-- Se você já rodou uma versão anterior deste script (a que usava Supabase
-- Auth, com `id references auth.users`), essas duas linhas abaixo limpam
-- aquilo com segurança — nenhuma conta chegou a ser criada com sucesso
-- naquele formato (travava antes de terminar), então não há dado real pra
-- perder aqui.
drop function if exists public.eh_master();
drop table if exists public.pdv_perfis;

create table public.pdv_perfis (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  senha_hash text not null,
  is_master boolean not null default false,
  telas_permitidas jsonb not null default '[]'::jsonb,
  criado_em timestamptz not null default now()
);
