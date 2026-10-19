import { request as httpRequest } from 'node:http'
import { pipeline } from 'node:stream/promises'

const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function endToEndHeaders(headers) {
  const excluded = new Set(hopHeaders)
  for (const name of String(headers.connection ?? '').split(',')) excluded.add(name.trim().toLowerCase())
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())))
}

export async function proxyNativeData(request, response, port) {
  const upstream = httpRequest({
    hostname: '127.0.0.1', port, method: request.method, path: request.url,
    headers: endToEndHeaders(request.headers),
    agent: false,
  })
  const abort = () => upstream.destroy()
  const deadline = setTimeout(() => {
    upstream.destroy(new Error('Native data delivery deadline exceeded'))
    if (response.headersSent) response.destroy()
  }, 60_000)
  deadline.unref?.()
  response.once('close', abort)
  upstream.setTimeout(30_000, () => upstream.destroy(new Error('Native data response timed out')))
  try {
    const incoming = await new Promise((resolve, reject) => {
      upstream.once('response', resolve)
      upstream.once('error', reject)
      upstream.once('close', () => reject(new Error('Native data connection closed before response')))
      request.once('aborted', abort)
      request.pipe(upstream)
    })
    response.writeHead(incoming.statusCode, endToEndHeaders(incoming.headers))
    await pipeline(incoming, response)
  } catch {
    if (response.headersSent) {
      response.destroy()
    } else if (!response.destroyed) {
      const body = '{"ok":false,"error":"Data service unavailable"}\n'
      response.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body),
      })
      response.end(request.method === 'HEAD' ? undefined : body)
    }
  } finally {
    clearTimeout(deadline)
    response.off('close', abort)
    request.off('aborted', abort)
    upstream.destroy()
  }
}
