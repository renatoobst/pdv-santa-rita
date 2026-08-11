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

export const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Identifica este cliente/aba (usado para ignorar eco de atualizações que a
// própria aba enviou). Não confundir com o id da barraca ativa — esse é
// dinâmico (o dispositivo escolhe/troca de barraca em tempo de execução) e
// por isso vive em js/barracas.js, não aqui.
export const PDV_CLIENT_ID = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
