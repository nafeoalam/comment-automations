import type { OutboundAction } from "../domain/types";
import { PlatformError, type PlatformAdapter } from "../platform/platform";
import type { Store } from "../store/store";
import type { Clock } from "../util/clock";
import { SendGuardrail, type SendRequest } from "./guardrail";

export type SendOutcome =
  | { status: "sent"; deduplicated: boolean }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

export interface DispatcherOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Injectable so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The guarded send loop:
 *
 *   loop (bounded):
 *     guardrail confirms the message (content OK, not already delivered, still allowed)
 *     -> send
 *     -> success: record "sent", stop
 *     -> rejected (4xx): record "failed", stop
 *     -> rate limited: definitely not delivered, back off, loop
 *     -> ambiguous (timeout/5xx): record "unknown", back off, loop
 *        (the next guardrail pass asks the platform whether it arrived)
 *
 * The record is written as "unknown" BEFORE the platform call. If the worker
 * crashes mid-call, whoever retries the job sees "unknown" and reconciles
 * first instead of blindly resending.
 */
export class ActionDispatcher {
  private readonly guardrail: SendGuardrail;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly platform: PlatformAdapter,
    private readonly clock: Clock,
    opts: DispatcherOptions = {},
  ) {
    this.guardrail = new SendGuardrail(store, platform, clock);
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async send(req: SendRequest): Promise<SendOutcome> {
    const record: OutboundAction = this.store.getOutbound(req.key) ?? {
      key: req.key,
      kind: req.kind,
      socialAccountId: req.socialAccountId,
      recipientId: req.recipientId,
      commentId: req.commentId,
      text: req.text,
      status: "pending",
      attempts: 0,
    };
    if (record.status === "sent") return { status: "sent", deduplicated: true };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const verdict = await this.guardrail.check(req, record);
      if (verdict.verdict === "already_delivered") {
        record.status = "sent";
        this.store.saveOutbound(record);
        return { status: "sent", deduplicated: true };
      }
      if (verdict.verdict === "blocked") {
        record.status = "blocked";
        record.lastError = verdict.reason;
        this.store.saveOutbound(record);
        return { status: "blocked", reason: verdict.reason };
      }

      record.channel = verdict.channel;
      record.attempts += 1;
      record.firstAttemptAt ??= this.clock.now();
      record.status = "unknown"; // in flight: not yet known whether it lands
      this.store.saveOutbound(record);

      try {
        const res = await this.call(req, verdict.channel);
        record.status = "sent";
        record.platformMessageId = res.id;
        this.store.saveOutbound(record);
        return { status: "sent", deduplicated: false };
      } catch (err) {
        if (!(err instanceof PlatformError)) throw err;
        record.lastError = `${err.kind}: ${err.message}`;
        if (err.kind === "rejected") {
          record.status = "failed";
          this.store.saveOutbound(record);
          return { status: "failed", reason: record.lastError };
        }
        // rate_limited: the platform refused before delivering, so it is safe to resend.
        // ambiguous: leave as "unknown" so the guardrail reconciles before the next attempt.
        if (err.kind === "rate_limited") record.status = "pending";
        this.store.saveOutbound(record);
        await this.sleep(this.backoff(attempt));
      }
    }

    // Final reconciliation before giving up, so we never report "failed" for a message that actually arrived.
    const last = await this.guardrail.check(req, record);
    if (last.verdict === "already_delivered") {
      record.status = "sent";
      this.store.saveOutbound(record);
      return { status: "sent", deduplicated: true };
    }
    record.status = "failed";
    this.store.saveOutbound(record);
    return { status: "failed", reason: `max_attempts: ${record.lastError ?? "unknown"}` };
  }

  private call(req: SendRequest, channel: "comment_reply" | "private_reply" | "dm") {
    switch (channel) {
      case "comment_reply":
        return this.platform.replyToComment({ socialAccountId: req.socialAccountId, commentId: req.commentId!, text: req.text });
      case "private_reply":
        return this.platform.sendPrivateReply({
          socialAccountId: req.socialAccountId,
          commentId: req.commentId!,
          recipientId: req.recipientId,
          text: req.text,
        });
      case "dm":
        return this.platform.sendDm({ socialAccountId: req.socialAccountId, recipientId: req.recipientId, text: req.text });
    }
  }

  /** Exponential backoff with full jitter. */
  private backoff(attempt: number): number {
    return Math.random() * this.baseDelayMs * 2 ** (attempt - 1);
  }
}
