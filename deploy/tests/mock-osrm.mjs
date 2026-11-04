import { createServer } from 'node:http';

createServer((request, response) => {
  if (request.url.startsWith('/nearest/')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'Ok', waypoints: [{ location: [-65.2036, -26.8241] }] }));
  } else if (request.url.startsWith('/route/')) {
    const coordinates = request.url.split('?')[0].split('/').at(-1).split(';');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'Ok', routes: [{ duration: 1, legs: coordinates.slice(1).map(() => ({ distance: 1, duration: 1 })) }] }));
  } else {
    response.writeHead(404).end();
  }
}).listen(5000, '0.0.0.0');
