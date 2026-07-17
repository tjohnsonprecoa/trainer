// gemini-session — mints a short-lived ("ephemeral") auth token for
// Google's Gemini Live API. The browser uses this token to open a
// WebSocket connection DIRECTLY to Google (audio flows browser <-> Google,
// not through this function) — the same producer/consumer pattern as
// realtime-session.js, just for the other engine. This function's only job
// is to keep the real GEMINI_KEY server-side and hand back a short-lived,
// CONFIGURATION-LOCKED token instead (the persona instructions are baked
// into the token itself via liveConnectConstraints, so they never reach
// the browser as plain text either).
//
// This is the Gemini counterpart to realtime-session.js — same persona
// behavior (via persona-instructions.js), different underlying model.
// Added as a side-by-side alternative engine, not a replacement — the app
// lets you pick which one runs a given call so the two can be compared
// directly. Claude still does all post-call SCORING either way.

const { GoogleGenAI } = require('@google/genai');
const { buildPersonaInstructions } = require('./persona-instructions');

const GEMINI_KEY = process.env.GEMINI_KEY || process.env.GOOGLE_API_KEY;

// Best-effort gender-leaning voice picks from Gemini's 30 prebuilt voices,
// based on common community characterization (Google doesn't publish
// explicit gender labels for these) — worth an ear-check like we did for
// the OpenAI voice picks, and easy to swap below if a different one suits
// a persona better.
const VOICE_MAP = {
  male: 'Charon',
  female: 'Kore',
};

// The current Live model with native audio + configurable reasoning.
// Google also offers 'gemini-3.1-flash-live-preview' variants at other
// price/quality points if this needs tuning later.
const MODEL = 'gemini-3.1-flash-live-preview';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!GEMINI_KEY) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Gemini key not configured. Add GEMINI_KEY to Netlify environment variables.' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { gender } = body;
    if (!body.personaPrompt) return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Missing personaPrompt' }) };

    const voice = VOICE_MAP[gender] || 'Kore';
    const instructions = buildPersonaInstructions(body);

    const client = new GoogleGenAI({ apiKey: GEMINI_KEY });
    const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min to finish the call
    const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString(); // 60s to actually connect

    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: MODEL,
          config: {
            responseModalities: ['AUDIO'],
            systemInstruction: { parts: [{ text: instructions }] },
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // Mirrors the OpenAI-side VAD tuning: lower sensitivity + a
            // bit of padding/silence tolerance cuts down false interruptions
            // from background noise, at a small latency cost.
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
                endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
                prefixPaddingMs: 20,
                silenceDurationMs: 700,
              },
            },
          },
        },
      },
      httpOptions: { apiVersion: 'v1alpha' },
    });

    if (!token || !token.name) {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: 'Failed to create Gemini ephemeral token' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ token: token.name, model: MODEL }),
    };

  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: err.message }) };
  }
};
