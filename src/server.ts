import { Hono } from "hono";
import { checkPolicy } from "./agent/check_policy";
import { DISCLAIMER_FOOTER } from "./prompt/schema";
import { db } from "./db/db";

/**
 * PoliCheck HTTP サーバー（Hono / Bun）。デプロイ用エントリ。
 *   GET  /            稼働情報
 *   GET  /healthz     ヘルスチェック
 *   POST /check       { policyText } → 4点セットの点検結果(JSON)
 *   GET  /disclaimer  免責ページ（CLAUDE.md 要件）
 *
 * 公開エンドポイントは有料LLMを呼ぶため、簡易レート制限を入れている
 * （本番では認証/WAF/上限管理を別途想定）。
 */

const MAX_BODY_CHARS = 20_000;
// 簡易レート制限（プロセス内・IP単位のスライディングウィンドウ）
const RATE_LIMIT = 10; // 件/分
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

// 免責ページ用に DISCLAIMER.md を読み込む（無ければフッターで代替）
const disclaimerMd = (await Bun.file("DISCLAIMER.md").exists())
  ? await Bun.file("DISCLAIMER.md").text()
  : DISCLAIMER_FOOTER;

// 起動時に法令DBが空でないか確認（空ならエラーで気付けるように）
try {
  const { n } = db.query("SELECT COUNT(*) AS n FROM regulations").get() as {
    n: number;
  };
  if (n === 0) {
    console.error(
      "[server] 警告: regulations が空です。bun run src/tools/add_regulation.ts を実行してください。",
    );
  } else {
    console.error(`[server] 法令DB: regulations ${n}行`);
  }
} catch (e) {
  console.error("[server] DB確認失敗:", e instanceof Error ? e.message : e);
}

const app = new Hono();

app.get("/", (c) =>
  c.json({
    name: "PoliCheck",
    description:
      "プライバシーポリシーを個人情報保護法に照らして一次点検するAPI（法的助言ではありません）",
    endpoints: {
      "POST /check": "{ policyText: string } → 4点セットの点検結果",
      "GET /disclaimer": "免責事項",
      "GET /healthz": "ヘルスチェック",
    },
  }),
);

app.get("/healthz", (c) => c.text("ok"));

app.post("/check", async (c) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "local";
  if (rateLimited(ip)) {
    return c.json({ error: "リクエストが多すぎます。少し待って再試行してください。" }, 429);
  }

  const body = (await c.req.json().catch(() => null)) as {
    policyText?: unknown;
  } | null;
  const policyText = body?.policyText;
  if (typeof policyText !== "string" || policyText.trim().length === 0) {
    return c.json({ error: "policyText（文字列）が必要です。" }, 400);
  }
  if (policyText.length > MAX_BODY_CHARS) {
    return c.json(
      { error: `policyText が長すぎます（${policyText.length} > ${MAX_BODY_CHARS}字）。` },
      413,
    );
  }

  try {
    const result = await checkPolicy({ policyText, verbose: false });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.get("/disclaimer", (c) => {
  // Markdown を最小限のHTMLに整形して表示
  const html = disclaimerMd
    .replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^\- (.*)$/gm, "<li>$1</li>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n\n/g, "<br><br>");
  return c.html(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>PoliCheck 免責事項</title>` +
      `<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.7;color:#222}h1{font-size:1.5rem}h2{font-size:1.2rem;margin-top:1.6rem}li{margin:.2rem 0}</style>` +
      `</head><body>${html}</body></html>`,
  );
});

const port = Number(process.env.PORT ?? 8787);
console.error(`[server] PoliCheck HTTP サーバー起動: http://localhost:${port}`);

export default { port, fetch: app.fetch };
