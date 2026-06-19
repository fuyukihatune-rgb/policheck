import { Database } from "bun:sqlite";

export const db = new Database("policheck.db");

// 条文チャンクのテーブル。embeddingはJSON文字列で保存
db.run(`
  CREATE TABLE IF NOT EXISTS regulations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article TEXT NOT NULL,        -- 条番号（例: 第27条）
    title TEXT,                   -- 見出し
    content TEXT NOT NULL,        -- 条文本文
    embedding TEXT NOT NULL,      -- 埋め込みベクトル(JSON)
    source TEXT,                  -- 出典
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

console.log("✅ DB初期化完了");
