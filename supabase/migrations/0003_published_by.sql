-- =============================================================================
-- 0003_published_by.sql — publish-time audit field
--
-- Records who is actually responsible for a reply reaching Google: the human
-- who approved it (carried over from the review's own approved_by at the
-- moment it was claimed for publishing), or the literal string 'auto' when
-- the deterministic policy published it without a human ever approving it
-- (status was GENERATED, not APPROVED, at claim time).
--
-- Distinct from approved_by: a review can be approved and never published,
-- or published in a different session than the one that approved it.
-- published_by is set exactly once, at the point the reply actually reaches
-- Google (or is confirmed to already be there — see the recovery path in
-- publishing.service.ts), and never changes after that.
-- =============================================================================

alter table reviews
  add column published_by text;
