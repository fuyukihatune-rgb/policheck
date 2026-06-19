import { searchRegulation as coreSearch, type SearchResult } from "../rag/search";

/**
 * search_regulation ツール: 条文のあいまい検索を MCP/エージェント向けに公開する層。
 * コア検索(rag/search.ts)を薄くラップし、入力検証と件数クランプを担う。
 *
 * 設計メモ:
 * - クエリ長に上限を設け、巨大入力によるコスト爆発・DoS 的挙動を防ぐ
 * - エージェントが内部で何度も呼ぶため、戻り値は構造化したまま（整形は呼び出し側）
 */

/** クエリの最大文字数（論点キーワード想定。長文ポリシー本文を丸ごと渡させない） */
const MAX_QUERY_CHARS = 200;
/** 返す件数の上限 */
const MAX_TOP_K = 10;
const DEFAULT_TOP_K = 5;

export interface SearchRegulationInput {
  /** 検索クエリ（論点・キーワード） */
  query: string;
  /** 返す件数（省略時 5、上限 10） */
  topK?: number;
}

export interface SearchRegulationOutput {
  query: string;
  results: SearchResult[];
}

/**
 * 条文を検索する。入力を検証してからコア検索に委譲する。
 */
export async function searchRegulation(
  input: SearchRegulationInput,
): Promise<SearchRegulationOutput> {
  const query = (input.query ?? "").trim();
  if (query.length === 0) throw new Error("query が空です");
  if (query.length > MAX_QUERY_CHARS) {
    throw new Error(
      `query が長すぎます（${query.length} > ${MAX_QUERY_CHARS}字）。論点キーワードに絞ってください。`,
    );
  }

  const topK = Math.min(
    Math.max(1, Math.floor(input.topK ?? DEFAULT_TOP_K)),
    MAX_TOP_K,
  );

  const results = await coreSearch(query, topK);
  return { query, results };
}

// 動作確認: bun run src/tools/search_regulation.ts "利用目的の特定"
if (import.meta.main) {
  const query = process.argv[2] ?? "利用目的の特定と通知";
  const { results } = await searchRegulation({ query, topK: 3 });
  console.log(`[search_regulation] "${query}" → ${results.length}件`);
  for (const r of results) {
    console.log(`  ${r.score.toFixed(4)}  ${r.article}${r.caption}`);
  }
}
