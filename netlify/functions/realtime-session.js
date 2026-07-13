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
    const { personaPrompt, gender, fhName, fhPronunciation, afpName, leadSource } = JSON.parse(event.body);
    if (!personaPrompt) return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Missing personaPrompt' }) };

    const voice = VOICE_MAP[gender] || 'alloy';
    const backstory = LEAD_SOURCE_BACKSTORY[leadSource] || '';
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
