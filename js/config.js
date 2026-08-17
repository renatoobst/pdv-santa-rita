// Configuração de conexão com o Supabase.
//
// A SUPABASE_KEY abaixo é uma "publishable key" (prefixo sb_publishable_),
// o novo formato do Supabase para chaves seguras de expor no navegador —
// equivalente à antiga "anon key". Ela NÃO é um segredo: pode aparecer no
// código do cliente sem problema. A segurança real dos dados é garantida
// pelas políticas de Row Level Security (RLS) configuradas no projeto
// Supabase, não por esconder essa string. Por isso ela continua aqui como
// uma constante normal, em vez de um .env (que, sem um passo de build,
// não teria como ser injetado no navegador de qualquer forma).
export const SUPABASE_URL = 'https://akcuenzyiwdzfjphqspr.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_zArjtVDcnjxpJkxEBk1bNQ_ijlY7T4H';

// SOMENTE LOCAL — NUNCA COMMITAR: em localhost, troca o cliente real do
// Supabase por um mock 100% em memória, que nunca faz nenhuma chamada de
// rede pro banco de produção. Existe porque uma injeção de teste rodada
// direto contra o banco real (achando que "servidor local" já significava
// "isolado") sobrescreveu o estoque de verdade da barraca 'main' ao vivo,
// no meio do evento. Isso aqui garante que isso não pode mais acontecer:
// não importa o que rodar em localhost — reset de config, pedido fake,
// qualquer coisa — fica só na memória desta aba, nunca sai daqui.
function criarClienteMockLocal() {
    const bancoFake = { pdv_state: {}, pdv_perfis: [], pdv_logs: [], pdv_historico_caixas: [], pdv_movimentacoes_estoque: [] };
    const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

    function tabela(nomeTabela) {
        let filtros = [], modo = null, payload = null, opcoes = {}, ordenacao = null, limite = null, terminal = null;

        const linhasDaTabela = () => nomeTabela === 'pdv_state' ? Object.values(bancoFake.pdv_state) : (bancoFake[nomeTabela] || bancoFake[nomeTabela] === [] ? bancoFake[nomeTabela] : (bancoFake[nomeTabela] = []));
        const aplicarFiltros = (linhas) => linhas.filter(row => filtros.every(([tipo, col, val]) => {
            if (tipo === 'eq') return row[col] === val;
            if (tipo === 'in') return Array.isArray(val) && val.includes(row[col]);
            return true;
        }));

        async function executar() {
            try {
                if (modo === 'insert' || modo === 'upsert') {
                    const itens = Array.isArray(payload) ? payload : [payload];
                    itens.forEach(item => {
                        if (nomeTabela === 'pdv_state') { bancoFake.pdv_state[item.id] = clone(item); return; }
                        if (item.id === undefined) item.id = linhasDaTabela().length + 1;
                        if (modo === 'upsert') {
                            const idx = linhasDaTabela().findIndex(r => r.id === item.id);
                            if (idx >= 0) { linhasDaTabela()[idx] = clone(item); return; }
                        }
                        linhasDaTabela().push(clone(item));
                    });
                    const dataRet = clone(itens.length === 1 ? itens[0] : itens);
                    return { data: dataRet, error: null, count: itens.length };
                }
                if (modo === 'update') {
                    const alvo = aplicarFiltros(linhasDaTabela());
                    alvo.forEach(row => Object.assign(row, payload));
                    return { data: clone(alvo), error: null };
                }
                if (modo === 'delete') {
                    if (nomeTabela === 'pdv_state') {
                        aplicarFiltros(Object.values(bancoFake.pdv_state)).forEach(row => delete bancoFake.pdv_state[row.id]);
                    } else {
                        bancoFake[nomeTabela] = linhasDaTabela().filter(row => aplicarFiltros([row]).length === 0);
                    }
                    return { data: null, error: null };
                }
                let linhas = aplicarFiltros(linhasDaTabela());
                if (ordenacao) linhas = [...linhas].sort((a, b) => {
                    const r = (a[ordenacao.col] > b[ordenacao.col]) ? 1 : ((a[ordenacao.col] < b[ordenacao.col]) ? -1 : 0);
                    return ordenacao.ascending ? r : -r;
                });
                if (limite) linhas = linhas.slice(0, limite);
                if (opcoes.count === 'exact' && opcoes.head) return { data: null, error: null, count: linhas.length };
                if (terminal === 'maybeSingle') return { data: linhas.length ? clone(linhas[0]) : null, error: null };
                if (terminal === 'single') return linhas.length ? { data: clone(linhas[0]), error: null } : { data: null, error: { message: 'Nenhuma linha encontrada (mock local)' } };
                return { data: clone(linhas), error: null };
            } catch (erro) {
                return { data: null, error: { message: erro.message } };
            }
        }

        const builder = {
            select(cols, opts) { modo = modo || 'select'; if (opts) opcoes = { ...opcoes, ...opts }; return builder; },
            insert(obj) { modo = 'insert'; payload = obj; return builder; },
            upsert(obj, opts) { modo = 'upsert'; payload = obj; opcoes = { ...opcoes, ...(opts || {}) }; return builder; },
            update(obj) { modo = 'update'; payload = obj; return builder; },
            delete() { modo = 'delete'; return builder; },
            eq(col, val) { filtros.push(['eq', col, val]); return builder; },
            in(col, vals) { filtros.push(['in', col, vals]); return builder; },
            order(col, opts) { ordenacao = { col, ascending: !opts || opts.ascending !== false }; return builder; },
            limit(n) { limite = n; return builder; },
            maybeSingle() { terminal = 'maybeSingle'; return executar(); },
            single() { terminal = 'single'; return executar(); },
            then(resolve, reject) { return executar().then(resolve, reject); }
        };
        return builder;
    }

    function canalFalso() {
        const canal = {
            on() { return canal; },
            subscribe(cb) { if (cb) setTimeout(() => cb('SUBSCRIBED'), 0); return canal; },
            track: async () => ({}),
            untrack: async () => ({}),
            send: async () => ({}),
            presenceState: () => ({})
        };
        return canal;
    }

    return {
        from: tabela,
        channel: canalFalso,
        removeChannel: () => {},
        storage: {
            from: () => ({
                upload: async () => ({ data: null, error: { message: 'Upload de foto desabilitado no ambiente de teste local (mock sem Storage real).' } }),
                getPublicUrl: () => ({ data: { publicUrl: '' } })
            })
        }
    };
}

const ehAmbienteLocalDeTeste = typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

export const supabaseClient = ehAmbienteLocalDeTeste
    ? criarClienteMockLocal()
    : window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

if (ehAmbienteLocalDeTeste) {
    console.warn('%c🧪 Ambiente de teste local — banco de dados 100% em memória, isolado do Supabase de produção. Nada aqui sincroniza com os aparelhos reais.', 'font-weight:bold; font-size:14px; color:#0891b2;');
}

// Identifica este cliente/aba (usado para ignorar eco de atualizações que a
// própria aba enviou). Não confundir com o id da barraca ativa — esse é
// dinâmico (o dispositivo escolhe/troca de barraca em tempo de execução) e
// por isso vive em js/barracas.js, não aqui.
export const PDV_CLIENT_ID = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
