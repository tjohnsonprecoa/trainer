// Background function — scores a completed role-play call.
// Two things get graded in one Claude call:
//   1. The role-play performance itself (reuses CallIQ's rubric style/voice)
//   2. How the rep dispositioned the call afterward — does what they logged
//      (disposition_reported + the photo of their planner-app notes) match
//      what actually happened on the transcript?
//
// Named with -background so Netlify runs it async with up to 15 min timeout,
// same pattern as CallIQ's score-background.js.

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
const SB_URL        = 'https://nbifzxzpcxchrwdcblyu.supabase.co';
const SB_KEY        = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iaWZ6eHpwY3hjaHJ3ZGNibHl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MTE3MjQsImV4cCI6MjA5NTQ4NzcyNH0.Nt5YbYLYdEdtbHu5fwrY8XTqhyNaP0Cz1LadnE67A8E';

const DISPOSITION_LABELS = {
  appointment_set: 'Appointment Set',
  callback_scheduled: 'Callback Scheduled',
  not_interested: 'Not Interested',
  no_answer: 'No Answer / Voicemail',
  send_info_only: 'Info Requested, No Appointment',
  do_not_call: 'Do Not Call',
  other: 'Other',
};

async function sbPatch(table, id, data) {
  await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

async function upsertProgress(repId, team, moduleId, passed, score) {
  // Read existing row (if any)
  const getRes = await fetch(
    `${SB_URL}/rest/v1/trainee_progress?rep_id=eq.${encodeURIComponent(repId)}&module_id=eq.${moduleId}&select=*`,
    { headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY } }
  );
  const rows = await getRes.json().catch(() => []);
  const existing = rows[0];

  const attempts = (existing?.attempts || 0) + 1;
  const bestScore = existing?.best_score != null ? Math.max(existing.best_score, score) : score;
  const status = passed ? 'passed' : 'in_progress';

  if (existing) {
    await fetch(`${SB_URL}/rest/v1/trainee_progress?id=eq.${existing.id}`, {
      method: 'PATCH',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status, attempts, best_score: bestScore, last_attempt_at: new Date().toISOString(), team }),
    });
  } else {
    await fetch(`${SB_URL}/rest/v1/trainee_progress`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ rep_id: repId, team, module_id: moduleId, status, attempts, best_score: bestScore, last_attempt_at: new Date().toISOString() }),
    });
  }
  // Note: unlocking the next tier is computed client-side (readiness map compares
  // each category's tier-1 module status against the next tier) — no need to
  // pre-create a trainee_progress row for it here, unlike the old linear-path version.
}

exports.handler = async (event) => {
  let jobId, attemptId;
  try {
    const body = JSON.parse(event.body);
    jobId = body.jobId;
    attemptId = body.attemptId;
    const {
      repId, team, moduleTitle, objectionType, difficulty, passThreshold,
      transcript, dispositionReported, dispositionNotesText, notesPhotoUrl, moduleId,
    } = body;

    if (!jobId || !transcript) return;

    // Fetch + base64-encode the notes photo (if provided) so Claude can see it directly.
    let imageBlock = null;
    if (notesPhotoUrl) {
      try {
        const imgRes = await fetch(notesPhotoUrl);
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
          imageBlock = {
            type: 'image',
            source: { type: 'base64', media_type: contentType, data: buf.toString('base64') },
          };
        }
      } catch (e) {
        // Non-fatal — score without the photo, note it in feedback via missing_notes_photo flag below.
      }
    }

    const dispositionLabel = DISPOSITION_LABELS[dispositionReported] || dispositionReported || 'Not reported';

    const systemPrompt = `You are a training supervisor for FPC (a pre-planning phone sales team) grading a NEW HIRE'S role-play practice call against an AI-played prospect.

MODULE: ${moduleTitle}
OBJECTION TYPE: ${objectionType}
DIFFICULTY: ${difficulty}
PASS THRESHOLD: ${passThreshold}/10

Score the rep primarily on HOW they ran the call, not just whether they landed an appointment. Getting an appointment matters much less than doing these things well:
1. CONVERSATION QUALITY — did they sound natural, unhurried, and genuinely present, rather than robotic, scripted-sounding, or rushed?
2. SCRIPT ADHERENCE — did they generally follow a sensible call structure (introduce themselves and the funeral home, ask about the prospect's motivation/reason for reaching out, explain the Final Wishes Organizer, then propose a specific appointment with an advisor) rather than skipping steps or jumping straight to an ask?
3. QUESTION QUALITY — did they ask good, specific, meaningful follow-up questions that build real value and show they were actually listening, rather than just reciting lines or asking generic/shallow questions?

An appointment scheduled after doing these three things well is a strong outcome. An appointment "scheduled" because the AI persona just gave in easily, or because the rep rushed to ask without earning it, should NOT score well — that's a false positive the real world won't reward. Likewise, a call that does NOT end in an appointment but where the rep had a genuinely good conversation, stayed roughly on script, and asked good questions can still score reasonably — that's a rep doing the right things against a tough or unconvinced prospect, which is exactly what these harder-tier modules are for.

Score generously for easy (tier 1) personas — these are intentionally easy "smokescreen" objections meant for reps to build fundamentals, so a rep who competently runs the script (introduces themselves, asks about motivation, explains the FWO, proposes an appointment, gives any reasonable response to the objection) should score well even without deep discovery questions. Hold a meaningfully higher bar for tier 2/3 personas, where genuinely good, specific discovery questions and a natural conversation are what separates a pass from a fail. At every tier, the THING you're grading is conversation quality, script adherence, and question quality (calibrated to what's realistic for that tier), not just the binary appointment outcome.

SECOND, separately, grade the rep's DISPOSITION ACCURACY — how well they logged the outcome of this call in their planner app afterward:
- The rep reported the disposition as: "${dispositionLabel}"
- The rep's free-text note on how it went: "${dispositionNotesText || '(none provided)'}"
- A photo of the notes they took during the call is attached${imageBlock ? '' : ' (none was provided or it could not be loaded)'}.

Compare all of this against what ACTUALLY happened in the transcript. New hires often over-report positive outcomes, under-document key details (family name, callback time, specific objection raised), or file a disposition that doesn't match reality. Grade disposition_match_score 1-10: 10 = disposition and notes are accurate and complete relative to the transcript; low scores = mismatch (e.g. logged "Appointment Set" but no appointment was actually confirmed) or notes missing details that were clearly stated on the call (names, dates, callback times, specific objections).

Respond with ONLY this JSON object, no markdown fences, no preamble:
{"overall_score":<1.0-10.0>,"passed":<bool, true if overall_score >= ${passThreshold}>,"appointment_scheduled":<bool>,"objection_handled":<bool>,"conversation_quality_score":<1-10>,"script_adherence_score":<1-10>,"question_quality_score":<1-10>,"strengths":"<thing1>|<thing2>|<thing3>","improvements":"<fix1>|<fix2>|<fix3>","key_moment":"<the single pivot point in the call, quote if possible>","coaching_tip":"<one concrete drill for next time>","disposition_match_score":<1-10>,"disposition_feedback":"<specific comparison: what they logged vs. what actually happened, and what a complete/accurate note would have included>","verdict":"<12-18 word summary of the whole attempt>"}`;

    const userContent = [
      { type: 'text', text: `ROLE-PLAY TRANSCRIPT:\n${transcript}` },
    ];
    if (imageBlock) {
      userContent.push({ type: 'text', text: 'PHOTO OF NOTES TAKEN DURING THE CALL:' });
      userContent.push(imageBlock);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      const errMsg = data.error?.message || `API error ${response.status}`;
      await sbPatch('trainer_score_jobs', jobId, { status: 'error', error: errMsg });
      if (attemptId) await sbPatch('training_attempts', attemptId, { status: 'error', error: errMsg });
      return;
    }

    const raw = data.content?.[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      await sbPatch('trainer_score_jobs', jobId, { status: 'error', error: 'AI returned invalid JSON' });
      if (attemptId) await sbPatch('training_attempts', attemptId, { status: 'error', error: 'AI returned invalid JSON' });
      return;
    }

    const result = JSON.parse(clean.slice(start, end + 1));

    await sbPatch('trainer_score_jobs', jobId, { status: 'done', result_json: result });

    if (attemptId) {
      await sbPatch('training_attempts', attemptId, {
        status: 'done',
        overall_score: result.overall_score,
        passed: !!result.passed,
        result_json: result,
        disposition_match_score: result.disposition_match_score,
        disposition_feedback: result.disposition_feedback,
      });
    }

    if (repId && moduleId) {
      await upsertProgress(repId, team, moduleId, !!result.passed, result.overall_score).catch(() => {});
    }

  } catch (err) {
    if (jobId) await sbPatch('trainer_score_jobs', jobId, { status: 'error', error: err.message }).catch(() => {});
    if (attemptId) await sbPatch('training_attempts', attemptId, { status: 'error', error: err.message }).catch(() => {});
  }
};
