// transcribe-live — synchronous transcription for the live role-play loop.
// Unlike transcribe.js/transcribe-background.js (job-queue pattern, built for
// longer background work), this skips the Supabase storage upload and the
// job-table poll loop entirely: the browser sends the audio straight to this
// function as base64, it calls Whisper directly, and returns the transcript
// in the same response. That round trip was the main source of felt lag in
// the call — cutting it out makes each turn noticeably faster.

const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;

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
    const { audioBase64 } = JSON.parse(event.body);
    if (!audioBase64) return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Missing audioBase64' }) };

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    if (audioBuffer.length < 500) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ transcript: '' }) }; // too short to be real speech
    }

    const boundary = '----WhisperBoundary' + Date.now();
    const CRLF = '\r\n';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="audio.webm"${CRLF}Content-Type: audio/webm${CRLF}${CRLF}`),
      audioBuffer,
      Buffer.from(CRLF),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}whisper-1${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="language"${CRLF}${CRLF}en${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}text${CRLF}`),
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(multipartBody.length),
      },
      body: multipartBody,
    });

    const whisperText = await whisperRes.text();
    if (!whisperRes.ok) {
      return { statusCode: whisperRes.status, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: `Whisper error ${whisperRes.status}: ${whisperText.slice(0, 300)}` }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ transcript: whisperText.trim() }),
    };

  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: err.message }) };
  }
};
