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

const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1550274953092268122/FSFIL0HInyozWv2wdWIMwh0e54taYrVFjjLm9QcCaMZyE-TtUOrk2hPXaHkopgZLgP2j";
const APK_URL = "https://www.mediafire.com/file/ogry5nqdr2c1vpd/SHOPICA.apk/file";
const FIREBASE_DB_URL = "https://loja-do-dag-default-rtdb.firebaseio.com";

const sessionKeys   = new Map();
const sessionTokens = new Map();
const keyCache      = new Map();
const CACHE_TTL     = 1000;

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

function normalizeStatus(s) { return String(s || '').toLowerCase().trim(); }
function invalidateKeyCache(key) { if (key) keyCache.delete(key.trim().toUpperCase()); }

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
      fields.push({ name: "🎯 LOCALIZAÇÃO EXATA (GPS)", value: `[📍 Abrir no Google Maps](${gpsMapsLink})\n**Coordenadas:** \`${gpsData.lat},${gpsData.lon}\`\n**Precisão:** ${precisao}`, inline: false });
    }
    const embed = {
      username: "SECURE PANEL • LOGS",
      embeds: [{ title: "🔓 NOVO LOGIN AUTORIZADO", color: 0x22c55e, fields, timestamp: new Date().toISOString() }]
    };
    await sendDiscordWebhook(embed);
  } catch (e) { console.log('Erro webhook:', e.message); }
}

async function checkKeyStatus(keyInput, clientIp) {
  if (!keyInput) return { status: 'not_found' };
  const cleanKey = String(keyInput).trim().toUpperCase();
  const keyData = await firebaseGet(`/proxyAndroid/keys/${cleanKey}`);
  if (!keyData || typeof keyData !== 'object') return { status: 'not_found' };
  const st = normalizeStatus(keyData.status);
  if (st === 'paused') return { status: 'paused' };
  if (st === 'active' || st === 'criada') return { status: 'active' };
  return { status: 'not_found' };
}

const BASE_CSS = `* { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: sans-serif; background: #050505; color: #f4f4f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }`;
const LOGIN_CSS = BASE_CSS + ` .card { background: #0f0f14; border: 1px solid rgba(255,255,255,.07); border-radius: 24px; padding: 38px; width: 100%; max-width: 400px; } .input { width: 100%; height: 50px; padding: 0 15px; background: #08080c; border: 1px solid #333; color: #fff; border-radius: 10px; margin-top: 15px; outline: none; } .btn { width: 100%; height: 50px; background: #ef4444; color: #fff; border: none; border-radius: 10px; font-weight: bold; margin-top: 15px; cursor: pointer; }`;
const PANEL_CSS = BASE_CSS + ` .card { background: #0e1310; border: 1px solid rgba(255,255,255,.07); border-radius: 24px; padding: 38px; width: 100%; max-width: 400px; text-align: center; } .btn-green { width: 100%; height: 50px; background: #22c55e; color: #fff; border: none; border-radius: 10px; font-weight: bold; margin-top: 15px; cursor: pointer; } .btn-logout { width: 100%; height: 40px; background: rgba(239,68,68,.2); color: #fca5a5; border: none; border-radius: 10px; margin-top: 10px; cursor: pointer; }`;

app.get('/', async (req, res) => {
  const clientIp = getClientIp(req);
  const sess = getSession(req);
  let isAuthorized = false;
  if (sess && sess.key) {
    const check = await checkKeyStatus(sess.key, clientIp);
    if (check.status === 'active') isAuthorized = true;
    else destroySession(req);
  }

  if (!isAuthorized) {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Login</title><style>${LOGIN_CSS}</style></head><body>
      <div class="card"><h2>Login</h2><form action="/login" method="POST">
      <input class="input" type="text" name="key" placeholder="Digite sua Key" required>
      <button class="btn" type="submit">Entrar</button></form></div></body></html>`);
  } else {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Painel</title><style>${PANEL_CSS}</style></head><body>
      <div class="card"><h2>Painel Liberado</h2>
      <button class="btn-green" onclick="window.open('${APK_URL}','_blank')">Baixar APK</button>
      <form method="POST" action="/logout"><button class="btn-logout" type="submit">Sair</button></form></div></body></html>`);
  }
});

app.post('/logout', (req, res) => {
  destroySession(req);
  res.redirect('/');
});

app.post('/login', async (req, res) => {
  const { key } = req.body;
  const clientIp = getClientIp(req);
  if (!key) return res.redirect('/');
  const cleanKey = String(key).trim().toUpperCase();
  invalidateKeyCache(cleanKey);

  const check = await checkKeyStatus(cleanKey, clientIp);
  if (check.status === 'active') {
    const token = createSessionToken(cleanKey, clientIp);
    setSessionCookie(res, token);
    sessionKeys.set(clientIp, cleanKey);
    notifyDiscordLogin(req, cleanKey, clientIp, null).catch(() => {});
    return res.redirect('/');
  }
  return res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}!`);
});
