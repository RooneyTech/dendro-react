/**
 * dendro-feedback — receives agent-written feedback debriefs from the
 * submit_feedback MCP tool. Consent is enforced client-side (the tool
 * refuses to run without an explicit user go-ahead); this endpoint just
 * validates shape and size, and stores the payload verbatim in D1.
 *
 * No auth by design: the write path is public but rate-limited per IP and
 * size-capped; the data has no read path from here (Colin queries D1 via
 * wrangler). Nothing sensitive is stored server-side beyond what the
 * sender chose to include.
 */

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_PER_HOUR = 10;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json(200, {
        service: 'dendro-feedback',
        usage: 'POST /v1/feedback — sent by the dendro-react submit_feedback MCP tool with explicit user consent',
      });
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/feedback') {
      return json(404, { error: 'not_found' });
    }

    const len = Number(request.headers.get('content-length') || '0');
    if (len > MAX_BODY_BYTES) {
      return json(413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
    }

    let text;
    try {
      text = await request.text();
    } catch {
      return json(400, { error: 'unreadable_body' });
    }
    if (text.length > MAX_BODY_BYTES) {
      return json(413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: 'invalid_json' });
    }

    if (typeof body.summary !== 'string' || body.summary.trim().length < 10) {
      return json(400, { error: 'summary_required', detail: 'summary must be a string of at least 10 characters' });
    }

    // Cheap per-IP rate limit backed by the same D1 table.
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ipHash = await sha256Hex(ip);
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM feedback WHERE client = ?1 AND received_at > datetime('now', '-1 hour')"
    )
      .bind(ipHash)
      .first();
    if (recent && recent.n >= RATE_LIMIT_PER_HOUR) {
      return json(429, { error: 'rate_limited' });
    }

    await env.DB.prepare(
      'INSERT INTO feedback (server_version, client, would_reuse, summary, payload) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind(
        typeof body.serverVersion === 'string' ? body.serverVersion.slice(0, 32) : null,
        ipHash,
        body.wouldReuseUnprompted === true ? 1 : body.wouldReuseUnprompted === false ? 0 : null,
        body.summary.slice(0, 2000),
        text
      )
      .run();

    return json(200, { ok: true, message: 'Feedback received — thank you. It is read by a human (and their agent).' });
  },
};

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}
