#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const SELFHOSTED_COMPOSE: &str = include_str!("../../../deploy/docker-compose.selfhosted.yml");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeployProgress {
    stage: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeployResult {
    address: String,
    token: String,
}

struct TemporaryDeploy {
    root: PathBuf,
}
impl Drop for TemporaryDeploy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn log_path() -> PathBuf {
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_else(|| ".".into()))
        .join("BicLex Hub")
        .join("logs")
        .join("biclex-hub.log")
}

#[tauri::command]
fn append_log(line: String) -> Result<(), String> {
    let path = log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{line}").map_err(|error| error.to_string())
}

#[tauri::command]
fn read_log_tail() -> Result<String, String> {
    let text = fs::read_to_string(log_path()).unwrap_or_default();
    Ok(text
        .lines()
        .rev()
        .take(200)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n"))
}

#[tauri::command]
async fn download_attachment(url: String, destination: String) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Unsupported download URL".into());
    }
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }
    const MAX_DOWNLOAD_SIZE: u64 = 100 * 1024 * 1024;
    if response.content_length().unwrap_or(0) > MAX_DOWNLOAD_SIZE {
        return Err("File exceeds the 100 MB download limit".into());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_DOWNLOAD_SIZE {
        return Err("File exceeds the 100 MB download limit".into());
    }
    let path = PathBuf::from(destination);
    if path.as_os_str().is_empty() || path.is_dir() {
        return Err("Invalid download destination".into());
    }
    let write_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || fs::write(write_path, bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn attachment_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "txt" | "log" | "md" => "text/plain",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
async fn upload_dropped_file(path: String, url: String) -> Result<serde_json::Value, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Unsupported upload URL".into());
    }
    let source = PathBuf::from(path);
    let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
    const MAX_UPLOAD_SIZE: u64 = 100 * 1024 * 1024;
    if !metadata.is_file() {
        return Err("Dropped item is not a file".into());
    }
    if metadata.len() > MAX_UPLOAD_SIZE {
        return Err("File exceeds the 100 MB upload limit".into());
    }
    let filename = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid dropped filename".to_string())?
        .to_string();
    let mime = attachment_mime(&source);
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(source))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(mime)
        .map_err(|error| error.to_string())?;
    let response = reqwest::Client::new()
        .post(url)
        .multipart(reqwest::multipart::Form::new().part("file", part))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Upload failed: HTTP {status}"));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

fn progress(window: &tauri::WebviewWindow, stage: &str, message: &str) {
    let _ = window.emit(
        "deploy-progress",
        DeployProgress {
            stage: stage.into(),
            message: message.into(),
        },
    );
}

fn hide_console(command: &mut Command) {
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
}

fn hidden_output(command: &mut Command) -> std::io::Result<Output> {
    hide_console(command);
    command.output()
}

fn stream_reader<R: Read + Send + 'static>(
    reader: R,
    window: tauri::WebviewWindow,
    tail: Arc<Mutex<VecDeque<String>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let line = line.trim().to_owned();
            if line.is_empty() {
                continue;
            }
            let visible = line.chars().take(700).collect::<String>();
            progress(&window, "docker-log", &visible);
            if let Ok(mut tail) = tail.lock() {
                tail.push_back(visible);
                while tail.len() > 120 {
                    tail.pop_front();
                }
            }
        }
    })
}

fn run_streamed(
    mut command: Command,
    window: &tauri::WebviewWindow,
    stdin_text: Option<String>,
) -> Result<(), String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin_text.is_some() {
        command.stdin(Stdio::piped());
    }
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Не удалось запустить удалённую установку: {error}"))?;
    if let (Some(stdin), Some(text)) = (child.stdin.as_mut(), stdin_text) {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let stdout = child
        .stdout
        .take()
        .map(|reader| stream_reader(reader, window.clone(), tail.clone()));
    let stderr = child
        .stderr
        .take()
        .map(|reader| stream_reader(reader, window.clone(), tail.clone()));
    let status = child.wait().map_err(|error| error.to_string())?;
    if let Some(reader) = stdout {
        let _ = reader.join();
    }
    if let Some(reader) = stderr {
        let _ = reader.join();
    }
    if status.success() {
        return Ok(());
    }
    let details = tail
        .lock()
        .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    Err(format!("Deploy не выполнен: {}", details.trim()))
}

fn parse_ssh_address(address: &str) -> Result<(String, u16), String> {
    let value = address
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    if value.is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | ':')
        })
    {
        return Err("Некорректный IP-адрес или домен".into());
    }
    let (host, port) = match value.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') && port.chars().all(|c| c.is_ascii_digit()) => (
            host.to_owned(),
            port.parse::<u16>().map_err(|_| "Некорректный SSH-порт")?,
        ),
        _ => (value.to_owned(), 22),
    };
    if host.is_empty() {
        return Err("Адрес сервера пуст".into());
    }
    Ok((host, port))
}

fn output_text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn fingerprint(text: &str) -> Option<String> {
    for line in text.lines() {
        let words = line.split_whitespace().collect::<Vec<_>>();
        if let Some(index) = words.iter().position(|word| word.starts_with("SHA256:")) {
            return Some(if index >= 2 {
                format!("{} {} {}", words[index - 2], words[index - 1], words[index])
            } else {
                words[index].to_string()
            });
        }
    }
    None
}

fn putty_args(port: u16, password_file: &Path, host_key: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-batch".into(),
        "-P".into(),
        port.to_string(),
        "-pwfile".into(),
        password_file.to_string_lossy().into_owned(),
    ];
    if let Some(host_key) = host_key {
        args.extend(["-hostkey".into(), host_key.into()]);
    }
    args
}

fn plink_args(port: u16, password_file: &Path, host_key: Option<&str>) -> Vec<String> {
    let mut args = putty_args(port, password_file, host_key);
    args.insert(1, "-no-antispoof".into());
    args
}

fn openssh_args(port: u16, scp: bool) -> Vec<String> {
    vec![
        if scp { "-P" } else { "-p" }.into(),
        port.to_string(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ConnectTimeout=15".into(),
    ]
}

fn prepare_bundle(
    host: &str,
    password: &str,
) -> Result<(TemporaryDeploy, PathBuf, String, String), String> {
    let root = std::env::temp_dir().join(format!(
        "biclex-hub-deploy-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let bundle_name = format!("biclex-hub-{}", uuid::Uuid::new_v4().simple());
    let bundle = root.join(&bundle_name);
    fs::create_dir_all(&bundle).map_err(|error| error.to_string())?;
    fs::write(bundle.join("docker-compose.yml"), SELFHOSTED_COMPOSE)
        .map_err(|error| error.to_string())?;
    let room_token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let turn_password = uuid::Uuid::new_v4().simple().to_string();
    fs::write(bundle.join(".env"), format!("BIND_ADDR=0.0.0.0:8123\nANNOUNCED_ADDRESS={host}\nROOM_NAME=main\nROOM_TOKEN={room_token}\nDATA_DIR=/data\nMAX_PEERS=20\nRTC_MIN_PORT=40000\nRTC_MAX_PORT=40100\nRUST_LOG=info\nTURN_HOST={host}\nTURN_USERNAME=biclex\nTURN_PASSWORD={turn_password}\n")).map_err(|error| error.to_string())?;
    let password_file = root.join("ssh-password.txt");
    fs::write(&password_file, password).map_err(|error| error.to_string())?;
    Ok((
        TemporaryDeploy { root },
        password_file,
        bundle_name,
        room_token,
    ))
}

fn find_resource(resource_dir: &Path, name: &str) -> Result<PathBuf, String> {
    [
        resource_dir.join("resources").join(name),
        resource_dir.join(name),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| format!("В сборке отсутствует {name}"))
}

fn deploy_blocking(
    window: tauri::WebviewWindow,
    resource_dir: PathBuf,
    address: String,
    username: String,
    password: String,
    use_password: bool,
) -> Result<DeployResult, String> {
    if username.is_empty()
        || !username
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Некорректный SSH-логин".into());
    }
    if use_password && password.is_empty() {
        return Err("Введите пароль SSH".into());
    }
    let (host, port) = parse_ssh_address(&address)?;
    let plink = find_resource(&resource_dir, "plink.exe")?;
    let pscp = find_resource(&resource_dir, "pscp.exe")?;
    let (temporary, password_file, bundle_name, room_token) = prepare_bundle(&host, &password)?;
    let target = format!("{username}@{host}");

    progress(
        &window,
        "ssh",
        if use_password {
            "Проверка SSH host key и пароля"
        } else {
            "Проверка SSH-ключа"
        },
    );
    let (probe, host_key) = if use_password {
        let mut probe_args = plink_args(port, &password_file, None);
        probe_args.extend([target.clone(), "exit".into()]);
        let mut command = Command::new(&plink);
        command.args(&probe_args);
        let probe = hidden_output(&mut command)
            .map_err(|error| format!("Не удалось запустить plink: {error}"))?;
        let key = if probe.status.success() {
            None
        } else {
            fingerprint(&output_text(&probe))
        };
        (probe, key)
    } else {
        let mut args = openssh_args(port, false);
        args.extend([target.clone(), "exit".into()]);
        let mut command = Command::new("ssh.exe");
        command.args(&args);
        let probe = hidden_output(&mut command)
            .map_err(|error| format!("Не найден системный OpenSSH client: {error}"))?;
        (probe, None)
    };
    if !probe.status.success() && !(use_password && host_key.is_some()) {
        return Err(format!(
            "SSH-подключение не выполнено: {}",
            output_text(&probe).trim()
        ));
    }
    if let Some(key) = &host_key {
        progress(&window, "ssh-key", &format!("Зафиксирован ключ {key}"));
    }

    progress(&window, "upload", "Загрузка BicLex Hub на сервер");
    let source = temporary
        .root
        .join(&bundle_name)
        .to_string_lossy()
        .into_owned();
    let copy = if use_password {
        let mut copy_args = putty_args(port, &password_file, host_key.as_deref());
        copy_args.extend(["-r".into(), source, format!("{target}:/tmp/")]);
        let mut command = Command::new(&pscp);
        command.args(&copy_args);
        hidden_output(&mut command)
            .map_err(|error| format!("Не удалось запустить pscp: {error}"))?
    } else {
        let mut copy_args = openssh_args(port, true);
        copy_args.extend(["-r".into(), source, format!("{target}:/tmp/")]);
        let mut command = Command::new("scp.exe");
        command.args(&copy_args);
        hidden_output(&mut command).map_err(|error| format!("Не найден системный scp: {error}"))?
    };
    if !copy.status.success() {
        return Err(format!(
            "Загрузка не выполнена: {}",
            output_text(&copy).trim()
        ));
    }

    progress(&window, "docker", "Установка Docker и сборка контейнеров");
    let remote = format!("/tmp/{bundle_name}");
    let script = format!(
        r#"set -e
export DEBIAN_FRONTEND=noninteractive
export BUILDKIT_PROGRESS=plain
export CARGO_TERM_COLOR=never
echo "Проверка Docker на сервере"
if ! command -v curl >/dev/null 2>&1; then apt-get update && apt-get install -y curl ca-certificates; fi
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
echo "Копирование конфигурации BicLex Hub"
install -d -m 755 /opt/biclex-hub
cp -a '{remote}/.' /opt/biclex-hub/
cd /opt/biclex-hub
mkdir -p data
echo "Загрузка готовых образов BicLex Hub"
docker compose pull
echo "Запуск контейнеров"
docker compose up -d --remove-orphans
echo "Настройка сетевых портов"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 8123/tcp || true
  ufw allow 3478/tcp || true
  ufw allow 3478/udp || true
  ufw allow 40000:40300/udp || true
fi
for attempt in $(seq 1 30); do
  echo "Проверка health: попытка $attempt/30"
  if curl -fsS http://127.0.0.1:8123/health >/dev/null; then exit 0; fi
  sleep 2
done
docker compose logs --tail=120 server
exit 1"#
    );
    let remote_command = if username == "root" {
        format!("bash -lc {}", shell_quote(&script))
    } else if use_password {
        format!("sudo -S -p '' bash -lc {}", shell_quote(&script))
    } else {
        format!("sudo -n bash -lc {}", shell_quote(&script))
    };
    let command = if use_password {
        let mut args = plink_args(port, &password_file, host_key.as_deref());
        args.extend([target, remote_command]);
        let mut command = Command::new(&plink);
        command.args(&args);
        command
    } else {
        let mut args = openssh_args(port, false);
        args.extend([target, remote_command]);
        let mut command = Command::new("ssh.exe");
        command.args(&args);
        command
    };
    let stdin_text = (use_password && username != "root").then(|| format!("{password}\n"));
    run_streamed(command, &window, stdin_text)?;
    progress(&window, "health", "Сервер отвечает: OK");
    drop(temporary);
    Ok(DeployResult {
        address: format!("http://{host}:8123"),
        token: room_token,
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[tauri::command]
async fn deploy_server(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    address: String,
    username: String,
    password: String,
    use_password: bool,
) -> Result<DeployResult, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        deploy_blocking(
            window,
            resource_dir,
            address,
            username,
            password,
            use_password,
        )
    })
    .await
    .map_err(|error| format!("Deploy task failed: {error}"))?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            append_log,
            read_log_tail,
            download_attachment,
            upload_dropped_file,
            open_devtools,
            deploy_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running BicLex Hub");
}
