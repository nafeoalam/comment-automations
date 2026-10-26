import { ActionDispatcher, type DispatcherOptions } from "../dispatch/dispatcher";
import type { CommentEvent, InboundEvent, MessageEvent } from "../domain/types";
import type { IntentClassifier } from "../intent/classifier";
import { Lifecycle } from "../lifecycle/lifecycle";
import type { PlatformAdapter } from "../platform/platform";
import type { Store } from "../store/store";
import { systemClock, type Clock } from "../util/clock";
import { followerKey, KeyedSerialQueue } from "../util/keyed-queue";
import { DEFAULT_CONFIG, type EngineConfig, type EngineDeps } from "./context";
import { ConversationRouter, type MessageOutcome } from "./conversation";
import { RunExecutor } from "./executor";
import { TriggerService, type CommentOutcome } from "./triggers";

export interface EngineOptions {
  store: Store;
  platform: PlatformAdapter;
  classifier: IntentClassifier;
  clock?: Clock;
  config?: Partial<EngineConfig>;
  dispatcher?: DispatcherOptions;
}

/**
 * Wires the components together. Inbound events enter here and are
 * serialized per follower (socialAccountId + followerId), which is the
 * partition key a production queue would use.
 */
export class AutomationEngine {
  readonly store: Store;
  readonly executor: RunExecutor;
  readonly triggers: TriggerService;
  readonly conversations: ConversationRouter;
  readonly lifecycle: Lifecycle;
  private readonly queue = new KeyedSerialQueue();

  constructor(opts: EngineOptions) {
    const clock = opts.clock ?? systemClock;
    const deps: EngineDeps = {
      store: opts.store,
      clock,
      classifier: opts.classifier,
      queue: this.queue,
      config: { ...DEFAULT_CONFIG, ...opts.config, messages: { ...DEFAULT_CONFIG.messages, ...opts.config?.messages } },
      dispatcher: new ActionDispatcher(opts.store, opts.platform, clock, opts.dispatcher),
    };
    this.store = opts.store;
    this.executor = new RunExecutor(deps);
    this.triggers = new TriggerService(deps, this.executor);
    this.conversations = new ConversationRouter(deps, this.executor);
    this.lifecycle = new Lifecycle(deps, this.executor);
  }

  onEvent(e: InboundEvent): Promise<CommentOutcome | MessageOutcome> {
    return e.type === "comment" ? this.onComment(e) : this.onMessage(e);
  }

  onComment(e: CommentEvent): Promise<CommentOutcome> {
    return this.queue.run(followerKey(e.socialAccountId, e.authorId), () => this.triggers.handleComment(e));
  }

  onMessage(e: MessageEvent): Promise<MessageOutcome> {
    return this.queue.run(followerKey(e.socialAccountId, e.senderId), () => this.conversations.handleMessage(e));
  }
}
