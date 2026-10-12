cd /var/www/minha-api
cat << 'EOF' > server.js
const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ============================================================
// ====================== CONFIGURAÇÕES =======================
// ============================================================
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1550274953092268122/FSFIL0HInyozWv2wdWIMwh0e54taYrVFjjLm9QcCaMZyE-TtUOrk2hPXaHkopgZLgP2j";
const APK_URL = "https://www.mediafire.com/file/ogry5nqdr2c1vpd/SHOPICA.apk/file";
const FIREBASE_DB_URL = "https://loja-do-dag-default-rtdb.firebaseio.com";

// ============================================================
// ====================== ESTADO GLOBAL =======================
// ============================================================
const sessionKeys   = new Map();
const sessionTokens = new Map();
const keyCache      = new Map();
const CACHE_TTL     = 1000;

const accessLogs = [];
const MAX_LOGS = 50;

// ============================================================
// ====================== UTILITÁRIOS =========================
// ============================================================
function logAccess(ip, details) {
  const time = new Date().toLocaleString('pt-BR', { timeZone: 'America/Manaus' });
  accessLogs.unshift({ ip, time, details });
  if (accessLogs.length > MAX_LOGS) accessLogs.pop();
}

function getClientIp(req) {
  let ip = req.headers['cf-connecting-ip'] ||
           req.headers['x-forwarded-for'] ||
           req.headers['x-real-ip'] ||
           req.socket.remoteAddress || '';
  if (typeof ip === 'string' && ip.includes(',')) ip = ip.split(',')[0].trim();
  if (typeof ip === 'string' && ip.includes('::ffff:')) ip = ip.replace('::ffff:', '');
  return (ip || '').trim();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}
function createSessionToken(key, ip) {
  const token = crypto.randomBytes(24).toString('hex');
  sessionTokens.set(token, { key, ip, createdAt: Date.now() });
  return token;
}
function getSession(req) {
  const cookies = parseCookies(req);
  if (cookies.session && sessionTokens.has(cookies.session)) {
    return { ...sessionTokens.get(cookies.session), token: cookies.session };
  }
  const ip = getClientIp(req);
  if (sessionKeys.has(ip)) return { key: sessionKeys.get(ip), ip, token: null };
  return null;
}
function destroySession(req) {
  const cookies = parseCookies(req);
  if (cookies.session) sessionTokens.delete(cookies.session);
  const ip = getClientIp(req);
  sessionKeys.delete(ip);
}

// ============================================================
// ====================== FIREBASE ============================
// ============================================================
function fbRequest(method, path, bodyData) {
  return new Promise((resolve) => {
    let urlData;
    try { urlData = new URL(`${FIREBASE_DB_URL}${path}.json`); }
    catch (e) { return resolve({ ok: false, error: 'url_invalida' }); }

    const dataString = bodyData !== undefined ? JSON.stringify(bodyData) : null;
    const headers = {};
    if (dataString !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(dataString);
    }
    const options = { hostname: urlData.hostname, path: urlData.pathname + urlData.search, method, headers, timeout: 10000 };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = data; }
        resolve({ ok, statusCode: res.statusCode, data: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (dataString !== null) req.write(dataString);
    req.end();
  });
}
async function firebaseGet(path) {
  const r = await fbRequest('GET', path);
  if (!r.ok) return null;
  if (r.data === null || r.data === 'null') return null;
  return r.data;
}
async function firebasePut(path, bodyData)   { return await fbRequest('PUT', path, bodyData); }
async function firebasePatch(path, bodyData) { return await fbRequest('PATCH', path, bodyData); }
async function firebaseDelete(path)          { return await fbRequest('DELETE', path); }

// ============================================================
// ====================== HELPERS DE KEY ======================
// ============================================================
function hwidResetPayload() {
  return { usedByIp: null, deviceId: null, deviceFingerprint: null, deviceBindingVersion: null, lastSeenAt: null };
}
function normalizeStatus(s) { return String(s || '').toLowerCase().trim(); }
function toNumber(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }

function computeRealStatus(kData) {
  if (!kData) return { status: 'not_found', isExpired: false };
  const st = normalizeStatus(kData.status);
  const expiresAt = toNumber(kData.expiresAt, 0);
  const now = Date.now();

  if (st === 'paused') return { status: 'paused', isExpired: false };
  if (st === 'criada') return { status: 'criada', isExpired: false };
  if (st === 'expired' && expiresAt <= 0) return { status: 'criada', isExpired: false, selfHeal: true, healTo: 'criada' };
  if (st === 'expired' && expiresAt > 0 && now <= expiresAt) return { status: 'active', isExpired: false, selfHeal: true, healTo: 'active' };
  if (st === 'expired') return { status: 'expired', isExpired: true };
  if (expiresAt > 0 && now > expiresAt) return { status: 'expired', isExpired: true };
  if (st === 'active') return { status: 'active', isExpired: false };
  return { status: st || 'not_found', isExpired: false };
}
function applySelfHeal(kStr, real) {
  if (real.selfHeal && real.healTo) {
    firebasePatch(`/proxyAndroid/keys/${kStr}`, { status: real.healTo }).catch(() => {});
    real.selfHeal = false;
  }
}
function hasHwidBind(kData) {
  if (!kData) return false;
  return !!(kData.usedByIp || kData.deviceId || kData.deviceFingerprint);
}

// ============================================================
// ====================== GEO / DISCORD =======================
// ============================================================
function getGeoInfo(ip) {
  return new Promise((resolve) => {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168') || ip.startsWith('10.')) return resolve(null);
    const url = `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting,query`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}
function sendDiscordWebhook(payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const urlData = new URL(DISCORD_WEBHOOK_URL);
    const options = { hostname: urlData.hostname, path: urlData.pathname + urlData.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options, (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.write(data); req.end();
  });
}
async function notifyDiscordLogin(req, key, clientIp, gpsData) {
  try {
    const geo = await getGeoInfo(clientIp);
    const ua = req.headers['user-agent'] || 'Desconhecido';
    const dataHora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Manaus' });
    let mapsLinkIp = 'Não disponível', localStr = 'Não disponível', coordsStr = 'Não disponível';
    let ispStr = 'Não disponível', proxyStr = 'Não disponível', mobileStr = 'Não disponível', timezoneStr = 'Não disponível';
    if (geo && geo.status === 'success') {
      mapsLinkIp = `https://www.google.com/maps?q=${geo.lat},${geo.lon}`;
      localStr = `${geo.city || '-'} / ${geo.regionName || '-'} / ${geo.country || '-'} (${geo.countryCode || '-'})`;
      coordsStr = `${geo.lat}, ${geo.lon}`;
      ispStr = geo.isp || geo.org || '-';
      proxyStr = geo.proxy ? 'Sim ⚠️' : 'Não';
      mobileStr = geo.mobile ? 'Sim' : 'Não';
      timezoneStr = geo.timezone || '-';
    }
    const fields = [
      { name: "🔑 Key Utilizada", value: `\`${key}\``, inline: false },
      { name: "🌐 IP", value: `\`${clientIp}\``, inline: true },
      { name: "🕒 Data/Hora", value: `\`${dataHora}\``, inline: true }
    ];
    if (gpsData && gpsData.lat && gpsData.lon) {
      const gpsMapsLink = `https://www.google.com/maps?q=${gpsData.lat},${gpsData.lon}`;
      const precisao = gpsData.accuracy ? `${Math.round(gpsData.accuracy)}m` : 'N/A';
      fields.push({ name: "🎯 LOCALIZAÇÃO EXATA (GPS)", value: `[📍 Abrir no Google Maps](${gpsMapsLink})\n**Coordenadas:** \`${gpsData.lat}, ${gpsData.lon}\`\n**Precisão:** ${precisao}`, inline: false });
    } else {
      fields.push({ name: "🎯 LOCALIZAÇÃO EXATA (GPS)", value: "❌ Usuário negou ou não suportado", inline: false });
    }
    fields.push(
      { name: "📍 Localização por IP", value: localStr, inline: false },
      { name: "🗺️ Coordenadas IP", value: `\`${coordsStr}\``, inline: true },
      { name: "🌍 Google Maps (IP)", value: mapsLinkIp !== 'Não disponível' ? `[Abrir](${mapsLinkIp})` : 'Não disponível', inline: true },
      { name: "📡 ISP / Provedor", value: ispStr, inline: false },
      { name: "🕐 Fuso Horário", value: `\`${timezoneStr}\``, inline: true },
      { name: "📱 Rede Móvel", value: mobileStr, inline: true },
      { name: "🛡️ Proxy/VPN", value: proxyStr, inline: true },
      { name: "💻 User-Agent", value: `\`\`\`${ua.substring(0, 300)}\`\`\``, inline: false }
    );
    const embed = {
      username: "SECURE PANEL • LOGS",
      avatar_url: "https://cdn-icons-png.flaticon.com/512/565/565547.png",
      embeds: [{ title: "🔓 NOVO LOGIN AUTORIZADO", color: gpsData && gpsData.lat ? 0x22c55e : 0xfacc15, fields, footer: { text: "SECURE PANEL v4.1 • Sistema de Logs" }, timestamp: new Date().toISOString() }]
    };
    await sendDiscordWebhook(embed);
  } catch (e) { console.log('Erro webhook:', e.message); }
}

// ============================================================
// ====================== CACHE DE LISTA ======================
// ============================================================
let _keysListCache = { data: null, timestamp: 0 };
const KEYS_LIST_CACHE_TTL = 2000;
async function getKeysListCached() {
  const now = Date.now();
  if (_keysListCache.data && (now - _keysListCache.timestamp < KEYS_LIST_CACHE_TTL)) return _keysListCache.data;
  const data = await firebaseGet('/proxyAndroid/keys') || {};
  _keysListCache.data = data;
  _keysListCache.timestamp = now;
  return data;
}
function invalidateKeysCache() { _keysListCache.data = null; _keysListCache.timestamp = 0; }
function invalidateKeyCache(key) { if (key) keyCache.delete(key.trim().toUpperCase()); }

// ============================================================
// =============== CHECK KEY STATUS ===========================
// ============================================================
async function checkKeyStatus(keyInput, clientIp, opts) {
  opts = opts || {};
  const skipDevice = !!opts.skipDeviceCheck;

  if (!keyInput) return { status: 'not_found', type: 'none' };
  const cleanKey = String(keyInput).trim().toUpperCase();
  const now = Date.now();

  const cached = keyCache.get(cleanKey);
  if (cached && (now - cached.timestamp < CACHE_TTL)) {
    if (!skipDevice && cached.usedByIp && cached.usedByIp !== clientIp) return { status: 'ip_locked', type: 'cache' };
    return { status: cached.status, type: 'cache' };
  }

  let keyData = await firebaseGet(`/proxyAndroid/keys/${cleanKey}`);
  if (!keyData || typeof keyData !== 'object') {
    keyCache.set(cleanKey, { status: 'not_found', timestamp: now });
    return { status: 'not_found', type: 'firebase' };
  }

  let st = normalizeStatus(keyData.status);
  const durationMs = toNumber(keyData.durationMs, 0);
  let expiresAt = toNumber(keyData.expiresAt, 0);

  if (st === 'expired' && expiresAt <= 0) {
    await firebasePatch(`/proxyAndroid/keys/${cleanKey}`, { status: 'criada', expiresAt: null, activatedAt: null, usedByIp: null });
    keyData = await firebaseGet(`/proxyAndroid/keys/${cleanKey}`) || keyData;
    st = 'criada'; expiresAt = 0;
    invalidateKeysCache();
  }
  if (st === 'expired' && expiresAt > 0 && now <= expiresAt) {
    await firebasePatch(`/proxyAndroid/keys/${cleanKey}`, { status: 'active' });
    st = 'active';
    invalidateKeysCache();
  }
  if (st === 'paused') {
    keyCache.set(cleanKey, { status: 'paused', timestamp: now });
    return { status: 'paused', type: 'firebase' };
  }
  if (expiresAt > 0 && now > expiresAt) {
    keyCache.set(cleanKey, { status: 'expired', timestamp: now });
    return { status: 'expired', type: 'firebase' };
  }
  if (!skipDevice && keyData.usedByIp && keyData.usedByIp !== clientIp) {
    keyCache.set(cleanKey, { status: 'ip_locked', timestamp: now, usedByIp: keyData.usedByIp });
    return { status: 'ip_locked', type: 'firebase' };
  }
  if (st === 'active' || st === 'criada') {
    const updatePayload = {};
    if (st === 'criada') {
      updatePayload.status = 'active';
      updatePayload.activatedAt = now;
      if (durationMs > 0) updatePayload.expiresAt = now + durationMs;
    } else if (st === 'active' && expiresAt <= 0 && durationMs > 0) {
      updatePayload.expiresAt = now + durationMs;
      if (!keyData.activatedAt) updatePayload.activatedAt = now;
    }
    if (!keyData.usedByIp) updatePayload.usedByIp = clientIp;
    if (Object.keys(updatePayload).length > 0) {
      const r = await firebasePatch(`/proxyAndroid/keys/${cleanKey}`, updatePayload);
      if (!r.ok) await firebasePatch(`/proxyAndroid/keys/${cleanKey}`, updatePayload);
      invalidateKeysCache();
    }
    keyCache.set(cleanKey, { status: 'active', timestamp: now, usedByIp: keyData.usedByIp || clientIp });
    return { status: 'active', type: 'firebase' };
  }
  keyCache.set(cleanKey, { status: 'not_found', timestamp: now });
  return { status: 'not_found', type: 'firebase' };
}

// ============================================================
// ====================== CSS BASE ============================
// ============================================================
const BASE_CSS = `
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
-webkit-font-smoothing:antialiased;background:#050505;color:#f4f4f5;
min-height:100vh;font-size:12.5px;line-height:1.4;}
button,input,select,textarea{font:inherit;color:inherit;}
button{cursor:pointer;border:none;background:none;position:relative;overflow:hidden;}
a{color:inherit;text-decoration:none;}
code{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.92em;}
::selection{background:rgba(220,38,38,.35);color:#fff;}
::-webkit-scrollbar{width:6px;height:6px;}
::-webkit-scrollbar-track{background:#0a0a0a;}
::-webkit-scrollbar-thumb{background:#25252b;border-radius:6px;}
::-webkit-scrollbar-thumb:hover{background:#3a3a42;}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
@keyframes fadeInScale{from{opacity:0;transform:scale(.96);}to{opacity:1;transform:scale(1);}}
@keyframes slideDown{from{opacity:0;transform:translateY(-8px);}to{opacity:1;transform:translateY(0);}}
@keyframes slideUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.55;transform:scale(.88);}}
@keyframes pulseRing{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55);}70%{box-shadow:0 0 0 8px rgba(34,197,94,0);}100%{box-shadow:0 0 0 0 rgba(34,197,94,0);}}
@keyframes pop{0%{transform:scale(0);}80%{transform:scale(1.2);}100%{transform:scale(1);}}
@keyframes spin{to{transform:rotate(360deg);}}
@keyframes fillBar{to{width:100%;}}
@keyframes shimmer{0%{background-position:-200% 0;}100%{background-position:200% 0;}}
@keyframes glow{0%,100%{box-shadow:0 0 0 rgba(220,38,38,0);}50%{box-shadow:0 0 18px rgba(220,38,38,.35);}}
@keyframes bounceIn{0%{opacity:0;transform:translateY(-10px) scale(.95);}60%{opacity:1;transform:translateY(2px) scale(1.01);}100%{opacity:1;transform:translateY(0) scale(1);}}
@keyframes ripple{to{transform:scale(4);opacity:0;}}
@keyframes infPulse{0%,100%{box-shadow:0 0 0 0 rgba(250,204,21,.55);}50%{box-shadow:0 0 0 8px rgba(250,204,21,0);}}
@keyframes auroraShift{0%{transform:translate(0,0) scale(1);}50%{transform:translate(3%,-3%) scale(1.08);}100%{transform:translate(0,0) scale(1);}}
@keyframes borderFlow{0%{background-position:0% 50%;}50%{background-position:100% 50%;}100%{background-position:0% 50%;}}
@keyframes floatY{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}
@keyframes glowPulse{0%,100%{box-shadow:0 0 0 rgba(220,38,38,.3),0 20px 60px -25px rgba(220,38,38,.5);}50%{box-shadow:0 0 25px rgba(220,38,38,.35),0 20px 60px -25px rgba(220,38,38,.85);}}
.btn::after,.mini::after,.btn-green::after,.btn-ghost::after{content:'';position:absolute;top:50%;left:50%;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.4);transform:translate(-50%,-50%) scale(0);opacity:0;pointer-events:none;}
.btn:active::after,.mini:active::after,.btn-green:active::after,.btn-ghost:active::after{animation:ripple .55s ease-out;}
`;

// ============================================================
// ============ CSS LOGIN — PREMIUM V4 ========================
// ============================================================
const LOGIN_PAGE_CSS = BASE_CSS + `
html,body{height:100%;background:#050505;}
body{
  display:flex;align-items:center;justify-content:center;
  padding:20px;min-height:100vh;color:#fff;position:relative;
  overflow-x:hidden;
}
.bg-aurora{
  position:fixed;inset:-10%;z-index:0;pointer-events:none;opacity:.85;
  background:
    radial-gradient(circle at 15% 20%, rgba(220,38,38,.28) 0%, transparent 40%),
    radial-gradient(circle at 85% 80%, rgba(153,27,27,.22) 0%, transparent 40%),
    radial-gradient(circle at 50% 50%, rgba(120,0,0,.15) 0%, transparent 55%);
  animation:auroraShift 14s ease-in-out infinite;
}
.bg-grid{
  position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.25;
  background-image:
    linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
  background-size:56px 56px;
  mask-image:radial-gradient(ellipse 65% 65% at 50% 50%, #000 15%, transparent 90%);
  -webkit-mask-image:radial-gradient(ellipse 65% 65% at 50% 50%, #000 15%, transparent 90%);
}
.bg-noise{
  position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.04;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

.wrap{width:100%;max-width:430px;position:relative;z-index:2;animation:fadeInScale .65s cubic-bezier(.4,0,.2,1);}

.card{
  position:relative;background:linear-gradient(170deg,#0f0f14 0%,#0a0a0f 100%);
  border:1px solid rgba(255,255,255,.07);
  border-radius:24px;padding:38px 30px 28px;
  box-shadow:
    0 1px 0 rgba(255,255,255,.06) inset,
    0 40px 100px -40px rgba(0,0,0,1),
    0 0 90px -30px rgba(220,38,38,.5);
  overflow:hidden;
  animation:glowPulse 5s ease-in-out infinite;
}
.card::before{
  content:'';position:absolute;top:0;left:15%;right:15%;height:1.5px;
  background:linear-gradient(90deg,transparent,#ef4444 20%,#f87171 50%,#ef4444 80%,transparent);
  background-size:200% 100%;
  animation:borderFlow 4s linear infinite;
}
.card::after{
  content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);
  width:70%;height:120px;
  background:radial-gradient(ellipse at center top, rgba(220,38,38,.14) 0%, transparent 70%);
  pointer-events:none;
}
@media (prefers-reduced-motion: reduce){
  .card,.card::before,.bg-aurora{animation:none !important;}
}

.logo{
  display:flex;flex-direction:column;align-items:center;gap:14px;
  margin-bottom:10px;position:relative;z-index:1;
  animation:slideDown .6s ease .05s backwards;
}
.logo-icon{
  width:76px;height:76px;border-radius:22px;position:relative;
  background:linear-gradient(160deg,#1a1a20 0%,#0a0a0e 100%);
  border:1px solid rgba(239,68,68,.4);
  display:flex;align-items:center;justify-content:center;
  box-shadow:
    0 1px 0 rgba(255,255,255,.08) inset,
    0 0 0 1px rgba(239,68,68,.08),
    0 20px 45px -20px rgba(220,38,38,.75),
    0 0 55px -10px rgba(220,38,38,.6);
  animation:floatY 4s ease-in-out infinite;
}
.logo-icon::before{
  content:'';position:absolute;inset:-3px;border-radius:25px;
  background:linear-gradient(160deg, rgba(239,68,68,.35), transparent 45%, rgba(239,68,68,.15));
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor; mask-composite:exclude; padding:3px;
  animation:borderFlow 6s linear infinite;
  pointer-events:none;
}
.logo-icon svg{width:36px;height:36px;filter:drop-shadow(0 0 14px rgba(239,68,68,1));}

.brand{
  font-size:26px;font-weight:900;letter-spacing:-.7px;line-height:1;
  background:linear-gradient(180deg,#fff 0%,#c4c4cc 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
}
.brand b{
  background:linear-gradient(180deg,#f87171 0%,#b91c1c 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  font-weight:900;
  filter:drop-shadow(0 0 10px rgba(239,68,68,.5));
}
.tagline{
  text-align:center;color:#5a5a63;font-size:9.5px;letter-spacing:6px;
  margin-top:2px;font-weight:800;text-transform:uppercase;
  animation:slideDown .6s ease .1s backwards;
}
.divider{
  height:1px;margin:22px 0;position:relative;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.09) 25%,rgba(255,255,255,.09) 75%,transparent);
}
.divider::before{
  content:'';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) rotate(45deg);
  width:6px;height:6px;background:#ef4444;border-radius:1px;
  box-shadow:0 0 12px rgba(239,68,68,.9),0 0 3px rgba(239,68,68,1);
}
.heading{
  text-align:center;font-size:19px;font-weight:800;letter-spacing:-.3px;color:#fff;
  animation:slideDown .6s ease .15s backwards;
}
.subheading{
  text-align:center;color:#6b6b75;font-size:12px;margin-top:5px;
  animation:slideDown .6s ease .2s backwards;
  letter-spacing:.2px;
}
.status{
  margin-top:18px;display:flex;justify-content:space-between;align-items:center;
  padding:12px 15px;border-radius:13px;
  background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.008));
  border:1px solid rgba(255,255,255,.06);
  font-size:10.5px;font-weight:700;color:#8a8a95;
  animation:slideUp .6s ease .25s backwards;
  backdrop-filter:blur(4px);
}
.status-left{display:flex;align-items:center;gap:9px;}
.dot{
  width:7px;height:7px;border-radius:50%;background:#22c55e;
  box-shadow:0 0 12px rgba(34,197,94,1),0 0 4px rgba(34,197,94,1);
  animation:pulseRing 1.8s infinite;
}
.status .badge-v{
  font-family:'SF Mono',Menlo,monospace;font-size:9.5px;
  padding:3px 10px;border-radius:7px;
  background:linear-gradient(180deg,rgba(239,68,68,.15),rgba(239,68,68,.05));
  color:#f87171;
  border:1px solid rgba(239,68,68,.32);font-weight:800;
}
.label{
  display:block;margin:20px 0 9px;font-size:10px;letter-spacing:2.5px;
  font-weight:800;color:#7a7a85;text-transform:uppercase;
  animation:slideUp .6s ease .3s backwards;
}
.input-wrap{position:relative;animation:slideUp .6s ease .35s backwards;}
.input-icon{
  position:absolute;left:15px;top:50%;transform:translateY(-50%);
  width:17px;height:17px;pointer-events:none;
  stroke:#5a5a63;transition:stroke .25s,filter .25s;
}
.input{
  width:100%;height:56px;padding:0 18px 0 46px;border-radius:14px;outline:none;
  background:linear-gradient(180deg,#08080c 0%,#0a0a0f 100%);
  border:1.5px solid rgba(255,255,255,.07);
  color:#fff;font-size:14px;font-weight:700;letter-spacing:2.5px;
  font-family:'SF Mono',Menlo,monospace;
  transition:border-color .25s,box-shadow .3s,background .25s,transform .2s;
}
.input::placeholder{letter-spacing:1.2px;font-weight:500;color:#3f3f47;font-size:12px;font-family:inherit;}
.input:focus{
  border-color:#ef4444;
  background:linear-gradient(180deg,#140a0c 0%,#0d070a 100%);
  box-shadow:0 0 0 4px rgba(239,68,68,.13),0 0 35px -6px rgba(239,68,68,.7);
  transform:translateY(-1px);
}
.input-wrap:focus-within .input-icon{stroke:#ef4444;filter:drop-shadow(0 0 6px rgba(239,68,68,.9));}

.btn{
  width:100%;height:56px;margin-top:18px;border-radius:14px;
  background:linear-gradient(180deg,#ef4444 0%,#dc2626 50%,#991b1b 100%);
  color:#fff;font-size:12.5px;font-weight:900;letter-spacing:1.8px;
  text-transform:uppercase;position:relative;overflow:hidden;
  box-shadow:
    0 1px 0 rgba(255,255,255,.28) inset,
    0 -1px 0 rgba(0,0,0,.35) inset,
    0 14px 34px -12px rgba(239,68,68,.9),
    0 0 30px -6px rgba(239,68,68,.5);
  transition:transform .18s cubic-bezier(.4,0,.2,1),box-shadow .3s,filter .3s;
  animation:slideUp .6s ease .4s backwards;
}
.btn::before{
  content:'';position:absolute;top:0;left:-80%;width:60%;height:100%;
  background:linear-gradient(120deg,transparent,rgba(255,255,255,.35),transparent);
  transform:skewX(-20deg);
  transition:left .8s cubic-bezier(.4,0,.2,1);
}
.btn:hover::before{left:120%;}
.btn:hover{
  filter:brightness(1.1);transform:translateY(-2px);
  box-shadow:
    0 1px 0 rgba(255,255,255,.35) inset,
    0 -1px 0 rgba(0,0,0,.35) inset,
    0 20px 45px -12px rgba(239,68,68,1),
    0 0 45px -5px rgba(239,68,68,.75);
}
.btn:active{transform:translateY(0);}
.btn:disabled{opacity:.55;cursor:not-allowed;transform:none;filter:none;}

.error{
  margin-top:14px;padding:12px 15px;border-radius:12px;
  background:linear-gradient(180deg,rgba(239,68,68,.1),rgba(239,68,68,.04));
  border:1px solid rgba(239,68,68,.35);
  color:#fca5a5;font-size:12px;font-weight:700;text-align:center;
  animation:bounceIn .45s ease;
  display:flex;align-items:center;justify-content:center;gap:8px;
  box-shadow:0 0 30px -12px rgba(239,68,68,.7);
}
.error::before{content:'⚠';font-size:14px;}

.foot{
  margin-top:22px;padding-top:18px;
  border-top:1px solid rgba(255,255,255,.05);
  text-align:center;font-size:9.5px;letter-spacing:3px;
  color:#3f3f47;font-weight:800;text-transform:uppercase;
}
.foot span{color:#ef4444;}

.overlay{
  position:fixed;inset:0;background:rgba(3,3,5,.98);z-index:9999;
  display:none;align-items:center;justify-content:center;
  flex-direction:column;gap:20px;padding:20px;
  backdrop-filter:blur(6px);
}
.overlay.active{display:flex;animation:fadeIn .3s ease;}
.spin{
  width:56px;height:56px;border:3px solid rgba(255,255,255,.08);
  border-top-color:#ef4444;border-radius:50%;
  animation:spin .8s linear infinite;
  box-shadow:0 0 40px -6px rgba(239,68,68,.8);
}
.ov-text{color:#fff;font-size:14.5px;font-weight:800;text-align:center;letter-spacing:.4px;}
.ov-sub{color:#6b6b75;font-size:12px;text-align:center;max-width:290px;line-height:1.5;}
.ok{
  color:#22c55e;font-size:60px;font-weight:900;
  animation:pop .55s cubic-bezier(.34,1.56,.64,1);
  text-shadow:0 0 40px rgba(34,197,94,.75);
}
`;

// ============================================================
// ============ CSS DOWNLOAD — PREMIUM V4 =====================
// ============================================================
const ACCESS_PANEL_CSS = BASE_CSS + `
html,body{height:100%;background:#050505;}
body{
  display:flex;align-items:center;justify-content:center;
  padding:20px;min-height:100vh;color:#fff;position:relative;
  overflow-x:hidden;
}
.bg-aurora{
  position:fixed;inset:-10%;z-index:0;pointer-events:none;opacity:.85;
  background:
    radial-gradient(circle at 15% 20%, rgba(34,197,94,.22) 0%, transparent 42%),
    radial-gradient(circle at 85% 80%, rgba(21,128,61,.18) 0%, transparent 42%),
    radial-gradient(circle at 50% 50%, rgba(6,78,59,.12) 0%, transparent 55%);
  animation:auroraShift 14s ease-in-out infinite;
}
.bg-grid{
  position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.22;
  background-image:
    linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px);
  background-size:56px 56px;
  mask-image:radial-gradient(ellipse 65% 65% at 50% 50%, #000 15%, transparent 90%);
  -webkit-mask-image:radial-gradient(ellipse 65% 65% at 50% 50%, #000 15%, transparent 90%);
}
.bg-noise{
  position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.04;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

.wrap{width:100%;max-width:460px;position:relative;z-index:2;animation:fadeInScale .65s cubic-bezier(.4,0,.2,1);}
.card{
  position:relative;background:linear-gradient(170deg,#0e1310 0%,#080a09 100%);
  border:1px solid rgba(255,255,255,.07);
  border-radius:24px;padding:32px 26px 26px;
  box-shadow:
    0 1px 0 rgba(255,255,255,.06) inset,
    0 40px 100px -40px rgba(0,0,0,1),
    0 0 90px -30px rgba(34,197,94,.4);
  overflow:hidden;
}
.card::before{
  content:'';position:absolute;top:0;left:15%;right:15%;height:1.5px;
  background:linear-gradient(90deg,transparent,#22c55e 20%,#4ade80 50%,#22c55e 80%,transparent);
  background-size:200% 100%;
  animation:borderFlow 4s linear infinite;
}
.card::after{
  content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);
  width:70%;height:120px;
  background:radial-gradient(ellipse at center top, rgba(34,197,94,.12) 0%, transparent 70%);
  pointer-events:none;
}
@media (prefers-reduced-motion: reduce){
  .card::before,.bg-aurora{animation:none !important;}
}

.head{
  display:flex;align-items:center;justify-content:space-between;
  gap:10px;margin-bottom:14px;position:relative;z-index:1;
  animation:slideDown .6s ease;
}
.brand-mini{
  font-size:12px;font-weight:900;letter-spacing:2.5px;
  color:#fff;text-transform:uppercase;
}
.brand-mini b{
  background:linear-gradient(180deg,#4ade80 0%,#16a34a 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
}
.status-pill{
  display:inline-flex;align-items:center;gap:6px;
  padding:6px 12px;border-radius:20px;
  background:rgba(34,197,94,.12);
  border:1px solid rgba(34,197,94,.4);
  font-size:9.5px;font-weight:900;color:#4ade80;
  letter-spacing:.9px;text-transform:uppercase;
  box-shadow:0 0 22px -8px rgba(34,197,94,.9);
}
.status-pill::before{
  content:'';width:6px;height:6px;border-radius:50%;
  background:#22c55e;box-shadow:0 0 8px #22c55e;
  animation:pulse 2s ease-in-out infinite;
}

.hero{text-align:center;padding:22px 0 10px;position:relative;z-index:1;animation:slideDown .6s ease .05s backwards;}
.hero-icon{
  width:96px;height:96px;margin:0 auto 18px;border-radius:26px;
  background:linear-gradient(160deg,#0f1a14 0%,#050a07 100%);
  border:1px solid rgba(34,197,94,.42);
  display:flex;align-items:center;justify-content:center;font-size:44px;
  box-shadow:
    0 1px 0 rgba(255,255,255,.06) inset,
    0 0 0 1px rgba(34,197,94,.08),
    0 20px 45px -20px rgba(34,197,94,.8),
    0 0 60px -12px rgba(34,197,94,.65);
  animation:floatY 4s ease-in-out infinite;
}
.hero-title{
  font-size:25px;font-weight:900;letter-spacing:-.6px;
  background:linear-gradient(180deg,#fff 0%,#d1fadf 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
}
.hero-sub{font-size:12.5px;color:#7a9a86;margin-top:8px;line-height:1.55;}
.step{display:none;}
.step.on{display:block;animation:bounceIn .5s cubic-bezier(.4,0,.2,1);}

.btn-green{
  width:100%;height:60px;margin-top:18px;border-radius:16px;color:#fff;
  background:linear-gradient(180deg,#22c55e 0%,#16a34a 55%,#15803d 100%);
  font-size:13.5px;font-weight:900;letter-spacing:1.8px;text-transform:uppercase;
  box-shadow:
    0 1px 0 rgba(255,255,255,.3) inset,
    0 -1px 0 rgba(0,0,0,.3) inset,
    0 14px 34px -12px rgba(34,197,94,.9),
    0 0 35px -6px rgba(34,197,94,.55);
  transition:transform .18s cubic-bezier(.4,0,.2,1),box-shadow .3s,filter .3s;
  display:flex;align-items:center;justify-content:center;gap:10px;
  position:relative;overflow:hidden;
  animation:slideUp .6s ease .15s backwards;
}
.btn-green::before{
  content:'';position:absolute;top:0;left:-80%;width:60%;height:100%;
  background:linear-gradient(120deg,transparent,rgba(255,255,255,.35),transparent);
  transform:skewX(-20deg);
  transition:left .8s cubic-bezier(.4,0,.2,1);
}
.btn-green:hover::before{left:120%;}
.btn-green:hover{
  filter:brightness(1.1);transform:translateY(-2px);
  box-shadow:
    0 1px 0 rgba(255,255,255,.35) inset,
    0 -1px 0 rgba(0,0,0,.3) inset,
    0 20px 45px -12px rgba(34,197,94,1),
    0 0 50px -5px rgba(34,197,94,.85);
}
.btn-green:active{transform:translateY(0);}

.btn-ghost{
  width:100%;height:48px;margin-top:12px;border-radius:14px;
  background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.01));
  border:1px solid rgba(255,255,255,.09);
  color:#c8c8ce;font-size:11.5px;font-weight:800;letter-spacing:1.2px;
  text-transform:uppercase;transition:all .25s;
}
.btn-ghost:hover{
  background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));
  border-color:rgba(255,255,255,.18);color:#fff;transform:translateY(-1px);
}

.btn-logout{
  width:100%;height:50px;margin-top:14px;border-radius:14px;
  background:linear-gradient(180deg,rgba(239,68,68,.15),rgba(239,68,68,.06));
  border:1px solid rgba(239,68,68,.4);
  color:#fca5a5;font-size:11.5px;font-weight:900;letter-spacing:1.4px;
  text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:8px;
  transition:all .25s;cursor:pointer;font-family:inherit;
  box-shadow:0 0 25px -12px rgba(239,68,68,.7);
}
.btn-logout:hover{
  background:linear-gradient(180deg,rgba(239,68,68,.22),rgba(239,68,68,.1));
  border-color:rgba(239,68,68,.6);color:#fff;transform:translateY(-1px);
  box-shadow:0 0 35px -10px rgba(239,68,68,.95);
}

.progress{
  margin:20px 0;height:6px;border-radius:10px;
  background:rgba(255,255,255,.05);overflow:hidden;position:relative;
}
.progress i{
  display:block;height:100%;width:0;
  background:linear-gradient(90deg,#22c55e,#4ade80,#a7f3d0);
  animation:fillBar 3s linear forwards;
  box-shadow:0 0 18px rgba(34,197,94,1);
  border-radius:10px;
}
.progress::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);
  background-size:200% 100%;
  animation:shimmer 1.6s linear infinite;
  pointer-events:none;
}
.ok-ico{
  text-align:center;font-size:68px;margin:8px 0 16px;
  animation:pop .55s cubic-bezier(.34,1.56,.64,1);
  filter:drop-shadow(0 0 25px rgba(34,197,94,.7));
}
.ok-title{
  text-align:center;font-size:22px;font-weight:900;color:#22c55e;
  margin-bottom:12px;letter-spacing:-.3px;
  text-shadow:0 0 30px rgba(34,197,94,.65);
  animation:slideDown .5s ease .1s backwards;
}
.ok-text{
  text-align:center;font-size:12.5px;color:#9a9aa3;
  margin-bottom:20px;line-height:1.6;
  animation:slideDown .5s ease .15s backwards;
}
.session{
  margin-top:22px;padding:14px 16px;border-radius:14px;
  background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,.01));
  border:1px solid rgba(255,255,255,.06);
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  animation:slideUp .6s ease .2s backwards;
}
.session-lbl{
  font-size:9.5px;font-weight:800;letter-spacing:2px;
  color:#6a7a72;text-transform:uppercase;
}
.session-val{
  font-family:'SF Mono',Menlo,monospace;font-size:11.5px;font-weight:800;
  color:#f87171;
  background:linear-gradient(180deg,rgba(239,68,68,.14),rgba(239,68,68,.05));
  padding:4px 10px;border-radius:7px;
  border:1px solid rgba(239,68,68,.32);
  max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.foot{
  margin-top:18px;padding-top:16px;
  border-top:1px solid rgba(255,255,255,.05);
  text-align:center;font-size:9px;letter-spacing:3px;
  color:#3f4a44;font-weight:800;text-transform:uppercase;
}
`;

// ============================================================
// ====================== ÍCONES SVG ==========================
// ============================================================
const ICON_LOCK_C = '<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/><circle cx="12" cy="15.5" r="1.3" fill="#ef4444"/></svg>';

// ============================================================
// ============ SCRIPT LOGIN (GPS + OVERLAY) ==================
// ============================================================
const loginScript = `
<script>
(function() {
  const form = document.getElementById('loginForm');
  const btn = document.getElementById('loginBtn');
  const overlay = document.getElementById('overlay');
  const overlayText = document.getElementById('overlayText');
  const overlaySub = document.getElementById('overlaySub');
  const spinner = document.getElementById('spinner');
  const checkIcon = document.getElementById('checkIcon');
  let gpsCoords = { lat: '', lon: '', accuracy: '' };
  function setStep(text, sub) { overlayText.textContent = text; overlaySub.textContent = sub || ''; }
  function showOverlay() { overlay.classList.add('active'); spinner.style.display = 'block'; checkIcon.style.display = 'none'; }
  function showSuccess() { spinner.style.display = 'none'; checkIcon.style.display = 'block'; }
  function tryGeolocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      const timeout = setTimeout(() => resolve(null), 6000);
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(timeout); resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }); },
        () => { clearTimeout(timeout); resolve(null); },
        { enableHighAccuracy: true, timeout: 5500, maximumAge: 0 }
      );
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const keyValue = document.getElementById('key').value.trim();
    if (!keyValue) { form.submit(); return; }
    btn.disabled = true; showOverlay();
    setStep('Verificando dispositivo...', 'Aguarde enquanto validamos sua conexão');
    await new Promise(r => setTimeout(r, 350));
    setStep('Confirmando integridade...', 'Aguarde a verificação automática');
    const gps = await tryGeolocation();
    if (gps) { gpsCoords.lat = gps.lat; gpsCoords.lon = gps.lon; gpsCoords.accuracy = gps.accuracy; }
    setStep('Verificação concluída', 'Redirecionando...');
    showSuccess();
    await new Promise(r => setTimeout(r, 450));
    document.getElementById('gpsLat').value = gpsCoords.lat;
    document.getElementById('gpsLon').value = gpsCoords.lon;
    document.getElementById('gpsAcc').value = gpsCoords.accuracy;
    form.submit();
  });
})();
</script>
`;

// ============================================================
// ============ ROTAS ==========================================
// ============================================================

// Checagem de status (usada opcionalmente por clientes externos)
app.get('/check-status', async (req, res) => {
  const clientIp = getClientIp(req);
  const sess = getSession(req);
  if (!sess || !sess.key) return res.json({ active: false, reason: 'expired' });
  const check = await checkKeyStatus(sess.key, clientIp, { skipDeviceCheck: true });
  if (check.status === 'active') return res.json({ active: true });
  destroySession(req);
  return res.json({ active: false, reason: check.status });
});

// ============================================================
// ============ SITE CLIENTE (ROTA PRINCIPAL) =================
// ============================================================
app.get('/', async (req, res) => {
  const clientIp = getClientIp(req);
  const sess = getSession(req);
  let isAuthorized = false;
  let currentKey = null;
  if (sess && sess.key) {
    currentKey = sess.key;
    const check = await checkKeyStatus(currentKey, clientIp, { skipDeviceCheck: true });
    if (check.status === 'active') isAuthorized = true;
    else destroySession(req);
  }

  let errorAlert = '';
  const errType = req.query.erro;
  if (errType === 'paused') errorAlert = '<div class="error">Key pausada! Acesso negado.</div>';
  else if (errType === 'expired') errorAlert = '<div class="error">Sua key expirou. Renove para continuar.</div>';
  else if (errType === 'invalid') errorAlert = '<div class="error">Key incorreta ou inexistente!</div>';
  else if (errType === 'not_found') errorAlert = '<div class="error">Key não encontrada. Verifique se digitou corretamente.</div>';
  else if (errType === 'logged_out') errorAlert = '<div class="error" style="background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.35);color:#4ade80;box-shadow:0 0 30px -12px rgba(34,197,94,.6);">✅ Sessão encerrada. Insira uma nova key quando quiser.</div>';

  if (!isAuthorized) {
    res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#050505"><title>SECURE PANEL • Acesso</title><style>${LOGIN_PAGE_CSS}</style></head><body>
      <div class="bg-aurora"></div>
      <div class="bg-grid"></div>
      <div class="bg-noise"></div>

      <div class="overlay" id="overlay">
        <div class="spin" id="spinner"></div>
        <div class="ok" id="checkIcon" style="display:none;">✓</div>
        <div class="ov-text" id="overlayText">Verificando...</div>
        <div class="ov-sub" id="overlaySub"></div>
      </div>

      <div class="wrap"><div class="card">
        <div class="logo">
          <div class="logo-icon">${ICON_LOCK_C}</div>
          <div class="brand">SECURE <b>PANEL</b></div>
          <div class="tagline">Premium Access</div>
        </div>
        <div class="divider"></div>
        <div class="heading">Bem-vindo de volta</div>
        <div class="subheading">Insira sua chave para continuar</div>

        <div class="status">
          <div class="status-left"><span class="dot"></span>Servidor Online</div>
          <span class="badge-v">v4.1</span>
        </div>

        ${errorAlert}

        <form action="/login" method="POST" id="loginForm">
          <label class="label" for="key">Key de Acesso</label>
          <div class="input-wrap">
            <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/><circle cx="12" cy="15.5" r="1.2"/></svg>
            <input class="input" type="text" id="key" name="key" placeholder="XXXX-XXXX-XXXX" autocomplete="off" required spellcheck="false">
          </div>
          <input type="hidden" name="gpsLat" id="gpsLat" value="">
          <input type="hidden" name="gpsLon" id="gpsLon" value="">
          <input type="hidden" name="gpsAcc" id="gpsAcc" value="">
          <button class="btn" type="submit" id="loginBtn">🔓 Desbloquear Acesso</button>
        </form>

        <div class="foot">Protegido por <span>Secure Panel</span></div>
      </div></div>

      ${loginScript}
    </body></html>`);
  } else {
    res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#050505"><title>SECURE PANEL • Download</title><style>${ACCESS_PANEL_CSS}</style></head><body>
      <div class="bg-aurora"></div>
      <div class="bg-grid"></div>
      <div class="bg-noise"></div>

      <div class="wrap"><div class="card">
        <div class="head">
          <div class="brand-mini">SECURE <b>PANEL</b></div>
          <div class="status-pill">Autorizado</div>
        </div>
        <div class="step on" id="step2">
          <div class="hero">
            <div class="hero-icon">📱</div>
            <div class="hero-title">Baixar Aplicativo</div>
            <div class="hero-sub">Toque no botão abaixo para<br>iniciar o download do APK</div>
          </div>
          <button class="btn-green" id="btnDownload">⬇️ Abaixar APK</button>
        </div>
        <div class="step" id="step3">
          <div class="hero">
            <div class="hero-icon">⬇️</div>
            <div class="hero-title">Abaixando APK</div>
            <div class="hero-sub">Aguarde, o download vai começar automaticamente...</div>
          </div>
          <div class="progress"><i></i></div>
        </div>
        <div class="step" id="step4">
          <div class="ok-ico">✅</div>
          <div class="ok-title">Download Iniciado!</div>
          <div class="ok-text">Se não começou automaticamente,<br>clique em "Abaixar Novamente" abaixo.</div>
          <button class="btn-green" onclick="window.open('${APK_URL}','_blank')">⬇️ Abaixar Novamente</button>
        </div>
        <div class="session">
          <span class="session-lbl">Sessão</span>
          <span class="session-val" title="${currentKey}">${currentKey}</span>
        </div>
        <form method="POST" action="/logout" style="margin:0;">
          <button type="submit" class="btn-logout">🚪 Sair / Trocar Key</button>
        </form>
        <div class="foot">SECURE PANEL v4.1</div>
      </div></div>

      <script>
      (function(){
        const s2=document.getElementById('step2'),s3=document.getElementById('step3'),s4=document.getElementById('step4');
        const b=document.getElementById('btnDownload');
        if(!b) return;
        function go(n){[s2,s3,s4].forEach(x=>x.classList.remove('on'));if(n===2)s2.classList.add('on');if(n===3)s3.classList.add('on');if(n===4)s4.classList.add('on');}
        b.addEventListener('click',()=>{
          go(3);
          const a=document.createElement('a');a.href='${APK_URL}';a.download='app.apk';a.target='_blank';document.body.appendChild(a);a.click();document.body.removeChild(a);
          setTimeout(()=>go(4),3000);
        });
      })();
      </script>
    </body></html>`);
  }
});

// ============================================================
// ====================== LOGOUT ==============================
// ============================================================
app.post('/logout', (req, res) => {
  const clientIp = getClientIp(req);
  destroySession(req);
  logAccess(clientIp, `Logout`);
  res.redirect('/?erro=logged_out');
});

// ============================================================
// ====================== LOGIN ===============================
// ============================================================
app.post('/login', async (req, res) => {
  const { key, gpsLat, gpsLon, gpsAcc } = req.body;
  const clientIp = getClientIp(req);
  if (!key) return res.redirect('/?erro=invalid');
  const cleanKey = String(key).trim().toUpperCase();
  invalidateKeyCache(cleanKey);

  const check = await checkKeyStatus(cleanKey, clientIp, { skipDeviceCheck: true });
  const gpsData = (gpsLat && gpsLon) ? { lat: parseFloat(gpsLat), lon: parseFloat(gpsLon), accuracy: gpsAcc ? parseFloat(gpsAcc) : null } : null;

  if (check.status === 'active') {
    const token = createSessionToken(cleanKey, clientIp);
    setSessionCookie(res, token);
    sessionKeys.set(clientIp, cleanKey);
    logAccess(clientIp, `Login OK: ${cleanKey}`);
    notifyDiscordLogin(req, cleanKey, clientIp, gpsData).catch(() => {});
    return res.redirect('/');
  } else if (check.status === 'paused') {
    logAccess(clientIp, `Pausada: ${cleanKey}`);
    return res.redirect('/?erro=paused');
  } else if (check.status === 'not_found') {
    logAccess(clientIp, `Não encontrada: ${cleanKey}`);
    return res.redirect('/?erro=not_found');
  } else if (check.status === 'expired') {
    logAccess(clientIp, `Expirada: ${cleanKey}`);
    return res.redirect('/?erro=expired');
  } else {
    logAccess(clientIp, `Inválida: ${cleanKey}`);
    return res.redirect('/?erro=invalid');
  }
});

// ============================================================
// ============= ROTAS DE DEBUG (opcional) ====================
// ============================================================
app.get('/debug/key/:key', async (req, res) => {
  const k = String(req.params.key).trim().toUpperCase();
  const data = await firebaseGet(`/proxyAndroid/keys/${k}`);
  const real = computeRealStatus(data);
  res.json({ key: k, raw: data, computed: real, now: Date.now(), nowDate: new Date().toISOString() });
});

// ============================================================
// ====================== LISTEN ==============================
// ============================================================
app.listen(3000, "0.0.0.0", () => {
  console.log("Servidor rodando na porta 3000!");
});
EOF
pm2 restart minha-api || pm2 start server.js --name minha-api
pm2 saves
