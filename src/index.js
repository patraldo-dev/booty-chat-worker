// Edge Worker — routes requests to Durable Objects
// - /chat/* → BootyChatRoom (bottle game chat)
// - /portal-ws/* → PortalRoom (portal avatar sync)
import { BootyChatRoom } from './booty-chat.js';
import { PortalRoom } from './portal-room.js';

export { BootyChatRoom, PortalRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'edge-worker', rooms: ['chat', 'portal-ws'] });
    }

    // Route all /chat/* requests to the global BootyChatRoom DO
    if (path.startsWith('/chat')) {
      const id = env.BOOTY_CHAT.idFromName('global-room');
      const stub = env.BOOTY_CHAT.get(id);
      // Pass the original request — constructing a new Request() strips the
      // WebSocket upgrade status for WS connections.
      return stub.fetch(request);
    }

    // Route /portal-ws/* requests to a per-portal PortalRoom DO.
    // The portalId comes from the ?room= query param.
    if (path.startsWith('/portal-ws')) {
      const roomId = url.searchParams.get('room') || 'default';
      const id = env.PORTAL_ROOM.idFromName(roomId);
      const stub = env.PORTAL_ROOM.get(id);

      // Pass the ORIGINAL request — constructing a new Request() strips the
      // WebSocket upgrade status, causing "tried to return a WebSocket in a
      // response to a request which did not contain Upgrade: websocket".
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};
