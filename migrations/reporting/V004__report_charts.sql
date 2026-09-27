-- V004__report_charts.sql
--
-- WHICH HIDDEN METABASE QUESTION BELONGS TO WHICH GRAV REPORT.
--
-- ── WHY THIS IS NOT IN MONGO ────────────────────────────────────────────────
-- Two reasons, and the second is the better one.
--
-- The immediate one: the shared development cluster is at its collection
-- limit — "cannot create a new collection -- already using 500 collections of
-- 500" — so a new Mongo collection is not available to take.
--
-- The one that would have made this the right home anyway: a pointer to a
-- Metabase question must never reach a browser, and the surest way to keep it
-- out of a response is for it to live somewhere no route can serialise by
-- accident. There is no Mongoose model for this table and no `presentReport`
-- that could spread it into a payload; it is reached by one service, through
-- one repository, over the reporting connection. A field on a document that is
-- already being JSON-ified is one careless spread away from being public. A
-- row in another database is not.
--
-- ── WHAT A ROW IS ───────────────────────────────────────────────────────────
-- One per (organisation, kind, layout hash). A DRAFT belongs to a layout
-- somebody is still building and expires; a SAVED row belongs to a GRAV custom
-- report and lives exactly as long as it does.
--
-- The organisation and report ids are Mongo ObjectIds, kept as text: this table
-- references them, it does not own them, and inventing a numeric key for
-- something whose identity lives in another database would only create two
-- ways to say the same thing.

CREATE TABLE reporting.report_chart (
  id                bigserial     PRIMARY KEY,
  organization_id   text          NOT NULL,
  kind              text          NOT NULL CHECK (kind IN ('draft', 'saved')),
  report_id         text,
  user_id           text,
  layout_hash       text          NOT NULL,
  card_id           integer       NOT NULL,
  collection_id     integer,
  display           text          NOT NULL DEFAULT 'table',
  archived_at       timestamptz,
  last_used_at      timestamptz   NOT NULL DEFAULT now(),
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),

  -- A saved row names its report; a draft names none. Stated as a constraint
  -- because the cleanup job's promise — "it never touches a saved report's
  -- question" — is only as good as the distinction it filters on.
  CONSTRAINT report_chart_kind_report CHECK (
    (kind = 'saved' AND report_id IS NOT NULL) OR
    (kind = 'draft' AND report_id IS NULL)
  )
);

-- THE LOCK. Two requests for the same chart race; one inserts and the other's
-- insert fails and re-reads the winner. Without it, a burst of requests leaves
-- a burst of questions and only one of them is ever remembered.
CREATE UNIQUE INDEX report_chart_identity_idx
  ON reporting.report_chart (organization_id, kind, layout_hash)
  WHERE archived_at IS NULL;

-- One question per saved report, for the same reason.
CREATE UNIQUE INDEX report_chart_report_idx
  ON reporting.report_chart (organization_id, report_id)
  WHERE kind = 'saved' AND archived_at IS NULL;

CREATE INDEX report_chart_stale_idx ON reporting.report_chart (kind, last_used_at)
  WHERE archived_at IS NULL;
CREATE INDEX report_chart_card_idx  ON reporting.report_chart (card_id);

COMMENT ON TABLE reporting.report_chart IS
  'Server-only: which hidden Metabase question draws which GRAV report. Never reaches a browser.';

-- The read-only role has no business here: this table is not reporting DATA,
-- and a Metabase connection that could read it would be a list of every
-- question and who it belongs to, offered to the tool the questions are hidden
-- from.
REVOKE ALL ON reporting.report_chart FROM PUBLIC;
