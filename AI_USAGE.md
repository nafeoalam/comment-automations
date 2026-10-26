# How this was built: my work and AI's work

I built this with **Claude Code**, Anthropic's coding assistant, running in VS Code. The split below is meant to be precise, so a reader can tell which reasoning is mine and which is the AI's.

## What I did myself

- **Made the core design decisions.** The AI turned the brief into a list of plain-language questions. I answered eight of them in my own words, and those answers are the backbone of the design:
  - Trigger on **intent** across languages, not keywords.
  - Keep the flow **fixed when deterministic** and ask follow-ups only when something is ambiguous, such as a post with several products.
  - When the business **updates a flow**, followers mid-flow are asked to **restart**.
  - Accept a **phone number as a fallback** to email, and give spammers a **generic response**.
  - A wait lasts **until the campaign ends or the product sells out**, with no fixed timeout.
  - Each follower gets the flow **once**, with deduplication.
  - Use a **guardrail loop** that confirms each message before sending it.
  - Leave **post scoping out** of this task.

  Several of my answers went beyond how the questions were framed. The AI asked whether "pricing" had to be the whole comment or just a word in it, and I answered that intent is what matters, not the keyword. It asked whether followers mid-flow should keep the old version, and I answered that they should be asked to restart. My reasoning for each decision is recorded in [docs/DECISIONS.md](docs/DECISIONS.md).
- **Set the scope and format.** I asked for a written design plus a TypeScript implementation, chose the language and the repo, and asked for my reasoning to be written down separately from the AI's.
- **Directed the process.** I asked the AI to explain the assignment simply and to put each decision to me as a question instead of handing me a finished plan.

## Where I used AI

- **Explaining and framing.** Claude explained the assignment in plain language and broke it into the decision questions above, with tradeoffs for each option.
- **One delegated decision.** I asked the AI to choose the execution engine (decision 5). It chose a Postgres state machine over Temporal. Its reasoning is in DECISIONS.md, marked as AI-made.
- **Implementation-level decisions.** While turning my decisions into a working design, the AI made eleven smaller calls, such as one automation per comment and one open question per follower. They are listed separately in DECISIONS.md (A1 to A11) so they can be reviewed.
- **Writing.** The AI wrote:
  - the design document ([docs/DESIGN.md](docs/DESIGN.md)) and its diagrams
  - the decision log, from my answers
  - the Postgres schema
  - the TypeScript reference implementation, its tests, and the demo script
  - this file, from what actually happened in the session
- **Verification.** The AI:
  - ran the type checker and the test suite
  - checked the SQL schema and its constraints against an embedded Postgres engine
  - rendered every diagram to confirm it is valid
  - ran the demo end to end
