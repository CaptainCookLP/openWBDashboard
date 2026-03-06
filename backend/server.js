'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');

const nodemailer = require('nodemailer');

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://10.100.95.10:1883';
const PORT        = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const RFID_FILE     = path.join(DATA_DIR, 'rfid-users.json');
const NOTIFY_FILE   = path.join(DATA_DIR, 'notify-config.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let settings = loadJSON(SETTINGS_FILE, {});
// MQTT broker: prefer persisted setting, then env var, then default
let mqttBrokerUrl = settings.mqttBroker || MQTT_BROKER;

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// RFID user list  [{rfid, name, mail, kontoId}]
let rfidUsers = loadJSON(RFID_FILE, []);

// Notification config
let notifyConfig = loadJSON(NOTIFY_FILE, {
  smtp:    { enabled: true, host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '', emailSubject: '', emailBody: '' },
  webhook: { enabled: true, url: '', headers: '{}', template: '' },
  monitor: { enabled: true, delayMinutes: 5, thresholdW: 100 }
});

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  chargepoints: {},   // { 1: { ... }, 2: { ... }, ... }
  grid: {},
  pv: {},
  battery: {},
  house: {},
  raw: {}             // raw topic → value store for unknown/extra topics
};

// Chargepoints are discovered dynamically from MQTT

// ─── Topic Parsers ────────────────────────────────────────────────────────────

function parseBool(v) {
  const s = String(v).trim();
  if (s === '1' || s.toLowerCase() === 'true') return true;
  if (s === '0' || s.toLowerCase() === 'false') return false;
  return null;
}

function parseFloat2(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function parseJSON(v) {
  try { return JSON.parse(v); } catch { return null; }
}

function setCP(id, field, value) {
  if (!state.chargepoints[id]) {
    state.chargepoints[id] = {
      id,
      name: `Ladepunkt ${id}`,
      power: null,
      chargingState: null,
      plugState: null,
      imported: null,
      soc: null,
      current: null,
      current1: null,
      current2: null,
      current3: null,
      configuredCurrent: null,
      kmCharged: null,
      phasesInUse: null,
      vehicle: null,
      rfid: null,
      manualLock: null,
      pluggedSince: null,
      idleSince: null,
      importedSincePlugged: null,
      rangeCharged: null,
      faultState: null,
      hasCharged: false,
      lastUpdate: null
    };
  }
  // Track when car is plugged in
  if (field === 'plugState') {
    if (value === true  && !state.chargepoints[id].pluggedSince) state.chargepoints[id].pluggedSince = Date.now();
    if (value === false) {
      state.chargepoints[id].pluggedSince = null;
      state.chargepoints[id].idleSince = null;
      state.chargepoints[id].importedSincePlugged = null;
      state.chargepoints[id].rangeCharged = null;
      state.chargepoints[id].hasCharged = false;
    }
  }
  // Set hasCharged flag on first active charging session
  if (field === 'chargingState' && value === true) {
    state.chargepoints[id].hasCharged = true;
  }
  state.chargepoints[id][field] = value;
  state.chargepoints[id].lastUpdate = Date.now();
}

// openWB v1 topic handlers
const v1Handlers = {
  // lp
  'W':              (id, v) => setCP(id, 'power',            parseFloat2(v)),
  'boolChargeStat': (id, v) => setCP(id, 'chargingState',    parseBool(v)),
  'boolPlugStat':   (id, v) => setCP(id, 'plugState',        parseBool(v)),
  'kWhCounter':     (id, v) => setCP(id, 'imported',         parseFloat2(v)),
  'AConfigured':    (id, v) => setCP(id, 'configuredCurrent',parseFloat2(v)),
  'currenctV1':     (id, v) => setCP(id, 'current1',         parseFloat2(v)),
  'currenctV2':     (id, v) => setCP(id, 'current2',         parseFloat2(v)),
  'currenctV3':     (id, v) => setCP(id, 'current3',         parseFloat2(v)),
  'VehicleConnected':(id, v) => setCP(id, 'vehicle',         parseBool(v)),
  'kmCharged':      (id, v) => setCP(id, 'kmCharged',        parseFloat2(v)),
  'strChargePointName': (id, v) => setCP(id, 'name',         String(v).trim()),
};

// ─── Notifications ────────────────────────────────────────────────────────────

function fmtDuration(ms) {
  if (!ms || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}min`;
  if (m > 0) return `${m}min`;
  return `${s}s`;
}

function applyTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendEmail(vars) {
  const s = notifyConfig.smtp;
  if (!s || !s.host) throw new Error('SMTP nicht konfiguriert (host fehlt)');
  const recipient = vars.userMail || s.to;
  if (!recipient) throw new Error('Kein Empfänger (weder User-E-Mail noch Fallback-To)');
  const transporter = nodemailer.createTransport({
    host: s.host, port: Number(s.port) || 587, secure: !!s.secure,
    auth: (s.user && s.pass) ? { user: s.user, pass: s.pass } : undefined
  });
  const defaultSubject = `Ladevorgang beendet – Fahrzeug noch verbunden (${vars.cpName})`;
  const subject = s.emailSubject ? applyTemplate(s.emailSubject, vars) : defaultSubject;
  const defaultHtml = `
    <div style="font-family:sans-serif;font-size:14px;color:#333;max-width:600px;">
      <p>Hallo,</p>
      <p>das Fahrzeug an <strong>${escHtml(vars.cpName)}</strong> lädt nicht mehr, ist aber noch angeschlossen.</p>
      <p style="color:#c00;font-weight:600;">Bitte Ladesäule frei machen.</p>
      <table style="border-collapse:collapse;margin:16px 0;font-size:14px;">
        <tr><td style="padding:6px 16px 6px 0;color:#888;white-space:nowrap;">Ladepunkt</td><td style="padding:6px 0;font-weight:600;">${escHtml(vars.cpName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#888;white-space:nowrap;">RFID</td><td style="padding:6px 0;">${escHtml(vars.rfid)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#888;white-space:nowrap;">Benutzer</td><td style="padding:6px 0;">${escHtml(vars.userName) || '–'}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#888;white-space:nowrap;">E-Mail</td><td style="padding:6px 0;">${escHtml(vars.userMail) || '–'}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#888;white-space:nowrap;">Angeschlossen seit</td><td style="padding:6px 0;">${escHtml(vars.chargeDuration)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#888;white-space:nowrap;">Geladen</td><td style="padding:6px 0;font-weight:600;">${escHtml(vars.importedKwh)} kWh</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#888;white-space:nowrap;">Zeitpunkt</td><td style="padding:6px 0;">${escHtml(vars.timestamp)}</td></tr>
      </table>
    </div>
  `;
  const html = s.emailBody ? applyTemplate(s.emailBody, vars) : defaultHtml;
  await transporter.sendMail({ from: s.from || s.user, to: recipient, subject, html });
  console.log(`E-Mail gesendet an ${recipient}: ${subject}`);
}

async function sendWebhook(payload) {
  const w = notifyConfig.webhook;
  if (!w || !w.url) throw new Error('Webhook-URL nicht konfiguriert');
  if (w.enabled === false) throw new Error('Webhook ist deaktiviert');
  const headers = { 'Content-Type': 'application/json' };
  try { Object.assign(headers, JSON.parse(w.headers || '{}')); } catch {}
  const body = w.template
    ? w.template.replace(/\{\{(\w+)\}\}/g, (_, k) => payload[k] ?? '')
    : JSON.stringify(payload);
  const res = await fetch(w.url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  console.log(`Webhook gesendet an ${w.url}`);
}

async function sendNotification(cp, user) {
  const now = Date.now();
  const durationMs = cp.pluggedSince ? now - cp.pluggedSince : null;
  const vars = {
    event:          'charging_stopped_plugged',
    cpId:           String(cp.id),
    cpName:         cp.name,
    rfid:           cp.rfid || '',
    userName:       user?.name    || '',
    userMail:       user?.mail    || '',
    kontoId:        user?.kontoId || '',
    chargeDuration: fmtDuration(durationMs),
    importedKwh:    cp.importedSincePlugged != null
                      ? (cp.importedSincePlugged / 1000).toFixed(2)
                      : (cp.imported != null ? parseFloat(cp.imported).toFixed(2) : '0.00'),
    rangeCharged:   cp.rangeCharged != null ? parseFloat(cp.rangeCharged).toFixed(1) : '–',
    power:          cp.power    != null ? String(Math.round(cp.power)) : '0',
    timestamp:      new Date().toLocaleString('de-DE'),
    isoTimestamp:   new Date().toISOString(),
  };
  const monEnabled = notifyConfig.monitor?.enabled !== false;
  if (!monEnabled) return;
  const errs = [];
  if (notifyConfig.smtp?.enabled !== false && notifyConfig.smtp?.host) {
    try { await sendEmail(vars);   } catch (e) { errs.push('E-Mail: '  + e.message); }
  }
  if (notifyConfig.webhook?.enabled !== false && notifyConfig.webhook?.url) {
    try { await sendWebhook(vars); } catch (e) { errs.push('Webhook: ' + e.message); }
  }
  if (errs.length) console.error('Benachrichtigungsfehler:', errs.join(' | '));
}

// Set of CP IDs that have already been notified (reset when no longer idle)
const notifiedCps = new Set();

function handleMqttMessage(topic, payload) {
  const msg = payload.toString().trim();
  state.raw[topic] = msg;

  const parts = topic.split('/');
  if (parts[0] !== 'openWB') return;

  // ── openWB v2 ──────────────────────────────────────────────────────────────
  // openWB/chargepoint/{n}/get/...
  if (parts[1] === 'chargepoint' && parts[3] === 'get') {
    const id = parseInt(parts[2], 10);
    if (isNaN(id)) return;
    const field = parts.slice(4).join('/');
    switch (field) {
      case 'power':          setCP(id, 'power',         parseFloat2(msg)); break;
      case 'plug_state':     setCP(id, 'plugState',     parseBool(msg));   break;
      case 'charge_state':   setCP(id, 'chargingState', parseBool(msg));   break;
      case 'imported':       setCP(id, 'imported',      parseFloat2(msg)); break;
      case 'current':        setCP(id, 'current',       parseFloat2(msg)); break;
      case 'phases_in_use':  setCP(id, 'phasesInUse',   parseInt(msg,10)); break;
      case 'connected_vehicle/soc': setCP(id, 'soc',       parseFloat2(msg));   break;
      case 'fault_state':            setCP(id, 'faultState', parseInt(msg, 10));  break;
    }
    return;
  }

  // openWB/chargepoint/{n}/config
  if (parts[1] === 'chargepoint' && parts[3] === 'config') {
    const id = parseInt(parts[2], 10);
    if (isNaN(id)) return;
    const cfg = parseJSON(msg);
    if (cfg && cfg.name) setCP(id, 'name', cfg.name);
    return;
  }

  // openWB/chargepoint/{n}/set/...
  if (parts[1] === 'chargepoint' && parts[3] === 'set') {
    const id = parseInt(parts[2], 10);
    if (isNaN(id)) return;
    const field = parts.slice(4).join('/');
    switch (field) {
      case 'rfid':        setCP(id, 'rfid',       String(msg).trim().replace(/^"|"$/g, '') || null); break;
      case 'manual_lock': setCP(id, 'manualLock', parseBool(msg));             break;
      case 'log': {
        const logData = parseJSON(msg);
        if (logData) {
          if (logData.imported_since_plugged != null) setCP(id, 'importedSincePlugged', parseFloat2(logData.imported_since_plugged));
          if (logData.range_charged != null) setCP(id, 'rangeCharged', parseFloat2(logData.range_charged));
          if (logData.rfid && !state.chargepoints[id]?.rfid) {
            setCP(id, 'rfid', String(logData.rfid).trim().replace(/^"|"$/g, '') || null);
          }
        }
        break;
      }
    }
    return;
  }

  // v2 global energy sources
  // openWB/counter/set/home_consumption
  if (parts[1] === 'counter' && parts[2] === 'set' && parts[3] === 'home_consumption') {
    state.house.power = parseFloat2(msg);
    return;
  }

  // openWB/counter/0/get/power|imported|exported
  if (parts[1] === 'counter' && parts[3] === 'get') {
    if (parts[4] === 'power')     state.grid.power      = parseFloat2(msg);
    if (parts[4] === 'imported')  state.grid.imported   = parseFloat2(msg);
    if (parts[4] === 'exported')  state.grid.exported   = parseFloat2(msg);
    if (parts[4] === 'frequency') state.grid.frequency  = parseFloat2(msg);
    return;
  }

  // openWB/pv/get/power
  if (parts[1] === 'pv' && parts[2] === 'get') {
    if (parts[3] === 'power')  state.pv.power  = parseFloat2(msg);
    if (parts[3] === 'energy') state.pv.energy = parseFloat2(msg);
    return;
  }

  // openWB/bat/get/power|soc
  if (parts[1] === 'bat' && parts[2] === 'get') {
    if (parts[3] === 'power')          state.battery.power    = parseFloat2(msg);
    if (parts[3] === 'soc')            state.battery.soc      = parseFloat2(msg);
    if (parts[3] === 'imported')       state.battery.imported = parseFloat2(msg);
    if (parts[3] === 'exported')       state.battery.exported = parseFloat2(msg);
    return;
  }

  // ── openWB v1 ──────────────────────────────────────────────────────────────
  // openWB/lp/{n}/{field}
  if (parts[1] === 'lp') {
    const id = parseInt(parts[2], 10);
    if (isNaN(id)) return;
    const field = parts[3];
    if (field && v1Handlers[field]) {
      v1Handlers[field](id, msg);
    }
    return;
  }

  // v1 global
  if (parts[1] === 'global') {
    if (parts[2] === 'WHouseConsumption') state.house.power    = parseFloat2(msg);
    if (parts[2] === 'WAllChargePoints')  state.house.cpPower  = parseFloat2(msg);
    return;
  }

  if (parts[1] === 'evu') {
    if (parts[2] === 'W')          state.grid.power    = parseFloat2(msg);
    if (parts[2] === 'WhImported') state.grid.imported = parseFloat2(msg);
    if (parts[2] === 'WhExported') state.grid.exported = parseFloat2(msg);
    return;
  }

  // v1 pv
  if (parts[1] === 'pv') {
    if (parts[3] === 'W')  state.pv.power  = parseFloat2(msg);
    if (parts[3] === 'Wh') state.pv.energy = parseFloat2(msg);
    return;
  }

  // v1 bat
  if (parts[1] === 'bat') {
    if (parts[2] === 'W')   state.battery.power   = parseFloat2(msg);
    if (parts[2] === 'soc') state.battery.soc     = parseFloat2(msg);
    return;
  }
}

// ─── Express + Socket.IO ──────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve frontend from /public
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use(express.json());

// ─── RFID Users API ───────────────────────────────────────────────────────────
app.get('/api/rfid-users', (req, res) => res.json(rfidUsers));

app.post('/api/rfid-users', (req, res) => {
  const { rfid, name, mail, kontoId } = req.body || {};
  if (!rfid || typeof rfid !== 'string') return res.status(400).json({ error: 'rfid ist erforderlich' });
  const rfidClean = rfid.trim().slice(0, 64);
  if (!rfidClean) return res.status(400).json({ error: 'rfid darf nicht leer sein' });
  if (rfidUsers.find(u => u.rfid === rfidClean)) return res.status(409).json({ error: 'RFID bereits vorhanden' });
  rfidUsers.push({
    rfid:    rfidClean,
    name:    String(name    || '').trim().slice(0, 128),
    mail:    String(mail    || '').trim().slice(0, 256),
    kontoId: String(kontoId || '').trim().slice(0, 64),
  });
  saveJSON(RFID_FILE, rfidUsers);
  res.status(201).json(rfidUsers);
});

app.put('/api/rfid-users/:rfid', (req, res) => {
  const idx = rfidUsers.findIndex(u => u.rfid === req.params.rfid);
  if (idx === -1) return res.status(404).json({ error: 'Nicht gefunden' });
  const { name, mail, kontoId } = req.body || {};
  rfidUsers[idx] = {
    rfid:    rfidUsers[idx].rfid,
    name:    String(name    ?? rfidUsers[idx].name).trim().slice(0, 128),
    mail:    String(mail    ?? rfidUsers[idx].mail).trim().slice(0, 256),
    kontoId: String(kontoId ?? rfidUsers[idx].kontoId).trim().slice(0, 64),
  };
  saveJSON(RFID_FILE, rfidUsers);
  res.json(rfidUsers[idx]);
});

app.delete('/api/rfid-users/:rfid', (req, res) => {
  rfidUsers = rfidUsers.filter(u => u.rfid !== req.params.rfid);
  saveJSON(RFID_FILE, rfidUsers);
  res.json({ ok: true });
});

// ─── Notify Config API ────────────────────────────────────────────────────────
app.get('/api/notify-config', (req, res) => res.json(notifyConfig));

app.post('/api/notify-config', (req, res) => {
  notifyConfig = req.body || notifyConfig;
  saveJSON(NOTIFY_FILE, notifyConfig);
  res.json({ ok: true });
});

app.post('/api/test-email', async (req, res) => {
  try {
    const vars = {
      event: 'test', cpId: '0', cpName: 'Test-LP', rfid: 'TEST123',
      userName: 'Max Mustermann', userMail: '', kontoId: 'K001',
      chargeDuration: '37min', importedKwh: '12.50', power: '0',
      timestamp: new Date().toLocaleString('de-DE'), isoTimestamp: new Date().toISOString(),
      message: 'Dies ist eine Test-E-Mail vom openWB Dashboard.',
    };
    await sendEmail(vars);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test-webhook', async (req, res) => {
  try {
    await sendWebhook({
      event: 'test', message: 'Test-Webhook vom openWB Dashboard',
      timestamp: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Import / Export API ─────────────────────────────────────────────────────
app.get('/api/export-config', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="openwb-dashboard-config.json"');
  res.json({ notifyConfig, rfidUsers });
});

app.post('/api/import-config', (req, res) => {
  const { notifyConfig: nc, rfidUsers: ru } = req.body || {};
  if (nc && typeof nc === 'object' && !Array.isArray(nc)) {
    notifyConfig = nc;
    saveJSON(NOTIFY_FILE, notifyConfig);
  }
  if (Array.isArray(ru)) {
    rfidUsers = ru
      .filter(u => u && typeof u.rfid === 'string' && u.rfid.trim())
      .map(u => ({
        rfid:    String(u.rfid).trim().slice(0, 64),
        name:    String(u.name    || '').trim().slice(0, 128),
        mail:    String(u.mail    || '').trim().slice(0, 256),
        kontoId: String(u.kontoId || '').trim().slice(0, 64),
      }));
    saveJSON(RFID_FILE, rfidUsers);
  }
  res.json({ ok: true });
});

// ─── Settings API (MQTT broker etc.) ────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({ mqttBroker: mqttBrokerUrl });
});

app.post('/api/settings', (req, res) => {
  const { mqttBroker } = req.body || {};
  if (mqttBroker !== undefined) {
    if (!/^(mqtt|mqtts|ws|wss):\/\/.+/.test(String(mqttBroker).trim())) {
      return res.status(400).json({ error: 'Ungültige MQTT-Broker-URL. Erlaubte Formate: mqtt://, mqtts://, ws://, wss://' });
    }
    settings.mqttBroker = String(mqttBroker).trim();
    saveJSON(SETTINGS_FILE, settings);
    mqttBrokerUrl = settings.mqttBroker;
    initMqtt(mqttBrokerUrl);
  }
  res.json({ ok: true, mqttBroker: mqttBrokerUrl });
});

// ─── Core API ─────────────────────────────────────────────────────────────────
app.get('/api/state',  (req, res) => res.json(state));
app.get('/api/config', (req, res) => res.json({ broker: mqttBrokerUrl, monitor: notifyConfig.monitor || {} }));

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('state', state);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Push state to all clients every second
setInterval(() => io.emit('state', state), 1000);

// ─── Monitor: plugged + idle (power ≤ threshold) → notify after delay ─────────
setInterval(() => {
  const now = Date.now();
  const monCfg = notifyConfig.monitor || {};
  if (monCfg.enabled === false) return;
  const thresholdW = monCfg.thresholdW ?? 100;
  const delayMs    = (monCfg.delayMinutes ?? 5) * 60 * 1000;

  for (const cp of Object.values(state.chargepoints)) {
    const id = cp.id;
    const idle = cp.plugState === true && cp.rfid &&
                 cp.hasCharged === true &&
                 cp.power != null && Math.abs(cp.power) <= thresholdW;
    if (idle) {
      if (!cp.idleSince) cp.idleSince = now;
      if (!notifiedCps.has(id) && (now - cp.idleSince) >= delayMs) {
        notifiedCps.add(id);
        const user = rfidUsers.find(u => u.rfid === cp.rfid) || null;
        sendNotification(cp, user).catch(e => console.error('monitor notify error:', e.message));
      }
    } else {
      cp.idleSince = null;
      notifiedCps.delete(id);
    }
  }
}, 30_000);

// ─── MQTT ─────────────────────────────────────────────────────────────────────

let mqttClient = null;

function initMqtt(brokerUrl) {
  if (mqttClient) {
    try { mqttClient.end(true); } catch {}
    mqttClient = null;
  }
  console.log(`Connecting to MQTT broker: ${brokerUrl}`);
  const client = mqtt.connect(brokerUrl, {
    clientId: `openwb-dashboard-${Math.random().toString(16).slice(2)}`,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });
  client.on('connect', () => {
    console.log('MQTT connected');
    client.subscribe('openWB/#', { qos: 0 }, (err) => {
      if (err) console.error('Subscribe error:', err);
      else console.log('Subscribed to openWB/#');
    });
  });
  client.on('message', (topic, payload) => {
    try { handleMqttMessage(topic, payload); }
    catch (e) { console.error('Parse error for topic', topic, e.message); }
  });
  client.on('error', (err) => console.error('MQTT error:', err.message));
  client.on('reconnect', () => console.log('MQTT reconnecting...'));
  client.on('offline', () => console.log('MQTT offline'));
  mqttClient = client;
}

initMqtt(mqttBrokerUrl);

// ─── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => console.log(`Dashboard running on http://0.0.0.0:${PORT}`));
