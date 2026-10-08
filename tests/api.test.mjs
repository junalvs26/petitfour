// Testes de API: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.LIMITE_PEDIDOS_MIN = '1000';
const { servidor } = await import('../servidor.js');

let base, token;
const req = async (metodo, rota, corpo, auth = true) => {
  const r = await fetch(base + rota, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: 'Bearer ' + token } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch { json = txt; }
  return { s: r.status, j: json };
};
const pedidoBase = { tipo: 'pedido', cliente: 'Maria Teste', telefone: '(98) 99999-0000' };
const agendaDe = async tipo => (await req('GET', '/api/agenda?tipo=' + tipo)).j.dias;

before(async () => {
  await new Promise(ok => servidor.listen(0, ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  token = (await req('POST', '/api/admin/login', { senha: 'senha-teste' })).j.token;
  // loja aberta o dia todo para os testes não dependerem do relógio
  const cfg = (await req('GET', '/api/admin/config')).j;
  for (let d = 0; d < 7; d++) cfg.horarios[d] = { aberto: true, inicio: '00:00', fim: '23:59' };
  cfg.dias_retirada = 3;
  assert.equal((await req('PUT', '/api/admin/config', cfg)).s, 200);
});
after(() => servidor.close());

test('admin: exige autenticação e senha correta', async () => {
  assert.equal((await req('GET', '/api/admin/pedidos', null, false)).s, 401);
  assert.equal((await req('POST', '/api/admin/login', { senha: 'errada' }, false)).s, 401);
});

test('arquivos internos não são servidos', async () => {
  for (const r of ['/servidor.js', '/data/petitfour.db', '/Petitfour.html', '/.claude/settings.local.json', '/tests/api.test.mjs'])
    assert.equal((await fetch(base + r)).status, 404, r);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/admin')).status, 200);
});

test('catálogo por categorias', async () => {
  const { j } = await req('GET', '/api/catalogo');
  assert.deepEqual(j.categorias.map(c => c.id), ['cookies', 'brownies', 'bolos', 'bebidas']);
  assert.equal(j.produtos.length, 19);
  assert.ok(j.produtos.every(p => Array.isArray(p.alergenos)));
});

test('produto desativado some do cardápio, não pode ser comprado e pode ser reativado', async () => {
  assert.equal((await req('PATCH', '/api/admin/produtos/mms/ativo', { ativo: false })).s, 200);
  assert.ok(!(await req('GET', '/api/catalogo')).j.produtos.some(p => p.id === 'mms'));
  assert.ok((await req('GET', '/api/admin/produtos')).j.some(p => p.id === 'mms' && !p.ativo), 'continua no painel');
  const r = await req('POST', '/api/pedidos', { ...pedidoBase, modalidade: 'delivery', bairro_id: 1, endereco: 'Rua A, 10', itens: [{ id: 'mms', qtd: 1 }] });
  assert.equal(r.s, 422);
  assert.equal((await req('PATCH', '/api/admin/produtos/mms/ativo', { ativo: true })).s, 200);
  assert.ok((await req('GET', '/api/catalogo')).j.produtos.some(p => p.id === 'mms'));
});

test('categoria desativada esconde seus produtos; CRUD de categoria', async () => {
  const nova = await req('POST', '/api/admin/categorias', { nome: 'Salgados', ordem: 9, ativo: true });
  assert.equal(nova.s, 201);
  assert.equal(nova.j.id, 'salgados');
  await req('PATCH', '/api/admin/categorias/bebidas/ativo', { ativo: false });
  const { j } = await req('GET', '/api/catalogo');
  assert.ok(!j.produtos.some(p => p.categoria_id === 'bebidas'));
  assert.ok(j.categorias.some(c => c.id === 'salgados'));
  await req('PATCH', '/api/admin/categorias/bebidas/ativo', { ativo: true });
});

test('delivery: taxa do bairro, bairro inválido/inativo, total recalculado no servidor', async () => {
  const itens = [{ id: 'trad', qtd: 2 }, { id: 'brownie', qtd: 1 }]; // 2*2050 + 780 = 4880
  const ok = await req('POST', '/api/cotacao', { tipo: 'pedido', modalidade: 'delivery', bairro_id: 1, itens, total: 1 });
  assert.equal(ok.s, 200);
  assert.equal(ok.j.subtotal, 4880);
  assert.equal(ok.j.taxa, 800);
  assert.equal(ok.j.total, 5680);
  assert.equal((await req('POST', '/api/cotacao', { tipo: 'pedido', modalidade: 'delivery', bairro_id: 999, itens })).s, 422);
  const b = (await req('POST', '/api/admin/bairros', { nome: 'Turu', taxa: 1500, ativo: false })).j;
  const inativo = await req('POST', '/api/cotacao', { tipo: 'pedido', modalidade: 'delivery', bairro_id: b.id, itens });
  assert.equal(inativo.s, 422);
  assert.match(inativo.j.erro, /não entregamos/);
  await req('PATCH', `/api/admin/bairros/${b.id}/ativo`, { ativo: true });
  assert.equal((await req('POST', '/api/cotacao', { tipo: 'pedido', modalidade: 'delivery', bairro_id: b.id, itens })).j.taxa, 1500);
  // retirada não cobra taxa mesmo se o bairro vier
  assert.equal((await req('POST', '/api/cotacao', { tipo: 'pedido', modalidade: 'retirada', bairro_id: 1, itens })).j.taxa, 0);
});

test('cupons: percentual, fixo, mínimo, expirado, desativado, limite de uso', async () => {
  const cria = c => req('POST', '/api/admin/cupons', { ativo: true, ...c });
  assert.equal((await cria({ codigo: 'doce10', tipo: 'percentual', valor: 10 })).j.codigo, 'DOCE10');
  await cria({ codigo: 'MENOS5', tipo: 'fixo', valor: 500, minimo: 5000 });
  await cria({ codigo: 'VELHO', tipo: 'fixo', valor: 500, validade: '2020-01-01' });
  const off = (await cria({ codigo: 'OFF', tipo: 'fixo', valor: 500 })).j;
  await req('PATCH', `/api/admin/cupons/${off.id}/ativo`, { ativo: false });
  await cria({ codigo: 'UMAVEZ', tipo: 'fixo', valor: 300, limite_uso: 1 });
  assert.equal((await cria({ codigo: 'DOCE10', tipo: 'fixo', valor: 1 })).s, 409, 'código duplicado');
  assert.equal((await cria({ codigo: 'X150', tipo: 'percentual', valor: 150 })).s, 422, 'percentual > 100');

  const cot = cupom => req('POST', '/api/cotacao', { tipo: 'pedido', modalidade: 'retirada', itens: [{ id: 'cake', qtd: 1 }], cupom }); // 2980
  let r = await cot('doce10');
  assert.equal(r.j.desconto, 298);
  assert.equal(r.j.total, 2682);
  assert.match((await cot('MENOS5')).j.erroCupom, /a partir de/);
  assert.match((await cot('VELHO')).j.erroCupom, /expirou/);
  assert.match((await cot('OFF')).j.erroCupom, /inválido ou desativado/);
  assert.match((await cot('NAOEXISTE')).j.erroCupom, /inválido/);

  // limite de uso: primeiro pedido consome, segundo é recusado
  const slot = (await agendaDe('pedido'))[0];
  const pedir = h => req('POST', '/api/pedidos', { ...pedidoBase, modalidade: 'retirada', itens: [{ id: 'cake', qtd: 1 }], cupom: 'UMAVEZ', agendado_para: slot.data + 'T' + h });
  const p1 = await pedir(slot.horarios[0]);
  assert.equal(p1.s, 201);
  assert.equal((await req('GET', '/api/pedidos/' + p1.j.codigo)).j.desconto, 300);
  const p2 = await pedir(slot.horarios[1]);
  assert.equal(p2.s, 422);
  assert.match(p2.j.erro, /limite/);
  // cupom inválido no envio real bloqueia (não é ignorado silenciosamente)
  assert.equal((await req('POST', '/api/pedidos', { ...pedidoBase, modalidade: 'retirada', itens: [{ id: 'cake', qtd: 1 }], cupom: 'VELHO', agendado_para: slot.data + 'T' + slot.horarios[1] })).s, 422);
});

test('pedido delivery: ignora valores do cliente, status em sequência e histórico', async () => {
  const r = await req('POST', '/api/pedidos', {
    ...pedidoBase, modalidade: 'delivery', bairro_id: 2, endereco: 'Rua das Flores, 100',
    itens: [{ id: 'trad', qtd: 1, preco: 1 }], subtotal: 1, total: 1, desconto: 9999, status: 'entregue',
  });
  assert.equal(r.s, 201);
  const p = (await req('GET', '/api/pedidos/' + r.j.codigo)).j;
  assert.equal(p.subtotal, 2050);
  assert.equal(p.taxa, 900);
  assert.equal(p.total, 2950);
  assert.equal(p.status, 'novo');
  assert.equal(p.telefone, undefined, 'rastreio público não expõe telefone');

  const mudar = s => req('POST', `/api/admin/pedidos/${r.j.id}/status`, { status: s });
  assert.equal((await mudar('pronto')).s, 409, 'pular etapa');
  assert.equal((await mudar('pronto_retirada')).s, 409, 'status de outro fluxo');
  for (const s of ['recebido', 'em_preparacao', 'pronto', 'saiu_para_entrega', 'entregue'])
    assert.equal((await mudar(s)).s, 200, s);
  assert.equal((await mudar('cancelado')).s, 409, 'finalizado não muda');
  const fim = (await req('GET', '/api/pedidos/' + r.j.codigo)).j;
  assert.deepEqual(fim.historico.map(h => h.status), ['novo', 'recebido', 'em_preparacao', 'pronto', 'saiu_para_entrega', 'entregue']);
  assert.equal((await req('POST', `/api/admin/pedidos/${r.j.id}/status`, { status: 'recebido' }, false)).s, 401);
});

test('pedido: validações de cliente, endereço, bairro, sacola', async () => {
  const d = { ...pedidoBase, modalidade: 'delivery', bairro_id: 1, endereco: 'Rua A, 10', itens: [{ id: 'trad', qtd: 1 }] };
  assert.equal((await req('POST', '/api/pedidos', { ...d, telefone: '123' })).j.campo, 'telefone');
  assert.equal((await req('POST', '/api/pedidos', { ...d, endereco: '' })).j.campo, 'endereço');
  assert.equal((await req('POST', '/api/pedidos', { ...d, bairro_id: '' })).j.campo, 'bairro');
  assert.equal((await req('POST', '/api/pedidos', { ...d, itens: [] })).j.campo, 'itens');
  assert.equal((await req('POST', '/api/pedidos', { ...d, itens: [{ id: 'trad', qtd: 0 }] })).s, 422);
  assert.equal((await req('POST', '/api/pedidos', { ...d, itens: [{ id: 'trad', qtd: 1.5 }] })).s, 422);
  assert.equal((await req('POST', '/api/pedidos', { ...d, tipo: 'encomenda' })).s, 422, 'encomenda sem horário');
});

test('retirada: horário obrigatório e válido, fluxo próprio de status', async () => {
  const base = { ...pedidoBase, modalidade: 'retirada', itens: [{ id: 'brownie', qtd: 3 }] };
  assert.equal((await req('POST', '/api/pedidos', base)).j.campo, 'horario');
  assert.equal((await req('POST', '/api/pedidos', { ...base, agendado_para: '2020-01-01T15:00' })).s, 422, 'passado');
  assert.equal((await req('POST', '/api/pedidos', { ...base, agendado_para: 'amanhã' })).s, 422);
  const dia = (await agendaDe('pedido'))[1];
  const r = await req('POST', '/api/pedidos', { ...base, agendado_para: dia.data + 'T' + dia.horarios[5] });
  assert.equal(r.s, 201);
  const mudar = s => req('POST', `/api/admin/pedidos/${r.j.id}/status`, { status: s });
  assert.equal((await mudar('saiu_para_entrega')).s, 409);
  for (const s of ['recebido', 'em_preparacao', 'pronto_retirada', 'retirado']) assert.equal((await mudar(s)).s, 200, s);
});

test('agenda: bloqueio de data/horário e capacidade por horário', async () => {
  const cfg = (await req('GET', '/api/admin/config')).j;
  const dias = await agendaDe('pedido');
  const alvo = dias[1];
  // bloqueia o dia inteiro
  const bd = (await req('POST', '/api/admin/bloqueios', { data: alvo.data, motivo: 'Feriado' })).j;
  assert.ok(!(await agendaDe('pedido')).some(d => d.data === alvo.data));
  assert.equal((await req('POST', '/api/pedidos', { ...pedidoBase, modalidade: 'retirada', itens: [{ id: 'trad', qtd: 1 }], agendado_para: alvo.data + 'T' + alvo.horarios[2] })).s, 422);
  await req('DELETE', '/api/admin/bloqueios/' + bd.id);
  // bloqueia um horário
  const h = alvo.horarios[3];
  await req('POST', '/api/admin/bloqueios', { data: alvo.data, hora: h });
  assert.ok(!(await agendaDe('pedido')).find(d => d.data === alvo.data).horarios.includes(h));
  // capacidade 1: segundo pedido no mesmo horário é recusado
  await req('PUT', '/api/admin/config', { ...cfg, capacidade_por_horario: 1 });
  const slot = alvo.data + 'T' + alvo.horarios[8];
  const novo = () => req('POST', '/api/pedidos', { ...pedidoBase, modalidade: 'retirada', itens: [{ id: 'trad', qtd: 1 }], agendado_para: slot });
  assert.equal((await novo()).s, 201);
  const seg = await novo();
  assert.equal(seg.s, 422);
  assert.equal(seg.j.campo, 'horario');
  await req('PUT', '/api/admin/config', { ...cfg, capacidade_por_horario: 5 });
});

test('encomenda: regra de 48h, produto de encomenda, observação', async () => {
  const cfg = (await req('GET', '/api/admin/config')).j;
  assert.equal((await req('PUT', '/api/admin/config', { ...cfg, antecedencia_encomenda_h: 24 })).s, 422, 'admin não reduz abaixo de 48h');

  const dias = await agendaDe('encomenda');
  const primeiro = new Date(dias[0].data + 'T' + dias[0].horarios[0] + ':00-03:00').getTime();
  assert.ok(primeiro >= Date.now() + 48 * 3600e3, 'primeiro horário oferecido respeita 48h');
  assert.ok(primeiro < Date.now() + 49 * 3600e3, 'e é o primeiro possível');

  const e = { ...pedidoBase, tipo: 'encomenda', modalidade: 'retirada', itens: [{ id: 'tres', qtd: 2 }], observacoes: 'Escrever "Parabéns, Ana"' };
  // 47h a partir de agora (horário local de São Luís, em slot de 30min)
  const quase = new Date(Date.now() - 3 * 3600e3 + 47 * 3600e3);
  quase.setUTCMinutes(quase.getUTCMinutes() < 30 ? 0 : 30);
  const r47 = await req('POST', '/api/pedidos', { ...e, agendado_para: quase.toISOString().slice(0, 16) });
  assert.equal(r47.s, 422);
  assert.match(r47.j.erro, /48 horas/);

  assert.equal((await req('POST', '/api/pedidos', { ...e, itens: [{ id: 'agua', qtd: 1 }], agendado_para: dias[0].data + 'T' + dias[0].horarios[0] })).s, 422, 'produto fora da encomenda');

  const ok = await req('POST', '/api/pedidos', { ...e, agendado_para: dias[0].data + 'T' + dias[0].horarios[0] });
  assert.equal(ok.s, 201);
  const p = (await req('GET', '/api/pedidos/' + ok.j.codigo)).j;
  assert.equal(p.tipo, 'encomenda');
  assert.equal(p.total, 8600);
  assert.equal(p.observacoes, 'Escrever "Parabéns, Ana"');
  const lista = (await req('GET', '/api/admin/pedidos?tipo=encomenda')).j;
  assert.ok(lista.some(x => x.id === ok.j.id));
});

test('delivery imediato recusado com a loja fechada', async () => {
  const cfg = (await req('GET', '/api/admin/config')).j;
  const fechado = structuredClone(cfg);
  for (let d = 0; d < 7; d++) fechado.horarios[d].aberto = false;
  await req('PUT', '/api/admin/config', fechado);
  assert.equal((await req('GET', '/api/catalogo')).j.loja.aberto, false);
  const r = await req('POST', '/api/pedidos', { ...pedidoBase, modalidade: 'delivery', bairro_id: 1, endereco: 'Rua A, 10', itens: [{ id: 'trad', qtd: 1 }] });
  assert.equal(r.s, 422);
  assert.match(r.j.erro, /fechados/);
  await req('PUT', '/api/admin/config', cfg);
});

test('admin: CRUD de produto com validação', async () => {
  const novo = await req('POST', '/api/admin/produtos', { nome: 'Bolo de Pote', preco: 1500, categoria_id: 'bolos', ativo: true, cardapio: true, encomenda: true, alergenos: ['lactose', 'xss'] });
  assert.equal(novo.s, 201);
  assert.equal(novo.j.id, 'bolo-de-pote');
  assert.equal(novo.j.alergenos, '["lactose"]');
  assert.equal((await req('POST', '/api/admin/produtos', { nome: 'X', preco: 10, categoria_id: 'bolos' })).s, 422);
  assert.equal((await req('POST', '/api/admin/produtos', { nome: 'Xis', preco: -1, categoria_id: 'bolos' })).s, 422);
  assert.equal((await req('POST', '/api/admin/produtos', { nome: 'Xis', preco: 10, categoria_id: 'nao' })).s, 422);
  assert.equal((await req('POST', '/api/admin/produtos', { nome: 'Xis', preco: 10, categoria_id: 'bolos', foto: 'javascript:alert(1)' })).s, 422);
  const ed = await req('PUT', '/api/admin/produtos/bolo-de-pote', { ...novo.j, alergenos: [], preco: 1600 });
  assert.equal(ed.j.preco, 1600);
  const resumo = await req('GET', '/api/admin/resumo');
  assert.equal(resumo.s, 200);
  assert.ok(resumo.j.hoje.n >= 1);
});

test('relatório: faturamento, cancelados com motivo e período', async () => {
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const rel = () => req('GET', `/api/admin/relatorio?de=${hoje}&ate=${hoje}`);
  const antes = (await rel()).j;
  const dia = (await agendaDe('pedido'))[0];
  const novo = async () => (await req('POST', '/api/pedidos', { ...pedidoBase, modalidade: 'retirada', itens: [{ id: 'trad', qtd: 2 }], agendado_para: dia.data + 'T' + dia.horarios.at(-1) })).j;
  await novo();
  const c = await novo();
  await req('POST', `/api/admin/pedidos/${c.id}/status`, { status: 'cancelado', obs: 'Cliente desistiu' });
  const r = (await rel()).j;
  assert.equal(r.totais.pedidos, antes.totais.pedidos + 1);
  assert.equal(r.totais.total, antes.totais.total + 4100);
  assert.equal(r.cancelados.n, antes.cancelados.n + 1);
  assert.equal(r.cancelados.total, antes.cancelados.total + 4100);
  assert.equal(r.cancelados.lista.find(x => x.id === c.id).motivo, 'Cliente desistiu');
  assert.equal(r.porDia.at(-1).dia, hoje);
  assert.ok(r.produtos.some(p => p.produto_id === 'trad'));
  assert.equal(r.totais.total, r.totais.produtos + r.totais.taxas - r.totais.descontos, 'fechamento bate');
  assert.equal((await req('GET', '/api/admin/relatorio?de=2026-02-01&ate=2026-01-01')).s, 422);
  assert.equal((await req('GET', `/api/admin/relatorio?de=${hoje}&ate=${hoje}`, null, false)).s, 401);
});

/* ============ MÉTRICAS ============ */
const hojeSL = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const metricas = async () => (await req('GET', `/api/admin/metricas?de=${hojeSL()}&ate=${hojeSL()}`)).j;
const lote = (sessao, eventos, extra = {}) => req('POST', '/api/eventos',
  { visitante: 'vis-' + sessao, sessao, origem: 'instagram.com', dispositivo: 'mobile', eventos, ...extra }, false);

test('eventos: aceita lote válido e recusa tipos/ids inválidos', async () => {
  assert.equal((await lote('sessao-aaaa1', [{ tipo: 'visita' }, { tipo: 'ver_produto', alvo: 'trad' }])).s, 200);
  assert.equal((await lote('sessao-aaaa1', [{ tipo: 'pedido_finalizado' }])).s, 422, 'tipo só do servidor');
  assert.equal((await lote('sessao-aaaa1', [{ tipo: 'inventado' }])).s, 422);
  assert.equal((await lote('x', [{ tipo: 'visita' }])).s, 422, 'sessão inválida');
  assert.equal((await lote('sessao-aaaa1', Array(21).fill({ tipo: 'visita' }))).s, 422, 'lote grande');
  assert.equal((await lote('sessao-aaaa1', [])).s, 422);
});

test('links curtos: CRUD, redireciona, conta clique e atribui o pedido', async () => {
  assert.equal((await req('POST', '/api/admin/links', { nome: 'Bio Insta', destino: '/', ativo: true })).s, 422, 'nome com espaço');
  assert.equal((await req('POST', '/api/admin/links', { nome: 'bio', destino: 'javascript:alert(1)', ativo: true })).s, 422);
  const l = await req('POST', '/api/admin/links', { nome: 'bio', destino: '/', ativo: true });
  assert.equal(l.s, 201);
  await req('POST', '/api/admin/links', { nome: 'zap', destino: 'https://wa.me/5598999990000', ativo: true });
  assert.equal((await req('POST', '/api/admin/links', { nome: 'bio', destino: '/', ativo: true })).s, 409);

  const r = await fetch(base + '/l/bio', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/?origem=bio');
  assert.equal((await fetch(base + '/l/zap', { redirect: 'manual' })).headers.get('location'), 'https://wa.me/5598999990000');
  assert.equal((await fetch(base + '/l/naoexiste', { redirect: 'manual' })).headers.get('location'), '/');
  await req('PATCH', `/api/admin/links/${l.j.id}/ativo`, { ativo: false });
  assert.equal((await fetch(base + '/l/bio', { redirect: 'manual' })).headers.get('location'), '/', 'inativo não conta');
  await req('PATCH', `/api/admin/links/${l.j.id}/ativo`, { ativo: true });

  // pedido vindo do link
  const dia = (await agendaDe('pedido'))[0];
  const p = await req('POST', '/api/pedidos', {
    ...pedidoBase, modalidade: 'retirada', itens: [{ id: 'trad', qtd: 1 }], agendado_para: dia.data + 'T' + dia.horarios.at(-2),
    rastro: { visitante: 'vis-sessao-link1', sessao: 'sessao-link1', origem: 'bio' },
  });
  assert.equal(p.s, 201);
  const m = await metricas();
  const bio = m.links.find(x => x.nome === 'bio');
  assert.equal(bio.cliques, 1);
  assert.equal(bio.pedidos, 1);
  assert.equal(bio.faturamento, 2050);
  assert.equal(m.links.find(x => x.nome === 'zap').cliques, 1);
  assert.ok(m.origens.some(o => o.origem === 'bio' && o.pedidos === 1));
});

test('métricas: funil por sessão, procura não atendida, cliques e recorrência', async () => {
  const antes = await metricas();
  await lote('sessao-funil1', [{ tipo: 'visita' }, { tipo: 'ver_produto', alvo: 'cake' }, { tipo: 'add_carrinho', alvo: 'cake' }, { tipo: 'abrir_sacola' }]);
  await lote('sessao-funil2', [{ tipo: 'visita' }, { tipo: 'clique', alvo: 'whatsapp' }, { tipo: 'fora_area' }, { tipo: 'busca_vazia', alvo: 'pudim' }]);
  const m = await metricas();
  const etapa = (mm, t) => mm.funil.find(f => f.tipo === t).sessoes;
  assert.equal(etapa(m, 'visita'), etapa(antes, 'visita') + 2);
  assert.equal(etapa(m, 'add_carrinho'), etapa(antes, 'add_carrinho') + 1);
  assert.ok(m.funil.some(f => f.tipo === 'pedido_finalizado'));
  assert.ok(m.cliques.some(c => c.alvo === 'whatsapp' && c.n >= 1));
  assert.ok(m.naoAtendida.some(x => x.tipo === 'fora_area'));
  assert.ok(m.buscasVazias.some(b => b.alvo === 'pudim'));
  assert.ok(m.produtos.some(p => p.produto_id === 'cake' && p.vistos >= 1 && p.sacola >= 1));
  assert.ok(m.dispositivos.some(d => d.dispositivo === 'mobile'));
  assert.equal(m.clientes.recorrentes >= 1, true, 'mesmo telefone em vários pedidos');
  assert.ok(Array.isArray(m.demanda.semana) && Array.isArray(m.demanda.horas) && Array.isArray(m.demanda.bairros));
  assert.equal((await req('GET', `/api/admin/metricas?de=${hojeSL()}&ate=${hojeSL()}`, null, false)).s, 401);
});

test('status: voltar uma fase e reabrir cancelado, com histórico', async () => {
  const r = (await req('POST', '/api/pedidos', { ...pedidoBase, modalidade: 'delivery', bairro_id: 1, endereco: 'Rua B, 20', itens: [{ id: 'trad', qtd: 1 }] })).j;
  const mudar = (s, obs) => req('POST', `/api/admin/pedidos/${r.id}/status`, { status: s, obs });
  for (const s of ['recebido', 'em_preparacao', 'pronto', 'saiu_para_entrega']) await mudar(s);
  assert.equal((await mudar('pronto', 'Marcou enviado sem querer')).s, 200, 'volta uma fase');
  assert.equal((await mudar('recebido')).s, 409, 'não pula duas fases para trás');
  assert.equal((await mudar('em_preparacao')).s, 200);
  let p = (await req('GET', '/api/pedidos/' + r.codigo)).j;
  assert.equal(p.status, 'em_preparacao');
  assert.equal(p.historico.at(-2).obs, 'Marcou enviado sem querer');
  assert.match(p.historico.at(-1).obs, /Correção/);
  // entregue por engano também volta
  for (const s of ['pronto', 'saiu_para_entrega', 'entregue']) await mudar(s);
  assert.equal((await mudar('cancelado')).s, 409, 'finalizado não cancela direto');
  assert.equal((await mudar('saiu_para_entrega')).s, 200, 'entregue volta');
  // cancelado reabre na fase em que estava
  assert.equal((await mudar('cancelado', 'teste')).s, 200);
  assert.equal((await mudar('novo')).s, 409, 'reabre só na fase anterior ao cancelamento');
  assert.equal((await mudar('saiu_para_entrega')).s, 200);
  p = (await req('GET', '/api/pedidos/' + r.codigo)).j;
  assert.equal(p.status, 'saiu_para_entrega');
  assert.equal((await req('POST', `/api/admin/pedidos/${r.id}/status`, { status: 'pronto' }, false)).s, 401);
});
