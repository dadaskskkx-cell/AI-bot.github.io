const state = {
  models: [],
  messages: [],
  streaming: false,
  controller: null,
  convTitle: '默认会话',
  direct: false
}

const el = id => document.getElementById(id)

function normalizeBaseUrl(raw) {
  const s = (raw || '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    return (u.origin || s).replace(/\/$/, '')
  } catch {
    return s.replace(/\/$/, '').replace(/\/api[\s\S]*$/,'')
  }
}

function switchTab(k) {
  ;['chat','models'].forEach(x => {
    el('tab-'+x).classList.toggle('active', x===k)
    el('page-'+x).classList.toggle('hidden', x!==k)
  })
}

function readDirectModels() {
  try {
    const s = localStorage.getItem('direct.models') || '[]'
    const arr = JSON.parse(s)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function writeDirectModels(list) {
  try { localStorage.setItem('direct.models', JSON.stringify(list || [])) } catch {}
}

async function loadModels() {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 1500)
    const r = await fetch(((window.API_BASE)||'') + '/api/models', { signal: controller.signal })
    clearTimeout(timeoutId)
    const list = await r.json()
    state.models = list
    const sel = el('modelSelect')
    sel.innerHTML = ''
    list.forEach(m => {
      const o = document.createElement('option')
      o.value = m.id
      o.textContent = (m.name || '未命名') + ' · ' + (m.model || '')
      sel.appendChild(o)
    })
    const directs = readDirectModels()
    directs.forEach(dm => {
      const o = document.createElement('option')
      o.value = 'direct:' + dm.id
      o.textContent = '直连 · ' + (dm.name || '未命名') + ' · ' + (dm.model || '')
      sel.appendChild(o)
    })
    renderModelsTable()
    updateCurrentModelBadge()
  } catch {
    state.models = []
    const sel = el('modelSelect')
    if (sel) {
      sel.innerHTML = ''
      const directs = readDirectModels()
      directs.forEach(dm => {
        const o = document.createElement('option')
        o.value = 'direct:' + dm.id
        o.textContent = '直连 · ' + (dm.name || '未命名') + ' · ' + (dm.model || '')
        sel.appendChild(o)
      })
    }
    renderModelsTable()
    updateCurrentModelBadge()
  }
}

function renderModelsTable() {
  const tb = el('modelsTable')
  tb.innerHTML = ''
  state.models.forEach(m => {
    const tr = document.createElement('tr')
    const td0 = document.createElement('td')
    td0.textContent = m.name
    const td1 = document.createElement('td')
    td1.textContent = m.model
    const td2 = document.createElement('td')
    td2.textContent = m.baseUrl
    const td3 = document.createElement('td')
    const btn = document.createElement('button')
    btn.textContent = '删除'
    btn.dataset.backendId = m.id
    td3.appendChild(btn)
    tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3)
    tb.appendChild(tr)
  })
  readDirectModels().forEach(dm => {
    const tr = document.createElement('tr')
    const td0 = document.createElement('td')
    td0.textContent = (dm.name || '未命名')
    const td1 = document.createElement('td')
    td1.textContent = (dm.model || '')
    const td2 = document.createElement('td')
    td2.textContent = (dm.baseUrl || '')
    const td3 = document.createElement('td')
    const btn = document.createElement('button')
    btn.textContent = '删除'
    btn.dataset.directId = dm.id
    td3.appendChild(btn)
    tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3)
    tb.appendChild(tr)
  })
}

function addMessage(role, content) {
  state.messages.push({ role, content })
  const box = el('messages')
  const row = document.createElement('div')
  row.className = 'bubbleRow ' + (role==='user'?'user':'assistant')
  const av = document.createElement('div')
  av.className = 'avatar ' + (role==='user'?'user':'assistant')
  const current = state.models.find(x => x.id === (el('modelSelect').value || ''))
  av.textContent = role==='user' ? '我' : '龙'
  const d = document.createElement('div')
  d.className = 'msg ' + (role==='user'?'user':'assistant')
  d.textContent = content
  row.appendChild(av)
  row.appendChild(d)
  box.appendChild(row)
  box.scrollTop = box.scrollHeight
  return d
}

async function saveModel() {
  const payload = {
    name: el('m_name').value,
    baseUrl: el('m_baseUrl').value,
    path: '/api/v3/chat/completions',
    model: el('m_model').value,
    apiKey: el('m_apiKey').value,
    headers: {}
  }
  const r = await fetch(((window.API_BASE)||'') + '/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (r.ok) {
    let id = null
    try {
      const out = await r.json()
      id = out && out.id
    } catch {}
    if (id && payload.apiKey) {
      try { localStorage.setItem('apiKey:'+id, payload.apiKey) } catch {}
    }
    loadModels()
    switchTab('chat')
  }
}

async function send() {
  const text = el('input').value.trim()
  if (!text || state.streaming) return
  addMessage('user', text)
  el('input').value = ''
  const stream = el('stream').checked
  const selVal = el('modelSelect').value
  if (selVal && selVal.startsWith('direct:')) {
    const id = selVal.slice(7)
    const dm = readDirectModels().find(x => x.id === id)
    if (!dm) { addMessage('assistant', '错误：未找到直连模型配置'); return }
    const baseUrlRaw = (dm.baseUrl || '').trim()
    const model = (dm.model || '').trim()
    const apiKey = (dm.apiKey || '').trim()
    if (!baseUrlRaw || !model || !apiKey) { addMessage('assistant', '错误：直连配置不完整'); return }
    const origin = normalizeBaseUrl(baseUrlRaw)
    const url = origin + '/api/v3/chat/completions'
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }
    const payload = { model, messages: state.messages.map(m => ({ role: m.role, content: m.content })), stream: !!stream }
    if (stream) {
      state.streaming = true
      state.controller = new AbortController()
      let res
      try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: state.controller.signal }) } catch (e) { addMessage('assistant', '错误：无法连接接口'); state.streaming = false; state.controller = null; return }
      if (!res.ok) { const t = await res.text(); addMessage('assistant', '错误：' + t); state.streaming = false; state.controller = null; return }
      const reader = res.body.getReader()
      let acc = ''
      const msgDiv = addMessage('assistant', '')
      const lastMessage = state.messages[state.messages.length - 1]
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        acc += new TextDecoder().decode(value)
        const parts = acc.split('\n'); acc = parts.pop()
        parts.forEach(line => {
          if (line.startsWith('data:')) {
            const t = line.slice(5).trim()
            if (t && t !== '[DONE]') {
              try { const j = JSON.parse(t); const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content || ''; if (delta) { msgDiv.textContent += delta; lastMessage.content += delta } } catch {}
            }
          }
        })
      }
      state.streaming = false
      state.controller = null
    } else {
      let r
      try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) }) } catch (e) { addMessage('assistant', '错误：无法连接接口'); return }
      if (!r.ok) {
        let msg = ''
        try { const j = await r.json(); msg = j.error && (j.error.message || j.error) || j.message || '' } catch { msg = await r.text() }
        addMessage('assistant', '错误：' + (msg || ('HTTP '+r.status)))
        return
      }
      const j = await r.json(); const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || ''
      addMessage('assistant', txt)
    }
    return
  }
  if (state.direct) {
    const baseUrlRaw = (localStorage.getItem('direct.baseUrl') || el('m_baseUrl').value || '').trim()
    const model = (localStorage.getItem('direct.model') || el('m_model').value || '').trim()
    const apiKey = (localStorage.getItem('direct.apiKey') || el('m_apiKey').value || '').trim()
    if (!baseUrlRaw || !model || !apiKey) { addMessage('assistant', '错误：直连配置不完整'); return }
    const origin = normalizeBaseUrl(baseUrlRaw)
    const url = origin + '/api/v3/chat/completions'
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }
    const payload = { model, messages: state.messages.map(m => ({ role: m.role, content: m.content })), stream: !!stream }
    if (stream) {
      state.streaming = true
      state.controller = new AbortController()
      let res
      try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: state.controller.signal }) } catch (e) { addMessage('assistant', '错误：无法连接接口'); state.streaming = false; state.controller = null; return }
      if (!res.ok) {
        let msg = ''
        try { const j = await res.json(); msg = j.error && (j.error.message || j.error) || j.message || '' } catch { msg = await res.text() }
        addMessage('assistant', '错误：' + (msg || ('HTTP '+res.status)))
        state.streaming = false
        state.controller = null
        return
      }
      const reader = res.body.getReader()
      let acc = ''
      const msgDiv = addMessage('assistant', '')
      const lastMessage = state.messages[state.messages.length - 1]
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        acc += new TextDecoder().decode(value)
        const parts = acc.split('\n'); acc = parts.pop()
        parts.forEach(line => {
          if (line.startsWith('data:')) {
            const t = line.slice(5).trim()
            if (t && t !== '[DONE]') {
              try { const j = JSON.parse(t); const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content || ''; if (delta) { msgDiv.textContent += delta; lastMessage.content += delta } } catch {}
            }
          }
        })
      }
      state.streaming = false
      state.controller = null
    } else {
      let r
      try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) }) } catch (e) { addMessage('assistant', '错误：无法连接接口'); return }
      if (!r.ok) {
        let msg = ''
        try { const j = await r.json(); msg = j.error && (j.error.message || j.error) || j.message || '' } catch { msg = await r.text() }
        addMessage('assistant', '错误：' + (msg || ('HTTP '+r.status)))
        return
      }
      const j = await r.json(); const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || ''
      addMessage('assistant', txt)
    }
    return
  }
  const modelId = el('modelSelect').value
  let apiKey = ''
  try { apiKey = localStorage.getItem('apiKey:'+modelId) || '' } catch {}
  if (!modelId) { addMessage('assistant', '错误：未选择模型或模型列表为空'); return }
  const payload = { modelId, messages: state.messages.map(m => ({ role: m.role, content: m.content })), stream, apiKey }
  if (stream) {
    state.streaming = true
    state.controller = new AbortController()
    let res
    try {
      res = await fetch(((window.API_BASE)||'') + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: state.controller.signal })
    } catch (e) {
      addMessage('assistant', '错误：无法连接后端，请检查 API_BASE 与网络')
      state.streaming = false
      state.controller = null
      return
    }
    if (!res.ok) {
      const text = await res.text()
      let msg = ''
      try { const j = JSON.parse(text); msg = j.error || j.message || j.body || text } catch { msg = text }
      addMessage('assistant', '错误：' + msg)
      state.streaming = false
      state.controller = null
      return
    }
    const reader = res.body.getReader()
    let acc = ''
        const msgDiv = addMessage('assistant', '');
    const lastMessage = state.messages[state.messages.length - 1];
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += new TextDecoder().decode(value)
      const parts = acc.split('\n')
      acc = parts.pop()
      parts.forEach(line => {
        if (line.startsWith('data:')) {
          const t = line.slice(5).trim()
          if (t && t !== '[DONE]') {
            try {
              const j = JSON.parse(t)
              const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content || ''
              if (delta) { msgDiv.textContent += delta; lastMessage.content += delta; }
            } catch {}
          }
        }
      })
    }
    state.streaming = false
    state.controller = null
  } else {
    let r
    try {
      r = await fetch(((window.API_BASE)||'') + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    } catch (e) {
      addMessage('assistant', '错误：无法连接后端，请检查 API_BASE 与网络')
      return
    }
    if (!r.ok) {
      const t = await r.text()
      let msg = ''
      try { const j = JSON.parse(t); msg = j.error || j.message || j.body || t } catch { msg = t }
      addMessage('assistant', '错误：' + msg)
      return
    }
    const j = await r.json()
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || ''
    addMessage('assistant', text)
  }
}

function stop() {
  if (state.controller) state.controller.abort()
}

function clearChat() {
  state.messages = []
  el('messages').innerHTML = ''
}

function newConv() {
  state.convTitle = '默认会话'
  clearChat()
}

function updateCurrentModelBadge() {
  const badge = el('currentModel')
  const selVal = el('modelSelect').value
  if (selVal && selVal.startsWith('direct:')) {
    const id = selVal.slice(7)
    const dm = readDirectModels().find(x => x.id === id)
    if (badge) badge.textContent = dm ? ('直连 · ' + (dm.name || '未命名') + ' · ' + (dm.model || '')) : '直连模式'
    return
  }
  if (state.direct) {
    const model = localStorage.getItem('direct.model') || el('m_model').value || ''
    if (badge) badge.textContent = model ? ('直连模式 · ' + model) : '直连模式'
    return
  }
  const id = selVal
  const m = state.models.find(x => x.id === id)
  if (badge) badge.textContent = m ? ((m.name || '未命名') + ' · ' + (m.model || '')) : ''
}

document.addEventListener('DOMContentLoaded', () => {
  el('tab-chat').onclick = () => switchTab('chat')
  el('tab-models').onclick = () => switchTab('models')
  el('refreshModels').onclick = loadModels
  el('saveModel').onclick = saveModel
  el('send').onclick = send
  el('stop').onclick = stop
  el('clear').onclick = clearChat
  const nc = document.getElementById('newConv'); if (nc) nc.onclick = newConv
  const ms = el('modelSelect'); if (ms) ms.onchange = updateCurrentModelBadge
  const mt = el('modelsTable'); if (mt) mt.addEventListener('click', async (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button')
    if (!btn) return
    const did = btn.dataset && btn.dataset.directId
    const bid = btn.dataset && btn.dataset.backendId
    if (did) {
      const list = readDirectModels().filter(x => x.id !== did)
      writeDirectModels(list)
      loadModels()
      return
    }
    if (bid) {
      try {
        await fetch(((window.API_BASE)||'') + '/api/models/'+bid, { method: 'DELETE' })
        try { localStorage.removeItem('apiKey:'+bid) } catch {}
      } catch {}
      loadModels()
    }
  })
  const dm = el('directMode'); if (dm) {
    try { state.direct = localStorage.getItem('direct.enabled') === '1' } catch {}
    dm.checked = !!state.direct
    dm.onchange = () => { state.direct = dm.checked; try { localStorage.setItem('direct.enabled', state.direct ? '1' : '0') } catch {}; updateCurrentModelBadge() }
  }
  const sd = el('saveDirect'); if (sd) sd.onclick = () => {
    const name = (el('m_name').value || '').trim()
    const baseUrl = normalizeBaseUrl(el('m_baseUrl').value || '')
    const model = (el('m_model').value || '').trim()
    const apiKey = (el('m_apiKey').value || '').trim()
    if (!baseUrl || !model || !apiKey) { return }
    const list = readDirectModels()
    const id = 'dm_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8)
    list.push({ id, name, baseUrl, model, apiKey })
    writeDirectModels(list)
    loadModels()
    const sel = el('modelSelect'); if (sel) sel.value = 'direct:' + id
    updateCurrentModelBadge()
  }
  const cd = el('clearDirect'); if (cd) cd.onclick = () => {
    writeDirectModels([])
    loadModels()
  }
  const sh = el('shareLink'); if (sh) sh.onclick = () => {
    const params = new URLSearchParams()
    const name = (el('m_name').value || '').trim()
    const baseUrl = normalizeBaseUrl(el('m_baseUrl').value || '')
    const model = (el('m_model').value || '').trim()
    if (name) params.set('name', name)
    if (baseUrl) params.set('baseUrl', baseUrl)
    if (model) params.set('model', model)
    params.set('prefill', '1')
    const link = location.origin + location.pathname + '?' + params.toString()
    try { navigator.clipboard.writeText(link) } catch {}
  }
  ;(function prefillFromQuery(){
    try {
      const qs = new URLSearchParams(location.search)
      if (qs.get('prefill') === '1') {
        const name = qs.get('name') || ''
        const baseUrl = qs.get('baseUrl') || ''
        const model = qs.get('model') || ''
        if (name) el('m_name').value = name
        if (baseUrl) el('m_baseUrl').value = baseUrl
        if (model) el('m_model').value = model
      }
    } catch {}
  })()
  el('input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })
  loadModels()
  updateCurrentModelBadge()
  switchTab('chat')
})