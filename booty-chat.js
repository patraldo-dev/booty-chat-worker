// Booty Battle Game Room — Durable Object with SQLite
// Each DO instance = one game room
// WebSocket for real-time: chat, location, proximity events

export class BootyChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Map(); // sessionId → { ws, username, displayName, lat, lon, lastSeen }
    this.cleanupInterval = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    await this.ensureDB();

    // GET /messages?limit=50&before=timestamp
    if (request.method === 'GET' && path === '/messages') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const before = url.searchParams.get('before');
      let sql = 'SELECT id, username, display_name, message, type, created_at FROM messages';
      if (before) sql += ` WHERE created_at < ?`;
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      const params = before ? [before, limit] : [limit];
      const result = await this.state.storage.sql.prepare(sql).bind(...params).all();
      const messages = (result.results || []).reverse();
      return Response.json({ messages });
    }

    // GET /nearby?lat=X&lon=Y&radius=500
    if (request.method === 'GET' && path === '/nearby') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      const radius = parseInt(url.searchParams.get('radius') || '500');
      if (isNaN(lat) || isNaN(lon)) return Response.json({ error: 'lat/lon required' }, { status: 400 });
      const nearby = this.getNearbyPlayers(lat, lon, radius);
      return Response.json({ nearby });
    }

    // GET /online
    if (request.method === 'GET' && path === '/online') {
      const now = Date.now();
      const players = [];
      for (const [, conn] of this.connections) {
        if (now - conn.lastSeen < 30000) { // active in last 30s
          players.push({
            username: conn.username,
            displayName: conn.displayName,
            hasLocation: conn.lat !== null,
            lat: conn.lat,
            lon: conn.lon
          });
        }
      }
      return Response.json({ players, count: players.length });
    }

    // POST /system
    if (request.method === 'POST' && path === '/system') {
      const { message, type, username } = await request.json();
      if (!message) return Response.json({ error: 'message required' }, { status: 400 });
      return await this.postMessage({
        username: username || 'system',
        display_name: null,
        message: String(message).slice(0, 500),
        type: type || 'system'
      });
    }

    // WebSocket upgrade at /ws
    if (path === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const username = url.searchParams.get('username') || 'anonymous';
      const displayName = url.searchParams.get('display_name') || username;
      const sessionId = crypto.randomUUID();

      const conn = { ws: server, username, displayName, lat: null, lon: null, lastSeen: Date.now() };
      this.connections.set(sessionId, conn);

      // Start cleanup if not running
      if (!this.cleanupInterval) {
        this.cleanupInterval = setInterval(() => this.cleanupStale(), 30000);
      }

      // Send recent history
      try {
        const result = await this.state.storage.sql.prepare(
          'SELECT id, username, display_name, message, type, created_at FROM messages ORDER BY created_at DESC LIMIT 50'
        ).bind().all();
        server.send(JSON.stringify({ type: 'history', messages: (result.results || []).reverse() }));
      } catch (e) {
        console.error('History load error:', e);
      }

      // Send current online players
      this.sendOnlineUpdate(server);

      // Broadcast join
      await this.postSystemMessage(`${displayName} se unió al chat`);
      this.broadcastOnlineUpdate();

      // Handle incoming messages
      server.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data);
          conn.lastSeen = Date.now();

          if (data.type === 'chat' && data.message) {
            const trimmed = String(data.message).trim().slice(0, 500);
            if (!trimmed) return;

            await this.postMessage({
              username, display_name: displayName, message: trimmed, type: 'user'
            });

            // Albot responds ~25%
            if (Math.random() < 0.25 && username !== 'albot-camus') {
              await this.narratorRespond(trimmed, username);
            }
          }

          // Location update from player
          if (data.type === 'location') {
            const prevLat = conn.lat;
            const prevLon = conn.lon;
            conn.lat = parseFloat(data.lat);
            conn.lon = parseFloat(data.lon);

            // Check proximity events (only if we have both old and new coords)
            if (prevLat !== null && conn.lat !== null) {
              this.checkProximityEvents(conn, prevLat, prevLon);
            }
          }
        } catch (e) {
          console.error('WS message error:', e);
        }
      });

      server.addEventListener('close', () => {
        this.connections.delete(sessionId);
        this.postSystemMessage(`${displayName} salió del chat`).catch(() => {});
        this.broadcastOnlineUpdate();
        if (this.connections.size === 0 && this.cleanupInterval) {
          clearInterval(this.cleanupInterval);
          this.cleanupInterval = null;
        }
      });

      server.addEventListener('error', () => {
        this.connections.delete(sessionId);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // ── Proximity ──────────────────────────────────────────────────────────

  getNearbyPlayers(lat, lon, radiusM = 500) {
    const nearby = [];
    for (const [id, conn] of this.connections) {
      if (conn.lat === null || conn.lon === null) continue;
      if (Date.now() - conn.lastSeen > 30000) continue; // stale
      const dist = this.haversine(lat, lon, conn.lat, conn.lon);
      if (dist <= radiusM) {
        nearby.push({
          sessionId: id,
          username: conn.username,
          displayName: conn.displayName,
          lat: conn.lat,
          lon: conn.lon,
          distance: Math.round(dist)
        });
      }
    }
    return nearby.sort((a, b) => a.distance - b.distance);
  }

  checkProximityEvents(movingConn, prevLat, prevLon) {
    const PROXIMITY_RADIUS = 200; // meters — "nearby" threshold

    for (const [id, conn] of this.connections) {
      if (id === movingConn.username) continue; // skip self (compare by username since we don't have sessionId in the loop context properly)
      if (conn.lat === null || conn.lon === null) continue;
      if (Date.now() - conn.lastSeen > 30000) continue;

      const distNow = this.haversine(movingConn.lat, movingConn.lon, conn.lat, conn.lon);
      const distBefore = this.haversine(prevLat, prevLon, conn.lat, conn.lon);

      // Player entered proximity
      if (distBefore > PROXIMITY_RADIUS && distNow <= PROXIMITY_RADIUS) {
        this.broadcast({
          type: 'proximity',
          event: 'enter',
          player: { username: movingConn.username, displayName: movingConn.displayName },
          target: { username: conn.username, displayName: conn.displayName },
          distance: Math.round(distNow),
          message: `🏴‍☠️ ${movingConn.displayName} está cerca de ${conn.displayName} (${Math.round(distNow)}m)`
        });
      }

      // Player left proximity
      if (distBefore <= PROXIMITY_RADIUS && distNow > PROXIMITY_RADIUS) {
        this.broadcast({
          type: 'proximity',
          event: 'leave',
          player: { username: movingConn.username, displayName: movingConn.displayName },
          target: { username: conn.username, displayName: conn.displayName },
          distance: Math.round(distNow),
          message: `${movingConn.displayName} se alejó de ${conn.displayName}`
        });
      }
    }
  }

  // ── Online status ──────────────────────────────────────────────────────

  sendOnlineUpdate(ws) {
    const now = Date.now();
    const players = [];
    for (const [, conn] of this.connections) {
      if (now - conn.lastSeen < 30000) {
        players.push({ username: conn.username, displayName: conn.displayName, hasLocation: conn.lat !== null });
      }
    }
    ws.send(JSON.stringify({ type: 'online', players, count: players.length }));
  }

  broadcastOnlineUpdate() {
    this.broadcast({ type: 'online_update', count: this.connections.size });
  }

  cleanupStale() {
    const now = Date.now();
    for (const [id, conn] of this.connections) {
      if (now - conn.lastSeen > 60000) {
        try { conn.ws.close(); } catch {}
        this.connections.delete(id);
      }
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────────

  async ensureDB() {
    if (this._dbReady) return;
    try {
      await this.state.storage.sql.prepare(
        `CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          display_name TEXT,
          message TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'user',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await this.state.storage.sql.prepare(
        `CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at)`
      ).run();
      this._dbReady = true;
    } catch (e) {
      console.error('DB init error:', e);
      this._dbReady = true;
    }
  }

  async postMessage({ username, display_name, message, type }) {
    const id = crypto.randomUUID();
    await this.state.storage.sql.prepare(
      `INSERT INTO messages (id, username, display_name, message, type, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, username, display_name, message, type).run();

    this.broadcast({
      id, username, display_name, message, type,
      created_at: new Date().toISOString()
    });

    return Response.json({ ok: true, id });
  }

  async postSystemMessage(message) {
    const id = crypto.randomUUID();
    try {
      await this.state.storage.sql.prepare(
        `INSERT INTO messages (id, username, display_name, message, type, created_at)
         VALUES (?, 'system', NULL, ?, 'system', datetime('now'))`
      ).bind(id, message).run();
    } catch {}

    this.broadcast({
      id, username: 'system', display_name: null,
      message, type: 'system', created_at: new Date().toISOString()
    });
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const [, conn] of this.connections) {
      try { conn.ws.send(data); } catch {}
    }
  }

  async narratorRespond(userMessage, username) {
    try {
      const result = await this.state.storage.sql.prepare(
        "SELECT username, message FROM messages WHERE type IN ('user','narrator') ORDER BY created_at DESC LIMIT 8"
      ).bind().all();
      const context = (result.results || []).map(r => `${r.username}: ${r.message}`).join('\n');

      const ai = this.env.AI;
      const resp = await ai.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
        prompt: `You are Albot Camus, the God-like Narrator of the Bottle Booty ocean game.
You speak in cryptic, poetic, slightly ominous prose. Keep responses to 1-2 short sentences max.
Respond naturally to the conversation. Match the language of the user.

Recent chat:
${context}

${username} said: ${userMessage}

Albot Camus:`,
        max_tokens: 100
      });

      const reply = (resp?.response || '').trim().slice(0, 300);
      if (!reply) return;

      await this.postMessage({
        username: 'albot-camus',
        display_name: 'Albot Camus',
        message: reply,
        type: 'narrator'
      });
    } catch (e) {
      console.error('Narrator error:', e);
    }
  }

  haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
        * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  async webSocketMessage(ws, message) {}
  async webSocketClose(ws, code, reason, wasClean) {}
}
