import { describe, expect, it } from "vitest";
import { ActionDispatcher } from "../src/dispatch/dispatcher";
import type { SendRequest } from "../src/dispatch/guardrail";
import { ACCOUNT, createWorld } from "../src/fixtures";

function setup() {
  const w = createWorld();
  const dispatcher = new ActionDispatcher(w.store, w.platform, w.clock, { sleep: async () => {} });
  const req = (over: Partial<SendRequest> = {}): SendRequest => ({
    key: "dm:test:1",
    kind: "dm",
    socialAccountId: ACCOUNT,
    recipientId: "ana",
    commentId: "cmt_ana",
    text: "Here is your link: https://shop.example.com/tee",
    ...over,
  });
  return { ...w, dispatcher, req };
}

describe("decision 9: the guardrail confirms every message before each send attempt", () => {
  it("does not resend when an ambiguous failure actually delivered the message", async () => {
    const s = setup();
    s.platform.failNext("ambiguous_after_delivery");
    expect(await s.dispatcher.send(s.req())).toEqual({ status: "sent", deduplicated: true });
    expect(s.platform.sent).toHaveLength(1);
    expect(s.store.getOutbound("dm:test:1")!.attempts).toBe(1);
  });

  it("resends once when an ambiguous failure did not deliver", async () => {
    const s = setup();
    s.platform.failNext("ambiguous_before_delivery");
    expect(await s.dispatcher.send(s.req())).toEqual({ status: "sent", deduplicated: false });
    expect(s.platform.sent).toHaveLength(1);
    expect(s.store.getOutbound("dm:test:1")!.attempts).toBe(2);
  });

  it("backs off and retries on rate limits", async () => {
    const s = setup();
    s.platform.failNext("rate_limited", "rate_limited");
    expect((await s.dispatcher.send(s.req())).status).toBe("sent");
    expect(s.store.getOutbound("dm:test:1")!.attempts).toBe(3);
  });

  it("does not retry a rejected request", async () => {
    const s = setup();
    s.platform.failNext("rejected");
    expect((await s.dispatcher.send(s.req())).status).toBe("failed");
    expect(s.store.getOutbound("dm:test:1")!.attempts).toBe(1);
  });

  it("gives up after the attempt limit and records the failure", async () => {
    const s = setup();
    s.platform.failNext("ambiguous_before_delivery", "ambiguous_before_delivery", "ambiguous_before_delivery", "ambiguous_before_delivery");
    const res = await s.dispatcher.send(s.req());
    expect(res.status).toBe("failed");
    expect(s.platform.sent).toHaveLength(0);
    expect(s.store.getOutbound("dm:test:1")!.status).toBe("failed");
  });

  it("recovers after a worker crash mid-send without double-sending", async () => {
    const s = setup();
    // Simulate a crash: the record says "unknown" and the platform did deliver it.
    await s.platform.sendPrivateReply({ socialAccountId: ACCOUNT, commentId: "cmt_ana", recipientId: "ana", text: s.req().text });
    s.store.saveOutbound({
      key: "dm:test:1", kind: "dm", socialAccountId: ACCOUNT, recipientId: "ana", commentId: "cmt_ana",
      text: s.req().text, status: "unknown", attempts: 1, firstAttemptAt: new Date(s.clock.now().getTime() - 1000), channel: "private_reply",
    });
    expect(await s.dispatcher.send(s.req())).toEqual({ status: "sent", deduplicated: true });
    expect(s.platform.sent).toHaveLength(1);
  });

  it("sends a given key only once", async () => {
    const s = setup();
    await s.dispatcher.send(s.req());
    expect(await s.dispatcher.send(s.req())).toEqual({ status: "sent", deduplicated: true });
    expect(s.platform.sent).toHaveLength(1);
  });

  it.each([
    [{ text: "Hi {{product.name}}" }, "unfilled_template_slot"],
    [{ text: "Pay here: https://evil.example.net/x" }, "link_not_allowed:evil.example.net"],
    [{ text: "   " }, "empty_message"],
    [{ recipientId: "ig_business" }, "recipient_is_self"],
  ])("blocks a bad message before it is sent: %o", async (over, reason) => {
    const s = setup();
    expect(await s.dispatcher.send(s.req(over))).toEqual({ status: "blocked", reason });
    expect(s.platform.sent).toHaveLength(0);
  });

  it("blocks a DM when the window is closed and the comment's private reply is used up", async () => {
    const s = setup();
    await s.dispatcher.send(s.req({ key: "first" })); // uses the private reply
    expect(await s.dispatcher.send(s.req({ key: "second", text: "another message" }))).toEqual({
      status: "blocked",
      reason: "messaging_window_closed",
    });
  });

  it("blocks a message whose run is no longer active", async () => {
    const s = setup();
    expect(await s.dispatcher.send(s.req({ stillWanted: () => false }))).toEqual({ status: "blocked", reason: "run_no_longer_active" });
  });

  it("end to end: a timeout on the first DM still gives the follower exactly one question", async () => {
    const w = createWorld();
    w.platform.failNext("ok", "ambiguous_after_delivery"); // comment reply OK, then the DM times out after delivery
    await w.engine.onComment(w.comment("zed", "pricing"));
    expect(w.platform.dmsTo("zed")).toHaveLength(1);
    expect(w.store.listRunsForFollower(ACCOUNT, "zed")[0]!.status).toBe("waiting");
  });
});
