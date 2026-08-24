-- =============================================================================
-- 0002_hardening.sql — Phase 5 hardening pass
--
-- 1. human_review_required: a sticky version of needs_human_review.
--
--    needs_human_review is overwritten by every generation attempt with
--    whatever that attempt's model output + keyword scan concluded. That is
--    fine as an audit signal, but the publishing decision was reading it
--    directly — so a regenerate that happens to get a rosier model opinion
--    the second time around could erase a risk flag the *first* attempt
--    raised, and move a review out of the human queue with nobody having
--    reviewed it. human_review_required only ever moves false -> true; once
--    a review earns a human review, no later regeneration can unset it. The
--    backfill below seeds it from the existing signal so already-flagged
--    reviews don't lose their flag on deploy.
-- =============================================================================

alter table reviews
  add column human_review_required boolean not null default false;

update reviews
  set human_review_required = true
  where needs_human_review = true;
