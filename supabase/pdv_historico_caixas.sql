-- Histórico de fechamentos de caixa — PDV Santa Rita
--
-- Não existe ferramenta de migrations neste projeto (é um app estático sem
-- backend/build). Este script é pra colar e rodar UMA VEZ no SQL Editor do
-- Supabase.
--
-- Antes, cada fechamento de caixa (com o detalhe de TODOS os pedidos
-- daquele caixa embutido, pra permitir reimprimir depois) ficava dentro do
-- array historicoCaixasDB, guardado no MESMO blob JSON de pdv_state que é
-- lido/gravado inteiro a cada ação do sistema (novo pedido, chamar painel
-- etc). Esse array nunca era limpo — crescia sem limite a cada evento,
-- deixando TUDO mais lento com o tempo, não só os relatórios de caixa.
--
-- Agora cada fechamento vira uma LINHA própria aqui (insert-only do ponto
-- de vista do app, exceto exclusão manual pelo Master) — mesmo raciocínio
-- de pdv_logs: 1 linha por evento em vez de 1 blob gigante reescrito toda
-- hora. O id agora é gerado pelo próprio Postgres (bigserial), então o
-- problema de colisão de id entre dispositivos que existia antes (dois
-- caixas fechados quase ao mesmo tempo em dispositivos diferentes
-- calculando o mesmo "historicoCaixasDB.length + 1") deixa de existir pra
-- este dado.
--
-- Mesmo modelo de confiança do resto do app (pdv_state, pdv_perfis,
-- pdv_logs): sem RLS/política granular, quem tem a chave pública do
-- projeto consegue ler/escrever.
create table public.pdv_historico_caixas (
  id bigserial primary key,
  barraca_id text not null,
  -- Identidade estável gerada no momento do fechamento (mesma ideia do
  -- chaveUnica dos pedidos) — usada só pra fila de retry (ver
  -- enviarFechamentoParaSupabase/tentarEnviarFilaDeFechamentos no app) não
  -- duplicar o mesmo fechamento se reenviar duas vezes por engano.
  chave_unica text,
  usuario_nome text,
  campanha text,
  data_abertura text,
  data_fechamento text,
  fundo_inicial numeric not null default 0,
  total_vendas numeric not null default 0,
  pix numeric not null default 0,
  pix_direto numeric not null default 0,
  credito numeric not null default 0,
  debito numeric not null default 0,
  dinheiro_vendas numeric not null default 0,
  bonificacao numeric not null default 0,
  total_gaveta numeric not null default 0,
  qtd_pedidos integer not null default 0,
  produtos_vendidos jsonb not null default '{}'::jsonb,
  valor_produtos_vendidos jsonb not null default '{}'::jsonb,
  pedidos_detalhados jsonb not null default '[]'::jsonb,
  criado_em timestamptz not null default now()
);

create index pdv_historico_caixas_barraca_idx on public.pdv_historico_caixas (barraca_id, criado_em desc);
-- Unique normal (não parcial): Postgres já trata NULL como distinto de
-- NULL em índice único, então fechamentos antigos migrados sem
-- chave_unica (ver insert abaixo) não colidem entre si por isso.
create unique index pdv_historico_caixas_chave_unica_idx on public.pdv_historico_caixas (chave_unica);

-- Migração dos fechamentos que já existem hoje dentro do JSON de
-- pdv_state — só insere de verdade se você já tinha caixas fechados ANTES
-- deste script. NÃO apaga nada do JSON original (o array
-- historicoCaixasDB fica intacto lá como backup silencioso — só o app é
-- que para de ler/gravar nele depois deste script).
insert into public.pdv_historico_caixas (
  barraca_id, chave_unica, usuario_nome, campanha, data_abertura, data_fechamento,
  fundo_inicial, total_vendas, pix, pix_direto, credito, debito, dinheiro_vendas,
  bonificacao, total_gaveta, qtd_pedidos, produtos_vendidos, valor_produtos_vendidos,
  pedidos_detalhados
)
select
  ps.id,
  elem->>'chaveUnica',
  elem->>'usuarioNome',
  elem->>'campanha',
  elem->>'dataAbertura',
  elem->>'dataFechamento',
  coalesce((elem->>'fundoInicial')::numeric, 0),
  coalesce((elem->>'totalVendas')::numeric, 0),
  coalesce((elem->>'pix')::numeric, 0),
  coalesce((elem->>'pixDireto')::numeric, 0),
  coalesce((elem->>'credito')::numeric, 0),
  coalesce((elem->>'debito')::numeric, 0),
  coalesce((elem->>'dinheiroVendas')::numeric, 0),
  coalesce((elem->>'bonificacao')::numeric, 0),
  coalesce((elem->>'totalGaveta')::numeric, 0),
  coalesce((elem->>'qtdPedidos')::int, 0),
  coalesce(elem->'produtosVendidos', '{}'::jsonb),
  coalesce(elem->'valorProdutosVendidos', '{}'::jsonb),
  coalesce(elem->'pedidosDetalhados', '[]'::jsonb)
from public.pdv_state ps,
     jsonb_array_elements(coalesce(ps.data->'historicoCaixasDB', '[]'::jsonb)) as elem
where ps.id not in ('__catalogo__', '__registry__')
on conflict (chave_unica) do nothing;
