// realtime-session — mints a short-lived ("ephemeral") client secret for
// OpenAI's Realtime API. The browser uses this secret to open a WebRTC
// connection DIRECTLY to OpenAI (audio flows browser <-> OpenAI, not through
// this function) — the standard producer/consumer secure pattern documented
// at platform.openai.com/docs/guides/realtime-webrtc. This function's only
// job is to keep the real OPENAI_KEY server-side and hand back a short-lived
// token instead.
//
// NOTE ON VENDOR: this is one of TWO interchangeable engines for the LIVE
// persona voice — see gemini-session.js for the Google alternative. Both
// share identical persona behavior via persona-instructions.js; only the
// provider-specific session setup (voice names, audio config) differs here.
// Claude still does the post-call SCORING regardless of which engine ran
// the live call (score-starter.js/score-background.js are unchanged).

const { buildPersonaInstructions } = require('./persona-instructions');

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
    const body = JSON.parse(event.body);
    const { gender } = body;
    if (!body.personaPrompt) return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Missing personaPrompt' }) };

    const voice = VOICE_MAP[gender] || 'alloy';
    const instructions = buildPersonaInstructions(body);

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
              // SWITCHED FROM semantic_vad → server_vad. semantic_vad's only
              // dial is `eagerness`, which controls how long the model waits
              // before deciding the rep is DONE talking — it has no volume/
              // loudness threshold for deciding when speech STARTS. It was
              // already set to 'low' (its least-sensitive option) and the
              // persona's audio was still falsely triggering "user started
              // speaking" mid-response, cutting the audio while the transcript
              // (already fully generated) kept the complete text. There was no
              // further headroom left in semantic_vad to fix that.
              // server_vad exposes an actual loudness threshold (0.0-1.0,
              // default 0.5) — raised here to 0.7 so a quiet echo/background
              // noise needs real volume before it's read as the rep talking,
              // while a rep actually speaking at normal volume still triggers
              // normally. prefix_padding_ms/silence_duration_ms raised
              // slightly above default too, giving a bit more buffer around
              // both ends of a genuine turn. If reps start feeling like the
              // persona doesn't respond fast enough to real interruptions,
              // lower threshold back toward 0.5-0.6 first before touching
              // the other two.
              turn_detection: {
                type: 'server_vad',
                threshold: 0.7,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                interrupt_response: true,
              },
            },
            output: { voice },
          },
          reasoning: { effort: 'low' }, // raise to 'medium'/'high' if replies feel shallow; costs more latency
          // Hard cap on how long a single response can be — instructions
          // already ask for "a sentence or two," but this backs that up at
          // the API level instead of relying on the model to just comply.
          // Shorter responses also generate (and speak) faster. 300 is
          // roomy enough for 2-3 natural sentences without much risk of
          // getting cut off mid-thought; lower it (e.g. 200) for snappier/
          // shorter replies, or raise it if responses start feeling clipped.
          max_output_tokens: 300,
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
