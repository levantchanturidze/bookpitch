import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { requireSession, UnauthenticatedError } from '@/lib/auth';
import { CHANNEL, type NotificationEvent } from '@/lib/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/notifications/stream — Server-Sent Events feed for the caller's
// org. Opens a dedicated pg.Client (outside Prisma's pool) that LISTENs on
// the bookpitch_events channel; every notification whose orgId matches the
// session is pushed as an SSE `data:` frame.
//
// Client disconnection is handled by the stream's `cancel()` — we UNLISTEN
// and close the pg client so we don't leak connections.
export async function GET() {
  let session;
  try {
    session = await requireSession();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const orgId = session.organizationId;
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL;
  if (!connectionString) {
    return NextResponse.json({ error: 'DB not configured' }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const pg = new Client({ connectionString });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: string) => controller.enqueue(encoder.encode(line));
      const sendEvent = (event: NotificationEvent) =>
        send(`data: ${JSON.stringify(event)}\n\n`);

      try {
        await pg.connect();
        await pg.query(`LISTEN ${CHANNEL}`);
      } catch (err) {
        send(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
        controller.close();
        return;
      }

      // Kickoff frame lets the client know the stream is live.
      send(`: connected orgId=${orgId}\n\n`);

      pg.on('notification', (msg) => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        try {
          const event = JSON.parse(msg.payload) as NotificationEvent;
          if (event.orgId === orgId) sendEvent(event);
        } catch {
          // Malformed payload — ignore.
        }
      });

      pg.on('error', (err) => {
        try {
          send(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
        } finally {
          controller.close();
        }
      });

      // Heartbeat — comment line every 25s so intermediaries don't reap us.
      const heartbeat = setInterval(() => {
        try {
          send(`: ping ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000);

      // Stow cleanup on the controller so cancel() can reach it.
      (controller as unknown as { _cleanup?: () => void })._cleanup = () => {
        clearInterval(heartbeat);
        pg.query(`UNLISTEN ${CHANNEL}`)
          .catch(() => null)
          .finally(() => pg.end().catch(() => null));
      };
    },
    cancel(reason) {
      // Client aborted (tab closed, refresh…). Release the pg connection.
      const cleanup = (this as unknown as { _cleanup?: () => void })._cleanup;
      if (cleanup) cleanup();
      void reason;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // hint for nginx-style proxies
    },
  });
}
