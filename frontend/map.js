(() => {
const mapSocket = io();

let isEditMode = false;
let mapMarkers = [];
let chargepointsState = {};
let mapmapRfidUserMap = {};
let activeMarkerDetails = null;
let dragMarker = null;

const mapArea = document.getElementById('mapArea');
const mapContent = document.getElementById('mapContent');
const mapImage = document.getElementById('mapImage');
const btnUpload = document.getElementById('btnUpload');
const imageUpload = document.getElementById('imageUpload');
const btnEditToggle = document.getElementById('btnEditToggle');
const btnSave = document.getElementById('btnSave');

const markerModal = document.getElementById('markerModal');
const chargepointSelect = document.getElementById('chargepointSelect');
const btnSaveMarker = document.getElementById('btnSaveMarker');
const btnCancelMarker = document.getElementById('btnCancelMarker');
const btnDeleteMarker = document.getElementById('btnDeleteMarker');

const infoModal = document.getElementById('infoModal');
const infoModalTitle = document.getElementById('infoModalTitle');
const infoModalBody = document.getElementById('infoModalBody');
const btnCloseInfo = document.getElementById('btnCloseInfo');

// --- Initialization ---
async function init() {
    await fetchRfidUsers();
    await fetchMapConfig();
    
    mapSocket.on('state', (state) => {
        chargepointsState = state.chargepoints;
        updateChargepointOptions();
        
        // Block re-rendering all markers if currently dragging a marker
        if (!isDragging && activeMarkerDetails === null) {
            renderMarkers();
        }
    });
}

async function fetchRfidUsers() {
    try {
        const res = await fetch('/api/rfid-users');
        if (res.ok) {
            const users = await res.json();
            mapRfidUserMap = {};
            users.forEach(u => { mapRfidUserMap[u.rfid] = u; });
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
    } catch(e) {
        console.error("Failed to load map config", e);
    }
}

// --- Marker Rendering ---
function renderMarkers() {
    // Keep image, remove old markers
    const elementsToRemove = mapContent.querySelectorAll('.marker');
    elementsToRemove.forEach(el => el.remove());

    mapMarkers.forEach((markerData, index) => {
        const markerEl = document.createElement('div');
        markerEl.className = 'marker';
        markerEl.style.left = markerData.x + '%';
        markerEl.style.top = markerData.y + '%';
        markerEl.dataset.index = index;
        
        // Status resolution
        let cpId = markerData.cpId;
        const cp = chargepointsState[cpId];
        
        let statusClass = 'status-free';
        let statusText = 'Frei';
        let detailText = cpId ? `Ladepunkt ${cpId}` : 'Nicht zugewiesen';
        
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
            
            // User info
            if (cp.rfid && cp.plugState) {
                const user = mapRfidUserMap[cp.rfid];
                const userName = user ? user.name : cp.rfid;
                detailText += ` | ${userName}`;
            }
        }
        
        markerEl.classList.add(statusClass);
        // Show name or fallback to LP ID. If no cpId, show '?'
        markerEl.innerHTML = cpId ? (cp ? cp.name : `LP${cpId}`) : '?';
        
        // Tooltip
        // (Removed hover tooltip as requested)

        // Interaction
        markerEl.addEventListener('mousedown', (e) => onMarkerMouseDown(e, index));
        markerEl.addEventListener('click', (e) => {
            e.stopPropagation(); // prevent map layout click
            if (isEditMode) {
                if (hasDragged) {
                    hasDragged = false;
                    return;
                }
                openMarkerModal(index);
            } else {
                showInfoModal(markerData.cpId);
            }
        });

        mapContent.appendChild(markerEl);
    });
}

let lastChargepointIds = '';
function updateChargepointOptions() {
    const currentIds = Object.keys(chargepointsState).sort().join(',');
    if (currentIds === lastChargepointIds) return; // Only reconstruct DOM if IDs list changed
    lastChargepointIds = currentIds;

    const currentValue = chargepointSelect.value;
    chargepointSelect.innerHTML = '<option value="">-- Keiner --</option>';
    for (const id in chargepointsState) {
        const cp = chargepointsState[id];
        const option = document.createElement('option');
        option.value = id;
        option.textContent = `${cp.name || id} (ID: ${id})`;
        chargepointSelect.appendChild(option);
    }
    chargepointSelect.value = currentValue;
}

// --- Edit Mode & Dragging ---
btnEditToggle.addEventListener('click', () => {
    isEditMode = !isEditMode;
    if (isEditMode) {
        mapArea.classList.add('edit-mode');
        btnEditToggle.textContent = 'Editieren beenden';
        btnSave.style.display = 'inline-block';
    } else {
        mapArea.classList.remove('edit-mode');
        btnEditToggle.textContent = 'Editieren aktivieren';
        btnSave.style.display = 'none';
        renderMarkers();
    }
});

mapArea.addEventListener('click', (e) => {
    if (!isEditMode) return;
    if (e.target !== mapArea && e.target !== mapImage && e.target !== mapContent) return;

    const rect = mapContent.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    mapMarkers.push({ x: x, y: y, cpId: '' });
    renderMarkers();
});

// Drag and drop marker logic natively
let isDragging = false;
let hasDragged = false;
function onMarkerMouseDown(e, index) {
    if (!isEditMode) return;
    dragMarker = index;
    isDragging = true;
    hasDragged = false;
    e.stopPropagation();
    e.preventDefault();
}

window.addEventListener('mousemove', (e) => {
    if (!isDragging || dragMarker === null) return;
    hasDragged = true;
    const rect = mapContent.getBoundingClientRect();
    
    let clientX = Math.max(rect.left, Math.min(e.clientX, rect.right));
    let clientY = Math.max(rect.top, Math.min(e.clientY, rect.bottom));

    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;

    mapMarkers[dragMarker].x = x;
    mapMarkers[dragMarker].y = y;
    
    // Optimistic fast render
    const markerEl = mapContent.querySelector(`.marker[data-index="${dragMarker}"]`);
    if(markerEl) {
        markerEl.style.left = x + '%';
        markerEl.style.top = y + '%';
    }
});

window.addEventListener('mouseup', () => {
    if (isDragging) {
        isDragging = false;
        dragMarker = null;
        // Do NOT call renderMarkers() here, otherwise the DOM element is destroyed before the 'click' event fires.
    }
});


// --- Modal / Assignment ---
function openMarkerModal(index) {
    activeMarkerDetails = index;
    const marker = mapMarkers[index];
    chargepointSelect.value = marker.cpId || '';
    markerModal.style.display = 'flex';
}

function closeMarkerModal() {
    markerModal.style.display = 'none';
    activeMarkerDetails = null;
    renderMarkers(); // re-render to reflect new properties immediately
}

btnSaveMarker.addEventListener('click', () => {
    if (activeMarkerDetails !== null) {
        mapMarkers[activeMarkerDetails].cpId = chargepointSelect.value;
    }
    closeMarkerModal(); // this triggers renderMarkers()
});

btnCancelMarker.addEventListener('click', closeMarkerModal);

btnDeleteMarker.addEventListener('click', () => {
    if (activeMarkerDetails !== null) {
        mapMarkers.splice(activeMarkerDetails, 1);
    }
    closeMarkerModal(); // this triggers renderMarkers()
});

// --- Info Modal ---
function showInfoModal(cpId) {
    if (!cpId) return;
    const cp = chargepointsState[cpId];
    if (!cp) return;

    let statusText = 'Frei';
    if (cp.faultState > 0) statusText = '<strong style="color:#dc3545;">Fehler / Warnung</strong>';
    else if (cp.chargingState) statusText = `<strong style="color:#d39e00;">Lädt (${(cp.power || 0).toFixed(1)} W)</strong>`;
    else if (cp.plugState) statusText = '<strong style="color:#17a2b8;">Verbunden</strong>';

    let userText = '<em>-</em>';
    if (cp.rfid && cp.plugState) {
        const user = mapRfidUserMap[cp.rfid];
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

// --- Upload Image ---
btnUpload.addEventListener('click', () => imageUpload.click());

imageUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        const base64Str = event.target.result;
        // Preview instantly
        mapImage.src = base64Str;
        
        // Save image immediately
        try {
            await fetch('/api/map', {
                method: 'POST',
                headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': 'Basic ' + btoa('admin:openwb2024')
                },
                body: JSON.stringify({ image: base64Str })
            });
            alert('Bild gespeichert!');
        } catch (err) {
            console.error(err);
            alert('Fehler beim Speichern des Bildes.');
        }
    };
    reader.readAsDataURL(file);
});


// --- Save Map Layout ---
btnSave.addEventListener('click', async () => {
    try {
        await fetch('/api/map', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markers: mapMarkers })
        });
        alert('Layout gespeichert!');
        
        isEditMode = false;
        mapArea.classList.remove('edit-mode');
        btnEditToggle.textContent = 'Editieren aktivieren';
        btnSave.style.display = 'none';
        
    } catch (err) {
        console.error(err);
        alert('Fehler beim Speichern des Layouts.');
    }
});

init();
})();
