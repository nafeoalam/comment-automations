# Comment-triggered automations

This is the backend design for automations that start when someone comments on a business's social media post. In the example, a follower comments "pricing" on an Instagram post. The system replies "Sent you a DM!", DMs them asking for their email, waits for the answer, and then DMs them a link.

The repo has two parts:
- **A written design** covering the architecture, data model, execution model, reliability, and concurrency.
- **A runnable TypeScript reference implementation** of the core engine, with tests for each design decision.

## Start here

| Read | For |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | The full design, with diagrams |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Each key decision, who made it, and why |
| [AI_USAGE.md](AI_USAGE.md) | Which parts I did myself and where I used AI |
| [db/schema.sql](db/schema.sql) | The Postgres schema the design targets |

## The design in brief

- **Intent, not keywords.** Comments are classified by meaning in any language. Cheap example-phrase matching runs first, then a cache, then a Claude call. When unsure, the system does nothing.
- **A fixed flow that asks only when needed.** An automation is a short list of typed steps. "Which product?" is asked only when the post shows several products and the comment didn't name one. Contact details are asked only if the business doesn't already have them.
- **Waits are database rows.** A follower can answer minutes or days later. A wait ends when the follower replies, the campaign ends, or the product sells out.
- **Versioned flows.** Edits create a new version. Followers mid-flow are asked to reply RESTART so they finish on the current flow.
- **Effectively-once messaging.** At-least-once delivery is made safe by idempotency keys and a send guardrail. Before every attempt, the guardrail checks the message content, whether it was already delivered, and whether we may still send it.
- **No races per follower.** All events for one follower are serialized, run updates use optimistic locking, and database constraints enforce one run per follower and one open question per follower.

## Run it

You need Node 20 or later. No API key is needed, because tests and the demo use a fake platform and a fake LLM tier.

```bash
npm install
npm test          # tests, grouped by design decision
npm run typecheck
npm run demo      # prints eight scenarios as a conversation transcript
```

The real Claude classifier is in `src/intent/claude-classifier.ts`. To use it, set `ANTHROPIC_API_KEY`, or optionally `INTENT_MODEL`, and pass a `ClaudeIntentClassifier` as the LLM tier.

## Repo map

```
src/
  domain/types.ts        domain model and event shapes
  engine/                trigger matcher, conversation router, run executor
  intent/                tiered intent classifier (examples, cache, Claude)
  dispatch/              guarded, idempotent send loop
  lifecycle/             publish version, campaign end, sold out
  store/                 persistence interface + in-memory store with SQL-equivalent constraints
  platform/              platform adapter interface + fake with failure injection
  demo.ts                scenario walkthrough
test/                    tests, named after the decisions they verify
db/schema.sql            Postgres schema
docs/                    design and decision log
```

This is a reference implementation. Persistence, the queue, and the platform are in-memory stand-ins that keep the production semantics. The design document explains how each one maps to production.
