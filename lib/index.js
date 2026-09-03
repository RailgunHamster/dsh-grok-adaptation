import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const name = "dsh-niuma-responses-ws";
const DEFAULT_MARKER_HEADER = "x-dsh-niuma-responses-ws";
const DEFAULT_MARKER_VALUE = "v2";
const DEFAULT_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const DEFAULT_WEBSOCKET_URL = "wss://api.niumacode.cc/v1/responses";

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
  if (input && typeof input.clone === "function") return input.clone().text();
  throw new Error("NiuMa WebSocket bridge could not read the Responses request body");
}

async function requestBodyTextIfAvailable(input, init) {
  try {
    return await requestBodyText(input, init);
  } catch {
    return undefined;
  }
}

function waitForSocket(socket, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      try { socket.close(); } catch {}
      finish(new Error("NiuMa WebSocket request aborted before connect"));
    };
    socket.once("open", () => finish());
    socket.once("error", (error) => finish(error));
    socket.once("unexpected-response", (_request, response) => finish(new Error(`NiuMa WebSocket handshake failed with HTTP ${response.statusCode}`)));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function bridgeFetch(input, init, config, rawBody, log) {
  const headers = requestHeaders(input, init);
  const authorization = headers.get("authorization");
  if (!authorization) throw new Error("NiuMa WebSocket bridge requires the request Authorization header");

  const body = JSON.parse(rawBody ?? await requestBodyText(input, init));
  delete body.stream;
  delete body.background;
  log(`bridge model=${body.model} inputItems=${Array.isArray(body.input) ? body.input.length : "?"} reasoning=${body.reasoning?.effort ?? "none"}`);
  const requestId = headers.get("x-client-request-id") || headers.get("session-id") || headers.get("session_id") || randomUUID();
  const socket = new WebSocket(config.websocketBaseURL, {
    headers: {
      Authorization: authorization,
      "OpenAI-Beta": config.websocketBeta,
      "x-client-request-id": requestId,
      "session-id": requestId
    },
    handshakeTimeout: config.handshakeTimeoutMs
  });
  await waitForSocket(socket, init?.signal);
  log("socket open");

  const encoded = new TextEncoder();
  let closed = false;
  let sawTerminal = false;
  const responseBody = new ReadableStream({
    start(controller) {
      const closeWithError = (error) => {
        if (closed) return;
        closed = true;
        const readable = error instanceof Error && error.message ? error.message : "NiuMa WebSocket stream failed";
        try { controller.error(new Error(readable)); } catch {}
        try { socket.close(); } catch {}
      };
      const closeNormally = () => {
        if (closed) return;
        closed = true;
        sawTerminal = true;
        try { controller.close(); } catch {}
        try { socket.close(); } catch {}
      };
      const failWithHttpError = (event) => {
        if (closed) return;
        closed = true;
        sawTerminal = true;
        const failure = event.type === "response.failed" ? event.response?.error : undefined;
        const message = failure?.message || event.message || "Bad Request";
        const type = failure?.type || event.code || "invalid_request_error";
        const code = failure?.code || event.code;
        log(`upstream error type=${event.type} message=${message}`);
        const bodyText = JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } });
        try {
          controller.enqueue(encoded.encode(bodyText));
          controller.close();
        } catch {}
        try { socket.close(); } catch {}
      };
      const onAbort = () => closeWithError(new Error("NiuMa WebSocket request aborted"));
      const onMessage = (data) => {
        if (closed) return;
        const text = data.toString();
        try {
          const event = JSON.parse(text);
          if (event.type === "error" || (event.type === "response.failed" && event.response?.error)) {
            failWithHttpError(event);
            return;
          }
          controller.enqueue(encoded.encode(`data: ${text}\n\n`));
          if (event.type === "response.completed") {
            log("response.completed");
            closeNormally();
          }
        } catch {
          controller.enqueue(encoded.encode(`data: ${text}\n\n`));
        }
      };
      socket.on("message", onMessage);
      socket.on("error", closeWithError);
      socket.on("close", (code, reason) => {
        log(`socket close code=${code} reason=${reason?.toString() ?? ""}`);
        if (closed) return;
        closeNormally();
      });
      if (init?.signal?.aborted) onAbort();
      else init?.signal?.addEventListener("abort", onAbort, { once: true });
      socket.send(JSON.stringify({ type: "response.create", ...body }));
    },
    cancel() {
      closed = true;
      try { socket.close(); } catch {}
    }
  });
  return new Response(responseBody, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}

function apply(ctx, config = {}) {
  const markerHeader = config.markerHeader || DEFAULT_MARKER_HEADER;
  const markerValue = config.markerValue || DEFAULT_MARKER_VALUE;
  const websocketBeta = config.websocketBeta || DEFAULT_WEBSOCKET_BETA;
  const websocketBaseURL = config.websocketBaseURL || DEFAULT_WEBSOCKET_URL;
  const autoModelPrefixes = Array.isArray(config.autoModelPrefixes) ? config.autoModelPrefixes : ["grok-"];
  const handshakeTimeoutMs = Number.isInteger(config.handshakeTimeoutMs) ? config.handshakeTimeoutMs : 30000;
  const debug = config.debug === true;
  const log = (message) => { if (debug && typeof console !== "undefined" && console.log) console.log(`[dsh-niuma-responses-ws] ${message}`); };

  ctx.effect(() => {
    const originalFetch = globalThis.fetch;
    const wrappedFetch = async (input, init) => {
      const url = requestURL(input);
      log(`fetch url=${url?.hostname ?? "?"}${url?.pathname ?? ""}`);
      if (url?.hostname !== "api.niumacode.cc" || url?.pathname.replace(/\/+$/, "") !== "/v1/responses") {
        return originalFetch(input, init);
      }
      const headers = requestHeaders(input, init);
      const marked = headers.get(markerHeader) === markerValue;
      log(`hit responses endpoint marked=${marked}`);
      if (marked) return bridgeFetch(input, init, { websocketBaseURL, websocketBeta, handshakeTimeoutMs }, undefined, log);

      // Old sessions may retain the model descriptor from before the route marker was added.
      const rawBody = await requestBodyTextIfAvailable(input, init);
      if (rawBody === undefined) { log("no body available -> direct"); return originalFetch(input, init); }
      let body;
      try { body = JSON.parse(rawBody); } catch { log("body not JSON -> direct"); return originalFetch(input, init); }
      const model = typeof body?.model === "string" ? body.model : "";
      const isAutoModel = autoModelPrefixes.some((prefix) => model.startsWith(prefix));
      log(`model=${model} auto=${isAutoModel}`);
      if (!isAutoModel) return originalFetch(input, init);
      return bridgeFetch(input, { ...init, body: rawBody }, { websocketBaseURL, websocketBeta, handshakeTimeoutMs }, rawBody, log);
    };
    globalThis.fetch = wrappedFetch;
    return () => {
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
    };
  });
}

export { apply, name };
