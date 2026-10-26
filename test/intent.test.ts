import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ExamplePhraseClassifier, findProductMention, TieredIntentClassifier, type ClassifyInput } from "../src/intent/classifier";
import { ClaudeIntentClassifier } from "../src/intent/claude-classifier";
import { extractEmail, extractPhone, normalize } from "../src/util/text";

const products = [
  { id: "p_tee", name: "Classic Tee", aliases: ["tee"] },
  { id: "p_cap", name: "Cap", aliases: ["gorra"] },
];
const input = (text: string): ClassifyInput => ({
  text,
  intents: [{ key: "pricing", description: "Asks for the price", examples: ["price", "how much", "precio"] }],
  products,
});

describe("text helpers", () => {
  it("normalizes case, accents, and punctuation", () => {
    expect(normalize("¿Cuánto CUESTA?!")).toBe("cuanto cuesta");
    expect(normalize("Combien ça coûte ?")).toBe("combien ca coute");
  });
  it("extracts emails and phone numbers", () => {
    expect(extractEmail("it's Ana.B+ig@Mail.Example.co.uk thanks")).toBe("ana.b+ig@mail.example.co.uk");
    expect(extractEmail("ana at example dot com")).toBeUndefined();
    expect(extractPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(extractPhone("I have 2 kids")).toBeUndefined();
  });
});

describe("example-phrase tier", () => {
  const c = new ExamplePhraseClassifier();
  it("matches whole words in any case", async () => {
    expect((await c.classify(input("PRICE??"))).confidence).toBe(0.98);
    expect((await c.classify(input("what's the price of the cap"))).intent).toBe("pricing");
  });
  it("does not match inside other words", async () => {
    expect((await c.classify(input("repricing strategy"))).intent).toBeNull();
  });
  it("finds a product only when exactly one is named", async () => {
    expect((await c.classify(input("precio de la gorra"))).productId).toBe("p_cap");
    expect(findProductMention("tee or cap?", products)).toBeNull();
  });
});

describe("tiered classifier", () => {
  it("falls back to 'no intent' when the LLM errors, and does not cache the failure", async () => {
    let calls = 0;
    const flaky = { classify: async () => { calls++; throw new Error("503"); } };
    const tiered = new TieredIntentClassifier(new ExamplePhraseClassifier(), flaky);
    expect((await tiered.classify(input("¿cuánto sale?"))).intent).toBeNull();
    await tiered.classify(input("¿cuánto sale?"));
    expect(calls).toBe(2);
  });

  it("gives up on a slow LLM after the timeout", async () => {
    const slow = { classify: () => new Promise<never>(() => {}) };
    const tiered = new TieredIntentClassifier(new ExamplePhraseClassifier(), slow, { llmTimeoutMs: 20 });
    expect((await tiered.classify(input("¿cuánto sale?"))).intent).toBeNull();
  });
});

describe("Claude tier", () => {
  function stubClient(reply: Partial<Anthropic.Beta.Messages.BetaMessage>) {
    const calls: unknown[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: unknown) => {
            calls.push(params);
            return { stop_reason: "end_turn", content: [], ...reply };
          },
        },
      },
    } as unknown as Anthropic;
    return { client, calls };
  }

  it("sends a structured-output request and parses the answer", async () => {
    const { client, calls } = stubClient({
      content: [{ type: "text", text: JSON.stringify({ intent: "pricing", confidence: 0.92, product_id: "p_cap", language: "es" }) }] as never,
    });
    const result = await new ClaudeIntentClassifier({ client }).classify(input("¿Y la gorrita cuánto sale?"));
    expect(result).toEqual({ intent: "pricing", confidence: 0.92, productId: "p_cap", language: "es", source: "llm" });

    const params = calls[0] as Record<string, any>;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.fallbacks).toBe("default");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema.properties.intent.enum).toEqual(["pricing", "none"]);
    expect(params.messages[0].content).toContain("<comment>\n¿Y la gorrita cuánto sale?\n</comment>");
  });

  it("treats a refusal as no intent", async () => {
    const { client } = stubClient({ stop_reason: "refusal" });
    expect((await new ClaudeIntentClassifier({ client }).classify(input("x"))).intent).toBeNull();
  });

  it("ignores intents and products that were not offered", async () => {
    const { client } = stubClient({
      content: [{ type: "text", text: JSON.stringify({ intent: "refund", confidence: 0.99, product_id: "p_other", language: "en" }) }] as never,
    });
    const result = await new ClaudeIntentClassifier({ client }).classify(input("refund me"));
    expect(result.intent).toBeNull();
    expect(result.productId).toBeNull();
  });
});
