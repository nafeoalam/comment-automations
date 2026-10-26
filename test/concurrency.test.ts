import { describe, expect, it } from "vitest";
import { ACCOUNT, AUTOMATION, CAMPAIGN, createWorld } from "../src/fixtures";
import { ConcurrencyError, UniqueViolation } from "../src/store/store";

describe("per-follower ordering", () => {
  it("a reply sent the instant after the comment still finds the wait", async () => {
    const w = createWorld();
    // Fired together, without awaiting the comment first.
    const [commentOutcome, dmOutcome] = await Promise.all([
      w.engine.onComment(w.comment("ana", "pricing")),
      w.engine.onMessage(w.dm("ana", "ana@example.com")),
    ]);
    expect(commentOutcome).toBe("started");
    expect(dmOutcome).toBe("resolved");
    expect(w.platform.dmsTo("ana").at(-1)).toContain("https://shop.example.com/tee");
  });

  it("two valid answers sent at once complete the flow exactly once", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("bea", "pricing"));
    const outcomes = await Promise.all([
      w.engine.onMessage(w.dm("bea", "bea@example.com")),
      w.engine.onMessage(w.dm("bea", "bea.work@example.com")),
    ]);
    expect(outcomes).toEqual(["resolved", "no_wait"]);
    expect(w.platform.dmsTo("bea").filter((t) => t.includes("https://"))).toHaveLength(1);
  });

  it("a reply racing a campaign end either completes or closes the run, never both", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("cal", "pricing"));
    await Promise.all([w.engine.lifecycle.endCampaign(CAMPAIGN), w.engine.onMessage(w.dm("cal", "cal@example.com"))]);
    const run = w.store.listRunsForFollower(ACCOUNT, "cal")[0]!;
    const gotLink = w.platform.dmsTo("cal").some((t) => t.includes("https://"));
    expect(run.status === "completed" ? gotLink : !gotLink && run.status === "closed").toBe(true);
  });

  it("many followers commenting at once each get exactly one reply and one DM", async () => {
    const w = createWorld();
    const followers = Array.from({ length: 50 }, (_, i) => `f${i}`);
    const events = followers.map((f) => w.comment(f, "pricing"));
    // Every webhook delivered twice, concurrently.
    await Promise.all([...events, ...events].map((e) => w.engine.onComment(e)));
    for (const e of events) {
      expect(w.platform.commentRepliesTo(e.commentId)).toHaveLength(1);
      expect(w.platform.dmsTo(e.authorId)).toHaveLength(1);
    }
    expect(w.store.listRunsByAutomation(AUTOMATION)).toHaveLength(50);
  });
});

describe("store constraints", () => {
  it("rejects a stale write (optimistic locking)", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("dan", "pricing"));
    const id = w.store.listRunsForFollower(ACCOUNT, "dan")[0]!.id;
    const a = w.store.getRun(id)!;
    const b = w.store.getRun(id)!;
    w.store.updateRun({ ...a, status: "completed" });
    expect(() => w.store.updateRun({ ...b, status: "failed" })).toThrow(ConcurrencyError);
  });

  it("closing a wait is a conditional update that only one caller wins", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("eve", "pricing"));
    const wait = w.store.getActiveWait(ACCOUNT, "eve")!;
    expect(w.store.closeWait(wait.id, "resolved")).toBe(true);
    expect(w.store.closeWait(wait.id, "cancelled")).toBe(false);
  });

  it("allows one run per follower per automation", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("fay", "pricing"));
    const existing = w.store.listRunsForFollower(ACCOUNT, "fay")[0]!;
    expect(() => w.store.insertRun({ ...existing, id: "run_dup", triggerEventId: "evt_other" })).toThrow(UniqueViolation);
  });

  it("allows one active wait per follower; a newer flow's question replaces the older one", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("gus", "pricing"));
    w.engine.lifecycle.createAutomation({
      id: "auto_size",
      socialAccountId: ACCOUNT,
      campaignId: CAMPAIGN,
      name: "Size help",
      definition: {
        trigger: { type: "comment_intent", intent: "sizing", description: "Asks about sizes", examples: ["size", "sizing"], minConfidence: 0.7 },
        steps: [
          { id: "contact", type: "ask_contact", prompt: "Send your email for the size guide.", invalidPrompt: "Email?", spamPrompt: "Valid email please.", accept: ["email"] },
          { id: "guide", type: "send_dm", text: "Size guide: https://shop.example.com/sizes" },
        ],
      },
    });
    await w.engine.onMessage(w.dm("gus", "hello")); // opens the window so the second flow can DM
    await w.engine.onComment(w.comment("gus", "what size should I get?"));

    const runs = w.store.listRunsForFollower(ACCOUNT, "gus");
    expect(runs.find((r) => r.automationId === AUTOMATION)!.closeReason).toBe("replaced_by_newer_flow");
    await w.engine.onMessage(w.dm("gus", "gus@example.com"));
    expect(w.platform.dmsTo("gus").at(-1)).toBe("Size guide: https://shop.example.com/sizes");
  });
});
