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

/** Flatten a Responses content-part array into plain text, substituting images. */
function contentToText(content, fallback) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fallback;
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part.type === "input_text" || part.type === "output_text") && part.text) parts.push(part.text);
    else if (part.type === "input_image") parts.push("[image omitted: upstream Grok rejects image blocks in tool outputs]");
  }
  return parts.length > 0 ? parts.join("\n") : fallback;
}

/**
 * Sub2API's Grok backend rejects `function_call_output` items whose output is
 * an array containing `input_image` parts with HTTP 400 "Upstream rejected
 * the request". Normalize every function_call_output to plain text.
 */
function sanitizeRequestBody(body) {
  if (!body || !Array.isArray(body.input)) return { changed: false, body };
  let changed = false;
  const input = body.input.map((item) => {
    if (!item || item.type !== "function_call_output" || typeof item.output === "string") return item;
    if (Array.isArray(item.output)) {
      changed = true;
      return { ...item, output: contentToText(item.output, "(no tool output)") };
    }
    return item;
  });
  return { changed, body: changed ? { ...body, input } : body };
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
      if (changed) log("stripped input_image from function_call_output");
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

export { apply, name, sanitizeRequestBody, contentToText };
