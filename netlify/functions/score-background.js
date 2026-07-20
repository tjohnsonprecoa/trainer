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
      transcript, dispositionReported, dispositionNotesText, notesPhotoUrl, moduleId, leadSource,
      dispositionFormJson, tier, difficultyLevel, fhName, afpName,
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
TIER: ${tier || 'unknown'} (1 = fundamentals/easy, 2 = moderate, 3 = hard)
ROLLED DIFFICULTY THIS ATTEMPT: ${difficultyLevel || difficulty || 'unknown'} on a 1-9 scale (1-2 easy band, 3-5 moderate band, 6-9 hard band) — the AI persona's guardedness and scheduling bar were set to this level for this specific attempt, so calibrate your leniency to THIS number, not just the tier
PASS THRESHOLD: ${passThreshold}/10
CALL CONTEXT: The rep was assigned to call as a representative of "${fhName || 'unknown funeral home'}" and to reference an advisor named "${afpName || 'unknown'}" — as part of script adherence, check whether they actually introduced themselves with that funeral home's name and used that advisor's name when proposing the appointment.

Score the rep primarily on HOW they ran the call, not just whether they landed an appointment. Getting an appointment matters much less than doing these things well:
1. CONVERSATION QUALITY — did they sound natural, unhurried, and genuinely present, rather than robotic, scripted-sounding, or rushed?
2. SCRIPT ADHERENCE — did they generally follow a sensible call structure (introduce themselves and the funeral home, ask about the prospect's motivation/reason for reaching out, explain the Final Wishes Organizer, then propose a specific appointment with an advisor) rather than skipping steps or jumping straight to an ask?
3. QUESTION QUALITY — did they ask good, specific, meaningful follow-up questions that build real value and show they were actually listening, rather than just reciting lines or asking generic/shallow questions?
4. APPOINTMENT QUALITY — ONLY if an appointment was scheduled: did the rep actually confirm ALL of the following before ending the call? (a) a specific date/day AND time, (b) the address where it will happen (if it's a home visit, not the funeral home itself), (c) a phone number, (d) who will be attending — including asking about a spouse/partner and getting their name if one exists, and (e) clearly setting the expectation that this is a real meeting about pre-planning (roughly an hour, substantive) and NOT framed as a quick drop-off or errand. A "scheduled" appointment that's missing several of these is a LOW-QUALITY outcome, even though it counts as appointment_scheduled=true — score it accordingly. If no appointment was scheduled (callback or decline instead), set appointment_quality_score to null — this dimension doesn't apply.

An appointment scheduled after doing all four of these well is a strong outcome. An appointment "scheduled" because the AI persona just gave in easily, because the rep rushed to ask without earning it, or because the rep got a "yes" but never nailed down the actual logistics, should NOT score well — those are false positives the real world won't reward (a rep who "gets" appointments that then fall through because half the details were never confirmed is not actually succeeding). Likewise, a call that does NOT end in a full appointment but where the rep had a genuinely good conversation, stayed roughly on script, and asked good questions can still score reasonably — that's a rep doing the right things against a tough or unconvinced prospect, which is exactly what these harder-tier modules are for. IMPORTANT: a callback (rather than a firm appointment) is a legitimate, ACCEPTABLE outcome when the rep did a reasonable-but-not-exceptional job — do not treat "no appointment, callback instead" as an automatic failure or score it harshly just because it isn't a full appointment; judge it on how the rep actually ran the call.

Score generously for easy (tier 1) personas — these are intentionally easy "smokescreen" objections meant for reps to build fundamentals, so a rep who competently runs the script (introduces themselves, asks about motivation, explains the FWO, proposes an appointment, gives any reasonable response to the objection) should score well even without deep discovery questions — BUT appointment quality (confirming date/time, address, phone, attendee/spouse info, correct framing) still fully applies at every tier, including tier 1. Easy objection-handling does not excuse sloppy appointment-setting. Hold a meaningfully higher bar for tier 2/3 personas on conversation/script/question quality specifically.

SECOND, separately, grade the rep's CALL RESULT ACCURACY — how well they logged the outcome of this call in their planner app afterward:
- The rep reported the disposition as: "${dispositionLabel}"
- The rep's free-text note on how it went: "${dispositionNotesText || '(none provided)'}"
- The COMPLETE form the rep filled out afterward (every field they logged): ${dispositionFormJson ? JSON.stringify(dispositionFormJson) : '(no structured form data)'}
  Compare EVERY field in that form against the transcript: does the logged day/time match what was agreed on the call? Does the logged spouse name match the name that came up? Does the logged email match what the prospect gave? Does the attendee info match what was actually discussed? Fields that contradict the transcript, or fields left empty when the information WAS discussed on the call, both count against disposition_match_score.
- A photo of the notes they took during the call is attached${imageBlock ? '' : ' (none was provided or it could not be loaded)'}.

Compare all of this against what ACTUALLY happened in the transcript. New hires often over-report positive outcomes, under-document key details (family name, callback time, specific objection raised), or file a disposition that doesn't match reality. Grade disposition_match_score 1-10: 10 = disposition and notes are accurate and complete relative to the transcript; low scores = mismatch (e.g. logged "Appointment Set" but no appointment was actually confirmed) or notes missing details that were clearly stated on the call (names, dates, callback times, specific objections).

THIRD, check for these nine specific RED FLAGS — situations worth a manager's attention, even if the rep thinks the call went well:

RED FLAG 1 — scheduled despite an existing real plan: If the prospect indicated they're "already taken care of" or already have a plan, look closely at what that actually turned out to mean once (if) the rep clarified it. If the transcript shows the prospect is ALREADY making payments toward an actual pre-arranged plan with a real funeral home (not just a will and/or a life insurance policy, which is a common false alarm and NOT this red flag), and the rep still scheduled an appointment without properly recognizing that this family is already genuinely covered, set red_flag_has_plan to true. If the rep correctly identified it was just a will/life insurance mix-up (the common case) and proceeded normally, or if the rep never got a "has plan" objection at all, set it to false.

RED FLAG 2 — Veterans Memorial Program appointment with no pre-planning discussion: This call's lead source is "${leadSource === 'veterans' ? 'Veterans Memorial Program' : (leadSource || 'not specified')}". If the lead source is Veterans Memorial Program AND an appointment was scheduled AND the entire conversation only covered veteran/VA burial benefits information and never actually discussed funeral pre-planning itself (the actual product), set red_flag_vmp_benefits_only to true. If pre-planning was discussed at any point, or no appointment was scheduled, or the lead source isn't Veterans Memorial Program, set it to false.

RED FLAG 3 — appointment stated as under an hour: If the topic of how long the appointment will take came up in the conversation (the persona was instructed to usually ask this once scheduling is being discussed) and the rep stated or clearly implied a duration under one hour, set red_flag_short_appointment to true. If duration never came up, or the rep correctly said around an hour or didn't specify a shorter time, set it to false.

RED FLAG 4 — no email captured/verified: ONLY evaluate this if an appointment was scheduled. If the rep never asked for the prospect's email address and read it back or otherwise confirmed it during the call, set red_flag_no_email_verification to true. If they did, or no appointment was scheduled at all, set it to false.

RED FLAG 5 — no address verified: ONLY evaluate this if an appointment was scheduled. If the appointment involves visiting the prospect (not at the funeral home), and the rep never confirmed/read back the specific address where the appointment will take place, set red_flag_no_address_verification to true. If they did confirm it, the appointment is at the funeral home itself (no home address to verify), or no appointment was scheduled, set it to false.

RED FLAG 6 — undersold the appointment: If the rep used language that trivializes or rushes the appointment's significance — e.g. "I'll just drop by," "it'll be real quick," "won't take long," "no big deal" — set red_flag_undersold_appointment to true, regardless of what duration (if any) was stated. If the rep spoke about the appointment in a way that reflected its actual importance, set it to false.

RED FLAG 7 — spouse status never established: Every call should surface whether this info/interest was for the lead alone or included a spouse/family member — normally via the standard opening question (e.g. "was that just for you, or another family member as well?"), but it's just as valid if the prospect volunteers this unprompted without being asked. Set red_flag_spouse_never_asked to true ONLY if this was never established in the conversation AT ALL — neither the rep asking nor the prospect volunteering it. If it came up in any way, by anyone, set it to false. Do not penalize the rep for not asking something the prospect already answered unprompted.

RED FLAG 8 — spouse attendance never confirmed: ONLY evaluate if the transcript establishes the lead has a spouse/partner (whether the prospect volunteered this or the rep asked and found out) AND an appointment was scheduled. Set red_flag_spouse_attendance_not_asked to true ONLY if whether the spouse will attend the appointment was never established in the conversation at all. If the prospect volunteered that the spouse would (or wouldn't) attend without being asked, that counts as confirmed — set it to false. Only set it true if this genuinely never came up by any means. If there's no indication of a spouse, or no appointment was scheduled, set it to false.

RED FLAG 9 — spouse name never captured: ONLY evaluate if the transcript establishes the lead has a spouse/partner. Set red_flag_spouse_name_not_captured to true ONLY if the spouse's name was never mentioned anywhere in the conversation by anyone. If the prospect said the spouse's name unprompted (e.g. "my husband Gary will be there"), that counts as captured just as much as if the rep had asked for it — set it to false in that case. Only set it true if the name genuinely never came up at all. If there's no indication of a spouse, set it to false.

If any red flag is true, explain specifically why in red_flag_notes (quote the relevant part of the transcript if possible) — if multiple are true, cover each briefly. If none apply, red_flag_notes can be an empty string.

SCORE CAPPING (mandatory — read carefully: red flags are NOT all equally severe, and the cap that applies depends on WHICH ones are true):

MAJOR red flags — these mean the appointment itself is compromised: wrong purpose, wrong expectations set, or the family is genuinely already covered. These still cap the score hard: red_flag_has_plan, red_flag_vmp_benefits_only, red_flag_short_appointment, red_flag_undersold_appointment.
- If exactly ONE major red flag is true, overall_score cannot exceed 6.0, regardless of how good conversation quality/script adherence/question quality were.
- If TWO OR MORE major red flags are true, overall_score cannot exceed 4.5.

MINOR/PROCEDURAL red flags — these are genuine coaching opportunities (a rep should build the habit of nailing every logistics detail every time) but they are administrative completeness misses, not a sign the call itself went poorly. They must NOT, by themselves, prevent an otherwise strong call from passing: red_flag_no_email_verification, red_flag_no_address_verification, red_flag_spouse_never_asked, red_flag_spouse_attendance_not_asked, red_flag_spouse_name_not_captured.
- If ONLY minor flags are present (no major flag is true), deduct roughly 0.5-1.5 points from what the score would otherwise be — more if several are missing at once — but do NOT apply a hard ceiling below ${passThreshold} (this module's pass threshold). A rep who ran a genuinely good, well-handled conversation and simply forgot to read back an email should still be able to pass. Still flag it clearly in red_flag_notes and make it one of the improvements/coaching points so the habit gets built — just don't let one logistics slip fail an otherwise strong call.
- If BOTH major and minor flags are present on the same call, the MAJOR cap above applies (it's the more restrictive rule) — minor flags don't stack an additional cap on top of it.

APPOINTMENT QUALITY CAP: if an appointment was scheduled and appointment_quality_score is below 5, overall_score cannot exceed 5.5, even with zero red flags — a low-quality appointment (missing date/time, address, phone, attendee info, or wrongly framed as quick/drop-off) is itself a real problem, not a footnote.

These caps are ceilings, not targets — if the rest of the call also had real issues, score below the cap accordingly. Never let a high conversation-quality or objection-handling score offset major red flags or poor appointment quality into an inflated overall_score.

IMPROVEMENTS & COACHING TIP — THINK LIKE AN EXPERIENCED SALES TRAINER, not a compliance checklist. The red flags and appointment-quality checks above already cover logistics/procedural misses (email, address, spouse info, appointment framing/duration) — do not just restate those in "improvements" and "coaching_tip" as if they were the main lesson from the call. Instead, evaluate the rep's actual SALES SKILL across these three dimensions, the way a real sales trainer listening to this call would:

1. OBJECTION HANDLING — did the rep genuinely address the underlying concern behind the objection, or just talk past it / recite a rebuttal that would've worked on any objection? Look for whether they acknowledged what the prospect actually said, asked a clarifying question to find the real concern underneath, and responded to THAT specific concern.
2. VALUE BUILDING — before asking for the appointment, did the rep build a genuine, specific reason FOR pre-planning (peace of mind, protecting family from decisions/cost during grief, locking in today's price, etc.) tailored to something this particular prospect said — or did they rush straight to the ask without earning it?
3. QUESTION QUALITY — were the rep's questions open-ended and building on the prospect's own words (real evidence of listening), or generic/closed/scripted regardless of what the prospect just said?

At least one "improvements" item and the "coaching_tip" should be a specific, actionable coaching point drawn from one of these three sales-skill areas — quote or closely paraphrase the actual moment in the transcript, and say exactly what the rep could have said or asked instead. Only fall back to a logistics/checklist item (email, address, spouse info, appointment framing) as the PRIMARY coaching focus if there's genuinely nothing more substantive to improve on across all three sales-skill areas above on this particular call. Likewise, when a rep does one of these three well, call it out specifically in "strengths" by naming the actual technique and where it showed up — not a vague compliment like "good rapport" or "stayed positive."

COACHING TIP SHORT: also write a one-sentence, STANDALONE version of the same advice — under 15 words, no quotes from the call, no references that only make sense with context (never start with "at the moment..." or "when X said..."). It must read as a complete, self-contained tip on its own, like "Ask what would happen to their family if this wasn't handled" or "Confirm the spouse's name before ending the call" — something someone could read with zero context and immediately understand and act on. This is used in a short digest list, so it can never be a fragment of the longer coaching_tip.

APPOINTMENT LENGTH (important): Real appointments with an advisor run about an hour. NEVER suggest, recommend, or praise offering a shorter appointment (e.g. "offer a quick 15-20 minute meeting to make it easier to schedule") anywhere in strengths, improvements, or coaching_tip — that is not a legitimate technique and should never appear as advice. If the rep themselves offered a shortened appointment time as a tactic during the call, that's worth noting as something to fix in improvements, not as something that worked.

Respond with ONLY this JSON object, no markdown fences, no preamble:
{"overall_score":<1.0-10.0>,"passed":<bool, true if overall_score >= ${passThreshold}>,"appointment_scheduled":<bool>,"objection_handled":<bool>,"conversation_quality_score":<1-10>,"script_adherence_score":<1-10>,"question_quality_score":<1-10>,"appointment_quality_score":<1-10 or null if no appointment was scheduled>,"strengths":"<thing1>|<thing2>|<thing3>","improvements":"<fix1>|<fix2>|<fix3>","key_moment":"<the single pivot point in the call, quote if possible>","coaching_tip":"<specific to this exact call: what to say/ask differently at the actual moment it mattered, plus one concrete skill to practice>","coaching_tip_short":"<under 15 words, standalone, no quotes/context needed>","disposition_match_score":<1-10>,"disposition_feedback":"<specific comparison: what they logged vs. what actually happened, and what a complete/accurate note would have included>","red_flag_has_plan":<bool>,"red_flag_vmp_benefits_only":<bool>,"red_flag_short_appointment":<bool>,"red_flag_no_email_verification":<bool>,"red_flag_no_address_verification":<bool>,"red_flag_undersold_appointment":<bool>,"red_flag_spouse_never_asked":<bool>,"red_flag_spouse_attendance_not_asked":<bool>,"red_flag_spouse_name_not_captured":<bool>,"red_flag_notes":"<explanation if any flags are true, else empty string>","verdict":"<12-18 word summary of the whole attempt>"}`;

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
        max_tokens: 4096,
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

    // stop_reason === 'max_tokens' means Claude's response was cut off before
    // it finished — this is the most likely reason start/end come back
    // pointing at an incomplete object (or no closing brace at all). Surfacing
    // this distinctly (rather than the old generic "invalid JSON") means if
    // it ever happens again, the error itself tells you to raise max_tokens
    // further rather than making you guess.
    if (start === -1 || end === -1) {
      const reason = data.stop_reason === 'max_tokens'
        ? 'AI response was cut off (hit max_tokens) before completing the JSON — try raising max_tokens further'
        : 'AI returned invalid JSON (no JSON object found in response)';
      await sbPatch('trainer_score_jobs', jobId, { status: 'error', error: reason });
      if (attemptId) await sbPatch('training_attempts', attemptId, { status: 'error', error: reason });
      return;
    }

    let result;
    try {
      result = JSON.parse(clean.slice(start, end + 1));
    } catch (parseErr) {
      // The braces were found but the content between them didn't parse —
      // this really is malformed JSON (as opposed to simple truncation above).
      // Still worth flagging stop_reason here too, since a truncation that
      // happens to cut off mid-field (rather than before the final brace)
      // would also land in this branch.
      const reason = data.stop_reason === 'max_tokens'
        ? `AI response was cut off (hit max_tokens) mid-JSON: ${parseErr.message}`
        : `AI returned invalid JSON: ${parseErr.message}`;
      await sbPatch('trainer_score_jobs', jobId, { status: 'error', error: reason });
      if (attemptId) await sbPatch('training_attempts', attemptId, { status: 'error', error: reason });
      return;
    }

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
