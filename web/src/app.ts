/// <reference types="vite/client" />
import { Device, types as MediasoupTypes } from "mediasoup-client";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  register as registerGlobalShortcut,
  unregister as unregisterGlobalShortcut,
} from "@tauri-apps/plugin-global-shortcut";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
} from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { GtcrnWorkletNode, loadGtcrn } from "@sapphi-red/web-noise-suppressor";
import gtcrnWorkletPath from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import gtcrnWasmPath from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import teamLogoUrl from "./assets/biclex-team-logo.png";
import {
  authenticatedUrl,
  loadServers,
  selectServer,
  selectedServer,
  websocketUrl,
  type HubServer,
} from "./servers";
import { mountServerSettings } from "./server-settings";
import { getLanguage, setLanguage, t, type Language } from "./i18n";
import { createEventSound, type EventSound } from "./event-sounds";
import "./style.css";
import "./update.css";

const CLIENT_VERSION = "0.3.22";

type Request = { requestId: string; type: string; [key: string]: unknown };
type ServerMessage = {
  requestId?: string;
  ok: boolean;
  type: string;
  turnIceServers?: RTCIceServer[];
  [key: string]: unknown;
};
type User = {
  peerId: string;
  name: string;
  producerId?: string;
  screenProducerId?: string;
  screenAudioProducerId?: string;
};
type ChatAttachment = {
  id: string;
  name: string;
  size: number;
  mime: string;
  url: string;
};
type ChatMessage = {
  id: string;
  senderPeerId: string;
  senderName: string;
  text: string;
  attachments: ChatAttachment[];
  createdAt: number;
};
type NoiseMode = "off" | "ai";
type ScreenQuality = "medium" | "high" | "maximum";
type MuteShortcut = {
  accelerator: string;
  display: string;
};
const DEFAULT_MUTE_SHORTCUT: MuteShortcut = {
  accelerator: "Ctrl+Shift+V",
  display: "Ctrl + Shift + V",
};
const MUTE_SHORTCUT_KEY = "biclex-mute-shortcut-v1";
const SCREEN_PROFILES = {
  medium: {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 10_000_000,
    startBitrate: 5_000,
  },
  high: {
    width: 2560,
    height: 1440,
    fps: 30,
    bitrate: 20_000_000,
    startBitrate: 10_000,
  },
  maximum: {
    width: 3840,
    height: 2160,
    fps: 60,
    bitrate: 40_000_000,
    startBitrate: 20_000,
  },
} satisfies Record<
  ScreenQuality,
  {
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    startBitrate: number;
  }
>;
type AiAudio = {
  input: MediaStream;
  inputTrack: MediaStreamTrack;
  outputTrack: MediaStreamTrack;
  context: AudioContext;
  node: GtcrnWorkletNode;
};
type RemoteAudio = {
  audio: HTMLAudioElement;
  consumer: MediasoupTypes.Consumer;
  peerId: string;
};
type RemoteScreen = {
  video: HTMLVideoElement;
  consumer: MediasoupTypes.Consumer;
  peerId: string;
};
type RemoteScreenAudio = {
  consumer: MediasoupTypes.Consumer;
  peerId: string;
};

const HEARTBEAT_MS = 20_000,
  PONG_TIMEOUT_MS = 55_000,
  CHAT_PAGE_SIZE = 15,
  RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000],
  SPEAKING_THRESHOLD = 0.025,
  SPEAKING_HANGOVER_MS = 300,
  ECHO_GUARD_REMOTE_THRESHOLD = 0.003,
  ECHO_GUARD_HANGOVER_MS = 900;
const isTauri = "__TAURI_INTERNALS__" in window;
const isMainView =
  new URLSearchParams(location.search).get("screenViewer") !== "1";
const app = document.querySelector<HTMLDivElement>("#app")!;
const diagnosticLines: string[] = [];
function diagnosticLog(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")}`;
  diagnosticLines.push(line);
  if (isTauri) void invoke("append_log", { line }).catch(() => undefined);
}
const participantVolumes: Record<string, number> = (() => {
  try {
    return JSON.parse(
      localStorage.getItem("biclex-participant-volumes") ?? "{}",
    ) as Record<string, number>;
  } catch {
    return {};
  }
})();
app.innerHTML = `<main class="app-shell">
  <section id="setup-page" class="page setup-page">
    <div class="brand"><img src="${teamLogoUrl}" alt="BicLex" /><div><h1>BicLex Hub</h1><p>${t("tagline")}</p></div></div>
    <div class="setup-form">
      <label>${t("language")}<select id="language"><option value="en">English</option><option value="ru">Русский</option></select></label>
      <label>${t("name")}<input id="name" maxlength="32" autocomplete="name" placeholder="${t("namePlaceholder")}" /></label>
      <label>${t("microphone")}<select id="input-device"><option value="">${t("defaultMicrophone")}</option></select></label>
      <div class="meter-block"><div class="meter-title"><span>${t("microphoneLevel")}</span><span id="meter-value">0%</span></div><div class="meter"><i id="meter-bar"></i></div></div>
      <button id="monitor" class="secondary">${t("testMicrophone")}</button>
      <p class="hint">${t("headphonesHint")}</p><p id="setup-error" class="setup-error" role="alert"></p>
      <button id="client-version" class="client-version" style="position:fixed;right:12px;bottom:8px;padding:0;border:0;color:#6f819d;background:transparent;font-size:.68rem">${t("clientVersion", { version: CLIENT_VERSION })}</button>
      <div class="join-actions"><button id="update" class="update" hidden>${t("update")}</button><button id="join" class="join">${t("join")}</button></div>
    </div>
  </section>
  <section id="room-page" class="page room-page" hidden>
    <header class="room-header"><div class="room-brand"><img src="${teamLogoUrl}" alt="" /><strong>BicLex Hub</strong></div><span id="connection-state" class="connection-state">${t("online")}</span></header>
    <div class="room-main"><div><h2>${t("participants")}</h2></div><div id="screens" class="screens" hidden></div><ul id="users" class="participants"></ul></div>
    <div class="room-bottom"><div class="media-settings"><div class="suppression"><span>${t("noiseSuppression")}</span><div class="noise" style="grid-template-columns:repeat(2,1fr)"><button data-noise="off">Off</button><button data-noise="ai">✨ AI</button></div></div><label class="screen-quality">${t("screenQuality")}<select id="screen-quality"><option value="medium">${t("qualityMedium")}</option><option value="high">${t("qualityHigh")}</option><option value="maximum">${t("qualityMaximum")}</option></select></label></div><div class="controls"><div class="mute-control"><div class="mute-shortcut-settings"><kbd id="mute-shortcut"></kbd><button id="edit-mute-shortcut" type="button" aria-label="${t("editMuteShortcut")}" title="${t("editMuteShortcut")}">✎</button></div><button id="mute" class="control mute" disabled><b>🎤</b><span>${t("mute")}</span></button></div><button id="screen-share" class="control screen-share"><b>🖥</b><span>${t("screenShare")}</span></button><button id="leave" class="control leave" disabled><b>🚪</b><span>${t("leave")}</span></button></div></div>
  </section>
  <section id="server-settings-page" class="page server-settings-page" hidden></section>
</main>`;
const setupPage = document.querySelector<HTMLElement>("#setup-page")!,
  roomPage = document.querySelector<HTMLElement>("#room-page")!,
  serverSettingsPage = document.querySelector<HTMLElement>(
    "#server-settings-page",
  )!,
  languageSelect = document.querySelector<HTMLSelectElement>("#language")!,
  nameInput = document.querySelector<HTMLInputElement>("#name")!,
  inputDevice = document.querySelector<HTMLSelectElement>("#input-device")!,
  meterBar = document.querySelector<HTMLElement>("#meter-bar")!,
  meterValue = document.querySelector<HTMLElement>("#meter-value")!,
  monitorButton = document.querySelector<HTMLButtonElement>("#monitor")!,
  setupError = document.querySelector<HTMLParagraphElement>("#setup-error")!,
  versionButton = document.querySelector<HTMLButtonElement>("#client-version")!,
  updateButton = document.querySelector<HTMLButtonElement>("#update")!,
  joinButton = document.querySelector<HTMLButtonElement>("#join")!,
  leaveButton = document.querySelector<HTMLButtonElement>("#leave")!,
  muteButton = document.querySelector<HTMLButtonElement>("#mute")!,
  muteShortcutLabel = document.querySelector<HTMLElement>("#mute-shortcut")!,
  editMuteShortcutButton = document.querySelector<HTMLButtonElement>(
    "#edit-mute-shortcut",
  )!,
  screenButton = document.querySelector<HTMLButtonElement>("#screen-share")!,
  screenQualitySelect =
    document.querySelector<HTMLSelectElement>("#screen-quality")!,
  screens = document.querySelector<HTMLElement>("#screens")!,
  users = document.querySelector<HTMLUListElement>("#users")!,
  connectionState = document.querySelector<HTMLElement>("#connection-state")!,
  noiseButtons = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-noise]"),
  ];
const outputDeviceLabel = document.createElement("label");
outputDeviceLabel.innerHTML = `${t("outputDevice")}<select id="output-device"><option value="">${t("defaultOutputDevice")}</option></select>`;
inputDevice.closest("label")?.after(outputDeviceLabel);
const outputDevice =
  outputDeviceLabel.querySelector<HTMLSelectElement>("#output-device")!;
const serverControl = document.createElement("div");
serverControl.className = "server-control";
serverControl.innerHTML = `<label>${t("server")}<select id="hub-server"></select></label><button id="server-settings" type="button" aria-label="${t("serverSettings")}" title="${t("serverSettings")}">⚙</button>`;
outputDeviceLabel.after(serverControl);
const serverSelect =
  serverControl.querySelector<HTMLSelectElement>("#hub-server")!;
const serverSettingsButton =
  serverControl.querySelector<HTMLButtonElement>("#server-settings")!;
const roomHeader = document.querySelector<HTMLElement>(".room-header")!;
const roomMain = document.querySelector<HTMLElement>(".room-main")!;
const roomBottom = document.querySelector<HTMLElement>(".room-bottom")!;
const conferencePane = document.createElement("section");
conferencePane.className = "conference-pane";
conferencePane.append(roomHeader, roomMain, roomBottom);
const chatPane = document.createElement("section");
chatPane.className = "chat-pane";
chatPane.innerHTML = `<header><div><h2>${t("chat")}</h2><span id="chat-server-name"></span></div><span id="upload-state"></span></header><div id="chat-messages" class="chat-messages"></div><div id="chat-attachments" class="chat-attachments"></div><form id="chat-form"><button id="attach-file" type="button" title="${t("addFile")}">＋</button><textarea id="chat-input" rows="1" maxlength="4000" placeholder="${t("messagePlaceholder")}"></textarea><button id="send-chat" type="submit">${t("send")}</button><input id="file-input" type="file" multiple hidden /></form><div id="chat-drop-overlay" class="chat-drop-overlay" aria-hidden="true"><span>⇩</span><strong>${t("dropFilesHere")}</strong></div>`;
roomPage.append(conferencePane, chatPane);
const chatMessages = chatPane.querySelector<HTMLElement>("#chat-messages")!;
const chatServerName =
  chatPane.querySelector<HTMLElement>("#chat-server-name")!;
const uploadState = chatPane.querySelector<HTMLElement>("#upload-state")!;
const chatForm = chatPane.querySelector<HTMLFormElement>("#chat-form")!;
const chatInput = chatPane.querySelector<HTMLTextAreaElement>("#chat-input")!;
const fileInput = chatPane.querySelector<HTMLInputElement>("#file-input")!;
const attachFileButton =
  chatPane.querySelector<HTMLButtonElement>("#attach-file")!;
const chatAttachments =
  chatPane.querySelector<HTMLElement>("#chat-attachments")!;
const chatDropOverlay =
  chatPane.querySelector<HTMLElement>("#chat-drop-overlay")!;
let activeServer: HubServer | undefined = selectedServer();
let pendingChatAttachments: ChatAttachment[] = [];
let chatDragDepth = 0;
let fileUploadQueue = Promise.resolve();
let screenWindow: WebviewWindow | undefined;
let screenWindowPeerId = "";
let ownScreenSoundActive = false;
let screenRtc: RTCPeerConnection | undefined;
let screenEventCleanup: UnlistenFn[] = [];
versionButton.textContent = t("clientVersion", { version: CLIENT_VERSION });
let socket: WebSocket | undefined,
  device: Device | undefined,
  sendTransport: MediasoupTypes.Transport | undefined,
  recvTransport: MediasoupTypes.Transport | undefined,
  microphoneProducer: MediasoupTypes.Producer | undefined,
  outgoingStream: MediaStream | undefined,
  outgoingTrack: MediaStreamTrack | undefined,
  outgoingAi: AiAudio | undefined,
  monitorStream: MediaStream | undefined,
  monitorAi: AiAudio | undefined,
  monitorAudio: HTMLAudioElement | undefined,
  meterContext: AudioContext | undefined,
  meterAnalyser: AnalyserNode | undefined,
  meterTimer: number | undefined,
  heartbeatTimer: number | undefined,
  watchdogTimer: number | undefined,
  statsTimer: number | undefined,
  reconnectTimer: number | undefined,
  lastPongAt = 0,
  reconnectAttempt = 0,
  intentionalDisconnect = true,
  joining = false,
  screenAudioSupported = false,
  ownPeerId = "",
  sequence = 0;
const pending = new Map<
    string,
    {
      resolve: (message: ServerMessage) => void;
      reject: (error: Error) => void;
    }
  >(),
  remoteAudio = new Map<string, RemoteAudio>(),
  remoteScreens = new Map<string, RemoteScreen>(),
  remoteScreenAudio = new Map<string, RemoteScreenAudio>(),
  audioSubscriptions = new Set<string>(),
  screenSubscriptions = new Set<string>(),
  screenAudioSubscriptions = new Set<string>(),
  stoppedScreenProducers = new Set<string>(),
  stoppedScreenAudioProducers = new Set<string>(),
  activeEventSounds = new Set<HTMLAudioElement>(),
  knownUsers = new Map<string, User>(),
  producerPeers = new Map<string, string>(),
  screenProducerPeers = new Map<string, string>(),
  screenAudioProducerPeers = new Map<string, string>(),
  speakingUntil = new Map<string, number>(),
  remoteAudioLevels = new Map<string, number>();
let screenStream: MediaStream | undefined,
  screenProducer: MediasoupTypes.Producer | undefined,
  screenAudioProducer: MediasoupTypes.Producer | undefined;
let noiseMode =
    (localStorage.getItem("biclex-noise-mode") as NoiseMode | null) ?? "off",
  screenQuality =
    (localStorage.getItem("biclex-screen-quality") as ScreenQuality | null) ??
    "high",
  selectedDeviceId = localStorage.getItem("biclex-input-device") ?? "",
  selectedOutputDeviceId = localStorage.getItem("biclex-output-device") ?? "",
  localSignaling = false,
  turnIceServers: RTCIceServer[] = [];
function loadMuteShortcut(): MuteShortcut {
  try {
    const saved = JSON.parse(
      localStorage.getItem(MUTE_SHORTCUT_KEY) ?? "null",
    ) as Partial<MuteShortcut> | null;
    if (saved?.accelerator && saved.display)
      return {
        accelerator: saved.accelerator,
        display: saved.display,
      };
  } catch {
    // Ignore an invalid saved value and restore the familiar default.
  }
  return DEFAULT_MUTE_SHORTCUT;
}
let muteShortcut = loadMuteShortcut();
let registeredMuteShortcut: string | undefined;
let capturingMuteShortcut = false;
let capturedMuteShortcut: MuteShortcut | undefined;
const capturedKeys = new Set<string>();
muteShortcutLabel.textContent = muteShortcut.display;
nameInput.value = localStorage.getItem("biclex-username") ?? "";
languageSelect.value = getLanguage();
languageSelect.onchange = () => {
  setLanguage(languageSelect.value as Language);
  location.reload();
};
if (!(screenQuality in SCREEN_PROFILES)) screenQuality = "high";
screenQualitySelect.value = screenQuality;
function refreshServerSelect() {
  const servers = loadServers();
  const selected = selectedServer();
  activeServer = servers.find((item) => item.id === selected?.id) ?? servers[0];
  serverSelect.replaceChildren();
  if (!servers.length) {
    serverSelect.add(new Option(t("addServerPrompt"), ""));
    serverSelect.disabled = true;
    updateJoinButton();
    return;
  }
  serverSelect.disabled = false;
  for (const server of servers) {
    const suffix = server.owned ? t("myServerSuffix") : "";
    serverSelect.add(new Option(`${server.name}${suffix}`, server.id));
  }
  serverSelect.value = activeServer?.id ?? "";
  updateJoinButton();
}
refreshServerSelect();
serverSelect.onchange = () => {
  selectServer(serverSelect.value);
  activeServer = selectedServer();
  updateJoinButton();
};
const serverSettings = mountServerSettings(serverSettingsPage, {
  onBack: () => showServerSettings(false),
  onChanged: () => refreshServerSelect(),
});
serverSettingsButton.onclick = () => {
  serverSettings.show();
  showServerSettings(true);
};
function showServerSettings(show: boolean) {
  setupPage.hidden = show;
  roomPage.hidden = true;
  serverSettingsPage.hidden = !show;
  setupPage.style.display = show ? "none" : "";
  roomPage.style.display = "none";
  serverSettingsPage.style.display = show ? "block" : "none";
  const size = new LogicalSize(760, 720);
  void resizeMainWindow(size, true);
}
function setSetupError(message = "") {
  setupError.textContent = message;
}
function setConnection(state: "online" | "reconnecting") {
  connectionState.textContent =
    state === "online" ? t("online") : t("reconnecting");
  connectionState.classList.toggle("reconnecting", state === "reconnecting");
}
async function resizeMainWindow(
  size: LogicalSize,
  center = false,
): Promise<number | null> {
  if (!isTauri) return null;
  const window = getCurrentWindow();
  try {
    await window.setSize(size);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 80));
    await window.setSize(size);
    if (center) await window.center();
    const actual = await window.outerSize();
    const scaleFactor = await window.scaleFactor();
    const actualLogicalWidth = actual.width / scaleFactor;
    diagnosticLog("WINDOW SIZE", {
      requested: { width: size.width, height: size.height },
      actual: { width: actual.width, height: actual.height },
      scaleFactor,
      actualLogicalWidth,
    });
    return actualLogicalWidth;
  } catch (error) {
    diagnosticLog(
      "WINDOW RESIZE FAILED",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
async function preferredRoomWindowSize(): Promise<LogicalSize> {
  const fallback = new LogicalSize(900, 650);
  if (!isTauri) return fallback;
  try {
    const monitor = await currentMonitor();
    if (!monitor) return fallback;
    const screen = monitor.size.toLogical(monitor.scaleFactor);
    const workArea = monitor.workArea.size.toLogical(monitor.scaleFactor);
    const relativeScale = Math.min(screen.width / 2560, screen.height / 1440);
    const width = Math.max(
      700,
      Math.min(
        Math.round(900 * relativeScale),
        Math.floor(workArea.width - 32),
      ),
    );
    const height = Math.max(
      620,
      Math.min(
        Math.round(650 * relativeScale),
        Math.floor(workArea.height - 32),
      ),
    );
    diagnosticLog("ROOM WINDOW TARGET", {
      monitor: monitor.name,
      screen: { width: screen.width, height: screen.height },
      workArea: { width: workArea.width, height: workArea.height },
      scaleFactor: monitor.scaleFactor,
      target: { width, height },
    });
    return new LogicalSize(width, height);
  } catch (error) {
    diagnosticLog(
      "ROOM WINDOW TARGET FAILED",
      error instanceof Error ? error.message : String(error),
    );
    return fallback;
  }
}
function showRoom(show: boolean) {
  diagnosticLog("ROOM SHOW", show);
  setupPage.hidden = show;
  roomPage.hidden = !show;
  serverSettingsPage.hidden = true;
  setupPage.style.display = show ? "none" : "";
  roomPage.style.display = show ? "grid" : "none";
  serverSettingsPage.style.display = "none";
  serverSelect.disabled = show;
  serverSettingsButton.disabled = show;
  chatServerName.textContent = activeServer?.name ?? "";
  if (show) {
    scrollChatToBottom("auto");
    void preferredRoomWindowSize().then((size) => resizeMainWindow(size, true));
  } else void resizeMainWindow(new LogicalSize(760, 760));
}
function updateJoinButton() {
  joinButton.disabled = !nameInput.value.trim() || !activeServer || joining;
}
function updateNoiseUi() {
  noiseButtons.forEach((b) =>
    b.classList.toggle("selected", b.dataset.noise === noiseMode),
  );
}
const shortcutKeyNames: Record<
  string,
  { accelerator: string; display: string }
> = {
  Space: { accelerator: "Space", display: "Space" },
  Enter: { accelerator: "Enter", display: "Enter" },
  Tab: { accelerator: "Tab", display: "Tab" },
  Backspace: { accelerator: "Backspace", display: "Backspace" },
  Delete: { accelerator: "Delete", display: "Delete" },
  Insert: { accelerator: "Insert", display: "Insert" },
  Home: { accelerator: "Home", display: "Home" },
  End: { accelerator: "End", display: "End" },
  PageUp: { accelerator: "PageUp", display: "Page Up" },
  PageDown: { accelerator: "PageDown", display: "Page Down" },
  ArrowUp: { accelerator: "Up", display: "↑" },
  ArrowDown: { accelerator: "Down", display: "↓" },
  ArrowLeft: { accelerator: "Left", display: "←" },
  ArrowRight: { accelerator: "Right", display: "→" },
};
function shortcutFromKeyboardEvent(
  event: KeyboardEvent,
): MuteShortcut | undefined {
  let key: { accelerator: string; display: string } | undefined;
  if (/^Key[A-Z]$/.test(event.code)) {
    const value = event.code.slice(3);
    key = { accelerator: value, display: value };
  } else if (/^Digit[0-9]$/.test(event.code)) {
    const value = event.code.slice(5);
    key = { accelerator: value, display: value };
  } else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code)) {
    key = { accelerator: event.code, display: event.code };
  } else key = shortcutKeyNames[event.code];
  if (!key) return undefined;
  const accelerator: string[] = [];
  const display: string[] = [];
  if (event.ctrlKey) {
    accelerator.push("Ctrl");
    display.push("Ctrl");
  }
  if (event.altKey) {
    accelerator.push("Alt");
    display.push("Alt");
  }
  if (event.shiftKey) {
    accelerator.push("Shift");
    display.push("Shift");
  }
  if (event.metaKey) {
    accelerator.push("Super");
    display.push("Win");
  }
  accelerator.push(key.accelerator);
  display.push(key.display);
  return {
    accelerator: accelerator.join("+"),
    display: display.join(" + "),
  };
}
function toggleMute() {
  if (!outgoingTrack) return;
  outgoingTrack.enabled = !outgoingTrack.enabled;
  void playEventSound(
    outgoingTrack.enabled ? "microphoneUnmuted" : "microphoneMuted",
  );
  muteButton.classList.toggle("muted", !outgoingTrack.enabled);
  muteButton.innerHTML = outgoingTrack.enabled
    ? `<b>🎤</b><span>${t("mute")}</span>`
    : `<b>🔇</b><span>${t("unmute")}</span>`;
}
async function activateMuteShortcut(
  next: MuteShortcut,
  persist: boolean,
): Promise<boolean> {
  const previous = registeredMuteShortcut;
  if (isTauri && previous) {
    try {
      await unregisterGlobalShortcut(previous);
    } catch (error) {
      diagnosticLog("MUTE SHORTCUT UNREGISTER FAILED", String(error));
    }
    registeredMuteShortcut = undefined;
  }
  if (isTauri) {
    try {
      await registerGlobalShortcut(next.accelerator, (event) => {
        if (event.state === "Pressed") toggleMute();
      });
      registeredMuteShortcut = next.accelerator;
    } catch (error) {
      diagnosticLog(
        "MUTE SHORTCUT REGISTER FAILED",
        next.accelerator,
        String(error),
      );
      if (previous) {
        try {
          await registerGlobalShortcut(previous, (event) => {
            if (event.state === "Pressed") toggleMute();
          });
          registeredMuteShortcut = previous;
        } catch (restoreError) {
          diagnosticLog("MUTE SHORTCUT RESTORE FAILED", String(restoreError));
        }
      }
      muteShortcutLabel.classList.add("error");
      muteShortcutLabel.textContent = t("muteShortcutUnavailable");
      muteShortcutLabel.title = t("muteShortcutUnavailable");
      window.setTimeout(() => {
        muteShortcutLabel.classList.remove("error");
        muteShortcutLabel.textContent = muteShortcut.display;
        muteShortcutLabel.title = "";
      }, 1800);
      return false;
    }
  }
  muteShortcut = next;
  muteShortcutLabel.textContent = next.display;
  muteShortcutLabel.title = "";
  if (persist) localStorage.setItem(MUTE_SHORTCUT_KEY, JSON.stringify(next));
  diagnosticLog("MUTE SHORTCUT ACTIVE", next.accelerator);
  return true;
}
async function startMuteShortcutCapture() {
  if (capturingMuteShortcut) return;
  if (isTauri && registeredMuteShortcut) {
    try {
      await unregisterGlobalShortcut(registeredMuteShortcut);
      registeredMuteShortcut = undefined;
    } catch (error) {
      diagnosticLog("MUTE SHORTCUT CAPTURE UNREGISTER FAILED", String(error));
    }
  }
  capturingMuteShortcut = true;
  capturedMuteShortcut = undefined;
  capturedKeys.clear();
  muteShortcutLabel.textContent = t("pressMuteShortcut");
  muteShortcutLabel.classList.add("recording");
  editMuteShortcutButton.classList.add("recording");
  editMuteShortcutButton.focus();
}
async function stopMuteShortcutCapture(saveCaptured: boolean) {
  if (!capturingMuteShortcut) return;
  const next = capturedMuteShortcut;
  capturingMuteShortcut = false;
  capturedMuteShortcut = undefined;
  capturedKeys.clear();
  muteShortcutLabel.classList.remove("recording");
  editMuteShortcutButton.classList.remove("recording");
  if (saveCaptured && next) await activateMuteShortcut(next, true);
  else await activateMuteShortcut(muteShortcut, false);
}
window.addEventListener(
  "keydown",
  (event) => {
    if (capturingMuteShortcut) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.code === "Escape") {
        void stopMuteShortcutCapture(false);
        return;
      }
      capturedKeys.add(event.code);
      const shortcut = shortcutFromKeyboardEvent(event);
      if (shortcut) {
        capturedMuteShortcut = shortcut;
        muteShortcutLabel.textContent = shortcut.display;
      }
      return;
    }
    if (
      !isTauri &&
      shortcutFromKeyboardEvent(event)?.accelerator === muteShortcut.accelerator
    ) {
      event.preventDefault();
      toggleMute();
    }
  },
  true,
);
window.addEventListener(
  "keyup",
  (event) => {
    if (!capturingMuteShortcut) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    capturedKeys.delete(event.code);
    if (capturedMuteShortcut && capturedKeys.size === 0)
      void stopMuteShortcutCapture(true);
  },
  true,
);
window.addEventListener("blur", () => {
  if (capturingMuteShortcut) void stopMuteShortcutCapture(false);
});
editMuteShortcutButton.onclick = () => {
  void startMuteShortcutCapture();
};
if (isMainView) void activateMuteShortcut(muteShortcut, false);
function volumeKey(name: string) {
  return name.trim().toLocaleLowerCase();
}
function participantVolume(peerId: string) {
  const name = knownUsers.get(peerId)?.name;
  if (!name) return 100;
  const value = participantVolumes[volumeKey(name)];
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
}
function setParticipantVolume(peerId: string, value: number) {
  const name = knownUsers.get(peerId)?.name;
  if (!name) return;
  participantVolumes[volumeKey(name)] = value;
  localStorage.setItem(
    "biclex-participant-volumes",
    JSON.stringify(participantVolumes),
  );
  applyEchoGuard(performance.now());
}
async function setNoiseMode(mode: NoiseMode) {
  if (mode === noiseMode || joining) return;
  const previous = noiseMode;
  noiseMode = mode;
  localStorage.setItem("biclex-noise-mode", mode);
  updateNoiseUi();
  if (!microphoneProducer) return;
  try {
    let nextStream: MediaStream | undefined;
    let nextAi: AiAudio | undefined;
    let nextTrack: MediaStreamTrack;
    if (mode === "ai") {
      nextAi = await createAiAudio();
      nextTrack = nextAi.outputTrack;
    } else {
      nextStream = await captureDirect("off");
      nextTrack = nextStream.getAudioTracks()[0];
    }
    await microphoneProducer.replaceTrack({ track: nextTrack });
    const oldStream = outgoingStream;
    const oldAi = outgoingAi;
    outgoingStream = nextStream;
    outgoingAi = nextAi;
    outgoingTrack = nextTrack;
    oldStream?.getTracks().forEach((track) => track.stop());
    closeAi(oldAi);
  } catch (error) {
    noiseMode = previous;
    localStorage.setItem("biclex-noise-mode", previous);
    updateNoiseUi();
    diagnosticLog(
      "NOISE MODE FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}
type MicrophoneCaptureProfile = "off" | "ai" | "standard";

function constraints(mode: MicrophoneCaptureProfile): MediaTrackConstraints {
  const browserProcessing = mode === "standard";
  return {
    deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
    // WebView's AEC can interact badly with GTCRN on some microphones and
    // produce pumping/robotic speech. Keep AEC for direct modes, but feed AI
    // the raw capture path so GTCRN is the only microphone processor.
    echoCancellation: mode !== "ai",
    // AI uses GTCRN, so WebView noise suppression and gain control stay off to
    // avoid processing the same signal twice and producing robotic speech.
    noiseSuppression: browserProcessing,
    autoGainControl: browserProcessing,
    channelCount: 1,
    sampleRate: 48_000,
  };
}
async function captureDirect(mode: MicrophoneCaptureProfile) {
  try {
    return await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: constraints(mode),
        video: false,
      }),
      t("microphone"),
    );
  } catch (error) {
    if (!selectedDeviceId) throw error;
    selectedDeviceId = "";
    localStorage.removeItem("biclex-input-device");
    inputDevice.value = "";
    return withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: constraints(mode),
        video: false,
      }),
      t("microphone"),
    );
  }
}
async function refreshDevices(permission = false) {
  if (permission)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* labels stay unavailable */
    }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputDevices = devices.filter((d) => d.kind === "audioinput");
  const outputDevices = devices.filter((d) => d.kind === "audiooutput");
  inputDevice.replaceChildren(new Option(t("defaultMicrophone"), ""));
  inputDevices.forEach((d, i) =>
    inputDevice.add(
      new Option(
        d.label || t("microphoneNumber", { number: i + 1 }),
        d.deviceId,
      ),
    ),
  );
  if (
    selectedDeviceId &&
    [...inputDevice.options].some((o) => o.value === selectedDeviceId)
  )
    inputDevice.value = selectedDeviceId;
  else if (selectedDeviceId) {
    selectedDeviceId = "";
    localStorage.removeItem("biclex-input-device");
    inputDevice.value = "";
  }
  outputDevice.replaceChildren(new Option(t("defaultOutputDevice"), ""));
  outputDevices.forEach((d, i) =>
    outputDevice.add(
      new Option(
        d.label || t("outputDeviceNumber", { number: i + 1 }),
        d.deviceId,
      ),
    ),
  );
  if (
    selectedOutputDeviceId &&
    [...outputDevice.options].some(
      (option) => option.value === selectedOutputDeviceId,
    )
  )
    outputDevice.value = selectedOutputDeviceId;
  else if (selectedOutputDeviceId) {
    selectedOutputDeviceId = "";
    localStorage.removeItem("biclex-output-device");
    outputDevice.value = "";
  }
}
async function applyAudioOutput(audio: HTMLMediaElement) {
  if (!("setSinkId" in audio)) return;
  try {
    await audio.setSinkId(selectedOutputDeviceId);
    diagnosticLog(
      "AUDIO OUTPUT APPLIED",
      selectedOutputDeviceId ? "SELECTED DEVICE" : "DEFAULT",
    );
  } catch (error) {
    diagnosticLog(
      "AUDIO OUTPUT FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}
async function playEventSound(cue: EventSound) {
  const audio = createEventSound(cue);
  activeEventSounds.add(audio);
  const release = () => activeEventSounds.delete(audio);
  audio.addEventListener("ended", release, { once: true });
  audio.addEventListener("error", release, { once: true });
  try {
    await applyAudioOutput(audio);
    await audio.play();
    diagnosticLog("EVENT SOUND", cue);
  } catch (error) {
    release();
    diagnosticLog(
      "EVENT SOUND FAILED",
      cue,
      error instanceof Error ? error.message : String(error),
    );
  }
}
function playOwnScreenStoppedSound() {
  if (!ownScreenSoundActive) return;
  ownScreenSoundActive = false;
  void playEventSound("screenStopped");
}
function closeAi(value: AiAudio | undefined) {
  if (!value) return;
  value.node.destroy();
  value.node.disconnect();
  value.input.getTracks().forEach((t) => t.stop());
  void value.context.close();
}
async function createAiAudio(): Promise<AiAudio> {
  const input = await captureDirect("ai"),
    inputTrack = input.getAudioTracks()[0],
    context = new AudioContext({
      sampleRate: 48_000,
      latencyHint: "interactive",
    });
  await context.resume();
  const source = context.createMediaStreamSource(input),
    destination = context.createMediaStreamDestination();
  if (context.sampleRate !== 48_000)
    throw new Error(`GTCRN requires 48000 Hz, got ${context.sampleRate}`);
  source.channelCount = 1;
  source.channelCountMode = "explicit";
  source.channelInterpretation = "speakers";
  destination.channelCount = 1;
  destination.channelCountMode = "explicit";
  destination.channelInterpretation = "speakers";
  diagnosticLog("AI INPUT SETTINGS", inputTrack.getSettings());
  diagnosticLog(
    "AI CONTEXT",
    `sampleRate=${context.sampleRate}`,
    `state=${context.state}`,
    "channels=mono",
    "frame=768",
  );
  context.onstatechange = () =>
    diagnosticLog("AI CONTEXT STATE", context.state);
  try {
    const wasmBinary = await loadGtcrn({ url: gtcrnWasmPath });
    await context.audioWorklet.addModule(gtcrnWorkletPath);
    const node = new GtcrnWorkletNode(context, { wasmBinary, maxChannels: 1 });
    node.channelCount = 1;
    node.channelCountMode = "explicit";
    node.channelInterpretation = "speakers";
    source.connect(node).connect(destination);
    const outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack) throw new Error("AI output track unavailable");
    diagnosticLog("AI OUTPUT SETTINGS", outputTrack.getSettings());
    return { input, inputTrack, outputTrack, context, node };
  } catch (error) {
    source.disconnect();
    input.getTracks().forEach((t) => t.stop());
    void context.close();
    throw error;
  }
}
function stopMeter() {
  if (meterTimer !== undefined) window.clearInterval(meterTimer);
  meterTimer = undefined;
  meterAnalyser?.disconnect();
  meterAnalyser = undefined;
  void meterContext?.close();
  meterContext = undefined;
  meterBar.style.width = "0%";
  meterValue.textContent = "0%";
}
async function probeLocalSignaling() {
  if (!activeServer) return false;
  try {
    if (new URL(activeServer.address).hostname !== "hub.biclex.ru")
      return false;
  } catch {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const ws = new WebSocket("ws://10.70.0.50:8123/ws");
    const timer = window.setTimeout(() => {
      ws.close();
      resolve(false);
    }, 1_200);
    ws.onopen = () => {
      window.clearTimeout(timer);
      ws.close(1000, "probe");
      resolve(true);
    };
    ws.onerror = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
  });
}
async function startMeter(track: MediaStreamTrack) {
  stopMeter();
  meterContext = new AudioContext();
  await meterContext.resume();
  const source = meterContext.createMediaStreamSource(new MediaStream([track]));
  meterAnalyser = meterContext.createAnalyser();
  meterAnalyser.fftSize = 512;
  source.connect(meterAnalyser);
  const silent = meterContext.createGain();
  silent.gain.value = 0;
  meterAnalyser.connect(silent).connect(meterContext.destination);
  meterTimer = window.setInterval(() => {
    if (!meterAnalyser) return;
    const data = new Uint8Array(meterAnalyser.fftSize);
    meterAnalyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const s of data) {
      const v = (s - 128) / 128;
      sum += v * v;
    }
    const percent = Math.min(
      100,
      Math.round(Math.sqrt(sum / data.length) * 320),
    );
    meterBar.style.width = `${percent}%`;
    meterValue.textContent = `${percent}%`;
  }, 50);
}
function stopMonitor() {
  monitorAudio?.pause();
  if (monitorAudio) monitorAudio.srcObject = null;
  monitorAudio = undefined;
  monitorStream?.getTracks().forEach((t) => t.stop());
  monitorStream = undefined;
  closeAi(monitorAi);
  monitorAi = undefined;
  stopMeter();
  monitorButton.textContent = t("testMicrophone");
}
async function toggleMonitor() {
  if (monitorAudio) {
    stopMonitor();
    return;
  }
  try {
    let track: MediaStreamTrack;
    if (noiseMode === "ai") {
      monitorAi = await createAiAudio();
      track = monitorAi.outputTrack;
    } else {
      monitorStream = await captureDirect("off");
      track = monitorStream.getAudioTracks()[0];
    }
    monitorAudio = new Audio();
    monitorAudio.autoplay = true;
    monitorAudio.srcObject = new MediaStream([track]);
    await applyAudioOutput(monitorAudio);
    await monitorAudio.play();
    await startMeter(track);
    monitorButton.textContent = t("stopMicrophoneTest");
  } catch (error) {
    stopMonitor();
    setSetupError(
      error instanceof Error ? error.message : t("microphoneFailed"),
    );
  }
}
const renderedChatMessages = new Set<string>();
let oldestChatMessageId: string | undefined;
let chatHasMore = false;
let chatHistoryLoading = true;
function effectiveServer(): HubServer {
  if (!activeServer) throw new Error(t("serverNotSelected"));
  return localSignaling
    ? { ...activeServer, address: "http://10.70.0.50:8123" }
    : activeServer;
}
function fileSize(size: number) {
  if (size < 1024) return t("bytes", { value: size });
  if (size < 1024 * 1024)
    return t("kilobytes", { value: (size / 1024).toFixed(1) });
  return t("megabytes", { value: (size / 1024 / 1024).toFixed(1) });
}
function attachmentUrl(attachment: ChatAttachment) {
  return authenticatedUrl(effectiveServer(), attachment.url);
}
async function fetchAttachment(attachment: ChatAttachment) {
  const response = await fetch(attachmentUrl(attachment));
  if (!response.ok)
    throw new Error(`${attachment.name}, HTTP ${response.status}`);
  return response.blob();
}
function imageDimensions(src: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error("Image has no dimensions"));
        return;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => reject(new Error("Image preview load failed"));
    image.src = src;
  });
}
function previewWindowSize(width: number, height: number) {
  const maxWidth = Math.max(320, Math.floor(window.screen.availWidth * 0.92));
  const maxHeight = Math.max(240, Math.floor(window.screen.availHeight * 0.9));
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
async function openImagePreview(attachment: ChatAttachment) {
  const src = attachmentUrl(attachment);
  if (!isTauri) {
    window.open(src, "_blank", "noopener,noreferrer");
    return;
  }
  let size = { width: 960, height: 720 };
  try {
    const dimensions = await imageDimensions(src);
    size = previewWindowSize(dimensions.width, dimensions.height);
  } catch (error) {
    diagnosticLog(
      "IMAGE PREVIEW DIMENSIONS FAILED",
      attachment.id,
      error instanceof Error ? error.message : String(error),
    );
  }
  const key = attachment.id.replace(/[^a-zA-Z0-9_-]/g, "");
  const preview = new WebviewWindow(`image-preview-${key}-${Date.now()}`, {
    url: `index.html?imagePreview=1&src=${encodeURIComponent(src)}&title=${encodeURIComponent(attachment.name)}`,
    title: attachment.name,
    width: size.width,
    height: size.height,
    resizable: true,
    center: true,
  });
  preview.once("tauri://error", (event) =>
    diagnosticLog("IMAGE PREVIEW WINDOW FAILED", event.payload),
  );
}
async function downloadAttachment(attachment: ChatAttachment) {
  try {
    const url = attachmentUrl(attachment);
    if (isTauri) {
      const destination = await save({
        title: t("saveFileAs"),
        defaultPath: attachment.name,
      });
      if (!destination) return;
      uploadState.textContent = t("downloading", { name: attachment.name });
      await invoke("download_attachment", {
        url,
        destination,
      });
      uploadState.textContent = t("downloaded", { name: attachment.name });
      return;
    }
    const blob = await fetchAttachment(attachment);
    const blobUrl = URL.createObjectURL(blob);
    const download = document.createElement("a");
    download.href = blobUrl;
    download.download = attachment.name;
    download.hidden = true;
    document.body.append(download);
    download.click();
    download.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    uploadState.textContent = t("downloaded", { name: attachment.name });
  } catch (error) {
    diagnosticLog(
      "ATTACHMENT DOWNLOAD FAILED",
      attachment.id,
      error instanceof Error ? error.message : String(error),
    );
    uploadState.textContent = t("downloadFailed", { name: attachment.name });
  }
}
function scrollChatToBottom(behavior: ScrollBehavior = "smooth") {
  requestAnimationFrame(() => {
    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior,
    });
    // A second layout pass is needed when a new image attachment finishes
    // loading and increases the message height after the first scroll.
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  });
}
function renderChatMessage(
  message: ChatMessage,
  position: "append" | "prepend" = "append",
  scrollToLatest = true,
) {
  if (renderedChatMessages.has(message.id)) return;
  renderedChatMessages.add(message.id);
  const item = document.createElement("article");
  item.className =
    message.senderPeerId === ownPeerId ? "chat-message own" : "chat-message";
  const header = document.createElement("header");
  const sender = document.createElement("strong");
  sender.textContent = message.senderName;
  const timestamp = document.createElement("time");
  const date = new Date(message.createdAt);
  timestamp.dateTime = date.toISOString();
  timestamp.textContent = date.toLocaleString(
    getLanguage() === "ru" ? "ru-RU" : "en-GB",
    {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
  );
  header.append(sender, timestamp);
  item.append(header);
  if (message.text) {
    const body = document.createElement("p");
    body.textContent = message.text;
    item.append(body);
  }
  if (message.attachments.length) {
    const attachments = document.createElement("div");
    attachments.className = "message-attachments";
    for (const attachment of message.attachments) {
      const link = document.createElement("a");
      link.href = attachmentUrl(attachment);
      link.onclick = (event) => {
        event.preventDefault();
        if (attachment.mime.startsWith("image/")) openImagePreview(attachment);
        else void downloadAttachment(attachment);
      };
      if (attachment.mime.startsWith("image/")) {
        const image = document.createElement("img");
        image.src = link.href;
        image.alt = attachment.name;
        image.loading = "lazy";
        if (scrollToLatest)
          image.addEventListener("load", () => scrollChatToBottom("auto"), {
            once: true,
          });
        link.append(image);
      }
      const label = document.createElement("span");
      label.textContent = `${attachment.name} · ${fileSize(attachment.size)}`;
      link.append(label);
      attachments.append(link);
    }
    item.append(attachments);
  }
  if (position === "prepend") chatMessages.prepend(item);
  else chatMessages.append(item);
  if (scrollToLatest) scrollChatToBottom();
}
function resetChatHistory() {
  renderedChatMessages.clear();
  chatMessages.replaceChildren();
  oldestChatMessageId = undefined;
  chatHasMore = false;
  chatHistoryLoading = true;
}
function renderInitialChatHistory(messages: ChatMessage[], hasMore: boolean) {
  resetChatHistory();
  for (const message of messages) renderChatMessage(message, "append", false);
  oldestChatMessageId = messages[0]?.id;
  chatHasMore = hasMore;
  scrollChatToBottom("auto");
  requestAnimationFrame(() => {
    chatHistoryLoading = false;
  });
}
async function loadOlderChatHistory() {
  if (chatHistoryLoading || !chatHasMore || !oldestChatMessageId) return;
  chatHistoryLoading = true;
  const previousHeight = chatMessages.scrollHeight;
  const previousTop = chatMessages.scrollTop;
  try {
    const response = await request("getChatHistory", {
      before: oldestChatMessageId,
      limit: CHAT_PAGE_SIZE,
    }).then(ensureOk);
    const messages = response.messages as ChatMessage[];
    for (const message of [...messages].reverse())
      renderChatMessage(message, "prepend", false);
    oldestChatMessageId = messages[0]?.id ?? oldestChatMessageId;
    chatHasMore = Boolean(response.hasMore);
    requestAnimationFrame(() => {
      chatMessages.scrollTop =
        previousTop + (chatMessages.scrollHeight - previousHeight);
      chatHistoryLoading = false;
    });
  } catch (error) {
    diagnosticLog(
      "CHAT HISTORY LOAD FAILED",
      error instanceof Error ? error.message : String(error),
    );
    chatHistoryLoading = false;
  }
}
chatMessages.addEventListener("scroll", () => {
  if (chatMessages.scrollTop <= 80) void loadOlderChatHistory();
});
function renderPendingAttachments() {
  chatAttachments.replaceChildren();
  for (const attachment of pendingChatAttachments) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.textContent = `${attachment.name} ×`;
    chip.onclick = () => {
      pendingChatAttachments = pendingChatAttachments.filter(
        (item) => item.id !== attachment.id,
      );
      renderPendingAttachments();
    };
    chatAttachments.append(chip);
  }
}
async function uploadChatFiles(files: readonly File[]) {
  uploadState.textContent = t("uploading");
  attachFileButton.disabled = true;
  try {
    for (const file of files) {
      const body = new FormData();
      body.append("file", file, file.name);
      const response = await fetch(
        authenticatedUrl(effectiveServer(), "/api/files"),
        {
          method: "POST",
          body,
        },
      );
      if (!response.ok)
        throw new Error(
          `${t("uploadFailed")}: ${file.name}, HTTP ${response.status}`,
        );
      pendingChatAttachments.push((await response.json()) as ChatAttachment);
      renderPendingAttachments();
    }
    uploadState.textContent = "";
  } catch (error) {
    uploadState.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    attachFileButton.disabled = false;
    fileInput.value = "";
  }
}
function queueChatFiles(files: FileList | readonly File[]) {
  const selectedFiles = Array.from(files);
  if (!selectedFiles.length) return;
  fileUploadQueue = fileUploadQueue.then(() => uploadChatFiles(selectedFiles));
}
async function uploadDroppedPaths(paths: readonly string[]) {
  uploadState.textContent = t("uploading");
  attachFileButton.disabled = true;
  try {
    const url = authenticatedUrl(effectiveServer(), "/api/files");
    for (const path of paths) {
      const attachment = await invoke<ChatAttachment>("upload_dropped_file", {
        path,
        url,
      });
      pendingChatAttachments.push(attachment);
      renderPendingAttachments();
    }
    uploadState.textContent = "";
  } catch (error) {
    uploadState.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    attachFileButton.disabled = false;
  }
}
function queueDroppedPaths(paths: readonly string[]) {
  if (!paths.length) return;
  fileUploadQueue = fileUploadQueue.then(() => uploadDroppedPaths(paths));
}
function setChatDragging(dragging: boolean) {
  chatPane.classList.toggle("dragging", dragging);
  chatDropOverlay.setAttribute("aria-hidden", String(!dragging));
}
function containsDraggedFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}
attachFileButton.onclick = () => fileInput.click();
fileInput.onchange = () => {
  if (fileInput.files?.length) queueChatFiles(fileInput.files);
};
chatPane.ondragenter = (event) => {
  if (!containsDraggedFiles(event)) return;
  event.preventDefault();
  chatDragDepth += 1;
  setChatDragging(true);
};
chatPane.ondragover = (event) => {
  if (!containsDraggedFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
};
chatPane.ondragleave = (event) => {
  if (!containsDraggedFiles(event)) return;
  event.preventDefault();
  chatDragDepth = Math.max(0, chatDragDepth - 1);
  if (!chatDragDepth) setChatDragging(false);
};
chatPane.ondrop = (event) => {
  if (!containsDraggedFiles(event)) return;
  event.preventDefault();
  chatDragDepth = 0;
  setChatDragging(false);
  if (event.dataTransfer?.files.length)
    queueChatFiles(event.dataTransfer.files);
};
if (isTauri)
  void getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "over") {
      if (!roomPage.hidden) setChatDragging(true);
    } else if (event.payload.type === "drop") {
      setChatDragging(false);
      if (!roomPage.hidden) queueDroppedPaths(event.payload.paths);
    } else {
      setChatDragging(false);
    }
  });
chatForm.onsubmit = (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text && !pendingChatAttachments.length) return;
  const attachments = pendingChatAttachments;
  chatInput.value = "";
  pendingChatAttachments = [];
  renderPendingAttachments();
  void request("sendChatMessage", { text, attachments }).catch((error) => {
    uploadState.textContent =
      error instanceof Error ? error.message : String(error);
    pendingChatAttachments = attachments;
    renderPendingAttachments();
  });
};
chatInput.onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
};
function request(
  type: string,
  fields: Record<string, unknown> = {},
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("Signaling connection is closed"));
      return;
    }
    const requestId = `${Date.now()}-${++sequence}`,
      started = performance.now();
    diagnosticLog("REQUEST", type, "BEFORE", requestId);
    console.debug(`[SIGNAL] ${type} BEFORE`, requestId);
    const timeout = window.setTimeout(() => {
      if (pending.delete(requestId)) {
        diagnosticLog("TIMEOUT", type, Math.round(performance.now() - started));
        console.error(
          `[SIGNAL] ${type} TIMEOUT`,
          Math.round(performance.now() - started),
        );
        reject(new Error(`${type}: signaling timeout`));
      }
    }, 12_000);
    pending.set(requestId, {
      resolve: (message) => {
        window.clearTimeout(timeout);
        diagnosticLog(
          "RESPONSE",
          type,
          "AFTER",
          Math.round(performance.now() - started),
          message.ok ? "OK" : "ERROR",
        );
        console.debug(
          `[SIGNAL] ${type} AFTER`,
          Math.round(performance.now() - started),
        );
        resolve(message);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    });
    socket.send(
      JSON.stringify({ requestId, type, ...fields } satisfies Request),
    );
  });
}
function ensureOk(m: ServerMessage) {
  if (!m.ok) throw new Error(String(m.message ?? "Request failed"));
  return m;
}
function withTimeout<T>(operation: Promise<T>, label: string) {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) =>
      window.setTimeout(() => reject(new Error(`${label}: timeout`)), 20_000),
    ),
  ]);
}
function stopHeartbeat() {
  if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
  if (watchdogTimer !== undefined) window.clearInterval(watchdogTimer);
  heartbeatTimer = watchdogTimer = undefined;
}
function startHeartbeat() {
  stopHeartbeat();
  lastPongAt = Date.now();
  heartbeatTimer = window.setInterval(() => {
    void request("ping")
      .then(ensureOk)
      .then(() => {
        lastPongAt = Date.now();
        console.debug("BicLex Hub: pong received");
      })
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  watchdogTimer = window.setInterval(() => {
    if (Date.now() - lastPongAt > PONG_TIMEOUT_MS)
      socket?.close(4000, "heartbeat timeout");
  }, 5_000);
  console.debug("BicLex Hub: heartbeat started");
}
function setSpeaking(peerId: string, level: number) {
  const now = performance.now();
  if (level >= SPEAKING_THRESHOLD)
    speakingUntil.set(peerId, now + SPEAKING_HANGOVER_MS);
  document
    .querySelector(`[data-peer="${CSS.escape(peerId)}"]`)
    ?.classList.toggle("speaking", (speakingUntil.get(peerId) ?? 0) > now);
}
let localEchoGuardUntil = 0;
let echoGuardActive = new Set<string>();
function applyEchoGuard(now: number) {
  const localVoiceRecent = localEchoGuardUntil > now;
  const nextActive = new Set<string>();
  for (const remote of remoteAudio.values()) {
    const baseVolume = participantVolume(remote.peerId) / 100;
    const returningAudio =
      localVoiceRecent &&
      (remoteAudioLevels.get(remote.peerId) ?? 0) >=
        ECHO_GUARD_REMOTE_THRESHOLD;
    if (returningAudio) nextActive.add(remote.peerId);
    const targetVolume = returningAudio ? 0 : baseVolume;
    // Cut a detected return immediately, but restore the participant's saved
    // volume gradually so the conference audio does not click or jump.
    remote.audio.volume =
      targetVolume < remote.audio.volume
        ? targetVolume
        : Math.min(
            targetVolume,
            remote.audio.volume + Math.max(0.08, targetVolume * 0.2),
          );
  }
  for (const peerId of nextActive)
    if (!echoGuardActive.has(peerId))
      diagnosticLog("ECHO GUARD ACTIVE", peerId);
  echoGuardActive = nextActive;
}
async function audioLevel(stats: RTCStatsReport) {
  for (const r of stats.values()) {
    const v = (r as unknown as { audioLevel?: unknown }).audioLevel;
    if (typeof v === "number") return v;
  }
  return 0;
}
function startSpeaking() {
  if (statsTimer !== undefined) return;
  statsTimer = window.setInterval(() => {
    void (async () => {
      const now = performance.now();
      if (microphoneProducer) {
        const localLevel = await audioLevel(
          await microphoneProducer.getStats(),
        );
        setSpeaking("self", localLevel);
        if (localLevel >= SPEAKING_THRESHOLD)
          localEchoGuardUntil = now + ECHO_GUARD_HANGOVER_MS;
      }
      await Promise.all(
        [...remoteAudio.values()].map(async (remote) => {
          const level = await audioLevel(await remote.consumer.getStats());
          remoteAudioLevels.set(remote.peerId, level);
          setSpeaking(remote.peerId, level);
        }),
      );
      applyEchoGuard(performance.now());
    })();
  }, 100);
}
function stopSpeaking() {
  if (statsTimer !== undefined) window.clearInterval(statsTimer);
  statsTimer = undefined;
  speakingUntil.clear();
  remoteAudioLevels.clear();
  localEchoGuardUntil = 0;
  echoGuardActive.clear();
  for (const remote of remoteAudio.values())
    remote.audio.volume = participantVolume(remote.peerId) / 100;
}
function scheduleReconnect() {
  if (intentionalDisconnect || reconnectTimer !== undefined) return;
  const delay =
    RECONNECT_DELAYS[Math.min(reconnectAttempt++, RECONNECT_DELAYS.length - 1)];
  setConnection("reconnecting");
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    void connect(true);
  }, delay);
}
function closeMedia() {
  microphoneProducer?.close();
  sendTransport?.close();
  recvTransport?.close();
  outgoingStream?.getTracks().forEach((t) => t.stop());
  closeAi(outgoingAi);
  for (const [id, i] of remoteAudio) {
    i.consumer.close();
    i.audio.pause();
    i.audio.srcObject = null;
    remoteAudio.delete(id);
  }
  microphoneProducer = undefined;
  sendTransport = recvTransport = undefined;
  outgoingStream = undefined;
  outgoingTrack = undefined;
  outgoingAi = undefined;
  device = undefined;
  screenAudioSupported = false;
  ownPeerId = "";
  knownUsers.clear();
  producerPeers.clear();
  screenProducerPeers.clear();
  screenAudioProducerPeers.clear();
  audioSubscriptions.clear();
  screenSubscriptions.clear();
  screenAudioSubscriptions.clear();
  stoppedScreenProducers.clear();
  stoppedScreenAudioProducers.clear();
  ownScreenSoundActive = false;
  screenProducer?.close();
  screenAudioProducer?.close();
  screenStream?.getTracks().forEach((t) => t.stop());
  screenProducer = undefined;
  screenAudioProducer = undefined;
  screenStream = undefined;
  screenRtc?.close();
  screenRtc = undefined;
  screenEventCleanup.forEach((unlisten) => unlisten());
  screenEventCleanup = [];
  if (screenWindow) {
    void screenWindow.close();
    screenWindow = undefined;
    screenWindowPeerId = "";
  }
  for (const [id, i] of remoteScreens) {
    i.consumer.close();
    i.video.pause();
    i.video.srcObject = null;
    remoteScreens.delete(id);
  }
  for (const [id, i] of remoteScreenAudio) {
    i.consumer.close();
    remoteScreenAudio.delete(id);
  }
  screens.replaceChildren();
  screens.hidden = true;
  screenButton.textContent = `🖥 ${t("screenShare")}`;
  users.replaceChildren();
  stopSpeaking();
}
function teardown(message?: string) {
  stopHeartbeat();
  closeMedia();
  for (const item of pending.values())
    item.reject(new Error(message ?? "Disconnected"));
  pending.clear();
  socket = undefined;
}
function fallbackToStandard() {
  noiseMode = "off";
  localStorage.setItem("biclex-noise-mode", noiseMode);
  updateNoiseUi();
}
async function connect(reconnecting = false, noMicrophone = false) {
  const name = nameInput.value.trim();
  if (!name || joining) return;
  joining = true;
  updateJoinButton();
  if (!reconnecting) {
    intentionalDisconnect = false;
    stopMonitor();
    activeServer = selectedServer();
    if (!activeServer) {
      setSetupError(t("addOrCreateServer"));
      joining = false;
      updateJoinButton();
      return;
    }
    resetChatHistory();
    pendingChatAttachments = [];
    renderPendingAttachments();
    uploadState.textContent = "";
    setSetupError(t("checkingLocalServer"));
    localSignaling = await probeLocalSignaling();
  } else {
    teardown("Reconnecting");
    resetChatHistory();
  }
  try {
    if (!activeServer) throw new Error(t("serverNotSelected"));
    const signalingUrl = websocketUrl(activeServer, localSignaling);
    const ws = new WebSocket(signalingUrl);
    socket = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (m.type === "pong") lastPongAt = Date.now();
      if (m.requestId && pending.has(m.requestId)) {
        const p = pending.get(m.requestId)!;
        pending.delete(m.requestId);
        p.resolve(m);
      } else void handleEvent(m);
    };
    ws.onclose = (e) => {
      diagnosticLog("WS close", e.code, e.reason);
      console.warn("BicLex Hub: WS close", e.code, e.reason);
      if (socket !== ws) return;
      teardown("Connection closed");
      if (!intentionalDisconnect) scheduleReconnect();
    };
    ws.onerror = () => {
      diagnosticLog("WS error");
      console.warn("BicLex Hub: WS error");
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        diagnosticLog("WS open", signalingUrl);
        console.debug("BicLex Hub: WS open", signalingUrl);
        startHeartbeat();
        resolve();
      };
      ws.onerror = () => reject(new Error("WebSocket connection failed"));
    });
    setSetupError(t("enteringRoom"));
    const joined = await request("join", { name }).then(ensureOk);
    const joinedName = String(joined.name ?? name);
    ownPeerId = String(joined.peerId ?? "");
    screenAudioSupported = Boolean(joined.screenAudioSupported);
    diagnosticLog("SCREEN AUDIO SUPPORTED", screenAudioSupported);
    setSetupError(t("loadingAudio"));
    const caps = await request("getRouterRtpCapabilities").then(ensureOk);
    device = new Device();
    await device.load({
      routerRtpCapabilities:
        caps.routerRtpCapabilities as MediasoupTypes.RtpCapabilities,
    });
    recvTransport = createRecvTransport(
      await request("createRecvTransport").then(ensureOk),
    );
    sendTransport = createSendTransport(
      await request("createSendTransport").then(ensureOk),
    );
    await subscribeKnownMedia();
    showRoom(true);
    setConnection("online");
    if (!noMicrophone) {
      setSetupError(t("connectingMicrophone"));
      if (noiseMode === "ai")
        try {
          outgoingAi = await createAiAudio();
          outgoingTrack = outgoingAi.outputTrack;
        } catch {
          fallbackToStandard();
          outgoingStream = await captureDirect("standard");
          outgoingTrack = outgoingStream.getAudioTracks()[0];
        }
      else {
        outgoingStream = await captureDirect("off");
        outgoingTrack = outgoingStream.getAudioTracks()[0];
      }
      const microphoneSettings = outgoingTrack.getSettings();
      diagnosticLog("MIC PROCESSING", {
        echoCancellation: microphoneSettings.echoCancellation,
        noiseSuppression: microphoneSettings.noiseSuppression,
        autoGainControl: microphoneSettings.autoGainControl,
        channelCount: microphoneSettings.channelCount,
      });
      setSetupError(t("connectingAudio"));
      const producerPromise = withTimeout(
        sendTransport!.produce({ track: outgoingTrack! }),
        "sendTransport.produce",
      );
      diagnosticLog("PRODUCE WAIT START");
      producerPromise
        .then((producer) => {
          microphoneProducer = producer;
          diagnosticLog("PRODUCE RESOLVED", producer.id);
          if (producer.track?.id !== outgoingTrack!.id)
            diagnosticLog("PRODUCE TRACK MISMATCH");
        })
        .catch((error) => {
          diagnosticLog(
            "PRODUCE FAILED",
            error instanceof Error ? error.message : String(error),
          );
          console.warn("BicLex Hub: produce failed", error);
        });
    }
    renderUser({ peerId: "self", name: joinedName });
    showRoom(true);
    setConnection("online");
    startSpeaking();
    reconnectAttempt = 0;
    leaveButton.disabled = false;
    muteButton.disabled = noMicrophone;
    updateNoiseUi();
  } catch (error) {
    console.warn("BicLex Hub: connection failed", error);
    const failedSocket = socket;
    intentionalDisconnect = !reconnecting;
    teardown("Connection failed");
    failedSocket?.close(4001, "connection setup failed");
    if (reconnecting) scheduleReconnect();
    else
      setSetupError(
        error instanceof Error ? error.message : t("connectionFailed"),
      );
  } finally {
    joining = false;
    updateJoinButton();
  }
}
async function handleEvent(m: ServerMessage) {
  if (m.type === "chatHistory") {
    renderInitialChatHistory(m.messages as ChatMessage[], Boolean(m.hasMore));
  }
  if (m.type === "chatMessage") {
    const message = m.message as ChatMessage;
    renderChatMessage(message);
    if (message.senderPeerId !== ownPeerId)
      void playEventSound("messageReceived");
  }
  if (m.type === "users")
    for (const u of m.users as User[]) {
      knownUsers.set(u.peerId, u);
      if (u.producerId) producerPeers.set(u.producerId, u.peerId);
      if (u.screenProducerId)
        screenProducerPeers.set(u.screenProducerId, u.peerId);
      if (u.screenAudioProducerId)
        screenAudioProducerPeers.set(u.screenAudioProducerId, u.peerId);
      renderUser(u);
      if (recvTransport && u.producerId) void subscribe(u.peerId, u.producerId);
      if (recvTransport && u.screenAudioProducerId)
        void subscribeScreenAudio(u.peerId, u.screenAudioProducerId);
      if (recvTransport && u.screenProducerId)
        void subscribeScreen(u.peerId, u.screenProducerId);
    }
  if (m.type === "userJoined") {
    const u = { peerId: String(m.peerId), name: String(m.name) };
    knownUsers.set(u.peerId, u);
    renderUser(u);
    void playEventSound("participantJoined");
  }
  if (m.type === "userLeft") {
    const peer = String(m.peerId);
    for (const [id, owner] of producerPeers)
      if (owner === peer) removeRemote(id);
    for (const [id, owner] of screenAudioProducerPeers)
      if (owner === peer) removeScreenAudio(id);
    knownUsers.delete(peer);
    removeUser(peer);
    void playEventSound("participantLeft");
  }
  if (m.type === "producerClosed") removeRemote(String(m.producerId));
  if (m.type === "screenProducerStopped") {
    const producerId = String(m.producerId);
    stoppedScreenProducers.add(producerId);
    removeScreen(producerId, String(m.peerId));
    void playEventSound("screenStopped");
  }
  if (m.type === "screenProducerStarted") {
    const peerId = String(m.peerId),
      producerId = String(m.producerId);
    stoppedScreenProducers.delete(producerId);
    screenProducerPeers.set(producerId, peerId);
    void playEventSound("screenStarted");
    if (recvTransport) await subscribeScreen(peerId, producerId);
    updateScreenIndicator(peerId, true);
  }
  if (m.type === "screenAudioProducerStopped") {
    const producerId = String(m.producerId);
    stoppedScreenAudioProducers.add(producerId);
    removeScreenAudio(producerId);
  }
  if (m.type === "screenAudioProducerStarted") {
    const peerId = String(m.peerId),
      producerId = String(m.producerId);
    stoppedScreenAudioProducers.delete(producerId);
    screenAudioProducerPeers.set(producerId, peerId);
    if (recvTransport) await subscribeScreenAudio(peerId, producerId);
  }
  if (m.type === "newProducer") {
    const peerId = String(m.peerId),
      producerId = String(m.producerId);
    producerPeers.set(producerId, peerId);
    if (recvTransport) await subscribe(peerId, producerId);
  }
}
async function subscribeKnownMedia() {
  diagnosticLog(
    "SUBSCRIBE KNOWN MEDIA",
    `audio=${producerPeers.size}`,
    `screen=${screenProducerPeers.size}`,
    `screenAudio=${screenAudioProducerPeers.size}`,
  );
  await Promise.all([
    ...[...producerPeers].map(([producerId, peerId]) =>
      subscribe(peerId, producerId),
    ),
    ...[...screenAudioProducerPeers].map(([producerId, peerId]) =>
      subscribeScreenAudio(peerId, producerId),
    ),
    ...[...screenProducerPeers].map(([producerId, peerId]) =>
      subscribeScreen(peerId, producerId),
    ),
  ]);
}
async function subscribeScreen(peerId: string, producerId: string) {
  if (
    remoteScreens.has(producerId) ||
    screenSubscriptions.has(producerId) ||
    stoppedScreenProducers.has(producerId) ||
    !recvTransport ||
    !device
  )
    return;
  screenSubscriptions.add(producerId);
  try {
    const reply = await request("consume", {
      producerId,
      rtpCapabilities: device.recvRtpCapabilities,
    }).then(ensureOk);
    const data = reply.consumer as {
      id: string;
      producerId: string;
      kind: "video";
      rtpParameters: MediasoupTypes.RtpParameters;
    };
    const consumer = await recvTransport.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([consumer.track]);
    remoteScreens.set(producerId, { video, consumer, peerId });
    consumer.track.addEventListener(
      "ended",
      () => removeScreen(producerId, peerId),
      { once: true },
    );
    updateScreenIndicator(peerId, true);
    await request("resumeConsumer", { consumerId: data.id }).then(ensureOk);
    await video.play().catch(() => undefined);
  } catch (error) {
    diagnosticLog(
      "SCREEN CONSUME FAILED",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    screenSubscriptions.delete(producerId);
  }
}
async function subscribeScreenAudio(peerId: string, producerId: string) {
  if (
    remoteScreenAudio.has(producerId) ||
    screenAudioSubscriptions.has(producerId) ||
    stoppedScreenAudioProducers.has(producerId) ||
    !recvTransport ||
    !device
  )
    return;
  screenAudioSubscriptions.add(producerId);
  try {
    const reply = await request("consume", {
      producerId,
      rtpCapabilities: device.recvRtpCapabilities,
    }).then(ensureOk);
    const data = reply.consumer as {
      id: string;
      producerId: string;
      kind: "audio";
      rtpParameters: MediasoupTypes.RtpParameters;
    };
    const consumer = await recvTransport.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });
    remoteScreenAudio.set(producerId, { consumer, peerId });
    consumer.track.addEventListener(
      "ended",
      () => removeScreenAudio(producerId),
      { once: true },
    );
    await request("resumeConsumer", { consumerId: data.id }).then(ensureOk);
    diagnosticLog("SCREEN AUDIO CONSUMER READY", peerId, producerId);
  } catch (error) {
    diagnosticLog(
      "SCREEN AUDIO CONSUME FAILED",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    screenAudioSubscriptions.delete(producerId);
  }
}
async function subscribe(peerId: string, producerId: string) {
  if (peerId === ownPeerId) {
    diagnosticLog("AUDIO SELF SUBSCRIPTION BLOCKED", peerId, producerId);
    return;
  }
  if (
    remoteAudio.has(producerId) ||
    audioSubscriptions.has(producerId) ||
    !recvTransport ||
    !device
  )
    return;
  audioSubscriptions.add(producerId);
  diagnosticLog("AUDIO SUBSCRIBE START", peerId, producerId);
  try {
    const reply = await request("consume", {
        producerId,
        rtpCapabilities: device.recvRtpCapabilities,
      }).then(ensureOk),
      data = reply.consumer as {
        id: string;
        producerId: string;
        kind: "audio";
        rtpParameters: MediasoupTypes.RtpParameters;
      },
      consumer = await recvTransport.consume({
        id: data.id,
        producerId: data.producerId,
        kind: data.kind,
        rtpParameters: data.rtpParameters,
      }),
      audio = new Audio();
    audio.autoplay = true;
    audio.volume = participantVolume(peerId) / 100;
    audio.srcObject = new MediaStream([consumer.track]);
    await applyAudioOutput(audio);
    remoteAudio.set(producerId, { audio, consumer, peerId });
    await request("resumeConsumer", { consumerId: data.id }).then(ensureOk);
    await audio.play();
    diagnosticLog("DIRECT AUDIO PLAYING", peerId, `volume=${audio.volume}`);
    diagnosticLog(
      "AUDIO SUBSCRIBE READY",
      peerId,
      producerId,
      consumer.track.readyState,
    );
  } catch (error) {
    diagnosticLog(
      "AUDIO SUBSCRIBE FAILED",
      peerId,
      producerId,
      error instanceof Error ? error.message : String(error),
    );
    console.warn("BicLex Hub: subscribe failed", error);
  } finally {
    audioSubscriptions.delete(producerId);
  }
}
function removeRemote(id: string) {
  const i = remoteAudio.get(id);
  i?.consumer.close();
  i?.audio.pause();
  if (i) i.audio.srcObject = null;
  remoteAudio.delete(id);
  if (
    i &&
    ![...remoteAudio.values()].some((remote) => remote.peerId === i.peerId)
  )
    remoteAudioLevels.delete(i.peerId);
  producerPeers.delete(id);
}
function removeScreen(id: string, ownerOverride = "") {
  const i = remoteScreens.get(id);
  const owner = ownerOverride || screenProducerPeers.get(id) || i?.peerId;
  i?.consumer.close();
  i?.video.pause();
  if (i) i.video.srcObject = null;
  remoteScreens.delete(id);
  screenProducerPeers.delete(id);
  if (owner) {
    updateScreenIndicator(owner, false);
    if (screenWindowPeerId === owner) void closeScreenViewer();
  }
  if (!owner && screenWindow) void closeScreenViewer();
}
function removeScreenAudio(id: string) {
  const item = remoteScreenAudio.get(id);
  item?.consumer.close();
  remoteScreenAudio.delete(id);
  screenAudioProducerPeers.delete(id);
}
function updateScreenIndicator(peerId: string, active: boolean) {
  const icon = document.querySelector<HTMLButtonElement>(
    `[data-peer="${CSS.escape(peerId)}"] .screen-icon`,
  );
  if (!icon) return;
  icon.hidden = !active;
  icon.innerHTML = active ? "📺<i></i>" : "";
  icon.onclick = active
    ? () => {
        void openScreen(peerId);
      }
    : null;
}
async function openScreen(peerId: string) {
  const ownScreen = peerId === "self";
  const producerId = ownScreen
    ? screenProducer?.id
    : [...screenProducerPeers.entries()].find(
        ([, owner]) => owner === peerId,
      )?.[0];
  if (!producerId) return;
  const videoStream = ownScreen
    ? screenStream
    : (remoteScreens.get(producerId)?.video.srcObject as
        MediaStream | undefined);
  if (!videoStream) return;
  const audioTrack = ownScreen
    ? screenStream?.getAudioTracks()[0]
    : [...remoteScreenAudio.values()].find((item) => item.peerId === peerId)
        ?.consumer.track;
  const sourceStream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...(audioTrack ? [audioTrack] : []),
  ]);
  await closeScreenViewer();
  const eventKey = producerId.replace(/[^a-zA-Z0-9_-]/g, "");
  const pendingCandidates: RTCIceCandidateInit[] = [];
  screenEventCleanup.push(
    await listen(`screen-ready-${eventKey}`, async () => {
      diagnosticLog("SCREEN VIEWER READY", producerId);
      screenRtc?.close();
      screenRtc = new RTCPeerConnection();
      screenRtc.onicecandidate = (event) => {
        if (event.candidate)
          void emit(
            `screen-host-candidate-${eventKey}`,
            event.candidate.toJSON(),
          );
      };
      const videoTrack = sourceStream.getVideoTracks()[0];
      if (!videoTrack) {
        diagnosticLog("SCREEN TRACK MISSING", producerId);
        return;
      }
      let bridgeVideoSender: RTCRtpSender | undefined;
      for (const track of sourceStream.getTracks()) {
        const sender = screenRtc.addTrack(track, sourceStream);
        if (track.kind === "video") bridgeVideoSender = sender;
      }
      await screenRtc.setLocalDescription(await screenRtc.createOffer());
      const bridgeParameters = bridgeVideoSender!.getParameters();
      bridgeParameters.degradationPreference = "maintain-resolution";
      for (const encoding of bridgeParameters.encodings) {
        encoding.maxBitrate = 50_000_000;
        encoding.maxFramerate = 60;
        encoding.scaleResolutionDownBy = 1;
        encoding.priority = "high";
        encoding.networkPriority = "high";
      }
      await bridgeVideoSender!.setParameters(bridgeParameters);
      await emit(`screen-offer-${eventKey}`, screenRtc.localDescription);
      diagnosticLog(
        "SCREEN OFFER SENT",
        producerId,
        "BRIDGE MAX 50Mbps",
        `audio=${Boolean(audioTrack)}`,
      );
    }),
    await listen<RTCSessionDescriptionInit>(
      `screen-answer-${eventKey}`,
      async (event) => {
        if (!screenRtc) return;
        await screenRtc.setRemoteDescription(event.payload);
        for (const candidate of pendingCandidates.splice(0))
          await screenRtc.addIceCandidate(candidate);
        diagnosticLog("SCREEN ANSWER RECEIVED", producerId);
      },
    ),
    await listen<RTCIceCandidateInit>(
      `screen-viewer-candidate-${eventKey}`,
      async (event) => {
        if (!screenRtc?.remoteDescription)
          pendingCandidates.push(event.payload);
        else await screenRtc.addIceCandidate(event.payload);
      },
    ),
  );
  const title = t("screenTitle", {
    name: ownScreen
      ? nameInput.value.trim()
      : (knownUsers.get(peerId)?.name ?? t("participant")),
  });
  screenWindow = new WebviewWindow(`screen-${eventKey}`, {
    url: `index.html?screenViewer=1&eventKey=${encodeURIComponent(eventKey)}&title=${encodeURIComponent(title)}&ownScreen=${ownScreen ? "1" : "0"}`,
    title,
    width: 960,
    height: 540,
    resizable: true,
    center: true,
  });
  screenWindowPeerId = peerId;
  screenWindow.once("tauri://error", (event) =>
    diagnosticLog("SCREEN WINDOW FAILED", event.payload),
  );
}
async function closeScreenViewer() {
  screenRtc?.close();
  screenRtc = undefined;
  screenEventCleanup.forEach((unlisten) => unlisten());
  screenEventCleanup = [];
  const viewer = screenWindow;
  screenWindow = undefined;
  screenWindowPeerId = "";
  await viewer?.close().catch(() => undefined);
}
function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}
function renderUser(u: User) {
  if (document.querySelector(`[data-peer="${CSS.escape(u.peerId)}"]`)) return;
  const item = document.createElement("li");
  item.dataset.peer = u.peerId;
  const self = u.peerId === "self";
  item.classList.toggle("self", self);
  item.innerHTML = `<span class="avatar">${initials(u.name)}</span><div class="participant-info"><span class="participant-name"></span><label class="participant-volume" ${self ? "hidden" : ""}><span>🔊</span><input type="range" min="0" max="100" step="5" value="100" aria-label="${t("participantVolume")}" /><output>100%</output></label></div><button class="screen-icon" type="button" aria-label="${t("openScreen")}" hidden></button>`;
  item.querySelector(".participant-name")!.textContent = u.name;
  if (!self) {
    const slider = item.querySelector<HTMLInputElement>(
        ".participant-volume input",
      )!,
      output = item.querySelector<HTMLOutputElement>(
        ".participant-volume output",
      )!,
      value = participantVolume(u.peerId);
    slider.value = String(value);
    output.value = `${value}%`;
    slider.oninput = () => {
      const next = Number(slider.value);
      output.value = `${next}%`;
      setParticipantVolume(u.peerId, next);
    };
  }
  users.append(item);
  if (u.screenProducerId) updateScreenIndicator(u.peerId, true);
}
function removeUser(peer: string) {
  document.querySelector(`[data-peer="${CSS.escape(peer)}"]`)?.remove();
  speakingUntil.delete(peer);
}
function leave() {
  intentionalDisconnect = true;
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const ws = socket;
  teardown("Left room");
  ws?.close(1000, "leave");
  showRoom(false);
  setSetupError();
  muteButton.disabled = leaveButton.disabled = true;
  updateNoiseUi();
  void checkForUpdate();
}
nameInput.oninput = () => {
  localStorage.setItem("biclex-username", nameInput.value);
  updateJoinButton();
};
joinButton.onclick = (event) => {
  void connect(false, event.ctrlKey);
};
leaveButton.onclick = leave;
monitorButton.onclick = () => {
  void toggleMonitor();
};
inputDevice.onchange = () => {
  selectedDeviceId = inputDevice.value;
  if (selectedDeviceId)
    localStorage.setItem("biclex-input-device", selectedDeviceId);
  else localStorage.removeItem("biclex-input-device");
};
outputDevice.onchange = () => {
  selectedOutputDeviceId = outputDevice.value;
  if (selectedOutputDeviceId)
    localStorage.setItem("biclex-output-device", selectedOutputDeviceId);
  else localStorage.removeItem("biclex-output-device");
  if (monitorAudio) void applyAudioOutput(monitorAudio);
  for (const { audio } of remoteAudio.values()) void applyAudioOutput(audio);
};
muteButton.onclick = toggleMute;
screenButton.onclick = async () => {
  if (!sendTransport) return;
  if (screenProducer) {
    const producerId = screenProducer.id;
    const audioProducerId = screenAudioProducer?.id;
    if (audioProducerId)
      void request("closeProducer", {
        producerId: audioProducerId,
      }).catch(() => undefined);
    void request("closeProducer", { producerId }).catch(() => undefined);
    screenAudioProducer?.close();
    screenProducer.close();
    updateScreenIndicator("self", false);
    if (screenWindowPeerId === "self") void closeScreenViewer();
    playOwnScreenStoppedSound();
    screenStream?.getTracks().forEach((t) => t.stop());
    screenProducer = undefined;
    screenAudioProducer = undefined;
    screenStream = undefined;
    screenQualitySelect.disabled = false;
    screenButton.textContent = `🖥 ${t("screenShare")}`;
    return;
  }
  try {
    const profile = SCREEN_PROFILES[screenQuality];
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: profile.width, max: profile.width },
        height: { ideal: profile.height, max: profile.height },
        frameRate: { ideal: profile.fps, max: profile.fps },
      },
      audio: true,
    });
    const track = screenStream.getVideoTracks()[0];
    const audioTrack = screenStream.getAudioTracks()[0];
    track.contentHint = "detail";
    if (audioTrack && screenAudioSupported) {
      audioTrack.contentHint = "music";
      screenAudioProducer = await withTimeout(
        sendTransport.produce({
          track: audioTrack,
          appData: { source: "screen-audio" },
          codecOptions: {
            opusStereo: true,
            opusDtx: false,
            opusFec: true,
          },
        }),
        "screenShare.audio.produce",
      );
      audioTrack.onended = () => {
        const producerId = screenAudioProducer?.id;
        if (producerId)
          void request("closeProducer", { producerId }).catch(() => undefined);
        screenAudioProducer?.close();
        screenAudioProducer = undefined;
      };
    } else if (audioTrack) {
      audioTrack.stop();
      diagnosticLog("SCREEN AUDIO DISABLED BY LEGACY SERVER");
    }
    screenProducer = await withTimeout(
      sendTransport.produce({
        track,
        appData: { source: "screen-video" },
        encodings: [
          {
            maxBitrate: profile.bitrate,
            maxFramerate: profile.fps,
            scaleResolutionDownBy: 1,
            priority: "high",
            networkPriority: "high",
            dtx: true,
          },
        ],
        codecOptions: {
          videoGoogleStartBitrate: profile.startBitrate,
          videoGoogleMinBitrate: Math.round(profile.startBitrate / 2),
          videoGoogleMaxBitrate: Math.round(profile.bitrate / 1_000),
        },
      }),
      "screenShare.produce",
    );
    const sender = screenProducer.rtpSender;
    if (sender) {
      const parameters = sender.getParameters();
      parameters.degradationPreference = "maintain-resolution";
      await sender.setParameters(parameters);
    }
    screenQualitySelect.disabled = true;
    updateScreenIndicator("self", true);
    ownScreenSoundActive = true;
    void playEventSound("screenStarted");
    diagnosticLog(
      "SCREEN QUALITY",
      screenQuality,
      profile,
      track.getSettings(),
    );
    screenButton.textContent = `■ ${t("stopScreenShare")}`;
    track.onended = () => {
      const producerId = screenProducer?.id;
      const audioProducerId = screenAudioProducer?.id;
      if (audioProducerId)
        void request("closeProducer", {
          producerId: audioProducerId,
        }).catch(() => undefined);
      if (producerId)
        void request("closeProducer", { producerId }).catch(() => undefined);
      screenAudioProducer?.close();
      screenProducer?.close();
      screenAudioProducer = undefined;
      screenProducer = undefined;
      screenStream = undefined;
      updateScreenIndicator("self", false);
      if (screenWindowPeerId === "self") void closeScreenViewer();
      screenQualitySelect.disabled = false;
      screenButton.textContent = `🖥 ${t("screenShare")}`;
      playOwnScreenStoppedSound();
    };
  } catch (error) {
    const audioProducerId = screenAudioProducer?.id;
    if (audioProducerId)
      void request("closeProducer", { producerId: audioProducerId }).catch(
        () => undefined,
      );
    screenAudioProducer?.close();
    screenAudioProducer = undefined;
    screenStream?.getTracks().forEach((t) => t.stop());
    screenStream = undefined;
    screenQualitySelect.disabled = false;
    diagnosticLog(
      "SCREEN SHARE FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
};
noiseButtons.forEach(
  (b) => (b.onclick = () => setNoiseMode(b.dataset.noise as NoiseMode)),
);
screenQualitySelect.onchange = () => {
  screenQuality = screenQualitySelect.value as ScreenQuality;
  localStorage.setItem("biclex-screen-quality", screenQuality);
  diagnosticLog("SCREEN QUALITY SELECTED", screenQuality);
};
if (navigator.mediaDevices)
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void refreshDevices();
  });
window.addEventListener("beforeunload", () => {
  intentionalDisconnect = true;
  stopHeartbeat();
});
if (navigator.mediaDevices) void refreshDevices(true);
updateJoinButton();
updateNoiseUi();
versionButton.onclick = () => {
  if (isTauri) void invoke("open_devtools");
};
let updateCheckRunning = false;
async function checkForUpdate() {
  if (updateCheckRunning || updateButton.disabled) return;
  updateCheckRunning = true;
  try {
    const update = await check();
    if (!update) {
      updateButton.hidden = true;
      joinButton.classList.remove("has-update");
      return;
    }
    updateButton.hidden = false;
    updateButton.textContent = t("update");
    joinButton.classList.add("has-update");
    updateButton.onclick = async () => {
      updateButton.disabled = true;
      updateButton.textContent = t("updating");
      await update.downloadAndInstall();
      await relaunch();
    };
  } catch (error) {
    diagnosticLog(
      "UPDATE CHECK FAILED",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    updateCheckRunning = false;
  }
}
if (isTauri) void checkForUpdate();
diagnosticLog(
  "DIAGNOSTIC BUILD START",
  `VERSION ${CLIENT_VERSION}`,
  "TURN credentials are handled without logging secrets",
);
function instrumentTransport(t: MediasoupTypes.Transport, label: string) {
  t.on("connectionstatechange", (state) => {
    diagnosticLog(`${label} connectionState`, state);
    console.debug(`${label} connectionState:`, state);
  });
  t.on("icegatheringstatechange", (state) => {
    diagnosticLog(`${label} iceGatheringState`, state);
    console.debug(`${label} iceGatheringState:`, state);
  });
  t.on("icecandidateerror", (error) => {
    const e = error as unknown as {
      url?: string;
      address?: string;
      port?: number;
      errorCode?: number;
      errorText?: string;
    };
    const details = {
      url: e.url,
      address: e.address,
      port: e.port,
      errorCode: e.errorCode,
      errorText: e.errorText,
    };
    diagnosticLog(`${label} ICE candidate error`, details);
    console.warn(`${label} ICE candidate error:`, details);
  });
}
function localTransport(m: ServerMessage) {
  const transport = m.transport as MediasoupTypes.TransportOptions & {
    iceCandidates?: Array<{ address: string; [key: string]: unknown }>;
    turnIceServers?: RTCIceServer[];
  };
  return {
    ...transport,
    iceServers: turnIceServers.length
      ? turnIceServers
      : transport.turnIceServers,
    iceTransportPolicy: (import.meta.env.VITE_FORCE_TURN === "true"
      ? "relay"
      : "all") as RTCIceTransportPolicy,
    ...(localSignaling
      ? {
          iceCandidates: transport.iceCandidates?.map((candidate) => ({
            ...candidate,
            address: "10.70.0.50",
          })),
        }
      : {}),
  } as MediasoupTypes.TransportOptions;
}
function createSendTransport(m: ServerMessage) {
  const t = device!.createSendTransport(localTransport(m));
  instrumentTransport(t, "SEND");
  t.on("connect", ({ dtlsParameters }, cb, eb) => {
    request("connectSendTransport", { dtlsParameters })
      .then(ensureOk)
      .then(cb)
      .catch(eb);
  });
  t.on("produce", ({ kind, rtpParameters, appData }, cb, eb) => {
    request("produce", {
      kind,
      rtpParameters,
      source: typeof appData.source === "string" ? appData.source : undefined,
    })
      .then(ensureOk)
      .then((r) => cb({ id: String(r.producerId) }))
      .catch(eb);
  });
  return t;
}
function createRecvTransport(m: ServerMessage) {
  const t = device!.createRecvTransport(localTransport(m));
  instrumentTransport(t, "RECV");
  t.on("connect", ({ dtlsParameters }, cb, eb) => {
    request("connectRecvTransport", { dtlsParameters })
      .then(ensureOk)
      .then(cb)
      .catch(eb);
  });
  return t;
}

const viewerParams = new URLSearchParams(location.search);
if (viewerParams.get("screenViewer") === "1") {
  app.innerHTML = `<div class="standalone-screen"><header>📺 ${viewerParams.get("title") ?? t("screenShare")}</header><video autoplay playsinline></video></div>`;
  void (async () => {
    const eventKey = viewerParams.get("eventKey") ?? "screen";
    const viewerVideo = app.querySelector("video") as HTMLVideoElement;
    const viewerStream = new MediaStream();
    viewerVideo.srcObject = viewerStream;
    viewerVideo.muted = viewerParams.get("ownScreen") === "1";
    const viewerRtc = new RTCPeerConnection();
    const pendingCandidates: RTCIceCandidateInit[] = [];
    let offerReceived = false;
    viewerRtc.ontrack = (event) => {
      if (
        !viewerStream.getTracks().some((track) => track.id === event.track.id)
      )
        viewerStream.addTrack(event.track);
      void viewerVideo.play().catch(() => undefined);
      const outputDeviceId = localStorage.getItem("biclex-output-device") ?? "";
      if (outputDeviceId && "setSinkId" in viewerVideo)
        void (
          viewerVideo as HTMLVideoElement & {
            setSinkId(deviceId: string): Promise<void>;
          }
        )
          .setSinkId(outputDeviceId)
          .catch(() => undefined);
      diagnosticLog(
        "SCREEN VIEWER TRACK RECEIVED",
        event.track.kind,
        event.track.readyState,
      );
    };
    viewerRtc.onicecandidate = (event) => {
      if (event.candidate)
        void emit(
          `screen-viewer-candidate-${eventKey}`,
          event.candidate.toJSON(),
        );
    };
    await listen<RTCSessionDescriptionInit>(
      `screen-offer-${eventKey}`,
      async (event) => {
        offerReceived = true;
        await viewerRtc.setRemoteDescription(event.payload);
        for (const candidate of pendingCandidates.splice(0))
          await viewerRtc.addIceCandidate(candidate);
        await viewerRtc.setLocalDescription(await viewerRtc.createAnswer());
        await emit(`screen-answer-${eventKey}`, viewerRtc.localDescription);
        diagnosticLog("SCREEN VIEWER ANSWER SENT", eventKey);
      },
    );
    await listen<RTCIceCandidateInit>(
      `screen-host-candidate-${eventKey}`,
      async (event) => {
        if (!viewerRtc.remoteDescription) pendingCandidates.push(event.payload);
        else await viewerRtc.addIceCandidate(event.payload);
      },
    );
    const readyTimer = window.setInterval(() => {
      if (offerReceived) window.clearInterval(readyTimer);
      else void emit(`screen-ready-${eventKey}`);
    }, 500);
    await emit(`screen-ready-${eventKey}`);
    diagnosticLog("SCREEN VIEWER READY SENT", eventKey);
  })();
}

undefined;
