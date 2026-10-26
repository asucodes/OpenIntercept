/**
 * OpenIntercept panel — no-build single-page app.
 *
 * Rendering is keyed and batched: rows update in place, nav counters refresh
 * without rebuilding the shell, and SSE bursts collapse into one frame. The
 * panel only presents what the sidecar reports; decisions are the real
 * decisions the adapter is blocked on.
 */

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === "class") node.className = value
    else if (key === "dataset") Object.assign(node.dataset, value)
    else if (key === "style") node.setAttribute("style", value)
    else if (key === "html") node.innerHTML = value
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value === true) node.setAttribute(key, "")
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const ICONS = {
  terminal: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 8 3 3-3 3"/><path d="M13 15h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.4 3.8 5.5 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.5-3.8-9S9.5 5.4 12 3Z"/>',
  shield: '<path d="M12 3 20 6v5.5c0 5-3.4 8.4-8 9.5-4.6-1.1-8-4.5-8-9.5V6l8-3Z"/><path d="m9 12 2 2 4-4"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v4a6 6 0 0 1-12 0Z"/><path d="M12 18v3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>',
  rows: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7"/><path d="M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  alert: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 10v4"/><path d="M12 17.5v.1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V4h12"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5"/><path d="M4 4h16"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  play: '<path d="m7 4 12 8-12 8V4Z"/>',
  forward: '<path d="m5 4 12 8-12 8V4Z"/><path d="M19 4v16"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m13 6 4 4"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  spark: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z"/>',
  hash: '<path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18"/>',
  activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  zap: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  file: '<path d="M6 2h8l4 4v16H6V2Z"/><path d="M14 2v5h5"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  wifi: '<path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><path d="M12 19h.01"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>',
}

function icon(name, size = 16) {
  const span = document.createElement("span")
  span.className = "icon"
  span.setAttribute("aria-hidden", "true")
  span.style.display = "inline-flex"
  span.style.alignItems = "center"
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.hash}</svg>`
  return span
}

const pad = (n) => String(n).padStart(2, "0")

function fmtTime(ts) {
  if (!ts) return "—"
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fmtDateTime(ts) {
  if (!ts) return "—"
  return new Date(ts).toLocaleString()
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${pad(s)}s`
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function ago(ts) {
  if (!ts) return "—"
  const diff = Date.now() - ts
  if (diff < 1500) return "now"
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function truncate(value, max = 80) {
  const text = String(value ?? "")
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function debounce(fn, ms = 120) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

const storage = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key)
      return value === null ? fallback : value
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* private mode */
    }
  },
}

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  })
  const type = response.headers.get("content-type") ?? ""
  const payload = type.includes("application/json") ? await response.json().catch(() => ({})) : await response.text()
  if (!response.ok) {
    const message = (payload && payload.error) || `${response.status} ${response.statusText}`
    throw new ApiError(message, response.status)
  }
  return payload
}

/* -------------------------------------------------------------------------- */
/* Views + state                                                               */
/* -------------------------------------------------------------------------- */

const VIEWS = [
  { id: "calls", label: "Calls", icon: "terminal", title: "Tool calls" },
  { id: "http", label: "HTTP", icon: "globe", title: "HTTP traffic" },
  { id: "intercept", label: "Intercept", icon: "shield", title: "Intercept queue" },
  { id: "rules", label: "Rules", icon: "sliders", title: "Rules" },
  { id: "plugin", label: "Plugin", icon: "plug", title: "Plugin & capture" },
]

const state = {
  view: "calls",
  connection: "connecting",
  meta: null,
  runtime: null,
  plugin: null,
  entries: [],
  traffic: [],
  holds: [],
  agents: [],
  selected: null,
  detailTab: "overview",
  search: "",
  statusFilter: "all",
  sort: "newest",
  rulesDraft: null,
  rulesDirty: false,
  ruleSearch: "",
  busy: false,
  loaded: false,
  theme: storage.get("openintercept.theme", "dark"),
  density: storage.get("openintercept.density", "comfortable"),
  railCollapsed: storage.get("openintercept.rail", "open") === "collapsed",
}

const drafts = new Map()

const STATUS_META = {
  "held-before": { label: "Held · args", tone: "hold" },
  "held-after": { label: "Held · result", tone: "hold" },
  running: { label: "Running", tone: "muted" },
  blocked: { label: "Blocked", tone: "danger" },
  forwarded: { label: "Forwarded", tone: "ok" },
  edited: { label: "Edited", tone: "info" },
  fabricated: { label: "Spoofed", tone: "violet" },
  dropped: { label: "Dropped", tone: "danger" },
  error: { label: "Tool error", tone: "warn" },
}

const TOOL_ICONS = {
  webfetch: "globe",
  websearch: "search",
  bash: "terminal",
  shell: "terminal",
  execute: "code",
  read: "file",
  write: "edit",
  edit: "edit",
  grep: "search",
  glob: "search",
  list: "rows",
  task: "zap",
  mcp: "plug",
}

function toolIcon(tool) {
  const key = String(tool ?? "").toLowerCase()
  if (TOOL_ICONS[key]) return TOOL_ICONS[key]
  if (key.startsWith("mcp")) return "plug"
  return "terminal"
}

function currentView() {
  return VIEWS.find((view) => view.id === state.view) ?? VIEWS[0]
}

/* -------------------------------------------------------------------------- */
/* Theme / density / rail                                                      */
/* -------------------------------------------------------------------------- */

function applyChromePrefs() {
  document.documentElement.dataset.theme = state.theme
  document.documentElement.dataset.density = state.density
  $("#app")?.classList.toggle("rail-collapsed", state.railCollapsed)
  const themeBtn = $("#theme-toggle")
  if (themeBtn) {
    themeBtn.replaceChildren(icon(state.theme === "dark" ? "sun" : "moon", 16))
    themeBtn.title = state.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
  }
  const densityBtn = $("#density-toggle")
  if (densityBtn) {
    densityBtn.replaceChildren(icon(state.density === "comfortable" ? "rows" : "panel", 16))
    densityBtn.title = state.density === "comfortable" ? "Compact rows" : "Comfortable rows"
  }
  const railBtn = $("#rail-toggle")
  if (railBtn) {
    railBtn.replaceChildren(icon("panel", 15))
    railBtn.title = state.railCollapsed ? "Expand sidebar" : "Collapse sidebar"
  }
  // static chrome icons (declared empty in index.html)
  $("#refresh")?.replaceChildren(icon("refresh", 15))
  $("#help-btn")?.replaceChildren(icon("help", 15))
  $(".search-trigger-icon")?.replaceChildren(icon("search", 15))
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark"
  storage.set("openintercept.theme", state.theme)
  applyChromePrefs()
}

function toggleDensity() {
  state.density = state.density === "comfortable" ? "compact" : "comfortable"
  storage.set("openintercept.density", state.density)
  applyChromePrefs()
}

function toggleRail() {
  state.railCollapsed = !state.railCollapsed
  storage.set("openintercept.rail", state.railCollapsed ? "collapsed" : "open")
  applyChromePrefs()
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                      */
/* -------------------------------------------------------------------------- */

function toast(title, { detail = "", tone = "info", timeout = 4200 } = {}) {
  const root = $("#toasts")
  const node = el("div", { class: `toast ${tone}` })
  node.append(el("div", { class: "toast-title" }, title))
  if (detail) node.append(el("div", { class: "toast-detail" }, detail))
  const close = el("button", { class: "toast-close", type: "button", "aria-label": "Dismiss" }, icon("x", 12))
  close.addEventListener("click", () => node.remove())
  node.append(close)
  if (timeout > 0) {
    const bar = el("span", { class: "toast-progress" })
    bar.style.animationDuration = `${timeout}ms`
    node.append(bar)
    setTimeout(() => node.remove(), timeout)
  }
  root.append(node)
}

const toastError = (error, title = "Request failed") =>
  toast(title, { detail: error instanceof Error ? error.message : String(error), tone: "error", timeout: 6500 })

/* -------------------------------------------------------------------------- */
/* Modal                                                                       */
/* -------------------------------------------------------------------------- */

let modalCloser = null

function openModal({ title, subtitle, iconName = "shield", body, actions = [], onClose = null, wide = false }) {
  const root = $("#modal-root")
  root.replaceChildren()
  root.hidden = false

  const close = () => {
    root.hidden = true
    root.replaceChildren()
    modalCloser = null
    document.removeEventListener("keydown", onKey)
    onClose?.()
  }

  const onKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation()
      close()
    }
    if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll("button, input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter(
        (node) => !node.disabled,
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  modalCloser = close
  document.addEventListener("keydown", onKey)

  const dialog = el("div", { class: `modal${wide ? " wide" : ""}`.trim(), role: "dialog", "aria-modal": "true", "aria-label": title })
  dialog.append(
    el(
      "div",
      { class: "modal-head" },
      el("span", { class: "modal-icon" }, icon(iconName, 17)),
      el(
        "div",
        { class: "modal-titlebox" },
        el("h3", { class: "modal-title" }, title),
        subtitle ? el("p", { class: "modal-sub" }, subtitle) : null,
      ),
      el("button", { class: "icon-btn modal-close", type: "button", "aria-label": "Close", onclick: close }, icon("x", 15)),
    ),
    el("div", { class: "modal-body" }, body),
  )

  const foot = el("div", { class: "modal-foot" })
  for (const action of actions) {
    foot.append(
      el(
        "button",
        {
          class: `btn ${action.tone ?? ""}`.trim(),
          type: "button",
          onclick: async (event) => {
            const button = event.currentTarget
            if (button.disabled) return
            button.disabled = true
            try {
              const keepOpen = await action.onClick?.()
              if (keepOpen === false) return
              close()
            } finally {
              button.disabled = false
            }
          },
        },
        action.label,
      ),
    )
  }
  dialog.append(foot)
  root.append(dialog)

  const focusable = dialog.querySelector("input, textarea, select, button")
  focusable?.focus()
  return { close }
}

/* -------------------------------------------------------------------------- */
/* Command palette                                                             */
/* -------------------------------------------------------------------------- */

let paletteState = { items: [], index: 0 }

function openPalette() {
  const root = $("#palette-root")
  if (!root.hidden) return
  root.hidden = false
  root.replaceChildren()

  const input = el("input", { class: "palette-input", type: "text", placeholder: "Search calls, HTTP, rules, or actions…", "aria-label": "Command palette" })
  const list = el("div", { class: "palette-list" })
  const palette = el(
    "div",
    { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Command palette" },
    el("div", { class: "palette-input-row" }, el("span", { class: "icon" }, icon("search", 16)), input, el("kbd", {}, "esc")),
    list,
    el(
      "div",
      { class: "palette-foot" },
      el("span", {}, el("kbd", {}, "↑"), " ", el("kbd", {}, "↓"), " navigate"),
      el("span", {}, el("kbd", {}, "↵"), " open"),
    ),
  )
  root.append(palette)

  const close = () => {
    root.hidden = true
    root.replaceChildren()
    document.removeEventListener("keydown", onKey)
  }

  const render = () => {
    const items = paletteItems(input.value)
    paletteState = { items, index: Math.min(paletteState.index, Math.max(0, items.length - 1)) }
    list.replaceChildren()
    if (!items.length) {
      list.append(el("div", { class: "palette-empty" }, "No matches. Try a tool name, URL, or action."))
      return
    }
    let lastSection = null
    items.forEach((item, index) => {
      if (item.section !== lastSection) {
        list.append(el("div", { class: "palette-section" }, item.section))
        lastSection = item.section
      }
      const node = el(
        "button",
        {
          class: `palette-item ${index === paletteState.index ? "active" : ""}`.trim(),
          type: "button",
          onclick: () => {
            close()
            item.run()
          },
          onmouseenter: () => {
            paletteState.index = index
            $$(".palette-item", list).forEach((n, i) => n.classList.toggle("active", i === index))
          },
        },
        el("span", { class: "p-icon" }, icon(item.icon ?? "hash", 14)),
        el("span", { class: "p-main" }, el("span", { class: "p-title" }, item.title), item.sub ? el("span", { class: "p-sub" }, item.sub) : null),
        item.hint ? el("kbd", {}, item.hint) : null,
      )
      list.append(node)
    })
  }

  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      paletteState.index = Math.min(paletteState.items.length - 1, paletteState.index + 1)
      render()
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      paletteState.index = Math.max(0, paletteState.index - 1)
      render()
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const item = paletteState.items[paletteState.index]
      if (item) {
        close()
        item.run()
      }
    }
  }

  document.addEventListener("keydown", onKey)
  input.addEventListener("input", () => {
    paletteState.index = 0
    render()
  })
  root.addEventListener(
    "click",
    (event) => {
      if (event.target === root) close()
    },
    { once: true },
  )
  render()
  input.focus()
}

function paletteItems(query) {
  const q = query.trim().toLowerCase()
  const matches = (...parts) => !q || parts.filter(Boolean).join(" ").toLowerCase().includes(q)
  const items = []

  const commands = [
    { title: "Go to Calls", sub: "Tool calls", icon: "terminal", run: () => setView("calls"), hint: "G C" },
    { title: "Go to HTTP", sub: "Captured exchanges", icon: "globe", run: () => setView("http"), hint: "G H" },
    { title: "Go to Intercept", sub: "Held calls", icon: "shield", run: () => setView("intercept"), hint: "G I" },
    { title: "Go to Rules", sub: "Interception policy", icon: "sliders", run: () => setView("rules"), hint: "G R" },
    { title: "Go to Plugin", sub: "Adapter and capture", icon: "plug", run: () => setView("plugin"), hint: "G P" },
    { title: state.runtime?.enabled ? "Turn interception off" : "Turn interception on", sub: "Toggle the global switch", icon: "bolt", run: () => toggleIntercept(!state.runtime?.enabled) },
    { title: "Reload captures", sub: "Fetch history, traffic, holds", icon: "refresh", run: () => loadAll().then(() => toast("Reloaded", { tone: "success", timeout: 1500 })).catch((error) => toastError(error, "Reload failed")) },
    { title: state.theme === "dark" ? "Switch to light theme" : "Switch to dark theme", sub: "Appearance", icon: state.theme === "dark" ? "sun" : "moon", run: toggleTheme },
    { title: state.density === "comfortable" ? "Use compact rows" : "Use comfortable rows", sub: "Density", icon: "rows", run: toggleDensity },
    { title: "Keyboard shortcuts", sub: "Open the cheat sheet", icon: "keyboard", run: openShortcuts, hint: "?" },
  ]
  for (const command of commands) {
    if (matches(command.title, command.sub)) items.push({ section: "Actions", ...command })
  }

  const entries = state.entries.filter((entry) =>
    matches(entry.tool, entry.argsText, entry.sessionTitle, entry.session?.id, entry.context?.agent, entry.context?.model),
  )
  for (const entry of entries.slice(0, 8)) {
    items.push({
      section: "Calls",
      title: `${entry.tool} · ${truncate(entry.argsText, 60)}`,
      sub: `${entry.sessionTitle || entry.session?.id || "no session"} · ${ago(entry.startedAt)}`,
      icon: toolIcon(entry.tool),
      run: () => {
        setView("calls")
        select("call", entry.id)
      },
    })
  }

  const exchanges = state.traffic.filter((exchange) =>
    matches(exchange.request?.method, exchange.request?.url, exchange.context?.model, exchange.context?.provider),
  )
  for (const exchange of exchanges.slice(0, 8)) {
    items.push({
      section: "HTTP",
      title: `${exchange.request?.method ?? "?"} ${truncate(hostOf(exchange.request?.url), 70)}`,
      sub: `${exchange.response?.status ?? "pending"} · ${ago(exchange.startedAt)}`,
      icon: "globe",
      run: () => {
        setView("http")
        select("http", exchange.id)
      },
    })
  }

  const rules = (state.rulesDraft?.rules ?? state.runtime?.profile?.rules ?? []).filter((rule) =>
    matches(rule.name, (rule.tools ?? []).join(" "), rule.action),
  )
  for (const rule of rules.slice(0, 6)) {
    items.push({
      section: "Rules",
      title: rule.name || "Unnamed rule",
      sub: `${rule.action} · ${(rule.tools ?? []).length ? rule.tools.join(", ") : "any tool"}`,
      icon: "sliders",
      run: () => setView("rules"),
    })
  }

  return items
}

/* -------------------------------------------------------------------------- */
/* Data layer                                                                  */
/* -------------------------------------------------------------------------- */

function hostOf(url) {
  try {
    return new URL(String(url)).host
  } catch {
    return truncate(String(url ?? ""), 60)
  }
}

function entryDuration(entry) {
  const end = entry.after?.at
  return end ? end - entry.startedAt : null
}

async function loadRuntime() {
  const [runtime, plugin] = await Promise.all([
    api("GET", "/api/state"),
    api("GET", "/api/plugin/status").catch(() => null),
  ])
  state.runtime = runtime
  state.plugin = plugin
  if (!state.rulesDirty) state.rulesDraft = structuredClone(runtime.profile)
}

async function loadCollections() {
  const [history, traffic, holds, meta, agents] = await Promise.all([
    api("GET", "/api/history?limit=500"),
    api("GET", "/api/traffic?limit=300"),
    api("GET", "/api/holds"),
    api("GET", "/api/meta").catch(() => null),
    api("GET", "/api/agent").catch(() => ({ agents: [] })),
  ])
  state.entries = history.entries ?? []
  state.traffic = traffic.exchanges ?? []
  state.holds = holds.holds ?? []
  state.meta = meta
  state.agents = agents.agents ?? []
  state.loaded = true
}

async function loadAll() {
  await Promise.all([loadRuntime(), loadCollections()])
  renderAll()
}

let renderQueued = false
function scheduleRender(fn = renderAll) {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    fn()
  })
}

function upsertEntry(entry) {
  const index = state.entries.findIndex((item) => item.id === entry.id)
  if (index >= 0) state.entries[index] = entry
  else state.entries.unshift(entry)
  if (state.entries.length > 600) state.entries.length = 600
}

function upsertTraffic(exchange) {
  const index = state.traffic.findIndex((item) => item.id === exchange.id)
  if (index >= 0) state.traffic[index] = exchange
  else state.traffic.unshift(exchange)
  if (state.traffic.length > 400) state.traffic.length = 400
}

function connectEvents() {
  const source = new EventSource("/api/events")

  source.addEventListener("open", () => {
    state.connection = "live"
    scheduleRender(renderChrome)
  })

  source.addEventListener("error", () => {
    state.connection = "offline"
    scheduleRender(renderChrome)
  })

  source.addEventListener("init", (event) => {
    const data = JSON.parse(event.data)
    state.runtime = {
      enabled: data.enabled,
      profile: data.profile,
      captureModelTraffic: data.captureModelTraffic,
      networkProxyEnabled: data.networkProxyEnabled,
    }
    if (!state.rulesDirty) state.rulesDraft = structuredClone(data.profile)
    state.entries = data.entries ?? []
    state.traffic = data.traffic ?? []
    state.holds = data.holds ?? []
    state.agents = data.agents ?? []
    state.loaded = true
    state.connection = "live"
    scheduleRender()
  })

  source.addEventListener("state", (event) => {
    const data = JSON.parse(event.data)
    state.runtime = { ...(state.runtime ?? {}), ...data }
    if (!state.rulesDirty) state.rulesDraft = structuredClone(data.profile)
    scheduleRender()
  })

  source.addEventListener("entry", (event) => {
    const data = JSON.parse(event.data)
    if (data.entry) {
      upsertEntry(data.entry)
      scheduleRender()
    }
  })

  source.addEventListener("held", (event) => {
    const data = JSON.parse(event.data)
    if (!state.holds.some((hold) => hold.key === data.key)) {
      state.holds.push({
        key: data.key,
        callId: data.callId,
        stage: data.stage,
        tool: data.tool,
        createdAt: data.createdAt,
        ruleName: data.ruleName ?? null,
        payload: { call: state.entries.find((entry) => entry.id === data.callId) ?? null },
      })
    }
    scheduleRender()
    // the event is a summary; fetch the full payload (args / captured result)
    api("GET", "/api/holds")
      .then((payload) => {
        state.holds = payload.holds ?? state.holds
        scheduleRender()
      })
      .catch(() => {})
  })

  source.addEventListener("released", (event) => {
    const data = JSON.parse(event.data)
    state.holds = state.holds.filter((hold) => hold.key !== data.key)
    if (data.entry) upsertEntry(data.entry)
    scheduleRender()
  })

  source.addEventListener("cleared", () => {
    state.entries = []
    scheduleRender()
  })

  source.addEventListener("traffic", (event) => {
    const data = JSON.parse(event.data)
    if (data.exchange) {
      upsertTraffic(data.exchange)
      scheduleRender()
    }
  })

  source.addEventListener("agent", (event) => {
    const data = JSON.parse(event.data)
    state.agents = [data, ...state.agents.filter((agent) => agent.instanceID !== data.instanceID)].slice(0, 12)
    scheduleRender()
  })
}

/* -------------------------------------------------------------------------- */
/* Chrome: nav, topbar, statusbar                                              */
/* -------------------------------------------------------------------------- */

const navRefs = new Map()

function buildNav() {
  const nav = $("#nav")
  nav.replaceChildren()
  navRefs.clear()
  for (const view of VIEWS) {
    const count = el("span", { class: "nav-count" }, "0")
    const button = el(
      "button",
      { class: "nav-item", type: "button", title: view.label, onclick: () => setView(view.id) },
      el("span", { class: "nav-icon" }, icon(view.icon, 17)),
      el("span", { class: "nav-label" }, view.label),
      count,
    )
    navRefs.set(view.id, { button, count })
    nav.append(button)
  }
}

function updateNav() {
  const counts = {
    calls: state.entries.length,
    http: state.traffic.length,
    intercept: state.holds.length,
  }
  for (const [id, refs] of navRefs) {
    refs.button.classList.toggle("active", id === state.view)
    const value = counts[id]
    if (value === undefined) {
      refs.count.hidden = true
      continue
    }
    refs.count.hidden = value === 0
    refs.count.textContent = value > 999 ? "999+" : String(value)
    refs.count.classList.toggle("alert", id === "intercept" && value > 0)
  }
}

function renderChrome() {
  updateNav()
  const view = currentView()
  $("#view-crumb").textContent = view.title

  const on = !!state.runtime?.enabled
  const toggle = $("#intercept")
  toggle.classList.toggle("on", on)
  toggle.setAttribute("aria-pressed", String(on))
  $("#intercept-label").textContent = on ? "Intercept on" : "Intercept off"
  $("#intercept-dot").className = `dot ${on ? "live" : ""}`.trim()

  const pill = $("#held-pill")
  if (state.holds.length) {
    pill.hidden = false
    pill.textContent = `${state.holds.length} held`
  } else {
    pill.hidden = true
  }

  const health = $("#rail-health")
  const online = state.connection === "live"
  health.replaceChildren(
    el("span", { class: `dot ${online ? "live" : "down"}` }),
    el(
      "span",
      { class: "rail-health-text" },
      el("strong", {}, online ? "Sidecar connected" : "Sidecar offline"),
      state.meta ? `v${state.meta.version}` : "127.0.0.1:7474",
    ),
  )

  renderStatusbar()
}

function renderStatusbar() {
  const bar = $("#statusbar")
  const rules = state.runtime?.profile?.rules?.length ?? 0
  const items = [
    el("span", { class: `item ${state.connection === "live" ? "live" : "danger"}` }, el("span", { class: `dot ${state.connection === "live" ? "live" : "down"}` }), state.connection === "live" ? "live" : "offline"),
    el("span", { class: "sep" }),
    el("span", { class: "item" }, `${state.entries.length} calls`),
    el("span", { class: "item" }, `${state.traffic.length} exchanges`),
    el("span", { class: "sep" }),
    el("span", { class: `item ${state.runtime?.enabled ? "warn" : ""}` }, state.runtime?.enabled ? "intercepting" : "pass-through"),
    el("span", { class: "item" }, `${rules} rules`),
  ]
  if (state.meta?.proxy?.running) {
    items.push(el("span", { class: "sep" }), el("span", { class: "item live" }, `proxy ${state.meta.proxy.host}:${state.meta.proxy.port}`))
  }
  items.push(
    el("span", { class: "grow" }),
    el("span", { class: "item" }, state.plugin?.installed ? "plugin installed" : "plugin not installed"),
    el("span", { class: "sep" }),
    el("span", { class: "item" }, "⌘K"),
  )
  bar.replaceChildren(...items)
}

/* -------------------------------------------------------------------------- */
/* List                                                                        */
/* -------------------------------------------------------------------------- */

const toolbarRefs = { search: null, status: null, note: null }

function buildToolbar() {
  const toolbar = $("#list-toolbar")
  toolbar.replaceChildren()
  if (state.view === "rules" || state.view === "plugin") {
    toolbar.hidden = true
    return
  }
  toolbar.hidden = false

  if (state.view === "calls") {
    const search = el("input", { type: "search", placeholder: "Filter by tool, args, session, model…", "aria-label": "Filter calls", value: state.search })
    search.addEventListener("input", () => {
      state.search = search.value
      field.classList.toggle("has-value", !!search.value)
      scheduleRender(renderList)
    })
    const field = el(
      "div",
      { class: `search-field ${state.search ? "has-value" : ""}` },
      el("span", { class: "icon-left" }, icon("search", 14)),
      search,
      el("button", { class: "clear", type: "button", "aria-label": "Clear filter", onclick: () => { search.value = ""; state.search = ""; field.classList.remove("has-value"); renderList() } }, icon("x", 12)),
    )

    const status = el("select", { class: "filter-select", "aria-label": "Status filter" })
    for (const [value, label] of [["all", "All statuses"], ["held", "Held"], ["spoofed", "Spoofed"], ["error", "Tool errors"], ["edited", "Edited"]]) {
      const option = el("option", { value }, label)
      if (state.statusFilter === value) option.selected = true
      status.append(option)
    }
    status.addEventListener("change", () => { state.statusFilter = status.value; renderList() })

    const sort = el("select", { class: "filter-select", "aria-label": "Sort order" })
    for (const [value, label] of [["newest", "Newest first"], ["oldest", "Oldest first"]]) {
      const option = el("option", { value }, label)
      if (state.sort === value) option.selected = true
      sort.append(option)
    }
    sort.addEventListener("change", () => { state.sort = sort.value; renderList() })

    const note = el("span", { class: "toolbar-note" })
    toolbar.append(field, status, sort, note, el("span", { class: "grow" }), el("button", { class: "btn ghost sm", type: "button", onclick: clearHistory }, icon("trash", 13), "Clear"))
    toolbarRefs.note = note
  } else if (state.view === "http") {
    const search = el("input", { type: "search", placeholder: "Filter by host, path, model, provider…", "aria-label": "Filter traffic", value: state.search })
    search.addEventListener("input", () => { state.search = search.value; scheduleRender(renderList) })
    const field = el("div", { class: `search-field ${state.search ? "has-value" : ""}` }, el("span", { class: "icon-left" }, icon("search", 14)), search)
    const note = el("span", { class: "toolbar-note" })
    toolbar.append(field, el("span", { class: "grow" }), note, el("button", { class: "btn ghost sm", type: "button", onclick: clearTraffic }, icon("trash", 13), "Clear"))
    toolbarRefs.note = note
  } else {
    const note = el("span", { class: "toolbar-note" }, state.holds.length ? `${state.holds.length} call(s) paused` : "Nothing is paused")
    toolbar.append(note)
    toolbarRefs.note = note
  }
}

function entryMatches(entry) {
  const q = state.search.trim().toLowerCase()
  if (!q) return true
  return [entry.tool, entry.argsText, entry.sessionTitle, entry.session?.id, entry.context?.agent, entry.context?.model, entry.context?.provider]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(q)
}

function visibleEntries() {
  let entries = state.entries.filter(entryMatches)
  if (state.statusFilter === "held") entries = entries.filter((entry) => entry.status.startsWith("held"))
  else if (state.statusFilter === "spoofed") entries = entries.filter((entry) => entry.status === "fabricated")
  else if (state.statusFilter === "error") entries = entries.filter((entry) => entry.status === "error")
  else if (state.statusFilter === "edited") entries = entries.filter((entry) => entry.status === "edited")
  if (state.sort === "oldest") entries = [...entries].sort((a, b) => a.startedAt - b.startedAt)
  return entries
}

function visibleTraffic() {
  const q = state.search.trim().toLowerCase()
  if (!q) return state.traffic
  return state.traffic.filter((exchange) =>
    [exchange.request?.method, exchange.request?.url, exchange.context?.model, exchange.context?.provider, exchange.context?.agent]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q),
  )
}

const rowCache = new Map()

function statusPill(status) {
  const meta = STATUS_META[status] ?? { label: status, tone: "muted" }
  return el("span", { class: `status-pill ${meta.tone}` }, meta.label)
}

function callRow(entry) {
  const node = el("div", { class: "row calls", role: "button", tabindex: "0" })
  const iconBox = el("span", { class: "row-icon" }, icon(toolIcon(entry.tool), 16))
  const name = el("span", { class: "name" }, entry.tool)
  const preview = el("span", { class: "preview" })
  const title = el("div", { class: "row-title" }, name, preview)
  const sub = el("div", { class: "row-sub" })
  const main = el("div", { class: "row-main" }, title, sub)
  const status = el("div", { class: "row-side" })
  const duration = el("span", { class: "row-duration" })
  const time = el("span", { class: "row-time" })
  node.append(iconBox, main, status, duration, time)

  node.addEventListener("click", () => select("call", entry.id))
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      select("call", entry.id)
    }
  })

  const refs = { node, iconBox, name, preview, sub, status, duration, time, sig: "" }
  node.dataset.key = entry.id
  rowCache.set(entry.id, refs)
  return refs
}

function updateCallRow(refs, entry) {
  const sig = [entry.tool, entry.argsText, entry.status, entry.startedAt, entry.after?.at, entry.sessionTitle, entry.context?.agent, entry.context?.model, state.selected?.id === entry.id].join("|")
  if (refs.sig === sig) return
  refs.sig = sig
  refs.iconBox.replaceChildren(icon(toolIcon(entry.tool), 16))
  refs.name.textContent = entry.tool
  refs.preview.textContent = truncate(String(entry.argsText ?? "").replace(/\s+/g, " "), 96)
  refs.sub.replaceChildren()
  const bits = [entry.sessionTitle || entry.session?.id || "no session"]
  if (entry.context?.agent) bits.push(entry.context.agent)
  if (entry.context?.model) bits.push(entry.context.model)
  bits.forEach((bit, index) => {
    if (index) refs.sub.append(el("span", { class: "sep" }))
    refs.sub.append(el("span", { class: "truncate" }, bit))
  })
  refs.status.replaceChildren(statusPill(entry.status))
  const ms = entryDuration(entry)
  refs.duration.textContent = ms === null ? (entry.status.startsWith("held") ? "waiting" : "—") : fmtDuration(ms)
  refs.time.textContent = fmtTime(entry.startedAt)
  refs.node.classList.toggle("held", entry.status.startsWith("held"))
  refs.node.classList.toggle("selected", state.selected?.kind === "call" && state.selected?.id === entry.id)
}

function httpRow(exchange) {
  const node = el("div", { class: "row http", role: "button", tabindex: "0" })
  const method = el("span", { class: "method-chip" })
  const name = el("span", { class: "name" })
  const preview = el("span", { class: "preview" })
  const title = el("div", { class: "row-title" }, name, preview)
  const sub = el("div", { class: "row-sub" })
  const main = el("div", { class: "row-main" }, title, sub)
  const status = el("div", { class: "row-side" })
  const duration = el("span", { class: "row-duration" })
  const time = el("span", { class: "row-time" })
  node.append(method, main, status, duration, time)
  node.addEventListener("click", () => select("http", exchange.id))
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      select("http", exchange.id)
    }
  })
  const refs = { node, method, name, preview, sub, status, duration, time, sig: "" }
  node.dataset.key = `http:${exchange.id}`
  rowCache.set(`http:${exchange.id}`, refs)
  return refs
}

function updateHttpRow(refs, exchange) {
  const sig = [exchange.request?.url, exchange.response?.status, exchange.startedAt, state.selected?.id === exchange.id].join("|")
  if (refs.sig === sig) return
  refs.sig = sig
  const method = String(exchange.request?.method ?? "GET").toUpperCase()
  refs.method.textContent = method
  refs.method.className = `method-chip ${["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "other"}`
  refs.name.textContent = truncate(String(exchange.request?.url ?? "").split("?")[0], 80)
  refs.preview.textContent = hostOf(exchange.request?.url)
  refs.sub.replaceChildren()
  const bits = [exchange.channel === "model" ? "model traffic" : "proxy"]
  if (exchange.context?.model) bits.push(exchange.context.model)
  if (exchange.context?.provider) bits.push(exchange.context.provider)
  bits.forEach((bit, index) => {
    if (index) refs.sub.append(el("span", { class: "sep" }))
    refs.sub.append(el("span", { class: "truncate" }, bit))
  })
  const status = exchange.response?.status
  refs.status.replaceChildren(
    el("span", { class: `status-code ${!status ? "muted" : status < 300 ? "ok" : status < 400 ? "info" : status < 500 ? "warn" : "danger"}` }, status ? String(status) : "pending"),
  )
  refs.duration.textContent = exchange.response?.at ? fmtDuration(exchange.response.at - exchange.startedAt) : "—"
  refs.time.textContent = fmtTime(exchange.startedAt)
  refs.node.classList.toggle("selected", state.selected?.kind === "http" && state.selected?.id === exchange.id)
}

function emptyState(kind) {
  if (kind === "calls") {
    return el(
      "div",
      { class: "empty" },
      el("span", { class: "empty-icon" }, icon("terminal", 22)),
      el("h3", {}, state.entries.length ? "No calls match this filter" : "No tool calls captured yet"),
      el("div", { class: "empty-actions" },
        el("button", { class: "btn primary", type: "button", onclick: () => setView("plugin") }, icon("plug", 14), "Set up the plugin"),
        el("button", { class: "btn", type: "button", onclick: () => setView("rules") }, icon("sliders", 14), "Rules"),
      ),
    )
  }
  if (kind === "http") {
    return el(
      "div",
      { class: "empty" },
      el("span", { class: "empty-icon" }, icon("globe", 22)),
      el("h3", {}, state.traffic.length ? "No exchanges match this filter" : "No HTTP traffic captured"),
      el("div", { class: "empty-actions" },
        el("button", { class: "btn", type: "button", onclick: () => setView("plugin") }, icon("sliders", 14), "Capture settings"),
      ),
    )
  }
  return el(
    "div",
    { class: "empty" },
    el("span", { class: "empty-icon" }, icon("shield", 22)),
    el("h3", {}, "Nothing is paused"),
    el("div", { class: "empty-actions" },
      el("button", { class: "btn", type: "button", onclick: () => setView("rules") }, icon("sliders", 14), "Rules"),
    ),
  )
}

const listShell = { mode: null, wrap: null, body: null }

function renderList() {
  const list = $("#list")
  if (!state.loaded) return renderSkeletons()

  if (state.view === "intercept") return renderHolds()
  if (state.view === "rules") return renderRules()
  if (state.view === "plugin") return renderPlugin()

  const isCalls = state.view === "calls"
  const items = isCalls ? visibleEntries() : visibleTraffic()
  if (toolbarRefs.note) {
    toolbarRefs.note.textContent = isCalls
      ? `${items.length} of ${state.entries.length}`
      : `${items.length} of ${state.traffic.length}`
  }

  if (!items.length) {
    listShell.mode = null
    listShell.body = null
    list.replaceChildren(emptyState(isCalls ? "calls" : "http"))
    return
  }

  const mode = isCalls ? "calls" : "http"
  if (listShell.mode !== mode || !listShell.body) {
    const wrap = el("div", { class: "rows" })
    wrap.append(
      el(
        "div",
        { class: `rows-head ${mode}` },
        el("span", {}, isCalls ? "" : "Method"),
        el("span", {}, isCalls ? "Call" : "Request"),
        el("span", {}, isCalls ? "Status" : "Code"),
        el("span", { class: "col-duration" }, "Time"),
        el("span", { class: "col-time" }, "At"),
      ),
    )
    const body = el("div", { class: "rows-body" })
    wrap.append(body)
    list.replaceChildren(wrap)
    listShell.mode = mode
    listShell.wrap = wrap
    listShell.body = body
  }

  const body = listShell.body
  const seen = new Set()
  items.forEach((item, index) => {
    const key = isCalls ? item.id : `http:${item.id}`
    seen.add(key)
    const cached = rowCache.get(key)
    const refs = cached ?? (isCalls ? callRow(item) : httpRow(item))
    if (isCalls) updateCallRow(refs, item)
    else updateHttpRow(refs, item)
    const current = body.children[index]
    if (current !== refs.node) body.insertBefore(refs.node, current ?? null)
  })
  for (const child of [...body.children]) {
    const key = child.dataset.key
    if (key && !seen.has(key)) child.remove()
  }
}

function renderSkeletons(count = 7) {
  const list = $("#list")
  listShell.mode = null
  listShell.body = null
  list.replaceChildren()
  const wrap = el("div", { class: "rows" })
  for (let i = 0; i < count; i++) {
    wrap.append(
      el(
        "div",
        { class: "skeleton-row" },
        el("span", { class: "sk icon" }),
        el("div", { class: "row-main" }, el("span", { class: "sk line" }), el("span", { class: "sk line short" })),
        el("span", { class: "sk pill" }),
        el("span", { class: "sk line" }),
      ),
    )
  }
  list.append(wrap)
}

/* -------------------------------------------------------------------------- */
/* Selection + detail                                                          */
/* -------------------------------------------------------------------------- */

function select(kind, id) {
  state.selected = { kind, id }
  state.detailTab = "overview"
  $("#detail").hidden = false
  $("#main").classList.add("with-detail")
  renderList()
  renderDetail()
}

function closeDetail() {
  state.selected = null
  const panel = $("#detail")
  panel.hidden = true
  panel.dataset.sig = ""
  $("#main").classList.remove("with-detail")
  renderList()
}

function selectedRecord() {
  if (!state.selected) return null
  if (state.selected.kind === "call") return state.entries.find((entry) => entry.id === state.selected.id) ?? null
  return state.traffic.find((exchange) => exchange.id === state.selected.id) ?? null
}

function copyButton(text, label = "Copy") {
  const button = el("button", { class: "copy-btn", type: "button" }, icon("copy", 11), label)
  button.addEventListener("click", async () => {
    if (await copyText(text)) {
      button.classList.add("copied")
      button.replaceChildren(icon("check", 11), "Copied")
      setTimeout(() => {
        button.classList.remove("copied")
        button.replaceChildren(icon("copy", 11), label)
      }, 1400)
    } else toast("Clipboard unavailable", { tone: "warn", timeout: 2200 })
  })
  return button
}

function section(title, ...children) {
  return el("div", { class: "section" }, el("div", { class: "section-title" }, title), ...children)
}

function codeBlock(text, tall = false) {
  return el("pre", { class: `code ${tall ? "tall" : ""}`.trim() }, String(text ?? ""))
}

function renderDetail() {
  const panel = $("#detail")
  if (!state.selected) {
    panel.hidden = true
    return
  }
  const record = selectedRecord()
  if (!record) {
    closeDetail()
    return
  }
  const sig = [
    state.selected.kind,
    state.selected.id,
    state.detailTab,
    record.status ?? "",
    record.after?.at ?? "",
    record.pendingStage ?? "",
    record.response?.status ?? "",
    record.before?.decision?.action ?? "",
    record.after?.decision?.action ?? "",
  ].join("|")
  if (panel.dataset.sig === sig) {
    panel.hidden = false
    return
  }
  panel.dataset.sig = sig
  panel.hidden = false
  $("#main").classList.add("with-detail")
  const isCall = state.selected.kind === "call"
  const tabs = isCall ? ["overview", "args", "result", "raw"] : ["overview", "request", "response", "raw"]

  const head = el(
    "div",
    { class: "detail-head" },
    el(
      "div",
      { class: "detail-titlebox" },
      el("div", { class: "detail-eyebrow" }, isCall ? `${record.adapter ?? "adapter"} · call` : `${record.channel ?? "network"} · exchange`),
      el(
        "div",
        { class: "detail-title" },
        el("span", { class: "name" }, isCall ? record.tool : `${record.request?.method ?? "?"} ${hostOf(record.request?.url)}`),
        isCall ? statusPill(record.status) : null,
      ),
      el("div", { class: "detail-sub" }, isCall ? truncate(String(record.argsText ?? ""), 140) : String(record.request?.url ?? "")),
    ),
    el("button", { class: "icon-btn detail-close", type: "button", "aria-label": "Close inspector", onclick: closeDetail }, icon("x", 15)),
  )

  const tabBar = el("div", { class: "detail-tabs", role: "tablist" })
  for (const tab of tabs) {
    tabBar.append(
      el(
        "button",
        {
          class: `detail-tab ${state.detailTab === tab ? "active" : ""}`.trim(),
          type: "button",
          role: "tab",
          onclick: () => {
            state.detailTab = tab
            renderDetail()
          },
        },
        tab[0].toUpperCase() + tab.slice(1),
      ),
    )
  }

  const body = el("div", { class: "detail-body" })
  if (state.detailTab === "overview") body.append(isCall ? callOverview(record) : httpOverview(record))
  else if (state.detailTab === "args") body.append(argsView(record))
  else if (state.detailTab === "result") body.append(resultView(record))
  else if (state.detailTab === "request") body.append(requestView(record))
  else if (state.detailTab === "response") body.append(responseView(record))
  else body.append(rawView(record, isCall))

  panel.replaceChildren(head, tabBar, body)
}

function callOverview(entry) {
  const frag = document.createDocumentFragment()
  const meta = el(
    "dl",
    { class: "kv" },
    el("dt", {}, "Tool"), el("dd", {}, entry.tool),
    el("dt", {}, "Adapter"), el("dd", {}, entry.adapter ?? "—"),
    el("dt", {}, "Session"), el("dd", {}, entry.sessionTitle || entry.session?.id || "—"),
    el("dt", {}, "Agent"), el("dd", {}, entry.context?.agent ?? "—"),
    el("dt", {}, "Model"), el("dd", {}, entry.context?.model ? `${entry.context.model}${entry.context.provider ? ` · ${entry.context.provider}` : ""}` : "—"),
    el("dt", {}, "Started"), el("dd", {}, fmtDateTime(entry.startedAt)),
    el("dt", {}, "Duration"), el("dd", {}, entryDuration(entry) === null ? "—" : fmtDuration(entryDuration(entry))),
    el("dt", {}, "Call id"), el("dd", { class: "mono" }, entry.id),
  )
  frag.append(section("Call", meta))

  if (entry.status === "fabricated") {
    frag.append(
      section(
        "Spoof",
        el("div", { class: "notice hold" }, el("span", { class: "notice-icon" }, icon("eye", 14)),
          el("div", {}, "The model received the spoofed text below. The real output stays in this inspector only.")),
      ),
    )
  }

  const decisions = el("div")
  const stage = (label, info) => {
    if (!info) return
    decisions.append(
      el(
        "div",
        { class: "decision" },
        el("span", { class: "stage" }, label),
        el("span", { class: `status-pill ${info.decision?.action === "drop" ? "danger" : info.decision?.action === "respond" ? "violet" : info.decision?.action === "replace" ? "info" : "ok"}` }, info.decision?.action ?? "pending"),
        el("span", { class: "reason" }, info.ruleName ? `rule: ${info.ruleName}` : info.decision?.by ? `by ${info.decision.by}` : "waiting"),
      ),
    )
  }
  stage("Before", entry.before)
  stage("After", entry.after)
  frag.append(section("Decisions", decisions))

  if (entry.status.startsWith("held")) {
    const hold = state.holds.find((item) => item.callId === entry.id)
    if (hold) {
      frag.append(
        section("Waiting",
          el("div", { class: "notice hold" }, el("span", { class: "notice-icon" }, icon("clock", 14)),
            el("div", {}, `Held at the ${hold.stage} stage. Open Intercept to release it.`)),
          el("div", { class: "mt-8" }, el("button", { class: "btn primary sm", type: "button", onclick: () => setView("intercept") }, "Review hold")),
        ),
      )
    }
  }
  return frag
}

function httpOverview(exchange) {
  const frag = document.createDocumentFragment()
  frag.append(
    section(
      "Exchange",
      el(
        "dl",
        { class: "kv" },
        el("dt", {}, "Method"), el("dd", { class: "mono" }, exchange.request?.method ?? "—"),
        el("dt", {}, "URL"), el("dd", { class: "mono" }, exchange.request?.url ?? "—"),
        el("dt", {}, "Channel"), el("dd", {}, exchange.channel ?? "—"),
        el("dt", {}, "Status"), el("dd", {}, exchange.response ? `${exchange.response.status} ${exchange.response.statusText ?? ""}` : "pending"),
        el("dt", {}, "Duration"), el("dd", {}, exchange.response?.at ? fmtDuration(exchange.response.at - exchange.startedAt) : "—"),
        el("dt", {}, "Model"), el("dd", {}, exchange.context?.model ?? "—"),
        el("dt", {}, "Provider"), el("dd", {}, exchange.context?.provider ?? "—"),
        el("dt", {}, "Started"), el("dd", {}, fmtDateTime(exchange.startedAt)),
      ),
    ),
  )
  if (exchange.channel === "network") {
    frag.append(section("Note", el("div", { class: "notice" }, el("span", { class: "notice-icon" }, icon("lock", 14)),
      el("div", {}, "Plaintext HTTP only. HTTPS CONNECT is tunnelled without interception."))))
  }
  return frag
}

function argsView(entry) {
  const frag = document.createDocumentFragment()
  const value = pretty(entry.args)
  const valid = parseJson(value)
  const draft = drafts.get(entry.id) ?? value
  frag.append(
    section("Arguments",
      el("div", { class: "copy-row" }, copyButton(value, "Copy JSON")),
      codeBlock(value, true),
    ),
  )
  if (entry.status.startsWith("held") && entry.pendingStage === "before") {
    const area = el("textarea", { class: "editor", spellcheck: "false" })
    area.value = draft
    const error = el("div", { class: "field-error" })
    area.addEventListener("input", () => {
      drafts.set(entry.id, area.value)
      const parsed = parseJson(area.value)
      area.classList.toggle("invalid", !parsed.ok)
      error.textContent = parsed.ok ? "" : parsed.error
    })
    frag.append(section("Edit before forwarding", area, error,
      el("div", { class: "mt-8" },
        el("button", { class: "btn primary sm", type: "button", onclick: () => {
          const hold = state.holds.find((item) => item.callId === entry.id && item.stage === "before")
          const parsed = parseJson(area.value)
          if (!hold) return toast("This call is no longer held", { tone: "warn" })
          if (!parsed.ok) {
            area.classList.add("invalid")
            error.textContent = parsed.error
            return
          }
          void decideHeld(hold, "replace", { args: parsed.value })
        } }, "Replace args & run"),
      ),
    ))
  }
  return frag
}

function resultView(entry) {
  const frag = document.createDocumentFragment()
  if (!entry.after) {
    frag.append(el("div", { class: "notice" }, el("span", { class: "notice-icon" }, icon("clock", 14)), el("div", {}, "The tool has not returned a result yet.")))
    return frag
  }
  const shown = entry.after.result
  frag.append(
    section(entry.status === "fabricated" ? "What the model saw" : "Result",
      el("div", { class: "copy-row" }, copyButton(shown.output, "Copy")),
      shown.title ? el("div", { class: "faint", style: "margin-bottom:6px" }, shown.title) : null,
      codeBlock(shown.output, true),
    ),
  )
  if (entry.status === "fabricated") {
    frag.append(
      section("What really happened",
        el("div", { class: "copy-row" }, copyButton(entry.after.originalResult?.output ?? "", "Copy")),
        codeBlock(entry.after.originalResult?.output ?? "", true),
      ),
    )
  }
  if (entry.after.decision?.action === "replace" && entry.status === "edited") {
    frag.append(section("Original result", codeBlock(entry.after.originalResult?.output ?? "", true)))
  }
  return frag
}

function requestView(exchange) {
  const frag = document.createDocumentFragment()
  const headers = Object.entries(exchange.request?.headers ?? {})
  frag.append(section("Request line", codeBlock(`${exchange.request?.method} ${exchange.request?.url}`)))
  frag.append(section("Headers", codeBlock(headers.map(([k, v]) => `${k}: ${v}`).join("\n") || "(none)")))
  if (exchange.request?.body) frag.append(section("Body", el("div", { class: "copy-row" }, copyButton(exchange.request.body, "Copy")), codeBlock(exchange.request.body, true)))
  return frag
}

function responseView(exchange) {
  const frag = document.createDocumentFragment()
  if (!exchange.response) {
    frag.append(el("div", { class: "notice" }, el("span", { class: "notice-icon" }, icon("clock", 14)), el("div", {}, "No response captured yet.")))
    return frag
  }
  const headers = Object.entries(exchange.response.headers ?? {})
  frag.append(section("Status", codeBlock(`${exchange.response.status} ${exchange.response.statusText ?? ""}`)))
  frag.append(section("Headers", codeBlock(headers.map(([k, v]) => `${k}: ${v}`).join("\n") || "(none)")))
  if (exchange.response.body) frag.append(section("Body", el("div", { class: "copy-row" }, copyButton(exchange.response.body, "Copy")), codeBlock(exchange.response.body, true)))
  return frag
}

function rawView(record, isCall) {
  return section(
    isCall ? "Record" : "Exchange",
    el("div", { class: "copy-row" }, copyButton(pretty(record), "Copy JSON")),
    codeBlock(pretty(record), true),
  )
}

/* -------------------------------------------------------------------------- */
/* Holds                                                                       */
/* -------------------------------------------------------------------------- */

const countdownTimers = new Set()

function clearCountdowns() {
  for (const timer of countdownTimers) clearInterval(timer)
  countdownTimers.clear()
}

function renderHolds() {
  clearCountdowns()
  const list = $("#list")
  if (!state.holds.length) {
    list.replaceChildren(emptyState("intercept"))
    return
  }

  const wrap = el("div", { class: "hold-list" })
  const timeoutMs = state.runtime?.profile?.defaults?.holdTimeoutMs ?? 120_000

  for (const hold of [...state.holds].sort((a, b) => a.createdAt - b.createdAt)) {
    const call = hold.payload?.call
    const result = hold.payload?.result
    const card = el("div", { class: "hold-card" })

    const timeLabel = el("span", { class: "time" })
    const progress = el("span")
    const bar = el("div", { class: "hold-progress" }, progress)

    card.append(
      el(
        "div",
        { class: "hold-head" },
        el("span", { class: "hold-icon" }, icon(hold.stage === "before" ? "send" : "download", 17)),
        el(
          "div",
          { class: "hold-title" },
          el("div", { class: "tool" }, hold.tool),
          el("div", { class: "meta" }, `${hold.stage === "before" ? "Arguments" : "Result"} held · ${call?.session?.title || call?.session?.id || "unknown session"}${hold.ruleName ? ` · rule ${hold.ruleName}` : ""}`),
        ),
        el("div", { class: "hold-countdown" }, icon("clock", 14), timeLabel),
      ),
      bar,
    )

    const body = el("div", { class: "hold-body" })
    if (hold.stage === "before") {
      body.append(section("Arguments", codeBlock(pretty(call?.args), false)))
    } else {
      body.append(
        section("Result",
          result?.title ? el("div", { class: "faint", style: "margin-bottom:6px" }, result.title) : null,
          codeBlock(result?.output ?? "", false),
        ),
      )
    }
    card.append(body)

    const actions = el("div", { class: "hold-actions" })
    if (hold.stage === "before") {
      actions.append(
        el("button", { class: "btn primary sm", type: "button", onclick: () => decideHeld(hold, "run") }, icon("play", 12), "Run"),
        el("button", { class: "btn sm", type: "button", onclick: () => openArgsEditor(hold) }, icon("edit", 12), "Edit args"),
        el("button", { class: "btn sm", type: "button", onclick: () => openSpoof(hold) }, icon("eye", 12), "Spoof result"),
        el("span", { class: "spacer" }),
        el("button", { class: "btn danger sm", type: "button", onclick: () => decideHeld(hold, "drop") }, icon("trash", 12), "Drop"),
      )
    } else {
      actions.append(
        el("button", { class: "btn primary sm", type: "button", onclick: () => decideHeld(hold, "forward") }, icon("forward", 12), "Forward"),
        el("button", { class: "btn sm", type: "button", onclick: () => openResultEditor(hold) }, icon("edit", 12), "Edit result"),
        el("button", { class: "btn sm", type: "button", onclick: () => openSpoof(hold) }, icon("eye", 12), "Replace result"),
        el("span", { class: "spacer" }),
        el("button", { class: "btn danger sm", type: "button", onclick: () => decideHeld(hold, "drop") }, icon("trash", 12), "Drop"),
      )
    }
    card.append(actions)
    wrap.append(card)

    const tick = () => {
      const left = Math.max(0, hold.createdAt + timeoutMs - Date.now())
      timeLabel.textContent = `${Math.ceil(left / 1000)}s`
      progress.style.width = `${Math.min(100, (left / timeoutMs) * 100)}%`
      if (left <= 0) clearInterval(timer)
    }
    const timer = setInterval(tick, 1000)
    countdownTimers.add(timer)
    tick()
  }

  list.replaceChildren(wrap)
}

async function decideHeld(hold, action, extra = {}) {
  const key = hold.key
  state.holds = state.holds.filter((item) => item.key !== key)
  scheduleRender()
  try {
    await api("POST", `/api/decision/${encodeURIComponent(key)}`, { action, by: "human", ...extra })
    toast(action === "drop" ? "Call dropped" : action === "run" ? "Released" : "Decision sent", { tone: "success", timeout: 1600 })
  } catch (error) {
    toastError(error, "Decision failed")
    await loadCollections().catch(() => {})
    scheduleRender()
  }
}

function openArgsEditor(hold) {
  const area = el("textarea", { class: "editor", spellcheck: "false" })
  area.value = pretty(hold.payload?.call?.args)
  const error = el("div", { class: "field-error" })
  area.addEventListener("input", () => {
    const parsed = parseJson(area.value)
    area.classList.toggle("invalid", !parsed.ok)
    error.textContent = parsed.ok ? "" : parsed.error
  })
  openModal({
    title: "Edit arguments",
    subtitle: "The tool receives exactly this JSON. The transcript keeps the original call.",
    iconName: "edit",
    wide: true,
    body: el("div", {}, area, error),
    actions: [
      { label: "Cancel", tone: "ghost" },
      {
        label: "Replace & run",
        tone: "primary",
        onClick: () => {
          const parsed = parseJson(area.value)
          if (!parsed.ok) {
            error.textContent = parsed.error
            area.classList.add("invalid")
            return false
          }
          void decideHeld(hold, "replace", { args: parsed.value })
          return true
        },
      },
    ],
  })
}

function openResultEditor(hold) {
  const area = el("textarea", { class: "editor", spellcheck: "false" })
  area.value = String(hold.payload?.result?.output ?? "")
  openModal({
    title: "Edit result",
    subtitle: "The model receives this text instead of the captured output.",
    iconName: "edit",
    wide: true,
    body: el("div", {}, area),
    actions: [
      { label: "Cancel", tone: "ghost" },
      {
        label: "Replace result",
        tone: "primary",
        onClick: () => {
          void decideHeld(hold, "replace", { result: { output: area.value } })
          return true
        },
      },
    ],
  })
}

function openSpoof(hold) {
  const isBefore = hold.stage === "before"
  const current = isBefore ? "" : String(hold.payload?.result?.output ?? "")
  const area = el("textarea", { class: "editor", spellcheck: "false", placeholder: "Write the text the model will see." })
  area.value = current

  const preview = el("pre", { class: "code" }, current || "Nothing yet.")
  area.addEventListener("input", () => {
    preview.textContent = area.value || "Nothing yet."
  })

  openModal({
    title: isBefore ? "Spoof result" : "Replace result",
    subtitle: isBefore
      ? "The tool is skipped entirely. The model gets this text as a normal, successful result."
      : "The captured output is discarded. The model gets this text as a normal, successful result.",
    iconName: "eye",
    wide: true,
    body: el(
      "div",
      {},
      el("p", { class: "modal-note" }, isBefore
        ? "Arguments stay exactly as the model wrote them. Nothing is sent to the tool."
        : "The original output stays in this inspector for your own review."),
      area,
      el("div", { class: "spoof-preview" }, el("div", { class: "section-title" }, "Model sees"), preview),
    ),
    actions: [
      { label: "Cancel", tone: "ghost" },
      {
        label: isBefore ? "Spoof result" : "Replace result",
        tone: "primary",
        onClick: () => {
          if (!area.value.trim()) {
            area.classList.add("invalid")
            area.focus()
            return false
          }
          if (isBefore) void decideHeld(hold, "respond", { result: { output: area.value } })
          else void decideHeld(hold, "replace", { result: { output: area.value } })
          return true
        },
      },
    ],
  })
  requestAnimationFrame(() => area.focus())
}

/* -------------------------------------------------------------------------- */
/* Global actions                                                              */
/* -------------------------------------------------------------------------- */

async function toggleIntercept(next) {
  const value = typeof next === "boolean" ? next : !state.runtime?.enabled
  state.runtime = { ...(state.runtime ?? {}), enabled: value }
  renderChrome()
  try {
    const result = await api("PUT", "/api/state", { enabled: value })
    state.runtime = { ...(state.runtime ?? {}), ...result }
    toast(value ? "Interception on" : "Interception off", { tone: value ? "warn" : "success", timeout: 1800 })
  } catch (error) {
    state.runtime.enabled = !value
    toastError(error, "Could not change interception")
  }
  scheduleRender(renderChrome)
}

async function clearHistory() {
  openModal({
    title: "Clear call history",
    subtitle: "This only clears the in-memory list. The audit log on disk is untouched.",
    iconName: "trash",
    body: el("p", { class: "modal-note" }, `Remove ${state.entries.length} captured call(s) from the panel?`),
    actions: [
      { label: "Cancel", tone: "ghost" },
      {
        label: "Clear history",
        tone: "danger",
        onClick: async () => {
          try {
            await api("POST", "/api/history/clear")
            state.entries = []
            if (state.selected?.kind === "call") closeDetail()
            scheduleRender()
            toast("History cleared", { tone: "success", timeout: 1800 })
          } catch (error) {
            toastError(error, "Clear failed")
          }
        },
      },
    ],
  })
}

async function clearTraffic() {
  try {
    await api("POST", "/api/traffic/clear")
    state.traffic = []
    if (state.selected?.kind === "http") closeDetail()
    scheduleRender()
    toast("Traffic cleared", { tone: "success", timeout: 1800 })
  } catch (error) {
    toastError(error, "Clear failed")
  }
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

const DEFAULT_PROFILE = {
  name: "default",
  rules: [
    { name: "hold web traffic", tools: ["webfetch", "websearch"], stages: null, action: "hold", enabled: true },
    {
      name: "hold code-mode fetches",
      tools: ["execute"],
      stages: null,
      argRegex: { source: "fetch\\s*\\(|https?://", flags: "i" },
      action: "hold",
      enabled: true,
    },
    {
      name: "hold shell fetches",
      tools: ["bash", "shell"],
      stages: null,
      argRegex: { source: "curl|wget|invoke-webrequest|iwr |https?://", flags: "i" },
      action: "hold",
      enabled: true,
    },
  ],
  defaults: { holdTimeoutMs: 120000, onTimeout: "forward", noRule: "hold" },
}

const RULE_TEMPLATES = [
  {
    label: "Hold web tools",
    hint: "Pause webfetch and websearch at both stages",
    rule: { name: "hold web traffic", tools: ["webfetch", "websearch"], stages: null, action: "hold", enabled: true },
  },
  {
    label: "Hold external fetches",
    hint: "Pause any tool whose args contain a URL",
    rule: {
      name: "hold external fetches",
      tools: null,
      stages: null,
      argRegex: { source: "https?://", flags: "i" },
      action: "hold",
      enabled: true,
    },
  },
  {
    label: "Drop shell network calls",
    hint: "Block curl/wget before they run",
    rule: {
      name: "drop shell network calls",
      tools: ["bash", "shell"],
      stages: ["before"],
      argRegex: { source: "curl|wget|invoke-webrequest|iwr ", flags: "i" },
      action: "drop",
      enabled: true,
    },
  },
  {
    label: "Flag secrets in output",
    hint: "Hold results that look like credentials",
    rule: {
      name: "flag secrets in output",
      tools: null,
      stages: ["after"],
      contentRegex: { source: "api[_-]?key|secret|token|password|BEGIN [A-Z ]*PRIVATE KEY", flags: "i" },
      action: "hold",
      enabled: true,
    },
  },
  {
    label: "Pass health checks",
    hint: "Never interrupt liveness probes",
    rule: { name: "pass health checks", tools: null, stages: null, argRegex: { source: "health|ping|liveness", flags: "i" }, action: "pass", enabled: true },
  },
]

function ensureDraft() {
  if (!state.rulesDraft) state.rulesDraft = structuredClone(state.runtime?.profile ?? DEFAULT_PROFILE)
  return state.rulesDraft
}

function compileSpec(spec) {
  if (!spec?.source) return null
  try {
    return new RegExp(spec.source, spec.flags ?? "")
  } catch {
    return null
  }
}

function ruleIssues(rule) {
  const issues = {}
  if (rule.argRegex?.source && !compileSpec(rule.argRegex)) issues.arg = "Invalid regular expression"
  if (rule.contentRegex?.source && !compileSpec(rule.contentRegex)) issues.content = "Invalid regular expression"
  if (!rule.name?.trim()) issues.name = "Give the rule a name"
  return issues
}

function ruleMatches(rule, entry) {
  if (rule.tools && rule.tools.length && !rule.tools.includes(entry.tool)) return false
  if (rule.stages && rule.stages.length) {
    const stage = entry.after ? "after" : "before"
    if (!rule.stages.includes(stage)) return false
  }
  const argRe = compileSpec(rule.argRegex)
  if (argRe && !argRe.test(entry.argsText ?? "")) return false
  const contentRe = compileSpec(rule.contentRegex)
  if (contentRe) {
    const output = entry.after?.result?.output
    if (typeof output !== "string" || !contentRe.test(output)) return false
  }
  return true
}

function ruleMatchCount(rule) {
  if (!rule.enabled) return 0
  return state.entries.filter((entry) => ruleMatches(rule, entry)).length
}

function markRulesDirty() {
  state.rulesDirty = true
  const footer = $("#rules-footer")
  if (footer) {
    footer.querySelector(".dirty-note")?.replaceChildren(el("span", { class: "dirty-dot" }), "Unsaved changes")
    const save = footer.querySelector("[data-save]")
    if (save) save.disabled = false
  }
}

function rulesFooter() {
  const footer = el("div", { class: "rules-footer", id: "rules-footer" })
  const note = el("span", { class: "saved-note dirty-note" }, state.rulesDirty ? [el("span", { class: "dirty-dot" }), "Unsaved changes"] : [icon("check", 12), "Saved"])
  const save = el("button", { class: "btn primary sm", type: "button", "data-save": "1", onclick: saveProfile }, "Save profile")
  save.disabled = !state.rulesDirty
  footer.append(
    note,
    el("span", { class: "spacer" }),
    el("button", { class: "btn ghost sm", type: "button", onclick: discardRules }, "Discard"),
    save,
  )
  return footer
}

async function saveProfile() {
  const draft = ensureDraft()
  const invalid = draft.rules.some((rule) => Object.keys(ruleIssues(rule)).length > 0)
  if (invalid) {
    toast("Fix invalid rules first", { detail: "A rule has an empty name or a broken regular expression.", tone: "error" })
    return
  }
  try {
    await api("PUT", "/api/profile", draft)
    state.rulesDirty = false
    state.runtime = { ...(state.runtime ?? {}), profile: structuredClone(draft) }
    scheduleRender()
    toast("Profile saved", { tone: "success", timeout: 1800 })
  } catch (error) {
    toastError(error, "Save failed")
  }
}

function discardRules() {
  state.rulesDraft = structuredClone(state.runtime?.profile ?? DEFAULT_PROFILE)
  state.rulesDirty = false
  renderRules()
}

function newRule() {
  ensureDraft().rules.push({ name: "new rule", tools: null, stages: null, action: "hold", enabled: true })
  state.rulesDirty = true
  renderRules()
}

function addTemplate(rule) {
  ensureDraft().rules.push(structuredClone(rule))
  state.rulesDirty = true
  renderRules()
}

function moveRule(index, delta) {
  const rules = ensureDraft().rules
  const target = index + delta
  if (target < 0 || target >= rules.length) return
  const [rule] = rules.splice(index, 1)
  rules.splice(target, 0, rule)
  state.rulesDirty = true
  renderRules()
}

function duplicateRule(index) {
  const rules = ensureDraft().rules
  const copy = structuredClone(rules[index])
  copy.name = `${copy.name || "rule"} copy`
  rules.splice(index + 1, 0, copy)
  state.rulesDirty = true
  renderRules()
}

function deleteRule(index) {
  ensureDraft().rules.splice(index, 1)
  state.rulesDirty = true
  renderRules()
}

function exportRules() {
  const draft = ensureDraft()
  const blob = new Blob([JSON.stringify({ name: draft.name, rules: draft.rules, defaults: draft.defaults }, null, 2)], {
    type: "application/json",
  })
  const url = URL.createObjectURL(blob)
  const link = el("a", { href: url, download: "openintercept-rules.json" })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast("Rules exported", { detail: "openintercept-rules.json", tone: "success", timeout: 2200 })
}

function importRules() {
  const input = el("input", { type: "file", accept: "application/json,.json", style: "display:none" })
  input.addEventListener("change", async () => {
    const file = input.files?.[0]
    input.remove()
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      const rules = Array.isArray(parsed) ? parsed : parsed.rules
      if (!Array.isArray(rules)) throw new Error("Expected a rules array")
      const draft = ensureDraft()
      draft.rules = rules.map((rule) => ({
        name: String(rule.name ?? "imported rule"),
        tools: Array.isArray(rule.tools) ? rule.tools.map(String) : null,
        stages: Array.isArray(rule.stages) ? rule.stages.filter((stage) => stage === "before" || stage === "after") : null,
        ...(rule.argRegex?.source ? { argRegex: { source: String(rule.argRegex.source), flags: String(rule.argRegex.flags ?? "") } } : {}),
        ...(rule.contentRegex?.source ? { contentRegex: { source: String(rule.contentRegex.source), flags: String(rule.contentRegex.flags ?? "") } } : {}),
        action: ["hold", "pass", "drop"].includes(rule.action) ? rule.action : "hold",
        enabled: rule.enabled !== false,
      }))
      if (parsed.defaults && typeof parsed.defaults === "object") draft.defaults = { ...draft.defaults, ...parsed.defaults }
      state.rulesDirty = true
      renderRules()
      toast("Rules imported", { detail: `${draft.rules.length} rule(s) ready to save`, tone: "success" })
    } catch (error) {
      toastError(error, "Import failed")
    }
  })
  document.body.append(input)
  input.click()
}

function resetRules() {
  openModal({
    title: "Reset rules",
    subtitle: "Replace the draft with the default profile.",
    iconName: "rotate",
    body: el("p", { class: "modal-note" }, "This discards unsaved edits and restores the three default rules. Nothing is written until you save."),
    actions: [
      { label: "Cancel", tone: "ghost" },
      {
        label: "Reset draft",
        tone: "danger",
        onClick: () => {
          state.rulesDraft = structuredClone(DEFAULT_PROFILE)
          state.rulesDirty = true
          renderRules()
        },
      },
    ],
  })
}

function seg(options, value, onChange, toneFor = (option) => option) {
  const wrap = el("div", { class: "seg" })
  for (const option of options) {
    const button = el(
      "button",
      {
        class: `seg-btn ${value === option ? `active ${toneFor(option)}` : ""}`.trim(),
        type: "button",
        onclick: () => onChange(option),
      },
      option,
    )
    wrap.append(button)
  }
  return wrap
}

function ruleCard(rule, index) {
  const issues = ruleIssues(rule)
  const card = el("div", { class: `rule-card ${rule.enabled ? "" : "disabled"} ${Object.keys(issues).length ? "invalid" : ""}`.trim() })

  const nameInput = el("input", { type: "text", value: rule.name ?? "", placeholder: "Rule name", "aria-label": "Rule name" })
  nameInput.addEventListener("input", () => {
    rule.name = nameInput.value
    markRulesDirty()
  })

  const enabledSwitch = el(
    "label",
    { class: "switch", title: rule.enabled ? "Rule enabled" : "Rule disabled" },
    el("input", {
      type: "checkbox",
      checked: rule.enabled,
      onchange: (event) => {
        rule.enabled = event.currentTarget.checked
        card.classList.toggle("disabled", !rule.enabled)
        markRulesDirty()
        updateRuleFoot()
      },
    }),
    el("span", { class: "track" }),
  )

  const head = el(
    "div",
    { class: "rule-head" },
    el("span", { class: "rule-index" }, String(index + 1)),
    el("div", { class: "rule-name" }, nameInput),
    el(
      "div",
      { class: "rule-badges" },
      enabledSwitch,
      seg(["hold", "pass", "drop"], rule.action, (action) => {
        rule.action = action
        markRulesDirty()
        renderRules()
      }, (action) => (action === "hold" ? "hold" : action === "pass" ? "pass" : "drop")),
    ),
    el(
      "div",
      { class: "rule-actions" },
      el("button", { class: "icon-btn", type: "button", title: "Move up", onclick: () => moveRule(index, -1) }, icon("arrowUp", 14)),
      el("button", { class: "icon-btn", type: "button", title: "Move down", onclick: () => moveRule(index, 1) }, icon("arrowDown", 14)),
      el("button", { class: "icon-btn", type: "button", title: "Duplicate", onclick: () => duplicateRule(index) }, icon("duplicate", 14)),
      el("button", { class: "icon-btn", type: "button", title: "Delete", onclick: () => deleteRule(index) }, icon("trash", 14)),
    ),
  )

  const toolsInput = el("input", { class: "text mono", type: "text", value: (rule.tools ?? []).join(", "), placeholder: "any tool", "aria-label": "Tools" })
  toolsInput.addEventListener("input", () => {
    const tools = toolsInput.value.split(",").map((tool) => tool.trim()).filter(Boolean)
    rule.tools = tools.length ? tools : null
    markRulesDirty()
    updateRuleFoot()
  })

  const stageWrap = el("div", { class: "seg" })
  for (const stage of ["before", "after"]) {
    const active = !rule.stages || rule.stages.includes(stage)
    stageWrap.append(
      el(
        "button",
        {
          class: `seg-btn ${active ? `active ${stage}` : ""}`.trim(),
          type: "button",
          "aria-pressed": String(active),
          onclick: (event) => {
            const current = rule.stages ? [...rule.stages] : ["before", "after"]
            const next = current.includes(stage) ? current.filter((item) => item !== stage) : [...current, stage]
            rule.stages = next.length === 0 || next.length === 2 ? null : next
            const nowActive = !rule.stages || rule.stages.includes(stage)
            event.currentTarget.classList.toggle("active", nowActive)
            event.currentTarget.classList.toggle(stage, nowActive)
            markRulesDirty()
            updateRuleFoot()
          },
        },
        stage,
      ),
    )
  }

  const argSource = el("input", { class: `text mono ${issues.arg ? "invalid" : ""}`.trim(), type: "text", value: rule.argRegex?.source ?? "", placeholder: "args regex", "aria-label": "Arguments regex" })
  const argFlags = el("input", { class: "text mono", type: "text", value: rule.argRegex?.flags ?? "", placeholder: "flags", "aria-label": "Arguments regex flags" })
  const argError = el("div", { class: "field-error" }, issues.arg ?? "")
  const applyArg = () => {
    const source = argSource.value.trim()
    rule.argRegex = source ? { source, flags: argFlags.value.trim() } : undefined
    const problem = source && !compileSpec(rule.argRegex)
    argSource.classList.toggle("invalid", !!problem)
    argError.textContent = problem ? "Invalid regular expression" : ""
    markRulesDirty()
    updateRuleFoot()
  }
  argSource.addEventListener("input", applyArg)
  argFlags.addEventListener("input", applyArg)

  const contentSource = el("input", { class: `text mono ${issues.content ? "invalid" : ""}`.trim(), type: "text", value: rule.contentRegex?.source ?? "", placeholder: "result regex (after only)", "aria-label": "Result regex" })
  const contentFlags = el("input", { class: "text mono", type: "text", value: rule.contentRegex?.flags ?? "", placeholder: "flags", "aria-label": "Result regex flags" })
  const contentError = el("div", { class: "field-error" }, issues.content ?? "")
  const applyContent = () => {
    const source = contentSource.value.trim()
    rule.contentRegex = source ? { source, flags: contentFlags.value.trim() } : undefined
    const problem = source && !compileSpec(rule.contentRegex)
    contentSource.classList.toggle("invalid", !!problem)
    contentError.textContent = problem ? "Invalid regular expression" : ""
    markRulesDirty()
    updateRuleFoot()
  }
  contentSource.addEventListener("input", applyContent)
  contentFlags.addEventListener("input", applyContent)

  const body = el(
    "div",
    { class: "rule-body" },
    el(
      "div",
      { class: "rule-fields" },
      el("div", { class: "field" }, el("label", {}, "Tools"), toolsInput, el("span", { class: "field-hint" }, "Comma separated, empty = any tool")),
      el("div", { class: "field" }, el("label", {}, "Stages"), stageWrap, el("span", { class: "field-hint" }, "Where this rule can fire")),
      el("div", { class: "field" }, el("label", {}, "Action"), el("span", { class: "field-hint" }, rule.action === "hold" ? "Pause and ask you" : rule.action === "pass" ? "Let it through untouched" : "Block before the tool runs")),
    ),
    el(
      "div",
      { class: "regex-grid" },
      el("div", { class: "regex-label" }, "Arguments regex"),
      argSource, argFlags, el("span"),
      argError,
    ),
    el(
      "div",
      { class: "regex-grid" },
      el("div", { class: "regex-label" }, "Result regex"),
      contentSource, contentFlags, el("span"),
      contentError,
    ),
  )

  const count = el("span", { class: "match-count" })
  const foot = el(
    "div",
    { class: "rule-foot" },
    count,
    el("span", { class: "spacer" }),
    el("span", {}, issues.name ?? ""),
  )

  function updateRuleFoot() {
    const matches = ruleMatchCount(rule)
    count.replaceChildren(icon("activity", 11), el("strong", {}, String(matches)), `match${matches === 1 ? "" : "es"} in history`)
    foot.querySelector(".spacer + span").textContent = ruleIssues(rule).name ?? ""
  }
  updateRuleFoot()

  card.append(head, body, foot)
  return card
}

function renderRules() {
  const list = $("#list")
  const draft = ensureDraft()
  const pane = el("div", { class: "pane" })
  const inner = el("div", { class: "pane-inner" })

  const searchInput = el("input", { type: "search", placeholder: "Find a rule…", value: state.ruleSearch, "aria-label": "Find a rule" })
  searchInput.addEventListener("input", () => {
    state.ruleSearch = searchInput.value
    renderRuleCards()
  })

  inner.append(
    el(
      "div",
      { class: "pane-head" },
      el("h2", {}, "Rules"),
      el("span", { class: "spacer" }),
      el("button", { class: "btn", type: "button", onclick: importRules }, icon("upload", 13), "Import"),
      el("button", { class: "btn", type: "button", onclick: exportRules }, icon("download", 13), "Export"),
      el("button", { class: "btn", type: "button", onclick: resetRules }, icon("rotate", 13), "Reset"),
      el("button", { class: "btn primary", type: "button", onclick: newRule }, icon("spark", 13), "New rule"),
    ),
    el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, icon("sliders", 14), el("h3", {}, "Templates")),
      el("div", { class: "card-body" },
        el("div", { class: "template-row" },
          ...RULE_TEMPLATES.map((template) =>
            el("button", { class: "template-btn", type: "button", title: template.hint, onclick: () => addTemplate(template.rule) }, icon("spark", 12), template.label),
          ),
        ),
      ),
    ),
    el("div", { class: "rules-toolbar" }, el("div", { class: "search-field" }, el("span", { class: "icon-left" }, icon("search", 14)), searchInput), el("span", { class: "spacer" })),
    el("div", { class: "rule-list", id: "rule-list" }),
    rulesFooter(),
  )
  pane.append(inner)
  list.replaceChildren(pane)

  function renderRuleCards() {
    const container = $("#rule-list")
    if (!container) return
    container.replaceChildren()
    const q = state.ruleSearch.trim().toLowerCase()
    const rules = draft.rules
    const visible = rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => !q || `${rule.name} ${(rule.tools ?? []).join(" ")} ${rule.action}`.toLowerCase().includes(q))
    if (!visible.length) {
      container.append(el("div", { class: "empty" }, el("span", { class: "empty-icon" }, icon("sliders", 20)), el("h3", {}, rules.length ? "No rule matches that search" : "No rules yet")))
      return
    }
    for (const { rule, index } of visible) container.append(ruleCard(rule, index))
  }
  renderRuleCards()
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                      */
/* -------------------------------------------------------------------------- */

async function installPlugin() {
  try {
    const result = await api("POST", "/api/plugin/install", {})
    state.plugin = await api("GET", "/api/plugin/status")
    toast("Plugin installed", { detail: result.dest, tone: "success", timeout: 5000 })
    scheduleRender()
  } catch (error) {
    toastError(error, "Install failed")
  }
}

const ONE_LINER_RAW = "https://raw.githubusercontent.com/asucodes/OpenIntercept/main/scripts"

function oneLinerText() {
  const isWindows = /Win/i.test(navigator.platform || "")
  return isWindows
    ? `irm ${ONE_LINER_RAW}/install.ps1 | iex`
    : `curl -fsSL ${ONE_LINER_RAW}/install.sh | bash`
}

function oneLinerCopy() {
  const button = el("button", { class: "copy-btn", type: "button" }, icon("copy", 11), "Copy")
  button.addEventListener("click", async () => {
    if (await copyText(oneLinerText())) {
      button.classList.add("copied")
      button.replaceChildren(icon("check", 11), "Copied")
      setTimeout(() => {
        button.classList.remove("copied")
        button.replaceChildren(icon("copy", 11), "Copy")
      }, 1400)
    } else toast("Clipboard unavailable", { tone: "warn", timeout: 2200 })
  })
  return button
}

async function setCapture(patch) {
  try {
    const result = await api("PUT", "/api/state", patch)
    state.runtime = { ...(state.runtime ?? {}), ...result }
    state.meta = await api("GET", "/api/meta").catch(() => state.meta)
    scheduleRender()
    toast("Capture updated", { tone: "success", timeout: 1600 })
  } catch (error) {
    toastError(error, "Could not update capture")
    scheduleRender()
  }
}

function settingSwitch(checked, onChange) {
  return el(
    "label",
    { class: "switch" },
    el("input", { type: "checkbox", checked, onchange: (event) => onChange(event.currentTarget.checked) }),
    el("span", { class: "track" }),
  )
}

function renderPlugin() {
  const list = $("#list")
  const meta = state.meta
  const pane = el("div", { class: "pane" })
  const inner = el("div", { class: "pane-inner" })

  const installed = !!state.plugin?.installed
  const agents = state.plugin?.agents ?? state.agents ?? []

  inner.append(
    el("div", { class: "pane-head" },
      el("h2", {}, "Plugin & capture"),
    ),
    el("div", { class: "card" },
      el("div", { class: "card-head" }, icon("zap", 14), el("h3", {}, "One-liner install"), el("span", { class: "spacer" })),
      el("div", { class: "card-body" },
        el("div", { class: "copy-row" }, oneLinerCopy()),
        el("pre", { class: "code-snippet", id: "one-liner" }, oneLinerText()),
        el("div", { class: "faint", style: "margin-top:6px" }, "Sets up Bun, the sidecar, and the adapter on any machine with OpenCode."),
      ),
    ),
    el("div", { class: "plugin-grid" },
      el("div", { class: "card" },
        el("div", { class: "card-head" }, icon("plug", 14), el("h3", {}, "Adapter"), el("span", { class: "spacer" }), el("span", { class: `status-pill ${installed ? "ok" : "warn"}` }, installed ? "installed" : "not installed")),
        el("div", { class: "card-body" },
          el("dl", { class: "kv" },
            el("dt", {}, "Destination"), el("dd", { class: "mono" }, state.plugin?.dest ?? "—"),
            el("dt", {}, "V1 variant"), el("dd", {}, "openintercept.ts (project installs)"),
            el("dt", {}, "V2 variant"), el("dd", {}, "openintercept-v2.ts"),
            el("dt", {}, "Heartbeats"), el("dd", {}, `${agents.length} active`),
          ),
          el("div", { class: "mt-12" },
            el("button", { class: "btn primary", type: "button", onclick: installPlugin }, icon("download", 13), installed ? "Reinstall adapter" : "Install adapter"),
            el("button", { class: "btn", type: "button", style: "margin-left:8px", onclick: async () => { if (await copyText(state.plugin?.dest ?? "")) toast("Path copied", { tone: "success", timeout: 1400 }) } }, icon("copy", 13), "Copy path"),
          ),
        ),
      ),
      el("div", { class: "card" },
        el("div", { class: "card-head" }, icon("sliders", 14), el("h3", {}, "Capture"), el("span", { class: "spacer" })),
        el("div", { class: "card-body" },
          el("div", { class: "setting-row" },
            el("div", { class: "setting-label" }, el("div", { class: "name" }, "Model HTTP traffic"), el("div", { class: "hint" }, "Opt-in · bodies are bounded previews, credentials redacted.")),
            el("div", { class: "setting-control" }, settingSwitch(!!state.runtime?.captureModelTraffic, (value) => setCapture({ captureModelTraffic: value }))),
          ),
          el("div", { class: "setting-row" },
            el("div", { class: "setting-label" }, el("div", { class: "name" }, "Plaintext HTTP proxy"), el("div", { class: "hint" }, `${meta?.proxy?.host ?? "127.0.0.1"}:${meta?.proxy?.port ?? 7475} · HTTPS tunnelled, not decrypted.`)),
            el("div", { class: "setting-control" }, settingSwitch(!!state.runtime?.networkProxyEnabled, (value) => setCapture({ networkProxyEnabled: value }))),
          ),
        ),
      ),
      el("div", { class: "card" },
        el("div", { class: "card-head" }, icon("database", 14), el("h3", {}, "Local data"), el("span", { class: "spacer" })),
        el("div", { class: "card-body" },
          el("dl", { class: "kv" },
            el("dt", {}, "Data dir"), el("dd", { class: "mono" }, meta?.dataDir ?? "—"),
            el("dt", {}, "Audit log"), el("dd", { class: "mono" }, meta?.audit?.path ?? "—"),
            el("dt", {}, "Audit size"), el("dd", {}, fmtBytes(meta?.audit?.size ?? 0)),
            el("dt", {}, "Version"), el("dd", {}, meta ? `${meta.name} ${meta.version}` : "—"),
            el("dt", {}, "Runtime"), el("dd", {}, meta ? `Bun ${meta.runtime.bun} · ${meta.runtime.platform}/${meta.runtime.arch}` : "—"),
            el("dt", {}, "Uptime"), el("dd", {}, meta ? fmtDuration(meta.uptimeMs) : "—"),
          ),
        ),
      ),
      el("div", { class: "card" },
        el("div", { class: "card-head" }, icon("wifi", 14), el("h3", {}, "Live adapters"), el("span", { class: "spacer" })),
        el("div", { class: "card-body" },
          agents.length
            ? el("div", { class: "steps" }, ...agents.map((agent) => el("div", { class: "step" },
                el("span", { class: "step-num" }, icon("activity", 11)),
                el("div", {}, el("div", {}, agent.adapter ?? "adapter"), el("div", { class: "faint" }, `${agent.location ?? "unknown location"} · ${ago(agent.at)}${agent.spoof ? ` · spoof ${agent.spoof}` : ""}`)),
              )))
            : el("div", { class: "notice" }, el("span", { class: "notice-icon" }, icon("alert", 14)), el("div", {}, "No adapter heartbeat yet.")),
        ),
      ),
    ),
  )
  pane.append(inner)
  list.replaceChildren(pane)
}

/* -------------------------------------------------------------------------- */
/* Navigation + render                                                         */
/* -------------------------------------------------------------------------- */

function setView(id) {
  if (!VIEWS.some((view) => view.id === id)) return
  const changed = state.view !== id
  state.view = id
  if (changed) {
    state.search = ""
    state.statusFilter = "all"
  }
  if (id === "rules" || id === "plugin") {
    if (state.selected) closeDetail()
  }
  try {
    history.replaceState(null, "", `#/${id}`)
  } catch {
    /* file:// */
  }
  buildToolbar()
  renderChrome()
  renderList()
}

function renderAll() {
  renderChrome()
  renderList()
  if (state.selected) renderDetail()
}

/* -------------------------------------------------------------------------- */
/* Shortcuts                                                                   */
/* -------------------------------------------------------------------------- */

const SHORTCUTS = [
  ["⌘K / Ctrl K", "Command palette"],
  ["I", "Toggle interception"],
  ["R", "Reload captures"],
  ["G then C", "Go to Calls"],
  ["G then H", "Go to HTTP"],
  ["G then I", "Go to Intercept"],
  ["G then R", "Go to Rules"],
  ["G then P", "Go to Plugin"],
  ["J / K", "Next / previous call"],
  ["/", "Focus filter"],
  ["Esc", "Close inspector"],
  ["?", "This cheat sheet"],
]

function openShortcuts() {
  openModal({
    title: "Keyboard shortcuts",
    subtitle: "Everything is one keystroke away.",
    iconName: "keyboard",
    body: el("div", { class: "steps" }, ...SHORTCUTS.map(([keys, label]) => el("div", { class: "step" },
      el("span", { class: "step-num", style: "width:auto;padding:0 7px;font-size:10px" }, keys),
      el("div", {}, label),
    ))),
    actions: [{ label: "Close", tone: "ghost" }],
  })
}

function moveSelection(delta) {
  if (state.view !== "calls" && state.view !== "http") return
  const items = state.view === "calls" ? visibleEntries() : visibleTraffic()
  if (!items.length) return
  const index = items.findIndex((item) => item.id === state.selected?.id)
  const next = Math.max(0, Math.min(items.length - 1, index === -1 ? (delta > 0 ? 0 : items.length - 1) : index + delta))
  select(state.view === "calls" ? "call" : "http", items[next].id)
  requestAnimationFrame(() => {
    document.querySelector(".row.selected")?.scrollIntoView({ block: "nearest" })
  })
}

let pendingG = false
let gTimer = null

function onKeydown(event) {
  const target = event.target
  const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
  const mod = event.metaKey || event.ctrlKey

  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault()
    openPalette()
    return
  }
  if (typing) return
  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    event.preventDefault()
    openShortcuts()
    return
  }
  if (event.key === "/") {
    event.preventDefault()
    $(".search-field input")?.focus()
    return
  }
  if (event.key === "Escape") {
    if (!$("#modal-root").hidden) return
    if (!$("#palette-root").hidden) return
    if (state.selected) closeDetail()
    return
  }
  if (event.key.toLowerCase() === "i" && !mod) {
    event.preventDefault()
    void toggleIntercept()
    return
  }
  if (event.key.toLowerCase() === "r" && !mod) {
    event.preventDefault()
    loadAll().then(() => toast("Reloaded", { tone: "success", timeout: 1400 })).catch((error) => toastError(error, "Reload failed"))
    return
  }
  if (event.key.toLowerCase() === "j") {
    event.preventDefault()
    moveSelection(1)
    return
  }
  if (event.key.toLowerCase() === "k") {
    event.preventDefault()
    moveSelection(-1)
    return
  }
  if (event.key.toLowerCase() === "g") {
    pendingG = true
    clearTimeout(gTimer)
    gTimer = setTimeout(() => { pendingG = false }, 900)
    return
  }
  if (pendingG) {
    const map = { c: "calls", h: "http", i: "intercept", r: "rules", p: "plugin" }
    const view = map[event.key.toLowerCase()]
    if (view) {
      event.preventDefault()
      pendingG = false
      setView(view)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

function wireShell() {
  $("#theme-toggle").addEventListener("click", toggleTheme)
  $("#density-toggle").addEventListener("click", toggleDensity)
  $("#rail-toggle").addEventListener("click", toggleRail)
  $("#help-btn").addEventListener("click", openShortcuts)
  $("#refresh").addEventListener("click", () => {
    loadAll().then(() => toast("Reloaded", { tone: "success", timeout: 1400 })).catch((error) => toastError(error, "Reload failed"))
  })
  $("#intercept").addEventListener("click", () => toggleIntercept())
  $("#palette-trigger").addEventListener("click", openPalette)
  $("#brand").addEventListener("click", (event) => {
    event.preventDefault()
    setView("calls")
  })
  document.addEventListener("keydown", onKeydown)

  window.addEventListener("hashchange", () => {
    const id = location.hash.replace(/^#\/?/, "")
    if (VIEWS.some((view) => view.id === id) && id !== state.view) setView(id)
  })
}

function boot() {
  applyChromePrefs()
  buildNav()
  wireShell()
  renderChrome()

  const initial = location.hash.replace(/^#\/?/, "")
  if (VIEWS.some((view) => view.id === initial)) state.view = initial
  buildToolbar()
  renderList()

  connectEvents()

  loadAll()
    .then(() => {
      if (state.connection !== "live") state.connection = "live"
      renderAll()
    })
    .catch((error) => {
      state.connection = "offline"
      state.loaded = true
      renderAll()
      toastError(error, "Sidecar unreachable")
    })
}

boot()
