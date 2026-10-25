import { createServer, request as httpRequest } from "node:http"
import { connect as netConnect, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import type { TrafficExchange } from "@openintercept/protocol"

const BODY_LIMIT = 64 * 1024
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i
const SECRET_QUERY = /(key|token|secret|auth|password)/i

function safeUrl(raw: string) {
  try {
    const url = new URL(raw)
    url.username = ""
    url.password = ""
    for (const key of [...url.searchParams.keys()]) if (SECRET_QUERY.test(key)) url.searchParams.set(key, "[REDACTED]")
    return url.toString()
  } catch {
    return raw
  }
}

function headersOf(headers: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(Object.entries(headers)
    .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
    .map(([name, value]) => [name, SECRET_HEADER.test(name) ? "[REDACTED]" : Array.isArray(value) ? value.join(", ") : value]))
}

function preview(chunks: Uint8Array[], type: string | undefined, truncated = false) {
  if (type && !/(json|text|xml|javascript|x-www-form-urlencoded)/i.test(type)) return `[non-text body omitted: ${type}]`
  let size = 0
  const kept: Uint8Array[] = []
  for (const chunk of chunks) {
    const take = chunk.subarray(0, Math.max(0, BODY_LIMIT - size))
    if (take.length) kept.push(take)
    size += take.length
    if (size >= BODY_LIMIT) break
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of kept) { bytes.set(chunk, offset); offset += chunk.length }
  const text = new TextDecoder().decode(bytes)
  return truncated ? `${text}\n[OpenIntercept capture truncated at ${BODY_LIMIT} bytes]` : text
}

/** Optional local proxy. HTTP is inspected; HTTPS CONNECT is passed through
 *  as an encrypted tunnel, so this does not claim to decrypt TLS traffic. */
export class NetworkProxy {
  private server: Server | null = null
  private listenPort: number | null = null
  /** every live socket (clients + tunneled connections) so stop() can tear
   *  them down — server.close() alone waits for open connections forever,
   *  and CONNECT tunnels never end on their own */
  private sockets = new Set<Socket>()

  constructor(private readonly onExchange: (exchange: TrafficExchange) => void, private readonly port = 7475) {}

  get status() {
    return { running: this.server?.listening === true, host: "127.0.0.1", port: this.listenPort ?? this.port }
  }

  private track(socket: Socket) {
    this.sockets.add(socket)
    socket.once("close", () => this.sockets.delete(socket))
  }

  async start() {
    if (this.server?.listening) return this.status
    const server = createServer((req, res) => {
      const id = randomUUID()
      const startedAt = Date.now()
      this.track(req.socket)
      this.track(res.socket ?? req.socket)
      const requestChunks: Uint8Array[] = []
      let requestSize = 0
      let requestTotal = 0
      req.on("data", (chunk: Uint8Array) => {
        requestTotal += chunk.length
        if (requestSize < BODY_LIMIT) {
          const kept = chunk.subarray(0, BODY_LIMIT - requestSize)
          requestChunks.push(kept)
          requestSize += kept.length
        }
      })
      let target: URL
      try {
        target = new URL(req.url ?? "/")
        if (target.protocol !== "http:") throw new Error("Only plaintext HTTP can be inspected; use CONNECT for HTTPS")
      } catch {
        res.writeHead(400, { "content-type": "text/plain" })
        res.end("OpenIntercept proxy expects an absolute http:// URL")
        return
      }
      const upstream = httpRequest(target, {
        method: req.method,
        headers: { ...req.headers, host: target.host },
      }, (upstreamResponse) => {
        const responseChunks: Uint8Array[] = []
        let responseSize = 0
        let responseTotal = 0
        upstreamResponse.on("data", (chunk: Uint8Array) => {
          responseTotal += chunk.length
          if (responseSize < BODY_LIMIT) {
            const kept = chunk.subarray(0, BODY_LIMIT - responseSize)
            responseChunks.push(kept)
            responseSize += kept.length
          }
        })
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(res)
        upstreamResponse.on("end", () => {
          this.onExchange({
            id,
            channel: "network",
            startedAt,
            request: {
              method: req.method ?? "GET",
              url: safeUrl(target.toString()),
              headers: headersOf(req.headers),
              body: preview(requestChunks, req.headers["content-type"]?.toString(), requestTotal > BODY_LIMIT),
            },
            response: {
              at: Date.now(),
              status: upstreamResponse.statusCode ?? 502,
              statusText: upstreamResponse.statusMessage,
              headers: headersOf(upstreamResponse.headers),
              body: preview(responseChunks, upstreamResponse.headers["content-type"]?.toString(), responseTotal > BODY_LIMIT),
            },
          })
        })
      })
      upstream.on("error", (error) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
        res.end(`OpenIntercept proxy upstream error: ${error.message}`)
      })
      req.pipe(upstream)
    })

    server.on("connect", (req, client: Socket, head) => {
      this.track(client)
      const [host, rawPort] = (req.url ?? "").split(":")
      const port = Number(rawPort || 443)
      const upstream = netConnect(port, host)
      this.track(upstream)
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.length) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
        this.onExchange({
          id: randomUUID(), channel: "network", startedAt: Date.now(),
          request: { method: "CONNECT", url: `https://${req.url}`, headers: headersOf(req.headers) },
          response: { at: Date.now(), status: 200, statusText: "Connection Established", headers: {}, body: "[encrypted TLS tunnel; payload not inspected]" },
        })
      })
      upstream.on("error", () => {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
      })
      client.on("error", () => upstream.destroy())
    })

    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", reject)
        this.listenPort = (server.address() as { port: number }).port
        resolve()
      })
    })
    return this.status
  }

  async stop() {
    const server = this.server
    this.server = null
    this.listenPort = null
    if (!server?.listening) return
    // destroy every live socket first: close() only waits for them, and
    // CONNECT tunnels would hold it open indefinitely (the stop() hang)
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => {
      // belt and braces: never let a straggler socket wedge the toggle
      const fallback = setTimeout(resolve, 1_000)
      server.close(() => {
        clearTimeout(fallback)
        resolve()
      })
    })
  }
}
