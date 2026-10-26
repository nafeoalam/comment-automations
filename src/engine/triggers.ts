import type { Automation, AutomationVersion, CommentEvent, Product } from "../domain/types";
import type { IntentSpec } from "../intent/classifier";
import type { EngineDeps } from "./context";
import type { RunExecutor } from "./executor";

export type CommentOutcome =
  | "duplicate_event"
  | "own_comment"
  | "no_active_automation"
  | "no_match"
  | "already_received"
  | "started";

/** Decides whether a new comment starts an automation run. */
export class TriggerService {
  constructor(private readonly d: EngineDeps, private readonly executor: RunExecutor) {}

  async handleComment(e: CommentEvent): Promise<CommentOutcome> {
    // Webhooks are at-least-once. INSERT ... ON CONFLICT DO NOTHING on the platform event id.
    if (!this.d.store.recordInboundEvent(e.eventId)) return "duplicate_event";

    // Our own "Sent you a DM!" reply comes back as a comment webhook. Never trigger on it.
    const account = this.d.store.getAccount(e.socialAccountId);
    if (!account || e.authorId === account.platformUserId) return "own_comment";

    const now = this.d.clock.now();
    const live = this.d.store
      .listActiveAutomations(e.socialAccountId)
      .filter((a) => {
        const c = this.d.store.getCampaign(a.campaignId);
        return c && c.status === "active" && c.endsAt.getTime() > now.getTime();
      })
      .map((a) => ({ automation: a, version: this.d.store.getVersion(a.id, a.currentVersion)! }));
    if (live.length === 0) return "no_active_automation";

    // One classification call covers every intent this account listens for.
    const intents = uniqueIntents(live.map((l) => l.version));
    const products = this.productsOnPost(e.postId);
    const result = await this.d.classifier.classify({ text: e.text, intents, products });

    const matches = live
      .filter((l) => l.version.definition.trigger.intent === result.intent)
      .filter((l) => result.confidence >= l.version.definition.trigger.minConfidence)
      // If two automations listen for the same intent, the most recently published one wins.
      .sort((a, b) => b.version.publishedAt.getTime() - a.version.publishedAt.getTime());
    if (matches.length === 0) return "no_match";

    const productId = result.productId && products.some((p) => p.id === result.productId) ? result.productId : undefined;

    // At most one automation per comment: two flows DMing the same person at once reads as spam.
    for (const { automation } of matches) {
      const run = await this.startFor(automation, e, productId);
      if (run) return "started";
    }
    return "already_received";
  }

  private startFor(automation: Automation, e: CommentEvent, productId?: string) {
    return this.executor.startRun({
      automation,
      socialAccountId: e.socialAccountId,
      followerId: e.authorId,
      postId: e.postId,
      commentId: e.commentId,
      triggerEventId: e.eventId,
      productId,
    });
  }

  private productsOnPost(postId: string): Product[] {
    const post = this.d.store.getPost(postId);
    if (!post) return [];
    return post.productIds.map((id) => this.d.store.getProduct(id)).filter((p): p is Product => !!p);
  }
}

function uniqueIntents(versions: AutomationVersion[]): IntentSpec[] {
  const byKey = new Map<string, IntentSpec>();
  for (const v of versions) {
    const t = v.definition.trigger;
    const existing = byKey.get(t.intent);
    byKey.set(t.intent, {
      key: t.intent,
      description: existing?.description ?? t.description,
      examples: [...new Set([...(existing?.examples ?? []), ...t.examples])],
    });
  }
  return [...byKey.values()];
}
