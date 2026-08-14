-- Bucket de fotos de produto — PDV Santa Rita
--
-- Não existe ferramenta de migrations neste projeto (é um app estático sem
-- backend/build). Este script é pra colar e rodar UMA VEZ no SQL Editor do
-- Supabase, antes de subir fotos de produto pela tela de cadastro.
--
-- Antes a foto do produto ia como base64 direto dentro do JSON do catálogo
-- (a mesma linha de pdv_state lida/gravada inteira a cada save) — com
-- muitos produtos com foto isso incha o blob e deixa TODO save mais lento,
-- não só o de produtos. Agora a foto vira um arquivo neste bucket e só o
-- link (texto curto) fica salvo no produto.
--
-- Mesmo modelo de confiança do resto do app (pdv_state, pdv_perfis,
-- pdv_logs): quem tem a chave pública do projeto consegue ler/enviar aqui,
-- sem política granular por usuário — "public" aqui é só sobre LEITURA
-- (qualquer um com o link vê a foto, necessário pra aparecer na tela de
-- Pedido); enviar/apagar arquivo continua exigindo a chave do projeto, não
-- é aberto pra internet em geral.
insert into storage.buckets (id, name, public)
values ('produtos-fotos', 'produtos-fotos', true)
on conflict (id) do nothing;

drop policy if exists "Leitura publica produtos-fotos" on storage.objects;
create policy "Leitura publica produtos-fotos"
  on storage.objects for select
  using (bucket_id = 'produtos-fotos');

drop policy if exists "Upload publico produtos-fotos" on storage.objects;
create policy "Upload publico produtos-fotos"
  on storage.objects for insert
  with check (bucket_id = 'produtos-fotos');
