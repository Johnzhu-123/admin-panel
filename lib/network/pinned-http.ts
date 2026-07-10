import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export type PinnedAddress = {
  address: string;
  family: 4 | 6;
};

export type ResolvedHttpTarget = {
  url: URL;
  addresses: PinnedAddress[];
};

const toRequestBody = async (body: BodyInit | null | undefined) => {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  throw new TypeError("Pinned HTTP transport does not support this request body type.");
};

const headersToNode = (headers: Headers) => {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const sanitizeRequestHeaders = (headers: Headers, url: URL, body?: string | Buffer) => {
  for (const name of [
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }
  headers.set("host", url.host);
  headers.set("accept-encoding", "identity");
  if (body !== undefined) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }
};

const responseHeaders = (raw: Record<string, string | string[] | undefined>) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
};

async function requestOne(
  target: ResolvedHttpTarget,
  address: PinnedAddress,
  init: RequestInit,
  body: string | Buffer | undefined
): Promise<Response> {
  const url = target.url;
  const isHttps = url.protocol === "https:";
  const headers = new Headers(init.headers);
  sanitizeRequestHeaders(headers, url, body);

  const signal = init.signal;
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }

  return new Promise<Response>((resolve, reject) => {
    let incomingResponse: import("node:http").IncomingMessage | undefined;
    const cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      const reason =
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError");
      incomingResponse?.destroy(reason);
      request.destroy(reason);
    };
    const request = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || (isHttps ? 443 : 80),
        method: (init.method || "GET").toUpperCase(),
        path: `${url.pathname}${url.search}`,
        headers: headersToNode(headers),
        ...(isHttps ? { servername: url.hostname } : {}),
      },
      (incoming) => {
        incomingResponse = incoming;
        incoming.once("close", cleanupAbort);
        incoming.once("end", cleanupAbort);
        incoming.once("error", cleanupAbort);
        const status = incoming.statusCode || 502;
        const method = (init.method || "GET").toUpperCase();
        const hasBody = method !== "HEAD" && status !== 204 && status !== 205 && status !== 304;
        const stream = hasBody
          ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
          : null;
        if (!hasBody) incoming.resume();
        resolve(
          new Response(stream, {
            status,
            statusText: incoming.statusMessage || "",
            headers: responseHeaders(incoming.headers),
          })
        );
      }
    );

    request.once("error", (error) => {
      cleanupAbort();
      reject(error);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => {
      if (!incomingResponse) cleanupAbort();
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export async function requestPinnedHttpTarget(
  target: ResolvedHttpTarget,
  init: RequestInit = {}
): Promise<Response> {
  if (!target.addresses.length) {
    throw new Error("Pinned HTTP target has no validated address.");
  }
  const method = (init.method || "GET").toUpperCase();
  const body = await toRequestBody(init.body);
  const mayRetryAddress = method === "GET" || method === "HEAD";
  let lastError: unknown;

  for (const address of target.addresses) {
    try {
      return await requestOne(target, address, init, body);
    } catch (error) {
      lastError = error;
      if (!mayRetryAddress || init.signal?.aborted) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Pinned HTTP connection failed.");
}
