import fastify from 'fastify'
import cors from '@fastify/cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import { nanoid } from 'nanoid'
import { Readable } from 'stream'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = fastify()

await app.register(cors, { origin: true, credentials: true })

const dataDir = path.join(__dirname, 'data')
const modelsFile = path.join(dataDir, 'models.json')
const logsFile = path.join(dataDir, 'logs.json')

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
if (!fs.existsSync(modelsFile)) fs.writeFileSync(modelsFile, JSON.stringify([]))
if (!fs.existsSync(logsFile)) fs.writeFileSync(logsFile, JSON.stringify([]))

function readJSON(p) {
  try {
    const s = fs.readFileSync(p, 'utf-8')
    return JSON.parse(s || '[]')
  } catch {
    return []
  }
}

function writeJSON(p, v) {
  fs.writeFileSync(p, JSON.stringify(v))
}

function getKey() {
  const k = process.env.APP_ENC_KEY
  if (!k) return null
  const b = Buffer.from(k, 'hex')
  if (b.length !== 32) return null
  return b
}

function encrypt(text) {
  const key = getKey()
  if (!key) throw new Error('APP_ENC_KEY missing or invalid')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

function decrypt(b64) {
  const key = getKey()
  if (!key) throw new Error('APP_ENC_KEY missing or invalid')
  const buf = Buffer.from(b64, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(enc), decipher.final()])
  return dec.toString('utf8')
}

app.get('/api/health', async () => ({ ok: true }))

app.get('/api/models', async () => {
  const list = readJSON(modelsFile)
  return list.map(m => ({ ...m, apiKeyEnc: undefined }))
})

app.post('/api/models', async (req, rep) => {
  const body = req.body || {}
  const list = readJSON(modelsFile)
  const id = body.id || nanoid()
  let apiKeyEnc = null
  if (body.apiKey) {
    try {
      apiKeyEnc = encrypt(body.apiKey)
    } catch (e) {
      return rep.status(400).send({ error: 'APP_ENC_KEY required' })
    }
  }
  const item = {
    id,
    name: body.name || '未命名模型',
    protocol: body.protocol || 'openai',
    baseUrl: body.baseUrl || '',
    path: body.path || '/v1/chat/completions',
    model: body.model || '',
    params: body.params || {},
    stream: body.stream !== false,
    headers: body.headers || {},
    apiKeyEnc
  }
  const i = list.findIndex(x => x.id === id)
  if (i >= 0) list[i] = item
  else list.push(item)
  writeJSON(modelsFile, list)
  return { id }
})

app.delete('/api/models/:id', async (req, rep) => {
  const id = req.params.id
  const list = readJSON(modelsFile)
  const next = list.filter(x => x.id !== id)
  writeJSON(modelsFile, next)
  return { ok: true }
})

app.post('/api/chat', async (req, rep) => {
  const start = Date.now()
  const body = req.body || {}
  let cfg = null
  if (body.modelId) {
    const list = readJSON(modelsFile)
    cfg = list.find(x => x.id === body.modelId)
  }
  const baseUrl = body.baseUrl || (cfg && cfg.baseUrl) || ''
  const pathSuffix = body.path || (cfg && cfg.path) || '/v1/chat/completions'
  const model = body.model || (cfg && cfg.model) || ''
  let apiKey = body.apiKey || ''
  if (!apiKey && cfg && cfg.apiKeyEnc) {
    try {
      apiKey = decrypt(cfg.apiKeyEnc)
    } catch {
      apiKey = ''
    }
  }
  const stream = body.stream !== false && ((cfg && cfg.stream) || body.stream)
  const params = { ...(cfg && cfg.params ? cfg.params : {}), ...(body.params || {}) }
  const msgs = body.messages || []
  if (!baseUrl || !model || !apiKey || !Array.isArray(msgs)) {
    return rep.status(400).send({ error: 'bad_request' })
  }
  const cleanBase = baseUrl.replace(/\/$/, '')
  const cleanPath = ('/' + pathSuffix.replace(/^\/*/, '')).replace(/\/+/, '/')
  const url = cleanBase + cleanPath
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, ...(cfg && cfg.headers ? cfg.headers : {}), ...(body.headers || {}) }
  const payload = { model, messages: msgs, ...params, stream: !!stream }
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
    if (stream) {
      if (!r.ok) {
        const text = await r.text()
        const latencyMs = Date.now() - start
        const logs = readJSON(logsFile)
        logs.push({ id: nanoid(), model, status: 'error', code: r.status, latencyMs, createdAt: new Date().toISOString() })
        writeJSON(logsFile, logs.slice(-10000))
        return rep.status(r.status).send({ error: 'upstream_error', status: r.status, body: text })
      }
      rep.header('Content-Type', 'text/event-stream')
      rep.header('Cache-Control', 'no-cache')
      rep.header('Connection', 'keep-alive')
      rep.raw.writeHead(200)
      const nodeStream = Readable.fromWeb(r.body)
      for await (const chunk of nodeStream) {
        rep.raw.write(chunk)
      }
      rep.raw.end()
    } else {
      if (!r.ok) {
        const text = await r.text()
        let data = null
        try { data = JSON.parse(text) } catch { data = { body: text } }
        const latencyMs = Date.now() - start
        const logs = readJSON(logsFile)
        logs.push({ id: nanoid(), model, status: 'error', code: r.status, latencyMs, createdAt: new Date().toISOString() })
        writeJSON(logsFile, logs.slice(-10000))
        return rep.status(r.status).send(data)
      }
      const json = await r.json()
      rep.send(json)
    }
    const latencyMs = Date.now() - start
    const logs = readJSON(logsFile)
    logs.push({ id: nanoid(), model, status: 'ok', latencyMs, createdAt: new Date().toISOString() })
    writeJSON(logsFile, logs.slice(-10000))
  } catch (e) {
    const latencyMs = Date.now() - start
    const logs = readJSON(logsFile)
    logs.push({ id: nanoid(), model, status: 'error', code: 502, latencyMs, createdAt: new Date().toISOString() })
    writeJSON(logsFile, logs.slice(-10000))
    return rep.status(502).send({ error: 'upstream_error', message: String(e && e.message || '') })
  }
})

app.get('/api/metrics', async () => {
  const logs = readJSON(logsFile)
  const total = logs.length
  const failures = logs.filter(x => x.status !== 'ok').length
  const avg = logs.length ? Math.round(logs.reduce((a, b) => a + (b.latencyMs || 0), 0) / logs.length) : 0
  return { total, failures, avgMs: avg }
})

const port = process.env.PORT || 3000
app.listen({ port: Number(port), host: '0.0.0.0' })