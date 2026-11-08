import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Vite-Plugin: der Dev-Server spielt das Handy (Big Screen, PLAN.md M18) — nur für
 * `npm run dev:bigscreen` (eigener Port, damit die IndexedDB getrennt bleibt).
 *   /bigscreen.json, /api/* → dev/simPhone.ts (derselbe Host-Code wie am Handy)
 *   WS /api/events          → minimaler WebSocket ohne Zusatzpaket
 * /catalog/* liefert Vite selbst aus public/catalog (wie die APK-Assets).
 */

interface SimPhone {
  handle(req: unknown, catalogDir: string): Promise<{ status: number; body: string; headers?: Record<string, string> }>;
  hello(session: string): Promise<string>;
  setTransport(t: { send: (msg: string, sessions?: string[]) => void; close: (sessions: string[], last?: string) => void }): void;
  SIM_PASSWORD: string;
}

function frame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export function bigscreenSim(): Plugin {
  const sockets = new Map<string, { session: string; socket: Duplex }>();
  let phone: SimPhone | null = null;
  const catalogDir = new URL('../public/catalog', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

  async function load(server: ViteDevServer): Promise<SimPhone> {
    if (phone) return phone;
    phone = (await server.ssrLoadModule('/dev/simPhone.ts')) as unknown as SimPhone;
    phone.setTransport({
      send: (msg, sessions) => {
        for (const s of sockets.values()) if (!sessions || sessions.includes(s.session)) s.socket.write(frame(msg));
      },
      close: (sessions, last) => {
        for (const [id, s] of sockets) {
          if (!sessions.includes(s.session)) continue;
          if (last) s.socket.write(frame(last));
          s.socket.end(frame('', 0x8));
          sockets.delete(id);
        }
      },
    });
    console.log(`\n  [Big-Screen-Simulator] Passwort: ${phone.SIM_PASSWORD}\n`);
    return phone;
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });
  }

  return {
    name: 'scryglass-bigscreen-sim',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (url === '/bigscreen.json') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ mode: 'bigscreen', deviceName: 'Simuliertes Handy', appVersion: 'dev', catalogGzip: false }));
          return;
        }
        if (!url.startsWith('/api/')) return next();
        const p = await load(server);
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const out = await p.handle({
          id: randomUUID(), method: req.method ?? 'GET', path: url, cookie: req.headers.cookie,
          body, remote: req.socket.remoteAddress ?? '127.0.0.1', userAgent: req.headers['user-agent'],
        }, catalogDir);
        res.statusCode = out.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
        res.end(out.body);
      });

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
        if (req.url !== '/api/events') return; // Vite-HMR & Co. nicht anfassen
        void (async () => {
          const p = await load(server);
          const auth = await p.handle({ id: randomUUID(), method: 'GET', path: '/api/ws-auth', cookie: req.headers.cookie }, catalogDir);
          if (auth.status !== 200) {
            socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
            return;
          }
          const session = (JSON.parse(auth.body) as { session: string }).session;
          const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          const id = randomUUID();
          sockets.set(id, { session, socket });
          socket.on('data', (buf: Buffer) => {
            if ((buf[0] & 0x0f) === 0x8) {
              sockets.delete(id);
              socket.end();
            }
          });
          socket.on('close', () => sockets.delete(id));
          socket.on('error', () => sockets.delete(id));
          socket.write(frame(await p.hello(session)));
        })();
      });
    },
  };
}
