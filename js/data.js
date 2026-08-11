// Dados padrão (seed) usados na primeira execução, antes de qualquer
// produto/categoria existir no localStorage ou no Supabase.

export const categoriasPadrao = ['Lanches', 'Porções', 'Sobremesas', 'Bebidas', 'Combos'];
export const produtosPadrao = [
            { id: 1, nome: 'X-Burger Duplo', preco: 22.00, categoria: 'Lanches', cozinha: true, isCombo: false, estoque: null, foto: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300' },
            { id: 2, nome: 'X-Salada', preco: 18.00, categoria: 'Lanches', cozinha: true, isCombo: false, estoque: null, foto: 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=300' },
            { id: 3, nome: 'Hot Dog Especial', preco: 15.00, categoria: 'Lanches', cozinha: true, isCombo: false, estoque: null, foto: 'https://images.unsplash.com/photo-1619740455993-9e612b1af08a?w=300' },
            { id: 4, nome: 'Porção Fritas Média', preco: 20.00, categoria: 'Porções', cozinha: true, isCombo: false, estoque: null, foto: 'https://images.unsplash.com/photo-1576107232684-1279f390859f?w=300' },
            { id: 5, nome: 'Bolo de Pote', preco: 12.00, categoria: 'Sobremesas', cozinha: false, isCombo: false, estoque: 10, foto: 'https://images.unsplash.com/photo-1587314168485-3236d6710814?w=300' },
            { id: 6, nome: 'Pudim', preco: 9.00, categoria: 'Sobremesas', cozinha: false, isCombo: false, estoque: 5, foto: 'https://images.unsplash.com/photo-1528975604071-b4dc52a2d18c?w=300' },
            { id: 7, nome: 'Coca-Cola Lata', preco: 6.00, categoria: 'Bebidas', cozinha: false, isCombo: false, estoque: 48, foto: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300' },
            { id: 8, nome: 'Guaraná Lata', preco: 6.00, categoria: 'Bebidas', cozinha: false, isCombo: false, estoque: 50, foto: 'https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=300' },
            { id: 9, nome: 'Água Mineral', preco: 4.00, categoria: 'Bebidas', cozinha: false, isCombo: false, estoque: 20, foto: 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?w=300' },
            { id: 10, nome: 'Combo Família', preco: 55.00, categoria: 'Combos', cozinha: true, isCombo: true, estoque: null, foto: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=300',
                itensCombo: [
                    {tipo: 'categoria', ref: 'Lanches', qtd: 2, nomeExibicao: 'Escolha de Lanches'},
                    {tipo: 'produto', ref: 4, qtd: 1, nomeExibicao: 'Fixo: Porção Fritas Média'},
                    {tipo: 'categoria', ref: 'Bebidas', qtd: 2, nomeExibicao: 'Escolha de Bebidas'}
                ]
            }
        ];
