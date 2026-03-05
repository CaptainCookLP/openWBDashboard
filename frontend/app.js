'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(value, unit, decimals = 1) {
  if (value === null || value === undefined) return '–';
  return `${parseFloat(value).toFixed(decimals)} ${unit}`;
}

function fmtPower(w) {
  if (w === null || w === undefined) return '–';
  const val = parseFloat(w);
  if (Math.abs(val) >= 1000) return (val / 1000).toFixed(2) + ' kW';
  return val.toFixed(0) + ' W';
}

function fmtPowerLarge(w) {
  if (w === null || w === undefined) return '–';
  const val = parseFloat(w);
  if (Math.abs(val) >= 1000) return (val / 1000).toFixed(2);
  return val.toFixed(0);
}

function fmtPowerUnit(w) {
  if (w === null || w === undefined) return '';
  return Math.abs(parseFloat(w)) >= 1000 ? 'kW' : 'W';
}

function fmtDuration(ms) {
  if (ms == null || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}min`;
  if (m > 0) return `${m}min ${s % 60}s`;
  return `${s}s`;
}

function fmtEnergy(kwh) {
  if (kwh === null || kwh === undefined) return '–';
  return parseFloat(kwh).toFixed(2) + ' kWh';
}

function fmtCurrent(a) {
  if (a === null || a === undefined) return '–';
  return parseFloat(a).toFixed(1) + ' A';
}

function getStateInfo(cp) {
  if (cp.chargingState === true)  return { cls: 'state-charging', badge: 'badge-charging', label: 'Lädt' };
  if (cp.plugState === true)      return { cls: 'state-plugged',  badge: 'badge-plugged',  label: 'Verbunden' };
  if (cp.plugState === false)     return { cls: 'state-idle',     badge: 'badge-idle',     label: 'Frei' };
  return                                   { cls: 'state-unknown', badge: 'badge-unknown',  label: 'Unbekannt' };
}

function maxCurrentForBar(a) {
  if (a === null || a === undefined) return 0;
  const v = parseFloat(a);
  const max = 32;
  return Math.min(100, Math.max(0, (v / max) * 100));
}

// ── DOM Build ─────────────────────────────────────────────────────────────────

function createCpCard(id) {
  const card = document.createElement('div');
  card.className = 'cp-card state-unknown';
  card.id = `cp-${id}`;
  card.innerHTML = `
    <div class="cp-header">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;">
        <span class="cp-id-badge">LP ${id}</span>
        <span class="cp-name" id="cp-${id}-name">Ladepunkt ${id}</span>
      </div>
      <span class="cp-status-badge badge-unknown" id="cp-${id}-badge">Unbekannt</span>
    </div>

    <!-- RFID / Lock row -->
    <div class="cp-rfid-row" id="cp-${id}-rfid-row">
      <div class="cp-lock-pill" id="cp-${id}-lock-pill" style="display:none;">🔒 Gesperrt</div>
      <div class="cp-rfid-pill" id="cp-${id}-rfid-pill" style="display:none;">
        <span class="rfid-icon">🏷️</span>
        <span id="cp-${id}-rfid"></span>
      </div>
    </div>

    <!-- User name + connect time -->
    <div class="cp-user-row" id="cp-${id}-user-row" style="display:none;">
      <span class="cp-user-name" id="cp-${id}-user-name"></span>
      <span class="cp-connect-time" id="cp-${id}-connect-time"></span>
    </div>

    <!-- Countdown (only when plugged + not charging) -->
    <div class="cp-countdown" id="cp-${id}-countdown" style="display:none;">
      <span class="countdown-label">⏱ Benachrichtigung in</span>
      <span class="countdown-val" id="cp-${id}-countdown-val">5:00</span>
    </div>

    <!-- Charged energy -->
    <div class="cp-energy-row" id="cp-${id}-energy-row" style="display:none;">
      <span class="energy-icon">⚡</span>
      <span class="energy-label">Geladen</span>
      <span class="energy-value" id="cp-${id}-energy-val">–</span>
    </div>

    <div class="cp-power-row">
      <span class="cp-power-value" id="cp-${id}-power">–</span>
      <span class="cp-power-unit" id="cp-${id}-power-unit"></span>
    </div>

    <div class="soc-bar-wrap" id="cp-${id}-soc-wrap" style="display:none;">
      <div class="soc-bar-label">
        <span>Fahrzeug-SOC</span>
        <span id="cp-${id}-soc-pct">–</span>
      </div>
      <div class="soc-bar-track">
        <div class="soc-bar-fill" id="cp-${id}-soc-bar" style="width:0%"></div>
      </div>
    </div>

    <div class="cp-phases" id="cp-${id}-phases-wrap" style="display:none;">
      ${['L1','L2','L3'].map((l,i) => `
        <div class="phase-col">
          <span class="phase-label">${l}</span>
          <div class="phase-bar-track">
            <div class="phase-bar-fill" id="cp-${id}-ph${i+1}-bar" style="height:0%"></div>
          </div>
          <span class="phase-val" id="cp-${id}-ph${i+1}-val">–</span>
        </div>
      `).join('')}
    </div>
  `;
  return card;
}

// ── Update Logic ──────────────────────────────────────────────────────────────

function updateGlobal(state) {
  const { grid, pv, battery, house } = state;

  // Grid
  setText('gridPower', grid.power !== undefined ? fmtPower(grid.power) : '–');

  // PV
  setText('pvPower', pv.power !== undefined ? fmtPower(Math.abs(pv.power)) : '–');

  // Battery
  if (battery.power !== undefined) {
    const p = parseFloat(battery.power);
    setText('batPower', fmtPower(p));
    const dir = p < -50 ? ' ↑ Laden' : p > 50 ? ' ↓ Entladen' : ' Standby';
    const socStr = battery.soc !== undefined ? `${parseFloat(battery.soc).toFixed(0)} %${dir}` : dir;
    setText('batSoc', socStr);
  }

  // House
  setText('housePower', house.power !== undefined ? fmtPower(house.power) : '–');

  // All CPs power (compute if not provided directly)
  let allCp = house.cpPower;
  if (allCp === undefined) {
    allCp = Object.values(state.chargepoints)
      .reduce((s, cp) => s + (cp.power !== null ? parseFloat(cp.power) : 0), 0);
  }
  setText('allCpPower', fmtPower(allCp));
}

// RFID user cache (loaded from server, refreshed on settings open)
let rfidUserMap = {}; // rfid -> user object

async function refreshRfidCache() {
  try {
    const users = await (await fetch('/api/rfid-users')).json();
    rfidUserMap = {};
    users.forEach(u => { rfidUserMap[u.rfid] = u; });
  } catch {}
}
refreshRfidCache();
setInterval(refreshRfidCache, 60_000);

// Track which CPs have already shown "Gesendet" to avoid flicker
const cpNotifiedSet = new Set();
let NOTIFY_DELAY_MS = 5 * 60 * 1000; // updated from /api/config on load
let NOTIFY_THRESHOLD_W = 100;         // updated from /api/config on load

// Load monitor config from server once at startup
(async () => {
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (cfg.monitor) {
      NOTIFY_DELAY_MS    = (Number(cfg.monitor.delayMinutes) || 5) * 60 * 1000;
      NOTIFY_THRESHOLD_W = Number(cfg.monitor.thresholdW) || 0;
    }
  } catch {}
})();

function updateChargepoint(id, cp) {
  const card = document.getElementById(`cp-${id}`);
  if (!card) return;

  const info = getStateInfo(cp);
  card.className = `cp-card ${info.cls}`;

  // Header
  setText(`cp-${id}-name`, cp.name || `Ladepunkt ${id}`);
  const badge = document.getElementById(`cp-${id}-badge`);
  if (badge) { badge.className = `cp-status-badge ${info.badge}`; badge.textContent = info.label; }

  // Power
  setText(`cp-${id}-power`,      fmtPowerLarge(cp.power));
  setText(`cp-${id}-power-unit`, fmtPowerUnit(cp.power));

  // Lock pill (top-left)
  const lockPill = document.getElementById(`cp-${id}-lock-pill`);
  if (lockPill) lockPill.style.display = cp.manualLock === true ? '' : 'none';

  // RFID pill (next to lock)
  const rfidPill = document.getElementById(`cp-${id}-rfid-pill`);
  if (rfidPill) {
    if (cp.rfid) {
      rfidPill.style.display = '';
      setText(`cp-${id}-rfid`, cp.rfid);
    } else {
      rfidPill.style.display = 'none';
    }
  }

  // User name row + connect time  — use server-side pluggedSince for accurate duration
  const plugged = cp.plugState === true;
  const now = Date.now();
  // pluggedSince is a server unix-ms timestamp; use it directly so the timer
  // is anchored to when the car actually connected, not when the browser loaded.
  const pluggedSince = cp.pluggedSince || null;

  const userRow = document.getElementById(`cp-${id}-user-row`);
  const user = cp.rfid ? rfidUserMap[cp.rfid] : null;
  if (userRow) {
    if (plugged && (user || cp.rfid)) {
      userRow.style.display = '';
      setText(`cp-${id}-user-name`, user?.name || cp.rfid || '');
      setText(`cp-${id}-connect-time`, pluggedSince ? fmtDuration(now - pluggedSince) : '');
    } else {
      userRow.style.display = 'none';
    }
  }

  // Countdown: use server-side idleSince (set when plugged + power ≤ threshold + rfid)
  const countdownEl = document.getElementById(`cp-${id}-countdown`);
  const countdownVal = document.getElementById(`cp-${id}-countdown-val`);
  const idleSince = cp.idleSince || null;
  if (countdownEl) {
    if (idleSince && plugged && cp.rfid) {
      const elapsed   = now - idleSince;
      const remaining = Math.max(0, NOTIFY_DELAY_MS - elapsed);
      countdownEl.style.display = '';
      if (countdownVal) {
        if (remaining === 0) {
          cpNotifiedSet.add(id);
          countdownVal.textContent = 'Gesendet ✓';
        } else {
          cpNotifiedSet.delete(id);
          const rm = Math.floor(remaining / 1000);
          countdownVal.textContent = `${Math.floor(rm / 60)}:${String(rm % 60).padStart(2,'0')}`;
        }
      }
    } else {
      countdownEl.style.display = 'none';
      cpNotifiedSet.delete(id);
    }
  }

  // Charged energy (from log topic: imported_since_plugged in Wh)
  const energyRow = document.getElementById(`cp-${id}-energy-row`);
  if (energyRow) {
    if (cp.importedSincePlugged != null && plugged) {
      energyRow.style.display = '';
      setText(`cp-${id}-energy-val`, (cp.importedSincePlugged / 1000).toFixed(2) + ' kWh');
    } else {
      energyRow.style.display = 'none';
    }
  }

  // SOC bar
  const socWrap = document.getElementById(`cp-${id}-soc-wrap`);
  if (cp.soc !== null && cp.soc !== undefined) {
    if (socWrap) socWrap.style.display = 'block';
    const pct = Math.min(100, Math.max(0, parseFloat(cp.soc)));
    setText(`cp-${id}-soc-pct`, pct.toFixed(0) + ' %');
    setStyle(`cp-${id}-soc-bar`, 'width', pct + '%');
  } else {
    if (socWrap) socWrap.style.display = 'none';
  }

  // Phase bars
  const phWrap = document.getElementById(`cp-${id}-phases-wrap`);
  const hasPhaseCurrent = cp.current1 !== null || cp.current2 !== null || cp.current3 !== null;
  if (hasPhaseCurrent) {
    if (phWrap) phWrap.style.display = 'flex';
    [1, 2, 3].forEach(p => {
      const v = cp[`current${p}`];
      setText(`cp-${id}-ph${p}-val`, fmtCurrent(v));
      setStyle(`cp-${id}-ph${p}-bar`, 'height', maxCurrentForBar(v) + '%');
    });
  } else {
    if (phWrap) phWrap.style.display = 'none';
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function setStyle(id, prop, value) {
  const el = document.getElementById(id);
  if (el) el.style[prop] = value;
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────

const renderedIds = new Set();

function sortGrid() {
  const grid = document.getElementById('cpGrid');
  if (!grid) return;
  const cards = Array.from(grid.children);
  cards.sort((a, b) => {
    const nameA = a.querySelector('.cp-name')?.textContent || '';
    const nameB = b.querySelector('.cp-name')?.textContent || '';
    return nameA.localeCompare(nameB, 'de');
  });
  cards.forEach(c => grid.appendChild(c));
}

const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  const dot = document.querySelector('.dot');
  const label = document.getElementById('connLabel');
  if (dot)   { dot.className = 'dot connected'; }
  if (label) label.textContent = 'Verbunden';
});

socket.on('disconnect', () => {
  const dot = document.querySelector('.dot');
  const label = document.getElementById('connLabel');
  if (dot)   { dot.className = 'dot disconnected'; }
  if (label) label.textContent = 'Verbindung getrennt';
});

socket.on('connect_error', () => {
  const dot = document.querySelector('.dot');
  const label = document.getElementById('connLabel');
  if (dot)   { dot.className = 'dot connecting'; }
  if (label) label.textContent = 'Verbinde…';
});

socket.on('state', (state) => {
  updateGlobal(state);

  const ids = Object.keys(state.chargepoints).map(Number);
  ids.forEach(id => {
    if (!renderedIds.has(id)) {
      const grid = document.getElementById('cpGrid');
      if (grid) grid.appendChild(createCpCard(id));
      renderedIds.add(id);
    }
    updateChargepoint(id, state.chargepoints[id]);
  });

  sortGrid();
  setText('lastUpdate', new Date().toLocaleTimeString('de-DE'));
});

// ── Init ──────────────────────────────────────────────────────────────────────

// Chargepoints are discovered dynamically via socket state events

// ── Tab Navigation ───────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('[id^="tab-"]').forEach(el => el.style.display = 'none');
    document.getElementById(`tab-${tab}`).style.display = '';
    if (tab === 'settings') loadSettings();
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

function showFeedback(elId, msg, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = 'settings-feedback ' + (isError ? 'feedback-error' : 'feedback-ok');
  setTimeout(() => { el.textContent = ''; el.className = 'settings-feedback'; }, 4000);
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function apiDelete(url) {
  const res = await fetch(url, { method: 'DELETE' });
  return res.json();
}
async function apiPut(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── RFID Table ────────────────────────────────────────────────────────────────

function renderRfidTable(users) {
  const tbody = document.getElementById('rfidTbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Keine Einträge</td></tr>';
    return;
  }
  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.dataset.rfid = u.rfid;
    tr.innerHTML = `
      <td class="col-mono">${esc(u.rfid)}</td>
      <td contenteditable="true" class="editable" data-field="name">${esc(u.name)}</td>
      <td contenteditable="true" class="editable" data-field="mail">${esc(u.mail)}</td>
      <td contenteditable="true" class="editable" data-field="kontoId">${esc(u.kontoId)}</td>
      <td><button class="btn btn-danger btn-sm" data-action="delete">Löschen</button>
          <button class="btn btn-secondary btn-sm" data-action="save" style="margin-left:4px">✓</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const rfid = tr?.dataset.rfid;
    if (!rfid) return;
    if (btn.dataset.action === 'delete') {
      if (!confirm(`RFID "${rfid}" löschen?`)) return;
      try {
        await apiDelete(`/api/rfid-users/${encodeURIComponent(rfid)}`);
        showFeedback('rfidFeedback', 'Gelöscht.');
        await reloadRfid();
      } catch (err) { showFeedback('rfidFeedback', err.message, true); }
    }
    if (btn.dataset.action === 'save') {
      const cells = tr.querySelectorAll('[data-field]');
      const upd = {};
      cells.forEach(td => { upd[td.dataset.field] = td.textContent.trim(); });
      try {
        await apiPut(`/api/rfid-users/${encodeURIComponent(rfid)}`, upd);
        showFeedback('rfidFeedback', 'Gespeichert.');
      } catch (err) { showFeedback('rfidFeedback', err.message, true); }
    }
  }, { once: false });
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function reloadRfid() {
  const res = await fetch('/api/rfid-users');
  const users = await res.json();
  renderRfidTable(users);
}

document.getElementById('rfidForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    rfid:    document.getElementById('rfidNew').value.trim(),
    name:    document.getElementById('rfidName').value.trim(),
    mail:    document.getElementById('rfidMail').value.trim(),
    kontoId: document.getElementById('rfidKonto').value.trim(),
  };
  try {
    await apiPost('/api/rfid-users', body);
    e.target.reset();
    showFeedback('rfidFeedback', 'Hinzugefügt.');
    await reloadRfid();
  } catch (err) { showFeedback('rfidFeedback', err.message, true); }
});

// ── SMTP Form ─────────────────────────────────────────────────────────────────

function populateSmtp(smtp) {
  const form = document.getElementById('smtpForm');
  if (!form || !smtp) return;
  ['host','port','user','pass','from','to','emailSubject','emailBody'].forEach(k => {
    if (form.elements[k]) form.elements[k].value = smtp[k] ?? '';
  });
  if (form.elements['secure']) form.elements['secure'].checked = !!smtp.secure;
  const enabledEl = document.getElementById('smtpEnabled');
  if (enabledEl) enabledEl.checked = smtp.enabled !== false;
}

document.getElementById('smtpForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const smtp = {
    enabled:      document.getElementById('smtpEnabled')?.checked !== false,
    host:         form.elements['host'].value.trim(),
    port:         Number(form.elements['port'].value) || 587,
    secure:       form.elements['secure'].checked,
    user:         form.elements['user'].value.trim(),
    pass:         form.elements['pass'].value,
    from:         form.elements['from'].value.trim(),
    to:           form.elements['to'].value.trim(),
    emailSubject: form.elements['emailSubject'].value.trim(),
    emailBody:    form.elements['emailBody'].value,
  };
  try {
    const cfg = await (await fetch('/api/notify-config')).json();
    await apiPost('/api/notify-config', { ...cfg, smtp });
    showFeedback('smtpFeedback', 'SMTP-Einstellungen gespeichert.');
  } catch (err) { showFeedback('smtpFeedback', err.message, true); }
});

document.getElementById('testEmailBtn')?.addEventListener('click', async () => {
  try {
    await apiPost('/api/test-email', {});
    showFeedback('smtpFeedback', 'Test-E-Mail erfolgreich gesendet ✓');
  } catch (err) { showFeedback('smtpFeedback', 'Fehler: ' + err.message, true); }
});

// ── Webhook Form ──────────────────────────────────────────────────────────────

function populateWebhook(webhook) {
  const form = document.getElementById('webhookForm');
  if (!form || !webhook) return;
  ['url','headers','template'].forEach(k => {
    if (form.elements[k]) form.elements[k].value = webhook[k] ?? '';
  });
  const enabledEl = document.getElementById('webhookEnabled');
  if (enabledEl) enabledEl.checked = webhook.enabled !== false;
}

document.getElementById('webhookForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const webhook = {
    enabled:  document.getElementById('webhookEnabled')?.checked !== false,
    url:      form.elements['url'].value.trim(),
    headers:  form.elements['headers'].value.trim() || '{}',
    template: form.elements['template'].value.trim(),
  };
  try {
    const cfg = await (await fetch('/api/notify-config')).json();
    await apiPost('/api/notify-config', { ...cfg, webhook });
    showFeedback('webhookFeedback', 'Webhook-Einstellungen gespeichert.');
  } catch (err) { showFeedback('webhookFeedback', err.message, true); }
});

document.getElementById('testWebhookBtn')?.addEventListener('click', async () => {
  try {
    await apiPost('/api/test-webhook', {});
    showFeedback('webhookFeedback', 'Test-Webhook erfolgreich gesendet ✓');
  } catch (err) { showFeedback('webhookFeedback', 'Fehler: ' + err.message, true); }
});

// ── Load all settings ─────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    await reloadRfid();
    const cfg = await (await fetch('/api/notify-config')).json();
    populateSmtp(cfg.smtp);
    populateWebhook(cfg.webhook);
    populateMonitor(cfg.monitor);
  } catch (e) { console.error('loadSettings error:', e); }
}

// ── Monitor Form ────────────────────────────────────────────────────────────────

function populateMonitor(monitor) {
  const form = document.getElementById('monitorForm');
  if (!form || !monitor) return;
  if (form.elements['delayMinutes']) form.elements['delayMinutes'].value = monitor.delayMinutes ?? 5;
  if (form.elements['thresholdW'])  form.elements['thresholdW'].value  = monitor.thresholdW  ?? 100;
  const enabledEl = document.getElementById('monitorEnabled');
  if (enabledEl) enabledEl.checked = monitor.enabled !== false;
}

document.getElementById('monitorForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const monitor = {
    enabled:      document.getElementById('monitorEnabled')?.checked !== false,
    delayMinutes: Number(form.elements['delayMinutes'].value) || 5,
    thresholdW:   Number(form.elements['thresholdW'].value)  || 0,
  };
  try {
    const cfg = await (await fetch('/api/notify-config')).json();
    await apiPost('/api/notify-config', { ...cfg, monitor });
    // Update local countdown config immediately
    NOTIFY_DELAY_MS    = monitor.delayMinutes * 60 * 1000;
    NOTIFY_THRESHOLD_W = monitor.thresholdW;
    showFeedback('monitorFeedback', 'Monitor-Einstellungen gespeichert.');
  } catch (err) { showFeedback('monitorFeedback', err.message, true); }
});

// ── Import / Export ──────────────────────────────────────────────────────────

document.getElementById('importFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await apiPost('/api/import-config', data);
    showFeedback('importFeedback', 'Konfiguration importiert ✓');
    await loadSettings();
  } catch (err) {
    showFeedback('importFeedback', 'Importfehler: ' + err.message, true);
  }
  e.target.value = ''; // reset so same file can be re-imported
});
