export type HubServer = {
  id: string;
  name: string;
  address: string;
  token: string;
  owned: boolean;
  builtin?: boolean;
  createdAt: number;
};

const SERVERS_KEY = "biclex-hub-servers-v1";
const SELECTED_KEY = "biclex-hub-selected-server";

export const builtinServer: HubServer = {
  id: "biclex-production",
  name: "BicLex Production",
  address: "https://hub.biclex.ru",
  token: "",
  owned: false,
  builtin: true,
  createdAt: 0,
};

export function normalizeAddress(value: string): string {
  let address = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(address)) address = `http://${address}`;
  const url = new URL(address);
  if (!url.port && url.protocol === "http:") url.port = "8123";
  return url.origin;
}

export function loadServers(): HubServer[] {
  let saved: HubServer[] = [];
  try {
    saved = JSON.parse(
      localStorage.getItem(SERVERS_KEY) ?? "[]",
    ) as HubServer[];
  } catch {
    saved = [];
  }
  const map = new Map<string, HubServer>([[builtinServer.id, builtinServer]]);
  for (const item of saved) {
    if (!item?.id || !item.name || !item.address) continue;
    try {
      map.set(item.id, { ...item, address: normalizeAddress(item.address) });
    } catch {
      /* ignore invalid legacy entries */
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      Number(b.owned) - Number(a.owned) ||
      a.name.localeCompare(b.name, "ru", { sensitivity: "base" }),
  );
}

export function saveServers(servers: HubServer[]) {
  localStorage.setItem(
    SERVERS_KEY,
    JSON.stringify(servers.filter((item) => !item.builtin)),
  );
}

export function selectedServer(): HubServer {
  const servers = loadServers();
  const selectedId = localStorage.getItem(SELECTED_KEY);
  return (
    servers.find((item) => item.id === selectedId) ??
    servers[0] ??
    builtinServer
  );
}

export function selectServer(id: string) {
  localStorage.setItem(SELECTED_KEY, id);
}

export function uniqueServerName(requested: string, servers = loadServers()) {
  const base = requested.trim() || "Без названия";
  if (
    !servers.some(
      (item) => item.name.toLocaleLowerCase() === base.toLocaleLowerCase(),
    )
  )
    return base;
  let suffix = 1;
  while (
    servers.some(
      (item) =>
        item.name.toLocaleLowerCase() ===
        `${base}#${suffix}`.toLocaleLowerCase(),
    )
  )
    suffix += 1;
  return `${base}#${suffix}`;
}

export function createConnectionCode(server: HubServer) {
  return `BicLex-Hub|1|${encodeURIComponent(server.address)}|${encodeURIComponent(server.token)}`;
}

export function parseConnectionCode(code: string) {
  const [kind, version, encodedAddress, encodedToken] = code.trim().split("|");
  if (
    !["BicLex-Hub", "BICLEX-HUB"].includes(kind) ||
    version !== "1" ||
    !encodedAddress ||
    !encodedToken
  )
    throw new Error("Некорректный код подключения");
  const address = normalizeAddress(decodeURIComponent(encodedAddress));
  const token = decodeURIComponent(encodedToken).trim();
  if (!token) throw new Error("В коде отсутствует токен комнаты");
  return { address, token };
}

export function websocketUrl(server: HubServer, local = false) {
  const base = new URL(local ? "http://10.70.0.50:8123" : server.address);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws";
  base.search = server.token
    ? `?token=${encodeURIComponent(server.token)}`
    : "";
  return base.toString();
}

export function authenticatedUrl(server: HubServer, path: string) {
  const url = new URL(path, `${server.address}/`);
  if (server.token) url.searchParams.set("token", server.token);
  return url.toString();
}
