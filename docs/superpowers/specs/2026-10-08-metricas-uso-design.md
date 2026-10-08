# Métricas de uso dos clientes — design

## Objetivo
Responder, no painel admin, sem serviços de terceiros:
- **Vender mais:** onde o cliente desiste (funil por sessão).
- **Planejar produção:** demanda por produto, dia da semana, horário e bairro; procura que não virou venda.
- **Origem:** de onde vêm visitas, pedidos e faturamento.
- **Cliques:** links curtos rastreáveis (`/l/nome`) geridos no painel + cliques em botões/links do site.

Restrições: zero dependências (como o resto do projeto), dados no próprio servidor (domínio próprio,
SQLite local), visitante anônimo (id aleatório no navegador, sem IP, sem dados pessoais nos eventos).

## Dados
- `eventos(id, criado_em, visitante, sessao, tipo, alvo, origem, dispositivo)` — retenção de 12 meses.
- `links(id, nome UNIQUE, destino, ativo, criado_em)` — CRUD no painel (mesmo padrão de cupons).
- `pedidos.origem` — origem da primeira visita do cliente; gravada na criação do pedido.

Tipos aceitos do navegador (lista fechada): `visita, ver_produto, add_carrinho, abrir_sacola,
escolher_data, clique, busca_vazia, sem_horario, horario_recusado, fora_area`.
Só o servidor grava: `pedido_finalizado` (na mesma transação do pedido) e `clique_link`.

## Coleta
- `POST /api/eventos` recebe lote de até 20 eventos `{visitante, sessao, origem, dispositivo, eventos:[{tipo, alvo}]}`;
  valida ids e tipos; limite por IP.
- O site junta eventos numa fila e envia com `sendBeacon` (a cada 2s e ao sair da página).
- Origem: `?origem=` (links curtos) › `utm_source` › domínio do referrer › `direto`.
  Origem da visita fica na sessão; a primeira origem do visitante fica no aparelho e vai no pedido.

## Links curtos
`GET /l/:nome` → registra `clique_link` e redireciona (302). Destino interno (`/...`) recebe `?origem=nome`
para atribuir o pedido; destino externo (https, ex.: WhatsApp) só redireciona. Link inativo/inexistente → página inicial.

## Painel
- Aba **Links**: criar/editar/desativar, ver URL pronta para copiar.
- Aba **Métricas** (por período): funil, origens (visitas → pedidos → R$), links (cliques → pedidos → R$),
  produtos (vistos → sacola → vendidos), demanda por dia da semana/horário/bairro, procura não atendida
  (sem horário, horário recusado, fora da área, buscas sem resultado), clientes novos × recorrentes,
  dispositivo, cliques no site.

## Testes
Testes de API em `tests/api.test.mjs`: ingestão e validação de eventos, CRUD de links e redirecionamento,
origem gravada no pedido + evento `pedido_finalizado`, números do endpoint de métricas.

## Fora do escopo
Gravação de sessão, mapas de calor, cookies de terceiros, Vercel (o site sai de lá).
