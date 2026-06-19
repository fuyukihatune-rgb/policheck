import { test, expect, describe } from "bun:test";
import {
  validateCheckPolicyResult,
  normalizeArticleKey,
  DISCLAIMER_FOOTER,
} from "../src/prompt/schema";

const allowed = new Set(["第27条", "第21条"]);

const validRisk = {
  perspective: "第三者提供に関する記載が見当たらない",
  articles: ["個人情報保護法 第27条"],
  reason: "本人同意や例外要件の明示がなく、条文の求める手当てとギャップがある可能性",
  consequence: "本人同意なき提供と整理されうる場面で、指導・勧告等の対象になりうる",
  severity: "high" as const,
};

describe("validateCheckPolicyResult", () => {
  test("正常な4点セットは通り、免責フッターが必ず付与される", () => {
    const r = validateCheckPolicyResult(
      { risks: [validRisk] },
      { allowedArticles: allowed },
    );
    expect(r.valid).toBe(true);
    expect(r.value?.disclaimer).toBe(DISCLAIMER_FOOTER);
    expect(r.value?.risks).toHaveLength(1);
  });

  test("断定表現（違法）を含む出力は拒否される", () => {
    const r = validateCheckPolicyResult(
      { risks: [{ ...validRisk, reason: "このポリシーは違法です" }] },
      { allowedArticles: allowed },
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes("禁止表現"))).toBe(true);
  });

  test("断定表現（適法）を含む出力は拒否される", () => {
    const r = validateCheckPolicyResult(
      { risks: [{ ...validRisk, consequence: "完全に適法です" }] },
      { allowedArticles: allowed },
    );
    expect(r.valid).toBe(false);
  });

  test("確定的な金額の脅しは拒否される", () => {
    const r = validateCheckPolicyResult(
      { risks: [{ ...validRisk, consequence: "罰金100万円が科されます" }] },
      { allowedArticles: allowed },
    );
    expect(r.valid).toBe(false);
  });

  test("RAGで未取得の条文（幻覚）は拒否される", () => {
    const r = validateCheckPolicyResult(
      { risks: [{ ...validRisk, articles: ["第999条"] }] },
      { allowedArticles: allowed },
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes("未取得"))).toBe(true);
  });

  test("必須フィールド欠落は拒否される", () => {
    const r = validateCheckPolicyResult(
      { risks: [{ ...validRisk, reason: "" }] },
      { allowedArticles: allowed },
    );
    expect(r.valid).toBe(false);
  });

  test("根拠条文が空配列は拒否される", () => {
    const r = validateCheckPolicyResult(
      { risks: [{ ...validRisk, articles: [] }] },
      { allowedArticles: allowed },
    );
    expect(r.valid).toBe(false);
  });

  test("risksが配列でなければ拒否される", () => {
    const r = validateCheckPolicyResult({ risks: "x" });
    expect(r.valid).toBe(false);
  });

  test("空のrisksは正常（過検出しない＝0件もvalid）", () => {
    const r = validateCheckPolicyResult({ risks: [] });
    expect(r.valid).toBe(true);
    expect(r.value?.risks).toHaveLength(0);
  });
});

describe("normalizeArticleKey", () => {
  test("漢数字をアラビア数字に正規化", () => {
    expect(normalizeArticleKey("第二十七条")).toBe("第27条");
    expect(normalizeArticleKey("第二十八条")).toBe("第28条");
    expect(normalizeArticleKey("第百二十八条")).toBe("第128条");
  });
  test("アラビア数字表記はそのまま", () => {
    expect(normalizeArticleKey("第27条")).toBe("第27条");
  });
  test("法令名付きでも条番号を抽出", () => {
    expect(normalizeArticleKey("個人情報保護法 第28条")).toBe("第28条");
  });
  test("枝番（条の○）を保持し、別条として区別する", () => {
    expect(normalizeArticleKey("第二十八条の二")).toBe("第28条の2");
    expect(normalizeArticleKey("第28条の2")).toBe("第28条の2");
    // 枝番付きと基底条は別キー（幻覚グラウンディングが潰れない）
    expect(normalizeArticleKey("第28条の2")).not.toBe(normalizeArticleKey("第28条"));
  });
});

describe("FORBIDDEN（断定語の過剰一致を避ける）", () => {
  const base = {
    perspective: "x",
    articles: ["第27条"],
    consequence: "指導・勧告等の対象になりうる",
    severity: "medium" as const,
  };
  const allowed = new Set(["第27条"]);
  test("「適法性／違法性」は分析的名詞として許容される", () => {
    const r = validateCheckPolicyResult(
      { risks: [{ ...base, reason: "適法性の説明が不足している可能性がある" }] },
      { allowedArticles: allowed },
    );
    expect(r.valid).toBe(true);
  });
  test("「違法です」等の断定は引き続き拒否される", () => {
    const r = validateCheckPolicyResult(
      { risks: [{ ...base, reason: "このポリシーは違法です" }] },
      { allowedArticles: allowed },
    );
    expect(r.valid).toBe(false);
  });
});
