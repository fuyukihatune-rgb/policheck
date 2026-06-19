/**
 * check_policy の出力スキーマと検証。
 *
 * CLAUDE.md 最重要②③の核心。「4点セット」を型で固定し、「断定させない」を
 * プロンプトだけでなく出力検証で構造的に強制する（インジェクションで破られても
 * 形式外をここで弾く）。
 *
 * - 4 点セットの必須フィールド: 観点 / 根拠条文 / なぜリスク / 放置リスク
 * - 断定表現（適法・違法・罰金◯円 等）の混入を検出して拒否
 * - 根拠条文は RAG で実在が確認された条番号のみ許可（幻覚引用の防止）
 */

/** 出力ごとに必ず添える免責フッター（一元管理）。 */
export const DISCLAIMER_FOOTER =
  "本結果はAIによる一次点検であり、法的助言ではありません。抵触の可能性がある観点の提示に留まり、適法・違法を判断するものではありません。最終確認は弁護士等の専門家へ。";

/** 重大度。断定ではなく相対的な目安に留める。 */
export type Severity = "high" | "medium" | "low";

/** リスク 1 件（4 点セット）。 */
export interface RiskItem {
  /** 1. リスク観点: どこが懸念か */
  perspective: string;
  /** 2. 根拠条文: 関連しうる条文（例: 個人情報保護法 第27条）。複数可 */
  articles: string[];
  /** 3. なぜリスクか: 条文の要求とポリシーの状態のギャップ */
  reason: string;
  /** 4. 放置した場合の想定リスク: 実務上起こりうる帰結（蓋然性トーン） */
  consequence: string;
  /** 重大度の目安（断定ではない） */
  severity: Severity;
}

/** check_policy の最終出力。 */
export interface CheckPolicyResult {
  /** 検出したリスク項目（4 点セットの配列） */
  risks: RiskItem[];
  /** 全体所見（任意。断定しないトーン） */
  summary?: string;
  /** 免責フッター */
  disclaimer: string;
}

/** 検証で許容する範囲の入力。LLM 生出力は形が崩れうるので unknown から検証する。 */
export interface ValidateOptions {
  /**
   * 引用を許可する条番号の集合（例: "第27条" / "第二十七条"）。
   * RAG で実在が確認された条のみ。省略時は条文の実在チェックをスキップ。
   */
  allowedArticles?: Set<string>;
}

export interface ValidationError {
  path: string;
  message: string;
}

/**
 * 断定・脅しに当たる禁止表現。出力に含まれていたら弾く。
 * 「違法でない」等の否定形も拾うため、語そのものの混入を検出する方針。
 */
const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /適法/, label: "「適法」の断定" },
  { pattern: /違法/, label: "「違法」の断定" },
  { pattern: /合法/, label: "「合法」の断定" },
  { pattern: /(?:罰金|過料|科料)[^。]{0,8}?\d/, label: "確定的な金額の脅し" },
  { pattern: /必ず(?:罰|処罰|摘発)/, label: "確定的な処罰の断定" },
];

const severities: Severity[] = ["high", "medium", "low"];

/** 条番号の表記ゆれを吸収して比較キーに正規化する（例: 「第27条」「第二十七条」）。 */
function normalizeArticleKey(s: string): string {
  // 漢数字 → アラビア数字に寄せる簡易変換（条番号で使う範囲のみ）
  const kanji: Record<string, string> = {
    〇: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5",
    六: "6", 七: "7", 八: "8", 九: "9",
  };
  // 「第二十七条」→ 桁構造を踏まえて変換
  const m = s.match(/第([〇一二三四五六七八九十百]+)条/);
  if (m) {
    const num = kanjiToNumber(m[1]!);
    if (num !== null) return `第${num}条`;
  }
  // アラビア数字表記はそのまま条番号部分を抽出
  const a = s.match(/第\s*(\d+)\s*条/);
  if (a) return `第${a[1]}条`;
  return s.replace(/\s/g, "");
}

/** 漢数字（十百まで）を数値へ。条番号用の簡易実装。 */
function kanjiToNumber(s: string): number | null {
  const digit: Record<string, number> = {
    〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9,
  };
  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (ch === "百") {
      total += (current === 0 ? 1 : current) * 100;
      current = 0;
    } else if (ch === "十") {
      total += (current === 0 ? 1 : current) * 10;
      current = 0;
    } else if (ch in digit) {
      current = digit[ch]!;
    } else {
      return null;
    }
  }
  return total + current;
}

/** 文字列フィールドが非空かを確認するヘルパ。 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * LLM 生出力(unknown)を CheckPolicyResult として検証する。
 * 形式・必須項目・断定表現・条文の実在を全てチェックし、エラー配列を返す。
 * エラーが空なら valid。
 */
export function validateCheckPolicyResult(
  raw: unknown,
  options: ValidateOptions = {},
): { valid: boolean; errors: ValidationError[]; value?: CheckPolicyResult } {
  const errors: ValidationError[] = [];
  const push = (path: string, message: string) =>
    errors.push({ path, message });

  if (typeof raw !== "object" || raw === null) {
    return { valid: false, errors: [{ path: "$", message: "オブジェクトではありません" }] };
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.risks)) {
    push("risks", "配列ではありません");
    return { valid: false, errors };
  }

  const checkForbidden = (text: string, path: string) => {
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) push(path, `禁止表現を含みます（${label}）`);
    }
  };

  obj.risks.forEach((item, i) => {
    const p = `risks[${i}]`;
    if (typeof item !== "object" || item === null) {
      push(p, "オブジェクトではありません");
      return;
    }
    const r = item as Record<string, unknown>;

    for (const [key, label] of [
      ["perspective", "リスク観点"],
      ["reason", "なぜリスクか"],
      ["consequence", "放置リスク"],
    ] as const) {
      if (!isNonEmptyString(r[key])) push(`${p}.${key}`, `${label}が空です`);
      else checkForbidden(r[key] as string, `${p}.${key}`);
    }

    if (!severities.includes(r.severity as Severity)) {
      push(`${p}.severity`, `severity は ${severities.join("/")} のいずれか`);
    }

    if (!Array.isArray(r.articles) || r.articles.length === 0) {
      push(`${p}.articles`, "根拠条文が空です（最低1つ必要）");
    } else {
      r.articles.forEach((art, j) => {
        if (!isNonEmptyString(art)) {
          push(`${p}.articles[${j}]`, "条文が空です");
          return;
        }
        // 実在チェック: 許可集合があれば、ヒット済み条文のみ許可
        if (options.allowedArticles) {
          const key = normalizeArticleKey(art as string);
          if (!options.allowedArticles.has(key)) {
            push(
              `${p}.articles[${j}]`,
              `RAGで未取得の条文を引用しています（${art}）`,
            );
          }
        }
      });
    }
  });

  if (obj.summary !== undefined) {
    if (!isNonEmptyString(obj.summary)) push("summary", "文字列ではありません");
    else checkForbidden(obj.summary, "summary");
  }

  if (errors.length > 0) return { valid: false, errors };

  // 検証通過。免責フッターを必ず付与した正規形を返す
  const value: CheckPolicyResult = {
    risks: (obj.risks as RiskItem[]).map((r) => ({
      perspective: r.perspective,
      articles: r.articles,
      reason: r.reason,
      consequence: r.consequence,
      severity: r.severity,
    })),
    summary: obj.summary as string | undefined,
    disclaimer: DISCLAIMER_FOOTER,
  };
  return { valid: true, errors: [], value };
}

/** 条番号文字列を比較キーへ正規化する（外部からも使えるよう公開）。 */
export { normalizeArticleKey };

// 動作確認: bun run src/prompt/schema.ts
if (import.meta.main) {
  const allowed = new Set(["第27条", "第21条"]);

  const good = {
    risks: [
      {
        perspective: "第三者提供に関する記載が見当たらない",
        articles: ["個人情報保護法 第27条"],
        reason: "本人同意や例外要件の明示がなく、条文の求める手当てとギャップがある可能性",
        consequence: "本人同意なき提供と整理されうる場面で、指導・勧告等の対象になりうる",
        severity: "high",
      },
    ],
    summary: "いくつかの観点で確認の余地があります",
  };
  const r1 = validateCheckPolicyResult(good, { allowedArticles: allowed });
  console.log("正常系 valid:", r1.valid, "/ footer付与:", !!r1.value?.disclaimer);

  const forbidden = {
    risks: [
      {
        perspective: "第三者提供の記載なし",
        articles: ["第27条"],
        reason: "このポリシーは違法です",
        consequence: "罰金100万円が科されます",
        severity: "high",
      },
    ],
  };
  const r2 = validateCheckPolicyResult(forbidden, { allowedArticles: allowed });
  console.log("断定検出 valid:", r2.valid);
  console.log("  errors:", r2.errors.map((e) => `${e.path}: ${e.message}`));

  const halluc = {
    risks: [
      {
        perspective: "x",
        articles: ["第999条"],
        reason: "y",
        consequence: "z",
        severity: "low",
      },
    ],
  };
  const r3 = validateCheckPolicyResult(halluc, { allowedArticles: allowed });
  console.log("幻覚条文検出 valid:", r3.valid, "/", r3.errors.map((e) => e.message));
}
