import { describe, expect, it } from "vitest";
import { ACCOUNT, AUTOMATION, CAMPAIGN, createWorld, POST_MULTI, PRICING_FLOW } from "../src/fixtures";
import { DAY } from "../src/util/clock";
import { validateDefinition } from "../src/lifecycle/lifecycle";
import type { AutomationDefinition } from "../src/domain/types";

const runsOf = (w: ReturnType<typeof createWorld>, follower: string) =>
  w.store.listRunsForFollower(ACCOUNT, follower).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

const V2: AutomationDefinition = {
  ...PRICING_FLOW,
  steps: PRICING_FLOW.steps.map((s) =>
    s.id === "link" ? { ...s, text: "New prices are live! {{product.name}}: {{product.link}}" } : s,
  ),
};

describe("decision 4: when the business updates the flow, followers mid-flow are asked to restart", () => {
  it("asks right away when the messaging window is open, and RESTART starts the new version", async () => {
    const w = createWorld();
    const c = w.comment("ana", "pricing", POST_MULTI);
    await w.engine.onComment(c);
    await w.engine.onMessage(w.dm("ana", "1")); // picks the tee; her message opens the window

    const { version, superseded } = await w.engine.lifecycle.publishVersion(AUTOMATION, V2);
    expect(version).toBe(2);
    expect(superseded).toBe(1);
    expect(runsOf(w, "ana")[0]!.status).toBe("superseded");
    expect(w.platform.dmsTo("ana").at(-1)).toBe("We've updated this offer. Reply RESTART to start again with the latest version.");

    // A late answer to the old question does not continue the old flow.
    w.clock.advance(1000);
    expect(await w.engine.onMessage(w.dm("ana", "Restart"))).toBe("restarted");
    const [old, fresh] = runsOf(w, "ana");
    expect(old!.supersededBy).toBe(fresh!.id);
    expect(fresh!.version).toBe(2);
    expect(fresh!.context.productId).toBe("p_tee"); // still valid, so not asked again

    await w.engine.onMessage(w.dm("ana", "ana@example.com"));
    expect(w.platform.dmsTo("ana").at(-1)).toBe("New prices are live! Classic Tee: https://shop.example.com/tee");
    // The restarted run did not reply to her comment a second time.
    expect(w.platform.commentRepliesTo(c.commentId)).toHaveLength(1);
  });

  it("waits for the follower's next message when the window is closed", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("bea", "pricing")); // only a private reply so far; window closed
    const before = w.platform.dmsTo("bea").length;

    await w.engine.lifecycle.publishVersion(AUTOMATION, V2);
    expect(w.platform.dmsTo("bea")).toHaveLength(before);

    expect(await w.engine.onMessage(w.dm("bea", "bea@example.com"))).toBe("no_wait");
    expect(w.platform.dmsTo("bea").at(-1)).toBe("We've updated this offer. Reply RESTART to start again with the latest version.");
  });

  it("rejects an invalid definition at publish time", async () => {
    const w = createWorld();
    const bad: AutomationDefinition = { ...PRICING_FLOW, steps: [{ id: "x", type: "send_dm", text: "Price: {{product.link}}" }] };
    await expect(w.engine.lifecycle.publishVersion(AUTOMATION, bad)).rejects.toThrow(/needs an ask_product step/);
    expect(() => validateDefinition({ ...PRICING_FLOW, steps: [{ id: "x", type: "send_dm", text: "{{coupon}}" }] })).toThrow(/unknown placeholder/);
  });
});

describe("decision 7: a wait lasts until the campaign ends or the product sells out", () => {
  it("has no timer: a reply ten days later still completes the flow", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("cal", "pricing"));
    w.clock.advance(10 * DAY);
    expect(await w.engine.onMessage(w.dm("cal", "cal@example.com"))).toBe("resolved");
    expect(w.platform.dmsTo("cal").at(-1)).toContain("https://shop.example.com/tee");
  });

  it("closes waiting runs when the campaign ends and tells the follower on their next message", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("dan", "pricing"));
    const before = w.platform.sent.length;

    expect(await w.engine.lifecycle.endCampaign(CAMPAIGN)).toBe(1);
    expect(runsOf(w, "dan")[0]!.closeReason).toBe("campaign_ended");
    expect(w.platform.sent.length).toBe(before); // nothing pushed

    expect(await w.engine.onMessage(w.dm("dan", "dan@example.com"))).toBe("no_wait");
    expect(w.platform.dmsTo("dan").at(-1)).toBe("Thanks for your interest! This campaign has ended.");
    expect(await w.engine.onComment(w.comment("eve", "pricing"))).toBe("no_active_automation");
  });

  it("the scheduler ends the campaign at its end time", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("fay", "pricing"));
    await w.engine.lifecycle.sweepCampaigns([CAMPAIGN]);
    expect(runsOf(w, "fay")[0]!.status).toBe("waiting");
    w.clock.advance(31 * DAY);
    await w.engine.lifecycle.sweepCampaigns([CAMPAIGN]);
    expect(runsOf(w, "fay")[0]!.closeReason).toBe("campaign_ended");
  });

  it("closes runs that chose a product that sells out", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("gus", "pricing", POST_MULTI));
    await w.engine.onMessage(w.dm("gus", "2")); // hoodie

    expect(await w.engine.lifecycle.markSoldOut("p_hoodie")).toBe(1);
    expect(runsOf(w, "gus")[0]!.closeReason).toBe("sold_out");
    await w.engine.onMessage(w.dm("gus", "gus@example.com"));
    expect(w.platform.dmsTo("gus").at(-1)).toBe("Sorry, Hoodie just sold out.");
  });

  it("stops offering a sold-out product to followers who are still choosing", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("hal", "pricing", POST_MULTI));
    expect(await w.engine.lifecycle.markSoldOut("p_cap")).toBe(0);

    expect(await w.engine.onMessage(w.dm("hal", "3"))).toBe("reasked");
    expect(w.platform.dmsTo("hal").at(-1)).toBe("Sorry, Cap just sold out. Please pick another one:\n1. Classic Tee\n2. Hoodie");
    expect(await w.engine.onMessage(w.dm("hal", "1"))).toBe("resolved");
    expect(runsOf(w, "hal")[0]!.context.productId).toBe("p_tee");
  });

  it("closes a choosing follower's run when every option sells out", async () => {
    const w = createWorld();
    await w.engine.onComment(w.comment("ivy", "pricing", POST_MULTI));
    for (const p of ["p_tee", "p_hoodie", "p_cap"]) await w.engine.lifecycle.markSoldOut(p);
    expect(runsOf(w, "ivy")[0]!.closeReason).toBe("sold_out");
  });
});
