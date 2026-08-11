# PDV Santa Rita

Aplicação de ponto de venda (PDV) conectada ao Supabase.

## Arquivos
- `index.html` — estrutura (markup) das telas, modais e navegação.
- `css/styles.css` — todos os estilos da aplicação.
- `js/config.js` — conexão com o Supabase (URL + chave pública) e identificador deste cliente/aba.
- `js/data.js` — categorias e produtos padrão usados na primeira execução de uma barraca.
- `js/app.js` — estado e lógica de uma barraca (pedidos, cozinha, caixa, estoque, relatórios, etc.), como módulo ES.
- `js/barracas.js` — suporte a múltiplas barracas: seleção/troca, cadastro (criar/renomear/remover) e o Dashboard Geral que soma todas.

A aplicação não tem passo de build: `index.html` carrega `js/app.js` via `<script type="module">`.
Por isso ela **precisa ser servida por um servidor HTTP** (não abrir o arquivo direto com duplo clique) —
módulos ES não carregam via `file://`. Para testar localmente:

```bash
python3 -m http.server 8000
```

e abrir `http://localhost:8000`. Em produção, qualquer hospedagem estática (Netlify, Vercel, GitHub Pages etc.)
serve os arquivos normalmente.

A chave em `js/config.js` é uma *publishable key* do Supabase (prefixo `sb_publishable_`) — feita para
ser exposta no navegador, como a antiga anon key. A segurança dos dados vem das políticas de
Row Level Security (RLS) no projeto Supabase, não de esconder essa string.

## Funcionalidades

- Busca de produtos por nome na tela de Pedido.
- Formas de pagamento: Cartão Débito, Cartão Crédito, Pix (Máquina), Pix Direto (Conta), Dinheiro,
  Bonificação e **Misto** (divide o valor entre 2 formas de pagamento). Forma de pagamento e modo de
  retirada agora são de preenchimento obrigatório (sem valor padrão pré-selecionado).
- Edição de pedido: permite alterar o status (Finalizado / Na Cozinha / Pronto na TV / Balcão Pendente)
  diretamente na tela de edição.
- Cozinha e Balcão/Entrega: painel lateral com resumo em tabela dos itens em produção/pendentes.
- Produtos & Estoque: campo Ativo/Inativo por produto (controla se aparece nas vendas) e exportação do
  relatório de estoque em PDF (via `html2pdf.js`).
- Dashboard: impressão e exportação em PDF (A4) do fechamento de caixa atual, e painel dedicado de
  bonificações/cortesias (pedidos sem valor monetário).
- Gestão de Pedidos: filtro por forma de pagamento.

## Múltiplas barracas

O PDV suporta várias "barracas" (bancas/estandes) usando o mesmo app, cada uma **totalmente isolada**:
cardápio, pedidos, caixa e fila de despacho próprios. Serve para eventos (ex: uma festa/feira da igreja)
em que cada barraca vende coisas diferentes e fecha seu próprio caixa.

- **Como funciona por baixo dos panos**: cada barraca é uma linha própria na tabela `pdv_state` do
  Supabase, identificada pelo `id` da barraca (o mesmo mecanismo que antes guardava só a barraca única
  como `id = 'main'` — por isso a barraca original virou automaticamente "Barraca Principal", sem
  precisar migrar nada no Supabase). Uma linha reservada, `id = '__registry__'`, guarda só a lista de
  barracas cadastradas (nome, id, data de criação).
- **Ao abrir o app pela primeira vez num dispositivo**, aparece uma tela para escolher (ou criar) a
  barraca em que ele vai trabalhar; a escolha fica salva naquele navegador/dispositivo até ser trocada
  manualmente pelo seletor no canto superior direito do menu. Dispositivos que já usavam o PDV antes
  dessa funcionalidade existir continuam entrando direto na "Barraca Principal", sem interrupção.
- **🏪 Barracas** (menu superior): tela para criar, renomear e remover barracas da lista. Remover só
  tira da lista de seleção — os dados no Supabase não são apagados.
- **🏬 Dashboard Geral** (dentro de Relatórios): soma pedidos e faturamento de todas as barracas
  cadastradas, direto do Supabase, sem interferir no que está em uso em nenhuma delas — útil para o
  fechamento geral do evento.

## Versionamento
Este repositório foi criado para versionar a aplicação PDV Santa Rita.
