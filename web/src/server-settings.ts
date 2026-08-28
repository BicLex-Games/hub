import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
type SettingsView = "list" | "add" | "create";

export type ServerSettingsOptions = {
  onBack: () => void;
  onChanged: (serverId?: string) => void;
};

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function mountServerSettings(
  root: HTMLElement,
  { onBack, onChanged }: ServerSettingsOptions,
) {
  let view: SettingsView = "list";
  let errorMessage = "";

  root.innerHTML = `<main class="settings-shell">
    <header class="settings-header">
      <button id="settings-back" class="settings-back" type="button">← Назад</button>
      <img src="${teamLogoUrl}" alt="BicLex"/>
      <div><h1>Серверы BicLex</h1><p>Подключение и развёртывание self-hosted комнат</p></div>
    </header>
    <section id="settings-content"></section>
  </main>`;
  const content = root.querySelector<HTMLElement>("#settings-content")!;
  root.querySelector<HTMLButtonElement>("#settings-back")!.onclick = () => {
    if (view === "list") onBack();
    else {
      view = "list";
      errorMessage = "";
      render();
    }
  };

  function setError(message = "") {
    errorMessage = message;
    const error = content.querySelector<HTMLElement>("#settings-error");
    if (error) error.textContent = message;
  }

  function showList() {
    const servers = loadServers();
    content.innerHTML = `<div class="settings-actions"><button id="add-server">Добавить</button><button id="create-server" class="primary">Создать сервер</button></div><p id="settings-error" class="settings-error"></p><ul id="server-list" class="server-list"></ul>`;
    const list = content.querySelector<HTMLUListElement>("#server-list")!;
    if (!servers.length) {
      list.innerHTML = '<li class="empty-servers">Серверов пока нет. Добавьте готовый сервер по коду или разверните свой.</li>';
    }
    for (const server of servers) {
      const item = document.createElement("li");
      item.innerHTML = `<div><strong></strong><span class="badges"></span><small></small></div><div class="server-actions"><button class="select">Выбрать</button>${server.owned ? '<button class="share">Поделиться</button>' : ""}<button class="remove">Удалить</button></div>`;
      item.querySelector("strong")!.textContent = server.name;
      item.querySelector("small")!.textContent = server.address;
      item.querySelector(".badges")!.textContent = server.owned
        ? "Мой сервер"
        : "Добавленный";
      item.querySelector<HTMLButtonElement>(".select")!.onclick = () => {
        selectServer(server.id);
        onChanged(server.id);
      };
      const share = item.querySelector<HTMLButtonElement>(".share");
      if (share)
        share.onclick = async () => {
          await navigator.clipboard.writeText(createConnectionCode(server));
          share.textContent = "Код скопирован";
          window.setTimeout(() => (share.textContent = "Поделиться"), 1400);
        };
      item.querySelector<HTMLButtonElement>(".remove")!.onclick = () => {
        saveServers(loadServers().filter((entry) => entry.id !== server.id));
        onChanged();
        render();
      };
      list.append(item);
    }
    content.querySelector<HTMLButtonElement>("#add-server")!.onclick = () => {
      view = "add";
      errorMessage = "";
      render();
    };
    content.querySelector<HTMLButtonElement>("#create-server")!.onclick = () => {
      view = "create";
      errorMessage = "";
      render();
    };
    setError(errorMessage);
  }

  function showAdd() {
    content.innerHTML = `<section class="server-form"><h2>Добавить сервер</h2><p class="form-description">Вставьте код — название, адрес и токен заполнятся автоматически.</p><label>Код подключения<textarea id="add-code" rows="4" placeholder="BicLex-Hub|2|..."></textarea></label><p id="settings-error" class="settings-error"></p><div class="form-actions"><button id="add-cancel">Отмена</button><button id="add-confirm" class="primary">Добавить</button></div></section>`;
    content.querySelector<HTMLButtonElement>("#add-cancel")!.onclick = () => {
      view = "list";
      render();
    };
    content.querySelector<HTMLButtonElement>("#add-confirm")!.onclick = () => {
      try {
        const servers = loadServers();
        const parsed = parseConnectionCode(
          content.querySelector<HTMLTextAreaElement>("#add-code")!.value,
        );
        const server: HubServer = {
          id: newId(),
          name: uniqueServerName(parsed.name, servers),
          address: parsed.address,
          token: parsed.token,
          owned: false,
          createdAt: Date.now(),
        };
        saveServers([...servers, server]);
        selectServer(server.id);
        onChanged(server.id);
        const button = content.querySelector<HTMLButtonElement>("#add-confirm")!;
        button.textContent = "Закрыть";
        button.classList.add("success");
        button.onclick = () => {
          view = "list";
          render();
        };
        content.querySelector<HTMLTextAreaElement>("#add-code")!.disabled = true;
        content.querySelector<HTMLButtonElement>("#add-cancel")!.hidden = true;
        setError();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    setError(errorMessage);
  }

  function showCreate() {
    content.innerHTML = `<section class="server-form"><h2>Создать сервер</h2><label>Название<input id="deploy-name" placeholder="Без названия"/></label><label>IP-адрес или домен Ubuntu-сервера<input id="deploy-address" placeholder="203.0.113.10"/></label><label>Логин SSH<input id="deploy-user" value="root" autocomplete="username"/></label><p class="ssh-key-hint">По умолчанию используется SSH-ключ из стандартной конфигурации Windows (~/.ssh).</p><label class="auth-toggle"><input id="deploy-use-password" type="checkbox"/> Использовать пароль SSH вместо ключа</label><label id="deploy-password-row" hidden>Пароль SSH<input id="deploy-password" type="password" autocomplete="current-password" disabled/></label><pre id="deploy-progress">Ожидание запуска…</pre><p id="deploy-elapsed" class="deploy-elapsed"></p><p id="settings-error" class="settings-error"></p><div class="form-actions"><button id="deploy-cancel">Отмена</button><button id="deploy-confirm" class="primary">Развернуть</button></div></section>`;
    const usePassword = content.querySelector<HTMLInputElement>("#deploy-use-password")!;
    const passwordRow = content.querySelector<HTMLElement>("#deploy-password-row")!;
    const password = content.querySelector<HTMLInputElement>("#deploy-password")!;
    usePassword.onchange = () => {
      passwordRow.hidden = !usePassword.checked;
      password.disabled = !usePassword.checked;
      if (usePassword.checked) password.focus();
    };
    content.querySelector<HTMLButtonElement>("#deploy-cancel")!.onclick = () => {
      view = "list";
      render();
    };
    content.querySelector<HTMLButtonElement>("#deploy-confirm")!.onclick = async () => {
      const button = content.querySelector<HTMLButtonElement>("#deploy-confirm")!;
      const progress = content.querySelector<HTMLPreElement>("#deploy-progress")!;
      const address = content.querySelector<HTMLInputElement>("#deploy-address")!;
      const username = content.querySelector<HTMLInputElement>("#deploy-user")!;
      const elapsed = content.querySelector<HTMLElement>("#deploy-elapsed")!;
      const startedAt = Date.now();
      let currentStage = "Подключение";
      const updateElapsed = () => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        elapsed.textContent = `${currentStage} · прошло ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      };
      const elapsedTimer = window.setInterval(updateElapsed, 1000);
      updateElapsed();
      try {
        button.disabled = true;
        setError();
        normalizeAddress(address.value);
        progress.textContent = "Подключение к серверу…";
        const unlisten = await listen<DeployProgress>(
          "deploy-progress",
          ({ payload }) => {
            currentStage = payload.stage;
            progress.textContent += `\n[${payload.stage}] ${payload.message}`;
            const lines = progress.textContent.split("\n");
            if (lines.length > 300)
              progress.textContent = lines.slice(-300).join("\n");
            progress.scrollTop = progress.scrollHeight;
            updateElapsed();
          },
        );
        try {
          const result = await invoke<DeployResult>("deploy_server", {
            address: address.value.trim(),
            username: username.value.trim(),
            password: password.value,
            usePassword: usePassword.checked,
          });
          password.value = "";
          const servers = loadServers();
          const server: HubServer = {
            id: newId(),
            name: uniqueServerName(
              content.querySelector<HTMLInputElement>("#deploy-name")!.value,
              servers,
            ),
            address: normalizeAddress(result.address),
            token: result.token,
            owned: true,
            createdAt: Date.now(),
          };
          saveServers([...servers, server]);
          selectServer(server.id);
          onChanged(server.id);
          progress.textContent += "\nГотово. Сервер сохранён в BicLex Hub.";
          button.textContent = "Закрыть";
          button.classList.add("success");
          button.onclick = () => {
            view = "list";
            render();
          };
          content.querySelector<HTMLButtonElement>("#deploy-cancel")!.hidden = true;
        } finally {
          unlisten();
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        progress.textContent += `\nОШИБКА: ${message}`;
      } finally {
        window.clearInterval(elapsedTimer);
        button.disabled = false;
      }
    };
    setError(errorMessage);
  }

  function render() {
    if (view === "add") showAdd();
    else if (view === "create") showCreate();
    else showList();
  }

  render();
  return {
    show: () => {
      view = "list";
      errorMessage = "";
      render();
    },
  };
}
