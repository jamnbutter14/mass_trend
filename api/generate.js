// Vercel serverless function: proxies requests to Gemini so the API key stays on the server.
// Required env var:   GEMINI_API_KEY
// Optional env vars:  ACCESS_CODE (if unset, the site is open to anyone with the link), GEMINI_MODEL (default gemini-3.8-flash), RATE_LIMIT_PER_HOUR (default 60), DAILY_CAP (default 3000)

const crypto = require('crypto');

const hits = new Map();           // ip -> array of timestamps (best-effort, per warm instance)
let day = new Date().toDateString();
let dayCount = 0;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket?.remoteAddress) || 'unknown';
}

function rateLimited(ip, perHour) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 3600_000);
  if (arr.length >= perHour) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) { // keep memory small
    for (const [k, v] of hits) if (!v.some(t => now - t < 3600_000)) hits.delete(k);
  }
  return false;
}

const str = (v, max) => String(v ?? '').slice(0, max);
const num = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

const GENERAL_THEMES = [
  'their charm and charisma', 'their warm personality and kindness', 'their talent and skill',
  'their hard work and dedication', 'their beautiful smile and looks', 'their voice and sound',
  'their humour and fun side', 'how they inspire and motivate fans', 'their confidence and presence',
  'how much fans love and support them', 'their growth over the years', 'how they make fans feel happy and understood'
];
const EVENT_THEMES = [
  'the energy and excitement of this event', 'their performance and stage presence at this event',
  'how unforgettable this moment is for fans'
];
const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

const TONES = {
  optimistic: ['Optimistic & Hopeful', 'bright, encouraging, full of faith in a beautiful future'],
  happy: ['Happy & Joyful', 'cheerful, glowing, overflowing with joy'],
  awed: ['Awed & Amazement', 'astonished, in awe, amazed by how special he is'],
  funny: ['Funny & Witty', 'light humour and clever wit, still clearly a compliment'],
  relaxed: ['Relaxed & Natural', 'casual, conversational, like a real fan typing naturally'],
  whimsical: ['Whimsical & Playful', 'imaginative, cute and playful, with a touch of fantasy']
};

function buildPrompt(b) {
  const keywords = (Array.isArray(b.keywords) ? b.keywords : []).slice(0, 10).map(k => str(k, 60).trim()).filter(Boolean);
  const event = str(b.event, 120).trim();
  const tags = str(b.tags, 300).trim();
  const idol = str(b.idol, 40).trim() || 'James';
  const limit = num(b.limit, 40, 500, 190);
  const count = num(b.count, 1, 40, 20);
  const angle = str(b.angle, 120);
  const avoid = (Array.isArray(b.avoid) ? b.avoid : []).slice(0, 200).map(a => str(a, 80));
  const incTags = !!b.incTags;
  const directPct = num(b.directPct, 0, 100, 30);
  const toneKey = Object.prototype.hasOwnProperty.call(TONES, b.tone) ? b.tone : 'mixed';
  if (!keywords.length) return null;

  const kwText = keywords.map(k => `"${k}"`).join(', ');
  let t = `Create ${count} compliments for ${idol}, each under ${limit} characters (counting spaces, emojis and punctuation), all have these ${keywords.length} keywords [${kwText}]${event ? ` at [${event}]` : ''}. Don't count/add a No. at the beginning.`;
  const direct = Math.round(count * directPct / 100);
  const third = count - direct;
  const toneLine = toneKey === 'mixed'
    ? `\n- Mood: mix the moods across the set, spreading them evenly so neighbouring compliments differ: ${Object.values(TONES).map(x => x[0] + ' (' + x[1] + ')').join('; ')}.\n- Extra flavour for this set: ${angle}.`
    : `\n- Mood: every compliment must have a ${TONES[toneKey][0]} mood (${TONES[toneKey][1]}). Keep this mood throughout, while still varying wording and structure.`;
  t += `\n\nRules:\n- HARD LIMIT: every compliment must be ${limit} characters or fewer in total. Keep them short and punchy.\n- Every compliment must contain ALL of the keywords above, worded naturally.\n- Write each as a standalone fan comment.\n- Make every compliment clearly different in structure, opening, tone and detail. Never start two with the same words. Vary what is praised (for example talent, charm, personality, kindness, hard work, humour, looks), as long as every keyword is still included.${toneLine}`;
  t += `\n- Point of view: exactly ${third} of the ${count} compliments talk ABOUT ${idol} in the third person (use his name or he/him/his, and never use "you" to address him). The other ${direct} speak DIRECTLY to ${idol} (use "you/your"). Shuffle the order so the two kinds are mixed randomly.`;
  if (event) t += `\n- Only mention the event as given. Do not invent extra details about it (venue, outfits, songs, schedule, what happened).`;
  else t += `\n- There is NO event, so these are general compliments. Do NOT mention or imply any event, stage, concert, performance, fan meeting, show, "tonight" or "today". Do not invent places, outfits or moments. Only use details that the keywords themselves suggest.`;
  if (tags && incTags) t += `\n- Today's tagline and hashtags is [${tags}]. Include them in every compliment, and count them toward the ${limit}-character limit.`;
  else if (tags) t += `\n- Today's tagline is [${tags}] for context only. Do NOT include any hashtags or the tagline text in the compliments.`;
  else t += `\n- Do NOT include any hashtags.`;
  if (avoid.length) t += `\n- These openings were already used, so do NOT repeat or paraphrase them:\n${avoid.map(a => '  * ' + a).join('\n')}`;
  t += `\n\nReturn ONLY a JSON array of ${count} strings, one string per compliment.`;
  return t;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const apiKey = process.env.GEMINI_API_KEY;
  const accessCode = process.env.ACCESS_CODE;
  if (!apiKey) return res.status(500).json({ error: 'Server is not configured. Set GEMINI_API_KEY in Vercel.' });

  const ip = clientIp(req);
  if (accessCode && !safeEqual(req.headers['x-access-code'] || '', accessCode)) {
    // limit guessing: 10 wrong codes per hour per visitor
    if (rateLimited('fail:' + ip, 10)) return res.status(429).json({ error: 'Too many wrong codes. Try again later.' });
    return res.status(401).json({ error: 'Wrong access code.' });
  }

  const perHour = num(process.env.RATE_LIMIT_PER_HOUR, 1, 100000, 60);
  const dailyCap = num(process.env.DAILY_CAP, 1, 1000000, 3000);
  const today = new Date().toDateString();
  if (today !== day) { day = today; dayCount = 0; }
  if (dayCount >= dailyCap) return res.status(429).json({ error: 'Daily limit reached. Try again tomorrow.' });
  if (rateLimited(ip, perHour)) return res.status(429).json({ error: 'Too many requests from you this hour. Please wait a bit.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Bad request.' });

  const prompt = buildPrompt(body);
  if (!prompt) return res.status(400).json({ error: 'Please enter at least one keyword.' });

  dayCount++;
  const wanted = typeof body.model === 'string' ? body.model.trim() : '';
  const model = /^gemini-[a-z0-9][a-z0-9.\-]{1,50}$/i.test(wanted) ? wanted : (process.env.GEMINI_MODEL || 'gemini-3.8-flash');
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 1.1,
          maxOutputTokens: 12000,
          responseMimeType: 'application/json',
          responseSchema: { type: 'ARRAY', items: { type: 'STRING' } }
        }
      })
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 429) return res.status(429).json({ error: `Rate limit reached for ${model}. Wait a minute or choose another model.` });
    if (!r.ok) return res.status(502).json({ error: (data.error && data.error.message) || ('Gemini error ' + r.status) });
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts;
    if (!parts) return res.status(502).json({ error: 'Empty response from Gemini (it may have been blocked).' });
    const raw = parts.map(p => p.text || '').join('').replace(/```json|```/g, '').trim();
    let arr; try { arr = JSON.parse(raw); } catch { return res.status(502).json({ error: 'Could not read Gemini output as a list.' }); }
    return res.status(200).json({ items: arr.filter(x => typeof x === 'string') });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Gemini: ' + e.message });
  }
};
