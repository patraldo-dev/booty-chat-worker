// BootyChatRoom — Durable Object with SQLite
// Each DO instance = one chat room. Stub ID = room name.
// WebSocket for real-time messaging. Albot Camus participates.

export class BootyChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Map(); // sessionId → { ws, username, displayName }
  }

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

  async fetch(request) {
    const url = new URL(request.url);
    await this.ensureDB();

    // Normalize path — edge worker forwards /chat/* as the original path
    const p = url.pathname.replace(/^\/chat/, '') || '/messages';

    // GET /messages — history
    if (request.method === 'GET' && (p === '/messages' || url.pathname === '/messages')) {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const before = url.searchParams.get('before');
      let sql = 'SELECT id, username, display_name, message, type, created_at FROM messages';
      if (before) sql += ' WHERE created_at < ?';
      sql += ' ORDER BY created_at DESC LIMIT ?';
      const params = before ? [before, limit] : [limit];
      const result = await this.state.storage.sql.prepare(sql).bind(...params).all();
      return Response.json({ messages: (result.results || []).reverse() });
    }

    // POST /system — system/narrator message
    if (request.method === 'POST' && (p === '/system' || url.pathname === '/system')) {
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
    if (p === '/ws' || url.pathname === '/ws' || url.pathname === '/chat/ws') {
      const username = url.searchParams.get('username');
      const displayName = url.searchParams.get('display_name') || username;

      if (!username) {
        return new Response('Username required', { status: 400 });
      }

      // Verify player exists in DB
      if (this.env.DB) {
        const player = await this.env.DB.prepare('SELECT username FROM bq_players WHERE username = ?').bind(username).first();
        if (!player) {
          return new Response('Player not found', { status: 403 });
        }
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const sessionId = crypto.randomUUID();
      this.connections.set(sessionId, { ws: server, username, displayName, lat: null, lon: null, hasLocation: false, lastPing: Date.now() });

      // Heartbeat to detect dead connections
      const hb = setInterval(() => {
        const conn = this.connections.get(sessionId);
        if (!conn) { clearInterval(hb); return; }
        if (Date.now() - conn.lastPing > 90000) {
          this.connections.delete(sessionId);
          clearInterval(hb);
          this.broadcast({ type: 'online_update', count: this.connections.size, username, action: 'leave' });
        }
      }, 30000);

      server.send(JSON.stringify({ type: 'ping' }));
      server.addEventListener('message', () => {
        const c = this.connections.get(sessionId);
        if (c) c.lastPing = Date.now();
      });

      // Send online count
      const playerList = [...this.connections.values()].map(c => ({ username: c.username, hasLocation: c.hasLocation }));
      server.send(JSON.stringify({ type: 'online', count: this.connections.size, players: playerList }));

      // Notify others
      this.broadcast({ type: 'online_update', count: this.connections.size, username });

      // Send history
      try {
        const result = await this.state.storage.sql.prepare(
          'SELECT id, username, display_name, message, type, created_at FROM messages ORDER BY created_at DESC LIMIT 50'
        ).bind().all();
        server.send(JSON.stringify({ type: 'history', messages: (result.results || []).reverse() }));
      } catch {}

      this.postSystemMessage(`${displayName} se unió al chat`).catch(() => {});

      server.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'chat' && data.message) {
            const trimmed = String(data.message).trim().slice(0, 500);
            if (!trimmed) return;

            await this.postMessage({
              username, display_name: displayName,
              message: trimmed, type: 'user'
            });

            // Albot Camus responds ~25% of the time
            if (Math.random() < 0.25 && username !== 'albot-camus') {
              await this.narratorRespond(trimmed, username);
            }
          }

          // Location update
          if (data.type === 'location' && data.lat && data.lon) {
            const conn = this.connections.get(sessionId);
            if (conn) {
              conn.lat = data.lat;
              conn.lon = data.lon;
              conn.hasLocation = true;
              conn.lastLocation = Date.now();
            }
          }

          // Capture broadcast
          if (data.type === 'capture') {
            this.broadcast({
              type: 'capture',
              username,
              bottle_id: data.bottle_id,
              bottle_title: data.title || 'Botella',
              trap: data.trap,
              challenge: data.challenge,
              created_at: new Date().toISOString()
            });
          }
          if (data.type === 'vote') {
            this.broadcast({
              type: 'vote',
              username,
              challenge: data.challenge,
              approved: data.approved,
              created_at: new Date().toISOString()
            });
          }
          if (data.type === 'pause' || data.type === 'resume') {
            this.broadcast({ type: data.type, username });
          }
        } catch (e) {
          console.error('WS message error:', e);
        }
      });

      server.addEventListener('close', () => {
        this.connections.delete(sessionId);
        this.broadcast({ type: 'online_update', count: this.connections.size, username, action: 'leave' });
        this.postSystemMessage(`${displayName} salió del chat`).catch(() => {});
      });

      server.addEventListener('error', () => {
        this.connections.delete(sessionId);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
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

      const resp = await this.env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
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
}
