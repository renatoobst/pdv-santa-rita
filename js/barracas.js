// Suporte a múltiplas barracas (multi-tenant).
//
// Cada barraca é totalmente isolada: seu próprio cardápio, pedidos, caixa e
// fila de despacho vivem numa linha própria da tabela `pdv_state` no Supabase,
// identificada pelo `id` da barraca (mesmo mecanismo de "um id = um estado
// completo" que já existia para a barraca única original, que por isso
// continua com o id 'main' — nenhuma migração de dados foi necessária).
//
// Um id reservado, '__registry__', guarda só a LISTA de barracas existentes
// (nome, id, data de criação) — não o estado de nenhuma delas. É essa lista
// que alimenta a tela de seleção, o trocador no menu e a tela de gestão.
//
// Este módulo não importa nada de app.js (para evitar import circular).
// app.js é quem importa daqui: `resolverBarracaAtiva()` (chamada uma vez no
// window.onload, antes de carregar qualquer estado) e `calcularResumoPedidos`
// (usada tanto pelo relatório de uma barraca quanto pelo Dashboard Geral).

import { supabaseClient, PDV_CLIENT_ID } from './config.js';

const REGISTRY_ID = '__registry__';
const CHAVE_BARRACA_LOCAL = 'pdv_barraca_atual_id';
const CHAVE_REGISTRO_CACHE = 'pdv_registro_barracas_cache';

export let registroBarracas = [];
export let barracaAtual = null; // { id, nome, criadoEm }

export function chaveCacheEstado(id) { return `pdv_cache_${id}`; }
export function chaveCacheAtalhos(id) { return `pdv_atalhos_${id}`; }
export function chaveCacheConfigPadroes(id) { return `pdv_config_padroes_${id}`; }

// Faixa Unicode das marcas diacríticas combinantes (usada para tirar acentos
// depois de normalize('NFD')). Escrita via \u para não depender de caracteres
// invisíveis literais no código-fonte.
const REGEX_MARCAS_DIACRITICAS = /[\u0300-\u036f]/g;

function gerarSlug(nomeDigitado) {
    let base = (nomeDigitado || '').toString().trim().toLowerCase()
        .normalize('NFD').replace(REGEX_MARCAS_DIACRITICAS, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-+|-+$)/g, '');
    if (!base || base === 'registry' || base === '__registry__') base = 'barraca';
    let slug = base, i = 2;
    while (registroBarracas.some(b => b.id === slug)) {
        slug = `${base}-${i}`;
        i++;
    }
    return slug;
}

function salvarRegistroCacheLocal() {
    localStorage.setItem(CHAVE_REGISTRO_CACHE, JSON.stringify(registroBarracas));
}

async function carregarRegistroBarracas() {
    try {
        const { data, error } = await supabaseClient
            .from('pdv_state')
            .select('data')
            .eq('id', REGISTRY_ID)
            .maybeSingle();
        if (error) throw error;

        if (data && data.data && Array.isArray(data.data.barracas)) {
            registroBarracas = data.data.barracas;
        } else {
            // Primeira vez que essa funcionalidade roda: registra a barraca
            // 'main' (a que já existia antes de "barracas" ser um conceito)
            // para que ela apareça na seleção e nada fique órfão.
            registroBarracas = [{ id: 'main', nome: 'Barraca Principal', criadoEm: new Date().toISOString() }];
            await salvarRegistroBarracas();
        }
    } catch (erro) {
        console.error('Não foi possível carregar o registro de barracas do Supabase. Usando cache local:', erro);
        try {
            const cache = JSON.parse(localStorage.getItem(CHAVE_REGISTRO_CACHE));
            registroBarracas = Array.isArray(cache) ? cache : [{ id: 'main', nome: 'Barraca Principal', criadoEm: new Date().toISOString() }];
        } catch (e) {
            registroBarracas = [{ id: 'main', nome: 'Barraca Principal', criadoEm: new Date().toISOString() }];
        }
    }
    // Garantia defensiva: 'main' sempre precisa estar selecionável, porque
    // sua linha de estado no Supabase já existe (é a barraca original) mesmo
    // que, por algum motivo, ela não esteja no registro.
    if (!registroBarracas.some(b => b.id === 'main')) {
        registroBarracas.unshift({ id: 'main', nome: 'Barraca Principal', criadoEm: new Date().toISOString() });
        await salvarRegistroBarracas();
    }
    salvarRegistroCacheLocal();
}

async function salvarRegistroBarracas() {
    salvarRegistroCacheLocal();
    try {
        const { error } = await supabaseClient
            .from('pdv_state')
            .upsert({
                id: REGISTRY_ID,
                data: { barracas: registroBarracas, origem: PDV_CLIENT_ID, salvoEm: new Date().toISOString() },
                updated_at: new Date().toISOString()
            }, { onConflict: 'id' });
        if (error) throw error;
    } catch (erro) {
        console.error('Falha ao sincronizar o registro de barracas com o Supabase. Mantido no cache local:', erro);
    }
}

function migrarCacheLegadoParaMain() {
    if (localStorage.getItem(chaveCacheEstado('main'))) return; // já migrado
    if (!localStorage.getItem('pdv_categorias')) return; // nada a migrar

    try {
        const estadoLegado = {
            categoriasDB: JSON.parse(localStorage.getItem('pdv_categorias')) || undefined,
            produtosDB: JSON.parse(localStorage.getItem('pdv_produtos')) || undefined,
            pedidosGerais: JSON.parse(localStorage.getItem('pdv_pedidos')) || undefined,
            contadorPedidos: parseInt(localStorage.getItem('pdv_contador')) || undefined,
            historicoCaixasDB: JSON.parse(localStorage.getItem('pdv_historico_caixas')) || undefined,
            caixaAberto: JSON.parse(localStorage.getItem('pdv_caixa_aberto') || 'false'),
            valorFundoCaixa: parseFloat(localStorage.getItem('pdv_fundo_caixa')) || 0,
            dataHoraAberturaCaixa: localStorage.getItem('pdv_hora_abertura_caixa') || null
        };
        localStorage.setItem(chaveCacheEstado('main'), JSON.stringify(estadoLegado));

        const atalhosLegado = localStorage.getItem('pdv_atalhos');
        if (atalhosLegado) localStorage.setItem(chaveCacheAtalhos('main'), atalhosLegado);
    } catch (erro) {
        console.error('Não foi possível migrar o cache local antigo para o formato por barraca:', erro);
    }
}

// Resolve qual barraca este dispositivo deve usar. Se já houver uma escolha
// salva (e ela ainda existir no registro), retorna na hora. Caso contrário,
// mostra a tela de seleção e só retorna quando o usuário escolher ou criar
// uma — por isso é assíncrona.
export async function resolverBarracaAtiva() {
    await carregarRegistroBarracas();

    const idSalvo = localStorage.getItem(CHAVE_BARRACA_LOCAL);
    let escolhida = idSalvo ? registroBarracas.find(b => b.id === idSalvo) : null;

    if (!escolhida && !idSalvo && localStorage.getItem('pdv_categorias')) {
        // Dispositivo já usava o PDV antes de "barracas" existir: assume
        // 'main' automaticamente, sem interromper quem já está em uso no evento.
        escolhida = registroBarracas.find(b => b.id === 'main');
        if (escolhida) localStorage.setItem(CHAVE_BARRACA_LOCAL, escolhida.id);
    }

    if (escolhida) {
        migrarCacheLegadoParaMain();
        barracaAtual = escolhida;
        renderizarSeletorBarracaNav();
        return escolhida;
    }

    return new Promise(resolve => {
        renderizarTelaSelecaoBarraca(resolve);
    });
}

function selecionarEEntrar(id) {
    localStorage.setItem(CHAVE_BARRACA_LOCAL, id);
    location.reload();
}

function renderizarTelaSelecaoBarraca(aoEscolher) {
    const tela = document.getElementById('tela-selecionar-barraca');
    const lista = document.getElementById('lista-barracas-selecao');
    tela.style.display = 'flex';

    lista.innerHTML = registroBarracas.map(b => `
        <button class="btn btn-primary" style="width:100%; text-align:left; padding:14px 16px;" data-barraca-id="${b.id}">🏪 ${b.nome}</button>
    `).join('') || '<p style="color:gray;">Nenhuma barraca cadastrada ainda. Crie a primeira abaixo.</p>';

    lista.querySelectorAll('button[data-barraca-id]').forEach(btn => {
        btn.onclick = () => {
            localStorage.setItem(CHAVE_BARRACA_LOCAL, btn.dataset.barracaId);
            const escolhida = registroBarracas.find(b => b.id === btn.dataset.barracaId);
            tela.style.display = 'none';
            barracaAtual = escolhida;
            renderizarSeletorBarracaNav();
            aoEscolher(escolhida);
        };
    });

    window.criarBarracaNaSelecao = async () => {
        const input = document.getElementById('input-nova-barraca-selecao');
        const nome = input.value.trim();
        if (!nome) { window.exibirAviso ? window.exibirAviso('Digite um nome para a barraca.') : alert('Digite um nome para a barraca.'); return; }
        const nova = await criarBarraca(nome);
        input.value = '';
        tela.style.display = 'none';
        barracaAtual = nova;
        renderizarSeletorBarracaNav();
        aoEscolher(nova);
    };
}

export async function criarBarraca(nomeDigitado) {
    const nome = (nomeDigitado || '').trim();
    if (!nome) throw new Error('Nome da barraca não pode ser vazio.');
    const id = gerarSlug(nome);
    const nova = { id, nome, criadoEm: new Date().toISOString() };
    registroBarracas.push(nova);
    await salvarRegistroBarracas();
    return nova;
}

export async function renomearBarraca(id, novoNome) {
    const nome = (novoNome || '').trim();
    if (!nome) return;
    const alvo = registroBarracas.find(b => b.id === id);
    if (!alvo) return;
    alvo.nome = nome;
    await salvarRegistroBarracas();
    if (barracaAtual && barracaAtual.id === id) {
        barracaAtual.nome = nome;
    }
    renderizarSeletorBarracaNav();
    renderizarPainelBarracas();
}

export async function removerBarraca(id) {
    if (barracaAtual && barracaAtual.id === id) {
        alert('Você não pode remover a barraca em que está trabalhando agora. Troque de barraca primeiro.');
        return;
    }
    if (!confirm('Remover esta barraca da lista? Os dados dela ficam guardados no Supabase (não são apagados), mas ela deixa de aparecer na seleção até ser recadastrada.')) return;
    registroBarracas = registroBarracas.filter(b => b.id !== id);
    await salvarRegistroBarracas();
    renderizarSeletorBarracaNav();
    renderizarPainelBarracas();
}

// --- Trocador de barraca no menu (sempre visível quando já dentro do app) ---
export function renderizarSeletorBarracaNav() {
    const nomeEl = document.getElementById('nome-barraca-atual-nav');
    const lista = document.getElementById('lista-barracas-trocar');
    if (!nomeEl || !lista || !barracaAtual) return;

    nomeEl.innerText = barracaAtual.nome;
    lista.innerHTML = registroBarracas
        .filter(b => b.id !== barracaAtual.id)
        .map(b => `<button data-trocar-id="${b.id}">🏪 ${b.nome}</button>`)
        .join('') + `<button onclick="mudarAba('tela-barracas', document.getElementById('btn-nav-barracas'))">⚙️ Gerenciar Barracas</button>`;

    lista.querySelectorAll('button[data-trocar-id]').forEach(btn => {
        btn.onclick = () => selecionarEEntrar(btn.dataset.trocarId);
    });
}

// --- Tela de gestão (criar / renomear / remover barracas) ---
export function renderizarPainelBarracas() {
    const tbody = document.getElementById('tabela-barracas');
    if (!tbody) return;

    if (registroBarracas.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:gray; padding:20px;">Nenhuma barraca cadastrada.</td></tr>';
        return;
    }

    tbody.innerHTML = registroBarracas.map(b => {
        const dataFmt = b.criadoEm ? new Date(b.criadoEm).toLocaleDateString('pt-BR') : '—';
        const ativa = barracaAtual && barracaAtual.id === b.id;
        return `
            <tr style="border-bottom: 1px solid #e5e7eb;">
                <td style="padding:10px; font-weight:bold;">🏪 ${b.nome} ${ativa ? '<span style="color: var(--success); font-size:0.75rem;">(esta barraca)</span>' : ''}</td>
                <td style="font-family: monospace; color:#6b7280;">${b.id}</td>
                <td style="color:#6b7280; font-size:0.85rem;">${dataFmt}</td>
                <td style="text-align:right;">
                    <button class="btn btn-warning" style="padding:6px 10px;" data-renomear-id="${b.id}" data-renomear-nome="${b.nome}">✏️ Renomear</button>
                    <button class="btn btn-danger" style="padding:6px 10px;" data-remover-id="${b.id}" ${ativa ? 'disabled title="Troque de barraca antes de remover esta"' : ''}>🗑️ Remover</button>
                </td>
            </tr>`;
    }).join('');

    tbody.querySelectorAll('button[data-renomear-id]').forEach(btn => {
        btn.onclick = () => {
            const novoNome = prompt('Novo nome da barraca:', btn.dataset.renomearNome);
            if (novoNome !== null) renomearBarraca(btn.dataset.renomearId, novoNome);
        };
    });
    tbody.querySelectorAll('button[data-remover-id]').forEach(btn => {
        btn.onclick = () => removerBarraca(btn.dataset.removerId);
    });
}

export async function criarBarracaNoPainel() {
    const input = document.getElementById('input-nova-barraca-painel');
    const nome = input.value.trim();
    if (!nome) return;
    await criarBarraca(nome);
    input.value = '';
    renderizarPainelBarracas();
    renderizarSeletorBarracaNav();
}

// --- Cálculo puro de resumo financeiro de um conjunto de pedidos ---
// Extraído de obterDadosRelatorioCaixa() (app.js) para poder ser reaproveitado
// tanto pelo relatório da barraca atual quanto pelo Dashboard Geral (que
// aplica a mesma conta aos dados de CADA barraca, sem tocar no estado da
// barraca ativa no dispositivo).
export function calcularResumoPedidos(pedidosGerais, caixaAberto, valorFundoCaixa) {
    const lista = Array.isArray(pedidosGerais) ? pedidosGerais : [];
    // Pedido Online (pagamentoPendente) ainda não virou dinheiro de verdade —
    // fica de fora dos totais do caixa (faturamento, gaveta, formas de
    // pagamento) até alguém abrir o pedido e definir a forma de pagamento na
    // retirada. Fica exposto à parte, em pendentesPagamento, só pra dar
    // visibilidade de quanto ainda está "a receber".
    const pendentesPagamento = lista.filter(p => p.statusPainel !== 'cancelado' && p.pagamentoPendente);
    const totalPendentePagamento = pendentesPagamento.reduce((a, p) => a + p.total, 0);

    const validos = lista.filter(p => p.statusPainel !== 'cancelado' && !p.pagamentoPendente);
    const validosVendas = validos.filter(p => p.pagamento && !p.pagamento.startsWith('Bonificação'));
    const totalVendas = validosVendas.reduce((a, p) => a + p.total, 0);

    let fatPix = 0, fatPixDireto = 0, fatCredito = 0, fatDebito = 0, fatDinheiro = 0;
    let resumoProdutosVendidos = {};
    let bonificacoesLista = [];

    validos.forEach(p => {
        const ehBonificacao = p.pagamento && p.pagamento.startsWith('Bonificação');
        if (ehBonificacao) {
            bonificacoesLista.push(p);
        } else {
            if (p.detalhesMisto && Array.isArray(p.detalhesMisto)) {
                p.detalhesMisto.forEach(d => {
                    if (d.forma === 'Pix') fatPix += d.valor;
                    if (d.forma === 'Pix Direto') fatPixDireto += d.valor;
                    if (d.forma === 'Cartão Crédito') fatCredito += d.valor;
                    if (d.forma === 'Cartão Débito') fatDebito += d.valor;
                    if (d.forma === 'Dinheiro') fatDinheiro += d.valor;
                });
            } else if (p.pagamento) {
                if (p.pagamento === 'Pix') fatPix += p.total;
                else if (p.pagamento === 'Pix Direto') fatPixDireto += p.total;
                else if (p.pagamento === 'Cartão Crédito') fatCredito += p.total;
                else if (p.pagamento === 'Cartão Débito') fatDebito += p.total;
                else if (p.pagamento === 'Dinheiro') fatDinheiro += p.total;
            }
            (p.itens || []).forEach(i => {
                resumoProdutosVendidos[i.nome] = (resumoProdutosVendidos[i.nome] || 0) + i.qtd;
            });
        }
    });

    return {
        validos,
        validosVendas,
        totalVendas,
        fatPix,
        fatPixDireto,
        fatCredito,
        fatDebito,
        fatDinheiro,
        qtdBonificacoes: bonificacoesLista.length,
        bonificacoesLista,
        totalGaveta: caixaAberto ? (valorFundoCaixa + fatDinheiro) : 0.00,
        resumoProdutosVendidos,
        pendentesPagamento,
        totalPendentePagamento
    };
}

// --- Dashboard Geral: agrega os dados de TODAS as barracas cadastradas ---
// Só leitura — busca as linhas de estado de cada barraca direto do Supabase
// e calcula os totais localmente. Nunca aplica esses dados como estado da
// barraca ativa (isso corromperia o que está sendo usado no dispositivo).
export async function carregarDashboardGeral() {
    const container = document.getElementById('corpo-dashboard-geral');
    if (!container) return;
    container.innerHTML = '<p style="color:gray;">Carregando dados de todas as barracas...</p>';

    await carregarRegistroBarracas();
    if (registroBarracas.length === 0) {
        container.innerHTML = '<p style="color:gray;">Nenhuma barraca cadastrada ainda.</p>';
        return;
    }

    const ids = registroBarracas.map(b => b.id);
    const { data, error } = await supabaseClient.from('pdv_state').select('id, data').in('id', ids);
    if (error) {
        container.innerHTML = `<p style="color:var(--danger);">Não foi possível carregar os dados das barracas: ${error.message}</p>`;
        return;
    }

    const porId = {};
    (data || []).forEach(row => { porId[row.id] = row.data; });

    let totalGeralAtual = 0, totalGeralHistorico = 0, totalGeralPedidos = 0;
    let linhas = '';

    registroBarracas.forEach(b => {
        const estado = porId[b.id];
        if (!estado) {
            linhas += `<tr><td style="padding:10px; font-weight:bold;">🏪 ${b.nome}</td><td colspan="5" style="color:gray;">Sem dados ainda</td></tr>`;
            return;
        }
        const resumo = calcularResumoPedidos(estado.pedidosGerais, !!estado.caixaAberto, Number(estado.valorFundoCaixa) || 0);
        const totalHistorico = (Array.isArray(estado.historicoCaixasDB) ? estado.historicoCaixasDB : []).reduce((acc, c) => acc + (c.totalVendas || 0), 0);
        const totalBarraca = resumo.totalVendas + totalHistorico;

        totalGeralAtual += resumo.totalVendas;
        totalGeralHistorico += totalHistorico;
        totalGeralPedidos += resumo.validos.length;

        linhas += `
            <tr style="border-bottom:1px solid #e5e7eb;">
                <td style="padding:10px; font-weight:bold;">🏪 ${b.nome}</td>
                <td>${estado.caixaAberto ? '🟢 Aberto' : '🔴 Fechado'}</td>
                <td style="text-align:center;">${resumo.validos.length}</td>
                <td>R$ ${resumo.totalVendas.toFixed(2)}</td>
                <td>R$ ${totalHistorico.toFixed(2)}</td>
                <td style="font-weight:bold; color:var(--success);">R$ ${totalBarraca.toFixed(2)}</td>
            </tr>`;
    });

    container.innerHTML = `
        <div style="overflow-x:auto;">
        <table class="tabela-resumo-canto" style="font-size:0.9rem; width:100%;">
            <thead>
                <tr style="background:#f1f5f9;">
                    <th style="text-align:left; padding:8px;">Barraca</th>
                    <th>Caixa</th>
                    <th>Pedidos (caixa atual)</th>
                    <th>Faturamento (caixa atual)</th>
                    <th>Total já fechado</th>
                    <th>Total Geral</th>
                </tr>
            </thead>
            <tbody>${linhas}</tbody>
            <tfoot>
                <tr style="font-weight:bold; background:#eef2ff;">
                    <td colspan="2" style="padding:10px;">TOTAL DO EVENTO</td>
                    <td style="text-align:center;">${totalGeralPedidos}</td>
                    <td>R$ ${totalGeralAtual.toFixed(2)}</td>
                    <td>R$ ${totalGeralHistorico.toFixed(2)}</td>
                    <td style="color:var(--success);">R$ ${(totalGeralAtual + totalGeralHistorico).toFixed(2)}</td>
                </tr>
            </tfoot>
        </table>
        </div>`;
}

// --- Realtime: mantém o registro de barracas atualizado entre dispositivos ---
export function iniciarRealtimeRegistroBarracas() {
    supabaseClient
        .channel('pdv-registry-sync')
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'pdv_state',
            filter: `id=eq.${REGISTRY_ID}`
        }, payload => {
            const dados = payload.new && payload.new.data;
            if (!dados || dados.origem === PDV_CLIENT_ID || !Array.isArray(dados.barracas)) return;
            registroBarracas = dados.barracas;
            salvarRegistroCacheLocal();
            renderizarSeletorBarracaNav();
            renderizarPainelBarracas();
        })
        .subscribe(status => {
            console.log('Supabase Realtime (registro de barracas):', status);
        });
}

window.criarBarracaNoPainel = criarBarracaNoPainel;
