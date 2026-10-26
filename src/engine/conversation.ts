import type { Contact, MessageEvent, Product, Run, Step, Wait } from "../domain/types";
import { findProductMention } from "../intent/classifier";
import { newId } from "../util/ids";
import { extractEmail, extractPhone, normalize, renderTemplate } from "../util/text";
import type { EngineDeps } from "./context";
import { withOptions, type RunExecutor } from "./executor";

export type MessageOutcome =
  | "duplicate_event"
  | "echo"
  | "restarted"
  | "no_wait"
  | "stale_wait"
  | "resolved"
  | "reasked"
  | "spam_response"
  | "spam_ignored"
  | "sold_out";

/** Routes a follower's DM to the run that is waiting on them, and resumes it. */
export class ConversationRouter {
  constructor(private readonly d: EngineDeps, private readonly executor: RunExecutor) {}

  async handleMessage(e: MessageEvent): Promise<MessageOutcome> {
    if (!this.d.store.recordInboundEvent(e.eventId)) return "duplicate_event";
    const account = this.d.store.getAccount(e.socialAccountId);
    if (!account || e.isEcho || e.senderId === account.platformUserId) return "echo";

    const now = this.d.clock.now();
    const contact = this.d.store.getContact(e.socialAccountId, e.senderId);
    contact.lastInboundAt = now; // their message opens the platform messaging window
    contact.recentInbound = [...contact.recentInbound, now].filter(
      (t) => now.getTime() - t.getTime() <= this.d.config.burstWindowMs,
    );
    this.d.store.saveContact(contact);

    // Deliver anything we owed them while the window was closed (campaign ended, sold out, flow updated).
    for (const n of this.d.store.takeNotices(e.socialAccountId, e.senderId)) {
      const res = await this.d.dispatcher.send({
        key: `notice:${n.id}`,
        kind: "dm",
        socialAccountId: n.socialAccountId,
        recipientId: n.followerId,
        text: n.text,
      });
      if (res.status !== "sent") this.d.store.addNotice(n); // keep it for next time
    }

    if (this.isRestart(e.text)) {
      const restarted = await this.restart(e);
      if (restarted) return "restarted";
    }

    const wait = this.d.store.getActiveWait(e.socialAccountId, e.senderId);
    if (!wait) return "no_wait"; // not part of an automation; left for the business's inbox
    const run = this.d.store.getRun(wait.runId)!;
    const step = this.executor.stepsFor(run)[run.stepIndex]!;

    return wait.kind === "product"
      ? this.onProductReply(e, run, wait, step, contact)
      : this.onContactReply(e, run, wait, step, contact);
  }

  // ---------- product choice ----------

  private async onProductReply(e: MessageEvent, run: Run, wait: Wait, step: Step, contact: Contact): Promise<MessageOutcome> {
    if (step.type !== "ask_product") throw new Error(`wait ${wait.id} does not match step ${step.id}`);
    const offered = wait.options.map((id) => this.d.store.getProduct(id)).filter((p): p is Product => !!p);
    const chosen = parseChoice(e.text, offered);
    if (!chosen) return this.onInvalid(run, contact, withOptions(step.invalidPrompt, offered), step.spamPrompt);

    if (!chosen.inStock) {
      // It sold out between our question and their answer.
      const remaining = this.executor.inStockProductsOnPost(run.postId);
      if (remaining.length === 0) {
        await this.executor.closeRun(run, "sold_out", "immediate");
        return "sold_out";
      }
      this.d.store.closeWait(wait.id, "cancelled");
      const fresh: Wait = { ...wait, id: newId("wait"), options: remaining.map((p) => p.id), status: "waiting", createdAt: this.d.clock.now() };
      this.executor.armWait(fresh);
      const text = withOptions(renderTemplate(this.d.config.messages.soldOutPickAnother, { "product.name": chosen.name }), remaining);
      await this.d.dispatcher.send({ key: `dm:${run.id}:${step.id}:soldout:${chosen.id}`, kind: "dm", socialAccountId: run.socialAccountId, recipientId: run.followerId, text });
      return "reasked";
    }

    // Conditional update: if a campaign-end or version change already cancelled this wait, we lose and stop.
    if (!this.d.store.closeWait(wait.id, "resolved")) return "stale_wait";
    run.context.productId = chosen.id;
    await this.executor.resume(run);
    return "resolved";
  }

  // ---------- contact capture ----------

  private async onContactReply(e: MessageEvent, run: Run, wait: Wait, step: Step, contact: Contact): Promise<MessageOutcome> {
    if (step.type !== "ask_contact") throw new Error(`wait ${wait.id} does not match step ${step.id}`);
    const email = step.accept.includes("email") ? extractEmail(e.text) : undefined;
    const phone = !email && step.accept.includes("phone") ? extractPhone(e.text) : undefined; // phone is the fallback
    if (!email && !phone) {
      return this.onInvalid(run, contact, this.executor.render(run, step.invalidPrompt), this.executor.render(run, step.spamPrompt));
    }

    if (!this.d.store.closeWait(wait.id, "resolved")) return "stale_wait";
    if (email) run.context.email = contact.email = email;
    if (phone) run.context.phone = contact.phone = phone;
    this.d.store.saveContact(contact);
    await this.executor.resume(run);
    return "resolved";
  }

  // ---------- invalid replies and spam ----------

  /**
   * First invalid replies get a specific re-ask. A follower who keeps sending
   * junk, or sends a burst, is treated as spamming: they get ONE generic
   * "please send proper info" response per cooldown, and everything else is
   * ignored. The wait stays open, so a valid answer later still works.
   */
  private async onInvalid(run: Run, contact: Contact, reask: string, spamText: string): Promise<MessageOutcome> {
    const cfg = this.d.config;
    run.context.invalidAttempts += 1;
    run = this.executor.save(run);

    const burst = contact.recentInbound.length > cfg.burstLimit;
    const spamming = burst || run.context.invalidAttempts > cfg.maxInvalidBeforeSpam;
    const base = { kind: "dm" as const, socialAccountId: run.socialAccountId, recipientId: run.followerId };

    if (!spamming) {
      await this.d.dispatcher.send({ ...base, key: `dm:${run.id}:reask:${run.context.invalidAttempts}`, text: reask });
      return "reasked";
    }
    const now = this.d.clock.now();
    if (contact.lastSpamResponseAt && now.getTime() - contact.lastSpamResponseAt.getTime() < cfg.spamCooldownMs) {
      return "spam_ignored";
    }
    contact.lastSpamResponseAt = now;
    this.d.store.saveContact(contact);
    await this.d.dispatcher.send({ ...base, key: `dm:${run.id}:spam:${now.getTime()}`, text: spamText });
    return "spam_response";
  }

  // ---------- restart after the business updated the flow ----------

  private isRestart(text: string): boolean {
    const t = normalize(text);
    return this.d.config.restartWords.some((w) => t === normalize(w));
  }

  /** Starts a fresh run on the latest version for the follower's most recent superseded run. */
  private async restart(e: MessageEvent): Promise<boolean> {
    const old = this.d.store
      .listRunsForFollower(e.socialAccountId, e.senderId)
      .filter((r) => r.status === "superseded" && !r.supersededBy)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!old) return false;
    const automation = this.d.store.getAutomation(old.automationId);
    const campaign = automation && this.d.store.getCampaign(automation.campaignId);
    if (!automation || automation.status !== "active" || !campaign || campaign.status !== "active") return false;

    const fresh = await this.executor.startRun({
      automation,
      socialAccountId: old.socialAccountId,
      followerId: old.followerId,
      postId: old.postId,
      commentId: old.commentId,
      triggerEventId: e.eventId,
      // Keep the product they already chose if it is still valid; everything else is asked again under the new flow.
      productId: old.context.productId && this.d.store.getProduct(old.context.productId)?.inStock ? old.context.productId : undefined,
      restartedFromRunId: old.id,
    });
    if (!fresh) return false;
    old.supersededBy = fresh.id;
    this.executor.save(old);
    return true;
  }
}

/**
 * Accepts a number ("2", "option 2") or a product name or alias in the reply.
 * Ordinals like "the second one" are left to a future LLM tier.
 */
export function parseChoice(text: string, offered: Product[]): Product | undefined {
  const n = normalize(text);
  const num = n.match(/^(?:option |number |no )?(\d{1,2})$/);
  if (num) return offered[Number(num[1]) - 1];
  const id = findProductMention(text, offered);
  return id ? offered.find((p) => p.id === id) : undefined;
}
