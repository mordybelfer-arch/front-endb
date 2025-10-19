import React, { useState, useEffect } from 'react';

function App() {
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('access_token');
    if (token) setAccessToken(token);
  }, []);

  const analyze = async () => {
    if (!playlistUrl && !accessToken) return alert('Paste playlist or login');
    setLoading(true);
    try {
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistUrl, access_token: accessToken })
      });
      const data = await res.json();
      setResult(data);
    } catch (err) { alert(err.message); }
    setLoading(false);
  };

  return (
    <div style={{ maxWidth: 800, margin: '40px auto', fontFamily: 'system-ui' }}>
      <h1>AutoMixify</h1>
      <p>Paste playlist link or login with Spotify</p>
      <input value={playlistUrl} onChange={e => setPlaylistUrl(e.target.value)} placeholder="Spotify playlist URL" style={{ width: '100%', padding: 8 }} />
      <button onClick={analyze} disabled={loading} style={{ padding: 10, marginTop: 10 }}>
        {loading ? 'Analyzing...' : 'Analyze Playlist'}
      </button>
      <a href={`${process.env.REACT_APP_BACKEND_URL}/login`} style={{ display: 'inline-block', marginTop: 10 }}>Login with Spotify</a>

      {result && (
        <div style={{ marginTop: 24 }}>
          <h2>Suggested Order</h2>
          <ol>
            {result.ordered.map(t => (
              <li key={t.id}>
                {t.name} — {t.artists} (BPM: {t.audio_features.tempo.toFixed(1)}, Key: {t.audio_features.key})
              </li>
            ))}
          </ol>
          <h3>Transitions</h3>
          <ul>
            {result.transitions.map((tr,i)=><li key={i}>{tr.from} → {tr.to} — score: {tr.score.toFixed(2)}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export default App;
