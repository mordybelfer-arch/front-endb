// backend code (Spotify API + analyze logic)
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const querystring = require('querystring');

const app = express();
app.use(cors());
app.use(express.json());

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, REDIRECT_URI, STATE_KEY = 'spotify_auth_state' } = process.env;
const basicAuth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

function getAuthHeaders() {
  return { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' };
}

app.get('/login', (req, res) => {
  const scope = 'playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public';
  const state = Math.random().toString(36).substring(2, 15);
  const url = 'https://accounts.spotify.com/authorize?' + querystring.stringify({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri: REDIRECT_URI,
    state
  });
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  try {
    const code = req.query.code || null;
    const body = querystring.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    });
    const tokenResp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: getAuthHeaders(),
      body
    });
    const tokenJson = await tokenResp.json();
    res.redirect(`${process.env.FRONTEND_URL || 'https://automixify.vercel.app'}?access_token=${tokenJson.access_token}&refresh_token=${tokenJson.refresh_token}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error in callback');
  }
});

app.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    const body = querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token
    });
    const tokenResp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: getAuthHeaders(),
      body
    });
    const tokenJson = await tokenResp.json();
    res.json(tokenJson);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function spotifyGet(url, access_token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  return r.json();
}

app.post('/api/analyze', async (req, res) => {
  try {
    const { playlistUrl, playlistId, access_token } = req.body;
    if (!access_token) return res.status(400).json({ error: 'access_token required' });

    let id = playlistId;
    if (!id && playlistUrl) {
      const m = playlistUrl.match(/playlist[/:]([A-Za-z0-9]+)/);
      if (m) id = m[1];
    }
    if (!id) return res.status(400).json({ error: 'playlist id required' });

    const tracks = [];
    let url = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100`;
    while (url) {
      const page = await spotifyGet(url, access_token);
      if (page.items) {
        for (const item of page.items) {
          if (item.track && item.track.id) {
            tracks.push({
              id: item.track.id,
              name: item.track.name,
              artists: item.track.artists.map(a => a.name).join(', '),
              uri: item.track.uri
            });
          }
        }
      }
      url = page.next;
    }

    if (tracks.length === 0) return res.status(400).json({ error: 'no tracks found' });

    const audioFeatures = {};
    for (let i = 0; i < tracks.length; i += 100) {
      const ids = tracks.slice(i, i + 100).map(t => t.id).join(',');
      const resp = await spotifyGet(`https://api.spotify.com/v1/audio-features?ids=${ids}`, access_token);
      if (resp && resp.audio_features) {
        for (const f of resp.audio_features) if (f && f.id) audioFeatures[f.id] = f;
      }
    }

    const camelotCompat = (a, b) => {
      if (!a || !b) return 0;
      let score = 0;
      if (a.key === b.key && a.mode === b.mode) score += 2.0;
      if (a.key === b.key && a.mode !== b.mode) score += 1.6;
      const diff = Math.min(Math.abs(a.key - b.key), 12 - Math.abs(a.key - b.key));
      if (diff === 1) score += 1.2;
      if (diff === 2) score += 0.6;
      const tempoDiff = Math.abs(a.tempo - b.tempo);
      score += Math.max(0, 1.5 - tempoDiff / 30);
      score += Math.max(0, 1.0 - Math.abs(a.energy - b.energy));
      score += Math.max(0, 1.0 - Math.abs(a.danceability - b.danceability)) * 0.8;
      return score;
    };

    const n = tracks.length;
    const compat = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const a = audioFeatures[tracks[i].id];
        const b = audioFeatures[tracks[j].id];
        compat[i][j] = camelotCompat(a, b);
      }
    }

    function greedyOrder() {
      const used = Array(n).fill(false);
      const order = [];
      let bestIdx = 0;
      let bestAvg = -Infinity;
      for (let i = 0; i < n; i++) {
        const avg = compat[i].reduce((s, v) => s + v, 0) / (n - 1);
        if (avg > bestAvg) { bestAvg = avg; bestIdx = i; }
      }
      order.push(bestIdx); used[bestIdx] = true;
      while (order.length < n) {
        const last = order[order.length - 1];
        let best = -1, bestScore = -Infinity;
        for (let j = 0; j < n; j++) if (!used[j]) {
          if (compat[last][j] > bestScore) { bestScore = compat[last][j]; best = j; }
        }
        order.push(best); used[best] = true;
      }
      return order;
    }

    function twoOpt(ord) {
      let improved = true;
      while (improved) {
        improved = false;
        for (let i = 1; i < ord.length - 1; i++) {
          for (let j = i + 1; j < ord.length; j++) {
            const newOrd = ord.slice(0);
            const a = newOrd.splice(i, 1)[0];
            newOrd.splice(j, 0, a);
            const oldScore = ord.reduce((s, _, idx) => idx < ord.length - 1 ? s + compat[ord[idx]][ord[idx + 1]] : s, 0);
            const newScore = newOrd.reduce((s, _, idx) => idx < newOrd.length - 1 ? s + compat[newOrd[idx]][newOrd[idx + 1]] : s, 0);
            if (newScore > oldScore) { ord = newOrd; improved = true; break; }
          }
          if (improved) break;
        }
      }
      return ord;
    }

    let order = greedyOrder();
    order = twoOpt(order);

    const ordered = order.map(idx => {
      const t = tracks[idx];
      return { index: idx, id: t.id, name: t.name, artists: t.artists, uri: t.uri, audio_features: audioFeatures[t.id] };
    });

    const transitions = [];
    for (let i = 0; i + 1 < ordered.length; i++) {
      transitions.push({
        from: ordered[i].name,
        to: ordered[i + 1].name,
        score: compat[ordered[i].index][ordered[i + 1].index]
      });
    }

    res.json({ ordered, transitions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8888;
app.listen(PORT, () => console.log('Backend running on port', PORT));
