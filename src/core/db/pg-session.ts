import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * `statement_timeout` que de fato chega ao servidor.
 *
 * O `statement_timeout` passado ao construtor do `Pool` NAO tem efeito atras do
 * Supavisor: ele viaja no startup packet, e o pooler descarta parametros de
 * startup -- o mesmo comportamento ja documentado para PGOPTIONS/PGTZ contra o
 * OMS. Medido em 2026-08-22: o pool pedia 20.000 ms e `SHOW statement_timeout`
 * devolvia "2min", o default do servidor.
 *
 * A consequencia era silenciosa e caro: uma consulta que devia falhar em 20 s
 * ocupava 2 minutos, e como 57014 conta como erro transitorio, o retry a
 * repetia tres vezes -- 490 s medidos num unico request. Ninguem escolheu esse
 * limite; ele apenas nao era o que o codigo dizia.
 *
 * Por que nao `pool.on("connect")`: o `pg` nao aguarda esse handler, entao a
 * primeira consulta pode ser despachada ANTES do SET (o proprio driver avisa,
 * "client.query() when the client is already executing a query"). Fica exatamente
 * a consulta mais perigosa -- a primeira, com conexao fria -- sem o limite.
 *
 * Aqui o SET e enviado na mesma conexao fisica, antes da consulta, e apenas
 * quando o limite MUDA: em modo sessao (porta 5432) o valor persiste, entao
 * repetir a cada consulta seria um round-trip jogado fora. O WeakMap nao impede
 * a coleta do client.
 *
 * Por que WeakMap<client, ms> e nao WeakSet<client>: um mesmo pool serve
 * chamadores com limites diferentes -- mirror-events-repository.ts pede 20 s nas
 * leituras e 120 s na descoberta, financial-orders-repository.ts pede 20 s nas
 * telas e 120 s nas gravacoes do job. Com WeakSet, o PRIMEIRO valor a tocar
 * aquela conexao vencia para sempre e todos os outros eram descartados em
 * silencio, invertidos nos dois sentidos: a descoberta do job podia herdar os
 * 20 s de uma tela e falhar, e uma tela podia herdar os 120 s do job e segurar
 * dois minutos de CPU. Guardar o valor aplicado e comparar e o que faz o
 * parametro `timeoutMs` significar o que diz.
 */
const applied = new WeakMap<PoolClient, number>();

export async function queryWithTimeout<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  timeoutMs: number,
  text: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    const wanted = Math.floor(timeoutMs);
    if (applied.get(client) !== wanted) {
      // Literal interpolado e nao parametro: SET nao aceita bind, e o valor vem
      // de constante do codigo, nunca de entrada externa.
      await client.query(`SET statement_timeout = ${wanted}`);
      applied.set(client, wanted);
    }

    return await client.query<T>(text, values as unknown[]);
  } finally {
    client.release();
  }
}
