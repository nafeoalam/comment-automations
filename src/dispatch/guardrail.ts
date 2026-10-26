import type { OutboundAction } from "../domain/types";
import type { PlatformAdapter } from "../platform/platform";
import type { Store } from "../store/store";
import { DAY, type Clock } from "../util/clock";

export interface SendRequest {
  /** Idempotency key. The same logical message always gets the same key. */
  key: string;
  kind: "comment_reply" | "dm";
  socialAccountId: string;
  recipientId: string;
  /** Required for comment replies. For DMs, it allows a private reply when the window is closed. */
  commentId?: string;
  text: string;
  /** Returns false if the run that asked for this message is no longer active. */
  stillWanted?: () => boolean;
}

export type GuardrailVerdict =
  | { verdict: "send"; channel: "comment_reply" | "private_reply" | "dm" }
  | { verdict: "already_delivered" }
  | { verdict: "blocked"; reason: string };

export const MESSAGING_WINDOW_MS = DAY;
const MAX_LENGTH = 1000;

/**
 * Runs before EVERY send attempt, including retries. It answers three questions:
 *  1. Is the message itself correct? (content checks)
 *  2. Has it already been delivered? (so a retry never double-sends)
 *  3. Are we still allowed to send it? (run still active, platform window open)
 */
export class SendGuardrail {
  constructor(
    private readonly store: Store,
    private readonly platform: PlatformAdapter,
    private readonly clock: Clock,
  ) {}

  async check(req: SendRequest, record: OutboundAction): Promise<GuardrailVerdict> {
    const contentProblem = this.checkContent(req);
    if (contentProblem) return { verdict: "blocked", reason: contentProblem };

    if (await this.alreadyDelivered(req, record)) return { verdict: "already_delivered" };

    if (req.stillWanted && !req.stillWanted()) return { verdict: "blocked", reason: "run_no_longer_active" };

    if (req.kind === "comment_reply") return { verdict: "send", channel: "comment_reply" };
    return this.chooseDmChannel(req);
  }

  private checkContent(req: SendRequest): string | undefined {
    const text = req.text.trim();
    if (!text) return "empty_message";
    if (text.length > MAX_LENGTH) return "message_too_long";
    if (/\{\{.*?\}\}/.test(text)) return "unfilled_template_slot";
    if (req.kind === "comment_reply" && !req.commentId) return "missing_comment_id";

    const account = this.store.getAccount(req.socialAccountId);
    if (!account) return "unknown_account";
    if (req.recipientId === account.platformUserId) return "recipient_is_self";
    for (const url of text.match(/https?:\/\/[^\s)]+/g) ?? []) {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return "malformed_link";
      }
      const allowed = account.allowedLinkDomains.some((d) => host === d || host.endsWith(`.${d}`));
      if (!allowed) return `link_not_allowed:${host}`;
    }
    return undefined;
  }

  /**
   * "sent" in our log is authoritative. "unknown" means an earlier attempt
   * ended ambiguously or the worker crashed mid-call, so we ask the platform
   * whether that exact text reached that recipient after the first attempt.
   */
  private async alreadyDelivered(req: SendRequest, record: OutboundAction): Promise<boolean> {
    if (record.status === "sent") return true;
    if (record.status !== "unknown" || !record.firstAttemptAt) return false;
    const recent = await this.platform.listSentSince({
      socialAccountId: req.socialAccountId,
      ...(req.kind === "comment_reply" ? { commentId: req.commentId } : { recipientId: req.recipientId }),
      since: record.firstAttemptAt,
    });
    return recent.some((m) => m.text === req.text);
  }

  /** Normal DM inside the messaging window, else a one-time private reply to their comment, else blocked. */
  private chooseDmChannel(req: SendRequest): GuardrailVerdict {
    const contact = this.store.getContact(req.socialAccountId, req.recipientId);
    const now = this.clock.now().getTime();
    if (contact.lastInboundAt && now - contact.lastInboundAt.getTime() < MESSAGING_WINDOW_MS) {
      return { verdict: "send", channel: "dm" };
    }
    if (req.commentId) {
      const used = this.store
        .listOutbound()
        .some((a) => a.channel === "private_reply" && a.commentId === req.commentId && a.key !== req.key && a.status === "sent");
      if (!used) return { verdict: "send", channel: "private_reply" };
    }
    return { verdict: "blocked", reason: "messaging_window_closed" };
  }
}
