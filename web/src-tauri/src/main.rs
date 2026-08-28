#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs::{self, OpenOptions}, io::Write, path::PathBuf};

fn log_path() -> PathBuf {
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_else(|| ".".into()))
        .join("Biclex Hub").join("logs").join("biclex-hub.log")
}

#[tauri::command]
fn append_log(line: String) -> Result<(), String> {
    let path = log_path();
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let mut file = OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_log_tail() -> Result<String, String> {
    let text = fs::read_to_string(log_path()).unwrap_or_default();
    Ok(text.lines().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![append_log, read_log_tail, open_devtools])
        .run(tauri::generate_context!())
        .expect("error while running Biclex Hub");
}
