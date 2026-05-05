const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// CORS — open to all origins (rate limiting is the protection layer, not CORS)
app.use(cors());

app.use(express.json({ limit: '10mb' })); // 10mb to handle base64 VIN photos

// Free tier rate limiter — 3 requests per 24 hours per IP
const freeLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    const resetTime = new Date(req.rateLimit.resetTime);
    const now = new Date();
    const msUntilReset = resetTime - now;
    const hoursLeft = Math.floor(msUntilReset / (1000 * 60 * 60));
    const minutesLeft = Math.floor((msUntilReset % (1000 * 60 * 60)) / (1000 * 60));
    res.status(429).json({
      error: 'rate_limit',
      message: `3 of 3 re-SCOUTs used. Resets in ${hoursLeft}h ${minutesLeft}m.`,
      resetIn: msUntilReset
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'scout-api' });
});

// Ping endpoint — used by frontend to wake server before first request
app.get('/ping', (req, res) => {
  res.json({ alive: true });
});

// Re-SCOUT endpoint — runs AI research on a truck
app.post('/api/scout', freeLimiter, async (req, res) => {
  const { prompt, trucks } = req.body;

  if (!prompt && !trucks) {
    return res.status(400).json({ error: 'Missing prompt or trucks array' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  const userPrompt = prompt || `Research and score these trucks for a SCOUT report: ${trucks.join(', ')}. 
Return a JSON object with updated scores (A-F) across these categories: reliability, ownership_cost, towing, safety, theft_risk, value, availability. 
Include a brief summary for each truck. Base scores on current real-world data.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: userPrompt
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: 'Anthropic API error', detail: err });
    }

    const data = await response.json();
    res.json({ result: data.content[0].text });

  } catch (err) {
    console.error('Scout endpoint error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// VIN photo endpoint — Claude vision reads VIN from photo
app.post('/api/vin', freeLimiter, async (req, res) => {
  const { image, mediaType } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'Missing image data' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType || 'image/jpeg',
                  data: image
                }
              },
              {
                type: 'text',
                text: 'Read the VIN number from this image. Return ONLY the 17-character VIN, nothing else. If you cannot read a clear VIN, return the word UNCLEAR.'
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: 'Anthropic API error', detail: err });
    }

    const data = await response.json();
    const vin = data.content[0].text.trim();

    if (vin === 'UNCLEAR') {
      return res.json({ vin: null, message: 'Could not read VIN clearly. Please try manual entry.' });
    }

    res.json({ vin });

  } catch (err) {
    console.error('VIN endpoint error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// VERA open query endpoint
app.post('/api/vera', freeLimiter, async (req, res) => {
  const { query, context } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Missing query' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  const systemPrompt = `You are VERA, the AI assistant inside SCOUT — a vehicle research and buying intelligence platform. 

Your voice: Direct, knowledgeable, warm but not cheerful. No exclamation points. Say "here's what I'd do" not "well there are many factors." When there's a real tradeoff, say so plainly. Occasionally dry wit. Never talk down. Say "I don't know" cleanly when you don't.

You have deep knowledge of trucks, SUVs, cars — reliability, costs, towing, safety, theft risk, trim levels, good/bad model years, fuel types, real-world vs manufacturer specs.

Keep responses concise and useful. The person asking has done their research — they want your take, not a Wikipedia article.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: context ? `Context: ${context}\n\nQuestion: ${query}` : query
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: 'Anthropic API error', detail: err });
    }

    const data = await response.json();
    res.json({ result: data.content[0].text });

  } catch (err) {
    console.error('VERA endpoint error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SCOUT API server running on port ${PORT}`);
});
