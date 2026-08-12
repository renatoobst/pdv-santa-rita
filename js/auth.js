// Login e permissões por usuário.
//
// Login simples, sem Supabase Auth: o próprio app confere usuário/senha
// contra a tabela `public.pdv_perfis` (ver supabase/pdv_perfis.sql pro script
// que cria essa tabela — PRECISA rodar uma vez no Supabase antes de qualquer
// login funcionar). A senha é guardada como hash SHA-256 (nunca em texto
// puro), mas sem sessão/JWT de verdade — é o mesmo modelo de confiança que o
// resto do app já usa pra ler/escrever em `pdv_state`: quem tem a chave
// pública do projeto consegue acessar a tabela. A proteção real é o app
// checar quem está logado como quê antes de mostrar/permitir cada coisa, não
// criptografia de ponta a ponta (mesmo nível da antiga senha fixa do caixa,
// só que agora por usuário e com controle de tela por tela).
//
// Este módulo não importa nada de app.js (mesma regra de barracas.js, evita
// import circular). app.js é quem importa daqui: `resolverSessaoAtiva()`
// (chamada uma vez no window.onload, antes até de resolverBarracaAtiva()) e
// `usuarioTemAcesso()` (usada dentro de mudarAba() pra bloquear telas sem
// permissão).

import { supabaseClient, PDV_CLIENT_ID } from './config.js';

const CHAVE_SESSAO_LOCAL = 'pdv_sessao_usuario_id';

export let usuarioAtual = null; // { id, nome, isMaster, telasPermitidas }
let perfisCache = [];

// Lista de telas que podem ser liberadas por usuário. "tela-gestao-usuarios"
// fica de fora de propósito — é sempre exclusiva do Master (ver
// usuarioTemAcesso), nunca algo que se marca na grade de permissões.
const TELAS_DISPONIVEIS = [
    { id: 'tela-pedido', label: '🛒 Pedido' },
    { id: 'tela-agendados', label: '🎫 Pedido Ficha' },
    { id: 'tela-preparo', label: '🍳 Cozinha' },
    { id: 'tela-entrega', label: '🛍️ Balcão/Entrega' },
    { id: 'tela-tv', label: '📺 TV Aberta' },
    { id: 'tela-videowall', label: '🎛️ Multiview 4x4' },
    { id: 'tela-produtos', label: '📦 Produtos & Estoque' },
    { id: 'tela-atalhos', label: '⌨️ Teclas de Atalho' },
    { id: 'tela-configuracoes', label: '⚙️ Configurações & Parâmetros' },
    { id: 'tela-barracas', label: '🏪 Barracas' },
    { id: 'tela-gestao', label: '📋 Gestão de Pedidos' },
    { id: 'tela-relatorio', label: '📈 Dashboard Analytics' },
    { id: 'tela-dashboard-geral', label: '🏬 Dashboard Geral' },
    { id: 'tela-fechamento-caixa', label: '📜 Histórico de Caixas' }
];

async function hashSenha(senha) {
    const dados = new TextEncoder().encode(senha);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dados);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function mapearPerfil(linha) {
    return { id: linha.id, nome: linha.nome, isMaster: !!linha.is_master, telasPermitidas: linha.telas_permitidas || [] };
}

function avisar(mensagem, titulo) {
    if (window.exibirAviso) window.exibirAviso(mensagem, titulo);
    else alert(mensagem);
}

// Único ponto de checagem de permissão — usado tanto pra esconder botões
// (aplicarPermissoesNaUI) quanto, de verdade, dentro de mudarAba() em app.js.
export function usuarioTemAcesso(idAba) {
    if (!usuarioAtual) return false;
    if (usuarioAtual.isMaster) return true;
    if (idAba === 'tela-gestao-usuarios') return false; // sempre exclusiva do Master
    return (usuarioAtual.telasPermitidas || []).includes(idAba);
}

// Esconde no menu tudo que o usuário logado não pode acessar. Varre qualquer
// elemento cujo onclick chame mudarAba('idAba', ...) — cobre ao mesmo tempo
// os botões do nav e os itens dentro dos dropdowns, sem precisar listar cada
// um manualmente. Isso só cuida da UI; quem realmente barra o acesso é a
// checagem dentro de mudarAba() (ver app.js) — sem ela, bastaria abrir o
// DevTools e chamar mudarAba() na mão pra contornar o menu escondido.
export function aplicarPermissoesNaUI() {
    if (!usuarioAtual) return;
    document.querySelectorAll('[onclick*="mudarAba("]').forEach(el => {
        const m = el.getAttribute('onclick').match(/mudarAba\('([^']+)'/);
        if (!m) return;
        el.style.display = usuarioTemAcesso(m[1]) ? '' : 'none';
    });
    const nomeEl = document.getElementById('nome-usuario-atual-nav');
    if (nomeEl) nomeEl.innerText = usuarioAtual.nome + (usuarioAtual.isMaster ? ' (Master)' : '');
}

async function carregarPerfilPorId(id) {
    const { data, error } = await supabaseClient.from('pdv_perfis').select('*').eq('id', id).maybeSingle();
    if (error || !data) return null;
    return mapearPerfil(data);
}

// Resolve quem está usando este dispositivo. Mesmo formato de
// resolverBarracaAtiva() em barracas.js: assíncrona, some sozinha se já
// houver uma sessão local válida, ou mostra uma tela cheia e só retorna
// quando o usuário terminar (login normal, ou criação da conta Master na
// primeira vez que o app roda em qualquer lugar).
export async function resolverSessaoAtiva() {
    let semNenhumUsuarioAinda;
    try {
        const { count, error } = await supabaseClient.from('pdv_perfis').select('id', { count: 'exact', head: true });
        if (error) throw error;
        semNenhumUsuarioAinda = (count || 0) === 0;
    } catch (erro) {
        console.error('Não foi possível consultar pdv_perfis — provavelmente o script supabase/pdv_perfis.sql ainda não foi rodado:', erro);
        renderizarErroConfiguracao();
        return new Promise(() => {}); // trava aqui de propósito, mostrando o aviso de configuração pendente
    }

    if (semNenhumUsuarioAinda) {
        return new Promise(resolve => renderizarTelaBootstrap(resolve));
    }

    const idSalvo = localStorage.getItem(CHAVE_SESSAO_LOCAL);
    if (idSalvo) {
        const perfil = await carregarPerfilPorId(idSalvo);
        if (perfil) {
            usuarioAtual = perfil;
            return perfil;
        }
        localStorage.removeItem(CHAVE_SESSAO_LOCAL); // usuário removido por um Master nesse meio tempo
    }

    return new Promise(resolve => renderizarTelaLogin(resolve));
}

function renderizarErroConfiguracao() {
    const tela = document.getElementById('tela-login');
    tela.style.display = 'flex';
    tela.querySelector('.modal-content').innerHTML = `
        <h2 style="margin-top:0; color: var(--danger);">⚠️ Configuração pendente</h2>
        <p style="color:#374151;">Não foi possível encontrar a tabela de usuários no Supabase. Rode o script
        <code>supabase/pdv_perfis.sql</code> no SQL Editor do projeto Supabase antes de usar o login.</p>
    `;
}

function renderizarTelaBootstrap(aoConcluir) {
    const tela = document.getElementById('tela-master-bootstrap');
    tela.style.display = 'flex';

    window.criarContaMaster = async () => {
        const nome = document.getElementById('input-master-nome').value.trim();
        const senha = document.getElementById('input-master-senha').value;
        if (!nome) return avisar('Digite um nome para a conta Master.');
        if (!senha || senha.length < 6) return avisar('A senha precisa ter pelo menos 6 caracteres.');

        const botao = document.getElementById('btn-criar-master');
        botao.disabled = true;
        try {
            const senha_hash = await hashSenha(senha);
            const { data, error } = await supabaseClient.from('pdv_perfis')
                .insert({ nome, senha_hash, is_master: true, telas_permitidas: [] })
                .select().single();
            if (error) throw error;

            usuarioAtual = mapearPerfil(data);
            localStorage.setItem(CHAVE_SESSAO_LOCAL, data.id);
            tela.style.display = 'none';
            aoConcluir(usuarioAtual);
        } catch (erro) {
            console.error('Falha ao criar conta Master:', erro);
            avisar(`Não foi possível criar a conta Master: ${erro.message || erro}`);
        } finally {
            botao.disabled = false;
        }
    };
}

function renderizarTelaLogin(aoConcluir) {
    const tela = document.getElementById('tela-login');
    tela.style.display = 'flex';

    window.fazerLogin = async () => {
        const nome = document.getElementById('input-login-nome').value.trim();
        const senha = document.getElementById('input-login-senha').value;
        if (!nome || !senha) return avisar('Preencha usuário e senha.');

        const botao = document.getElementById('btn-fazer-login');
        botao.disabled = true;
        try {
            const senha_hash = await hashSenha(senha);
            const { data, error } = await supabaseClient.from('pdv_perfis').select('*').eq('nome', nome).maybeSingle();
            if (error) throw error;
            if (!data || data.senha_hash !== senha_hash) {
                avisar('Usuário ou senha incorretos.');
                return;
            }
            usuarioAtual = mapearPerfil(data);
            localStorage.setItem(CHAVE_SESSAO_LOCAL, data.id);
            tela.style.display = 'none';
            document.getElementById('input-login-senha').value = '';
            aoConcluir(usuarioAtual);
        } catch (erro) {
            console.error('Falha no login:', erro);
            avisar('Não foi possível fazer login. Tente novamente.');
        } finally {
            botao.disabled = false;
        }
    };
}

export function fazerLogout() {
    localStorage.removeItem(CHAVE_SESSAO_LOCAL);
    location.reload();
}

// --- Tela de gestão de usuários (exclusiva do Master) ---

async function carregarPerfis() {
    const { data, error } = await supabaseClient.from('pdv_perfis').select('*').order('criado_em', { ascending: true });
    if (error) throw error;
    perfisCache = data || [];
}

export async function renderizarTelaGestaoUsuarios() {
    if (!usuarioAtual || !usuarioAtual.isMaster) return;

    const gridNovo = document.getElementById('grid-telas-novo-usuario');
    if (gridNovo && !gridNovo.dataset.montado) {
        gridNovo.innerHTML = TELAS_DISPONIVEIS.map(t => `
            <label class="item-checkbox-ingrediente">
                <input type="checkbox" class="chk-tela-novo-usuario" value="${t.id}"> ${t.label}
            </label>
        `).join('');
        gridNovo.dataset.montado = '1';
    }

    try {
        await carregarPerfis();
    } catch (erro) {
        console.error('Falha ao carregar usuários:', erro);
        avisar('Não foi possível carregar a lista de usuários.');
        return;
    }

    const tbody = document.getElementById('tabela-usuarios');
    if (!tbody) return;

    if (perfisCache.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:gray; padding:20px;">Nenhum usuário cadastrado ainda.</td></tr>';
        return;
    }

    tbody.innerHTML = perfisCache.map(p => {
        const resumoTelas = p.is_master
            ? 'Todas (Master)'
            : ((p.telas_permitidas || []).length ? `${p.telas_permitidas.length} tela(s)` : '<span style="color:var(--danger);">Nenhuma</span>');
        const voceMesmo = usuarioAtual.id === p.id;
        return `
            <tr style="border-bottom: 1px solid #e5e7eb;">
                <td style="padding:10px; font-weight:bold;">${p.nome} ${voceMesmo ? '<span style="color:var(--success); font-size:0.75rem;">(você)</span>' : ''}</td>
                <td>${p.is_master ? '🟢 Sim' : '—'}</td>
                <td>${resumoTelas}</td>
                <td style="text-align:right; white-space:nowrap;">
                    ${p.is_master ? '<span style="color:gray; font-size:0.8rem;">—</span>' : `
                        <button class="btn btn-warning" style="padding:6px 10px;" data-editar-perm-id="${p.id}">✏️ Editar</button>
                        <button class="btn btn-danger" style="padding:6px 10px;" data-apagar-usuario-id="${p.id}">🗑️ Remover</button>
                    `}
                </td>
            </tr>`;
    }).join('');

    tbody.querySelectorAll('button[data-apagar-usuario-id]').forEach(btn => {
        btn.onclick = async () => {
            if (!confirm('Remover este usuário? Ele não vai mais conseguir entrar no sistema.')) return;
            try {
                const { error } = await supabaseClient.from('pdv_perfis').delete().eq('id', btn.dataset.apagarUsuarioId);
                if (error) throw error;
                renderizarTelaGestaoUsuarios();
            } catch (erro) {
                console.error('Falha ao remover usuário:', erro);
                avisar('Não foi possível remover este usuário.');
            }
        };
    });

    tbody.querySelectorAll('button[data-editar-perm-id]').forEach(btn => {
        btn.onclick = () => abrirModalPermissoes(btn.dataset.editarPermId);
    });
}

export async function criarUsuarioForm() {
    const nome = document.getElementById('input-novo-usuario-nome').value.trim();
    const senha = document.getElementById('input-novo-usuario-senha').value;
    const telas = Array.from(document.querySelectorAll('.chk-tela-novo-usuario:checked')).map(chk => chk.value);

    if (!nome) return avisar('Digite o nome do usuário.');
    if (!senha || senha.length < 6) return avisar('A senha precisa ter pelo menos 6 caracteres.');

    const botao = document.getElementById('btn-criar-usuario');
    botao.disabled = true;
    try {
        const senha_hash = await hashSenha(senha);
        const { error } = await supabaseClient.from('pdv_perfis').insert({
            nome, senha_hash, is_master: false, telas_permitidas: telas
        });
        if (error) throw error;

        document.getElementById('input-novo-usuario-nome').value = '';
        document.getElementById('input-novo-usuario-senha').value = '';
        document.querySelectorAll('.chk-tela-novo-usuario').forEach(chk => chk.checked = false);
        avisar(`Usuário "${nome}" criado com sucesso!`);
        renderizarTelaGestaoUsuarios();
    } catch (erro) {
        console.error('Falha ao criar usuário:', erro);
        const msg = erro.code === '23505' ? 'Já existe um usuário com esse nome.' : `Não foi possível criar o usuário: ${erro.message || erro}`;
        avisar(msg);
    } finally {
        botao.disabled = false;
    }
}

function abrirModalPermissoes(id) {
    const perfil = perfisCache.find(p => p.id === id);
    if (!perfil) return;

    const modal = document.getElementById('modal-permissoes-usuario');
    document.getElementById('titulo-modal-permissoes').innerText = `Editar ${perfil.nome}`;
    document.getElementById('input-nova-senha-usuario').value = '';

    const grid = document.getElementById('grid-telas-editar-usuario');
    grid.innerHTML = TELAS_DISPONIVEIS.map(t => `
        <label class="item-checkbox-ingrediente">
            <input type="checkbox" class="chk-tela-editar-usuario" value="${t.id}" ${(perfil.telas_permitidas || []).includes(t.id) ? 'checked' : ''}> ${t.label}
        </label>
    `).join('');

    modal.dataset.usuarioId = id;
    modal.style.display = 'flex';
}

export function fecharModalPermissoes() {
    document.getElementById('modal-permissoes-usuario').style.display = 'none';
}

export async function salvarPermissoesUsuario() {
    const modal = document.getElementById('modal-permissoes-usuario');
    const id = modal.dataset.usuarioId;
    const telas = Array.from(document.querySelectorAll('.chk-tela-editar-usuario:checked')).map(chk => chk.value);
    const novaSenha = document.getElementById('input-nova-senha-usuario').value;

    if (novaSenha && novaSenha.length < 6) {
        return avisar('A nova senha precisa ter pelo menos 6 caracteres.');
    }

    try {
        const atualizacao = { telas_permitidas: telas };
        if (novaSenha) atualizacao.senha_hash = await hashSenha(novaSenha);

        const { error } = await supabaseClient.from('pdv_perfis').update(atualizacao).eq('id', id);
        if (error) throw error;
        fecharModalPermissoes();
        renderizarTelaGestaoUsuarios();
    } catch (erro) {
        console.error('Falha ao salvar alterações do usuário:', erro);
        avisar('Não foi possível salvar as alterações.');
    }
}

// --- Deslogar todo mundo ao fechar o caixa (exceto o Master) ---
//
// Segue a mesma convenção dos outros canais de Realtime (pdv-state-sync,
// pdv-catalogo-sync, pdv-registry-sync): observa uma linha reservada de
// `pdv_state`, ignora o próprio eco via PDV_CLIENT_ID. É um AVISO em tempo
// real pra quem está com o app aberto e online — um dispositivo offline no
// momento do aviso só perde a sessão local na próxima vez que carregar a
// página (não há token remoto pra revogar, já que o login aqui não usa JWT).
export function chaveLogoutForcado(barracaId) {
    return `__logout_${barracaId}__`;
}

export async function dispararLogoutForcado(barracaId) {
    try {
        const { error } = await supabaseClient.from('pdv_state').upsert({
            id: chaveLogoutForcado(barracaId),
            data: { forcarLogoutEm: new Date().toISOString(), origem: PDV_CLIENT_ID },
            updated_at: new Date().toISOString()
        }, { onConflict: 'id' });
        if (error) throw error;
    } catch (erro) {
        console.error('Falha ao avisar os outros dispositivos pra deslogar:', erro);
    }
}

export function iniciarRealtimeLogoutForcado(barracaId) {
    supabaseClient
        .channel('pdv-logout-forcado')
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'pdv_state',
            filter: `id=eq.${chaveLogoutForcado(barracaId)}`
        }, payload => {
            const dados = payload.new && payload.new.data;
            if (!dados || dados.origem === PDV_CLIENT_ID) return;
            if (usuarioAtual && usuarioAtual.isMaster) return; // Master é poupado
            fazerLogout();
        })
        .subscribe(status => {
            console.log('Supabase Realtime (logout forçado):', status);
        });
}

window.fazerLogout = fazerLogout;
window.criarUsuarioForm = criarUsuarioForm;
window.fecharModalPermissoes = fecharModalPermissoes;
window.salvarPermissoesUsuario = salvarPermissoesUsuario;
