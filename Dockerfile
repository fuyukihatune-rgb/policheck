# PoliCheck HTTP サーバー（Hono / Bun）
FROM oven/bun:1

WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# アプリ一式（法令DB policheck.db・data/・DISCLAIMER.md を含む）
COPY . .

ENV PORT=8787
EXPOSE 8787

# GEMINI_API_KEY（埋め込み）と ANTHROPIC_API_KEY（LLM）は実行時に環境変数で渡す
CMD ["bun", "run", "src/server.ts"]
