import sharp from "sharp";

const name = "dsh-grok-adaptation";
const DEFAULT_MARKER_HEADER = "x-dsh-grok-adaptation";
const DEFAULT_MARKER_VALUE = "v2";
const MIN_IMAGE_SIZE = 24;
const TARGET_IMAGE_SIZE = 32;

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
    const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(out);
  }
  if (input && typeof input.clone === "function") return input.clone().text();
  return undefined;
}

function dataImageBuffer(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const header = url.slice(5, comma);
  if (!/;base64(?:;|$)/i.test(header)) return undefined;
  const mediaType = header.split(";", 1)[0].toLowerCase();
  if (!mediaType.startsWith("image/")) return undefined;
  try {
    return { mediaType, buffer: Buffer.from(url.slice(comma + 1), "base64") };
  } catch {
    return undefined;
  }
}

function imageURL(part) {
  if (!part || typeof part !== "object") return undefined;
  if (typeof part.image_url === "string") return part.image_url;
  if (part.image_url && typeof part.image_url.url === "string") return part.image_url.url;
  return undefined;
}

function withImageURL(part, url) {
  if (typeof part.image_url === "string") return { ...part, image_url: url };
  return { ...part, image_url: { ...part.image_url, url } };
}

/**
 * Decode an undersized image with libvips and re-encode it as a nearest-neighbor
 * 32x32 PNG. Sharp supports the raster formats used by DSH (PNG, JPEG, GIF,
 * WebP, TIFF, AVIF, and more), so the plugin does not maintain format-specific
 * decoders of its own.
 */
async function resizeSmallImage(part, width, height) {
  const parsed = dataImageBuffer(imageURL(part));
  if (!parsed) return undefined;
  try {
    const output = await sharp(parsed.buffer, { animated: false, failOn: "error" })
      .resize({
        width: TARGET_IMAGE_SIZE,
        height: TARGET_IMAGE_SIZE,
        fit: "contain",
        position: "centre",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: sharp.kernel.nearest,
      })
      .png()
      .toBuffer();
    const scale = Math.min(TARGET_IMAGE_SIZE / width, TARGET_IMAGE_SIZE / height);
    const contentWidth = Math.max(1, Math.round(width * scale));
    const contentHeight = Math.max(1, Math.round(height * scale));
    return {
      part: withImageURL(part, `data:image/png;base64,${output.toString("base64")}`),
      note: {
        type: "input_text",
        text: `[image rescaled from ${width}x${height} to ${contentWidth}x${contentHeight} on a ${TARGET_IMAGE_SIZE}x${TARGET_IMAGE_SIZE} transparent canvas with nearest-neighbor sampling]`,
      },
    };
  } catch {
    return undefined;
  }
}

async function imageDimensions(part) {
  const parsed = dataImageBuffer(imageURL(part));
  if (!parsed) return undefined;
  try {
    const metadata = await sharp(parsed.buffer, { animated: false, failOn: "error" }).metadata();
    if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) return undefined;
    return { width: metadata.width, height: metadata.height };
  } catch {
    return undefined;
  }
}

async function processParts(parts, stats) {
  let changed = false;
  const output = [];
  for (const part of parts) {
    if (!part || typeof part !== "object" || part.type !== "input_image") {
      output.push(part);
      continue;
    }
    const dims = await imageDimensions(part);
    if (!dims || (dims.width > MIN_IMAGE_SIZE && dims.height > MIN_IMAGE_SIZE)) {
      output.push(part);
      continue;
    }
    const resized = await resizeSmallImage(part, dims.width, dims.height);
    changed = true;
    if (resized) {
      stats.rescaled++;
      output.push(resized.note, resized.part);
    } else {
      stats.failed++;
      output.push({
        type: "input_text",
        text: `[image ${dims.width}x${dims.height} could not be decoded for the upstream 24px minimum]`,
      });
    }
  }
  return changed ? output : parts;
}

/** Process image parts in both user-message content and tool-result replays. */
async function sanitizeRequestBody(body) {
  if (!body || !Array.isArray(body.input)) return { changed: false, body, rescaled: 0, failed: 0 };
  const stats = { rescaled: 0, failed: 0 };
  let changed = false;
  const input = [];
  for (const item of body.input) {
    if (item?.type === "function_call_output" && Array.isArray(item.output)) {
      const output = await processParts(item.output, stats);
      if (output !== item.output) changed = true;
      input.push(output === item.output ? item : { ...item, output });
    } else if (item?.type === "message" && Array.isArray(item.content)) {
      const content = await processParts(item.content, stats);
      if (content !== item.content) changed = true;
      input.push(content === item.content ? item : { ...item, content });
    } else {
      input.push(item);
    }
  }
  return { changed, body: changed ? { ...body, input } : body, ...stats };
}

function apply(ctx, config = {}) {
  const markerHeader = config.markerHeader || DEFAULT_MARKER_HEADER;
  const markerValue = config.markerValue || DEFAULT_MARKER_VALUE;
  const autoModelPrefixes = Array.isArray(config.autoModelPrefixes) ? config.autoModelPrefixes : ["grok-"];
  const debug = config.debug === true;
  const log = (message) => {
    if (debug && typeof console !== "undefined" && console.log) console.log(`[dsh-grok-adaptation] ${message}`);
  };

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
      if (rawBody === undefined) {
        log("no body readable -> passthrough");
        return originalFetch(input, init);
      }
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        log("body not JSON -> passthrough");
        return originalFetch(input, init);
      }
      const model = typeof body?.model === "string" ? body.model : "";
      const isAutoModel = autoModelPrefixes.some((prefix) => model.startsWith(prefix));
      log(`model=${model} auto=${isAutoModel}`);
      if (!isAutoModel) return forwardFetch(originalFetch, input, init, url, headers, rawBody);

      const { changed, body: sanitized, rescaled, failed } = await sanitizeRequestBody(body);
      if (rescaled > 0) log(`rescaled ${rescaled} sub-24px image(s) to 32x32`);
      if (failed > 0) log(`could not decode ${failed} sub-24px image(s)`);
      if (!changed) return forwardFetch(originalFetch, input, init, url, headers, rawBody);
      const text = JSON.stringify(sanitized);
      const nextHeaders = new Headers(headers);
      nextHeaders.delete("content-length");
      nextHeaders.set("content-length", String(Buffer.byteLength(text)));
      return forwardFetch(originalFetch, input, init, url, nextHeaders, text);
    };
    globalThis.fetch = wrappedFetch;
    return () => {
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
    };
  });
}

function forwardFetch(originalFetch, input, init, url, headers, body) {
  const method = init.method || (input && typeof input === "object" && input.method) || "POST";
  const signal = init.signal || (input && typeof input === "object" ? input.signal : undefined);
  return originalFetch(url.toString(), { ...init, method, headers, body, signal });
}

export { apply, name, sanitizeRequestBody, imageDimensions, resizeSmallImage };
