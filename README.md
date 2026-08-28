# BicLex Hub

Self-hosted голосовая комната BicLex: Tauri 2-клиент, Rust/Axum signaling, mediasoup SFU, чат и файлы.

## Текущий этап

Стабильная версия 0.1.36 зафиксирована в `main` и теге `v0.1.36`. Self-hosted разработка ведётся в `feature/self-hosted-chat`.

## Компоненты

- `web/` — Tauri 2 + TypeScript + `mediasoup-client`.
- `server/` — Rust + Axum + Tokio + WebSocket + `mediasoup`.
- `deploy/docker-compose.selfhosted.yml` — автономный server + Coturn.
- `data/` — постоянная история чата и файлы, не попадающие в Git.

## Запуск сервера

Заполните `.env` по образцу `.env.example`. Для self-hosted сервера обязательны `ANNOUNCED_ADDRESS` и секретный `ROOM_TOKEN`:

```powershell
docker compose --project-directory . --env-file .env -f deploy/docker-compose.selfhosted.yml up -d --build
curl http://localhost:8123/health
```

Открыть на Ubuntu/firewall: TCP `8123`, TCP/UDP `3478`, UDP `40000-40300`. Диапазон mediasoup можно переназначить через `RTC_MIN_PORT` и `RTC_MAX_PORT`. Файлы ограничены 100 МБ, чат хранит до 500 последних сообщений.

## Запуск клиента

```powershell
cd web
npm install
npm run dev
```

Для Tauri: `npm run tauri -- dev`. Клиент хранит список серверов и токены в local storage. Пароль Ubuntu используется только во время deploy и не сохраняется.

## Серверы в клиенте

Шестерёнка на экране входа открывает отдельное окно. В нём можно:

- добавить чужой сервер по коду `BicLex-Hub|1|address|token`;
- автоматически развернуть свой сервер на Ubuntu по SSH;
- скопировать код своего сервера для других участников.

Для автодеплоя Ubuntu нужен SSH-доступ и либо `root`, либо пользователь с `sudo`. Первый SSH host key считывается и затем закрепляется для всех команд этого deploy.
