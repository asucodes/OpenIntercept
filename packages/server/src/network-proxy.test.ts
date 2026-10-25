import { afterEach, expect, test } from "bun:test"
import { createServer, request } from "node:http"
import { createServer as tcpServer, connect as tcpConnect } from "node:net"
import { NetworkProxy } from "./network-proxy"

const servers: Array<{ close(cb?: () => void): void }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

test("optional proxy forwards plaintext HTTP and captures request/response", async () => {
  const origin = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": "sid=secret" })
    res.end(`received ${req.method} ${req.url}`)
  })
  servers.push(origin)
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve))
  const originPort = (origin.address() as { port: number }).port
  const captured: any[] = []
  const proxy = new NetworkProxy((exchange) => captured.push(exchange), 0)
  servers.push({ close: (cb) => { void proxy.stop().then(() => cb?.()) } })
  const status = await proxy.start()

  await new Promise<void>((resolve, reject) => {
    const outbound = request({
      host: status.host,
      port: status.port,
      method: "GET",
      path: `http://127.0.0.1:${originPort}/resource?q=1&api_token=secret`,
      headers: { "x-api-key": "secret" },
    }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => body += chunk)
      response.on("end", () => {
        expect(body).toContain("received GET /resource?q=1")
        resolve()
      })
    })
    outbound.on("error", reject)
    outbound.end()
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(captured).toHaveLength(1)
  expect(captured[0].channel).toBe("network")
  expect(captured[0].request.url).toContain("/resource?q=1&api_token=%5BREDACTED%5D")
  expect(captured[0].request.headers["x-api-key"]).toBe("[REDACTED]")
  expect(captured[0].response.status).toBe(200)
  expect(captured[0].response.body).toContain("received GET")
  expect(captured[0].response.headers["set-cookie"]).toBe("[REDACTED]")
})

test("CONNECT tunnels raw bytes and stop() resolves while the tunnel is OPEN (hang regression)", async () => {
  const echo = tcpServer()
  echo.on("connection", (sock) => sock.on("data", (d) => sock.write(d)))
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve))
  const echoPort = (echo.address() as { port: number }).port
  servers.push(echo)

  const captured: any[] = []
  const proxy = new NetworkProxy((exchange) => captured.push(exchange), 0)
  await proxy.start()

  const client = tcpConnect(proxy.status.port, "127.0.0.1")
  await new Promise<void>((resolve) => client.on("connect", resolve))
  client.write(`CONNECT 127.0.0.1:${echoPort}:443 HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`)
  await new Promise<void>((resolve) => client.once("data", (chunk) => {
    expect(chunk.toString()).toContain("200")
    resolve()
  }))
  const echoed = new Promise<string>((resolve) => client.once("data", (d) => resolve(d.toString())))
  client.write("tunneled-payload")
  expect(await echoed).toBe("tunneled-payload")
  expect(captured.some((x) => x.request.method === "CONNECT" && x.response?.body?.includes("encrypted TLS tunnel"))).toBe(true)

  // the regression: an OPEN tunnel must not wedge stop()
  const start = Date.now()
  await proxy.stop()
  expect(Date.now() - start).toBeLessThan(2_000)
  expect(proxy.status.running).toBe(false)
  client.destroy()
})

test("stop() on a never-started proxy is a no-op; start() is idempotent", async () => {
  const proxy = new NetworkProxy(() => {}, 0)
  await proxy.stop() // must not throw
  const s1 = await proxy.start()
  const s2 = await proxy.start()
  expect(s1.port).toBe(s2.port)
  await proxy.stop()
})
