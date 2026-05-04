const socket = io();

const mapContent = document.getElementById('mapContent');
const infoModal = document.getElementById('infoModal');
const infoModalTitle = document.getElementById('infoModalTitle');
const infoModalBody = document.getElementById('infoModalBody');
const btnCloseInfo = document.getElementById('btnCloseInfo');

let mapMarkers = [];
let chargepointsState = {};
let rfidUserMap = {};

// Socket handling
socket.on('connect', () => {
    fetchMapConfig();
    fetchRfidUsers();
});

socket.on('state', (data) => {
    if (data.chargepoints) {
        chargepointsState = data.chargepoints;
        renderMarkers();
    }
});

socket.on('map-config', (config) => {
    if (config) {
        mapMarkers = config.markers || [];
        renderMarkers();
    }
});

async function fetchRfidUsers() {
    try {
        const res = await fetch('/api/rfid-users');
        if (res.ok) {
            const users = await res.json();
            rfidUserMap = {};
            users.forEach(u => { rfidUserMap[u.rfid] = u; });
        }
    } catch (e) {
        console.error("Failed to fetch RFID users", e);
    }
}

async function fetchMapConfig() {
    try {
        const res = await fetch('/api/map');
        if (res.ok) {
            const mapConfig = await res.json();
            mapMarkers = mapConfig.markers || [];
            renderMarkers();
        }
    } catch (e) {
        console.error("Failed to fetch map config", e);
    }
}

function renderMarkers() {
    // Clear existing
    document.querySelectorAll('.marker').forEach(el => el.remove());

    mapMarkers.forEach((markerData, index) => {
        const markerEl = document.createElement('div');
        
        let cpId = markerData.cpId;
        const cp = chargepointsState[cpId];

        let statusClass = 'status-free';
        let statusText = 'Frei';
        let detailText = cpId;

        if (cp) {
            detailText = cp.name || detailText;
            if (cp.faultState > 0) {
                statusClass = 'status-error';
                statusText = 'Fehler/Warnung';
            } else if (cp.chargingState) {
                statusClass = 'status-charging';
                statusText = `Lädt (${(cp.power || 0).toFixed(1)} W)`;
            } else if (cp.plugState) {
                statusClass = 'status-occupied';
                statusText = 'Verbunden';
            }
        }
        
        markerEl.classList.add('marker');
        markerEl.classList.add(statusClass);
        // Show name or fallback to LP ID. If no cpId, show '?'
        markerEl.innerHTML = cpId ? (cp ? cp.name : `LP${cpId}`) : '?';
        
        // Interaction (View details)
        markerEl.addEventListener('click', (e) => {
            e.stopPropagation();
            openInfoModal(cpId);
        });

        // Set position based on %. Use fit-content on wrapper so image defines aspect ratio.
        markerEl.style.left = `${markerData.x}%`;
        markerEl.style.top = `${markerData.y}%`;
        
        mapContent.appendChild(markerEl);
    });
}

function openInfoModal(cpId) {
    if (!cpId) return;
    const cp = chargepointsState[cpId];
    if (!cp) return;

    let statusText = 'Frei';
    if (cp.faultState > 0) statusText = '<strong style="color:#dc3545;">Fehler / Warnung</strong>';
    else if (cp.chargingState) statusText = `<strong style="color:#d39e00;">Lädt (${(cp.power || 0).toFixed(1)} W)</strong>`;
    else if (cp.plugState) statusText = '<strong style="color:#17a2b8;">Verbunden</strong>';

    let userText = '<em>-</em>';
    if (cp.rfid && cp.plugState) {
        const user = rfidUserMap[cp.rfid];
        userText = user ? `<strong>${user.name}</strong>` : `Unbekannt (${cp.rfid})`;
    }

    infoModalTitle.innerText = cp.name || `Ladepunkt ${cpId}`;
    infoModalBody.innerHTML = `
        <div style="margin-bottom: 5px;">Status: ${statusText}</div>
        <div style="margin-bottom: 5px;">Nutzer: ${userText}</div>
        ${cp.power ? `<div>Leistung: ${(cp.power).toFixed(1)} W</div>` : ''}
    `;
    infoModal.style.display = 'flex';
}

btnCloseInfo.addEventListener('click', () => {
    infoModal.style.display = 'none';
});