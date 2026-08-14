// Lógica principal do PDV Santa Rita.
//
// Este módulo concentra o estado da aplicação (produtos, pedidos, carrinho,
// caixa, atalhos) e todas as funções de UI/negócio. As funções referenciadas
// via onclick="..." no HTML (estático ou gerado dinamicamente via innerHTML)
// são expostas em 'window' no final do arquivo, pois módulos ES não vazam
// suas declarações para o escopo global automaticamente.

import { supabaseClient, PDV_CLIENT_ID } from './config.js';
import { categoriasPadrao, produtosPadrao } from './data.js';
import { resolverBarracaAtiva, calcularResumoPedidos, chaveCacheEstado, chaveCacheAtalhos, renderizarPainelBarracas, carregarDashboardGeral, iniciarRealtimeRegistroBarracas, registroBarracas } from './barracas.js';
import { resolverSessaoAtiva, usuarioTemAcesso, aplicarPermissoesNaUI, renderizarTelaGestaoUsuarios, confirmarSenhaUsuarioAtual, usuarioAtual, registrarLog, tentarEnviarFilaDeLogs } from './auth.js';

        // Id da barraca ativa neste dispositivo (linha correspondente na tabela
        // `pdv_state` do Supabase). Só é conhecido depois que resolverBarracaAtiva()
        // roda no window.onload — antes disso o app não deve ler/gravar estado
        // nenhum, por isso os valores abaixo começam nos padrões "vazios" e só são
        // preenchidos por carregarCacheLocalDaBarraca()/carregarEstadoSupabase().
        let barracaStateId = null;

        // Catálogo de produtos e categorias: ÚNICO, compartilhado entre todas as
        // barracas (não faz parte do estado de uma barraca específica). Vive numa
        // linha própria no Supabase (id = CATALOGO_ID, ver mais abaixo), separada
        // da linha de estado de cada barraca. Cada produto tem um campo
        // `barracas: string[]` com os ids das barracas onde ele deve aparecer.
        const CATALOGO_ID = '__catalogo__';
        let categoriasDB = JSON.parse(JSON.stringify(categoriasPadrao));
        // Subcategorias organizadas por categoria: { "Bebidas": ["Refrigerantes","Sucos"] }.
        // Faz parte do catálogo compartilhado, igual categoriasDB/produtosDB.
        let subcategoriasDB = {};
        let produtosDB = JSON.parse(JSON.stringify(produtosPadrao)).map(p => {
            const { estoque, ...resto } = p; // estoque não é mais um campo do produto — é por barraca (estoquePorProduto)
            return { ...resto, barracas: [] };
        });
        produtosDB.forEach(p => { if (p.ativo === undefined) p.ativo = true; });
        let carregandoCatalogoRemoto = false;

        // Estoque É por barraca: { [idProduto]: quantidade|null }. null = estoque
        // livre/não controlado (mesmo significado que produto.estoque === null tinha
        // antes). Faz parte do estado desta barraca, não do catálogo compartilhado.
        let estoquePorProduto = {};

        let pedidosGerais = [];
        let contadorPedidos = 1;
        let historicoCaixasDB = [];

        // Vários caixas podem estar abertos ao mesmo tempo nesta barraca — um
        // por usuário (ver caixaDoUsuarioAtual()). Cada item:
        // { id, usuarioId, usuarioNome, valorFundoCaixa, dataHoraAbertura }.
        let caixasAbertos = [];
        let caixaRelatorioSelecionado = null; // null = aba "Todos" no Dashboard Analytics
        // Fechamentos marcados na tela de Histórico de Caixas pra gerar um
        // relatório combinado (soma de vários caixas do mesmo dia/evento) —
        // ver renderizarHistoricoCaixas/imprimirRelatorioCombinado.
        let fechamentosSelecionadosParaRelatorio = new Set();

        let supabaseDisponivel = true;
        let carregandoEstadoRemoto = false;
        let ultimaAtualizacaoRemota = null;
        let intervaloTentativaReconexao = null;
        let offlineDesde = null;

        function telaAtual() {
            const el = document.querySelector('.tab-content.active');
            return el ? el.id : null;
        }

        // Mostra/esconde a faixa vermelha fixa no topo — único lugar que
        // escreve em supabaseDisponivel, pra garantir que o indicador visual
        // nunca fique dessincronizado do valor real. Também é o único lugar
        // que loga queda/volta de conexão (pdv_logs) e liga/desliga a
        // tentativa automática de reconexão — funciona mesmo pra quedas que o
        // canal de tempo real nem avisa (ele pode cair em silêncio), porque
        // isso aqui só depende de uma leitura/escrita real ter falhado.
        function definirSupabaseDisponivel(valor) {
            const mudou = supabaseDisponivel !== valor;
            supabaseDisponivel = valor;
            const indicador = document.getElementById('indicador-offline');
            if (indicador) indicador.style.display = valor ? 'none' : 'flex';

            if (!mudou) return;

            if (!valor) {
                offlineDesde = Date.now();
                registrarLog('offline', null, { tela: telaAtual(), barracaId: barracaStateId });
                if (!intervaloTentativaReconexao) {
                    intervaloTentativaReconexao = setInterval(() => {
                        resincronizarSeNecessario('tentativa automática de reconexão');
                    }, 10000);
                }
            } else {
                const detalhe = offlineDesde ? `Ficou offline por ${Math.round((Date.now() - offlineDesde) / 1000)}s` : null;
                registrarLog('online', detalhe, { tela: telaAtual(), barracaId: barracaStateId });
                tentarEnviarFilaDeLogs();
                tentarEnviarFilaDeFechamentos();
                if (intervaloTentativaReconexao) { clearInterval(intervaloTentativaReconexao); intervaloTentativaReconexao = null; }
                offlineDesde = null;
            }
        }

        // Captura qualquer erro JS não tratado (e Promise rejeitada sem
        // .catch) e manda pra pdv_logs — junto com qual tela estava ativa e
        // qual usuário estava logado, pra dar pra investigar "o sistema
        // bugou" depois sem precisar reproduzir na hora. Não interfere em
        // nada da UI (não mostra nada pro usuário, só registra).
        window.addEventListener('error', (evento) => {
            registrarLog('erro', `${evento.message} (${evento.filename}:${evento.lineno})`, { tela: telaAtual(), barracaId: barracaStateId });
        });
        window.addEventListener('unhandledrejection', (evento) => {
            const motivo = evento.reason && evento.reason.message ? evento.reason.message : String(evento.reason);
            registrarLog('erro', `Promise rejeitada: ${motivo}`, { tela: telaAtual(), barracaId: barracaStateId });
        });

        // TECLAS DE ATALHO PADRÃO
        let atalhosConfig = {
            direita: '1',
            esquerda: '2',
            chamar: '3',
            entregue: '4'
        };
        let gravandoAtalhoAcao = null;
        let indexPedidoSelecionadoBalcao = 0;
        let indexPedidoSelecionadoCozinha = 0;
        let indexPedidoSelecionadoPausa = 0;

        // PARÂMETROS PADRÃO DA TELA DE PEDIDO (pré-seleção de forma de pagamento /
        // tipo de retirada / modo de retirada global toda vez que o carrinho é
        // limpo). Local por dispositivo, igual atalhosConfig — não sincroniza via
        // Supabase, pois é preferência de operação de quem está usando este caixa.
        let configPadroes = {
            formaPagto: '',
            tipoAtendimento: '',
            tipoRetiradaGlobal: '',
            // Pedido sem NENHUM item de cozinha (doce, refri...) vai pro
            // Balcão 02 em vez do Balcão 01 — ver atualizarTelas().
            separarBalcaoDoces: false,
            // Desligado = pula direto pro botão "Entregue" (sem tocar som/
            // exigir "Chamar Painel" antes) — ver atualizarTelas().
            chamarAtivoBalcao01: true,
            chamarAtivoBalcaoDoces: true,
            // Dados do recebedor pro QR Code de Pix (ver montarPayloadPix) —
            // cada barraca tem sua própria conta/chave.
            pixChave: '',
            pixNomeRecebedor: '',
            pixCidadeRecebedor: '',
            // Taxa (%) que a maquininha desconta em cada forma — usado só
            // pra calcular Lucro Real no Dashboard/Fechamento de Caixa (ver
            // calcularCustoProducaoTotal/obterDadosRelatorioCaixa). Pix
            // Direto (conta) e Dinheiro não têm taxa de maquininha, por
            // isso não têm campo aqui.
            taxaCredito: 0,
            taxaDebito: 0,
            taxaPix: 0
        };

        function exibirAviso(mensagem, titulo = "Aviso do Sistema") {
            document.getElementById('modal-aviso-titulo').innerText = titulo;
            document.getElementById('modal-aviso-mensagem').innerText = mensagem;
            document.getElementById('modal-aviso').style.display = 'flex';
        }

        function fecharAviso() {
            document.getElementById('modal-aviso').style.display = 'none';
        }

        // Antes a foto ia como base64 direto dentro do JSON do catálogo
        // (pdv_state) — com muitos produtos com foto isso incha o blob que é
        // lido/gravado inteiro a cada save, deixando tudo mais lento. Agora
        // sobe pro Supabase Storage e só o link fica salvo no produto.
        const BUCKET_FOTOS_PRODUTO = 'produtos-fotos';
        let uploadFotoEmAndamento = false;

        async function processarUploadFoto(input) {
            if (!input.files || !input.files[0]) return;
            const file = input.files[0];
            if (file.size > 2 * 1024 * 1024) {
                exibirAviso("A foto escolhida é muito grande! Escolha uma imagem de até 2MB.");
                input.value = "";
                return;
            }

            const fotoAnterior = document.getElementById('novo-prod-foto').value;
            const previewImg = document.getElementById('preview-foto-img');
            const previewContainer = document.getElementById('preview-foto-container');
            const status = document.getElementById('status-upload-foto');

            // Preview local imediato (não espera a rede) — a URL real do
            // Storage só substitui isso depois que o upload terminar.
            previewImg.src = URL.createObjectURL(file);
            previewContainer.style.display = 'block';
            status.innerText = 'Enviando foto...';
            status.style.display = 'inline';
            uploadFotoEmAndamento = true;

            const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
            const nomeArquivo = `foto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

            const { error } = await supabaseClient.storage.from(BUCKET_FOTOS_PRODUTO).upload(nomeArquivo, file, { cacheControl: '3600', upsert: false });
            uploadFotoEmAndamento = false;

            if (error) {
                exibirAviso("Não deu pra enviar a foto agora (sem internet, ou o bucket de fotos ainda não foi criado no Supabase). Tente de novo.");
                status.style.display = 'none';
                input.value = "";
                if (fotoAnterior) { previewImg.src = fotoAnterior; } else { previewContainer.style.display = 'none'; }
                return;
            }

            const { data } = supabaseClient.storage.from(BUCKET_FOTOS_PRODUTO).getPublicUrl(nomeArquivo);
            document.getElementById('novo-prod-foto').value = data.publicUrl;
            status.style.display = 'none';
        }

        // Estado desta barraca: pedidos, caixa, estoque. NÃO inclui mais
        // categoriasDB/produtosDB — isso é o catálogo compartilhado, sincronizado
        // separadamente (ver montarCatalogoAtual/salvarCatalogo mais abaixo). Também
        // não inclui mais historicoCaixasDB — isso agora é a tabela própria
        // pdv_historico_caixas (ver carregarHistoricoCaixas/
        // enviarFechamentoParaSupabase), pra não crescer sem limite dentro
        // deste blob que é lido/gravado inteiro a cada ação do sistema.
        function montarEstadoAtual() {
            return {
                pedidosGerais,
                contadorPedidos,
                caixasAbertos,
                estoquePorProduto,
                configPadroes,
                origem: PDV_CLIENT_ID,
                salvoEm: new Date().toISOString()
            };
        }

        function salvarCacheLocal() {
            // Cache com escopo por barraca (chaveCacheEstado inclui o barracaStateId),
            // para que duas barracas usadas no mesmo navegador/dispositivo nunca
            // se misturem no cache local — só o que vem do Supabase é compartilhado,
            // e mesmo assim cada barraca tem sua própria linha lá.
            localStorage.setItem(chaveCacheEstado(barracaStateId), JSON.stringify(montarEstadoAtual()));
            localStorage.setItem(chaveCacheAtalhos(barracaStateId), JSON.stringify(atalhosConfig));
        }

        // Pinta a tela imediatamente com o que já está em cache local desta
        // barraca (se houver), antes/independente da resposta do Supabase.
        // Chamada uma vez, logo depois que barracaStateId é resolvido.
        function carregarCacheLocalDaBarraca() {
            try {
                const raw = localStorage.getItem(chaveCacheEstado(barracaStateId));
                if (raw) aplicarEstado(JSON.parse(raw), false);
            } catch (erro) {
                console.error('Cache local de estado corrompido, ignorando:', erro);
            }
            try {
                const rawAtalhos = localStorage.getItem(chaveCacheAtalhos(barracaStateId));
                if (rawAtalhos) atalhosConfig = JSON.parse(rawAtalhos);
            } catch (erro) {
                console.error('Cache local de atalhos corrompido, ignorando:', erro);
            }
        }

        function aplicarEstado(estado, atualizarUI = true) {
            if (!estado) return;
            carregandoEstadoRemoto = true;

            // MESCLA em vez de SOBRESCREVER — antes, chegar estado daqui
            // (boot, push em tempo real de outro dispositivo, ou
            // resincronizarSeNecessario reconectando) apagava qualquer
            // alteração local ainda não salva (ex: clicou "Chamar" e
            // "Entregue" num pedido offline, mas a internet voltou e um
            // resync chegou ANTES do próximo salvarNoBancoLocal() — a baixa
            // sumia, sem aviso nenhum). salvarNoBancoLocal() já mesclava
            // nesse sentido só na GRAVAÇÃO; isso aqui fecha o mesmo buraco
            // na LEITURA, usando os mesmos mesclarPorIdComColisao/
            // mesclarPorUniao (local sempre vence quando é a mesma entrada
            // ainda não sincronizada; se for colisão de verdade, os dois
            // sobrevivem, um ganha número novo).
            if (Array.isArray(estado.pedidosGerais)) {
                const mescladoPedidos = mesclarPorIdComColisao(pedidosGerais, estado.pedidosGerais);
                pedidosGerais = mescladoPedidos.lista;
                if (mescladoPedidos.houveColisao) {
                    exibirAviso('⚠️ Dois dispositivos criaram um pedido com o mesmo número quase ao mesmo tempo — o sistema corrigiu sozinho, sem apagar nenhum dos dois, mas um deles pode ter ganhado um número novo. Confira "Ver Todos os Pedidos" se algo parecer com número trocado.', 'Sincronização');
                }
            }
            contadorPedidos = Number.isFinite(Number(estado.contadorPedidos)) ? Math.max(contadorPedidos, Number(estado.contadorPedidos)) : contadorPedidos;
            garantirContadorPedidosAdiante();

            if (Array.isArray(estado.caixasAbertos)) {
                caixasAbertos = podarCaixasFechadas(mesclarCaixasAbertos(caixasAbertos, estado.caixasAbertos));
            } else if (estado.caixaAberto === true) {
                // Migração: estado salvo no formato antigo (1 caixa único pra
                // barraca inteira) com um caixa aberto na hora da atualização —
                // preserva como um caixa "legado" em vez de simplesmente perder
                // o fundo e os pedidos em aberto.
                caixasAbertos = [{
                    id: 'legado',
                    usuarioId: null,
                    usuarioNome: 'Caixa (antes da atualização)',
                    valorFundoCaixa: Number(estado.valorFundoCaixa) || 0,
                    dataHoraAbertura: estado.dataHoraAberturaCaixa || null
                }];
                pedidosGerais.forEach(p => { if (!p.caixaId) p.caixaId = 'legado'; });
            }

            if (estado.estoquePorProduto && typeof estado.estoquePorProduto === 'object') {
                estoquePorProduto = estado.estoquePorProduto;
            } else if (Array.isArray(estado.produtosDB)) {
                // Migração automática: linha ainda no formato antigo (de antes do
                // catálogo único existir), onde cada produto carregava seu próprio
                // `estoque`. Extrai esses valores para o novo formato por barraca.
                // A partir do próximo salvarNoBancoLocal() esta linha já sai no
                // formato novo (produtosDB/categoriasDB somem daqui, vão só para
                // o catálogo compartilhado).
                estoquePorProduto = {};
                estado.produtosDB.forEach(p => { estoquePorProduto[p.id] = (p.estoque === undefined ? null : p.estoque); });
            }

            if (estado.configPadroes && typeof estado.configPadroes === 'object') {
                configPadroes = { ...configPadroes, ...estado.configPadroes };
                aplicarVisibilidadeBalcaoDoces();
                atualizarBotoesChamarAtivo();
            }

            ultimaAtualizacaoRemota = estado.salvoEm || null;
            salvarCacheLocal();
            carregandoEstadoRemoto = false;

            if (atualizarUI) {
                atualizarInterfaceCaixa();
                renderizarMenu(categoriaFiltroAtual);
                renderizarTabelaProdutos();
                atualizarTelas();
                atualizarFiltrosGestao();
                renderizarHistoricoCaixas();
                renderizarPainelAtalhos();
                const modalConfig = document.getElementById('modal-config-pedido');
                if (modalConfig && modalConfig.style.display === 'flex') carregarFormularioConfiguracoes();
                const relatorio = document.getElementById('tela-relatorio');
                if (relatorio && relatorio.classList.contains('active')) atualizarDashboard();
            }
        }

        // --- Navegação por teclado na tela de Pedido (setas + Enter) ---
        // Só ativa quando a tela de Pedido está aberta e o foco não está
        // dentro de um campo de texto (senão as setas atrapalhariam digitar
        // na busca ou no nome do cliente).
        let indiceProdutoFocadoTeclado = -1;

        function cardsProdutoVisiveis() {
            return Array.from(document.querySelectorAll('#menu-produtos .card-produto'));
        }

        function aplicarFocoVisualProduto() {
            const cards = cardsProdutoVisiveis();
            cards.forEach((c, i) => c.classList.toggle('card-focado-teclado', i === indiceProdutoFocadoTeclado));
            if (indiceProdutoFocadoTeclado >= 0 && cards[indiceProdutoFocadoTeclado]) {
                cards[indiceProdutoFocadoTeclado].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }

        function navegacaoTecladoPedidoAtiva() {
            const telaPedido = document.getElementById('tela-pedido');
            if (!telaPedido || !telaPedido.classList.contains('active')) return false;
            const ativo = document.activeElement;
            const tag = ativo ? ativo.tagName : '';
            return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
        }

        document.addEventListener('keydown', (e) => {
            if (!navegacaoTecladoPedidoAtiva()) return;
            const cards = cardsProdutoVisiveis();
            if (cards.length === 0) return;

            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                indiceProdutoFocadoTeclado = Math.min(indiceProdutoFocadoTeclado + 1, cards.length - 1);
                aplicarFocoVisualProduto();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                indiceProdutoFocadoTeclado = Math.max(indiceProdutoFocadoTeclado - 1, 0);
                aplicarFocoVisualProduto();
            } else if (e.key === 'Enter') {
                if (indiceProdutoFocadoTeclado >= 0 && cards[indiceProdutoFocadoTeclado]) {
                    e.preventDefault();
                    cards[indiceProdutoFocadoTeclado].click();
                }
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                if (carrinho.length > 0) {
                    e.preventDefault();
                    removerItemCarrinho(carrinho[carrinho.length - 1].cartId);
                }
            }
        });

        // --- Teclado numérico próprio em tablet/celular (evita abrir o
        // teclado nativo do sistema operacional por cima de campos de
        // número) — só ativa em dispositivos de toque (pointer:coarse);
        // desktop com mouse/teclado físico continua digitando normal. ---
        let inputTecladoNumericoAtivo = null;

        function ehDispositivoDeToque() {
            return window.matchMedia('(pointer: coarse)').matches;
        }

        function configurarTecladoNumerico(input) {
            if (input.dataset.tecladoConfigurado) return;
            input.dataset.tecladoConfigurado = '1';
            input.setAttribute('inputmode', 'none');
            input.readOnly = true;
            input.style.cursor = 'pointer';
            input.addEventListener('focus', () => abrirTecladoNumerico(input));
            input.addEventListener('click', () => abrirTecladoNumerico(input));
        }

        function ativarTecladoNumericoSeTablet() {
            if (!ehDispositivoDeToque()) return;
            document.querySelectorAll('input[type="number"]').forEach(configurarTecladoNumerico);
        }

        function abrirTecladoNumerico(input) {
            inputTecladoNumericoAtivo = input;
            document.getElementById('teclado-numerico-flutuante').style.display = 'block';
            atualizarPreviewTecladoNumerico();
        }

        function fecharTecladoNumerico() {
            document.getElementById('teclado-numerico-flutuante').style.display = 'none';
            inputTecladoNumericoAtivo = null;
        }

        // O teclado flutuante fica por cima do campo de verdade (às vezes até
        // cobrindo ele, dependendo de onde o campo está na tela) — esse mini
        // visor mostra o valor digitado até agora sem precisar ver o campo
        // original por trás.
        function atualizarPreviewTecladoNumerico() {
            const preview = document.getElementById('preview-teclado-numerico');
            const input = inputTecladoNumericoAtivo;
            if (!preview || !input) return;
            preview.innerText = input.value || '';
        }

        function digitarTecladoNumerico(tecla) {
            const input = inputTecladoNumericoAtivo;
            if (!input) return;
            if (tecla === '⌫') {
                input.value = input.value.slice(0, -1);
            } else if (tecla === '.') {
                if (!input.value.includes('.')) input.value += '.';
            } else {
                input.value += tecla;
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            atualizarPreviewTecladoNumerico();
        }

        // --- Substitutos de prompt()/confirm() nativos (janela própria em
        // HTML, dá pra mascarar senha e não fica com a cara do navegador) ---

        // Alterna um <input type="password"> pra "text" e volta — usado pelo
        // ícone de olho em toda tela que pede senha (login, criar usuário,
        // resetar senha, confirmar senha do caixa).
        function alternarMostrarSenha(idInput, btnEl) {
            const input = document.getElementById(idInput);
            if (!input) return;
            const mostrando = input.type === 'text';
            input.type = mostrando ? 'password' : 'text';
            btnEl.innerText = mostrando ? '👁️' : '🙈';
        }

        function pedirTexto(mensagem, { titulo = 'Confirme', senha = false, valorInicial = '' } = {}) {
            return new Promise(resolve => {
                const modal = document.getElementById('modal-prompt-generico');
                document.getElementById('titulo-prompt-generico').innerText = titulo;
                document.getElementById('texto-prompt-generico').innerText = mensagem;
                const input = document.getElementById('input-prompt-generico');
                input.type = senha ? 'password' : 'text';
                input.value = valorInicial;
                const btnOlho = document.getElementById('btn-olho-prompt-generico');
                btnOlho.style.display = senha ? 'inline-block' : 'none';
                btnOlho.innerText = '👁️';
                modal.style.display = 'flex';
                setTimeout(() => input.focus(), 50);

                const btnOk = document.getElementById('btn-ok-prompt-generico');
                const btnCancelar = document.getElementById('btn-cancelar-prompt-generico');
                const limpar = () => {
                    modal.style.display = 'none';
                    btnOk.onclick = null; btnCancelar.onclick = null; input.onkeydown = null;
                };
                btnOk.onclick = () => { const v = input.value; limpar(); resolve(v); };
                btnCancelar.onclick = () => { limpar(); resolve(null); };
                input.onkeydown = (e) => {
                    if (e.key === 'Enter') btnOk.onclick();
                    if (e.key === 'Escape') btnCancelar.onclick();
                };
            });
        }

        function pedirConfirmacao(mensagem, { titulo = 'Confirmar ação' } = {}) {
            return new Promise(resolve => {
                const modal = document.getElementById('modal-confirm-generico');
                document.getElementById('titulo-confirm-generico').innerText = titulo;
                document.getElementById('texto-confirm-generico').innerText = mensagem;
                modal.style.display = 'flex';

                const btnSim = document.getElementById('btn-sim-confirm-generico');
                const btnNao = document.getElementById('btn-nao-confirm-generico');
                const limpar = () => { modal.style.display = 'none'; btnSim.onclick = null; btnNao.onclick = null; };
                btnSim.onclick = () => { limpar(); resolve(true); };
                btnNao.onclick = () => { limpar(); resolve(false); };
            });
        }

        // --- Multi-caixa: cada usuário abre/fecha o próprio caixa ---

        function caixaDoUsuarioAtual() {
            if (!usuarioAtual) return null;
            return caixasAbertos.find(c => c.usuarioId === usuarioAtual.id && !c.fechado) || null;
        }

        function usuarioPodeAbrirFecharCaixa() {
            return !!(usuarioAtual && (usuarioAtual.isMaster || usuarioAtual.podeAbrirFecharCaixa));
        }

        // Duas entradas (pedido OU fechamento de caixa) são "a mesma coisa" só
        // se a chaveUnica bater. Registros salvos ANTES dessa chave existir
        // (de antes desta correção) caem no fallback: só considera igual se o
        // conteúdo for IDÊNTICO — qualquer diferença já é tratada como
        // colisão de verdade (mais seguro renumerar um registro antigo por
        // engano do que misturar dois registros diferentes num só).
        function mesmaEntrada(a, b) {
            if (a.chaveUnica && b.chaveUnica) return a.chaveUnica === b.chaveUnica;
            return JSON.stringify(a) === JSON.stringify(b);
        }

        // Mescla uma lista LOCAL com a lista que está agora no servidor, por
        // id — nunca sobrescreve a lista inteira. Tudo que só existe de um
        // lado entra. Quando os dois lados têm o mesmo id: se for a mesma
        // entrada (chaveUnica igual), a versão local vence (é a intenção mais
        // recente desta tela); se forem entradas DIFERENTES com o mesmo id
        // (dois dispositivos calcularam o mesmo número "ao mesmo tempo" —
        // colisão de verdade), a que já está no servidor fica com aquele
        // número e a local ganha um número novo, nunca perde nenhuma das
        // duas. Usado por pedidosGerais (id = contador local++, mesmo risco
        // de colisão entre dispositivos). historicoCaixasDB não usa mais
        // isso — tem tabela própria (pdv_historico_caixas) com id gerado
        // pelo Postgres, então colisão de id não existe mais pra ele.
        function mesclarPorIdComColisao(locais, remotos) {
            const mapaRemoto = new Map(remotos.map(item => [item.id, item]));
            const resultado = [...remotos];
            let proximoIdLivre = Math.max(0, ...remotos.map(p => Number(p.id) || 0), ...locais.map(p => Number(p.id) || 0)) + 1;
            let houveColisao = false;

            locais.forEach(itemLocal => {
                const noServidor = mapaRemoto.get(itemLocal.id);
                if (!noServidor) {
                    resultado.push(itemLocal);
                    return;
                }
                if (mesmaEntrada(itemLocal, noServidor)) {
                    const idx = resultado.findIndex(item => item.id === itemLocal.id);
                    if (idx !== -1) resultado[idx] = itemLocal;
                } else {
                    houveColisao = true;
                    resultado.push({ ...itemLocal, id: proximoIdLivre, numeroOriginalAntesDaColisao: itemLocal.id });
                    proximoIdLivre++;
                }
            });

            return { lista: resultado, houveColisao };
        }

        // BUG REAL encontrado e corrigido: fechar um caixa costumava
        // REMOVER ele de caixasAbertos (filter). Isso quebra com
        // mesclarPorUniao — união não tem conceito de remoção, só de "id
        // que eu não conheço ainda". Se o dispositivo que fechou salvasse
        // logo depois de ler um estado remoto ainda desatualizado (escrito
        // por OUTRO dispositivo antes do fechamento chegar até ele), a
        // união trazia o caixa "fechado" de volta pra lista — o caixa
        // reaparecia aberto de novo, às vezes na hora, às vezes minutos
        // depois. Quanto mais dispositivos ativos na barraca, mais fácil de
        // acontecer (é só precisar de UM save de qualquer outro aparelho
        // que ainda não soube do fechamento).
        //
        // Fechar agora só marca fechado:true (não remove mais — ver
        // fecharCaixaPrompt) e essa função de mescla dá sempre preferência
        // pro lado que já está fechado, não importa se veio do lado local
        // ou remoto — fechar é uma via de mão única (nunca reabre sozinho),
        // então não existe ambiguidade de "qual versão é mais nova" pra
        // resolver: fechado sempre vence sobre aberto.
        function mesclarCaixasAbertos(locais, remotos) {
            const mapa = new Map();
            remotos.forEach(item => mapa.set(item.id, item));
            locais.forEach(item => {
                const existente = mapa.get(item.id);
                if (existente && existente.fechado && !item.fechado) return; // remoto já fechou, não reabre
                mapa.set(item.id, item);
            });
            return Array.from(mapa.values());
        }

        // Sem isso, caixasAbertos cresceria pra sempre (todo caixa fechado
        // desde o início do evento continuaria ocupando espaço, só pra
        // proteger contra a ressureição acima). 48h é bem mais que
        // suficiente pra qualquer dispositivo ativo já ter sincronizado o
        // fechamento — depois disso não tem mais risco de ressurreição, dá
        // pra esquecer o registro de vez (o fechamento em si já está salvo
        // permanentemente em pdv_historico_caixas, isso aqui é só
        // coordenação entre dispositivos).
        function podarCaixasFechadas(lista) {
            const LIMITE_MS = 48 * 60 * 60 * 1000;
            const agora = Date.now();
            return lista.filter(c => !c.fechado || !c.fechadoEm || (agora - c.fechadoEm) < LIMITE_MS);
        }

        // Garante que contadorPedidos nunca fique atrás do maior id que já
        // existe DE VERDADE em pedidosGerais. Sem isso: depois de uma
        // colisão renumerada (ex: um pedido virou #7 pra não colidir com
        // outro #3 de outro dispositivo), contadorPedidos podia continuar
        // achando que o próximo pedido livre era #4 — o próximo pedido
        // criado localmente colidia com um que JÁ estava no próprio array,
        // e como salvarNoBancoLocal só mescla com o servidor quando
        // `remoto.origem !== PDV_CLIENT_ID` (pula a checagem quando ESTE
        // dispositivo foi o último a gravar, por otimização), essa colisão
        // interna ia direto pro banco sem nenhuma detecção — bug real,
        // confirmado por simulação (2 caixas vendendo simultaneamente por
        // um tempo, um deles ficando offline no meio e voltando depois).
        // Chamada sempre que pedidosGerais muda por causa de uma mesclagem
        // vinda de fora (salvarNoBancoLocal e aplicarEstado).
        function garantirContadorPedidosAdiante() {
            const maiorId = pedidosGerais.reduce((max, p) => Math.max(max, Number(p.id) || 0), 0);
            if (maiorId >= contadorPedidos) contadorPedidos = maiorId + 1;
        }

        async function salvarNoBancoLocal() {
            salvarCacheLocal();
            if (carregandoEstadoRemoto) return;

            try {
                // Busca o que está no servidor NESTE INSTANTE, bem antes de
                // gravar, e mescla por id em vez de sobrescrever o array
                // inteiro — sem isso, dois dispositivos salvando perto um do
                // outro (ou um dispositivo que ficou um tempo sem conexão e
                // "acorda") apagavam pedido um do outro silenciosamente. Ver
                // mesclarPorIdComColisao/mesclarPorUniao acima.
                const { data: linhaAtual, error: erroLeitura } = await supabaseClient
                    .from('pdv_state')
                    .select('data')
                    .eq('id', barracaStateId)
                    .maybeSingle();
                if (erroLeitura) throw erroLeitura;

                const remoto = linhaAtual && linhaAtual.data;
                let houveColisao = false;
                if (remoto && remoto.origem !== PDV_CLIENT_ID) {
                    const remotoPedidos = Array.isArray(remoto.pedidosGerais) ? remoto.pedidosGerais : [];
                    const mescladoPedidos = mesclarPorIdComColisao(pedidosGerais, remotoPedidos);
                    pedidosGerais = mescladoPedidos.lista;
                    houveColisao = houveColisao || mescladoPedidos.houveColisao;

                    const remotoCaixasAbertos = Array.isArray(remoto.caixasAbertos) ? remoto.caixasAbertos : [];
                    caixasAbertos = podarCaixasFechadas(mesclarCaixasAbertos(caixasAbertos, remotoCaixasAbertos));

                    const remotoContador = Number(remoto.contadorPedidos) || 0;
                    contadorPedidos = Math.max(contadorPedidos, remotoContador);
                    garantirContadorPedidosAdiante();

                    if (houveColisao) {
                        exibirAviso('⚠️ Dois dispositivos criaram um pedido com o mesmo número quase ao mesmo tempo — o sistema corrigiu sozinho, sem apagar nenhum dos dois, mas um deles pode ter ganhado um número novo. Confira "Ver Todos os Pedidos" se algo parecer com número trocado.', 'Sincronização');
                    }
                }

                const estado = montarEstadoAtual();
                const { error } = await supabaseClient
                    .from('pdv_state')
                    .upsert({ id: barracaStateId, data: estado, updated_at: new Date().toISOString() }, { onConflict: 'id' });
                if (error) throw error;
                definirSupabaseDisponivel(true);
            } catch (erro) {
                definirSupabaseDisponivel(false);
                console.error('Falha ao sincronizar com Supabase. Dados mantidos no cache local:', erro);
            }
        }

        // --- Histórico de fechamentos de caixa (pdv_historico_caixas) ---
        // Tabela própria em vez de dentro do blob de pdv_state — ver
        // supabase/pdv_historico_caixas.sql. historicoCaixasDB continua
        // existindo como array em memória (os relatórios/telas que já
        // dependiam dele continuam iguais), só passa a ser POPULADO via
        // fetch nesta tabela em vez de vir junto do resto do estado.
        function mapearLinhaHistoricoCaixa(row) {
            return {
                id: row.id,
                chaveUnica: row.chave_unica,
                usuarioNome: row.usuario_nome,
                campanha: row.campanha,
                dataAbertura: row.data_abertura,
                dataFechamento: row.data_fechamento,
                fundoInicial: Number(row.fundo_inicial) || 0,
                totalVendas: Number(row.total_vendas) || 0,
                pix: Number(row.pix) || 0,
                pixDireto: Number(row.pix_direto) || 0,
                credito: Number(row.credito) || 0,
                debito: Number(row.debito) || 0,
                dinheiroVendas: Number(row.dinheiro_vendas) || 0,
                bonificacao: Number(row.bonificacao) || 0,
                totalGaveta: Number(row.total_gaveta) || 0,
                qtdPedidos: row.qtd_pedidos || 0,
                produtosVendidos: row.produtos_vendidos || {},
                valorProdutosVendidos: row.valor_produtos_vendidos || {},
                // Fechamento de ANTES desta coluna existir vem null do banco
                // — fica null aqui também (não vira 0), pra
                // renderizarDetalhesCaixaNoModal saber diferenciar "não
                // calculado ainda" de "calculado e deu zero" e cair no
                // fallback aproximado.
                custoProducaoEstimado: row.custo_producao_estimado === null || row.custo_producao_estimado === undefined ? null : Number(row.custo_producao_estimado),
                custoTaxasEstimado: row.custo_taxas_estimado === null || row.custo_taxas_estimado === undefined ? null : Number(row.custo_taxas_estimado),
                lucroRealEstimado: row.lucro_real_estimado === null || row.lucro_real_estimado === undefined ? null : Number(row.lucro_real_estimado),
                pedidosDetalhados: row.pedidos_detalhados || []
            };
        }

        function linhaHistoricoCaixaParaSupabase(registro) {
            return {
                barraca_id: barracaStateId,
                chave_unica: registro.chaveUnica,
                usuario_nome: registro.usuarioNome,
                campanha: registro.campanha,
                data_abertura: registro.dataAbertura,
                data_fechamento: registro.dataFechamento,
                fundo_inicial: registro.fundoInicial,
                total_vendas: registro.totalVendas,
                pix: registro.pix,
                pix_direto: registro.pixDireto,
                credito: registro.credito,
                debito: registro.debito,
                dinheiro_vendas: registro.dinheiroVendas,
                bonificacao: registro.bonificacao,
                total_gaveta: registro.totalGaveta,
                qtd_pedidos: registro.qtdPedidos,
                produtos_vendidos: registro.produtosVendidos,
                valor_produtos_vendidos: registro.valorProdutosVendidos,
                custo_producao_estimado: registro.custoProducaoEstimado,
                custo_taxas_estimado: registro.custoTaxasEstimado,
                lucro_real_estimado: registro.lucroRealEstimado,
                pedidos_detalhados: registro.pedidosDetalhados
            };
        }

        // Carrega o histórico de fechamentos DESTA barraca do Supabase pra
        // dentro do array em memória — chamado ao entrar em Histórico de
        // Caixas / Produtos por Período (mudarAba) e uma vez no boot.
        async function carregarHistoricoCaixas() {
            if (!barracaStateId) return;
            try {
                const { data, error } = await supabaseClient
                    .from('pdv_historico_caixas')
                    .select('*')
                    .eq('barraca_id', barracaStateId)
                    .order('criado_em', { ascending: false });
                if (error) throw error;
                historicoCaixasDB = (data || []).map(mapearLinhaHistoricoCaixa);
            } catch (erro) {
                console.error('Falha ao carregar histórico de caixas:', erro);
                const tbody = document.getElementById('tabela-historico-caixas');
                if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="padding: 20px; text-align: center; color: var(--danger);">Não foi possível carregar o histórico de caixas. A tabela pdv_historico_caixas existe no Supabase? (ver supabase/pdv_historico_caixas.sql)</td></tr>`;
                return;
            }
            renderizarHistoricoCaixas();
            renderizarProdutosPorPeriodo();
        }

        // Fila de retry local pra fechamento de caixa que não conseguiu ser
        // gravado no Supabase na hora (sem internet etc) — mesma ideia da
        // fila de logs em auth.js, mas fechamento de caixa é dado
        // financeiro, não pode ficar só na esperança de um F5 futuro
        // carregar o cache certo. Fica em localStorage até confirmar.
        const CHAVE_FILA_FECHAMENTOS = 'pdv_fila_fechamentos_pendentes';
        function lerFilaFechamentosPendentes() {
            try { return JSON.parse(localStorage.getItem(CHAVE_FILA_FECHAMENTOS)) || []; }
            catch { return []; }
        }
        function salvarFilaFechamentosPendentes(fila) {
            try { localStorage.setItem(CHAVE_FILA_FECHAMENTOS, JSON.stringify(fila)); }
            catch (erro) { console.error('Não foi possível salvar a fila de fechamentos pendentes:', erro); }
        }

        // Chamado logo depois de fechar um caixa (fecharCaixaPrompt), com o
        // registro já visível na tela local (unshift síncrono lá). Se a
        // gravação falhar, entra na fila em vez de ser descartado — nunca
        // perde um fechamento por causa de internet.
        async function enviarFechamentoParaSupabase(registro) {
            const linha = linhaHistoricoCaixaParaSupabase(registro);
            try {
                const { data, error } = await supabaseClient.from('pdv_historico_caixas').insert(linha).select('id').single();
                if (error) throw error;
                // Troca o id temporário local pelo id real do Postgres — o
                // registro na tela é o MESMO objeto (mesma referência) que
                // está dentro de historicoCaixasDB, então isso já corrige
                // ele lá também; só precisa re-renderizar pra atualizar os
                // botões que têm o id embutido no onclick.
                registro.id = data.id;
                renderizarHistoricoCaixas();
            } catch (erro) {
                console.error('Falha ao gravar fechamento de caixa no Supabase — entrou na fila de retry:', erro);
                const fila = lerFilaFechamentosPendentes();
                fila.push(linha);
                salvarFilaFechamentosPendentes(fila);
            }
        }

        // Chamado ao reconectar (definirSupabaseDisponivel) e uma vez no
        // boot, pro caso de ter sobrado algo na fila de uma sessão anterior
        // que fechou antes da internet voltar. upsert com ignoreDuplicates
        // (por chave_unica) pra ser seguro reenviar mesmo se uma tentativa
        // anterior já tiver dado certo silenciosamente (timeout ambíguo).
        async function tentarEnviarFilaDeFechamentos() {
            const fila = lerFilaFechamentosPendentes();
            if (fila.length === 0) return;
            const restantes = [];
            for (const linha of fila) {
                try {
                    const { error } = await supabaseClient.from('pdv_historico_caixas').upsert(linha, { onConflict: 'chave_unica', ignoreDuplicates: true });
                    if (error) throw error;
                } catch (erro) {
                    restantes.push(linha);
                }
            }
            salvarFilaFechamentosPendentes(restantes);
            if (restantes.length < fila.length) carregarHistoricoCaixas();
        }

        async function carregarEstadoSupabase(mostrarAvisoSeFalhar = true) {
            try {
                const { data, error } = await supabaseClient
                    .from('pdv_state')
                    .select('data, updated_at')
                    .eq('id', barracaStateId)
                    .maybeSingle();

                if (error) throw error;
                definirSupabaseDisponivel(true);

                if (data && data.data) {
                    aplicarEstado(data.data, false);
                } else {
                    await salvarNoBancoLocal();
                }
                return true;
            } catch (erro) {
                definirSupabaseDisponivel(false);
                console.error('Não foi possível carregar o Supabase. Usando cache local:', erro);
                if (mostrarAvisoSeFalhar) exibirAviso('Supabase não disponível. O PDV abriu usando apenas o cache local.');
                return false;
            }
        }

        // Ver comentário no window.onload (perto de iniciarRealtimeSupabase)
        // pra entender por que isso existe: o realtime pode ficar quieto sem
        // avisar nada quando o dispositivo volta de segundo plano/reconecta.
        // debounce de 3s evita refetch duplicado quando visibilitychange e
        // online disparam quase juntos.
        let ultimoResyncCompleto = 0;
        async function resincronizarSeNecessario(motivo) {
            if (!barracaStateId || carregandoEstadoRemoto) return;
            const agora = Date.now();
            if (agora - ultimoResyncCompleto < 3000) return;
            ultimoResyncCompleto = agora;
            console.log('Ressincronizando estado completo —', motivo);
            await carregarEstadoSupabase(false);
        }

        function iniciarRealtimeSupabase() {
            supabaseClient
                .channel('pdv-state-sync')
                .on('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'pdv_state',
                    filter: `id=eq.${barracaStateId}`
                }, payload => {
                    const estado = payload.new && payload.new.data;
                    if (!estado || estado.origem === PDV_CLIENT_ID) return;
                    aplicarEstado(estado, true);
                })
                .subscribe(status => {
                    console.log('Supabase Realtime:', status);
                });
        }

        // --- Catálogo compartilhado (categorias + produtos) ---
        // Sincronizado numa linha própria (CATALOGO_ID), independente da barraca
        // ativa — todas as barracas leem e escrevem a mesma linha. A visibilidade
        // por barraca é feita pelo campo `barracas` de cada produto, não por linhas
        // separadas.
        function montarCatalogoAtual() {
            return {
                categoriasDB,
                produtosDB,
                subcategoriasDB,
                origem: PDV_CLIENT_ID,
                salvoEm: new Date().toISOString()
            };
        }

        function salvarCatalogoCacheLocal() {
            localStorage.setItem('pdv_catalogo_cache', JSON.stringify(montarCatalogoAtual()));
        }

        function aplicarCatalogo(catalogo, atualizarUI = true) {
            if (!catalogo) return;
            carregandoCatalogoRemoto = true;
            categoriasDB = Array.isArray(catalogo.categoriasDB) ? catalogo.categoriasDB : categoriasDB;
            produtosDB = Array.isArray(catalogo.produtosDB) ? catalogo.produtosDB : produtosDB;
            subcategoriasDB = (catalogo.subcategoriasDB && typeof catalogo.subcategoriasDB === 'object') ? catalogo.subcategoriasDB : subcategoriasDB;
            produtosDB.forEach(p => {
                if (p.ativo === undefined) p.ativo = true;
                if (!Array.isArray(p.barracas)) p.barracas = [];
            });
            salvarCatalogoCacheLocal();
            carregandoCatalogoRemoto = false;

            if (atualizarUI) {
                renderizarCategoriasUI();
                renderizarMenu(categoriaFiltroAtual);
                renderizarTabelaProdutos();
                atualizarTelas();
            }
        }

        async function salvarCatalogo() {
            salvarCatalogoCacheLocal();
            if (carregandoCatalogoRemoto) return;

            const catalogo = montarCatalogoAtual();
            try {
                const { error } = await supabaseClient
                    .from('pdv_state')
                    .upsert({ id: CATALOGO_ID, data: catalogo, updated_at: new Date().toISOString() }, { onConflict: 'id' });
                if (error) throw error;
            } catch (erro) {
                console.error('Falha ao sincronizar o catálogo de produtos com o Supabase. Mantido no cache local:', erro);
            }
        }

        // Migração automática, executada uma única vez (na primeira barraca que
        // carregar o app depois desta funcionalidade existir): antes, cada barraca
        // tinha seu próprio catálogo dentro do seu próprio estado. Não existe mais
        // "o" catálogo antigo — existem vários, um por barraca. Usamos como semente
        // o da barraca 'main' (a barraca original, com o cardápio real em uso),
        // atribuindo todos os produtos dela à barraca 'main'. As demais barracas
        // começam sem nenhum produto atribuído — quem cuida delas escolhe o que
        // aparece em cada uma pela tela de Produtos & Estoque.
        async function migrarCatalogoDeMain() {
            try {
                const { data, error } = await supabaseClient
                    .from('pdv_state')
                    .select('data')
                    .eq('id', 'main')
                    .maybeSingle();
                if (error) throw error;

                const estadoMain = data && data.data;
                if (estadoMain && Array.isArray(estadoMain.produtosDB)) {
                    categoriasDB = Array.isArray(estadoMain.categoriasDB) ? estadoMain.categoriasDB : JSON.parse(JSON.stringify(categoriasPadrao));
                    produtosDB = estadoMain.produtosDB.map(p => {
                        const { estoque, ...resto } = p;
                        return { ...resto, ativo: p.ativo !== false, barracas: ['main'] };
                    });
                } else {
                    categoriasDB = JSON.parse(JSON.stringify(categoriasPadrao));
                    produtosDB = JSON.parse(JSON.stringify(produtosPadrao)).map(p => {
                        const { estoque, ...resto } = p;
                        return { ...resto, barracas: [] };
                    });
                }
            } catch (erro) {
                console.error('Não foi possível migrar o catálogo a partir da barraca "main". Usando padrões:', erro);
                categoriasDB = JSON.parse(JSON.stringify(categoriasPadrao));
                produtosDB = JSON.parse(JSON.stringify(produtosPadrao)).map(p => {
                    const { estoque, ...resto } = p;
                    return { ...resto, barracas: [] };
                });
            }
            await salvarCatalogo();
        }

        async function carregarCatalogo() {
            try {
                const { data, error } = await supabaseClient
                    .from('pdv_state')
                    .select('data')
                    .eq('id', CATALOGO_ID)
                    .maybeSingle();
                if (error) throw error;

                if (data && data.data && Array.isArray(data.data.produtosDB)) {
                    aplicarCatalogo(data.data, false);
                } else {
                    await migrarCatalogoDeMain();
                    aplicarCatalogo(montarCatalogoAtual(), false);
                }
            } catch (erro) {
                console.error('Não foi possível carregar o catálogo do Supabase. Usando cache local:', erro);
                try {
                    const cache = JSON.parse(localStorage.getItem('pdv_catalogo_cache'));
                    if (cache) aplicarCatalogo(cache, false);
                } catch (e) { /* mantém os padrões já carregados */ }
            }
        }

        function iniciarRealtimeCatalogo() {
            supabaseClient
                .channel('pdv-catalogo-sync')
                .on('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'pdv_state',
                    filter: `id=eq.${CATALOGO_ID}`
                }, payload => {
                    const catalogo = payload.new && payload.new.data;
                    if (!catalogo || catalogo.origem === PDV_CLIENT_ID) return;
                    aplicarCatalogo(catalogo, true);
                })
                .subscribe(status => {
                    console.log('Supabase Realtime (catálogo de produtos):', status);
                });
        }

        // --- Impressão em Rede ---
        // Deixa vender/imprimir num dispositivo (ex: tablet) mas o recibo sair
        // de verdade em OUTRA máquina logada no sistema (ex: o PC que está
        // ligado de verdade na impressora térmica). Não grava nada no
        // Supabase — usa Realtime Broadcast (mensagem avulsa entre navegadores
        // abertos agora, nunca fica salva) + Presence (só pra saber quais
        // dispositivos estão com "recebe impressões" ligado agora mesmo, pra
        // popular o seletor de destino). Cada dispositivo guarda sua própria
        // preferência no localStorage — é config de máquina física, não da
        // barraca (não sincroniza pelo pdv_state).
        let canalImpressaoRede = null;
        let dispositivosImpressoraOnline = {};

        function chaveImpressaoRemotaAtiva() { return `pdv_impressao_remota_ativa_${barracaStateId}`; }
        function chaveImpressaoRemotaDestino() { return `pdv_impressao_remota_destino_${barracaStateId}`; }
        function chaveSouImpressoraRede() { return `pdv_sou_impressora_rede_${barracaStateId}`; }

        function impressaoRemotaAtiva() { return localStorage.getItem(chaveImpressaoRemotaAtiva()) === '1'; }
        function destinoImpressaoRemota() { return localStorage.getItem(chaveImpressaoRemotaDestino()) || ''; }
        function souImpressoraDeRede() { return localStorage.getItem(chaveSouImpressoraRede()) === '1'; }

        function obterCanalImpressaoRede() {
            if (!barracaStateId) return null;
            if (canalImpressaoRede) return canalImpressaoRede;

            canalImpressaoRede = supabaseClient.channel(`pdv-impressao-${barracaStateId}`, {
                config: { presence: { key: usuarioAtual ? String(usuarioAtual.id) : PDV_CLIENT_ID } }
            });

            canalImpressaoRede
                .on('broadcast', { event: 'imprimir' }, ({ payload }) => {
                    if (!souImpressoraDeRede() || !usuarioAtual) return;
                    if (String(payload.destinoUsuarioId) !== String(usuarioAtual.id)) return;
                    document.getElementById('area-impressao').innerHTML = payload.html;
                    window.print();
                })
                .on('presence', { event: 'sync' }, () => {
                    const estado = canalImpressaoRede.presenceState();
                    dispositivosImpressoraOnline = {};
                    Object.keys(estado).forEach(chave => {
                        const presencas = estado[chave];
                        if (presencas && presencas[0]) dispositivosImpressoraOnline[chave] = presencas[0];
                    });
                    atualizarSelectDestinoImpressao();
                })
                .subscribe(status => {
                    if (status === 'SUBSCRIBED' && souImpressoraDeRede() && usuarioAtual) {
                        canalImpressaoRede.track({ usuarioNome: usuarioAtual.nome });
                    }
                });

            return canalImpressaoRede;
        }

        // Substitui todo "window.print()" direto do app — se a impressão em
        // rede estiver ligada E tiver destino escolhido e disponível agora,
        // manda o conteúdo de #area-impressao por broadcast pra máquina de
        // destino em vez de imprimir aqui; senão, imprime local como sempre
        // (mesmo comportamento de hoje).
        async function dispararImpressao() {
            if (impressaoRemotaAtiva() && destinoImpressaoRemota()) {
                const canal = obterCanalImpressaoRede();
                const destino = destinoImpressaoRemota();
                if (canal && dispositivosImpressoraOnline[destino]) {
                    const html = document.getElementById('area-impressao').innerHTML;
                    await canal.send({ type: 'broadcast', event: 'imprimir', payload: { html, destinoUsuarioId: destino } });
                    exibirAviso(`🖨️ Impressão enviada para ${dispositivosImpressoraOnline[destino].usuarioNome}.`);
                    return;
                }
                exibirAviso('⚠️ Impressora de rede escolhida não está disponível agora. Imprimindo aqui mesmo.');
            }
            window.print();
        }

        function alternarImpressaoRemota() {
            const ativo = document.getElementById('cfg-impressao-remota-ativa').checked;
            localStorage.setItem(chaveImpressaoRemotaAtiva(), ativo ? '1' : '0');
            document.getElementById('linha-destino-impressao-remota').style.display = ativo ? 'block' : 'none';
            if (ativo) obterCanalImpressaoRede();
        }

        function salvarDestinoImpressaoRemota() {
            localStorage.setItem(chaveImpressaoRemotaDestino(), document.getElementById('cfg-destino-impressao-remota').value);
        }

        function alternarSouImpressoraRede() {
            const ativo = document.getElementById('cfg-sou-impressora-rede').checked;
            localStorage.setItem(chaveSouImpressoraRede(), ativo ? '1' : '0');
            const canal = obterCanalImpressaoRede();
            if (canal) {
                if (ativo && usuarioAtual) canal.track({ usuarioNome: usuarioAtual.nome });
                else canal.untrack();
            }
            document.getElementById('status-impressora-rede').innerText = ativo
                ? `🟢 Recebendo impressões como "${usuarioAtual ? usuarioAtual.nome : ''}".`
                : '';
        }

        function atualizarSelectDestinoImpressao() {
            const select = document.getElementById('cfg-destino-impressao-remota');
            if (!select) return;
            const atual = select.value;
            const entradas = Object.entries(dispositivosImpressoraOnline)
                .filter(([id]) => !usuarioAtual || id !== String(usuarioAtual.id));
            select.innerHTML = '<option value="">-- Selecione --</option>' +
                entradas.map(([id, info]) => `<option value="${id}">${info.usuarioNome || ('Usuário ' + id)}</option>`).join('');
            if (entradas.some(([id]) => id === atual)) select.value = atual;

            const contagem = document.getElementById('contagem-impressoras-online');
            if (contagem) {
                contagem.innerText = entradas.length > 0
                    ? `🟢 ${entradas.length} dispositivo(s) disponível(is) agora`
                    : '🔴 Nenhum dispositivo disponível no momento';
            }
        }

        // --- Aviso Sonoro em Rede ---
        // Mesma ideia/mecanismo da Impressão em Rede acima (Broadcast +
        // Presence, nada gravado no Supabase, preferência por dispositivo
        // no localStorage) — só que pro bipe/voz de "Chamar Painel" em vez
        // do recibo.
        let canalChamarRede = null;
        let dispositivosAltoFalanteOnline = {};

        function chaveChamarRemotoAtivo() { return `pdv_chamar_remoto_ativo_${barracaStateId}`; }
        function chaveChamarRemotoDestino() { return `pdv_chamar_remoto_destino_${barracaStateId}`; }
        function chaveSouAltoFalanteRede() { return `pdv_sou_altofalante_rede_${barracaStateId}`; }

        function chamarRemotoAtivo() { return localStorage.getItem(chaveChamarRemotoAtivo()) === '1'; }
        function destinoChamarRemoto() { return localStorage.getItem(chaveChamarRemotoDestino()) || ''; }
        function souAltoFalanteDeRede() { return localStorage.getItem(chaveSouAltoFalanteRede()) === '1'; }

        function obterCanalChamarRede() {
            if (!barracaStateId) return null;
            if (canalChamarRede) return canalChamarRede;

            canalChamarRede = supabaseClient.channel(`pdv-chamar-${barracaStateId}`, {
                config: { presence: { key: usuarioAtual ? String(usuarioAtual.id) : PDV_CLIENT_ID } }
            });

            canalChamarRede
                .on('broadcast', { event: 'chamar' }, ({ payload }) => {
                    if (!souAltoFalanteDeRede() || !usuarioAtual) return;
                    if (String(payload.destinoUsuarioId) !== String(usuarioAtual.id)) return;
                    tocarBeep();
                    if (vozAnuncioEstaAtiva()) setTimeout(() => falarChamadaPedido(payload.pedidoId, payload.clienteNome), 1700);
                })
                .on('presence', { event: 'sync' }, () => {
                    const estado = canalChamarRede.presenceState();
                    dispositivosAltoFalanteOnline = {};
                    Object.keys(estado).forEach(chave => {
                        const presencas = estado[chave];
                        if (presencas && presencas[0]) dispositivosAltoFalanteOnline[chave] = presencas[0];
                    });
                    atualizarSelectDestinoChamarRede();
                })
                .subscribe(status => {
                    if (status === 'SUBSCRIBED' && souAltoFalanteDeRede() && usuarioAtual) {
                        canalChamarRede.track({ usuarioNome: usuarioAtual.nome });
                    }
                });

            return canalChamarRede;
        }

        // Substitui o "tocarBeep + falarChamadaPedido" direto que chamarNoPainel
        // fazia antes — se o aviso remoto estiver ligado E tiver destino
        // escolhido e disponível agora, manda por broadcast pra máquina de
        // destino tocar lá; senão, toca aqui mesmo como sempre foi.
        async function dispararAvisoSonoro(pedidoId, clienteNome) {
            if (chamarRemotoAtivo() && destinoChamarRemoto()) {
                const canal = obterCanalChamarRede();
                const destino = destinoChamarRemoto();
                if (canal && dispositivosAltoFalanteOnline[destino]) {
                    await canal.send({ type: 'broadcast', event: 'chamar', payload: { pedidoId, clienteNome, destinoUsuarioId: destino } });
                    return;
                }
                // Sem popup de aviso aqui (diferente de dispararImpressao) —
                // chamar painel acontece o tempo todo no corre do Balcão,
                // um popup a cada vez que a máquina de destino cair
                // atrapalharia mais do que ajudaria. Toca aqui mesmo.
            }
            tocarBeep();
            if (vozAnuncioEstaAtiva()) setTimeout(() => falarChamadaPedido(pedidoId, clienteNome), 1700);
        }

        function alternarChamarRemoto() {
            const ativo = document.getElementById('cfg-chamar-remoto-ativo').checked;
            localStorage.setItem(chaveChamarRemotoAtivo(), ativo ? '1' : '0');
            document.getElementById('linha-destino-chamar-remoto').style.display = ativo ? 'block' : 'none';
            if (ativo) obterCanalChamarRede();
        }

        function salvarDestinoChamarRemoto() {
            localStorage.setItem(chaveChamarRemotoDestino(), document.getElementById('cfg-destino-chamar-remoto').value);
        }

        function alternarSouAltoFalanteRede() {
            const ativo = document.getElementById('cfg-sou-altofalante-rede').checked;
            localStorage.setItem(chaveSouAltoFalanteRede(), ativo ? '1' : '0');
            const canal = obterCanalChamarRede();
            if (canal) {
                if (ativo && usuarioAtual) canal.track({ usuarioNome: usuarioAtual.nome });
                else canal.untrack();
            }
            document.getElementById('status-altofalante-rede').innerText = ativo
                ? `🟢 Tocando avisos como "${usuarioAtual ? usuarioAtual.nome : ''}".`
                : '';
        }

        function atualizarSelectDestinoChamarRede() {
            const select = document.getElementById('cfg-destino-chamar-remoto');
            if (!select) return;
            const atual = select.value;
            const entradas = Object.entries(dispositivosAltoFalanteOnline)
                .filter(([id]) => !usuarioAtual || id !== String(usuarioAtual.id));
            select.innerHTML = '<option value="">-- Selecione --</option>' +
                entradas.map(([id, info]) => `<option value="${id}">${info.usuarioNome || ('Usuário ' + id)}</option>`).join('');
            if (entradas.some(([id]) => id === atual)) select.value = atual;

            const contagem = document.getElementById('contagem-altofalantes-online');
            if (contagem) {
                contagem.innerText = entradas.length > 0
                    ? `🟢 ${entradas.length} dispositivo(s) disponível(is) agora`
                    : '🔴 Nenhum dispositivo disponível no momento';
            }
        }

        function aplicarConfiguracoesImpressaoRedeNaTela() {
            const chkAtiva = document.getElementById('cfg-impressao-remota-ativa');
            const chkSou = document.getElementById('cfg-sou-impressora-rede');
            if (!chkAtiva || !chkSou) return;
            chkAtiva.checked = impressaoRemotaAtiva();
            document.getElementById('linha-destino-impressao-remota').style.display = chkAtiva.checked ? 'block' : 'none';
            chkSou.checked = souImpressoraDeRede();
            document.getElementById('status-impressora-rede').innerText = chkSou.checked
                ? `🟢 Recebendo impressões como "${usuarioAtual ? usuarioAtual.nome : ''}".`
                : '';
            if (chkAtiva.checked || chkSou.checked) obterCanalImpressaoRede();
            atualizarSelectDestinoImpressao();

            const chkChamarRemotoAtivo = document.getElementById('cfg-chamar-remoto-ativo');
            const chkSouAltoFalante = document.getElementById('cfg-sou-altofalante-rede');
            if (chkChamarRemotoAtivo && chkSouAltoFalante) {
                chkChamarRemotoAtivo.checked = chamarRemotoAtivo();
                document.getElementById('linha-destino-chamar-remoto').style.display = chkChamarRemotoAtivo.checked ? 'block' : 'none';
                chkSouAltoFalante.checked = souAltoFalanteDeRede();
                document.getElementById('status-altofalante-rede').innerText = chkSouAltoFalante.checked
                    ? `🟢 Tocando avisos como "${usuarioAtual ? usuarioAtual.nome : ''}".`
                    : '';
                if (chkChamarRemotoAtivo.checked || chkSouAltoFalante.checked) obterCanalChamarRede();
                atualizarSelectDestinoChamarRede();
            }

            const chkBalcaoDoces = document.getElementById('cfg-separar-balcao-doces');
            if (chkBalcaoDoces) chkBalcaoDoces.checked = !!configPadroes.separarBalcaoDoces;

            const chkChamarBalcao01 = document.getElementById('cfg-chamar-ativo-balcao01');
            if (chkChamarBalcao01) chkChamarBalcao01.checked = configPadroes.chamarAtivoBalcao01 !== false;
            const chkChamarBalcaoDoces = document.getElementById('cfg-chamar-ativo-balcao-doces');
            if (chkChamarBalcaoDoces) chkChamarBalcaoDoces.checked = configPadroes.chamarAtivoBalcaoDoces !== false;

            const inputPixChave = document.getElementById('cfg-pix-chave');
            if (inputPixChave) {
                inputPixChave.value = configPadroes.pixChave || '';
                document.getElementById('cfg-pix-nome').value = configPadroes.pixNomeRecebedor || '';
                document.getElementById('cfg-pix-cidade').value = configPadroes.pixCidadeRecebedor || '';
            }
        }

        let carrinho = [];
        let pedidoEmEdicaoId = null; let categoriaFiltroAtual = 'Todos'; let produtoEmEdicaoId = null;
        let categoriaFiltroTabelaProdutos = 'Todos';
        // 'venda' | 'insumo' — qual dos dois sub-menus de "📦 Produtos" a
        // tabela está mostrando agora (ver filtrarProdutosPorTipo).
        let tipoFiltroTabelaProdutos = 'venda';

        function filtrarProdutosPorTipo(tipo, botao) {
            tipoFiltroTabelaProdutos = tipo;
            // Mantém o form de cadastro (se estiver aberto criando um
            // produto novo) em sincronia com a aba — senão o campo Preço
            // continuaria visível mesmo depois de trocar pra Insumos.
            // Só quando NÃO está editando: editar preserva o tipo original
            // do produto (ver salvarProduto), não teria sentido mudar os
            // campos visíveis no meio de uma edição por causa da aba.
            if (modoCadastroAtivo === 'simples' && produtoEmEdicaoId === null) atualizarCamposInsumo();
            mudarAba('tela-produtos', botao);
        }
        
        let chartVendas, chartHorarios, chartCategorias, chartRetirada;
        let chartPagamentoCaixa, chartProdutosCaixa;

        let modoCadastroAtivo = 'simples';
        let comboTemporario = [];
        let comboAtualId = null; 

        let trocaItemPedidoId = null;
        let trocaItemCartId = null;
        let trocaItemSubIndex = null; // != null quando é um sub-item de combo sendo trocado
        let obsCartIdAtual = null;

        // Volume do aviso sonoro (0 a 500%), por dispositivo — ver o slider ao
        // lado do "Voz Ligada" no Balcão. O bipe é gerado por osciladores do
        // Web Audio API, então o ganho PODE passar de 100% de verdade (fica
        // mais alto que o volume "normal", com distorção em valores altos —
        // é esperado, é isso que faz soar mais alto). A fala (SpeechSynthesis)
        // NÃO tem essa flexibilidade: o navegador limita o volume dela em no
        // máximo 100%, então acima disso o slider só afeta o bipe.
        const CHAVE_VOLUME_ANUNCIO = 'pdv_volume_anuncio';
        function fatorVolumeAnuncio() {
            const salvo = parseInt(localStorage.getItem(CHAVE_VOLUME_ANUNCIO));
            // Trava em 100% mesmo — o slider vai só até lá agora, mas isso
            // aqui cobre um valor antigo (>100) que possa ter ficado salvo de
            // antes, pra não amplificar o bipe além do que o controle mostra.
            return Math.min(100, isNaN(salvo) ? 100 : salvo) / 100;
        }

        function tocarBeep() {
            try {
                const fator = fatorVolumeAnuncio();
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (audioCtx.state === 'suspended') { audioCtx.resume(); }
                const osc1 = audioCtx.createOscillator(); const gain1 = audioCtx.createGain();
                osc1.type = 'triangle'; osc1.frequency.setValueAtTime(987.77, audioCtx.currentTime);
                gain1.gain.setValueAtTime(0, audioCtx.currentTime); gain1.gain.linearRampToValueAtTime(1 * fator, audioCtx.currentTime + 0.05); gain1.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);
                osc1.connect(gain1); gain1.connect(audioCtx.destination); osc1.start(audioCtx.currentTime); osc1.stop(audioCtx.currentTime + 0.6);

                const osc2 = audioCtx.createOscillator(); const gain2 = audioCtx.createGain();
                osc2.type = 'triangle'; osc2.frequency.setValueAtTime(783.99, audioCtx.currentTime + 0.25);
                gain2.gain.setValueAtTime(0, audioCtx.currentTime + 0.25); gain2.gain.linearRampToValueAtTime(1 * fator, audioCtx.currentTime + 0.3); gain2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.5);
                osc2.connect(gain2); gain2.connect(audioCtx.destination); osc2.start(audioCtx.currentTime + 0.25); osc2.stop(audioCtx.currentTime + 1.5);
            } catch(e) { console.log("Áudio não suportado"); }
        }

        function ajustarVolumeAnuncio(valor) {
            localStorage.setItem(CHAVE_VOLUME_ANUNCIO, valor);
            // Balcão 01 e Balcão 02 (Doces) têm cada um seu próprio slider
            // (mesma classe) — mexer em um sincroniza o outro na hora,
            // mesmo padrão do botão de Voz Ligada/Desligada.
            document.querySelectorAll('.slider-volume-anuncio').forEach(s => { s.value = valor; });
            document.querySelectorAll('.txt-volume-anuncio').forEach(label => { label.innerText = `${valor}%`; });
        }

        function toggleMenuGlobal() {
            const nav = document.getElementById('nav-principal');
            const btnShow = document.getElementById('btn-show-global-menu');
            if (nav.style.display === 'none') { nav.style.display = 'flex'; btnShow.style.display = 'none'; }
            else { nav.style.display = 'none'; btnShow.style.display = 'block'; }
        }

        // Menu sanduíche do mobile: abre/fecha o painel com as abas (o CSS é
        // quem decide, via classe, o que vira lista vertical abaixo do
        // hambúrguer — ver @media (max-width: 768px) em styles.css).
        function toggleMenuMobile() {
            document.getElementById('nav-principal').classList.toggle('menu-mobile-aberto');
        }

        // Os menus do topo (Painéis/Gestão/Relatórios/seletor de barraca) abrem
        // no :hover via CSS, o que não existe em toque (celular/tablet) — sem
        // isso, esses menus ficariam impossíveis de abrir no mobile. Alterna a
        // classe "aberto" no clique/toque do botão, além do hover que já existe
        // pra quem usa mouse. O markup do nav é estático, então isso só precisa
        // rodar uma vez.
        function inicializarDropdownsToque() {
            document.querySelectorAll('.dropdown > .dropbtn').forEach(botao => {
                botao.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const dropdown = botao.closest('.dropdown');
                    const jaAberto = dropdown.classList.contains('aberto');
                    document.querySelectorAll('.dropdown.aberto').forEach(d => d.classList.remove('aberto'));
                    if (!jaAberto) dropdown.classList.add('aberto');
                });
            });
            document.addEventListener('click', () => {
                document.querySelectorAll('.dropdown.aberto').forEach(d => d.classList.remove('aberto'));
            });
        }
        inicializarDropdownsToque();

        function mudarAba(idAba, botao) {
            // Checagem de verdade (não só esconder o botão no menu) — sem isso,
            // bastaria abrir o DevTools e chamar mudarAba() na mão pra contornar
            // uma tela escondida por falta de permissão.
            if (!usuarioTemAcesso(idAba)) {
                exibirAviso('Você não tem permissão para acessar esta tela.');
                return;
            }

            document.querySelectorAll('.tab-content').forEach(aba => aba.classList.remove('active'));
            document.querySelectorAll('nav button, .dropdown-content button').forEach(btn => btn.classList.remove('active'));
            document.getElementById('nav-principal').classList.remove('menu-mobile-aberto');

            const mainContainer = document.getElementById('container-principal');
            if (idAba === 'tela-tv') {
                mainContainer.classList.add('container-tv');
            } else {
                mainContainer.classList.remove('container-tv');
            }

            const abaAtiva = document.getElementById(idAba); if(abaAtiva) abaAtiva.classList.add('active');
            if(botao) {
                botao.classList.add('active');
                if(botao.closest('.dropdown-content')) {
                    const dropBtn = botao.closest('.dropdown').querySelector('.dropbtn');
                    if(dropBtn) dropBtn.classList.add('active');
                }
            }
            
            if(idAba === 'tela-gestao') atualizarFiltrosGestao();
            if(idAba === 'tela-relatorio') atualizarDashboard();
            if(idAba === 'tela-fechamento-caixa') carregarHistoricoCaixas();
            if(idAba === 'tela-produtos') { renderizarCategoriasUI(); renderizarTabelaProdutos(); popularSelectsEntradaEstoque(); if (produtoEmEdicaoId === null) renderizarChecklistBarracasProduto(); }
            if(idAba === 'tela-entrada-estoque') { popularSelectsEntradaEstoque(); mudarModoEntradaEstoque('compra'); }
            if(idAba === 'tela-margem-lucro') renderizarMargemLucro();
            if(idAba === 'tela-pedido') {
                renderizarCategoriasUI();
                renderizarMenu(categoriaFiltroAtual);
                // Só reaplica os padrões se não houver carrinho/edição em
                // andamento — nunca sobrescreve uma seleção que o operador já
                // fez pra um pedido em curso.
                if (carrinho.length === 0 && pedidoEmEdicaoId === null) aplicarConfigPadroesNoFormulario();
            }
            if(idAba === 'tela-atalhos') renderizarPainelAtalhos();
            if(idAba === 'tela-entrega') atualizarTelas();
            if(idAba === 'tela-preparo') atualizarTelas();
            if(idAba === 'tela-barracas') renderizarPainelBarracas();
            if(idAba === 'tela-gestao-usuarios') renderizarTelaGestaoUsuarios();
            if(idAba === 'tela-dashboard-geral') carregarDashboardGeral();
            if(idAba === 'tela-configuracoes') aplicarConfiguracoesImpressaoRedeNaTela();
            if(idAba === 'tela-produtos-periodo') carregarHistoricoCaixas();
            if(idAba === 'tela-logs-sistema') carregarLogsSistema();
        }

        function calcularDiferencaMinutos(horaInicio, horaFim) {
            if (!horaInicio || !horaFim) return "-";
            try {
                const [h1, m1] = horaInicio.split(':').map(Number);
                const [h2, m2] = horaFim.split(':').map(Number);
                let min1 = h1 * 60 + m1;
                let min2 = h2 * 60 + m2;
                if (min2 < min1) min2 += 24 * 60;
                const diff = min2 - min1;
                return `${diff} min`;
            } catch (e) {
                return "-";
            }
        }

        // --- SISTEMA DE GRAVAÇÃO E NAVEGAÇÃO DE TECLAS DE ATALHO ---
        function renderizarPainelAtalhos() {
            document.getElementById('badge-key-direita').innerText = atalhosConfig.direita || '-';
            document.getElementById('badge-key-esquerda').innerText = atalhosConfig.esquerda || '-';
            document.getElementById('badge-key-chamar').innerText = atalhosConfig.chamar || '-';
            document.getElementById('badge-key-entregue').innerText = atalhosConfig.entregue || '-';
        }

        // --- PARÂMETROS PADRÃO (TELA DE CONFIGURAÇÕES) ---
        function carregarFormularioConfiguracoes() {
            document.getElementById('cfg-padrao-forma-pagto').value = configPadroes.formaPagto || '';
            document.getElementById('cfg-padrao-tipo-atendimento').value = configPadroes.tipoAtendimento || '';
            document.getElementById('cfg-padrao-tipo-retirada-global').value = configPadroes.tipoRetiradaGlobal || '';
            document.getElementById('cfg-separar-balcao-doces').checked = !!configPadroes.separarBalcaoDoces;
            document.getElementById('cfg-chamar-ativo-balcao01').checked = configPadroes.chamarAtivoBalcao01 !== false;
            document.getElementById('cfg-chamar-ativo-balcao-doces').checked = configPadroes.chamarAtivoBalcaoDoces !== false;
            document.getElementById('cfg-pix-chave').value = configPadroes.pixChave || '';
            document.getElementById('cfg-pix-nome').value = configPadroes.pixNomeRecebedor || '';
            document.getElementById('cfg-pix-cidade').value = configPadroes.pixCidadeRecebedor || '';
            document.getElementById('cfg-taxa-credito').value = configPadroes.taxaCredito || 0;
            document.getElementById('cfg-taxa-debito').value = configPadroes.taxaDebito || 0;
            document.getElementById('cfg-taxa-pix').value = configPadroes.taxaPix || 0;
        }

        function abrirModalConfigPedido() {
            carregarFormularioConfiguracoes();
            document.getElementById('modal-config-pedido').style.display = 'flex';
        }

        function fecharModalConfigPedido() {
            document.getElementById('modal-config-pedido').style.display = 'none';
        }

        function salvarConfiguracoesPadrao() {
            configPadroes = {
                formaPagto: document.getElementById('cfg-padrao-forma-pagto').value,
                tipoAtendimento: document.getElementById('cfg-padrao-tipo-atendimento').value,
                tipoRetiradaGlobal: document.getElementById('cfg-padrao-tipo-retirada-global').value,
                separarBalcaoDoces: document.getElementById('cfg-separar-balcao-doces').checked,
                chamarAtivoBalcao01: document.getElementById('cfg-chamar-ativo-balcao01').checked,
                chamarAtivoBalcaoDoces: document.getElementById('cfg-chamar-ativo-balcao-doces').checked,
                pixChave: document.getElementById('cfg-pix-chave').value.trim(),
                pixNomeRecebedor: document.getElementById('cfg-pix-nome').value.trim(),
                pixCidadeRecebedor: document.getElementById('cfg-pix-cidade').value.trim(),
                taxaCredito: parseFloat(document.getElementById('cfg-taxa-credito').value) || 0,
                taxaDebito: parseFloat(document.getElementById('cfg-taxa-debito').value) || 0,
                taxaPix: parseFloat(document.getElementById('cfg-taxa-pix').value) || 0
            };
            aplicarVisibilidadeBalcaoDoces();
            atualizarBotoesChamarAtivo();
            // Precisa ir pro Supabase (não só no cache local deste navegador) —
            // senão some ao abrir em outra aba/dispositivo ou depois de limpar
            // dados do navegador.
            salvarNoBancoLocal();
        }

        // Só mostra o botão "Balcão 02" no menu quando o toggle está ligado —
        // senão fica um botão morto/confuso pra quem nunca vai usar essa
        // separação. Chamada sempre que configPadroes muda (salvar aqui, ou
        // aplicarEstado recebendo de outro dispositivo).
        function aplicarVisibilidadeBalcaoDoces() {
            const btn = document.getElementById('btn-nav-balcao-doces');
            if (btn) btn.style.display = configPadroes.separarBalcaoDoces ? '' : 'none';
        }

        // Atalho de "Chamar antes de Entregar" direto no cabeçalho de cada
        // Balcão — mais rápido que ir em Configurações pra ligar/desligar no
        // meio do corre. Sincroniza com todos os dispositivos (é
        // configPadroes) igual o toggle de Separar Balcão Doces.
        function alternarChamarAtivo(qual) {
            const chave = qual === 'balcaoDoces' ? 'chamarAtivoBalcaoDoces' : 'chamarAtivoBalcao01';
            const novoValor = !(configPadroes[chave] !== false);
            configPadroes = { ...configPadroes, [chave]: novoValor };
            atualizarBotoesChamarAtivo();
            atualizarTelas();
            salvarNoBancoLocal();
        }

        // Mantém em sincronia os dois lugares que mostram/mexem nesse toggle
        // (o botão de atalho no cabeçalho do Balcão e o checkbox em
        // Configurações) — chamado ao alternar aqui, ao salvar em
        // Configurações, e ao chegar configPadroes atualizado de outro
        // dispositivo (aplicarEstado).
        function atualizarBotoesChamarAtivo() {
            const ativo01 = configPadroes.chamarAtivoBalcao01 !== false;
            const btn01 = document.getElementById('btn-toggle-chamar-balcao01');
            if (btn01) {
                btn01.innerText = ativo01 ? '🔔 Chamar Ligado' : '⚡ Chamar Desligado';
                btn01.classList.toggle('btn-success', ativo01);
                btn01.classList.toggle('btn-warning', !ativo01);
            }
            const chk01 = document.getElementById('cfg-chamar-ativo-balcao01');
            if (chk01) chk01.checked = ativo01;

            const ativoDoces = configPadroes.chamarAtivoBalcaoDoces !== false;
            const btnDoces = document.getElementById('btn-toggle-chamar-doces');
            if (btnDoces) {
                btnDoces.innerText = ativoDoces ? '🔔 Chamar Ligado' : '⚡ Chamar Desligado';
                btnDoces.classList.toggle('btn-success', ativoDoces);
                btnDoces.classList.toggle('btn-warning', !ativoDoces);
            }
            const chkDoces = document.getElementById('cfg-chamar-ativo-balcao-doces');
            if (chkDoces) chkDoces.checked = ativoDoces;
        }

        function iniciarGravaçãoAtalho(acao) {
            gravandoAtalhoAcao = acao;
            document.querySelectorAll('.card-atalho').forEach(c => c.classList.remove('gravando'));
            const card = document.getElementById(`card-key-${acao}`);
            if (card) card.classList.add('gravando');
            exibirAviso(`Pressione qualquer tecla no seu teclado para gravar a ação de "${acao.toUpperCase()}".`);
        }

        window.addEventListener('keydown', (e) => {
            if (gravandoAtalhoAcao) {
                const teclaPressionada = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                atalhosConfig[gravandoAtalhoAcao] = teclaPressionada;
                salvarCacheLocal();
                renderizarPainelAtalhos();
                gravandoAtalhoAcao = null;
                document.querySelectorAll('.card-atalho').forEach(c => c.classList.remove('gravando'));
                exibirAviso(`Tecla "${teclaPressionada}" gravada com sucesso!`);
                return;
            }

            if (e.key === 'Escape' && document.getElementById('modal-troca-item').style.display === 'flex') {
                fecharModalTroca();
                e.preventDefault();
                return;
            }

            const tagAtiva = document.activeElement.tagName;
            if (tagAtiva === 'INPUT' || tagAtiva === 'TEXTAREA' || tagAtiva === 'SELECT') {
                // Precisa checar aqui também (não só lá embaixo) porque o
                // <select> de trocar produto fica focado — sem isso, Enter
                // com foco no select não confirmava a troca de jeito nenhum.
                if (e.key === 'Enter') {
                    if (document.getElementById('modal-obs').style.display === 'flex') {
                        salvarObsModal();
                        e.preventDefault();
                    } else if (document.getElementById('modal-troca-item').style.display === 'flex') {
                        confirmarTrocaItemBalcao();
                        e.preventDefault();
                    }
                }
                return;
            }

            if (e.key === 'Enter') {
                if (document.getElementById('modal-troca-item').style.display === 'flex') {
                    confirmarTrocaItemBalcao();
                    e.preventDefault();
                    return;
                }
                if (document.getElementById('modal-aviso').style.display === 'flex') {
                    fecharAviso();
                    e.preventDefault();
                    return;
                }
                if (document.activeElement && typeof document.activeElement.click === 'function') {
                    document.activeElement.click();
                    e.preventDefault();
                    return;
                }
            }

            const abaEntrega = document.getElementById('tela-entrega');
            if (abaEntrega && abaEntrega.classList.contains('active')) {
                const tecla = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                const cardsBalcao = Array.from(document.querySelectorAll('#fila-entrega .card-pedido'));
                if (cardsBalcao.length === 0) return;

                if (indexPedidoSelecionadoBalcao >= cardsBalcao.length) indexPedidoSelecionadoBalcao = 0;
                const cardAtual = cardsBalcao[indexPedidoSelecionadoBalcao];

                if (tecla === atalhosConfig.direita || e.key === 'ArrowRight') {
                    indexPedidoSelecionadoBalcao = (indexPedidoSelecionadoBalcao + 1) % cardsBalcao.length;
                    destacarCardBalcao(cardsBalcao);
                    e.preventDefault();
                } else if (tecla === atalhosConfig.esquerda || e.key === 'ArrowLeft') {
                    indexPedidoSelecionadoBalcao = (indexPedidoSelecionadoBalcao - 1 + cardsBalcao.length) % cardsBalcao.length;
                    destacarCardBalcao(cardsBalcao);
                    e.preventDefault();
                }
                else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    focarProximoElementoNoCard(cardAtual, e.key === 'ArrowDown');
                    e.preventDefault();
                }
                else if (tecla === atalhosConfig.chamar) {
                    if (cardAtual) {
                        const btnChamar = cardAtual.querySelector("button[onclick*='chamarNoPainel']");
                        if (btnChamar) btnChamar.click();
                    }
                } else if (tecla === atalhosConfig.entregue) {
                    if (cardAtual) {
                        const btnRetirado = cardAtual.querySelector("button[onclick*='finalizarEntrega']");
                        if (btnRetirado) btnRetirado.click();
                    }
                }
                return;
            }

            // Mesma navegação por setas do Balcão (cima/baixo troca o botão
            // focado dentro do card, esquerda/direita troca de card), só que
            // pra Cozinha (só leitura, sem botão de ação) e Pedidos em Pausa
            // (um botão "Enviar p/ Cozinha" por card).
            const abaCozinha = document.getElementById('tela-preparo');
            if (abaCozinha && abaCozinha.classList.contains('active')) {
                const cardsCozinha = Array.from(document.querySelectorAll('#fila-cozinha .card-pedido'));
                if (cardsCozinha.length === 0) return;
                if (indexPedidoSelecionadoCozinha >= cardsCozinha.length) indexPedidoSelecionadoCozinha = 0;
                const cardAtualCozinha = cardsCozinha[indexPedidoSelecionadoCozinha];

                if (e.key === 'ArrowRight') {
                    indexPedidoSelecionadoCozinha = (indexPedidoSelecionadoCozinha + 1) % cardsCozinha.length;
                    destacarCardTeclado(cardsCozinha, indexPedidoSelecionadoCozinha);
                    e.preventDefault();
                } else if (e.key === 'ArrowLeft') {
                    indexPedidoSelecionadoCozinha = (indexPedidoSelecionadoCozinha - 1 + cardsCozinha.length) % cardsCozinha.length;
                    destacarCardTeclado(cardsCozinha, indexPedidoSelecionadoCozinha);
                    e.preventDefault();
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    focarProximoElementoNoCard(cardAtualCozinha, e.key === 'ArrowDown');
                    e.preventDefault();
                }
                return;
            }

            const abaPausa = document.getElementById('tela-agendados');
            if (abaPausa && abaPausa.classList.contains('active')) {
                const cardsPausa = Array.from(document.querySelectorAll('#fila-agendados .card-pedido'));
                if (cardsPausa.length === 0) return;
                if (indexPedidoSelecionadoPausa >= cardsPausa.length) indexPedidoSelecionadoPausa = 0;
                const cardAtualPausa = cardsPausa[indexPedidoSelecionadoPausa];

                if (e.key === 'ArrowRight') {
                    indexPedidoSelecionadoPausa = (indexPedidoSelecionadoPausa + 1) % cardsPausa.length;
                    destacarCardTeclado(cardsPausa, indexPedidoSelecionadoPausa);
                    e.preventDefault();
                } else if (e.key === 'ArrowLeft') {
                    indexPedidoSelecionadoPausa = (indexPedidoSelecionadoPausa - 1 + cardsPausa.length) % cardsPausa.length;
                    destacarCardTeclado(cardsPausa, indexPedidoSelecionadoPausa);
                    e.preventDefault();
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    focarProximoElementoNoCard(cardAtualPausa, e.key === 'ArrowDown');
                    e.preventDefault();
                }
            }
        });

        // Compartilhado pela navegação por setas de Balcão, Cozinha e Pausa —
        // destaca visualmente o card selecionado, rola ele até a área visível
        // e joga o foco no primeiro botão de dentro (Enter já dispara clique
        // no elemento focado, ver handler de 'Enter' logo acima).
        function destacarCardTeclado(cards, index, rolar = true) {
            cards.forEach(c => c.classList.remove('card-selecionado-teclado'));
            if (cards[index]) {
                const cardTarget = cards[index];
                cardTarget.classList.add('card-selecionado-teclado');

                // "rolar" só é true quando é resposta direta a uma tecla de
                // seta — evita que um re-render automático (realtime, clique
                // de mouse em "Chamar Painel" etc.) jogue a tela pro topo só
                // por causa desse destaque, mesmo sem o usuário estar
                // navegando por teclado. MAS o foco precisa ser reaplicado
                // sempre, mesmo sem rolar: atualizarTelas() recria os cards do
                // zero (innerHTML), então o botão que estava focado antes do
                // "Chamar Painel" deixa de existir — sem refocar aqui, o
                // Enter de novo (Retirado) parava de funcionar depois do
                // primeiro Enter (Chamar). Usa preventScroll pra não rolar a
                // tela ao focar de novo quando rolar=false.
                if (rolar) cardTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

                // Prioriza o botão de ação principal do card (Chamar Painel /
                // Retirado / Enviar p/ Cozinha) em vez de literalmente o
                // primeiro botão em ordem no HTML — senão, quando o primeiro
                // item do card tinha um botão "Trocar" antes dele, o foco
                // caía ali em vez do botão principal, de forma inconsistente
                // entre um card e outro.
                // "Retirado" tem prioridade sobre "Re-chamar"/"Chamar Painel"
                // quando os dois existem no card (pedido já chamado, esperando
                // ser retirado) — depois de chamar, a próxima ação mais comum
                // é confirmar a retirada, não chamar de novo.
                const botaoPrincipal = cardTarget.querySelector("button[onclick*='finalizarEntrega']")
                    || cardTarget.querySelector("button[onclick*='chamarNoPainel']")
                    || cardTarget.querySelector("button[onclick*='moverParaAgora']")
                    || cardTarget.querySelector('button');
                if (botaoPrincipal) botaoPrincipal.focus({ preventScroll: !rolar });
            }
        }

        function destacarCardBalcao(cards, rolar = true) {
            destacarCardTeclado(cards, indexPedidoSelecionadoBalcao, rolar);
        }

        // Cima/baixo dentro do card atual (Balcão, Cozinha, Pausa) — cicla
        // entre os botões/campos focáveis daquele card específico (ex: nos
        // itens de balcão, passa pelos "Trocar" de cada item até chegar no
        // botão de ação principal, ou vice-versa).
        function focarProximoElementoNoCard(card, avancar) {
            if (!card) return;
            const elementosFocaveis = Array.from(card.querySelectorAll('button, select, input, [tabindex="0"]'));
            if (elementosFocaveis.length === 0) return;
            let indexFocoAtual = elementosFocaveis.indexOf(document.activeElement);
            indexFocoAtual = avancar
                ? (indexFocoAtual + 1) % elementosFocaveis.length
                : (indexFocoAtual - 1 + elementosFocaveis.length) % elementosFocaveis.length;
            elementosFocaveis[indexFocoAtual].focus();
        }

        // Controla quais ações aparecem na tabela desse modal — o mesmo modal
        // é usado tanto pelo "📋 Ver Todos os Pedidos" da tela de Pedido
        // (ali pode alterar/excluir) quanto pelo "✅ Pedidos Já Entregues" do
        // Balcão (ali é só consulta, sem editar nem apagar nada).
        let origemModalTodosPedidos = 'pedido';

        function abrirModalTodosPedidos() {
            origemModalTodosPedidos = 'pedido';
            renderizarTabelaModalTodosPedidos();
            document.getElementById('modal-todos-pedidos').style.display = 'flex';
        }

        // Atalho usado pelo botão "Pedidos Já Entregues" no Balcão — mesmo
        // modal de "Ver Todos os Pedidos", já abre filtrado e só com o olho
        // (ver detalhes), sem alterar/excluir.
        function abrirModalPedidosEntregues() {
            document.getElementById('filtro-modal-status').value = 'entregue';
            origemModalTodosPedidos = 'balcao';
            renderizarTabelaModalTodosPedidos();
            document.getElementById('modal-todos-pedidos').style.display = 'flex';
        }

        function fecharModalTodosPedidos() {
            document.getElementById('modal-todos-pedidos').style.display = 'none';
        }

        function renderizarTabelaModalTodosPedidos() {
            const tbody = document.getElementById('tabela-modal-todos-pedidos');
            const filtroStatus = document.getElementById('filtro-modal-status').value;
            tbody.innerHTML = '';
            
            let lista = [...pedidosGerais].reverse();

            if (filtroStatus !== 'Todos') {
                if (filtroStatus === 'preparando') lista = lista.filter(p => p.statusPainel === 'preparando' || p.statusPainel === 'pronto');
                if (filtroStatus === 'mais_tarde') lista = lista.filter(p => p.itens.some(i => i.fase === 'mais_tarde'));
                if (filtroStatus === 'entregue') lista = lista.filter(p => p.statusPainel === 'entregue');
                if (filtroStatus === 'cancelado') lista = lista.filter(p => p.statusPainel === 'cancelado');
            }

            if (lista.length === 0) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 20px; color: gray;">Nenhum pedido encontrado.</td></tr>';
            } else {
                lista.forEach(p => {
                    let statusTag = '';
                    if (p.statusPainel === 'cancelado') statusTag = `<span style="background:var(--danger); color:white; padding:3px 6px; border-radius:4px; font-weight:bold;" title="${p.motivoCancelamento ? 'Motivo: ' + p.motivoCancelamento : 'Motivo não registrado'}">CANCELADO</span>`;
                    else if (p.itens.some(i => i.fase === 'mais_tarde')) statusTag = '<span style="background:var(--info); color:white; padding:3px 6px; border-radius:4px; font-weight:bold;">📦 P. MAIS TARDE</span>';
                    else if (p.statusPainel === 'entregue') statusTag = '<span style="background:var(--success); color:white; padding:3px 6px; border-radius:4px; font-weight:bold;">FINALIZADO</span>';
                    else statusTag = '<span style="background:var(--warning); color:black; padding:3px 6px; border-radius:4px; font-weight:bold;">EM PREPARO</span>';

                    // Vindo do Balcão ("Pedidos Já Entregues") é só consulta —
                    // nada de alterar/excluir ali. Vindo da tela de Pedido
                    // ("Ver Todos os Pedidos") tem as ações completas: olho
                    // sempre, alterar (exceto cancelado/finalizado) e excluir
                    // (cancelarPedido já é Master-only e devolve o estoque).
                    let acoes = `<button onclick="verDetalhesPedido(${p.id})" class="btn" style="background:#0891b2; color:white; padding: 4px 8px; font-size: 0.8rem; margin-right: 4px;" title="Ver Pedido Completo">👁️</button>`;
                    if (origemModalTodosPedidos === 'pedido') {
                        acoes += `<button onclick="reimprimirPedido(${p.id})" class="btn" style="background:#475569; color:white; padding: 4px 8px; font-size: 0.8rem; margin-right: 4px;" title="Reimprimir Pedido">🖨️</button>`;
                        if (p.statusPainel !== 'cancelado') {
                            acoes += `<button onclick="editarPedido(${p.id}); fecharModalTodosPedidos();" class="btn btn-warning" style="padding: 4px 8px; font-size: 0.8rem; margin-right: 4px;">✏️ Alterar</button>`;
                        }
                        if (p.statusPainel !== 'cancelado') {
                            acoes += `<button onclick="cancelarPedido(${p.id}); renderizarTabelaModalTodosPedidos();" class="btn btn-danger" style="padding: 4px 8px; font-size: 0.8rem;" title="Excluir Pedido (devolve o estoque)">🗑️</button>`;
                        } else {
                            acoes += `<span style="color:gray; font-size: 0.8rem;">Bloqueado</span>`;
                        }
                    }

                    const tempoPreparo = calcularDiferencaMinutos(p.horaEntradaCozinha || p.hora, p.horaEntrega);

                    tbody.innerHTML += `
                        <tr style="border-bottom: 1px solid #e5e7eb; ${p.statusPainel === 'cancelado' ? 'opacity: 0.5;' : ''}">
                            <td style="padding: 8px; font-weight: bold;">#${rotuloPedido(p)}</td>
                            <td style="font-weight:bold; color:#374151;">${p.hora}</td>
                            <td style="color:#2563eb; font-weight:bold;">${p.horaEntradaCozinha || '-'}</td>
                            <td style="color:#16a34a; font-weight:bold;">${p.horaEntrega || '-'}</td>
                            <td style="font-weight: bold; color: var(--primary);">${tempoPreparo}</td>
                            <td style="font-weight: bold;">${p.cliente}</td>
                            <td>${p.pagamento}</td>
                            <td>${statusTag}</td>
                            <td style="font-weight: bold; color:var(--success);">R$ ${p.total.toFixed(2)}</td>
                            <td>${acoes}</td>
                        </tr>
                    `;
                });
            }
        }

        function renderizarCategoriasUI() {
            if(!categoriasDB.includes('Combos')) categoriasDB.push('Combos');
            
            document.getElementById('novo-prod-categoria').innerHTML = categoriasDB.map(c => `<option value="${c}">${c}</option>`).join('');
            atualizarListaSubcategoriasExistentes();
            
            const comboSelect = document.getElementById('combo-add-select');
            if(comboSelect) {
                let catOptions = categoriasDB.filter(c => c !== 'Combos').map(c => `<option value="cat_${c}">Categoria: ${c}</option>`).join('');
                let prodOptions = produtosDB.filter(p => !p.isCombo && p.ativo !== false).map(p => `<option value="prod_${p.id}">Produto Fixo: ${p.nome}</option>`).join('');
                comboSelect.innerHTML = `<optgroup label="Escolha do Cliente (Categorias)">${catOptions}</optgroup><optgroup label="Item Fixo (Produtos Específicos)">${prodOptions}</optgroup>`;
            }

            const menuCatContainer = document.getElementById('menu-categorias-container');
            let botoesHtml = `<div class="tag-categoria ${categoriaFiltroAtual === 'Todos' ? 'ativa' : ''}" onclick="filtrarMenu('Todos')">Todos</div>`;
            categoriasDB.forEach(cat => { botoesHtml += `<div class="tag-categoria ${categoriaFiltroAtual === cat ? 'ativa' : ''}" onclick="filtrarMenu('${cat}')">${cat}</div>`; });
            if(menuCatContainer) menuCatContainer.innerHTML = botoesHtml;

            const abasTabelaContainer = document.getElementById('abas-tabela-produtos-container');
            if (abasTabelaContainer) {
                let abasHtml = `<div class="tag-categoria ${categoriaFiltroTabelaProdutos === 'Todos' ? 'ativa' : ''}" onclick="filtrarTabelaProdutosPorCategoria('Todos')">Geral (Todos)</div>`;
                categoriasDB.forEach(cat => {
                    abasHtml += `<div class="tag-categoria ${categoriaFiltroTabelaProdutos === cat ? 'ativa' : ''}" onclick="filtrarTabelaProdutosPorCategoria('${cat}')">${cat}</div>`;
                });
                abasTabelaContainer.innerHTML = abasHtml;
            }

            const listaGestao = document.getElementById('lista-gestao-categorias');
            if(listaGestao) {
                listaGestao.innerHTML = categoriasDB.map((cat, index) => `
                    <li class="cat-item" draggable="true"
                        ondragstart="tratarDragStartCategoria(event, ${index})"
                        ondragover="tratarDragOverCategoria(event)"
                        ondrop="tratarDropCategoria(event, ${index})"
                        ondragend="tratarDragEndCategoria(event)">
                        <span style="font-weight: bold; display:flex; align-items:center; gap:8px;">
                            <span style="color:gray; cursor:grab;">☰</span> ${cat}
                        </span>
                        <div class="cat-acoes">
                            <button onclick="moverCategoria(${index}, -1)" title="Subir Posição">⬆</button>
                            <button onclick="moverCategoria(${index}, 1)" title="Descer Posição">⬇</button>
                            <button onclick="editarCategoria('${cat}')" title="Editar Nome">✏️</button>
                            <button onclick="excluirCategoria('${cat}')" title="Excluir Categoria">🗑️</button>
                        </div>
                    </li>
                `).join('');
            }
        }

        // Categorias fazem parte do catálogo compartilhado — mudam para todas as
        // barracas de uma vez, por isso salvam com salvarCatalogo(), não
        // salvarNoBancoLocal() (que é o estado desta barraca sozinha).
        function moverCategoria(index, direcao) {
            const novoIndex = index + direcao;
            if (novoIndex < 0 || novoIndex >= categoriasDB.length) return;
            const temp = categoriasDB[index];
            categoriasDB[index] = categoriasDB[novoIndex];
            categoriasDB[novoIndex] = temp;
            salvarCatalogo();
            renderizarCategoriasUI();
            renderizarMenu(categoriaFiltroAtual);
        }

        // Reordenar categorias arrastando (alternativa aos botões ⬆/⬇ acima).
        let indexCategoriaArrastada = null;

        function tratarDragStartCategoria(e, index) {
            indexCategoriaArrastada = index;
            e.currentTarget.classList.add('arrastando');
            e.dataTransfer.effectAllowed = 'move';
        }

        function tratarDragOverCategoria(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        }

        function tratarDropCategoria(e, indexAlvo) {
            e.preventDefault();
            if (indexCategoriaArrastada !== null && indexCategoriaArrastada !== indexAlvo) {
                const itemMovido = categoriasDB.splice(indexCategoriaArrastada, 1)[0];
                categoriasDB.splice(indexAlvo, 0, itemMovido);
                salvarCatalogo();
                renderizarCategoriasUI();
                renderizarMenu(categoriaFiltroAtual);
                renderizarTabelaProdutos();
            }
        }

        function tratarDragEndCategoria(e) {
            e.currentTarget.classList.remove('arrastando');
            indexCategoriaArrastada = null;
        }

        function adicionarCategoria() {
            let nome = document.getElementById('nova-cat-nome').value.trim(); if (!nome) return;
            nome = nome.charAt(0).toUpperCase() + nome.slice(1);
            if (categoriasDB.includes(nome)) return exibirAviso("Esta categoria já está cadastrada!");
            categoriasDB.push(nome); document.getElementById('nova-cat-nome').value = '';
            salvarCatalogo();
            renderizarCategoriasUI();
        }
        async function editarCategoria(nomeAntigo) {
            let novoNome = await pedirTexto(`Editar categoria: "${nomeAntigo}"\nDigite o novo nome:`, { titulo: '✏️ Editar Categoria', valorInicial: nomeAntigo });
            if (novoNome && novoNome.trim() !== '') {
                novoNome = novoNome.charAt(0).toUpperCase() + novoNome.slice(1);
                if (categoriasDB.includes(novoNome) && novoNome !== nomeAntigo) return exibirAviso("Esta categoria já existe.");
                categoriasDB[categoriasDB.indexOf(nomeAntigo)] = novoNome;
                produtosDB.forEach(p => { if (p.categoria === nomeAntigo) p.categoria = novoNome; });
                if (categoriaFiltroAtual === nomeAntigo) categoriaFiltroAtual = novoNome;
                salvarCatalogo();
                renderizarCategoriasUI(); renderizarTabelaProdutos(); renderizarMenu(categoriaFiltroAtual);
            }
        }
        async function excluirCategoria(nome) {
            if (produtosDB.some(p => p.categoria === nome)) return exibirAviso(`Existem produtos vinculados a "${nome}". Remova os produtos antes.`);
            if (await pedirConfirmacao(`Excluir a categoria "${nome}"? Isso afeta TODAS as barracas, não só a sua.`, { titulo: '🗑️ Excluir Categoria' })) {
                categoriasDB = categoriasDB.filter(c => c !== nome);
                if (categoriaFiltroAtual === nome) categoriaFiltroAtual = 'Todos';
                salvarCatalogo();
                renderizarCategoriasUI(); renderizarMenu(categoriaFiltroAtual);
            }
        }

        function mudarModoCadastro(modo) {
            modoCadastroAtivo = modo;
            document.getElementById('tab-simples').style.background = modo === 'simples' ? 'var(--primary)' : 'transparent';
            document.getElementById('tab-simples').style.color = modo === 'simples' ? 'white' : '#333';
            document.getElementById('tab-combo').style.background = modo === 'combo' ? 'var(--primary)' : 'transparent';
            document.getElementById('tab-combo').style.color = modo === 'combo' ? 'white' : '#333';

            if(modo === 'combo') {
                document.getElementById('box-estoque-simples').style.display = 'none';
                document.getElementById('box-cozinha-simples').style.display = 'none';
                document.getElementById('box-itens-combo').style.display = 'block';
                // Insumo e ficha técnica não existem pra combo — combo é
                // sempre vendido, e o custo dele viria da soma dos itens
                // escolhidos (não é uma ficha técnica fixa igual produto
                // simples).
                document.getElementById('box-ficha-tecnica').style.display = 'none';
                document.getElementById('box-preco-simples').style.display = 'block';
                // Combo já é a categoria "Combos" por definição — não faz
                // sentido escolher categoria/subcategoria pra ele.
                document.getElementById('box-categoria-subcategoria').style.display = 'none';
                document.getElementById('novo-prod-categoria').value = 'Combos';
                document.getElementById('novo-prod-subcategoria').value = '';
                document.getElementById('titulo-form-produto').innerText = "Cadastrar Combo";
            } else {
                document.getElementById('box-estoque-simples').style.display = 'block';
                document.getElementById('box-itens-combo').style.display = 'none';
                document.getElementById('box-categoria-subcategoria').style.display = 'block';
                atualizarCamposInsumo();
                document.getElementById('titulo-form-produto').innerText = "Cadastrar Produto";
            }
        }

        // Esconde Preço/Cozinha-Balcão quando o cadastro é de um insumo —
        // insumo é matéria-prima (farinha, embalagem...), nunca vendido
        // direto, então essas duas perguntas não fazem sentido pra ele. Não
        // existe mais um checkbox "é insumo" separado: já tem uma aba só
        // pra Insumos (ver filtrarProdutosPorTipo), então é ISSO que decide
        // — cadastrar estando na aba Insumos já cadastra como insumo.
        function atualizarCamposInsumo() {
            const ehInsumo = tipoFiltroTabelaProdutos === 'insumo';
            document.getElementById('box-preco-simples').style.display = ehInsumo ? 'none' : 'block';
            document.getElementById('box-cozinha-simples').style.display = ehInsumo ? 'none' : 'block';
            // Ficha técnica (custo de produção) só faz sentido pra quem é
            // VENDIDO — insumo é matéria-prima, o custo dele vem direto da
            // Entrada de Estoque, não de uma "receita" com outros itens.
            document.getElementById('box-ficha-tecnica').style.display = ehInsumo ? 'none' : 'block';
        }

        function addProdutoTemporarioAoCombo() {
            const selectVal = document.getElementById('combo-add-select').value;
            const qtd = parseInt(document.getElementById('combo-add-qtd').value);
            if(!selectVal || isNaN(qtd) || qtd <= 0) return;
            
            let tipo = selectVal.startsWith('cat_') ? 'categoria' : 'produto';
            let ref = selectVal.substring(selectVal.indexOf('_') + 1);
            let nomeExibicao = '';

            if (tipo === 'categoria') {
                nomeExibicao = `Escolha de ${ref}`;
            } else {
                ref = parseInt(ref);
                let p = produtosDB.find(x => x.id === ref);
                nomeExibicao = `Fixo: ${p ? p.nome : '?'}`;
            }

            const ext = comboTemporario.find(x => x.tipo === tipo && x.ref === ref);
            if(ext) ext.qtd += qtd;
            else comboTemporario.push({ tipo: tipo, ref: ref, qtd: qtd, nomeExibicao: nomeExibicao });
            renderizarListaComboTemporario();
        }

        function renderizarListaComboTemporario() {
            const ul = document.getElementById('lista-combo-temporario');
            ul.innerHTML = comboTemporario.map((item, index) => `
                <li style="display:flex; justify-content:space-between; border-bottom: 1px dashed #ccc; padding: 4px 0;">
                    <span>${item.qtd}x ${item.nomeExibicao}</span>
                    <button class="btn" onclick="removerItemComboTemporario(${index})" style="background:none; border:none; color:red; cursor:pointer; padding:0;">❌</button>
                </li>
            `).join('');
        }

        function removerItemComboTemporario(index) {
            comboTemporario.splice(index, 1);
            renderizarListaComboTemporario();
        }

        // --- Ficha técnica de custo (interna) ---
        // Lista de insumos/produtos usados pra produzir 1 unidade — só serve
        // pra ESTIMAR custo/lucro (nunca aparece no pedido/recibo do
        // cliente, isso continua sendo o campo "Ingredientes" de sempre).
        // Precisa que o item usado já tenha custoMedio (uma Entrada de
        // Estoque registrada) — se não tiver, entra na lista mas conta como
        // "custo desconhecido" em vez de fingir que custa R$ 0.
        let fichaTecnicaTemporaria = []; // { insumoId, insumoNome, quantidade }

        function addItemFichaTecnica() {
            const select = document.getElementById('ficha-tecnica-add-select');
            const idInsumo = parseInt(select.value);
            const qtd = parseFloat(document.getElementById('ficha-tecnica-add-qtd').value);
            if (!idInsumo || isNaN(qtd) || qtd <= 0) return exibirAviso('Selecione o item e a quantidade usada.');
            if (fichaTecnicaTemporaria.some(i => i.insumoId === idInsumo)) return exibirAviso('Esse item já está na ficha técnica.');
            const item = produtosDB.find(p => p.id === idInsumo);
            fichaTecnicaTemporaria.push({ insumoId: idInsumo, insumoNome: item ? item.nome : '?', quantidade: qtd });
            document.getElementById('ficha-tecnica-add-qtd').value = '1';
            select.value = '';
            renderizarListaFichaTecnica();
        }

        function removerItemFichaTecnica(index) {
            fichaTecnicaTemporaria.splice(index, 1);
            renderizarListaFichaTecnica();
        }

        // Soma quantidade × custo médio de cada item — incompleto=true se
        // algum item ainda não tem custo médio conhecido (nunca teve
        // Entrada de Estoque registrada), pra quem for ler o resultado saber
        // que o número é subestimado, não confiar cegamente nele.
        function calcularCustoProducao(fichaTecnica) {
            let custo = 0;
            let incompleto = false;
            (fichaTecnica || []).forEach(item => {
                const insumo = produtosDB.find(p => p.id === item.insumoId);
                const custoMedio = insumo ? insumo.custoMedio : undefined;
                if (custoMedio === undefined || custoMedio === null) { incompleto = true; return; }
                custo += custoMedio * item.quantidade;
            });
            return { custo, incompleto };
        }

        // Soma o custo de produção (ficha técnica) de tudo que foi
        // VENDIDO de verdade numa lista de pedidos — mesmo filtro
        // (não-cancelado, não-bonificação) que já gera resumoProdutosVendidos
        // em calcularResumoPedidos (js/barracas.js) e em fecharCaixaPrompt,
        // pra "Lucro Real" bater com o mesmo faturamento mostrado ali do
        // lado. Bonificação fica de fora de propósito: já teve seu custo
        // "perdido" contabilizado à parte (é uma cortesia, não uma venda).
        // itensSemCusto conta quantos itens vendidos não têm ficha técnica
        // completa ainda — usado só pra avisar que o número está
        // subestimado, não pra travar nada.
        function calcularCustoProducaoTotal(listaPedidos) {
            let custoTotal = 0;
            let itensSemCusto = 0;
            const validos = (listaPedidos || []).filter(p => p.statusPainel !== 'cancelado' && p.pagamento && !p.pagamento.startsWith('Bonificação'));
            validos.forEach(p => {
                (p.itens || []).forEach(item => {
                    if (item.isCombo && Array.isArray(item.itensComboEscolhidos)) {
                        item.itensComboEscolhidos.forEach(sub => {
                            const prod = produtosDB.find(x => x.id === sub.idProduto);
                            if (prod && Array.isArray(prod.fichaTecnica) && prod.fichaTecnica.length > 0) {
                                const { custo, incompleto } = calcularCustoProducao(prod.fichaTecnica);
                                custoTotal += custo;
                                if (incompleto) itensSemCusto++;
                            } else {
                                itensSemCusto++;
                            }
                        });
                    } else {
                        const prod = produtosDB.find(x => x.id === item.idProduto);
                        if (prod && Array.isArray(prod.fichaTecnica) && prod.fichaTecnica.length > 0) {
                            const { custo, incompleto } = calcularCustoProducao(prod.fichaTecnica);
                            custoTotal += custo * (item.qtd || 1);
                            if (incompleto) itensSemCusto++;
                        } else {
                            itensSemCusto++;
                        }
                    }
                });
            });
            return { custoTotal, itensSemCusto };
        }

        // Taxa de maquininha (Configurações > Taxas de Pagamento) + custo de
        // produção = o que falta pro faturamento bruto virar Lucro Real.
        // `dados` já vem de calcularResumoPedidos (fatCredito/fatDebito/fatPix
        // e totalVendas) — essa função só soma o que falta em cima disso.
        function calcularCustosOperacao(listaPedidos, dados) {
            const { custoTotal: custoProducaoTotal, itensSemCusto } = calcularCustoProducaoTotal(listaPedidos);
            const taxaCredito = configPadroes.taxaCredito || 0;
            const taxaDebito = configPadroes.taxaDebito || 0;
            const taxaPix = configPadroes.taxaPix || 0;
            const custoTaxas = (dados.fatCredito * taxaCredito / 100) + (dados.fatDebito * taxaDebito / 100) + (dados.fatPix * taxaPix / 100);
            const lucroReal = dados.totalVendas - custoProducaoTotal - custoTaxas;
            return { custoProducaoTotal, custoTaxas, lucroReal, itensSemCustoProducao: itensSemCusto };
        }

        function renderizarListaFichaTecnica() {
            const ul = document.getElementById('lista-ficha-tecnica');
            if (!ul) return;
            ul.innerHTML = fichaTecnicaTemporaria.length === 0
                ? '<li style="color:gray; font-weight:normal; list-style:none; margin-left:-20px;">Nenhum item adicionado.</li>'
                : fichaTecnicaTemporaria.map((item, i) => {
                    const insumo = produtosDB.find(p => p.id === item.insumoId);
                    const custoMedio = insumo ? insumo.custoMedio : undefined;
                    const custoTxt = (custoMedio !== undefined && custoMedio !== null) ? `R$ ${(custoMedio * item.quantidade).toFixed(2)}` : '⚠️ custo desconhecido';
                    return `<li style="display:flex; justify-content:space-between; border-bottom: 1px dashed #a7f3d0; padding: 4px 0;">
                        <span>${item.quantidade}x ${item.insumoNome} <small style="font-weight:normal; color:#065f46;">(${custoTxt})</small></span>
                        <button class="btn" onclick="removerItemFichaTecnica(${i})" style="background:none; border:none; color:red; cursor:pointer; padding:0;">❌</button>
                    </li>`;
                }).join('');
            // Produto editado que já tem ficha técnica cadastrada não deve
            // ficar escondido atrás do accordion fechado — abre sozinho pra
            // não parecer que a informação sumiu.
            if (fichaTecnicaTemporaria.length > 0) definirEstadoBoxFichaTecnica(true);
            atualizarResumoCustoLucro();
        }

        // Accordion do bloco de custo interno — fica fechado por padrão
        // (a maioria só cadastra nome/preço/foto rápido) e só abre quando
        // clicado ou quando já tem item cadastrado (ver renderizarListaFichaTecnica).
        // Independente do display:none/block do PRÓPRIO #box-ficha-tecnica
        // (esse é controlado por atualizarCamposInsumo/mudarModoCadastro —
        // decide SE a seção existe pra esse tipo de produto; isto aqui só
        // decide se está expandida ou recolhida).
        function definirEstadoBoxFichaTecnica(aberto) {
            const conteudo = document.getElementById('conteudo-ficha-tecnica');
            const seta = document.getElementById('seta-ficha-tecnica');
            if (!conteudo || !seta) return;
            conteudo.style.display = aberto ? 'block' : 'none';
            seta.innerText = aberto ? '▼' : '▶';
        }

        function alternarBoxFichaTecnica() {
            const conteudo = document.getElementById('conteudo-ficha-tecnica');
            if (!conteudo) return;
            definirEstadoBoxFichaTecnica(conteudo.style.display === 'none');
        }

        function atualizarResumoCustoLucro() {
            const div = document.getElementById('resumo-custo-lucro-produto');
            if (!div) return;
            if (fichaTecnicaTemporaria.length === 0) { div.innerHTML = ''; return; }
            const { custo, incompleto } = calcularCustoProducao(fichaTecnicaTemporaria);
            const preco = parseFloat(document.getElementById('novo-prod-preco').value) || 0;
            const lucro = preco - custo;
            const margem = preco > 0 ? (lucro / preco * 100) : 0;
            div.innerHTML = `Custo estimado: R$ ${custo.toFixed(2)}${incompleto ? ' <span style="color:#b45309;">(algum item sem custo médio ainda)</span>' : ''}<br>` +
                `Lucro estimado: <span style="color:${lucro >= 0 ? '#065f46' : 'var(--danger)'};">R$ ${lucro.toFixed(2)} (${margem.toFixed(0)}%)</span>`;
        }

        // Ativo/Inativo é global (produto some das vendas em TODAS as barracas) —
        // é diferente de "não marcado para esta barraca", que só afeta uma.
        function toggleStatusAtivoProduto(id) {
            const p = produtosDB.find(prod => prod.id === id);
            if (p) {
                p.ativo = !p.ativo;
                salvarCatalogo();
                renderizarTabelaProdutos();
                renderizarMenu(categoriaFiltroAtual);
            }
        }

        // Desenha os checkboxes de "em quais barracas este produto aparece" no
        // formulário de cadastro/edição. `idsMarcados` vem do produto sendo
        // editado (ou fica vazio, com a barraca atual pré-marcada, ao cadastrar).
        function renderizarChecklistBarracasProduto(idsMarcados) {
            const box = document.getElementById('checklist-barracas-produto');
            if (!box) return;
            const marcados = Array.isArray(idsMarcados) ? idsMarcados : [barracaStateId];
            box.innerHTML = registroBarracas.map(b => `
                <label style="display:flex; align-items:center; gap:5px; font-weight:normal; font-size:0.85rem; margin-bottom:0;">
                    <input type="checkbox" class="chk-barraca-produto" value="${b.id}" style="width:auto; margin-bottom:0;" ${marcados.includes(b.id) ? 'checked' : ''}>
                    ${b.nome}
                </label>
            `).join('') || '<span style="color:gray; font-size:0.85rem;">Nenhuma barraca cadastrada ainda.</span>';
        }

        function filtrarTabelaProdutosPorCategoria(cat) {
            categoriaFiltroTabelaProdutos = cat;
            renderizarCategoriasUI();
            renderizarTabelaProdutos();
        }

        function renderizarTabelaProdutos() {
            const tbody = document.getElementById('tabela-produtos'); tbody.innerHTML = '';

            const buscaInput = document.getElementById('busca-tabela-produtos');
            const termoBusca = buscaInput ? buscaInput.value.trim().toLowerCase() : '';

            // Combo não tem tipo próprio (é sempre vendido, nunca insumo) --
            // conta como 'venda' pra esse filtro mesmo sem o campo.
            let lista = produtosDB.filter(p => p.isCombo || (p.tipo || 'venda') === tipoFiltroTabelaProdutos);

            const tituloTela = document.getElementById('titulo-tela-produtos');
            if (tituloTela) tituloTela.innerText = tipoFiltroTabelaProdutos === 'insumo' ? '🧪 Gerenciar Insumos' : '🛒 Gerenciar Produtos & Combos';

            if (categoriaFiltroTabelaProdutos && categoriaFiltroTabelaProdutos !== 'Todos') {
                lista = lista.filter(p => p.categoria === categoriaFiltroTabelaProdutos);
            }

            if (termoBusca) {
                lista = lista.filter(p =>
                    p.nome.toLowerCase().includes(termoBusca) ||
                    p.id.toString().includes(termoBusca) ||
                    (p.categoria && p.categoria.toLowerCase().includes(termoBusca))
                );
            }

            const contadorEl = document.getElementById('contagem-produtos-lista');
            if (contadorEl) contadorEl.innerText = `Mostrando ${lista.length} ${lista.length === 1 ? 'produto' : 'produtos'}${produtosDB.length !== lista.length ? ` de ${produtosDB.length} no total` : ''}`;

            // Alerta de cadastro incompleto — olha o catálogo INTEIRO (não só
            // a aba/filtro atual), pra avisar mesmo se o produto sem ficha
            // técnica estiver escondido atrás do filtro de Insumos agora.
            const alertaEl = document.getElementById('alerta-cadastro-incompleto');
            if (alertaEl) {
                const semFichaTecnica = produtosDB.filter(p => !p.isCombo && (p.tipo || 'venda') === 'venda' && (!Array.isArray(p.fichaTecnica) || p.fichaTecnica.length === 0)).length;
                const semCustoMedio = produtosDB.filter(p => p.tipo === 'insumo' && (p.custoMedio === undefined || p.custoMedio === null)).length;
                if (semFichaTecnica > 0 || semCustoMedio > 0) {
                    const partes = [];
                    if (semFichaTecnica > 0) partes.push(`⚠️ ${semFichaTecnica} produto(s) sem ficha técnica`);
                    if (semCustoMedio > 0) partes.push(`⚠️ ${semCustoMedio} insumo(s) sem custo médio ainda`);
                    alertaEl.innerText = partes.join(' · ') + ' — clique pra ver Margem & Lucro';
                    alertaEl.style.display = 'block';
                } else {
                    alertaEl.style.display = 'none';
                }
            }

            if (lista.length === 0) {
                tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; padding: 20px; color: gray;">Nenhum produto ou combo encontrado.</td></tr>';
                return;
            }

            lista.forEach(p => {
                let desc = p.isCombo ? `<br><small style="color:var(--info);">↳ Composto por: ${p.itensCombo.map(i => {
                    if(i.tipo === 'categoria') return `${i.qtd}x Escolha de ${i.ref}`;
                    else { let subP = produtosDB.find(x=>x.id===i.ref); return `${i.qtd}x ${subP?subP.nome:'Fixo'}`; }
                }).join(', ')}</small>` : (p.ingredientes ? `<br><small style="color:#0284c7;">Ingredientes: ${p.ingredientes}</small>` : '');

                const estoqueAqui = estoquePorProduto[p.id];
                const estoqueAquiVal = (estoqueAqui === undefined) ? null : estoqueAqui;
                let txtEstoque = p.isCombo ? '<span style="color:gray;">Misto</span>' : (estoqueAquiVal !== null ? `${estoqueAquiVal} un.` : '∞ (Livre)');
                let corEstoque = (!p.isCombo && estoqueAquiVal !== null && estoqueAquiVal <= 5) ? 'color: var(--danger);' : '';
                let imgThumb = p.foto ? `<img src="${p.foto}" style="width:40px; height:40px; object-fit:contain; background:#f8fafc; border-radius:6px; padding:2px; border:1px solid #ddd;">` : '<span style="color:gray; font-size:0.75rem;">Sem foto</span>';

                let badgeStatus = p.ativo !== false
                    ? `<button class="btn btn-success" style="padding:3px 8px; font-size:0.75rem;" onclick="toggleStatusAtivoProduto(${p.id})">🟢 Ativo</button>`
                    : `<button class="btn btn-danger" style="padding:3px 8px; font-size:0.75rem;" onclick="toggleStatusAtivoProduto(${p.id})">🔴 Inativo</button>`;

                const nomesBarracas = (p.barracas || []).map(id => {
                    const b = registroBarracas.find(x => x.id === id);
                    return b ? b.nome : id;
                });
                let badgesBarracas = nomesBarracas.length
                    ? nomesBarracas.map(n => `<span style="background:#ede9fe; color:#5b21b6; padding:2px 6px; border-radius:4px; font-size:0.75rem; display:inline-block; margin:1px;">${n}</span>`).join('')
                    : '<span style="color:var(--danger); font-size:0.75rem;">Nenhuma (invisível)</span>';

                // Custo Médio / Lucro Est. são só informação interna (nunca
                // aparecem pro cliente) — combo não tem custo médio próprio
                // (seria a soma dos itens escolhidos, variável por pedido) e
                // insumo não tem "lucro" (nunca é vendido direto).
                let txtCustoMedio = '<span style="color:gray;">—</span>';
                if (!p.isCombo && p.custoMedio !== undefined && p.custoMedio !== null) {
                    txtCustoMedio = `R$ ${p.custoMedio.toFixed(2)}`;
                }
                let txtLucro = '<span style="color:gray;">—</span>';
                if (!p.isCombo && p.tipo !== 'insumo' && Array.isArray(p.fichaTecnica) && p.fichaTecnica.length > 0) {
                    const { custo, incompleto } = calcularCustoProducao(p.fichaTecnica);
                    const lucro = p.preco - custo;
                    txtLucro = `<span style="color:${lucro >= 0 ? '#065f46' : 'var(--danger)'};">R$ ${lucro.toFixed(2)}</span>${incompleto ? ' ⚠️' : ''}`;
                }

                tbody.innerHTML += `
                    <tr draggable="true" ondragstart="tratarDragStartProduto(event, ${p.id})" ondragover="tratarDragOverProduto(event)" ondrop="tratarDropProduto(event, ${p.id})" ondragend="tratarDragEndProduto(event)" style="border-bottom: 1px solid #f3f4f6; cursor: grab; ${p.ativo === false ? 'opacity: 0.6; background:#fef2f2;' : ''}">
                        <td style="padding: 10px; font-weight: bold;"><span style="color:gray; cursor:grab;" title="Arraste para reordenar (dentro da mesma categoria)">☰</span> #${p.id}</td>
                        <td>${imgThumb}</td>
                        <td>${badgeStatus}</td>
                        <td>${p.nome} ${desc} <br><span style="font-size: 0.8rem; color: gray;">${p.tipo === 'insumo' ? '🧪 Insumo' : (p.cozinha ? '👨‍🍳 Cozinha' : '🛍️ Balcão')}</span></td>
                        <td><span style="background:#e5e7eb; padding:2px 6px; border-radius:4px; font-size:0.8rem;">${p.categoria}</span>${p.subcategoria ? `<br><span style="color:gray; font-size:0.7rem;">↳ ${p.subcategoria}</span>` : ''}</td>
                        <td style="max-width:160px;">${badgesBarracas}</td>
                        <td style="font-weight: bold;">R$ ${p.preco.toFixed(2)}</td>
                        <td>${txtCustoMedio}</td>
                        <td>${txtLucro}</td>
                        <td style="${corEstoque}">${txtEstoque}</td>
                        <td style="white-space: nowrap;">
                            <button class="btn btn-warning" style="padding: 4px; font-size: 0.8rem; color: black;" onclick="prepararEdicaoProduto(${p.id})">✏️</button>
                            ${!p.isCombo ? `<button class="btn btn-primary" style="padding: 4px; font-size: 0.8rem;" onclick="adicionarEstoqueManual(${p.id})">📦 +</button>` : ''}
                            <button class="btn btn-danger" style="padding: 4px; font-size: 0.8rem;" onclick="apagarProduto(${p.id})">🗑️</button>
                        </td>
                    </tr>`;
            });
        }

        // Visão dedicada de custo/margem — a tabela de Produtos (11 colunas,
        // genérica) mostra Custo Médio/Lucro Est. mas não dá pra ordenar
        // pelo pior caso nem ver resumo. Fonte é o CATÁLOGO agora
        // (produtosDB), não histórico de vendas — isso é
        // "Produtos Vendidos por Período".
        function renderizarMargemLucro() {
            const tbody = document.getElementById('tabela-margem-lucro');
            if (!tbody) return;

            const buscaInput = document.getElementById('filtro-margem-lucro-nome');
            const termoBusca = buscaInput ? buscaInput.value.trim().toLowerCase() : '';

            let lista = produtosDB.filter(p => !p.isCombo && (p.tipo || 'venda') === 'venda');
            if (termoBusca) lista = lista.filter(p => p.nome.toLowerCase().includes(termoBusca));

            const linhas = lista.map(p => {
                const temCusto = p.custoMedio !== undefined && p.custoMedio !== null;
                const temFicha = Array.isArray(p.fichaTecnica) && p.fichaTecnica.length > 0;
                let margemReais = null, margemPct = null, incompleto = false;
                if (temFicha) {
                    const { custo, incompleto: inc } = calcularCustoProducao(p.fichaTecnica);
                    margemReais = p.preco - custo;
                    margemPct = p.preco > 0 ? (margemReais / p.preco * 100) : 0;
                    incompleto = inc;
                }
                return { p, temCusto, temFicha, margemReais, margemPct, incompleto };
            });

            // Pior margem primeiro (quem mais precisa de atenção) — quem não
            // tem ficha técnica ainda vai pro final (não dá pra saber se tá
            // bom ou ruim, não é "urgente" da mesma forma que margem negativa).
            linhas.sort((a, b) => {
                if (a.temFicha && !b.temFicha) return -1;
                if (!a.temFicha && b.temFicha) return 1;
                if (!a.temFicha && !b.temFicha) return a.p.nome.localeCompare(b.p.nome);
                return a.margemPct - b.margemPct;
            });

            const comMargem = linhas.filter(l => l.temFicha);
            const semFicha = linhas.filter(l => !l.temFicha);
            const margemMedia = comMargem.length ? comMargem.reduce((a, l) => a + l.margemPct, 0) / comMargem.length : 0;
            const pior = comMargem.length ? comMargem[0] : null;

            document.getElementById('ml-total-com-margem').innerText = comMargem.length;
            document.getElementById('ml-total-sem-ficha').innerText = semFicha.length;
            document.getElementById('ml-margem-media').innerText = margemMedia.toFixed(0);
            document.getElementById('ml-pior-produto').innerText = pior ? `${pior.p.nome} (${pior.margemPct.toFixed(0)}%)` : '-';

            if (linhas.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px; color: gray;">Nenhum produto de venda cadastrado.</td></tr>';
                return;
            }

            tbody.innerHTML = linhas.map(l => {
                const { p, temCusto, temFicha, margemReais, margemPct, incompleto } = l;
                let status, corStatus;
                if (!temFicha) { status = '⚠️ Sem Ficha Técnica'; corStatus = '#d97706'; }
                else if (margemReais < 0) { status = '🔴 Margem Negativa'; corStatus = 'var(--danger)'; }
                else { status = incompleto ? '⚠️ Custo Incompleto' : '✅ OK'; corStatus = incompleto ? '#d97706' : '#16a34a'; }

                return `
                    <tr style="border-bottom: 1px solid #f3f4f6;">
                        <td style="padding: 10px; font-weight: bold;">${p.nome}</td>
                        <td><span style="background:#e5e7eb; padding:2px 6px; border-radius:4px; font-size:0.8rem;">${p.categoria}</span></td>
                        <td style="text-align:right; font-weight:bold;">R$ ${p.preco.toFixed(2)}</td>
                        <td style="text-align:right;">${temCusto ? `R$ ${p.custoMedio.toFixed(2)}` : '<span style="color:gray;">—</span>'}</td>
                        <td style="text-align:right; ${temFicha ? '' : 'color:gray;'}">${temFicha ? `R$ ${margemReais.toFixed(2)}` : '—'}</td>
                        <td style="text-align:right; font-weight:bold; ${temFicha ? (margemPct >= 0 ? 'color:#16a34a;' : 'color:var(--danger);') : 'color:gray;'}">${temFicha ? `${margemPct.toFixed(0)}%` : '—'}</td>
                        <td style="color:${corStatus}; font-weight:bold; white-space:nowrap;">${status}</td>
                    </tr>`;
            }).join('');
        }

        function gerarPDFMargemLucro() {
            const el = document.getElementById('tela-margem-lucro');
            if (!el || typeof html2pdf !== 'function') return;
            const restaurar = expandirRolaveisParaCaptura(el);
            html2pdf().set({
                margin: 10,
                filename: `Margem_Lucro_${new Date().toISOString().slice(0,10)}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2 },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            }).from(el).save().then(restaurar).catch(restaurar);
        }

        // Reordenar produtos arrastando — só dentro da mesma categoria (a
        // ordem em produtosDB é a mesma ordem usada na tela de Pedido, ver
        // renderizarMenu). Arrastar sobre um produto de outra categoria não
        // faz nada, pra não misturar a ordem de categorias diferentes.
        let idProdutoArrastado = null;

        function tratarDragStartProduto(e, idProduto) {
            idProdutoArrastado = idProduto;
            e.currentTarget.classList.add('arrastando');
            e.dataTransfer.effectAllowed = 'move';
        }

        function tratarDragOverProduto(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        }

        function tratarDropProduto(e, idProdutoAlvo) {
            e.preventDefault();
            if (idProdutoArrastado === null || idProdutoArrastado === idProdutoAlvo) return;

            const produtoArrastado = produtosDB.find(p => p.id === idProdutoArrastado);
            const produtoAlvo = produtosDB.find(p => p.id === idProdutoAlvo);
            if (!produtoArrastado || !produtoAlvo || produtoArrastado.categoria !== produtoAlvo.categoria) {
                return exibirAviso('Só é possível reordenar produtos dentro da mesma categoria.');
            }

            const indexOrigem = produtosDB.findIndex(p => p.id === idProdutoArrastado);
            const indexAlvo = produtosDB.findIndex(p => p.id === idProdutoAlvo);
            const itemMovido = produtosDB.splice(indexOrigem, 1)[0];
            produtosDB.splice(indexAlvo, 0, itemMovido);

            salvarCatalogo();
            renderizarTabelaProdutos();
            renderizarMenu(categoriaFiltroAtual);
        }

        function tratarDragEndProduto(e) {
            e.currentTarget.classList.remove('arrastando');
            idProdutoArrastado = null;
        }

        // Sugestões de subcategoria (datalist) já usadas dentro da categoria
        // selecionada no momento — ex: escolheu "Bebidas", sugere "Refrigerantes"
        // e "Sucos" se algum produto de Bebidas já tiver essas subcategorias.
        function atualizarListaSubcategoriasExistentes() {
            const categoria = document.getElementById('novo-prod-categoria').value;
            const select = document.getElementById('novo-prod-subcategoria');
            if (!select) return;
            const valorAtual = select.value;
            const subcats = subcategoriasDB[categoria] || [];
            select.innerHTML = '<option value="">-- Nenhuma --</option>' + subcats.map(s => `<option value="${s}">${s}</option>`).join('');
            if (subcats.includes(valorAtual)) select.value = valorAtual;
        }

        // --- Gerenciar categorias (modal) ---

        function abrirModalGerenciarCategorias() {
            renderizarCategoriasUI();
            document.getElementById('modal-gerenciar-categorias').style.display = 'flex';
        }

        function fecharModalGerenciarCategorias() {
            document.getElementById('modal-gerenciar-categorias').style.display = 'none';
        }

        // --- Gerenciar subcategorias (modal, sempre da categoria escolhida
        // agora no formulário de cadastro) ---

        function abrirModalGerenciarSubcategorias() {
            const categoria = document.getElementById('novo-prod-categoria').value;
            if (!categoria) return exibirAviso("Escolha uma categoria primeiro.");
            document.getElementById('titulo-modal-subcategorias').innerText = `📂 Subcategorias de "${categoria}"`;
            document.getElementById('modal-gerenciar-subcategorias').dataset.categoria = categoria;
            renderizarTabelaSubcategorias(categoria);
            document.getElementById('modal-gerenciar-subcategorias').style.display = 'flex';
        }

        function fecharModalGerenciarSubcategorias() {
            document.getElementById('modal-gerenciar-subcategorias').style.display = 'none';
        }

        function renderizarTabelaSubcategorias(categoria) {
            const tbody = document.getElementById('tabela-gestao-subcategorias');
            const subcats = subcategoriasDB[categoria] || [];
            if (subcats.length === 0) {
                tbody.innerHTML = '<tr><td style="padding:12px; text-align:center; color:gray;">Nenhuma subcategoria ainda.</td></tr>';
                return;
            }
            tbody.innerHTML = subcats.map((s, i) => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                    <td style="padding:8px; font-weight:bold;">${s}</td>
                    <td style="text-align:right; white-space:nowrap;">
                        <button class="btn btn-warning" style="padding:4px 8px; font-size:0.8rem;" onclick="editarSubcategoria('${categoria}', ${i})" title="Renomear">✏️</button>
                        <button class="btn btn-danger" style="padding:4px 8px; font-size:0.8rem;" onclick="excluirSubcategoria('${categoria}', ${i})" title="Excluir">🗑️</button>
                    </td>
                </tr>
            `).join('');
        }

        async function adicionarSubcategoria() {
            const categoria = document.getElementById('modal-gerenciar-subcategorias').dataset.categoria;
            const input = document.getElementById('nova-subcat-nome');
            const nome = input.value.trim();
            if (!nome) return;
            if (!subcategoriasDB[categoria]) subcategoriasDB[categoria] = [];
            if (subcategoriasDB[categoria].includes(nome)) return exibirAviso("Essa subcategoria já existe.");
            subcategoriasDB[categoria].push(nome);
            input.value = '';
            salvarCatalogo();
            renderizarTabelaSubcategorias(categoria);
            atualizarListaSubcategoriasExistentes();
        }

        async function editarSubcategoria(categoria, index) {
            const atual = subcategoriasDB[categoria][index];
            const novoNome = await pedirTexto(`Editar subcategoria: "${atual}"\nDigite o novo nome:`, { titulo: '✏️ Editar Subcategoria', valorInicial: atual });
            if (!novoNome || !novoNome.trim()) return;
            const nome = novoNome.trim();
            subcategoriasDB[categoria][index] = nome;
            // Produtos que já usavam o nome antigo acompanham a renomeação,
            // senão ficariam com uma subcategoria "fantasma" fora da lista.
            produtosDB.forEach(p => { if (p.categoria === categoria && p.subcategoria === atual) p.subcategoria = nome; });
            salvarCatalogo();
            renderizarTabelaSubcategorias(categoria);
            atualizarListaSubcategoriasExistentes();
        }

        async function excluirSubcategoria(categoria, index) {
            const nome = subcategoriasDB[categoria][index];
            if (!(await pedirConfirmacao(`Excluir a subcategoria "${nome}"? Produtos que já usam ela mantêm o nome, só não vai mais aparecer na lista pra escolher.`, { titulo: '🗑️ Excluir Subcategoria' }))) return;
            subcategoriasDB[categoria].splice(index, 1);
            salvarCatalogo();
            renderizarTabelaSubcategorias(categoria);
            atualizarListaSubcategoriasExistentes();
        }

        function prepararEdicaoProduto(id) {
            document.getElementById('painel-cadastro-produto').scrollIntoView({ behavior: 'smooth', block: 'start' });

            const p = produtosDB.find(prod => prod.id === id);
            document.getElementById('novo-prod-nome').value = p.nome;
            document.getElementById('novo-prod-preco').value = p.preco;
            document.getElementById('novo-prod-categoria').value = p.categoria;
            // Repopula as opções de subcategoria (dependem da categoria) ANTES
            // de tentar selecionar o valor salvo, senão o <select> ainda
            // estaria com as opções da categoria anterior e a seleção não colaria.
            atualizarListaSubcategoriasExistentes();
            document.getElementById('novo-prod-subcategoria').value = p.subcategoria || '';
            document.getElementById('novo-prod-foto').value = p.foto || '';
            document.getElementById('novo-prod-ativo').value = (p.ativo !== false).toString();
            document.getElementById('novo-prod-ingredientes').value = p.ingredientes || '';
            renderizarChecklistBarracasProduto(p.barracas);

            if (p.foto) {
                document.getElementById('preview-foto-img').src = p.foto;
                document.getElementById('preview-foto-container').style.display = 'block';
            } else {
                document.getElementById('preview-foto-container').style.display = 'none';
            }

            mudarModoCadastro(p.isCombo ? 'combo' : 'simples');

            if(p.isCombo) {
                comboTemporario = p.itensCombo.map(i => {
                    let nomeExibicao = '';
                    if (i.tipo === 'categoria') nomeExibicao = `Escolha de ${i.ref}`;
                    else { let subP = produtosDB.find(x => x.id === i.ref); nomeExibicao = `Fixo: ${subP ? subP.nome : '?'}`; }
                    return { ...i, nomeExibicao };
                });
                renderizarListaComboTemporario();
            } else {
                const estoqueAqui = estoquePorProduto[p.id];
                document.getElementById('txt-estoque-atual-cadastro').innerText = (estoqueAqui !== undefined && estoqueAqui !== null) ? `${estoqueAqui} un.` : '∞ Livre (sem controle)';
                document.getElementById('novo-prod-cozinha').value = p.cozinha ? 'cozinha' : (p.entregaInstantanea ? 'instantaneo' : 'balcao');
                fichaTecnicaTemporaria = Array.isArray(p.fichaTecnica) ? JSON.parse(JSON.stringify(p.fichaTecnica)) : [];
                renderizarListaFichaTecnica();
            }

            produtoEmEdicaoId = p.id;
            document.getElementById('titulo-form-produto').innerText = `Editar ${p.isCombo?'Combo':'Produto'} #${p.id}`;
            document.getElementById('btn-salvar-produto').innerText = "Atualizar 🔄";
            document.getElementById('btn-salvar-produto').classList.replace('btn-primary', 'btn-warning');
            document.getElementById('btn-cancelar-edicao-prod').style.display = 'block';
        }

        function cancelarEdicaoProduto() {
            produtoEmEdicaoId = null;
            document.getElementById('novo-prod-nome').value = '';
            document.getElementById('novo-prod-preco').value = '';
            document.getElementById('txt-estoque-atual-cadastro').innerText = '—';
            document.getElementById('novo-prod-foto').value = '';
            document.getElementById('file-prod-foto').value = '';
            document.getElementById('novo-prod-ativo').value = "true";
            document.getElementById('novo-prod-ingredientes').value = '';
            document.getElementById('novo-prod-subcategoria').value = '';
            document.getElementById('preview-foto-container').style.display = 'none';
            renderizarChecklistBarracasProduto();

            comboTemporario = []; renderizarListaComboTemporario();
            fichaTecnicaTemporaria = []; renderizarListaFichaTecnica();
            definirEstadoBoxFichaTecnica(false);
            mudarModoCadastro('simples');
            document.getElementById('btn-salvar-produto').innerText = "Salvar 💾";
            document.getElementById('btn-salvar-produto').classList.replace('btn-warning', 'btn-primary');
            document.getElementById('btn-cancelar-edicao-prod').style.display = 'none';
        }

        function salvarProduto() {
            if (uploadFotoEmAndamento) return exibirAviso("A foto ainda está sendo enviada — aguarde um instante e tente salvar de novo.");

            let nome = document.getElementById('novo-prod-nome').value.trim();
            let categoria = document.getElementById('novo-prod-categoria').value;
            let subcategoria = document.getElementById('novo-prod-subcategoria').value.trim();
            let foto = document.getElementById('novo-prod-foto').value.trim();
            let ativo = document.getElementById('novo-prod-ativo').value === 'true';
            let ingredientes = document.getElementById('novo-prod-ingredientes').value.trim();
            let barracasMarcadas = Array.from(document.querySelectorAll('.chk-barraca-produto:checked')).map(chk => chk.value);

            let isCombo = (modoCadastroAtivo === 'combo');
            // Insumo (matéria-prima, nunca vendida direto) não existe pra
            // combo. Sem checkbox separado — já tem uma aba só pra Insumos
            // (ver filtrarProdutosPorTipo), essa é a fonte da verdade pra
            // produto NOVO. Editar um produto existente preserva o tipo
            // original dele, não a aba atual — evita que trocar de aba no
            // meio de uma edição converta o tipo do produto sem querer.
            const produtoOriginal = produtoEmEdicaoId !== null ? produtosDB.find(pr => pr.id === produtoEmEdicaoId) : null;
            let ehInsumo = !isCombo && (produtoOriginal ? produtoOriginal.tipo === 'insumo' : tipoFiltroTabelaProdutos === 'insumo');
            let preco = ehInsumo ? 0 : parseFloat(document.getElementById('novo-prod-preco').value);

            if (!nome || !categoria || (!ehInsumo && (isNaN(preco) || preco <= 0))) return exibirAviso("Preencha todos os campos do produto corretamente.");

            let cozinha = false;
            let entregaInstantanea = false;
            let finalItensCombo = [];

            if (isCombo) {
                if (comboTemporario.length === 0) return exibirAviso("O combo precisa ter pelo menos 1 item incluso!");
                finalItensCombo = JSON.parse(JSON.stringify(comboTemporario));
                cozinha = true;
            } else if (!ehInsumo) {
                const direcionamento = document.getElementById('novo-prod-cozinha').value;
                cozinha = direcionamento === 'cozinha';
                entregaInstantanea = direcionamento === 'instantaneo';
            }

            // Estoque não é mais editado aqui de jeito nenhum — só pela tela
            // "📥 Entrada de Produtos" (entrada de compra) ou um Ajuste de
            // Inventário. Editar cadastro (nome, preço, categoria...) nunca
            // mais mexe no número de estoque, evitando resetar sem querer.
            const eraNovoProduto = produtoEmEdicaoId === null;
            let idSalvo;
            if (produtoEmEdicaoId !== null) {
                let p = produtosDB.find(prod => prod.id === produtoEmEdicaoId);
                p.nome = nome; p.preco = preco; p.categoria = categoria; p.subcategoria = subcategoria; p.cozinha = cozinha;
                p.entregaInstantanea = entregaInstantanea;
                p.isCombo = isCombo; p.itensCombo = finalItensCombo; p.foto = foto; p.ativo = ativo; p.barracas = barracasMarcadas;
                p.ingredientes = ingredientes; p.tipo = ehInsumo ? 'insumo' : 'venda';
                p.fichaTecnica = (isCombo || ehInsumo) ? [] : JSON.parse(JSON.stringify(fichaTecnicaTemporaria));
                idSalvo = p.id;
                cancelarEdicaoProduto();
            } else {
                idSalvo = produtosDB.length > 0 ? Math.max(...produtosDB.map(p => p.id)) + 1 : 1;
                produtosDB.push({
                    id: idSalvo,
                    nome, preco, categoria, subcategoria, cozinha, entregaInstantanea, isCombo, itensCombo: finalItensCombo, foto, ativo, barracas: barracasMarcadas, ingredientes,
                    tipo: ehInsumo ? 'insumo' : 'venda',
                    fichaTecnica: (isCombo || ehInsumo) ? [] : JSON.parse(JSON.stringify(fichaTecnicaTemporaria))
                });
                cancelarEdicaoProduto();
            }

            if (!isCombo && eraNovoProduto) {
                // Só inicializa (como "estoque livre") na CRIAÇÃO — editar
                // um produto depois nunca mais mexe no estoque aqui; isso
                // fica só a cargo de "📥 Entrada de Produtos" / Ajuste de
                // Inventário, que ficam com o histórico de por que mudou.
                estoquePorProduto[idSalvo] = null;
                salvarNoBancoLocal();
            }
            salvarCatalogo();
            renderizarCategoriasUI();
            renderizarTabelaProdutos(); renderizarMenu(categoriaFiltroAtual);
        }

        // Auto (des)ativa um produto quando o estoque DESTA barraca chega/sai de
        // 0 — só quando o produto pertence a exatamente 1 barraca. `ativo` é um
        // campo global do catálogo compartilhado, enquanto o estoque é por
        // barraca; aplicar isso a um produto vendido em várias barracas faria a
        // barraca A vender tudo esconder o produto também da barraca B, mesmo
        // com estoque lá. Retorna true se mudou `ativo` (call site deve chamar
        // salvarCatalogo() nesse caso).
        function sincronizarAtivoPorEstoque(produto, novoEstoque) {
            if (!produto || produto.isCombo) return false;
            if (!Array.isArray(produto.barracas) || produto.barracas.length !== 1) return false;
            if (novoEstoque === null || novoEstoque === undefined) return false;
            const novoAtivo = novoEstoque > 0;
            if (produto.ativo === novoAtivo) return false;
            produto.ativo = novoAtivo;
            return true;
        }

        async function adicionarEstoqueManual(idProduto) {
            const p = produtosDB.find(prod => prod.id === idProduto);
            if(p.isCombo) return;
            const atual = estoquePorProduto[idProduto];
            const atualVal = (atual === undefined) ? null : atual;
            if(atualVal === null) return exibirAviso("Este produto possui Estoque Livre nesta barraca.");
            const add = await pedirTexto(`Adicionar estoque ao ${p.nome} nesta barraca (Atual: ${atualVal}):`, { titulo: '📦 Adicionar Estoque' });
            if(add && !isNaN(add)) {
                const qtdAdicionada = parseInt(add);
                const novoEstoque = atualVal + qtdAdicionada;
                estoquePorProduto[idProduto] = novoEstoque;
                if (sincronizarAtivoPorEstoque(p, novoEstoque)) salvarCatalogo();
                salvarNoBancoLocal();
                renderizarTabelaProdutos(); renderizarMenu(categoriaFiltroAtual);

                // Atalho rápido também entra no histórico de movimentações —
                // sem nota fiscal/custo (é só um "+ rápido"), mas nenhuma
                // entrada de estoque deve escapar do registro, venha de onde vier.
                try {
                    const { error } = await supabaseClient.from('pdv_movimentacoes_estoque').insert({
                        barraca_id: barracaStateId,
                        produto_id: idProduto,
                        produto_nome: p.nome,
                        tipo: 'entrada',
                        quantidade: qtdAdicionada,
                        estoque_antes: atualVal,
                        estoque_depois: novoEstoque,
                        motivo: 'Atalho rápido (📦 + na lista de produtos)',
                        usuario_nome: usuarioAtual ? usuarioAtual.nome : null
                    });
                    if (error) throw error;
                } catch (erro) {
                    console.error('Falha ao gravar movimentação do atalho rápido de estoque:', erro);
                }
            }
        }

        async function apagarProduto(idProduto) {
            if (await pedirConfirmacao(`Excluir este produto/combo do catálogo? Isso remove ele de TODAS as barracas que o vendem, não só da sua. Para tirar só da sua barraca, edite o produto e desmarque sua barraca na lista.`, { titulo: '🗑️ Excluir Produto' })) {
                produtosDB = produtosDB.filter(p => p.id !== idProduto);
                if (produtoEmEdicaoId === idProduto) cancelarEdicaoProduto();
                delete estoquePorProduto[idProduto];
                salvarNoBancoLocal();
                salvarCatalogo();
                renderizarCategoriasUI();
                renderizarTabelaProdutos();
                renderizarMenu(categoriaFiltroAtual);
            }
        }

        // --- Entrada de Estoque (compra + ajuste de inventário) ---
        // Único jeito de estoque mudar fora da baixa automática de venda —
        // ver salvarProduto() (cadastro não mexe mais nisso). Cada entrada/
        // ajuste vira 1 linha em pdv_movimentacoes_estoque por produto (ver
        // supabase/pdv_movimentacoes_estoque.sql), pra guardar o histórico
        // de por que o estoque mudou (nota fiscal, custo, motivo).
        let itensEntradaEstoque = []; // { produtoId, produtoNome, qtd, custoUnitario }

        function popularSelectsEntradaEstoque() {
            const opcoes = produtosDB.filter(p => !p.isCombo)
                .map(p => `<option value="${p.id}">${p.nome}${p.tipo === 'insumo' ? ' 🧪' : ''}</option>`).join('');
            const selectItem = document.getElementById('entrada-item-select');
            const selectAjuste = document.getElementById('ajuste-produto-select');
            const selectFicha = document.getElementById('ficha-tecnica-add-select');
            if (selectItem) selectItem.innerHTML = '<option value="">-- Selecione --</option>' + opcoes;
            if (selectAjuste) selectAjuste.innerHTML = '<option value="">-- Selecione --</option>' + opcoes;
            if (selectFicha) selectFicha.innerHTML = '<option value="">-- Selecione --</option>' + opcoes;
        }

        function mudarModoEntradaEstoque(modo) {
            ['compra', 'ajuste', 'historico'].forEach(m => {
                const tab = document.getElementById(`tab-entrada-${m}`);
                tab.style.background = m === modo ? 'var(--primary)' : 'transparent';
                tab.style.color = m === modo ? 'white' : '#333';
                document.getElementById(`box-entrada-${m}`).style.display = m === modo ? 'block' : 'none';
            });
            if (modo === 'historico') carregarMovimentacoesEstoque();
        }

        function addItemEntradaEstoque() {
            const select = document.getElementById('entrada-item-select');
            const idProduto = parseInt(select.value);
            const qtd = parseFloat(document.getElementById('entrada-item-qtd').value);
            const custo = parseFloat(document.getElementById('entrada-item-custo').value);
            if (!idProduto || isNaN(qtd) || qtd <= 0 || isNaN(custo) || custo < 0) {
                return exibirAviso('Selecione o produto e preencha quantidade/custo corretamente.');
            }
            const produto = produtosDB.find(p => p.id === idProduto);
            itensEntradaEstoque.push({ produtoId: idProduto, produtoNome: produto.nome, qtd, custoUnitario: custo });
            document.getElementById('entrada-item-qtd').value = '1';
            document.getElementById('entrada-item-custo').value = '';
            select.value = '';
            renderizarItensEntradaEstoque();
        }

        function removerItemEntradaEstoque(index) {
            itensEntradaEstoque.splice(index, 1);
            renderizarItensEntradaEstoque();
        }

        function renderizarItensEntradaEstoque() {
            const tbody = document.getElementById('tabela-itens-entrada-estoque');
            if (itensEntradaEstoque.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="padding:12px; text-align:center; color:gray;">Nenhum item adicionado.</td></tr>';
            } else {
                tbody.innerHTML = itensEntradaEstoque.map((item, i) => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                        <td style="padding:6px;">${item.produtoNome}</td>
                        <td>${item.qtd}</td>
                        <td>R$ ${item.custoUnitario.toFixed(2)}</td>
                        <td>R$ ${(item.qtd * item.custoUnitario).toFixed(2)}</td>
                        <td><button class="btn btn-danger" style="padding:3px 8px; font-size:0.75rem;" onclick="removerItemEntradaEstoque(${i})">🗑️</button></td>
                    </tr>
                `).join('');
            }
            atualizarTotalEntradaEstoque();
        }

        function atualizarTotalEntradaEstoque() {
            const frete = parseFloat(document.getElementById('entrada-frete').value) || 0;
            const despesas = parseFloat(document.getElementById('entrada-outras-despesas').value) || 0;
            const subtotal = itensEntradaEstoque.reduce((a, i) => a + i.qtd * i.custoUnitario, 0);
            document.getElementById('txt-total-entrada-estoque').innerText = (subtotal + frete + despesas).toFixed(2);
        }

        // Estoque é por barraca (estoquePorProduto vive dentro do pdv_state
        // DESTA barraca) — confirmar uma entrada só muda o estoque de quem
        // está logado nela agora, mesmo o produto sendo do catálogo
        // compartilhado. Frete/despesas são rateados entre os itens
        // proporcional ao valor de cada um (custo "pousado"/landed cost).
        async function confirmarEntradaEstoque() {
            if (itensEntradaEstoque.length === 0) return exibirAviso('Adicione pelo menos 1 item antes de confirmar a entrada.');

            const numeroNF = document.getElementById('entrada-numero-nf').value.trim();
            const fornecedor = document.getElementById('entrada-fornecedor').value.trim();
            const frete = parseFloat(document.getElementById('entrada-frete').value) || 0;
            const despesas = parseFloat(document.getElementById('entrada-outras-despesas').value) || 0;
            const rateioTotal = frete + despesas;
            const subtotalGeral = itensEntradaEstoque.reduce((a, i) => a + i.qtd * i.custoUnitario, 0);
            // Nota 100% doada (todo item custo R$0) não tem valor pra ratear
            // o frete/despesas PROPORCIONALMENTE — mas o frete ainda existe
            // e não pode simplesmente sumir. Cai pra ratear por QUANTIDADE
            // em vez de valor nesse caso (só entra em jogo quando
            // subtotalGeral é 0 mas ainda assim tem frete/despesa a diluir).
            const qtdGeral = itensEntradaEstoque.reduce((a, i) => a + i.qtd, 0);

            const linhas = itensEntradaEstoque.map(item => {
                const valorItem = item.qtd * item.custoUnitario;
                const shareRateio = subtotalGeral > 0
                    ? (valorItem / subtotalGeral) * rateioTotal
                    : (qtdGeral > 0 ? (item.qtd / qtdGeral) * rateioTotal : 0);
                const custoUnitarioFinal = item.custoUnitario + (shareRateio / item.qtd);

                const estoqueAntes = estoquePorProduto[item.produtoId];
                const estoqueAntesVal = (estoqueAntes === undefined || estoqueAntes === null) ? 0 : estoqueAntes;
                const estoqueDepois = estoqueAntesVal + item.qtd;
                estoquePorProduto[item.produtoId] = estoqueDepois;

                const produto = produtosDB.find(p => p.id === item.produtoId);
                if (produto) {
                    // Média ponderada pelo estoque que já existia — não é só
                    // "o preço da última compra", senão uma entrada barata
                    // isolada bagunça o custo de um lote grande já em estoque
                    // (e vice-versa). Sem custoMedio anterior (1ª entrada
                    // desse produto, ou produto antigo de antes dessa
                    // funcionalidade) cai direto pro custo desta entrada.
                    const custoMedioAntigo = (produto.custoMedio !== undefined && produto.custoMedio !== null) ? produto.custoMedio : null;
                    const baseAntiga = custoMedioAntigo !== null ? estoqueAntesVal : 0;
                    const totalUnidades = baseAntiga + item.qtd;
                    produto.custoMedio = totalUnidades > 0
                        ? ((baseAntiga * (custoMedioAntigo || 0)) + (item.qtd * custoUnitarioFinal)) / totalUnidades
                        : custoUnitarioFinal;
                    sincronizarAtivoPorEstoque(produto, estoqueDepois);
                }

                return {
                    barraca_id: barracaStateId,
                    produto_id: item.produtoId,
                    produto_nome: item.produtoNome,
                    tipo: 'entrada',
                    quantidade: item.qtd,
                    estoque_antes: estoqueAntesVal,
                    estoque_depois: estoqueDepois,
                    custo_unitario: item.custoUnitario,
                    custo_unitario_final: custoUnitarioFinal,
                    numero_nota_fiscal: numeroNF || null,
                    fornecedor: fornecedor || null,
                    usuario_nome: usuarioAtual ? usuarioAtual.nome : null
                };
            });

            salvarNoBancoLocal();
            salvarCatalogo();
            renderizarTabelaProdutos();
            renderizarMenu(categoriaFiltroAtual);

            try {
                const { error } = await supabaseClient.from('pdv_movimentacoes_estoque').insert(linhas);
                if (error) throw error;
                exibirAviso(`Entrada confirmada! Estoque atualizado pra ${linhas.length} item(ns).`);
            } catch (erro) {
                console.error('Falha ao gravar movimentação de estoque:', erro);
                exibirAviso('O estoque já foi atualizado, mas não deu pra gravar o histórico dessa entrada agora (sem internet?). O número em si está certo.');
            }

            itensEntradaEstoque = [];
            document.getElementById('entrada-data-nf').value = '';
            document.getElementById('entrada-numero-nf').value = '';
            document.getElementById('entrada-fornecedor').value = '';
            document.getElementById('entrada-frete').value = '';
            document.getElementById('entrada-outras-despesas').value = '';
            renderizarItensEntradaEstoque();
        }

        function atualizarEstoqueAtualAjuste() {
            const idProduto = parseInt(document.getElementById('ajuste-produto-select').value);
            const atual = estoquePorProduto[idProduto];
            const atualVal = (atual === undefined || atual === null) ? null : atual;
            document.getElementById('txt-ajuste-estoque-atual').innerText = atualVal === null ? '∞ Livre (sem controle)' : `${atualVal} un.`;
            document.getElementById('ajuste-estoque-contado').value = atualVal !== null ? atualVal : '';
            atualizarDiferencaAjuste();
        }

        function atualizarDiferencaAjuste() {
            const idProduto = parseInt(document.getElementById('ajuste-produto-select').value);
            const atual = estoquePorProduto[idProduto];
            const atualVal = (atual === undefined || atual === null) ? 0 : atual;
            const contadoStr = document.getElementById('ajuste-estoque-contado').value;
            const txtDif = document.getElementById('txt-ajuste-diferenca');
            if (contadoStr === '') { txtDif.innerText = '—'; return; }
            const contado = parseFloat(contadoStr);
            if (isNaN(contado)) { txtDif.innerText = '—'; return; }
            const dif = contado - atualVal;
            txtDif.innerText = (dif > 0 ? '+' : '') + dif;
            txtDif.style.color = dif === 0 ? '#111827' : (dif > 0 ? 'var(--success)' : 'var(--danger)');
        }

        async function confirmarAjusteInventario() {
            const idProduto = parseInt(document.getElementById('ajuste-produto-select').value);
            if (!idProduto) return exibirAviso('Selecione um produto ou insumo.');
            const contadoStr = document.getElementById('ajuste-estoque-contado').value;
            if (contadoStr === '') return exibirAviso('Preencha o estoque contado fisicamente.');
            const contado = parseFloat(contadoStr);
            if (isNaN(contado) || contado < 0) return exibirAviso('Estoque contado inválido.');
            const motivo = document.getElementById('ajuste-motivo').value.trim();
            if (!motivo) return exibirAviso('O motivo do ajuste é obrigatório.');

            const produto = produtosDB.find(p => p.id === idProduto);
            const atual = estoquePorProduto[idProduto];
            const atualVal = (atual === undefined || atual === null) ? 0 : atual;
            const diferenca = contado - atualVal;

            estoquePorProduto[idProduto] = contado;
            if (produto && sincronizarAtivoPorEstoque(produto, contado)) salvarCatalogo();
            salvarNoBancoLocal();
            renderizarTabelaProdutos();
            renderizarMenu(categoriaFiltroAtual);

            try {
                const { error } = await supabaseClient.from('pdv_movimentacoes_estoque').insert({
                    barraca_id: barracaStateId,
                    produto_id: idProduto,
                    produto_nome: produto ? produto.nome : '?',
                    tipo: 'ajuste',
                    quantidade: diferenca,
                    estoque_antes: atualVal,
                    estoque_depois: contado,
                    motivo,
                    usuario_nome: usuarioAtual ? usuarioAtual.nome : null
                });
                if (error) throw error;
                exibirAviso('Ajuste de inventário confirmado!');
            } catch (erro) {
                console.error('Falha ao gravar ajuste de inventário:', erro);
                exibirAviso('O estoque já foi ajustado, mas não deu pra gravar o histórico agora (sem internet?). O número em si está certo.');
            }

            document.getElementById('ajuste-produto-select').value = '';
            document.getElementById('txt-ajuste-estoque-atual').innerText = '—';
            document.getElementById('ajuste-estoque-contado').value = '';
            document.getElementById('txt-ajuste-diferenca').innerText = '—';
            document.getElementById('ajuste-motivo').value = '';
        }

        const ROTULOS_TIPO_MOV_ESTOQUE = {
            entrada: { texto: '📥 Entrada', cor: '#16a34a' },
            ajuste: { texto: '🔧 Ajuste', cor: '#d97706' }
        };

        async function carregarMovimentacoesEstoque() {
            const tbody = document.getElementById('tabela-movimentacoes-estoque');
            if (!tbody || !barracaStateId) return;
            tbody.innerHTML = '<tr><td colspan="9" style="padding:20px; text-align:center; color:gray;">Carregando...</td></tr>';

            const inicio = document.getElementById('filtro-mov-data-inicio').value;
            const fim = document.getElementById('filtro-mov-data-fim').value;
            const tipo = document.getElementById('filtro-mov-tipo').value;

            let consulta = supabaseClient.from('pdv_movimentacoes_estoque').select('*').eq('barraca_id', barracaStateId).order('criado_em', { ascending: false }).limit(500);
            if (tipo) consulta = consulta.eq('tipo', tipo);
            if (inicio) consulta = consulta.gte('criado_em', `${inicio}T00:00:00`);
            if (fim) consulta = consulta.lte('criado_em', `${fim}T23:59:59`);

            try {
                const { data, error } = await consulta;
                if (error) throw error;
                renderizarTabelaMovimentacoesEstoque(data || []);
            } catch (erro) {
                console.error('Falha ao carregar movimentações de estoque:', erro);
                tbody.innerHTML = '<tr><td colspan="9" style="padding:20px; text-align:center; color:var(--danger);">Não foi possível carregar o histórico. A tabela pdv_movimentacoes_estoque existe no Supabase? (ver supabase/pdv_movimentacoes_estoque.sql)</td></tr>';
            }
        }

        function renderizarTabelaMovimentacoesEstoque(linhas) {
            const tbody = document.getElementById('tabela-movimentacoes-estoque');
            if (!tbody) return;
            if (linhas.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="padding:20px; text-align:center; color:gray;">Nenhuma movimentação encontrada.</td></tr>';
                return;
            }
            tbody.innerHTML = linhas.map(l => {
                const rotulo = ROTULOS_TIPO_MOV_ESTOQUE[l.tipo] || { texto: l.tipo, cor: '#374151' };
                const dataHora = new Date(l.criado_em).toLocaleString('pt-BR');
                const nfFornecedor = [l.numero_nota_fiscal, l.fornecedor].filter(Boolean).join(' / ') || '-';
                const qtdNum = Number(l.quantidade);
                return `
                    <tr style="border-bottom:1px solid #e5e7eb;">
                        <td style="padding:8px; white-space:nowrap;">${dataHora}</td>
                        <td><span style="color:${rotulo.cor}; font-weight:bold;">${rotulo.texto}</span></td>
                        <td style="font-weight:bold;">${l.produto_nome}</td>
                        <td style="font-weight:bold; color:${qtdNum < 0 ? 'var(--danger)' : 'var(--success)'};">${qtdNum > 0 ? '+' : ''}${qtdNum}</td>
                        <td>${l.estoque_antes ?? '-'} → ${l.estoque_depois ?? '-'}</td>
                        <td>${l.custo_unitario_final != null ? 'R$ ' + Number(l.custo_unitario_final).toFixed(2) : '-'}</td>
                        <td>${nfFornecedor}</td>
                        <td>${l.motivo || '-'}</td>
                        <td>${l.usuario_nome || '-'}</td>
                    </tr>
                `;
            }).join('');
        }

        function imprimirEstoquePorCategoria() {
            const areaPrint = document.getElementById('area-impressao');
            
            // Só produtos desta barraca — estoque é um conceito por barraca.
            const produtosDaBarraca = produtosDB.filter(p => Array.isArray(p.barracas) && p.barracas.includes(barracaStateId));

            let agrupado = {};
            categoriasDB.forEach(cat => { agrupado[cat] = []; });
            produtosDaBarraca.forEach(p => {
                if (!agrupado[p.categoria]) agrupado[p.categoria] = [];
                agrupado[p.categoria].push(p);
            });

            let htmlCategorias = '';
            for (let cat in agrupado) {
                if (agrupado[cat].length > 0) {
                    htmlCategorias += `
                        <div class="print-center print-bold" style="margin-top:10px; background:#f3f4f6; padding:3px; text-transform:uppercase;">--- ${cat} ---</div>
                    `;
                    agrupado[cat].forEach(p => {
                        const estoqueAqui = estoquePorProduto[p.id];
                        const estoqueAquiVal = (estoqueAqui === undefined) ? null : estoqueAqui;
                        let txtEstoque = p.isCombo ? 'Misto' : (estoqueAquiVal !== null ? `${estoqueAquiVal} un.` : 'Livre');
                        let txtInativo = p.ativo === false ? ' (INATIVO)' : '';
                        htmlCategorias += `
                            <div class="print-row" style="margin-top:4px;">
                                <span>${p.nome}${txtInativo}</span>
                                <span class="print-bold">${txtEstoque}</span>
                            </div>
                        `;
                    });
                }
            }

            const dataHora = new Date().toLocaleString('pt-BR');
            areaPrint.innerHTML = `
                <div class="print-center print-bold" style="font-size: 16px;">SANTUÁRIO SANTA RITA</div>
                <div class="print-center print-bold" style="font-size: 13px; margin-top:4px;">RELATÓRIO DE ESTOQUE POR CATEGORIA</div>
                <div class="print-center print-bold" style="font-size:10px; margin-bottom: 5px;">Gerado em: ${dataHora}</div>
                <div class="print-divider"></div>
                ${htmlCategorias}
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-top: 10px; font-size: 10px;">
                    Documento de Conferência Interna
                </div>
            `;

            dispararImpressao();
        }

        function gerarPDFEstoquePorCategoria() {
            imprimirEstoquePorCategoria();
            const element = document.getElementById('area-impressao');
            element.style.display = 'block';
            const opt = {
                margin: 5,
                filename: `Estoque_Santuario_${new Date().toISOString().slice(0,10)}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2 },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };
            html2pdf().set(opt).from(element).save().then(() => {
                element.style.display = 'none';
            });
        }

        function renderizarMenu(filtro = 'Todos') {
            categoriaFiltroAtual = filtro; renderizarCategoriasUI(); 
            const menuDiv = document.getElementById('menu-produtos'); menuDiv.innerHTML = '';
            const termoBusca = (document.getElementById('busca-produto-menu') ? document.getElementById('busca-produto-menu').value.trim().toLowerCase() : '');
            
            // Só produtos ativos (globalmente) E marcados para esta barraca aparecem
            // aqui — o catálogo é único, mas cada barraca só vende o que foi
            // marcado para ela.
            const produtosDisponiveisVenda = produtosDB.filter(p => p.ativo !== false && p.tipo !== 'insumo' && Array.isArray(p.barracas) && p.barracas.includes(barracaStateId));

            const renderCardHTML = (produto) => {
                let badgeEstoque = ''; let opacity = '1'; let descCombo = '';
                const estoqueAqui = estoquePorProduto[produto.id];
                const estoqueAquiVal = (estoqueAqui === undefined) ? null : estoqueAqui;
                if (produto.isCombo) {
                    badgeEstoque = `<div class="badge-combo">✨ COMBO</div>`;
                    let qtdTotal = produto.itensCombo.reduce((acc, i)=>acc+i.qtd, 0);
                    descCombo = `<div style="font-size: 0.65rem; color: gray; margin-top:1px;">Contém: ${qtdTotal} itens</div>`;
                } else if (estoqueAquiVal !== null) {
                    if (estoqueAquiVal <= 0) { badgeEstoque = `<div class="badge-estoque estoque-baixo">ESGOTADO</div>`; opacity = '0.5'; }
                    else if (estoqueAquiVal <= 5) badgeEstoque = `<div class="badge-estoque estoque-baixo">Restam ${estoqueAquiVal}</div>`;
                    else badgeEstoque = `<div class="badge-estoque">Est: ${estoqueAquiVal}</div>`;
                }

                let imgHtml = produto.foto ? `<img src="${produto.foto}" class="img-produto-card" alt="${produto.nome}">` : '';

                return `
                    <div class="card-produto" style="opacity: ${opacity};" onclick="addCarrinho(${produto.id})">
                        ${badgeEstoque}
                        ${imgHtml}
                        <div style="font-size: 0.7rem; color: #6b7280; font-weight: bold; text-transform: uppercase;">${produto.categoria}</div>
                        <div style="font-size: 0.85rem; font-weight: bold; margin: 2px 0; color: #111827; line-height: 1.1;">${produto.nome}</div>
                        ${descCombo}
                        <div style="color: var(--success); font-size: 0.95rem; font-weight: 800; margin-top: 4px;">R$ ${produto.preco.toFixed(2)}</div>
                    </div>`;
            };

            // Dentro de uma categoria, produtos com subcategoria (ex: Bebidas
            // > Refrigerantes, Sucos) ganham um mini-cabeçalho próprio; os
            // sem subcategoria aparecem soltos, sem cabeçalho extra.
            const renderGrupoProdutos = (itens) => {
                const semSub = itens.filter(p => !p.subcategoria);
                const comSub = itens.filter(p => p.subcategoria);
                let html = '';
                if (semSub.length > 0) html += `<div class="subgrupo-container">${semSub.map(renderCardHTML).join('')}</div>`;
                if (comSub.length > 0) {
                    let porSub = {};
                    comSub.forEach(p => { (porSub[p.subcategoria] = porSub[p.subcategoria] || []).push(p); });
                    for (let sub in porSub) {
                        html += `
                            <div class="subgrupo-header" style="font-size:0.8rem; border-bottom:none; border-left:3px solid var(--primary); padding-left:8px; margin-top:8px;">↳ ${sub}</div>
                            <div class="subgrupo-container">${porSub[sub].map(renderCardHTML).join('')}</div>
                        `;
                    }
                }
                return html;
            };

            let produtosFiltrados = produtosDisponiveisVenda;
            if (termoBusca) {
                produtosFiltrados = produtosDisponiveisVenda.filter(p => p.nome.toLowerCase().includes(termoBusca));
            }

            if (filtro === 'Todos') {
                let agrupado = {};
                categoriasDB.forEach(cat => { agrupado[cat] = []; });
                produtosFiltrados.forEach(p => {
                    if (!agrupado[p.categoria]) agrupado[p.categoria] = [];
                    agrupado[p.categoria].push(p);
                });

                let htmlGeral = '';
                for (let cat in agrupado) {
                    if (agrupado[cat].length > 0) {
                        htmlGeral += `
                            <div class="subgrupo-header">📁 ${cat}</div>
                            ${renderGrupoProdutos(agrupado[cat])}
                        `;
                    }
                }
                menuDiv.innerHTML = htmlGeral || '<p style="color: gray; text-align:center;">Nenhum produto ativo encontrado.</p>';
            } else {
                const itens = produtosFiltrados.filter(p => p.categoria === filtro);
                if (itens.length === 0) {
                    menuDiv.innerHTML = '<p style="color: gray; text-align:center;">Nenhum produto ativo nesta categoria.</p>';
                } else {
                    menuDiv.innerHTML = renderGrupoProdutos(itens);
                }
            }
        }
        function filtrarMenu(categoria) { renderizarMenu(categoria); }

        function abrirModalCombo(produto) {
            document.getElementById('modal-combo-titulo').innerText = `Montar ${produto.nome}`;
            const body = document.getElementById('modal-combo-body');
            body.innerHTML = '';
            
            produto.itensCombo.forEach((req) => {
                if (req.tipo === 'categoria') {
                    for(let i=0; i<req.qtd; i++) {
                        const opcoes = produtosDB.filter(p => p.categoria === req.ref && !p.isCombo && p.ativo !== false && Array.isArray(p.barracas) && p.barracas.includes(barracaStateId));
                        const optionsHtml = opcoes.map(p => {
                            const estAqui = estoquePorProduto[p.id];
                            const estAquiVal = (estAqui === undefined) ? null : estAqui;
                            let disp = estAquiVal !== null ? ` (Restam ${estAquiVal})` : '';
                            let block = (estAquiVal !== null && estAquiVal <= 0) ? 'disabled' : '';
                            return `<option value="${p.id}" ${block}>${p.nome}${disp}</option>`;
                        }).join('');
                        
                        body.innerHTML += `
                            <label style="font-size: 0.85rem; font-weight: bold; margin-top: 10px; display:block; color:#2563eb;">Escolha 1x ${req.ref}:</label>
                            <select class="combo-item-select" style="margin-bottom: 5px; width: 100%; padding: 8px;">
                                ${optionsHtml}
                            </select>
                        `;
                    }
                } else if (req.tipo === 'produto') {
                    let pFixo = produtosDB.find(x => x.id === req.ref);
                    for(let i=0; i<req.qtd; i++) {
                        body.innerHTML += `
                            <label style="font-size: 0.85rem; font-weight: bold; margin-top: 10px; display:block; color:#16a34a;">Item Fixo Incluso:</label>
                            <div class="combo-item-fixed" data-id="${req.ref}" style="background:#f0fdf4; padding:8px; border:1px solid #16a34a; border-radius:6px; margin-bottom:5px; font-size:0.9rem; color:#14532d; font-weight:bold;">
                                ✔️ 1x ${pFixo ? pFixo.nome : 'Desconhecido'}
                            </div>
                        `;
                    }
                }
            });
            document.getElementById('modal-combo').style.display = 'flex';
        }

        function fecharModalCombo() {
            document.getElementById('modal-combo').style.display = 'none';
            comboAtualId = null;
        }

        // No celular a tela empilha (produtos em cima, carrinho embaixo — ver
        // @media max-width:900px em styles.css) e depois de tocar num produto
        // não dava nenhum sinal visual de que o item entrou no pedido, sem
        // rolar a tela manualmente pra conferir. Rola até o carrinho sozinho
        // só nesse layout empilhado (no desktop os dois já ficam lado a lado).
        function avisarItemAdicionadoMobile() {
            if (window.innerWidth > 900) return;
            const carrinhoEl = document.getElementById('box-carrinho-container');
            if (carrinhoEl) carrinhoEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function confirmarCombo() {
            if (!caixaDoUsuarioAtual()) {
                return exibirAviso("🔒 Abra o seu caixa antes de fazer vendas.", "Caixa Fechado");
            }

            const produto = produtosDB.find(p => p.id === comboAtualId);
            const selects = document.querySelectorAll('.combo-item-select');
            const fixos = document.querySelectorAll('.combo-item-fixed');
            let itensEscolhidos = [];
            let checkEstoqueMap = {};

            for(let select of selects) {
                if(!select.value) { exibirAviso("Há opções indisponíveis ou não selecionadas no combo!"); return; }
                const idProd = parseInt(select.value);
                const subP = produtosDB.find(x => x.id === idProd);
                checkEstoqueMap[idProd] = (checkEstoqueMap[idProd] || 0) + 1;
                itensEscolhidos.push({ idProduto: subP.id, nome: subP.nome, cozinha: subP.cozinha, qtd: 1, categoria: subP.categoria, fase: 'agora' });
            }
            
            for(let fixo of fixos) {
                const idProd = parseInt(fixo.dataset.id);
                const subP = produtosDB.find(x => x.id === idProd);
                checkEstoqueMap[idProd] = (checkEstoqueMap[idProd] || 0) + 1;
                itensEscolhidos.push({ idProduto: subP.id, nome: subP.nome, cozinha: subP.cozinha, qtd: 1, categoria: subP.categoria, fase: 'agora' });
            }

            for(let id in checkEstoqueMap) {
                if(!verificarEstoqueDisponivel(parseInt(id), checkEstoqueMap[id])) return; 
            }

            let tipoGlobal = document.getElementById('tipo-retirada-global').value;
            let fase = tipoGlobal === 'mais_tarde' ? 'mais_tarde' : 'agora';

            carrinho.push({ 
                cartId: Date.now().toString() + Math.floor(Math.random()*100), 
                idProduto: produto.id, nome: produto.nome, preco: produto.preco, 
                categoria: produto.categoria, cozinha: produto.cozinha, 
                isCombo: true, itensComboEscolhidos: itensEscolhidos,
                qtd: 1, obs: '', fase: fase 
            });
            fecharModalCombo();
            atualizarCarrinhoUI();
            avisarItemAdicionadoMobile();
        }

        function abrirModalObs(cartId) {
            obsCartIdAtual = cartId;
            const item = carrinho.find(i => i.cartId === cartId);
            const produto = produtosDB.find(p => p.id === item.idProduto);

            document.getElementById('modal-obs-nome-item').innerText = `Item: ${item.nome}`;

            const boxCheck = document.getElementById('container-checkboxes-obs');
            const gridCheck = document.getElementById('grid-ingredientes-obs');
            gridCheck.innerHTML = '';

            let listaIngredientes = [];
            if (produto && produto.ingredientes) {
                listaIngredientes = produto.ingredientes.split(',').map(s => s.trim()).filter(Boolean);
            }

            if (listaIngredientes.length > 0) {
                boxCheck.style.display = 'block';
                listaIngredientes.forEach(ing => {
                    const jaTemSem = item.obs ? item.obs.includes(`Sem ${ing}`) : false;
                    gridCheck.innerHTML += `
                        <label class="item-checkbox-ingrediente">
                            <input type="checkbox" value="Sem ${ing}" ${jaTemSem ? 'checked' : ''} class="cb-obs-ingrediente"> Sem ${ing}
                        </label>
                    `;
                });
            } else {
                boxCheck.style.display = 'none';
            }

            let textoLivre = item.obs || '';
            if (listaIngredientes.length > 0 && textoLivre) {
                listaIngredientes.forEach(ing => {
                    textoLivre = textoLivre.replace(`Sem ${ing}`, '').replace(/,\s*,/g, ',').replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
                });
            }

            document.getElementById('input-obs-texto').value = textoLivre;
            document.getElementById('modal-obs').style.display = 'flex';
            document.getElementById('input-obs-texto').focus();
        }

        function fecharModalObs() {
            document.getElementById('modal-obs').style.display = 'none';
            obsCartIdAtual = null;
        }

        function salvarObsModal() {
            if (obsCartIdAtual !== null) {
                const checkboxes = document.querySelectorAll('.cb-obs-ingrediente:checked');
                let marcados = Array.from(checkboxes).map(cb => cb.value);
                const textoLivre = document.getElementById('input-obs-texto').value.trim();

                let obsFinal = [];
                if (marcados.length > 0) obsFinal.push(marcados.join(', '));
                if (textoLivre) obsFinal.push(textoLivre);

                const item = carrinho.find(i => i.cartId === obsCartIdAtual);
                if (item) item.obs = obsFinal.join(', ');
            }
            fecharModalObs();
            atualizarCarrinhoUI();
        }

        function abrirModalTrocaItem(idPedido, cartId, subIndex = null) {
            trocaItemPedidoId = idPedido;
            trocaItemCartId = cartId;
            trocaItemSubIndex = subIndex;
            const pedido = pedidosGerais.find(p => p.id === idPedido);
            const itemPai = pedido.itens.find(i => i.cartId === cartId);
            // Troca de um sub-item DENTRO de um combo (subIndex informado) usa
            // os dados do sub-item escolhido, não do combo em si — um combo
            // sempre tem item.cozinha=true (ver salvarProduto), então checar
            // isso no item pai bloquearia toda troca de sub-item de combo.
            const item = subIndex !== null ? itemPai.itensComboEscolhidos[subIndex] : itemPai;

            if (!item || item.cozinha) return exibirAviso("Apenas itens de balcão (sem cozinha) podem ser trocados aqui!");

            const prodOriginal = produtosDB.find(p => p.id === item.idProduto);
            const precoItem = item.preco || (prodOriginal ? prodOriginal.preco : 0);

            document.getElementById('modal-troca-info').innerText = `Pedido #${rotuloPedido(pedido)} (${pedido.cliente}) - Item atual: ${item.nome}${precoItem ? ` (R$ ${precoItem.toFixed(2)})` : ''}`;

            // Sempre exige mesmo valor, dentro ou fora de combo — pra sub-item
            // de combo isso compara com o preço do produto ORIGINAL daquele
            // slot (via prodOriginal.preco acima), não com o preço do combo
            // inteiro.
            const produtosDisponiveis = produtosDB.filter(p => p.categoria === item.categoria && !p.isCombo && Math.abs(p.preco - precoItem) < 0.01 && p.ativo !== false && Array.isArray(p.barracas) && p.barracas.includes(barracaStateId));
            const select = document.getElementById('select-novo-item-troca');

            if (produtosDisponiveis.length === 0) {
                select.innerHTML = '<option value="">Nenhum produto ativo com o mesmo valor nesta categoria</option>';
            } else {
                select.innerHTML = produtosDisponiveis.map(p => {
                    const estAqui = estoquePorProduto[p.id];
                    const estAquiVal = (estAqui === undefined) ? null : estAqui;
                    let disp = estAquiVal !== null ? ` (Restam ${estAquiVal})` : '';
                    return `<option value="${p.id}">${p.nome} - R$ ${p.preco.toFixed(2)}${disp}</option>`;
                }).join('');
            }

            document.getElementById('modal-troca-item').style.display = 'flex';
            // Foca o select assim que o modal abre — daí as setas já mudam o
            // produto escolhido (comportamento nativo do <select>) e o Enter
            // confirma, sem precisar tocar no mouse.
            select.focus();
        }

        function fecharModalTroca() {
            document.getElementById('modal-troca-item').style.display = 'none';
            trocaItemPedidoId = null;
            trocaItemCartId = null;
            trocaItemSubIndex = null;
        }

        function confirmarTrocaItemBalcao() {
            const selectVal = document.getElementById('select-novo-item-troca').value;
            if (!selectVal) return exibirAviso("Selecione um produto válido para a troca.");
            
            const novoIdProduto = parseInt(selectVal);
            const novoProduto = produtosDB.find(p => p.id === novoIdProduto);
            if (!novoProduto) return;

            const pedido = pedidosGerais.find(p => p.id === trocaItemPedidoId);
            const itemPai = pedido.itens.find(i => i.cartId === trocaItemCartId);
            const item = trocaItemSubIndex !== null ? itemPai.itensComboEscolhidos[trocaItemSubIndex] : itemPai;

            let catalogoAlteradoPorEstoque = false;

            const prodAntigo = produtosDB.find(p => p.id === item.idProduto);
            if (prodAntigo) {
                const estAntigo = estoquePorProduto[prodAntigo.id];
                if (estAntigo !== undefined && estAntigo !== null) {
                    const novoEst = estAntigo + 1;
                    estoquePorProduto[prodAntigo.id] = novoEst;
                    if (sincronizarAtivoPorEstoque(prodAntigo, novoEst)) catalogoAlteradoPorEstoque = true;
                }
            }

            const estNovo = estoquePorProduto[novoProduto.id];
            if (estNovo !== undefined && estNovo !== null) {
                if (estNovo <= 0) {
                    exibirAviso("Atenção: Este produto estava sem estoque, mas a troca foi efetuada.");
                }
                const novoEst = estNovo - 1;
                estoquePorProduto[novoProduto.id] = novoEst;
                if (sincronizarAtivoPorEstoque(novoProduto, novoEst)) catalogoAlteradoPorEstoque = true;
            }

            item.idProduto = novoProduto.id;
            item.nome = novoProduto.nome;
            item.categoria = novoProduto.categoria;
            // Sub-item de combo não tem preço próprio (o combo inteiro tem um
            // preço fixo) — só produtos trocados fora de combo herdam o preço
            // do novo produto.
            if (trocaItemSubIndex === null) item.preco = novoProduto.preco;

            if (catalogoAlteradoPorEstoque) salvarCatalogo();
            salvarNoBancoLocal();
            fecharModalTroca();
            renderizarMenu(categoriaFiltroAtual);
            renderizarTabelaProdutos();
            atualizarTelas();
            exibirAviso("Troca realizada com sucesso e estoque atualizado!");
        }

        function toggleCampoDinheiro() {
            const forma = document.getElementById('forma-pagto').value;
            const boxDinheiro = document.getElementById('box-dinheiro-troco');
            const boxBonificacao = document.getElementById('box-bonificacao');
            const boxMisto = document.getElementById('box-pagamento-misto');

            boxDinheiro.style.display = 'none';
            boxBonificacao.style.display = 'none';
            boxMisto.style.display = 'none';

            const btnQrCodePix = document.getElementById('btn-gerar-qrcode-pix');
            if (btnQrCodePix) btnQrCodePix.style.display = (forma === 'Pix' || forma === 'Pix Direto') ? 'block' : 'none';

            if(forma === 'Dinheiro') {
                boxDinheiro.style.display = 'block'; 
                calcularTroco(); 
            } else if (forma === 'Bonificação') {
                boxBonificacao.style.display = 'block';
            } else if (forma === 'Misto') {
                boxMisto.style.display = 'block';
                atualizarValoresMisto();
                
                const forma1 = document.getElementById('misto-forma-1').value;
                const forma2 = document.getElementById('misto-forma-2').value;
                if(forma1 === 'Dinheiro' || forma2 === 'Dinheiro') {
                    boxDinheiro.style.display = 'block';
                    calcularTroco();
                }
            }
        }

        // --- Pix QR Code ---
        // Gera o "BR Code" (payload padrão do Banco Central pra QR Code
        // Pix) inteiramente no navegador, sem gateway/API de pagamento —
        // é só texto formatado + checksum, qualquer banco/carteira lê.
        // Não confirma pagamento sozinho (isso o Pix estático nunca faz);
        // o operador ainda confere que caiu e clica em Cobrar como sempre.
        function removerAcentosPix(str) {
            // Faixa Unicode dos acentos combinantes (U+0300 a U+036F) —
            // construída via charCode em vez de regex literal, pra não
            // depender de caracteres combinantes soltos dentro do arquivo
            // fonte (frágil: normalização de texto em qualquer ferramenta
            // no caminho — editor, git, terminal — pode corromper isso).
            const inicio = String.fromCharCode(0x0300);
            const fim = String.fromCharCode(0x036f);
            const regexAcentos = new RegExp('[' + inicio + '-' + fim + ']', 'g');
            return (str || '').normalize('NFD').replace(regexAcentos, '');
        }

        function tlvPix(id, valor) {
            const tamanho = String(valor.length).padStart(2, '0');
            return `${id}${tamanho}${valor}`;
        }

        // CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF) — exigido
        // pelo padrão como últimos 4 caracteres do payload, calculado sobre
        // o payload inteiro (já incluindo o prefixo "6304" do próprio campo
        // do CRC, sem o valor do CRC ainda).
        function crc16Pix(payload) {
            let crc = 0xFFFF;
            for (let i = 0; i < payload.length; i++) {
                crc ^= payload.charCodeAt(i) << 8;
                for (let j = 0; j < 8; j++) {
                    crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
                    crc &= 0xFFFF;
                }
            }
            return crc.toString(16).toUpperCase().padStart(4, '0');
        }

        function montarPayloadPix({ chave, nome, cidade, valor }) {
            const nomeLimpo = removerAcentosPix(nome).toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 25).trim() || 'RECEBEDOR';
            const cidadeLimpa = removerAcentosPix(cidade).toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 15).trim() || 'BRASIL';
            const valorStr = Number(valor).toFixed(2);

            const infoConta = tlvPix('00', 'br.gov.bcb.pix') + tlvPix('01', chave.trim());
            const dadosAdicionais = tlvPix('05', '***'); // sem txid próprio — "***" é o valor padrão pra Pix estático

            let payload = ''
                + tlvPix('00', '01')
                + tlvPix('01', '11')
                + tlvPix('26', infoConta)
                + tlvPix('52', '0000')
                + tlvPix('53', '986')
                + tlvPix('54', valorStr)
                + tlvPix('58', 'BR')
                + tlvPix('59', nomeLimpo)
                + tlvPix('60', cidadeLimpa)
                + tlvPix('62', dadosAdicionais)
                + '6304';

            return payload + crc16Pix(payload);
        }

        function abrirModalPixQRCode() {
            if (!configPadroes.pixChave) {
                return exibirAviso('Cadastre a chave Pix desta barraca primeiro em ⚙️ Gestão → Configurações → "📱 Pix (QR Code)".');
            }
            const total = carrinho.reduce((acc, item) => acc + (item.preco * item.qtd) - (item.desconto || 0) + (item.acrescimo || 0), 0);
            if (total <= 0) return exibirAviso('Adicione itens ao pedido antes de gerar o QR Code.');

            const payload = montarPayloadPix({
                chave: configPadroes.pixChave,
                nome: configPadroes.pixNomeRecebedor,
                cidade: configPadroes.pixCidadeRecebedor,
                valor: total
            });

            document.getElementById('pix-qrcode-valor').innerText = `R$ ${total.toFixed(2)}`;
            document.getElementById('pix-qrcode-copia-cola').value = payload;

            const qr = qrcode(0, 'M');
            qr.addData(payload);
            qr.make();
            document.getElementById('pix-qrcode-desenho').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });

            document.getElementById('modal-pix-qrcode').style.display = 'flex';
        }

        function fecharModalPixQRCode() {
            document.getElementById('modal-pix-qrcode').style.display = 'none';
        }

        function copiarCodigoPixCopiaCola() {
            const campo = document.getElementById('pix-qrcode-copia-cola');
            campo.select();
            navigator.clipboard.writeText(campo.value)
                .then(() => exibirAviso('Código Pix copiado!'))
                .catch(() => document.execCommand('copy'));
        }

        function atualizarValoresMisto(origem = '1') {
            const total = carrinho.reduce((acc, item) => acc + (item.preco * item.qtd) - (item.desconto || 0) + (item.acrescimo || 0), 0);
            const inputVal1 = document.getElementById('misto-valor-1');
            const inputVal2 = document.getElementById('misto-valor-2');
            
            if (origem === '1') {
                let v1 = parseFloat(inputVal1.value) || 0;
                if(v1 > total) v1 = total;
                inputVal2.value = (total - v1 > 0 ? total - v1 : 0).toFixed(2);
            } else {
                let v2 = parseFloat(inputVal2.value) || 0;
                if(v2 > total) v2 = total;
                inputVal1.value = (total - v2 > 0 ? total - v2 : 0).toFixed(2);
            }
            calcularTroco();
        }

        function calcularTroco() {
            const total = carrinho.reduce((acc, item) => acc + (item.preco * item.qtd) - (item.desconto || 0) + (item.acrescimo || 0), 0);
            const forma = document.getElementById('forma-pagto').value;
            const recVal = parseFloat(document.getElementById('valor-recebido-dinheiro').value) || 0;
            
            let valorDevidoDinheiro = total;
            if(forma === 'Misto') {
                const forma1 = document.getElementById('misto-forma-1').value;
                const forma2 = document.getElementById('misto-forma-2').value;
                const v1 = parseFloat(document.getElementById('misto-valor-1').value) || 0;
                const v2 = parseFloat(document.getElementById('misto-valor-2').value) || 0;
                
                valorDevidoDinheiro = 0;
                if(forma1 === 'Dinheiro') valorDevidoDinheiro += v1;
                if(forma2 === 'Dinheiro') valorDevidoDinheiro += v2;
            }

            const troco = recVal - valorDevidoDinheiro;
            document.getElementById('valor-troco-display').innerText = (troco > 0 ? troco : 0).toFixed(2);
        }

        function verificarEstoqueDisponivel(idProduto, qtdParaAdicionar = 1) {
            const p = produtosDB.find(x => x.id === idProduto);
            const estoqueAqui = estoquePorProduto[idProduto];
            const estoqueAquiVal = (estoqueAqui === undefined) ? null : estoqueAqui;
            if(!p || estoqueAquiVal === null) return true;

            let countCart = 0;
            carrinho.forEach(ci => {
                if(ci.isCombo) {
                    ci.itensComboEscolhidos.forEach(sub => { if(sub.idProduto === idProduto) countCart += 1; });
                } else {
                    if(ci.idProduto === idProduto) countCart += (ci.qtd || 1);
                }
            });

            if (countCart + qtdParaAdicionar > estoqueAquiVal) {
                exibirAviso(`Estoque insuficiente de ${p.nome}! Restam ${estoqueAquiVal} unidades.`);
                return false;
            }
            return true;
        }

        function mudarTipoRetiradaGlobal() {
            const tipo = document.getElementById('tipo-retirada-global').value;
            // item.fase só pode ser 'agora' ou 'mais_tarde' — nunca o valor cru
            // do select. "agora_sem_cozinha" (e qualquer outro valor) precisa
            // virar 'agora'; do contrário o item fica com uma fase que não bate
            // com nenhum filtro (nem 'agora' nem 'mais_tarde') e some de vez dos
            // recibos/telas que dependem de fase, mesmo depois de entregue.
            const faseNormalizada = tipo === 'mais_tarde' ? 'mais_tarde' : 'agora';
            carrinho.forEach(item => item.fase = (tipo === 'parcial' ? item.fase : faseNormalizada));
            atualizarCarrinhoUI();
        }

        function addCarrinho(idProduto) {
            if (!caixaDoUsuarioAtual()) {
                return exibirAviso("🔒 Abra o seu caixa (ícone 💰 ao lado do carrinho) antes de adicionar pedidos.", "Caixa Fechado");
            }

            const produto = produtosDB.find(p => p.id === idProduto);
            if (!produto || produto.ativo === false) {
                return exibirAviso("Este produto está inativo e não pode ser vendido.");
            }

            if(produto.isCombo) {
                comboAtualId = idProduto;
                abrirModalCombo(produto);
                return;
            }

            // Cada clique é 1 linha nova no carrinho (qtd:1), de propósito —
            // pedido pra mesa que quer "1 sem cebola" + "1 bem passado" só
            // dá pra descrever separado se forem linhas separadas (cada
            // linha tem sua própria Observação). Um prompt de quantidade
            // juntando tudo numa linha só (testado e revertido) quebrava
            // isso — perdia a chance de dar obs diferente pra cada unidade.
            if(!verificarEstoqueDisponivel(idProduto, 1)) return;

            let tipoGlobal = document.getElementById('tipo-retirada-global').value;
            let fase = tipoGlobal === 'mais_tarde' ? 'mais_tarde' : 'agora';

            carrinho.push({
                cartId: Date.now().toString() + Math.floor(Math.random()*1000),
                idProduto: produto.id, nome: produto.nome, preco: produto.preco,
                categoria: produto.categoria, cozinha: produto.cozinha, entregaInstantanea: !!produto.entregaInstantanea,
                isCombo: false, qtd: 1, obs: '', fase: fase
            });
            atualizarCarrinhoUI();
            avisarItemAdicionadoMobile();
        }

        function removerItemCarrinho(cartId) {
            carrinho = carrinho.filter(i => i.cartId !== cartId);
            atualizarCarrinhoUI();
        }

        function setFaseItem(cartId, novaFase) { carrinho.find(i => i.cartId === cartId).fase = novaFase; atualizarCarrinhoUI(); }

        // Desconto é um valor fixo em R$ por item (não %), guardado direto no
        // item do carrinho — segue pro pedido salvo e aparece no recibo, pra
        // ficar registrado o motivo da diferença de valor depois.
        async function abrirDescontoItem(cartId) {
            const item = carrinho.find(i => i.cartId === cartId);
            if (!item) return;

            const maximo = item.preco * item.qtd;
            const valorStr = await pedirTexto(`Valor de desconto (R$) para "${item.nome}" (máximo R$ ${maximo.toFixed(2)}). Deixe 0 pra remover o desconto:`, { titulo: '🏷️ Desconto no Item', valorInicial: item.desconto ? item.desconto.toFixed(2) : '' });
            if (valorStr === null) return;

            const valor = parseFloat(valorStr.replace(',', '.'));
            if (isNaN(valor) || valor < 0) return exibirAviso("Valor de desconto inválido.");
            if (valor > maximo) return exibirAviso(`O desconto não pode ser maior que o valor do item (R$ ${maximo.toFixed(2)}).`);

            item.desconto = valor > 0 ? valor : undefined;
            atualizarCarrinhoUI();
        }

        // Acréscimo é o oposto do desconto: cliente pagou A MAIS por aquele
        // item (ex: pediu um extra que não está no cardápio, ou só quis dar
        // uma diferença maior mesmo) — mesmo esquema (valor fixo em R$,
        // guardado no item do carrinho, aparece no recibo).
        async function abrirAcrescimoItem(cartId) {
            const item = carrinho.find(i => i.cartId === cartId);
            if (!item) return;

            const valorStr = await pedirTexto(`Valor de acréscimo (R$) para "${item.nome}" — quanto a mais o cliente pagou. Deixe 0 pra remover o acréscimo:`, { titulo: '➕ Acréscimo no Item', valorInicial: item.acrescimo ? item.acrescimo.toFixed(2) : '' });
            if (valorStr === null) return;

            const valor = parseFloat(valorStr.replace(',', '.'));
            if (isNaN(valor) || valor < 0) return exibirAviso("Valor de acréscimo inválido.");

            item.acrescimo = valor > 0 ? valor : undefined;
            atualizarCarrinhoUI();
        }

        function atualizarCarrinhoUI() {
            const divItens = document.getElementById('itens-carrinho');
            const tipoGlobal = document.getElementById('tipo-retirada-global').value;
            divItens.innerHTML = ''; let total = 0;
            if (carrinho.length === 0) divItens.innerHTML = '<p style="color:gray; text-align:center;">Nenhum item adicionado.</p>';

            let temItemCozinha = false;

            carrinho.forEach(item => {
                const desconto = item.desconto || 0;
                const acrescimo = item.acrescimo || 0;
                total += (item.preco * item.qtd) - desconto + acrescimo;
                if (item.cozinha || (item.isCombo && item.itensComboEscolhidos.some(sub => sub.cozinha))) {
                    temItemCozinha = true;
                }

                // Editando um pedido já existente, o toggle por item fica
                // sempre disponível (não depende do Modo de Retirada Global,
                // que fica escondido durante edição — ver editarPedido).
                let htmlFase = (tipoGlobal === 'parcial' || pedidoEmEdicaoId !== null)
                    ? `<select onchange="setFaseItem('${item.cartId}', this.value)" style="margin:0; padding:6px; font-size:0.85rem;"><option value="agora" ${item.fase==='agora'?'selected':''}>Agora</option><option value="mais_tarde" ${item.fase==='mais_tarde'?'selected':''}>Depois</option></select>`
                    : `<span style="font-size:0.8rem; background:#f3f4f6; padding:4px;">${item.fase === 'mais_tarde' ? '📦 Depois' : '🟢 Agora'}</span>`;

                let descCombo = item.isCombo ? `<div style="font-size:0.75rem; color:gray; margin-top:2px;">↳ Contém: ${item.itensComboEscolhidos.map(sub=>`1x ${sub.nome}`).join(', ')}</div>` : '';

                // Total da LINHA (preço unitário × quantidade), não o preço
                // unitário sozinho — senão "3x Coca-Cola R$ 5,00" ficaria
                // ambíguo (5 é de 1 ou das 3?). Desconto/acréscimo já são
                // valores da linha inteira (ver abrirDescontoItem/abrirAcrescimoItem).
                let precoLinha = item.preco * item.qtd;
                let htmlPreco = (desconto > 0 || acrescimo > 0)
                    ? `<b><s style="color:gray; font-weight:normal; font-size:0.85rem;">R$ ${precoLinha.toFixed(2)}</s> R$ ${(precoLinha - desconto + acrescimo).toFixed(2)}</b>`
                    : `<b>R$ ${precoLinha.toFixed(2)}</b>`;

                divItens.innerHTML += `
                    <div class="item-carrinho">
                        <div style="display:flex; justify-content:space-between;"><b>${item.qtd}x ${item.nome}</b>${htmlPreco}</div>
                        ${descCombo}
                        ${desconto > 0 ? `<div style="color:var(--success); font-size:0.8rem; font-weight:bold; margin-top:2px;">🏷️ Desconto: R$ ${desconto.toFixed(2)}</div>` : ''}
                        ${acrescimo > 0 ? `<div style="color:#c2410c; font-size:0.8rem; font-weight:bold; margin-top:2px;">➕ Acréscimo: R$ ${acrescimo.toFixed(2)}</div>` : ''}
                        ${item.obs ? `<div style="color:var(--danger); font-size:0.85rem; margin-top:4px;">📝 Observação: ${item.obs}</div>` : ''}
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; flex-wrap:wrap; gap:6px;">
                            <div style="display:flex; gap:8px; flex-wrap:wrap;">${htmlFase} <button class="btn btn-warning" style="padding:6px; font-size:0.8rem;" onclick="abrirModalObs('${item.cartId}')">Observação</button> <button class="btn" style="padding:6px; font-size:0.8rem; background:#0d9488; color:white;" onclick="abrirDescontoItem('${item.cartId}')" title="Aplicar desconto neste item">🏷️ Desconto</button> <button class="btn" style="padding:6px; font-size:0.8rem; background:#c2410c; color:white;" onclick="abrirAcrescimoItem('${item.cartId}')" title="Aplicar acréscimo neste item">➕ Acréscimo</button></div>
                            <div class="qtd-controle"><button class="btn btn-danger" style="padding:6px; font-size:0.8rem;" onclick="removerItemCarrinho('${item.cartId}')">🗑️ Remover</button></div>
                        </div>
                    </div>`;
            });

            const optSemCozinha = document.getElementById('opt-sem-cozinha');
            const selectRetirada = document.getElementById('tipo-retirada-global');

            if (temItemCozinha) {
                optSemCozinha.style.display = 'none';
                if (selectRetirada.value === 'agora_sem_cozinha') {
                    selectRetirada.value = '';
                }
            } else {
                optSemCozinha.style.display = 'block';
            }

            // Editando um pedido, quem decide se ele vai pra Cozinha é o
            // campo manual "Status do Pedido" (ver editarPedido) — ele NÃO
            // se atualiza sozinho quando o carrinho muda. Bug real: alguém
            // adiciona um item de cozinha (ex: hambúrguer) num pedido que
            // já estava como "Balcão Pendente" e esquece de mudar esse
            // campo — o item nunca aparece na tela da Cozinha, mesmo
            // aparecendo certo no Balcão. Corrige sozinho só nesse sentido
            // (nunca tira automaticamente de "Na Cozinha", só põe quando
            // precisa) — o operador ainda pode reverter na mão se for de
            // propósito.
            if (pedidoEmEdicaoId !== null) {
                const selectStatusEdicao = document.getElementById('status-pedido-edicao');
                if (selectStatusEdicao && temItemCozinha && selectStatusEdicao.value === 'nenhum') {
                    selectStatusEdicao.value = 'preparando';
                    exibirAviso('Esse pedido tem item de cozinha agora — mudei o "Status do Pedido" pra "Na Cozinha (Em Preparo)" automaticamente, senão a Cozinha não veria esse item.', '👨‍🍳 Status Atualizado');
                }
            }

            document.getElementById('total-carrinho').innerText = total.toFixed(2);
            const qtdItens = carrinho.reduce((a, i) => a + i.qtd, 0);
            document.getElementById('qtd-itens-carrinho').innerText = `${qtdItens} ${qtdItens === 1 ? 'item' : 'itens'}`;
            atualizarValoresMisto();
        }

        // Aplica os padrões definidos em "Configurações & Parâmetros" nos campos
        // de pagamento/retirada da tela de Pedido. Chamada ao limpar o carrinho,
        // ao entrar na tela de Pedido (se não houver carrinho em andamento) e no
        // carregamento inicial — assim o que foi configurado aparece pré-marcado
        // sem precisar finalizar um pedido primeiro pra "ativar" o padrão.
        function aplicarConfigPadroesNoFormulario() {
            document.getElementById('forma-pagto').value = configPadroes.formaPagto || '';
            document.getElementById('tipo-retirada-global').value = configPadroes.tipoRetiradaGlobal || '';
            document.getElementById('tipo-atendimento').value = configPadroes.tipoAtendimento || '';
            toggleCampoDinheiro();
        }

        // limparCarrinho() também é chamada automaticamente depois de uma
        // venda concluída (finalizarPedido) — não pode pedir confirmação ali,
        // senão travaria o fluxo normal de checkout. Só o botão "Limpar
        // Pedido" (clique manual) passa por este wrapper com o confirm().
        async function limparCarrinhoComConfirmacao() {
            if (carrinho.length > 0 && !(await pedirConfirmacao('Deseja limpar o pedido?', { titulo: '❌ Limpar Pedido' }))) return;
            limparCarrinho();
        }

        function limparCarrinho() {
            carrinho = []; document.getElementById('nome-cliente').value = '';
            document.getElementById('valor-recebido-dinheiro').value = '';
            document.getElementById('obs-bonificacao').value = '';

            aplicarConfigPadroesNoFormulario();

            pedidoEmEdicaoId = null;
            document.getElementById('banner-alerta-edicao').style.display = 'none';
            document.getElementById('box-status-edicao').style.display = 'none';
            document.getElementById('box-modo-retirada-global').style.display = 'block';
            document.getElementById('btn-limpar-pedido').style.display = 'block';
            document.getElementById('box-carrinho-container').classList.remove('modo-edicao');
            document.getElementById('titulo-painel-carrinho').innerText = "Pedido Atual";
            document.getElementById('btn-finalizar-pedido').innerHTML = `Cobrar, Imprimir e Enviar 🖨️`;
            document.getElementById('btn-finalizar-pedido').classList.replace('btn-warning', 'btn-primary');

            atualizarCarrinhoUI();
        }

        // Letra fixa deste aparelho/navegador — usada só pra rotular pedido
        // que nasce OFFLINE (ver finalizarPedido/rotuloPedido). Diferente do
        // PDV_CLIENT_ID (js/config.js): esse é gerado de novo a cada reload
        // de página, não serve pra identificar "este aparelho" de forma
        // estável. Sorteada 1x e guardada no localStorage pra sempre dar a
        // mesma letra neste navegador, mesmo depois de recarregar/reabrir.
        const CHAVE_LETRA_DISPOSITIVO = 'pdv_letra_dispositivo';
        function obterLetraDispositivo() {
            let letra = localStorage.getItem(CHAVE_LETRA_DISPOSITIVO);
            if (!letra) {
                letra = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
                localStorage.setItem(CHAVE_LETRA_DISPOSITIVO, letra);
            }
            return letra;
        }

        // Número que aparece pro humano (tela, recibo, voz) — normalmente é
        // só o id. Pedido que nasceu com o app OFFLINE ganha a letra do
        // aparelho na frente (ex: "B15"): dois aparelhos offline ao mesmo
        // tempo podem colidir no MESMO id internamente (o mecanismo de
        // mesclagem resolve isso sozinho depois, sem perder pedido), mas com
        // letras diferentes o papel impresso na hora nunca fica ambíguo. Uma
        // vez atribuído o rótulo é permanente — não muda quando sincroniza,
        // pra nunca deixar de bater com um recibo já impresso.
        function rotuloPedido(p) {
            if (!p) return '?';
            return (p.numeroProvisorio && p.letraDispositivo) ? `${p.letraDispositivo}${p.id}` : `${p.id}`;
        }

        function finalizarPedido() {
            const meuCaixaAtual = caixaDoUsuarioAtual();
            if (!meuCaixaAtual) {
                return exibirAviso("🔒 Abra o seu caixa antes de finalizar pedidos.", "Caixa Fechado");
            }

            const cliente = document.getElementById('nome-cliente').value.trim();
            if (carrinho.length === 0) return exibirAviso("O carrinho está vazio!");
            if (!cliente) return exibirAviso("Por favor, informe o Nome do Cliente ou Mesa!");

            let formaPagto = document.getElementById('forma-pagto').value;
            const tipoAtendimento = document.getElementById('tipo-atendimento').value;
            const tipoGlobalRetirada = document.getElementById('tipo-retirada-global').value;

            if (!formaPagto) {
                return exibirAviso("Por favor, selecione a Forma de Pagamento!");
            }
            // Editando, "Modo de Retirada (Global)" fica escondido (quem manda
            // é "Status do Pedido") — não faz sentido exigir valor nele aqui.
            if (pedidoEmEdicaoId === null && !tipoGlobalRetirada) {
                return exibirAviso("Por favor, selecione o Modo de Retirada (Global)!");
            }
            if (!tipoAtendimento) {
                return exibirAviso("Por favor, selecione o Tipo de Retirada (Levar ou Local)!");
            }

            const total = carrinho.reduce((acc, item) => acc + (item.preco * item.qtd) - (item.desconto || 0) + (item.acrescimo || 0), 0);

            let detalhesMisto = null;

            if (formaPagto === 'Dinheiro') {
                const recVal = parseFloat(document.getElementById('valor-recebido-dinheiro').value);
                if (isNaN(recVal) || recVal < total) {
                    return exibirAviso("Para pagamento em Dinheiro, informe o Valor Recebido igual ou maior ao Total.");
                }
            } else if (formaPagto === 'Bonificação') {
                const obsBono = document.getElementById('obs-bonificacao').value.trim();
                if (!obsBono) {
                    return exibirAviso("Para Bonificação, é obrigatório preencher a Observação/Motivo!");
                }
                formaPagto = `Bonificação (${obsBono})`;
            } else if (formaPagto === 'Misto') {
                const f1 = document.getElementById('misto-forma-1').value;
                const v1 = parseFloat(document.getElementById('misto-valor-1').value) || 0;
                const f2 = document.getElementById('misto-forma-2').value;
                const v2 = parseFloat(document.getElementById('misto-valor-2').value) || 0;

                if (v1 <= 0 || v2 <= 0 || (v1 + v2).toFixed(2) !== total.toFixed(2)) {
                    return exibirAviso(`A soma das duas formas de pagamento (R$ ${(v1 + v2).toFixed(2)}) deve ser exatamente igual ao Total do Pedido (R$ ${total.toFixed(2)})!`);
                }

                if (f1 === f2) {
                    return exibirAviso("Escolha duas formas de pagamento diferentes!");
                }

                if (f1 === 'Dinheiro' || f2 === 'Dinheiro') {
                    const valDinheiroDevido = f1 === 'Dinheiro' ? v1 : v2;
                    const recVal = parseFloat(document.getElementById('valor-recebido-dinheiro').value);
                    if (isNaN(recVal) || recVal < valDinheiroDevido) {
                        return exibirAviso(`Informe o Valor Recebido em Dinheiro igual ou maior a R$ ${valDinheiroDevido.toFixed(2)}.`);
                    }
                }

                formaPagto = `${f1} (R$ ${v1.toFixed(2)}) + ${f2} (R$ ${v2.toFixed(2)})`;
                detalhesMisto = [
                    { forma: f1, valor: v1 },
                    { forma: f2, valor: v2 }
                ];
            }

            const dataObjeto = new Date();
            const dataAtual = dataObjeto.toLocaleDateString('pt-BR');
            const horaAtual = dataObjeto.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            
            let statusPainelCalculado = 'nenhum';
            let horaEntradaCozinhaCalculada = null;
            let horaEntregaCalculada = null;
            let caixaIdPedido = meuCaixaAtual.id;
            // Marca se esse pedido já passou por "Pedidos em Pausa"
            // (moverParaAgora) — usado só pra mostrar um ícone no card do
            // Balcão, avisando quem está lá que não é um pedido novato.
            // Preservado na edição igual chaveUnica/caixaId (não recalcula
            // do zero, senão editar um pedido que veio de pausa "esqueceria"
            // isso).
            let veioDePausaPedido = false;
            // Identidade estável do pedido, gerada 1x na criação e preservada
            // em toda edição — não é o número que aparece no recibo (esse
            // pode precisar mudar se colidir com outro dispositivo, ver
            // mesclarPedidosPorId), é o que permite reconhecer "esse pedido
            // aqui é o mesmo que aquele lá" mesmo se o número mudar.
            let chaveUnicaPedido = `${PDV_CLIENT_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            // Marca se o pedido NASCEU com o app offline — decidido 1x na
            // criação e preservado em toda edição depois (mesmo padrão de
            // chaveUnica/veioDePausa). Ver rotuloPedido(): pedido criado
            // online nunca ganha esses campos, então continua mostrando só o
            // id puro, igual sempre foi.
            let numeroProvisorioPedido = false;
            let letraDispositivoPedido = null;

            if (pedidoEmEdicaoId !== null) {
                statusPainelCalculado = document.getElementById('status-pedido-edicao').value;
                const pedidoExistente = pedidosGerais.find(p => p.id === pedidoEmEdicaoId);
                if (pedidoExistente) {
                    horaEntradaCozinhaCalculada = pedidoExistente.horaEntradaCozinha;
                    horaEntregaCalculada = statusPainelCalculado === 'entregue' ? (pedidoExistente.horaEntrega || horaAtual) : pedidoExistente.horaEntrega;
                    // Editar um pedido não muda de quem é o caixa dono dele —
                    // qualquer usuário com acesso a caixa pode alterar o pedido
                    // de outro operador sem "roubar" a venda pro próprio caixa.
                    caixaIdPedido = pedidoExistente.caixaId || meuCaixaAtual.id;
                    chaveUnicaPedido = pedidoExistente.chaveUnica || chaveUnicaPedido;
                    veioDePausaPedido = !!pedidoExistente.veioDePausa;
                    numeroProvisorioPedido = !!pedidoExistente.numeroProvisorio;
                    letraDispositivoPedido = pedidoExistente.letraDispositivo || null;
                }
            } else {
                const itensAgora = carrinho.filter(i => i.fase === 'agora');
                const vaiParaCozinha = tipoGlobalRetirada !== 'agora_sem_cozinha' && itensAgora.some(i => i.cozinha || (i.isCombo && i.itensComboEscolhidos && i.itensComboEscolhidos.some(sub=>sub.cozinha)));
                // Se TODOS os itens "agora" do carrinho são de entrega
                // instantânea (rifa, ingresso — nunca vão pra Cozinha nem
                // ficam esperando no Balcão), o pedido já nasce entregue,
                // independente do Modo de Retirada escolhido.
                const todosInstantaneos = itensAgora.length > 0 && itensAgora.every(i => !i.isCombo && i.entregaInstantanea);
                statusPainelCalculado = vaiParaCozinha ? 'preparando' : ((tipoGlobalRetirada === 'agora_sem_cozinha' || todosInstantaneos) ? 'entregue' : 'nenhum');
                horaEntradaCozinhaCalculada = vaiParaCozinha ? horaAtual : null;
                horaEntregaCalculada = (!vaiParaCozinha && (tipoGlobalRetirada === 'agora_sem_cozinha' || todosInstantaneos)) ? horaAtual : null;
                if (!supabaseDisponivel) {
                    numeroProvisorioPedido = true;
                    letraDispositivoPedido = obterLetraDispositivo();
                }
            }

            // Pedido bonificado não cobrou nada de verdade — o valor dos itens
            // e o total ficam zerados no pedido salvo (recibo, histórico,
            // "Ver Detalhes" etc mostram R$ 0,00), só marcado como
            // Bonificação. Já é excluído de todo faturamento/relatório
            // financeiro em outros lugares do app; isso só deixa o próprio
            // registro do pedido coerente com isso.
            const ehBonificacao = formaPagto.startsWith('Bonificação');
            const itensSnapshot = JSON.parse(JSON.stringify(carrinho)).map(item => {
                // Reabrir um pedido já finalizado: editar e mudar "Status do
                // Pedido" de volta pra "Na Cozinha"/"Balcão Pendente" não
                // adiantava nada sozinho — os itens continuavam com
                // fase:'entregue' (herdada do pedido original), e tanto
                // Cozinha quanto Balcão só mostram item com fase !== 'entregue'
                // (ver atualizarTelas). Resultado: o pedido sumia de tudo,
                // mesmo com o status dizendo "preparando"/"nenhum". Se o novo
                // status não é mais "entregue", devolve pra "agora" os itens
                // que ainda estavam marcados como entregues.
                if (pedidoEmEdicaoId !== null && statusPainelCalculado !== 'entregue' && item.fase === 'entregue') {
                    item.fase = 'agora';
                }
                if (!ehBonificacao) return item;
                item.preco = 0;
                item.desconto = undefined;
                item.acrescimo = undefined;
                return item;
            });

            const novoPedido = {
                id: pedidoEmEdicaoId !== null ? pedidoEmEdicaoId : contadorPedidos++,
                chaveUnica: chaveUnicaPedido,
                cliente: cliente, pagamento: formaPagto, tipoAtendimento: tipoAtendimento,
                total: ehBonificacao ? 0 : total, data: dataAtual, hora: horaAtual,
                detalhesMisto: detalhesMisto,
                horaEntradaCozinha: horaEntradaCozinhaCalculada,
                horaEntrega: horaEntregaCalculada,
                statusPainel: statusPainelCalculado,
                caixaId: caixaIdPedido,
                veioDePausa: veioDePausaPedido,
                numeroProvisorio: numeroProvisorioPedido,
                letraDispositivo: letraDispositivoPedido,
                itens: itensSnapshot
            };

            let catalogoAlteradoPorEstoque = false;

            if (pedidoEmEdicaoId !== null) {
                pedidosGerais.find(p => p.id === pedidoEmEdicaoId).itens.forEach(item => {
                    if(item.isCombo) {
                        item.itensComboEscolhidos.forEach(sub => {
                            const est = estoquePorProduto[sub.idProduto];
                            if(est !== undefined && est !== null) {
                                const novoEst = est + 1;
                                estoquePorProduto[sub.idProduto] = novoEst;
                                const subProd = produtosDB.find(p => p.id === sub.idProduto);
                                if (sincronizarAtivoPorEstoque(subProd, novoEst)) catalogoAlteradoPorEstoque = true;
                            }
                        });
                    } else {
                        const est = estoquePorProduto[item.idProduto];
                        if(est !== undefined && est !== null) {
                            const novoEst = est + 1;
                            estoquePorProduto[item.idProduto] = novoEst;
                            const prod = produtosDB.find(p => p.id === item.idProduto);
                            if (sincronizarAtivoPorEstoque(prod, novoEst)) catalogoAlteradoPorEstoque = true;
                        }
                    }
                });
                pedidosGerais = pedidosGerais.filter(p => p.id !== pedidoEmEdicaoId);
            }

            carrinho.forEach(item => {
                if(item.isCombo) {
                    item.itensComboEscolhidos.forEach(sub => {
                        const est = estoquePorProduto[sub.idProduto];
                        if(est !== undefined && est !== null) {
                            const novoEst = est - 1;
                            estoquePorProduto[sub.idProduto] = novoEst;
                            const subProd = produtosDB.find(p => p.id === sub.idProduto);
                            if (sincronizarAtivoPorEstoque(subProd, novoEst)) catalogoAlteradoPorEstoque = true;
                        }
                    });
                } else {
                    const est = estoquePorProduto[item.idProduto];
                    if(est !== undefined && est !== null) {
                        const novoEst = est - 1;
                        estoquePorProduto[item.idProduto] = novoEst;
                        const prod = produtosDB.find(p => p.id === item.idProduto);
                        if (sincronizarAtivoPorEstoque(prod, novoEst)) catalogoAlteradoPorEstoque = true;
                    }
                }
            });

            pedidosGerais.push(novoPedido);
            if (catalogoAlteradoPorEstoque) salvarCatalogo();
            salvarNoBancoLocal();

            gerarHTMLImpressao(novoPedido);
            dispararImpressao();

            if (pedidoEmEdicaoId === null && configPadroes.separarBalcaoDoces && !pedidoTemAlgoDeCozinha(novoPedido.itens)) {
                exibirAviso(`Pedido #${rotuloPedido(novoPedido)} não tem nada de cozinha — foi direcionado pro Balcão 02 (Doces).`, '🍬 Balcão 02 (Doces)');
            }

            limparCarrinho();
            renderizarMenu(categoriaFiltroAtual); 
            renderizarTabelaProdutos(); 
            atualizarTelas();
        }

        // Retorna o HTML do recibo (sem escrever em lugar nenhum) — usado
        // tanto pra imprimir 1 pedido (gerarHTMLImpressao) quanto vários de
        // uma vez (imprimirPedidosEmPausa).
        function montarHTMLReciboPedido(pedido, quebrarPagina = false) {
            // "Agora" = qualquer coisa que não seja 'mais_tarde' NEM 'entregue'
            // (cobre pedidos antigos com item.fase = 'agora_sem_cozinha' salvo
            // por engano — bug já corrigido em mudarTipoRetiradaGlobal — sem
            // deixar esses itens sumirem do recibo). Excluir 'entregue' é o que
            // evita reimprimir junto, como "a retirar agora", itens que já
            // foram entregues numa retirada parcial anterior.
            const iEntregue = pedido.itens.filter(i => i.fase === 'entregue');
            const iAgora = pedido.itens.filter(i => i.fase !== 'mais_tarde' && i.fase !== 'entregue');
            const iDepois = pedido.itens.filter(i => i.fase === 'mais_tarde');

            const htmlItem = (i) => {
                let det = '';
                if(i.isCombo) { det = `<div style="font-size:12px; font-weight:bold; padding-left:5px; color:#000;">↳ ${i.itensComboEscolhidos.map(sub=> `1x ${sub.nome}`).join('<br>↳ ')}</div>`; }
                let obs = i.obs ? `<div style="font-size:12px; font-weight:bold;">Observação: ${i.obs}</div>` : '';
                let desconto = i.desconto ? `<div style="font-size:12px; font-weight:bold;">Desconto: -R$ ${i.desconto.toFixed(2)}</div>` : '';
                let acrescimo = i.acrescimo ? `<div style="font-size:12px; font-weight:bold;">Acréscimo: +R$ ${i.acrescimo.toFixed(2)}</div>` : '';
                return `<div style="margin-top:5px;"><div class="print-row"><span class="print-bold">${i.qtd}x ${i.nome}</span><span class="print-bold">R$ ${(i.preco * i.qtd).toFixed(2)}</span></div>${det}${desconto}${acrescimo}${obs}</div>`;
            };

            return `
                <div ${quebrarPagina ? 'class="print-page-break"' : ''}>
                <div class="print-center print-bold" style="font-size: 16px;">SANTUÁRIO SANTA RITA</div>
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="font-size: 42px; margin: 5px 0;">#${rotuloPedido(pedido)}</div>
                <div class="print-center print-bold" style="font-size: 26px; margin-bottom: 5px; text-transform: uppercase;">${pedido.cliente}</div>
                <div class="print-center print-bold" style="font-size: 14px; margin-bottom: 10px;">[ ${pedido.tipoAtendimento} ]</div>
                <div class="print-center print-bold">${pedido.data} - ${pedido.hora}</div>
                <div class="print-divider"></div>
                ${iAgora.length ? `<div class="print-center print-bold" style="margin-bottom:5px;">(RETIRAR AGORA)</div>` + iAgora.map(htmlItem).join('') : ''}
                ${iDepois.length ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">[ RETIRAR DEPOIS ]</div>` + iDepois.map(htmlItem).join('') : ''}
                ${iEntregue.length ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px; opacity:0.7;">(JÁ RETIRADO ANTES)</div>` + iEntregue.map(htmlItem).join('') : ''}
                <div class="print-divider"></div>

                <div class="print-pagto-box">
                    PAGAMENTO: ${pedido.pagamento}
                </div>

                <div class="print-row print-bold" style="font-size: 16px; margin-top:6px;"><span>TOTAL:</span><span>R$ ${pedido.total.toFixed(2)}</span></div>
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-top: 15px; font-size: 12px; line-height: 1.3;">
                    Muito obrigado pela sua ajuda! Que Santa Rita interceda e derrame muitas bênçãos sobre a sua vida e a de sua família. 🙏
                </div>
                </div>
            `;
        }

        function gerarHTMLImpressao(pedido) {
            document.getElementById('area-impressao').innerHTML = montarHTMLReciboPedido(pedido);
        }

        // "👁️ Ver Pedido Completo" — mesmo template do recibo, mas mostrado
        // na tela dentro de um modal (sem imprimir nem gerar arquivo). As
        // classes .print-* só têm estilo dentro de @media print, por isso
        // aplica o mesmo CSS "na mão" que o baixarPDFRecibo usa.
        function verDetalhesPedido(id) {
            const pedido = pedidosGerais.find(p => p.id === id);
            if (!pedido) return;
            document.getElementById('corpo-detalhes-pedido').innerHTML = `
                <style>
                    .pdf-recibo { font-family: Arial, sans-serif; font-size: 14px; font-weight: bold; color: #111; }
                    .pdf-recibo .print-center { text-align: center; }
                    .pdf-recibo .print-bold { font-weight: 900; }
                    .pdf-recibo .print-divider { border-top: 2px dashed #999; margin: 8px 0; }
                    .pdf-recibo .print-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-weight: bold; }
                    .pdf-recibo .print-pagto-box { font-size: 16px; font-weight: 900; margin: 8px 0; text-transform: uppercase; background: #111; color: #fff; padding: 6px 2px; text-align: center; border-radius: 4px; }
                </style>
                <div class="pdf-recibo">${montarHTMLReciboPedido(pedido)}</div>
                ${pedido.statusPainel === 'cancelado' && pedido.motivoCancelamento ? `<div style="margin-top:10px; background:#fef2f2; border:1px solid #fca5a5; border-radius:6px; padding:8px; font-size:13px; color:#991b1b;"><b>Motivo do cancelamento:</b> ${pedido.motivoCancelamento}</div>` : ''}
            `;
            document.getElementById('modal-detalhes-pedido').style.display = 'flex';
        }

        function fecharModalDetalhesPedido() {
            document.getElementById('modal-detalhes-pedido').style.display = 'none';
        }

        // Botão "🖨️ Imprimir Todos" na tela de Pedidos em Pausa — imprime de
        // uma vez o recibo de cada pedido que ainda tem item parado (fase
        // "mais_tarde"), com quebra de página entre eles.
        function imprimirPedidosEmPausa() {
            const pausados = pedidosGerais.filter(p => p.statusPainel !== 'cancelado' && p.itens.some(i => i.fase === 'mais_tarde'));
            if (pausados.length === 0) return exibirAviso("Não há pedidos em pausa pra imprimir.");
            document.getElementById('area-impressao').innerHTML = pausados.map((p, i) => montarHTMLReciboPedido(p, i > 0)).join('');
            dispararImpressao();
        }

        // #area-impressao só ganha a aparência de recibo (largura 80mm,
        // fonte, divisórias) dentro de @media print — fora da impressão real
        // essas classes (.print-center etc.) não valem nada. Pra baixar como
        // PDF em vez de mandar pra impressora, clona o HTML do recibo pra
        // fora da tela com essas mesmas regras aplicadas "na mão" e usa o
        // html2pdf com página no tamanho real do conteúdo (papel de recibo
        // não pagina, é uma tira só).
        function baixarPDFRecibo(htmlConteudo, nomeArquivo) {
            if (typeof html2pdf !== 'function') return;
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'position:absolute; left:-9999px; top:0;';
            wrapper.innerHTML = `
                <style>
                    .pdf-recibo { width:80mm; padding:5mm; font-family:Arial, sans-serif; font-size:13px; font-weight:bold; color:black; background:white; }
                    .pdf-recibo .print-center { text-align:center; }
                    .pdf-recibo .print-bold { font-weight:900; }
                    .pdf-recibo .print-divider { border-top:2px dashed black; margin:8px 0; }
                    .pdf-recibo .print-row { display:flex; justify-content:space-between; margin-bottom:4px; font-weight:bold; }
                    .pdf-recibo .print-pagto-box { font-size:18px; font-weight:900; margin:8px 0; text-transform:uppercase; background:#000; color:#fff; padding:6px 2px; text-align:center; border:2px solid #000; }
                </style>
                <div class="pdf-recibo">${htmlConteudo}</div>
            `;
            document.body.appendChild(wrapper);
            const conteudo = wrapper.querySelector('.pdf-recibo');
            const alturaMM = Math.max(100, (conteudo.scrollHeight * 25.4 / 96) + 10);
            const limpar = () => document.body.contains(wrapper) && document.body.removeChild(wrapper);
            html2pdf().set({
                margin: 0,
                filename: nomeArquivo,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2 },
                jsPDF: { unit: 'mm', format: [80, alturaMM], orientation: 'portrait' }
            }).from(conteudo).save().then(limpar).catch(limpar);
        }

        function baixarPDFPedido(idPedido) {
            const pedido = pedidosGerais.find(p => p.id === idPedido);
            if (!pedido) return;
            baixarPDFRecibo(montarHTMLReciboPedido(pedido), `Pedido_${idPedido}.pdf`);
        }

        // O cálculo em si mora em barracas.js (calcularResumoPedidos), como uma
        // função pura, para poder ser reaproveitado pelo Dashboard Geral com os
        // dados de QUALQUER barraca — aqui só repassamos o estado ao vivo desta.
        function obterDadosRelatorioCaixa(caixaId = caixaRelatorioSelecionado) {
            let listaPedidos, dados;
            if (caixaId) {
                const caixa = caixasAbertos.find(c => c.id === caixaId && !c.fechado);
                listaPedidos = pedidosGerais.filter(p => p.caixaId === caixaId);
                dados = calcularResumoPedidos(listaPedidos, !!caixa, caixa ? caixa.valorFundoCaixa : 0);
            } else {
                // "Todos": soma de todos os caixas abertos agora nesta barraca.
                const caixasRealmenteAbertas = caixasAbertos.filter(c => !c.fechado);
                listaPedidos = pedidosGerais;
                const fundoTotal = caixasRealmenteAbertas.reduce((a, c) => a + c.valorFundoCaixa, 0);
                dados = calcularResumoPedidos(pedidosGerais, caixasRealmenteAbertas.length > 0, fundoTotal);
            }
            // Custo de produção + taxa de maquininha não fazem parte de
            // calcularResumoPedidos (js/barracas.js) porque dependem do
            // catálogo (produtosDB) e de configPadroes, que só existem aqui —
            // mescla em cima do resumo pra Dashboard e prints do caixa atual
            // ganharem "Lucro Real" de graça, sem duplicar cálculo.
            return { ...dados, ...calcularCustosOperacao(listaPedidos, dados) };
        }

        function imprimirRelatorioCaixaAtual() {
            const dados = obterDadosRelatorioCaixa();
            const caixaSelecionado = caixaRelatorioSelecionado ? caixasAbertos.find(c => c.id === caixaRelatorioSelecionado) : null;
            const fundoInicial = dados.totalGaveta - dados.fatDinheiro;
            let htmlProdsPrint = '';
            Object.entries(dados.resumoProdutosVendidos).sort((a, b) => b[1] - a[1]).forEach(([prod, qtd]) => {
                const linha = formatarLinhaProdutoVendido(prod, qtd, dados.valorProdutosVendidos);
                htmlProdsPrint += `<div class="print-row"><span>${prod}</span><span class="print-bold">${linha.qtdTxt}</span></div>`;
            });

            let htmlBonoPrint = '';
            if (dados.bonificacoesLista.length > 0) {
                htmlBonoPrint = dados.bonificacoesLista.map(b => {
                    const resumo = b.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ');
                    return `<div style="font-size:11px; margin-bottom:3px; font-weight:bold;"><b>#${rotuloPedido(b)} ${b.cliente}:</b> ${resumo} (${b.pagamento})</div>`;
                }).join('');
            }

            const dataHora = new Date().toLocaleString('pt-BR');

            const areaPrint = document.getElementById('area-impressao');
            areaPrint.innerHTML = `
                <div class="print-center print-bold" style="font-size: 16px;">SANTUÁRIO SANTA RITA</div>
                <div class="print-center print-bold" style="font-size: 13px; margin-top: 4px;">RELATÓRIO DO CAIXA ATUAL</div>
                <div class="print-center print-bold" style="font-size:10px; margin-bottom: 5px;">Emitido em: ${dataHora}</div>
                <div class="print-divider"></div>
                <div class="print-row"><span>Caixa:</span><span class="print-bold">${caixaSelecionado ? caixaSelecionado.usuarioNome : 'Todos os caixas'}</span></div>
                <div class="print-row"><span>Abertura:</span><span class="print-bold">${caixaSelecionado ? (caixaSelecionado.dataHoraAbertura || '-') : '-'}</span></div>
                <div class="print-divider"></div>
                
                <div class="print-center print-bold" style="font-size: 13px; margin-bottom:2px;">FATURAMENTO TOTAL VENDAS</div>
                <div class="print-center print-bold" style="font-size: 28px; margin-bottom:5px;">R$ ${dados.totalVendas.toFixed(2)}</div>
                
                <div class="print-divider"></div>
                <div class="print-row"><span>Fundo Inicial:</span><span class="print-bold">R$ ${fundoInicial.toFixed(2)}</span></div>
                <div class="print-row"><span>Qtd Vendas Pagas:</span><span class="print-bold">${dados.validosVendas.length}</span></div>
                <div class="print-row"><span>Qtd Bonificações:</span><span class="print-bold">${dados.qtdBonificacoes}</span></div>
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-bottom: 5px;">DETALHAMENTO FORMAS PAGTO</div>
                <div class="print-row"><span>💳 Cartão Débito:</span><span class="print-bold">R$ ${dados.fatDebito.toFixed(2)}</span></div>
                <div class="print-row"><span>💳 Cartão Crédito:</span><span class="print-bold">R$ ${dados.fatCredito.toFixed(2)}</span></div>
                <div class="print-row"><span>📱 Pix (Máquina):</span><span class="print-bold">R$ ${dados.fatPix.toFixed(2)}</span></div>
                <div class="print-row"><span>💵 Dinheiro Vendas:</span><span class="print-bold">R$ ${dados.fatDinheiro.toFixed(2)}</span></div>
                <div class="print-row"><span>📲 Pix Direto (Conta):</span><span class="print-bold">R$ ${dados.fatPixDireto.toFixed(2)}</span></div>
                <div class="print-divider"></div>
                <div class="print-row print-bold" style="font-size: 15px;"><span>TOTAL GAVETA:</span><span>R$ ${dados.totalGaveta.toFixed(2)}</span></div>
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-bottom:5px;">💰 CUSTO & LUCRO REAL (interno)</div>
                <div class="print-row"><span>Custo de Produção:</span><span class="print-bold">R$ ${dados.custoProducaoTotal.toFixed(2)}</span></div>
                <div class="print-row"><span>Custo de Taxas:</span><span class="print-bold">R$ ${dados.custoTaxas.toFixed(2)}</span></div>
                <div class="print-row print-bold" style="font-size: 15px;"><span>LUCRO REAL:</span><span>R$ ${dados.lucroReal.toFixed(2)}</span></div>
                ${dados.itensSemCustoProducao > 0 ? `<div style="font-size:9px; margin-top:3px;">⚠️ ${dados.itensSemCustoProducao} item(ns) sem ficha técnica — lucro subestimado.</div>` : ''}
                ${htmlProdsPrint ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">PRODUTOS VENDIDOS</div>${htmlProdsPrint}` : ''}
                ${htmlBonoPrint ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">🎁 BONIFICAÇÕES / CORTESIAS (${dados.qtdBonificacoes} ped)</div>${htmlBonoPrint}` : ''}
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-top: 10px; font-size: 10px;">
                    Documento de Conferência Parcial de Caixa
                </div>
            `;

            dispararImpressao();
        }

        function gerarPDFCaixaAtual() {
            const dados = obterDadosRelatorioCaixa();
            const caixaSelecionado = caixaRelatorioSelecionado ? caixasAbertos.find(c => c.id === caixaRelatorioSelecionado) : null;
            const fundoInicial = dados.totalGaveta - dados.fatDinheiro;
            const dataHora = new Date().toLocaleString('pt-BR');

            let htmlTabelaProdutos = '';
            Object.entries(dados.resumoProdutosVendidos).sort((a, b) => b[1] - a[1]).forEach(([prod, qtd]) => {
                const linha = formatarLinhaProdutoVendido(prod, qtd, dados.valorProdutosVendidos);
                htmlTabelaProdutos += `
                    <tr>
                        <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${prod}</td>
                        <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 800; color: #2563eb;">${linha.qtdTxt}</td>
                    </tr>
                `;
            });

            let htmlTabelaBonificacoes = '';
            if (dados.bonificacoesLista.length > 0) {
                htmlTabelaBonificacoes = dados.bonificacoesLista.map(b => {
                    const resumoItens = b.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ');
                    return `
                        <tr>
                            <td style="padding: 8px; border-bottom: 1px solid #fee2e2; font-weight: bold; color: #991b1b;">#${rotuloPedido(b)} ${b.cliente}</td>
                            <td style="padding: 8px; border-bottom: 1px solid #fee2e2; color: #7f1d1d;">${b.pagamento}</td>
                            <td style="padding: 8px; border-bottom: 1px solid #fee2e2; font-weight: 600;">${resumoItens}</td>
                        </tr>
                    `;
                }).join('');
            }

            const divContainerPDF = document.createElement('div');
            divContainerPDF.style.padding = '25px';
            divContainerPDF.style.fontFamily = "'Segoe UI', Arial, sans-serif";
            divContainerPDF.style.color = '#1f2937';
            divContainerPDF.style.background = '#ffffff';

            divContainerPDF.innerHTML = `
                <div style="border-bottom: 3px solid #2563eb; padding-bottom: 15px; margin-bottom: 20px; text-align: center;">
                    <h1 style="margin: 0; color: #1e3a8a; font-size: 24px; text-transform: uppercase;">Santuário Santa Rita</h1>
                    <h2 style="margin: 5px 0 0 0; color: #4b5563; font-size: 16px; border: none; padding: 0;">RELATÓRIO DE FECHAMENTO / CONFERÊNCIA DE CAIXA</h2>
                    <p style="margin: 5px 0 0 0; font-size: 12px; color: #6b7280;">Emitido em: ${dataHora} | Caixa: <b>${caixaSelecionado ? caixaSelecionado.usuarioNome : 'Todos os caixas'}</b> | Abertura: <b>${caixaSelecionado ? (caixaSelecionado.dataHoraAbertura || '-') : '-'}</b></p>
                </div>

                <div style="display: flex; gap: 15px; margin-bottom: 25px;">
                    <div style="flex: 1; background: #f0fdf4; border: 2px solid #16a34a; border-radius: 8px; padding: 15px; text-align: center;">
                        <span style="font-size: 12px; font-weight: bold; color: #166534; text-transform: uppercase; display: block;">Faturamento Total Vendas</span>
                        <span style="font-size: 26px; font-weight: 900; color: #15803d; display: block; margin-top: 5px;">R$ ${dados.totalVendas.toFixed(2)}</span>
                    </div>
                    <div style="flex: 1; background: #e0f2fe; border: 2px solid #0284c7; border-radius: 8px; padding: 15px; text-align: center;">
                        <span style="font-size: 12px; font-weight: bold; color: #0369a1; text-transform: uppercase; display: block;">Total em Gaveta (Dinheiro + Fundo)</span>
                        <span style="font-size: 26px; font-weight: 900; color: #0284c7; display: block; margin-top: 5px;">R$ ${dados.totalGaveta.toFixed(2)}</span>
                    </div>
                    <div style="flex: 1; background: #f0fdf4; border: 2px solid #16a34a; border-radius: 8px; padding: 15px; text-align: center;">
                        <span style="font-size: 12px; font-weight: bold; color: #166534; text-transform: uppercase; display: block;">Lucro Real (interno)</span>
                        <span style="font-size: 26px; font-weight: 900; color: #15803d; display: block; margin-top: 5px;">R$ ${dados.lucroReal.toFixed(2)}</span>
                    </div>
                </div>

                <div style="margin-bottom: 25px;">
                    <h3 style="font-size: 14px; text-transform: uppercase; border-bottom: 2px solid #e5e7eb; padding-bottom: 5px; color: #111827; margin-top: 0;">Custo de Produção & Taxas (interno — nunca aparece pro cliente)</h3>
                    <div style="display: flex; justify-content: space-between; background: #fffbeb; padding: 12px; border-radius: 6px; font-size: 13px; font-weight: bold;">
                        <span>Custo de Produção: R$ ${dados.custoProducaoTotal.toFixed(2)}</span>
                        <span>Custo de Taxas: R$ ${dados.custoTaxas.toFixed(2)}</span>
                        ${dados.itensSemCustoProducao > 0 ? `<span style="color:#b45309;">⚠️ ${dados.itensSemCustoProducao} item(ns) sem custo</span>` : ''}
                    </div>
                </div>

                <div style="margin-bottom: 25px;">
                    <h3 style="font-size: 14px; text-transform: uppercase; border-bottom: 2px solid #e5e7eb; padding-bottom: 5px; color: #111827; margin-top: 0;">Resumo do Atendimento</h3>
                    <div style="display: flex; justify-content: space-between; background: #f8fafc; padding: 12px; border-radius: 6px; font-size: 13px; font-weight: bold;">
                        <span>Fundo Inicial de Caixa: R$ ${fundoInicial.toFixed(2)}</span>
                        <span>Qtd. Vendas Pagas: ${dados.validosVendas.length}</span>
                        <span>Qtd. Bonificações: ${dados.qtdBonificacoes}</span>
                    </div>
                </div>

                <div style="margin-bottom: 25px;">
                    <h3 style="font-size: 14px; text-transform: uppercase; border-bottom: 2px solid #e5e7eb; padding-bottom: 5px; color: #111827; margin-top: 0;">Detalhamento por Forma de Pagamento Entradas</h3>
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                        <thead>
                            <tr style="background: #f1f5f9; text-align: left;">
                                <th style="padding: 8px; border-bottom: 2px solid #cbd5e1;">Forma de Pagamento</th>
                                <th style="padding: 8px; border-bottom: 2px solid #cbd5e1; text-align: right;">Valor Apurado (R$)</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">💳 Cartão Débito</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: bold;">R$ ${dados.fatDebito.toFixed(2)}</td></tr>
                            <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">💳 Cartão Crédito</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: bold;">R$ ${dados.fatCredito.toFixed(2)}</td></tr>
                            <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">📱 Pix (Máquina)</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: bold;">R$ ${dados.fatPix.toFixed(2)}</td></tr>
                            <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">💵 Dinheiro (Vendas)</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: bold;">R$ ${dados.fatDinheiro.toFixed(2)}</td></tr>
                            <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">📲 Pix Direto (Conta)</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: bold;">R$ ${dados.fatPixDireto.toFixed(2)}</td></tr>
                        </tbody>
                    </table>
                </div>

                <div style="margin-bottom: 25px;">
                    <h3 style="font-size: 14px; text-transform: uppercase; border-bottom: 2px solid #e5e7eb; padding-bottom: 5px; color: #111827; margin-top: 0;">Quantidade de Produtos / Combos Vendidos</h3>
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                        <thead>
                            <tr style="background: #f1f5f9; text-align: left;">
                                <th style="padding: 8px; border-bottom: 2px solid #cbd5e1;">Item / Produto</th>
                                <th style="padding: 8px; border-bottom: 2px solid #cbd5e1; text-align: right;">Quantidade Vendida</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${htmlTabelaProdutos || '<tr><td colspan="2" style="padding:8px; text-align:center; color:gray;">Nenhum item vendido.</td></tr>'}
                        </tbody>
                    </table>
                </div>

                <div>
                    <h3 style="font-size: 14px; text-transform: uppercase; border-bottom: 2px solid #e5e7eb; padding-bottom: 5px; color: #dc2626; margin-top: 0;">🎁 Relatório de Bonificações / Cortesias (${dados.qtdBonificacoes} Pedidos)</h3>
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead>
                            <tr style="background: #fef2f2; text-align: left;">
                                <th style="padding: 8px; border-bottom: 2px solid #fca5a5;">Pedido / Cliente</th>
                                <th style="padding: 8px; border-bottom: 2px solid #fca5a5;">Motivo</th>
                                <th style="padding: 8px; border-bottom: 2px solid #fca5a5;">Itens Entregues</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${htmlTabelaBonificacoes || '<tr><td colspan="3" style="padding:8px; text-align:center; color:gray;">Nenhuma bonificação registrada.</td></tr>'}
                        </tbody>
                    </table>
                </div>

                <div style="margin-top: 30px; border-top: 1px solid #ccc; padding-top: 10px; text-align: center; font-size: 11px; color: #6b7280; font-style: italic;">
                    Documento Gerado Automático pelo PDV Pro Santuário Santa Rita
                </div>
            `;

            const opt = {
                margin: 10,
                filename: `Relatorio_Caixa_A4_${new Date().toISOString().slice(0,10)}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2 },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            html2pdf().set(opt).from(divContainerPDF).save();
        }
        
        function reimprimirPedido(idPedido) {
            const pedido = pedidosGerais.find(p => p.id === idPedido);
            if (pedido) { gerarHTMLImpressao(pedido); dispararImpressao(); }
        }

        function moverParaAgora(id) { 
            const p = pedidosGerais.find(x => x.id === id); 
            const horaAtual = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            
            p.itens.forEach(i => { if(i.fase==='mais_tarde') i.fase='agora'; });
            p.statusPainel = 'preparando';
            p.veioDePausa = true;
            if (!p.horaEntradaCozinha) p.horaEntradaCozinha = horaAtual;

            salvarNoBancoLocal();
            atualizarTelas(); 
        }

        // Fala "Pedido número X, Fulano" em voz alta (Web Speech API). O beep
        // toca primeiro pra chamar atenção; a fala vem logo depois, sem
        // sobrepor. Se o navegador/dispositivo não suportar (raro, mas
        // acontece em alguns tablets), falha em silêncio — o beep já cumpriu
        // o papel de avisar.
        //
        // tocarBeep() tem duas notas: a segunda só termina de tocar/apagar
        // em ~1.5s depois de disparada — por isso o atraso da fala precisa
        // ser maior que isso, senão a voz começa em cima do fim do bipe.
        function falarChamadaPedido(numeroPedido, nomeCliente) {
            try {
                if (!('speechSynthesis' in window)) return;
                const fator = fatorVolumeAnuncio();
                const texto = `Pedido número ${numeroPedido}, ${nomeCliente}`;
                // O navegador só aceita volume entre 0 e 1 (100%) pra fala
                // sintetizada — não tem como aumentar isso de verdade (só o
                // bipe, que é gerado por osciladores, pode ser amplificado).
                // Como compensação, quando o slider passa de 100% a frase
                // repete (até 3x) — não aumenta o volume, mas aumenta a
                // chance de ser percebida no meio do barulho do evento.
                const repeticoes = Math.min(3, Math.max(1, Math.round(fator)));
                speechSynthesis.cancel();
                for (let i = 0; i < repeticoes; i++) {
                    const utter = new SpeechSynthesisUtterance(texto);
                    utter.lang = 'pt-BR';
                    utter.rate = 0.95;
                    utter.volume = Math.min(fator, 1);
                    speechSynthesis.speak(utter);
                }
            } catch (e) {
                console.log('Fala por voz não suportada neste dispositivo:', e);
            }
        }

        // Liga/desliga o anúncio por voz (nome + número falado) neste
        // dispositivo — é uma preferência de hardware físico (a caixinha de
        // som fica numa máquina específica do evento), por isso fica só no
        // localStorage, não sincroniza pelo Supabase. O beep sempre toca,
        // independente disso.
        const CHAVE_VOZ_ANUNCIO = 'pdv_voz_anuncio_ativa';
        function vozAnuncioEstaAtiva() {
            return localStorage.getItem(CHAVE_VOZ_ANUNCIO) !== '0';
        }
        function alternarVozAnuncio() {
            localStorage.setItem(CHAVE_VOZ_ANUNCIO, vozAnuncioEstaAtiva() ? '0' : '1');
            atualizarBotoesVozAnuncio();
        }
        // Zoom por tela (Pedido/Cozinha/Balcão) — preferência do dispositivo
        // físico (uma máquina pode precisar de letras maiores que outra),
        // por isso fica no localStorage, não sincroniza pelo Supabase.
        function chaveZoomTela(idConteudo) { return `pdv_zoom_${idConteudo}`; }

        function aplicarZoomSalvo(idConteudo) {
            const el = document.getElementById(idConteudo);
            const txt = document.getElementById(`txt-zoom-${idConteudo}`);
            if (!el) return;
            const zoom = parseInt(localStorage.getItem(chaveZoomTela(idConteudo))) || 100;
            el.style.zoom = `${zoom}%`;
            if (txt) txt.innerText = `${zoom}%`;
        }

        function ajustarZoomTela(idConteudo, delta) {
            const atual = parseInt(localStorage.getItem(chaveZoomTela(idConteudo))) || 100;
            const novo = Math.min(150, Math.max(50, atual + delta));
            localStorage.setItem(chaveZoomTela(idConteudo), novo);
            aplicarZoomSalvo(idConteudo);
        }

        function aplicarTodosZoomsSalvos() {
            ['conteudo-zoom-pedido', 'conteudo-zoom-preparo', 'conteudo-zoom-entrega', 'conteudo-zoom-entrega-doces'].forEach(aplicarZoomSalvo);
        }

        function atualizarBotoesVozAnuncio() {
            const ativa = vozAnuncioEstaAtiva();
            document.querySelectorAll('.btn-toggle-voz').forEach(btn => {
                btn.innerText = ativa ? '🗣️ Voz Ligada' : '🔇 Só Bip';
                btn.classList.toggle('btn-success', ativa);
                btn.classList.toggle('btn-warning', !ativa);
            });

            const valorSalvo = parseInt(localStorage.getItem(CHAVE_VOLUME_ANUNCIO));
            const volume = isNaN(valorSalvo) ? 100 : valorSalvo;
            document.querySelectorAll('.slider-volume-anuncio').forEach(s => { s.value = volume; });
            document.querySelectorAll('.txt-volume-anuncio').forEach(label => { label.innerText = `${volume}%`; });
        }

        function chamarNoPainel(id) {
            const p = pedidosGerais.find(x => x.id === id);
            p.statusPainel = 'pronto';
            dispararAvisoSonoro(rotuloPedido(p), p.cliente);
            salvarNoBancoLocal();
            atualizarTelas();
        }
        
        function finalizarEntrega(id) { 
            const p = pedidosGerais.find(x => x.id === id);
            const horaAtual = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            
            p.itens.forEach(i => { if(i.fase !== 'mais_tarde') i.fase = 'entregue'; });
            p.statusPainel = 'entregue';
            p.horaEntrega = horaAtual;

            salvarNoBancoLocal();
            atualizarTelas(); 
        }

        // Devolve o estoque de todos os itens do pedido e marca como
        // cancelado — núcleo reaproveitado tanto por cancelarPedido (1
        // pedido, com prompt de motivo) quanto pelo forçar-fechamento de
        // caixa (vários pedidos de uma vez, 1 motivo só pro lote inteiro).
        // Não salva nem re-renderiza sozinho — quem chama decide quando
        // fazer isso (1x só, depois do lote inteiro processado).
        function cancelarPedidoInterno(p, motivo) {
            let catalogoAlteradoPorEstoque = false;
            p.itens.forEach(item => {
                if(item.isCombo) {
                    item.itensComboEscolhidos.forEach(sub => {
                        const est = estoquePorProduto[sub.idProduto];
                        if(est !== undefined && est !== null) {
                            const novoEst = est + 1;
                            estoquePorProduto[sub.idProduto] = novoEst;
                            const subProd = produtosDB.find(x => x.id === sub.idProduto);
                            if (sincronizarAtivoPorEstoque(subProd, novoEst)) catalogoAlteradoPorEstoque = true;
                        }
                    });
                } else {
                    const est = estoquePorProduto[item.idProduto];
                    if(est !== undefined && est !== null) {
                        const novoEst = est + 1;
                        estoquePorProduto[item.idProduto] = novoEst;
                        const prod = produtosDB.find(x => x.id === item.idProduto);
                        if (sincronizarAtivoPorEstoque(prod, novoEst)) catalogoAlteradoPorEstoque = true;
                    }
                }
            });
            p.statusPainel = 'cancelado';
            p.motivoCancelamento = motivo;
            return catalogoAlteradoPorEstoque;
        }

        async function cancelarPedido(id) {
            if (!usuarioAtual || !usuarioAtual.isMaster) return exibirAviso("Só o usuário Master pode cancelar/apagar pedidos.");

            const p = pedidosGerais.find(x => x.id === id);

            // Pede o motivo em vez de só confirmar sim/não — ajuda a entender
            // depois se o cancelamento foi erro de operador, desistência de
            // cliente, etc. O próprio preenchimento já serve como confirmação,
            // por isso não pede mais um segundo "tem certeza?" separado.
            const motivo = await pedirTexto(`Por que está cancelando o Pedido #${rotuloPedido(p)}? (obrigatório)`, { titulo: '🗑️ Cancelar Pedido' });
            if (motivo === null) return;
            if (!motivo.trim()) return exibirAviso("É obrigatório informar o motivo do cancelamento.");

            if (p && p.statusPainel !== 'cancelado') {
                const catalogoAlterado = cancelarPedidoInterno(p, motivo.trim());
                if (catalogoAlterado) salvarCatalogo();
                salvarNoBancoLocal();
                renderizarMenu(categoriaFiltroAtual);
                renderizarTabelaProdutos();
                atualizarTelas();
                atualizarFiltrosGestao();
                exibirAviso(`Pedido #${rotuloPedido(p)} cancelado com sucesso e estoque devolvido!`);
            }
        }

        // Usado pra decidir se um pedido vai pro Balcão 01 ou pro Balcão 02
        // (Doces) quando configPadroes.separarBalcaoDoces está ligado —
        // "tem algo de cozinha" olha tanto item simples quanto sub-item
        // escolhido dentro de combo.
        function pedidoTemAlgoDeCozinha(itens) {
            return itens.some(item => item.isCombo
                ? (item.itensComboEscolhidos || []).some(sub => sub.cozinha)
                : item.cozinha);
        }

        // Média de (horaEntrega - hora) em minutos, só dos pedidos que têm
        // as duas horas ("HH:MM") — pedidos antigos sem horaEntrega
        // preenchida ou ainda não entregues são ignorados, não contam como
        // zero. Retorna "--" sem dado nenhum pra não parecer 0min de
        // entrega quando na verdade é falta de informação.
        function formatarTempoMedioEntrega(pedidosEntregues) {
            const paraMinutos = (hhmm) => {
                if (!hhmm || typeof hhmm !== 'string' || !hhmm.includes(':')) return null;
                const [h, m] = hhmm.split(':').map(Number);
                if (Number.isNaN(h) || Number.isNaN(m)) return null;
                return h * 60 + m;
            };
            const duracoes = [];
            pedidosEntregues.forEach(p => {
                const inicio = paraMinutos(p.hora);
                const fim = paraMinutos(p.horaEntrega);
                if (inicio === null || fim === null) return;
                let duracao = fim - inicio;
                if (duracao < 0) duracao += 24 * 60; // virada de dia (raro, mas evita média negativa)
                duracoes.push(duracao);
            });
            if (duracoes.length === 0) return '--';
            const mediaMin = Math.round(duracoes.reduce((a, b) => a + b, 0) / duracoes.length);
            return mediaMin >= 60 ? `${Math.floor(mediaMin / 60)}h ${mediaMin % 60}min` : `${mediaMin}min`;
        }

        // Único critério pra "tem item de verdade na cozinha agora": fase
        function atualizarTelas() {
            let htmlCozinha = '', htmlBalcao = '', htmlBalcaoDoces = '', htmlAgenda = '', htmlPrepTV = '';
            let countCoz = 0, countBalc = 0, countBalcDoces = 0, countAgend = 0;
            let prontos = [], entregues = [];

            // MAPAS PARA AS SIDEBARS EM FORMATO DE TABELA
            let resumoBalcaoCozinha = {};
            let resumoBalcaoFicha = {};
            let resumoProducaoCozinha = {};
            // Só usado quando configPadroes.separarBalcaoDoces está ligado —
            // ver bloco do Balcão logo abaixo.
            let resumoBalcaoDoces = {};

            pedidosGerais.forEach(p => {
                if(p.statusPainel === 'cancelado') return;
                
                // Exclui 'entregue' junto com 'mais_tarde' — senão, quando uma
                // retirada parcial manda o restante pausado de volta pra
                // cozinha (moverParaAgora reabre p.statusPainel = 'preparando'
                // no pedido inteiro), os itens que já tinham sido entregues na
                // primeira leva voltavam a aparecer na Cozinha/Balcão como se
                // ainda precisassem ser produzidos/entregues de novo.
                const iAgoraPendentes = p.itens.filter(i => i.fase !== 'mais_tarde' && i.fase !== 'entregue');
                const iDepois = p.itens.filter(i => i.fase === 'mais_tarde');

                // Só conta/mostra em produção quem está REALMENTE "preparando"
                // agora — antes isso somava também pedidos já "pronto" ou
                // "entregue" (o forEach rodava pra qualquer pedido não
                // cancelado), inflando o contador do resumo da Cozinha com
                // itens que já saíram da produção.
                let itensPurosCozinha = [];
                if (p.statusPainel === 'preparando') {
                    iAgoraPendentes.forEach(item => {
                        if (item.isCombo) {
                            item.itensComboEscolhidos.forEach(sub => {
                                if(sub.cozinha && sub.fase !== 'entregue') {
                                    itensPurosCozinha.push({nome: sub.nome, obs: item.obs, comboPai: item.nome});
                                    resumoProducaoCozinha[sub.nome] = (resumoProducaoCozinha[sub.nome] || 0) + 1;
                                }
                            });
                        } else {
                            if(item.cozinha) {
                                itensPurosCozinha.push({nome: item.nome, obs: item.obs, qtd: item.qtd});
                                resumoProducaoCozinha[item.nome] = (resumoProducaoCozinha[item.nome] || 0) + item.qtd;
                            }
                        }
                    });
                }

                // FILTRO DE COZINHA: MOSTRA APENAS SE TIVER ITENS DE PRODUÇÃO
                if(p.statusPainel === 'preparando' && itensPurosCozinha.length > 0) {
                    countCoz++;
                    const itensDetalhadosCozinha = itensPurosCozinha.map(i => `
                        <div style="border-bottom:1px dashed #ccc; padding:6px 0;">
                            <b>${i.qtd || 1}x ${i.nome}</b>
                            ${i.comboPai ? `<br><small style="color:gray;">(Vem do ${i.comboPai})</small>` : ''}
                            ${i.obs ? `<br><i style="color:red;font-size:0.8rem; font-weight:bold;">Observação: ${i.obs}</i>`:''}
                        </div>
                    `).join('');

                    htmlCozinha += `
                        <div class="card-pedido"><div class="status-bar bg-warning"></div>
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <h3 style="margin:0;">#${rotuloPedido(p)}</h3>
                            <b style="text-transform: uppercase; font-size: 1.1rem; color: #111827;">${p.cliente}</b>
                        </div>
                        <div style="font-size: 0.85rem; font-weight: bold; color: var(--primary); margin-top: 2px; margin-bottom: 5px;">[ ${p.tipoAtendimento || 'Levar (Viagem)'} ]</div>
                        <div class="lista-itens" style="margin-top:0;">${itensDetalhadosCozinha}</div>
                        </div>`;
                }

                if((p.statusPainel === 'preparando' || p.statusPainel === 'pronto' || p.statusPainel === 'nenhum') && iAgoraPendentes.length > 0) {
                    // Toggle em Configurações (⚙️ na tela de Pedido) — pedido
                    // sem NADA de cozinha vai pro Balcão 02 (Doces) em vez do
                    // Balcão 01. Desligado = tudo cai no Balcão 01, como
                    // sempre foi (ver pedidoTemAlgoDeCozinha acima).
                    const vaiPraBalcaoDoces = configPadroes.separarBalcaoDoces && !pedidoTemAlgoDeCozinha(iAgoraPendentes);
                    const resumoAlvo = vaiPraBalcaoDoces ? resumoBalcaoDoces : resumoBalcaoCozinha;
                    if (vaiPraBalcaoDoces) countBalcDoces++; else countBalc++;

                    // "Chamar" desligado (Configurações) = pula direto pro
                    // botão de entregar, sem tocar som nem exigir o passo de
                    // "Chamar Painel" antes.
                    const chamarAtivo = vaiPraBalcaoDoces ? (configPadroes.chamarAtivoBalcaoDoces !== false) : (configPadroes.chamarAtivoBalcao01 !== false);

                    let btn;
                    if (!chamarAtivo) {
                        btn = `
                        <div style="display:flex; gap:5px;">
                            <button class="btn btn-success" style="width:100%;" onclick="finalizarEntrega(${p.id})">✅ Entregue</button>
                        </div>`;
                    } else if (p.statusPainel === 'preparando' || p.statusPainel === 'nenhum') {
                        btn = `
                        <div style="display:flex; gap:5px;">
                            <button class="btn btn-warning" style="width:100%;" onclick="chamarNoPainel(${p.id})">🔔 Chamar Painel</button>
                        </div>`;
                    } else {
                        btn = `
                        <div style="display:flex; gap:5px;">
                            <button class="btn btn-warning" style="width:50%; padding:8px; font-size:0.8rem;" onclick="chamarNoPainel(${p.id})">🔔 Re-chamar</button>
                            <button class="btn btn-success" style="width:50%;" onclick="finalizarEntrega(${p.id})">✅ Retirado</button>
                        </div>`;
                    }
                    
                    const itensDetalhadosBalcao = iAgoraPendentes.map(item => {
                        // Combo soma por item ESCOLHIDO dentro dele (sub.nome),
                        // igual o resumo da Cozinha faz — senão o combo conta
                        // sob o próprio nome ("COMBO 01") em vez do produto
                        // real (ex: Hamburguer), e os dois resumos não batem.
                        if (item.isCombo) {
                            item.itensComboEscolhidos.forEach(sub => {
                                resumoAlvo[sub.nome] = (resumoAlvo[sub.nome] || 0) + 1;
                            });
                        } else {
                            resumoAlvo[item.nome] = (resumoAlvo[item.nome] || 0) + item.qtd;
                        }

                        if (item.isCombo) {
                            return item.itensComboEscolhidos.map((sub, subIndex) => {
                                let btnTrocaSub = (!sub.cozinha && (p.statusPainel === 'pronto' || p.statusPainel === 'preparando' || p.statusPainel === 'nenhum')) ? `<button class="btn btn-warning" style="padding:2px 6px; font-size:0.75rem; margin-left:5px;" onclick="abrirModalTrocaItem(${p.id}, '${item.cartId}', ${subIndex})" title="Trocar Sabor/Produto">✏️ Trocar</button>` : '';
                                return `
                                    <div style="border-bottom:1px dashed #ccc; padding:6px 0; display:flex; justify-content:space-between; align-items:center;">
                                        <div><b>1x ${sub.nome}</b> <small style="color:gray;">(Do ${item.nome})</small>${item.obs ? `<br><i style="color:red;font-size:0.8rem;">Obs: ${item.obs}</i>`:''}</div>
                                        <div>${btnTrocaSub}</div>
                                    </div>
                                `;
                            }).join('');
                        } else {
                            let btnTroca = (!item.cozinha && (p.statusPainel === 'pronto' || p.statusPainel === 'preparando' || p.statusPainel === 'nenhum')) ? `<button class="btn btn-warning" style="padding:2px 6px; font-size:0.75rem; margin-left:5px;" onclick="abrirModalTrocaItem(${p.id}, '${item.cartId}')" title="Trocar Sabor/Produto">✏️ Trocar</button>` : '';
                            return `
                                <div style="border-bottom:1px dashed #ccc; padding:6px 0; display:flex; justify-content:space-between; align-items:center;">
                                    <div><b>${item.qtd}x ${item.nome}</b>${item.obs ? `<br><i style="color:red;font-size:0.8rem;">Obs: ${item.obs}</i>`:''}</div>
                                    <div style="display:flex; align-items:center; gap:4px;">
                                        ${btnTroca}
                                    </div>
                                </div>
                            `;
                        }
                    }).join('');

                    const cardHtmlBalcao = `
                        <div class="card-pedido"><div class="status-bar ${p.statusPainel === 'preparando' ? 'bg-warning' : 'bg-pronto'}"></div>
                        <div style="display:flex; justify-content:space-between;"><h3>#${rotuloPedido(p)} - ${p.cliente}${p.veioDePausa ? ' <span title="Veio de Pedidos em Pausa">⏸️</span>' : ''}</h3><span>Entrada: ${p.hora}</span></div>
                        <div style="font-size: 0.85rem; font-weight: bold; color: var(--primary); margin-top: -5px; margin-bottom: 5px;">[ ${p.tipoAtendimento || 'Levar (Viagem)'} ]</div>
                        <div class="lista-itens" style="margin-top:0;">${itensDetalhadosBalcao}</div>
                        ${btn}</div>`;
                    if (vaiPraBalcaoDoces) htmlBalcaoDoces += cardHtmlBalcao; else htmlBalcao += cardHtmlBalcao;
                }

                if(iDepois.length > 0) {
                    countAgend++;
                    
                    const itensDetalhadosFicha = iDepois.map(i => {
                        if (i.isCombo) {
                            i.itensComboEscolhidos.forEach(sub => {
                                resumoBalcaoFicha[sub.nome] = (resumoBalcaoFicha[sub.nome] || 0) + 1;
                            });
                        } else {
                            resumoBalcaoFicha[i.nome] = (resumoBalcaoFicha[i.nome] || 0) + i.qtd;
                        }

                        let comboDet = i.isCombo ? `<br><small style="color:gray;">↳ ${i.itensComboEscolhidos.map(sub=>`1x ${sub.nome}`).join(', ')}</small>` : '';
                        let obsDet = i.obs ? `<br><i style="color:red; font-size:0.8rem; font-weight:bold;">Observação: ${i.obs}</i>` : '';
                        return `<div style="border-bottom:1px dashed #ccc; padding:4px 0;"><b>${i.qtd}x ${i.nome}</b>${comboDet}${obsDet}</div>`;
                    }).join('');

                    htmlAgenda += `
                        <div class="card-pedido" style="border:1px solid var(--info);">
                            <div class="status-bar bg-info"></div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <h3 style="margin:0;">#${rotuloPedido(p)} - ${p.cliente}</h3>
                                <b style="color:var(--info); font-size:0.85rem;">🕒 ${p.hora}</b>
                            </div>
                            <div style="font-size: 0.85rem; font-weight: bold; color: var(--primary); margin-top:2px;">[ ${p.tipoAtendimento || 'Levar (Viagem)'} ]</div>
                            <div class="lista-itens" style="margin-top:8px;">${itensDetalhadosFicha}</div>
                            <button class="btn btn-info" onclick="moverParaAgora(${p.id})">📤 Enviar p/ Cozinha</button>
                            <button class="btn" style="width:100%; margin-top:5px; background:#475569; color:white; padding:6px; font-size:0.8rem;" onclick="reimprimirPedido(${p.id})" title="Imprimir só este pedido">🖨️ Imprimir</button>
                        </div>`;
                }

                // A TV precisa mostrar exatamente os mesmos pedidos que a tela da
                // Cozinha (itensPurosCozinha, calculado acima, já filtra por
                // fase==='agora'). Antes isso era recalculado olhando p.itens
                // inteiro sem filtrar a fase — um pedido de Pedido Ficha (itens
                // ainda 'mais_tarde', não enviados à cozinha) com status
                // 'preparando' definido manualmente (ex: pelo dropdown de status
                // na edição) aparecia na TV mesmo sem nada realmente em produção.
                if(p.statusPainel === 'preparando' && itensPurosCozinha.length > 0) {
                    htmlPrepTV += `<div class="mc-num"><span class="id">#${String(p.id).padStart(2, '0')}</span><span class="nome">${p.cliente}</span></div>`;
                }

                if(p.statusPainel === 'pronto') prontos.push(p);
                if(p.statusPainel === 'entregue') entregues.push(p);
            });

            // MONTA A SIDEBAR DA COZINHA (SOMENTE PRODUTOS EM PREPARO ATIVO)
            const corpoResumoCozinha = document.getElementById('corpo-resumo-cozinha');
            if (corpoResumoCozinha) {
                let prodsCozinhaNomes = Object.keys(resumoProducaoCozinha);
                if (prodsCozinhaNomes.length === 0) {
                    corpoResumoCozinha.innerHTML = '<p style="color:gray; font-size:0.8rem;">Nenhum item em preparo.</p>';
                } else {
                    let agrupadoPorCatCoz = {};
                    categoriasDB.forEach(cat => { agrupadoPorCatCoz[cat] = []; });

                    prodsCozinhaNomes.forEach(nomeProd => {
                        const pObj = produtosDB.find(prod => prod.nome === nomeProd);
                        const cat = pObj ? pObj.categoria : 'Geral';
                        if (!agrupadoPorCatCoz[cat]) agrupadoPorCatCoz[cat] = [];
                        
                        const total = resumoProducaoCozinha[nomeProd];
                        agrupadoPorCatCoz[cat].push({ nome: nomeProd, total });
                    });

                    let htmlTabelaCozinha = `
                        <table class="tabela-resumo-canto">
                            <thead>
                                <tr>
                                    <th style="text-align:left;">Item em Preparo</th>
                                    <th style="width:60px;">Qtd</th>
                                </tr>
                            </thead>
                            <tbody>
                    `;

                    for (let cat in agrupadoPorCatCoz) {
                        if (agrupadoPorCatCoz[cat].length > 0) {
                            htmlTabelaCozinha += `<tr class="cat-row"><td colspan="2">📁 ${cat}</td></tr>`;
                            agrupadoPorCatCoz[cat].forEach(item => {
                                htmlTabelaCozinha += `
                                    <tr>
                                        <td><b>${item.nome}</b></td>
                                        <td style="text-align:center; font-weight:900; background:#fef3c7; color:#b45309;">${item.total}</td>
                                    </tr>
                                `;
                            });
                        }
                    }

                    htmlTabelaCozinha += '</tbody></table>';
                    corpoResumoCozinha.innerHTML = htmlTabelaCozinha;
                }
            }

            // TEMPO MÉDIO DE ENTREGA — da hora que o pedido foi criado até
            // a hora que foi marcado como entregue, média dos pedidos
            // entregues que ainda estão em pedidosGerais (ou seja, do caixa
            // aberto agora — some do cálculo quando o caixa fecha, igual o
            // resto da tela). Balcão 01 e Balcão 02 usam a MESMA
            // classificação de roteamento (pedidoTemAlgoDeCozinha +
            // configPadroes.separarBalcaoDoces) que decide os cards no
            // resto desta função.
            const elTempoBalcao01 = document.querySelector('#tempo-medio-entrega-balcao .valor-tempo-medio-entrega');
            const elTempoBalcaoDoces = document.querySelector('#tempo-medio-entrega-balcao-doces .valor-tempo-medio-entrega');
            if (elTempoBalcao01 || elTempoBalcaoDoces) {
                const entreguesBalcao01 = [], entreguesBalcaoDoces = [];
                pedidosGerais.forEach(p => {
                    if (p.statusPainel !== 'entregue') return;
                    const vaiPraDoces = configPadroes.separarBalcaoDoces && !pedidoTemAlgoDeCozinha(p.itens);
                    (vaiPraDoces ? entreguesBalcaoDoces : entreguesBalcao01).push(p);
                });
                if (elTempoBalcao01) elTempoBalcao01.innerText = formatarTempoMedioEntrega(entreguesBalcao01);
                if (elTempoBalcaoDoces) elTempoBalcaoDoces.innerText = formatarTempoMedioEntrega(entreguesBalcaoDoces);
            }

            // MONTA A SIDEBAR DO BALCÃO
            const corpoResumoBalcao = document.getElementById('corpo-resumo-balcao');
            if (corpoResumoBalcao) {
                let todosProdutosAtivosNomes = new Set([...Object.keys(resumoBalcaoCozinha), ...Object.keys(resumoBalcaoFicha)]);
                if (todosProdutosAtivosNomes.size === 0) {
                    corpoResumoBalcao.innerHTML = '<p style="color:gray; font-size:0.8rem;">Nenhum item ativo.</p>';
                } else {
                    let agrupadoPorCat = {};
                    categoriasDB.forEach(cat => { agrupadoPorCat[cat] = []; });

                    todosProdutosAtivosNomes.forEach(nomeProd => {
                        const pObj = produtosDB.find(prod => prod.nome === nomeProd);
                        const cat = pObj ? pObj.categoria : 'Geral';
                        if (!agrupadoPorCat[cat]) agrupadoPorCat[cat] = [];
                        
                        const qtdCoz = resumoBalcaoCozinha[nomeProd] || 0;
                        const qtdFicha = resumoBalcaoFicha[nomeProd] || 0;
                        const total = qtdCoz + qtdFicha;

                        agrupadoPorCat[cat].push({ nome: nomeProd, qtdCoz, qtdFicha, total });
                    });

                    let htmlTabelaResumo = `
                        <table class="tabela-resumo-canto">
                            <thead>
                                <tr>
                                    <th style="text-align:left;">Item / Produto</th>
                                    <th>ativo</th>
                                    <th>ficha</th>
                                    <th>total</th>
                                </tr>
                            </thead>
                            <tbody>
                    `;

                    for (let cat in agrupadoPorCat) {
                        if (agrupadoPorCat[cat].length > 0) {
                            htmlTabelaResumo += `<tr class="cat-row"><td colspan="4">📁 ${cat}</td></tr>`;
                            agrupadoPorCat[cat].forEach(item => {
                                htmlTabelaResumo += `
                                    <tr>
                                        <td><b>${item.nome}</b></td>
                                        <td style="text-align:center; font-weight:bold; color:#1e40af;">${item.qtdCoz || '-'}</td>
                                        <td style="text-align:center; font-weight:bold; color:#8b5cf6;">${item.qtdFicha || '-'}</td>
                                        <td style="text-align:center; font-weight:900; background:#dcfce7; color:#15803d;">${item.total}</td>
                                    </tr>
                                `;
                            });
                        }
                    }

                    htmlTabelaResumo += '</tbody></table>';
                    corpoResumoBalcao.innerHTML = htmlTabelaResumo;
                }
            }

            // MONTA A SIDEBAR DO BALCÃO 02 (DOCES) — mais simples que a do
            // Balcão 01 (não tem "ficha" separado, só quantidade ativa
            // mesmo), ajuda quem está lá a saber o que já pode levar pro
            // Balcão 01 se precisar.
            const corpoResumoBalcaoDoces = document.getElementById('corpo-resumo-balcao-doces');
            if (corpoResumoBalcaoDoces) {
                const nomesDoces = Object.keys(resumoBalcaoDoces);
                if (nomesDoces.length === 0) {
                    corpoResumoBalcaoDoces.innerHTML = '<p style="color:gray; font-size:0.8rem;">Nenhum item ativo.</p>';
                } else {
                    let htmlTabelaDoces = `
                        <table class="tabela-resumo-canto">
                            <thead><tr><th style="text-align:left;">Item / Produto</th><th>qtd</th></tr></thead>
                            <tbody>
                    `;
                    nomesDoces.sort((a, b) => resumoBalcaoDoces[b] - resumoBalcaoDoces[a]).forEach(nome => {
                        htmlTabelaDoces += `
                            <tr>
                                <td><b>${nome}</b></td>
                                <td style="text-align:center; font-weight:900; background:#dcfce7; color:#15803d;">${resumoBalcaoDoces[nome]}</td>
                            </tr>
                        `;
                    });
                    htmlTabelaDoces += '</tbody></table>';
                    corpoResumoBalcaoDoces.innerHTML = htmlTabelaDoces;
                }
            }

            document.getElementById('fila-cozinha').innerHTML = htmlCozinha || '<p style="color:gray;">Livre.</p>';
            document.getElementById('fila-entrega').innerHTML = htmlBalcao || '<p style="color:gray;">Livre.</p>';
            document.getElementById('fila-agendados').innerHTML = htmlAgenda || '<p style="color:gray;">Nenhum retido.</p>';
            const filaEntregaDoces = document.getElementById('fila-entrega-doces');
            if (filaEntregaDoces) filaEntregaDoces.innerHTML = htmlBalcaoDoces || '<p style="color:gray;">Livre.</p>';

            document.getElementById('badge-cozinha').innerText = countCoz;
            document.getElementById('badge-cozinha').style.display = countCoz ? 'inline-block' : 'none';
            document.getElementById('badge-entrega').innerText = countBalc;
            document.getElementById('badge-entrega').style.display = countBalc ? 'inline-block' : 'none';
            document.getElementById('badge-agendados').innerText = countAgend;
            document.getElementById('badge-agendados').style.display = countAgend ? 'inline-block' : 'none';
            const badgeEntregaDoces = document.getElementById('badge-entrega-doces');
            if (badgeEntregaDoces) {
                badgeEntregaDoces.innerText = countBalcDoces;
                badgeEntregaDoces.style.display = countBalcDoces ? 'inline-block' : 'none';
            }

            // Mesmas contagens, só que escritas por extenso no cabeçalho de
            // cada tela (o badge do menu é pequeno demais pra bater o olho).
            document.getElementById('contagem-cozinha').innerText = `${countCoz} ${countCoz === 1 ? 'pedido' : 'pedidos'}`;
            document.getElementById('contagem-entrega').innerText = `${countBalc} ${countBalc === 1 ? 'pedido' : 'pedidos'}`;
            document.getElementById('contagem-agendados').innerText = `${countAgend} ${countAgend === 1 ? 'pedido' : 'pedidos'}`;
            const contagemEntregaDoces = document.getElementById('contagem-entrega-doces');
            if (contagemEntregaDoces) contagemEntregaDoces.innerText = `${countBalcDoces} ${countBalcDoces === 1 ? 'pedido' : 'pedidos'}`;

            document.getElementById('tv-lista-preparando').innerHTML = htmlPrepTV || '<div style="color:gray;text-align:center;width:100%;font-size:1.5vw;margin-top:20px;">Aguardando...</div>';
            
            const tvDest = document.getElementById('tv-pronto-destaque');
            if(prontos.length > 0) {
                let ult = prontos[prontos.length - 1];
                tvDest.style.display = 'flex'; 
                tvDest.innerHTML = `<div class="mc-destaque-num">#${String(ult.id).padStart(2, '0')}</div><div class="mc-destaque-name">${ult.cliente}</div>`;
            } else { tvDest.style.display = 'none'; }
            
            let hist = [...prontos.reverse(), ...entregues.slice(-8).reverse()].slice(0, 10);
            document.getElementById('tv-lista-historico').innerHTML = hist.map(p => `<div class="mc-num ready"><span class="id">#${String(p.id).padStart(2, '0')}</span><span class="nome">${p.cliente}</span></div>`).join('');

            const cardsBalcaoVisiveis = Array.from(document.querySelectorAll('#fila-entrega .card-pedido'));
            if (cardsBalcaoVisiveis.length > 0) {
                destacarCardBalcao(cardsBalcaoVisiveis, false);
            }

            // "Produtos Vendidos por Período" agora inclui venda AO VIVO dos
            // caixas abertos (ver calcularResumoProdutosPorPeriodo) — atualiza
            // sozinho aqui, se a tela estiver aberta, pra não parecer "parado"
            // enquanto o dia inteiro de vendas acontece. atualizarTelas() já
            // roda tanto em toda ação local (novo pedido, chamar painel...)
            // quanto em todo estado recebido de outro dispositivo (via
            // aplicarEstado), então cobre os dois casos sem duplicar a chamada.
            const telaProdutosPeriodo = document.getElementById('tela-produtos-periodo');
            if (telaProdutosPeriodo && telaProdutosPeriodo.classList.contains('active')) {
                renderizarProdutosPorPeriodo();
            }
        }

        function atualizarFiltrosGestao() {
            const textoBusca = document.getElementById('filtro-texto-gestao').value.toLowerCase();
            const dataBusca = document.getElementById('filtro-data-gestao').value;
            const pagtoBusca = document.getElementById('filtro-pagto-gestao').value;
            const statusBusca = document.getElementById('filtro-status-gestao').value;
            let dataFormatada = "";
            if (dataBusca) { const partes = dataBusca.split('-'); dataFormatada = `${partes[2]}/${partes[1]}/${partes[0]}`; }

            const tbody = document.getElementById('tabela-gestao'); tbody.innerHTML = '';
            let pedidosFiltrados = [...pedidosGerais].reverse();

            if (textoBusca) pedidosFiltrados = pedidosFiltrados.filter(p => p.cliente.toLowerCase().includes(textoBusca) || p.id.toString().includes(textoBusca));
            if (dataFormatada) pedidosFiltrados = pedidosFiltrados.filter(p => p.data === dataFormatada);
            if (pagtoBusca !== 'Todos') {
                pedidosFiltrados = pedidosFiltrados.filter(p => p.pagamento && p.pagamento.includes(pagtoBusca));
            }
            if (statusBusca !== 'Todos') {
                if (statusBusca === 'entregue') pedidosFiltrados = pedidosFiltrados.filter(p => p.statusPainel === 'entregue');
                if (statusBusca === 'preparando') pedidosFiltrados = pedidosFiltrados.filter(p => p.statusPainel === 'preparando' || p.statusPainel === 'pronto');
                if (statusBusca === 'cancelado') pedidosFiltrados = pedidosFiltrados.filter(p => p.statusPainel === 'cancelado');
            }

            if (pedidosFiltrados.length === 0) return tbody.innerHTML = '<tr><td colspan="10" style="padding: 15px; text-align: center; color: gray;">Nenhum pedido encontrado.</td></tr>';

            pedidosFiltrados.forEach(p => {
                let statusHtml = ''; let acoesHtml = '';
                let btnImprimir = `<button onclick="reimprimirPedido(${p.id})" class="btn" style="background:#3b82f6; color:white; padding: 4px 8px; font-size: 0.8rem; margin-right: 5px;" title="Reimprimir">🖨️</button><button onclick="baixarPDFPedido(${p.id})" class="btn" style="background:#b91c1c; color:white; padding: 4px 8px; font-size: 0.8rem; margin-right: 5px;" title="Baixar em PDF">📄</button>`;

                // Cancelar/apagar pedido é só pro Master (mesma regra da tela
                // de Pedido) — atendente comum não vê o botão de lixeira aqui.
                const btnCancelarGestao = (usuarioAtual && usuarioAtual.isMaster) ? `<button onclick="cancelarPedido(${p.id})" class="btn btn-danger" style="padding: 4px 8px; font-size: 0.8rem;">🗑️</button>` : '';

                if (p.statusPainel === 'entregue') {
                    statusHtml = '<span class="status-badge" style="background:var(--success);">✅ Finalizado</span>';
                    acoesHtml = btnImprimir + `<button onclick="editarPedido(${p.id})" class="btn btn-warning" style="padding: 4px 8px; font-size: 0.8rem; margin-right: 5px;">✏️</button> ${btnCancelarGestao}`;
                } else if (p.statusPainel === 'cancelado') {
                    statusHtml = `<span class="status-badge" style="background:var(--danger);" title="${p.motivoCancelamento ? 'Motivo: ' + p.motivoCancelamento : 'Motivo não registrado'}">❌ Cancelado</span>`;
                    acoesHtml = btnImprimir + '<span style="color:gray; font-size: 0.8rem;">Bloqueado</span>';
                } else {
                    if (p.statusPainel === 'pronto') statusHtml = '<span class="status-badge" style="background:var(--primary);">📺 Pronto TV</span>';
                    else if (p.statusPainel === 'preparando') statusHtml = '<span class="status-badge" style="background:var(--warning); color:black;">👨‍🍳 Cozinha</span>';
                    else statusHtml = '<span class="status-badge" style="background:var(--info);">📦 P/ Depois</span>';

                    acoesHtml = btnImprimir + `<button onclick="editarPedido(${p.id})" class="btn btn-warning" style="padding: 4px 8px; font-size: 0.8rem; margin-right: 5px;">✏️</button> ${btnCancelarGestao}`;
                }
                const resumoItens = p.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ');
                const tempoPreparo = calcularDiferencaMinutos(p.horaEntradaCozinha || p.hora, p.horaEntrega);
                const caixaDoPedido = caixasAbertos.find(c => c.id === p.caixaId);
                const nomeCaixaPedido = caixaDoPedido ? caixaDoPedido.usuarioNome : '-';

                tbody.innerHTML += `<tr style="border-bottom: 1px solid #f3f4f6; ${p.statusPainel === 'cancelado' ? 'opacity:0.5;' : ''}">
                    <td style="padding: 12px; font-weight: bold;">#${rotuloPedido(p)}</td>
                    <td style="font-size: 0.8rem; font-weight: bold; color: #4b5563;">${nomeCaixaPedido}</td>
                    <td style="font-size: 0.75rem; color: #4b5563;">
                        <b>Ent:</b> ${p.hora}<br>
                        <b>Coz:</b> ${p.horaEntradaCozinha || '-'}<br>
                        <b>Entr:</b> ${p.horaEntrega || '-'}
                    </td>
                    <td style="font-weight: bold; color: var(--primary);">${tempoPreparo}</td>
                    <td style="font-weight: bold;">${p.cliente}</td><td style="font-size: 0.85rem; font-weight: bold; color: #4b5563;">${p.pagamento}</td>
                    <td style="font-size: 0.85rem; max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${resumoItens}">${resumoItens}</td>
                    <td>${statusHtml}</td><td style="font-weight: bold; color: var(--success);">R$ ${p.total.toFixed(2)}</td><td>${acoesHtml}</td></tr>`;
            });
        }

        async function abrirCaixaPrompt() {
            if (!usuarioAtual) return;
            if (!usuarioPodeAbrirFecharCaixa()) return exibirAviso("Você não tem permissão para abrir caixa.");
            if (caixaDoUsuarioAtual()) return exibirAviso("Você já tem um caixa aberto.");

            const valStr = await pedirTexto("Valor inicial em dinheiro (fundo de caixa):", { titulo: '🟢 Abrir Caixa' });
            if (valStr === null) return;
            const val = parseFloat(valStr.replace(',', '.'));
            if (isNaN(val) || val < 0) return exibirAviso("Valor de fundo de caixa inválido.");

            const senha = await pedirTexto(`Confirme sua senha (${usuarioAtual.nome}) para abrir o caixa:`, { titulo: '🔒 Confirmar senha', senha: true });
            if (senha === null) return;
            const senhaOk = await confirmarSenhaUsuarioAtual(senha);
            if (!senhaOk) return exibirAviso("Senha incorreta.");

            const dataObjeto = new Date();
            const dataHoraAbertura = `${dataObjeto.toLocaleDateString('pt-BR')} ${dataObjeto.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

            caixasAbertos.push({
                id: `${usuarioAtual.id}_${Date.now()}`,
                usuarioId: usuarioAtual.id,
                usuarioNome: usuarioAtual.nome,
                valorFundoCaixa: val,
                dataHoraAbertura
            });

            salvarNoBancoLocal();
            atualizarInterfaceCaixa();
            exibirAviso(`Caixa aberto com sucesso! Fundo inicial: R$ ${val.toFixed(2)}`);
            atualizarDashboard();
        }

        // Fecha um caixa específico (idCaixa) — qualquer usuário com permissão
        // de abrir/fechar caixa pode fechar o de outro operador (ex: alguém
        // esqueceu aberto), não só o próprio. Só os pedidos DAQUELE caixa
        // entram no fechamento e saem de pedidosGerais — os outros caixas
        // abertos na barraca continuam intactos.
        async function fecharCaixaPrompt(idCaixa) {
            const caixa = caixasAbertos.find(c => c.id === idCaixa && !c.fechado);
            if (!caixa) return exibirAviso("Este caixa já está fechado.");
            if (!usuarioPodeAbrirFecharCaixa()) {
                return exibirAviso("Você não tem permissão para fechar caixa.");
            }

            // Só deixa fechar se não sobrou nada pendente desse caixa no
            // Balcão (preparando/pronto/nenhum) nem em Pedidos em Pausa —
            // senão esses pedidos ficariam "órfãos" depois do fechamento.
            const pendentes = pedidosGerais.filter(p => p.caixaId === idCaixa && p.statusPainel !== 'entregue' && p.statusPainel !== 'cancelado');
            if (pendentes.length > 0) {
                if (!usuarioAtual.isMaster) {
                    return exibirAviso(`Ainda há ${pendentes.length} pedido(s) pendente(s) desse caixa no Balcão ou em Pedidos em Pausa. Finalize ou cancele todos antes de fechar o caixa.`, "Caixa não pode ser fechado");
                }
                // Master pode forçar: cancela em lote os pendentes (devolve
                // o estoque de cada um, igual cancelarPedido faz um por um)
                // pra liberar o fechamento — útil no fim do evento, quando
                // sobra pedido que não vai mais ser produzido/entregue.
                // Sempre pede confirmação explícita + motivo, nunca aplica
                // silencioso — é uma ação que não dá pra desfazer.
                const listaNomes = pendentes.map(p => `#${rotuloPedido(p)} (${p.cliente})`).join(', ');
                const confirmouForcar = await pedirConfirmacao(
                    `Ainda há ${pendentes.length} pedido(s) pendente(s) neste caixa: ${listaNomes}. Forçar o fechamento CANCELA todos esses pedidos (devolve o estoque) — não dá pra desfazer. Forçar mesmo assim?`,
                    { titulo: '⚠️ Forçar Fechamento de Caixa' }
                );
                if (!confirmouForcar) return;

                const motivoForcado = await pedirTexto('Motivo do cancelamento em lote (obrigatório):', { titulo: '🗑️ Forçar Fechamento — Motivo', valorInicial: 'Fechamento forçado do caixa' });
                if (motivoForcado === null) return;
                if (!motivoForcado.trim()) return exibirAviso("É obrigatório informar o motivo.");

                let catalogoAlteradoPorEstoqueForcado = false;
                pendentes.forEach(p => {
                    if (cancelarPedidoInterno(p, motivoForcado.trim())) catalogoAlteradoPorEstoqueForcado = true;
                });
                if (catalogoAlteradoPorEstoqueForcado) salvarCatalogo();
                salvarNoBancoLocal();
                renderizarMenu(categoriaFiltroAtual);
                renderizarTabelaProdutos();
                atualizarTelas();
                atualizarFiltrosGestao();
            }

            const senha = await pedirTexto(`Confirme sua senha (${usuarioAtual.nome}) para fechar o caixa de ${caixa.usuarioNome}:`, { titulo: '🔒 Confirmar senha', senha: true });
            if (senha === null) return;
            const senhaOk = await confirmarSenhaUsuarioAtual(senha);
            if (!senhaOk) return exibirAviso("Senha incorreta.");

            const nomeCampanha = await pedirTexto("Nome da campanha/evento para fechar o caixa (obrigatório):", { titulo: '🔒 Fechar Caixa' });
            if (!nomeCampanha || nomeCampanha.trim() === "") {
                return exibirAviso("O Nome da Campanha é obrigatório para fechar o caixa!");
            }

            // Tudo que segue (cálculo + salvar + imprimir) fica blindado num
            // try/catch — antes, se QUALQUER conta aqui dentro desse
            // (ex: um pedido antigo com campo faltando) explodisse, a
            // função simplesmente parava no meio sem avisar nada: o caixa
            // continuava em caixasAbertos (parecendo "não fechou") e
            // ninguém via mensagem de erro nenhuma. Agora qualquer falha
            // aparece na tela em vez de falhar em silêncio, e só mexe em
            // caixasAbertos/pedidosGerais depois que os cálculos já deram
            // certo — nunca deixa o caixa pela metade.
            try {

            const pedidosDoCaixa = pedidosGerais.filter(p => p.caixaId === idCaixa);
            const validos = pedidosDoCaixa.filter(p => p.statusPainel !== 'cancelado');
            const validosFinanceiros = validos.filter(p => p.pagamento && !p.pagamento.startsWith('Bonificação'));

            const totalVendas = validosFinanceiros.reduce((a, p) => a + p.total, 0);

            let fatPix = 0, fatPixDireto = 0, fatCredito = 0, fatDebito = 0, fatDinheiro = 0, fatBonificacao = 0;

            validos.forEach(p => {
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
                    else if (p.pagamento.startsWith('Bonificação')) fatBonificacao += p.total;
                }
            });

            // Combo soma por item ESCOLHIDO (sub.nome), igual o resumo da
            // Cozinha/Balcão já faz — senão conta sob o nome do combo em vez
            // do produto real. Combo não guarda preço por sub-item, só o
            // total do combo — divide igual entre os itens escolhidos como
            // aproximação do valor de cada um.
            let resumoProdutosVendidos = {};
            let valorProdutosVendidos = {};
            validosFinanceiros.forEach(p => {
                p.itens.forEach(i => {
                    if (i.isCombo && Array.isArray(i.itensComboEscolhidos) && i.itensComboEscolhidos.length > 0) {
                        const valorUnitario = i.preco / i.itensComboEscolhidos.length;
                        i.itensComboEscolhidos.forEach(sub => {
                            resumoProdutosVendidos[sub.nome] = (resumoProdutosVendidos[sub.nome] || 0) + 1;
                            valorProdutosVendidos[sub.nome] = (valorProdutosVendidos[sub.nome] || 0) + valorUnitario;
                        });
                    } else {
                        resumoProdutosVendidos[i.nome] = (resumoProdutosVendidos[i.nome] || 0) + i.qtd;
                        valorProdutosVendidos[i.nome] = (valorProdutosVendidos[i.nome] || 0) + (i.preco * i.qtd);
                    }
                });
            });

            // Calculado e gravado como SNAPSHOT deste momento — se o
            // catálogo (custo médio/ficha técnica) ou a taxa da maquininha
            // mudarem depois, este fechamento continua mostrando o que era
            // verdade na hora de fechar (mesmo raciocínio de
            // valorProdutosVendidos, ver renderizarDetalhesCaixaNoModal).
            const { custoProducaoTotal, custoTaxas, lucroReal } = calcularCustosOperacao(pedidosDoCaixa, { fatCredito, fatDebito, fatPix, totalVendas });

            const dataObjeto = new Date();
            const dataHoraFechamento = `${dataObjeto.toLocaleDateString('pt-BR')} ${dataObjeto.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
            const dataHoraAbertura = caixa.dataHoraAbertura || dataHoraFechamento;

            const registroFechamento = {
                // Id temporário só pra esta tela (negativo, nunca colide com
                // um id real do Postgres, que é sempre positivo) — vira o
                // id de verdade assim que enviarFechamentoParaSupabase
                // confirmar a gravação, ver logo abaixo.
                id: -Date.now(),
                // Identidade estável enviada pra pdv_historico_caixas (ver
                // enviarFechamentoParaSupabase) — usada só pela fila de
                // retry, pra não duplicar se reenviar duas vezes.
                chaveUnica: `${PDV_CLIENT_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                usuarioNome: caixa.usuarioNome,
                campanha: nomeCampanha.trim(),
                dataAbertura: dataHoraAbertura,
                dataFechamento: dataHoraFechamento,
                fundoInicial: caixa.valorFundoCaixa,
                totalVendas: totalVendas,
                pix: fatPix,
                pixDireto: fatPixDireto,
                credito: fatCredito,
                debito: fatDebito,
                dinheiroVendas: fatDinheiro,
                bonificacao: fatBonificacao,
                totalGaveta: caixa.valorFundoCaixa + fatDinheiro,
                qtdPedidos: validos.length,
                produtosVendidos: resumoProdutosVendidos,
                valorProdutosVendidos: valorProdutosVendidos,
                custoProducaoEstimado: custoProducaoTotal,
                custoTaxasEstimado: custoTaxas,
                lucroRealEstimado: lucroReal,
                pedidosDetalhados: JSON.parse(JSON.stringify(pedidosDoCaixa))
            };

            // Mostra na tela local IMEDIATAMENTE (antes até de confirmar no
            // Supabase) — imprimir e navegar pro Histórico não podem esperar
            // rede. enviarFechamentoParaSupabase troca o id temporário pelo
            // real quando confirmar; se falhar (sem internet), entra na fila
            // de retry e tenta de novo sozinho quando a conexão voltar —
            // nunca é descartado.
            historicoCaixasDB.unshift(registroFechamento);

            // Marca fechado em vez de REMOVER de caixasAbertos — remover
            // direto quebrava a sincronização entre dispositivos (ver
            // mesclarCaixasAbertos acima pra entender o bug e por que a
            // correção precisa ser aqui, não só na função de mescla).
            const caixaFechado = caixasAbertos.find(c => c.id === idCaixa);
            if (caixaFechado) { caixaFechado.fechado = true; caixaFechado.fechadoEm = Date.now(); }
            pedidosGerais = pedidosGerais.filter(p => p.caixaId !== idCaixa);
            if (caixaRelatorioSelecionado === idCaixa) caixaRelatorioSelecionado = null;

            salvarNoBancoLocal();
            atualizarInterfaceCaixa();
            atualizarTelas();
            atualizarFiltrosGestao();
            atualizarDashboard();

            imprimirRelatorioFechamento(registroFechamento.id);

            exibirAviso("Caixa fechado com sucesso! Redirecionando para o Histórico de Caixas...");

            // Espera essa tentativa (rápida, mesmo offline — falha na hora e
            // vai pra fila) ANTES de navegar: mudarAba pra tela-fechamento-caixa
            // recarrega o histórico do Supabase, e se navegasse antes desse
            // insert terminar, o fechamento que acabou de ser criado podia
            // sumir da tela até a próxima atualização.
            await enviarFechamentoParaSupabase(registroFechamento);
            mudarAba('tela-fechamento-caixa', document.getElementById('btn-sub-fechamento'));

            } catch (erro) {
                console.error('Falha ao fechar caixa:', erro);
                exibirAviso(`❌ Deu um erro durante o fechamento: ${erro.message || erro}. Confira a tela: se o caixa ainda aparecer na lista de abertos, tente fechar de novo; se já tiver sumido de lá, o fechamento em si aconteceu (confira em Histórico de Caixas) e o erro foi só num passo depois (imprimir/sincronizar). Se precisar, avise o suporte com essa mensagem.`, 'Erro ao Fechar Caixa');
            }
        }

        async function excluirRegistroCaixa(idCaixa) {
            if (!usuarioAtual || !usuarioAtual.isMaster) {
                return exibirAviso("Só o usuário Master pode excluir um fechamento de caixa.");
            }
            if (!(await pedirConfirmacao(`Excluir permanentemente o Fechamento de Caixa #${idCaixa}?`, { titulo: '🗑️ Excluir Fechamento' }))) return;

            const senha = await pedirTexto(`Confirme sua senha (${usuarioAtual.nome}) para excluir este fechamento:`, { titulo: '🔒 Confirmar senha', senha: true });
            if (senha === null) return;
            const senhaOk = await confirmarSenhaUsuarioAtual(senha);
            if (!senhaOk) return exibirAviso("Senha incorreta.");

            // Devolve ao estoque tudo que foi vendido nesse fechamento — feito
            // pra cobrir caixas abertos só de teste, onde as vendas nunca
            // deveriam ter descontado estoque de verdade. Pedidos já
            // cancelados não entram aqui: cancelarPedido() já devolveu o
            // estoque deles na hora, devolver de novo duplicaria.
            const registro = historicoCaixasDB.find(c => c.id === idCaixa);
            let catalogoAlteradoPorEstoque = false;
            if (registro && Array.isArray(registro.pedidosDetalhados)) {
                registro.pedidosDetalhados.forEach(p => {
                    if (p.statusPainel === 'cancelado') return;
                    (p.itens || []).forEach(item => {
                        const devolverUm = (idProduto) => {
                            const est = estoquePorProduto[idProduto];
                            if (est === undefined || est === null) return;
                            const novoEst = est + 1;
                            estoquePorProduto[idProduto] = novoEst;
                            const prod = produtosDB.find(prod => prod.id === idProduto);
                            if (prod && sincronizarAtivoPorEstoque(prod, novoEst)) catalogoAlteradoPorEstoque = true;
                        };
                        if (item.isCombo) {
                            (item.itensComboEscolhidos || []).forEach(sub => devolverUm(sub.idProduto));
                        } else {
                            devolverUm(item.idProduto);
                        }
                    });
                });
            }

            historicoCaixasDB = historicoCaixasDB.filter(c => c.id !== idCaixa);
            if (catalogoAlteradoPorEstoque) salvarCatalogo();
            salvarNoBancoLocal();
            renderizarHistoricoCaixas();
            renderizarTabelaProdutos();
            renderizarMenu(categoriaFiltroAtual);

            try {
                const { error } = await supabaseClient.from('pdv_historico_caixas').delete().eq('id', idCaixa);
                if (error) throw error;
                exibirAviso(`Registro de Caixa #${idCaixa} excluído e estoque devolvido com sucesso!`);
            } catch (erro) {
                console.error('Falha ao excluir fechamento de caixa no Supabase:', erro);
                exibirAviso(`Removido da tela e o estoque foi devolvido, mas não deu pra confirmar a exclusão no servidor agora (sem internet?). Se o Fechamento #${idCaixa} reaparecer aqui mais tarde, exclua de novo.`);
            }
        }

        // "dd/mm/yyyy hh:mm" (formato usado em dataFechamento) -> Date.
        function parseDataFechamentoBR(dataStr) {
            if (!dataStr) return null;
            const [dataParte] = dataStr.split(' ');
            const [d, m, y] = dataParte.split('/').map(Number);
            if (!d || !m || !y) return null;
            return new Date(y, m - 1, d);
        }

        // Fundiu "Histórico de Caixas" com "Fechamentos por Período" numa tela
        // só — eram quase a mesma coisa (as duas listavam historicoCaixasDB
        // filtrado por data). Ações (ver/imprimir/exportar/excluir) do
        // Histórico + filtro de operador e os 4 cartões de resumo do Por
        // Período, tudo numa única renderização.
        function renderizarHistoricoCaixas() {
            const tbody = document.getElementById('tabela-historico-caixas');
            tbody.innerHTML = '';

            // Limpa da seleção qualquer fechamento que não existe mais
            // (ex: foi excluído) — senão "N selecionado(s)" fica errado.
            [...fechamentosSelecionadosParaRelatorio].forEach(id => {
                if (!historicoCaixasDB.some(c => c.id === id)) fechamentosSelecionadosParaRelatorio.delete(id);
            });
            atualizarBarraFechamentosSelecionados();

            const inicioEl = document.getElementById('filtro-historico-data-inicio');
            const fimEl = document.getElementById('filtro-historico-data-fim');
            const inicio = inicioEl ? inicioEl.value : '';
            const fim = fimEl ? fimEl.value : '';

            const selectOperador = document.getElementById('filtro-historico-operador');
            if (selectOperador && !selectOperador.dataset.montado) {
                const nomes = [...new Set(historicoCaixasDB.map(c => c.usuarioNome).filter(Boolean))];
                selectOperador.innerHTML = '<option value="Todos">Todos os operadores</option>' + nomes.map(n => `<option value="${n}">${n}</option>`).join('');
                selectOperador.dataset.montado = '1';
            }
            const operador = selectOperador ? selectOperador.value : 'Todos';

            let lista = [...historicoCaixasDB];
            if (inicio) {
                const dtInicio = new Date(inicio + 'T00:00:00');
                lista = lista.filter(c => { const d = parseDataFechamentoBR(c.dataFechamento); return d && d >= dtInicio; });
            }
            if (fim) {
                const dtFim = new Date(fim + 'T23:59:59');
                lista = lista.filter(c => { const d = parseDataFechamentoBR(c.dataFechamento); return d && d <= dtFim; });
            }
            if (operador && operador !== 'Todos') {
                lista = lista.filter(c => c.usuarioNome === operador);
            }

            const totalVendas = lista.reduce((a, c) => a + c.totalVendas, 0);
            const qtdPedidosSoma = lista.reduce((a, c) => a + c.qtdPedidos, 0);
            const ticketMedio = qtdPedidosSoma > 0 ? totalVendas / qtdPedidosSoma : 0;

            const elTotalVendas = document.getElementById('hc-total-vendas');
            if (elTotalVendas) {
                elTotalVendas.innerText = totalVendas.toFixed(2);
                document.getElementById('hc-qtd-fechamentos').innerText = lista.length;
                document.getElementById('hc-ticket-medio').innerText = ticketMedio.toFixed(2);
            }

            if (lista.length === 0) {
                return tbody.innerHTML = `<tr><td colspan="9" style="padding: 20px; text-align: center; color: gray;">${historicoCaixasDB.length === 0 ? 'Nenhum caixa foi fechado ainda.' : 'Nenhum fechamento no período filtrado.'}</td></tr>`;
            }

            lista.forEach(c => {
                tbody.innerHTML += `
                    <tr style="border-bottom: 1px solid #e5e7eb;">
                        <td style="text-align:center;"><input type="checkbox" class="chk-fechamento-selecionado" ${fechamentosSelecionadosParaRelatorio.has(c.id) ? 'checked' : ''} onchange="alternarSelecaoFechamento(${c.id}, this.checked)"></td>
                        <td style="padding: 12px; font-weight: bold;">#${c.id}</td>
                        <td style="font-size: 0.85rem; font-weight: bold; color: #4b5563;">${c.usuarioNome || '-'}</td>
                        <td style="font-weight: bold; color: var(--primary); text-transform: uppercase;">${c.campanha || 'Padrão'}</td>
                        <td style="font-size: 0.85rem; color: #4b5563;">${c.dataAbertura}</td>
                        <td style="font-size: 0.85rem; color: #4b5563;">${c.dataFechamento}</td>
                        <td style="font-weight: bold; color: var(--success);">R$ ${c.totalVendas.toFixed(2)}</td>
                        <td style="text-align: center; font-weight: bold;">${c.qtdPedidos}</td>
                        <td>
                            <button onclick="verDetalhesCaixa(${c.id})" class="btn btn-info" style="padding: 6px 10px; font-size: 0.8rem; margin-right:2px;" title="Ver Detalhes">👁️</button>
                            <button onclick="imprimirRelatorioFechamento(${c.id})" class="btn" style="background:#047857; color:white; padding: 6px 10px; font-size: 0.8rem; margin-right:2px;" title="Imprimir Comprovante">🖨️</button>
                            <button onclick="gerarJPGFechamento(${c.id})" class="btn" style="background:#7c3aed; color:white; padding: 6px 10px; font-size: 0.8rem; margin-right:2px;" title="Baixar JPG">🖼️</button>
                            <button onclick="gerarPDFFechamento(${c.id})" class="btn" style="background:#b91c1c; color:white; padding: 6px 10px; font-size: 0.8rem; margin-right:2px;" title="Baixar PDF">📄</button>
                            <button onclick="excluirRegistroCaixa(${c.id})" class="btn btn-danger" style="padding: 6px 10px; font-size: 0.8rem;" title="Excluir Caixa">🗑️</button>
                        </td>
                    </tr>
                `;
            });
        }

        // --- Relatório combinado de vários fechamentos de caixa ---
        // Útil quando mais de um caixa é aberto/fechado no mesmo dia/evento
        // (vários operadores) e o Master quer um relatório só, somado, em
        // vez de imprimir/conferir cada fechamento separado.
        function alternarSelecaoFechamento(id, marcado) {
            if (marcado) fechamentosSelecionadosParaRelatorio.add(id);
            else fechamentosSelecionadosParaRelatorio.delete(id);
            atualizarBarraFechamentosSelecionados();
        }

        function atualizarBarraFechamentosSelecionados() {
            const qtd = fechamentosSelecionadosParaRelatorio.size;
            const barra = document.getElementById('barra-fechamentos-selecionados');
            if (barra) barra.style.display = qtd > 0 ? 'flex' : 'none';
            const txt = document.getElementById('qtd-fechamentos-selecionados');
            if (txt) txt.innerText = qtd;
        }

        function limparSelecaoFechamentos() {
            fechamentosSelecionadosParaRelatorio.clear();
            renderizarHistoricoCaixas();
        }

        function obterFechamentosSelecionados() {
            return historicoCaixasDB
                .filter(c => fechamentosSelecionadosParaRelatorio.has(c.id))
                .sort((a, b) => (parseDataFechamentoBR(a.dataFechamento) || 0) - (parseDataFechamentoBR(b.dataFechamento) || 0));
        }

        function montarResumoCombinado(fechamentos) {
            const totais = { totalVendas: 0, fundoInicial: 0, pix: 0, pixDireto: 0, credito: 0, debito: 0, dinheiroVendas: 0, bonificacao: 0, totalGaveta: 0, qtdPedidos: 0 };
            const produtosVendidos = {};
            const valorProdutosVendidos = {};
            fechamentos.forEach(c => {
                totais.totalVendas += c.totalVendas || 0;
                totais.fundoInicial += c.fundoInicial || 0;
                totais.pix += c.pix || 0;
                totais.pixDireto += c.pixDireto || 0;
                totais.credito += c.credito || 0;
                totais.debito += c.debito || 0;
                totais.dinheiroVendas += c.dinheiroVendas || 0;
                totais.bonificacao += c.bonificacao || 0;
                totais.totalGaveta += c.totalGaveta || 0;
                totais.qtdPedidos += c.qtdPedidos || 0;
                Object.entries(c.produtosVendidos || {}).forEach(([nome, qtd]) => {
                    produtosVendidos[nome] = (produtosVendidos[nome] || 0) + qtd;
                });
                Object.entries(c.valorProdutosVendidos || {}).forEach(([nome, valor]) => {
                    valorProdutosVendidos[nome] = (valorProdutosVendidos[nome] || 0) + valor;
                });
            });
            return { ...totais, produtosVendidos, valorProdutosVendidos };
        }

        function montarHtmlRelatorioCombinado(fechamentos) {
            const resumo = montarResumoCombinado(fechamentos);

            const htmlLista = fechamentos.map(c => `
                <div class="print-row" style="font-size:10px;">
                    <span>#${c.id} ${c.usuarioNome || '-'} (${c.dataFechamento})</span>
                    <span class="print-bold">R$ ${(c.totalVendas || 0).toFixed(2)}</span>
                </div>
            `).join('');

            let htmlProdsPrint = '';
            if (Object.keys(resumo.produtosVendidos).length > 0) {
                Object.entries(resumo.produtosVendidos).sort((a, b) => b[1] - a[1]).forEach(([prod, qtd]) => {
                    const linha = formatarLinhaProdutoVendido(prod, qtd, resumo.valorProdutosVendidos);
                    htmlProdsPrint += `<div class="print-row"><span>${prod}</span><span class="print-bold">${linha.qtdTxt}</span></div>`;
                });
            }

            return `
                <div class="print-center print-bold" style="font-size: 18px;">SANTUÁRIO SANTA RITA</div>
                <div class="print-center print-bold" style="font-size: 14px; margin-top: 5px;">RELATÓRIO COMBINADO</div>
                <div class="print-center print-bold" style="font-size: 12px; margin-top: 2px;">${fechamentos.length} FECHAMENTOS DE CAIXA</div>
                <div class="print-divider"></div>
                ${htmlLista}
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="font-size: 13px; margin-bottom:2px;">FATURAMENTO TOTAL</div>
                <div class="print-center print-bold" style="font-size: 28px; margin-bottom:5px;">R$ ${resumo.totalVendas.toFixed(2)}</div>
                <div class="print-divider"></div>
                <div class="print-row"><span>Fundo Inicial (soma):</span><span class="print-bold">R$ ${resumo.fundoInicial.toFixed(2)}</span></div>
                <div class="print-row"><span>Qtd de Pedidos:</span><span class="print-bold">${resumo.qtdPedidos}</span></div>
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-bottom: 5px;">DETALHAMENTO FORMAS PAGTO</div>
                <div class="print-row"><span>💳 Cartão Débito:</span><span class="print-bold">R$ ${resumo.debito.toFixed(2)}</span></div>
                <div class="print-row"><span>💳 Cartão Crédito:</span><span class="print-bold">R$ ${resumo.credito.toFixed(2)}</span></div>
                <div class="print-row"><span>📱 Pix (Máquina):</span><span class="print-bold">R$ ${resumo.pix.toFixed(2)}</span></div>
                <div class="print-row"><span>💵 Dinheiro Vendas:</span><span class="print-bold">R$ ${resumo.dinheiroVendas.toFixed(2)}</span></div>
                <div class="print-row"><span>📲 Pix Direto (Conta):</span><span class="print-bold">R$ ${resumo.pixDireto.toFixed(2)}</span></div>
                <div class="print-divider"></div>
                <div class="print-row print-bold" style="font-size: 15px;"><span>TOTAL GAVETA (soma):</span><span>R$ ${resumo.totalGaveta.toFixed(2)}</span></div>
                ${htmlProdsPrint ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">PRODUTOS VENDIDOS (TODOS OS CAIXAS)</div>${htmlProdsPrint}` : ''}
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-top: 10px; font-size: 11px;">Relatório combinado emitido para conferência interna.</div>
            `;
        }

        function imprimirRelatorioCombinado() {
            const fechamentos = obterFechamentosSelecionados();
            if (fechamentos.length === 0) return exibirAviso('Selecione pelo menos um fechamento pra gerar o relatório combinado.');
            if (fechamentos.length === 1) return imprimirRelatorioFechamento(fechamentos[0].id);
            document.getElementById('area-impressao').innerHTML = montarHtmlRelatorioCombinado(fechamentos);
            dispararImpressao();
        }

        // area-impressao normalmente é display:none (só aparece via
        // @media print) — pra tirar JPG/PDF precisa deixar visível
        // temporariamente antes do html2canvas capturar, e esconder de novo
        // depois (independente de sucesso ou erro).
        // Monta um objeto no MESMO formato de um item de historicoCaixasDB,
        // só que com os totais somados de vários fechamentos — permite
        // reaproveitar renderizarDetalhesCaixaNoModal (com os gráficos e
        // tudo) sem duplicar template nenhum. Mesma ideia de
        // verMeuRelatorioCaixa (que já monta um objeto sintético parecido
        // pro caixa ainda aberto).
        function montarObjetoFechamentoCombinado(fechamentos) {
            const resumo = montarResumoCombinado(fechamentos);
            return {
                id: fechamentos.map(f => f.id).join(' + '),
                campanha: `${fechamentos.length} fechamentos combinados`,
                dataAbertura: fechamentos[0].dataAbertura,
                dataFechamento: fechamentos[fechamentos.length - 1].dataFechamento,
                fundoInicial: resumo.fundoInicial,
                totalVendas: resumo.totalVendas,
                pix: resumo.pix,
                pixDireto: resumo.pixDireto,
                credito: resumo.credito,
                debito: resumo.debito,
                dinheiroVendas: resumo.dinheiroVendas,
                totalGaveta: resumo.totalGaveta,
                qtdPedidos: resumo.qtdPedidos,
                produtosVendidos: resumo.produtosVendidos,
                valorProdutosVendidos: resumo.valorProdutosVendidos,
                pedidosDetalhados: fechamentos.flatMap(f => f.pedidosDetalhados || [])
            };
        }

        // "Ver Combinado" abre o MESMO modal rico (com gráficos) que "Ver
        // Detalhes" de um fechamento só — só muda o objeto que alimenta ele.
        function verDetalhesCombinado() {
            const fechamentos = obterFechamentosSelecionados();
            if (fechamentos.length === 0) return exibirAviso('Selecione pelo menos um fechamento pra ver combinado.');
            if (fechamentos.length === 1) return verDetalhesCaixa(fechamentos[0].id);
            renderizarDetalhesCaixaNoModal(montarObjetoFechamentoCombinado(fechamentos));
        }

        // JPG/PDF do combinado agora reaproveita o mesmo modal de "Ver
        // Detalhes" (igual gerarJPGFechamento/gerarPDFFechamento fazem pra
        // um fechamento só) em vez do template estreito de impressora
        // térmica — ficava com visual bem diferente dos outros relatórios.
        function gerarJPGRelatorioCombinado() {
            const fechamentos = obterFechamentosSelecionados();
            if (fechamentos.length === 0) return exibirAviso('Selecione pelo menos um fechamento pra gerar o relatório combinado.');
            verDetalhesCombinado();
            setTimeout(() => {
                const el = document.querySelector('#modal-detalhes-caixa .modal-content');
                if (!el || typeof html2canvas !== 'function') return;
                const restaurar = expandirRolaveisParaCaptura(el);
                html2canvas(el, { scale: 2 }).then(canvas => {
                    restaurar();
                    const link = document.createElement('a');
                    link.download = `Relatorio_Combinado_${fechamentos.length}_caixas.jpg`;
                    link.href = canvas.toDataURL('image/jpeg', 0.92);
                    link.click();
                    fecharModalDetalhesCaixa();
                }).catch(restaurar);
            }, 150);
        }

        function gerarPDFRelatorioCombinado() {
            const fechamentos = obterFechamentosSelecionados();
            if (fechamentos.length === 0) return exibirAviso('Selecione pelo menos um fechamento pra gerar o relatório combinado.');
            verDetalhesCombinado();
            setTimeout(() => {
                const el = document.querySelector('#modal-detalhes-caixa .modal-content');
                if (!el || typeof html2pdf !== 'function') return;
                const restaurar = expandirRolaveisParaCaptura(el);
                html2pdf().set({
                    margin: 10,
                    filename: `Relatorio_Combinado_${fechamentos.length}_caixas.pdf`,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2 },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                }).from(el).save().then(() => {
                    restaurar();
                    fecharModalDetalhesCaixa();
                }).catch(restaurar);
            }, 150);
        }

        function verDetalhesCaixa(idCaixa) {
            const c = historicoCaixasDB.find(item => item.id === idCaixa);
            if (!c) return;
            renderizarDetalhesCaixaNoModal(c);
        }

        // Mesmo modal de "Ver Detalhes" do Histórico, mas alimentado com dados
        // AO VIVO do caixa do usuário logado (ainda aberto, não fechado) — é o
        // que o botão 👁️ na tela de Pedido abre.
        function verMeuRelatorioCaixa() {
            const meuCaixa = caixaDoUsuarioAtual();
            if (!meuCaixa) return exibirAviso("Você não tem caixa aberto.");
            const dados = obterDadosRelatorioCaixa(meuCaixa.id);
            const pedidosDoCaixa = pedidosGerais.filter(p => p.caixaId === meuCaixa.id);
            renderizarDetalhesCaixaNoModal({
                id: meuCaixa.id,
                campanha: 'Caixa em aberto',
                dataAbertura: meuCaixa.dataHoraAbertura,
                dataFechamento: 'Em aberto',
                fundoInicial: meuCaixa.valorFundoCaixa,
                totalVendas: dados.totalVendas,
                pix: dados.fatPix,
                pixDireto: dados.fatPixDireto,
                credito: dados.fatCredito,
                debito: dados.fatDebito,
                dinheiroVendas: dados.fatDinheiro,
                totalGaveta: dados.totalGaveta,
                qtdPedidos: dados.validos.length,
                produtosVendidos: dados.resumoProdutosVendidos,
                valorProdutosVendidos: dados.valorProdutosVendidos,
                pedidosDetalhados: pedidosDoCaixa
            });
        }

        // Usado nos relatórios de fechamento (modal de detalhes e impressão) —
        // c.pedidosDetalhados guarda o snapshot completo dos pedidos daquele
        // caixa, incluindo os pagos como bonificação (que já ficam fora de
        // "Produtos Vendidos"/faturamento). Extrai só esses pra mostrar em
        // separado: quantidade, descrição do que saiu e pra quem foi.
        function extrairBonificacoesDoFechamento(c) {
            if (!c.pedidosDetalhados) return [];
            return c.pedidosDetalhados.filter(p => p.statusPainel !== 'cancelado' && p.pagamento && p.pagamento.startsWith('Bonificação'));
        }

        // Soma, produto a produto, tudo que foi vendido + bonificado em todos
        // os fechamentos de caixa (historicoCaixasDB) dentro do período —
        // mesma filtragem por data de renderizarHistoricoCaixas(), só que
        // agrupado por PRODUTO em vez de por fechamento. Não inclui caixas
        // ainda abertos (só o que já foi fechado tem produtosVendidos
        // consolidado). Combo já entra pelo nome do sub-item escolhido, igual
        // ao resto do app (ver fecharCaixaPrompt).
        function calcularResumoProdutosPorPeriodo(dataInicio, dataFim) {
            const resumo = {};
            const garantir = nome => resumo[nome] || (resumo[nome] = { qtdVendida: 0, qtdBonificada: 0, valorVendido: 0, valorAproximado: false });

            let lista = [...historicoCaixasDB];
            if (dataInicio) {
                const dtInicio = new Date(dataInicio + 'T00:00:00');
                lista = lista.filter(c => { const d = parseDataFechamentoBR(c.dataFechamento); return d && d >= dtInicio; });
            }
            if (dataFim) {
                const dtFim = new Date(dataFim + 'T23:59:59');
                lista = lista.filter(c => { const d = parseDataFechamentoBR(c.dataFechamento); return d && d <= dtFim; });
            }

            lista.forEach(c => {
                Object.entries(c.produtosVendidos || {}).forEach(([nome, qtd]) => {
                    const registro = garantir(nome);
                    registro.qtdVendida += qtd;
                    const valorHistorico = (c.valorProdutosVendidos || {})[nome];
                    if (valorHistorico !== undefined) {
                        registro.valorVendido += valorHistorico;
                    } else {
                        // Fechamento salvo antes do valor histórico por produto
                        // existir (ou registro antigo sem esse campo) — aproxima
                        // pelo preço ATUAL do catálogo, mesmo fallback já usado
                        // em formatarLinhaProdutoVendido pros outros relatórios.
                        // Sem isso, todo fechamento antigo contava 0 aqui mesmo
                        // tendo vendido de verdade.
                        const prod = produtosDB.find(p => p.nome === nome);
                        if (prod) { registro.valorVendido += prod.preco * qtd; registro.valorAproximado = true; }
                    }
                });
                extrairBonificacoesDoFechamento(c).forEach(pedido => {
                    (pedido.itens || []).forEach(item => {
                        if (item.isCombo && Array.isArray(item.itensComboEscolhidos) && item.itensComboEscolhidos.length > 0) {
                            item.itensComboEscolhidos.forEach(sub => { garantir(sub.nome).qtdBonificada += 1; });
                        } else {
                            garantir(item.nome).qtdBonificada += item.qtd;
                        }
                    });
                });
            });

            // Além dos caixas já FECHADOS (acima), soma também o que está
            // sendo vendido AGORA nos caixas ainda abertos — senão a venda
            // só aparecia aqui depois de alguém fechar o caixa, e a tela
            // parecia "parada" o dia inteiro. Só entra se o filtro de data
            // não exclui hoje (filtrar só um período passado não deveria
            // trazer venda de agora).
            const agora = new Date();
            const inicioDoDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
            const incluiHoje = (!dataInicio || new Date(dataInicio + 'T00:00:00') <= agora)
                && (!dataFim || new Date(dataFim + 'T23:59:59') >= inicioDoDia);
            if (incluiHoje) {
                const dadosAoVivo = obterDadosRelatorioCaixa(null);
                Object.entries(dadosAoVivo.resumoProdutosVendidos).forEach(([nome, qtd]) => {
                    const registro = garantir(nome);
                    registro.qtdVendida += qtd;
                    registro.valorVendido += (dadosAoVivo.valorProdutosVendidos[nome] || 0);
                });
                dadosAoVivo.bonificacoesLista.forEach(pedido => {
                    (pedido.itens || []).forEach(item => {
                        if (item.isCombo && Array.isArray(item.itensComboEscolhidos) && item.itensComboEscolhidos.length > 0) {
                            item.itensComboEscolhidos.forEach(sub => { garantir(sub.nome).qtdBonificada += 1; });
                        } else {
                            garantir(item.nome).qtdBonificada += item.qtd;
                        }
                    });
                });
            }

            return resumo;
        }

        function renderizarProdutosPorPeriodo() {
            const tbody = document.getElementById('tabela-produtos-periodo');
            if (!tbody) return;

            const inicio = document.getElementById('filtro-produtos-periodo-inicio').value;
            const fim = document.getElementById('filtro-produtos-periodo-fim').value;
            const busca = document.getElementById('filtro-produtos-periodo-nome').value.trim().toLowerCase();

            const resumo = calcularResumoProdutosPorPeriodo(inicio, fim);
            let linhas = Object.entries(resumo);
            if (busca) linhas = linhas.filter(([nome]) => nome.toLowerCase().includes(busca));
            linhas.sort((a, b) => (b[1].qtdVendida + b[1].qtdBonificada) - (a[1].qtdVendida + a[1].qtdBonificada));

            let totalQtd = 0, totalBonificada = 0, totalValor = 0;
            linhas.forEach(([, d]) => { totalQtd += d.qtdVendida; totalBonificada += d.qtdBonificada; totalValor += d.valorVendido; });

            document.getElementById('pp-total-qtd').innerText = totalQtd;
            document.getElementById('pp-total-bonificada').innerText = totalBonificada;
            document.getElementById('pp-total-valor').innerText = totalValor.toFixed(2);
            document.getElementById('pp-total-geral').innerText = totalQtd + totalBonificada;

            if (linhas.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="padding: 20px; text-align: center; color: gray;">${historicoCaixasDB.length === 0 ? 'Nenhum caixa foi fechado ainda.' : 'Nenhum produto no período/busca filtrado.'}</td></tr>`;
                return;
            }

            const temValorAproximado = linhas.some(([, d]) => d.valorAproximado);
            tbody.innerHTML = linhas.map(([nome, d]) => `
                <tr style="border-bottom: 1px solid #e5e7eb;">
                    <td style="padding: 10px; font-weight: bold;">${nome}</td>
                    <td style="text-align:center; font-weight: bold; color: var(--primary);">${d.qtdVendida}</td>
                    <td style="text-align:center; font-weight: bold; color: ${d.qtdBonificada > 0 ? '#dc2626' : '#9ca3af'};">${d.qtdBonificada}</td>
                    <td style="text-align:center; font-weight: 900; color: #7c3aed;">${d.qtdVendida + d.qtdBonificada}</td>
                    <td style="text-align:right; font-weight: bold; color: var(--success);">R$ ${d.valorVendido.toFixed(2)}${d.valorAproximado ? '*' : ''}</td>
                </tr>
            `).join('') + (temValorAproximado ? `<tr><td colspan="5" style="padding:6px 10px; font-size:0.7rem; color:gray;">* valor estimado pelo preço atual do produto (fechamento salvo antes do valor histórico ser guardado, ou produto removido do catálogo)</td></tr>` : '');
        }

        function gerarPDFProdutosPeriodo() {
            const el = document.getElementById('tela-produtos-periodo');
            if (!el || typeof html2pdf !== 'function') return;
            const restaurar = expandirRolaveisParaCaptura(el);
            html2pdf().set({
                margin: 10,
                filename: `Produtos_Por_Periodo_${new Date().toISOString().slice(0,10)}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2 },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            }).from(el).save().then(restaurar).catch(restaurar);
        }

        const ROTULOS_TIPO_LOG = {
            login: { texto: '🔑 Login', cor: '#2563eb' },
            offline: { texto: '🔴 Ficou offline', cor: '#dc2626' },
            online: { texto: '🟢 Voltou online', cor: '#16a34a' },
            erro: { texto: '⚠️ Erro', cor: '#d97706' }
        };

        function renderizarTabelaLogs(linhas) {
            const tbody = document.getElementById('tabela-logs-sistema');
            if (!tbody) return;
            if (linhas.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="padding:20px; text-align:center; color:gray;">Nenhum evento encontrado.</td></tr>';
                return;
            }
            tbody.innerHTML = linhas.map(l => {
                const rotulo = ROTULOS_TIPO_LOG[l.tipo] || { texto: l.tipo, cor: '#374151' };
                const dataHora = new Date(l.criado_em).toLocaleString('pt-BR');
                return `
                    <tr style="border-bottom: 1px solid #e5e7eb;">
                        <td style="padding: 8px; white-space:nowrap;">${dataHora}</td>
                        <td style="font-weight:bold; color:${rotulo.cor};">${rotulo.texto}</td>
                        <td>${l.usuario_nome || '-'}</td>
                        <td>${l.tela || '-'}</td>
                        <td style="max-width:320px;">${l.detalhe || '-'}</td>
                        <td style="font-size:0.75rem; color:gray;" title="${l.client_id || ''}">${l.client_id ? l.client_id.slice(0, 8) : '-'}</td>
                    </tr>
                `;
            }).join('');
        }

        // Busca direto no Supabase (pdv_logs) — não faz parte de
        // pedidosGerais/pdv_state, então não passa por
        // montarEstadoAtual/aplicarEstado nem pelo cache local; é sempre uma
        // consulta fresca. Exclusiva do Master (ver usuarioTemAcesso).
        async function carregarLogsSistema() {
            const tbody = document.getElementById('tabela-logs-sistema');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="6" style="padding:20px; text-align:center; color:gray;">Carregando...</td></tr>';

            const tipo = document.getElementById('filtro-logs-tipo').value;
            const usuarioBusca = document.getElementById('filtro-logs-usuario').value.trim();
            const inicio = document.getElementById('filtro-logs-data-inicio').value;
            const fim = document.getElementById('filtro-logs-data-fim').value;

            let consulta = supabaseClient.from('pdv_logs').select('*').order('criado_em', { ascending: false }).limit(500);
            if (tipo) consulta = consulta.eq('tipo', tipo);
            if (usuarioBusca) consulta = consulta.ilike('usuario_nome', `%${usuarioBusca}%`);
            if (inicio) consulta = consulta.gte('criado_em', `${inicio}T00:00:00`);
            if (fim) consulta = consulta.lte('criado_em', `${fim}T23:59:59`);

            try {
                const { data, error } = await consulta;
                if (error) throw error;
                renderizarTabelaLogs(data || []);
            } catch (erro) {
                console.error('Falha ao carregar logs do sistema:', erro);
                tbody.innerHTML = '<tr><td colspan="6" style="padding:20px; text-align:center; color:var(--danger);">Não foi possível carregar os logs. A tabela pdv_logs existe no Supabase? (ver supabase/pdv_logs.sql)</td></tr>';
            }
        }

        // Monta "94 un. — R$ 2.350,00" pra lista de Produtos Vendidos. Usa o
        // valor já calculado na hora do fechamento (mapaValor); fechamentos
        // salvos antes dessa função existir não têm esse campo, então cai
        // pro preço ATUAL do catálogo × quantidade como aproximação (avisado
        // como tal, já que o preço pode ter mudado desde a venda).
        function formatarLinhaProdutoVendido(nome, qtd, mapaValor) {
            let valor = mapaValor ? mapaValor[nome] : undefined;
            let aproximado = false;
            if (valor === undefined) {
                const prod = produtosDB.find(p => p.nome === nome);
                if (prod) { valor = prod.preco * qtd; aproximado = true; }
            }
            const valorTxt = valor !== undefined ? ` — R$ ${valor.toFixed(2)}${aproximado ? '*' : ''}` : '';
            return { qtdTxt: `${qtd} un.${valorTxt}`, aproximado };
        }

        function renderizarDetalhesCaixaNoModal(c) {
            document.getElementById('titulo-detalhe-caixa').innerText = `Caixa #${c.id} - ${c.campanha || 'Fechamento'}`;
            const corpo = document.getElementById('corpo-detalhes-caixa');

            let htmlProds = '';
            let temValorAproximado = false;
            if (c.produtosVendidos && Object.keys(c.produtosVendidos).length > 0) {
                Object.entries(c.produtosVendidos).sort((a, b) => b[1] - a[1]).forEach(([prod, qtd]) => {
                    const linha = formatarLinhaProdutoVendido(prod, qtd, c.valorProdutosVendidos);
                    if (linha.aproximado) temValorAproximado = true;
                    htmlProds += `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed #eee;"><span>${prod}</span><b>${linha.qtdTxt}</b></div>`;
                });
                if (temValorAproximado) htmlProds += `<div style="font-size:0.7rem; color:gray; margin-top:6px;">* valor estimado pelo preço atual do produto (fechamento salvo antes do valor histórico ser guardado)</div>`;
            } else {
                htmlProds = '<p style="color:gray;">Nenhum produto registrado.</p>';
            }

            const topProdutosCaixa = Object.entries(c.produtosVendidos || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);

            // Fechamento de antes desta funcionalidade existir (ou o
            // relatório combinado, que nunca grava snapshot próprio) não tem
            // custoProducaoEstimado salvo — recalcula ao vivo com o catálogo
            // e as taxas ATUAIS como estimativa, marcado como aproximado.
            // Mesmo raciocínio de valorProdutosVendidos/aproximado acima.
            let custoProducaoCaixa = c.custoProducaoEstimado;
            let custoTaxasCaixa = c.custoTaxasEstimado;
            let lucroRealCaixa = c.lucroRealEstimado;
            let custoAproximado = false;
            if (custoProducaoCaixa === null || custoProducaoCaixa === undefined) {
                custoAproximado = true;
                const { custoTotal } = calcularCustoProducaoTotal(c.pedidosDetalhados || []);
                custoProducaoCaixa = custoTotal;
                const taxaCredito = configPadroes.taxaCredito || 0, taxaDebito = configPadroes.taxaDebito || 0, taxaPix = configPadroes.taxaPix || 0;
                custoTaxasCaixa = (c.credito || 0) * taxaCredito / 100 + (c.debito || 0) * taxaDebito / 100 + (c.pix || 0) * taxaPix / 100;
                lucroRealCaixa = c.totalVendas - custoProducaoCaixa - custoTaxasCaixa;
            }

            const bonificacoesFechamento = extrairBonificacoesDoFechamento(c);
            let htmlBono = '';
            if (bonificacoesFechamento.length > 0) {
                htmlBono = bonificacoesFechamento.map(b => {
                    const resumo = b.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ');
                    return `<div style="font-size:0.85rem; margin-bottom:6px; padding-bottom:6px; border-bottom:1px dashed #fecaca;"><b>#${rotuloPedido(b)} ${b.cliente}:</b> ${resumo}<br><small style="color:#991b1b;">${b.pagamento}</small></div>`;
                }).join('');
            } else {
                htmlBono = '<p style="color:gray; font-size:0.85rem;">Nenhuma bonificação neste caixa.</p>';
            }

            corpo.innerHTML = `
                <div style="background:#f8fafc; padding:12px; border-radius:8px; margin-bottom:15px; font-size:0.9rem;">
                    <div><b>Campanha/Evento:</b> <span style="color:var(--primary); font-weight:bold; text-transform:uppercase;">${c.campanha || 'Geral'}</span></div>
                    <div><b>Abertura:</b> ${c.dataAbertura}</div>
                    <div><b>Fechamento:</b> ${c.dataFechamento}</div>
                    <div style="margin-top:5px;"><b>Fundo Inicial:</b> R$ ${c.fundoInicial.toFixed(2)} | <b>Qtd Pedidos:</b> ${c.qtdPedidos}</div>
                </div>

                <div style="background:#dcfce7; border:2px solid #16a34a; padding:15px; border-radius:8px; text-align:center; margin-bottom:15px;">
                    <div style="font-size:0.9rem; font-weight:bold; color:#14532d; text-transform:uppercase;">Faturamento Total de Vendas</div>
                    <div style="font-size:2.2rem; font-weight:900; color:#15803d;">R$ ${c.totalVendas.toFixed(2)}</div>
                </div>

                <h4 style="margin:10px 0 5px 0; color:#1f2937;">💰 Custo & Lucro Real (interno — nunca aparece pro cliente)</h4>
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; margin-bottom:6px; font-size:0.9rem;">
                    <div style="background:#fffbeb; padding:10px; border-radius:6px; text-align:center;">💰 <b>Produção:</b><br>R$ ${custoProducaoCaixa.toFixed(2)}</div>
                    <div style="background:#f3e8ff; padding:10px; border-radius:6px; text-align:center;">💳 <b>Taxas:</b><br>R$ ${custoTaxasCaixa.toFixed(2)}</div>
                    <div style="background:#dcfce7; padding:10px; border-radius:6px; text-align:center; color:#15803d; font-weight:bold;">📈 <b>Lucro Real:</b><br>R$ ${lucroRealCaixa.toFixed(2)}</div>
                </div>
                <div style="font-size:0.7rem; color:gray; margin-bottom:15px;">${custoAproximado ? '* estimado com o catálogo/taxas atuais (fechamento salvo antes desse cálculo existir, ou relatório combinado)' : ''}</div>

                <h4 style="margin:10px 0 5px 0; color:#1f2937;">💳 Formas de Pagamento Entradas</h4>
                <div style="background:white; border:1px solid #e5e7eb; border-radius:8px; padding:10px; margin-bottom:10px;">
                    <canvas id="chart-pagamento-caixa" style="max-height:220px;"></canvas>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:15px; font-size:0.9rem;">
                    <div style="background:#f3e8ff; padding:10px; border-radius:6px;">💳 <b>Débito:</b> R$ ${c.debito.toFixed(2)}</div>
                    <div style="background:#fef3c7; padding:10px; border-radius:6px;">💳 <b>Crédito:</b> R$ ${c.credito.toFixed(2)}</div>
                    <div style="background:#ecfeff; padding:10px; border-radius:6px;">📱 <b>Pix (Máquina):</b> R$ ${c.pix.toFixed(2)}</div>
                    <div style="background:#dcfce7; padding:10px; border-radius:6px;">💵 <b>Dinheiro (Vendas):</b> R$ ${c.dinheiroVendas.toFixed(2)}</div>
                    <div style="background:#e0f2fe; padding:10px; border-radius:6px;">📲 <b>Pix Direto (Conta):</b> R$ ${(c.pixDireto || 0).toFixed(2)}</div>
                </div>

                <div style="display:flex; justify-content:space-between; background:#e0f2fe; padding:12px; border-radius:8px; font-weight:bold; font-size:1.05rem; color:#0369a1; margin-bottom:15px;">
                    <span>TOTAL GAVETA (Dinheiro + Fundo):</span>
                    <span>R$ ${c.totalGaveta.toFixed(2)}</span>
                </div>

                <h4 style="margin:10px 0 5px 0; color:#1f2937;">🏆 Produtos Mais Vendidos</h4>
                <div style="background:white; border:1px solid #e5e7eb; border-radius:8px; padding:10px; margin-bottom:15px;">
                    <canvas id="chart-produtos-caixa" style="max-height:260px;"></canvas>
                </div>

                <h4 style="margin:10px 0 5px 0; color:#1f2937;">📦 Produtos Vendidos</h4>
                <div style="background:white; border:1px solid #e5e7eb; padding:10px; border-radius:8px; max-height:150px; overflow-y:auto; margin-bottom:15px;">
                    ${htmlProds}
                </div>

                <h4 style="margin:10px 0 5px 0; color:#dc2626;">🎁 Itens Bonificados (Cortesias)</h4>
                <div style="background:#fef2f2; border:1px solid #fecaca; padding:10px; border-radius:8px; max-height:180px; overflow-y:auto;">
                    ${htmlBono}
                </div>
            `;

            document.getElementById('modal-detalhes-caixa').style.display = 'flex';

            if (chartPagamentoCaixa) chartPagamentoCaixa.destroy();
            if (chartProdutosCaixa) chartProdutosCaixa.destroy();

            const labelsPagto = ['💳 Débito', '💳 Crédito', '📱 Pix (Máquina)', '💵 Dinheiro', '📲 Pix Direto'];
            const valoresPagto = [c.debito, c.credito, c.pix, c.dinheiroVendas, c.pixDireto || 0];
            chartPagamentoCaixa = new Chart(document.getElementById('chart-pagamento-caixa').getContext('2d'), {
                type: 'doughnut',
                data: { labels: labelsPagto, datasets: [{ data: valoresPagto, backgroundColor: ['#8b5cf6', '#f59e0b', '#0ea5e9', '#16a34a', '#0284c7'] }] },
                options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { datalabels: { color: '#fff', font: { weight: 'bold', size: 11 }, formatter: (v, ctx) => {
                    if (!v) return '';
                    const total = ctx.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
                    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
                    return `R$ ${v.toFixed(0)} (${pct}%)`;
                } } } }
            });

            chartProdutosCaixa = new Chart(document.getElementById('chart-produtos-caixa').getContext('2d'), {
                type: 'bar',
                data: { labels: topProdutosCaixa.map(i => i[0]), datasets: [{ label: 'Unidades Vendidas', data: topProdutosCaixa.map(i => i[1]), backgroundColor: '#2563eb', borderRadius: 4 }] },
                options: { responsive: true, maintainAspectRatio: false, animation: false, indexAxis: 'y', plugins: { datalabels: { anchor: 'end', align: 'end', color: '#1f2937', font: { weight: 'bold' }, formatter: formatarQtd } } }
            });
        }

        function fecharModalDetalhesCaixa() {
            document.getElementById('modal-detalhes-caixa').style.display = 'none';
        }

        function imprimirRelatorioFechamento(idFechamento) {
            const c = historicoCaixasDB.find(item => item.id === idFechamento);
            if (!c) return;

            // Mesmo fallback aproximado de renderizarDetalhesCaixaNoModal —
            // fechamento de antes desta funcionalidade existir recalcula ao
            // vivo com o catálogo/taxas atuais.
            let custoProducaoCaixa = c.custoProducaoEstimado;
            let custoTaxasCaixa = c.custoTaxasEstimado;
            let lucroRealCaixa = c.lucroRealEstimado;
            if (custoProducaoCaixa === null || custoProducaoCaixa === undefined) {
                const { custoTotal } = calcularCustoProducaoTotal(c.pedidosDetalhados || []);
                custoProducaoCaixa = custoTotal;
                const taxaCredito = configPadroes.taxaCredito || 0, taxaDebito = configPadroes.taxaDebito || 0, taxaPix = configPadroes.taxaPix || 0;
                custoTaxasCaixa = (c.credito || 0) * taxaCredito / 100 + (c.debito || 0) * taxaDebito / 100 + (c.pix || 0) * taxaPix / 100;
                lucroRealCaixa = c.totalVendas - custoProducaoCaixa - custoTaxasCaixa;
            }

            let htmlProdsPrint = '';
            if (c.produtosVendidos && Object.keys(c.produtosVendidos).length > 0) {
                Object.entries(c.produtosVendidos).sort((a, b) => b[1] - a[1]).forEach(([prod, qtd]) => {
                    const linha = formatarLinhaProdutoVendido(prod, qtd, c.valorProdutosVendidos);
                    htmlProdsPrint += `<div class="print-row"><span>${prod}</span><span class="print-bold">${linha.qtdTxt}</span></div>`;
                });
            }

            let htmlBonoPrint = '';
            extrairBonificacoesDoFechamento(c).forEach(b => {
                const resumo = b.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ');
                htmlBonoPrint += `<div style="font-size:11px; margin-bottom:3px; font-weight:bold;"><b>#${rotuloPedido(b)} ${b.cliente}:</b> ${resumo} (${b.pagamento})</div>`;
            });

            const areaPrint = document.getElementById('area-impressao');
            areaPrint.innerHTML = `
                <div class="print-center print-bold" style="font-size: 18px;">SANTUÁRIO SANTA RITA</div>
                <div class="print-center print-bold" style="font-size: 14px; margin-top: 5px;">FECHAMENTO DE CAIXA #${c.id}</div>
                <div class="print-center print-bold" style="font-size: 12px; margin-top: 2px; text-transform:uppercase;">EVENTO: ${c.campanha || 'GERAL'}</div>
                <div class="print-divider"></div>
                <div style="font-size: 11px; font-weight:bold;">
                    <div><b>Operador:</b> ${c.usuarioNome || '-'}</div>
                    <div><b>Abertura:</b> ${c.dataAbertura}</div>
                    <div><b>Fechamento:</b> ${c.dataFechamento}</div>
                </div>
                <div class="print-divider"></div>
                
                <div class="print-center print-bold" style="font-size: 13px; margin-bottom:2px;">FATURAMENTO TOTAL</div>
                <div class="print-center print-bold" style="font-size: 28px; margin-bottom:5px;">R$ ${c.totalVendas.toFixed(2)}</div>
                
                <div class="print-divider"></div>
                <div class="print-row"><span>Fundo Inicial:</span><span class="print-bold">R$ ${c.fundoInicial.toFixed(2)}</span></div>
                <div class="print-row"><span>Qtd de Pedidos:</span><span class="print-bold">${c.qtdPedidos}</span></div>
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-bottom: 5px;">DETALHAMENTO FORMAS PAGTO</div>
                <div class="print-row"><span>💳 Cartão Débito:</span><span class="print-bold">R$ ${c.debito.toFixed(2)}</span></div>
                <div class="print-row"><span>💳 Cartão Crédito:</span><span class="print-bold">R$ ${c.credito.toFixed(2)}</span></div>
                <div class="print-row"><span>📱 Pix (Máquina):</span><span class="print-bold">R$ ${c.pix.toFixed(2)}</span></div>
                <div class="print-row"><span>💵 Dinheiro Vendas:</span><span class="print-bold">R$ ${c.dinheiroVendas.toFixed(2)}</span></div>
                <div class="print-row"><span>📲 Pix Direto (Conta):</span><span class="print-bold">R$ ${(c.pixDireto || 0).toFixed(2)}</span></div>
                <div class="print-divider"></div>
                <div class="print-row print-bold" style="font-size: 15px;"><span>TOTAL GAVETA:</span><span>R$ ${c.totalGaveta.toFixed(2)}</span></div>
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-bottom:5px;">💰 CUSTO & LUCRO REAL (interno)</div>
                <div class="print-row"><span>Custo de Produção:</span><span class="print-bold">R$ ${custoProducaoCaixa.toFixed(2)}</span></div>
                <div class="print-row"><span>Custo de Taxas:</span><span class="print-bold">R$ ${custoTaxasCaixa.toFixed(2)}</span></div>
                <div class="print-row print-bold" style="font-size: 15px;"><span>LUCRO REAL:</span><span>R$ ${lucroRealCaixa.toFixed(2)}</span></div>
                ${htmlProdsPrint ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">PRODUTOS VENDIDOS</div>${htmlProdsPrint}` : ''}
                ${htmlBonoPrint ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">🎁 BONIFICAÇÕES / CORTESIAS</div>${htmlBonoPrint}` : ''}
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-top: 10px; font-size: 11px;">
                    Relatório emitido para conferência interna.
                </div>
            `;

            dispararImpressao();
        }

        // Widget de caixa na tela de Pedido (substitui o antigo bloco fixo de
        // "Abertura de Caixa" que ficava no Dashboard — agora cada usuário
        // abre/fecha o próprio caixa por aqui, sem precisar sair da tela de
        // venda). Mostra o caixa do usuário logado e, pra quem tem permissão,
        // uma lista dos demais caixas abertos na barraca (útil se alguém
        // esqueceu de fechar o dele).
        function atualizarInterfaceCaixa() {
            const painel = document.getElementById('painel-caixa-pedido');
            if (!painel) return;

            const meuCaixa = caixaDoUsuarioAtual();
            let html = '';

            if (meuCaixa) {
                html += `
                    <div class="badge-caixa badge-caixa-aberto">
                        💰 Seu caixa: R$ ${meuCaixa.valorFundoCaixa.toFixed(2)} (${meuCaixa.dataHoraAbertura})
                        <button class="btn btn-danger" style="padding:4px 8px; font-size:0.75rem; margin-left:6px;" onclick="fecharCaixaPrompt('${meuCaixa.id}')">🔒 Fechar</button>
                    </div>`;
            } else if (usuarioPodeAbrirFecharCaixa()) {
                html += `
                    <div class="badge-caixa badge-caixa-fechado">
                        🔒 Você não tem caixa aberto
                        <button class="btn btn-success" style="padding:4px 8px; font-size:0.75rem; margin-left:6px;" onclick="abrirCaixaPrompt()">🟢 Abrir Caixa</button>
                    </div>`;
            } else {
                html += `<div class="badge-caixa badge-caixa-fechado">🔒 Peça pra alguém com acesso abrir o caixa</div>`;
            }

            const outrosCaixas = caixasAbertos.filter(c => !c.fechado && (!meuCaixa || c.id !== meuCaixa.id));
            if (usuarioPodeAbrirFecharCaixa() && outrosCaixas.length > 0) {
                html += `<div class="lista-outros-caixas">` + outrosCaixas.map(c => `
                    <span class="chip-outro-caixa">${c.usuarioNome}: R$ ${c.valorFundoCaixa.toFixed(2)}
                        <button class="btn btn-warning" style="padding:2px 6px; font-size:0.7rem;" onclick="fecharCaixaPrompt('${c.id}')" title="Fechar caixa de ${c.usuarioNome}">🔒</button>
                    </span>`).join('') + `</div>`;
            }

            painel.innerHTML = html;
        }

        // Abas "Todos" + 1 por caixa aberto agora, no topo do Dashboard
        // Analytics — clicar troca caixaRelatorioSelecionado e re-renderiza os
        // números (obterDadosRelatorioCaixa já sabe filtrar por essa variável).
        function renderizarAbasCaixasRelatorio() {
            const container = document.getElementById('abas-caixas-relatorio');
            if (!container) return;

            const abas = [{ id: null, label: 'Todos' }, ...caixasAbertos.filter(c => !c.fechado).map(c => ({ id: c.id, label: c.usuarioNome }))];
            container.innerHTML = abas.map(a => `
                <button class="tag-categoria ${caixaRelatorioSelecionado === a.id ? 'ativa' : ''}" onclick="selecionarCaixaRelatorio(${a.id ? `'${a.id}'` : 'null'})">${a.id ? '💰 ' + a.label : '🗂️ Todos'}</button>
            `).join('');
        }

        function selecionarCaixaRelatorio(idCaixa) {
            caixaRelatorioSelecionado = idCaixa;
            renderizarAbasCaixasRelatorio();
            atualizarDashboard();
        }

        // Telas de relatório têm vários painéis internos com "max-height +
        // overflow-y:auto" (tabelas, listas) — o html2canvas só captura a
        // área visível desses painéis, cortando o resto do conteúdo. Antes
        // de tirar a foto, remove temporariamente esse limite de todo mundo
        // dentro do elemento capturado, deixa o layout se esticar pro
        // tamanho real, tira a foto e devolve o CSS original em seguida.
        function expandirRolaveisParaCaptura(container) {
            const originais = [];
            [container, ...container.querySelectorAll('*')].forEach(el => {
                const cs = window.getComputedStyle(el);
                if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') {
                    originais.push({ el, overflow: el.style.overflow, overflowY: el.style.overflowY, overflowX: el.style.overflowX, maxHeight: el.style.maxHeight });
                    el.style.overflow = 'visible';
                    el.style.overflowY = 'visible';
                    el.style.overflowX = 'visible';
                    el.style.maxHeight = 'none';
                }
            });
            return () => originais.forEach(o => {
                o.el.style.overflow = o.overflow;
                o.el.style.overflowY = o.overflowY;
                o.el.style.overflowX = o.overflowX;
                o.el.style.maxHeight = o.maxHeight;
            });
        }

        function gerarJPG(elementoId, nomeArquivo) {
            const el = document.getElementById(elementoId);
            if (!el || typeof html2canvas !== 'function') return;
            const restaurar = expandirRolaveisParaCaptura(el);
            html2canvas(el, { scale: 2 }).then(canvas => {
                restaurar();
                const link = document.createElement('a');
                link.download = nomeArquivo;
                link.href = canvas.toDataURL('image/jpeg', 0.92);
                link.click();
            }).catch(restaurar);
        }

        function gerarJPGRelatorioCaixa() {
            gerarJPG('tela-relatorio', `Relatorio_Caixa_${new Date().toISOString().slice(0,10)}.jpg`);
        }

        function gerarJPGEstoque() {
            gerarJPG('tela-produtos', `Estoque_${new Date().toISOString().slice(0,10)}.jpg`);
        }

        function gerarJPGDashboardGeral() {
            gerarJPG('tela-dashboard-geral', `Dashboard_Geral_${new Date().toISOString().slice(0,10)}.jpg`);
        }

        function gerarPDFDashboardGeral() {
            const el = document.getElementById('tela-dashboard-geral');
            if (!el || typeof html2pdf !== 'function') return;
            const restaurar = expandirRolaveisParaCaptura(el);
            html2pdf().set({
                margin: 10,
                filename: `Dashboard_Geral_${new Date().toISOString().slice(0,10)}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2 },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
            }).from(el).save().then(restaurar).catch(restaurar);
        }

        // JPG de um fechamento já histórico — reaproveita o mesmo modal de
        // "Ver Detalhes" (verDetalhesCaixa) já existente: popula, mostra,
        // tira o print e fecha de novo, sem duplicar nenhum template.
        function gerarJPGFechamento(idCaixa) {
            verDetalhesCaixa(idCaixa);
            setTimeout(() => {
                const el = document.querySelector('#modal-detalhes-caixa .modal-content');
                if (!el || typeof html2canvas !== 'function') return;
                const restaurar = expandirRolaveisParaCaptura(el);
                html2canvas(el, { scale: 2 }).then(canvas => {
                    restaurar();
                    const link = document.createElement('a');
                    link.download = `Fechamento_Caixa_${idCaixa}.jpg`;
                    link.href = canvas.toDataURL('image/jpeg', 0.92);
                    link.click();
                    fecharModalDetalhesCaixa();
                }).catch(restaurar);
            }, 150);
        }

        // PDF do mesmo modal de detalhes, reaproveitando o padrão do JPG acima.
        function gerarPDFFechamento(idCaixa) {
            verDetalhesCaixa(idCaixa);
            setTimeout(() => {
                const el = document.querySelector('#modal-detalhes-caixa .modal-content');
                if (!el || typeof html2pdf !== 'function') return;
                const restaurar = expandirRolaveisParaCaptura(el);
                html2pdf().set({
                    margin: 10,
                    filename: `Fechamento_Caixa_${idCaixa}.pdf`,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2 },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                }).from(el).save().then(() => {
                    restaurar();
                    fecharModalDetalhesCaixa();
                }).catch(restaurar);
            }, 150);
        }

        // Botão de atalho na própria tela de Pedido — imprime o relatório do
        // caixa do usuário logado sem precisar ir até o Dashboard Analytics
        // nem mudar a aba selecionada lá.
        async function imprimirMeuCaixa() {
            const meuCaixa = caixaDoUsuarioAtual();
            if (!meuCaixa) return exibirAviso("Você não tem caixa aberto.");
            if (!(await pedirConfirmacao("Deseja imprimir o relatório do seu caixa?", { titulo: '🖨️ Imprimir Relatório' }))) return;
            const selecaoAnterior = caixaRelatorioSelecionado;
            caixaRelatorioSelecionado = meuCaixa.id;
            imprimirRelatorioCaixaAtual();
            caixaRelatorioSelecionado = selecaoAnterior;
        }

        function atualizarDashboard() {
            renderizarAbasCaixasRelatorio();
            const dados = obterDadosRelatorioCaixa();

            document.getElementById('rel-total').innerText = dados.totalVendas.toFixed(2);
            document.getElementById('rel-total-dinheiro').innerText = dados.totalGaveta.toFixed(2);
            document.getElementById('rel-qtd-pedidos').innerText = dados.validos.length;
            
            const qtdFinanceiras = dados.validosVendas.length;
            document.getElementById('rel-ticket').innerText = (qtdFinanceiras ? (dados.totalVendas / qtdFinanceiras) : 0).toFixed(2);

            document.getElementById('rel-custo-producao').innerText = dados.custoProducaoTotal.toFixed(2);
            document.getElementById('rel-custo-taxas').innerText = dados.custoTaxas.toFixed(2);
            document.getElementById('rel-lucro-real').innerText = dados.lucroReal.toFixed(2);
            const avisoIncompleto = document.getElementById('rel-aviso-custo-incompleto');
            if (avisoIncompleto) {
                avisoIncompleto.style.display = dados.itensSemCustoProducao > 0 ? 'block' : 'none';
                document.getElementById('rel-qtd-itens-sem-custo').innerText = dados.itensSemCustoProducao;
            }

            document.getElementById('rel-pix').innerText = dados.fatPix.toFixed(2);
            document.getElementById('rel-pix-direto').innerText = dados.fatPixDireto.toFixed(2);
            document.getElementById('rel-credito').innerText = dados.fatCredito.toFixed(2);
            document.getElementById('rel-debito').innerText = dados.fatDebito.toFixed(2);
            document.getElementById('rel-dinheiro-vendas').innerText = dados.fatDinheiro.toFixed(2);
            document.getElementById('rel-qtd-bonificacao').innerText = dados.qtdBonificacoes;

            const painelBono = document.getElementById('painel-resumo-bonificacoes');
            if (dados.bonificacoesLista.length > 0) {
                painelBono.innerHTML = dados.bonificacoesLista.map(b => {
                    const resumoItens = b.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ');
                    return `
                        <div style="background:#fef2f2; border:1px solid #fca5a5; padding:8px 12px; border-radius:6px; margin-bottom:6px; font-size:0.85rem; color:#991b1b;">
                            <b>Pedido #${rotuloPedido(b)} - ${b.cliente}:</b> ${resumoItens} <br><small style="color:#b91c1c;">(Motivo: ${b.pagamento})</small>
                        </div>
                    `;
                }).join('');
            } else {
                painelBono.innerHTML = '<p style="color: gray;">Nenhuma bonificação registrada no caixa atual.</p>';
            }

            gerarGraficos(dados.validos);
            renderizarTempoPreparoPorProduto(dados.validos);
        }

        if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
            Chart.register(ChartDataLabels);
        }

        // Rótulo fixo (sem precisar de hover) pra barra/linha — só a
        // quantidade (% ali não teria um "todo" claro de referência, ex:
        // ranking do Top 5).
        function formatarQtd(value) {
            return (typeof value === 'number' && value) ? String(value) : '';
        }

        // Rótulo fixo pra pizza/rosca — quantidade + % do total daquele
        // gráfico. Blindado com try/catch porque o datalabels às vezes chama
        // o formatter em passos intermediários de animação/legenda com um
        // contexto incompleto.
        function formatarQtdEPct(value, ctx) {
            if (typeof value !== 'number' || !value) return '';
            try {
                const dados = ctx.chart.data.datasets[ctx.datasetIndex].data;
                const total = dados.reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
                const pct = total > 0 ? Math.round((value / total) * 100) : 0;
                return `${value} (${pct}%)`;
            } catch (e) {
                return String(value);
            }
        }

        function gerarGraficos(pedidos) {
            let contagemProdutos = {}; let contagemHoras = {}; let contagemCategorias = {}; let contagemRetirada = { 'Agora': 0, 'Depois': 0 };

            pedidos.forEach(p => {
                // Bonificação é cortesia, não venda de verdade — fica de fora
                // dos 3 gráficos de volume/proporção pra não distorcer o real
                // padrão de consumo (só o de "Mais Vendidos" excluía antes,
                // deixando Categoria e Tipo de Retirada inconsistentes).
                if (p.pagamento && p.pagamento.startsWith('Bonificação')) return;

                const horaCheia = p.hora.split(':')[0] + 'h'; contagemHoras[horaCheia] = (contagemHoras[horaCheia] || 0) + 1;
                p.itens.forEach(i => {
                    contagemProdutos[i.nome] = (contagemProdutos[i.nome] || 0) + i.qtd;
                    contagemCategorias[i.categoria] = (contagemCategorias[i.categoria] || 0) + i.qtd;
                    if (i.fase === 'agora' || i.fase === 'entregue') contagemRetirada['Agora'] += i.qtd; else contagemRetirada['Depois'] += i.qtd;
                });
            });

            const topProdutos = Object.entries(contagemProdutos).sort((a, b) => b[1] - a[1]).slice(0, 5);
            const horasOrdenadas = Object.keys(contagemHoras).sort(); const dadosHoras = horasOrdenadas.map(h => contagemHoras[h]);
            if (chartVendas) chartVendas.destroy(); if (chartHorarios) chartHorarios.destroy(); if (chartCategorias) chartCategorias.destroy(); if (chartRetirada) chartRetirada.destroy();
            const coresBase = ['#2563eb', '#16a34a', '#f59e0b', '#8b5cf6', '#ef4444', '#0ea5e9', '#14b8a6'];

            chartVendas = new Chart(document.getElementById('chartMaisVendidos').getContext('2d'), { type: 'bar', data: { labels: topProdutos.map(item => item[0]), datasets: [{ label: 'Unidades Vendidas (Vendas)', data: topProdutos.map(item => item[1]), backgroundColor: '#2563eb', borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { datalabels: { anchor: 'end', align: 'top', color: '#1f2937', font: { weight: 'bold' }, formatter: formatarQtd } } } });
            chartHorarios = new Chart(document.getElementById('chartHorarios').getContext('2d'), { type: 'line', data: { labels: horasOrdenadas.length > 0 ? horasOrdenadas : ['Sem dados'], datasets: [{ label: 'Qtd de Pedidos', data: dadosHoras.length > 0 ? dadosHoras : [0], borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.2)', fill: true, tension: 0.3 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { datalabels: { align: 'top', color: '#92400e', font: { weight: 'bold' }, formatter: formatarQtd } } } });
            chartCategorias = new Chart(document.getElementById('chartCategorias').getContext('2d'), { type: 'doughnut', data: { labels: Object.keys(contagemCategorias), datasets: [{ data: Object.values(contagemCategorias), backgroundColor: coresBase }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { datalabels: { color: '#fff', font: { weight: 'bold', size: 11 }, formatter: formatarQtdEPct } } } });
            chartRetirada = new Chart(document.getElementById('chartRetirada').getContext('2d'), { type: 'pie', data: { labels: ['🟢 Retirar Agora', '📦 Retirar Depois'], datasets: [{ data: [contagemRetirada['Agora'], contagemRetirada['Depois']], backgroundColor: ['#16a34a', '#8b5cf6'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { datalabels: { color: '#fff', font: { weight: 'bold', size: 12 }, formatter: formatarQtdEPct } } } });
        }

        // Tempo é medido por PEDIDO (entrada → entrega), não por item — não dá
        // pra saber quanto cada produto isoladamente demorou dentro de um
        // pedido com vários itens. Como aproximação honesta, atribui o tempo
        // total do pedido a cada produto de cozinha que ele continha, e tira a
        // média — serve pra apontar quais produtos costumam aparecer em
        // pedidos mais demorados (gargalo), não um cronômetro exato por item.
        function renderizarTempoPreparoPorProduto(pedidos) {
            const tbody = document.getElementById('tabela-tempo-preparo');
            if (!tbody) return;

            let somaPorProduto = {};
            let contagemPorProduto = {};

            pedidos.forEach(p => {
                if (!p.horaEntradaCozinha || !p.horaEntrega) return;
                const [h1, m1] = p.horaEntradaCozinha.split(':').map(Number);
                const [h2, m2] = p.horaEntrega.split(':').map(Number);
                if (isNaN(h1) || isNaN(m1) || isNaN(h2) || isNaN(m2)) return;
                let min1 = h1 * 60 + m1, min2 = h2 * 60 + m2;
                if (min2 < min1) min2 += 24 * 60;
                const tempoPedido = min2 - min1;

                const produtosDoPedido = new Set();
                p.itens.forEach(item => {
                    if (item.isCombo) {
                        item.itensComboEscolhidos.forEach(sub => { if (sub.cozinha) produtosDoPedido.add(sub.nome); });
                    } else if (item.cozinha) {
                        produtosDoPedido.add(item.nome);
                    }
                });
                produtosDoPedido.forEach(nome => {
                    somaPorProduto[nome] = (somaPorProduto[nome] || 0) + tempoPedido;
                    contagemPorProduto[nome] = (contagemPorProduto[nome] || 0) + 1;
                });
            });

            const linhas = Object.keys(somaPorProduto)
                .map(nome => ({ nome, qtdPedidos: contagemPorProduto[nome], media: somaPorProduto[nome] / contagemPorProduto[nome] }))
                .sort((a, b) => b.media - a.media);

            if (linhas.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="padding:12px; text-align:center; color:gray;">Sem dados suficientes ainda (precisa de pedidos já entregues, com hora de entrada na cozinha registrada).</td></tr>';
                return;
            }

            tbody.innerHTML = linhas.map(l => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:8px; font-weight:600;">${l.nome}</td>
                    <td>${l.qtdPedidos}</td>
                    <td style="font-weight:bold; color:${l.media > 20 ? 'var(--danger)' : (l.media > 10 ? 'var(--warning)' : 'var(--success)')};">${Math.round(l.media)} min</td>
                </tr>
            `).join('');
        }

        function editarPedido(id) {
            const p = pedidosGerais.find(x => x.id === id);
            if(!p) return;

            carrinho = JSON.parse(JSON.stringify(p.itens));
            document.getElementById('nome-cliente').value = p.cliente; 
            
            if (p.pagamento.startsWith('Bonificação')) {
                document.getElementById('forma-pagto').value = 'Bonificação';
                const partes = p.pagamento.match(/\((.*?)\)/);
                document.getElementById('obs-bonificacao').value = partes ? partes[1] : '';
            } else if (p.detalhesMisto && Array.isArray(p.detalhesMisto)) {
                document.getElementById('forma-pagto').value = 'Misto';
                document.getElementById('misto-forma-1').value = p.detalhesMisto[0].forma;
                document.getElementById('misto-valor-1').value = p.detalhesMisto[0].valor;
                document.getElementById('misto-forma-2').value = p.detalhesMisto[1].forma;
                document.getElementById('misto-valor-2').value = p.detalhesMisto[1].valor;
            } else {
                document.getElementById('forma-pagto').value = p.pagamento;
            }

            if(p.tipoAtendimento) document.getElementById('tipo-atendimento').value = p.tipoAtendimento;
            
            toggleCampoDinheiro(); 
            pedidoEmEdicaoId = id;

            document.getElementById('lbl-id-pedido-edicao').innerText = `#${rotuloPedido(p)}`;
            document.getElementById('banner-alerta-edicao').style.display = 'block';
            
            const selectStatusEdicao = document.getElementById('status-pedido-edicao');
            selectStatusEdicao.value = p.statusPainel || 'nenhum';
            document.getElementById('box-status-edicao').style.display = 'block';

            // Durante edição quem manda é "Status do Pedido" ali em cima —
            // "Modo de Retirada (Global)" só serve pra CRIAR pedido (decide o
            // status inicial), editando ele não faz mais nada além de
            // confundir com dois controles pra "mesma coisa". O toggle
            // agora/depois por item continua liberado sem precisar dele (ver
            // atualizarCarrinhoUI).
            document.getElementById('box-modo-retirada-global').style.display = 'none';
            document.getElementById('btn-limpar-pedido').style.display = 'none';

            document.getElementById('box-carrinho-container').classList.add('modo-edicao');
            document.getElementById('titulo-painel-carrinho').innerText = `Alterando Pedido #${rotuloPedido(p)}`;

            document.getElementById('btn-finalizar-pedido').innerHTML = `Salvar Alteração e Reimprimir 🖨️`;
            document.getElementById('btn-finalizar-pedido').classList.replace('btn-primary', 'btn-warning');
            
            mudarAba('tela-pedido', document.querySelectorAll('nav button')[0]); 
            atualizarCarrinhoUI();
        }

        window.onload = async () => {
            // Ativa os teclados próprios (numérico e de texto) ANTES de
            // qualquer coisa que possa travar em await — inclusive a própria
            // tela de login usa campos de senha/usuário que precisam disso
            // desde o primeiro instante em tablet/celular, e essa tela
            // aparece antes de qualquer login existir.
            ativarTecladoNumericoSeTablet();
            document.getElementById('grid-teclado-numerico').addEventListener('click', e => {
                const btn = e.target.closest('.tecla-num');
                if (btn) digitarTecladoNumerico(btn.dataset.tecla);
            });

            // Antes de qualquer coisa: quem está usando este dispositivo? Mostra
            // a tela de login (ou de criar a conta Master, na primeiríssima vez)
            // e só segue depois disso resolver — ninguém vê nem a lista de
            // barracas sem se identificar primeiro.
            await resolverSessaoAtiva();
            aplicarPermissoesNaUI();

            // Só depois de saber quem está logado é que faz sentido perguntar em
            // qual barraca este dispositivo trabalha (mostra a tela de seleção e
            // aguarda, se for a primeira vez). Só depois disso barracaStateId
            // existe e é seguro ler/gravar estado.
            const barraca = await resolverBarracaAtiva(usuarioAtual && !usuarioAtual.isMaster ? usuarioAtual.barracasPermitidas : null);
            barracaStateId = barraca.id;
            // resolverBarracaAtiva() acabou de montar o trocador de barraca no
            // menu (com seu próprio link "Gerenciar Barracas") — reaplica as
            // permissões agora que esse pedaço da UI existe de verdade, senão
            // esse link específico escaparia do primeiro aplicarPermissoesNaUI().
            aplicarPermissoesNaUI();

            carregarCacheLocalDaBarraca();
            await carregarEstadoSupabase();
            await carregarCatalogo();
            atualizarInterfaceCaixa();
            renderizarCategoriasUI();
            renderizarMenu();
            aplicarConfigPadroesNoFormulario();
            atualizarTelas();
            atualizarFiltrosGestao();
            carregarHistoricoCaixas();
            tentarEnviarFilaDeFechamentos();
            atualizarBotoesVozAnuncio();
            aplicarTodosZoomsSalvos();
            iniciarRealtimeSupabase();
            iniciarRealtimeRegistroBarracas();
            iniciarRealtimeCatalogo();

            // Realtime é ótimo enquanto a conexão fica de pé, mas se o
            // dispositivo for pra segundo plano (tela apaga, troca de app) ou
            // a internet cair por um tempo, o canal pode ficar quieto sem
            // avisar nada — não é erro de leitura/escrita, então nem acende
            // o indicador offline, e o dispositivo fica "dormindo" sem saber
            // que perdeu atualizações de outros dispositivos. salvarNoBancoLocal
            // já mescla em vez de sobrescrever (ver lá), mas só na PRÓXIMA vez
            // que ESTE dispositivo salvar algo; isso aqui resolve mais cedo —
            // assim que a tela volta a ficar visível ou a internet volta,
            // busca o estado completo de novo sozinho.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') resincronizarSeNecessario('tela voltou a ficar visível');
            });
            window.addEventListener('online', () => resincronizarSeNecessario('conexão de internet voltou'));

            // Reconecta sozinho se este dispositivo já tinha sido configurado
            // (numa sessão anterior) como impressora de rede ou como remetente
            // — senão só voltaria a funcionar depois de reabrir a tela de
            // Configurações manualmente a cada F5.
            if (souImpressoraDeRede() || impressaoRemotaAtiva()) obterCanalImpressaoRede();
            if (souAltoFalanteDeRede() || chamarRemotoAtivo()) obterCanalChamarRede();

            // Suporte a abrir direto numa tela específica — usado por cada
            // quadrante do Multiview (iframe com ?abrirTela=X). Não chama
            // requestFullscreen() sozinho aqui: navegador bloqueia tela cheia
            // disparada fora de um clique direto do usuário nesta janela — por
            // isso mostra um botão flutuante pra confirmar com 1 clique.
            const telaAutoAbrir = new URLSearchParams(location.search).get('abrirTela');
            if (telaAutoAbrir && usuarioTemAcesso(telaAutoAbrir)) {
                mudarAba(telaAutoAbrir, null);
                // Modo "só a tela" — usado tanto pela TV Senha em janela
                // própria quanto por cada quadrante do Multiview (iframe):
                // esconde o menu/nav inteiro, senão cada quadradinho mostra
                // o cabeçalho do app inteiro de novo, sem sentido no espaço
                // minúsculo de um quadrante 4x4.
                const nav = document.getElementById('nav-principal');
                const btnMostrarMenu = document.getElementById('btn-show-global-menu');
                if (nav) nav.style.display = 'none';
                if (btnMostrarMenu) btnMostrarMenu.style.display = 'none';

                // Dentro de um <iframe> (quadrante do Multiview) não faz
                // sentido nem funciona pedir tela cheia — só mostra o botão
                // quando é mesmo uma janela própria (aberta via TV Senha).
                if (window.self === window.top) {
                    const btnFull = document.createElement('button');
                    btnFull.innerText = '🖥️ Clique para Tela Cheia';
                    btnFull.style.cssText = 'position:fixed; top:10px; right:10px; z-index:99999; padding:12px 18px; font-size:1rem; font-weight:bold; background:#2563eb; color:white; border:none; border-radius:8px; cursor:pointer; box-shadow:0 4px 10px rgba(0,0,0,0.3);';
                    btnFull.onclick = () => {
                        document.documentElement.requestFullscreen().then(() => btnFull.remove()).catch(() => {});
                    };
                    document.body.appendChild(btnFull);
                }
            } else if (!usuarioTemAcesso('tela-pedido')) {
                // A tela-pedido vem marcada "active" direto no HTML estático
                // — aplicarPermissoesNaUI() só esconde os botões do menu que
                // o usuário não pode acessar, não troca a aba ativa sozinha.
                // Sem isso, um usuário sem acesso à tela-pedido (ex: perfil
                // só de Balcão/Pausa/TV Senha) via de cara uma tela de Pedido
                // "vazia" que ele nem deveria ver. Manda pra primeira tela
                // que ele TEM acesso, na mesma ordem em que aparecem no menu.
                const ordemTelasPadrao = ['tela-pedido', 'tela-agendados', 'tela-preparo', 'tela-entrega', 'tela-tv', 'tela-produtos', 'tela-barracas', 'tela-gestao', 'tela-fechamento-caixa', 'tela-produtos-periodo', 'tela-relatorio', 'tela-dashboard-geral', 'tela-configuracoes', 'tela-gestao-usuarios'];
                const primeiraPermitida = ordemTelasPadrao.find(id => usuarioTemAcesso(id));
                if (primeiraPermitida) {
                    const botaoCorrespondente = document.querySelector(`[onclick*="mudarAba('${primeiraPermitida}'"]`);
                    mudarAba(primeiraPermitida, botaoCorrespondente);
                }
            }
        };

// --- Shim exigido pela conversão para módulo ES (não existe no arquivo-fonte) ---
// O campo de busca de produtos chama "filtrarMenu(categoriaFiltroAtual)" direto no
// HTML. categoriaFiltroAtual é uma variável de módulo (let) e não fica visível em
// 'window', então o HTML não consegue mais lê-la diretamente como conseguia no
// script inline original. Esta função só repassa o valor atual da variável.
function filtrarMenuBusca() {
    filtrarMenu(categoriaFiltroAtual);
}

// --- Exposição global das funções chamadas via onclick="..." no HTML ---
// (necessário porque este arquivo é um módulo ES; markup estático e
// innerHTML gerado dinamicamente resolvem onclick por nome em 'window')
window.abrirCaixaPrompt = abrirCaixaPrompt;
window.abrirModalObs = abrirModalObs;
window.abrirDescontoItem = abrirDescontoItem;
window.abrirAcrescimoItem = abrirAcrescimoItem;
window.abrirModalTodosPedidos = abrirModalTodosPedidos;
window.abrirModalTrocaItem = abrirModalTrocaItem;
window.addCarrinho = addCarrinho;
window.addProdutoTemporarioAoCombo = addProdutoTemporarioAoCombo;
window.adicionarCategoria = adicionarCategoria;
window.adicionarEstoqueManual = adicionarEstoqueManual;
window.apagarProduto = apagarProduto;
window.filtrarProdutosPorTipo = filtrarProdutosPorTipo;
window.addItemFichaTecnica = addItemFichaTecnica;
window.alternarBoxFichaTecnica = alternarBoxFichaTecnica;
window.removerItemFichaTecnica = removerItemFichaTecnica;
window.atualizarResumoCustoLucro = atualizarResumoCustoLucro;
window.mudarModoEntradaEstoque = mudarModoEntradaEstoque;
window.addItemEntradaEstoque = addItemEntradaEstoque;
window.removerItemEntradaEstoque = removerItemEntradaEstoque;
window.atualizarTotalEntradaEstoque = atualizarTotalEntradaEstoque;
window.confirmarEntradaEstoque = confirmarEntradaEstoque;
window.atualizarEstoqueAtualAjuste = atualizarEstoqueAtualAjuste;
window.atualizarDiferencaAjuste = atualizarDiferencaAjuste;
window.confirmarAjusteInventario = confirmarAjusteInventario;
window.carregarMovimentacoesEstoque = carregarMovimentacoesEstoque;
window.atualizarFiltrosGestao = atualizarFiltrosGestao;
window.atualizarTelas = atualizarTelas;
window.atualizarValoresMisto = atualizarValoresMisto;
window.calcularTroco = calcularTroco;
window.cancelarEdicaoProduto = cancelarEdicaoProduto;
window.cancelarPedido = cancelarPedido;
window.chamarNoPainel = chamarNoPainel;
window.confirmarCombo = confirmarCombo;
window.confirmarTrocaItemBalcao = confirmarTrocaItemBalcao;
window.salvarConfiguracoesPadrao = salvarConfiguracoesPadrao;
window.editarCategoria = editarCategoria;
window.editarPedido = editarPedido;
window.excluirCategoria = excluirCategoria;
window.excluirRegistroCaixa = excluirRegistroCaixa;
window.fecharAviso = fecharAviso;
window.fecharCaixaPrompt = fecharCaixaPrompt;
window.selecionarCaixaRelatorio = selecionarCaixaRelatorio;
window.gerarJPGRelatorioCaixa = gerarJPGRelatorioCaixa;
window.gerarJPGEstoque = gerarJPGEstoque;
window.gerarJPGDashboardGeral = gerarJPGDashboardGeral;
window.gerarPDFDashboardGeral = gerarPDFDashboardGeral;
window.gerarJPGFechamento = gerarJPGFechamento;
window.gerarPDFFechamento = gerarPDFFechamento;
window.alternarSelecaoFechamento = alternarSelecaoFechamento;
window.limparSelecaoFechamentos = limparSelecaoFechamentos;
window.verDetalhesCombinado = verDetalhesCombinado;
window.imprimirRelatorioCombinado = imprimirRelatorioCombinado;
window.gerarJPGRelatorioCombinado = gerarJPGRelatorioCombinado;
window.gerarPDFRelatorioCombinado = gerarPDFRelatorioCombinado;
window.imprimirMeuCaixa = imprimirMeuCaixa;
window.alternarImpressaoRemota = alternarImpressaoRemota;
window.salvarDestinoImpressaoRemota = salvarDestinoImpressaoRemota;
window.alternarSouImpressoraRede = alternarSouImpressoraRede;
window.alternarChamarRemoto = alternarChamarRemoto;
window.salvarDestinoChamarRemoto = salvarDestinoChamarRemoto;
window.alternarSouAltoFalanteRede = alternarSouAltoFalanteRede;
window.abrirModalPixQRCode = abrirModalPixQRCode;
window.fecharModalPixQRCode = fecharModalPixQRCode;
window.copiarCodigoPixCopiaCola = copiarCodigoPixCopiaCola;
window.pedirTexto = pedirTexto;
window.alternarMostrarSenha = alternarMostrarSenha;
window.pedirConfirmacao = pedirConfirmacao;
window.verMeuRelatorioCaixa = verMeuRelatorioCaixa;
window.limparCarrinhoComConfirmacao = limparCarrinhoComConfirmacao;
window.alternarVozAnuncio = alternarVozAnuncio;
window.alternarChamarAtivo = alternarChamarAtivo;
window.ajustarVolumeAnuncio = ajustarVolumeAnuncio;
window.ajustarZoomTela = ajustarZoomTela;
window.fecharTecladoNumerico = fecharTecladoNumerico;
window.tratarDragStartProduto = tratarDragStartProduto;
window.tratarDragOverProduto = tratarDragOverProduto;
window.tratarDropProduto = tratarDropProduto;
window.tratarDragEndProduto = tratarDragEndProduto;
window.atualizarListaSubcategoriasExistentes = atualizarListaSubcategoriasExistentes;
window.abrirModalPedidosEntregues = abrirModalPedidosEntregues;
window.gerarJPG = gerarJPG;
window.abrirModalGerenciarCategorias = abrirModalGerenciarCategorias;
window.fecharModalGerenciarCategorias = fecharModalGerenciarCategorias;
window.abrirModalGerenciarSubcategorias = abrirModalGerenciarSubcategorias;
window.fecharModalGerenciarSubcategorias = fecharModalGerenciarSubcategorias;
window.adicionarSubcategoria = adicionarSubcategoria;
window.editarSubcategoria = editarSubcategoria;
window.excluirSubcategoria = excluirSubcategoria;
window.abrirModalConfigPedido = abrirModalConfigPedido;
window.fecharModalConfigPedido = fecharModalConfigPedido;
window.fecharModalCombo = fecharModalCombo;
window.fecharModalDetalhesCaixa = fecharModalDetalhesCaixa;
window.fecharModalObs = fecharModalObs;
window.fecharModalTodosPedidos = fecharModalTodosPedidos;
window.fecharModalTroca = fecharModalTroca;
window.filtrarMenu = filtrarMenu;
window.filtrarMenuBusca = filtrarMenuBusca;
window.finalizarEntrega = finalizarEntrega;
window.finalizarPedido = finalizarPedido;
window.gerarPDFCaixaAtual = gerarPDFCaixaAtual;
window.gerarPDFEstoquePorCategoria = gerarPDFEstoquePorCategoria;
window.imprimirEstoquePorCategoria = imprimirEstoquePorCategoria;
window.imprimirRelatorioCaixaAtual = imprimirRelatorioCaixaAtual;
window.imprimirPedidosEmPausa = imprimirPedidosEmPausa;
window.baixarPDFPedido = baixarPDFPedido;
window.imprimirRelatorioFechamento = imprimirRelatorioFechamento;
window.iniciarGravaçãoAtalho = iniciarGravaçãoAtalho;
window.limparCarrinho = limparCarrinho;
window.moverCategoria = moverCategoria;
window.tratarDragStartCategoria = tratarDragStartCategoria;
window.tratarDragOverCategoria = tratarDragOverCategoria;
window.tratarDropCategoria = tratarDropCategoria;
window.tratarDragEndCategoria = tratarDragEndCategoria;
window.moverParaAgora = moverParaAgora;
window.mudarAba = mudarAba;
window.mudarModoCadastro = mudarModoCadastro;
window.mudarTipoRetiradaGlobal = mudarTipoRetiradaGlobal;
window.prepararEdicaoProduto = prepararEdicaoProduto;
window.processarUploadFoto = processarUploadFoto;
window.reimprimirPedido = reimprimirPedido;
window.verDetalhesPedido = verDetalhesPedido;
window.fecharModalDetalhesPedido = fecharModalDetalhesPedido;
window.removerItemCarrinho = removerItemCarrinho;
window.removerItemComboTemporario = removerItemComboTemporario;
window.renderizarTabelaModalTodosPedidos = renderizarTabelaModalTodosPedidos;
window.renderizarTabelaProdutos = renderizarTabelaProdutos;
window.filtrarTabelaProdutosPorCategoria = filtrarTabelaProdutosPorCategoria;
window.salvarObsModal = salvarObsModal;
window.salvarProduto = salvarProduto;
window.setFaseItem = setFaseItem;
window.toggleCampoDinheiro = toggleCampoDinheiro;
window.toggleMenuGlobal = toggleMenuGlobal;
window.toggleMenuMobile = toggleMenuMobile;
window.toggleStatusAtivoProduto = toggleStatusAtivoProduto;
window.verDetalhesCaixa = verDetalhesCaixa;
window.renderizarHistoricoCaixas = renderizarHistoricoCaixas;
window.renderizarProdutosPorPeriodo = renderizarProdutosPorPeriodo;
window.gerarPDFProdutosPeriodo = gerarPDFProdutosPeriodo;
window.renderizarMargemLucro = renderizarMargemLucro;
window.gerarPDFMargemLucro = gerarPDFMargemLucro;
window.carregarLogsSistema = carregarLogsSistema;

// PWA: registra o service worker (sw.js) só cuida do "shell" do app pra ele
// abrir mesmo sem internet — os dados de verdade continuam vindo do
// Supabase, isso aqui nunca intercepta essas chamadas (ver sw.js).
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((erro) => {
            console.log('Service worker não pôde ser registrado (app continua funcionando normal):', erro);
        });
    });
}
