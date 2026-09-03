import { randomUUID } from "node:crypto";

const name = "dsh-niuma-responses-ws";
const DEFAULT_MARKER_HEADER = "x-dsh-niuma-responses-ws";
const DEFAULT_MARKER_VALUE = "v2";

function requestURL(input) {
  if (typeof input === "string" || input instanceof URL) return new URL(String(input));
  if (input && typeof input.url === "string") return new URL(input.url);
  return undefined;
}

function requestHeaders(input, init) {
  const headers = new Headers(input && typeof input === "object" ? input.headers : undefined);
  for (const [key, value] of new Headers(init?.headers).entries()) headers.set(key, value);
  return headers;
}

async function requestBodyText(input, init) {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
  if (init?.body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(init.body));
  if (init?.body && typeof init.body.getReader === "function") {
    const reader = init.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return new TextDecoder().decode(out);
  }
  if (input && typeof input.clone === "function") return input.clone().text();
  return undefined;
}

/**
 * Sub2API's Grok backend rejects `function_call_output` items whose output
 * contains an `input_image` part smaller than or equal to 24x24 (HTTP 400
 * "Upstream rejected the request"). Larger images pass through untouched.
 * Only the undersized images are downgraded to a text note.
 */
function sanitizeRequestBody(body) {
  if (!body || !Array.isArray(body.input)) return { changed: false, body };
  let changed = false;
  const input = body.input.map((item) => {
    if (!item || item.type !== "function_call_output" || typeof item.output === "string") return item;
    if (Array.isArray(item.output)) {
      const next = sanitizeOutputParts(item.output);
      if (next !== item.output) {
        changed = true;
        return { ...item, output: next };
      }
    }
    return item;
  });
  return { changed, body: changed ? { ...body, input } : body };
}

/** Keep only readable content parts; downgrade images that do not clear the 24px minimum. */
function sanitizeOutputParts(parts) {
  const out = [];
  let touched = false;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_text" || part.type === "output_text") {
      out.push(part);
      continue;
    }
    if (part.type !== "input_image") continue;
    const dims = imageDimensions(part);
    if (dims !== undefined && dims.width > MIN_IMAGE_SIZE && dims.height > MIN_IMAGE_SIZE) {
      out.push(part);
    } else {
      touched = true;
      const note = dims === undefined
        ? "[image omitted: unreadable image data]"
        : `[image omitted: ${dims.width}x${dims.height} below the 24x24 minimum accepted by upstream Grok]`;
      out.push({ type: "input_text", text: note });
    }
  }
  if (!touched) return parts;
  return out.length > 0 ? out : [{ type: "input_text", text: "(no readable tool output)" }];
}

/** Minimum image edge (px) Sub2API Grok accepts; strictly smaller images must be stripped. */
const MIN_IMAGE_SIZE = 24;

/**
 * Read image dimensions from an input_image data URI header without a full
 * decoder. Returns undefined when the data URI is not one of the formats this
 * parser understands, so an unknown-but-valid image is never dropped.
 */
function imageDimensions(part) {
  const url = part && typeof part === "object" ? part.image_url : undefined;
  if (typeof url !== "string" || !url.startsWith("data:")) return undefined;
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) return undefined;
  const fmt = m[1];
  const buf = Buffer.from(m[2], "base64");
  try {
    if (fmt === "png") {
      if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (fmt === "gif") {
      if (buf.length < 10 || buf.toString("ascii", 0, 6) !== "GIF89a" && buf.toString("ascii", 0, 6) !== "GIF87a") return undefined;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (fmt === "jpeg" || fmt === "jpg") return jpegDimensions(buf);
    if (fmt === "webp") return webpDimensions(buf);
  } catch {}
  return undefined;
}

function jpegDimensions(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < buf.length) {
    if (buf[at] !== 0xff) { at++; continue; }
    const marker = buf[at + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const len = buf.readUInt16BE(at + 2);
    if (len < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(at + 5), width: buf.readUInt16BE(at + 7) };
    }
    at += 2 + len;
  }
  return undefined;
}

function webpDimensions(buf) {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const tag = buf.toString("ascii", 12, 16);
  if (tag === "VP8X") {
    const w = 1 + buf.readUIntLE(24, 3);
    const h = 1 + buf.readUIntLE(27, 3);
    return { width: w, height: h };
  }
  if (tag === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (tag === "VP8 ") {
    if (buf.length < 30) return undefined;
    const w = buf.readUInt16LE(26) & 0x3fff;
    const h = buf.readUInt16LE(28) & 0x3fff;
    return { width: w, height: h };
  }
  return undefined;
}

function apply(ctx, config = {}) {
  const markerHeader = config.markerHeader || DEFAULT_MARKER_HEADER;
  const markerValue = config.markerValue || DEFAULT_MARKER_VALUE;
  const autoModelPrefixes = Array.isArray(config.autoModelPrefixes) ? config.autoModelPrefixes : ["grok-"];
  const debug = config.debug === true;
  const log = (message) => { if (debug && typeof console !== "undefined" && console.log) console.log(`[dsh-niuma-responses-ws] ${message}`); };

  ctx.effect(() => {
    const originalFetch = globalThis.fetch;
    const wrappedFetch = async (input, init = {}) => {
      const url = requestURL(input);
      const isResponses =
        url?.hostname === "api.niumacode.cc" &&
        (url?.pathname.replace(/\/+$/, "") === "/v1/responses" || url?.pathname.replace(/\/+$/, "") === "/responses");
      if (!isResponses) return originalFetch(input, init);
      const headers = requestHeaders(input, init);
      const marked = headers.get(markerHeader) === markerValue;
      log(`responses endpoint hit marked=${marked}`);

      const rawBody = await requestBodyText(input, init);
      if (rawBody === undefined) { log("no body readable -> passthrough"); return originalFetch(input, init); }
      let body;
      try { body = JSON.parse(rawBody); } catch { log("body not JSON -> passthrough"); return originalFetch(input, init); }
      const model = typeof body?.model === "string" ? body.model : "";
      const isAutoModel = autoModelPrefixes.some((prefix) => model.startsWith(prefix));
      log(`model=${model} auto=${isAutoModel}`);
      if (!marked && !isAutoModel) return originalFetch(input, init);

      const { changed, body: sanitized } = sanitizeRequestBody(body);
      if (changed) log("downgraded sub-24px input_image inside function_call_output");
      const text = JSON.stringify(sanitized);
      const nextHeaders = new Headers(headers);
      nextHeaders.set("content-length", String(Buffer.byteLength(text)));
      return originalFetch(url.toString(), { ...init, body: text, headers: nextHeaders });
    };
    globalThis.fetch = wrappedFetch;
    return () => {
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
    };
  });
}

export { apply, name, sanitizeRequestBody, imageDimensions };
