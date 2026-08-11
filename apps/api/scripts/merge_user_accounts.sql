-- ─────────────────────────────────────────────────────────────────────────
-- One-time merge of duplicate Mathias accounts (CLAUDE.md §13a).
--
--   RETIRE  dc89f830-c85e-48f0-8faf-60ba59e529e9   mathias@yon.studio
--   KEEP    860a66cd-4268-4d3b-aa44-8eabd80cd7f1   Mathias@yon.studio
--
-- Cause: users.email is a plain case-sensitive unique column and neither
-- the login lookup nor the signup duplicate-check normalised case, so one
-- person ended up with two accounts holding different grants.
--
-- Run inside ONE transaction with ON_ERROR_STOP=1 so any failure — a
-- missed FK, a unique violation, a failed assertion — rolls the whole
-- thing back rather than leaving the account half-merged. Do NOT run
-- statement-by-statement.
--
-- FK COVERAGE: 24 foreign keys onto users.id across 20 tables, discovered
-- fresh from the models for this change rather than reused from the
-- purge-service audit (which was for assets/folders, a different graph).
-- Four of those columns sit under unique constraints and therefore cannot
-- simply be reassigned:
--
--   project_members    UNIQUE(project_id, user_id)          -- NOT partial:
--                                                              counts
--                                                              soft-deleted
--   votes              UNIQUE(asset_id, user_id)
--   approvals          UNIQUE(version_id, user_id)
--   comment_reactions  UNIQUE(comment_id, user_id, emoji)
--
-- For each, a row that would collide is soft-deleted (or deleted where the
-- table has no deleted_at) and only the non-colliding remainder is
-- reassigned. The other 20 FKs are plain reassignments.
--
-- The retired user row is SOFT-deleted, not hard-deleted. Both email
-- lookups already filter `deleted_at IS NULL`
-- (auth_service.get_user_by_email, setup.py), so the retired row cannot be
-- matched by the case-insensitive lookup shipped alongside this — while
-- staying recoverable if this merge turns out to have missed something.
-- ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on
\set OLD '''dc89f830-c85e-48f0-8faf-60ba59e529e9'''
\set NEW '''860a66cd-4268-4d3b-aa44-8eabd80cd7f1'''

BEGIN;

-- ── Guards. Any failure here aborts before a single row changes. ────────
DO $$
DECLARE o users%ROWTYPE; n users%ROWTYPE;
BEGIN
  SELECT * INTO o FROM users WHERE id = 'dc89f830-c85e-48f0-8faf-60ba59e529e9';
  SELECT * INTO n FROM users WHERE id = '860a66cd-4268-4d3b-aa44-8eabd80cd7f1';

  IF o.id IS NULL THEN RAISE EXCEPTION 'Retire account not found — already merged?'; END IF;
  IF n.id IS NULL THEN RAISE EXCEPTION 'Keep account not found — wrong database?'; END IF;
  IF o.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Retire account is already soft-deleted — merge may have run'; END IF;
  IF n.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Keep account is soft-deleted — refusing to merge into it'; END IF;
  IF lower(o.email) <> lower(n.email) THEN
    RAISE EXCEPTION 'These are not the same address (% vs %) — refusing', o.email, n.email;
  END IF;
  RAISE NOTICE 'Guards passed: retiring % -> keeping %', o.email, n.email;
END $$;

\echo ''
\echo '── BEFORE ─────────────────────────────────────────────────────────'
SELECT p.name AS project, pm.role, pm.deleted_at IS NOT NULL AS soft_deleted
FROM project_members pm JOIN projects p ON p.id = pm.project_id
WHERE pm.user_id = :OLD ORDER BY p.name;

-- ── 1. Collision-bearing tables ────────────────────────────────────────

-- project_members. Test_NEW: the keeper already holds `owner`, so the
-- retired `admin` row is the loser — the owner grant must not be
-- downgraded. TEST FOTO: keeper holds `owner`, retired row is an
-- already-soft-deleted `viewer`. Just Ride 2026: no keeper row, so that
-- live `editor` grant reassigns rather than vanishing.
UPDATE project_members o
SET deleted_at = COALESCE(o.deleted_at, now())
WHERE o.user_id = :OLD
  AND EXISTS (SELECT 1 FROM project_members n
              WHERE n.project_id = o.project_id AND n.user_id = :NEW);

UPDATE project_members SET user_id = :NEW
WHERE user_id = :OLD
  AND NOT EXISTS (SELECT 1 FROM project_members n
                  WHERE n.project_id = project_members.project_id AND n.user_id = :NEW);

-- votes / approvals / comment_reactions: no deleted_at column on votes or
-- comment_reactions, so a colliding row is removed outright. It is a
-- duplicate of one the keeper already has — the same person's same vote —
-- so nothing is lost.
DELETE FROM votes o WHERE o.user_id = :OLD
  AND EXISTS (SELECT 1 FROM votes n WHERE n.user_id = :NEW AND n.asset_id = o.asset_id);
UPDATE votes SET user_id = :NEW WHERE user_id = :OLD;

-- approvals does have a deleted_at, but soft-deleting a collision here
-- would leave the row pointing at the retired account and trip the
-- completeness assertion below, which counts rows regardless of
-- deleted_at. A duplicate approval by the same person on the same version
-- carries nothing the keeper's row doesn't already have.
DELETE FROM approvals o WHERE o.user_id = :OLD
  AND EXISTS (SELECT 1 FROM approvals n WHERE n.user_id = :NEW AND n.version_id = o.version_id);
UPDATE approvals SET user_id = :NEW WHERE user_id = :OLD;

DELETE FROM comment_reactions o WHERE o.user_id = :OLD
  AND EXISTS (SELECT 1 FROM comment_reactions n
              WHERE n.user_id = :NEW AND n.comment_id = o.comment_id AND n.emoji = o.emoji);
UPDATE comment_reactions SET user_id = :NEW WHERE user_id = :OLD;

-- ── 2. The remaining 20 FKs — plain reassignment ───────────────────────
-- Content follows the person. Nothing here is deleted just because the
-- account it was attributed to is being retired.
UPDATE activity_logs      SET user_id             = :NEW WHERE user_id             = :OLD;
UPDATE asset_shares       SET shared_by           = :NEW WHERE shared_by           = :OLD;
UPDATE asset_shares       SET shared_with_user_id = :NEW WHERE shared_with_user_id = :OLD;
UPDATE asset_versions     SET created_by          = :NEW WHERE created_by          = :OLD;
UPDATE assets             SET assignee_id         = :NEW WHERE assignee_id         = :OLD;
UPDATE assets             SET created_by          = :NEW WHERE created_by          = :OLD;
UPDATE collection_shares  SET created_by          = :NEW WHERE created_by          = :OLD;
UPDATE collections        SET created_by          = :NEW WHERE created_by          = :OLD;
UPDATE comments           SET author_id           = :NEW WHERE author_id           = :OLD;
UPDATE folders            SET created_by          = :NEW WHERE created_by          = :OLD;
UPDATE lut_groups         SET owner_id            = :NEW WHERE owner_id            = :OLD;
UPDATE luts               SET owner_id            = :NEW WHERE owner_id            = :OLD;
UPDATE mentions           SET mentioned_user_id   = :NEW WHERE mentioned_user_id   = :OLD;
UPDATE notifications      SET user_id             = :NEW WHERE user_id             = :OLD;
UPDATE project_lut_shares SET shared_by           = :NEW WHERE shared_by           = :OLD;
UPDATE project_members    SET invited_by          = :NEW WHERE invited_by          = :OLD;
UPDATE projects           SET archived_by         = :NEW WHERE archived_by         = :OLD;
UPDATE projects           SET created_by          = :NEW WHERE created_by          = :OLD;
UPDATE share_links        SET created_by          = :NEW WHERE created_by          = :OLD;
UPDATE sidecar_files      SET uploaded_by         = :NEW WHERE uploaded_by         = :OLD;

-- ── 3. Frozen identity snapshots ───────────────────────────────────────
-- Text copies that exist to survive user deletion. They now name a
-- retired account, so they are re-pointed at the keeper's identity. Same
-- human either way; this only keeps the byline consistent.
UPDATE projects p SET created_by_name  = n.first_name || ' ' || n.last_name,
                      created_by_email = n.email
FROM users n WHERE n.id = :NEW AND p.created_by = :NEW AND lower(p.created_by_email) = 'mathias@yon.studio';
UPDATE assets a         SET created_by_name = n.first_name || ' ' || n.last_name FROM users n WHERE n.id = :NEW AND a.created_by = :NEW;
UPDATE asset_versions v SET created_by_name = n.first_name || ' ' || n.last_name FROM users n WHERE n.id = :NEW AND v.created_by = :NEW;
UPDATE comments c       SET author_name     = n.first_name || ' ' || n.last_name FROM users n WHERE n.id = :NEW AND c.author_id  = :NEW;

-- ── 4. Retire the now-empty account ────────────────────────────────────
UPDATE users SET deleted_at = now(), status = 'deactivated' WHERE id = :OLD;

-- ── 5. Assert the merge is actually complete before committing ─────────
DO $$
DECLARE remaining int;
BEGIN
  SELECT
    (SELECT count(*) FROM activity_logs      WHERE user_id             = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM approvals          WHERE user_id             = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM asset_shares       WHERE shared_by           = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM asset_shares       WHERE shared_with_user_id = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM asset_versions     WHERE created_by          = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM assets             WHERE assignee_id         = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM assets             WHERE created_by          = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM collection_shares  WHERE created_by          = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM collections        WHERE created_by          = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM comment_reactions  WHERE user_id             = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM comments           WHERE author_id           = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM folders            WHERE created_by          = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM lut_groups         WHERE owner_id            = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM luts               WHERE owner_id            = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM mentions           WHERE mentioned_user_id   = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM notifications      WHERE user_id             = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM project_lut_shares WHERE shared_by           = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM project_members    WHERE invited_by          = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM projects           WHERE archived_by         = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM projects           WHERE created_by          = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM share_links        WHERE created_by          = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM sidecar_files      WHERE uploaded_by         = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  + (SELECT count(*) FROM votes              WHERE user_id             = 'dc89f830-c85e-48f0-8faf-60ba59e529e9')
  INTO remaining;

  IF remaining <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK: % reference(s) to the retired account remain outside project_members', remaining;
  END IF;

  -- project_members is the one table allowed to keep rows: the collided
  -- ones are soft-deleted in place rather than reassigned.
  IF EXISTS (SELECT 1 FROM project_members
             WHERE user_id = 'dc89f830-c85e-48f0-8faf-60ba59e529e9' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'ROLLBACK: retired account still holds a LIVE project membership';
  END IF;

  -- The invariant the partial unique index enforces. Belt and braces.
  IF EXISTS (SELECT project_id FROM project_members
             WHERE role = 'owner' AND deleted_at IS NULL
             GROUP BY project_id HAVING count(*) <> 1) THEN
    RAISE EXCEPTION 'ROLLBACK: a project no longer has exactly one live owner';
  END IF;

  RAISE NOTICE 'All assertions passed.';
END $$;

\echo ''
\echo '── AFTER ──────────────────────────────────────────────────────────'
SELECT p.name AS project, pm.role, pm.deleted_at IS NOT NULL AS soft_deleted
FROM project_members pm JOIN projects p ON p.id = pm.project_id
WHERE pm.user_id = :NEW ORDER BY p.name;

SELECT id, email, status, deleted_at FROM users
WHERE id IN (:OLD, :NEW) ORDER BY created_at;

COMMIT;
