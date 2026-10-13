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
function normalizeStatus(s) { return String(s || '').toLowerCase().trim(); }
function toNumber(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }

function invalidateKeysCache() {}
function invalidateKeyCache(key) { if (key) keyCache.delete(key.trim().toUpperCase()); }

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
      localStr = `${geo.city \vert{}\vert{} '-'} /${geo.regionName || '-'} / ${geo.country \vert{}\vert{} '-'} (${geo.countryCode || '-'})`;
      coordsStr = `${geo.lat},${geo.lon}`;
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
  }
  if (st === 'expired' && expiresAt > 0 && now <= expiresAt) {
    await firebasePatch(`/proxyAndroid/keys/${cleanKey}`, { status: 'active' });
    st = 'active';
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
      await firebasePatch(`/proxyAndroid/keys/${cleanKey}`, updatePayload);
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
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:#050505;color:#f4f4f5;min-height:100vh;font-size:12.5px;line-height:1.4;}
button,input,select,textarea{font:inherit;color:inherit;}
button{cursor:pointer;border:none;background:none;position:relative;overflow:hidden;}
a{color:inherit;text-decoration:none;}
code{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.92em;}
`;

const LOGIN_PAGE_CSS = BASE_CSS + `
body{display:flex;align-items:center;justify-content:center;padding:20px;min-height:100vh;color:#fff;background:#050505;}
.wrap{width:100%;max-width:430px;}
.card{background:#0f0f14;border:1px solid rgba(255,255,255,.07);border-radius:24px;padding:38px 30px 28px;}
.input{width:100%;height:56px;padding:0 18px;border-radius:14px;background:#08080c;border:1.5px solid rgba(255,255,255,.07);color:#fff;font-size:14px;outline:none;}
.btn{width:100%;height:56px;margin-top:18px;border-radius:14px;background:#ef4444;color:#fff;font-weight:900;text-transform:uppercase;}
.error{margin-top:14px;padding:12px;background:rgba(239,68,68,.1);color:#fca5a5;border-radius:12px;text-align:center;}
`;

const ACCESS_PANEL_CSS = BASE_CSS + `
body{display:flex;align-items:center;justify-content:center;padding:20px;min-height:100vh;color:#fff;background:#050505;}
.wrap{width:100%;max-width:460px;}
.card{background:#0e1310;border:1px solid rgba(255,255,255,.07);border-radius:24px;padding:32px;}
.btn-green{width:100%;height:60px;margin-top:18px;border-radius:16px;background:#22c55e;color:#fff;font-weight:900;text-transform:uppercase;}
.btn-logout{width:100%;height:50px;margin-top:14px;border-radius:14px;background:rgba(239,68,68,.15);color:#fca5a5;font-weight:900;}
`;

const ICON_LOCK_C = '<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>';

const loginScript = `
<script>
(function() {
  const form = document.getElementById('loginForm');
  form.addEventListener('submit', async (e) => {
    form.submit();
  });
})();
</script>
`;

// ============================================================
// ====================== ROTAS ===============================
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
  if (errType === 'paused') errorAlert = '<div class="error">Key pausada!</div>';
  else if (errType === 'expired') errorAlert = '<div class="error">Key expirada!</div>';
  else if (errType === 'invalid') errorAlert = '<div class="error">Key inválida!</div>';
  else if (errType === 'not_found') errorAlert = '<div class="error">Key não encontrada!</div>';
  else if (errType === 'logged_out') errorAlert = '<div class="error">Sessão encerrada.</div>';

  if (!isAuthorized) {
    res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Login</title><style>${LOGIN_PAGE_CSS}</style></head><body>
      <div class="wrap"><div class="card">
        <h2>Login</h2>
        ${errorAlert}
        <form action="/login" method="POST" id="loginForm">
          <input class="input" type="text" name="key" placeholder="XXXX-XXXX" required>
          <input type="hidden" name="gpsLat" id="gpsLat" value="">
          <input type="hidden" name="gpsLon" id="gpsLon" value="">
          <input type="hidden" name="gpsAcc" id="gpsAcc" value="">
          <button class="btn" type="submit">Entrar</button>
        </form>
      </div></div>
      ${loginScript}
    </body></html>`);
  } else {
    res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Painel</title><style>${ACCESS_PANEL_CSS}</style></head><body>
      <div class="wrap"><div class="card">
        <h2>Painel de Download</h2>
        <button class="btn-green" onclick="window.open('${APK_URL}','_blank')">Baixar APK</button>
        <form method="POST" action="/logout"><button type="submit" class="btn-logout">Sair</button></form>
      </div></div>
    </body></html>`);
  }
});

app.post('/logout', (req, res) => {
  destroySession(req);
  res.redirect('/?erro=logged_out');
});

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
    notifyDiscordLogin(req, cleanKey, clientIp, gpsData).catch(() => {});
    return res.redirect('/');
  } else if (check.status === 'paused') {
    return res.redirect('/?erro=paused');
  } else if (check.status === 'not_found') {
    return res.redirect('/?erro=not_found');
  } else if (check.status === 'expired') {
    return res.redirect('/?erro=expired');
  } else {
    return res.redirect('/?erro=invalid');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}!`);
});
