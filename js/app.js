// Lógica principal do PDV Santa Rita.
//
// Este módulo concentra o estado da aplicação (produtos, pedidos, carrinho,
// caixa, atalhos) e todas as funções de UI/negócio. As funções referenciadas
// via onclick="..." no HTML (estático ou gerado dinamicamente via innerHTML)
// são expostas em 'window' no final do arquivo, pois módulos ES não vazam
// suas declarações para o escopo global automaticamente.

import { supabaseClient, PDV_STATE_ID, PDV_CLIENT_ID } from './config.js';
import { categoriasPadrao, produtosPadrao } from './data.js';

        let categoriasDB = JSON.parse(localStorage.getItem('pdv_categorias')) || JSON.parse(JSON.stringify(categoriasPadrao));
        let produtosDB = JSON.parse(localStorage.getItem('pdv_produtos')) || JSON.parse(JSON.stringify(produtosPadrao));
        produtosDB.forEach(p => { if (p.ativo === undefined) p.ativo = true; });

        let pedidosGerais = JSON.parse(localStorage.getItem('pdv_pedidos')) || [];
        let contadorPedidos = parseInt(localStorage.getItem('pdv_contador')) || 1;
        let historicoCaixasDB = JSON.parse(localStorage.getItem('pdv_historico_caixas')) || [];

        let caixaAberto = JSON.parse(localStorage.getItem('pdv_caixa_aberto')) || false;
        let valorFundoCaixa = parseFloat(localStorage.getItem('pdv_fundo_caixa')) || 0.00;
        let dataHoraAberturaCaixa = localStorage.getItem('pdv_hora_abertura_caixa') || null;

        let supabaseDisponivel = true;
        let carregandoEstadoRemoto = false;
        let ultimaAtualizacaoRemota = null;

        // TECLAS DE ATALHO PADRÃO
        let atalhosConfig = JSON.parse(localStorage.getItem('pdv_atalhos')) || {
            direita: '1',
            esquerda: '2',
            chamar: '3',
            entregue: '4'
        };
        let gravandoAtalhoAcao = null;
        let indexPedidoSelecionadoBalcao = 0;

        function exibirAviso(mensagem, titulo = "Aviso do Sistema") {
            document.getElementById('modal-aviso-titulo').innerText = titulo;
            document.getElementById('modal-aviso-mensagem').innerText = mensagem;
            document.getElementById('modal-aviso').style.display = 'flex';
        }

        function fecharAviso() {
            document.getElementById('modal-aviso').style.display = 'none';
        }

        function processarUploadFoto(input) {
            if (input.files && input.files[0]) {
                const file = input.files[0];
                if (file.size > 2 * 1024 * 1024) {
                    exibirAviso("A foto escolhida é muito grande! Escolha uma imagem de até 2MB.");
                    input.value = "";
                    return;
                }
                const reader = new FileReader();
                reader.onload = function (e) {
                    const base64Str = e.target.result;
                    document.getElementById('novo-prod-foto').value = base64Str;
                    document.getElementById('preview-foto-img').src = base64Str;
                    document.getElementById('preview-foto-container').style.display = 'block';
                };
                reader.readAsDataURL(file);
            }
        }

        function montarEstadoAtual() {
            return {
                categoriasDB,
                produtosDB,
                pedidosGerais,
                contadorPedidos,
                historicoCaixasDB,
                caixaAberto,
                valorFundoCaixa,
                dataHoraAberturaCaixa,
                origem: PDV_CLIENT_ID,
                salvoEm: new Date().toISOString()
            };
        }

        function salvarCacheLocal() {
            localStorage.setItem('pdv_categorias', JSON.stringify(categoriasDB));
            localStorage.setItem('pdv_produtos', JSON.stringify(produtosDB));
            localStorage.setItem('pdv_pedidos', JSON.stringify(pedidosGerais));
            localStorage.setItem('pdv_contador', contadorPedidos);
            localStorage.setItem('pdv_historico_caixas', JSON.stringify(historicoCaixasDB));
            localStorage.setItem('pdv_caixa_aberto', JSON.stringify(caixaAberto));
            localStorage.setItem('pdv_fundo_caixa', valorFundoCaixa);
            localStorage.setItem('pdv_atalhos', JSON.stringify(atalhosConfig));
            if (dataHoraAberturaCaixa) localStorage.setItem('pdv_hora_abertura_caixa', dataHoraAberturaCaixa);
            else localStorage.removeItem('pdv_hora_abertura_caixa');
        }

        function aplicarEstado(estado, atualizarUI = true) {
            if (!estado) return;
            carregandoEstadoRemoto = true;
            categoriasDB = Array.isArray(estado.categoriasDB) ? estado.categoriasDB : categoriasDB;
            produtosDB = Array.isArray(estado.produtosDB) ? estado.produtosDB : produtosDB;
            produtosDB.forEach(p => { if (p.ativo === undefined) p.ativo = true; });

            pedidosGerais = Array.isArray(estado.pedidosGerais) ? estado.pedidosGerais : pedidosGerais;
            contadorPedidos = Number.isFinite(Number(estado.contadorPedidos)) ? Number(estado.contadorPedidos) : contadorPedidos;
            historicoCaixasDB = Array.isArray(estado.historicoCaixasDB) ? estado.historicoCaixasDB : historicoCaixasDB;
            caixaAberto = typeof estado.caixaAberto === 'boolean' ? estado.caixaAberto : caixaAberto;
            valorFundoCaixa = Number.isFinite(Number(estado.valorFundoCaixa)) ? Number(estado.valorFundoCaixa) : valorFundoCaixa;
            dataHoraAberturaCaixa = estado.dataHoraAberturaCaixa || null;
            ultimaAtualizacaoRemota = estado.salvoEm || null;
            salvarCacheLocal();
            carregandoEstadoRemoto = false;

            if (atualizarUI) {
                atualizarInterfaceCaixa();
                renderizarCategoriasUI();
                renderizarMenu(categoriaFiltroAtual);
                renderizarTabelaProdutos();
                atualizarTelas();
                atualizarFiltrosGestao();
                renderizarHistoricoCaixas();
                renderizarPainelAtalhos();
                const relatorio = document.getElementById('tela-relatorio');
                if (relatorio && relatorio.classList.contains('active')) atualizarDashboard();
            }
        }

        async function salvarNoBancoLocal() {
            salvarCacheLocal();
            if (carregandoEstadoRemoto) return;

            const estado = montarEstadoAtual();
            try {
                const { error } = await supabaseClient
                    .from('pdv_state')
                    .upsert({ id: PDV_STATE_ID, data: estado, updated_at: new Date().toISOString() }, { onConflict: 'id' });
                if (error) throw error;
                supabaseDisponivel = true;
            } catch (erro) {
                supabaseDisponivel = false;
                console.error('Falha ao sincronizar com Supabase. Dados mantidos no cache local:', erro);
            }
        }

        async function carregarEstadoSupabase() {
            try {
                const { data, error } = await supabaseClient
                    .from('pdv_state')
                    .select('data, updated_at')
                    .eq('id', PDV_STATE_ID)
                    .maybeSingle();

                if (error) throw error;
                supabaseDisponivel = true;

                if (data && data.data) {
                    aplicarEstado(data.data, false);
                } else {
                    await salvarNoBancoLocal();
                }
                return true;
            } catch (erro) {
                supabaseDisponivel = false;
                console.error('Não foi possível carregar o Supabase. Usando cache local:', erro);
                exibirAviso('Supabase não disponível. O PDV abriu usando apenas o cache local.');
                return false;
            }
        }

        function iniciarRealtimeSupabase() {
            supabaseClient
                .channel('pdv-state-sync')
                .on('postgres_changes', {
                    event: '*',
                    schema: 'public',
                    table: 'pdv_state',
                    filter: `id=eq.${PDV_STATE_ID}`
                }, payload => {
                    const estado = payload.new && payload.new.data;
                    if (!estado || estado.origem === PDV_CLIENT_ID) return;
                    aplicarEstado(estado, true);
                })
                .subscribe(status => {
                    console.log('Supabase Realtime:', status);
                });
        }

        let carrinho = []; 
        let pedidoEmEdicaoId = null; let categoriaFiltroAtual = 'Todos'; let produtoEmEdicaoId = null; 
        
        let chartVendas, chartHorarios, chartCategorias, chartRetirada;

        let modoCadastroAtivo = 'simples';
        let comboTemporario = [];
        let comboAtualId = null; 

        let trocaItemPedidoId = null;
        let trocaItemCartId = null;
        let obsCartIdAtual = null;

        function tocarBeep() {
            try {
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (audioCtx.state === 'suspended') { audioCtx.resume(); }
                const osc1 = audioCtx.createOscillator(); const gain1 = audioCtx.createGain();
                osc1.type = 'triangle'; osc1.frequency.setValueAtTime(987.77, audioCtx.currentTime); 
                gain1.gain.setValueAtTime(0, audioCtx.currentTime); gain1.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.05); gain1.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6); 
                osc1.connect(gain1); gain1.connect(audioCtx.destination); osc1.start(audioCtx.currentTime); osc1.stop(audioCtx.currentTime + 0.6);

                const osc2 = audioCtx.createOscillator(); const gain2 = audioCtx.createGain();
                osc2.type = 'triangle'; osc2.frequency.setValueAtTime(783.99, audioCtx.currentTime + 0.25); 
                gain2.gain.setValueAtTime(0, audioCtx.currentTime + 0.25); gain2.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.3); gain2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.5);
                osc2.connect(gain2); gain2.connect(audioCtx.destination); osc2.start(audioCtx.currentTime + 0.25); osc2.stop(audioCtx.currentTime + 1.5);
            } catch(e) { console.log("Áudio não suportado"); }
        }

        function toggleMenuGlobal() {
            const nav = document.getElementById('nav-principal');
            const btnShow = document.getElementById('btn-show-global-menu');
            if (nav.style.display === 'none') { nav.style.display = 'flex'; btnShow.style.display = 'none'; } 
            else { nav.style.display = 'none'; btnShow.style.display = 'block'; }
        }

        function mudarAba(idAba, botao) {
            document.querySelectorAll('.tab-content').forEach(aba => aba.classList.remove('active'));
            document.querySelectorAll('nav button, .dropdown-content button').forEach(btn => btn.classList.remove('active'));
            
            const mainContainer = document.getElementById('container-principal');
            if (idAba === 'tela-tv') {
                mainContainer.classList.add('container-tv');
                mainContainer.classList.remove('container-vw');
            } else if (idAba === 'tela-videowall') {
                mainContainer.classList.add('container-vw');
                mainContainer.classList.remove('container-tv');
            } else {
                mainContainer.classList.remove('container-tv');
                mainContainer.classList.remove('container-vw');
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
            if(idAba === 'tela-fechamento-caixa') renderizarHistoricoCaixas();
            if(idAba === 'tela-agendados') document.getElementById('busca-agendados').focus();
            if(idAba === 'tela-produtos') { renderizarCategoriasUI(); renderizarTabelaProdutos(); }
            if(idAba === 'tela-pedido') { renderizarCategoriasUI(); renderizarMenu(categoriaFiltroAtual); }
            if(idAba === 'tela-atalhos') renderizarPainelAtalhos();
            if(idAba === 'tela-videowall') atualizarTelas(); 
            if(idAba === 'tela-entrega') atualizarTelas();
            if(idAba === 'tela-preparo') atualizarTelas();
        }
        function sairVideoWall() { mudarAba('tela-pedido', document.querySelectorAll('nav button')[0]); }

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

            const tagAtiva = document.activeElement.tagName;
            if (tagAtiva === 'INPUT' || tagAtiva === 'TEXTAREA' || tagAtiva === 'SELECT') return;

            const abaEntrega = document.getElementById('tela-entrega');
            if (abaEntrega && abaEntrega.classList.contains('active')) {
                const tecla = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                const cardsBalcao = Array.from(document.querySelectorAll('#fila-entrega .card-pedido'));
                if (cardsBalcao.length === 0) return;

                if (indexPedidoSelecionadoBalcao >= cardsBalcao.length) indexPedidoSelecionadoBalcao = 0;

                if (tecla === atalhosConfig.direita) {
                    indexPedidoSelecionadoBalcao = (indexPedidoSelecionadoBalcao + 1) % cardsBalcao.length;
                    destacarCardBalcao(cardsBalcao);
                } else if (tecla === atalhosConfig.esquerda) {
                    indexPedidoSelecionadoBalcao = (indexPedidoSelecionadoBalcao - 1 + cardsBalcao.length) % cardsBalcao.length;
                    destacarCardBalcao(cardsBalcao);
                } else if (tecla === atalhosConfig.chamar) {
                    const cardAtual = cardsBalcao[indexPedidoSelecionadoBalcao];
                    if (cardAtual) {
                        const btnChamar = cardAtual.querySelector("button[onclick*='chamarNoPainel']");
                        if (btnChamar) btnChamar.click();
                    }
                } else if (tecla === atalhosConfig.entregue) {
                    const cardAtual = cardsBalcao[indexPedidoSelecionadoBalcao];
                    if (cardAtual) {
                        const btnRetirado = cardAtual.querySelector("button[onclick*='finalizarEntrega']");
                        if (btnRetirado) btnRetirado.click();
                    }
                }
            }
        });

        function destacarCardBalcao(cards) {
            cards.forEach(c => c.classList.remove('card-selecionado-teclado'));
            if (cards[indexPedidoSelecionadoBalcao]) {
                cards[indexPedidoSelecionadoBalcao].classList.add('card-selecionado-teclado');
                cards[indexPedidoSelecionadoBalcao].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        function abrirModalTodosPedidos() {
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
                    if (p.statusPainel === 'cancelado') statusTag = '<span style="background:var(--danger); color:white; padding:3px 6px; border-radius:4px; font-weight:bold;">CANCELADO</span>';
                    else if (p.itens.some(i => i.fase === 'mais_tarde')) statusTag = '<span style="background:var(--info); color:white; padding:3px 6px; border-radius:4px; font-weight:bold;">📦 P. MAIS TARDE</span>';
                    else if (p.statusPainel === 'entregue') statusTag = '<span style="background:var(--success); color:white; padding:3px 6px; border-radius:4px; font-weight:bold;">FINALIZADO</span>';
                    else statusTag = '<span style="background:var(--warning); color:black; padding:3px 6px; border-radius:4px; font-weight:bold;">EM PREPARO</span>';

                    let acoes = `
                        <button onclick="reimprimirPedido(${p.id})" class="btn" style="background:#3b82f6; color:white; padding: 4px 8px; font-size: 0.8rem; margin-right: 4px;" title="Imprimir Pedido Completo">🖨️</button>
                    `;
                    if (p.statusPainel !== 'cancelado') {
                        acoes += `
                            <button onclick="editarPedido(${p.id}); fecharModalTodosPedidos();" class="btn btn-warning" style="padding: 4px 8px; font-size: 0.8rem; margin-right: 4px;">✏️ Alterar</button>
                            <button onclick="cancelarPedido(${p.id}); renderizarTabelaModalTodosPedidos();" class="btn btn-danger" style="padding: 4px 8px; font-size: 0.8rem;">🗑️</button>
                        `;
                    } else {
                        acoes += `<span style="color:gray; font-size: 0.8rem;">Bloqueado</span>`;
                    }

                    const tempoPreparo = calcularDiferencaMinutos(p.horaEntradaCozinha || p.hora, p.horaEntrega);

                    tbody.innerHTML += `
                        <tr style="border-bottom: 1px solid #e5e7eb; ${p.statusPainel === 'cancelado' ? 'opacity: 0.5;' : ''}">
                            <td style="padding: 8px; font-weight: bold;">#${p.id}</td>
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
            
            const listaGestao = document.getElementById('lista-gestao-categorias');
            if(listaGestao) {
                listaGestao.innerHTML = categoriasDB.map((cat, index) => `
                    <li class="cat-item">
                        <span style="font-weight: bold;">${cat}</span>
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
        
        function moverCategoria(index, direcao) {
            const novoIndex = index + direcao;
            if (novoIndex < 0 || novoIndex >= categoriasDB.length) return;
            const temp = categoriasDB[index];
            categoriasDB[index] = categoriasDB[novoIndex];
            categoriasDB[novoIndex] = temp;
            salvarNoBancoLocal();
            renderizarCategoriasUI();
            renderizarMenu(categoriaFiltroAtual);
        }

        function adicionarCategoria() {
            let nome = document.getElementById('nova-cat-nome').value.trim(); if (!nome) return;
            nome = nome.charAt(0).toUpperCase() + nome.slice(1); 
            if (categoriasDB.includes(nome)) return exibirAviso("Esta categoria já está cadastrada!");
            categoriasDB.push(nome); document.getElementById('nova-cat-nome').value = ''; 
            salvarNoBancoLocal();
            renderizarCategoriasUI();
        }
        function editarCategoria(nomeAntigo) {
            let novoNome = prompt(`Editar categoria: "${nomeAntigo}"\nDigite o novo nome:`, nomeAntigo);
            if (novoNome && novoNome.trim() !== '') {
                novoNome = novoNome.charAt(0).toUpperCase() + novoNome.slice(1);
                if (categoriasDB.includes(novoNome) && novoNome !== nomeAntigo) return exibirAviso("Esta categoria já existe.");
                categoriasDB[categoriasDB.indexOf(nomeAntigo)] = novoNome;
                produtosDB.forEach(p => { if (p.categoria === nomeAntigo) p.categoria = novoNome; });
                if (categoriaFiltroAtual === nomeAntigo) categoriaFiltroAtual = novoNome;
                salvarNoBancoLocal();
                renderizarCategoriasUI(); renderizarTabelaProdutos(); renderizarMenu(categoriaFiltroAtual);
            }
        }
        function excluirCategoria(nome) {
            if (produtosDB.some(p => p.categoria === nome)) return exibirAviso(`Existem produtos vinculados a "${nome}". Remova os produtos antes.`);
            if (confirm(`Excluir a categoria "${nome}"?`)) { 
                categoriasDB = categoriasDB.filter(c => c !== nome); 
                if (categoriaFiltroAtual === nome) categoriaFiltroAtual = 'Todos'; 
                salvarNoBancoLocal();
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
                document.getElementById('novo-prod-categoria').value = 'Combos';
                document.getElementById('titulo-form-produto').innerText = "Cadastrar Combo";
            } else {
                document.getElementById('box-estoque-simples').style.display = 'block';
                document.getElementById('box-cozinha-simples').style.display = 'block';
                document.getElementById('box-itens-combo').style.display = 'none';
                document.getElementById('titulo-form-produto').innerText = "Cadastrar Produto";
            }
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

        function toggleStatusAtivoProduto(id) {
            const p = produtosDB.find(prod => prod.id === id);
            if (p) {
                p.ativo = !p.ativo;
                salvarNoBancoLocal();
                renderizarTabelaProdutos();
                renderizarMenu(categoriaFiltroAtual);
            }
        }

        function renderizarTabelaProdutos() {
            const tbody = document.getElementById('tabela-produtos'); tbody.innerHTML = '';
            produtosDB.forEach(p => {
                let desc = p.isCombo ? `<br><small style="color:var(--info);">↳ Composto por: ${p.itensCombo.map(i => {
                    if(i.tipo === 'categoria') return `${i.qtd}x Escolha de ${i.ref}`;
                    else { let subP = produtosDB.find(x=>x.id===i.ref); return `${i.qtd}x ${subP?subP.nome:'Fixo'}`; }
                }).join(', ')}</small>` : '';

                let txtEstoque = p.isCombo ? '<span style="color:gray;">Misto</span>' : (p.estoque !== null ? `${p.estoque} un.` : '∞ (Livre)');
                let corEstoque = (!p.isCombo && p.estoque !== null && p.estoque <= 5) ? 'color: var(--danger);' : '';
                let imgThumb = p.foto ? `<img src="${p.foto}" style="width:40px; height:40px; object-fit:contain; background:#f8fafc; border-radius:6px; padding:2px; border:1px solid #ddd;">` : '<span style="color:gray; font-size:0.75rem;">Sem foto</span>';

                let badgeStatus = p.ativo !== false 
                    ? `<button class="btn btn-success" style="padding:3px 8px; font-size:0.75rem;" onclick="toggleStatusAtivoProduto(${p.id})">🟢 Ativo</button>`
                    : `<button class="btn btn-danger" style="padding:3px 8px; font-size:0.75rem;" onclick="toggleStatusAtivoProduto(${p.id})">🔴 Inativo</button>`;

                tbody.innerHTML += `
                    <tr style="border-bottom: 1px solid #f3f4f6; ${p.ativo === false ? 'opacity: 0.6; background:#fef2f2;' : ''}">
                        <td style="padding: 10px; font-weight: bold;">#${p.id}</td>
                        <td>${imgThumb}</td>
                        <td>${badgeStatus}</td>
                        <td>${p.nome} ${desc} <br><span style="font-size: 0.8rem; color: gray;">${p.cozinha ? '👨‍🍳 Cozinha' : '🛍️ Balcão'}</span></td>
                        <td><span style="background:#e5e7eb; padding:2px 6px; border-radius:4px; font-size:0.8rem;">${p.categoria}</span></td>
                        <td style="font-weight: bold;">R$ ${p.preco.toFixed(2)}</td><td style="${corEstoque}">${txtEstoque}</td>
                        <td style="white-space: nowrap;">
                            <button class="btn btn-warning" style="padding: 4px; font-size: 0.8rem; color: black;" onclick="prepararEdicaoProduto(${p.id})">✏️</button> 
                            ${!p.isCombo ? `<button class="btn btn-primary" style="padding: 4px; font-size: 0.8rem;" onclick="adicionarEstoqueManual(${p.id})">📦 +</button>` : ''}
                            <button class="btn btn-danger" style="padding: 4px; font-size: 0.8rem;" onclick="apagarProduto(${p.id})">🗑️</button>
                        </td>
                    </tr>`;
            });
        }
        
        function prepararEdicaoProduto(id) {
            const p = produtosDB.find(prod => prod.id === id);
            document.getElementById('novo-prod-nome').value = p.nome; 
            document.getElementById('novo-prod-preco').value = p.preco;
            document.getElementById('novo-prod-categoria').value = p.categoria;
            document.getElementById('novo-prod-foto').value = p.foto || '';
            document.getElementById('novo-prod-ativo').value = (p.ativo !== false).toString();

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
                document.getElementById('novo-prod-estoque').value = p.estoque !== null ? p.estoque : ''; 
                document.getElementById('novo-prod-cozinha').value = p.cozinha ? 'true' : 'false'; 
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
            document.getElementById('novo-prod-estoque').value = '';
            document.getElementById('novo-prod-foto').value = '';
            document.getElementById('file-prod-foto').value = '';
            document.getElementById('novo-prod-ativo').value = "true";
            document.getElementById('preview-foto-container').style.display = 'none';

            comboTemporario = []; renderizarListaComboTemporario();
            mudarModoCadastro('simples');
            document.getElementById('btn-salvar-produto').innerText = "Salvar 💾";
            document.getElementById('btn-salvar-produto').classList.replace('btn-warning', 'btn-primary'); 
            document.getElementById('btn-cancelar-edicao-prod').style.display = 'none';
        }

        function salvarProduto() {
            let nome = document.getElementById('novo-prod-nome').value.trim(); 
            let preco = parseFloat(document.getElementById('novo-prod-preco').value);
            let categoria = document.getElementById('novo-prod-categoria').value; 
            let foto = document.getElementById('novo-prod-foto').value.trim();
            let ativo = document.getElementById('novo-prod-ativo').value === 'true';

            if (!nome || isNaN(preco) || preco <= 0 || !categoria) return exibirAviso("Preencha todos os campos do produto corretamente.");
            
            let isCombo = (modoCadastroAtivo === 'combo');
            let cozinha = false;
            let estoqueFinal = null;
            let finalItensCombo = [];

            if (isCombo) {
                if (comboTemporario.length === 0) return exibirAviso("O combo precisa ter pelo menos 1 item incluso!");
                finalItensCombo = JSON.parse(JSON.stringify(comboTemporario));
                cozinha = true;
            } else {
                cozinha = document.getElementById('novo-prod-cozinha').value === 'true';
                let estoqueInput = document.getElementById('novo-prod-estoque').value.trim();
                estoqueFinal = estoqueInput === '' ? null : parseInt(estoqueInput);
                
                if (estoqueFinal !== null && estoqueFinal <= 0) {
                    ativo = false;
                }
            }

            if (produtoEmEdicaoId !== null) {
                let p = produtosDB.find(prod => prod.id === produtoEmEdicaoId);
                p.nome = nome; p.preco = preco; p.categoria = categoria; p.cozinha = cozinha; 
                p.isCombo = isCombo; p.estoque = estoqueFinal; p.itensCombo = finalItensCombo; p.foto = foto; p.ativo = ativo;
                cancelarEdicaoProduto(); 
            } else {
                produtosDB.push({ 
                    id: produtosDB.length > 0 ? Math.max(...produtosDB.map(p => p.id)) + 1 : 1, 
                    nome, preco, categoria, cozinha, isCombo, estoque: estoqueFinal, itensCombo: finalItensCombo, foto, ativo 
                });
                cancelarEdicaoProduto(); 
            }
            salvarNoBancoLocal();
            renderizarCategoriasUI();
            renderizarTabelaProdutos(); renderizarMenu(categoriaFiltroAtual);
        }

        function adicionarEstoqueManual(idProduto) {
            const p = produtosDB.find(prod => prod.id === idProduto); 
            if(p.isCombo) return;
            if(p.estoque === null) return exibirAviso("Este produto possui Estoque Livre.");
            const add = prompt(`Adicionar estoque ao ${p.nome} (Atual: ${p.estoque}):`);
            if(add && !isNaN(add)) { 
                p.estoque += parseInt(add); 
                if (p.estoque > 0) p.ativo = true;
                salvarNoBancoLocal();
                renderizarTabelaProdutos(); renderizarMenu(categoriaFiltroAtual); 
            }
        }

        function apagarProduto(idProduto) {
            if (confirm(`Excluir produto/combo?`)) { 
                produtosDB = produtosDB.filter(p => p.id !== idProduto); 
                if (produtoEmEdicaoId === idProduto) cancelarEdicaoProduto(); 
                salvarNoBancoLocal();
                renderizarCategoriasUI();
                renderizarTabelaProdutos(); 
                renderizarMenu(categoriaFiltroAtual); 
            }
        }

        function imprimirEstoquePorCategoria() {
            const areaPrint = document.getElementById('area-impressao');
            
            let agrupado = {};
            categoriasDB.forEach(cat => { agrupado[cat] = []; });
            produtosDB.forEach(p => {
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
                        let txtEstoque = p.isCombo ? 'Misto' : (p.estoque !== null ? `${p.estoque} un.` : 'Livre');
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

            window.print();
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
            
            const produtosDisponiveisVenda = produtosDB.filter(p => p.ativo !== false);

            const renderCardHTML = (produto) => {
                let badgeEstoque = ''; let opacity = '1'; let descCombo = '';
                if (produto.isCombo) {
                    badgeEstoque = `<div class="badge-combo">✨ COMBO</div>`;
                    let qtdTotal = produto.itensCombo.reduce((acc, i)=>acc+i.qtd, 0);
                    descCombo = `<div style="font-size: 0.65rem; color: gray; margin-top:1px;">Contém: ${qtdTotal} itens</div>`;
                } else if (produto.estoque !== null) {
                    if (produto.estoque <= 0) { badgeEstoque = `<div class="badge-estoque estoque-baixo">ESGOTADO</div>`; opacity = '0.5'; }
                    else if (produto.estoque <= 5) badgeEstoque = `<div class="badge-estoque estoque-baixo">Restam ${produto.estoque}</div>`;
                    else badgeEstoque = `<div class="badge-estoque">Est: ${produto.estoque}</div>`;
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
                        let cards = agrupado[cat].map(p => renderCardHTML(p)).join('');
                        htmlGeral += `
                            <div class="subgrupo-header">📁 ${cat}</div>
                            <div class="subgrupo-container">${cards}</div>
                        `;
                    }
                }
                menuDiv.innerHTML = htmlGeral || '<p style="color: gray; text-align:center;">Nenhum produto ativo encontrado.</p>';
            } else {
                const itens = produtosFiltrados.filter(p => p.categoria === filtro);
                if (itens.length === 0) {
                    menuDiv.innerHTML = '<p style="color: gray; text-align:center;">Nenhum produto ativo nesta categoria.</p>';
                } else {
                    let cards = itens.map(p => renderCardHTML(p)).join('');
                    menuDiv.innerHTML = `<div class="subgrupo-container" style="margin-top:5px;">${cards}</div>`;
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
                        const opcoes = produtosDB.filter(p => p.categoria === req.ref && !p.isCombo && p.ativo !== false);
                        const optionsHtml = opcoes.map(p => {
                            let disp = p.estoque !== null ? ` (Restam ${p.estoque})` : '';
                            let block = (p.estoque !== null && p.estoque <= 0) ? 'disabled' : '';
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

        function confirmarCombo() {
            if (!caixaAberto) {
                return exibirAviso("🔒 O Caixa está fechado! Abra o caixa antes de fazer vendas.", "Caixa Fechado");
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
        }

        function abrirModalObs(cartId) {
            obsCartIdAtual = cartId;
            const item = carrinho.find(i => i.cartId === cartId);
            document.getElementById('modal-obs-nome-item').innerText = `Item: ${item.nome}`;
            document.getElementById('input-obs-texto').value = item.obs || '';
            document.getElementById('modal-obs').style.display = 'flex';
            document.getElementById('input-obs-texto').focus();
        }

        function fecharModalObs() {
            document.getElementById('modal-obs').style.display = 'none';
            obsCartIdAtual = null;
        }

        function salvarObsModal() {
            if (obsCartIdAtual !== null) {
                const texto = document.getElementById('input-obs-texto').value.trim();
                const item = carrinho.find(i => i.cartId === obsCartIdAtual);
                if (item) item.obs = texto;
            }
            fecharModalObs();
            atualizarCarrinhoUI();
        }

        function abrirModalTrocaItem(idPedido, cartId) {
            trocaItemPedidoId = idPedido;
            trocaItemCartId = cartId;
            const pedido = pedidosGerais.find(p => p.id === idPedido);
            const item = pedido.itens.find(i => i.cartId === cartId);
            
            if (!item || item.cozinha) return exibirAviso("Apenas itens de balcão (sem cozinha) podem ser trocados aqui!");

            const prodOriginal = produtosDB.find(p => p.id === item.idProduto);
            const precoItem = item.preco || (prodOriginal ? prodOriginal.preco : 0);

            document.getElementById('modal-troca-info').innerText = `Pedido #${pedido.id} (${pedido.cliente}) - Item atual: ${item.nome} (R$ ${precoItem.toFixed(2)})`;
            
            const produtosDisponiveis = produtosDB.filter(p => p.categoria === item.categoria && !p.isCombo && Math.abs(p.preco - precoItem) < 0.01 && p.ativo !== false);
            const select = document.getElementById('select-novo-item-troca');
            
            if (produtosDisponiveis.length === 0) {
                select.innerHTML = '<option value="">Nenhum produto ativo com o mesmo valor nesta categoria</option>';
            } else {
                select.innerHTML = produtosDisponiveis.map(p => {
                    let disp = p.estoque !== null ? ` (Restam ${p.estoque})` : '';
                    return `<option value="${p.id}">${p.nome} - R$ ${p.preco.toFixed(2)}${disp}</option>`;
                }).join('');
            }

            document.getElementById('modal-troca-item').style.display = 'flex';
        }

        function fecharModalTroca() {
            document.getElementById('modal-troca-item').style.display = 'none';
            trocaItemPedidoId = null;
            trocaItemCartId = null;
        }

        function confirmarTrocaItemBalcao() {
            const selectVal = document.getElementById('select-novo-item-troca').value;
            if (!selectVal) return exibirAviso("Selecione um produto válido para a troca.");
            
            const novoIdProduto = parseInt(selectVal);
            const novoProduto = produtosDB.find(p => p.id === novoIdProduto);
            if (!novoProduto) return;

            const pedido = pedidosGerais.find(p => p.id === trocaItemPedidoId);
            const item = pedido.itens.find(i => i.cartId === trocaItemCartId);

            const prodAntigo = produtosDB.find(p => p.id === item.idProduto);
            if (prodAntigo && prodAntigo.estoque !== null) {
                prodAntigo.estoque += 1;
                if (prodAntigo.estoque > 0) prodAntigo.ativo = true;
            }

            if (novoProduto.estoque !== null) {
                if (novoProduto.estoque <= 0) {
                    exibirAviso("Atenção: Este produto estava sem estoque, mas a troca foi efetuada.");
                }
                novoProduto.estoque -= 1;
                if (novoProduto.estoque <= 0) {
                    novoProduto.ativo = false;
                }
            }

            item.idProduto = novoProduto.id;
            item.nome = novoProduto.nome;
            item.categoria = novoProduto.categoria;
            item.preco = novoProduto.preco;

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

        function atualizarValoresMisto(origem = '1') {
            const total = carrinho.reduce((acc, item) => acc + (item.preco * item.qtd), 0);
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
            const total = carrinho.reduce((acc, item) => acc + (item.preco * item.qtd), 0);
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
            if(!p || p.estoque === null) return true; 
            
            let countCart = 0;
            carrinho.forEach(ci => {
                if(ci.isCombo) {
                    ci.itensComboEscolhidos.forEach(sub => { if(sub.idProduto === idProduto) countCart += 1; });
                } else {
                    if(ci.idProduto === idProduto) countCart += 1; 
                }
            });

            if (countCart + qtdParaAdicionar > p.estoque) {
                exibirAviso(`Estoque insuficiente de ${p.nome}! Restam ${p.estoque} unidades.`);
                return false;
            }
            return true;
        }

        function mudarTipoRetiradaGlobal() {
            const tipo = document.getElementById('tipo-retirada-global').value;
            carrinho.forEach(item => item.fase = (tipo === 'parcial' ? item.fase : tipo)); 
            atualizarCarrinhoUI();
        }

        function addCarrinho(idProduto) {
            if (!caixaAberto) {
                return exibirAviso("🔒 O Caixa está fechado! Abra o caixa no Dashboard antes de adicionar pedidos.", "Caixa Fechado");
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
            
            if(!verificarEstoqueDisponivel(idProduto, 1)) return;
            
            let tipoGlobal = document.getElementById('tipo-retirada-global').value;
            let fase = tipoGlobal === 'mais_tarde' ? 'mais_tarde' : 'agora';
            
            carrinho.push({ 
                cartId: Date.now().toString() + Math.floor(Math.random()*1000), 
                idProduto: produto.id, nome: produto.nome, preco: produto.preco, 
                categoria: produto.categoria, cozinha: produto.cozinha, 
                isCombo: false, qtd: 1, obs: '', fase: fase 
            });
            atualizarCarrinhoUI();
        }

        function removerItemCarrinho(cartId) {
            carrinho = carrinho.filter(i => i.cartId !== cartId);
            atualizarCarrinhoUI();
        }

        function setFaseItem(cartId, novaFase) { carrinho.find(i => i.cartId === cartId).fase = novaFase; atualizarCarrinhoUI(); }
        
        function atualizarCarrinhoUI() {
            const divItens = document.getElementById('itens-carrinho'); 
            const tipoGlobal = document.getElementById('tipo-retirada-global').value;
            divItens.innerHTML = ''; let total = 0;
            if (carrinho.length === 0) divItens.innerHTML = '<p style="color:gray; text-align:center;">Nenhum item adicionado.</p>';
            
            let temItemCozinha = false;

            carrinho.forEach(item => {
                total += (item.preco * item.qtd);
                if (item.cozinha || (item.isCombo && item.itensComboEscolhidos.some(sub => sub.cozinha))) {
                    temItemCozinha = true;
                }

                let htmlFase = tipoGlobal === 'parcial' 
                    ? `<select onchange="setFaseItem('${item.cartId}', this.value)" style="margin:0; padding:6px; font-size:0.85rem;"><option value="agora" ${item.fase==='agora'?'selected':''}>Agora</option><option value="mais_tarde" ${item.fase==='mais_tarde'?'selected':''}>Depois</option></select>`
                    : `<span style="font-size:0.8rem; background:#f3f4f6; padding:4px;">${item.fase === 'agora' ? '🟢 Agora' : '📦 Depois'}</span>`;
                
                let descCombo = item.isCombo ? `<div style="font-size:0.75rem; color:gray; margin-top:2px;">↳ Contém: ${item.itensComboEscolhidos.map(sub=>`1x ${sub.nome}`).join(', ')}</div>` : '';

                divItens.innerHTML += `
                    <div class="item-carrinho">
                        <div style="display:flex; justify-content:space-between;"><b>1x ${item.nome}</b><b>R$ ${(item.preco).toFixed(2)}</b></div>
                        ${descCombo}
                        ${item.obs ? `<div style="color:var(--danger); font-size:0.85rem; margin-top:4px;">📝 Observação: ${item.obs}</div>` : ''}
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                            <div style="display:flex; gap:8px;">${htmlFase} <button class="btn btn-warning" style="padding:6px; font-size:0.8rem;" onclick="abrirModalObs('${item.cartId}')">Observação</button></div>
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

            document.getElementById('total-carrinho').innerText = total.toFixed(2);
            atualizarValoresMisto();
        }

        function limparCarrinho() {
            carrinho = []; document.getElementById('nome-cliente').value = '';
            document.getElementById('valor-recebido-dinheiro').value = '';
            document.getElementById('obs-bonificacao').value = '';
            
            document.getElementById('forma-pagto').value = '';
            document.getElementById('tipo-retirada-global').value = '';
            document.getElementById('tipo-atendimento').value = '';

            toggleCampoDinheiro();

            pedidoEmEdicaoId = null;
            document.getElementById('banner-alerta-edicao').style.display = 'none';
            document.getElementById('box-status-edicao').style.display = 'none';
            document.getElementById('box-carrinho-container').classList.remove('modo-edicao');
            document.getElementById('titulo-painel-carrinho').innerText = "Pedido Atual";
            document.getElementById('btn-finalizar-pedido').innerHTML = `Cobrar, Imprimir e Enviar 🖨️`;
            document.getElementById('btn-finalizar-pedido').classList.replace('btn-warning', 'btn-primary');

            atualizarCarrinhoUI();
        }

        function finalizarPedido() {
            if (!caixaAberto) {
                return exibirAviso("🔒 O Caixa está fechado! Abra o caixa antes de finalizar pedidos.", "Caixa Fechado");
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
            if (!tipoGlobalRetirada) {
                return exibirAviso("Por favor, selecione o Modo de Retirada (Global)!");
            }
            if (!tipoAtendimento) {
                return exibirAviso("Por favor, selecione o Tipo de Retirada (Levar ou Local)!");
            }

            const total = carrinho.reduce((acc, item) => acc + (item.preco * item.qtd), 0);

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

            if (pedidoEmEdicaoId !== null) {
                statusPainelCalculado = document.getElementById('status-pedido-edicao').value;
                const pedidoExistente = pedidosGerais.find(p => p.id === pedidoEmEdicaoId);
                if (pedidoExistente) {
                    horaEntradaCozinhaCalculada = pedidoExistente.horaEntradaCozinha;
                    horaEntregaCalculada = statusPainelCalculado === 'entregue' ? (pedidoExistente.horaEntrega || horaAtual) : pedidoExistente.horaEntrega;
                }
            } else {
                const vaiParaCozinha = tipoGlobalRetirada !== 'agora_sem_cozinha' && carrinho.some(i => i.fase === 'agora' && (i.cozinha || (i.isCombo && i.itensComboEscolhidos && i.itensComboEscolhidos.some(sub=>sub.cozinha))));
                statusPainelCalculado = vaiParaCozinha ? 'preparando' : (tipoGlobalRetirada === 'agora_sem_cozinha' ? 'entregue' : 'nenhum');
                horaEntradaCozinhaCalculada = vaiParaCozinha ? horaAtual : null;
                horaEntregaCalculada = (!vaiParaCozinha && tipoGlobalRetirada === 'agora_sem_cozinha') ? horaAtual : null;
            }

            const novoPedido = {
                id: pedidoEmEdicaoId !== null ? pedidoEmEdicaoId : contadorPedidos++,
                cliente: cliente, pagamento: formaPagto, tipoAtendimento: tipoAtendimento,
                total: total, data: dataAtual, hora: horaAtual,
                detalhesMisto: detalhesMisto,
                horaEntradaCozinha: horaEntradaCozinhaCalculada,
                horaEntrega: horaEntregaCalculada,
                statusPainel: statusPainelCalculado,
                itens: JSON.parse(JSON.stringify(carrinho)) 
            };

            if (pedidoEmEdicaoId !== null) {
                pedidosGerais.find(p => p.id === pedidoEmEdicaoId).itens.forEach(item => {
                    if(item.isCombo) {
                        item.itensComboEscolhidos.forEach(sub => { 
                            let subP = produtosDB.find(x=>x.id===sub.idProduto); 
                            if(subP && subP.estoque!==null) {
                                subP.estoque += 1;
                                if (subP.estoque > 0) subP.ativo = true;
                            } 
                        });
                    } else {
                        let prod = produtosDB.find(p => p.id === item.idProduto); 
                        if(prod && prod.estoque !== null) {
                            prod.estoque += 1;
                            if (prod.estoque > 0) prod.ativo = true;
                        }
                    }
                });
                pedidosGerais = pedidosGerais.filter(p => p.id !== pedidoEmEdicaoId);
            }

            carrinho.forEach(item => {
                if(item.isCombo) {
                    item.itensComboEscolhidos.forEach(sub => { 
                        let subP = produtosDB.find(x=>x.id===sub.idProduto); 
                        if(subP && subP.estoque!==null) {
                            subP.estoque -= 1;
                            if (subP.estoque <= 0) subP.ativo = false;
                        } 
                    });
                } else {
                    let prod = produtosDB.find(p => p.id === item.idProduto); 
                    if(prod && prod.estoque !== null) {
                        prod.estoque -= 1;
                        if (prod.estoque <= 0) prod.ativo = false;
                    }
                }
            });

            pedidosGerais.push(novoPedido);
            salvarNoBancoLocal();

            gerarHTMLImpressao(novoPedido); 
            window.print();

            limparCarrinho(); 
            renderizarMenu(categoriaFiltroAtual); 
            renderizarTabelaProdutos(); 
            atualizarTelas();
        }

        function gerarHTMLImpressao(pedido) {
            const areaPrint = document.getElementById('area-impressao');
            const iAgora = pedido.itens.filter(i => i.fase === 'agora' || i.fase === 'entregue'); 
            const iDepois = pedido.itens.filter(i => i.fase === 'mais_tarde');
            
            const htmlItem = (i) => {
                let det = '';
                if(i.isCombo) { det = `<div style="font-size:12px; font-weight:bold; padding-left:5px; color:#000;">↳ ${i.itensComboEscolhidos.map(sub=> `1x ${sub.nome}`).join('<br>↳ ')}</div>`; }
                let obs = i.obs ? `<div style="font-size:12px; font-weight:bold;">Observação: ${i.obs}</div>` : '';
                return `<div style="margin-top:5px;"><div class="print-row"><span class="print-bold">1x ${i.nome}</span><span class="print-bold">R$ ${(i.preco).toFixed(2)}</span></div>${det}${obs}</div>`;
            };
            
            areaPrint.innerHTML = `
                <div class="print-center print-bold" style="font-size: 16px;">SANTUÁRIO SANTA RITA</div>
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="font-size: 42px; margin: 5px 0;">#${pedido.id}</div>
                <div class="print-center print-bold" style="font-size: 26px; margin-bottom: 5px; text-transform: uppercase;">${pedido.cliente}</div>
                <div class="print-center print-bold" style="font-size: 14px; margin-bottom: 10px;">[ ${pedido.tipoAtendimento} ]</div>
                <div class="print-center print-bold">${pedido.data} - ${pedido.hora}</div>
                <div class="print-divider"></div>
                ${iAgora.length ? `<div class="print-center print-bold" style="margin-bottom:5px;">(RETIRAR AGORA)</div>` + iAgora.map(htmlItem).join('') : ''}
                ${iDepois.length ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">[ RETIRAR DEPOIS ]</div>` + iDepois.map(htmlItem).join('') : ''}
                <div class="print-divider"></div>
                
                <div class="print-pagto-box">
                    PAGAMENTO: ${pedido.pagamento}
                </div>
                
                <div class="print-row print-bold" style="font-size: 16px; margin-top:6px;"><span>TOTAL:</span><span>R$ ${pedido.total.toFixed(2)}</span></div>
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-top: 15px; font-size: 12px; line-height: 1.3;">
                    Muito obrigado pela sua ajuda! Que Santa Rita interceda e derrame muitas bênçãos sobre a sua vida e a de sua família. 🙏
                </div>
            `;
        }

        function obterDadosRelatorioCaixa() {
            const validos = pedidosGerais.filter(p => p.statusPainel !== 'cancelado');
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

                    p.itens.forEach(i => {
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
                resumoProdutosVendidos
            };
        }

        function imprimirRelatorioCaixaAtual() {
            const dados = obterDadosRelatorioCaixa();
            let htmlProdsPrint = '';
            for (let prod in dados.resumoProdutosVendidos) {
                htmlProdsPrint += `<div class="print-row"><span>${prod}</span><span class="print-bold">${dados.resumoProdutosVendidos[prod]} un</span></div>`;
            }

            let htmlBonoPrint = '';
            if (dados.bonificacoesLista.length > 0) {
                htmlBonoPrint = dados.bonificacoesLista.map(b => {
                    const resumo = b.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ');
                    return `<div style="font-size:11px; margin-bottom:3px; font-weight:bold;"><b>#${b.id} ${b.cliente}:</b> ${resumo} (${b.pagamento})</div>`;
                }).join('');
            }

            const dataHora = new Date().toLocaleString('pt-BR');

            const areaPrint = document.getElementById('area-impressao');
            areaPrint.innerHTML = `
                <div class="print-center print-bold" style="font-size: 16px;">SANTUÁRIO SANTA RITA</div>
                <div class="print-center print-bold" style="font-size: 13px; margin-top: 4px;">RELATÓRIO DO CAIXA ATUAL</div>
                <div class="print-center print-bold" style="font-size:10px; margin-bottom: 5px;">Emitido em: ${dataHora}</div>
                <div class="print-divider"></div>
                <div class="print-row"><span>Status do Caixa:</span><span class="print-bold">${caixaAberto ? 'ABERTO' : 'FECHADO'}</span></div>
                <div class="print-row"><span>Abertura:</span><span class="print-bold">${dataHoraAberturaCaixa || '-'}</span></div>
                <div class="print-divider"></div>
                
                <div class="print-center print-bold" style="font-size: 13px; margin-bottom:2px;">FATURAMENTO TOTAL VENDAS</div>
                <div class="print-center print-bold" style="font-size: 28px; margin-bottom:5px;">R$ ${dados.totalVendas.toFixed(2)}</div>
                
                <div class="print-divider"></div>
                <div class="print-row"><span>Fundo Inicial:</span><span class="print-bold">R$ ${valorFundoCaixa.toFixed(2)}</span></div>
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
                ${htmlProdsPrint ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">PRODUTOS VENDIDOS</div>${htmlProdsPrint}` : ''}
                ${htmlBonoPrint ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">🎁 BONIFICAÇÕES / CORTESIAS (${dados.qtdBonificacoes} ped)</div>${htmlBonoPrint}` : ''}
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-top: 10px; font-size: 10px;">
                    Documento de Conferência Parcial de Caixa
                </div>
            `;

            window.print();
        }

        function gerarPDFCaixaAtual() {
            const dados = obterDadosRelatorioCaixa();
            const dataHora = new Date().toLocaleString('pt-BR');

            let htmlTabelaProdutos = '';
            for (let prod in dados.resumoProdutosVendidos) {
                htmlTabelaProdutos += `
                    <tr>
                        <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${prod}</td>
                        <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 800; color: #2563eb;">${dados.resumoProdutosVendidos[prod]} un.</td>
                    </tr>
                `;
            }

            let htmlTabelaBonificacoes = '';
            if (dados.bonificacoesLista.length > 0) {
                htmlTabelaBonificacoes = dados.bonificacoesLista.map(b => {
                    const resumoItens = b.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ');
                    return `
                        <tr>
                            <td style="padding: 8px; border-bottom: 1px solid #fee2e2; font-weight: bold; color: #991b1b;">#${b.id} ${b.cliente}</td>
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
                    <p style="margin: 5px 0 0 0; font-size: 12px; color: #6b7280;">Emitido em: ${dataHora} | Status: <b>${caixaAberto ? 'ABERTO' : 'FECHADO'}</b> | Abertura: <b>${dataHoraAberturaCaixa || '-'}</b></p>
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
                </div>

                <div style="margin-bottom: 25px;">
                    <h3 style="font-size: 14px; text-transform: uppercase; border-bottom: 2px solid #e5e7eb; padding-bottom: 5px; color: #111827; margin-top: 0;">Resumo do Atendimento</h3>
                    <div style="display: flex; justify-content: space-between; background: #f8fafc; padding: 12px; border-radius: 6px; font-size: 13px; font-weight: bold;">
                        <span>Fundo Inicial de Caixa: R$ ${valorFundoCaixa.toFixed(2)}</span>
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
            if (pedido) { gerarHTMLImpressao(pedido); window.print(); }
        }

        function moverParaAgora(id) { 
            const p = pedidosGerais.find(x => x.id === id); 
            const horaAtual = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            
            p.itens.forEach(i => { if(i.fase==='mais_tarde') i.fase='agora'; }); 
            p.statusPainel = 'preparando'; 
            if (!p.horaEntradaCozinha) p.horaEntradaCozinha = horaAtual;

            salvarNoBancoLocal();
            atualizarTelas(); 
        }

        function chamarNoPainel(id) { 
            const p = pedidosGerais.find(x => x.id === id);
            p.statusPainel = 'pronto'; 
            tocarBeep(); 
            salvarNoBancoLocal();
            atualizarTelas(); 
        }
        
        function finalizarEntrega(id) { 
            const p = pedidosGerais.find(x => x.id === id);
            const horaAtual = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            
            p.itens.forEach(i => { if(i.fase === 'agora') i.fase = 'entregue'; });
            p.statusPainel = 'entregue'; 
            p.horaEntrega = horaAtual;

            salvarNoBancoLocal();
            atualizarTelas(); 
        }

        function cancelarPedido(id) {
            if(confirm(`Tem certeza que deseja CANCELAR o Pedido #${id}?`)) {
                const p = pedidosGerais.find(x => x.id === id);
                if (p && p.statusPainel !== 'cancelado') {
                    p.itens.forEach(item => { 
                        if(item.isCombo) {
                            item.itensComboEscolhidos.forEach(sub => { 
                                let subP = produtosDB.find(x=>x.id===sub.idProduto); 
                                if(subP && subP.estoque!==null) {
                                    subP.estoque += 1;
                                    if (subP.estoque > 0) subP.ativo = true;
                                } 
                            });
                        } else {
                            let prod = produtosDB.find(px => px.id === item.idProduto); 
                            if(prod && prod.estoque !== null) {
                                prod.estoque += 1;
                                if (prod.estoque > 0) prod.ativo = true;
                            }
                        }
                    });
                    p.statusPainel = 'cancelado'; 
                    salvarNoBancoLocal();
                    renderizarMenu(categoriaFiltroAtual); 
                    renderizarTabelaProdutos(); 
                    atualizarTelas(); 
                    atualizarFiltrosGestao();
                    exibirAviso(`Pedido #${id} cancelado com sucesso e estoque devolvido!`);
                }
            }
        }

        function atualizarTelas() {
            let htmlCozinha = '', htmlBalcao = '', htmlAgenda = '', htmlPrepTV = '';
            let countCoz = 0, countBalc = 0, countAgend = 0;
            let prontos = [], entregues = [];

            // MAPAS PARA AS SIDEBARS EM FORMATO DE TABELA
            let resumoBalcaoCozinha = {};
            let resumoBalcaoFicha = {};
            let resumoProducaoCozinha = {};

            pedidosGerais.forEach(p => {
                if(p.statusPainel === 'cancelado') return;
                
                const iAgoraPendentes = p.itens.filter(i => i.fase === 'agora');
                const iDepois = p.itens.filter(i => i.fase === 'mais_tarde');

                let itensPurosCozinha = [];
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
                            itensPurosCozinha.push({nome: item.nome, obs: item.obs});
                            resumoProducaoCozinha[item.nome] = (resumoProducaoCozinha[item.nome] || 0) + item.qtd;
                        }
                    }
                });

                // FILTRO DE COZINHA: MOSTRA APENAS SE TIVER ITENS DE PRODUÇÃO
                if(p.statusPainel === 'preparando' && itensPurosCozinha.length > 0) {
                    countCoz++;
                    const itensDetalhadosCozinha = itensPurosCozinha.map(i => `
                        <div style="border-bottom:1px dashed #ccc; padding:6px 0;">
                            <b>1x ${i.nome}</b> 
                            ${i.comboPai ? `<br><small style="color:gray;">(Vem do ${i.comboPai})</small>` : ''}
                            ${i.obs ? `<br><i style="color:red;font-size:0.8rem; font-weight:bold;">Observação: ${i.obs}</i>`:''}
                        </div>
                    `).join('');

                    htmlCozinha += `
                        <div class="card-pedido"><div class="status-bar bg-warning"></div>
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <h3 style="margin:0;">#${p.id}</h3>
                            <b style="text-transform: uppercase; font-size: 1.1rem; color: #111827;">${p.cliente}</b>
                        </div>
                        <div style="font-size: 0.85rem; font-weight: bold; color: var(--primary); margin-top: 2px; margin-bottom: 5px;">[ ${p.tipoAtendimento || 'Levar (Viagem)'} ]</div>
                        <div class="lista-itens" style="margin-top:0;">${itensDetalhadosCozinha}</div>
                        </div>`;
                }

                if((p.statusPainel === 'preparando' || p.statusPainel === 'pronto' || p.statusPainel === 'nenhum') && iAgoraPendentes.length > 0) {
                    countBalc++;
                    
                    let btn = (p.statusPainel === 'preparando' || p.statusPainel === 'nenhum') ? `
                        <div style="display:flex; gap:5px;">
                            <button class="btn btn-warning" style="width:100%;" onclick="chamarNoPainel(${p.id})">🔔 Chamar Painel</button>
                        </div>` : `
                        <div style="display:flex; gap:5px;">
                            <button class="btn btn-warning" style="width:50%; padding:8px; font-size:0.8rem;" onclick="chamarNoPainel(${p.id})">🔔 Re-chamar</button>
                            <button class="btn btn-success" style="width:50%;" onclick="finalizarEntrega(${p.id})">✅ Retirado</button>
                        </div>`;
                    
                    const itensDetalhadosBalcao = iAgoraPendentes.map(item => {
                        resumoBalcaoCozinha[item.nome] = (resumoBalcaoCozinha[item.nome] || 0) + item.qtd;

                        if (item.isCombo) {
                            return item.itensComboEscolhidos.map(sub => {
                                let btnTrocaSub = (!sub.cozinha && (p.statusPainel === 'pronto' || p.statusPainel === 'preparando')) ? `<button class="btn btn-warning" style="padding:2px 6px; font-size:0.75rem; margin-left:5px;" onclick="abrirModalTrocaItem(${p.id}, '${item.cartId}')" title="Trocar Sabor/Produto">✏️ Trocar</button>` : '';
                                return `
                                    <div style="border-bottom:1px dashed #ccc; padding:6px 0; display:flex; justify-content:space-between; align-items:center;">
                                        <div><b>1x ${sub.nome}</b> <small style="color:gray;">(Do ${item.nome})</small>${item.obs ? `<br><i style="color:red;font-size:0.8rem;">Obs: ${item.obs}</i>`:''}</div>
                                        <div>${btnTrocaSub}</div>
                                    </div>
                                `;
                            }).join('');
                        } else {
                            let btnTroca = (!item.cozinha && (p.statusPainel === 'pronto' || p.statusPainel === 'preparando')) ? `<button class="btn btn-warning" style="padding:2px 6px; font-size:0.75rem; margin-left:5px;" onclick="abrirModalTrocaItem(${p.id}, '${item.cartId}')" title="Trocar Sabor/Produto">✏️ Trocar</button>` : '';
                            return `
                                <div style="border-bottom:1px dashed #ccc; padding:6px 0; display:flex; justify-content:space-between; align-items:center;">
                                    <div><b>1x ${item.nome}</b>${item.obs ? `<br><i style="color:red;font-size:0.8rem;">Obs: ${item.obs}</i>`:''}</div>
                                    <div style="display:flex; align-items:center; gap:4px;">
                                        ${btnTroca}
                                    </div>
                                </div>
                            `;
                        }
                    }).join('');

                    htmlBalcao += `
                        <div class="card-pedido"><div class="status-bar ${p.statusPainel === 'preparando' ? 'bg-warning' : 'bg-pronto'}"></div>
                        <div style="display:flex; justify-content:space-between;"><h3>#${p.id} - ${p.cliente}</h3><span>Entrada: ${p.hora}</span></div>
                        <div style="font-size: 0.85rem; font-weight: bold; color: var(--primary); margin-top: -5px; margin-bottom: 5px;">[ ${p.tipoAtendimento || 'Levar (Viagem)'} ]</div>
                        <div class="lista-itens" style="margin-top:0;">${itensDetalhadosBalcao}</div>
                        ${btn}</div>`;
                }

                if(iDepois.length > 0) {
                    countAgend++;
                    
                    const itensDetalhadosFicha = iDepois.map(i => {
                        resumoBalcaoFicha[i.nome] = (resumoBalcaoFicha[i.nome] || 0) + i.qtd;

                        let comboDet = i.isCombo ? `<br><small style="color:gray;">↳ ${i.itensComboEscolhidos.map(sub=>`1x ${sub.nome}`).join(', ')}</small>` : '';
                        let obsDet = i.obs ? `<br><i style="color:red; font-size:0.8rem; font-weight:bold;">Observação: ${i.obs}</i>` : '';
                        return `<div style="border-bottom:1px dashed #ccc; padding:4px 0;"><b>1x ${i.nome}</b>${comboDet}${obsDet}</div>`;
                    }).join('');

                    htmlAgenda += `
                        <div class="card-pedido" style="border:1px solid var(--info);">
                            <div class="status-bar bg-info"></div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <h3 style="margin:0;">#${p.id} - ${p.cliente}</h3>
                                <b style="color:var(--info); font-size:0.85rem;">🕒 ${p.hora}</b>
                            </div>
                            <div style="font-size: 0.85rem; font-weight: bold; color: var(--primary); margin-top:2px;">[ ${p.tipoAtendimento || 'Levar (Viagem)'} ]</div>
                            <div class="lista-itens" style="margin-top:8px;">${itensDetalhadosFicha}</div>
                            <button class="btn btn-info" onclick="moverParaAgora(${p.id})">📤 Enviar p/ Cozinha</button>
                        </div>`;
                }

                let temCozinhaGeral = p.itens.some(item => {
                    if (item.isCombo) {
                        return item.itensComboEscolhidos && item.itensComboEscolhidos.some(sub => sub.cozinha);
                    }
                    return item.cozinha;
                });

                if((p.statusPainel === 'preparando' || p.statusPainel === 'pronto') && temCozinhaGeral) { 
                    if (p.statusPainel === 'preparando') {
                        htmlPrepTV += `<div class="mc-num"><span class="id">#${String(p.id).padStart(2, '0')}</span><span class="nome">${p.cliente}</span></div>`; 
                    }
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

            document.getElementById('fila-cozinha').innerHTML = htmlCozinha || '<p style="color:gray;">Livre.</p>';
            document.getElementById('fila-entrega').innerHTML = htmlBalcao || '<p style="color:gray;">Livre.</p>';
            document.getElementById('fila-agendados').innerHTML = htmlAgenda || '<p style="color:gray;">Nenhum retido.</p>';
            
            document.getElementById('badge-cozinha').innerText = countCoz; 
            document.getElementById('badge-cozinha').style.display = countCoz ? 'inline-block' : 'none';
            document.getElementById('badge-entrega').innerText = countBalc; 
            document.getElementById('badge-entrega').style.display = countBalc ? 'inline-block' : 'none';
            document.getElementById('badge-agendados').innerText = countAgend; 
            document.getElementById('badge-agendados').style.display = countAgend ? 'inline-block' : 'none';

            document.getElementById('tv-lista-preparando').innerHTML = htmlPrepTV || '<div style="color:gray;text-align:center;width:100%;font-size:1.5vw;margin-top:20px;">Aguardando...</div>';
            
            const tvDest = document.getElementById('tv-pronto-destaque');
            if(prontos.length > 0) {
                let ult = prontos[prontos.length - 1];
                tvDest.style.display = 'flex'; 
                tvDest.innerHTML = `<div class="mc-destaque-num">#${String(ult.id).padStart(2, '0')}</div><div class="mc-destaque-name">${ult.cliente}</div>`;
            } else { tvDest.style.display = 'none'; }
            
            let hist = [...prontos.reverse(), ...entregues.slice(-8).reverse()].slice(0, 10);
            document.getElementById('tv-lista-historico').innerHTML = hist.map(p => `<div class="mc-num ready"><span class="id">#${String(p.id).padStart(2, '0')}</span><span class="nome">${p.cliente}</span></div>`).join('');

            if(document.getElementById('vw-cozinha')) document.getElementById('vw-cozinha').innerHTML = htmlCozinha;
            if(document.getElementById('vw-balcao')) document.getElementById('vw-balcao').innerHTML = htmlBalcao;
            if(document.getElementById('vw-tv')) {
                document.getElementById('vw-tv').innerHTML = `
                <div class="mc-tv-layout" style="height: 100%; border-radius: 0;">
                    <div class="mc-tv-col preparando" style="padding: 10px; width: 50%;">
                        <div class="mc-tv-title title-prep" style="font-size: 1.2rem; margin-bottom: 10px;">Preparando</div>
                        <div class="mc-list-vertical" style="gap: 8px;">${htmlPrepTV}</div>
                    </div>
                    <div class="mc-tv-col pronto" style="padding: 10px; width: 50%;">
                        <div class="mc-tv-title title-pronto" style="font-size: 1.2rem; margin-bottom: 10px;">Pronto</div>
                        ${tvDest.style.display === 'flex' ? `<div class="mc-destaque blinking" style="padding: 10px; margin-bottom:10px;">${tvDest.innerHTML}</div>` : ''}
                        <div class="mc-list-vertical" style="gap: 8px;">${document.getElementById('tv-lista-historico').innerHTML}</div>
                    </div>
                </div>`;
            }

            const cardsBalcaoVisiveis = Array.from(document.querySelectorAll('#fila-entrega .card-pedido'));
            if (cardsBalcaoVisiveis.length > 0) {
                destacarCardBalcao(cardsBalcaoVisiveis);
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

            if (pedidosFiltrados.length === 0) return tbody.innerHTML = '<tr><td colspan="9" style="padding: 15px; text-align: center; color: gray;">Nenhum pedido encontrado.</td></tr>';

            pedidosFiltrados.forEach(p => {
                let statusHtml = ''; let acoesHtml = '';
                let btnImprimir = `<button onclick="reimprimirPedido(${p.id})" class="btn" style="background:#3b82f6; color:white; padding: 4px 8px; font-size: 0.8rem; margin-right: 5px;" title="Reimprimir">🖨️</button>`;

                if (p.statusPainel === 'entregue') { 
                    statusHtml = '<span class="status-badge" style="background:var(--success);">✅ Finalizado</span>'; 
                    acoesHtml = btnImprimir + `<button onclick="editarPedido(${p.id})" class="btn btn-warning" style="padding: 4px 8px; font-size: 0.8rem; margin-right: 5px;">✏️</button> <button onclick="cancelarPedido(${p.id})" class="btn btn-danger" style="padding: 4px 8px; font-size: 0.8rem;">🗑️</button>`; 
                } else if (p.statusPainel === 'cancelado') { 
                    statusHtml = '<span class="status-badge" style="background:var(--danger);">❌ Cancelado</span>'; 
                    acoesHtml = btnImprimir + '<span style="color:gray; font-size: 0.8rem;">Bloqueado</span>'; 
                } else {
                    if (p.statusPainel === 'pronto') statusHtml = '<span class="status-badge" style="background:var(--primary);">📺 Pronto TV</span>';
                    else if (p.statusPainel === 'preparando') statusHtml = '<span class="status-badge" style="background:var(--warning); color:black;">👨‍🍳 Cozinha</span>';
                    else statusHtml = '<span class="status-badge" style="background:var(--info);">📦 P/ Depois</span>';
                    
                    acoesHtml = btnImprimir + `<button onclick="editarPedido(${p.id})" class="btn btn-warning" style="padding: 4px 8px; font-size: 0.8rem; margin-right: 5px;">✏️</button> <button onclick="cancelarPedido(${p.id})" class="btn btn-danger" style="padding: 4px 8px; font-size: 0.8rem;">🗑️</button>`;
                }
                const resumoItens = p.itens.map(i => `1x ${i.nome}`).join(', ');
                const tempoPreparo = calcularDiferencaMinutos(p.horaEntradaCozinha || p.hora, p.horaEntrega);

                tbody.innerHTML += `<tr style="border-bottom: 1px solid #f3f4f6; ${p.statusPainel === 'cancelado' ? 'opacity:0.5;' : ''}">
                    <td style="padding: 12px; font-weight: bold;">#${p.id}</td>
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

        function abrirCaixa() {
            const val = parseFloat(document.getElementById('valor-fundo-caixa').value);
            if (isNaN(val) || val < 0) return exibirAviso("Insira um valor de fundo de caixa válido.");
            
            valorFundoCaixa = val;
            caixaAberto = true;
            
            const dataObjeto = new Date();
            const dataHoraAbertura = `${dataObjeto.toLocaleDateString('pt-BR')} ${dataObjeto.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
            dataHoraAberturaCaixa = dataHoraAbertura;
            salvarNoBancoLocal();
            
            atualizarInterfaceCaixa();
            exibirAviso(`Caixa aberto com sucesso! Fundo inicial: R$ ${valorFundoCaixa.toFixed(2)}`);
            atualizarDashboard();
        }

        function fecharCaixaPrompt() {
            if (!caixaAberto) return exibirAviso("O caixa já está fechado.");
            
            const nomeCampanha = prompt("Digite o NOME DA CAMPANHA / EVENTO para fechar o caixa (Obrigatório):");
            if (!nomeCampanha || nomeCampanha.trim() === "") {
                return exibirAviso("O Nome da Campanha é obrigatório para fechar o caixa!");
            }

            const senha = prompt("Digite a senha para fechar o caixa:");
            if (senha === "@Santaritatv2030") {
                
                const validos = pedidosGerais.filter(p => p.statusPainel !== 'cancelado');
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
                
                let resumoProdutosVendidos = {};
                validosFinanceiros.forEach(p => {
                    p.itens.forEach(i => {
                        resumoProdutosVendidos[i.nome] = (resumoProdutosVendidos[i.nome] || 0) + i.qtd;
                    });
                });

                const dataObjeto = new Date();
                const dataHoraFechamento = `${dataObjeto.toLocaleDateString('pt-BR')} ${dataObjeto.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
                const dataHoraAbertura = dataHoraAberturaCaixa || dataHoraFechamento;

                const registroFechamento = {
                    id: historicoCaixasDB.length + 1,
                    campanha: nomeCampanha.trim(),
                    dataAbertura: dataHoraAbertura,
                    dataFechamento: dataHoraFechamento,
                    fundoInicial: valorFundoCaixa,
                    totalVendas: totalVendas,
                    pix: fatPix,
                    pixDireto: fatPixDireto,
                    credito: fatCredito,
                    debito: fatDebito,
                    dinheiroVendas: fatDinheiro,
                    bonificacao: fatBonificacao,
                    totalGaveta: valorFundoCaixa + fatDinheiro,
                    qtdPedidos: validos.length,
                    produtosVendidos: resumoProdutosVendidos,
                    pedidosDetalhados: JSON.parse(JSON.stringify(pedidosGerais))
                };

                historicoCaixasDB.unshift(registroFechamento);

                caixaAberto = false;
                valorFundoCaixa = 0.00;
                
                pedidosGerais = [];

                dataHoraAberturaCaixa = null;
                salvarNoBancoLocal();

                document.getElementById('valor-fundo-caixa').value = '';
                atualizarInterfaceCaixa();
                atualizarTelas();
                atualizarFiltrosGestao();
                atualizarDashboard();

                exibirAviso("Caixa fechado com sucesso! Redirecionando para o Histórico de Caixas...");
                
                mudarAba('tela-fechamento-caixa', document.getElementById('btn-sub-fechamento'));

            } else if (senha !== null) {
                exibirAviso("Senha incorreta!");
            }
        }

        function excluirRegistroCaixa(idCaixa) {
            const senha = prompt(`Digite a senha para EXCLUIR permanentemente o Fechamento de Caixa #${idCaixa}:`);
            if (senha === "@Santaritatv2030") {
                historicoCaixasDB = historicoCaixasDB.filter(c => c.id !== idCaixa);
                salvarNoBancoLocal();
                renderizarHistoricoCaixas();
                exibirAviso(`Registro de Caixa #${idCaixa} excluído com sucesso!`);
            } else if (senha !== null) {
                exibirAviso("Senha incorreta! O registro não foi excluído.");
            }
        }

        function renderizarHistoricoCaixas() {
            const tbody = document.getElementById('tabela-historico-caixas');
            tbody.innerHTML = '';

            if (historicoCaixasDB.length === 0) {
                return tbody.innerHTML = '<tr><td colspan="9" style="padding: 20px; text-align: center; color: gray;">Nenhum caixa foi fechado ainda.</td></tr>';
            }

            historicoCaixasDB.forEach(c => {
                tbody.innerHTML += `
                    <tr style="border-bottom: 1px solid #e5e7eb;">
                        <td style="padding: 12px; font-weight: bold;">#${c.id}</td>
                        <td style="font-weight: bold; color: var(--primary); text-transform: uppercase;">${c.campanha || 'Padrão'}</td>
                        <td style="font-size: 0.85rem; color: #4b5563;">${c.dataAbertura}</td>
                        <td style="font-size: 0.85rem; color: #4b5563;">${c.dataFechamento}</td>
                        <td style="font-weight: bold;">R$ ${c.fundoInicial.toFixed(2)}</td>
                        <td style="font-weight: bold; color: var(--success);">R$ ${c.totalVendas.toFixed(2)}</td>
                        <td style="font-weight: bold; color: #0284c7;">R$ ${c.totalGaveta.toFixed(2)}</td>
                        <td style="text-align: center; font-weight: bold;">${c.qtdPedidos}</td>
                        <td>
                            <button onclick="verDetalhesCaixa(${c.id})" class="btn btn-info" style="padding: 6px 10px; font-size: 0.8rem; margin-right:2px;" title="Ver Detalhes">👁️</button>
                            <button onclick="imprimirRelatorioFechamento(${c.id})" class="btn" style="background:#047857; color:white; padding: 6px 10px; font-size: 0.8rem; margin-right:2px;" title="Imprimir Comprovante">🖨️</button>
                            <button onclick="excluirRegistroCaixa(${c.id})" class="btn btn-danger" style="padding: 6px 10px; font-size: 0.8rem;" title="Excluir Caixa">🗑️</button>
                        </td>
                    </tr>
                `;
            });
        }

        function verDetalhesCaixa(idCaixa) {
            const c = historicoCaixasDB.find(item => item.id === idCaixa);
            if (!c) return;

            document.getElementById('titulo-detalhe-caixa').innerText = `Caixa #${c.id} - ${c.campanha || 'Fechamento'}`;
            const corpo = document.getElementById('corpo-detalhes-caixa');

            let htmlProds = '';
            if (c.produtosVendidos && Object.keys(c.produtosVendidos).length > 0) {
                for (let prod in c.produtosVendidos) {
                    htmlProds += `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed #eee;"><span>${prod}</span><b>${c.produtosVendidos[prod]} un.</b></div>`;
                }
            } else {
                htmlProds = '<p style="color:gray;">Nenhum produto registrado.</p>';
            }

            let htmlListaPedidosCaixa = '';
            if (c.pedidosDetalhados && c.pedidosDetalhados.length > 0) {
                htmlListaPedidosCaixa = c.pedidosDetalhados.map(p => {
                    const tempo = calcularDiferencaMinutos(p.horaEntradaCozinha || p.hora, p.horaEntrega);
                    return `
                        <tr style="border-bottom: 1px solid #f3f4f6; ${p.statusPainel === 'cancelado' ? 'opacity:0.5;' : ''}">
                            <td style="padding:6px; font-weight:bold;">#${p.id}</td>
                            <td>${p.cliente}</td>
                            <td>${p.hora}</td>
                            <td>${p.horaEntradaCozinha || '-'}</td>
                            <td>${p.horaEntrega || '-'}</td>
                            <td style="font-weight:bold; color:var(--primary);">${tempo}</td>
                            <td>${p.pagamento}</td>
                            <td style="font-weight:bold; color:var(--success);">R$ ${p.total.toFixed(2)}</td>
                            <td>
                                <button class="btn btn-info" style="padding: 2px 6px; font-size:0.75rem;" onclick="abrirVerPedidoUnicoDoCaixa(${c.id}, ${p.id})">🔍 Ver Pedido</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else {
                htmlListaPedidosCaixa = '<tr><td colspan="9" style="text-align:center; padding:10px; color:gray;">Sem registros de pedidos antigos.</td></tr>';
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

                <h4 style="margin:10px 0 5px 0; color:#1f2937;">💳 Formas de Pagamento Entradas</h4>
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

                <h4 style="margin:10px 0 5px 0; color:#1f2937;">📦 Produtos Vendidos</h4>
                <div style="background:white; border:1px solid #e5e7eb; padding:10px; border-radius:8px; max-height:150px; overflow-y:auto; margin-bottom:15px;">
                    ${htmlProds}
                </div>

                <h4 style="margin:10px 0 5px 0; color:#1f2937;">⏱️ Raio-X de Pedidos & Tempo de Preparo</h4>
                <div style="background:white; border:1px solid #e5e7eb; border-radius:8px; max-height:200px; overflow-y:auto;">
                    <table style="width:100%; border-collapse:collapse; font-size:0.8rem; text-align:left;">
                        <thead>
                            <tr style="background:#f8fafc; border-bottom:1px solid #ddd;">
                                <th style="padding:6px;"># ID</th>
                                <th>Cliente</th>
                                <th>Entrada</th>
                                <th>Cozinha</th>
                                <th>Entrega</th>
                                <th>Tempo</th>
                                <th>Pagto</th>
                                <th>Total</th>
                                <th>Ação</th>
                            </tr>
                        </thead>
                        <tbody>${htmlListaPedidosCaixa}</tbody>
                    </table>
                </div>
            `;

            document.getElementById('modal-detalhes-caixa').style.display = 'flex';
        }

        function abrirVerPedidoUnicoDoCaixa(idCaixa, idPedido) {
            const c = historicoCaixasDB.find(item => item.id === idCaixa);
            if (!c || !c.pedidosDetalhados) return;

            const pedido = c.pedidosDetalhados.find(p => p.id === idPedido);
            if (!pedido) return;

            document.getElementById('titulo-ver-pedido-unico').innerText = `Pedido #${pedido.id} - ${pedido.cliente}`;
            
            const itensHtml = pedido.itens.map(i => {
                let comboDet = i.isCombo ? `<br><small style="color:gray;">Contém: ${i.itensComboEscolhidos.map(sub=>sub.nome).join(', ')}</small>` : '';
                let obsDet = i.obs ? `<br><small style="color:red; font-weight:bold;">Obs: ${i.obs}</small>` : '';
                return `
                    <div style="display:flex; justify-content:space-between; border-bottom:1px dashed #eee; padding:6px 0;">
                        <div><b>1x ${i.nome}</b>${comboDet}${obsDet}</div>
                        <b>R$ ${i.preco.toFixed(2)}</b>
                    </div>
                `;
            }).join('');

            document.getElementById('corpo-ver-pedido-unico').innerHTML = `
                <div style="background:#f8fafc; padding:10px; border-radius:6px; margin-bottom:12px; font-size:0.85rem;">
                    <div><b>Data/Hora Entrada:</b> ${pedido.data} ${pedido.hora}</div>
                    <div><b>Entrada Cozinha:</b> ${pedido.horaEntradaCozinha || '-'}</div>
                    <div><b>Horário Entrega:</b> ${pedido.horaEntrega || '-'}</div>
                    <div><b>Tempo de Preparo:</b> ${calcularDiferencaMinutos(pedido.horaEntradaCozinha || pedido.hora, pedido.horaEntrega)}</div>
                    <div><b>Pagamento:</b> ${pedido.pagamento}</div>
                    <div><b>Tipo Retirada:</b> ${pedido.tipoAtendimento}</div>
                </div>
                <h4 style="margin:5px 0; color:#374151;">Itens do Pedido:</h4>
                ${itensHtml}
                <div style="display:flex; justify-content:space-between; background:#e5e7eb; padding:10px; border-radius:6px; font-weight:bold; margin-top:12px; font-size:1.1rem;">
                    <span>Total:</span>
                    <span>R$ ${pedido.total.toFixed(2)}</span>
                </div>
            `;

            document.getElementById('btn-reimprimir-modal-unico').onclick = function() {
                gerarHTMLImpressao(pedido);
                window.print();
            };

            document.getElementById('modal-ver-pedido-unico').style.display = 'flex';
        }

        function fecharModalVerPedidoUnico() {
            document.getElementById('modal-ver-pedido-unico').style.display = 'none';
        }

        function fecharModalDetalhesCaixa() {
            document.getElementById('modal-detalhes-caixa').style.display = 'none';
        }

        function imprimirRelatorioFechamento(idFechamento) {
            const c = historicoCaixasDB.find(item => item.id === idFechamento);
            if (!c) return;

            let htmlProdsPrint = '';
            if (c.produtosVendidos && Object.keys(c.produtosVendidos).length > 0) {
                for (let prod in c.produtosVendidos) {
                    htmlProdsPrint += `<div class="print-row"><span>${prod}</span><span class="print-bold">${c.produtosVendidos[prod]} un</span></div>`;
                }
            }

            const areaPrint = document.getElementById('area-impressao');
            areaPrint.innerHTML = `
                <div class="print-center print-bold" style="font-size: 18px;">SANTUÁRIO SANTA RITA</div>
                <div class="print-center print-bold" style="font-size: 14px; margin-top: 5px;">FECHAMENTO DE CAIXA #${c.id}</div>
                <div class="print-center print-bold" style="font-size: 12px; margin-top: 2px; text-transform:uppercase;">EVENTO: ${c.campanha || 'GERAL'}</div>
                <div class="print-divider"></div>
                <div style="font-size: 11px; font-weight:bold;">
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
                ${htmlProdsPrint ? `<div class="print-divider"></div><div class="print-center print-bold" style="margin-bottom:5px;">PRODUTOS VENDIDOS</div>${htmlProdsPrint}` : ''}
                <div class="print-divider"></div>
                <div class="print-center print-bold" style="margin-top: 10px; font-size: 11px;">
                    Relatório emitido para conferência interna.
                </div>
            `;

            window.print();
        }

        function atualizarInterfaceCaixa() {
            const statusTxt = document.getElementById('status-caixa-texto');
            const inputCaixa = document.getElementById('valor-fundo-caixa');
            if (caixaAberto) {
                statusTxt.innerText = `Status do Caixa: Aberto (Fundo Inicial: R$ ${valorFundoCaixa.toFixed(2)})`;
                statusTxt.style.color = "var(--success)";
                inputCaixa.value = valorFundoCaixa;
                inputCaixa.disabled = true;
            } else {
                statusTxt.innerText = "Status do Caixa: Fechado";
                statusTxt.style.color = "var(--danger)";
                inputCaixa.value = "";
                inputCaixa.disabled = false;
            }
        }

        function atualizarDashboard() {
            const dados = obterDadosRelatorioCaixa();

            document.getElementById('rel-total').innerText = dados.totalVendas.toFixed(2);
            document.getElementById('rel-total-dinheiro').innerText = dados.totalGaveta.toFixed(2);
            document.getElementById('rel-qtd-pedidos').innerText = dados.validos.length;
            
            const qtdFinanceiras = dados.validosVendas.length;
            document.getElementById('rel-ticket').innerText = (qtdFinanceiras ? (dados.totalVendas / qtdFinanceiras) : 0).toFixed(2);

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
                            <b>Pedido #${b.id} - ${b.cliente}:</b> ${resumoItens} <br><small style="color:#b91c1c;">(Motivo: ${b.pagamento})</small>
                        </div>
                    `;
                }).join('');
            } else {
                painelBono.innerHTML = '<p style="color: gray;">Nenhuma bonificação registrada no caixa atual.</p>';
            }

            gerarGraficos(dados.validos);
        }

        function gerarGraficos(pedidos) {
            let contagemProdutos = {}; let contagemHoras = {}; let contagemCategorias = {}; let contagemRetirada = { 'Agora': 0, 'Depois': 0 };

            pedidos.forEach(p => {
                const horaCheia = p.hora.split(':')[0] + 'h'; contagemHoras[horaCheia] = (contagemHoras[horaCheia] || 0) + 1;
                p.itens.forEach(i => {
                    if(!p.pagamento || !p.pagamento.startsWith('Bonificação')) {
                        contagemProdutos[i.nome] = (contagemProdutos[i.nome] || 0) + i.qtd;
                    }
                    contagemCategorias[i.categoria] = (contagemCategorias[i.categoria] || 0) + i.qtd;
                    if (i.fase === 'agora' || i.fase === 'entregue') contagemRetirada['Agora'] += i.qtd; else contagemRetirada['Depois'] += i.qtd;
                });
            });

            const topProdutos = Object.entries(contagemProdutos).sort((a, b) => b[1] - a[1]).slice(0, 5);
            const horasOrdenadas = Object.keys(contagemHoras).sort(); const dadosHoras = horasOrdenadas.map(h => contagemHoras[h]);
            if (chartVendas) chartVendas.destroy(); if (chartHorarios) chartHorarios.destroy(); if (chartCategorias) chartCategorias.destroy(); if (chartRetirada) chartRetirada.destroy();
            const coresBase = ['#2563eb', '#16a34a', '#f59e0b', '#8b5cf6', '#ef4444', '#0ea5e9', '#14b8a6'];

            chartVendas = new Chart(document.getElementById('chartMaisVendidos').getContext('2d'), { type: 'bar', data: { labels: topProdutos.map(item => item[0]), datasets: [{ label: 'Unidades Vendidas (Vendas)', data: topProdutos.map(item => item[1]), backgroundColor: '#2563eb', borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false } });
            chartHorarios = new Chart(document.getElementById('chartHorarios').getContext('2d'), { type: 'line', data: { labels: horasOrdenadas.length > 0 ? horasOrdenadas : ['Sem dados'], datasets: [{ label: 'Qtd de Pedidos', data: dadosHoras.length > 0 ? dadosHoras : [0], borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.2)', fill: true, tension: 0.3 }] }, options: { responsive: true, maintainAspectRatio: false } });
            chartCategorias = new Chart(document.getElementById('chartCategorias').getContext('2d'), { type: 'doughnut', data: { labels: Object.keys(contagemCategorias), datasets: [{ data: Object.values(contagemCategorias), backgroundColor: coresBase }] }, options: { responsive: true, maintainAspectRatio: false } });
            chartRetirada = new Chart(document.getElementById('chartRetirada').getContext('2d'), { type: 'pie', data: { labels: ['🟢 Retirar Agora', '📦 Retirar Depois'], datasets: [{ data: [contagemRetirada['Agora'], contagemRetirada['Depois']], backgroundColor: ['#16a34a', '#8b5cf6'] }] }, options: { responsive: true, maintainAspectRatio: false } });
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

            document.getElementById('lbl-id-pedido-edicao').innerText = `#${id}`;
            document.getElementById('banner-alerta-edicao').style.display = 'block';
            
            const selectStatusEdicao = document.getElementById('status-pedido-edicao');
            selectStatusEdicao.value = p.statusPainel || 'nenhum';
            document.getElementById('box-status-edicao').style.display = 'block';

            document.getElementById('box-carrinho-container').classList.add('modo-edicao');
            document.getElementById('titulo-painel-carrinho').innerText = `Alterando Pedido #${id}`;

            document.getElementById('btn-finalizar-pedido').innerHTML = `Salvar Alteração e Reimprimir 🖨️`;
            document.getElementById('btn-finalizar-pedido').classList.replace('btn-primary', 'btn-warning');
            
            mudarAba('tela-pedido', document.querySelectorAll('nav button')[0]); 
            atualizarCarrinhoUI();
        }

        window.onload = async () => {
            await carregarEstadoSupabase();
            atualizarInterfaceCaixa();
            renderizarCategoriasUI();
            renderizarMenu();
            atualizarTelas();
            atualizarFiltrosGestao();
            renderizarHistoricoCaixas();
            iniciarRealtimeSupabase();
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
window.abrirCaixa = abrirCaixa;
window.abrirModalObs = abrirModalObs;
window.abrirModalTodosPedidos = abrirModalTodosPedidos;
window.abrirModalTrocaItem = abrirModalTrocaItem;
window.abrirVerPedidoUnicoDoCaixa = abrirVerPedidoUnicoDoCaixa;
window.addCarrinho = addCarrinho;
window.addProdutoTemporarioAoCombo = addProdutoTemporarioAoCombo;
window.adicionarCategoria = adicionarCategoria;
window.adicionarEstoqueManual = adicionarEstoqueManual;
window.apagarProduto = apagarProduto;
window.atualizarFiltrosGestao = atualizarFiltrosGestao;
window.atualizarTelas = atualizarTelas;
window.atualizarValoresMisto = atualizarValoresMisto;
window.calcularTroco = calcularTroco;
window.cancelarEdicaoProduto = cancelarEdicaoProduto;
window.cancelarPedido = cancelarPedido;
window.chamarNoPainel = chamarNoPainel;
window.confirmarCombo = confirmarCombo;
window.confirmarTrocaItemBalcao = confirmarTrocaItemBalcao;
window.editarCategoria = editarCategoria;
window.editarPedido = editarPedido;
window.excluirCategoria = excluirCategoria;
window.excluirRegistroCaixa = excluirRegistroCaixa;
window.fecharAviso = fecharAviso;
window.fecharCaixaPrompt = fecharCaixaPrompt;
window.fecharModalCombo = fecharModalCombo;
window.fecharModalDetalhesCaixa = fecharModalDetalhesCaixa;
window.fecharModalObs = fecharModalObs;
window.fecharModalTodosPedidos = fecharModalTodosPedidos;
window.fecharModalTroca = fecharModalTroca;
window.fecharModalVerPedidoUnico = fecharModalVerPedidoUnico;
window.filtrarMenu = filtrarMenu;
window.filtrarMenuBusca = filtrarMenuBusca;
window.finalizarEntrega = finalizarEntrega;
window.finalizarPedido = finalizarPedido;
window.gerarPDFCaixaAtual = gerarPDFCaixaAtual;
window.gerarPDFEstoquePorCategoria = gerarPDFEstoquePorCategoria;
window.imprimirEstoquePorCategoria = imprimirEstoquePorCategoria;
window.imprimirRelatorioCaixaAtual = imprimirRelatorioCaixaAtual;
window.imprimirRelatorioFechamento = imprimirRelatorioFechamento;
window.iniciarGravaçãoAtalho = iniciarGravaçãoAtalho;
window.limparCarrinho = limparCarrinho;
window.moverCategoria = moverCategoria;
window.moverParaAgora = moverParaAgora;
window.mudarAba = mudarAba;
window.mudarModoCadastro = mudarModoCadastro;
window.mudarTipoRetiradaGlobal = mudarTipoRetiradaGlobal;
window.prepararEdicaoProduto = prepararEdicaoProduto;
window.processarUploadFoto = processarUploadFoto;
window.reimprimirPedido = reimprimirPedido;
window.removerItemCarrinho = removerItemCarrinho;
window.removerItemComboTemporario = removerItemComboTemporario;
window.renderizarTabelaModalTodosPedidos = renderizarTabelaModalTodosPedidos;
window.sairVideoWall = sairVideoWall;
window.salvarObsModal = salvarObsModal;
window.salvarProduto = salvarProduto;
window.setFaseItem = setFaseItem;
window.toggleCampoDinheiro = toggleCampoDinheiro;
window.toggleMenuGlobal = toggleMenuGlobal;
window.toggleStatusAtivoProduto = toggleStatusAtivoProduto;
window.verDetalhesCaixa = verDetalhesCaixa;
