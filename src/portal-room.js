// PortalRoom — Durable Object for real-time avatar sync in the portals.
// Each DO instance = one portal world (keyed by portalId). WebSocket-based
// pose broadcasting. No persistence — poses are ephemeral (in-memory only).
//
// Modeled on BootyChatRoom but streamlined: no SQLite, no chat, no AI.
// Just connection tracking + pose fan-out.

export class PortalRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // sessionId → { ws, userId, displayName, x, y, z, yaw, lastUpdate, lastPing }
    this.connections = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade at /ws
    if (url.pathname === '/ws') {
      const userId = url.searchParams.get('user') || crypto.randomUUID();
      const displayName = url.searchParams.get('name') || 'visitor';
      const avatar = url.searchParams.get('avatar') || null;

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const sessionId = crypto.randomUUID();

      this.connections.set(sessionId, {
        ws: server, userId, displayName, avatar,
        x: 0, y: 1.5, z: 3, yaw: 0,
        lastUpdate: 0, lastPing: Date.now(),
      });

      // Heartbeat — reap dead connections every 30s
      const hb = setInterval(() => {
        const conn = this.connections.get(sessionId);
        if (!conn) { clearInterval(hb); return; }
        if (Date.now() - conn.lastPing > 90000) {
          this.connections.delete(sessionId);
          clearInterval(hb);
          this.broadcast({ type: 'peer_left', sessionId }, sessionId);
        }
      }, 30000);

      server.send(JSON.stringify({ type: 'ping' }));
      server.addEventListener('message', () => {
        const c = this.connections.get(sessionId);
        if (c) c.lastPing = Date.now();
      });

      // Send current roster (all connected peers + their last known positions)
      const roster = [...this.connections.entries()]
        .filter(([id]) => id !== sessionId)
        .map(([id, c]) => ({ sessionId: id, userId: c.userId, displayName: c.displayName, avatar: c.avatar, x: c.x, y: c.y, z: c.z, yaw: c.yaw }));
      server.send(JSON.stringify({ type: 'roster', peers: roster }));

      // Notify others that this peer joined
      this.broadcast({ type: 'peer_joined', sessionId, userId, displayName, avatar, x: 0, y: 1.5, z: 3, yaw: 0 }, sessionId);

      // Handle incoming messages (pose updates + WebRTC signaling)
      server.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'pose') {
            const conn = this.connections.get(sessionId);
            if (!conn) return;
            // Throttle: ignore poses more frequent than every 50ms
            const now = Date.now();
            if (now - conn.lastUpdate < 50) return;
            conn.x = data.x;
            conn.y = data.y;
            conn.z = data.z;
            conn.yaw = data.yaw;
            conn.lastUpdate = now;
            // Broadcast to all OTHER connections (not back to sender)
            this.broadcast({ type: 'peer_pose', sessionId, x: data.x, y: data.y, z: data.z, yaw: data.yaw }, sessionId);
          }

          // Profile broadcast: a peer announces its avatar URL (sent as a WS
          // message rather than in the connect URL, which broke on long URLs).
          // Store on the connection + relay so others can render the photo face.
          if (data.type === 'profile') {
            const conn = this.connections.get(sessionId);
            if (!conn) return;
            conn.avatar = data.avatar || null;
            this.broadcast({ type: 'peer_profile', sessionId, avatar: data.avatar || null, displayName: conn.displayName }, sessionId);
          }

          // WebRTC signaling relay — forward to the specific target peer.
          // The DO never touches audio; it only relays connection setup JSON.
          if (data.type === 'rtc_offer' || data.type === 'rtc_answer' || data.type === 'rtc_ice') {
            const targetConn = this.connections.get(data.to);
            if (targetConn) {
              targetConn.ws.send(JSON.stringify({
                ...data,
                from: sessionId,  // stamp with the actual sender
              }));
            }
          }
        } catch (e) {
          // ignore malformed messages
        }
      });

      // Cleanup on disconnect
      server.addEventListener('close', () => {
        this.connections.delete(sessionId);
        this.broadcast({ type: 'peer_left', sessionId }, sessionId);
      });
      server.addEventListener('error', () => {
        this.connections.delete(sessionId);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '') {
      return Response.json({ status: 'ok', service: 'portal-room', connections: this.connections.size });
    }

    return new Response('Not found', { status: 404 });
  }

  // Broadcast to all connections EXCEPT the sender (excludeId).
  // If excludeId is omitted, broadcasts to everyone.
  broadcast(msg, excludeId) {
    const data = JSON.stringify(msg);
    for (const [id, conn] of this.connections) {
      if (id === excludeId) continue;
      try { conn.ws.send(data); } catch {}
    }
  }
}
