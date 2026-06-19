import { db } from "../db/db";
import { embedTexts } from "../rag/embed";
import { invalidateRegulationCache } from "../rag/search";
import type { LawArticle, LawData } from "../rag/fetch_law";

/**
 * add_regulation ツール: 整形済み法令(data/personal_info_law.json)を
 * チャンク化 → Gemini 埋め込み → ローカル D1(bun:sqlite) に保存する。
 *
 * 設計メモ:
 * - 基本は 1 条 1 チャンク。長い条だけ項・号の改行境界で分割する
 *   （長文は埋め込みが薄まり検索精度が落ちるため）
 * - 各チャンク先頭に「第○条（見出し）」を付け、分割しても条の文脈を保つ
 * - 冪等: 再実行時は全削除→再投入（単一法令スコープなので安全。版更新もそのまま流せる）
 */

const DATA_PATH = "data/personal_info_law.json";
/** これを超えた条だけ分割する閾値（文字数） */
const MAX_CHARS = 800;
/** 埋め込み API を 1 回で呼ぶチャンク数（無料枠レート対策） */
const EMBED_BATCH = 32;

/** D1 に 1 行で入る条文チャンク。 */
export interface RegulationChunk {
  /** 条番号見出し（例: 第二十七条） */
  article: string;
  /** 条見出し（例: （第三者提供の制限）） */
  caption: string;
  /** チャンク本文（先頭に「条番号＋見出し」を含む） */
  content: string;
}

/**
 * 条配列をチャンク配列に変換する（純関数）。
 * MAX_CHARS 以下の条はそのまま 1 チャンク、超える条は改行境界で貪欲分割。
 */
export function buildChunks(articles: LawArticle[]): RegulationChunk[] {
  const chunks: RegulationChunk[] = [];
  for (const a of articles) {
    const header = `${a.article}${a.caption}`;
    const make = (body: string): RegulationChunk => ({
      article: a.article,
      caption: a.caption,
      content: `${header}\n${body}`,
    });

    if (a.content.length <= MAX_CHARS) {
      chunks.push(make(a.content));
      continue;
    }

    // 長い条は改行（項・号）境界で貪欲にパッキングして分割
    let buf: string[] = [];
    let len = 0;
    const flush = () => {
      if (buf.length) {
        chunks.push(make(buf.join("\n")));
        buf = [];
        len = 0;
      }
    };
    for (const line of a.content.split("\n")) {
      if (len + line.length > MAX_CHARS && buf.length) flush();
      buf.push(line);
      len += line.length + 1;
    }
    flush();
  }
  return chunks;
}

/** data ファイルを読み、埋め込み、D1 に保存する。 */
export async function addRegulation(): Promise<number> {
  const file = Bun.file(DATA_PATH);
  if (!(await file.exists())) {
    throw new Error(
      `${DATA_PATH} が見つかりません。先に bun run src/rag/fetch_law.ts を実行してください。`,
    );
  }
  const data: LawData = JSON.parse(await file.text());
  const chunks = buildChunks(data.articles);
  console.log(
    `[add_regulation] ${data.articles.length}条 → ${chunks.length}チャンクに分割`,
  );

  // バッチで埋め込み（RETRIEVAL_DOCUMENT: 文書側として最適化）
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vs = await embedTexts(
      batch.map((c) => c.content),
      "RETRIEVAL_DOCUMENT",
    );
    vectors.push(...vs);
    console.log(
      `  埋め込み進捗 ${Math.min(i + EMBED_BATCH, chunks.length)}/${chunks.length}`,
    );
  }

  // 出典（出所・版・取得日）を 1 行に記録。改ざん混入・版ズレの追跡用
  const source = `${data.meta.source_name} | ${data.meta.law_id} | rev:${data.meta.law_revision_id} | 取得:${data.meta.retrieved_at}`;

  const insert = db.prepare(
    `INSERT INTO regulations (article, title, content, embedding, source) VALUES (?, ?, ?, ?, ?)`,
  );
  // 冪等化＋一貫性のためトランザクションで「全削除→一括投入」
  const replaceAll = db.transaction(
    (rows: { chunk: RegulationChunk; vec: number[] }[]) => {
      db.run("DELETE FROM regulations");
      for (const { chunk, vec } of rows) {
        insert.run(
          chunk.article,
          chunk.caption,
          chunk.content,
          JSON.stringify(vec),
          source,
        );
      }
    },
  );
  replaceAll(chunks.map((chunk, i) => ({ chunk, vec: vectors[i]! })));
  // 同一プロセスで検索を回している場合に備え、条文キャッシュを破棄
  invalidateRegulationCache();

  const { n } = db
    .query("SELECT COUNT(*) AS n FROM regulations")
    .get() as { n: number };
  console.log(`[add_regulation] ✅ 保存完了: regulations ${n}行`);
  console.log(`   出典: ${source}`);
  return n;
}

if (import.meta.main) {
  await addRegulation();
}
