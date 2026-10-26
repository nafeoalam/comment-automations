# Decision log

This file records the key design decisions, **who made each one**, and the reasoning behind it.

- **Decisions 1 to 9** were posed as plain questions. I answered them in my own words, except decision 5, which I delegated. Each entry shows my reasoning first, lightly edited for clarity, and then how the design implements it.
- **Decisions A1 to A11** are smaller calls the AI made while turning my decisions into a working design. They are listed separately so they can be reviewed and challenged.

See [AI_USAGE.md](../AI_USAGE.md) for the full split between my work and AI's work.

| # | Decision | Decided by |
|---|---|---|
| 1 | Fixed flow when deterministic, follow-up questions only when ambiguous | Author |
| 2 | Trigger on intent, not keywords | Author |
| 3 | Restricting automations to specific posts is out of scope | Author |
| 4 | When the flow changes, followers mid-flow are asked to restart | Author |
| 5 | Execution engine: Postgres state machine plus job queue | AI (delegated) |
| 6 | Email first, phone as fallback, a generic response for spammers | Author |
| 7 | A wait lasts until the campaign ends or the product sells out | Author |
| 8 | Each follower gets the flow once, with deduplication | Author |
| 9 | A guardrail confirms every message before it is sent, in a loop | Author |

---

## 1. How general should an automation be?

**Decided by:** author

**My reasoning.** It depends on the situation. Some cases are deterministic and have only one option, and in those the flow should be fixed. When something is ambiguous, there should be follow-up steps. For example, if a post shows three products and the follower only comments "pricing", the system should ask which product, and the follower then selects one.

**How the design implements it.** An automation is an ordered list of typed steps. "Ask" steps skip themselves when the answer is already known: the post shows one product, the comment names the product, or the business already has the follower's contact details. The same definition is therefore a fixed flow in the simple case and adds a question only when it is needed.

**Tradeoff.** No arbitrary branching or loops. New step types can be added without changing the model. See [DESIGN §3](DESIGN.md#3-how-general-the-system-is).

**Code and tests:** `src/engine/executor.ts`, plus the "decision 1" tests in `test/flow.test.ts`.

## 2. How should a comment be matched?

**Decided by:** author

**My reasoning.** The main point is understanding intent. "Pricing" might be written in a different language, with alternative terms, or as a whole sentence. Getting the intent right is the core of the trigger.

**How the design implements it.** Intent detection runs in tiers:
1. A cheap match on the business's multilingual example phrases.
2. A cache.
3. An LLM call for everything else.

The LLM also reports whether the comment names a product, which feeds decision 1. A per-automation confidence threshold makes the system do nothing when unsure, because an unwanted DM is worse than a missed one.

**Tradeoff.** An LLM call costs latency and money. Caching and the cheap tier keep calls to unique, unclear comments. See [DESIGN §9](DESIGN.md#9-intent-detection).

**Code and tests:** `src/intent/`, plus the "decision 2" tests in `test/flow.test.ts` and `test/intent.test.ts`.

## 3. Which posts can trigger an automation?

**Decided by:** author

**My reasoning.** Not in this task.

**How the design implements it.** Any post on the connected account can trigger. The data model doesn't prevent adding post scoping later, as a filter in the trigger matcher.

## 4. What happens when an automation is edited while followers are mid-flow?

**Decided by:** author

**My reasoning.** The follower shouldn't decide the automation; the business does. If the business changes it, people in the middle of the flow should be asked to restart, so that everyone is consistent with the updated flow.

**How the design implements it.**
- Every publish creates an immutable version.
- Runs on older versions are marked `superseded` and their open question is cancelled.
- The follower is asked: "We've updated this offer. Reply RESTART to start again." This is sent right away when the platform allows it, otherwise on their next message.
- RESTART starts a new run on the latest version. It doesn't repeat the public comment reply, and it keeps an already-chosen product if it is still in stock.

**Tradeoff.** Followers do one extra step after an edit, in exchange for never finishing a flow the business has replaced.

**Code and tests:** `Lifecycle.publishVersion` and `ConversationRouter.restart`, plus the "decision 4" tests in `test/lifecycle.test.ts`.

## 5. What runs the automations?

**Decided by:** AI. I delegated this decision ("not sure, you decide").

**AI's reasoning.** The choice is a state machine on Postgres with a transactional outbox and a job queue, instead of a durable-workflow engine like Temporal.
- Automations are data-defined and short.
- We need to query state across runs: who is waiting, conversion rates, everyone who chose product X. That is natural in SQL.
- Idle waits cost only rows.
- It reuses infrastructure a product team typically already runs.
- Temporal would be worth revisiting if flows grow into long, branching processes across several services.

**Code and tests:** `src/engine/executor.ts`, `db/schema.sql`, and [DESIGN §6](DESIGN.md#6-execution-model) and [§13](DESIGN.md#13-alternatives-considered).

## 6. What if the follower's reply isn't a valid email?

**Decided by:** author

**My reasoning.** As a fallback, the system can accept a phone number. If the follower is spamming, the system should give a generic response asking them to submit proper information.

**How the design implements it.**
- Email is preferred. If there is none, a phone number is accepted.
- The first invalid replies get a specific re-ask.
- A follower is treated as spamming after repeated invalid replies or a burst of messages. They then get one generic "please send a valid email or phone number" response per cooldown period, and anything else is silently ignored.
- The question stays open, so a valid answer later still completes the flow.

**Code and tests:** `ConversationRouter.onContactReply` and `onInvalid`, plus the "decision 6" tests in `test/flow.test.ts`.

## 7. How long does the system wait for an answer?

**Decided by:** author

**My reasoning.** Until the campaign ends, or until the product is sold out.

**How the design implements it.**
- Waits have no timer.
- When the campaign's end time passes, every open run in it is closed.
- When a product sells out, runs that chose it are closed. Followers still choosing simply stop being offered it.
- In both cases the follower is told on their next message. Their message opens the platform's messaging window, so the notice can always be delivered, and nobody gets an unsolicited "this ended" DM.

**Code and tests:** `Lifecycle.endCampaign`, `sweepCampaigns`, and `markSoldOut`, plus the "decision 7" tests in `test/lifecycle.test.ts`.

## 8. Can the same follower get the flow twice?

**Decided by:** author

**My reasoning.** No, each follower should get it once. Deduplication should be handled.

**How the design implements it.** Two layers:
- Duplicate webhook deliveries are dropped by platform event id.
- A database constraint allows one run per follower per automation.

Runs that were superseded by a new version don't count, so RESTART still works. A second "pricing" comment from the same follower is acknowledged as already received and sends nothing.

**Code and tests:** `MemoryStore.insertRun`, the `runs_one_per_follower` index in `db/schema.sql`, plus the "decision 8" tests in `test/flow.test.ts` and `test/concurrency.test.ts`.

## 9. What if sending a message fails in an unclear way?

**Decided by:** author

**My reasoning.** It should be a loop, where a guardrail first confirms the message and then sends it.

**How the design implements it.** Every send goes through a bounded loop. Before each attempt, including retries, the guardrail checks three things:
1. **The content is right.** There are no unfilled placeholders, links go only to allowed domains, and the message isn't sent to ourselves.
2. **It hasn't already been delivered.** It checks our log, and after a timeout it reads the conversation back from the platform.
3. **We may still send it.** The run is still active and the platform's messaging window allows it.

Only then does it send. A timeout therefore becomes either "it arrived, stop" or "it didn't, resend", never a double message.

**Code and tests:** `src/dispatch/`, plus `test/dispatcher.test.ts`.

---

## Smaller decisions made by AI during implementation

These follow from the decisions above but were not discussed explicitly. Each is a reasonable default that the author or a reviewer may want to change.

| # | Decision | Reasoning |
|---|---|---|
| A1 | At most **one automation per comment**. If two match, the most recently published wins. | Two flows DMing the same person at once reads as spam. |
| A2 | **One open question per follower.** If a second automation asks something, the newer question wins and the older run is closed. | An incoming DM must route to exactly one run, and the follower is answering the last thing we asked. |
| A3 | "Once" counts completed and closed runs, but **not superseded** ones. | Keeps decision 8 strict while allowing decision 4's restart. |
| A4 | A failed public comment reply **does not stop** the DM flow. | The DM is the point of the feature. The public reply is a courtesy. |
| A5 | Spam threshold: a third invalid reply, or more than 5 messages in a minute. The cooldown is 10 minutes. | Generous to honest typos, firm with floods. These are configurable defaults. |
| A6 | Campaign-ended and sold-out notices are sent **lazily**, on the follower's next message. The flow-updated notice is sent **immediately** when allowed. | Decision 4 says followers "should be asked", which implies reaching out. Decision 7 only requires closing the wait. |
| A7 | The question's wait is created **before** the question is sent. | A follower who answers instantly always finds an open question. This removes a race. |
| A8 | On restart, a chosen product is **kept if still in stock**. | Avoids asking a question whose answer we already have, which is decision 1's principle. |
| A9 | The default intent confidence threshold is **0.7**. | Leans toward not DMing when unsure. It should be tuned on real labelled comments. |
| A10 | The LLM tier uses **Claude Opus 5.5 at low effort** with server-side refusal fallback, configurable through `INTENT_MODEL`. | A capable default for multilingual intent. Switching to a cheaper model is a cost decision for the business. |
| A11 | If the LLM errors or times out, the comment is treated as **no intent**, and the failure is not cached. | Doing nothing is the safe outcome. A later identical comment retries the LLM. |
