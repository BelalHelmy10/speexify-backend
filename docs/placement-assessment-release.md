# Placement assessment implementation

## Current behavior

- The learner signs in before starting. Each account has a separate browser draft.
- The five stages can be visited independently. Language questions are shown four at a time.
- Answers, writing, playback counts and position are saved locally. Audio blobs are stored in IndexedDB until submission. Drafts do not sync between devices.
- Speaking can be recorded, replayed, replaced, or requested as a live coach check. A live request does not automatically schedule a session.
- Objective scoring is calculated by the API. Speaking self-ratings and writing length do not manufacture a proficiency score. CEFR remains unset until a coach reviews the evidence.
- The API validates writing limits, evidence format and size, and complete objective responses. Per-learner transaction locks prevent duplicate submissions for the same attempt ID.
- Admin summary lists omit large assessment metadata. Individual reviews include the speaking recording, selected writing task and answers.
- Existing assessment JSON fields hold submitted recordings, capped at 3 million data-URL characters. No database migration is required for this implementation.

## Verification

- Frontend: lint, typecheck, production build, style isolation.
- Browser regression: `node scripts/assessmentQa.mjs` in the frontend repository, with the local server running. Uses an isolated browser, a fake microphone and intercepted API responses; it does not write learner records to the database.
- Browser coverage: pagination; record, replace and reset; reload recorded drafts; listening pause/resume; stage navigation; mobile/tablet/desktop overflow; submission payload; reviewed results.
- Backend: unit tests and integration tests. Placement integration tests exercise the real Express route against a stubbed database boundary. They do not establish real PostgreSQL concurrency or production upload behavior.

## Work still needed before claiming a validated, adaptive placement instrument

The current objective item bank and three listening scenarios are largely retained. Audio is now mono so both participants can be heard through either earphone, with attribution retained. This is not a new listening corpus.

1. Create and coach-review a broader bank of everyday, workplace and extended-discussion listening tasks, with suitable recording rights and transcripts for reviewers. Verify every answer against the final audio. Preview transcripts must not reveal answers during the listening task.
2. Pilot the questions and samples with learners whose levels are independently assessed by coaches. Review difficulty, ambiguous distractors, completion time and agreement between reviewers.
3. Calibrate any future score-to-CEFR mapping and adaptive routing from that evidence. Keep the present coach-confirmed workflow until that work is complete.
4. Move recording bytes to private object storage with authenticated retrieval and a defined deletion policy before a high-volume rollout. The current bounded JSON storage is an interim implementation.
5. Verify an authenticated submission and coach review in staging, including the PostgreSQL transaction and the hosting proxy's request-size limits. Deploy the compatible backend before the frontend.

## Coach review

Review the actual writing and recording before assigning CEFR. Record useful feedback about message clarity, organization, language range and control, intelligibility and fluency. A monologue does not establish interaction ability; use the live conversation for turn-taking, clarification and response to follow-up questions. For a live-check request, keep placement pending until that conversation happens.
