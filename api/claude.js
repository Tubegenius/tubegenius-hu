module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
 
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
 
  try {
    const { type, messages, videoId } = req.body;
 
    // YouTube adatok lekérése
    if (type === 'youtube') {
      if (!videoId) {
        return res.status(400).json({ error: 'Hiányzó videoId' });
      }
      const ytKey = process.env.YT_API_KEY;
      const ytUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,statistics&key=${ytKey}`;
      const ytRes = await fetch(ytUrl);
      const ytData = await ytRes.json();
      if (!ytData.items || ytData.items.length === 0) {
        return res.status(404).json({ error: 'Videó nem található' });
      }
      return res.status(200).json(ytData.items[0]);
    }
 
    // Claude API hívás
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Hiányzó messages' });
    }
 
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        messages
      })
    });
 
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }
 
    const data = await response.json();
    return res.status(200).json(data);
 
  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message });
  }
}
