// Booty Chat Worker — routes requests to the Durable Object
import { BootyChatRoom } from './booty-chat.js';

export { BootyChatRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'booty-chat-worker' });
    }

    // Route all /chat/* requests to the global DO room
    if (path.startsWith('/chat')) {
      const id = env.BOOTY_CHAT.idFromName('global-room');
      const stub = env.BOOTY_CHAT.get(id);

      // Rewrite path for the DO
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

    return new Response('Not found', { status: 404 });
  }
};
