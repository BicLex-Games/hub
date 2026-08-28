use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Multipart, Path, Query, State,
    },
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router as AxumRouter,
};
use futures_util::{SinkExt, StreamExt};
use mediasoup::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    net::{IpAddr, Ipv4Addr},
    num::{NonZeroU32, NonZeroU8},
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, Mutex};
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};
use tracing::{debug, info};

const ROOM_NAME: &str = "main";
const MAX_PEERS: usize = 20;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ClientCommand {
    Join {
        name: String,
    },
    GetRouterRtpCapabilities,
    CreateSendTransport,
    ConnectSendTransport {
        dtls_parameters: Value,
    },
    Produce {
        kind: String,
        rtp_parameters: Value,
    },
    CreateRecvTransport,
    ConnectRecvTransport {
        dtls_parameters: Value,
    },
    Consume {
        producer_id: String,
        rtp_capabilities: Value,
    },
    ResumeConsumer {
        consumer_id: String,
    },
    CloseProducer {
        producer_id: String,
    },
    SendChatMessage {
        text: String,
        attachments: Vec<ChatAttachment>,
    },
    Leave,
    Ping,
}
#[derive(Debug, Deserialize)]
struct ClientRequest {
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    #[serde(flatten)]
    command: ClientCommand,
}

#[derive(Debug, Serialize, Clone)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ServerEvent {
    Joined {
        peer_id: String,
        name: String,
        room: String,
        turn_ice_servers: Vec<Value>,
    },
    Users {
        users: Vec<UserInfo>,
    },
    UserJoined {
        peer_id: String,
        name: String,
    },
    UserLeft {
        peer_id: String,
    },
    RouterRtpCapabilities {
        router_rtp_capabilities: Value,
    },
    SendTransportCreated {
        transport: Value,
    },
    RecvTransportCreated {
        transport: Value,
    },
    Produced {
        producer_id: String,
    },
    NewProducer {
        peer_id: String,
        producer_id: String,
        name: String,
    },
    ConsumerCreated {
        consumer: Value,
    },
    ProducerClosed {
        peer_id: String,
        producer_id: String,
    },
    ScreenProducerStarted {
        peer_id: String,
        producer_id: String,
    },
    ScreenProducerStopped {
        peer_id: String,
        producer_id: String,
    },
    ChatHistory {
        messages: Vec<ChatMessage>,
    },
    ChatMessage {
        message: ChatMessage,
    },
    Error {
        code: String,
        message: String,
    },
    Pong,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UserInfo {
    peer_id: String,
    name: String,
    producer_id: Option<String>,
    screen_producer_id: Option<String>,
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatAttachment {
    id: String,
    name: String,
    size: u64,
    mime: String,
    url: String,
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: String,
    sender_peer_id: String,
    sender_name: String,
    text: String,
    attachments: Vec<ChatAttachment>,
    created_at: u64,
}
#[derive(Debug, Deserialize)]
struct AuthQuery {
    token: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFile {
    id: String,
    name: String,
    size: u64,
    mime: String,
}
#[derive(Debug, Serialize)]
struct ServerEnvelope {
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    ok: bool,
    #[serde(flatten)]
    event: ServerEvent,
}

struct Peer {
    id: String,
    name: String,
    tx: mpsc::UnboundedSender<ServerEnvelope>,
    send_transport: Option<WebRtcTransport>,
    recv_transport: Option<WebRtcTransport>,
    producer: Option<Producer>,
    screen_producer: Option<Producer>,
    consumers: HashMap<String, Consumer>,
}
struct Room {
    router: mediasoup::router::Router,
    peers: HashMap<String, Peer>,
    messages: VecDeque<ChatMessage>,
    data_dir: PathBuf,
}
#[derive(Clone)]
struct AppState {
    room: Arc<Mutex<Room>>,
    room_token: Arc<String>,
    data_dir: Arc<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();
    let manager = WorkerManager::new();
    let worker = manager.create_worker(WorkerSettings::default()).await?;
    // Opus RTP capability is advertised with its standard two-channel codec profile;
    // the microphone track itself remains mono (channelCount=1) on the client.
    let router = worker
        .create_router(RouterOptions::new(vec![
            RtpCodecCapability::Audio {
                mime_type: MimeTypeAudio::Opus,
                preferred_payload_type: Some(111),
                clock_rate: NonZeroU32::new(48_000).unwrap(),
                channels: NonZeroU8::new(2).unwrap(),
                parameters: RtpCodecParametersParameters::default(),
                rtcp_feedback: vec![RtcpFeedback::Nack, RtcpFeedback::TransportCc],
            },
            RtpCodecCapability::Video {
                mime_type: MimeTypeVideo::Vp8,
                preferred_payload_type: Some(112),
                clock_rate: NonZeroU32::new(90_000).unwrap(),
                parameters: RtpCodecParametersParameters::default(),
                rtcp_feedback: vec![
                    RtcpFeedback::Nack,
                    RtcpFeedback::NackPli,
                    RtcpFeedback::TransportCc,
                ],
            },
        ]))
        .await?;
    info!("mediasoup worker and Opus router initialized");
    let data_dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "/data".into()));
    fs::create_dir_all(data_dir.join("files"))?;
    let messages = load_chat_history(&data_dir)?;
    let state = AppState {
        room: Arc::new(Mutex::new(Room {
            router,
            peers: HashMap::new(),
            messages,
            data_dir: data_dir.clone(),
        })),
        room_token: Arc::new(std::env::var("ROOM_TOKEN").unwrap_or_default()),
        data_dir: Arc::new(data_dir),
    };
    let app = AxumRouter::new()
        .route("/health", get(health))
        .route("/ws", get(ws_handler))
        .route("/api/files", post(upload_file))
        .route("/files/{id}", get(download_file))
        .nest_service("/updates", ServeDir::new("/updates"))
        .layer(DefaultBodyLimit::max(110 * 1024 * 1024))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8123".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    info!(%bind, "BicLex Hub signaling server started");
    axum::serve(listener, app).await?;
    Ok(())
}
async fn health() -> impl IntoResponse {
    axum::Json(json!({"status":"ok", "room": ROOM_NAME}))
}
fn authorized(state: &AppState, token: Option<&str>) -> bool {
    state.room_token.is_empty() || token == Some(state.room_token.as_str())
}
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn safe_download_name(name: &str) -> String {
    let cleaned = name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect::<String>();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed.chars().take(180).collect()
    }
}
fn load_chat_history(data_dir: &FsPath) -> anyhow::Result<VecDeque<ChatMessage>> {
    let path = data_dir.join("chat.jsonl");
    let text = fs::read_to_string(path).unwrap_or_default();
    let mut messages = text
        .lines()
        .filter_map(|line| serde_json::from_str::<ChatMessage>(line).ok())
        .collect::<VecDeque<_>>();
    while messages.len() > 500 {
        messages.pop_front();
    }
    Ok(messages)
}
async fn append_chat_message(data_dir: &FsPath, message: &ChatMessage) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("chat.jsonl"))
        .await?;
    file.write_all(serde_json::to_string(message)?.as_bytes())
        .await?;
    file.write_all(b"\n").await?;
    Ok(())
}
async fn upload_file(
    State(state): State<AppState>,
    Query(auth): Query<AuthQuery>,
    mut multipart: Multipart,
) -> Response {
    if !authorized(&state, auth.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "invalid room token").into_response();
    }
    let field = match multipart.next_field().await {
        Ok(Some(field)) => field,
        Ok(None) => return (StatusCode::BAD_REQUEST, "file is required").into_response(),
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    let name = safe_download_name(field.file_name().unwrap_or("file"));
    let mime = field
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_owned();
    let bytes = match field.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    if bytes.is_empty() || bytes.len() > 100 * 1024 * 1024 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "file must contain 1 byte to 100 MB",
        )
            .into_response();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let stored = StoredFile {
        id: id.clone(),
        name: name.clone(),
        size: bytes.len() as u64,
        mime: mime.clone(),
    };
    let files_dir = state.data_dir.join("files");
    if let Err(error) = tokio::fs::write(files_dir.join(format!("{id}.bin")), &bytes).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    let metadata = match serde_json::to_vec(&stored) {
        Ok(metadata) => metadata,
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    };
    if let Err(error) = tokio::fs::write(files_dir.join(format!("{id}.json")), metadata).await {
        let _ = tokio::fs::remove_file(files_dir.join(format!("{id}.bin"))).await;
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    Json(ChatAttachment {
        id: id.clone(),
        name,
        size: stored.size,
        mime,
        url: format!("/files/{id}"),
    })
    .into_response()
}
async fn download_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(auth): Query<AuthQuery>,
) -> Response {
    if !authorized(&state, auth.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "invalid room token").into_response();
    }
    if uuid::Uuid::parse_str(&id).is_err() {
        return (StatusCode::BAD_REQUEST, "invalid file id").into_response();
    }
    let files_dir = state.data_dir.join("files");
    let metadata = match tokio::fs::read(files_dir.join(format!("{id}.json")))
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StoredFile>(&bytes).ok())
    {
        Some(metadata) => metadata,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let body = match tokio::fs::read(files_dir.join(format!("{id}.bin"))).await {
        Ok(body) => body,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&metadata.mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    let disposition = format!(
        "attachment; filename*=UTF-8''{}",
        url_encode_filename(&metadata.name)
    );
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    response
}
fn url_encode_filename(name: &str) -> String {
    name.as_bytes()
        .iter()
        .map(|byte| match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                (*byte as char).to_string()
            }
            value => format!("%{value:02X}"),
        })
        .collect()
}
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(auth): Query<AuthQuery>,
) -> Response {
    if !authorized(&state, auth.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "invalid room token").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state.room))
        .into_response()
}

async fn handle_socket(socket: WebSocket, room: Arc<Mutex<Room>>) {
    info!("WebSocket opened");
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if let Ok(payload) = serde_json::to_string(&message) {
                if sink.send(Message::Text(payload.into())).await.is_err() {
                    break;
                }
            }
        }
    });
    let mut peer_id = None;
    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => match serde_json::from_str::<ClientRequest>(&text) {
                Ok(request) => {
                    let request_id = request.request_id.clone();
                    let leave = matches!(request.command, ClientCommand::Leave);
                    if let Err(error) = handle_command(
                        request.command,
                        request_id.clone(),
                        &room,
                        &tx,
                        &mut peer_id,
                    )
                    .await
                    {
                        send_error(&tx, request_id, "request_failed", error.to_string());
                    }
                    if leave {
                        break;
                    }
                }
                Err(error) => send_error(&tx, None, "invalid_message", error.to_string()),
            },
            Message::Close(frame) => {
                info!(?frame, "WebSocket closed by client");
                break;
            }
            _ => {}
        }
    }
    if let Some(id) = peer_id {
        info!(peer_id = %id, "Peer cleanup");
        cleanup_peer(&room, &id).await;
    }
    writer.abort();
}

async fn handle_command(
    command: ClientCommand,
    request_id: Option<String>,
    room: &Arc<Mutex<Room>>,
    tx: &mpsc::UnboundedSender<ServerEnvelope>,
    peer_id: &mut Option<String>,
) -> anyhow::Result<()> {
    match command {
        ClientCommand::Join { name } => join(name, request_id, room, tx, peer_id).await?,
        ClientCommand::GetRouterRtpCapabilities => {
            let guard = room.lock().await;
            reply(
                tx,
                request_id,
                ServerEvent::RouterRtpCapabilities {
                    router_rtp_capabilities: serde_json::to_value(guard.router.rtp_capabilities())?,
                },
            );
        }
        ClientCommand::CreateSendTransport => {
            create_transport(request_id, room, tx, peer_id, true).await?
        }
        ClientCommand::CreateRecvTransport => {
            create_transport(request_id, room, tx, peer_id, false).await?
        }
        ClientCommand::ConnectSendTransport { dtls_parameters } => {
            connect_transport(request_id, room, peer_id, dtls_parameters, true).await?
        }
        ClientCommand::ConnectRecvTransport { dtls_parameters } => {
            connect_transport(request_id, room, peer_id, dtls_parameters, false).await?
        }
        ClientCommand::Produce {
            kind,
            rtp_parameters,
        } => produce(request_id, room, tx, peer_id, kind, rtp_parameters).await?,
        ClientCommand::Consume {
            producer_id,
            rtp_capabilities,
        } => consume(request_id, room, tx, peer_id, producer_id, rtp_capabilities).await?,
        ClientCommand::ResumeConsumer { consumer_id } => {
            let consumer = {
                let guard = room.lock().await;
                peer(&guard, peer_id)?.consumers.get(&consumer_id).cloned()
            };
            if let Some(c) = consumer {
                c.resume().await?;
            }
            reply(tx, request_id, ServerEvent::Pong);
        }
        ClientCommand::CloseProducer { producer_id } => {
            close_producer(request_id, room, tx, peer_id, producer_id).await?
        }
        ClientCommand::SendChatMessage { text, attachments } => {
            send_chat_message(request_id, room, tx, peer_id, text, attachments).await?
        }
        ClientCommand::Ping => {
            debug!("Heartbeat ping received; pong sent");
            reply(tx, request_id, ServerEvent::Pong)
        }
        ClientCommand::Leave => {
            if let Some(id) = peer_id.take() {
                cleanup_peer(room, &id).await
            }
        }
    }
    Ok(())
}

async fn join(
    name: String,
    request_id: Option<String>,
    room: &Arc<Mutex<Room>>,
    tx: &mpsc::UnboundedSender<ServerEnvelope>,
    peer_id: &mut Option<String>,
) -> anyhow::Result<()> {
    let base_name = name.trim().to_owned();
    if base_name.is_empty() || base_name.chars().count() > 32 {
        anyhow::bail!("name must contain 1-32 characters");
    }
    let mut guard = room.lock().await;
    if guard.peers.len() >= MAX_PEERS {
        anyhow::bail!("room is full");
    }
    let mut name = base_name.clone();
    let mut suffix = 1_u32;
    while guard
        .peers
        .values()
        .any(|p| p.name.eq_ignore_ascii_case(&name))
    {
        name = format!("{base_name}#{suffix}");
        suffix += 1;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let turn_ice_servers = turn_ice_servers();
    let users = guard
        .peers
        .values()
        .map(|p| UserInfo {
            peer_id: p.id.clone(),
            name: p.name.clone(),
            producer_id: p.producer.as_ref().map(|x| x.id().to_string()),
            screen_producer_id: p.screen_producer.as_ref().map(|x| x.id().to_string()),
        })
        .collect();
    guard.peers.insert(
        id.clone(),
        Peer {
            id: id.clone(),
            name: name.clone(),
            tx: tx.clone(),
            send_transport: None,
            recv_transport: None,
            producer: None,
            screen_producer: None,
            consumers: HashMap::new(),
        },
    );
    *peer_id = Some(id.clone());
    reply(
        tx,
        request_id,
        ServerEvent::Joined {
            peer_id: id.clone(),
            name: name.clone(),
            room: ROOM_NAME.into(),
            turn_ice_servers,
        },
    );
    reply(tx, None, ServerEvent::Users { users });
    reply(
        tx,
        None,
        ServerEvent::ChatHistory {
            messages: guard
                .messages
                .iter()
                .rev()
                .take(200)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
        },
    );
    broadcast_except(
        &guard,
        &id,
        ServerEvent::UserJoined {
            peer_id: id.clone(),
            name,
        },
    );
    Ok(())
}

async fn send_chat_message(
    request_id: Option<String>,
    room: &Arc<Mutex<Room>>,
    tx: &mpsc::UnboundedSender<ServerEnvelope>,
    peer_id: &Option<String>,
    text: String,
    attachments: Vec<ChatAttachment>,
) -> anyhow::Result<()> {
    let text = text.trim().to_owned();
    if text.chars().count() > 4000 {
        anyhow::bail!("message is too long");
    }
    if text.is_empty() && attachments.is_empty() {
        anyhow::bail!("message is empty");
    }
    if attachments.len() > 10 {
        anyhow::bail!("too many attachments");
    }
    let (sender_peer_id, sender_name, data_dir) = {
        let guard = room.lock().await;
        let peer = peer(&guard, peer_id)?;
        (peer.id.clone(), peer.name.clone(), guard.data_dir.clone())
    };
    for attachment in &attachments {
        if uuid::Uuid::parse_str(&attachment.id).is_err()
            || !data_dir
                .join("files")
                .join(format!("{}.bin", attachment.id))
                .is_file()
        {
            anyhow::bail!("attachment not found");
        }
    }
    let message = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        sender_peer_id,
        sender_name,
        text,
        attachments,
        created_at: now_millis(),
    };
    append_chat_message(&data_dir, &message).await?;
    let mut guard = room.lock().await;
    guard.messages.push_back(message.clone());
    while guard.messages.len() > 500 {
        guard.messages.pop_front();
    }
    broadcast(&guard, ServerEvent::ChatMessage { message });
    reply(tx, request_id, ServerEvent::Pong);
    Ok(())
}

fn turn_ice_servers() -> Vec<Value> {
    let (Some(username), Some(password)) = (
        std::env::var_os("TURN_USERNAME"),
        std::env::var_os("TURN_PASSWORD"),
    ) else {
        return Vec::new();
    };
    let host = std::env::var("TURN_HOST").unwrap_or_else(|_| "turn.biclex.ru".into());
    vec![json!({
        "urls": [format!("turn:{host}:3478?transport=udp"), format!("turn:{host}:3478?transport=tcp")],
        "username": username.to_string_lossy(),
        "credential": password.to_string_lossy()
    })]
}

async fn create_transport(
    request_id: Option<String>,
    room: &Arc<Mutex<Room>>,
    tx: &mpsc::UnboundedSender<ServerEnvelope>,
    peer_id: &Option<String>,
    send: bool,
) -> anyhow::Result<()> {
    let mut guard = room.lock().await;
    let id = peer_id
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("join required"))?
        .clone();
    info!(peer_id = %id, direction = if send { "send" } else { "recv" }, "CREATE TRANSPORT requested");
    let rtc_min_port = std::env::var("RTC_MIN_PORT")
        .unwrap_or_else(|_| "40000".into())
        .parse::<u16>()
        .map_err(|_| anyhow::anyhow!("RTC_MIN_PORT must be a valid UDP port"))?;
    let rtc_max_port = std::env::var("RTC_MAX_PORT")
        .unwrap_or_else(|_| "40100".into())
        .parse::<u16>()
        .map_err(|_| anyhow::anyhow!("RTC_MAX_PORT must be a valid UDP port"))?;
    if rtc_min_port > rtc_max_port {
        anyhow::bail!("RTC_MIN_PORT must not exceed RTC_MAX_PORT");
    }
    let listen = ListenInfo {
        protocol: Protocol::Udp,
        ip: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        announced_address: std::env::var("ANNOUNCED_ADDRESS")
            .ok()
            .filter(|v| !v.is_empty()),
        expose_internal_ip: false,
        port: None,
        port_range: Some(rtc_min_port..=rtc_max_port),
        flags: None,
        send_buffer_size: None,
        recv_buffer_size: None,
    };
    let transport = guard
        .router
        .create_webrtc_transport(WebRtcTransportOptions::new(
            WebRtcTransportListenInfos::new(listen),
        ))
        .await?;
    let mut data = json!({"id": transport.id().to_string(), "iceParameters": transport.ice_parameters(), "iceCandidates": transport.ice_candidates(), "dtlsParameters": transport.dtls_parameters()});
    data["turnIceServers"] = Value::Array(turn_ice_servers());
    let p = guard
        .peers
        .get_mut(&id)
        .ok_or_else(|| anyhow::anyhow!("peer not found"))?;
    if send {
        p.send_transport = Some(transport);
        info!(peer_id = %id, transport_id = %data["id"], "CREATE SEND TRANSPORT success");
        reply(
            tx,
            request_id,
            ServerEvent::SendTransportCreated { transport: data },
        );
    } else {
        p.recv_transport = Some(transport);
        info!(peer_id = %id, transport_id = %data["id"], "CREATE RECV TRANSPORT success");
        reply(
            tx,
            request_id,
            ServerEvent::RecvTransportCreated { transport: data },
        );
    }
    Ok(())
}

async fn connect_transport(
    request_id: Option<String>,
    room: &Arc<Mutex<Room>>,
    peer_id: &Option<String>,
    dtls: Value,
    send: bool,
) -> anyhow::Result<()> {
    let transport = {
        let guard = room.lock().await;
        let p = peer(&guard, peer_id)?;
        if send {
            p.send_transport.clone()
        } else {
            p.recv_transport.clone()
        }
    }
    .ok_or_else(|| anyhow::anyhow!("transport not created"))?;
    info!(peer_id = ?peer_id, direction = if send { "send" } else { "recv" }, "CONNECT TRANSPORT requested");
    transport
        .connect(WebRtcTransportRemoteParameters {
            dtls_parameters: serde_json::from_value(dtls)?,
        })
        .await?;
    info!(peer_id = ?peer_id, direction = if send { "send" } else { "recv" }, "CONNECT TRANSPORT success");
    let guard = room.lock().await;
    reply(&peer(&guard, peer_id)?.tx, request_id, ServerEvent::Pong);
    Ok(())
}

async fn produce(
    request_id: Option<String>,
    room: &Arc<Mutex<Room>>,
    tx: &mpsc::UnboundedSender<ServerEnvelope>,
    peer_id: &Option<String>,
    kind: String,
    params: Value,
) -> anyhow::Result<()> {
    let media_kind = match kind.as_str() {
        "audio" => MediaKind::Audio,
        "video" => MediaKind::Video,
        _ => anyhow::bail!("unsupported media kind"),
    };
    let transport = {
        let guard = room.lock().await;
        peer(&guard, peer_id)?.send_transport.clone()
    }
    .ok_or_else(|| anyhow::anyhow!("send transport not created"))?;
    info!(peer_id = ?peer_id, kind = %kind, "PRODUCE requested");
    let producer = transport
        .produce(ProducerOptions::new(
            media_kind,
            serde_json::from_value(params)?,
        ))
        .await?;
    let producer_id = producer.id().to_string();
    info!(peer_id = ?peer_id, producer_id = %producer_id, "PRODUCER created");
    let mut guard = room.lock().await;
    let id = peer_id.as_ref().unwrap();
    let name = guard.peers[id].name.clone();
    if kind == "audio" {
        guard.peers.get_mut(id).unwrap().producer = Some(producer);
    } else {
        guard.peers.get_mut(id).unwrap().screen_producer = Some(producer);
    }
    reply(
        tx,
        request_id,
        ServerEvent::Produced {
            producer_id: producer_id.clone(),
        },
    );
    if kind == "audio" {
        broadcast_except(
            &guard,
            id,
            ServerEvent::NewProducer {
                peer_id: id.clone(),
                producer_id,
                name,
            },
        );
    } else {
        broadcast_except(
            &guard,
            id,
            ServerEvent::ScreenProducerStarted {
                peer_id: id.clone(),
                producer_id,
            },
        );
    }
    Ok(())
}

async fn consume(
    request_id: Option<String>,
    room: &Arc<Mutex<Room>>,
    tx: &mpsc::UnboundedSender<ServerEnvelope>,
    peer_id: &Option<String>,
    producer_id: String,
    capabilities: Value,
) -> anyhow::Result<()> {
    let (transport, producer, router) = {
        let guard = room.lock().await;
        let transport = peer(&guard, peer_id)?
            .recv_transport
            .clone()
            .ok_or_else(|| anyhow::anyhow!("recv transport not created"))?;
        let producer = guard
            .peers
            .values()
            .find_map(|p| {
                p.producer
                    .as_ref()
                    .filter(|x| x.id().to_string() == producer_id)
                    .cloned()
                    .or_else(|| {
                        p.screen_producer
                            .as_ref()
                            .filter(|x| x.id().to_string() == producer_id)
                            .cloned()
                    })
            })
            .ok_or_else(|| anyhow::anyhow!("producer not found"))?;
        (transport, producer, guard.router.clone())
    };
    let caps: RtpCapabilities = serde_json::from_value(capabilities)?;
    if !router.can_consume(&producer.id(), &caps) {
        anyhow::bail!("router cannot consume producer");
    }
    let mut options = ConsumerOptions::new(producer.id(), caps);
    options.paused = true;
    let consumer = transport.consume(options).await?;
    let data = json!({"id": consumer.id().to_string(), "producerId": producer.id().to_string(), "kind": consumer.kind(), "rtpParameters": consumer.rtp_parameters()});
    let mut guard = room.lock().await;
    peer_mut(&mut guard, peer_id)?
        .consumers
        .insert(consumer.id().to_string(), consumer);
    reply(
        tx,
        request_id,
        ServerEvent::ConsumerCreated { consumer: data },
    );
    Ok(())
}

async fn close_producer(
    request_id: Option<String>,
    room: &Arc<Mutex<Room>>,
    tx: &mpsc::UnboundedSender<ServerEnvelope>,
    peer_id: &Option<String>,
    producer_id: String,
) -> anyhow::Result<()> {
    let mut guard = room.lock().await;
    let id = peer_id
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("join required"))?;
    let closed = {
        let peer = guard
            .peers
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("peer not found"))?;
        if peer.screen_producer.as_ref().map(|p| p.id().to_string()) == Some(producer_id.clone()) {
            peer.screen_producer.take();
            true
        } else {
            false
        }
    };
    if closed {
        broadcast_except(
            &guard,
            id,
            ServerEvent::ScreenProducerStopped {
                peer_id: id.clone(),
                producer_id,
            },
        );
    }
    reply(tx, request_id, ServerEvent::Pong);
    Ok(())
}

async fn cleanup_peer(room: &Arc<Mutex<Room>>, id: &str) {
    let mut guard = room.lock().await;
    if let Some(mut p) = guard.peers.remove(id) {
        if let Some(producer) = p.producer.take() {
            let pid = producer.id().to_string();
            drop(producer);
            broadcast_except(
                &guard,
                id,
                ServerEvent::ProducerClosed {
                    peer_id: id.into(),
                    producer_id: pid,
                },
            );
        }
        if let Some(producer) = p.screen_producer.take() {
            let pid = producer.id().to_string();
            drop(producer);
            broadcast_except(
                &guard,
                id,
                ServerEvent::ScreenProducerStopped {
                    peer_id: id.to_owned(),
                    producer_id: pid,
                },
            );
        }
        p.consumers.clear();
        p.send_transport.take();
        p.recv_transport.take();
        broadcast_except(&guard, id, ServerEvent::UserLeft { peer_id: id.into() });
        info!(peer_id = id, "peer left");
    }
}
fn peer<'a>(room: &'a Room, id: &Option<String>) -> anyhow::Result<&'a Peer> {
    room.peers
        .get(
            id.as_ref()
                .ok_or_else(|| anyhow::anyhow!("join required"))?,
        )
        .ok_or_else(|| anyhow::anyhow!("peer not found"))
}
fn peer_mut<'a>(room: &'a mut Room, id: &Option<String>) -> anyhow::Result<&'a mut Peer> {
    room.peers
        .get_mut(
            id.as_ref()
                .ok_or_else(|| anyhow::anyhow!("join required"))?,
        )
        .ok_or_else(|| anyhow::anyhow!("peer not found"))
}
fn reply(
    tx: &mpsc::UnboundedSender<ServerEnvelope>,
    request_id: Option<String>,
    event: ServerEvent,
) {
    let _ = tx.send(ServerEnvelope {
        request_id,
        ok: true,
        event,
    });
}
fn send_error(
    tx: &mpsc::UnboundedSender<ServerEnvelope>,
    request_id: Option<String>,
    code: &str,
    message: String,
) {
    let _ = tx.send(ServerEnvelope {
        request_id,
        ok: false,
        event: ServerEvent::Error {
            code: code.into(),
            message,
        },
    });
}
fn broadcast_except(room: &Room, except: &str, event: ServerEvent) {
    for (id, peer) in &room.peers {
        if id != except {
            let _ = peer.tx.send(ServerEnvelope {
                request_id: None,
                ok: true,
                event: event.clone(),
            });
        }
    }
}
fn broadcast(room: &Room, event: ServerEvent) {
    for peer in room.peers.values() {
        let _ = peer.tx.send(ServerEnvelope {
            request_id: None,
            ok: true,
            event: event.clone(),
        });
    }
}
