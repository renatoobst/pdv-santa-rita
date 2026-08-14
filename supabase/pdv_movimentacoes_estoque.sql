-- Movimentações de estoque (entrada de compra + ajuste de inventário) —
-- PDV Santa Rita
--
-- Não existe ferramenta de migrations neste projeto (é um app estático sem
-- backend/build). Este script é pra colar e rodar UMA VEZ no SQL Editor do
-- Supabase, antes de usar a tela "📥 Entrada de Estoque".
--
-- Antes, estoque só mudava de duas formas: automático na venda, ou digitando
-- um número novo direto no cadastro do produto (sem registrar POR QUE mudou
-- — não ficava nota fiscal, custo, motivo, nada). Agora cada entrada de
-- compra ou ajuste de inventário vira uma LINHA própria aqui (insert-only
-- do ponto de vista do app) — mesmo raciocínio de pdv_logs/
-- pdv_historico_caixas: 1 linha por evento em vez de sobrescrever um número
-- sem histórico.
--
-- Uma nota fiscal com vários itens vira várias linhas aqui (uma por
-- produto/insumo), não um JSON com lista dentro — mais simples de somar e
-- filtrar por produto depois.
--
-- Mesmo modelo de confiança do resto do app: sem RLS/política granular,
-- quem tem a chave pública do projeto consegue ler/escrever.
create table public.pdv_movimentacoes_estoque (
  id bigserial primary key,
  barraca_id text not null,
  produto_id integer not null,
  -- Snapshot do nome no momento da movimentação — continua legível mesmo
  -- se o produto for renomeado ou apagado do catálogo depois.
  produto_nome text not null,
  -- 'entrada' (compra chegou) | 'ajuste' (contagem física corrigiu)
  tipo text not null,
  -- entrada: sempre positiva (quantidade que chegou).
  -- ajuste: delta (positivo ou negativo) entre contado e o que o sistema tinha.
  quantidade numeric not null,
  estoque_antes numeric,
  estoque_depois numeric,
  -- Só preenchido em 'entrada':
  custo_unitario numeric,
  -- custo_unitario + rateio proporcional de frete/outras despesas da nota
  custo_unitario_final numeric,
  numero_nota_fiscal text,
  fornecedor text,
  -- Obrigatório em 'ajuste' (por que a contagem bateu diferente),
  -- opcional em 'entrada' (observação livre).
  motivo text,
  usuario_nome text,
  criado_em timestamptz not null default now()
);

create index pdv_movimentacoes_estoque_barraca_idx on public.pdv_movimentacoes_estoque (barraca_id, criado_em desc);
create index pdv_movimentacoes_estoque_produto_idx on public.pdv_movimentacoes_estoque (produto_id);
