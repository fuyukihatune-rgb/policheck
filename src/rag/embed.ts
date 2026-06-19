import { GoogleGenAI } from "@google/genai";

/**
 * Gemini 埋め込みラッパ。
 *
 * RAG の土台。条文登録(add_regulation)とクエリ検索(search_regulation)の
 * 両方から使う唯一の埋め込み入口。
 *
 * 設計メモ:
 * - taskType を文書用/クエリ用で使い分け、検索精度を上げる（Gemini 標準機能）
 * - 768 次元に縮約し L2 正規化する。数百チャンク規模では 3072 次元は過剰で、
 *   正規化済みベクトルなら自前コサイン類似度を「内積」で計算できる（高速・単純）
 * - タイムアウト＋指数バックオフのリトライで外部 API 障害時の暴発を防ぐ
 */

export const EMBED_MODEL = "gemini-embedding-001";
export const EMBED_DIM = 768;

/** 埋め込み用途。文書登録とクエリ検索で使い分ける。 */
export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 500;

// 無料枠レート制限対策。
// gemini-embedding-001 の無料枠は「100 リクエスト/分」で、バッチ内の各テキストが
// 1 リクエストとして計上される。上限より低い目標値に抑え、429 を未然に防ぐ。
const MAX_TEXTS_PER_MIN = 80;
const RATE_WINDOW_MS = 60_000;
/** 直近に送ったテキストの送信時刻（スライディングウィンドウ） */
const sentAt: number[] = [];

/** これから n 件送る前に、毎分上限を超えないよう必要なら待機する。 */
async function reserveRate(n: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (sentAt.length && now - sentAt[0]! > RATE_WINDOW_MS) sentAt.shift();
    if (sentAt.length + n <= MAX_TEXTS_PER_MIN) {
      for (let i = 0; i < n; i++) sentAt.push(now);
      return;
    }
    const waitMs = RATE_WINDOW_MS - (now - sentAt[0]!) + 100;
    console.log(
      `[embed] レート制限待機 ${Math.ceil(waitMs / 1000)}秒（直近 ${sentAt.length}/${MAX_TEXTS_PER_MIN} 件/分）`,
    );
    await sleep(waitMs);
  }
}

/** 429 エラー本文から推奨待機秒(retryDelay)を取り出す。無ければ null。 */
function parseRetryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/"retryDelay":\s*"(\d+)s"/) ?? msg.match(/retry in (\d+)/);
  if (m) return (Number(m[1]) + 1) * 1000;
  return null;
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error(
    "GEMINI_API_KEY が未設定です。.env に設定してください（リポジトリにはコミットしないこと）。",
  );
}

const ai = new GoogleGenAI({ apiKey });

/** L2 正規化。ゼロベクトルはそのまま返す（NaN 汚染を避ける）。 */
function l2normalize(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 指数バックオフ付きリトライ。
 * 最終試行で失敗したら元のエラーを投げる（握りつぶさない）。
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        // 429 の場合は API 推奨の retryDelay を優先。無ければ指数バックオフ。
        const wait =
          parseRetryDelayMs(err) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[embed] ${label} 失敗 (試行 ${attempt}/${MAX_RETRIES})。${Math.ceil(
            wait / 1000,
          )}秒後に再試行: ${reason.slice(0, 120)}`,
        );
        await sleep(wait);
      }
    }
  }
  throw new Error(
    `[embed] ${label} がリトライ上限(${MAX_RETRIES})に達しました: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/** 1 回分の API 呼び出し。タイムアウトは AbortSignal で制御。 */
async function callEmbed(
  texts: string[],
  taskType: EmbedTaskType,
): Promise<number[][]> {
  await reserveRate(texts.length);
  const res = await ai.models.embedContent({
    model: EMBED_MODEL,
    contents: texts,
    config: {
      taskType,
      outputDimensionality: EMBED_DIM,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    },
  });

  const embeddings = res.embeddings;
  if (!embeddings || embeddings.length !== texts.length) {
    throw new Error(
      `埋め込み結果の数が不正です（要求 ${texts.length} / 返却 ${
        embeddings?.length ?? 0
      }）`,
    );
  }

  return embeddings.map((e, i) => {
    const values = e.values;
    if (!values || values.length === 0) {
      throw new Error(`${i} 番目のテキストの埋め込みが空です`);
    }
    return l2normalize(values);
  });
}

/**
 * 複数テキストをまとめて埋め込む（バッチ）。
 * 戻り値は入力と同じ順序の、L2 正規化済みベクトル配列。
 */
export async function embedTexts(
  texts: string[],
  taskType: EmbedTaskType,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.some((t) => t.trim().length === 0)) {
    throw new Error("空文字列は埋め込めません");
  }
  return withRetry(
    () => callEmbed(texts, taskType),
    `embedTexts(${texts.length}件, ${taskType})`,
  );
}

/** 単一テキストを埋め込む。 */
export async function embedText(
  text: string,
  taskType: EmbedTaskType,
): Promise<number[]> {
  const [vec] = await embedTexts([text], taskType);
  return vec!;
}

// 直接実行時のスモークテスト: bun run src/rag/embed.ts
if (import.meta.main) {
  const doc = await embedText(
    "個人情報取扱事業者は、個人データを第三者に提供してはならない。",
    "RETRIEVAL_DOCUMENT",
  );
  console.log(`✅ 埋め込み成功 / モデル: ${EMBED_MODEL}`);
  console.log(`   次元数: ${doc.length}（期待値 ${EMBED_DIM}）`);
  console.log(`   先頭5要素: [${doc.slice(0, 5).map((x) => x.toFixed(4)).join(", ")}]`);

  const norm = Math.sqrt(doc.reduce((s, x) => s + x * x, 0));
  console.log(`   L2ノルム: ${norm.toFixed(6)}（正規化済みなら ≒1）`);

  // taskType 別に近い/遠い文で内積(=コサイン)が妥当に動くか確認
  const [near, far] = await embedTexts(
    ["第三者への個人データ提供に関する規定", "今日の天気は晴れです"],
    "RETRIEVAL_QUERY",
  );
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
  console.log(`   類似(関連クエリ) コサイン: ${dot(doc, near!).toFixed(4)}`);
  console.log(`   無関係(天気) コサイン:   ${dot(doc, far!).toFixed(4)}`);
}
