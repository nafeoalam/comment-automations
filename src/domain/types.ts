// Domain model for comment-triggered automations.
// Vocabulary: the BUSINESS owns social accounts and automations; a FOLLOWER is
// the person who comments and receives DMs.

// ---------- Catalog (owned by the business, read by the engine) ----------

export interface Product {
  id: string;
  name: string;
  /** Other names followers may use for this product, in any language. */
  aliases: string[];
  link: string;
  inStock: boolean;
}

export interface Post {
  id: string;
  socialAccountId: string;
  /** Products shown in the post. One product means no "which one?" question. */
  productIds: string[];
}

export interface Campaign {
  id: string;
  name: string;
  endsAt: Date;
  status: "active" | "ended";
}

export interface SocialAccount {
  id: string;
  /** The business's own platform user id. Used to ignore our own comments and echoes. */
  platformUserId: string;
  /** Domains our outgoing messages may link to. Checked by the send guardrail. */
  allowedLinkDomains: string[];
}

// ---------- Automation definition (versioned, immutable once published) ----------

/** What starts an automation: a comment whose INTENT matches, in any language. */
export interface IntentTrigger {
  type: "comment_intent";
  /** Stable intent key, e.g. "pricing". */
  intent: string;
  /** Plain-language description given to the classifier. */
  description: string;
  /** Example phrases, any language. Used by the cheap tier before the LLM. */
  examples: string[];
  /** Below this confidence we do nothing. A wrong DM is worse than a missed one. */
  minConfidence: number;
}

/**
 * A small, typed step catalog. The flow is a fixed, ordered list.
 * "ask_*" steps are follow-ups that are SKIPPED when the answer is already
 * known (one product on the post, product named in the comment, contact
 * info already on file). That is how one definition is a fixed flow when the
 * situation is deterministic and asks follow-ups only when it is ambiguous.
 */
export type Step =
  | { id: string; type: "reply_to_comment"; text: string }
  | {
      id: string;
      type: "ask_product";
      prompt: string;
      invalidPrompt: string;
      /** Generic response for followers who are spamming. */
      spamPrompt: string;
    }
  | {
      id: string;
      type: "ask_contact";
      prompt: string;
      invalidPrompt: string;
      /** Generic response for followers who are spamming. */
      spamPrompt: string;
      /** Email is preferred; phone is the fallback. */
      accept: Array<"email" | "phone">;
    }
  | { id: string; type: "send_dm"; text: string };

export interface AutomationDefinition {
  trigger: IntentTrigger;
  steps: Step[];
}

export interface Automation {
  id: string;
  socialAccountId: string;
  campaignId: string;
  name: string;
  status: "active" | "paused";
  currentVersion: number;
}

export interface AutomationVersion {
  automationId: string;
  version: number;
  definition: AutomationDefinition;
  publishedAt: Date;
}

// ---------- Runtime state ----------

export type RunStatus =
  | "running" // executing steps
  | "waiting" // parked on a durable wait for the follower's reply
  | "completed"
  | "superseded" // the business published a new version; follower asked to restart
  | "closed" // campaign ended or product sold out
  | "failed";

export type CloseReason = "campaign_ended" | "sold_out" | "replaced_by_newer_flow";

export interface RunContext {
  productId?: string;
  email?: string;
  phone?: string;
  invalidAttempts: number;
  /** Set when this run was started by a RESTART after a version change. */
  restartedFromRunId?: string;
}

export interface Run {
  id: string;
  automationId: string;
  /** Runs are pinned to the version they started on. */
  version: number;
  socialAccountId: string;
  followerId: string;
  postId: string;
  commentId: string;
  triggerEventId: string;
  status: RunStatus;
  stepIndex: number;
  context: RunContext;
  closeReason?: CloseReason;
  failureReason?: string;
  /** Set on a superseded run once the follower has restarted. */
  supersededBy?: string;
  /** Optimistic-concurrency token. Every update must present the current value. */
  rowVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Wait {
  id: string;
  runId: string;
  socialAccountId: string;
  followerId: string;
  stepId: string;
  kind: "product" | "contact";
  /** For product waits: the product ids we listed, in order. "2" means options[1]. */
  options: string[];
  status: "waiting" | "resolved" | "cancelled";
  createdAt: Date;
}

/** Follower profile the business accumulates (lead capture). */
export interface Contact {
  socialAccountId: string;
  followerId: string;
  email?: string;
  phone?: string;
  lastInboundAt?: Date;
  /** Timestamps of recent inbound DMs, for burst/spam detection. */
  recentInbound: Date[];
  lastSpamResponseAt?: Date;
}

/**
 * A message we could not send yet because the platform messaging window was
 * closed. Delivered once, the next time the follower writes to us.
 */
export interface PendingNotice {
  id: string;
  socialAccountId: string;
  followerId: string;
  text: string;
  reason: CloseReason | "flow_updated";
  createdAt: Date;
}

export type OutboundKind = "comment_reply" | "dm";

export interface OutboundAction {
  /** Idempotency key, e.g. "comment-reply:<commentId>" or "dm:<runId>:<stepId>". */
  key: string;
  kind: OutboundKind;
  socialAccountId: string;
  recipientId: string;
  commentId?: string;
  text: string;
  /** How it was (or will be) sent. A private reply is allowed once per comment. */
  channel?: "comment_reply" | "private_reply" | "dm";
  /** "unknown" = the platform call ended ambiguously; the guardrail must confirm before resending. */
  status: "pending" | "sent" | "unknown" | "failed" | "blocked";
  attempts: number;
  firstAttemptAt?: Date;
  platformMessageId?: string;
  lastError?: string;
}

// ---------- Inbound events (normalized by the existing webhook layer) ----------

export interface CommentEvent {
  type: "comment";
  /** Platform event id. Webhooks are at-least-once, so this is our dedup key. */
  eventId: string;
  socialAccountId: string;
  postId: string;
  commentId: string;
  authorId: string;
  text: string;
  createdAt: Date;
}

export interface MessageEvent {
  type: "message";
  eventId: string;
  socialAccountId: string;
  senderId: string;
  text: string;
  /** Platforms echo messages we send. Never treat an echo as a follower reply. */
  isEcho: boolean;
  createdAt: Date;
}

export type InboundEvent = CommentEvent | MessageEvent;
