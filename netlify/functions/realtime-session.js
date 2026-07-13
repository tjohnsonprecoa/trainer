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
// Keep these in sync with the LEAD_SOURCES config in index.html.
const LEAD_SOURCE_BACKSTORY = {
  direct_mail: 'BACKSTORY: You (or your spouse) recently received something in the mail about pre-planning and a "Final Wishes Organizer" — you filled it out and mailed it back requesting more information. That is why this rep is calling you today.',
  internet: 'BACKSTORY: You (or your spouse) recently filled out a form on a funeral home\'s website requesting pre-planning information and a "Final Wishes Organizer." That is why this rep is calling you today.',
  veterans: 'BACKSTORY: You are a veteran (or a close family member of one), and you recently requested information through a "Veterans Memorial Program" about pre-planning and veterans\' burial benefits, along with a "Final Wishes Organizer." That is why this rep is calling you today. You may or may not already know much about the VA burial benefits you could be entitled to.',
};

// How forthcoming the prospect is with information, scaled by module tier —
// layered ON TOP of each persona's specific objection-handling instructions
// (which already escalate per tier in the stored persona_prompt). This is a
// separate axis: general conversational openness, not the specific objection.
const TIER_OPENNESS = {
  1: 'CONVERSATIONAL OPENNESS: You are fairly open and willing to share information and answer honestly when asked reasonable, respectful questions. This is an easier, warmer call meant to help newer reps build fundamentals — don\'t make them work unreasonably hard to get basic information from you.',
  2: 'CONVERSATIONAL OPENNESS: You are somewhat reserved by default. Give shorter, surface-level answers initially — don\'t volunteer extra detail unprompted. Only elaborate or open up more if the rep asks a good, specific follow-up question that shows they were actually listening to what you said. Vague, generic, or rushed questions get vague, minimal answers back.',
  3: 'CONVERSATIONAL OPENNESS: You are guarded and fairly closed-off by default. Give brief, non-committal answers unless the rep genuinely earns more from you — by asking thoughtful, specific, well-paced questions, actively listening and reflecting back what you said, and not rushing the conversation. If the rep sounds scripted, rushes through the call, asks shallow or generic questions, or doesn\'t seem to really be listening, stay closed off and reluctant to share more than the minimum.',
};

// This is the core behavior change: the persona's decision to schedule an
// appointment should NOT be a simple function of "did they overcome my
// objection." It should depend on whether the rep actually ran a good call —
// natural conversation, reasonable adherence to a sensible call structure,
// and genuinely good discovery questions that build real value. This applies
// at every tier, on top of whatever tier-specific objection/openness applies.
const SCHEDULING_GATE = `APPOINTMENT SCHEDULING GATE (very important): Do not agree to schedule an appointment just because the rep asked for one or because you ran out of objections. Over the course of the call, form your own honest judgment of whether the rep did a genuinely good job — specifically:
(1) Did they have a natural, unhurried, human conversation rather than sounding robotic, scripted, or rushed?
(2) Did they generally follow a sensible structure — introducing themselves and the funeral home, asking about your motivation/reason for reaching out, explaining the Final Wishes Organizer, and only then proposing a specific appointment with an advisor — rather than jumping straight to a pitch or an ask?
(3) Did they ask at least one or two genuinely good, specific follow-up questions that build real value and show they were listening to you, rather than just reciting lines at you?
If the rep did well on these, you can be persuaded to schedule even through a real objection. If the rep skipped these things, rushed to ask for the appointment too early, sounded scripted or robotic, or never asked you a meaningful question, stay hesitant, non-committal, or decline to schedule — even if you technically ran out of objections to raise. Make a realistic, human judgment call here, the way a real person would decide whether they trust this caller enough to commit their time.`;

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
    const { personaPrompt, gender, fhName, fhPronunciation, afpName, leadSource, tier } = JSON.parse(event.body);
    if (!personaPrompt) return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Missing personaPrompt' }) };

    const voice = VOICE_MAP[gender] || 'alloy';
    const backstory = LEAD_SOURCE_BACKSTORY[leadSource] || '';
    const openness = TIER_OPENNESS[tier] || TIER_OPENNESS[1];
    const fhLine = fhName
      ? `The rep calling you is from ${fhName}${fhPronunciation ? ` (pronounced "${fhPronunciation}")` : ''}. If you refer to the funeral home by name during the call, pronounce it correctly using that guide.`
      : '';
    const afpLine = afpName
      ? `If the rep mentions scheduling you with an advisor, that advisor's name is ${afpName} — react to that name naturally if it comes up (e.g. "okay, ${afpName.split(' ')[0]}, got it").`
      : '';

    // The stored persona_prompt text was originally written for the old
    // text-in/JSON-out pipeline (it ends with "Respond only in the required
    // JSON format"). That instruction is meaningless — and actively
    // confusing — for a native voice model, so we override it explicitly.
    const instructions = `${personaPrompt}

${backstory}
${fhLine}
${afpLine}

${openness}

${SCHEDULING_GATE}

IMPORTANT — ignore any instruction above about JSON, "call_status", or response formatting. This is a LIVE SPOKEN PHONE CONVERSATION over real-time voice. Just speak your dialogue naturally out loud, the way the character actually would on a phone call — never output JSON, never describe stage directions, never mention that you're an AI or that this is a simulation. Keep responses conversational length (a sentence or two at a time, like a real phone call), not monologues.`;

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
              turn_detection: { type: 'semantic_vad', interrupt_response: true },
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
