import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.js';

function buildServer(store) {
  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/todos') {
      send(200, store.list());
      return;
    }
    if (req.method === 'POST' && req.url === '/todos') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const { title } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        send(201, store.add(title));
      } catch (error) {
        send(400, { error: String(error.message) });
      }
      return;
    }
    const match = req.url?.match(/^\/todos\/([^/]+)\/complete$/);
    if (req.method === 'POST' && match) {
      try {
        send(200, store.complete(decodeURIComponent(match[1])));
      } catch (error) {
        send(404, { error: String(error.message) });
      }
      return;
    }
    send(404, { error: 'not found' });
  });
}

export function createTodoServer(store = createStore()) {
  return buildServer(store);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createTodoServer().listen(port, '127.0.0.1', () => {
    console.log(`todo-app listening on http://127.0.0.1:${port}/`);
  });
}
