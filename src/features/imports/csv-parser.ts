import type { CsvParseResult, ImportRow } from "./types";

/**
 * Cabeçalho esperado (case-insensitive):
 *   data, tipo, valor, descricao, categoria, origem
 *
 * Formato de data aceito: DD/MM/AAAA ou AAAA-MM-DD
 * Tipo aceito: receita|entrada|income -> "income" / despesa|saída|saida|expense -> "expense"
 * Valor aceito: número positivo (ex: 1234.56 ou 1.234,56 ou R$ 1.234,56)
 */

function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseDate(raw: string): Date | null {
  const trimmed = raw.trim();
  // DD/MM/AAAA
  const dmyMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const dt = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
    return isNaN(dt.getTime()) ? null : dt;
  }
  // AAAA-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const dt = new Date(`${trimmed}T00:00:00.000Z`);
    return isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

function parseType(raw: string): "income" | "expense" | null {
  const v = raw.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (["receita", "entrada", "income"].includes(v)) return "income";
  if (["despesa", "saida", "expense"].includes(v)) return "expense";
  return null;
}

function parseAmount(raw: string): number | null {
  // Remove prefixos monetários, espaços e quebras
  let cleaned = raw.trim().replace(/^R\$\s?/, "").replace(/\s/g, "");
  // Se tiver ponto de milhar e vírgula decimal: 1.234,56
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    // Remove qualquer ponto/vírgula de milhar (ex: 1,234.56)
    cleaned = cleaned.replace(",", ".");
  }
  const n = parseFloat(cleaned);
  if (isNaN(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if ((ch === "," || ch === ";") && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ""));
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ""));
  return result;
}

export function parseCsv(content: string): CsvParseResult {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) {
    return { rows: [], errorCount: 0 };
  }

  const headers = splitCsvLine(nonEmpty[0]).map(normalizeHeader);
  const idx = {
    data: headers.indexOf("data"),
    tipo: headers.indexOf("tipo"),
    valor: headers.indexOf("valor"),
    descricao: Math.max(headers.indexOf("descricao"), headers.indexOf("descricao")),
    categoria: headers.indexOf("categoria"),
    origem: Math.max(headers.indexOf("origem"), headers.indexOf("source")),
  };

  const rows: ImportRow[] = [];
  let errorCount = 0;

  for (let i = 1; i < nonEmpty.length; i++) {
    const cells = splitCsvLine(nonEmpty[i]);
    const rowIndex = i;

    const rawDate = idx.data >= 0 ? (cells[idx.data] ?? "") : "";
    const rawType = idx.tipo >= 0 ? (cells[idx.tipo] ?? "") : "";
    const rawValue = idx.valor >= 0 ? (cells[idx.valor] ?? "") : "";

    const occurredAt = parseDate(rawDate);
    const type = parseType(rawType);
    const amountCents = parseAmount(rawValue);

    if (!occurredAt || !type || !amountCents) {
      const msgs: string[] = [];
      if (!occurredAt) msgs.push(`data inválida: "${rawDate}"`);
      if (!type) msgs.push(`tipo inválido: "${rawType}"`);
      if (!amountCents) msgs.push(`valor inválido: "${rawValue}"`);
      rows.push({
        rowIndex,
        occurredAt: new Date(),
        type: "income",
        amountCents: 0,
        status: "error",
        errorMsg: msgs.join("; "),
      });
      errorCount++;
      continue;
    }

    rows.push({
      rowIndex,
      occurredAt,
      type,
      amountCents,
      description: idx.descricao >= 0 ? (cells[idx.descricao] || undefined) : undefined,
      category: idx.categoria >= 0 ? (cells[idx.categoria] || undefined) : undefined,
      source: idx.origem >= 0 ? (cells[idx.origem] || undefined) : undefined,
      status: "pending",
    });
  }

  return { rows, errorCount };
}
