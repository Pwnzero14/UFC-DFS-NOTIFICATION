// Local receiver for the FanDuel capture extension.
//
// The extension reads the odds JSON your own FanDuel tabs loaded and POSTs it
// here; this saves it where the FanDuel adapter reads it. Bound to 127.0.0.1
// only, so nothing off this machine can reach it, and it accepts nothing but a
// JSON body on POST /fanduel.

import http from 'node:http';
import { writeFile, rename } from 'node:fs/promises';

const MAX_BODY = 40 * 1024 * 1024;

export function startReceiver({ port, boardPath, log = console.log }) {
  if (!port) return null;

  const server = http.createServer((req, res) => {
    // The extension's background worker sends no page Origin, or a
    // chrome-extension:// one. A web page trying to post here would carry its
    // own https:// origin, and is refused.
    const origin = req.headers.origin || '';
    if (origin && !/^chrome-extension:\/\/|^moz-extension:\/\//.test(origin)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/fanduel') {
      res.writeHead(404).end();
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(body?.responses)) throw new Error('no responses array');
        const tmp = `${boardPath}.tmp`;
        await writeFile(tmp, JSON.stringify(body), 'utf8');
        await rename(tmp, boardPath).catch(() => writeFile(boardPath, JSON.stringify(body), 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      } catch (err) {
        res.writeHead(400).end(String(err.message).slice(0, 200));
      }
    });
  });

  server.on('error', (err) => log(`[receiver] could not listen on 127.0.0.1:${port} (${err.code || err.message})`));
  server.listen(port, '127.0.0.1', () => log(`Receiver : 127.0.0.1:${port} (FanDuel capture extension)`));
  return server;
}
