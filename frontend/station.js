'use strict';

/*  Station Display – shows exactly 2 chargepoints side-by-side.
 *
 *  Usage:  /station.html?cps=7,8          (explicit CP IDs)
 *          /station.html?station=3         (station 3 → CPs 7,8 – see stationMap)
 *          /station.html?cps=7,8&name=Ladesäule+C
 *
 *  The station ↔ CP mapping can be customised via the stationMap below or
 *  overridden with ?cps= query params at any time.
 */

// ── Config ────────────────────────────────────────────────────────────────────

// Default mapping: station number → [leftCpId, rightCpId]
// Adjust these to match your physical wiring!
const stationMap = {
  1: [1, 2],
  2: [7, 8],
  3: [9, 10],
  4: [11, 12],
};

const POPUP_DURATION_MS = 5000;   // how long the RFID popup stays visible

// ── Parse URL params ──────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
let leftId, rightId, stationName;

if (params.has('cps')) {
  const ids = params.get('cps').split(',').map(Number).filter(n => !isNaN(n));
  leftId  = ids[0] ?? null;
  rightId = ids[1] ?? null;
} else if (params.has('station')) {
  const sn = Number(params.get('station'));
  const pair = stationMap[sn];
  if (pair) { leftId = pair[0]; rightId = pair[1]; }
}

stationName = params.get('name') || (params.has('station') ? `Ladesäule ${params.get('station')}` : null);

if (!leftId || !rightId) {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;color:#94a3b8;font-family:sans-serif;">
      <h2 style="color:#e8ecf4">Ladesäulen-Anzeige</h2>
      <p>Bitte Ladepunkte als URL-Parameter angeben:</p>
      <code style="background:#1f2333;padding:8px 16px;border-radius:8px;color:#4f8ef7">/station.html?cps=7,8</code>
      <p>oder</p>
      <code style="background:#1f2333;padding:8px 16px;border-radius:8px;color:#4f8ef7">/station.html?station=2</code>
      <p style="margin-top:16px;font-size:.85rem;color:#6b7280">Verfügbare Stationen: ${Object.entries(stationMap).map(([k,v]) => `${k} → LP ${v[0]}+${v[1]}`).join(' | ')}</p>
    </div>`;
  throw new Error('Missing CP ids');
}

// Set header title
if (stationName) {
  document.getElementById('stationTitle').textContent = stationName;
}
document.title = `${stationName || `LP ${leftId}+${rightId}`} – openWB`;

// Set initial LP labels
document.getElementById('leftId').textContent  = `LP ${leftId}`;
document.getElementById('rightId').textContent = `LP ${rightId}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPower(w) {
  if (w == null) return '–';
  const v = parseFloat(w);
  return Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) : v.toFixed(0);
}
function fmtPowerUnit(w) {
  if (w == null) return '';
  return Math.abs(parseFloat(w)) >= 1000 ? 'kW' : 'W';
}
function fmtDuration(ms) {
  if (ms == null || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}min`;
  if (m > 0) return `${m}min`;
  return `${s}s`;
}
function fmtCurrent(a) {
  if (a == null) return '–';
  return parseFloat(a).toFixed(1) + ' A';
}
function txt(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function stateInfo(cp) {
  if (cp.chargingState)   return { cls: 'state-charging', badge: 'badge-charging', label: 'Lädt' };
  if (cp.plugState)       return { cls: 'state-plugged',  badge: 'badge-plugged',  label: 'Verbunden' };
  if (cp.plugState === false) return { cls: 'state-idle', badge: 'badge-idle',     label: 'Frei' };
  return { cls: 'state-unknown', badge: 'badge-unknown', label: 'Unbekannt' };
}

// ── RFID User Cache ───────────────────────────────────────────────────────────

let rfidUserMap = {};

async function refreshRfidCache() {
  try {
    const users = await (await fetch('/api/rfid-users')).json();
    rfidUserMap = {};
    users.forEach(u => { rfidUserMap[u.rfid] = u; });
  } catch {}
}
refreshRfidCache();
setInterval(refreshRfidCache, 60_000);

// ── Clock ─────────────────────────────────────────────────────────────────────

function updateClock() {
  txt('clock', new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
}
updateClock();
setInterval(updateClock, 10_000);

// ── Panel Update ──────────────────────────────────────────────────────────────

// Track previous RFID per side to detect new logins
const prevRfid = { left: null, right: null };

function updatePanel(side, cp) {
  if (!cp) return;

  const info = stateInfo(cp);
  const inner = document.querySelector(`#panel${cap(side)} .panel-inner`);
  if (inner) inner.className = `panel-inner ${info.cls}`;

  // Header
  txt(`${side}Name`, cp.name || `Ladepunkt ${cp.id}`);
  const badge = document.getElementById(`${side}Badge`);
  if (badge) { badge.className = `panel-badge ${info.badge}`; badge.textContent = info.label; }

  // Power
  txt(`${side}Power`,     fmtPower(cp.power));
  txt(`${side}PowerUnit`, fmtPowerUnit(cp.power));

  // User row
  const user = cp.rfid ? rfidUserMap[cp.rfid] : null;
  const userRow = document.getElementById(`${side}User`);
  if (userRow) {
    if (cp.rfid && (user || cp.plugState)) {
      userRow.style.display = '';
      txt(`${side}UserName`, user?.name || cp.rfid);
    } else {
      userRow.style.display = 'none';
    }
  }

  // Stats
  const now = Date.now();
  const plugDur = cp.pluggedSince ? fmtDuration(now - cp.pluggedSince) : '–';
  const energy  = cp.importedSincePlugged != null
    ? (cp.importedSincePlugged / 1000).toFixed(2) + ' kWh'
    : '–';
  txt(`${side}Energy`,   energy);
  txt(`${side}Duration`, plugDur);
  txt(`${side}Soc`,      cp.soc != null ? `${parseFloat(cp.soc).toFixed(0)} %` : '–');
  txt(`${side}Rfid`,     cp.rfid || '–');

  // Phases
  const hasPh = cp.current1 != null || cp.current2 != null || cp.current3 != null;
  const phEl = document.getElementById(`${side}Phases`);
  if (phEl) phEl.style.display = hasPh ? 'flex' : 'none';
  if (hasPh) {
    txt(`${side}Ph1`, fmtCurrent(cp.current1));
    txt(`${side}Ph2`, fmtCurrent(cp.current2));
    txt(`${side}Ph3`, fmtCurrent(cp.current3));
  }

  // ── RFID Login Popup ──
  checkRfidPopup(side, cp);
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── RFID Popup Logic ──────────────────────────────────────────────────────────

let popupTimer = null;

function checkRfidPopup(side, cp) {
  const rfid = cp.rfid || null;
  const prev = prevRfid[side];

  // Detect new RFID (wasn't there before, or changed)
  if (rfid && rfid !== prev) {
    const user = rfidUserMap[rfid] || null;
    showPopup(cp, user);
  }
  prevRfid[side] = rfid;
}

function showPopup(cp, user) {
  const overlay = document.getElementById('popupOverlay');
  if (!overlay) return;

  txt('popupUser',  user?.name || cp.rfid || '–');
  txt('popupCp',    cp.name || `LP ${cp.id}`);
  txt('popupRfid',  cp.rfid || '–');
  txt('popupKonto', user?.kontoId || '–');
  document.getElementById('popupTitle').textContent =
    user?.name ? `Willkommen, ${user.name.split(' ')[0]}!` : 'Fahrzeug erkannt';

  overlay.classList.add('visible');
  if (popupTimer) clearTimeout(popupTimer);
  popupTimer = setTimeout(() => {
    overlay.classList.remove('visible');
    popupTimer = null;
  }, POPUP_DURATION_MS);
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────

const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  const dot = document.getElementById('connDot');
  if (dot) dot.className = 'conn-dot connected';
});
socket.on('disconnect', () => {
  const dot = document.getElementById('connDot');
  if (dot) dot.className = 'conn-dot disconnected';
});
socket.on('connect_error', () => {
  const dot = document.getElementById('connDot');
  if (dot) dot.className = 'conn-dot connecting';
});

socket.on('state', (state) => {
  const cps = state.chargepoints || {};
  updatePanel('left',  cps[leftId]  || null);
  updatePanel('right', cps[rightId] || null);
});
