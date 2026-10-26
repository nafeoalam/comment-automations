import type { ActionDispatcher } from "../dispatch/dispatcher";
import type { IntentClassifier } from "../intent/classifier";
import type { Store } from "../store/store";
import type { Clock } from "../util/clock";
import { MINUTE } from "../util/clock";
import type { KeyedSerialQueue } from "../util/keyed-queue";

export interface EngineConfig {
  /** Invalid replies allowed before a follower is treated as spamming. */
  maxInvalidBeforeSpam: number;
  /** More than burstLimit messages within burstWindowMs also counts as spamming. */
  burstLimit: number;
  burstWindowMs: number;
  /** A spamming follower gets the generic response at most once per cooldown. Other messages are ignored. */
  spamCooldownMs: number;
  /** Words that mean "restart my flow" after the business updated it. Matched after normalization. */
  restartWords: string[];
  messages: {
    flowUpdated: string;
    campaignEnded: string;
    soldOut: string; // {{product.name}}
    soldOutPickAnother: string; // {{product.name}}
  };
}

export const DEFAULT_CONFIG: EngineConfig = {
  maxInvalidBeforeSpam: 2,
  burstLimit: 5,
  burstWindowMs: MINUTE,
  spamCooldownMs: 10 * MINUTE,
  restartWords: ["restart", "start again", "start over", "reiniciar", "recommencer", "neu starten"],
  messages: {
    flowUpdated: "We've updated this offer. Reply RESTART to start again with the latest version.",
    campaignEnded: "Thanks for your interest! This campaign has ended.",
    soldOut: "Sorry, {{product.name}} just sold out.",
    soldOutPickAnother: "Sorry, {{product.name}} just sold out. Please pick another one:",
  },
};

/** Everything the engine components share. */
export interface EngineDeps {
  store: Store;
  dispatcher: ActionDispatcher;
  classifier: IntentClassifier;
  clock: Clock;
  queue: KeyedSerialQueue;
  config: EngineConfig;
}
