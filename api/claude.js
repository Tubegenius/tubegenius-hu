module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  try {
    const { type, messages, videoId, searchQuery } = req.body;
    const YT_KEY = process.env.YT_API_KEY;
 
    // YouTube videó adatok lekérése
    if (type === 'youtube') {
      const ytRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,statistics&key=${YT_KEY}`
      );
      const ytData = await ytRes.json();
      if (!ytData.items || ytData.items.length === 0) {
        return res.status(404).json({ error: 'Videó nem található' });
      }
      return res.status(200).json(ytData.items[0]);
    }
 
    // YouTube keresés + statisztikák viral score-hoz
    if (type === 'youtube_search') {
      // Keresés
      const searchRes = await fetch(
        `https://www.googleapis.com/youtube/v3/search?q=${encodeURIComponent(searchQuery)}&part=snippet&type=video&maxResults=10&relevanceLanguage=hu&key=${YT_KEY}`
      );
      const searchData = await searchRes.json();
      
      if (!searchData.items || searchData.items.length === 0) {
        return res.status(200).json({ avgViews: 0, avgLikes: 0, videoCount: 0, topVideos: [] });
      }
 
      // Videó ID-k összegyűjtése
      const videoIds = searchData.items.map(i => i.id.videoId).filter(Boolean).join(',');
      
      // Statisztikák lekérése
      const statsRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${videoIds}&part=statistics,snippet&key=${YT_KEY}`
      );
      const statsData = await statsRes.json();
 
      if (!statsData.items || statsData.items.length === 0) {
        return res.status(200).json({ avgViews: 0, avgLikes: 0, videoCount: 0, topVideos: [] });
      }
 
      // Átlagok számítása
      const views = statsData.items.map(v => parseInt(v.statistics.viewCount || 0));
      const likes = statsData.items.map(v => parseInt(v.statistics.likeCount || 0));
      const avgViews = Math.round(views.reduce((a, b) => a + b, 0) / views.length);
      const avgLikes = Math.round(likes.reduce((a, b) => a + b, 0) / likes.length);
 
      const topVideos = statsData.items.slice(0, 3).map(v => ({
        title: v.snippet.title,
        views: parseInt(v.statistics.viewCount || 0),
        likes: parseInt(v.statistics.likeCount || 0)
      }));
 
      return res.status(200).json({ avgViews, avgLikes, videoCount: statsData.items.length, topVideos });
    }
 
    // Claude API hívás
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
      const e = await response.text();
      return res.status(response.status).json({ error: e });
    }
 
    const data = await response.json();
    return res.status(200).json(data);
 
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
