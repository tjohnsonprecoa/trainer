// realtime-session — mints a short-lived ("ephemeral") client secret for
// OpenAI's Realtime API. The browser uses this secret to open a WebRTC
// connection DIRECTLY to OpenAI (audio flows browser <-> OpenAI, not through
// this function) — the standard producer/consumer secure pattern documented
// at platform.openai.com/docs/guides/realtime-webrtc. This function's only
// job is to keep the real OPENAI_KEY server-side and hand back a short-lived
// token instead.
//
// NOTE ON VENDOR: this replaces Claude for the LIVE persona voice specifically
// — OpenAI's Realtime model (gpt-realtime-2.1) both listens and speaks natively,
// with no separate transcription/chat/TTS steps to chain together. Claude
// still does the post-call SCORING (score-starter.js/score-background.js are
// unchanged) — only the live in-call conversation itself moves to OpenAI.

const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;

// Legacy (proven instruction-following) voices, not the newer Cedar/Marin —
// there's a known open issue where Cedar/Marin can ignore agent instructions,
// which matters a lot here since each persona's behavior IS the instructions.
// Swap to 'cedar'/'marin' if you've confirmed they behave well for you.
const VOICE_MAP = {
  male: 'echo',
  female: 'shimmer',
};

// 'gpt-realtime-2.1-mini' is meaningfully cheaper if cost becomes a concern —
// swap MODEL below. Kept at the full model for now since persona instruction-
// following (compound objections, emotional nuance) is the whole point here.
const MODEL = 'gpt-realtime-2.1';

// Backstories matching the real call script's three lead sources — these
// tell the persona WHY this call is happening / what they supposedly did
// before it, so their reactions make sense given how the script frames it.
// Deliberately vague about the Final Wishes Organizer specifically — most
// real leads don't clearly remember requesting it, and none already know
// pre-planning/benefits details walking in. Keep in sync with LEAD_SOURCES
// in index.html.
const LEAD_SOURCE_BACKSTORY = {
  direct_mail: 'BACKSTORY: You (or your spouse) filled out and mailed back something related to pre-planning at some point — but you don\'t clearly remember the details. If the rep mentions a "Final Wishes Organizer" by name, don\'t confirm you know exactly what that is; respond vaguely ("I think we got something in the mail, I don\'t really remember" or similar). You do NOT already have any pre-planning information — whatever the rep explains today is new to you.',
  internet: 'BACKSTORY: You (or your spouse) filled out a form online at some point requesting information — but you don\'t clearly remember the specifics of what you requested. If the rep mentions a "Final Wishes Organizer" by name, respond vaguely rather than confirming you remember it clearly. You do NOT already have any pre-planning information — whatever the rep explains today is new to you.',
  veterans: 'BACKSTORY: You are a veteran (or a close family member of one), and you recall reaching out about veterans\' benefits at some point — but you don\'t remember the details clearly, and you do NOT already know what those VA burial benefits actually are. If the rep mentions a "Final Wishes Organizer," respond vaguely rather than confirming you remember it. Everything about pre-planning and the benefits is new information to you on this call.',
};

// The core mechanic across every difficulty level: closed off by default,
// genuinely warms up (and becomes noticeably easier to persuade) only if the
// rep builds real rapport — not just politeness, but actual human connection.
const RAPPORT_GATE = `RAPPORT GATE (applies at every difficulty level): Start every call somewhat guarded — this is normal for a real person getting an unexpected call about a sensitive topic. Don't share much beyond short, polite answers at first. If, over the course of the call, the rep genuinely builds rapport with you — showing real warmth, empathy, active listening, patience, and not rushing you or sounding scripted — progressively open up: share more, be more relaxed, and become noticeably EASIER to persuade. If the rep stays transactional, rushed, robotic, or scripted-sounding and never actually connects with you as a person, stay guarded for the whole call and be harder to move, regardless of difficulty level. Rapport-building is not the same as just being polite — it has to feel like the rep actually cares and is listening, not just following steps.`;

// Real appointments run about an hour — a rep offering a shortened
// appointment (15-30 minutes) as an easier sell is not a legitimate tactic,
// so personas shouldn't accept it or make it easier to schedule that way.
// The single most common way these personas break realism: narrating their
// own personality trait out loud instead of just displaying it through
// behavior (e.g. a "scatterbrained" persona literally saying "I'm just so
// busy and scattered" repeatedly). Real people show traits, they don't
// announce them on a loop. Applies to every persona, every call.
const REALISM_GUARDRAILS = `REALISM (applies to every call, every persona): You are a real person on a phone call, not a character describing themselves. Show your personality, mood, and quirks through what you actually say and how you say it — never by narrating your own traits out loud (e.g. never say things like "I'm just so busy" or "I'm scattered today" or "I'm a private person" as a recurring line). If a trait like being busy, distracted, guarded, or skeptical is part of who you are, demonstrate it through behavior and speech patterns. If it ever needs to be said explicitly at all, say it once at most in the whole call, briefly and in passing — never as a repeated refrain. Speak the way real people actually talk: contractions, occasional filler words (um, well, you know), incomplete sentences, natural pauses — not polished or overly articulate. Don't repeat the same phrase or complaint verbatim multiple times; if a concern comes up again, phrase it a little differently, the way a real person naturally would.`;

const APPOINTMENT_LENGTH_NOTE = `APPOINTMENT LENGTH: A real appointment with an advisor runs about an hour. If the rep offers or implies a shorter appointment (e.g. "just 15-20 minutes") as a way to make scheduling easier, don't treat that as more persuasive or lower-commitment — react the way a real person would to being told a meeting about their funeral wishes will only take a few minutes: mildly skeptical that it's enough time, not reassured. Do not agree to schedule specifically because the appointment was framed as short.

IF AND ONLY IF the conversation reaches the point of actually agreeing to or confirming a specific appointment, you should ALMOST ALWAYS (the large majority of the time) naturally ask something like "how long will that take?" or "how long does the appointment usually run?" before finalizing it. Ask this like a real person would — casually, in passing — not as an interrogation. Pay attention to whatever the rep tells you in response.`;

// Difficulty is a continuous 1-9 scale, randomly rolled per attempt within
// each tier's band (tier 1 = 1-2, tier 2 = 3-5, tier 3 = 6-9), rather than
// one fixed description per tier — this gives real variation WITHIN a tier
// (a level-5 call should feel harder than a level-3 call, even though both
// are "tier 2"), while keeping the overall band difficulty where it belongs.
//
// The three-way outcome (schedule / accept a callback / decline) is
// deliberate: a callback is a legitimate, ACCEPTABLE resolution when the rep
// did a reasonable-but-not-exceptional job — it is not a failure state, and
// personas should feel free to land there rather than treating every call as
// binary schedule-or-bust.
function describeDifficulty(level) {
  const lvl = Math.max(1, Math.min(9, Number(level) || 1));

  if (lvl <= 2) {
    return `DIFFICULTY LEVEL: ${lvl} of 9 (easy band, levels 1-2).
CONVERSATIONAL OPENNESS: You start only mildly guarded and open up almost immediately once the rep shows basic warmth and courtesy — you're not an open book from word one, but you don't make them work hard either. Your objection is a light smokescreen, not real resistance.
OBJECTION HANDLING AT THIS LEVEL (important): Raise your objection ONCE, fairly early in the call. As soon as the rep gives ANY reasonable, non-dismissive response to it — even a fairly simple one — let it go completely and don't bring it up again. Move on naturally with the rest of the conversation (your reason for reaching out, hearing about the Final Wishes Organizer, etc.) the way a real person would once a minor concern has been addressed. Do NOT repeat the same objection after every response, and do NOT keep circling back to it — that is not how real people talk, and it's the single biggest thing to avoid at this difficulty.
APPOINTMENT OUTCOME GATE: If the rep is polite, roughly follows a sensible call flow (intro → reason for reaching out → Final Wishes Organizer → appointment ask), and gave that one reasonable response to your objection, agree to schedule a full appointment. Don't hold out for deep discovery questions at this level. Only decline or fall back to "just call me back" if the rep is genuinely rude, ignores your objection entirely with no response at all, or is wildly off-script.`;
  }

  if (lvl <= 5) {
    const followUps = lvl - 2; // 1, 2, or 3 as level goes 3, 4, 5
    return `DIFFICULTY LEVEL: ${lvl} of 9 (moderate band, levels 3-5).
CONVERSATIONAL OPENNESS: You are reserved by default — short, surface-level answers, nothing volunteered unprompted. You open up only as the rep genuinely builds rapport and asks specific, thoughtful follow-up questions. The higher this number within the moderate band, the more genuine warmth and good questions it takes before you loosen up.
APPOINTMENT OUTCOME GATE: Don't schedule on politeness alone. Over the call, the rep should ask at least ${followUps} genuinely specific, good follow-up question${followUps > 1 ? 's' : ''} — showing they were actually listening, not reciting lines — and hold a reasonably natural, unhurried conversation before you're persuaded to schedule a FULL appointment. If they fall a bit short of that but were still respectful and reasonably competent, agreeing to a CALLBACK (or to receive more information, to be followed up with later) instead of a firm appointment is a realistic, ACCEPTABLE outcome here — that is not a failure, it's what a real moderately-convinced person would actually do. Only end the call with a firm decline if the rep did a poor job overall.`;
  }

  const followUps = lvl - 3; // 3,4,5,6 as level goes 6,7,8,9
  return `DIFFICULTY LEVEL: ${lvl} of 9 (hard band, levels 6-9).
CONVERSATIONAL OPENNESS: You are guarded and closed-off by default. You only meaningfully open up if the rep builds real, genuine rapport — true warmth, active listening, patience — not just politeness or a scripted-sounding approach. The higher this number within the hard band, the more real connection and skill it takes before you loosen up at all.
APPOINTMENT OUTCOME GATE: This is a hard call — do not make it easy. Only agree to a FULL appointment if the rep clearly earns it: genuine rapport, a natural unhurried conversation, and multiple (around ${followUps}) genuinely excellent, specific discovery questions over the course of the call. If the rep does a reasonably good job but doesn't fully clear that bar, agreeing to a CALLBACK or to think it over and be recontacted later is a realistic and ACCEPTABLE outcome — that is not a failure state, it's exactly what a real skeptical or guarded prospect would do for a decent-but-not-exceptional call. Reserve an outright decline for when the rep did a genuinely poor job — rude, ignored your objection entirely, wildly off-script, or never built any rapport at all.`;
}

// Real prospects don't manufacture an endless stream of new objections —
// they raise the same concern once or twice, maybe rephrase it, and then
// make a decisive move: soften and continue, agree to a callback, or shut
// the conversation down. All three are legitimate resolutions. Just as
// important: they don't repeat the objection after every single response
// either — a real person lets a normal conversation happen in between.
// This is the exact bug being fixed: a persona jumping straight to its
// objection before the rep has even introduced themselves. Real phone calls
// always start with the person answering ("Hello?") and the caller then
// introducing themselves — objections come up naturally in response to
// something, not as an opening line.
const CALL_OPENING_RULE = `HOW THE CALL STARTS (critical — read carefully): Your very first line, when the call connects, must be a simple, neutral way of answering the phone — something like "Hello?" or "Hello, this is [your name]." Nothing more. Do NOT raise your objection, deflect, mention the Final Wishes Organizer, or react to anything substantive on this first line — you don't know why they're calling yet. Wait for the rep to actually introduce themselves and explain the reason for the call (who they are, what funeral home, why they're reaching out) before you respond to any of that. Your objection should only come up naturally, later in the conversation, in response to something the rep actually said — never as your opening move before the rep has spoken.`;

const OBJECTION_CYCLE_CAP = `OBJECTION PACING (important for realism — read carefully): Only raise your objection, or a natural rephrasing of it, up to about 1-3 times total over the WHOLE call — never more. Just as importantly, do NOT bring it up after every single response from the rep — that reads as robotic and repetitive, not like a real person. After you raise it and the rep responds at all reasonably, let at least one or two normal conversational exchanges happen before you'd ever consider bringing it up again — and only actually bring it up again if it still feels like a genuine, unresolved concern to you, not as a reflex. Once you've raised it your last time (within the 1-3 total), make a decisive choice based on the difficulty gate above: schedule a full appointment, agree to a callback (a legitimate middle outcome, not a failure), or firmly and politely end the call. Real people resolve one way or another; they don't stall forever, and they don't loop the same pushback over and over.`;

// "Already taken care of" claims (has-will / has-plans objection type):
// most real families who say this only mean a basic will or life insurance
// — NOT an actual funeral home pre-need plan. A good rep has to clarify
// which one it is before treating the objection as resolved. Occasionally
// (rare, at your own discretion) it's genuinely the latter — and in that
// case scheduling really isn't appropriate, which is exactly the scenario
// the scoring rubric checks for as a red flag.
const HAS_PLANS_CLARIFICATION = `"ALREADY TAKEN CARE OF" CLAIMS (special instruction): When you say things are "already taken care of" or "we already have a plan," be deliberately vague about what that actually means at first — don't specify whether it's a will, a life insurance policy, or an actual pre-arranged plan with a funeral home. Make the rep ask a clarifying question (e.g. "when you say taken care of, do you mean you've already met with a specific funeral home and set up payments toward a pre-arranged plan, or is that more about a will or a life insurance policy?") before you clarify what you actually meant.

MOST OF THE TIME (the common, realistic case): once asked, reveal that it's really just a will and/or a life insurance policy — not an actual funeral home pre-need plan. That distinction is the rep's job to draw out and explain; once they do, you can be reasonably persuaded to still consider an appointment (subject to the scheduling gate above).

RARELY (occasionally, at your own realistic discretion, and ONLY reveal this if the rep asks a genuinely specific clarifying question): you may instead be a case where you are ALREADY genuinely and legitimately covered — you've already met with a specific funeral home and are already making payments toward a real pre-arranged plan. In that rare case, don't volunteer this upfront; only reveal it if directly and specifically asked. If the rep never asks and just pushes ahead to schedule an appointment anyway without ever clarifying what "taken care of" meant, let them schedule it if your normal scheduling gate is otherwise met — a real person in this situation might go along with it politely rather than argue — but this is exactly the kind of miss a good rep should have caught.`;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!OPENAI_KEY) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'OpenAI key not configured. Add OPENAI_KEY to Netlify environment variables.' }) };
  }

  try {
    const { personaPrompt, gender, fhName, fhPronunciation, afpName, leadSource, difficultyLevel, objectionType, address, surveyDateLabel } = JSON.parse(event.body);
    if (!personaPrompt) return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Missing personaPrompt' }) };

    const voice = VOICE_MAP[gender] || 'alloy';
    const backstory = LEAD_SOURCE_BACKSTORY[leadSource] || '';
    const difficultyDesc = describeDifficulty(difficultyLevel);
    const hasPlansNote = (objectionType === 'has-will' || objectionType === 'has-plans') ? HAS_PLANS_CLARIFICATION : '';
    const fhLine = fhName
      ? `The rep calling you is from ${fhName}${fhPronunciation ? ` (pronounced "${fhPronunciation}")` : ''}. If you refer to the funeral home by name during the call, pronounce it correctly using that guide.`
      : '';
    const afpLine = afpName
      ? `If the rep mentions scheduling you with an advisor, that advisor's name is ${afpName} — react to that name naturally if it comes up (e.g. "okay, ${afpName.split(' ')[0]}, got it").`
      : '';
    const addressLine = address
      ? `Your home address is ${address}. Only bring this up if the rep asks for it or if you're confirming an in-home appointment — don't volunteer it unprompted.`
      : '';
    const surveyDateLine = surveyDateLabel
      ? `You submitted the request that led to this call approximately ${surveyDateLabel}. If the rep asks when you sent it in or filled it out, answer consistent with that timeframe (loosely — you don't remember the exact date, just roughly when).`
      : '';

    // The stored persona_prompt text was originally written for the old
    // text-in/JSON-out pipeline and ends with a sentence instructing JSON
    // output (e.g. "Respond only in the required JSON format"). Leaving that
    // in and just telling the model afterward to "ignore" it was causing the
    // model to sometimes split the difference — literally saying a field
    // label like "Response:" out loud before its actual line. Stripping the
    // instruction out of the source text entirely (rather than just
    // contradicting it later) removes the conflict at the root.
    const cleanedPersonaPrompt = (personaPrompt || '')
      .replace(/\s*Respond only in the required JSON format\.?\s*$/i, '')
      .trim();

    const instructions = `${cleanedPersonaPrompt}

${backstory}
${fhLine}
${afpLine}
${addressLine}
${surveyDateLine}

${CALL_OPENING_RULE}

${difficultyDesc}

${REALISM_GUARDRAILS}

${RAPPORT_GATE}

${APPOINTMENT_LENGTH_NOTE}

${OBJECTION_CYCLE_CAP}

${hasPlansNote}

IMPORTANT: This is a LIVE SPOKEN PHONE CONVERSATION over real-time voice. Just speak your dialogue naturally out loud, the way the character actually would on a phone call. Never output JSON. Never say field-name-style labels out loud (e.g. never say the word "Response" or "Reply" before your line — just speak the line itself). Never describe stage directions. Never mention that you're an AI or that this is a simulation. Keep responses conversational length (a sentence or two at a time, like a real phone call), not monologues.`;

    const sessionRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: MODEL,
          instructions,
          output_modalities: ['audio'],
          audio: {
            input: {
              transcription: { model: 'gpt-4o-mini-transcribe' },
              // far_field suits typical laptop/desktop mics (most reps, most
              // likely setup); switch to 'near_field' if most reps are on
              // headsets — filters background noise BEFORE it reaches VAD,
              // directly reducing false "user is speaking" triggers.
              noise_reduction: { type: 'far_field' },
              // eagerness 'low' makes the model wait longer / need clearer
              // signal before deciding the rep is talking or interrupting —
              // trades a little latency for fewer false interruptions from
              // background noise, breathing, etc. Raise to 'medium'/'auto'
              // if it starts feeling sluggish to respond once tuned.
              turn_detection: { type: 'semantic_vad', eagerness: 'low', interrupt_response: true },
            },
            output: { voice },
          },
          reasoning: { effort: 'low' }, // raise to 'medium'/'high' if replies feel shallow; costs more latency
        },
      }),
    });

    const sessionData = await sessionRes.json();
    if (!sessionRes.ok || !sessionData.value) {
      return { statusCode: sessionRes.status || 500, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: sessionData.error?.message || 'Failed to create realtime session' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ clientSecret: sessionData.value, model: MODEL }),
    };

  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: err.message }) };
  }
};
