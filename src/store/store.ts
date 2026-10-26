import type {
  Automation,
  AutomationVersion,
  Campaign,
  Contact,
  OutboundAction,
  PendingNotice,
  Post,
  Product,
  Run,
  SocialAccount,
  Wait,
} from "../domain/types";

/** Raised where Postgres would raise a unique-constraint violation. */
export class UniqueViolation extends Error {
  constructor(public readonly constraint: string) {
    super(`unique violation: ${constraint}`);
  }
}

/** Raised when an update presents a stale rowVersion (optimistic locking). */
export class ConcurrencyError extends Error {
  constructor(public readonly entity: string, public readonly id: string) {
    super(`stale write to ${entity} ${id}`);
  }
}

/**
 * Persistence boundary. Each method maps to one SQL statement or one short
 * transaction in db/schema.sql; comments name the constraint being enforced.
 */
export interface Store {
  // Catalog
  putAccount(a: SocialAccount): void;
  getAccount(id: string): SocialAccount | undefined;
  putProduct(p: Product): void;
  getProduct(id: string): Product | undefined;
  putPost(p: Post): void;
  getPost(id: string): Post | undefined;
  putCampaign(c: Campaign): void;
  getCampaign(id: string): Campaign | undefined;

  // Automations
  putAutomation(a: Automation): void;
  getAutomation(id: string): Automation | undefined;
  listActiveAutomations(socialAccountId: string): Automation[];
  listAutomationsByCampaign(campaignId: string): Automation[];
  /** UNIQUE (automation_id, version). Versions are immutable. */
  insertVersion(v: AutomationVersion): void;
  getVersion(automationId: string, version: number): AutomationVersion | undefined;

  // Inbound dedup: INSERT ... ON CONFLICT (platform_event_id) DO NOTHING
  /** Returns false if this event id was already seen. */
  recordInboundEvent(eventId: string): boolean;

  // Runs
  /**
   * UNIQUE (automation_id, trigger_event_id) and a partial UNIQUE
   * (automation_id, follower_id) WHERE status <> 'superseded'.
   * The second one is "each follower gets the flow once".
   */
  insertRun(run: Run): Run;
  getRun(id: string): Run | undefined;
  /** UPDATE ... WHERE id = $1 AND row_version = $2. Returns the stored row with rowVersion + 1. */
  updateRun(run: Run): Run;
  listRunsByAutomation(automationId: string): Run[];
  listRunsForFollower(socialAccountId: string, followerId: string): Run[];
  /** Runs in status running or waiting (partial index on status). */
  listActiveRuns(): Run[];

  // Waits
  /** Partial UNIQUE (social_account_id, follower_id) WHERE status = 'waiting'. */
  armWait(w: Wait): void;
  getActiveWait(socialAccountId: string, followerId: string): Wait | undefined;
  getActiveWaitForRun(runId: string): Wait | undefined;
  /** UPDATE waits SET status = $2 WHERE id = $1 AND status = 'waiting'. True if this call won. */
  closeWait(waitId: string, to: "resolved" | "cancelled"): boolean;

  // Contacts
  getContact(socialAccountId: string, followerId: string): Contact;
  saveContact(c: Contact): void;

  // Pending notices (delivered on the follower's next message)
  addNotice(n: PendingNotice): void;
  takeNotices(socialAccountId: string, followerId: string): PendingNotice[];

  // Outbound actions, keyed by idempotency key
  getOutbound(key: string): OutboundAction | undefined;
  saveOutbound(a: OutboundAction): void;
  listOutbound(): OutboundAction[];
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory Store. Returns copies, like a database would, so a caller holding
 * a stale Run really does get a ConcurrencyError on update.
 */
export class MemoryStore implements Store {
  private accounts = new Map<string, SocialAccount>();
  private products = new Map<string, Product>();
  private posts = new Map<string, Post>();
  private campaigns = new Map<string, Campaign>();
  private automations = new Map<string, Automation>();
  private versions = new Map<string, AutomationVersion>();
  private inboundEvents = new Set<string>();
  private runs = new Map<string, Run>();
  private waits = new Map<string, Wait>();
  private contacts = new Map<string, Contact>();
  private notices: PendingNotice[] = [];
  private outbound = new Map<string, OutboundAction>();

  putAccount(a: SocialAccount) { this.accounts.set(a.id, clone(a)); }
  getAccount(id: string) { const a = this.accounts.get(id); return a && clone(a); }
  putProduct(p: Product) { this.products.set(p.id, clone(p)); }
  getProduct(id: string) { const p = this.products.get(id); return p && clone(p); }
  putPost(p: Post) { this.posts.set(p.id, clone(p)); }
  getPost(id: string) { const p = this.posts.get(id); return p && clone(p); }
  putCampaign(c: Campaign) { this.campaigns.set(c.id, clone(c)); }
  getCampaign(id: string) { const c = this.campaigns.get(id); return c && clone(c); }

  putAutomation(a: Automation) { this.automations.set(a.id, clone(a)); }
  getAutomation(id: string) { const a = this.automations.get(id); return a && clone(a); }
  listActiveAutomations(socialAccountId: string) {
    return [...this.automations.values()]
      .filter((a) => a.socialAccountId === socialAccountId && a.status === "active")
      .map(clone);
  }
  listAutomationsByCampaign(campaignId: string) {
    return [...this.automations.values()].filter((a) => a.campaignId === campaignId).map(clone);
  }

  insertVersion(v: AutomationVersion) {
    const key = `${v.automationId}#${v.version}`;
    if (this.versions.has(key)) throw new UniqueViolation("automation_versions_pkey");
    this.versions.set(key, clone(v));
  }
  getVersion(automationId: string, version: number) {
    const v = this.versions.get(`${automationId}#${version}`);
    return v && clone(v);
  }

  recordInboundEvent(eventId: string): boolean {
    if (this.inboundEvents.has(eventId)) return false;
    this.inboundEvents.add(eventId);
    return true;
  }

  insertRun(run: Run): Run {
    for (const r of this.runs.values()) {
      if (r.automationId === run.automationId && r.triggerEventId === run.triggerEventId) {
        throw new UniqueViolation("runs_automation_trigger_event_key");
      }
      if (r.automationId === run.automationId && r.followerId === run.followerId && r.status !== "superseded") {
        throw new UniqueViolation("runs_one_per_follower");
      }
    }
    this.runs.set(run.id, clone(run));
    return clone(run);
  }
  getRun(id: string) { const r = this.runs.get(id); return r && clone(r); }
  updateRun(run: Run): Run {
    const current = this.runs.get(run.id);
    if (!current) throw new Error(`run ${run.id} not found`);
    if (current.rowVersion !== run.rowVersion) throw new ConcurrencyError("run", run.id);
    const next = { ...clone(run), rowVersion: run.rowVersion + 1 };
    this.runs.set(run.id, next);
    return clone(next);
  }
  listRunsByAutomation(automationId: string) {
    return [...this.runs.values()].filter((r) => r.automationId === automationId).map(clone);
  }
  listRunsForFollower(socialAccountId: string, followerId: string) {
    return [...this.runs.values()]
      .filter((r) => r.socialAccountId === socialAccountId && r.followerId === followerId)
      .map(clone);
  }

  listActiveRuns() {
    return [...this.runs.values()].filter((r) => r.status === "running" || r.status === "waiting").map(clone);
  }

  armWait(w: Wait) {
    if (this.getActiveWait(w.socialAccountId, w.followerId)) {
      throw new UniqueViolation("waits_one_active_per_follower");
    }
    this.waits.set(w.id, clone(w));
  }
  getActiveWait(socialAccountId: string, followerId: string) {
    for (const w of this.waits.values()) {
      if (w.socialAccountId === socialAccountId && w.followerId === followerId && w.status === "waiting") {
        return clone(w);
      }
    }
    return undefined;
  }
  getActiveWaitForRun(runId: string) {
    for (const w of this.waits.values()) {
      if (w.runId === runId && w.status === "waiting") return clone(w);
    }
    return undefined;
  }
  closeWait(waitId: string, to: "resolved" | "cancelled"): boolean {
    const w = this.waits.get(waitId);
    if (!w || w.status !== "waiting") return false;
    w.status = to;
    return true;
  }

  getContact(socialAccountId: string, followerId: string): Contact {
    const c = this.contacts.get(`${socialAccountId}:${followerId}`);
    return c ? clone(c) : { socialAccountId, followerId, recentInbound: [] };
  }
  saveContact(c: Contact) { this.contacts.set(`${c.socialAccountId}:${c.followerId}`, clone(c)); }

  addNotice(n: PendingNotice) { this.notices.push(clone(n)); }
  takeNotices(socialAccountId: string, followerId: string): PendingNotice[] {
    const mine = this.notices.filter((n) => n.socialAccountId === socialAccountId && n.followerId === followerId);
    this.notices = this.notices.filter((n) => !mine.includes(n));
    return mine.map(clone);
  }

  getOutbound(key: string) { const a = this.outbound.get(key); return a && clone(a); }
  saveOutbound(a: OutboundAction) { this.outbound.set(a.key, clone(a)); }
  listOutbound() { return [...this.outbound.values()].map(clone); }
}
