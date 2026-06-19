import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * PoliCheck MCP サーバー（stdio）。Claude Desktop / Claude Code 等の MCP ホストから接続する。
 * ツール定義は src/mcp/tools.ts を共有（HTTP版も同じ定義を使う）。
 *
 * 重要: stdio トランスポートは stdout を JSON-RPC 専用に使う。本プロジェクトは
 * console.log を多用するため、console.log/warn/info を stderr に振り替え、
 * ツール定義は「振り替え後」に動的 import して初期化ログも stdout を汚さないようにする。
 */

const toStderr =
  () =>
  (...args: unknown[]) =>
    process.stderr.write(
      `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
    );
console.log = toStderr();
console.info = toStderr();
console.warn = toStderr();

// ホストが任意の cwd から起動しても動くよう、プロジェクトルートへ移動。
const PROJECT_ROOT = resolve(import.meta.dir, "../..");
process.chdir(PROJECT_ROOT);

// .env を明示ロード（Bun の自動ロードは起動時 cwd 基準のため）。既存の環境変数は上書きしない。
const envPath = resolve(PROJECT_ROOT, ".env");
if (await Bun.file(envPath).exists()) {
  const txt = await Bun.file(envPath).text();
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// 振り替え後に動的 import（初期化ログも stderr へ）
const { createMcpServer } = await import("./tools");

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "[mcp] PoliCheck MCP サーバー起動（stdio）。ツール: check_policy / search_regulation / add_regulation",
);
