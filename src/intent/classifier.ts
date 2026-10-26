import { containsPhrase, normalize } from "../util/text";

export interface IntentSpec {
  key: string;
  description: string;
  examples: string[];
}

export interface ProductRef {
  id: string;
  name: string;
  aliases: string[];
}

export interface ClassifyInput {
  text: string;
  /** All intents active automations on this account listen for. One call covers them all. */
  intents: IntentSpec[];
  /** Products on the post, so the classifier can tell us if the comment already names one. */
  products: ProductRef[];
}

export interface IntentResult {
  intent: string | null;
  confidence: number;
  /** Set when the comment clearly names exactly one of the post's products. */
  productId: string | null;
  language?: string;
  source: "examples" | "llm" | "cache" | "none";
}

export interface IntentClassifier {
  classify(input: ClassifyInput): Promise<IntentResult>;
}

export const NO_INTENT: IntentResult = { intent: null, confidence: 0, productId: null, source: "none" };

/** Whole-word match of product names and aliases. Returns an id only if exactly one product matches. */
export function findProductMention(text: string, products: ProductRef[]): string | null {
  const t = normalize(text);
  const hits = products.filter((p) => [p.name, ...p.aliases].some((n) => containsPhrase(t, normalize(n))));
  return hits.length === 1 ? hits[0]!.id : null;
}

/**
 * Tier 1: cheap and deterministic. Matches the business's example phrases
 * (in any languages they list) after normalization. It handles the common
 * case ("pricing", "price?", "precio") with no model call. It never says "no".
 * It returns null so the next tier can decide.
 */
export class ExamplePhraseClassifier implements IntentClassifier {
  async classify(input: ClassifyInput): Promise<IntentResult> {
    const text = normalize(input.text);
    let best: IntentResult = NO_INTENT;
    for (const intent of input.intents) {
      for (const ex of intent.examples) {
        const e = normalize(ex);
        const confidence = text === e ? 0.98 : containsPhrase(text, e) ? 0.9 : 0;
        if (confidence > best.confidence) {
          best = { intent: intent.key, confidence, productId: null, source: "examples" };
        }
      }
    }
    if (best.intent) best.productId = findProductMention(input.text, input.products);
    return best;
  }
}

/**
 * Tier 1 first, then the LLM tier for everything tier 1 can't settle
 * (other languages, slang, full sentences). Results are cached by normalized
 * text, because viral posts get the same few comments thousands of times.
 */
export class TieredIntentClassifier implements IntentClassifier {
  private cache = new Map<string, IntentResult>();

  constructor(
    private readonly cheap: IntentClassifier,
    private readonly llm?: IntentClassifier,
    private readonly opts: { maxCacheEntries?: number; llmTimeoutMs?: number } = {},
  ) {}

  async classify(input: ClassifyInput): Promise<IntentResult> {
    const key = [
      normalize(input.text),
      input.intents.map((i) => i.key).sort().join(","),
      input.products.map((p) => p.id).sort().join(","),
    ].join("|");
    const cached = this.cache.get(key);
    if (cached) return { ...cached, source: "cache" };

    let result = await this.cheap.classify(input);
    if (!result.intent && this.llm) {
      const llmResult = await this.tryLlm(this.llm, input);
      // LLM down or slow: answer with the cheap tier alone ("no intent") and don't cache it, so a later comment retries.
      if (!llmResult) return result;
      result = llmResult;
      if (result.intent && !result.productId) result.productId = findProductMention(input.text, input.products);
    }

    if (this.cache.size >= (this.opts.maxCacheEntries ?? 10_000)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, result);
    return result;
  }

  private async tryLlm(llm: IntentClassifier, input: ClassifyInput): Promise<IntentResult | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.opts.llmTimeoutMs ?? 5_000);
    });
    try {
      return await Promise.race([llm.classify(input), timeout]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Deterministic stand-in for the LLM tier in tests and the demo. */
export class FakeLlmClassifier implements IntentClassifier {
  calls = 0;
  constructor(private readonly table: Record<string, Omit<IntentResult, "source">>) {}
  async classify(input: ClassifyInput): Promise<IntentResult> {
    this.calls += 1;
    const hit = this.table[normalize(input.text)];
    return hit ? { ...hit, source: "llm" } : { ...NO_INTENT, source: "llm" };
  }
}
