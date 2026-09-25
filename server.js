"use strict";
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs-extra");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const PASSWORD = process.env.PANEL_PASSWORD;
const BDIR = path.join(__dirname, "bot"); // এখানেই আপলোড করা official-bot প্রজেক্ট এক্সট্র্যাক্ট হবে
const EDITABLE_SUBDIRS = ["commands", "utils"]; // বটের ভেতরে শুধু এই ফোল্ডারগুলো এডিট/ডিলিটযোগ্য
const ROOT_EDITABLE_FILES = [".env", "package.json"]; // বটের রুটে শুধু এই ফাইলগুলো এডিটযোগ্য

fs.ensureDirSync(BDIR);

// ──────────────────────────── লগ রিং-বাফার ────────────────────────────
const MAX_LOG_LINES = 800;
const logLines = [];
function pushLog(level, text) {
  logLines.push({ t: Date.now(), level, text: String(text) });
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
}
pushLog("info", "🎛️ Panel চালু হলো");

// ──────────────────────────── বট সাবপ্রসেস ম্যানেজমেন্ট ────────────────────────────
let botProc = null;
let botState = "stopped"; // stopped | installing | starting | running | crashed
let restartTimestamps = [];

function spawnLogged(cmd, args, opts, onDone) {
  const p = spawn(cmd, args, { cwd: BDIR, env: process.env, ...opts });
  p.stdout.on("data", (d) => pushLog("info", d.toString().trim()));
  p.stderr.on("data", (d) => pushLog("error", d.toString().trim()));
  p.on("close", (code) => onDone && onDone(code));
  return p;
}

function npmInstallThenStart() {
  botState = "installing";
  pushLog("info", "📦 npm install শুরু হচ্ছে...");
  spawnLogged("npm", ["install", "--no-audit", "--no-fund"], {}, (code) => {
    if (code !== 0) {
      botState = "crashed";
      pushLog("error", `❌ npm install ব্যর্থ (exit ${code})`);
      return;
    }
    pushLog("info", "✅ npm install সম্পন্ন");
    startBot();
  });
}

function startBot() {
  const idx = path.join(BDIR, "index.js");
  if (!fs.existsSync(idx)) {
    pushLog("error", "❌ bot/index.js পাওয়া যায়নি — আগে জিপ আপলোড করুন");
    botState = "stopped";
    return;
  }
  botState = "starting";
  pushLog("info", "🚀 বট চালু হচ্ছে...");
  botProc = spawnLogged("node", ["index.js"], {}, (code) => {
    botState = "stopped";
    pushLog("error", `⚠️ বট বন্ধ হয়ে গেছে (exit ${code})`);
    botProc = null;

    // ✅ ৩০ মিনিটে ৪ বারের বেশি অটো-রিস্টার্ট না — বারবার ক্র্যাশ-লুপ
    // (যেমন খারাপ কোড সেভ হয়ে থাকলে) সার্ভার overload করবে না
    const now = Date.now();
    restartTimestamps = restartTimestamps.filter((t) => now - t < 30 * 60 * 1000);
    if (restartTimestamps.length >= 4) {
      pushLog("error", "🛑 ৩০ মিনিটে ৪ বার ক্র্যাশ হয়েছে — অটো-রিস্টার্ট বন্ধ রাখা হলো। প্যানেল থেকে ম্যানুয়ালি স্টার্ট করুন।");
      return;
    }
    restartTimestamps.push(now);
    setTimeout(() => { if (botState === "stopped") startBot(); }, 5000);
  });
  botState = "running";
}

function stopBot() {
  if (botProc) {
    botProc.kill();
    botProc = null;
  }
  botState = "stopped";
  pushLog("info", "⏹️ বট বন্ধ করা হলো");
}

// ──────────────────────────── অথ মিডলওয়্যার ────────────────────────────
function auth(req, res, next) {
  if (!PASSWORD) return res.status(500).json({ error: "PANEL_PASSWORD .env এ সেট করা নেই" });
  const token = req.headers["x-panel-token"] || req.query.token;
  if (token !== PASSWORD) return res.status(401).json({ error: "ভুল পাসওয়ার্ড" });
  next();
}

// ──────────────────────────── আপলোড (zip → bot/) ────────────────────────────
const upload = multer({ storage: multer.diskStorage({ destination: "/tmp", filename: (r, f, cb) => cb(null, Date.now() + "_" + f.originalname) }), limits: { fileSize: 200 * 1024 * 1024 } });

app.post("/api/upload", auth, upload.single("zip"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "জিপ ফাইল পাওয়া যায়নি" });
    stopBot();

    await fs.emptyDir(BDIR); // পুরনো বট ফাইল মুছে নতুনটা বসানো
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();

    // জিপের ভেতরে যদি একটাই টপ-লেভেল ফোল্ডার থাকে (যেমন official-bot/...),
    // সেই ফোল্ডারের ভেতরের কনটেন্টটাই bot/-এ রাখা, extra nesting এড়াতে
    const topDirs = new Set(entries.map((e) => e.entryName.split("/")[0]));
    const singleRoot = topDirs.size === 1 ? [...topDirs][0] : null;

    zip.extractAllTo(BDIR, true);
    if (singleRoot && fs.existsSync(path.join(BDIR, singleRoot)) && fs.statSync(path.join(BDIR, singleRoot)).isDirectory()) {
      const inner = path.join(BDIR, singleRoot);
      for (const f of await fs.readdir(inner)) {
        await fs.move(path.join(inner, f), path.join(BDIR, f), { overwrite: true });
      }
      await fs.remove(inner);
    }

    await fs.remove(req.file.path);
    pushLog("info", `📦 জিপ এক্সট্র্যাক্ট হলো (${entries.length} এন্ট্রি)`);
    res.json({ ok: true, msg: "জিপ এক্সট্র্যাক্ট হয়েছে। এখন 'Install + Start' চাপুন।" });
  } catch (e) {
    pushLog("error", "❌ আপলোড ব্যর্থ: " + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────── বট কন্ট্রোল ────────────────────────────
app.post("/api/bot/install-start", auth, (req, res) => { npmInstallThenStart(); res.json({ ok: true }); });
app.post("/api/bot/start", auth, (req, res) => { startBot(); res.json({ ok: true }); });
app.post("/api/bot/stop", auth, (req, res) => { stopBot(); res.json({ ok: true }); });
app.post("/api/bot/restart", auth, (req, res) => { stopBot(); setTimeout(startBot, 1000); res.json({ ok: true }); });

app.get("/api/status", auth, (req, res) => {
  res.json({
    botState,
    panelUptimeSec: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    time: new Date().toISOString(),
    hasProject: fs.existsSync(path.join(BDIR, "index.js")),
  });
});

app.get("/api/logs", auth, (req, res) => res.json({ lines: logLines }));

// ──────────────────────────── ফাইল ম্যানেজার (bot/ এর ভেতরে) ────────────────────────────
function safeResolve(relPath) {
  const cleaned = String(relPath || "").replace(/^\/+/, "");
  const top = cleaned.split("/")[0];
  if (!EDITABLE_SUBDIRS.includes(top) && !ROOT_EDITABLE_FILES.includes(cleaned)) {
    throw new Error("এই পাথ এডিট/ডিলিট করার অনুমতি নেই");
  }
  const full = path.resolve(BDIR, cleaned);
  if (!full.startsWith(path.resolve(BDIR))) throw new Error("অবৈধ পাথ");
  return full;
}

app.get("/api/files", auth, async (req, res) => {
  try {
    const result = [];
    for (const f of ROOT_EDITABLE_FILES) {
      const fp = path.join(BDIR, f);
      if (await fs.pathExists(fp)) result.push({ path: f, size: (await fs.stat(fp)).size });
    }
    for (const dir of EDITABLE_SUBDIRS) {
      const dirPath = path.join(BDIR, dir);
      if (!(await fs.pathExists(dirPath))) continue;
      for (const f of await fs.readdir(dirPath)) {
        if (!f.endsWith(".js")) continue;
        const stat = await fs.stat(path.join(dirPath, f));
        result.push({ path: `${dir}/${f}`, size: stat.size });
      }
    }
    res.json({ files: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/file", auth, async (req, res) => {
  try {
    const full = safeResolve(req.query.path);
    const content = (await fs.pathExists(full)) ? await fs.readFile(full, "utf8") : "";
    res.json({ path: req.query.path, content });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/file", auth, async (req, res) => {
  try {
    const { path: relPath, content } = req.body;
    const full = safeResolve(relPath);
    if (relPath.endsWith(".js")) {
      try { new Function(content); } catch (se) { return res.status(400).json({ error: "সিনট্যাক্স এরর, সেভ হয়নি: " + se.message }); }
    }
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content, "utf8");
    pushLog("info", `✏️ ফাইল সেভ হলো: ${relPath}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/file", auth, async (req, res) => {
  try {
    const full = safeResolve(req.body?.path || req.query.path);
    await fs.remove(full);
    pushLog("info", `🗑️ ফাইল ডিলিট হলো: ${req.query.path || req.body.path}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ──────────────────────────── UptimeRobot হেলথ-চেক ────────────────────────────
// Render free tier নিষ্ক্রিয় থাকলে ঘুমিয়ে পড়ে — UptimeRobot প্রতি কয়েক
// মিনিটে এই URL-এ পিং করলে সার্ভার জেগে থাকবে
app.get("/ping", (req, res) => res.status(200).send("OK " + new Date().toISOString()));

// ──────────────────────────── প্যানেল UI ────────────────────────────
app.get("/", (req, res) => res.type("html").send(PANEL_HTML));

const PANEL_HTML = `<!DOCTYPE html>
<html lang="bn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Bot Panel</title>
<style>
:root{color-scheme:dark}
body{margin:0;font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;padding-bottom:40px}
header{padding:14px 16px;background:#161b22;border-bottom:1px solid #30363d;position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:18px;margin:0}
.badge{font-size:12px;padding:4px 10px;border-radius:20px;background:#30363d}
.badge.running{background:#1f6f3d}
.badge.stopped{background:#5a1e1e}
.badge.installing,.badge.starting{background:#6e5a12}
.tabs{display:flex;gap:8px;padding:10px 16px;background:#161b22;overflow-x:auto}
.tab{padding:8px 14px;border-radius:20px;background:#21262d;white-space:nowrap;font-size:14px}
.tab.active{background:#2f81f7;color:#fff}
.content{padding:14px 16px}
.card{background:#161b22;border-radius:10px;padding:14px;margin-bottom:12px}
.file-row{display:flex;justify-content:space-between;align-items:center;padding:12px;background:#161b22;border-radius:10px;margin-bottom:8px}
button{background:#2f81f7;color:#fff;border:none;padding:9px 14px;border-radius:8px;font-size:14px;margin:3px 3px 3px 0}
button.danger{background:#da3633}
button.secondary{background:#30363d}
button.success{background:#2ea043}
textarea{width:100%;height:55vh;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:10px;font-family:monospace;font-size:13px;box-sizing:border-box}
input[type=text],input[type=password],input[type=file]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;margin-bottom:10px}
.log-line{font-family:monospace;font-size:12px;padding:4px 0;border-bottom:1px solid #21262d;white-space:pre-wrap;word-break:break-all}
.log-error{color:#f85149}.log-warn{color:#e3b341}
.hidden{display:none}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.status-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.status-box{background:#161b22;padding:12px;border-radius:10px}
.status-box b{font-size:18px;display:block}
</style></head>
<body>
<div id="loginScreen" class="content">
  <h2>🔒 Bot Panel লগইন</h2>
  <input type="password" id="pwInput" placeholder="PANEL_PASSWORD দিন">
  <button onclick="doLogin()" style="width:100%">লগইন</button>
</div>

<div id="app" class="hidden">
  <header><h1>🤖 Bot Panel</h1><span id="stateBadge" class="badge">...</span></header>
  <div class="tabs">
    <div class="tab active" data-tab="deploy" onclick="switchTab('deploy')">🚀 ডিপ্লয়</div>
    <div class="tab" data-tab="files" onclick="switchTab('files')">📁 ফাইল</div>
    <div class="tab" data-tab="logs" onclick="switchTab('logs')">📜 লগ</div>
    <div class="tab" data-tab="status" onclick="switchTab('status')">📊 স্ট্যাটাস</div>
  </div>
  <div class="content">

    <div id="tab-deploy">
      <div class="card">
        <p>official-bot.zip আপলোড করুন (পুরনো bot/ ফোল্ডার মুছে নতুনটা বসবে):</p>
        <input type="file" id="zipInput" accept=".zip">
        <button onclick="uploadZip()" class="success">⬆️ আপলোড করুন</button>
        <p id="uploadMsg" style="font-size:13px;color:#9198a1"></p>
      </div>
      <div class="card">
        <div class="row">
          <button onclick="botAction('install-start')" class="success">📦 Install + Start</button>
          <button onclick="botAction('start')">▶️ Start</button>
          <button onclick="botAction('stop')" class="danger">⏹️ Stop</button>
          <button onclick="botAction('restart')" class="secondary">🔄 Restart</button>
        </div>
      </div>
    </div>

    <div id="tab-files" class="hidden">
      <div id="fileList"></div>
    </div>

    <div id="tab-logs" class="hidden">
      <button class="secondary" onclick="loadLogs()">🔄 রিফ্রেশ</button>
      <div id="logView" style="margin-top:10px"></div>
    </div>

    <div id="tab-status" class="hidden">
      <div class="status-grid" id="statusGrid"></div>
      <p style="font-size:12px;color:#9198a1;margin-top:12px">UptimeRobot মনিটর URL হিসেবে এই ঠিকানা ব্যবহার করুন: <code>/ping</code></p>
    </div>

    <div id="editorView" class="hidden">
      <div class="row">
        <button class="secondary" onclick="closeEditor()">← ফিরে যান</button>
        <button onclick="saveFile()">💾 সেভ করুন</button>
        <button class="danger" onclick="deleteFile()">🗑️ ডিলিট</button>
      </div>
      <p id="editorPath" style="font-family:monospace;font-size:13px;margin:10px 0 6px"></p>
      <textarea id="editorContent"></textarea>
    </div>

  </div>
</div>

<script>
let TOKEN = localStorage.getItem("panelToken") || "";
let currentFile = null;
let statusTimer = null;

function api(p, opts = {}) {
  opts.headers = Object.assign({ "x-panel-token": TOKEN }, opts.headers || {});
  return fetch(p, opts).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "এরর"); return d; });
}

function doLogin() { TOKEN = document.getElementById("pwInput").value.trim(); localStorage.setItem("panelToken", TOKEN); boot(); }

async function boot() {
  if (!TOKEN) return;
  try {
    await api("/api/status");
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    refreshBadge();
    statusTimer = setInterval(refreshBadge, 8000);
  } catch (e) {
    document.getElementById("loginScreen").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
  }
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  ["deploy","files","logs","status"].forEach(t => document.getElementById("tab-" + t).classList.toggle("hidden", t !== name));
  closeEditor();
  if (name === "files") loadFiles();
  if (name === "logs") loadLogs();
  if (name === "status") loadStatus();
}

async function refreshBadge() {
  try {
    const s = await api("/api/status");
    const b = document.getElementById("stateBadge");
    b.textContent = s.botState;
    b.className = "badge " + s.botState;
  } catch (e) {}
}

async function uploadZip() {
  const f = document.getElementById("zipInput").files[0];
  if (!f) return alert("আগে একটা zip ফাইল বাছুন");
  const fd = new FormData(); fd.append("zip", f);
  document.getElementById("uploadMsg").textContent = "⏳ আপলোড হচ্ছে...";
  try {
    const r = await fetch("/api/upload?token=" + encodeURIComponent(TOKEN), { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    document.getElementById("uploadMsg").textContent = "✅ " + d.msg;
  } catch (e) { document.getElementById("uploadMsg").textContent = "❌ " + e.message; }
}

async function botAction(action) {
  await api("/api/bot/" + action, { method: "POST" });
  setTimeout(refreshBadge, 1500);
}

async function loadFiles() {
  const { files } = await api("/api/files");
  document.getElementById("fileList").innerHTML = files.map(f =>
    \`<div class="file-row"><span>\${f.path}</span><button class="secondary" onclick="openFile('\${f.path}')">এডিট</button></div>\`
  ).join("") || "<p>এখনো কোনো ফাইল আপলোড হয়নি</p>";
}

async function openFile(p) {
  const { content } = await api("/api/file?path=" + encodeURIComponent(p));
  currentFile = p;
  document.getElementById("editorPath").textContent = p;
  document.getElementById("editorContent").value = content;
  document.getElementById("editorView").classList.remove("hidden");
  document.getElementById("tab-files").classList.add("hidden");
}

function closeEditor() {
  document.getElementById("editorView").classList.add("hidden");
  const filesTab = document.querySelector('.tab[data-tab="files"]');
  if (filesTab && filesTab.classList.contains("active")) document.getElementById("tab-files").classList.remove("hidden");
  currentFile = null;
}

async function saveFile() {
  try {
    await api("/api/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: currentFile, content: document.getElementById("editorContent").value }) });
    alert("✅ সেভ হয়েছে — বট চালু থাকলে Restart চাপুন কার্যকর করতে");
  } catch (e) { alert("❌ " + e.message); }
}

async function deleteFile() {
  if (!confirm("নিশ্চিত? " + currentFile + " ডিলিট হয়ে যাবে")) return;
  await api("/api/file?path=" + encodeURIComponent(currentFile), { method: "DELETE" });
  closeEditor(); loadFiles();
}

async function loadLogs() {
  const { lines } = await api("/api/logs");
  document.getElementById("logView").innerHTML = lines.slice().reverse().map(l =>
    \`<div class="log-line \${l.level === 'error' ? 'log-error' : l.level === 'warn' ? 'log-warn' : ''}">[\${new Date(l.t).toLocaleTimeString('bn-BD')}] \${l.text}</div>\`
  ).join("") || "<p>কোনো লগ নেই</p>";
}

async function loadStatus() {
  const s = await api("/api/status");
  document.getElementById("statusGrid").innerHTML = \`
    <div class="status-box"><b>\${s.botState}</b>বট স্ট্যাটাস</div>
    <div class="status-box"><b>\${Math.floor(s.panelUptimeSec/60)} মিনিট</b>প্যানেল আপটাইম</div>
    <div class="status-box"><b>\${s.memoryMB} MB</b>মেমরি</div>
    <div class="status-box"><b>\${s.hasProject ? "✅" : "❌"}</b>প্রজেক্ট আপলোড আছে</div>\`;
}

boot();
</script>
</body></html>`;

process.on("unhandledRejection", (r) => pushLog("error", "unhandledRejection: " + r));
process.on("uncaughtException", (e) => pushLog("error", "uncaughtException: " + e.message));

app.listen(PORT, () => console.log(`🎛️ Panel চালু — পোর্ট ${PORT}`));
