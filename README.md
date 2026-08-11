# PDV Santa Rita

Aplicação de ponto de venda (PDV) conectada ao Supabase.

## Arquivos
- `index.html` — estrutura (markup) das telas, modais e navegação.
- `css/styles.css` — todos os estilos da aplicação.
- `js/config.js` — conexão com o Supabase (URL + chave pública) e identificadores de sincronização.
- `js/data.js` — categorias e produtos padrão usados na primeira execução.
- `js/app.js` — estado da aplicação e toda a lógica (pedidos, cozinha, caixa, estoque, relatórios, etc.), como módulo ES.

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

## Versionamento
Este repositório foi criado para versionar a aplicação PDV Santa Rita.
