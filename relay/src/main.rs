use std::{path::PathBuf, time::{Duration, SystemTime}};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{StatusCode, header},
    response::IntoResponse,
    routing::{get, put},
    Router,
};
use tokio::fs;

#[derive(Clone)]
struct AppState {
    dir: PathBuf,
    ttl: Duration,
    max_bytes: usize,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "/data".into());
    let ttl_mins: u64 = std::env::var("TTL_MINUTES").ok().and_then(|v| v.parse().ok()).unwrap_or(30);
    let max_bytes: usize = std::env::var("MAX_BYTES").ok().and_then(|v| v.parse().ok()).unwrap_or(2 * 1024 * 1024 * 1024);

    let dir = PathBuf::from(dir);
    fs::create_dir_all(&dir).await.unwrap();

    let state = AppState { dir: dir.clone(), ttl: Duration::from_secs(ttl_mins * 60), max_bytes };

    // cleanup task
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Ok(mut rd) = fs::read_dir(&cleanup_state.dir).await {
                while let Ok(Some(entry)) = rd.next_entry().await {
                    if let Ok(meta) = entry.metadata().await {
                        if let Ok(modified) = meta.modified() {
                            if SystemTime::now().duration_since(modified).unwrap_or_default() > cleanup_state.ttl {
                                let _ = fs::remove_file(entry.path()).await;
                            }
                        }
                    }
                }
            }
        }
    });

    let app = Router::new()
        .route("/p2p/:token", put(put_bundle).get(get_bundle).delete(delete_bundle))
        .route("/health", get(|| async { "ok" }))
        .route("/", get(|| async { "pandora relay ok" }))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();
    tracing::info!("listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}

fn sanitize(token: &str) -> Option<String> {
    if token.len() < 8 || token.len() > 128 { return None; }
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return None; }
    Some(token.to_string())
}

async fn put_bundle(State(state): State<AppState>, Path(token): Path<String>, body: Bytes) -> impl IntoResponse {
    let Some(token) = sanitize(&token) else { return (StatusCode::BAD_REQUEST, "bad token").into_response(); };
    if body.len() > state.max_bytes { return (StatusCode::PAYLOAD_TOO_LARGE, "too large").into_response(); }
    let path = state.dir.join(&token);
    match fs::write(&path, &body).await {
        Ok(_) => (StatusCode::OK, "ok").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("write: {e}")).into_response(),
    }
}

async fn get_bundle(State(state): State<AppState>, Path(token): Path<String>) -> impl IntoResponse {
    let Some(token) = sanitize(&token) else { return (StatusCode::BAD_REQUEST, "bad token").into_response(); };
    let path = state.dir.join(&token);
    // enforce TTL lazily so GET returns 404 immediately after expiry even if sweeper has not run yet
    if let Ok(meta) = fs::metadata(&path).await {
        if let Ok(modified) = meta.modified() {
            if SystemTime::now().duration_since(modified).unwrap_or_default() > state.ttl {
                let _ = fs::remove_file(&path).await;
                return (StatusCode::NOT_FOUND, "not found").into_response();
            }
        }
    }
    match fs::read(&path).await {
        Ok(data) => ([(header::CONTENT_TYPE, "application/zip"), (header::CONTENT_DISPOSITION, "attachment; filename=\"share.zip\"")], data).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn delete_bundle(State(state): State<AppState>, Path(token): Path<String>) -> impl IntoResponse {
    let Some(token) = sanitize(&token) else { return (StatusCode::BAD_REQUEST, "bad token").into_response(); };
    let _ = fs::remove_file(state.dir.join(token)).await;
    (StatusCode::NO_CONTENT, "").into_response()
}
