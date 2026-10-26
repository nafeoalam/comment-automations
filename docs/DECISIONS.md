# Decisions

This file lists the key decisions and who made each one.

- **Decisions 1 to 9:** I answered these myself, except number 5, which I left to the AI.
- **[A1 to A11](#smaller-choices-made-by-the-ai):** smaller choices the AI made while building the design.

[AI_USAGE.md](../AI_USAGE.md) explains the full split between my work and the AI's. [DESIGN.md](DESIGN.md) has the full design.

| # | Decision | By |
|---|---|---|
| 1 | [Fixed flow, with questions only when something is unclear](#1-how-general-should-it-be) | Me |
| 2 | [Match intent, not keywords](#2-how-should-a-comment-be-matched) | Me |
| 3 | [Limiting automations to specific posts is out of scope](#3-which-posts-can-trigger-it) | Me |
| 4 | [When the flow changes, followers mid-flow restart](#4-what-if-the-flow-is-edited-while-people-are-mid-flow) | Me |
| 5 | [Run automations on Postgres and a job queue](#5-what-runs-the-automations) | AI |
| 6 | [Email first, phone as a fallback, a generic reply for spam](#6-what-if-the-reply-isnt-a-valid-email) | Me |
| 7 | [Wait until the campaign ends or the product sells out](#7-how-long-do-we-wait) | Me |
| 8 | [Each follower gets the flow once](#8-can-someone-get-the-flow-twice) | Me |
| 9 | [A guardrail checks every message before sending](#9-what-if-a-send-fails-in-an-unclear-way) | Me |

---

## 1. How general should it be?

**My reasoning.** Some cases have only one option, so the flow should be fixed. When something is unclear, ask a follow-up. For example, if a post shows three products and someone comments "pricing", ask which product.

**In the design.** Question steps skip themselves when the answer is already known. More in [DESIGN §2](DESIGN.md#2-how-general-is-it).

**Code:** [`src/engine/executor.ts`](../src/engine/executor.ts)

## 2. How should a comment be matched?

**My reasoning.** Intent is what matters. "Pricing" can come in another language, as a different word, or as a whole sentence.

**In the design.** Matching runs in three tiers: example phrases, then a cache, then an LLM. When unsure, the system does nothing. More in [DESIGN §8](DESIGN.md#8-intent-detection).

**Code:** [`src/intent/`](../src/intent)

## 3. Which posts can trigger it?

**My reasoning.** Not in this task.

**In the design.** Any post on the account can trigger. A post filter can be added later.

## 4. What if the flow is edited while people are mid-flow?

**My reasoning.** The business decides the flow, not the follower. If it changes, people mid-flow should restart so everyone is on the new version.

**In the design.**
- Each edit creates a new version.
- Followers mid-flow are asked to reply RESTART.
- RESTART starts them on the new version without posting the comment reply again.

More in [DESIGN §5](DESIGN.md#5-how-it-runs).

**Code:** [`src/lifecycle/lifecycle.ts`](../src/lifecycle/lifecycle.ts)

## 5. What runs the automations?

**I left this to the AI.**

**The AI's reasoning.** The choice is Postgres plus a job queue, not a workflow engine like Temporal.
- Flows are short.
- We need SQL queries across runs.
- Waiting costs only a database row.
- It reuses tools most teams already run.

More in [DESIGN §11](DESIGN.md#11-alternatives-considered).

**Code:** [`src/engine/executor.ts`](../src/engine/executor.ts), [`db/schema.sql`](../db/schema.sql)

## 6. What if the reply isn't a valid email?

**My reasoning.** Accept a phone number as a fallback. If someone is spamming, send a generic reply asking for proper info.

**In the design.**
- An invalid answer gets asked again.
- Someone who keeps sending junk gets one generic reply per 10 minutes, and the rest is ignored.
- A valid answer later still works.

**Code:** [`src/engine/conversation.ts`](../src/engine/conversation.ts)

## 7. How long do we wait?

**My reasoning.** Until the campaign ends or the product sells out.

**In the design.**
- There are no timers.
- Campaign end and sell-outs close open waits.
- The follower is told on their next message.

More in [DESIGN §5](DESIGN.md#5-how-it-runs).

**Code:** [`src/lifecycle/lifecycle.ts`](../src/lifecycle/lifecycle.ts)

## 8. Can someone get the flow twice?

**My reasoning.** No, only once. Handle duplicates.

**In the design.**
- Repeated webhooks are ignored.
- A database rule allows one run per follower per automation. Restarts after an edit are the only exception.

**Code:** [`src/store/store.ts`](../src/store/store.ts), [`db/schema.sql`](../db/schema.sql)

## 9. What if a send fails in an unclear way?

**My reasoning.** Use a loop where a guardrail first confirms the message, then sends it.

**In the design.** Before every attempt, the guardrail checks three things:
- the message is correct,
- it wasn't already delivered,
- we're still allowed to send it.

So a timeout never causes a double message. More in [DESIGN §6](DESIGN.md#6-reliability).

**Code:** [`src/dispatch/`](../src/dispatch)

---

## Smaller choices made by the AI

These are defaults that can be changed.

| # | Choice | Why |
|---|---|---|
| A1 | One automation per comment. The newest wins. | Two flows DMing one person feels like spam. |
| A2 | One open question per follower. The newest wins. | A DM must go to exactly one run. |
| A3 | Restarted runs don't count against "once". | Lets decision 4 work with decision 8. |
| A4 | A failed comment reply doesn't stop the DMs. | The DM is the point. The comment reply is a courtesy. |
| A5 | Spam means a 3rd invalid reply or more than 5 messages a minute, with a 10-minute cooldown. | Forgiving of typos, firm with floods. |
| A6 | "Campaign ended" and "sold out" are sent on the follower's next message. "Flow updated" is sent right away when allowed. | Decision 4 says followers should be asked to restart. |
| A7 | The wait opens before the question is sent. | Instant answers are never missed. |
| A8 | Restart keeps the chosen product if it is still in stock. | Don't ask what we already know. |
| A9 | The confidence threshold is 0.7. | Leans toward not DMing. Tune it on real comments. |
| A10 | Claude Opus 5.5 is the LLM, configurable. | A strong default. A cheaper model is a cost choice. |
| A11 | If the LLM fails, treat the comment as no match. | No DM is safer than a wrong DM. |
