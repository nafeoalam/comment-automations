import type { Automation, CloseReason, Product, Run, Step, Wait } from "../domain/types";
import { UniqueViolation } from "../store/store";
import { newId } from "../util/ids";
import { renderTemplate } from "../util/text";
import type { EngineDeps } from "./context";

type StepOutcome = "next" | "wait" | "stop";

export interface StartRunInput {
  automation: Automation;
  socialAccountId: string;
  followerId: string;
  postId: string;
  commentId: string;
  triggerEventId: string;
  productId?: string;
  restartedFromRunId?: string;
}

/**
 * Interprets an automation's step list for one follower.
 *
 * Production mapping: each call to advance() is one job. Persisting the run
 * and enqueueing its next job happen in one database transaction
 * (transactional outbox), so a crash between steps never loses or repeats a
 * step. Here, persistence is the store and the "next job" is the loop.
 */
export class RunExecutor {
  constructor(private readonly d: EngineDeps) {}

  /** Starts a run unless this follower already had one for this automation. Returns null when deduplicated. */
  async startRun(input: StartRunInput): Promise<Run | null> {
    const now = this.d.clock.now();
    let run: Run = {
      id: newId("run"),
      automationId: input.automation.id,
      version: input.automation.currentVersion,
      socialAccountId: input.socialAccountId,
      followerId: input.followerId,
      postId: input.postId,
      commentId: input.commentId,
      triggerEventId: input.triggerEventId,
      status: "running",
      stepIndex: 0,
      context: { invalidAttempts: 0, productId: input.productId, restartedFromRunId: input.restartedFromRunId },
      rowVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      run = this.d.store.insertRun(run);
    } catch (err) {
      if (err instanceof UniqueViolation) return null; // "each follower gets the flow once"
      throw err;
    }
    return this.advance(run);
  }

  /** Called when a wait is resolved: move past the ask step and keep going. */
  async resume(run: Run): Promise<Run> {
    run.status = "running";
    run.stepIndex += 1;
    run.context.invalidAttempts = 0;
    run = this.save(run);
    return this.advance(run);
  }

  async advance(run: Run): Promise<Run> {
    const steps = this.stepsFor(run);
    while (run.status === "running" && run.stepIndex < steps.length) {
      const outcome = await this.execute(run, steps[run.stepIndex]!);
      if (outcome === "next") {
        run.stepIndex += 1;
        run = this.save(run);
      } else {
        if (outcome === "wait") run.status = "waiting";
        return this.save(run);
      }
    }
    if (run.status === "running") {
      run.status = "completed";
      run = this.save(run);
    }
    return run;
  }

  stepsFor(run: Run): Step[] {
    const v = this.d.store.getVersion(run.automationId, run.version);
    if (!v) throw new Error(`missing version ${run.automationId}@${run.version}`);
    return v.definition.steps;
  }

  private async execute(run: Run, step: Step): Promise<StepOutcome> {
    switch (step.type) {
      case "reply_to_comment": {
        // Keyed by comment, not by run, so a restarted run never replies to the same comment twice.
        const res = await this.d.dispatcher.send({
          key: `comment-reply:${run.commentId}`,
          kind: "comment_reply",
          socialAccountId: run.socialAccountId,
          recipientId: run.followerId,
          commentId: run.commentId,
          text: step.text,
          stillWanted: () => this.isActive(run.id),
        });
        // The public reply is a courtesy; the DM flow is the product. Its failure is logged in outbound_actions and the flow continues.
        void res;
        return "next";
      }

      case "ask_product": {
        if (run.context.productId) return "next"; // named in the comment, or chosen earlier
        const options = this.inStockProductsOnPost(run.postId);
        if (options.length === 1) {
          run.context.productId = options[0]!.id; // deterministic: nothing to ask
          return "next";
        }
        if (options.length === 0) {
          Object.assign(run, await this.closeRun(run, "sold_out", "immediate"));
          return "stop";
        }
        return this.ask(run, step, "product", options.map((p) => p.id), withOptions(step.prompt, options));
      }

      case "ask_contact": {
        const contact = this.d.store.getContact(run.socialAccountId, run.followerId);
        if (step.accept.includes("email") && contact.email) {
          run.context.email = contact.email; // already on file: don't ask again
          return "next";
        }
        if (step.accept.includes("phone") && contact.phone) {
          run.context.phone = contact.phone;
          return "next";
        }
        return this.ask(run, step, "contact", [], this.render(run, step.prompt));
      }

      case "send_dm": {
        const res = await this.d.dispatcher.send({
          key: `dm:${run.id}:${step.id}`,
          kind: "dm",
          socialAccountId: run.socialAccountId,
          recipientId: run.followerId,
          commentId: run.commentId,
          text: this.render(run, step.text),
          stillWanted: () => this.isActive(run.id),
        });
        if (res.status === "sent") return "next";
        run.status = "failed";
        run.failureReason = `send_dm ${step.id}: ${res.reason}`;
        return "stop";
      }
    }
  }

  /**
   * Arms the wait BEFORE sending the question. If the follower answers
   * instantly, their reply already finds a wait to resolve; there is no window
   * where a reply arrives and nothing is listening.
   */
  private async ask(run: Run, step: Step, kind: Wait["kind"], options: string[], text: string): Promise<StepOutcome> {
    const wait: Wait = {
      id: newId("wait"),
      runId: run.id,
      socialAccountId: run.socialAccountId,
      followerId: run.followerId,
      stepId: step.id,
      kind,
      options,
      status: "waiting",
      createdAt: this.d.clock.now(),
    };
    this.armWait(wait);

    const res = await this.d.dispatcher.send({
      key: `dm:${run.id}:${step.id}:prompt`,
      kind: "dm",
      socialAccountId: run.socialAccountId,
      recipientId: run.followerId,
      commentId: run.commentId,
      text,
      stillWanted: () => this.isActive(run.id),
    });
    if (res.status !== "sent") {
      this.d.store.closeWait(wait.id, "cancelled");
      run.status = "failed";
      run.failureReason = `ask ${step.id}: ${res.reason}`;
      return "stop";
    }
    return "wait";
  }

  /**
   * One active wait per follower, so an incoming DM routes to exactly one run.
   * If another automation is already waiting on this follower, the newest
   * question wins: the follower is answering the last thing we asked.
   */
  armWait(wait: Wait): void {
    try {
      this.d.store.armWait(wait);
    } catch (err) {
      if (!(err instanceof UniqueViolation)) throw err;
      const older = this.d.store.getActiveWait(wait.socialAccountId, wait.followerId)!;
      this.d.store.closeWait(older.id, "cancelled");
      const olderRun = this.d.store.getRun(older.runId);
      if (olderRun && olderRun.id !== wait.runId) {
        olderRun.status = "closed";
        olderRun.closeReason = "replaced_by_newer_flow";
        this.save(olderRun);
      }
      this.d.store.armWait(wait);
    }
  }

  /**
   * Ends a run because the campaign ended or the product sold out.
   * "lazy": tell the follower the next time they write (we stay inside the messaging window).
   * "immediate": try now (used when the follower just wrote to us); fall back to lazy.
   */
  async closeRun(run: Run, reason: CloseReason, when: "lazy" | "immediate"): Promise<Run> {
    const wait = this.d.store.getActiveWaitForRun(run.id);
    if (wait) this.d.store.closeWait(wait.id, "cancelled");
    run.status = "closed";
    run.closeReason = reason;
    const saved = this.save(run);

    const product = run.context.productId ? this.d.store.getProduct(run.context.productId) : undefined;
    const msgs = this.d.config.messages;
    const text =
      reason === "sold_out"
        ? renderTemplate(msgs.soldOut, { "product.name": product?.name ?? "this item" })
        : msgs.campaignEnded;
    await this.notify(run, text, reason, when);
    return saved;
  }

  /** Sends a system notice now, or stores it to deliver on the follower's next message. */
  async notify(run: Run, text: string, reason: CloseReason | "flow_updated", when: "lazy" | "immediate"): Promise<void> {
    const notice = {
      id: newId("notice"),
      socialAccountId: run.socialAccountId,
      followerId: run.followerId,
      text,
      reason,
      createdAt: this.d.clock.now(),
    };
    if (when === "immediate") {
      const res = await this.d.dispatcher.send({
        key: `notice:${run.id}:${reason}`,
        kind: "dm",
        socialAccountId: run.socialAccountId,
        recipientId: run.followerId,
        commentId: run.commentId,
        text,
      });
      if (res.status === "sent") return;
    }
    this.d.store.addNotice(notice);
  }

  /** Fills {{product.*}} placeholders from the run's chosen product. */
  render(run: Run, template: string): string {
    const product = run.context.productId ? this.d.store.getProduct(run.context.productId) : undefined;
    return renderTemplate(template, productVars(product));
  }

  inStockProductsOnPost(postId: string): Product[] {
    const post = this.d.store.getPost(postId);
    if (!post) return [];
    return post.productIds
      .map((id) => this.d.store.getProduct(id))
      .filter((p): p is Product => !!p && p.inStock);
  }

  isActive(runId: string): boolean {
    const r = this.d.store.getRun(runId);
    return !!r && (r.status === "running" || r.status === "waiting");
  }

  save(run: Run): Run {
    run.updatedAt = this.d.clock.now();
    return this.d.store.updateRun(run);
  }
}

export function withOptions(prompt: string, options: Product[]): string {
  return [prompt, ...options.map((p, i) => `${i + 1}. ${p.name}`)].join("\n");
}

export function productVars(product?: Product): Record<string, string | undefined> {
  return { "product.name": product?.name, "product.link": product?.link };
}
