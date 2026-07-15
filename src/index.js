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

      const doPath = path.replace('/chat', '') || '/messages';
      const doUrl = new URL(request.url);
      doUrl.pathname = doPath;
      const doRequest = new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' ? request.body : undefined
      });

      return stub.fetch(doRequest);
    }

    // Route /portal-ws/* requests to a per-portal PortalRoom DO.
    // The portalId comes from the ?room= query param.
    if (path.startsWith('/portal-ws')) {
      const roomId = url.searchParams.get('room') || 'default';
      const id = env.PORTAL_ROOM.idFromName(roomId);
      const stub = env.PORTAL_ROOM.get(id);

      // Forward the request to the DO (path becomes /ws for the DO)
      const doUrl = new URL(request.url);
      doUrl.pathname = '/ws';
      const doRequest = new Request(doUrl.toString(), {
        headers: request.headers,
      });

      return stub.fetch(doRequest);
    }

    return new Response('Not found', { status: 404 });
  }
};
