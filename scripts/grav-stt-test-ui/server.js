#!/usr/bin/env node
"use strict";

/*
 * Local-only temporary UI for the separate open-source STT prototype.
 * It intentionally uses a private SSH hop rather than adding a CMS endpoint.
 */
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.GRAV_STT_TEST_PORT || 3037);
const POD = process.env.GRAV_STT_POD || "root@213.173.98.203";
const SSH_PORT = process.env.GRAV_STT_SSH_PORT || "27784";
const SSH_KEY = process.env.GRAV_STT_SSH_KEY || path.join(os.homedir(), ".ssh", "id_ed25519");
const POD_ROOT = "/workspace/grav-stt-benchmark/ui-runs";
const POD_WARM_CLIENT = "/workspace/grav-stt-benchmark/flex_client.py";
const POD_WARM_HOST = "127.0.0.1";
const POD_WARM_PORT = 19038;
const LOCAL_ROOT = path.join(os.tmpdir(), "grav-stt-test-ui");
const MAX_BYTES = 150 * 1024 * 1024;
const EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".webm", ".mp4", ".ogg", ".flac"]);

const app = express();
let activeJob = false;

const upload = multer({
  dest: LOCAL_ROOT,
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter(_req, file, callback) {
    const extension = path.extname(file.originalname || "").toLowerCase();
    callback(extension && EXTENSIONS.has(extension) ? null : new Error("Use WAV, MP3, M4A, WebM, MP4, OGG, or FLAC."), Boolean(extension && EXTENSIONS.has(extension)));
  },
});

function ssh(command, options = {}) {
  return execFileAsync("ssh", [
    "-o", "ConnectTimeout=20", "-i", SSH_KEY, "-p", SSH_PORT, POD, command,
  ], { timeout: options.timeout || 15 * 60_000, maxBuffer: 2 * 1024 * 1024 });
}

function scp(local, remote) {
  return execFileAsync("scp", ["-i", SSH_KEY, "-P", SSH_PORT, local, `${POD}:${remote}`], {
    timeout: 5 * 60_000,
    maxBuffer: 256 * 1024,
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

app.get("/", (_req, res) => res.type("html").send(PAGE));
app.get("/health", (_req, res) => res.json({ ready: true, busy: activeJob }));

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (activeJob) return res.status(409).json({ error: "A transcription is already running. Try again when it finishes." });
  if (!req.file) return res.status(400).json({ error: "Choose one audio file first." });
  activeJob = true;
  const extension = path.extname(req.file.originalname).toLowerCase();
  const id = crypto.randomUUID();
  const remoteDir = `${POD_ROOT}/${id}`;
  const remoteInput = `${remoteDir}/input${extension}`;
  const remoteOutput = `${remoteDir}/result.json`;
  try {
    await ssh(`mkdir -p ${shellQuote(remoteDir)}`);
    await scp(req.file.path, remoteInput);
    const { stdout } = await ssh(
      `/root/comi-venv/bin/python ${shellQuote(POD_WARM_CLIENT)} --host ${shellQuote(POD_WARM_HOST)} --port ${POD_WARM_PORT} --input ${shellQuote(remoteInput)} --output ${shellQuote(remoteOutput)}`
    );
    const workerResponse = JSON.parse(stdout);
    if (!workerResponse.success) throw new Error(workerResponse.error || "The warm model worker did not complete.");
    const result = workerResponse.result;
    res.json({ success: true, result });
  } catch (error) {
    console.error("[grav-stt-test-ui]", error.stderr || error.message);
    res.status(502).json({ error: "The private model runner did not complete.", detail: String(error.stderr || error.message).slice(-1200) });
  } finally {
    activeJob = false;
    await fs.unlink(req.file.path).catch(() => {});
    // This is a diagnostic upload, not a recording store.  The browser already
    // received its JSON result, so remove this exact UUID-scoped remote folder
    // rather than retaining an accidental archive on the test pod.
    await ssh(`rm -rf ${shellQuote(remoteDir)}`, { timeout: 60_000 }).catch(() => {});
  }
});

app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || "Upload failed." }));

fs.mkdir(LOCAL_ROOT, { recursive: true }).then(() => {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`GRAV STT tester is available only on http://127.0.0.1:${PORT}`);
  });
});

const PAGE = String.raw`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GRAV Voice — transcription tester</title>
<style>
  :root{color-scheme:dark;--bg:#101218;--card:#191c25;--line:#303544;--ink:#f7f8fb;--muted:#a9b0c0;--accent:#82e6bc;--warn:#ffd27a}*{box-sizing:border-box}body{margin:0;background:linear-gradient(125deg,#0c0f15,#171a25);font:15px/1.5 system-ui,sans-serif;color:var(--ink)}main{max-width:1080px;margin:48px auto;padding:0 22px}h1{font-size:32px;margin:0 0 6px}.sub{color:var(--muted);margin:0 0 28px}.card{background:#191c25e8;border:1px solid var(--line);border-radius:18px;padding:24px;margin:16px 0;box-shadow:0 18px 50px #0004}.drop{display:block;border:1.5px dashed #5d687e;border-radius:14px;padding:32px;text-align:center;cursor:pointer}.drop:hover{border-color:var(--accent)}input{display:none}button{margin-top:16px;border:0;border-radius:10px;padding:12px 18px;background:var(--accent);color:#092117;font-weight:700;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.status{min-height:24px;color:var(--muted);margin-top:14px}.notice{font-size:13px;color:var(--warn)}.hidden{display:none}.transcript{font-size:18px;white-space:pre-wrap}.meta{color:var(--muted);font-size:13px}.tag{display:inline-block;border-radius:999px;padding:3px 9px;background:#293044;margin:4px 6px 4px 0;font-size:12px}ul{margin:10px 0 0;padding-left:20px}pre{overflow:auto;max-height:350px;background:#0e1016;border:1px solid var(--line);padding:14px;border-radius:10px;font-size:12px}</style>
<main><h1>GRAV Voice tester</h1><p class="sub">Private, temporary, single-model transcription. Nothing is sent to Qwen or the CMS database.</p>
<section class="card"><div class="meta">ACTIVE ARCHITECTURE</div><p><strong>Indic-Transcribe Flex</strong> decides the transcription prompt and produces Romanized code-mixed text itself.</p><ul><li>No language router or separate Hindi/Odia/English lanes</li><li>No external Romanizer, Qwen, LLM cleanup, or candidate chooser</li><li>For long recordings only, safe audio chunks are joined in time order</li></ul></section>
<section class="card"><label class="drop" for="audio"><strong id="fileName">Choose an audio file</strong><br><span class="meta">WAV, MP3, M4A, WebM, MP4, OGG, FLAC · max 150 MB</span></label><input id="audio" type="file" accept="audio/*,video/webm,video/mp4"><button id="go">Transcribe</button><div id="status" class="status"></div><p class="notice">The single model stays warm on the private 16 GB GPU. Output below is its raw Romanized text.</p></section>
<section id="result" class="hidden"><section class="card"><div class="meta">RAW ROMANIZED TRANSCRIPT</div><div id="transcript" class="transcript"></div></section><section class="card"><div class="meta">MODEL DETAILS</div><div id="details"></div></section><section class="card"><div class="meta">RAW MACHINE RESULT</div><pre id="raw"></pre></section></section></main>
<script>const audio=document.querySelector('#audio'),go=document.querySelector('#go'),status=document.querySelector('#status'),result=document.querySelector('#result');audio.onchange=()=>document.querySelector('#fileName').textContent=audio.files[0]?.name||'Choose an audio file';go.onclick=async()=>{if(!audio.files[0])return status.textContent='Choose an audio file first.';go.disabled=true;result.classList.add('hidden');status.textContent='Uploading to the private test runner…';const data=new FormData();data.append('audio',audio.files[0]);try{status.textContent='Transcribing with the preloaded single model…';const r=await fetch('/api/transcribe',{method:'POST',body:data});const body=await r.json();if(!r.ok)throw Error(body.detail||body.error);const x=body.result;document.querySelector('#transcript').textContent=x.romanTranscript||'(No speech detected)';const d=x.modelLanguageDecision||{};document.querySelector('#details').innerHTML='<span class="tag">'+esc(x.model||'')+'</span><span class="tag">Romanized</span><span class="tag">'+esc(d.lang||'auto')+' prompt chosen by model</span><div class="meta">'+esc(String(x.durationSeconds||0))+' s audio · '+esc(String(x.processingSeconds||0))+' s processing'+(x.longForm?' · safe long-form chunks':'')+'</div>';document.querySelector('#raw').textContent=JSON.stringify(x,null,2);result.classList.remove('hidden');status.textContent='Finished. This is raw model output.'}catch(e){status.textContent='Error: '+e.message}finally{go.disabled=false}};function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</script></html>`;
