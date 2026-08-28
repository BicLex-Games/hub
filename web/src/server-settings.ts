import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  createConnectionCode,
  loadServers,
  normalizeAddress,
  parseConnectionCode,
  saveServers,
  selectServer,
  uniqueServerName,
  type HubServer,
} from "./servers";
import teamLogoUrl from "./assets/biclex-team-logo.png";
import "./server-settings.css";

type DeployProgress = { stage: string; message: string };
type DeployResult = { address: string; token: string };

document.title = "Серверы — BicLex Hub";
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main class="settings-shell">
    <header><img src="${teamLogoUrl}" alt="BicLex"/><div><h1>Серверы BicLex</h1><p>Подключение и развёртывание self-hosted комнат</p></div></header>
    <div class="settings-actions"><button id="add-server">Добавить</button><button id="create-server" class="primary">Создать сервер</button></div>
    <section id="server-form" class="server-form" hidden></section>
    <p id="settings-error" class="settings-error"></p>
    <ul id="server-list" class="server-list"></ul>
  </main>`;

const list = document.querySelector<HTMLUListElement>("#server-list")!;
const form = document.querySelector<HTMLElement>("#server-form")!;
const error = document.querySelector<HTMLParagraphElement>("#settings-error")!;

function setError(message = "") {
  error.textContent = message;
}
function id() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
async function changed(serverId?: string) {
  if (serverId) selectServer(serverId);
  render();
  await emit("servers-updated").catch(() => undefined);
}
function render() {
  list.replaceChildren();
  for (const server of loadServers()) {
    const item = document.createElement("li");
    item.innerHTML = `<div><strong></strong><span class="badges"></span><small></small></div><div class="server-actions"><button class="select">Выбрать</button>${server.owned ? '<button class="share">Поделиться</button>' : ""}${server.builtin ? "" : '<button class="remove">Удалить</button>'}</div>`;
    item.querySelector("strong")!.textContent = server.name;
    item.querySelector("small")!.textContent = server.address;
    item.querySelector(".badges")!.textContent = server.owned
      ? "Мой сервер"
      : "Добавленный";
    item.querySelector<HTMLButtonElement>(".select")!.onclick = () =>
      void changed(server.id);
    const share = item.querySelector<HTMLButtonElement>(".share");
    if (share)
      share.onclick = async () => {
        await navigator.clipboard.writeText(createConnectionCode(server));
        share.textContent = "Код скопирован";
        window.setTimeout(() => (share.textContent = "Поделиться"), 1400);
      };
    const remove = item.querySelector<HTMLButtonElement>(".remove");
    if (remove)
      remove.onclick = () => {
        saveServers(loadServers().filter((entry) => entry.id !== server.id));
        void changed();
      };
    list.append(item);
  }
}

document.querySelector<HTMLButtonElement>("#add-server")!.onclick = () => {
  setError();
  form.hidden = false;
  form.innerHTML = `<h2>Добавить сервер</h2><label>Название<input id="add-name" placeholder="Без названия"/></label><label>Код подключения<textarea id="add-code" rows="3" placeholder="BicLex-Hub|1|..."></textarea></label><div><button id="add-cancel">Отмена</button><button id="add-confirm" class="primary">Добавить</button></div>`;
  form.querySelector<HTMLButtonElement>("#add-cancel")!.onclick = () =>
    (form.hidden = true);
  form.querySelector<HTMLButtonElement>("#add-confirm")!.onclick = () => {
    try {
      const servers = loadServers();
      const parsed = parseConnectionCode(
        form.querySelector<HTMLTextAreaElement>("#add-code")!.value,
      );
      const server: HubServer = {
        id: id(),
        name: uniqueServerName(
          form.querySelector<HTMLInputElement>("#add-name")!.value,
          servers,
        ),
        address: parsed.address,
        token: parsed.token,
        owned: false,
        createdAt: Date.now(),
      };
      saveServers([...servers, server]);
      form.hidden = true;
      void changed(server.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
};

document.querySelector<HTMLButtonElement>("#create-server")!.onclick = () => {
  setError();
  form.hidden = false;
  form.innerHTML = `<h2>Создать сервер</h2><label>Название<input id="deploy-name" placeholder="Без названия"/></label><label>IP-адрес или домен Ubuntu-сервера<input id="deploy-address" placeholder="203.0.113.10"/></label><label>Логин SSH<input id="deploy-user" value="root" autocomplete="username"/></label><label>Пароль SSH<input id="deploy-password" type="password" autocomplete="current-password"/></label><pre id="deploy-progress">Ожидание запуска…</pre><div><button id="deploy-cancel">Отмена</button><button id="deploy-confirm" class="primary">Развернуть</button></div>`;
  form.querySelector<HTMLButtonElement>("#deploy-cancel")!.onclick = () =>
    (form.hidden = true);
  form.querySelector<HTMLButtonElement>("#deploy-confirm")!.onclick =
    async () => {
      const button = form.querySelector<HTMLButtonElement>("#deploy-confirm")!;
      const progress = form.querySelector<HTMLPreElement>("#deploy-progress")!;
      const addressInput =
        form.querySelector<HTMLInputElement>("#deploy-address")!;
      const usernameInput =
        form.querySelector<HTMLInputElement>("#deploy-user")!;
      const passwordInput =
        form.querySelector<HTMLInputElement>("#deploy-password")!;
      try {
        button.disabled = true;
        setError();
        normalizeAddress(addressInput.value);
        progress.textContent = "Подключение к серверу…";
        const unlisten = await listen<DeployProgress>(
          "deploy-progress",
          ({ payload }) => {
            progress.textContent += `\n[${payload.stage}] ${payload.message}`;
            progress.scrollTop = progress.scrollHeight;
          },
        );
        try {
          const result = await invoke<DeployResult>("deploy_server", {
            address: addressInput.value.trim(),
            username: usernameInput.value.trim(),
            password: passwordInput.value,
          });
          passwordInput.value = "";
          const servers = loadServers();
          const server: HubServer = {
            id: id(),
            name: uniqueServerName(
              form.querySelector<HTMLInputElement>("#deploy-name")!.value,
              servers,
            ),
            address: normalizeAddress(result.address),
            token: result.token,
            owned: true,
            createdAt: Date.now(),
          };
          saveServers([...servers, server]);
          progress.textContent += "\nГотово. Сервер добавлен в BicLex Hub.";
          await changed(server.id);
        } finally {
          unlisten();
        }
      } catch (cause) {
        passwordInput.value = "";
        setError(cause instanceof Error ? cause.message : String(cause));
        progress.textContent += `\nОШИБКА: ${cause instanceof Error ? cause.message : String(cause)}`;
      } finally {
        button.disabled = false;
      }
    };
};

render();
