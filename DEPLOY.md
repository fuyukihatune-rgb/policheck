# デプロイ手順

PoliCheck の HTTP API（Hono / Bun）をコンテナでデプロイする。法令DB（`policheck.db`）は
リポジトリに同梱しているため、ビルド後すぐ起動できる。

## エンドポイント

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/` | 稼働情報（JSON） |
| GET | `/healthz` | ヘルスチェック（`ok`） |
| POST | `/check` | `{ "policyText": "..." }` → 4点セットの点検結果（JSON） |
| GET | `/disclaimer` | 免責ページ（HTML） |

実行時に必要な環境変数：

- `GEMINI_API_KEY` — 埋め込み（RAG）用
- `ANTHROPIC_API_KEY` — LLM推論用
- `PORT` — 任意（既定 8787）

## ローカルでコンテナ確認

```bash
docker build -t policheck .
docker run --rm -p 8787:8787 \
  -e GEMINI_API_KEY=$GEMINI_API_KEY \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  policheck

# 別ターミナルで
curl -s localhost:8787/healthz
curl -s -X POST localhost:8787/check -H 'content-type: application/json' \
  --data-binary @<(jq -Rs '{policyText: .}' < samples/tricky_policy.md)
```

## Fly.io（コンテナ）

```bash
fly launch --no-deploy            # fly.toml 生成（Dockerfile 自動検出）
fly secrets set GEMINI_API_KEY=... ANTHROPIC_API_KEY=...
fly deploy
# 公開URLの /healthz と /check を確認
```

## Render（GitHub連携・Docker）

クレジットカード不要・ブラウザ完結。同梱の `render.yaml`（Blueprint）を使う。

1. https://render.com に GitHub でサインイン
2. New → **Blueprint** → 本リポジトリ(`policheck`)を選択（`render.yaml` を自動読込）
3. `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` を入力して Apply
4. ビルド完了後（数分）、公開URLの `/healthz` `/disclaimer` `/check` を確認

> Free プランは無操作で休止し、次回アクセス時にコールドスタート（数十秒）する。デモ前に一度叩いて温めておく。

## 注意（本番運用）

- `/check` は有料LLMを呼ぶ。公開する場合は**認証・レート制限・上限管理**を別途必須とする
  （本実装はプロセス内の簡易IPレート制限のみ）。
- 法令改正に追従する場合は `bun run src/rag/fetch_law.ts` → `bun run src/tools/add_regulation.ts`
  を実行して `policheck.db` を再生成・再デプロイする。
- APIキーは環境変数で注入し、イメージやリポジトリに含めない。
