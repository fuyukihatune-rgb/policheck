import { db } from "../db/db";
import { embedText } from "./embed";

/**
 * 条文のあいまい検索（RAG の検索側）。
 * クエリを埋め込み、D1 に保存した条文チャンクとのコサイン類似度で上位を返す。
 *
 * 設計メモ:
 * - ベクトルは登録・検索とも L2 正規化済みなので、コサイン類似度＝内積で計算できる
 * - 数百チャンク規模なので外部ベクトル DB は使わず、全件メモリ上で総当たり
 * - チャンクは初回に一度だけ読み込みキャッシュする（エージェントが何度も呼ぶため）
 */

export interface SearchResult {
  /** 条番号見出し（例: 第二十七条） */
  article: string;
  /** 条見出し（例: （第三者提供の制限）） */
  caption: string;
  /** 該当チャンク本文 */
  content: string;
  /** コサイン類似度（-1〜1。正規化済みなので実質 0〜1 付近） */
  score: number;
}

interface CachedChunk {
  article: string;
  caption: string;
  content: string;
  embedding: number[];
}

let cache: CachedChunk[] | null = null;

/** D1 から全チャンクを読み、埋め込みをパースしてメモリに載せる（初回のみ）。 */
function loadChunks(): CachedChunk[] {
  if (cache) return cache;
  const rows = db
    .query("SELECT article, title, content, embedding FROM regulations")
    .all() as {
    article: string;
    title: string;
    content: string;
    embedding: string;
  }[];
  if (rows.length === 0) {
    throw new Error(
      "regulations が空です。先に bun run src/tools/add_regulation.ts を実行してください。",
    );
  }
  cache = rows.map((r) => ({
    article: r.article,
    caption: r.title,
    content: r.content,
    embedding: JSON.parse(r.embedding) as number[],
  }));
  return cache;
}

/** 正規化済みベクトル同士のコサイン類似度（＝内積）。 */
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * クエリに近い条文チャンクを上位 topK 件返す。
 * @param query 検索クエリ（論点キーワードなど）
 * @param topK  返す件数（既定 5）
 */
export async function searchRegulation(
  query: string,
  topK = 5,
): Promise<SearchResult[]> {
  if (query.trim().length === 0) throw new Error("検索クエリが空です");
  const chunks = loadChunks();
  const qvec = await embedText(query, "RETRIEVAL_QUERY");

  return chunks
    .map((c) => ({
      article: c.article,
      caption: c.caption,
      content: c.content,
      score: dot(qvec, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// 単体動作確認: bun run src/rag/search.ts "第三者提供"
if (import.meta.main) {
  const query = process.argv[2] ?? "第三者への個人データの提供";
  console.log(`[search] クエリ: "${query}"`);
  const results = await searchRegulation(query, 5);
  for (const r of results) {
    console.log(
      `  ${r.score.toFixed(4)}  ${r.article}${r.caption}  | ${r.content
        .replace(/\n/g, " ")
        .slice(0, 60)}…`,
    );
  }
}
