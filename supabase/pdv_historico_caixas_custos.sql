-- Adiciona custo/lucro real ao histórico de fechamentos de caixa —
-- PDV Santa Rita
--
-- Colar e rodar UMA VEZ no SQL Editor do Supabase, depois de
-- pdv_historico_caixas.sql já ter rodado.
--
-- Até agora o fechamento de caixa só guardava faturamento BRUTO — nunca
-- descontava o custo de produção (ficha técnica dos produtos, ver
-- calcularCustoProducao em js/app.js) nem a taxa da maquininha
-- (Configurações > Taxas de Pagamento). Essas 3 colunas guardam o cálculo
-- feito NO MOMENTO do fechamento (snapshot, não recalculado depois) —
-- mesmo raciocínio de valor_produtos_vendidos: se o catálogo mudar de
-- preço/custo depois, o fechamento antigo continua mostrando o que era
-- verdade na hora. Fechamentos de ANTES desta coluna existir ficam com
-- estes 3 campos null — o app trata isso com uma estimativa aproximada
-- calculada ao vivo (ver renderizarDetalhesCaixaNoModal).
alter table public.pdv_historico_caixas
  add column if not exists custo_producao_estimado numeric,
  add column if not exists custo_taxas_estimado numeric,
  add column if not exists lucro_real_estimado numeric;
