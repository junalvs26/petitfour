/* Petitfour — servidor de pedidos.
   Sem dependências. Roda de dois jeitos:
   - local: `npm start` (Node >= 22.5, banco SQLite em data/petitfour.db);
   - Vercel: api/index.js usa o `handler` daqui; o banco é o Turso (SQLite na nuvem),
     acessado por HTTP quando TURSO_DATABASE_URL + TURSO_AUTH_TOKEN existem.
   Toda regra de dinheiro, disponibilidade e agenda é decidida AQUI;
   o navegador só exibe o que o servidor calculou. Valores em centavos. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(RAIZ, 'public');
const PORTA = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(RAIZ, 'data', 'petitfour.db');
const WEBHOOK = process.env.NOTIFY_WEBHOOK_URL || '';   // n8n / WhatsApp: opcional
const FUSO_MIN = -180;                                  // São Luís, UTC-3 (sem horário de verão)
const ANTECEDENCIA_MIN_ENCOMENDA_H = 48;                // regra fixa: nunca menos que isso

// Senha do painel: ADMIN_PASSWORD. O padrão '12345' vale só localmente;
// na Vercel, sem a variável, o login do painel fica bloqueado.
const SENHA_ADMIN = process.env.ADMIN_PASSWORD || (process.env.VERCEL ? '' : '12345');

/* ============ BANCO ============
   Mesma interface para os dois bancos (tudo assíncrono):
   all/get/run(sql, args) · exec(sql com vários comandos) · lote([[sql, args]…]) atômico. */
async function bancoLocal(caminho) {
  const { DatabaseSync } = await import('node:sqlite');
  if (caminho !== ':memory:') mkdirSync(path.dirname(caminho), { recursive: true });
  const d = new DatabaseSync(caminho);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const rodar = (sql, a = []) => { const r = d.prepare(sql).run(...a); return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }; };
  return {
    all: async (sql, a = []) => d.prepare(sql).all(...a).map(r => ({ ...r })),
    get: async (sql, a = []) => { const r = d.prepare(sql).get(...a); return r ? { ...r } : undefined; },
    run: async (sql, a) => rodar(sql, a),
    exec: async sql => d.exec(sql),
    lote: async stmts => {
      d.exec('BEGIN IMMEDIATE');
      try { const out = stmts.map(([s, a]) => rodar(s, a)); d.exec('COMMIT'); return out; }
      catch (e) { d.exec('ROLLBACK'); throw e; }
    },
  };
}

/* Turso pelo protocolo HTTP (Hrana v2 /v2/pipeline) — dispensa o SDK. */
function bancoTurso(url, token) {
  const base = url.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  const arg = v => v == null ? { type: 'null' }
    : Number.isInteger(v) ? { type: 'integer', value: String(v) }
    : typeof v === 'number' ? { type: 'float', value: v }
    : { type: 'text', value: String(v) };
  const val = c => c.type === 'null' ? null : c.type === 'integer' ? Number(c.value) : c.type === 'blob' ? c.base64 : c.value;
  async function pipeline(requests) {
    const r = await fetch(base + '/v2/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
    });
    if (!r.ok) throw new Error(`Turso HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.results.slice(0, requests.length).map(x => {
      if (x.type === 'error') throw new Error('Turso: ' + x.error.message);
      return x.response.result;
    });
  }
  const linhas = res => res.rows.map(row => Object.fromEntries(res.cols.map((c, i) => [c.name, val(row[i])])));
  const um = async (sql, a = []) => (await pipeline([{ type: 'execute', stmt: { sql, args: a.map(arg) } }]))[0];
  return {
    all: async (s, a) => linhas(await um(s, a)),
    get: async (s, a) => linhas(await um(s, a))[0],
    run: async (s, a) => { const r = await um(s, a); return { changes: r.affected_row_count, id: Number(r.last_insert_rowid) }; },
    exec: async sql => { await pipeline([{ type: 'sequence', sql }]); },
    lote: async stmts => {
      // BEGIN → cada passo só roda se o anterior deu certo → COMMIT, senão ROLLBACK
      const steps = [{ stmt: { sql: 'BEGIN' } }];
      stmts.forEach(([s, a = []], i) => steps.push({ stmt: { sql: s, args: a.map(arg) }, condition: { type: 'ok', step: i } }));
      const n = steps.length;
      steps.push({ stmt: { sql: 'COMMIT' }, condition: { type: 'ok', step: n - 1 } });
      steps.push({ stmt: { sql: 'ROLLBACK' }, condition: { type: 'not', cond: { type: 'ok', step: n } } });
      const [res] = await pipeline([{ type: 'batch', batch: { steps } }]);
      const erro = res.step_errors.find(Boolean);
      if (erro) throw new Error(erro.message);
      return res.step_results.slice(1, n).map(r => ({ changes: r.affected_row_count }));
    },
  };
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS categorias(
  id TEXT PRIMARY KEY, nome TEXT NOT NULL, ordem INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS produtos(
  id TEXT PRIMARY KEY, nome TEXT NOT NULL, preco INTEGER NOT NULL CHECK(preco >= 0),
  categoria_id TEXT NOT NULL REFERENCES categorias(id),
  descricao TEXT NOT NULL DEFAULT '', longa TEXT NOT NULL DEFAULT '', foto TEXT,
  alergenos TEXT NOT NULL DEFAULT '[]', selo TEXT, selo_rosa INTEGER NOT NULL DEFAULT 0,
  destaque INTEGER, ordem INTEGER NOT NULL DEFAULT 0,
  cardapio INTEGER NOT NULL DEFAULT 1, encomenda INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS bairros(
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
  taxa INTEGER NOT NULL CHECK(taxa >= 0), ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS cupons(
  id INTEGER PRIMARY KEY, codigo TEXT NOT NULL UNIQUE COLLATE NOCASE,
  tipo TEXT NOT NULL CHECK(tipo IN ('percentual','fixo')), valor INTEGER NOT NULL CHECK(valor > 0),
  minimo INTEGER NOT NULL DEFAULT 0, validade TEXT, limite_uso INTEGER,
  usos INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1,
  CHECK(limite_uso IS NULL OR usos <= limite_uso));
CREATE TABLE IF NOT EXISTS configuracoes(chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bloqueios(
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, hora TEXT, motivo TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS pedidos(
  id INTEGER PRIMARY KEY, codigo TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL CHECK(tipo IN ('pedido','encomenda')),
  modalidade TEXT NOT NULL CHECK(modalidade IN ('delivery','retirada')),
  cliente TEXT NOT NULL, telefone TEXT NOT NULL,
  endereco TEXT, bairro_id INTEGER, bairro_nome TEXT,
  agendado_para TEXT, observacoes TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL, desconto INTEGER NOT NULL DEFAULT 0, cupom_codigo TEXT,
  taxa INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'novo', criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_agenda ON pedidos(agendado_para);
CREATE TABLE IF NOT EXISTS pedido_itens(
  id INTEGER PRIMARY KEY, pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  produto_id TEXT NOT NULL, nome TEXT NOT NULL, preco INTEGER NOT NULL,
  qtd INTEGER NOT NULL, subtotal INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pedido_historico(
  id INTEGER PRIMARY KEY, pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  status TEXT NOT NULL, em TEXT NOT NULL, obs TEXT NOT NULL DEFAULT '');
`;

/* Banco vazio: carrega o cardápio que antes vivia fixo no index.html.
   Depois disso, tudo é gerenciado pelo painel. */
async function semear() {
  if (await db.get('SELECT 1 FROM categorias LIMIT 1')) return;
  const L = ['lactose', 'gluten', 'ovo'], LA = [...L, 'avela'];
  const cats = [['cookies', 'Cookies'], ['brownies', 'Brownies & Biscoitos'], ['bolos', 'Bolos & Tortas'], ['bebidas', 'Bebidas']];
  // [id, nome, preco, cat, foto, alerg, desc, longa, selo, seloRosa, destaque, encomenda]
  const prods = [
    ['combo5', 'Combo 5 Cookie', 9800, 'cookies', '60c3dc72-4c91-4348-a2e1-a39c0e4f34c1.jpg', L, '5 cookies — você escolhe os sabores', 'Combo com 5 cookies — escolha o sabor dos cookies. As informações para alérgicos variam conforme os sabores escolhidos.', 'Combo', 0, 1, 1],
    ['trad', 'Cookie Tradicional', 2050, 'cookies', 'a03626f6-e176-4841-820e-8cd7b7d713d3.jpg', L, 'Gotas de chocolate e chocolate ao leite', 'Cookie com massa tradicional e gotas de chocolate, recheado com mais gotas de chocolate e finalizado com chocolate ao leite.', null, 0, 2, 1],
    ['mms', "Cookie M&M's", 2250, 'cookies', '9cbd108d-0510-4426-bd77-ac33f3810c78.jpg', L, "Finalizado com M&M's", "Cookie com massa tradicional e gotas de chocolate, recheado com mais gotas de chocolate e finalizado com M&M's.", null, 0, null, 1],
    ['ninho', 'Cookie Ninho com Nutella', 2050, 'cookies', '40605a71-cb16-4b19-b86f-4713cd4fa399.jpg', LA, 'Brigadeiro de Ninho e Nutella', 'Cookie com massa tradicional e gotas de chocolate ao leite e branco, recheado com brigadeiro de Ninho, Nutella e finalizado com leite Ninho em pó e mais Nutella.', 'Queridinho', 0, 3, 1],
    ['kinder', 'Cookie Kinder Bueno', 2400, 'cookies', '9e7f3fc8-5767-4caa-b7eb-c5a73beada57.jpg', LA, 'Pasta de Kinder Bueno da casa', 'Cookie com massa tradicional e gotas de chocolate ao leite, recheado com nossa pasta de Kinder Bueno, finalizado com o chocolate Kinder Bueno.', null, 0, null, 1],
    ['triplo', 'Cookie Triplo Chocolate', 2050, 'cookies', '923e7ff7-aeb0-4245-a736-adcea1147921.jpg', L, 'Massa de cacau, três chocolates', 'Cookie com massa de cacau e gotas de chocolate, recheado com chocolate ao leite, branco e meio amargo.', null, 0, null, 1],
    ['dragee', 'Cookie Dragée', 2050, 'cookies', 'fbbac5b0-393c-4b89-9c55-f206d3ebcbb3.jpg', L, 'Brigadeiro de panela e confeitos', 'Cookie com massa tradicional e gotas de chocolate, recheado com brigadeiro de panela e finalizado com confeitos de bolinha coloridos.', null, 0, null, 1],
    ['limao', 'Cookie Limão Siciliano com Framboesa', 2150, 'cookies', 'c7f2c725-0d86-465d-b022-2de0966df10d.jpg', L, 'Creme de limão e geleia de framboesa', 'Cookie com massa tradicional e gotas de chocolate, recheado com creme de limão siciliano e geleia de framboesa e finalizado com mais geleia de framboesa e raspas de limão siciliano.', null, 0, null, 1],
    ['nutella', 'Cookie Nutella', 2050, 'cookies', '9e1b8e68-a936-4372-8b74-57d3994898d7.jpg', LA, 'Recheado com muita Nutella', 'Cookie com massa tradicional e gotas de chocolate recheado com muita Nutella.', null, 0, null, 1],
    ['redvelvet', 'Cookie Red Velvet', 2050, 'cookies', 'd8f387cb-65e1-43fd-b69f-726858d0c9ad.jpg', L, 'Massa vermelha e chocolate branco', 'Cookie com massa vermelha e gotas de chocolate branco, recheado com mais chocolate branco, finalizado com açúcar de confeiteiro.', 'Destaque de hoje', 1, 4, 1],
    ['cake', 'Cookie Cake', 2980, 'cookies', '9b4b9f23-06e6-4e4c-918a-712b24d03a66.jpg', L, 'Recheado com bolo de chocolate', 'Massa tradicional com gotas de chocolate ao leite, recheado com bolo de chocolate e com muita cobertura de brigadeiro e dragée.', 'Mais pedido', 0, 0, 1],
    ['brownie', 'Brownie Tradicional', 780, 'brownies', '9861e363-c041-41ea-9ee3-2036f54093b1.jpg', L, 'Molhadinho dentro, casquinha fora', 'Brownie bem molhadinho por dentro e com uma casquinha irresistível por fora.', null, 0, null, 1],
    ['raspas', 'Raspas de Brownie', 1800, 'brownies', null, L, 'As bordinhas, a parte mais crocante', 'A parte mais crocante do brownie (as bordinhas).', 'Crocante', 0, null, 1],
    ['areinha', 'Areinha', 2000, 'brownies', '5ef90e09-796f-4235-9ad0-67ef2924881c.jpg', L, 'Amanteigados crocantes · aprox. 60 g', 'Biscoitinhos amanteigados super crocantes — aproximadamente 60 gramas.', null, 0, null, 1],
    ['chocolatudo', 'Bolo Chocolatudo (fatia)', 1700, 'bolos', '5184f7b2-6af1-456c-b518-bb374e3e9a3e.jpg', L, 'Cobertura de brigadeiro', 'Bolo de chocolate super molhadinho com cobertura de brigadeiro.', null, 0, null, 1],
    ['cenoura', 'Bolo de Cenoura (fatia)', 1700, 'bolos', '9798c934-95d2-47d0-ac42-1784f45bb2fa.jpg', L, 'Fofinho, com cobertura de brigadeiro', 'Bolo de cenoura super fofinho com cobertura de brigadeiro.', null, 0, null, 1],
    ['tres', 'Torta Três Amores', 4300, 'bolos', 'ee90c1b8-e100-4c47-8333-138d211dde3f.jpg', L, 'Base de brownie e três chocolates', 'Base de brownie com recheio de creme de chocolate branco, chocolate ao leite e chocolate meio amargo, finalizado com granulado de chocolate ao leite.', 'Para dividir', 0, 5, 1],
    ['agua', 'Água Sem Gás · 510 ml', 600, 'bebidas', '31997706-5c40-4e05-820b-667c60fde11d.jpg', [], 'Água mineral sem gás', 'Água mineral sem gás, garrafa de 510 ml.', null, 0, null, 0],
    ['aguagas', 'Água com Gás · 500 ml', 700, 'bebidas', '611fdab2-df27-4ab4-a0e4-3116fb639670.jpg', [], 'Água mineral com gás', 'Água mineral com gás, garrafa de 500 ml.', null, 0, null, 0],
  ];
  // OR IGNORE: duas instâncias subindo juntas na Vercel não duplicam nada
  await db.lote([
    ...cats.map(([id, nome], i) => ['INSERT OR IGNORE INTO categorias(id,nome,ordem) VALUES(?,?,?)', [id, nome, i]]),
    ...prods.map((p, i) => [`INSERT OR IGNORE INTO produtos(id,nome,preco,categoria_id,foto,alergenos,descricao,longa,selo,selo_rosa,destaque,encomenda,ordem)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [p[0], p[1], p[2], p[3], p[4], JSON.stringify(p[5]), p[6], p[7], p[8], p[9], p[10], p[11], i]]),
    // Taxas de exemplo do briefing — conferir com a loja antes de ir ao ar.
    ...[['Renascença', 800], ['Calhau', 900], ['Cohama', 1200]].map(b => ['INSERT OR IGNORE INTO bairros(nome,taxa) VALUES(?,?)', b]),
  ]);
}

let db = null, pronto = null;
const preparar = () => (pronto ??= (async () => {
  const url = process.env.TURSO_DATABASE_URL;
  db = url ? bancoTurso(url, process.env.TURSO_AUTH_TOKEN || '') : await bancoLocal(DB_PATH);
  await db.exec(ESQUEMA);
  await semear();
})().catch(e => { pronto = null; throw e; }));

/* ============ CONFIGURAÇÕES ============ */
const CONFIG_PADRAO = {
  loja: {
    nome: 'Petitfour', whatsapp: '', instagram: '@petitfour',
    endereco_retirada: '', pagamento: 'Pagamento na entrega ou na retirada',
  },
  // 0 = domingo … 6 = sábado
  horarios: {
    0: { aberto: true, inicio: '14:00', fim: '22:00' },
    1: { aberto: false, inicio: '14:00', fim: '22:00' },
    2: { aberto: true, inicio: '14:00', fim: '22:00' },
    3: { aberto: true, inicio: '14:00', fim: '22:00' },
    4: { aberto: true, inicio: '14:00', fim: '22:00' },
    5: { aberto: true, inicio: '14:00', fim: '22:00' },
    6: { aberto: true, inicio: '14:00', fim: '22:00' },
  },
  intervalo_min: 30,
  capacidade_por_horario: 5,
  antecedencia_retirada_min: 60,
  antecedencia_encomenda_h: 48,
  dias_retirada: 3,
  dias_encomenda: 30,
  prazo_entrega: '35–50 min',
};

async function getConfig() {
  const row = await db.get("SELECT valor FROM configuracoes WHERE chave='config'");
  const salvo = row ? JSON.parse(row.valor) : {};
  return {
    ...CONFIG_PADRAO, ...salvo,
    loja: { ...CONFIG_PADRAO.loja, ...salvo.loja },
    horarios: { ...CONFIG_PADRAO.horarios, ...salvo.horarios },
  };
}

/* ============ ERROS E VALIDAÇÃO ============ */
class ErroHttp extends Error {
  constructor(status, msg, campo) { super(msg); this.status = status; this.campo = campo; }
}
const falha = (msg, campo = null, status = 422) => { throw new ErroHttp(status, msg, campo); };

function texto(v, campo, min = 0, max = 200) {
  if (v == null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') falha(`Campo "${campo}" inválido.`, campo);
  const s = String(v).trim().replace(/[ \t]+/g, ' ');
  if (s.length < min) falha(min === 1 ? `Preencha o campo "${campo}".` : `"${campo}" precisa de pelo menos ${min} caracteres.`, campo);
  if (s.length > max) falha(`"${campo}" pode ter no máximo ${max} caracteres.`, campo);
  return s;
}
function inteiro(v, campo, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) falha(`Campo "${campo}" inválido.`, campo);
  return n;
}
const opcionalInt = (v, campo, min, max) => (v === '' || v == null ? null : inteiro(v, campo, min, max));
const bool = v => (v === true || v === 1 || v === '1' ? 1 : 0);
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/, RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_AGENDA = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const brl = c => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

/* ============ TEMPO (hora local de São Luís) ============ */
// "Local" = Date deslocado para UTC-3; ler SEMPRE com getUTC*.
const agoraLocal = () => new Date(Date.now() + FUSO_MIN * 60000);
const hojeLocal = () => agoraLocal().toISOString().slice(0, 10);
const localParaMs = iso => Date.parse(iso + ':00Z') - FUSO_MIN * 60000;
const minutos = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const agoraISO = () => new Date().toISOString();

function datasLocais(n) {
  const b = agoraLocal(), out = [];
  for (let i = 0; i < n; i++)
    out.push(new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + i)).toISOString().slice(0, 10));
  return out;
}

async function lojaAberta() {
  const cfg = await getConfig(), agora = agoraLocal();
  const h = cfg.horarios[agora.getUTCDay()];
  if (!h?.aberto) return false;
  if (await db.get('SELECT 1 FROM bloqueios WHERE data=? AND hora IS NULL', [hojeLocal()])) return false;
  const m = agora.getUTCHours() * 60 + agora.getUTCMinutes();
  return m >= minutos(h.inicio) && m < minutos(h.fim);
}

/* Horários que o cliente pode escolher: dentro do funcionamento, fora de
   bloqueios, respeitando antecedência e a capacidade de cada horário. */
async function agenda(tipo) {
  const cfg = await getConfig();
  const encomenda = tipo === 'encomenda';
  const antecedenciaMs = encomenda
    ? Math.max(ANTECEDENCIA_MIN_ENCOMENDA_H, cfg.antecedencia_encomenda_h) * 3600e3
    : cfg.antecedencia_retirada_min * 60e3;
  const limite = Date.now() + antecedenciaMs;
  const hoje = hojeLocal();
  const bloqs = await db.all('SELECT data, hora FROM bloqueios WHERE data >= ?', [hoje]);
  const diaBloq = new Set(bloqs.filter(b => !b.hora).map(b => b.data));
  const horaBloq = new Set(bloqs.filter(b => b.hora).map(b => b.data + 'T' + b.hora));
  const ocupacao = new Map((await db.all(
    `SELECT agendado_para a, COUNT(*) n FROM pedidos
     WHERE agendado_para >= ? AND status <> 'cancelado' GROUP BY agendado_para`, [hoje])).map(r => [r.a, r.n]));
  const out = [];
  for (const data of datasLocais(encomenda ? cfg.dias_encomenda : cfg.dias_retirada)) {
    const h = cfg.horarios[new Date(data + 'T00:00:00Z').getUTCDay()];
    if (!h?.aberto || diaBloq.has(data)) continue;
    const horarios = [];
    for (let m = minutos(h.inicio); m < minutos(h.fim); m += cfg.intervalo_min) {
      const iso = data + 'T' + hhmm(m);
      if (localParaMs(iso) < limite || horaBloq.has(iso)) continue;
      if ((ocupacao.get(iso) || 0) >= cfg.capacidade_por_horario) continue;
      horarios.push(hhmm(m));
    }
    if (horarios.length) out.push({ data, horarios });
  }
  return out;
}
const horarioDisponivel = async (tipo, iso) => {
  const [d, h] = iso.split('T');
  return (await agenda(tipo)).some(x => x.data === d && x.horarios.includes(h));
};

/* ============ CUPOM / CÁLCULO DO PEDIDO ============ */
async function avaliarCupom(codigo, subtotal) {
  const c = await db.get('SELECT * FROM cupons WHERE codigo = ?', [codigo]);
  if (!c || !c.ativo) falha('Cupom inválido ou desativado.', 'cupom');
  if (c.validade && hojeLocal() > c.validade) falha('Este cupom expirou.', 'cupom');
  if (c.limite_uso != null && c.usos >= c.limite_uso) falha('Este cupom atingiu o limite de uso.', 'cupom');
  if (subtotal < c.minimo) falha(`Cupom válido para pedidos a partir de ${brl(c.minimo)}.`, 'cupom');
  const desconto = c.tipo === 'percentual' ? Math.round(subtotal * c.valor / 100) : c.valor;
  return { cupom: c, desconto: Math.min(desconto, subtotal) };
}

/* estrito=false (cotação): bairro/cupom pendentes não impedem mostrar o resumo. */
async function calcular(body, estrito) {
  const tipo = ['pedido', 'encomenda'].includes(body.tipo) ? body.tipo : falha('Tipo de pedido inválido.', 'tipo');
  const modalidade = ['delivery', 'retirada'].includes(body.modalidade)
    ? body.modalidade : falha('Escolha delivery ou retirada.', 'modalidade');
  if (!Array.isArray(body.itens) || !body.itens.length) falha('Sua sacola está vazia.', 'itens');
  if (body.itens.length > 50) falha('Itens demais em um só pedido.', 'itens');

  const qtds = new Map();
  for (const it of body.itens) {
    if (typeof it?.id !== 'string') falha('Item inválido.', 'itens');
    qtds.set(it.id, (qtds.get(it.id) || 0) + inteiro(it.qtd, 'quantidade', 1, 99));
  }
  const ids = [...qtds.keys()];
  const achados = new Map((await db.all(`SELECT p.*, c.ativo cat_ativa FROM produtos p
    JOIN categorias c ON c.id = p.categoria_id WHERE p.id IN (${ids.map(() => '?').join(',')})`, ids)).map(p => [p.id, p]));
  const linhas = [];
  let subtotal = 0;
  for (const [id, qtd] of qtds) {
    const p = achados.get(id);
    if (!p || !p.ativo || !p.cat_ativa || !(tipo === 'encomenda' ? p.encomenda : p.cardapio))
      falha(`${p ? p.nome : 'Um dos produtos'} não está disponível no momento.`, 'itens');
    if (qtd > 99) falha(`Quantidade máxima de ${p.nome}: 99.`, 'itens');
    linhas.push({ produto_id: p.id, nome: p.nome, preco: p.preco, qtd, subtotal: p.preco * qtd });
    subtotal += p.preco * qtd;
  }

  let taxa = 0, bairro = null;
  if (modalidade === 'delivery') {
    if (body.bairro_id != null && body.bairro_id !== '') {
      const bid = Number(body.bairro_id);
      bairro = Number.isInteger(bid) ? await db.get('SELECT * FROM bairros WHERE id = ?', [bid]) : null;
      if (!bairro || !bairro.ativo) falha('Ainda não entregamos nesse bairro.', 'bairro');
      taxa = bairro.taxa;
    } else if (estrito) falha('Selecione o bairro de entrega.', 'bairro');
  }

  let desconto = 0, cupom = null, erroCupom = null;
  const codigo = typeof body.cupom === 'string' ? body.cupom.trim() : '';
  if (codigo) {
    try { ({ cupom, desconto } = await avaliarCupom(codigo, subtotal)); }
    catch (e) { if (estrito || !(e instanceof ErroHttp)) throw e; erroCupom = e.message; }
  }
  return { tipo, modalidade, linhas, subtotal, desconto, cupom, erroCupom, taxa, bairro, total: subtotal - desconto + taxa };
}

/* ============ STATUS ============ */
const FLUXOS = {
  delivery: ['novo', 'recebido', 'em_preparacao', 'pronto', 'saiu_para_entrega', 'entregue'],
  retirada: ['novo', 'recebido', 'em_preparacao', 'pronto_retirada', 'retirado'],
};
const FINAIS = ['entregue', 'retirado', 'cancelado'];
const EVENTOS = {
  novo: 'order.created', recebido: 'order.received', em_preparacao: 'order.preparing',
  pronto: 'order.ready', pronto_retirada: 'order.ready', saiu_para_entrega: 'order.out_for_delivery',
  entregue: 'order.delivered', retirado: 'order.delivered', cancelado: 'order.cancelled',
};

/* Ponto único de saída para notificações (n8n → WhatsApp). Só envia se
   NOTIFY_WEBHOOK_URL estiver configurada; nada é simulado. Aguarda o envio
   (até 5s) porque na Vercel a função congela assim que responde. */
async function emitir(status, pedido, evento = EVENTOS[status]) {
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: evento, pedido }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) { console.error('[webhook]', EVENTOS[status], pedido.codigo, e.message); }
}

async function pedidoCompleto(id) {
  const p = await db.get('SELECT * FROM pedidos WHERE id = ?', [id]);
  if (!p) return null;
  p.itens = await db.all('SELECT produto_id,nome,preco,qtd,subtotal FROM pedido_itens WHERE pedido_id=? ORDER BY id', [id]);
  p.historico = await db.all('SELECT status,em,obs FROM pedido_historico WHERE pedido_id=? ORDER BY id', [id]);
  p.fluxo = FLUXOS[p.modalidade];
  return p;
}

async function criarPedido(body) {
  const r = await calcular(body, true);
  const cliente = texto(body.cliente, 'nome', 2, 80);
  const telefone = String(body.telefone ?? '').replace(/\D/g, '');
  if (telefone.length < 10 || telefone.length > 13) falha('Informe um telefone com DDD.', 'telefone');
  const observacoes = texto(body.observacoes, 'observações', 0, 500);
  const endereco = r.modalidade === 'delivery' ? texto(body.endereco, 'endereço', 5, 200) : null;

  let agendado = null;
  if (r.tipo === 'encomenda' || r.modalidade === 'retirada') {
    agendado = typeof body.agendado_para === 'string' && RE_AGENDA.test(body.agendado_para)
      ? body.agendado_para : falha('Escolha a data e o horário.', 'horario');
    if (r.tipo === 'encomenda' && localParaMs(agendado) < Date.now() + ANTECEDENCIA_MIN_ENCOMENDA_H * 3600e3)
      falha('Encomendas precisam de no mínimo 48 horas de antecedência.', 'horario');
    if (!(await horarioDisponivel(r.tipo, agendado))) falha('Esse horário não está disponível. Escolha outro.', 'horario');
  } else if (!(await lojaAberta())) {
    falha('Estamos fechados agora — o delivery volta no horário de funcionamento. Você pode agendar uma retirada.', 'modalidade');
  }

  const codigo = crypto.randomBytes(9).toString('base64url');
  const agora = agoraISO();
  const idDoPedido = '(SELECT id FROM pedidos WHERE codigo = ?)';
  const stmts = [];
  // o CHECK da tabela cupons impede passar do limite de uso, mesmo com pedidos simultâneos
  if (r.cupom) stmts.push(['UPDATE cupons SET usos = usos + 1 WHERE id = ?', [r.cupom.id]]);
  stmts.push([`INSERT INTO pedidos(codigo,tipo,modalidade,cliente,telefone,endereco,bairro_id,bairro_nome,
    agendado_para,observacoes,subtotal,desconto,cupom_codigo,taxa,total,status,criado_em,atualizado_em)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'novo',?,?)`, [
    codigo, r.tipo, r.modalidade, cliente, telefone, endereco,
    r.bairro?.id ?? null, r.bairro?.nome ?? null, agendado, observacoes,
    r.subtotal, r.desconto, r.cupom?.codigo ?? null, r.taxa, r.total, agora, agora]]);
  for (const l of r.linhas)
    stmts.push([`INSERT INTO pedido_itens(pedido_id,produto_id,nome,preco,qtd,subtotal) VALUES(${idDoPedido},?,?,?,?,?)`,
      [codigo, l.produto_id, l.nome, l.preco, l.qtd, l.subtotal]]);
  stmts.push([`INSERT INTO pedido_historico(pedido_id,status,em) VALUES(${idDoPedido}, 'novo', ?)`, [codigo, agora]]);
  try { await db.lote(stmts); }
  catch (e) { if (/CHECK/i.test(e.message)) falha('Este cupom atingiu o limite de uso.', 'cupom'); throw e; }

  const { id } = await db.get('SELECT id FROM pedidos WHERE codigo = ?', [codigo]);
  const pedido = await pedidoCompleto(id);
  await emitir('novo', pedido);
  return pedido;
}

async function mudarStatus(id, novo, obs) {
  const p = await db.get('SELECT * FROM pedidos WHERE id = ?', [id]) || falha('Pedido não encontrado.', null, 404);
  const fluxo = FLUXOS[p.modalidade];
  const i = fluxo.indexOf(p.status);
  let correcao = false;
  if (p.status === 'cancelado') {
    // reabrir: volta exatamente para a fase em que estava antes do cancelamento
    const antes = await db.get(`SELECT status FROM pedido_historico WHERE pedido_id=? AND status <> 'cancelado' ORDER BY id DESC LIMIT 1`, [id]);
    if (novo !== antes?.status) falha('Um pedido cancelado só pode voltar para a fase em que estava.', 'status', 409);
    correcao = true;
  } else if (novo === 'cancelado') {
    if (FINAIS.includes(p.status)) falha('Pedido finalizado não pode ser cancelado. Volte a fase antes, se foi engano.', 'status', 409);
  } else if (novo === fluxo[i - 1]) {
    correcao = true;   // voltar uma fase (ex.: marcou "saiu para entrega" por engano)
  } else if (novo !== fluxo[i + 1]) {
    falha('Mudança de status fora da sequência.', 'status', 409);
  }
  if (correcao && !obs) obs = `Correção: voltou de "${p.status}"`;
  const agora = agoraISO();
  const [upd] = await db.lote([
    ['UPDATE pedidos SET status=?, atualizado_em=? WHERE id=? AND status=?', [novo, agora, id, p.status]],
    ['INSERT INTO pedido_historico(pedido_id,status,em,obs) SELECT id, ?, ?, ? FROM pedidos WHERE id=? AND status=? AND atualizado_em=?',
      [novo, agora, obs, id, novo, agora]],
  ]);
  if (!upd.changes) falha('Este pedido acabou de ser alterado. Atualize a tela.', 'status', 409);
  const pedido = await pedidoCompleto(id);
  await emitir(novo, pedido, correcao ? 'order.status_corrected' : undefined);
  return pedido;
}

/* ============ ADMIN: SANITIZAÇÃO ============ */
const ALERGENOS = ['lactose', 'gluten', 'ovo', 'avela'];

async function categoriaExiste(id) {
  return (await db.get('SELECT 1 FROM categorias WHERE id = ?', [String(id ?? '')])) ? String(id) : falha('Categoria inválida.', 'categoria_id');
}
function validarFoto(v) {
  const f = texto(v, 'foto', 0, 300);
  if (!f) return null;
  if (/^https:\/\/[^\s"'<>]+$/.test(f) || /^[\w-]+\.(jpe?g|png|webp)$/i.test(f)) return f;
  falha('Foto: use o nome de um arquivo em Petitfour_files ou um link https.', 'foto');
}

const ENTIDADES = {
  categorias: {
    ordem: 'ordem, nome', idTexto: true,
    novoId: d => idLivre('categorias', slug(d.nome)),
    limpar: async b => ({ nome: texto(b.nome, 'nome', 2, 60), ordem: opcionalInt(b.ordem, 'ordem', 0, 9999) ?? 0, ativo: bool(b.ativo) }),
  },
  produtos: {
    ordem: 'ordem, nome', idTexto: true,
    novoId: d => idLivre('produtos', slug(d.nome)),
    limpar: async b => ({
      nome: texto(b.nome, 'nome', 2, 80),
      preco: inteiro(b.preco, 'preço', 0, 1_000_000),
      categoria_id: await categoriaExiste(b.categoria_id),
      descricao: texto(b.descricao, 'descrição curta', 0, 120),
      longa: texto(b.longa, 'descrição completa', 0, 1000),
      foto: validarFoto(b.foto),
      alergenos: JSON.stringify(Array.isArray(b.alergenos) ? ALERGENOS.filter(a => b.alergenos.includes(a)) : []),
      selo: texto(b.selo, 'selo', 0, 30) || null,
      selo_rosa: bool(b.selo_rosa),
      destaque: opcionalInt(b.destaque, 'posição em destaque', 0, 99),
      ordem: opcionalInt(b.ordem, 'ordem', 0, 9999) ?? 0,
      cardapio: bool(b.cardapio),
      encomenda: bool(b.encomenda),
      ativo: bool(b.ativo),
    }),
  },
  bairros: {
    ordem: 'nome',
    limpar: async b => ({ nome: texto(b.nome, 'nome', 2, 60), taxa: inteiro(b.taxa, 'taxa', 0, 100_000), ativo: bool(b.ativo) }),
  },
  cupons: {
    ordem: 'ativo DESC, codigo',
    limpar: async b => {
      const codigo = texto(b.codigo, 'código', 3, 30).toUpperCase();
      if (!/^[A-Z0-9_-]+$/.test(codigo)) falha('Código: use só letras, números, - ou _.', 'codigo');
      const tipo = ['percentual', 'fixo'].includes(b.tipo) ? b.tipo : falha('Tipo de cupom inválido.', 'tipo');
      const validade = b.validade ? (RE_DATA.test(b.validade) ? b.validade : falha('Validade inválida.', 'validade')) : null;
      return {
        codigo, tipo,
        valor: tipo === 'percentual' ? inteiro(b.valor, 'percentual', 1, 100) : inteiro(b.valor, 'valor', 1, 1_000_000),
        minimo: opcionalInt(b.minimo, 'valor mínimo', 0, 1_000_000) ?? 0,
        validade,
        limite_uso: opcionalInt(b.limite_uso, 'limite de uso', 1, 1_000_000),
        ativo: bool(b.ativo),
      };
    },
  },
};
const idDe = (tabela, id) => ENTIDADES[tabela].idTexto ? String(id) : Number(id);

async function idLivre(tabela, base) {
  let id = base, n = 2;
  while (await db.get(`SELECT 1 FROM ${tabela} WHERE id = ?`, [id])) id = `${base}-${n++}`;
  return id;
}

async function salvarEntidade(tabela, body, id) {
  const ent = ENTIDADES[tabela];
  const dados = await ent.limpar(body);
  const cols = Object.keys(dados);
  try {
    if (id == null) {
      if (ent.novoId) dados.id = await ent.novoId(dados);
      const c = Object.keys(dados);
      const r = await db.run(`INSERT INTO ${tabela}(${c.join(',')}) VALUES(${c.map(() => '?').join(',')})`, Object.values(dados));
      id = dados.id ?? r.id;
    } else {
      const r = await db.run(`UPDATE ${tabela} SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`, [...Object.values(dados), id]);
      if (!r.changes) falha('Registro não encontrado.', null, 404);
    }
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) falha('Já existe um registro com esse nome/código.', 'nome', 409);
    if (/CHECK/i.test(e.message)) falha('Limite de uso menor que a quantidade de usos já feitos.', 'limite_uso');
    throw e;
  }
  return db.get(`SELECT * FROM ${tabela} WHERE id = ?`, [id]);
}

function validarConfig(b) {
  const horarios = {};
  for (let d = 0; d < 7; d++) {
    const h = b.horarios?.[d];
    if (!RE_HORA.test(h?.inicio) || !RE_HORA.test(h?.fim) || minutos(h.inicio) >= minutos(h.fim))
      falha('Horário de funcionamento inválido: o início deve ser antes do fim.', 'horarios');
    horarios[d] = { aberto: !!h.aberto, inicio: h.inicio, fim: h.fim };
  }
  const l = b.loja ?? {};
  return {
    loja: {
      nome: texto(l.nome, 'nome da loja', 1, 60),
      whatsapp: texto(l.whatsapp, 'WhatsApp', 0, 20).replace(/\D/g, ''),
      instagram: texto(l.instagram, 'Instagram', 0, 40),
      endereco_retirada: texto(l.endereco_retirada, 'endereço de retirada', 0, 200),
      pagamento: texto(l.pagamento, 'formas de pagamento', 0, 120),
    },
    horarios,
    intervalo_min: inteiro(b.intervalo_min, 'intervalo', 10, 240),
    capacidade_por_horario: inteiro(b.capacidade_por_horario, 'capacidade por horário', 1, 500),
    antecedencia_retirada_min: inteiro(b.antecedencia_retirada_min, 'antecedência da retirada', 0, 1440),
    antecedencia_encomenda_h: inteiro(b.antecedencia_encomenda_h, 'antecedência da encomenda', ANTECEDENCIA_MIN_ENCOMENDA_H, 720),
    dias_retirada: inteiro(b.dias_retirada, 'dias de agenda (retirada)', 1, 14),
    dias_encomenda: inteiro(b.dias_encomenda, 'dias de agenda (encomenda)', 3, 120),
    prazo_entrega: texto(b.prazo_entrega, 'prazo de entrega', 0, 30),
  };
}

/* ============ AUTENTICAÇÃO ADMIN ============
   Token assinado (validade.assinatura): funciona entre instâncias diferentes
   da Vercel sem guardar sessão. Trocar a senha invalida todos os tokens. */
const SEGREDO = process.env.SESSION_SECRET || crypto.createHash('sha256').update('pf-sessao:' + SENHA_ADMIN).digest();
const assinar = exp => exp + '.' + crypto.createHmac('sha256', SEGREDO).update(String(exp)).digest('base64url');
const tentativas = new Map();        // ip -> {n, ate} (por instância: freio, não garantia)
const hash = s => crypto.createHash('sha256').update(String(s)).digest();

function login(ip, senha) {
  const t = tentativas.get(ip);
  if (!SENHA_ADMIN) falha('Painel sem senha configurada (ADMIN_PASSWORD).', null, 503);
  if (t && t.n >= 5 && t.ate > Date.now()) falha('Muitas tentativas. Aguarde alguns minutos.', null, 429);
  if (typeof senha !== 'string' || !crypto.timingSafeEqual(hash(senha), hash(SENHA_ADMIN))) {
    const n = t && t.ate > Date.now() ? t.n + 1 : 1;
    tentativas.set(ip, { n, ate: Date.now() + 5 * 60e3 });
    falha('Senha incorreta.', 'senha', 401);
  }
  tentativas.delete(ip);
  return { token: assinar(Date.now() + 12 * 3600e3) };
}
function autenticado(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const [exp] = token.split('.');
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const certo = assinar(exp);
  return token.length === certo.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(certo));
}

/* limite simples de criação de pedidos por IP */
const envios = new Map();
const LIMITE_PEDIDOS_MIN = Number(process.env.LIMITE_PEDIDOS_MIN) || 8;
function limitarEnvio(ip) {
  const agora = Date.now();
  const lista = (envios.get(ip) || []).filter(t => t > agora - 60e3);
  if (lista.length >= LIMITE_PEDIDOS_MIN) falha('Muitos pedidos seguidos. Aguarde um minuto.', null, 429);
  lista.push(agora);
  envios.set(ip, lista);
}

/* ============ ROTAS ============ */
const rotas = [];
const rota = (metodo, padrao, fn, admin = false) => rotas.push({
  metodo, admin, fn,
  re: new RegExp('^' + padrao.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'),
});
const produtoPublico = p => ({ ...p, alergenos: JSON.parse(p.alergenos) });

// --- público
rota('GET', '/api/catalogo', async () => {
  const cfg = await getConfig();
  return {
    categorias: await db.all('SELECT id,nome FROM categorias WHERE ativo=1 ORDER BY ordem, nome'),
    produtos: (await db.all(`SELECT p.id,p.nome,p.preco,p.categoria_id,p.descricao,p.longa,p.foto,p.alergenos,
        p.selo,p.selo_rosa,p.destaque,p.cardapio,p.encomenda
      FROM produtos p JOIN categorias c ON c.id=p.categoria_id
      WHERE p.ativo=1 AND c.ativo=1 ORDER BY p.ordem, p.nome`)).map(produtoPublico),
    bairros: await db.all('SELECT id,nome,taxa FROM bairros WHERE ativo=1 ORDER BY nome'),
    loja: { ...cfg.loja, aberto: await lojaAberta(), prazo_entrega: cfg.prazo_entrega, horarios: cfg.horarios },
    regras: { antecedencia_encomenda_h: Math.max(ANTECEDENCIA_MIN_ENCOMENDA_H, cfg.antecedencia_encomenda_h) },
  };
});
rota('GET', '/api/agenda', async (req, p, b, q) => ({ dias: await agenda(q.get('tipo') === 'encomenda' ? 'encomenda' : 'pedido') }));
rota('POST', '/api/cotacao', async (req, p, body) => {
  const r = await calcular(body, false);
  return {
    linhas: r.linhas, subtotal: r.subtotal, desconto: r.desconto, taxa: r.taxa, total: r.total,
    cupom: r.cupom ? { codigo: r.cupom.codigo, tipo: r.cupom.tipo, valor: r.cupom.valor } : null,
    erroCupom: r.erroCupom, bairro: r.bairro ? { id: r.bairro.id, nome: r.bairro.nome } : null,
    aberto: await lojaAberta(),
  };
});
rota('POST', '/api/pedidos', async (req, p, body) => {
  limitarEnvio(req.ip);
  const pedido = await criarPedido(body);
  return { status: 201, corpo: { codigo: pedido.codigo, id: pedido.id } };
});
rota('GET', '/api/pedidos/:codigo', async (req, { codigo }) => {
  const row = await db.get('SELECT id FROM pedidos WHERE codigo = ?', [codigo]) || falha('Pedido não encontrado.', null, 404);
  const { id, codigo: c, tipo, modalidade, cliente, bairro_nome, agendado_para, itens, subtotal, desconto,
    cupom_codigo, taxa, total, status, criado_em, historico, fluxo, observacoes } = await pedidoCompleto(row.id);
  return { id, codigo: c, tipo, modalidade, cliente, bairro_nome, agendado_para, itens, subtotal, desconto,
    cupom_codigo, taxa, total, status, criado_em, historico, fluxo, observacoes };
});

// --- admin
rota('POST', '/api/admin/login', (req, p, body) => login(req.ip, body.senha));
rota('GET', '/api/admin/resumo', async () => {
  const inicioHoje = new Date(localParaMs(hojeLocal() + 'T00:00')).toISOString();
  return {
    porStatus: await db.all('SELECT status, COUNT(*) n FROM pedidos GROUP BY status'),
    hoje: await db.get(`SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM pedidos
      WHERE criado_em >= ? AND status <> 'cancelado'`, [inicioHoje]),
    proximasEncomendas: await db.all(`SELECT id, cliente, agendado_para, total, status FROM pedidos
      WHERE tipo='encomenda' AND status NOT IN ('cancelado','entregue','retirado')
      ORDER BY agendado_para LIMIT 8`),
    aberto: await lojaAberta(),
  };
}, true);
rota('GET', '/api/admin/pedidos', async (req, p, b, q) => {
  const onde = [], args = [];
  const grupo = q.get('grupo');
  if (grupo === 'abertos') onde.push(`status NOT IN ('entregue','retirado','cancelado')`);
  if (grupo === 'finalizados') onde.push(`status IN ('entregue','retirado')`);
  if (grupo === 'cancelados') onde.push(`status = 'cancelado'`);
  if (q.get('status')) { onde.push('status = ?'); args.push(q.get('status')); }
  if (['pedido', 'encomenda'].includes(q.get('tipo'))) { onde.push('tipo = ?'); args.push(q.get('tipo')); }
  const ordem = q.get('tipo') === 'encomenda' ? 'agendado_para, id' : 'id DESC';
  const ids = await db.all(`SELECT id FROM pedidos ${onde.length ? 'WHERE ' + onde.join(' AND ') : ''}
    ORDER BY ${ordem} LIMIT 200`, args);
  return Promise.all(ids.map(r => pedidoCompleto(r.id)));
}, true);
/* Relatório por período (datas locais de São Luís, pela data de criação do pedido).
   Faturamento = pedidos não cancelados; cancelados aparecem à parte, com motivo. */
rota('GET', '/api/admin/relatorio', async (req, p, b, q) => {
  const de = q.get('de'), ate = q.get('ate');
  if (!RE_DATA.test(de) || !RE_DATA.test(ate) || de > ate) falha('Período inválido.', 'periodo');
  if ((Date.parse(ate) - Date.parse(de)) / 864e5 > 366) falha('Período máximo: 1 ano.', 'periodo');
  const ini = new Date(localParaMs(de + 'T00:00')).toISOString();
  const fim = new Date(localParaMs(ate + 'T00:00') + 864e5).toISOString();
  const periodo = 'criado_em >= ? AND criado_em < ?', args = [ini, fim];
  const dia = "date(criado_em, '-3 hours')";
  const [totais, cancel, porDia, porModalidade, produtos, cupons, cancelados] = await Promise.all([
    db.get(`SELECT COUNT(*) pedidos, COALESCE(SUM(total),0) total, COALESCE(SUM(subtotal),0) produtos,
      COALESCE(SUM(taxa),0) taxas, COALESCE(SUM(desconto),0) descontos
      FROM pedidos WHERE ${periodo} AND status <> 'cancelado'`, args),
    db.get(`SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM pedidos WHERE ${periodo} AND status = 'cancelado'`, args),
    db.all(`SELECT ${dia} dia, SUM(status <> 'cancelado') pedidos,
      COALESCE(SUM(CASE WHEN status <> 'cancelado' THEN total END),0) total,
      SUM(status = 'cancelado') cancelados, COALESCE(SUM(CASE WHEN status = 'cancelado' THEN total END),0) valor_cancelado
      FROM pedidos WHERE ${periodo} GROUP BY dia ORDER BY dia`, args),
    db.all(`SELECT tipo, modalidade, COUNT(*) pedidos, SUM(total) total FROM pedidos
      WHERE ${periodo} AND status <> 'cancelado' GROUP BY tipo, modalidade ORDER BY total DESC`, args),
    db.all(`SELECT i.produto_id, i.nome, SUM(i.qtd) qtd, SUM(i.subtotal) total
      FROM pedido_itens i JOIN pedidos p ON p.id = i.pedido_id
      WHERE p.${periodo.replaceAll(' AND ', ' AND p.')} AND p.status <> 'cancelado'
      GROUP BY i.produto_id ORDER BY total DESC`, args),
    db.all(`SELECT cupom_codigo codigo, COUNT(*) usos, SUM(desconto) desconto FROM pedidos
      WHERE ${periodo} AND status <> 'cancelado' AND cupom_codigo IS NOT NULL GROUP BY cupom_codigo ORDER BY desconto DESC`, args),
    db.all(`SELECT p.id, p.cliente, p.tipo, p.modalidade, p.total, p.criado_em, h.em cancelado_em, h.obs motivo
      FROM pedidos p LEFT JOIN pedido_historico h ON h.pedido_id = p.id AND h.status = 'cancelado'
      WHERE p.${periodo.replaceAll(' AND ', ' AND p.')} AND p.status = 'cancelado' ORDER BY p.id DESC`, args),
  ]);
  return { de, ate, totais, cancelados: { ...cancel, lista: cancelados }, porDia, porModalidade, produtos, cupons };
}, true);

rota('POST', '/api/admin/pedidos/:id/status', (req, { id }, body) =>
  mudarStatus(Number(id), String(body.status ?? ''), texto(body.obs, 'observação', 0, 200)), true);

for (const tabela of Object.keys(ENTIDADES)) {
  rota('GET', `/api/admin/${tabela}`, async () => {
    const rows = await db.all(`SELECT * FROM ${tabela} ORDER BY ${ENTIDADES[tabela].ordem}`);
    return tabela === 'produtos' ? rows.map(produtoPublico) : rows;
  }, true);
  rota('POST', `/api/admin/${tabela}`, async (req, p, body) => ({ status: 201, corpo: await salvarEntidade(tabela, body, null) }), true);
  rota('PUT', `/api/admin/${tabela}/:id`, (req, { id }, body) => salvarEntidade(tabela, body, idDe(tabela, id)), true);
  rota('PATCH', `/api/admin/${tabela}/:id/ativo`, async (req, { id }, body) => {
    const r = await db.run(`UPDATE ${tabela} SET ativo=? WHERE id=?`, [bool(body.ativo), idDe(tabela, id)]);
    if (!r.changes) falha('Registro não encontrado.', null, 404);
    return { ok: true };
  }, true);
}

rota('GET', '/api/admin/config', () => getConfig(), true);
rota('PUT', '/api/admin/config', async (req, p, body) => {
  const cfg = validarConfig(body);
  await db.run(`INSERT INTO configuracoes(chave,valor) VALUES('config',?)
    ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor`, [JSON.stringify(cfg)]);
  return getConfig();
}, true);
rota('GET', '/api/admin/bloqueios', () =>
  db.all('SELECT * FROM bloqueios WHERE data >= ? ORDER BY data, hora', [hojeLocal()]), true);
rota('POST', '/api/admin/bloqueios', async (req, p, b) => {
  const data = RE_DATA.test(b.data) ? b.data : falha('Data inválida.', 'data');
  const hora = b.hora ? (RE_HORA.test(b.hora) ? b.hora : falha('Horário inválido.', 'hora')) : null;
  if (await db.get('SELECT 1 FROM bloqueios WHERE data=? AND hora IS ?', [data, hora])) falha('Esse bloqueio já existe.', 'data', 409);
  const r = await db.run('INSERT INTO bloqueios(data,hora,motivo) VALUES(?,?,?)', [data, hora, texto(b.motivo, 'motivo', 0, 100)]);
  return { status: 201, corpo: await db.get('SELECT * FROM bloqueios WHERE id=?', [r.id]) };
}, true);
rota('DELETE', '/api/admin/bloqueios/:id', async (req, { id }) => {
  if (!(await db.run('DELETE FROM bloqueios WHERE id=?', [Number(id)])).changes) falha('Bloqueio não encontrado.', null, 404);
  return { ok: true };
}, true);

/* ============ ARQUIVOS ESTÁTICOS (só local; na Vercel quem serve é a CDN) ============ */
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const PAGINAS = new Set(['index.html', 'admin.html']);

async function servirArquivo(res, url) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel === 'admin') rel = 'admin.html';
  const ext = path.extname(rel).toLowerCase();
  const alvo = path.resolve(PUBLICO, rel);
  const permitido = alvo.startsWith(PUBLICO + path.sep) && TIPOS[ext] && !rel.split('/').some(s => s.startsWith('.'))
    && (ext !== '.html' || PAGINAS.has(rel));
  if (!permitido) return enviar(res, 404, { erro: 'Não encontrado.' });
  try {
    const conteudo = await readFile(alvo);
    res.writeHead(200, {
      'Content-Type': TIPOS[ext],
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      ...(rel === 'admin.html' ? { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } : {}),
    });
    res.end(conteudo);
  } catch { enviar(res, 404, { erro: 'Não encontrado.' }); }
}

function enviar(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

function lerCorpo(req) {
  // Na Vercel o corpo já chega lido em req.body
  if (req.body !== undefined) {
    const b = req.body;
    if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return Promise.resolve(b);
    if (b == null || b === '') return Promise.resolve({});
    try { const j = JSON.parse(String(b)); return Promise.resolve(j && typeof j === 'object' ? j : {}); }
    catch { return Promise.reject(new ErroHttp(400, 'JSON inválido.')); }
  }
  return new Promise((ok, erro) => {
    let tam = 0; const partes = [];
    req.on('data', c => {
      tam += c.length;
      if (tam > 100_000) { erro(new ErroHttp(413, 'Requisição grande demais.')); req.destroy(); }
      else partes.push(c);
    });
    req.on('end', () => {
      if (!partes.length) return ok({});
      try { const j = JSON.parse(Buffer.concat(partes).toString('utf8')); ok(j && typeof j === 'object' ? j : {}); }
      catch { erro(new ErroHttp(400, 'JSON inválido.')); }
    });
    req.on('error', erro);
  });
}

export async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  // atrás da Vercel o IP real vem no cabeçalho; localmente, do socket
  req.ip = process.env.VERCEL
    ? String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    : req.socket.remoteAddress;
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return enviar(res, 405, { erro: 'Método não permitido.' });
      return await servirArquivo(res, url);
    }
    const r = rotas.find(x => x.metodo === req.method && x.re.test(url.pathname));
    if (!r) return enviar(res, 404, { erro: 'Rota não encontrada.' });
    if (r.admin && !autenticado(req)) return enviar(res, 401, { erro: 'Faça login novamente.' });
    const params = { ...url.pathname.match(r.re).groups };
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await lerCorpo(req) : {};
    await preparar();
    const out = await r.fn(req, params, body, url.searchParams);
    if (out && out.status && out.corpo) return enviar(res, out.status, out.corpo);
    enviar(res, 200, out);
  } catch (e) {
    if (e instanceof ErroHttp) return enviar(res, e.status, { erro: e.message, campo: e.campo });
    console.error(e);
    enviar(res, 500, { erro: 'Erro interno. Tente novamente.' });
  }
}

export const servidor = http.createServer(handler);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  servidor.listen(PORTA, () => console.log(`Petitfour em http://localhost:${PORTA}  ·  admin: /admin`));
}
