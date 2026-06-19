import { checkPolicy } from "./agent/check_policy";
import type { RiskItem } from "./prompt/schema";

/**
 * CLI エントリ。ポリシー文ファイルを受け取り、一次点検結果（4点セット）を整形表示する。
 *
 * 使い方:
 *   bun run check samples/bad_policy.md
 *   bun run src/cli.ts samples/bad_policy.md --quiet   # 思考ログを抑制
 */

const SEVERITY_LABEL: Record<RiskItem["severity"], string> = {
  high: "🔴 高",
  medium: "🟡 中",
  low: "🟢 低",
};

function formatRisk(risk: RiskItem, index: number): string {
  const lines = [
    `\n[${index + 1}] ${SEVERITY_LABEL[risk.severity]}  ${risk.perspective}`,
    `    ① リスク観点 : ${risk.perspective}`,
    `    ② 根拠条文   : ${risk.articles.join(" / ")}`,
    `    ③ なぜリスク : ${risk.reason}`,
    `    ④ 放置リスク : ${risk.consequence}`,
  ];
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  const path = args.find((a) => !a.startsWith("--"));

  if (!path) {
    console.error("使い方: bun run check <ポリシー文ファイル> [--quiet]");
    process.exit(1);
  }

  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`ファイルが見つかりません: ${path}`);
    process.exit(1);
  }
  const policyText = await file.text();

  if (!quiet) console.log(`\n===== PoliCheck 一次点検: ${path} =====`);
  const result = await checkPolicy({ policyText, verbose: !quiet });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`点検結果: ${result.risks.length} 件の観点を提示`);
  console.log("=".repeat(60));

  if (result.risks.length === 0) {
    console.log(
      "\n大きな懸念観点は検出されませんでした。ただし検出なしは「問題がないこと」を意味しません。",
    );
  } else {
    // 重大度順（high→low）に並べて表示
    const order = { high: 0, medium: 1, low: 2 } as const;
    const sorted = [...result.risks].sort(
      (a, b) => order[a.severity] - order[b.severity],
    );
    sorted.forEach((r, i) => console.log(formatRisk(r, i)));
  }

  console.log(`\n${"-".repeat(60)}`);
  console.log(`⚠️  ${result.disclaimer}`);
  console.log("-".repeat(60));
}

if (import.meta.main) {
  await main();
}
