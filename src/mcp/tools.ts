import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkPolicy } from "../agent/check_policy";
import { searchRegulation } from "../tools/search_regulation";
import { addRegulation } from "../tools/add_regulation";

/**
 * PoliCheck の MCP ツール定義（stdio / HTTP 両トランスポートで共有）。
 * check_policy / search_regulation / add_regulation を MCP ツールとして公開する。
 */

type CheckPolicyResult = Awaited<ReturnType<typeof checkPolicy>>;
const SEVERITY_LABEL = { high: "🔴 高", medium: "🟡 中", low: "🟢 低" } as const;

/** check_policy の結果を MCP ホストで読みやすいテキストに整形する。 */
function formatCheckResult(result: CheckPolicyResult): string {
  if (result.risks.length === 0) {
    return [
      "## 一次点検結果: 0 件",
      "",
      "大きな懸念観点は検出されませんでした。ただし検出なしは「問題がないこと」を意味しません。",
      "",
      `> ${result.disclaimer}`,
    ].join("\n");
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  const sorted = [...result.risks].sort(
    (a, b) => order[a.severity] - order[b.severity],
  );
  const body = sorted
    .map((r, i) =>
      [
        `### [${i + 1}] ${SEVERITY_LABEL[r.severity]} ${r.perspective}`,
        `- **① リスク観点**: ${r.perspective}`,
        `- **② 根拠条文**: ${r.articles.join(" / ")}`,
        `- **③ なぜリスクか**: ${r.reason}`,
        `- **④ 放置した場合の想定リスク**: ${r.consequence}`,
      ].join("\n"),
    )
    .join("\n\n");
  return [
    `## 一次点検結果: ${result.risks.length} 件の観点を提示`,
    "",
    body,
    "",
    `> ${result.disclaimer}`,
  ].join("\n");
}

/** 3 ツールを登録した MCP サーバーを生成する。 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "policheck", version: "0.1.0" });

  // --- check_policy（メイン） ---
  server.registerTool(
    "check_policy",
    {
      title: "プライバシーポリシー一次点検",
      description:
        "プライバシーポリシー文を受け取り、個人情報保護法の論点に分割して関連条文をRAGで参照し、" +
        "リスク観点・根拠条文・なぜリスクか・放置した場合の想定リスクの4点セットで一次点検結果を返す。" +
        "適法/違法の断定はせず、専門家レビュー前の論点洗い出しに用いる。",
      inputSchema: {
        policyText: z
          .string()
          .min(1)
          .max(20_000)
          .describe("点検対象のプライバシーポリシー本文"),
      },
    },
    async ({ policyText }) => {
      try {
        const result = await checkPolicy({ policyText, verbose: false });
        return { content: [{ type: "text", text: formatCheckResult(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `点検に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // --- search_regulation（条文あいまい検索） ---
  server.registerTool(
    "search_regulation",
    {
      title: "条文あいまい検索",
      description:
        "個人情報保護法の条文を、クエリ埋め込みと自前コサイン類似度であいまい検索し、関連条文を上位N件返す。",
      inputSchema: {
        query: z.string().min(1).max(200).describe("検索クエリ（論点キーワード）"),
        topK: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("返す件数（既定5、上限10）"),
      },
    },
    async ({ query, topK }) => {
      try {
        const { results } = await searchRegulation({ query, topK });
        const text = results
          .map(
            (r) =>
              `- ${r.score.toFixed(3)}  ${r.article}${r.caption}\n  ${r.content.replace(/\n/g, " ").slice(0, 120)}…`,
          )
          .join("\n");
        return { content: [{ type: "text", text: text || "ヒットなし" }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `検索に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // --- add_regulation（法令登録・セットアップ用） ---
  server.registerTool(
    "add_regulation",
    {
      title: "法令データ登録",
      description:
        "data/personal_info_law.json の個人情報保護法条文をチャンク化・埋め込みし、DBへ保存（冪等）する。" +
        "通常はセットアップ時に一度だけ実行する保守用ツール（埋め込みAPIを多数呼ぶため時間がかかる）。",
      inputSchema: {},
    },
    async () => {
      try {
        const n = await addRegulation();
        return {
          content: [{ type: "text", text: `登録完了: regulations ${n} 行` }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `登録に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  return server;
}
