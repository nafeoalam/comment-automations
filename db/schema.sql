-- Postgres schema the design targets. The in-memory store (src/store/store.ts)
-- enforces the same constraints, and its method comments name them.
-- Catalog tables (social_accounts, products, posts, campaigns) are assumed to
-- exist in the wider product; only the columns the engine reads are shown.

CREATE TABLE social_accounts (
  id                    text PRIMARY KEY,
  business_id           text NOT NULL,
  platform              text NOT NULL,              -- 'instagram', ...
  platform_user_id      text NOT NULL,              -- our own id: used to ignore our comments and echoes
  allowed_link_domains  text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'connected'  -- 'connected' | 'token_revoked'
);

CREATE TABLE products (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  aliases   text[] NOT NULL DEFAULT '{}',
  link      text NOT NULL,
  in_stock  boolean NOT NULL DEFAULT true
);

CREATE TABLE post_products (
  post_id     text NOT NULL,
  product_id  text NOT NULL REFERENCES products(id),
  position    int  NOT NULL,
  PRIMARY KEY (post_id, product_id)
);

CREATE TABLE campaigns (
  id       text PRIMARY KEY,
  name     text NOT NULL,
  ends_at  timestamptz NOT NULL,
  status   text NOT NULL DEFAULT 'active'           -- 'active' | 'ended'
);

-- ---------- Automations ----------

CREATE TABLE automations (
  id                 text PRIMARY KEY,
  social_account_id  text NOT NULL REFERENCES social_accounts(id),
  campaign_id        text NOT NULL REFERENCES campaigns(id),
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'active',  -- 'active' | 'paused'
  current_version    int  NOT NULL
);
CREATE INDEX automations_active_by_account ON automations (social_account_id) WHERE status = 'active';

-- Immutable. Runs pin to (automation_id, version).
CREATE TABLE automation_versions (
  automation_id  text NOT NULL REFERENCES automations(id),
  version        int  NOT NULL,
  definition     jsonb NOT NULL,                    -- { trigger, steps[] } validated at publish
  trigger_intent text GENERATED ALWAYS AS (definition #>> '{trigger,intent}') STORED,
  published_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (automation_id, version)
);

-- ---------- Inbound events ----------

-- Webhooks are at-least-once: INSERT ... ON CONFLICT (platform_event_id) DO NOTHING.
CREATE TABLE inbound_events (
  platform_event_id  text PRIMARY KEY,
  social_account_id  text NOT NULL,
  type               text NOT NULL,                 -- 'comment' | 'message'
  payload            jsonb NOT NULL,
  intent_result      jsonb,                         -- classifier output, kept for audit
  received_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------- Runs ----------

CREATE TABLE runs (
  id                 text PRIMARY KEY,
  automation_id      text NOT NULL,
  version            int  NOT NULL,
  social_account_id  text NOT NULL,
  follower_id        text NOT NULL,
  post_id            text NOT NULL,
  comment_id         text NOT NULL,
  trigger_event_id   text NOT NULL,
  status             text NOT NULL,                 -- running | waiting | completed | superseded | closed | failed
  step_index         int  NOT NULL DEFAULT 0,
  context            jsonb NOT NULL DEFAULT '{}',   -- productId, email, phone, invalidAttempts
  close_reason       text,                          -- campaign_ended | sold_out | replaced_by_newer_flow
  failure_reason     text,
  superseded_by      text REFERENCES runs(id),
  row_version        int  NOT NULL DEFAULT 0,       -- optimistic locking
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (automation_id, version) REFERENCES automation_versions(automation_id, version),
  UNIQUE (automation_id, trigger_event_id)          -- a redelivered event can't start a second run
);
-- "Each follower gets the flow once." Superseded runs don't count, so RESTART works.
CREATE UNIQUE INDEX runs_one_per_follower ON runs (automation_id, follower_id) WHERE status <> 'superseded';
CREATE INDEX runs_active ON runs (automation_id) WHERE status IN ('running', 'waiting');
CREATE INDEX runs_active_product ON runs ((context->>'productId')) WHERE status IN ('running', 'waiting');

-- Every update: UPDATE runs SET ..., row_version = row_version + 1
--               WHERE id = $1 AND row_version = $2   (0 rows => someone else won; reload)

-- ---------- Waits ----------

-- A parked question. No timer: closed by a reply, a campaign end, a sell-out, or a new version.
CREATE TABLE waits (
  id                 text PRIMARY KEY,
  run_id             text NOT NULL REFERENCES runs(id),
  social_account_id  text NOT NULL,
  follower_id        text NOT NULL,
  step_id            text NOT NULL,
  kind               text NOT NULL,                 -- 'product' | 'contact'
  options            text[] NOT NULL DEFAULT '{}',  -- product ids in the order we listed them
  status             text NOT NULL DEFAULT 'waiting', -- waiting | resolved | cancelled
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- One open question per follower, so an incoming DM routes to exactly one run.
CREATE UNIQUE INDEX waits_one_active_per_follower ON waits (social_account_id, follower_id) WHERE status = 'waiting';

-- Resolving is a conditional update; only one of {reply, campaign end, sell-out, new version} wins:
--   UPDATE waits SET status = 'resolved' WHERE id = $1 AND status = 'waiting'

-- ---------- Contacts (lead capture) ----------

CREATE TABLE contacts (
  social_account_id      text NOT NULL,
  follower_id            text NOT NULL,
  email                  text,
  phone                  text,
  last_inbound_at        timestamptz,              -- opens the platform's 24h messaging window
  last_spam_response_at  timestamptz,
  PRIMARY KEY (social_account_id, follower_id)
);
-- Burst detection reads recent rows from inbound_events (or a Redis sliding window at scale).

-- Messages we owe a follower but couldn't send because the window was closed.
CREATE TABLE pending_notices (
  id                 text PRIMARY KEY,
  social_account_id  text NOT NULL,
  follower_id        text NOT NULL,
  text               text NOT NULL,
  reason             text NOT NULL,                -- campaign_ended | sold_out | flow_updated
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_notices_by_follower ON pending_notices (social_account_id, follower_id);

-- ---------- Outbound actions (idempotent sends) ----------

CREATE TABLE outbound_actions (
  idempotency_key      text PRIMARY KEY,           -- 'comment-reply:<commentId>', 'dm:<runId>:<stepId>', ...
  kind                 text NOT NULL,              -- 'comment_reply' | 'dm'
  channel              text,                       -- 'comment_reply' | 'private_reply' | 'dm'
  social_account_id    text NOT NULL,
  recipient_id         text NOT NULL,
  comment_id           text,
  text                 text NOT NULL,
  status               text NOT NULL,              -- pending | unknown | sent | failed | blocked
  attempts             int  NOT NULL DEFAULT 0,
  first_attempt_at     timestamptz,
  platform_message_id  text,
  last_error           text
);
-- A private reply is allowed once per comment.
CREATE UNIQUE INDEX one_private_reply_per_comment ON outbound_actions (comment_id) WHERE channel = 'private_reply' AND status = 'sent';

-- ---------- Job queue / outbox ----------

-- Written in the same transaction as the run update that schedules it, so a
-- state change and its follow-up work commit together or not at all.
-- Workers claim with SELECT ... FOR UPDATE SKIP LOCKED, ordered per partition key.
CREATE TABLE jobs (
  id             bigserial PRIMARY KEY,
  partition_key  text NOT NULL,                    -- social_account_id:follower_id
  kind           text NOT NULL,                    -- 'advance_run' | 'send' | 'end_campaign' | ...
  payload        jsonb NOT NULL,
  run_after      timestamptz NOT NULL DEFAULT now(),
  attempts       int NOT NULL DEFAULT 0,
  locked_until   timestamptz,                      -- lease; expired leases are retried
  dead           boolean NOT NULL DEFAULT false    -- dead-letter after max attempts
);
CREATE INDEX jobs_ready ON jobs (run_after) WHERE NOT dead;
