import { GoogleGenAI } from "@google/genai";

/**
 * LLM 生成ラッパ（エージェントの思考用）。
 *
 * 環境変数 LLM_PROVIDER で推論プロバイダを切り替える（既定 anthropic）。
 * 埋め込み(rag/embed.ts)は常に Gemini を使う（Anthropic に埋め込みAPIは無く、
 * D1 のベクトルも Gemini 768次元で構築済みのため）。
 *
 * いずれのプロバイダも:
 * - JSON 文字列を返す前提（プロンプト側で「JSONのみ」を指示）
 * - タイムアウト・指数バックオフ・レート/過負荷エラー時のリトライ
 * - 失敗は握りつぶさず、リトライ上限で投げる
 */

const PROVIDER = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();

const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** エラー本文から推奨待機秒(retryDelay / retry-after)を取り出す。無ければ null。 */
function parseRetryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m =
    msg.match(/"retryDelay":\s*"(\d+)s"/) ?? msg.match(/retry in (\d+)/);
  if (m) return (Number(m[1]) + 1) * 1000;
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const wait =
          parseRetryDelayMs(err) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[llm] ${label} 失敗 (試行 ${attempt}/${MAX_RETRIES})。${Math.ceil(
            wait / 1000,
          )}秒後に再試行: ${reason.slice(0, 140)}`,
        );
        await sleep(wait);
      }
    }
  }
  throw new Error(
    `[llm] ${label} がリトライ上限(${MAX_RETRIES})に達しました: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/** プロバイダ共通インタフェース。プロンプト→生テキストを返す。 */
interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(prompt: string): Promise<string>;
}

// ---- Anthropic (Claude) プロバイダ: 公式エンドポイントへ fetch で直接アクセス ----
// 依存追加を避けるため SDK ではなく Messages API を直接叩く。
class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
  private readonly apiKey: string;

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY が未設定です（LLM_PROVIDER=anthropic）。.env を確認してください。",
      );
    }
    this.apiKey = key;
  }

  async generate(prompt: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system:
          "あなたは指定されたJSONスキーマだけを返すアシスタントです。前後の説明文やマークダウンの囲い(```)を一切付けず、JSONオブジェクトのみを出力してください。",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const retryAfter = res.headers.get("retry-after");
      // retry-after(秒) を parseRetryDelayMs が拾える形式に埋め込む
      throw new Error(
        `HTTP ${res.status}${retryAfter ? ` retry in ${retryAfter}` : ""}: ${body.slice(0, 160)}`,
      );
    }

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text = data.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (!text || text.trim().length === 0) {
      throw new Error("Anthropic 応答が空です");
    }
    return text;
  }
}

// ---- Gemini プロバイダ: 無料枠レート制限つき ----
class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly model = process.env.GEMINI_LLM_MODEL ?? "gemini-2.5-flash";
  private readonly ai: GoogleGenAI;
  // 無料枠は実効 約10 RPM。上限より低い目標値に抑え、バースト429を防ぐ。
  private readonly maxPerMin = 8;
  private readonly windowMs = 60_000;
  private readonly sentAt: number[] = [];

  constructor() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY が未設定です。");
    this.ai = new GoogleGenAI({ apiKey: key });
  }

  private async reserveRate(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.sentAt.length && now - this.sentAt[0]! > this.windowMs) {
        this.sentAt.shift();
      }
      if (this.sentAt.length < this.maxPerMin) {
        this.sentAt.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.sentAt[0]!) + 100;
      console.log(
        `[llm] レート制限待機 ${Math.ceil(waitMs / 1000)}秒（直近 ${this.sentAt.length}/${this.maxPerMin} 件/分）`,
      );
      await sleep(waitMs);
    }
  }

  async generate(prompt: string): Promise<string> {
    await this.reserveRate();
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.2,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    const out = res.text;
    if (!out || out.trim().length === 0) throw new Error("Gemini 応答が空です");
    return out;
  }
}

function createProvider(): LlmProvider {
  switch (PROVIDER) {
    case "gemini":
      return new GeminiProvider();
    case "anthropic":
      return new AnthropicProvider();
    default:
      throw new Error(`未知の LLM_PROVIDER: ${PROVIDER}（anthropic | gemini）`);
  }
}

const provider = createProvider();
console.log(`[llm] プロバイダ: ${provider.name} / モデル: ${provider.model}`);

/** 生テキストから JSON を寛容に取り出す（囲い記号・前後文の混入に耐性）。 */
function parseJsonLoose(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // 最初の { から最後の } までを抜き出して再試行
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
  }
  throw new Error(
    `[llm] ${label}: JSON パースに失敗しました（先頭120字: ${text.slice(0, 120)}）`,
  );
}

/**
 * プロンプトを渡し、JSON として解釈した結果を返す（型は呼び出し側で検証）。
 */
export async function generateJson(
  prompt: string,
  label: string,
): Promise<unknown> {
  const text = await withRetry(() => provider.generate(prompt), label);
  return parseJsonLoose(text, label);
}
