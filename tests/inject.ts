import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import type { Express } from "express";
// Exercise the actual Express middleware stack without opening a TCP listener.
export async function inject(
  app: Express,
  {
    url,
    method = "GET",
    headers = {},
    body,
    secure = false,
  }: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    secure?: boolean;
  },
) {
  const chunks: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  Object.defineProperty(socket, "encrypted", { value: secure });
  const req = new IncomingMessage(socket as any);
  req.url = url;
  req.method = method;
  req.complete = true;
  req.httpVersion = "1.1";
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.headers = {
    host: "127.0.0.1:3100",
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  if (body !== undefined) {
    const serialized = JSON.stringify(body);
    req.headers["content-type"] = "application/json";
    req.headers["content-length"] = String(Buffer.byteLength(serialized));
    req.push(serialized);
  }
  req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) => [
    k,
    String(v),
  ]);
  req.push(null);
  const res = new ServerResponse(req);
  res.assignSocket(socket as any);
  await new Promise<void>((resolve, reject) => {
    res.on("finish", resolve);
    res.on("error", reject);
    app(req as any, res as any);
  });
  const raw = Buffer.concat(chunks).toString();
  let text = raw.slice(raw.indexOf("\r\n\r\n") + 4);
  if (res.getHeader("transfer-encoding") === "chunked") {
    const decoded: string[] = [];
    while (text.length) {
      const end = text.indexOf("\r\n");
      const n = parseInt(text.slice(0, end), 16);
      if (!n) break;
      decoded.push(text.slice(end + 2, end + 2 + n));
      text = text.slice(end + 2 + n + 2);
    }
    text = decoded.join("");
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.statusCode, data, text, headers: res.getHeaders() };
}
