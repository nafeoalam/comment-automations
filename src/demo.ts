// npm run demo: walks through the main scenarios and prints what each follower sees.
import { AUTOMATION, CAMPAIGN, createWorld, POST_MULTI, PRICING_FLOW } from "./fixtures";
import type { SentMessage } from "./platform/platform";

const show = (m: SentMessage) => {
  const where = m.kind === "comment_reply" ? "reply on comment" : m.kind === "private_reply" ? `private reply DM to ${m.recipientId}` : `DM to ${m.recipientId}`;
  console.log(`      ${where}: ${JSON.stringify(m.text)}`);
};
const w = createWorld({ onSend: show });

const comment = async (who: string, text: string, post?: string) => {
  const e = w.comment(who, text, post);
  console.log(`  [comment] ${who}: ${JSON.stringify(text)}`);
  console.log(`      => ${await w.engine.onComment(e)}`);
  return e;
};
const dm = async (who: string, text: string) => {
  console.log(`  [DM] ${who}: ${JSON.stringify(text)}`);
  console.log(`      => ${await w.engine.onMessage(w.dm(who, text))}`);
};
const section = (title: string) => console.log(`\n=== ${title} ===`);

section("1. The example: one product on the post, so no product question");
await comment("ana", "pricing");
await dm("ana", "sure, ana@example.com");

section("2. Three products, Spanish comment, product chosen by number, phone as fallback");
await comment("bea", "¿Cuánto cuesta?", POST_MULTI);
await dm("bea", "2");
await dm("bea", "no tengo email");
await dm("bea", "+34 612 345 678");

section("3. Product named in the comment, so it is not asked");
await comment("cal", "how much is the cap?", POST_MULTI);
await dm("cal", "cal@example.com");

section("4. Duplicates and loops are ignored");
const dup = await comment("dan", "price?");
console.log(`  [comment] same webhook delivered again`);
console.log(`      => ${await w.engine.onComment({ ...dup })}`);
await comment("dan", "pricing pls");
await comment("ig_business", "Sent you a DM!");
await comment("eve", "this is so expensive lol");

section("5. Spam gets one generic response per cooldown");
for (const t of ["asdf", "???", "lol", "lol"]) await dm("dan", t);

section("6. A DM times out after delivery; the guardrail confirms it arrived and does not resend");
w.platform.failNext("ok", "ambiguous_after_delivery");
await comment("fay", "pricing");
const fayDm = w.store.listOutbound().find((a) => a.recipientId === "fay" && a.kind === "dm")!;
console.log(`      (the DM call timed out; send attempts: ${fayDm.attempts}, DMs fay received: ${w.platform.dmsTo("fay").length})`);

section("7. The business updates the flow mid-conversation; the follower restarts");
await comment("gus", "pricing", POST_MULTI);
await dm("gus", "1");
console.log("  [business] publishes version 2");
await w.engine.lifecycle.publishVersion(AUTOMATION, {
  ...PRICING_FLOW,
  steps: PRICING_FLOW.steps.map((s) => (s.id === "link" ? { ...s, text: "New prices are live! {{product.name}}: {{product.link}}" } : s)),
});
await dm("gus", "restart");
await dm("gus", "gus@example.com");

section("8. The campaign ends; a waiting follower is told on their next message");
await comment("hal", "price", POST_MULTI);
console.log("  [business] campaign ends");
await w.engine.lifecycle.endCampaign(CAMPAIGN);
await dm("hal", "3");
