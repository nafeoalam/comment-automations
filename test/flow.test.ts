import { describe, expect, it } from "vitest";
import { ACCOUNT, BUSINESS_USER, createWorld, POST_MULTI, POST_SINGLE } from "../src/fixtures";

const run = (w: ReturnType<typeof createWorld>, follower: string) => w.store.listRunsForFollower(ACCOUNT, follower)[0]!;

describe("the example flow", () => {
  it("replies to the comment, DMs for an email, waits, then DMs the link", async () => {
    const w = createWorld();
    const c = w.comment("ana", "pricing");

    expect(await w.engine.onComment(c)).toBe("started");
    expect(w.platform.commentRepliesTo(c.commentId)).toEqual(["Sent you a DM!"]);
    expect(w.platform.dmsTo("ana")).toEqual(["Happy to help with Classic Tee! What's the best email to send the pricing to?"]);
    expect(w.platform.sent.find((m) => m.recipientId === "ana")!.kind).toBe("private_reply");
    expect(run(w, "ana").status).toBe("waiting");

    expect(await w.engine.onMessage(w.dm("ana", "sure, it's Ana@Example.com"))).toBe("resolved");
    expect(w.platform.dmsTo("ana").at(-1)).toBe("Thanks! Here is the pricing for Classic Tee: https://shop.example.com/tee");
    expect(run(w, "ana").status).toBe("completed");
    expect(w.store.getContact(ACCOUNT, "ana").email).toBe("ana@example.com");
  });
});

describe("decision 1: fixed flow when deterministic, follow-up only when ambiguous", () => {
  it("asks which product when the post shows several, and accepts a number", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("bea", "how much?", POST_MULTI));
    expect(w.platform.dmsTo("bea")).toEqual([
      "Thanks for asking! Which product would you like pricing for? Reply with a number:\n1. Classic Tee\n2. Hoodie\n3. Cap",
    ]);

    expect(await w.engine.onMessage(w.dm("bea", "2"))).toBe("resolved");
    expect(w.platform.dmsTo("bea").at(-1)).toBe("Happy to help with Hoodie! What's the best email to send the pricing to?");

    await w.engine.onMessage(w.dm("bea", "bea@example.com"));
    expect(w.platform.dmsTo("bea").at(-1)).toBe("Thanks! Here is the pricing for Hoodie: https://shop.example.com/hoodie");
  });

  it("accepts the product by name or alias", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("cal", "price?", POST_MULTI));
    expect(await w.engine.onMessage(w.dm("cal", "the gorra please"))).toBe("resolved");
    expect(run(w, "cal").context.productId).toBe("p_cap");
  });

  it("skips the product question when the comment already names the product", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("dan", "how much is the hoodie?", POST_MULTI));
    expect(w.platform.dmsTo("dan")).toEqual(["Happy to help with Hoodie! What's the best email to send the pricing to?"]);
  });

  it("re-asks with the options when the product reply is unclear", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("eve", "pricing", POST_MULTI));
    expect(await w.engine.onMessage(w.dm("eve", "the blue one"))).toBe("reasked");
    expect(w.platform.dmsTo("eve").at(-1)).toBe(
      "Sorry, I didn't catch that. Reply with the number of the product:\n1. Classic Tee\n2. Hoodie\n3. Cap",
    );
  });

  it("skips asking for contact info the business already has", async () => {
    const w = createWorld();
    // Fay completes the pricing flow, so her email is on file.
    await w.engine.onComment(w.comment("fay", "pricing"));
    await w.engine.onMessage(w.dm("fay", "fay@example.com"));

    w.engine.lifecycle.createAutomation({
      id: "auto_restock",
      socialAccountId: ACCOUNT,
      campaignId: "camp_fall",
      name: "Restock alert",
      definition: {
        trigger: { type: "comment_intent", intent: "restock", description: "Wants a restock alert", examples: ["restock"], minConfidence: 0.7 },
        steps: [
          { id: "contact", type: "ask_contact", prompt: "Where should we alert you?", invalidPrompt: "Email or phone?", spamPrompt: "Valid email or phone, please.", accept: ["email", "phone"] },
          { id: "done", type: "send_dm", text: "You're on the restock list!" },
        ],
      },
    });
    await w.engine.onComment(w.comment("fay", "restock?"));
    expect(w.platform.dmsTo("fay").at(-1)).toBe("You're on the restock list!");
    expect(w.platform.dmsTo("fay")).not.toContain("Where should we alert you?");
  });
});

describe("decision 2: match on intent, not keywords", () => {
  it.each([
    ["¿Cuánto cuesta?", "es"],
    ["Combien ça coûte ?", "fr"],
    ["What would this set me back?", "paraphrase"],
  ])("starts the flow for %s (%s)", async (text) => {
    const w = createWorld();
    expect(await w.engine.onComment(w.comment("gus", text))).toBe("started");
  });

  it("does nothing when the classifier is not confident", async () => {
    const w = createWorld();
    expect(await w.engine.onComment(w.comment("hal", "This is so expensive lol"))).toBe("no_match");
    expect(w.platform.sent).toHaveLength(0);
  });

  it("does nothing for unrelated comments", async () => {
    const w = createWorld();
    expect(await w.engine.onComment(w.comment("ivy", "love this color"))).toBe("no_match");
  });

  it("uses the product the LLM found in a foreign-language comment", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("jon", "¿Cuánto cuesta la sudadera?", POST_MULTI));
    expect(w.platform.dmsTo("jon")).toEqual(["Happy to help with Hoodie! What's the best email to send the pricing to?"]);
  });

  it("caches classifications, so a viral comment costs one LLM call", async () => {
    const w = createWorld();
    for (const f of ["k1", "k2", "k3"]) await w.engine.onComment(w.comment(f, "¿Cuánto cuesta?"));
    expect(w.llm.calls).toBe(1);
    expect(w.store.listRunsForFollower(ACCOUNT, "k3")).toHaveLength(1);
  });

  it("never calls the LLM when an example phrase already matches", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("lou", "PRICE??"));
    expect(w.llm.calls).toBe(0);
  });
});

describe("decision 6: email first, phone as fallback, generic response to spam", () => {
  it("accepts a phone number when no email is given", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("max", "pricing"));
    expect(await w.engine.onMessage(w.dm("max", "call me at +1 (415) 555-0132"))).toBe("resolved");
    expect(run(w, "max").context.phone).toBe("+14155550132");
    expect(w.platform.dmsTo("max").at(-1)).toContain("https://shop.example.com/tee");
  });

  it("re-asks on an invalid reply", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("ned", "pricing"));
    expect(await w.engine.onMessage(w.dm("ned", "why do you need it?"))).toBe("reasked");
    expect(w.platform.dmsTo("ned").at(-1)).toBe(
      "That doesn't look like an email. Please send your email address, or a phone number if you prefer.",
    );
  });

  it("answers a spammer once per cooldown with a generic response, then still accepts valid info", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("oz", "pricing"));
    const outcomes = [];
    for (const junk of ["asdf", "lol", "spam spam", "more spam"]) outcomes.push(await w.engine.onMessage(w.dm("oz", junk)));
    expect(outcomes).toEqual(["reasked", "reasked", "spam_response", "spam_ignored"]);
    expect(w.platform.dmsTo("oz").filter((t) => t.startsWith("To continue"))).toHaveLength(1);

    w.clock.advance(11 * 60_000);
    expect(await w.engine.onMessage(w.dm("oz", "zzz"))).toBe("spam_response");

    expect(await w.engine.onMessage(w.dm("oz", "ok fine: oz@example.com"))).toBe("resolved");
    expect(run(w, "oz").status).toBe("completed");
  });

  it("treats a burst of messages as spam even before the invalid-reply limit", async () => {
    const w = createWorld({ config: { maxInvalidBeforeSpam: 100 } });
    await w.engine.onComment(w.comment("pat", "pricing"));
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push(await w.engine.onMessage(w.dm("pat", `junk ${i}`)));
    expect(outcomes.slice(0, 5)).toEqual(Array(5).fill("reasked"));
    expect(outcomes[5]).toBe("spam_response");
  });
});

describe("decision 8: each follower gets the flow once", () => {
  it("drops a duplicate webhook delivery", async () => {
    const w = createWorld();
    const c = w.comment("quin", "pricing");
    expect(await w.engine.onComment(c)).toBe("started");
    expect(await w.engine.onComment({ ...c })).toBe("duplicate_event");
    expect(w.platform.commentRepliesTo(c.commentId)).toHaveLength(1);
  });

  it("does not start a second run when the same follower comments again", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("rae", "pricing"));
    await w.engine.onMessage(w.dm("rae", "rae@example.com"));
    const before = w.platform.sent.length;
    expect(await w.engine.onComment(w.comment("rae", "pricing again pls", POST_MULTI))).toBe("already_received");
    expect(w.platform.sent.length).toBe(before);
  });
});

describe("loop prevention", () => {
  it("ignores our own comment reply coming back as a webhook", async () => {
    const w = createWorld();
    expect(await w.engine.onComment(w.comment(BUSINESS_USER, "Sent you a DM!"))).toBe("own_comment");
  });

  it("ignores echoes of our own DMs", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("sam", "pricing"));
    expect(await w.engine.onMessage(w.dm("sam", "sam@example.com", { isEcho: true }))).toBe("echo");
    expect(run(w, "sam").status).toBe("waiting");
  });

  it("leaves DMs that are not part of a flow to the business's inbox", async () => {
    const w = createWorld();
    expect(await w.engine.onMessage(w.dm("tia", "hi, do you ship to Canada?"))).toBe("no_wait");
    expect(w.platform.sent).toHaveLength(0);
  });

  it("triggers on any post of the account (post scoping is out of scope)", async () => {
    const w = createWorld();
    expect(await w.engine.onComment(w.comment("uma", "pricing", POST_SINGLE))).toBe("started");
    expect(await w.engine.onComment(w.comment("vic", "pricing", POST_MULTI))).toBe("started");
  });
});
