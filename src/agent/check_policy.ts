import { generateJson } from "./llm";
import { searchRegulation } from "../tools/search_regulation";
import {
  buildAssessPrompt,
  buildIssueSplitPrompt,
  DEFAULT_ISSUES,
} from "../prompt/prompts";
import {
  validateCheckPolicyResult,
  normalizeArticleKey,
  DISCLAIMER_FOOTER,
  type CheckPolicyResult,
  type RiskItem,
} from "../prompt/schema";

/**
 * check_policy: 論点分割エージェント（Tool Use ループを自前実装）。
 *
 * 「1回検索→1回LLM」にはしない。LLM の判断 → ツール実行(search_regulation) →
 * 結果返却 → 再判断 のループを自前コードで回す（CLAUDE.md 最重要①）。
 *
 * フロー:
 *   1. ポリシー受領（サイズ上限チェック）
 *   2. LLM で点検論点に分割
 *   3. 各論点: search_regulation → LLM照合 → 不十分ならLLM提案クエリで再検索（ループ）
 *   4. 全論点走査後、許可条文セットでスキーマ検証 → 4点セット出力
 *   5. 各ステップをログ出力（本文・個人情報は出さない）
 */

/** 入力ポリシーの最大文字数（巨大入力によるコスト爆発・DoS 防止）。 */
const MAX_POLICY_CHARS = 20_000;
/** 1 論点あたりの検索ラウンド上限（初回 + 再検索）。 */
const MAX_SEARCH_ROUNDS = 2;
/** 1 回の検索で取得する条文数。 */
const TOP_K = 5;
/** 処理する論点数の上限（無料枠の LLM 呼び出し数を抑えるため最重要論点に絞る）。 */
const MAX_ISSUES = 6;

/** 論点分割の 1 件。 */
interface Issue {
  id: string;
  title: string;
  query: string;
}

/** check_policy の入力。 */
export interface CheckPolicyInput {
  policyText: string;
  /** ログ出力の有無（既定 true）。思考プロセスの可視化用。 */
  verbose?: boolean;
}

let stepCounter = 0;
function log(verbose: boolean, msg: string): void {
  if (verbose) console.log(`[check_policy] ${msg}`);
}
function logStep(verbose: boolean, msg: string): void {
  if (verbose) console.log(`[check_policy] ▶ STEP ${++stepCounter}: ${msg}`);
}

/** LLM 応答から論点配列を取り出す。失敗時は既定論点にフォールバック。 */
function parseIssues(raw: unknown): Issue[] {
  const arr = (raw as { issues?: unknown })?.issues;
  if (Array.isArray(arr)) {
    const issues = arr
      .filter(
        (x): x is Issue =>
          !!x &&
          typeof (x as Issue).title === "string" &&
          typeof (x as Issue).query === "string",
      )
      .map((x, i) => ({
        id: typeof x.id === "string" && x.id ? x.id : `issue-${i + 1}`,
        title: x.title,
        query: x.query,
      }));
    if (issues.length > 0) return issues.slice(0, MAX_ISSUES);
  }
  // フォールバック: 既定論点で続行（点検を止めない）
  return DEFAULT_ISSUES.map((title, i) => ({
    id: `default-${i + 1}`,
    title,
    query: title,
  }));
}

/** 1 論点を評価する。検索→照合→（不十分なら）再検索のループ。 */
async function assessIssue(
  issue: Issue,
  policyText: string,
  allowedArticles: Set<string>,
  verbose: boolean,
): Promise<RiskItem[]> {
  let query = issue.query;
  const collected: RiskItem[] = [];

  for (let round = 1; round <= MAX_SEARCH_ROUNDS; round++) {
    // --- ツール呼び出し: search_regulation ---
    const { results } = await searchRegulation({ query, topK: TOP_K });
    for (const r of results) allowedArticles.add(normalizeArticleKey(r.article));
    log(
      verbose,
      `  🔎 検索(${round}/${MAX_SEARCH_ROUNDS}) "${query}" → ` +
        results
          .map((r) => `${r.article}(${r.score.toFixed(2)})`)
          .join(", "),
    );

    // --- LLM 照合 ---
    const raw = await generateJson(
      buildAssessPrompt({ issueTitle: issue.title, policyText, retrieved: results }),
      `assess[${issue.id}] round${round}`,
    );
    const parsed = raw as {
      sufficient?: boolean;
      nextQuery?: string | null;
      risks?: unknown;
    };
    const risks = Array.isArray(parsed.risks) ? (parsed.risks as RiskItem[]) : [];
    log(
      verbose,
      `  🧠 照合: sufficient=${parsed.sufficient !== false} / 暫定リスク${risks.length}件`,
    );

    // この論点の暫定リスクを保持（最後のラウンド結果を採用）
    collected.length = 0;
    collected.push(...risks);

    // --- 再検索の判断（LLM の判断でループ）---
    const needMore =
      parsed.sufficient === false &&
      typeof parsed.nextQuery === "string" &&
      parsed.nextQuery.trim().length > 0;
    if (!needMore || round === MAX_SEARCH_ROUNDS) break;

    log(verbose, `  ↻ 不十分と判断 → 再検索キーワード: "${parsed.nextQuery}"`);
    query = parsed.nextQuery!.trim();
  }

  return collected;
}

/**
 * メイン。ポリシー文を点検し、4 点セットの構造化結果を返す。
 */
export async function checkPolicy(
  input: CheckPolicyInput,
): Promise<CheckPolicyResult> {
  const verbose = input.verbose ?? true;
  const policyText = (input.policyText ?? "").trim();
  stepCounter = 0;

  // --- 入力検証 ---
  if (policyText.length === 0) throw new Error("ポリシー本文が空です");
  if (policyText.length > MAX_POLICY_CHARS) {
    throw new Error(
      `ポリシー本文が長すぎます（${policyText.length} > ${MAX_POLICY_CHARS}字）`,
    );
  }
  log(verbose, `点検開始（本文 ${policyText.length} 字）`);

  // --- STEP 1: 論点分割 ---
  logStep(verbose, "論点分割");
  const issuesRaw = await generateJson(
    buildIssueSplitPrompt(policyText),
    "issue-split",
  );
  const issues = parseIssues(issuesRaw);
  log(verbose, `論点 ${issues.length} 件: ${issues.map((i) => i.title).join(" / ")}`);

  // --- STEP 2: 各論点を評価（検索ループ）---
  const allowedArticles = new Set<string>();
  const allRisks: RiskItem[] = [];
  for (const issue of issues) {
    logStep(verbose, `論点評価「${issue.title}」`);
    const risks = await assessIssue(issue, policyText, allowedArticles, verbose);
    allRisks.push(...risks);
  }

  // --- STEP 3: スキーマ検証（断定・幻覚条文を構造で排除）---
  logStep(verbose, "出力検証");
  // 個々のリスクを検証で篩い、不正項目は落とす（必ず妥当な出力にする）
  const validRisks = allRisks.filter((r) => {
    const v = validateCheckPolicyResult({ risks: [r] }, { allowedArticles });
    if (!v.valid) {
      log(
        verbose,
        `  ⚠ リスク項目を除外: ${v.errors.map((e) => e.message).join(", ")}`,
      );
    }
    return v.valid;
  });

  // 安全網: low 重大度は一次点検の閾値未満として除外（過検出抑制・「黙るべき時は黙る」）
  const surfacedRisks = validRisks.filter((r) => r.severity !== "low");
  const droppedLow = validRisks.length - surfacedRisks.length;
  if (droppedLow > 0) {
    log(verbose, `  ℹ low重大度 ${droppedLow} 件を閾値未満として非表示`);
  }

  const result: CheckPolicyResult = {
    risks: surfacedRisks,
    disclaimer: DISCLAIMER_FOOTER,
  };
  // 最終形を全体検証（安全網）
  const finalCheck = validateCheckPolicyResult(result, { allowedArticles });
  if (!finalCheck.valid) {
    throw new Error(
      `最終出力の検証に失敗: ${finalCheck.errors.map((e) => e.message).join(", ")}`,
    );
  }
  log(
    verbose,
    `✅ 点検完了: 提示 ${surfacedRisks.length} 件（検証除外 ${allRisks.length - validRisks.length} 件 / low非表示 ${droppedLow} 件）`,
  );
  return finalCheck.value!;
}
