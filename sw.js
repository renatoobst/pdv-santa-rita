// Service Worker do PDV — só cuida do "shell" do app (HTML/CSS/JS locais e as
// bibliotecas de CDN) pra ele pelo menos ABRIR sem internet. Os dados de
// verdade (pedidos, estoque, caixa) continuam vindo do Supabase em tempo
// real — isso aqui nunca intercepta chamadas pro Supabase, só evita a tela
// branca quando o dispositivo perde conexão.
const CACHE_SHELL = 'pdv-shell-v2';

const ARQUIVOS_SHELL = [
    './',
    './index.html',
    './css/styles.css',
    './js/app.js',
    './js/auth.js',
    './js/barracas.js',
    './manifest.json',
    './assets/icon.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_SHELL).then((cache) => cache.addAll(ARQUIVOS_SHELL)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((chaves) => Promise.all(
            chaves.filter((chave) => chave !== CACHE_SHELL).map((chave) => caches.delete(chave))
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Nunca mexe em chamadas pro Supabase (dados/realtime) — sempre direto
    // pra rede, sem cache, pra não servir pedido/estoque desatualizado.
    if (url.hostname.includes('supabase.co')) return;
    if (event.request.method !== 'GET') return;

    const ehMesmaOrigem = url.origin === self.location.origin;

    if (ehMesmaOrigem) {
        // Shell local: tenta rede primeiro (pra sempre pegar a versão mais
        // nova quando tem internet) e só cai pro cache se a rede falhar.
        event.respondWith(
            fetch(event.request)
                .then((resposta) => {
                    const copia = resposta.clone();
                    caches.open(CACHE_SHELL).then((cache) => cache.put(event.request, copia));
                    return resposta;
                })
                .catch(() => caches.match(event.request))
        );
    } else {
        // Bibliotecas de CDN (Chart.js, html2pdf etc.): raramente mudam,
        // então cache primeiro, com a rede como reforço/atualização.
        event.respondWith(
            caches.match(event.request).then((cacheada) => {
                const buscaRede = fetch(event.request).then((resposta) => {
                    const copia = resposta.clone();
                    caches.open(CACHE_SHELL).then((cache) => cache.put(event.request, copia));
                    return resposta;
                }).catch(() => cacheada);
                return cacheada || buscaRede;
            })
        );
    }
});
