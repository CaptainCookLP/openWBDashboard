# openWB Dashboard

Ein selbst gehostetes Echtzeit-Dashboard für [openWB](https://openwb.de) Wallboxen.  
Empfängt MQTT-Nachrichten direkt vom openWB-Broker und zeigt Lade- und Energiedaten übersichtlich im Browser an.

![Dashboard Screenshot](docs/screenshot.png)

---

## Features

- **Echtzeit-Übersicht** – Netz, PV, Speicher, Hausverbrauch und alle Ladepunkte live via WebSocket
- **Mehrere Ladepunkte** – werden automatisch aus dem MQTT-Stream erkannt (openWB v1 & v2)
- **Fahrzeug-SOC** – Ladezustandsanzeige per Balken
- **RFID-Verwaltung** – RFID-Tags mit Name, E-Mail und Konto-ID verwalten
- **Fehleranzeige** – `fault_state` je Ladepunkt wird direkt auf der Karte angezeigt
- **Benachrichtigungen** – E-Mail (SMTP) und Webhook, wenn ein Fahrzeug nach einem Ladevorgang weiter verbunden bleibt
  - Countdown-Anzeige im Dashboard (startet erst nach mindestens einem aktiven Ladevorgang)
- **Einstellungen im Browser**
  - MQTT-Broker-Adresse (ohne Container-Neustart änderbar)
  - SMTP- und Webhook-Konfiguration
  - Konfiguration exportieren / importieren
- **Docker-basiert** – einfacher Betrieb, kein Node.js auf dem Host nötig

---

## Voraussetzungen

| Anforderung | Version |
|-------------|---------|
| Docker      | ≥ 20    |
| Docker Compose | ≥ 2 (Plugin) oder ≥ 1.29 (standalone) |
| openWB      | v1 oder v2, MQTT-Broker erreichbar |

---

## Schnellstart

```bash
# 1. Repository klonen
git clone https://github.com/DEIN-USER/openWBDashboard.git
cd openWBDashboard

# 2. (Optional) MQTT-Broker im Compose-File anpassen
#    Standardwert: mqtt://10.100.95.10:1883
#    Alternativ direkt im Dashboard unter ⚙️ Einstellungen → MQTT-Broker einstellen

# 3. Container bauen und starten
docker compose up -d --build

# 4. Dashboard öffnen
http://DEINE-SERVER-IP:3000
```

Logs ansehen:
```bash
docker compose logs -f
```

---

## Installationsanleitung (Schritt für Schritt)

### 1. Docker installieren (Debian/Ubuntu)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Neu anmelden, damit die Gruppenänderung aktiv wird
```

### 2. Repository klonen

```bash
git clone https://github.com/DEIN-USER/openWBDashboard.git
cd openWBDashboard
```

### 3. MQTT-Broker konfigurieren

**Option A – `docker-compose.yml` bearbeiten** (empfohlen beim Erststart):

```yaml
environment:
  - MQTT_BROKER=mqtt://192.168.1.50:1883   # IP deiner openWB anpassen
  - PORT=3000
```

**Option B – Im laufenden Dashboard ändern** (kein Neustart nötig):  
Einstellungen → 📡 MQTT-Broker → neue URL eingeben → „Speichern & Verbinden"

### 4. Container starten

```bash
docker compose up -d --build
```

Beim ersten Start wird das Docker-Image gebaut (~1–2 Minuten).

### 5. Dashboard aufrufen

```
http://<SERVER-IP>:3000
```

### 6. Aktualisieren

```bash
git pull
docker compose up -d --build
```

---

## Konfiguration

### Persistente Daten

Alle Konfigurationsdaten werden unter `./data/` gespeichert (Docker-Volume):

| Datei | Inhalt |
|-------|--------|
| `data/rfid-users.json` | RFID-Benutzerliste |
| `data/notify-config.json` | SMTP / Webhook / Monitor-Einstellungen |
| `data/settings.json` | MQTT-Broker-URL (UI-Einstellung) |

### Umgebungsvariablen (`docker-compose.yml`)

| Variable | Standardwert | Beschreibung |
|----------|-------------|--------------|
| `MQTT_BROKER` | `mqtt://10.100.95.10:1883` | Fallback-Broker (wenn kein `data/settings.json` vorhanden) |
| `PORT` | `3000` | HTTP-Port des Dashboards |
| `DATA_DIR` | `/app/data` | Pfad zum Daten-Verzeichnis im Container |

### MQTT-Topics

Das Dashboard abonniert `openWB/#` und verarbeitet folgende Topics:

| Topic | Beschreibung |
|-------|-------------|
| `openWB/chargepoint/{n}/get/power` | Ladeleistung |
| `openWB/chargepoint/{n}/get/plug_state` | Stecker verbunden |
| `openWB/chargepoint/{n}/get/charge_state` | Ladevorgang aktiv |
| `openWB/chargepoint/{n}/get/imported` | Geladene Energie |
| `openWB/chargepoint/{n}/get/fault_state` | Fehlerstatus (0=OK, 1=Warnung, 2=Fehler) |
| `openWB/chargepoint/{n}/get/connected_vehicle/soc` | Fahrzeug-SOC |
| `openWB/counter/set/home_consumption` | Hausverbrauch |
| `openWB/counter/0/get/power` | Netzbezug/-einspeisung |
| `openWB/pv/get/power` | PV-Leistung |
| `openWB/bat/get/power` | Speicher-Leistung |
| `openWB/bat/get/soc` | Speicher-SOC |

---

## Benachrichtigungen

Das Dashboard sendet eine Benachrichtigung, wenn:
1. Ein Fahrzeug mit RFID verbunden ist **und**
2. **Mindestens ein Ladevorgang stattgefunden hat** **und**
3. Die Ladeleistung unter den konfigurierten Schwellwert fällt **und**
4. Dieser Zustand länger als die konfigurierte Verzögerung anhält

### SMTP (E-Mail)

Einstellungen → ✉️ E-Mail (SMTP)

| Feld | Beschreibung |
|------|-------------|
| SMTP-Host | z.B. `smtp.gmail.com` |
| Port | z.B. `587` (STARTTLS) oder `465` (SSL) |
| Benutzer / Passwort | SMTP-Zugangsdaten |
| Empfänger | Fallback-E-Mail-Adresse |

Verfügbare Template-Variablen im Betreff und HTML-Body:
`{{cpName}}`, `{{cpId}}`, `{{rfid}}`, `{{userName}}`, `{{userMail}}`, `{{kontoId}}`, `{{chargeDuration}}`, `{{importedKwh}}`, `{{rangeCharged}}`, `{{power}}`, `{{timestamp}}`

### Webhook

Einstellungen → 🔗 Webhook

Sendet einen HTTP POST an die konfigurierte URL mit JSON-Payload.  
Optional: eigenes Body-Template mit denselben Variablen wie bei E-Mail.

---

## Sicherheitshinweise

> ⚠️ **Das Dashboard ist für den Betrieb im lokalen Netzwerk ausgelegt.**

- **Keine Authentifizierung** eingebaut – wer Port 3000 erreichen kann, hat vollen Zugriff
- **Nicht direkt ins Internet exposieren** ohne vorgeschalteten Reverse-Proxy mit Auth
  - Empfehlung: nginx oder Traefik mit Basic Auth oder OAuth2 Proxy
- **CORS**: Socket.IO akzeptiert Verbindungen von allen Origins (`*`) – in einer internen Netzwerkumgebung unkritisch
- **Webhook-SSRF**: Der Server führt HTTP-Requests an die konfigurierte Webhook-URL aus – nur vertrauenswürdige URLs eintragen
- **Empfehlung für Produktionsumgebung**: Firewall-Regel, die Port 3000 nur im LAN erreichbar macht

---

## Entwicklung (ohne Docker)

```bash
# Abhängigkeiten installieren
cd backend
npm install

# Backend starten (MQTT_BROKER muss erreichbar sein)
MQTT_BROKER=mqtt://192.168.1.50:1883 node server.js
```

Das Frontend liegt unter `frontend/` und wird direkt vom Express-Server ausgeliefert.

---

## Docker-Image manuell bauen

```bash
docker build --pull --rm -f backend/Dockerfile -t openwbdashboard:latest .
```

---

## Projektstruktur

```
openWBDashboard/
├── backend/
│   ├── server.js          # Express + Socket.IO + MQTT Backend
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── index.html         # Haupt-UI
│   ├── app.js             # Frontend-Logik (Socket.IO, DOM-Updates)
│   ├── style.css          # Dark-Theme Stylesheet
│   └── station.html/.js/.css  # Einzelansicht (Ladepunkt)
├── data/                  # Persistente Daten (Docker-Volume)
├── docker-compose.yml
└── README.md
```

---

## Lizenz

MIT
