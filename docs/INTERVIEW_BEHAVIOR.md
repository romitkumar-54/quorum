# Interview behavior

Updated 2026-09-06.

## Dynamic questions

Configured interviews use Agora's managed model. Each floor grant now includes
the shared conversation, other interviewers' questions, recent candidate claims,
the current flag, difficulty and coverage. The prompt asks one follow-up grounded
in the last answer and avoids repeating answered questions or inventing facts.

The live integration test exposed a join failure: Agora rejects a VAD silence
duration above 2000 ms. Both Agora and the browser now use the same **two-second**
pause from `INTERVIEW_LIMITS.answerSilenceMs`. Previously the invalid 4000 ms
request caused the panel to fall back to simulated questions before any agents
joined. The fallback now selects unused questions and never declares an answer
correct merely because it names a technique. A model timeout is explicitly shown
as a preset fallback in the notice.

## Redirects and shared brief

High-confidence detours and explicit evasion receive a short spoken redirect to
the pending question. Stable speech-recognition phrases can trigger this before
the candidate goes silent; speculative interim text cannot. This depends on the
browser delivering a stable phrase. Unknown answers, accents and silence are not
misconduct. A request to repeat or clarify a question is not scored as an answer.

The brief records each answer with its question. This allows a short answer such
as “From 400ms to 20ms” to retain its question's competency. Interviewer words are
never ingested as candidate evidence. Flags retain quotes and timestamps, and
distinguish open, challenged, and subsequently clarified concerns. “I built” and
“we built” alone are not contradictory. Different stages are not automatically
contradictory, and simply mentioning customers does not assert impact.

Behavior detection and assessment remain transparent rules, not a semantic LLM
grader. They cannot recognize every paraphrased detour or verify arbitrary
technical correctness. The live question model also receives the full answer and
instructions to redirect when it recognizes a detour the rules missed.

## Ending and review

- Target: at least nine answers, including two distinct relevant answers in each
  of algorithms, impact and communication. Repeated answers do not add coverage.
- Hard limits: twelve answers or fifteen minutes.
- Inactivity: two minutes without speech or typing activity while the panel is
  waiting for an answer. Time spent waiting for the panel is excluded.
- The End button or “Please end the interview” closes immediately.

At completion no further question is generated. The report appears, the
microphone stops, and the app calls leave for every owned agent. Cleanup is
retried and a failure is exposed with a retry control; starting another session
is disabled until cleanup succeeds. Page-close cleanup remains best-effort.
These browser timers do not guarantee cleanup after a crashed browser/server;
durable server-side expiry would require a deployed scheduler or lease service.

Only candidate answers contribute to rubric scores. Questions identify the
area being asked, but their techniques, numbers and reasoning earn no credit.
Irrelevant or evasive responses supply no evidence for the pending question.
Untested areas remain unassessed and do not receive invented scores. The report
includes supporting quotes, improvement gaps and concerns still needing
clarification. Scores describe evidence quality, not independently verified
correctness or a hiring recommendation.

## Verification

`npm test` runs the offline regression suite; `npx tsc --noEmit` checks types
after Next has generated route types. `npm run build` verifies production output.

`tests/liveAgora.test.ts` is opt-in (`QUORUM_LIVE_TEST=1`) and targets a local
server on port 3000. It creates three billable agents, so run it only with an
authorized testing budget. It checks questions across Technical and Product,
redirects an unrelated answer, and requests cleanup in `finally` with retries.
It passed against the live service on 2026-09-06 with cleanup confirmed. It tests
the control plane, not acoustic microphone capture or human barge-in.
