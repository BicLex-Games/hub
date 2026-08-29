import { t } from "./i18n";

export type HubServer = {
  id: string;
  name: string;
  address: string;
  token: string;
  owned: boolean;
  createdAt: number;
};

const SERVERS_KEY = "biclex-hub-servers-v1";
const SELECTED_KEY = "biclex-hub-selected-server";

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
  const map = new Map<string, HubServer>();
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
  localStorage.setItem(SERVERS_KEY, JSON.stringify(servers));
}

export function selectedServer(): HubServer | undefined {
  const servers = loadServers();
  const selectedId = localStorage.getItem(SELECTED_KEY);
  return servers.find((item) => item.id === selectedId) ?? servers[0];
}

export function selectServer(id: string) {
  localStorage.setItem(SELECTED_KEY, id);
}

export function uniqueServerName(requested: string, servers = loadServers()) {
  const base = requested.trim() || t("untitled");
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
  return `BicLex-Hub|2|${encodeURIComponent(server.name)}|${encodeURIComponent(server.address)}|${encodeURIComponent(server.token)}`;
}

export function parseConnectionCode(code: string) {
  const parts = code.trim().split("|");
  const [kind, version] = parts;
  if (!["BicLex-Hub", "BICLEX-HUB"].includes(kind))
    throw new Error(t("invalidConnectionCode"));
  let encodedName = "";
  let encodedAddress = "";
  let encodedToken = "";
  if (version === "2" && parts.length === 5) {
    [, , encodedName, encodedAddress, encodedToken] = parts;
  } else if (version === "1" && parts.length === 4) {
    [, , encodedAddress, encodedToken] = parts;
  } else {
    throw new Error(t("unsupportedConnectionCode"));
  }
  if (!encodedAddress || !encodedToken)
    throw new Error(t("invalidConnectionCode"));
  const address = normalizeAddress(decodeURIComponent(encodedAddress));
  const token = decodeURIComponent(encodedToken).trim();
  const name = decodeURIComponent(encodedName).trim() || t("untitled");
  if (!token) throw new Error(t("missingRoomToken"));
  return { name, address, token };
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
