#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tauri::{Emitter, Manager};

const SERVER_CARGO_TOML: &str = include_str!("../../../server/Cargo.toml");
const SERVER_CARGO_LOCK: &str = include_str!("../../../server/Cargo.lock");
const SERVER_MAIN_RS: &str = include_str!("../../../server/src/main.rs");
const SERVER_DOCKERFILE: &str = include_str!("../../../server/Dockerfile");
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
        "-no-antispoof".into(),
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
    fs::create_dir_all(bundle.join("server/src")).map_err(|error| error.to_string())?;
    fs::write(bundle.join("server/Cargo.toml"), SERVER_CARGO_TOML)
        .map_err(|error| error.to_string())?;
    fs::write(bundle.join("server/Cargo.lock"), SERVER_CARGO_LOCK)
        .map_err(|error| error.to_string())?;
    fs::write(bundle.join("server/src/main.rs"), SERVER_MAIN_RS)
        .map_err(|error| error.to_string())?;
    fs::write(bundle.join("server/Dockerfile"), SERVER_DOCKERFILE)
        .map_err(|error| error.to_string())?;
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
) -> Result<DeployResult, String> {
    if username.is_empty()
        || !username
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Некорректный SSH-логин".into());
    }
    if password.is_empty() {
        return Err("Введите пароль SSH".into());
    }
    let (host, port) = parse_ssh_address(&address)?;
    let plink = find_resource(&resource_dir, "plink.exe")?;
    let pscp = find_resource(&resource_dir, "pscp.exe")?;
    let (temporary, password_file, bundle_name, room_token) = prepare_bundle(&host, &password)?;
    let target = format!("{username}@{host}");

    progress(&window, "ssh", "Проверка SSH host key");
    let mut probe_args = putty_args(port, &password_file, None);
    probe_args.extend([target.clone(), "exit".into()]);
    let probe = Command::new(&plink)
        .args(&probe_args)
        .output()
        .map_err(|error| format!("Не удалось запустить plink: {error}"))?;
    let probe_text = output_text(&probe);
    let host_key = if probe.status.success() {
        None
    } else {
        fingerprint(&probe_text)
    };
    if !probe.status.success() && host_key.is_none() {
        return Err(format!(
            "SSH-подключение не выполнено: {}",
            probe_text.trim()
        ));
    }
    if let Some(key) = &host_key {
        progress(&window, "ssh-key", &format!("Зафиксирован ключ {key}"));
    }

    progress(&window, "upload", "Загрузка BicLex Hub на сервер");
    let mut copy_args = putty_args(port, &password_file, host_key.as_deref());
    copy_args.push("-r".into());
    copy_args.push(
        temporary
            .root
            .join(&bundle_name)
            .to_string_lossy()
            .into_owned(),
    );
    copy_args.push(format!("{target}:/tmp/"));
    let copy = Command::new(&pscp)
        .args(&copy_args)
        .output()
        .map_err(|error| format!("Не удалось запустить pscp: {error}"))?;
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
if ! command -v curl >/dev/null 2>&1; then apt-get update && apt-get install -y curl ca-certificates; fi
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
install -d -m 755 /opt/biclex-hub
cp -a '{remote}/.' /opt/biclex-hub/
cd /opt/biclex-hub
mkdir -p data
docker compose up -d --build
if command -v ufw >/dev/null 2>&1; then
  ufw allow 8123/tcp || true
  ufw allow 3478/tcp || true
  ufw allow 3478/udp || true
  ufw allow 40000:40300/udp || true
fi
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8123/health >/dev/null; then exit 0; fi
  sleep 2
done
docker compose logs --tail=120 server
exit 1"#
    );
    let remote_command = if username == "root" {
        format!("bash -lc {}", shell_quote(&script))
    } else {
        format!("sudo -S -p '' bash -lc {}", shell_quote(&script))
    };
    let mut deploy_args = putty_args(port, &password_file, host_key.as_deref());
    deploy_args.extend([target, remote_command]);
    let mut command = Command::new(&plink);
    command
        .args(&deploy_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if username != "root" {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Не удалось запустить deploy: {error}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(format!("{password}\n").as_bytes())
            .map_err(|error| error.to_string())?;
    }
    let deployed = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !deployed.status.success() {
        return Err(format!(
            "Deploy не выполнен: {}",
            output_text(&deployed).trim()
        ));
    }
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
) -> Result<DeployResult, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        deploy_blocking(window, resource_dir, address, username, password)
    })
    .await
    .map_err(|error| format!("Deploy task failed: {error}"))?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            append_log,
            read_log_tail,
            open_devtools,
            deploy_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running BicLex Hub");
}
