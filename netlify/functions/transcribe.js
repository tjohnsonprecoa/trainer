// Creates a trainer_transcription_jobs row and returns the jobId.
// Same pattern as CallIQ's transcribe.js, pointed at the trainer's own job table
// so the two apps' queues don't collide (shared Supabase project, separate tables).

const SB_URL = 'https://nbifzxzpcxchrwdcblyu.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iaWZ6eHpwY3hjaHJ3ZGNibHl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MTE3MjQsImV4cCI6MjA5NTQ4NzcyNH0.Nt5YbYLYdEdtbHu5fwrY8XTqhyNaP0Cz1LadnE67A8E';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { fileUrl, fileName } = JSON.parse(event.body);
    if (!fileUrl) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing fileUrl' }) };

    const insertRes = await fetch(`${SB_URL}/rest/v1/trainer_transcription_jobs`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ file_url: fileUrl, file_name: fileName, status: 'pending' }),
    });

    const insertText = await insertRes.text();
    if (!insertRes.ok) {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: `DB insert failed (${insertRes.status}): ${insertText}` }) };
    }

    const insertData = JSON.parse(insertText);
    const jobId = (Array.isArray(insertData) ? insertData[0] : insertData)?.id;
    if (!jobId) return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'No job ID returned: ' + insertText }) };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ jobId }),
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: err.message }) };
  }
};
