# MemeDrip

MemeDrip est une alternative open-source à MemeDrop.

## Architecture

- `backend/`: bot Discord + serveur WebSocket Socket.IO (Node.js/TypeScript)
- `client/`: application desktop Electron + React/Vite

---

## 1) Configuration Discord

1. Ouvrir le **Discord Developer Portal**
2. Créer une application puis un bot
3. Activer **Message Content Intent** (onglet Bot)
4. Générer l'URL d'invitation (`Scopes: bot`, permissions min: `Read Messages/View Channels`)
5. Inviter le bot sur le serveur Discord
6. Copier le token du bot

---

## 2) Backend (Bot + WebSocket)

### Variables d'environnement

Créer `/home/runner/work/memedrip/memedrip/backend/.env`:

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CHANNEL_IDS=123456789012345678,987654321098765432
WS_PORT=3000
WS_ALLOWED_ORIGINS=*
```

### Lancer en local

```bash
cd /home/runner/work/memedrip/memedrip/backend
npm install
npm run dev
```

### Lancer avec Docker Compose

```bash
cd /home/runner/work/memedrip/memedrip
docker compose up -d --build
```

> Pour un usage externe, placez un reverse proxy (Nginx/Caddy) en HTTPS/WSS avec certificat Let's Encrypt.

---

## 3) Client Desktop (Electron)

```bash
cd /home/runner/work/memedrip/memedrip/client
npm install
npm run dev
```

L'UI permet:

- saisie de l'URL du serveur WebSocket
- statut (pastille verte/rouge)
- réglage du volume
- connexion/déconnexion
- réduction en System Tray

La fenêtre de drop est transparente, sans bordure, toujours au premier plan, et affiche image/GIF/vidéo de façon éphémère.

### Build distribution

```bash
cd /home/runner/work/memedrip/memedrip/client
npm run build
```

Le build renderer est généré dans `client/dist` et le process Electron dans `client/dist-electron`.

---

## Notes infra

- Hébergez le backend sur un VPS pour un service 24/7.
- Activez WSS via reverse proxy pour l'accès des amis depuis internet.
- Distribuez l'exécutable client compilé (.exe/.dmg/.AppImage) via votre canal habituel.
