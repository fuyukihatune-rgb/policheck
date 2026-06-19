/**
 * e-Gov 法令API(v2) から個人情報保護法を取得し、条単位に整形して
 * data/personal_info_law.json に保存する。
 *
 * 設計メモ:
 * - 根拠条文の幻覚対策の一次ソース。RAG は必ずこの取得範囲からのみ条文を引く
 * - 本則(MainProvision)のみ対象。附則(SupplProvision)は条番号が本則と重複し
 *   一次点検の論点でもないため除外する
 * - 出典・取得日・law_revision_id をメタに残し、改ざん条文の混入と版ズレを防ぐ
 *
 * 実行: bun run src/rag/fetch_law.ts
 */

const LAW_ID = "415AC0000000057"; // 個人情報の保護に関する法律（平成十五年法律第五十七号）
const SOURCE_URL = `https://laws.e-gov.go.jp/api/2/law_data/${LAW_ID}`;
const SOURCE_NAME = "e-Gov法令検索（デジタル庁）";
const OUT_PATH = "data/personal_info_law.json";

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

/** 整形済みの 1 条分。db の regulations テーブルに 1 行で入る単位。 */
export interface LawArticle {
  /** 条番号の見出し（例: 第二十七条） */
  article: string;
  /** API 上の条番号（例: 27、枝番は 27_2 形式） */
  num: string;
  /** 条見出し（例: （第三者提供の制限））。無い条もある */
  caption: string;
  /** 条文本文（項・号を改行整形して連結） */
  content: string;
}

/** data ファイル全体の型。 */
export interface LawData {
  meta: {
    law_id: string;
    law_revision_id: string;
    law_num: string;
    title: string;
    source_url: string;
    source_name: string;
    retrieved_at: string;
  };
  articles: LawArticle[];
}

/** e-Gov のレスポンスは XML 由来のタグ木（タグ/属性/子）。 */
interface Node {
  tag?: string;
  attr?: Record<string, string>;
  children?: (Node | string)[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const wait = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(
          `[fetch_law] ${label} 失敗 (試行 ${attempt}/${MAX_RETRIES})。${wait}ms 後に再試行: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await sleep(wait);
      }
    }
  }
  throw new Error(
    `[fetch_law] ${label} がリトライ上限(${MAX_RETRIES})に達しました: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/** ノード配下の全テキストを連結する。 */
function rawText(node: Node | string): string {
  if (typeof node === "string") return node;
  if (!node.children) return "";
  return node.children.map(rawText).join("");
}

/** 指定タグの直下/子孫から最初の 1 つを返す（浅い探索）。 */
function findChild(node: Node, tag: string): Node | undefined {
  return node.children?.find(
    (c): c is Node => typeof c === "object" && c.tag === tag,
  );
}

function findChildren(node: Node, tag: string): Node[] {
  return (node.children ?? []).filter(
    (c): c is Node => typeof c === "object" && c.tag === tag,
  );
}

/**
 * Paragraph を読みやすいテキストに整形する。
 * 本文 + 各号を「号番号　本文」の形で改行区切りにする。
 */
function paragraphText(p: Node): string {
  const sentence = rawText(findChild(p, "ParagraphSentence") ?? {});
  const items = findChildren(p, "Item").map((item) => {
    const title = rawText(findChild(item, "ItemTitle") ?? {});
    const body = rawText(findChild(item, "ItemSentence") ?? {});
    return title ? `${title}　${body}` : body;
  });
  return [sentence, ...items].filter((s) => s.trim()).join("\n");
}

/** Article ノードを LawArticle に整形する。 */
function toArticle(node: Node): LawArticle {
  const article = rawText(findChild(node, "ArticleTitle") ?? {}).trim();
  const caption = rawText(findChild(node, "ArticleCaption") ?? {}).trim();
  const content = findChildren(node, "Paragraph")
    .map(paragraphText)
    .filter((s) => s.trim())
    .join("\n");
  return {
    article,
    num: node.attr?.Num ?? "",
    caption,
    content,
  };
}

/** 木を再帰的に下り、tag に一致するノードを集める。 */
function* walk(node: Node | string): Generator<Node> {
  if (typeof node !== "object") return;
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

async function main() {
  console.log(`[fetch_law] e-Gov v2 から取得: ${SOURCE_URL}`);

  const json = await withRetry(async () => {
    const res = await fetch(SOURCE_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<any>;
  }, "law_data 取得");

  const lawRevisionId: string = json.revision_info?.law_revision_id ?? "";
  const title: string = json.revision_info?.law_title ?? "";
  const lawNum: string = json.law_info?.law_num ?? "";
  const fullText: Node = json.law_full_text;

  // 本則(MainProvision)のみを対象にする（附則は除外）
  const body = findChild(fullText, "LawBody");
  const mainProvision = body ? findChild(body, "MainProvision") : undefined;
  if (!mainProvision) throw new Error("MainProvision が見つかりません");

  const articles: LawArticle[] = [];
  for (const n of walk(mainProvision)) {
    if (n.tag === "Article") articles.push(toArticle(n));
  }
  // 本文が空の条（削除条など）は除外
  const filtered = articles.filter((a) => a.article && a.content.trim());

  const retrievedAt = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const data: LawData = {
    meta: {
      law_id: LAW_ID,
      law_revision_id: lawRevisionId,
      law_num: lawNum,
      title,
      source_url: SOURCE_URL,
      source_name: SOURCE_NAME,
      retrieved_at: retrievedAt,
    },
    articles: filtered,
  };

  await Bun.write(OUT_PATH, JSON.stringify(data, null, 2));

  console.log(`[fetch_law] ✅ 保存完了: ${OUT_PATH}`);
  console.log(`   法令: ${title} (${lawNum})`);
  console.log(`   版: ${lawRevisionId}`);
  console.log(`   取得日: ${retrievedAt}`);
  console.log(`   本則の条数: ${filtered.length}`);
  console.log(`   先頭3条:`);
  for (const a of filtered.slice(0, 3)) {
    console.log(`     - ${a.article}${a.caption}（本文 ${a.content.length} 字）`);
  }
}

if (import.meta.main) {
  await main();
}
