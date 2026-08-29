const baseUrl = process.env.HUB_URL;
const token = process.env.HUB_TOKEN;
const chatMessage = process.env.HUB_CHAT_MESSAGE;

if (!baseUrl || !token) {
  console.error("HUB_URL and HUB_TOKEN are required");
  process.exit(2);
}

const url = new URL("/ws", baseUrl);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.searchParams.set("token", token);

const socket = new WebSocket(url);
const received = [];
const timeout = setTimeout(() => {
  console.error("Production smoke test timed out", received);
  process.exit(1);
}, 15_000);

function send(requestId, type, fields = {}) {
  socket.send(JSON.stringify({ requestId, type, ...fields }));
}

socket.addEventListener("open", () => {
  send("smoke-join", "join", { name: "BicLex Smoke Test" });
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  received.push(message.type);

  if (message.requestId === "smoke-join" && message.ok) {
    if (chatMessage) {
      send("smoke-chat", "sendChatMessage", {
        text: chatMessage,
        attachments: [],
      });
    } else {
      send("smoke-ping", "ping");
    }
  }

  if (
    (message.requestId === "smoke-chat" ||
      message.requestId === "smoke-ping") &&
    message.ok
  ) {
    send("smoke-leave", "leave");
    clearTimeout(timeout);
    console.log(
      JSON.stringify({
        wss: "PASS",
        join: "PASS",
        chat: chatMessage ? "PASS" : "SKIPPED",
        historyReceived: received.includes("chatHistory"),
      }),
    );
    socket.close();
  }
});

socket.addEventListener("error", () => {
  clearTimeout(timeout);
  console.error("Production WebSocket connection failed");
  process.exit(1);
});
