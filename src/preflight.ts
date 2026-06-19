/**
 * デモ前プリフライト点検。
 * 本番直前に `bun run preflight` で、鍵・DB・サンプル・外部API疎通をまとめて確認する。
 * すべて緑なら exit 0、ひとつでも赤なら exit 1。
 */

import { db } from "./db/db";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) =>
  checks.push({ name, ok, detail });

// 1) APIキー
const provider = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
add(
  "GEMINI_API_KEY（埋め込み用）",
  !!process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY ? "設定済み" : "未設定（.envを確認）",
);
if (provider === "anthropic") {
  add(
    "ANTHROPIC_API_KEY（LLM用）",
    !!process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_API_KEY ? "設定済み" : "未設定（.envを確認）",
  );
}
add("LLM_PROVIDER", true, provider);

// 2) 法令DB
try {
  const { n } = db.query("SELECT COUNT(*) AS n FROM regulations").get() as {
    n: number;
  };
  const { u } = db
    .query("SELECT COUNT(DISTINCT article) AS u FROM regulations")
    .get() as { u: number };
  add(
    "法令DB（regulations）",
    n > 0,
    n > 0
      ? `${n}行 / ${u}条`
      : "空。`bun run src/tools/add_regulation.ts` を実行",
  );
} catch (e) {
  add("法令DB（regulations）", false, e instanceof Error ? e.message : String(e));
}

// 3) サンプル
for (const s of ["bad", "decent", "tricky"]) {
  const exists = await Bun.file(`samples/${s}_policy.md`).exists();
  add(`サンプル ${s}_policy.md`, exists, exists ? "あり" : "見つからない");
}

// 4) Gemini埋め込み疎通（1回）
try {
  const { embedText, EMBED_DIM } = await import("./rag/embed");
  const v = await embedText("接続テスト", "RETRIEVAL_QUERY");
  add(
    "Gemini埋め込み疎通",
    v.length === EMBED_DIM,
    `${v.length}次元を取得`,
  );
} catch (e) {
  add(
    "Gemini埋め込み疎通",
    false,
    (e instanceof Error ? e.message : String(e)).slice(0, 100),
  );
}

// 5) LLM疎通（1回・最小）
try {
  const { generateJson } = await import("./agent/llm");
  const r = (await generateJson(
    'JSONで {"ok": true} とだけ返してください。',
    "preflight",
  )) as { ok?: boolean };
  add("LLM疎通", r?.ok === true, r?.ok === true ? "応答OK" : "応答が想定外");
} catch (e) {
  add(
    "LLM疎通",
    false,
    (e instanceof Error ? e.message : String(e)).slice(0, 100),
  );
}

// 結果表示
console.log("\n===== PoliCheck プリフライト点検 =====");
for (const c of checks) {
  console.log(`  ${c.ok ? "✅" : "❌"} ${c.name.padEnd(28, "　")} ${c.detail}`);
}
const allOk = checks.every((c) => c.ok);
console.log(
  `\n${allOk ? "🟢 すべて緑。デモを開始できます。" : "🔴 赤あり。上記を解消してから開始してください。"}\n`,
);
process.exit(allOk ? 0 : 1);
