import type { Clock } from "../util/clock";
import { newId } from "../util/ids";

/**
 * - ambiguous: timeout or 5xx after the request left us. It may or may not have been delivered.
 * - rate_limited: 429. Not delivered; retry later.
 * - rejected: 4xx such as an invalid recipient or a closed messaging window. Not delivered; do not retry.
 */
export type PlatformErrorKind = "ambiguous" | "rate_limited" | "rejected";

export class PlatformError extends Error {
  constructor(public readonly kind: PlatformErrorKind, message: string) {
    super(message);
  }
}

export interface SentMessage {
  id: string;
  socialAccountId: string;
  kind: "comment_reply" | "private_reply" | "dm";
  recipientId?: string;
  commentId?: string;
  text: string;
  at: Date;
}

/**
 * The existing integration layer, which the brief says we can assume. The
 * only addition is listSentSince. It reads back recent messages from the
 * conversation or comment thread, which the platform APIs expose. The send
 * guardrail uses it to confirm whether an ambiguous send was really delivered.
 */
export interface PlatformAdapter {
  replyToComment(input: { socialAccountId: string; commentId: string; text: string }): Promise<{ id: string }>;
  /** The first DM to a commenter, tied to their comment (Instagram "private reply"). Allowed once per comment. */
  sendPrivateReply(input: {
    socialAccountId: string;
    commentId: string;
    recipientId: string;
    text: string;
  }): Promise<{ id: string }>;
  /** A normal DM. Only allowed inside the messaging window (24h after the follower's last message). */
  sendDm(input: { socialAccountId: string; recipientId: string; text: string }): Promise<{ id: string }>;
  listSentSince(input: {
    socialAccountId: string;
    recipientId?: string;
    commentId?: string;
    since: Date;
  }): Promise<SentMessage[]>;
}

export type FailureMode =
  | "ok" // succeed normally (lets a test target the Nth call)
  | "ambiguous_after_delivery" // the message was delivered, but we saw a timeout
  | "ambiguous_before_delivery" // the request never landed, and we saw a timeout
  | "rate_limited"
  | "rejected";

/** In-memory platform with failure injection, for tests and the demo. */
export class FakePlatform implements PlatformAdapter {
  readonly sent: SentMessage[] = [];
  private failures: FailureMode[] = [];
  private privateReplied = new Set<string>();

  constructor(private readonly clock: Clock, private readonly onSend?: (m: SentMessage) => void) {}

  /** Makes the next N platform calls fail with these modes, in order. */
  failNext(...modes: FailureMode[]): void {
    this.failures.push(...modes);
  }

  async replyToComment(input: { socialAccountId: string; commentId: string; text: string }) {
    return this.deliver({ kind: "comment_reply", socialAccountId: input.socialAccountId, commentId: input.commentId, text: input.text });
  }

  async sendPrivateReply(input: { socialAccountId: string; commentId: string; recipientId: string; text: string }) {
    if (this.privateReplied.has(input.commentId)) {
      throw new PlatformError("rejected", "private reply already sent for this comment");
    }
    const res = await this.deliver({
      kind: "private_reply",
      socialAccountId: input.socialAccountId,
      commentId: input.commentId,
      recipientId: input.recipientId,
      text: input.text,
    });
    this.privateReplied.add(input.commentId);
    return res;
  }

  async sendDm(input: { socialAccountId: string; recipientId: string; text: string }) {
    return this.deliver({ kind: "dm", socialAccountId: input.socialAccountId, recipientId: input.recipientId, text: input.text });
  }

  async listSentSince(input: { socialAccountId: string; recipientId?: string; commentId?: string; since: Date }) {
    return this.sent.filter(
      (m) =>
        m.socialAccountId === input.socialAccountId &&
        m.at.getTime() >= input.since.getTime() &&
        (input.recipientId === undefined || m.recipientId === input.recipientId) &&
        (input.commentId === undefined || m.commentId === input.commentId),
    );
  }

  /** Messages a given follower received by DM, in order. */
  dmsTo(recipientId: string): string[] {
    return this.sent.filter((m) => m.recipientId === recipientId).map((m) => m.text);
  }

  commentRepliesTo(commentId: string): string[] {
    return this.sent.filter((m) => m.kind === "comment_reply" && m.commentId === commentId).map((m) => m.text);
  }

  private async deliver(m: Omit<SentMessage, "id" | "at">): Promise<{ id: string }> {
    const failure = this.failures.shift();
    if (failure === "rate_limited") throw new PlatformError("rate_limited", "429 too many requests");
    if (failure === "rejected") throw new PlatformError("rejected", "400 bad request");
    if (failure === "ambiguous_before_delivery") throw new PlatformError("ambiguous", "request timed out");
    const msg: SentMessage = { ...m, id: newId("msg"), at: this.clock.now() };
    this.sent.push(msg);
    this.onSend?.(msg);
    if (failure === "ambiguous_after_delivery") throw new PlatformError("ambiguous", "request timed out");
    return { id: msg.id };
  }
}
