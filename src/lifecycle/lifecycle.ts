import type { Automation, AutomationDefinition, Run } from "../domain/types";
import type { EngineDeps } from "../engine/context";
import type { RunExecutor } from "../engine/executor";
import { followerKey } from "../util/keyed-queue";

export class InvalidDefinition extends Error {}

/** Rejects definitions the engine could not run correctly, at publish time rather than mid-flow. */
export function validateDefinition(def: AutomationDefinition): void {
  const t = def.trigger;
  if (!t.intent.trim()) throw new InvalidDefinition("trigger.intent is required");
  if (!(t.minConfidence > 0 && t.minConfidence <= 1)) throw new InvalidDefinition("trigger.minConfidence must be in (0, 1]");
  if (def.steps.length === 0) throw new InvalidDefinition("at least one step is required");

  const ids = new Set<string>();
  let askedProduct = false;
  for (const step of def.steps) {
    if (ids.has(step.id)) throw new InvalidDefinition(`duplicate step id ${step.id}`);
    ids.add(step.id);
    if (step.type === "ask_product") askedProduct = true;
    if (step.type === "ask_contact" && step.accept.length === 0) {
      throw new InvalidDefinition(`${step.id}: accept must list email and/or phone`);
    }
    const texts = Object.values(step).filter((v): v is string => typeof v === "string");
    for (const text of texts) {
      for (const [, slot] of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
        if (slot !== "product.name" && slot !== "product.link") throw new InvalidDefinition(`${step.id}: unknown placeholder {{${slot}}}`);
        if (!askedProduct) throw new InvalidDefinition(`${step.id}: {{${slot}}} needs an ask_product step before it`);
      }
    }
  }
}

/**
 * Business-side changes that affect runs already in flight. Every per-run
 * change goes through the follower's serial queue, so it never races with
 * that follower's own DMs.
 */
export class Lifecycle {
  constructor(private readonly d: EngineDeps, private readonly executor: RunExecutor) {}

  createAutomation(input: { id: string; socialAccountId: string; campaignId: string; name: string; definition: AutomationDefinition }): Automation {
    validateDefinition(input.definition);
    const automation: Automation = {
      id: input.id,
      socialAccountId: input.socialAccountId,
      campaignId: input.campaignId,
      name: input.name,
      status: "active",
      currentVersion: 1,
    };
    this.d.store.insertVersion({ automationId: input.id, version: 1, definition: input.definition, publishedAt: this.d.clock.now() });
    this.d.store.putAutomation(automation);
    return automation;
  }

  /**
   * Publishes a new immutable version. Followers mid-flow on an older version
   * are asked to restart, so nobody finishes a flow the business has replaced.
   */
  async publishVersion(automationId: string, definition: AutomationDefinition): Promise<{ version: number; superseded: number }> {
    validateDefinition(definition);
    const automation = this.d.store.getAutomation(automationId);
    if (!automation) throw new Error(`automation ${automationId} not found`);
    const version = automation.currentVersion + 1;
    this.d.store.insertVersion({ automationId, version, definition, publishedAt: this.d.clock.now() });
    automation.currentVersion = version;
    this.d.store.putAutomation(automation);

    const stale = this.d.store
      .listRunsByAutomation(automationId)
      .filter((r) => (r.status === "running" || r.status === "waiting") && r.version < version);
    await Promise.all(
      stale.map((r) =>
        this.onFollower(r, async (run) => {
          if (run.version >= version || !this.executor.isActive(run.id)) return;
          const wait = this.d.store.getActiveWaitForRun(run.id);
          if (wait) this.d.store.closeWait(wait.id, "cancelled");
          run.status = "superseded";
          const saved = this.executor.save(run);
          // Ask now if the messaging window is open; otherwise on their next message.
          await this.executor.notify(saved, this.d.config.messages.flowUpdated, "flow_updated", "immediate");
        }),
      ),
    );
    return { version, superseded: stale.length };
  }

  /** Closes every open run in the campaign. Followers are told on their next message. */
  async endCampaign(campaignId: string): Promise<number> {
    const campaign = this.d.store.getCampaign(campaignId);
    if (!campaign) throw new Error(`campaign ${campaignId} not found`);
    campaign.status = "ended";
    this.d.store.putCampaign(campaign);

    let closed = 0;
    for (const automation of this.d.store.listAutomationsByCampaign(campaignId)) {
      automation.status = "paused";
      this.d.store.putAutomation(automation);
      const open = this.d.store.listRunsByAutomation(automation.id).filter((r) => r.status === "running" || r.status === "waiting");
      await Promise.all(
        open.map((r) =>
          this.onFollower(r, async (run) => {
            if (!this.executor.isActive(run.id)) return;
            await this.executor.closeRun(run, "campaign_ended", "lazy");
            closed += 1;
          }),
        ),
      );
    }
    return closed;
  }

  /** Scheduler tick: ends campaigns whose end time has passed. In production, a job scheduled at endsAt does this. */
  async sweepCampaigns(campaignIds: string[]): Promise<void> {
    const now = this.d.clock.now().getTime();
    for (const id of campaignIds) {
      const c = this.d.store.getCampaign(id);
      if (c && c.status === "active" && c.endsAt.getTime() <= now) await this.endCampaign(id);
    }
  }

  /**
   * Marks a product sold out. Runs that already chose it are closed (told on
   * their next message). Runs still choosing just stop offering it; if every
   * option on their post is gone, they are closed too.
   */
  async markSoldOut(productId: string): Promise<number> {
    const product = this.d.store.getProduct(productId);
    if (!product) throw new Error(`product ${productId} not found`);
    product.inStock = false;
    this.d.store.putProduct(product);

    const affected = this.d.store.listActiveRuns().filter((r) => {
      if (r.context.productId === productId) return true;
      const wait = this.d.store.getActiveWaitForRun(r.id);
      return wait?.kind === "product" && wait.options.includes(productId) && this.executor.inStockProductsOnPost(r.postId).length === 0;
    });
    let closed = 0;
    await Promise.all(
      affected.map((r) =>
        this.onFollower(r, async (run) => {
          if (!this.executor.isActive(run.id)) return;
          await this.executor.closeRun(run, "sold_out", "lazy");
          closed += 1;
        }),
      ),
    );
    return closed;
  }

  /** Runs `fn` on a freshly loaded copy of the run, inside that follower's serial queue. */
  private onFollower(r: Run, fn: (run: Run) => Promise<void>): Promise<void> {
    return this.d.queue.run(followerKey(r.socialAccountId, r.followerId), async () => {
      const fresh = this.d.store.getRun(r.id);
      if (fresh) await fn(fresh);
    });
  }
}
