const ALLOWED_ORIGINS = new Set([
  "https://basilveerman.github.io",
  "https://play.basilveerman.com",
  "http://localhost:5173",
  "http://localhost:3000",
]);

const TILES_FILENAME = "west-north-america.pmtiles";

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const token  = req.headers.get("x-tile-token") || "";

    const knownOrigin = origin && ALLOWED_ORIGINS.has(origin);
    const validToken  = token === env.TILE_SECRET;

    if (!knownOrigin && !validToken) {
      return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(req.url);
    const key = url.pathname.replace(/^\//, "");
    if (key !== TILES_FILENAME) {
      return new Response("Not found", { status: 404 });
    }

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, knownOrigin),
      });
    }

    const rangeHeader = req.headers.get("Range");
    let r2Object;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
      if (match) {
        const [_, offset, end] = match;
        r2Object = await env.TILES.get(key, {
          range: {
            offset: Number(offset),
            length: end ? Number(end) - Number(offset) + 1 : undefined,
          },
        });
      }
    } else {
      r2Object = await env.TILES.get(key);
    }

    if (!r2Object) {
      return new Response("Not found", { status: 404 });
    }

    const headers = corsHeaders(origin, knownOrigin);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Cache-Control", "public, max-age=86400");
    if (r2Object.size) headers.set("Content-Length", String(r2Object.size));
    if (rangeHeader && r2Object.range) {
      const { offset, length } = r2Object.range;
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/*`);
    }

    return new Response(r2Object.body, {
      status: rangeHeader ? 206 : 200,
      headers,
    });
  },
};

function corsHeaders(origin, knownOrigin) {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", knownOrigin ? origin : "*");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Range, If-None-Match, x-tile-token");
  h.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}
