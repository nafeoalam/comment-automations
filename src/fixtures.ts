// A small world (one business, three products, two posts, one campaign) shared by the tests and the demo.
import type { AutomationDefinition, CommentEvent, MessageEvent } from "./domain/types";
import { AutomationEngine } from "./engine/engine";
import type { EngineConfig } from "./engine/context";
import { ExamplePhraseClassifier, FakeLlmClassifier, TieredIntentClassifier, type IntentClassifier } from "./intent/classifier";
import { FakePlatform, type SentMessage } from "./platform/platform";
import { MemoryStore } from "./store/store";
import { DAY, ManualClock } from "./util/clock";

export const ACCOUNT = "acc_shop";
export const BUSINESS_USER = "ig_business";
export const CAMPAIGN = "camp_fall";
export const AUTOMATION = "auto_pricing";
export const POST_SINGLE = "post_tee"; // shows one product
export const POST_MULTI = "post_collection"; // shows three products

export const PRICING_FLOW: AutomationDefinition = {
  trigger: {
    type: "comment_intent",
    intent: "pricing",
    description: "The commenter wants to know the price or cost of a product in the post.",
    examples: ["pricing", "price", "how much", "cost", "precio", "prix"],
    minConfidence: 0.7,
  },
  steps: [
    { id: "reply", type: "reply_to_comment", text: "Sent you a DM!" },
    {
      id: "which_product",
      type: "ask_product",
      prompt: "Thanks for asking! Which product would you like pricing for? Reply with a number:",
      invalidPrompt: "Sorry, I didn't catch that. Reply with the number of the product:",
      spamPrompt: "Please reply with one of the product numbers above so we can help.",
    },
    {
      id: "contact",
      type: "ask_contact",
      prompt: "Happy to help with {{product.name}}! What's the best email to send the pricing to?",
      invalidPrompt: "That doesn't look like an email. Please send your email address, or a phone number if you prefer.",
      spamPrompt: "To continue, please send a valid email address or phone number.",
      accept: ["email", "phone"],
    },
    { id: "link", type: "send_dm", text: "Thanks! Here is the pricing for {{product.name}}: {{product.link}}" },
  ],
};

/** What the LLM tier would say for phrases the example tier can't settle. */
export const LLM_ANSWERS = {
  "cuanto cuesta": { intent: "pricing", confidence: 0.93, productId: null, language: "es" },
  "combien ca coute": { intent: "pricing", confidence: 0.91, productId: null, language: "fr" },
  "what would this set me back": { intent: "pricing", confidence: 0.88, productId: null, language: "en" },
  "cuanto cuesta la sudadera": { intent: "pricing", confidence: 0.95, productId: "p_hoodie", language: "es" },
  "this is so expensive lol": { intent: "pricing", confidence: 0.45, productId: null, language: "en" },
  "love this color": { intent: null, confidence: 0.9, productId: null, language: "en" },
};

export interface WorldOptions {
  classifier?: IntentClassifier;
  config?: Partial<EngineConfig>;
  onSend?: (m: SentMessage) => void;
}

export function createWorld(opts: WorldOptions = {}) {
  const clock = new ManualClock();
  const store = new MemoryStore();
  const platform = new FakePlatform(clock, opts.onSend);
  const llm = new FakeLlmClassifier(LLM_ANSWERS);
  const classifier = opts.classifier ?? new TieredIntentClassifier(new ExamplePhraseClassifier(), llm);
  const engine = new AutomationEngine({
    store,
    platform,
    classifier,
    clock,
    config: opts.config,
    dispatcher: { sleep: async () => {} },
  });

  store.putAccount({ id: ACCOUNT, platformUserId: BUSINESS_USER, allowedLinkDomains: ["shop.example.com"] });
  store.putProduct({ id: "p_tee", name: "Classic Tee", aliases: ["tee", "t-shirt", "camiseta"], link: "https://shop.example.com/tee", inStock: true });
  store.putProduct({ id: "p_hoodie", name: "Hoodie", aliases: ["sudadera"], link: "https://shop.example.com/hoodie", inStock: true });
  store.putProduct({ id: "p_cap", name: "Cap", aliases: ["hat", "gorra"], link: "https://shop.example.com/cap", inStock: true });
  store.putPost({ id: POST_SINGLE, socialAccountId: ACCOUNT, productIds: ["p_tee"] });
  store.putPost({ id: POST_MULTI, socialAccountId: ACCOUNT, productIds: ["p_tee", "p_hoodie", "p_cap"] });
  store.putCampaign({ id: CAMPAIGN, name: "Fall drop", endsAt: new Date(clock.now().getTime() + 30 * DAY), status: "active" });
  engine.lifecycle.createAutomation({ id: AUTOMATION, socialAccountId: ACCOUNT, campaignId: CAMPAIGN, name: "Pricing DM", definition: PRICING_FLOW });

  let seq = 0;
  const comment = (follower: string, text: string, postId = POST_SINGLE, eventId?: string): CommentEvent => ({
    type: "comment",
    eventId: eventId ?? `evt_${++seq}`,
    socialAccountId: ACCOUNT,
    postId,
    commentId: `cmt_${follower}_${postId}_${seq}`,
    authorId: follower,
    text,
    createdAt: clock.now(),
  });
  const dm = (follower: string, text: string, extra: Partial<MessageEvent> = {}): MessageEvent => ({
    type: "message",
    eventId: `evt_${++seq}`,
    socialAccountId: ACCOUNT,
    senderId: follower,
    text,
    isEcho: false,
    createdAt: clock.now(),
    ...extra,
  });

  return { engine, store, platform, clock, llm, comment, dm };
}
