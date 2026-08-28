# Biclex Hub

Внутренний голосовой клиент Biclex: одна комната `main`, Tauri 2-клиент и Rust SFU-сервер.

## Текущий этап

MVP голосовой комнаты реализован: WebSocket signaling, mediasoup SFU, один Opus-аудиопоток на участника, mute/unmute и список пользователей.

## Компоненты

- `web/` — Tauri 2 + TypeScript + `mediasoup-client`.
- `server/` — Rust + Axum + Tokio + WebSocket + `mediasoup`.
- `docker-compose.yml` — локальный запуск server.

## Запуск сервера

Заполните `ANNOUNCED_ADDRESS` в `.env` публичным DNS-именем или IP сервера, затем:

```powershell
docker compose up -d --build
curl http://localhost:8123/health
```

Сервер публикует TCP `8123` и UDP `40000-40100`. TCP `8123` нужен для доступа Nginx Proxy Manager к signaling; наружу клиент должен подключаться по `wss://<домен>/ws`.

## Запуск клиента

```powershell
cd web
npm install
npm run dev
```

Для Tauri: `npm run tauri -- dev`. Перед production-сборкой задайте `VITE_SIGNALING_URL=wss://<домен>/ws`.
